import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendDecided } from "../../kernel/src/checkpoint/append-only-file.ts";
import { emitCommand } from "./commands/emit.ts";
import { resolveRunSurface } from "./run-surface.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-v2-cli-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

async function emit(rootDir: string, args: string[], payload: unknown) {
  return emitCommand.run({ rootDir, args: [...args, "--json", JSON.stringify(payload)], env: {},
    readStdin: async () => { throw new Error("unexpected stdin read"); }, write: () => {} });
}

const started = { host: "codex", workflow: { releaseId: "test", profile: "core" } };

describe("explicit v2 writers", () => {
  it("executes the installed workflow's complete two-round observation example", async () => {
    const contract = await readFile(new URL("../../../.agents/skills/execute-work/references/run-observation-contract.md", import.meta.url), "utf8");
    const examples = [...contract.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
      .map(match => JSON.parse(match[1]!)).filter(Array.isArray);
    expect(examples, "the shared workflow must supply one complete event sequence").toHaveLength(1);
    const sequence = examples[0] as { eventId: string; kind: string; payload: Record<string, unknown> }[];
    expect(sequence.filter(event => event.kind === "review.round.opened")).toHaveLength(2);
    expect(sequence.filter(event => event.kind === "review.round.closed")).toHaveLength(2);
    const root = await repository();
    expect((await emit(root, ["run.started", "--version", "2", "--event-id", "example-start"], started)).kind).toBe("ok");
    for (const event of sequence) {
      const result = await emit(root, [event.kind, "--event-id", event.eventId], event.payload);
      expect(result.kind, `${event.eventId}: ${JSON.stringify(result)}`).toBe("ok");
    }
    const resolved = await resolveRunSurface(root);
    if (!resolved.ok) throw new Error(resolved.reason);
    const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
    if (!current.ok || !current.runId) throw new Error("no example run");
    const read = await resolved.surface.store.read(current.runId);
    if (!read.ok) throw new Error("unreadable example run");
    expect(read.events).toHaveLength(sequence.length + 1);
    expect(read.events.filter(event => event.kind === "review.round.closed").map(event => event.payload["round"])).toEqual([1, 2]);
  });

  it("names the selected event version when an immutable attempt binding is refused", async () => {
    const root = await repository();
    expect((await emit(root, ["run.started", "--version", "2", "--event-id", "start"], started)).kind).toBe("ok");
    const binding = { activityId: "review", attemptId: "first", candidateTreeSha: "a".repeat(40),
      owner: "codex", phase: "review", state: "running", nextStep: "Review the candidate" };
    expect((await emit(root, ["activity.observed", "--event-id", "first"], binding)).kind).toBe("ok");
    const replacement = { ...binding, attemptId: "second" };
    const missing = await emit(root, ["activity.observed", "--event-id", "missing"], replacement);
    expect(missing.kind).toBe("blocked");
    expect(JSON.stringify(missing)).toContain("supersedesAttemptId");
    expect(JSON.stringify(missing)).toContain("run-event/2 contract");
    expect((await emit(root, ["activity.observed", "--event-id", "replacement"],
      { ...replacement, supersedesAttemptId: "first" })).kind).toBe("ok");
    const changed = await emit(root, ["activity.observed", "--event-id", "changed"],
      { ...replacement, state: "completed" });
    expect(changed.kind).toBe("blocked");
    expect(JSON.stringify(changed)).toContain("supersedesAttemptId");
    expect(JSON.stringify(changed)).toContain("run-event/2 contract");
    expect((await emit(root, ["activity.observed", "--event-id", "completed"],
      { ...replacement, supersedesAttemptId: "first", state: "completed" })).kind).toBe("ok");
  });

  it.each(["1", "2"])("names version %s in a refused run start", async version => {
    const root = await repository();
    const result = await emit(root, ["run.started", "--version", version,
      ...(version === "2" ? ["--event-id", "bad-start"] : [])], { ...started, unsupported: true });
    expect(result.kind).toBe("blocked");
    expect(JSON.stringify(result)).toContain(`run-event/${version} contract`);
  });

  it("deduplicates concurrent CLI retries across observation instants but preserves strict raw inputs", async () => {
    const root = await repository();
    expect((await emit(root, ["run.started", "--version", "2", "--event-id", "start-1"], started)).kind).toBe("ok");
    const resolved = await resolveRunSurface(root);
    if (!resolved.ok) throw new Error(resolved.reason);
    const { store, worktreeKey } = resolved.surface;
    const current = await store.current(worktreeKey);
    if (!current.ok || !current.runId) throw new Error("no current run");
    const runId = current.runId;
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const hold = appendDecided({ journalPath: path.join(store.runsDir, `${runId}.jsonl`), crossProcess: true,
      decide: async () => { entered(); await released; return { ok: true as const, accepted: undefined }; } });
    await locked;
    const requests: Promise<unknown>[] = [];
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      for (const at of ["2026-09-07T12:00:00Z", "2026-09-07T12:00:02Z"]) {
        vi.setSystemTime(new Date(at));
        let consumed!: () => void;
        const inputConsumed = new Promise<void>(resolve => { consumed = resolve; });
        requests.push(emitCommand.run({ rootDir: root, args: ["ticket.read", "--event-id", "ticket-1"], env: {},
          readStdin: async () => { consumed(); return JSON.stringify({ ticket: "V26-1922", tracker: "linear" }); }, write: () => {} }));
        await inputConsumed;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      release();
      await hold;
      expect((await Promise.all(requests)).map(result => (result as { kind: string }).kind)).toEqual(["ok", "ok"]);
      const read = await store.read(runId);
      if (!read.ok) throw new Error("unreadable run");
      expect(read.events).toHaveLength(2);
      expect(read.events[1]?.at).toBe("2026-09-07T12:00:00Z");
      const { seq: _seq, ...raw } = read.events[1]!;
      expect((await store.append(runId, { ...raw, at: "2026-09-07T12:00:03Z" })).ok).toBe(false);
      expect((await emit(root, ["ticket.read", "--event-id", "ticket-1"], { ticket: "changed", tracker: "linear" })).kind).toBe("blocked");
    } finally {
      release();
      await hold;
      await Promise.allSettled(requests);
      vi.useRealTimers();
    }
  });

  it("starts v2 explicitly and subsequent events retain that version", async () => {
    const root = await repository();
    expect((await emit(root, ["run.started", "--version", "2", "--event-id", "start-1"], started)).kind).toBe("ok");
    expect((await emit(root, ["ticket.read", "--event-id", "ticket-1"], { ticket: "V26-1922", tracker: "linear" })).kind).toBe("ok");
    const resolved = await resolveRunSurface(root);
    if (!resolved.ok) throw new Error(resolved.reason);
    const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
    if (!current.ok || current.runId === undefined) throw new Error("no current run");
    const read = await resolved.surface.store.read(current.runId);
    if (!read.ok) throw new Error("unreadable run");
    expect(read.events.map(e => e.version)).toEqual(["run-event/2", "run-event/2"]);
    expect(read.events.map(e => (e as unknown as {eventId: string}).eventId)).toEqual(["start-1", "ticket-1"]);
  });

  it("refuses v2 retries without stable IDs and never upgrades an existing v1 run", async () => {
    const root = await repository();
    expect((await emit(root, ["run.started", "--version", "2"], started)).kind).toBe("usage");
    expect((await emit(root, ["run.started"], started)).kind).toBe("ok");
    expect((await emit(root, ["ticket.read", "--version", "2", "--event-id", "ticket-1"], { ticket: "V26-1922", tracker: "linear" })).kind).toBe("usage");
    expect((await emit(root, ["ticket.read"], { ticket: "V26-1922", tracker: "linear" })).kind).toBe("ok");
  });

  it("deduplicates a retried event after its first write without another sequence", async () => {
    const root = await repository();
    expect((await emit(root, ["run.started", "--version", "2", "--event-id", "start-1"], started)).kind).toBe("ok");
    const args = ["ticket.read", "--event-id", "ticket-1"];
    const payload = { ticket: "V26-1922", tracker: "linear" };
    expect((await emit(root, args, payload)).kind).toBe("ok");
    expect((await emit(root, args, payload)).kind).toBe("ok");
    const resolved = await resolveRunSurface(root);
    if (!resolved.ok) throw new Error(resolved.reason);
    const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
    if (!current.ok || !current.runId) throw new Error("no current run");
    const read = await resolved.surface.store.read(current.runId);
    expect(read.ok && read.events.length).toBe(2);
  });
});
