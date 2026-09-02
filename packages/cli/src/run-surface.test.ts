/**
 * The run surface, driven the way an operator drives it.
 *
 * Every scenario here runs the real CLI against a real temporary git
 * repository and reads the real store back off disk. Nothing stubs git and
 * nothing stubs the store: the whole point of this unit is that a run journal
 * written in one worktree, by two different writers, on two different code
 * paths, is one coherent thing an operator can read.
 */
import { execFile } from "node:child_process";
import { appendFile, chmod, lstat, mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  createRunStore,
  defineHarnessConfig,
  gitNamespaceClearedEnvironment,
  resolveRunStoreLocation,
  runGitDirect,
  type HarnessConfig,
  type RunEvent,
} from "@agent-delivery-harness/kernel";
import { COMPLETION_WRAPPED_COMMANDS } from "./boundary.ts";
import { EXIT_OK, EXIT_POLICY, EXIT_USAGE, runCli, type CliRuntime } from "./index.ts";
import { buildRunEvent } from "./run-surface.ts";

const exec = promisify(execFile);
const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const TREE_SHA = "a".repeat(40);
const OTHER_TREE_SHA = "b".repeat(40);
/** Written as a code point so the escape itself never sits in this source. */
const ESC = String.fromCharCode(27);

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], { cwd });
  return stdout.trim();
}

const PROVIDER_ID = "claude-code.ce-code-review";
const STRUCTURAL_WAIVABLE = ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings"];
const STRUCTURAL_NONWAIVABLE = [
  "ambiguous_records",
  "malformed_record",
  "unknown_provider",
  "live_provider_missing",
  "ambiguous_live_provider",
  "live_provider_failed",
  "resolution_not_allowed",
];

function makeConfig(): HarnessConfig {
  return defineHarnessConfig({
    gateId: "run.surface.gate",
    baseRef: "origin/main",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: ["deliverable-tree/v1"],
    computingIdentityVersion: "deliverable-tree/v1",
    reviewNeutral: [{ prefix: "docs/reports/" }, { prefix: "docs/solutions/" }, { prefix: "telemetry/delivery-runs/" }],
    recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [],
    activationThreshold: 1,
    providers: [{ id: PROVIDER_ID, findingCodes: [] }],
    agentEnvSignals: ["CLAUDE_CODE"],
    ciPolicies: [],
    ciPolicyEnvKey: "DH_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [
      {
        id: "review.green",
        activation: { kind: "relevant_change" },
        freshness: "exact_candidate",
        providers: [PROVIDER_ID],
        acceptedPayloadSpecs: ["review.green/1"],
        allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
        humanWaiverAllowed: true,
        minimumAttestationLevel: "self",
        ciDelegationPolicyIds: [],
        remediation: { default: [{ id: "submit-evidence", kind: "manual_action", summary: "Submit review evidence." }] },
        waivableCodes: [...STRUCTURAL_WAIVABLE],
        nonWaivableCodes: [...STRUCTURAL_NONWAIVABLE],
      },
    ],
    deliveryRecordPath: "telemetry/delivery-runs/record.json",
    deliveryRecordVerification: { baseMovement: "stale" },
  });
}

/** A repository whose HEAD may or may not carry a `harness.config.ts`, so the presence check has something to say. */
async function initRepo(options: { readonly withConfig?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-run-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  if (options.withConfig !== false) writeFileSync(path.join(dir, "harness.config.ts"), "export default {};\n", "utf8");
  writeFileSync(path.join(dir, "src.txt"), "hello\n", "utf8");
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "root");
  await git(dir, "branch", "origin/main");
  return dir;
}

interface Invocation {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(dir: string, argv: readonly string[], overrides: Partial<CliRuntime> = {}): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime: CliRuntime = {
    cwd: dir,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    loadConfig: async () => makeConfig(),
    ...overrides,
  };
  const code = await runCli(argv, runtime);
  return { code, out: out.join(""), err: err.join("") };
}

/** `emit` with its payload on stdin, which is the shape the skills use. */
async function emit(dir: string, argv: readonly string[], payload?: unknown): Promise<Invocation> {
  return cli(dir, ["emit", ...argv], {
    ...(payload === undefined ? {} : { readStdin: async () => JSON.stringify(payload) }),
  });
}

async function storeOf(
  dir: string,
): Promise<{ readonly runsDir: string; readonly commonDir: string; readonly worktreeKey: string }> {
  const location = await resolveRunStoreLocation({ cwd: dir, run: runGitDirect, env: gitNamespaceClearedEnvironment() });
  if (!location.ok) throw new Error(location.reason);
  return { runsDir: location.runsDir, commonDir: location.commonDir, worktreeKey: location.worktreeKey };
}

async function journalOf(dir: string, runId: string): Promise<readonly RunEvent[]> {
  const { commonDir } = await storeOf(dir);
  const read = await createRunStore(commonDir).read(runId);
  if (!read.ok) throw new Error(`journal unreadable: ${JSON.stringify(read.rejections)}`);
  return read.events;
}

async function notesOf(dir: string, runId: string): Promise<readonly unknown[]> {
  const { commonDir } = await storeOf(dir);
  return createRunStore(commonDir).readNotes(runId);
}

/**
 * `runs show`'s two readout rows for one required entry. They are read as a
 * pair on purpose: the rows are complementary by construction, so an entry may
 * appear on exactly one of them.
 */
async function readoutRowsFor(dir: string, runId: string): Promise<{ readonly present: string; readonly missing: string }> {
  const shown = await cli(dir, ["runs", "show", runId]);
  expect(shown.code, shown.err).toBe(EXIT_OK);
  const lines = shown.out.split("\n");
  return {
    present: lines.find((line) => line.includes("present:")) ?? "",
    missing: lines.find((line) => line.includes("missing:")) ?? "",
  };
}

/** A journal whose closed round does not pair: absent from `present`, named by `missing`. */
async function expectRoundClosedAbsent(dir: string, runId: string): Promise<void> {
  const { present, missing } = await readoutRowsFor(dir, runId);
  expect(present).not.toContain("review.round.closed");
  expect(missing).toContain("review.round.closed");
}

/** The run id `emit run.started` allocated, taken from the store rather than parsed out of prose. */
async function startRun(dir: string, extra: readonly string[] = []): Promise<string> {
  const result = await emit(dir, ["run.started", ...extra], {
    host: "vitest",
    workflow: { releaseId: "test-release", profile: "linear" },
  });
  expect(result.code, result.err).toBe(EXIT_OK);
  // The deny side of the stale-pointer report: every start on this path either
  // took a free pointer or displaced a named run, and neither is the store-health
  // alarm. Without this the alarm can fire unconditionally and stay green.
  expect(result.out, "a start that displaced nothing unreadable must not raise the store-health alarm").not.toContain(
    "stale pointer",
  );
  const { commonDir, worktreeKey } = await storeOf(dir);
  const current = await createRunStore(commonDir).current(worktreeKey);
  if (!current.ok || current.runId === undefined) throw new Error("run.started left no current run");
  return current.runId;
}

/**
 * A journal that satisfies every condition the complete rule states except the
 * two CLI completions, with `gate.reported` in its ordered place: Athena's
 * finished state, and the one status the config-presence note attaches to.
 */
async function executorOnlyRun(dir: string): Promise<string> {
  const runId = await startRun(dir);
  const steps: readonly (readonly [string, unknown])[] = [
    ["ticket.read", { ticket: "V26-1549", tracker: "linear" }],
    ["posture.declared", { posture: "test-first" }],
    [
      "lens.selected",
      { mandated: ["lens.outcome-correctness", "lens.adversarial-testing"], selected: [], rationale: "the shipped pair" },
    ],
    ["review.round.opened", { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }],
    [
      "review.round.closed",
      {
        round: 1,
        candidateTreeSha: TREE_SHA,
        outcome: "aligned",
        findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
        cost: { unit: "usd", total: 0, reportedBy: "vitest" },
      },
    ],
    ["gate.reported", { command: "npm run check", outcome: "pass", durationMs: 5 }],
    ["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: TREE_SHA }],
    ["run.ended", { result: "complete", cost: { unit: "usd", total: 0, reportedBy: "vitest" } }],
  ];
  for (const [kind, payload] of steps) {
    const result = await emit(dir, [kind], payload);
    expect(result.code, `${kind}: ${result.err}`).toBe(EXIT_OK);
  }
  return runId;
}

// ── The scripted loop ────────────────────────────────────────────────────────

describe("emit, the boundary wrap, and runs", () => {
  it("writes a three-event journal across both writers and reads it back", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);

    const checked = await cli(dir, ["check"]);
    expect(checked.code, checked.err).toBe(EXIT_OK);

    const ended = await emit(dir, ["run.ended"], {
      result: "complete",
      cost: { unit: "usd", total: 0, reportedBy: "vitest" },
    });
    expect(ended.code, ended.err).toBe(EXIT_OK);

    const events = await journalOf(dir, runId);
    expect(events.map((event) => event.kind)).toEqual(["run.started", "command.completed", "run.ended"]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events[0]!.actor.role).toBe("executor");
    expect(events[1]!.actor.role).toBe("cli");
    expect(events[1]!.payload).toMatchObject({ command: "check", outcome: "ok" });
    expect(events[2]!.actor.role).toBe("executor");

    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    // The writer label is what keeps a CLI completion distinguishable from an
    // executor's claim to have run the same command.
    expect(shown.out).toMatch(/command\.completed +cli\b/);
    expect(shown.out).toMatch(/run\.started +executor\b/);
  });

  it("emits in a directory with no harness.config.ts", async () => {
    const dir = await initRepo({ withConfig: false });
    const runId = await startRun(dir);
    const ended = await emit(dir, ["run.ended"], {
      result: "complete",
      cost: { unit: "usd", total: 0, reportedBy: "vitest" },
    });
    expect(ended.code, ended.err).toBe(EXIT_OK);
    expect((await journalOf(dir, runId)).map((event) => event.kind)).toEqual(["run.started", "run.ended"]);
  });

  it("keeps a run in the worktree it started in", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const other = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    cleanups.push(other);
    await git(dir, "worktree", "add", "--quiet", "-b", "side", other);

    // Whatever `check` decides in B, it decides it about B. The run store is
    // shared — one common directory — but the pointer is per-worktree, so B
    // resolves no current run and A's journal never learns B ran anything.
    await cli(other, ["check"]);
    expect((await journalOf(dir, runId)).map((event) => event.kind)).toEqual(["run.started"]);

    // The other half of the same sentence: separate pointers, ONE store. B
    // reads A's run because they share a common directory; it is not current
    // in B, because the pointer is not shared. A store resolved from the
    // worktree's own git dir would pass the isolation half and fail this one.
    const listed = await cli(other, ["runs", "list"]);
    expect(listed.code, listed.err).toBe(EXIT_OK);
    expect(listed.out).toContain(runId);
    expect(listed.out).not.toMatch(new RegExp(`${runId}.*\\bcurrent\\b`));
  });

  it("refuses a second run.started without --force and names the displaced run with it", async () => {
    const dir = await initRepo();
    const first = await startRun(dir);

    const refused = await emit(dir, ["run.started"], {
      host: "vitest",
      workflow: { releaseId: "test-release", profile: "linear" },
    });
    expect(refused.code).toBe(EXIT_POLICY);
    expect((await journalOf(dir, first)).map((event) => event.kind)).toEqual(["run.started"]);
    // The pointer is read BEFORE the journal is allocated, so the refusal
    // leaves no second journal behind. Allocating first would list two.
    const { commonDir } = await storeOf(dir);
    expect(await createRunStore(commonDir).list()).toEqual([first]);

    const second = await startRun(dir, ["--force"]);
    expect(second).not.toBe(first);
    expect((await journalOf(dir, second))[0]!.payload).toMatchObject({ displacedRunId: first });
  });

  it("stops appending once the run has ended, and starts cleanly afterwards", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const ended = await emit(dir, ["run.ended"], {
      result: "complete",
      cost: { unit: "usd", total: 0, reportedBy: "vitest" },
    });
    expect(ended.code, ended.err).toBe(EXIT_OK);

    await cli(dir, ["check"]);
    await cli(dir, ["verify"]);
    expect((await journalOf(dir, runId)).map((event) => event.kind)).toEqual(["run.started", "run.ended"]);
    expect(await notesOf(dir, runId)).toEqual([]);

    const next = await startRun(dir);
    expect(next).not.toBe(runId);
    expect((await journalOf(dir, next))[0]!.payload).not.toHaveProperty("displacedRunId");
  });

  // ── Refusals ───────────────────────────────────────────────────────────────

  it("refuses an unknown kind, a malformed payload, and command.completed, noting each once", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);

    const unknown = await emit(dir, ["not.a.kind"], { anything: true });
    expect(unknown.code).toBe(EXIT_POLICY);
    expect(unknown.err).toContain("not.a.kind");

    const malformed = await emit(dir, ["ticket.read"], { ticket: 17, tracker: "linear" });
    expect(malformed.code).toBe(EXIT_POLICY);

    const completion = await emit(dir, ["command.completed"], { command: "gate", outcome: "ok", durationMs: 1 });
    expect(completion.code).toBe(EXIT_POLICY);

    expect((await journalOf(dir, runId)).map((event) => event.kind)).toEqual(["run.started"]);
    const notes = (await notesOf(dir, runId)) as readonly { kind: string; code: string }[];
    expect(notes.map((note) => note.kind)).toEqual(["not.a.kind", "ticket.read", "command.completed"]);

    // And the viewer renders them, so a refused append is visible to an
    // operator reading the run rather than only to something reading the store.
    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(shown.out).toContain("refused appends:");
    for (const note of notes) expect(shown.out).toContain(note.kind);
  });

  it("leaves a wrapped command's outcome and exit code untouched when the store fails", async () => {
    const dir = await initRepo();
    const clean = await cli(dir, ["check"]);

    const runId = await startRun(dir);
    const { runsDir, worktreeKey } = await storeOf(dir);
    // A pointer the store must refuse to read: the append can never happen,
    // and `check` must not notice.
    const pointerPath = path.join(runsDir, "current", worktreeKey);
    await unlink(pointerPath);
    await symlink("/dev/null", pointerPath);

    const sabotaged = await cli(dir, ["check"]);
    expect(sabotaged.code).toBe(clean.code);
    expect(sabotaged.out).toBe(clean.out);
    expect((await journalOf(dir, runId)).map((event) => event.kind)).toEqual(["run.started"]);
  });

  it("resolves the store under the invoking worktree even with GIT_DIR planted", async () => {
    const dir = await initRepo();
    const elsewhere = await initRepo();
    const saved = { dir: process.env["GIT_DIR"], common: process.env["GIT_COMMON_DIR"] };
    process.env["GIT_DIR"] = path.join(elsewhere, ".git");
    process.env["GIT_COMMON_DIR"] = path.join(elsewhere, ".git");
    try {
      const runId = await startRun(dir);
      await cli(dir, ["check"]);
      const events = await journalOf(dir, runId);
      expect(events.map((event) => event.kind)).toEqual(["run.started", "command.completed"]);
      expect(events[0]!.repo.commonDir).toBe((await storeOf(dir)).commonDir);
      // The other repository's store was never touched.
      expect(await createRunStore((await storeOf(elsewhere)).commonDir).list()).toEqual([]);
    } finally {
      if (saved.dir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved.dir;
      if (saved.common === undefined) delete process.env["GIT_COMMON_DIR"];
      else process.env["GIT_COMMON_DIR"] = saved.common;
    }
  });

  it("exits with the policy code when there is no repository and no resolvable run", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "dh-norepo-"));
    cleanups.push(outside);
    const listed = await cli(outside, ["runs", "list"]);
    expect(listed.code).toBe(EXIT_POLICY);
    expect(listed.err).toContain("git repository");

    const dir = await initRepo();
    const noPointer = await emit(dir, ["ticket.read"], { ticket: "V26-1549", tracker: "linear" });
    expect(noPointer.code).toBe(EXIT_POLICY);
    expect(noPointer.err).toContain("no current run");
    expect(await createRunStore((await storeOf(dir)).commonDir).list()).toEqual([]);

    const unknownRun = await emit(dir, ["ticket.read", "--run", "run-deadbeefdeadbeef"], {
      ticket: "V26-1549",
      tracker: "linear",
    });
    expect(unknownRun.code).toBe(EXIT_POLICY);
    expect(await createRunStore((await storeOf(dir)).commonDir).list()).toEqual([]);
    // No journal AND no note: a caller-chosen id must not be able to create a
    // file anywhere in the store, which is the whole point of resolving the
    // run before the kind is judged.
    await expect(lstat(path.join((await storeOf(dir)).runsDir, "notes", "run-deadbeefdeadbeef.jsonl"))).rejects.toThrow();
  });

  it("rejects a missing kind, a missing subcommand, and an unknown flag as usage", async () => {
    const dir = await initRepo();
    expect((await cli(dir, ["emit"])).code).toBe(EXIT_USAGE);
    expect((await cli(dir, ["runs"])).code).toBe(EXIT_USAGE);
    expect((await cli(dir, ["runs", "show"])).code).toBe(EXIT_USAGE);
    expect((await emit(dir, ["run.started", "--nope"], {})).code).toBe(EXIT_USAGE);
  });

  // ── The viewer ─────────────────────────────────────────────────────────────

  it("lists each run's status and size and the store's total", async () => {
    const dir = await initRepo();
    const first = await startRun(dir);
    await emit(dir, ["run.ended"], { result: "partial", cost: { unit: "usd", total: 0, reportedBy: "vitest" } });
    const second = await startRun(dir);

    const listed = await cli(dir, ["runs", "list"]);
    expect(listed.code, listed.err).toBe(EXIT_OK);
    expect(listed.out).toContain(first);
    expect(listed.out).toContain(second);
    expect(listed.out).toContain("incomplete");
    expect(listed.out).toMatch(/\bopen\b/);
    // `list` prints a completeness verdict of its own, so it carries the same
    // three labels `show` does — at this call site, not only in the constant.
    expect(listed.out).toContain("self-attested");
    expect(listed.out).toContain("observability, not evidence");
    expect(listed.out).toContain("unbound to a record");
    // The marker is pinned in the direction that says something: the run this
    // worktree points at IS marked. A marker never printed passes only the
    // negative assertion in the two-worktree row.
    expect(listed.out).toMatch(new RegExp(`${second}.*\\bcurrent\\b`));
    const { runsDir } = await storeOf(dir);
    const total =
      (await stat(path.join(runsDir, `${first}.jsonl`))).size + (await stat(path.join(runsDir, `${second}.jsonl`))).size;
    expect(listed.out).toContain(`${total} bytes`);
  });

  it("labels gate.reported as executor-written and names the CLI completions it lacks", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const reported = await emit(dir, ["gate.reported"], { command: "npm run pr:athena", outcome: "pass", durationMs: 12 });
    expect(reported.code, reported.err).toBe(EXIT_OK);

    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(shown.out).toMatch(/gate\.reported +executor\b/);
    const missing = shown.out.split("\n").find((line) => line.includes("missing:")) ?? "";
    expect(missing).toContain("command.completed:gate");
    expect(missing).toContain("command.completed:record");
    // A gate reported before any round closed is a violated constraint, and
    // the third readout row is where the operator learns that.
    const violations = shown.out.split("\n").find((line) => line.includes("violations:")) ?? "";
    expect(violations).toContain("gate-reported-before-closed-round");
  });

  it("names only the record completion when the gate completion is present", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const gated = await cli(dir, ["gate"]);
    expect(gated.code).not.toBe(EXIT_OK);
    const completion = (await journalOf(dir, runId)).find((event) => event.payload["command"] === "gate");
    expect(completion, "gate wrote no completion").toBeDefined();
    // The outcome is read off the exit code, not assumed: a wrap that always
    // said "ok" would make every completion in every journal a false claim.
    expect(completion!.payload["outcome"]).toBe("policy");
    const shown = await cli(dir, ["runs", "show", runId]);
    const missing = shown.out.split("\n").find((line) => line.includes("missing:")) ?? "";
    expect(missing).toContain("command.completed:record");
    expect(missing).not.toContain("command.completed:gate");
  });

  it("adds the config-presence note only where the config file is, and never imports it", async () => {
    const dir = await initRepo({ withConfig: false });
    const runId = await executorOnlyRun(dir);

    const without = await cli(dir, ["runs", "show", runId]);
    expect(without.code, without.err).toBe(EXIT_OK);
    expect(without.out).toContain("complete-executor-only");
    expect(without.out).not.toContain("harness.config.ts present");

    // A config that would throw the moment anything imported it.
    await writeFile(path.join(dir, "harness.config.ts"), "throw new Error('imported');\n", "utf8");
    const withConfig = await cli(dir, ["runs", "show", runId]);
    expect(withConfig.code, withConfig.err).toBe(EXIT_OK);
    expect(withConfig.out).toContain("harness.config.ts present");
    expect(withConfig.out).toContain(dir);
    expect((await lstat(path.join(dir, "harness.config.ts"))).isFile()).toBe(true);
  });

  it("prints a labeled treeSha line from prepare, and records the completion", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const prepared = await cli(dir, ["prepare"]);
    expect(prepared.code, prepared.err).toBe(EXIT_OK);
    const labeled = prepared.out.split("\n").find((line) => line.trim().startsWith("treeSha "));
    expect(labeled, prepared.out).toBeDefined();
    const treeSha = labeled!.trim().slice("treeSha ".length);
    expect(treeSha).toMatch(/^[0-9a-f]{40,64}$/);
    // The same value the round rows and `findByCandidateTreeSha` bind to.
    expect(prepared.out).toContain(`tree ${treeSha}`);
    expect((await journalOf(dir, runId))[1]!.payload).toMatchObject({ command: "prepare", outcome: "ok" });
  });

  it("carries the self-attestation, observability, and unbound labels on any journal", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.out).toContain("self-attested");
    expect(shown.out).toContain("observability, not evidence");
    expect(shown.out).toContain("unbound to a record");
  });

  it("binds a round to its candidate in the envelope and in the round row", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const opened = await cli(dir, [
      "emit",
      "review.round.opened",
      "--json",
      JSON.stringify({ round: 1, candidateTreeSha: OTHER_TREE_SHA, lenses: ["lens.outcome-correctness"] }),
    ]);
    expect(opened.code, opened.err).toBe(EXIT_OK);

    const events = await journalOf(dir, runId);
    expect(events[1]!.candidateTreeSha).toBe(OTHER_TREE_SHA);
    const { commonDir } = await storeOf(dir);
    expect(await createRunStore(commonDir).findByCandidateTreeSha(OTHER_TREE_SHA)).toEqual({ runId, alsoMatching: [] });

    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.out).toMatch(new RegExp(`round 1.*${OTHER_TREE_SHA}`));
  });

  it("reads present off the journal rather than subtracting what is missing", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    await cli(dir, ["gate"]);

    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    const present = shown.out.split("\n").find((line) => line.includes("present:")) ?? "";
    expect(present).toContain("run.started");
    expect(present).toContain("command.completed:gate");
    // `gate.reported` is required only of an executor-only journal, so it is
    // absent from `missing` here. A `present` computed by subtracting
    // `missing` from the required list would name a gate.reported this
    // journal never carried.
    expect(present).not.toContain("gate.reported");
    expect(present).not.toContain("ticket.read");
  });

  it("does not count an executor-written completion as a CLI completion", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const { commonDir } = await storeOf(dir);
    // The store admits this — a completion claimed by an executor is a legal
    // event. The readout must still refuse to read it as the product's.
    const forged = await createRunStore(commonDir).append(
      runId,
      buildRunEvent({
        runId,
        commonDir,
        kind: "command.completed",
        role: "executor",
        payload: { command: "gate", outcome: "ok", durationMs: 1 },
      }),
    );
    expect(forged.ok, JSON.stringify(forged)).toBe(true);

    const shown = await cli(dir, ["runs", "show", runId]);
    const present = shown.out.split("\n").find((line) => line.includes("present:")) ?? "";
    const missing = shown.out.split("\n").find((line) => line.includes("missing:")) ?? "";
    expect(present).not.toContain("command.completed:gate");
    expect(missing).toContain("command.completed:gate");
  });

  it("leaves a wrapped command untouched when the append itself is refused", async () => {
    const dir = await initRepo();
    const clean = await cli(dir, ["check"]);
    const runId = await startRun(dir);
    const { runsDir } = await storeOf(dir);
    const journalPath = path.join(runsDir, `${runId}.jsonl`);
    // The pointer resolves and the run is current, so the wrap gets all the
    // way to `store.append` — the path an unreadable pointer never reaches —
    // and is refused there.
    await appendFile(journalPath, "not a run event\n", "utf8");
    const before = await readFile(journalPath, "utf8");

    const sabotaged = await cli(dir, ["check"]);
    expect(sabotaged.code).toBe(clean.code);
    expect(sabotaged.out).toBe(clean.out);
    expect(sabotaged.err).toBe(clean.err);
    expect(await readFile(journalPath, "utf8")).toBe(before);
  });

  it("displaces a pointer whose journal is gone rather than allocating one run per retry", async () => {
    const dir = await initRepo();
    const first = await startRun(dir);
    const { runsDir, commonDir, worktreeKey } = await storeOf(dir);
    // A pruned store, a restored `.git`: the pointer survives, the journal
    // does not. `current` answers `undefined` here exactly as it does for no
    // pointer at all, so nothing but the pointer write can tell them apart.
    await unlink(path.join(runsDir, `${first}.jsonl`));

    // Started directly rather than through `startRun`: this is the one start
    // that SHOULD raise the store-health alarm, and the shared helper asserts
    // the deny side.
    const restarted = await emit(dir, ["run.started"], {
      host: "vitest",
      workflow: { releaseId: "test-release", profile: "linear" },
    });
    expect(restarted.code, restarted.err).toBe(EXIT_OK);
    expect(restarted.out).toContain("stale pointer");
    const pointer = await createRunStore(commonDir).current(worktreeKey);
    const second = pointer.ok ? pointer.runId : undefined;
    expect(second).not.toBe(first);
    expect(await createRunStore(commonDir).list()).toEqual([second]);
  });

  it("runs the config-free pair through the shipped loader seam", async () => {
    const dir = await initRepo({ withConfig: false });
    await writeFile(path.join(dir, "harness.config.ts"), "throw new Error('imported');\n", "utf8");
    // No `loadConfig` override anywhere below: this is the real seam. A
    // config-free command that fell through to the configured path would
    // import that file, so these two exits are what the class buys.
    const payload = JSON.stringify({ host: "vitest", workflow: { releaseId: "test-release", profile: "linear" } });
    const started = await cli(dir, ["emit", "run.started", "--json", payload], { loadConfig: undefined });
    expect(started.code, started.err).toBe(EXIT_OK);
    const listed = await cli(dir, ["runs", "list"], { loadConfig: undefined });
    expect(listed.code, listed.err).toBe(EXIT_OK);
    // And the configured path in the same repository does not survive it,
    // which is what makes the two exits above mean anything.
    expect((await cli(dir, ["check"], { loadConfig: undefined })).code).not.toBe(EXIT_OK);
  });

  it("wraps only the commands on the completion allowlist", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    await cli(dir, ["maintain"]);
    await cli(dir, ["managed"]);
    await cli(dir, ["emit"]);
    await cli(dir, ["runs", "list"]);
    expect((await journalOf(dir, runId)).map((event) => event.kind)).toEqual(["run.started"]);

    // The seven names, spelled here rather than read from the constant under
    // test. Comparing the driven completions to `COMPLETION_WRAPPED_COMMANDS`
    // would be a fixture agreeing with itself: dropping a member changes both
    // sides and the row stays green, which is exactly how `record` could stop
    // being wrapped — and `command.completed:record` is a required journal
    // entry, so every journal in the repository would become permanently
    // incomplete with nothing red.
    const WRAPPED = ["check", "prepare", "review-context", "submit-evidence", "gate", "record", "verify"];
    expect([...COMPLETION_WRAPPED_COMMANDS].sort()).toEqual([...WRAPPED].sort());

    // Every member driven, not four of seven. The exit codes do not matter:
    // the wrap runs whatever the command decided, as the `gate` row shows.
    for (const command of WRAPPED) await cli(dir, [command]);
    const completed = (await journalOf(dir, runId))
      .filter((event) => event.kind === "command.completed")
      .map((event) => event.payload["command"]);
    expect([...new Set(completed)].sort()).toEqual([...WRAPPED].sort());
    expect(completed).toHaveLength(WRAPPED.length);
  });

  it("reports a journal it cannot read rather than dropping it from the list", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const { runsDir } = await storeOf(dir);
    // Group-readable: the store's owner-only discipline refuses it. A row that
    // silently skipped an unreadable journal would hide exactly the run whose
    // storage is in trouble.
    await chmod(path.join(runsDir, `${runId}.jsonl`), 0o644);

    const listed = await cli(dir, ["runs", "list"]);
    expect(listed.code, listed.err).toBe(EXIT_OK);
    expect(listed.out).toContain(runId);
    expect(listed.out).toContain("unreadable");
    await chmod(path.join(runsDir, `${runId}.jsonl`), 0o600);
  });

  it("lets exactly one of two concurrent run.started take the pointer", async () => {
    const dir = await initRepo();
    const payload = JSON.stringify({ host: "vitest", workflow: { releaseId: "test-release", profile: "linear" } });
    // The deny side of the stale-pointer re-read. A pointer that has become
    // live between the read and the exclusive create is a genuine race and
    // must still be refused — a re-read that displaced anything, or a refused
    // pointer write reported as success, would let both of these exit 0.
    //
    // Raced four times over four repositories, not once. The loser is
    // sometimes refused at the earlier pointer read rather than at the
    // exclusive create, so a single race reaches the deny side most of the
    // time but not every time; repeating it makes the row detect what it
    // claims to detect on every run rather than on most of them.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const raced = attempt === 0 ? dir : await initRepo();
      const codes = (
        await Promise.all([
          cli(raced, ["emit", "run.started", "--json", payload], { loadConfig: undefined }),
          cli(raced, ["emit", "run.started", "--json", payload], { loadConfig: undefined }),
        ])
      ).map((invocation) => invocation.code);
      expect(codes.filter((code) => code === EXIT_OK), `attempt ${attempt}`).toHaveLength(1);

      const { commonDir, worktreeKey } = await storeOf(raced);
      const current = await createRunStore(commonDir).current(worktreeKey);
      expect(current.ok && current.runId !== undefined).toBe(true);
    }
  });

  it("counts a closed round as present only when a round of that number was opened", async () => {
    const dir = await initRepo();
    const orphan = await startRun(dir);
    const closed = {
      round: 1,
      candidateTreeSha: TREE_SHA,
      outcome: "aligned",
      findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
      cost: { unit: "usd", total: 0, reportedBy: "vitest" },
    };
    expect((await emit(dir, ["review.round.closed"], closed)).code).toBe(EXIT_OK);

    // `missing` pairs rounds; `present` must answer under the same rule, or the
    // readout names one entry on both rows and a reader cannot tell what the
    // run still owes.
    await expectRoundClosedAbsent(dir, orphan);

    await emit(dir, ["run.ended"], { result: "partial", cost: { unit: "usd", total: 0, reportedBy: "vitest" } });
    const paired = await startRun(dir);
    expect(
      (await emit(dir, ["review.round.opened"], { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] })).code,
    ).toBe(EXIT_OK);
    expect((await emit(dir, ["review.round.closed"], closed)).code).toBe(EXIT_OK);

    const { present, missing } = await readoutRowsFor(dir, paired);
    expect(present).toContain("review.round.closed");
    expect(missing).not.toContain("review.round.closed");

    // The two discriminators the pairing rule is made of, each pinned by a
    // journal that satisfies every OTHER condition. Without these the rule can
    // lose the round comparison, or lose the ordering, and stay green.
    //
    // Mismatched number: round 2 opened, round 1 closed. Pairing on any opened
    // round rather than the same one would report this closed round present.
    await emit(dir, ["run.ended"], { result: "partial", cost: { unit: "usd", total: 0, reportedBy: "vitest" } });
    const mismatched = await startRun(dir);
    expect(
      (await emit(dir, ["review.round.opened"], { round: 2, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] })).code,
    ).toBe(EXIT_OK);
    expect((await emit(dir, ["review.round.closed"], closed)).code).toBe(EXIT_OK);
    await expectRoundClosedAbsent(dir, mismatched);

    // Wrong order: round 1 closed, then round 1 opened. Pairing without the
    // "opened first" comparison would report this closed round present.
    await emit(dir, ["run.ended"], { result: "partial", cost: { unit: "usd", total: 0, reportedBy: "vitest" } });
    const inverted = await startRun(dir);
    expect((await emit(dir, ["review.round.closed"], closed)).code).toBe(EXIT_OK);
    expect(
      (await emit(dir, ["review.round.opened"], { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] })).code,
    ).toBe(EXIT_OK);
    await expectRoundClosedAbsent(dir, inverted);
  });

  it("keeps present and missing on one predicate when a round closes on both sides of its open", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const closed = {
      round: 1,
      candidateTreeSha: TREE_SHA,
      outcome: "aligned",
      findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
      cost: { unit: "usd", total: 0, reportedBy: "vitest" },
    };
    // Closed, opened, closed. The evaluator pairs the FIRST close with the
    // first open, finds it inverted, and reports the entry missing. A `present`
    // row scanning every close for any earlier open finds the second one and
    // names the same entry on both rows — the contradiction the readout's own
    // comment forbids. One predicate, or the reader is told both things.
    expect((await emit(dir, ["review.round.closed"], closed)).code).toBe(EXIT_OK);
    expect(
      (await emit(dir, ["review.round.opened"], { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] })).code,
    ).toBe(EXIT_OK);
    expect((await emit(dir, ["review.round.closed"], closed)).code).toBe(EXIT_OK);

    await expectRoundClosedAbsent(dir, runId);
  });

  it("says so when it displaces a pointer that names no readable run", async () => {
    const dir = await initRepo();
    const first = await startRun(dir);
    const { runsDir } = await storeOf(dir);
    await unlink(path.join(runsDir, `${first}.jsonl`));

    const started = await emit(dir, ["run.started"], {
      host: "vitest",
      workflow: { releaseId: "test-release", profile: "linear" },
    });
    expect(started.code, started.err).toBe(EXIT_OK);
    // There is no id to record — the pointer named nothing readable — so the
    // summary is the only place this is reported, and a silent success would
    // hide a store that needs attention.
    expect(started.out).toContain("stale pointer");
  });

  // ── Neutralization ─────────────────────────────────────────────────────────

  it("renders executor free text inert and on one line", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const coloured = await emit(dir, ["lens.selected"], {
      mandated: ["lens.outcome-correctness", "lens.adversarial-testing"],
      selected: [],
      rationale: `${ESC}[31mred${ESC}[0m rationale`,
    });
    expect(coloured.code, coloured.err).toBe(EXIT_OK);
    const decided = await emit(dir, ["decision.recorded"], {
      fork: "branch name",
      choice: "chose one\n  4  2026-01-01T00:00:00Z  command.completed  cli  gate ok",
    });
    expect(decided.code, decided.err).toBe(EXIT_OK);

    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(shown.out).not.toContain(ESC);
    expect(shown.out).toContain("red rationale");
    // The forged row is text inside one row, never a row of its own.
    expect(shown.out.split("\n").filter((line) => /^\s*4\s/.test(line))).toEqual([]);
    expect(shown.out).toMatch(/chose one 4 2026-01-01T00:00:00Z command\.completed cli gate ok/);
  });

  it("renders every hostile-capable field of every kind inert, not the two it was written for", async () => {
    // The contract's `label` check bounds length and nothing else, so a
    // rendered `host`, `tracker`, `posture`, gate `command`, blocker `code`,
    // round `outcome`, cost `unit` and compounding `reference` are all
    // executor free text on their way to a terminal, exactly like a
    // `rationale`. Two kinds' worth of coverage samples that surface; a call
    // site that stopped neutralizing anywhere else reached the operator with
    // an escape and a row of its own. This row drives every arm that can carry
    // one and asserts over the WHOLE rendered output.
    const dir = await initRepo();
    const hostile = `${ESC}[31mred${ESC}[0m\n  99  2026-01-01T00:00:00Z  command.completed  cli  gate ok`;
    const cost = { unit: hostile, total: 0, reportedBy: hostile };
    const started = await emit(dir, ["run.started"], {
      host: hostile,
      workflow: { releaseId: "test-release", profile: "linear" },
    });
    expect(started.code, started.err).toBe(EXIT_OK);

    const steps: readonly (readonly [string, unknown])[] = [
      ["ticket.read", { ticket: "V26-1549", tracker: hostile }],
      ["posture.declared", { posture: hostile }],
      [
        "lens.selected",
        { mandated: ["lens.outcome-correctness", "lens.adversarial-testing"], selected: [], rationale: hostile },
      ],
      [
        "review.round.closed",
        { round: 1, candidateTreeSha: TREE_SHA, outcome: hostile, findings: { P0: 0, P1: 0, P2: 0, P3: 0 }, cost },
      ],
      ["gate.reported", { command: hostile, outcome: "pass", durationMs: 5 }],
      ["blocker.recorded", { code: hostile, summary: hostile }],
      ["decision.recorded", { fork: hostile, choice: hostile, cited: hostile }],
      ["compounding.recorded", { outcome: hostile, reference: hostile }],
      ["run.ended", { result: "partial", cost }],
    ];
    for (const [kind, payload] of steps) {
      const result = await emit(dir, [kind], payload);
      expect(result.code, `${kind}: ${result.err}`).toBe(EXIT_OK);
    }
    const runId = (await createRunStore((await storeOf(dir)).commonDir).list())[0]!;
    const events = await journalOf(dir, runId);

    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(shown.out).not.toContain(ESC);
    // The event rows are exactly the journal's own, one per event and no more:
    // a field that opened a row of its own would add a sequence number the
    // journal never wrote, whichever field the text came from.
    const rowSeqs = shown.out
      .split("\n")
      .filter((line) => /^\s*\d+\s+\d{4}-\d{2}-\d{2}T/.test(line))
      .map((line) => Number(line.trim().split(/\s+/)[0]!));
    expect(rowSeqs).toEqual(events.map((event) => event.seq));
    // Every rendered occurrence is collapsed onto its own row's text, so the
    // count of "red" occurrences is the count of fields that rendered one.
    expect(shown.out.match(/red 99 2026-01-01T00:00:00Z command\.completed cli gate ok/g) ?? []).not.toHaveLength(0);
    expect(shown.out).not.toMatch(/\n\s*99\s/);

    // `runs list` renders the same journal's status column and the store path.
    const listed = await cli(dir, ["runs", "list"]);
    expect(listed.code, listed.err).toBe(EXIT_OK);
    expect(listed.out).not.toContain(ESC);
  });

  it("echoes a hostile unknown kind exactly as the note records it", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const refused = await emit(dir, [`${ESC}[31mnope${ESC}[0m`], { anything: true });
    expect(refused.code).toBe(EXIT_POLICY);
    expect(refused.err).not.toContain(ESC);

    const notes = (await notesOf(dir, runId)) as readonly { kind: string }[];
    expect(notes).toHaveLength(1);
    expect(refused.err).toContain(notes[0]!.kind);

    // And the durable line is inert where an operator actually reads it. The
    // note's `kind` is the one field on this row that an executor authored,
    // and it reached the file precisely because the store would not take it.
    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(shown.out).toContain("refused appends:");
    expect(shown.out).not.toContain(ESC);
  });
});
