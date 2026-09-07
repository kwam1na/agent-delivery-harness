import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureRunArtifact, sha256Hex } from "@agent-delivery-harness/kernel";
import { appendDecided } from "../../kernel/src/checkpoint/append-only-file.ts";
import { emitCommand } from "./commands/emit.ts";
import { runsCommand } from "./commands/runs.ts";
import * as surface from "./run-surface.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "capture-retry-"));
  const sourceRoot = await mkdtemp(path.join(tmpdir(), "capture-source-"));
  roots.push(root, sourceRoot);
  execFileSync("git", ["init", "-q", root]);
  const context = { rootDir: root, env: {}, readStdin: async () => "", write: () => {} };
  expect((await emitCommand.run({ ...context, args: ["run.started", "--version", "2", "--event-id", "start", "--json", JSON.stringify({ host: "codex", workflow: { releaseId: "test", profile: "core" } })] })).kind).toBe("ok");
  const resolved = await surface.resolveRunSurface(root);
  if (!resolved.ok) throw new Error(resolved.reason);
  const { store, worktreeKey } = resolved.surface;
  const current = await store.current(worktreeKey);
  if (!current.ok || !current.runId) throw new Error("missing run");
  const runId = current.runId;
  const bytes = '{"outcome":"changes-requested"}';
  await writeFile(path.join(sourceRoot, "report.json"), bytes);
  const artifact = { artifactId: "report", activityId: "review", attemptId: "review-1", candidateTreeSha: "a".repeat(40), digest: sha256Hex(bytes), sizeBytes: Buffer.byteLength(bytes), mediaType: "application/json", producer: "codex" };
  const request = { sourceRoot, sourcePath: "report.json", artifact, report: { reportId: "report", role: "review" }, eventId: "capture" };
  const capture = (value = request) => runsCommand.run({ ...context, args: ["capture", runId, "--json", JSON.stringify(value)] });
  return { store, runId, request, capture, sourceRoot };
}

it("deduplicates concurrent captures with different generated observation times", async () => {
  const { store, runId, capture } = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { entered = resolve; });
  const hold = appendDecided({ journalPath: path.join(store.runsDir, `${runId}.jsonl`), crossProcess: true,
    decide: async () => { entered(); await released; return { ok: true as const, accepted: undefined }; } });
  await locked;
  const requests: ReturnType<typeof capture>[] = [];
  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    const original = surface.buildRunEvent;
    let observed = 0;
    let built!: () => void;
    const allBuilt = new Promise<void>(resolve => { built = resolve; });
    vi.spyOn(surface, "buildRunEvent").mockImplementation(input => {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 7, 12, 0, observed * 2)));
      const event = original(input);
      if (++observed === 4) built();
      return event;
    });
    requests.push(capture(), capture());
    await allBuilt;
    release();
    await hold;
    expect((await Promise.all(requests)).map(result => result.kind)).toEqual(["ok", "ok"]);
    const read = await store.read(runId);
    if (!read.ok) throw new Error("unreadable run");
    expect(read.events.map(event => event.eventId).sort()).toEqual(["capture-artifact", "capture-report", "start"]);
  } finally {
    release();
    await hold;
    await Promise.allSettled(requests);
  }
});

it("publishes missing references from retained exact bytes after scratch cleanup and refuses rebinding", async () => {
  const { store, runId, request, capture, sourceRoot } = await fixture();
  // Capture completed before an interrupted caller could append its references.
  expect((await captureRunArtifact({ store, runId, metadata: request.artifact, sourceRoot, sourcePath: request.sourcePath })).ok).toBe(true);
  await rm(sourceRoot, { recursive: true });
  expect((await capture()).kind).toBe("ok");
  expect((await capture()).kind).toBe("ok");
  const read = await store.read(runId);
  if (!read.ok) throw new Error("unreadable run");
  expect(read.events.map(event => event.eventId)).toEqual(["start", "capture-artifact", "capture-report"]);
  expect((await capture({ ...request, artifact: { ...request.artifact, producer: "different" } })).kind).toBe("blocked");
});
