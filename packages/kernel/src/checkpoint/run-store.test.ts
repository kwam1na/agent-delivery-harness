/**
 * The run store: an append-only journal per delivery run under the git common
 * directory, and the worktree-keyed pointer that says which run is current.
 *
 * Written RED before `run-store.ts` existed.
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING. The store lives where anything the
 * owner executes can reach it — that is the price of surviving the removal of
 * the worktree a run happened in. So every file it opens is opened with
 * `O_NOFOLLOW` and checked by `fstat` ON THE OPENED DESCRIPTOR, every run id
 * is charset-checked before a path is formed, and every rejection but the two
 * naming no addressable run — an id the charset refuses, and
 * `unresolvable_run` — is recorded in a bounded note rather than swallowed;
 * those two are left unnoted so a mistyped id cannot leave a notes entry for a
 * run that never existed. The residual race against owner-executed code is
 * unclosable and is bounded by the fact that nothing authoritative reads any
 * of this.
 *
 * WHAT THIS SUITE ACCEPTS AS UNPROVEN. Two clauses of the discipline have no
 * vector here, and both are accepted that way rather than left to look like
 * oversights:
 *
 * - The undefended DIRECTORY COMPONENTS behind the residual above. `O_NOFOLLOW`
 *   and the `fstat` check defend the FINAL path component only, because node
 *   has no `openat`, so there is nothing for a vector to assert about a planted
 *   parent directory.
 * - `ownerOnlyRegularFile`'s uid clause (`append-only-file.ts`, "not owned by
 *   this user"). Reaching it needs a file at a store path owned by a DIFFERENT
 *   user, and no fixture running as one unprivileged user can create one. The
 *   sibling clauses — regular file and owner-only mode — are vectored in "the
 *   fstat discipline on every opened descriptor" below; this one is not, and
 *   the gap is the fixture's, not the discipline's.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunStore, type RunStore } from "./run-store.ts";
import type { RunEventInput, RunEventKind } from "./run-event.ts";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "run-store-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let counter = 0;
const freshStore = (): { store: RunStore; commonDir: string; runsDir: string } => {
  counter += 1;
  const commonDir = path.join(scratch, `common-${counter}`, ".git");
  return { store: createRunStore(commonDir), commonDir, runsDir: path.join(commonDir, "managed-delivery", "runs") };
};

const TREE = "a".repeat(40);
const OTHER_TREE = "b".repeat(40);
const COST = { unit: "usd", total: 1, reportedBy: "claude-code" };

const event = (
  runId: string,
  kind: RunEventKind,
  payload: Record<string, unknown>,
  overrides: Partial<RunEventInput> = {},
): RunEventInput =>
  ({
    version: "run-event/1",
    runId,
    at: "2026-09-02T10:00:00Z",
    repo: { commonDir: "/tmp/repo/.git" },
    kind,
    actor: { role: "executor" },
    attestation: "self",
    payload,
    ...overrides,
  }) as RunEventInput;

const startedFor = (runId: string, at = "2026-09-02T10:00:00Z"): RunEventInput =>
  event(runId, "run.started", { host: "claude-code", workflow: { releaseId: "r1", profile: "linear" } }, { at });

const roundOpened = (runId: string, tree = TREE): RunEventInput =>
  event(runId, "review.round.opened", { round: 1, candidateTreeSha: tree, lenses: [] }, { candidateTreeSha: tree });

const allocated = async (store: RunStore): Promise<string> => {
  const allocation = await store.allocate();
  expect(allocation.ok, JSON.stringify(allocation)).toBe(true);
  if (!allocation.ok) throw new Error("unreachable");
  return allocation.runId;
};

describe("run ids and path containment", () => {
  it("refuses a malformed id, an id carrying a dot, and an id escaping the runs directory, before any write", async () => {
    const { store, runsDir } = freshStore();
    for (const runId of ["", ".", "..", "run.0001", "../elsewhere", "runs/nested", "-leading"]) {
      const outcome = await store.append(runId, startedFor(runId));
      expect(outcome.ok, runId).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.rejections[0]?.code, runId).toBe("malformed_member");
      expect((await store.read(runId)).ok, runId).toBe(false);
    }
    // Nothing was created — not the journal, not a note, not the directory.
    expect(() => statSync(runsDir)).toThrow();
  });

  it("allocates a collision-checked id that names a real, owner-only journal", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    expect(runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
    expect(runId).not.toContain(".");
    const stats = statSync(path.join(runsDir, `${runId}.jsonl`));
    expect(stats.mode & 0o777).toBe(0o600);
    expect(statSync(runsDir).mode & 0o777).toBe(0o700);
  });

  it("refuses an append to a run that was never allocated", async () => {
    const { store } = freshStore();
    const outcome = await store.append("run-never-allocated", startedFor("run-never-allocated"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections[0]?.code).toBe("unresolvable_run");
  });

  it("notes nothing for a run it has no journal for, rather than creating that run's notes", async () => {
    const { store, runsDir } = freshStore();
    // A note is a line IN a run's record. `unresolvable_run` says there is no
    // such run, so a note for it would be the store's own answer to "which
    // runs exist?" contradicting itself: `readNotes` would answer for an id
    // `list` has never heard of, and the notes entry would outlive the typo
    // that produced it.
    const outcome = await store.append("run-never-allocated", startedFor("run-never-allocated"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections[0]?.code).toBe("unresolvable_run");

    expect(await store.readNotes("run-never-allocated")).toEqual([]);
    expect(existsSync(path.join(runsDir, "notes", "run-never-allocated.jsonl"))).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});

describe("the append discipline", () => {
  it("assigns a strictly increasing seq and reads the journal back in order", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    expect((await store.append(runId, startedFor(runId))).ok).toBe(true);
    expect((await store.append(runId, event(runId, "posture.declared", { posture: "test-first" }))).ok).toBe(true);
    const read = await store.read(runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(read.events.map((entry) => entry.kind)).toEqual(["run.started", "posture.declared"]);
  });

  it("refuses an input that carries its own seq rather than letting it displace the assigned one", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    expect((await store.append(runId, startedFor(runId))).ok).toBe(true);

    // `seq` sits AFTER `runId` here, which is the ordering that wins: the
    // assignment is keyed on `runId`, so any later key of the same name
    // overwrites what the store just counted. The store's own entry point
    // admits no `seq` at all, so the input never reaches the assignment.
    const displacing = { ...event(runId, "posture.declared", { posture: "test-first" }), seq: 99 };
    const outcome = await store.append(runId, displacing as unknown as RunEventInput);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((rejection) => [rejection.code, rejection.pointer])).toEqual([["unknown_member", "/seq"]]);

    // Nothing durable moved: the journal still ends at the seq the store counted.
    const read = await store.read(runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((entry) => entry.seq)).toEqual([1]);
  });

  it("refuses an input whose own seq precedes runId, the ordering the assignment loop used to swallow", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    expect((await store.append(runId, startedFor(runId))).ok).toBe(true);

    // The complementary ordering to the row above: `seq` sits BEFORE `runId`.
    // This is the position that used to be accepted in silence — the
    // assignment loop copied the 99 across and then overwrote it when it
    // reached `runId`, so the input never displaced anything and nothing
    // reported that it had tried. The gate walks `Object.keys`, so it refuses
    // this position for exactly the reason it refuses the other; no mutation
    // separates the two orderings, which is why both need a row.
    const displacing = { seq: 99, ...event(runId, "posture.declared", { posture: "test-first" }) };
    const outcome = await store.append(runId, displacing as unknown as RunEventInput);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((rejection) => [rejection.code, rejection.pointer])).toEqual([["unknown_member", "/seq"]]);

    // Nothing durable moved: the journal still ends at the seq the store counted.
    const read = await store.read(runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((entry) => entry.seq)).toEqual([1]);
  });

  it("serializes two concurrent in-process appends with strictly increasing seq", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const [left, right] = await Promise.all([
      store.append(runId, event(runId, "posture.declared", { posture: "test-first" })),
      store.append(runId, event(runId, "decision.recorded", { fork: "branch name", choice: "claude/x" })),
    ]);
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect([left.event.seq, right.event.seq].sort()).toEqual([2, 3]);
    const read = await store.read(runId);
    expect(read.ok && read.events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("repairs a torn tail on the next append without losing a durable line", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const journalPath = path.join(runsDir, `${runId}.jsonl`);
    const durable = readFileSync(journalPath, "utf8");
    writeFileSync(journalPath, `${durable}{"version":"run-event/1","seq":2`, { mode: 0o600 });
    expect((await store.append(runId, event(runId, "posture.declared", { posture: "test-first" }))).ok).toBe(true);
    const read = await store.read(runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(readFileSync(journalPath, "utf8").startsWith(durable)).toBe(true);
  });

  it("refuses a durable journal line that parses as JSON but is not a run event", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const journalPath = path.join(runsDir, `${runId}.jsonl`);
    // Terminated, so it is durable: the torn-tail repair above never reaches
    // it, and `append`'s own validation never saw it. The only thing standing
    // between this line and a reader is the per-entry check inside the read.
    const stray = { runId, seq: 2, kind: "posture.declared", payload: { posture: "test-first" } };
    writeFileSync(journalPath, `${readFileSync(journalPath, "utf8")}${JSON.stringify(stray)}\n`, { mode: 0o600 });

    const read = await store.read(runId);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // `unsupported_spec` rather than `not_an_object` is the discrimination
    // this row exists for: the line parsed, and the entry was refused on its
    // shape. The `/1` prefix pins the refusal to the offending entry's index
    // rather than to the journal as a whole.
    expect(read.rejections.map((rejection) => [rejection.code, rejection.pointer])).toEqual([
      ["unsupported_spec", "/1/version"],
    ]);
  });

  it("rejects a second run.started and any append after run.ended", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const second = await store.append(runId, startedFor(runId));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.rejections[0]?.code).toBe("invalid_transition");

    expect((await store.append(runId, event(runId, "run.ended", { result: "complete", cost: COST }))).ok).toBe(true);
    const after = await store.append(runId, event(runId, "posture.declared", { posture: "test-first" }));
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.rejections[0]?.code).toBe("journal_terminal");
  });

  it("rejects role cli on any kind other than command.completed, gate.reported among them", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const asCli = await store.append(
      runId,
      event(runId, "gate.reported", { command: "pr:athena", outcome: "pass", durationMs: 1 }, { actor: { role: "cli" } }),
    );
    expect(asCli.ok).toBe(false);
    if (!asCli.ok) expect(asCli.rejections[0]?.code).toBe("unsupported_combination");
    const completion = await store.append(
      runId,
      event(runId, "command.completed", { command: "gate", outcome: "ok", durationMs: 1 }, { actor: { role: "cli" } }),
    );
    expect(completion.ok).toBe(true);
  });

  it("rejects an envelope member that disagrees with the payload, and accepts a ticketless run start", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    expect((await store.append(runId, startedFor(runId))).ok).toBe(true);

    const absentInEnvelope = await store.append(runId, event(runId, "pr.opened", { url: "https://example.invalid/pull/1", candidateTreeSha: TREE }));
    expect(absentInEnvelope.ok).toBe(false);
    if (!absentInEnvelope.ok) expect(absentInEnvelope.rejections[0]?.code).toBe("unsupported_combination");

    const absentInPayload = await store.append(
      runId,
      event(runId, "posture.declared", { posture: "test-first" }, { candidateTreeSha: TREE }),
    );
    expect(absentInPayload.ok).toBe(false);
    if (!absentInPayload.ok) expect(absentInPayload.rejections[0]?.code).toBe("unsupported_combination");

    const differing = await store.append(
      runId,
      event(runId, "review.round.opened", { round: 1, candidateTreeSha: TREE, lenses: [] }, { candidateTreeSha: OTHER_TREE }),
    );
    expect(differing.ok).toBe(false);
    if (!differing.ok) expect(differing.rejections[0]?.code).toBe("unsupported_combination");
  });

  it("rejects an over-long or malformed candidateTreeSha and ticket in the payload and in the envelope alike", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const long = "a".repeat(41);
    const badTree = await store.append(
      runId,
      event(runId, "review.round.opened", { round: 1, candidateTreeSha: long, lenses: [] }, { candidateTreeSha: long }),
    );
    expect(badTree.ok).toBe(false);
    if (!badTree.ok) {
      expect(badTree.rejections.map((rejection) => [rejection.code, rejection.pointer])).toEqual([
        ["malformed_member", "/candidateTreeSha"],
        ["malformed_member", "/payload/candidateTreeSha"],
      ]);
    }
    const badTicket = "V".repeat(129);
    const ticket = await store.append(
      runId,
      event(runId, "ticket.read", { ticket: badTicket, tracker: "linear" }, { ticket: badTicket }),
    );
    expect(ticket.ok).toBe(false);
    if (!ticket.ok) {
      expect(ticket.rejections.map((rejection) => [rejection.code, rejection.pointer])).toEqual([
        ["malformed_member", "/ticket"],
        ["malformed_member", "/payload/ticket"],
      ]);
    }
  });

  it("rejects a pr.opened whose url is not http or https", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const outcome = await store.append(
      runId,
      event(runId, "pr.opened", { url: "javascript:alert(1)", candidateTreeSha: TREE }, { candidateTreeSha: TREE }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejections[0]?.code).toBe("malformed_member");
  });
});

describe("secret discipline over the run family's own free-text set", () => {
  const TOKEN = `ghp_${"A".repeat(30)}`;

  it("redacts a secret inside rationale and rejects one inside digest", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const selected = await store.append(
      runId,
      event(runId, "lens.selected", { mandated: [], selected: [], rationale: `the token is ${TOKEN}` }),
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.event.payload["rationale"]).toBe("the token is [redacted:github-token]");

    const completion = await store.append(
      runId,
      event(runId, "command.completed", { command: "gate", outcome: "ok", durationMs: 1, digest: TOKEN }, { actor: { role: "cli" } }),
    );
    expect(completion.ok).toBe(false);
    if (!completion.ok) expect(completion.rejections[0]?.code).toBe("secret_rejected");
  });

  it("leaves the spine's own free-text set untouched: summary is redactable in both families", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const blocker = await store.append(runId, event(runId, "blocker.recorded", { code: "config_unloadable", summary: `saw ${TOKEN}` }));
    expect(blocker.ok).toBe(true);
    if (!blocker.ok) return;
    expect(blocker.event.payload["summary"]).toBe("saw [redacted:github-token]");
  });
});

describe("the rejection notes", () => {
  it("records a rejected append under the run's own notes entry, kind reduced to the bounded charset", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    const hostile = `[31mrun.${"X".repeat(400)}`;
    const outcome = await store.append(runId, event(runId, hostile as RunEventKind, {}));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejections[0]?.code).toBe("unknown_kind");

    const notes = await store.readNotes(runId);
    expect(notes.length).toBe(1);
    const note = notes[0] as { kind: string; code: string; at?: string; pattern?: string };
    expect(note.kind.length).toBeLessThanOrEqual(128);
    expect(note.kind).toMatch(/^[a-z0-9]+([._-][a-z0-9]+)*$/);
    expect(note.code).toBe("unknown_kind");
    expect(note.at).toBe("2026-09-02T10:00:00Z");
    expect(JSON.stringify(note)).not.toContain("");

    // Notes live in their own subdirectory; no run id can name another run's.
    expect(readFileSync(path.join(runsDir, "notes", `${runId}.jsonl`), "utf8").trim().length).toBeGreaterThan(0);
    expect(await store.list()).toEqual([runId]);
  });

  it("names the discipline pattern when a secret was the cause", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    await store.append(
      runId,
      event(runId, "command.completed", { command: "gate", outcome: "ok", durationMs: 1, digest: `ghp_${"A".repeat(30)}` }, { actor: { role: "cli" } }),
    );
    const notes = (await store.readNotes(runId)) as { code: string; pattern?: string }[];
    expect(notes[0]?.code).toBe("secret_rejected");
    expect(notes[0]?.pattern).toBe("github-token");
  });

  it("drops a note whose own write is refused, with no retry, and still returns the append's rejection", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    mkdirSync(path.join(runsDir, "notes"), { recursive: true, mode: 0o700 });
    symlinkSync(path.join(scratch, "planted-note-target"), path.join(runsDir, "notes", `${runId}.jsonl`));

    const outcome = await store.append(runId, event(runId, "posture.declared", { posture: 7 } as unknown as Record<string, unknown>));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejections[0]?.code).toBe("malformed_member");
    expect(() => readFileSync(path.join(scratch, "planted-note-target"), "utf8")).toThrow();
    expect(await store.readNotes(runId)).toEqual([]);
  });
});

describe("the fstat discipline on every opened descriptor", () => {
  it("refuses a planted symlink at a journal path on append and on read", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    const planted = path.join(scratch, "planted-journal-target");
    writeFileSync(planted, "", { mode: 0o600 });
    const journalPath = path.join(runsDir, `${runId}.jsonl`);
    await rm(journalPath);
    symlinkSync(planted, journalPath);

    const outcome = await store.append(runId, startedFor(runId));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejections[0]?.code).toBe("access_refused");
    expect(readFileSync(planted, "utf8")).toBe("");
    expect((await store.read(runId)).ok).toBe(false);
  });

  it("refuses a journal that is not owner-only", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    await store.append(runId, startedFor(runId));
    chmodSync(path.join(runsDir, `${runId}.jsonl`), 0o644);
    const outcome = await store.append(runId, event(runId, "posture.declared", { posture: "test-first" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejections[0]?.code).toBe("access_refused");
    expect((await store.read(runId)).ok).toBe(false);
  });

  it("refuses a journal path that is not a regular file", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    await rm(path.join(runsDir, `${runId}.jsonl`));
    mkdirSync(path.join(runsDir, `${runId}.jsonl`), { mode: 0o700 });
    expect((await store.read(runId)).ok).toBe(false);
  });
});

describe("the per-worktree current-run pointer", () => {
  const KEY = "c".repeat(64);
  const OTHER_KEY = "d".repeat(64);

  it("writes the pointer by exclusive create, refuses a second without force, and displaces with it", async () => {
    const { store } = freshStore();
    const first = await allocated(store);
    const second = await allocated(store);
    expect(await store.setCurrent(KEY, first)).toEqual({ ok: true });
    const refused = await store.setCurrent(KEY, second);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.rejections[0]?.code).toBe("invalid_transition");
    expect(await store.setCurrent(KEY, second, { force: true })).toEqual({ ok: true, displaced: first });
    expect(await store.current(KEY)).toEqual({ ok: true, runId: second });
  });

  it("keeps one worktree's pointer out of another's", async () => {
    const { store } = freshStore();
    const mine = await allocated(store);
    await store.setCurrent(KEY, mine);
    expect(await store.current(OTHER_KEY)).toEqual({ ok: true, runId: undefined });
  });

  it("clears the pointer only when it names the run being cleared", async () => {
    const { store } = freshStore();
    const mine = await allocated(store);
    const other = await allocated(store);
    await store.setCurrent(KEY, mine);
    expect(await store.clearCurrent(KEY, other)).toBe(false);
    expect(await store.current(KEY)).toEqual({ ok: true, runId: mine });
    expect(await store.clearCurrent(KEY, mine)).toBe(true);
    expect(await store.current(KEY)).toEqual({ ok: true, runId: undefined });
  });

  it("reads an over-long, malformed, or orphaned pointer as no current run", async () => {
    const { store, runsDir } = freshStore();
    const pointerPath = path.join(runsDir, "current", KEY);
    mkdirSync(path.dirname(pointerPath), { recursive: true, mode: 0o700 });
    for (const content of ["x".repeat(5000), "run.0001", "../elsewhere", "run-orphaned"]) {
      writeFileSync(pointerPath, content, { mode: 0o600 });
      expect(await store.current(KEY), content.slice(0, 20)).toEqual({ ok: true, runId: undefined });
    }
  });

  it("refuses a planted symlink at the pointer path on create and on read", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    const planted = path.join(scratch, `planted-pointer-${counter}`);
    const pointerPath = path.join(runsDir, "current", KEY);
    mkdirSync(path.dirname(pointerPath), { recursive: true, mode: 0o700 });
    symlinkSync(planted, pointerPath);

    const outcome = await store.setCurrent(KEY, runId);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejections[0]?.code).toBe("invalid_transition");
    expect(() => readFileSync(planted, "utf8")).toThrow();

    const read = await store.current(KEY);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.rejections[0]?.code).toBe("access_refused");
  });

  it("refuses a pointer file that is not owner-only", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    await store.setCurrent(KEY, runId);
    chmodSync(path.join(runsDir, "current", KEY), 0o644);
    const read = await store.current(KEY);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.rejections[0]?.code).toBe("access_refused");
  });
});

describe("taking back a journal that never became a run", () => {
  it("removes an allocated journal that holds nothing, and one that holds only its own start", async () => {
    for (const started of [false, true]) {
      const { store, runsDir } = freshStore();
      const runId = await allocated(store);
      if (started) expect((await store.append(runId, startedFor(runId))).ok).toBe(true);
      expect(await store.list()).toEqual([runId]);

      const discarded = await store.discard(runId);
      expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
      // Gone from the store's own answer to "which runs exist?", and gone from
      // the directory: a journal `list` no longer names but a reader can still
      // open is the same orphan under another name.
      expect(await store.list()).toEqual([]);
      expect(existsSync(path.join(runsDir, `${runId}.jsonl`))).toBe(false);
      expect((await store.read(runId)).ok).toBe(false);
    }
  });

  it("takes the run's notes entry with the journal", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    // The refusal an `emit run.started` with a malformed payload produces: the
    // journal exists, the append is refused, and the store notes it.
    const refused = await store.append(runId, event(runId, "run.started", { host: "x" }));
    expect(refused.ok).toBe(false);
    expect((await store.readNotes(runId)).length).toBe(1);

    expect((await store.discard(runId)).ok).toBe(true);
    expect(await store.readNotes(runId)).toEqual([]);
    expect(existsSync(path.join(runsDir, "notes", `${runId}.jsonl`))).toBe(false);
  });

  it("refuses a journal that carries history beyond its start", async () => {
    const { store, runsDir } = freshStore();
    const runId = await allocated(store);
    expect((await store.append(runId, startedFor(runId))).ok).toBe(true);
    expect((await store.append(runId, roundOpened(runId))).ok).toBe(true);

    const refused = await store.discard(runId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.rejections[0]?.code).toBe("invalid_transition");
    expect(await store.list()).toEqual([runId]);
    expect(existsSync(path.join(runsDir, `${runId}.jsonl`))).toBe(true);
  });

  it("refuses a journal whose only event is not the start it was allocated for", async () => {
    const { store } = freshStore();
    const runId = await allocated(store);
    // Reachable through `emit <kind> --run <id>` against a journal whose start
    // was refused: the first durable line of a journal need not be a start.
    expect((await store.append(runId, event(runId, "posture.declared", { posture: "test-first" }))).ok).toBe(true);

    const refused = await store.discard(runId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.rejections[0]?.code).toBe("invalid_transition");
    expect(await store.list()).toEqual([runId]);
  });

  it("refuses an inadmissible id and an id it has no journal for, creating nothing", async () => {
    const { store, runsDir } = freshStore();
    const escaping = await store.discard("../elsewhere");
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) expect(escaping.rejections[0]?.code).toBe("malformed_member");

    const absent = await store.discard("run-never-allocated");
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.rejections[0]?.code).toBe("unresolvable_run");
    expect(existsSync(runsDir)).toBe(false);
  });
});

describe("listing and candidate lookup", () => {
  it("lists run ids in ascending order and ignores the notes and current subdirectories", async () => {
    const { store, runsDir } = freshStore();
    const ids = ["run-c", "run-a", "run-b"];
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    for (const id of ids) writeFileSync(path.join(runsDir, `${id}.jsonl`), "", { mode: 0o600 });
    mkdirSync(path.join(runsDir, "notes"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(runsDir, "notes", "run-a.jsonl"), "", { mode: 0o600 });
    mkdirSync(path.join(runsDir, "current"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(runsDir, "current", "e".repeat(64)), "run-a", { mode: 0o600 });
    writeFileSync(path.join(runsDir, "stray.txt"), "", { mode: 0o600 });
    expect(await store.list()).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("returns the most recently started matching run and names the others, whichever id sorts first", async () => {
    for (const [earlyId, lateId] of [
      ["run-aaa", "run-zzz"],
      ["run-zzz", "run-aaa"],
    ]) {
      const { store, runsDir } = freshStore();
      mkdirSync(runsDir, { recursive: true, mode: 0o700 });
      for (const [id, at] of [
        [earlyId, "2026-09-02T10:00:00Z"],
        [lateId, "2026-09-02T11:00:00Z"],
      ]) {
        writeFileSync(path.join(runsDir, `${id!}.jsonl`), "", { mode: 0o600 });
        await store.append(id!, startedFor(id!, at));
        await store.append(id!, roundOpened(id!));
      }
      expect(await store.findByCandidateTreeSha(TREE)).toEqual({ runId: lateId, alsoMatching: [earlyId] });
    }
  });

  it("breaks an equal-instant tie by the lexicographically greater run id, either way round", async () => {
    for (const pair of [
      ["run-aaa", "run-zzz"],
      ["run-zzz", "run-aaa"],
    ]) {
      const { store, runsDir } = freshStore();
      mkdirSync(runsDir, { recursive: true, mode: 0o700 });
      for (const id of pair) {
        writeFileSync(path.join(runsDir, `${id!}.jsonl`), "", { mode: 0o600 });
        await store.append(id!, startedFor(id!, "2026-09-02T10:00:00Z"));
        await store.append(id!, roundOpened(id!));
      }
      const found = await store.findByCandidateTreeSha(TREE);
      expect(found?.runId).toBe("run-zzz");
      expect(found?.alsoMatching).toEqual(["run-aaa"]);
    }
  });

  it("never selects a matching journal without run.started over one that has it", async () => {
    const { store, runsDir } = freshStore();
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    const withStart = "run-zzz-with-start";
    writeFileSync(path.join(runsDir, `${withStart}.jsonl`), "", { mode: 0o600 });
    await store.append(withStart, startedFor(withStart));
    await store.append(withStart, roundOpened(withStart));
    // No `emit` path produces a journal with no `run.started`, so this one is
    // written directly.
    const headless = "run-zzzz-headless";
    writeFileSync(
      path.join(runsDir, `${headless}.jsonl`),
      `${JSON.stringify({ ...roundOpened(headless), seq: 1 })}\n`,
      { mode: 0o600 },
    );
    expect(await store.findByCandidateTreeSha(TREE)).toEqual({ runId: withStart, alsoMatching: [headless] });
  });

  it("skips a journal that refuses the read discipline and returns none when nothing readable matches", async () => {
    const { store, runsDir } = freshStore();
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    const good = "run-good";
    writeFileSync(path.join(runsDir, `${good}.jsonl`), "", { mode: 0o600 });
    await store.append(good, startedFor(good));
    await store.append(good, roundOpened(good));
    const unreadable = "run-unreadable";
    writeFileSync(path.join(runsDir, `${unreadable}.jsonl`), `${JSON.stringify({ ...roundOpened(unreadable), seq: 1 })}\n`, { mode: 0o644 });
    expect(await store.findByCandidateTreeSha(TREE)).toEqual({ runId: good, alsoMatching: [] });
    expect(await store.findByCandidateTreeSha(OTHER_TREE)).toBeUndefined();
  });
});
