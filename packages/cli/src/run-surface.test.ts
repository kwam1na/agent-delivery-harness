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
import http from "node:http";
import net from "node:net";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
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
  type RunStore,
} from "@agent-delivery-harness/kernel";
import { COMPLETION_WRAPPED_COMMANDS } from "./boundary.ts";
import { EXIT_OK, EXIT_POLICY, EXIT_USAGE, runCli, type CliRuntime } from "./index.ts";
import { READOUT_LABELS } from "./run-projection.ts";
import { DEFAULT_POLL_SECONDS, RUN_SERVER_CSP, escapeHtml, startRunServer, type RunServerHandle } from "./run-server.ts";
import { RUN_STORE_OVERRIDE, buildRunEvent, resolveRunSurface, resolveWorktreeRoot } from "./run-surface.ts";

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

/**
 * The store this repository owns — where its runs live with no override in
 * play. Resolved through the kernel rather than the CLI's resolver on purpose:
 * this is the store the override has to keep an invocation OUT of.
 */
async function ownStoreOf(
  dir: string,
): Promise<{ readonly runsDir: string; readonly commonDir: string; readonly worktreeKey: string }> {
  const location = await resolveRunStoreLocation({ cwd: dir, run: runGitDirect, env: gitNamespaceClearedEnvironment() });
  if (!location.ok) throw new Error(location.reason);
  return { runsDir: location.runsDir, commonDir: location.commonDir, worktreeKey: location.worktreeKey };
}

/**
 * The store an invocation from `dir` actually resolves, which under this
 * suite's own pin is the override's. Every assertion about what a CLI
 * invocation wrote reads it back through here, so the reader and the writer
 * can never disagree about which store the scenario was about.
 */
async function storeOf(
  dir: string,
): Promise<{
  readonly store: RunStore;
  readonly runsDir: string;
  readonly commonDir: string;
  readonly worktreeKey: string;
}> {
  const resolved = await resolveRunSurface(dir);
  if (!resolved.ok) throw new Error(resolved.reason);
  const { store, runsDir, commonDir, worktreeKey } = resolved.surface;
  return { store, runsDir, commonDir, worktreeKey };
}

/** Runs `body` with the run store pinned at `root`, restoring the suite's pin after. */
async function withStoreOverride<T>(root: string | undefined, body: () => Promise<T>): Promise<T> {
  const pinned = process.env[RUN_STORE_OVERRIDE];
  if (root === undefined) delete process.env[RUN_STORE_OVERRIDE];
  else process.env[RUN_STORE_OVERRIDE] = root;
  try {
    return await body();
  } finally {
    if (pinned === undefined) delete process.env[RUN_STORE_OVERRIDE];
    else process.env[RUN_STORE_OVERRIDE] = pinned;
  }
}

/** Runs `body` with no override at all: every resolution falls back to git. */
async function withoutStoreOverride<T>(body: () => Promise<T>): Promise<T> {
  return withStoreOverride(undefined, body);
}

async function journalOf(dir: string, runId: string): Promise<readonly RunEvent[]> {
  const { store } = await storeOf(dir);
  const read = await store.read(runId);
  if (!read.ok) throw new Error(`journal unreadable: ${JSON.stringify(read.rejections)}`);
  return read.events;
}

async function notesOf(dir: string, runId: string): Promise<readonly unknown[]> {
  const { store } = await storeOf(dir);
  return store.readNotes(runId);
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

/**
 * One `runs show` row's cells. The projection joins a row's cells with two
 * spaces and collapses the whitespace inside every cell, so splitting on the
 * separator recovers exactly what the surface decided to put in each column —
 * which is what a wording assertion has to read, rather than the row's text.
 */
const cellsOf = (row: string): readonly string[] => row.trim().split(/ {2}/);

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
  const { store, worktreeKey } = await storeOf(dir);
  const current = await store.current(worktreeKey);
  if (!current.ok || current.runId === undefined) throw new Error("run.started left no current run");
  return current.runId;
}

/**
 * A journal that satisfies every condition the complete rule states except the
 * two CLI completions, with `gate.reported` in its ordered place: Athena's
 * finished state, and the one status the config-presence note attaches to.
 */
async function executorOnlyRun(dir: string, rationale = "the shipped pair"): Promise<string> {
  const runId = await startRun(dir);
  const steps: readonly (readonly [string, unknown])[] = [
    ["ticket.read", { ticket: "V26-1549", tracker: "linear" }],
    ["posture.declared", { posture: "test-first" }],
    [
      "lens.selected",
      { mandated: ["lens.outcome-correctness", "lens.adversarial-testing"], selected: [], rationale },
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
    // The deny side of `show`'s open/ended header: this run HAS ended, and a
    // header hard-wired to `open` would still satisfy every line above.
    expect(shown.out).toMatch(new RegExp(`^run ${runId} +ended\\b`, "m"));
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
    const { store } = await storeOf(dir);
    expect(await store.list()).toEqual([first]);

    const second = await startRun(dir, ["--force"]);
    expect(second).not.toBe(first);
    expect((await journalOf(dir, second))[0]!.payload).toMatchObject({ displacedRunId: first });
  });

  it("leaves no journal behind when the start's own payload is refused, however many times it is retried", async () => {
    const dir = await initRepo();
    const { store } = await storeOf(dir);

    // `workflow` is required, so the store refuses the append AFTER `allocate`
    // has already created the journal. Nothing points at it and nothing will
    // ever append to it, and `runs list` showed it as an open run beside
    // genuine ones — one more per retry.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refused = await emit(dir, ["run.started"], { host: "x" });
      expect(refused.code, `attempt ${attempt}`).toBe(EXIT_POLICY);
      expect(await store.list(), `attempt ${attempt}`).toEqual([]);
    }

    const listed = await cli(dir, ["runs", "list"]);
    expect(listed.code, listed.err).toBe(EXIT_OK);
    expect(listed.out).toContain("across 0 run(s)");

    // And the start that is not refused still allocates: the removal is the
    // allocator taking back what it created, not a start that stopped working.
    const runId = await startRun(dir);
    expect(await store.list()).toEqual([runId]);
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
    // The affirmative side of the same header the three-writer row pins as
    // `ended`: this run never ended, so it reads open, and current here.
    expect(shown.out).toMatch(new RegExp(`^run ${runId} +open\\b`, "m"));
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
      expect(await (await storeOf(elsewhere)).store.list()).toEqual([]);
    } finally {
      if (saved.dir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved.dir;
      if (saved.common === undefined) delete process.env["GIT_COMMON_DIR"];
      else process.env["GIT_COMMON_DIR"] = saved.common;
    }
  });

  /**
   * The defect this pins: a CLI invocation made from a worktree that has a run
   * current appended a `command.completed` to THAT run, whoever made the
   * invocation. The repository's own suite invokes the CLI from its checkout
   * root, so `npm run check` wrote foreign completions into whatever delivery
   * run was open there. The override is what separates the two: the store a
   * process resolves is the one the override names, so an invocation under it
   * cannot reach the store its worktree would otherwise resolve.
   */
  it("appends nothing to the invoking worktree's own run when the store override names another store", async () => {
    const dir = await initRepo();
    const runId = await withoutStoreOverride(async () => {
      const started = await startRun(dir);
      // The pointer is current in this repository's own store, which is
      // exactly the state the checkout root is in during a live delivery.
      const own = await ownStoreOf(dir);
      const current = await createRunStore(own.commonDir).current(own.worktreeKey);
      expect(current.ok && current.runId).toBe(started);
      return started;
    });
    const own = await ownStoreOf(dir);
    const journalPath = path.join(own.runsDir, `${runId}.jsonl`);
    const before = await readFile(journalPath, "utf8");

    // Every wrapped command, invoked from that worktree, under an override
    // naming a store somewhere else entirely.
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "dh-run-store-"));
    cleanups.push(elsewhere);
    await withStoreOverride(elsewhere, async () => {
      for (const command of COMPLETION_WRAPPED_COMMANDS) await cli(dir, [command]);
    });

    expect(await readFile(journalPath, "utf8")).toBe(before);
    expect(await createRunStore(own.commonDir).readNotes(runId)).toEqual([]);
  });

  /**
   * The wiring half of the same rule, and the one that fails if the suite's
   * own pin is ever removed: this process resolves a store that is not the
   * checkout's, so no test in it — this one included — can reach the run a
   * delivery has open here.
   */
  it("pins the repository's own suite at a store outside the checkout's common directory", async () => {
    const pinned = process.env[RUN_STORE_OVERRIDE];
    expect(pinned, `${RUN_STORE_OVERRIDE} is unset; the suite would resolve the checkout's own run store`).toBeDefined();
    expect(path.isAbsolute(pinned ?? "")).toBe(true);

    const checkout = await ownStoreOf(process.cwd());
    const resolved = await resolveRunSurface(process.cwd());
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.surface.runsDir).not.toBe(checkout.runsDir);
    expect(`${resolved.surface.runsDir}${path.sep}`.startsWith(`${checkout.commonDir}${path.sep}`)).toBe(false);
  });

  /**
   * The fail-closed half of the same override, which neither row above holds.
   * Both of them name a store somewhere else and get one; what the header
   * calls the refusal — a value that is SET but not absolute — has never been
   * exercised, so falling back to the repository's own store here would leave
   * the suite green. A caller that mis-spells its pin is exactly the caller
   * that must not reach a live store by accident: the resolution is refused,
   * the refusal says which variable to fix, and the run the invoking worktree
   * has current is untouched even across every wrapped command.
   */
  it("refuses a relative store override, names the variable, and leaves the invoking worktree's run untouched", async () => {
    const dir = await initRepo();
    const runId = await withoutStoreOverride(async () => startRun(dir));
    const own = await ownStoreOf(dir);
    const journalPath = path.join(own.runsDir, `${runId}.jsonl`);
    const before = await readFile(journalPath, "utf8");

    await withStoreOverride(path.join(".", "relative-store"), async () => {
      const refused = await resolveRunSurface(dir);
      expect(refused.ok, `a relative ${RUN_STORE_OVERRIDE} must be refused, not fall back to the repository's own store`).toBe(
        false,
      );
      // The reason is what an operator acts on, so it has to name the lever
      // rather than describe a path they never typed.
      expect(refused.ok ? "" : refused.reason).toContain(RUN_STORE_OVERRIDE);

      for (const command of COMPLETION_WRAPPED_COMMANDS) await cli(dir, [command]);
    });

    expect(await readFile(journalPath, "utf8")).toBe(before);
    expect(await createRunStore(own.commonDir).readNotes(runId)).toEqual([]);
  });

  /**
   * Blank is unset — the branch `withoutStoreOverride` cannot reach, because it
   * DELETES the variable rather than setting it empty. An environment that
   * exports `DELIVERY_HARNESS_RUN_STORE=` with nothing after it sets it blank,
   * and blank has to land exactly where an unset override lands: the
   * repository's own store, for the resolver and for a wrapped command's
   * completion alike. Refusing it would block every run-store resolution there,
   * and rooting the store at the relative join a blank value produces would
   * file the journal under the process's working directory.
   */
  it("treats a blank store override as unset and resolves the repository's own store", async () => {
    const dir = await initRepo();
    const own = await ownStoreOf(dir);

    const runId = await withStoreOverride("", async () => {
      const resolved = await resolveRunSurface(dir);
      if (!resolved.ok) throw new Error(`a blank ${RUN_STORE_OVERRIDE} was refused: ${resolved.reason}`);
      expect(resolved.surface.runsDir).toBe(own.runsDir);

      const started = await startRun(dir);
      const checked = await cli(dir, ["check"]);
      expect(checked.code, checked.err).toBe(EXIT_OK);
      return started;
    });

    // Read back through the repository's OWN store rather than the resolver
    // under test, so the row says where the events landed and not merely that
    // the resolver is self-consistent.
    const read = await createRunStore(own.commonDir).read(runId);
    if (!read.ok) throw new Error(`the repository's own store holds no journal for ${runId}`);
    expect(read.events.map((event) => event.kind)).toEqual(["run.started", "command.completed"]);
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
    expect(await (await storeOf(dir)).store.list()).toEqual([]);

    const unknownRun = await emit(dir, ["ticket.read", "--run", "run-deadbeefdeadbeef"], {
      ticket: "V26-1549",
      tracker: "linear",
    });
    expect(unknownRun.code).toBe(EXIT_POLICY);
    expect(await (await storeOf(dir)).store.list()).toEqual([]);
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
    // Both sides of the open/ended column, each bound to the run it belongs
    // to. A column pinned only by `/\bopen\b/` says nothing: a reader that
    // printed `open` for every run, ended ones included, satisfies it.
    expect(listed.out).toMatch(new RegExp(`${second}.*\\bopen\\b`));
    expect(listed.out).toMatch(new RegExp(`${first}.*\\bended\\b`));
    expect(listed.out).not.toMatch(new RegExp(`${first}.*\\bopen\\b`));
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

  it("answers the config-presence question at the worktree root from any subdirectory", async () => {
    const dir = await initRepo();
    const runId = await executorOnlyRun(dir);
    const nested = path.join(dir, "packages", "cli");
    await mkdir(nested, { recursive: true });

    // The page answers this at the worktree root. `runs show` answering it at
    // the raw invocation cwd would tell an operator standing two directories
    // down that this repository has no config, while the page — over the same
    // file on disk — says it has one. One journal, one answer.
    const shown = await cli(nested, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(shown.out).toContain(`harness.config.ts present at ${realpathSync(dir)}`);
    expect(shown.out).not.toContain(`present at ${realpathSync(nested)}`);

    const { page } = await pageAndState(await serve([nested]));
    expect(page).toContain(`note: no CLI gate completion in this journal; harness.config.ts present at ${escapedRoot(dir)}`);
  });

  it("does not read a subdirectory's own config as the worktree's", async () => {
    const dir = await initRepo({ withConfig: false });
    const runId = await executorOnlyRun(dir);
    const nested = path.join(dir, "packages", "cli");
    await mkdir(nested, { recursive: true });
    // The file the note looks for, one directory below the root that owns the
    // question. A note answered anywhere but the worktree root — at the cwd,
    // or at the nearest ancestor carrying the file — reports a config this
    // repository does not have.
    await writeFile(path.join(nested, "harness.config.ts"), "export default {};\n", "utf8");

    const shown = await cli(nested, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(shown.out).toContain("complete-executor-only");
    expect(shown.out).not.toContain("harness.config.ts present");

    const { page, state } = await pageAndState(await serve([nested]));
    expect(page).not.toContain("harness.config.ts present");
    expect(runOf(state, runId).readout.note).toBeUndefined();
  });

  it("names the invoking directory where git names a repository but no worktree root", async () => {
    const dir = await initRepo();
    const runId = await executorOnlyRun(dir);

    // A directory git answers `--git-dir` and `--git-common-dir` for and
    // refuses `--show-toplevel` in: the store resolves, so `runs show` runs,
    // while the worktree root does not resolve at all. That is the fallback
    // arm's one reachable entry, and it is asserted rather than assumed — a
    // git that started naming a toplevel here would leave the arm untouched
    // and this row still green.
    const gitDir = path.join(dir, ".git");
    expect((await resolveWorktreeRoot(gitDir)).ok, "no worktree root resolves inside a .git directory").toBe(false);

    // The config the note looks for, planted at that directory, so WHICH root
    // the note names is observable rather than merely absent. The repository's
    // own root carries one too, from `initRepo`, so a fallback that reached
    // for the worktree root instead would also print a note — a different one.
    await writeFile(path.join(gitDir, "harness.config.ts"), "export default {};\n", "utf8");

    const shown = await cli(gitDir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    const note = shown.out.split("\n").find((line) => line.includes("note:")) ?? "";
    expect(note).toBe(`    note: no CLI gate completion in this journal; harness.config.ts present at ${gitDir}`);
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
    const { store } = await storeOf(dir);
    expect(await store.findByCandidateTreeSha(OTHER_TREE_SHA)).toEqual({ runId, alsoMatching: [] });

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
    const { store, commonDir } = await storeOf(dir);
    // The store admits this — a completion claimed by an executor is a legal
    // event. The readout must still refuse to read it as the product's.
    const forged = await store.append(
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

  it("leaves a wrapped command untouched when the store THROWS rather than returning a rejection", async () => {
    const dir = await initRepo();
    const clean = await cli(dir, ["check"]);
    const runId = await startRun(dir);
    const { store, runsDir, commonDir } = await storeOf(dir);
    const journalPath = path.join(runsDir, `${runId}.jsonl`);
    const before = await readFile(journalPath, "utf8");

    // The OTHER failure mode, and the one the wrap's `catch` is the only thing
    // standing between and a command's exit code. `append` converts a
    // `JournalAccessRefused` into a rejection and RETHROWS everything else, so
    // a raw errno reaches the caller as a throw. A read-only journal produces
    // exactly that: still a regular file, still owner-only, so every fstat
    // discipline passes and the failure lands on the write itself as EACCES.
    await chmod(journalPath, 0o400);
    try {
      const thrown = await store
        .append(
          runId,
          buildRunEvent({ runId, commonDir, kind: "posture.declared", role: "executor", payload: { posture: "test-first" } }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      // Pinned as a throw, and as one the store did NOT classify: were this a
      // `JournalAccessRefused`, `append` would have returned a rejection and
      // this row would be the refusal row above under another name.
      expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");
      expect((thrown as Error | undefined)?.name).not.toBe("JournalAccessRefused");

      const sabotaged = await cli(dir, ["check"]);
      expect(sabotaged.code).toBe(clean.code);
      expect(sabotaged.out).toBe(clean.out);
      expect(sabotaged.err).toBe(clean.err);
    } finally {
      await chmod(journalPath, 0o600);
    }
    expect(await readFile(journalPath, "utf8")).toBe(before);
  });

  it("displaces a pointer whose journal is gone rather than allocating one run per retry", async () => {
    const dir = await initRepo();
    const first = await startRun(dir);
    const { store, runsDir, worktreeKey } = await storeOf(dir);
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
    const pointer = await store.current(worktreeKey);
    const second = pointer.ok ? pointer.runId : undefined;
    expect(second).not.toBe(first);
    expect(await store.list()).toEqual([second]);
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

    // Every member driven, not four of seven. The wrap runs whatever the
    // command decided, as the `gate` row shows, so the exit codes vary — and
    // they are kept, because the outcome column below is derived from them.
    const codes = new Map<string, number>();
    for (const command of WRAPPED) codes.set(command, (await cli(dir, [command])).code);
    const completions = (await journalOf(dir, runId)).filter((event) => event.kind === "command.completed");
    const completed = completions.map((event) => event.payload["command"]);
    expect([...new Set(completed)].sort()).toEqual([...WRAPPED].sort());
    expect(completed).toHaveLength(WRAPPED.length);

    // THE OUTCOME COLUMN, NOT ONLY THE COMMAND COLUMN. `command.completed`
    // carries a closed four-value enum the wrap derives from the exit code,
    // and a derivation that lost an arm records the wrong value for every
    // invocation that took it while every assertion above stays green.
    // `submit-evidence` with no `--manifest` is the usage exit among the
    // seven, and it was the arm no journal in this suite had ever recorded;
    // `check` is the ok one beside it. The policy arm is pinned on the gate
    // row that reads a refused `gate` back out of its own journal.
    expect(codes.get("submit-evidence")).toBe(EXIT_USAGE);
    expect(codes.get("check")).toBe(EXIT_OK);
    const outcomeOf = (command: string): unknown =>
      completions.find((event) => event.payload["command"] === command)?.payload["outcome"];
    expect(outcomeOf("submit-evidence")).toBe("usage");
    expect(outcomeOf("check")).toBe("ok");
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

      const { store, worktreeKey } = await storeOf(raced);
      const current = await store.current(worktreeKey);
      expect(current.ok && current.runId !== undefined).toBe(true);
      // ONE journal, not two. The loser allocates and appends a real
      // `run.started` before the exclusive pointer write refuses it, so
      // without the allocator taking its journal back the store holds a
      // second, fully-formed-looking run that `runs list` calls open and
      // nothing distinguishes from an abandoned delivery.
      expect(await store.list(), `attempt ${attempt}`).toEqual([current.ok ? current.runId : undefined]);
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
      // `httpUrl` validates with `new URL` but never writes the parsed form
      // back, so the payload keeps the caller's original string — including
      // C0 controls `new URL` would have percent-encoded had its output been
      // used. So a url is executor free text on the way to a terminal exactly
      // like a rationale, and both lenses filed the arm that renders it as the
      // one this row had left undriven.
      ["pr.opened", { url: `https://example.invalid/${hostile}`, candidateTreeSha: TREE_SHA }],
      ["blocker.recorded", { code: hostile, summary: hostile }],
      ["decision.recorded", { fork: hostile, choice: hostile, cited: hostile }],
      ["compounding.recorded", { outcome: hostile, reference: hostile }],
      ["run.ended", { result: "partial", cost }],
    ];
    for (const [kind, payload] of steps) {
      const result = await emit(dir, [kind], payload);
      expect(result.code, `${kind}: ${result.err}`).toBe(EXIT_OK);
    }
    const runId = (await (await storeOf(dir)).store.list())[0]!;
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

// ── `runs serve` ─────────────────────────────────────────────────────────────

/**
 * The page is driven over a real socket with a real HTTP client, never by
 * calling the request handler directly. Two of this unit's properties — the
 * loopback bind and the `Host` refusal — exist only at the socket, and a
 * handler invoked in-process would report both as passing while neither was
 * ever exercised. `node:http` rather than `fetch` because the client has to be
 * able to send a `Host` the runtime would otherwise write for it, and a method
 * the route table is supposed to refuse.
 */
async function httpRequest(
  url: string,
  headers: Readonly<Record<string, string>> = {},
  method = "GET",
): Promise<{ readonly status: number; readonly headers: NodeJS.Dict<string | string[]>; readonly body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

/** The case almost every row wants: a GET, with whatever headers that row needs. */
const httpGet = (
  url: string,
  headers: Readonly<Record<string, string>> = {},
): ReturnType<typeof httpRequest> => httpRequest(url, headers);

/**
 * One request written onto the socket verbatim, for the single case no HTTP
 * client can express: a request carrying NO `Host` header at all.
 *
 * `node:http` writes a `Host` for every request it sends, and node's own
 * server answers 400 to an HTTP/1.1 request that lacks one before the handler
 * ever runs (`requireHostHeader`, on by default). An HTTP/1.0 request typed
 * onto the socket by hand is what reaches `hostIsBound` with `undefined`.
 */
async function rawRequest(host: string, port: number, lines: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => socket.end(lines.join("\r\n")));
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => resolve(text));
    socket.once("error", reject);
  });
}

/**
 * A port nothing is listening on, obtained the only way available: bind one
 * ephemerally, read it back, release it.
 *
 * A row that asserts a fixed `--port` was honoured cannot hard-code a number —
 * a developer's machine is not empty — and it cannot assert against a port the
 * server chose, because the ephemeral default is exactly what such a row exists
 * to distinguish an honoured `--port` from.
 */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") reject(new Error("the probe bound no inspectable address"));
      else resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface ServedState {
  readonly labels: string;
  readonly pollSeconds: number;
  readonly repositories: readonly { readonly root: string; readonly commonDir: string; readonly runsDir: string; readonly worktreeKeys: readonly string[] }[];
  readonly runs: readonly {
    readonly runId: string;
    readonly repository: string;
    readonly ticket: string;
    readonly open: boolean;
    readonly live: boolean;
    readonly readable: boolean;
    readonly durationSeconds: number;
    readonly rounds: { readonly opened: number; readonly closed: number };
    readonly gate?: { readonly outcome: string; readonly writer: string };
    readonly record?: { readonly outcome: string; readonly writer: string };
    readonly result?: string;
    readonly readout: { readonly status: string; readonly present: readonly string[]; readonly missing: readonly string[]; readonly note?: string };
    readonly timeline: readonly { readonly seq: number; readonly kind: string; readonly writer: string; readonly detail: string }[];
    readonly roundDetail: readonly {
      readonly round: string;
      readonly candidateTreeSha: string;
      readonly opened: boolean;
      readonly lenses: string;
    }[];
  }[];
}

/** A started server, registered for teardown even when the assertion that follows throws. */
const servers: { close(): Promise<void> }[] = [];
afterAll(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function serve(
  repos: readonly string[],
  options: { readonly pollSeconds?: number; readonly port?: number } = {},
): Promise<RunServerHandle> {
  const started = await startRunServer({ repos, ...options });
  if (!started.ok) throw new Error(started.reason);
  servers.push(started.server);
  return started.server;
}

/** The page and the JSON endpoint for one server, both fetched with the Host it bound. */
async function pageAndState(server: RunServerHandle): Promise<{ readonly page: string; readonly state: ServedState }> {
  const host = `${server.host}:${server.port}`;
  const page = await httpGet(`${server.url}/`, { host });
  expect(page.status).toBe(200);
  const json = await httpGet(`${server.url}/api/runs`, { host });
  expect(json.status).toBe(200);
  return { page: page.body, state: JSON.parse(json.body) as ServedState };
}

/** A worktree root as the page spells it: git's own toplevel, HTML-escaped. */
function escapedRoot(dir: string): string {
  return escapeHtml(realpathSync(dir));
}

const runOf = (state: ServedState, runId: string): ServedState["runs"][number] => {
  const found = state.runs.find((run) => run.runId === runId);
  if (found === undefined) throw new Error(`${runId} not served: ${state.runs.map((run) => run.runId).join(",")}`);
  return found;
};

/**
 * One run's own block on the page: everything between its heading and the next
 * run's, or the end of the document.
 *
 * The page renders every run under one `<h2>`, and a block that read another
 * run's projection would still put the right words SOMEWHERE on the page.
 * Slicing to the heading is what makes "this run's completeness" an assertion
 * about this run rather than about the document.
 */
function sectionFor(page: string, runId: string): string {
  const heading = `<h2>${runId}</h2>`;
  const start = page.indexOf(heading);
  expect(start, `${runId} has no heading on the page`).toBeGreaterThan(-1);
  const rest = page.slice(start + heading.length);
  const next = rest.indexOf("<h2>");
  return next === -1 ? rest : rest.slice(0, next);
}

/** A journal carrying both writers, a paired round, and an end. */
async function scriptedRun(dir: string, options: { readonly rationale?: string } = {}): Promise<string> {
  const runId = await startRun(dir);
  const steps: readonly (readonly [string, unknown])[] = [
    ["ticket.read", { ticket: "V26-1555", tracker: "linear" }],
    ["posture.declared", { posture: "test-first" }],
    [
      "lens.selected",
      {
        mandated: ["lens.outcome-correctness", "lens.adversarial-testing"],
        selected: [],
        rationale: options.rationale ?? "the shipped pair",
      },
    ],
    ["review.round.opened", { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }],
    [
      "review.round.closed",
      {
        round: 1,
        candidateTreeSha: TREE_SHA,
        outcome: "aligned",
        findings: { P0: 0, P1: 2, P2: 0, P3: 0 },
        cost: { unit: "usd", total: 1, reportedBy: "vitest" },
      },
    ],
  ];
  for (const [kind, payload] of steps) {
    const result = await emit(dir, [kind], payload);
    expect(result.code, `${kind}: ${result.err}`).toBe(EXIT_OK);
  }
  // The CLI's own writers: two wrapped commands, appended by the boundary.
  expect((await cli(dir, ["check"])).code).toBe(EXIT_OK);
  const opened = await emit(dir, ["pr.opened"], { url: "https://example.invalid/pr/1555", candidateTreeSha: TREE_SHA });
  expect(opened.code, opened.err).toBe(EXIT_OK);
  return runId;
}

describe("runs serve", () => {
  it("renders the scripted journal, both writers labeled, with each round's candidate", async () => {
    const dir = await initRepo();
    const runId = await scriptedRun(dir);
    const ended = await emit(dir, ["run.ended"], { result: "complete", cost: { unit: "usd", total: 2, reportedBy: "vitest" } });
    expect(ended.code, ended.err).toBe(EXIT_OK);

    const { page, state } = await pageAndState(await serve([dir]));
    const run = runOf(state, runId);

    expect(run.ticket).toBe("V26-1555");
    expect(run.rounds).toEqual({ opened: 1, closed: 1 });
    expect(run.result).toBe("complete");
    expect(run.record).toBeUndefined();
    expect(run.timeline.map((entry) => entry.kind)).toContain("command.completed");

    // The writer label is the point: a CLI completion and an executor's claim
    // to have run the same command must never read alike.
    expect(run.timeline.find((entry) => entry.kind === "command.completed")?.writer).toBe("cli");
    expect(run.timeline.find((entry) => entry.kind === "pr.opened")?.writer).toBe("executor");

    // And the PAGE carries the writer beside each event, not just the JSON:
    // the confusion this label exists to prevent is an operator reading the
    // executor's claim to have run a command as the product's own record of
    // having run it.
    expect(page).toContain("<td>cli-written</td>");
    expect(page).toContain("<td>executor-written</td>");

    // The per-run timeline carries each round's candidate.
    expect(run.roundDetail.map((round) => round.candidateTreeSha)).toEqual([TREE_SHA]);
    expect(page).toContain(TREE_SHA);
    expect(page).toContain(runId);
    expect(page).toContain("https://example.invalid/pr/1555");
    expect(page).toContain("test-first");
  });

  it("shows a live-appended event on the next poll and stops polling once the run ends", async () => {
    const dir = await initRepo();
    const runId = await scriptedRun(dir);
    const server = await serve([dir], { pollSeconds: 1 });

    const live = await pageAndState(server);
    expect(runOf(live.state, runId).live).toBe(true);
    expect(runOf(live.state, runId).open).toBe(true);
    // The CELL, not the word. The stylesheet names all three states, so
    // `toContain("ended")` holds on every page ever rendered; only the cell
    // distinguishes a run the operator is watching from one that has stopped.
    expect(live.page).toContain('<td class="live">live</td>');
    expect(live.page).not.toContain('<td class="ended">ended</td>');
    // A live run is what makes the page refresh itself; the interval is the
    // page's own declaration, so an operator can see how stale a row may be.
    expect(live.page).toContain('http-equiv="refresh"');
    expect(live.page).toContain('content="1"');
    expect(live.page).not.toContain("branch name");

    const decided = await emit(dir, ["decision.recorded"], { fork: "branch name", choice: "ticket branch" });
    expect(decided.code, decided.err).toBe(EXIT_OK);

    // One poll later — which for a server that reads the store per request is
    // simply the next request — the page carries the event.
    const refreshed = await pageAndState(server);
    expect(refreshed.page).toContain("branch name");
    expect(runOf(refreshed.state, runId).timeline.map((entry) => entry.kind)).toContain("decision.recorded");

    const ended = await emit(dir, ["run.ended"], { result: "complete", cost: { unit: "usd", total: 2, reportedBy: "vitest" } });
    expect(ended.code, ended.err).toBe(EXIT_OK);

    const after = await pageAndState(server);
    expect(runOf(after.state, runId).live).toBe(false);
    expect(runOf(after.state, runId).open).toBe(false);
    expect(after.page).toContain('<td class="ended">ended</td>');
    expect(after.page).not.toContain('<td class="live">live</td>');
    // Nothing is live, so nothing is polled. The refresh is what an operator
    // pays for in requests; a store with only finished runs must cost nothing.
    expect(after.page).not.toContain('http-equiv="refresh"');
  });

  it("renders the poll interval it declares, not one the page hardcodes", async () => {
    const dir = await initRepo();
    await startRun(dir);

    // The other live row serves `pollSeconds: 1`. This one names no interval,
    // so the page renders the constant the server declares — and a renderer
    // that spelled either number into the markup fails one of the two.
    expect(DEFAULT_POLL_SECONDS, "the two live rows must not assert the same interval").not.toBe(1);

    const { page, state } = await pageAndState(await serve([dir]));
    expect(state.pollSeconds).toBe(DEFAULT_POLL_SECONDS);
    // Both places the interval reaches the operator: the refresh the browser
    // obeys, and the prose that tells a reader how stale a row may be.
    expect(page).toContain(`<meta http-equiv="refresh" content="${DEFAULT_POLL_SECONDS}">`);
    expect(page).toContain(`<p class="meta">refreshing every ${DEFAULT_POLL_SECONDS}s while a run is live</p>`);
  });

  it("gives each repository its own pointer key, store root, and root path under a planted git environment", async () => {
    const first = await initRepo();
    const second = await initRepo();
    const liveRunId = await startRun(first);
    const otherRunId = await startRun(second);
    const ended = await emit(second, ["run.ended"], { result: "partial", cost: { unit: "usd", total: 0, reportedBy: "vitest" } });
    expect(ended.code, ended.err).toBe(EXIT_OK);

    const firstStore = await storeOf(first);
    const secondStore = await storeOf(second);
    expect(firstStore.worktreeKey).not.toBe(secondStore.worktreeKey);

    // An inherited git environment must never relocate a store OR rename a
    // root. It names the SECOND repository while the server resolves both.
    //
    // BOTH VARIABLES, because the server runs two different git queries per
    // `--repo` path and `GIT_DIR` alone only decides one of them. The store
    // resolution reads the common directory, which `GIT_DIR` moves. The root
    // comes from `rev-parse --show-toplevel`, and with only `GIT_DIR` planted
    // that query still answers with its own cwd — so an uncleared toplevel
    // query would have passed this row while being just as inherited. Adding
    // `GIT_WORK_TREE` is what makes an uncleared `--show-toplevel` in the
    // first path name the second repository.
    const planted = { dir: process.env["GIT_DIR"], workTree: process.env["GIT_WORK_TREE"] };
    process.env["GIT_DIR"] = path.join(second, ".git");
    process.env["GIT_WORK_TREE"] = second;
    try {
      const { state } = await pageAndState(await serve([first, second]));
      expect(state.repositories.map((repository) => repository.runsDir)).toEqual([firstStore.runsDir, secondStore.runsDir]);

      // The roots the page names are the toplevels of the paths the operator
      // gave, not the work tree the environment pointed at.
      expect(state.repositories.map((repository) => repository.root)).toEqual([realpathSync(first), realpathSync(second)]);
      expect(state.repositories.map((repository) => repository.worktreeKeys[0])).toEqual([
        firstStore.worktreeKey,
        secondStore.worktreeKey,
      ]);

      // Each run belongs to the repository whose store holds it, and liveness
      // does not cross: the second repository's pointer was cleared by its own
      // `run.ended`, and the first's run is live only under the first.
      expect(runOf(state, liveRunId).repository).toBe(realpathSync(first));
      expect(runOf(state, liveRunId).live).toBe(true);
      expect(runOf(state, otherRunId).repository).toBe(realpathSync(second));
      expect(runOf(state, otherRunId).live).toBe(false);
    } finally {
      if (planted.dir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = planted.dir;
      if (planted.workTree === undefined) delete process.env["GIT_WORK_TREE"];
      else process.env["GIT_WORK_TREE"] = planted.workTree;
    }
  });

  it("renders a run live in an unnamed worktree of the same repository as open but not live", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const other = path.join(path.dirname(dir), `${path.basename(dir)}-served`);
    cleanups.push(other);
    await git(dir, "worktree", "add", "--quiet", "-b", "served", other);

    // Only worktree B is named. The store is shared — one common directory —
    // so the run is listed; the pointer that would make it live belongs to A,
    // and the server reads only the pointers of the worktrees it was given.
    const { page, state } = await pageAndState(await serve([other]));
    expect(runOf(state, runId).open).toBe(true);
    expect(runOf(state, runId).live).toBe(false);
    expect(page).toContain(runId);
    expect(page).toContain('<td class="open">open</td>');
    expect(page).not.toContain('<td class="live">live</td>');
  });

  it("groups both named worktrees of one repository, listing the run once and reading every pointer", async () => {
    const dir = await initRepo();
    const other = path.join(path.dirname(dir), `${path.basename(dir)}-grouped`);
    cleanups.push(other);
    await git(dir, "worktree", "add", "--quiet", "-b", "grouped", other);

    // The run is started in the worktree named SECOND, so the pointer that
    // makes it live is not the group's first: a server that read one pointer
    // per store would render this run open and never live.
    const runId = await startRun(other);

    const first = await storeOf(dir);
    const second = await storeOf(other);
    expect(first.commonDir).toBe(second.commonDir);
    expect(first.worktreeKey).not.toBe(second.worktreeKey);

    // Named on its own, the first worktree holds no pointer at this run. That
    // is the control: whatever makes the run live below came from the other.
    const alone = await pageAndState(await serve([dir]));
    expect(runOf(alone.state, runId).live).toBe(false);

    const { page, state } = await pageAndState(await serve([dir, other]));

    // One store, so one group — carrying both keys, in the order the operator
    // named them, with the first named path owning the group's root.
    expect(state.repositories).toHaveLength(1);
    expect(state.repositories[0]?.worktreeKeys).toEqual([first.worktreeKey, second.worktreeKey]);
    expect(state.repositories[0]?.root).toBe(realpathSync(dir));

    // Two worktrees, one store: the run is served once, not once per key.
    expect(state.runs.filter((run) => run.runId === runId)).toHaveLength(1);
    expect(page.split(`<h2>${runId}</h2>`).length - 1).toBe(1);

    // And it is live, which only the second worktree's pointer can say.
    expect(runOf(state, runId).live).toBe(true);
    expect(page).toContain('<td class="live">live</td>');
  });

  it("binds loopback on an ephemeral port and refuses a foreign Host", async () => {
    const dir = await initRepo();
    await startRun(dir);
    const server = await serve([dir]);

    // `host` is read back off the bound socket, not echoed from the constant
    // handed to `listen`, so a server that bound every interface would report
    // `0.0.0.0` (or `::`) here and this row would fail. That is the whole of
    // the loopback claim: a handle that repeated its own input could not
    // distinguish the two.
    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);

    const bound = await httpGet(`${server.url}/`, { host: `${server.host}:${server.port}` });
    expect(bound.status).toBe(200);

    // A name that is not the bound address is a request that arrived through
    // something else — a DNS rebind, a proxy, a page on another origin. The
    // page renders executor-written text, so it answers only to itself.
    const foreign = await httpGet(`${server.url}/`, { host: "harness.example.invalid" });
    expect(foreign.status).toBe(403);
    expect(foreign.body).not.toContain(dir);

    const noHost = await httpGet(`${server.url}/api/runs`, { host: "127.0.0.1" });
    expect(noHost.status).toBe(403);
  });

  it("binds the port it was given and answers to that exact pair", async () => {
    const dir = await initRepo();
    await startRun(dir);
    const port = await freePort();
    const server = await serve([dir], { port });

    // The handle reports the port read back off the socket, so a server that
    // dropped the input and took an ephemeral port instead would report a
    // different number here. That is the whole difference between honouring
    // `--port` and appearing to.
    expect(server.port).toBe(port);
    expect(server.url).toBe(`http://127.0.0.1:${port}`);

    // And the `Host` check is computed from the pair actually bound, so a
    // fixed port has to be part of the name the page answers to — and the
    // ephemeral port the server would otherwise have taken is not it.
    expect((await httpGet(`${server.url}/`, { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await httpGet(`${server.url}/`, { host: `127.0.0.1:${port + 1}` })).status).toBe(403);
  });

  it("answers HEAD like GET and refuses every other method with 405", async () => {
    const dir = await initRepo();
    await startRun(dir);
    const server = await serve([dir]);
    const host = `${server.host}:${server.port}`;

    // HEAD is in the route table with GET, so it bounds the refusal below: a
    // server that answered 405 to everything but GET would pass every row of
    // the loop and fail this one.
    expect((await httpRequest(`${server.url}/`, { host }, "HEAD")).status).toBe(200);

    // EVERY route, not one, because the guard's POSITION is the property being
    // asserted: it sits above the route table, so a guard moved below the `/`
    // branch would answer `POST /` with the whole rendered run store while a
    // loop that only ever asked for `/api/runs` stayed green.
    for (const route of ["/", "/api/runs", "/nothing-here"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const at = `${method} ${route}`;
        const response = await httpRequest(`${server.url}${route}`, { host }, method);
        expect(response.status, at).toBe(405);
        expect(response.body, at).toBe("method not allowed\n");
        // A refusal is a response like any other. It is rendered in the
        // operator's browser, so it is served under the same policy the page
        // is — all four headers, and no cross-origin allowance.
        expect(response.headers["content-security-policy"], at).toBe(RUN_SERVER_CSP);
        expect(response.headers["x-content-type-options"], at).toBe("nosniff");
        expect(response.headers["referrer-policy"], at).toBe("no-referrer");
        expect(response.headers["cache-control"], at).toBe("no-store");
        expect(response.headers["access-control-allow-origin"], at).toBeUndefined();
      }
    }
  });

  it("carries the security headers on a 403, and refuses a request with no Host at all", async () => {
    const dir = await initRepo();
    await startRun(dir);
    const server = await serve([dir]);

    // The 403 is the response a rebound page actually receives, so it is the
    // one response whose headers matter most: a refusal served without
    // `nosniff` or the policy is a refusal a browser may still render as
    // something.
    const foreign = await httpGet(`${server.url}/`, { host: "harness.example.invalid" });
    expect(foreign.status).toBe(403);
    expect(foreign.headers["content-security-policy"]).toBe(RUN_SERVER_CSP);
    expect(foreign.headers["x-content-type-options"]).toBe("nosniff");
    expect(foreign.headers["referrer-policy"]).toBe("no-referrer");
    expect(foreign.headers["cache-control"]).toBe("no-store");
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();

    // `hostIsBound` compares an ABSENT header against the bound pair, and the
    // row above never reaches that branch — it sends a wrong host, not a
    // missing one. This one sends no `Host`, which only a hand-written
    // HTTP/1.0 request can do, and it is refused with everything else.
    const absent = await rawRequest(server.host, server.port, ["GET /api/runs HTTP/1.0", "", ""]);
    expect(absent).toContain("403 Forbidden");
    expect(absent).toContain("forbidden host");
    expect(absent).toContain(`Content-Security-Policy: ${RUN_SERVER_CSP}`);
    // Nothing about the store leaks through the refusal, on this path either.
    expect(absent).not.toContain(realpathSync(dir));
  });

  it("serves JSON and the page with nosniff, the policy header, and no cross-origin allowance", async () => {
    const dir = await initRepo();
    await startRun(dir);
    const server = await serve([dir]);
    const host = `${server.host}:${server.port}`;

    for (const route of ["/", "/api/runs", "/nothing-here"]) {
      const response = await httpGet(`${server.url}${route}`, { host });
      expect(response.headers["x-content-type-options"], route).toBe("nosniff");
      expect(String(response.headers["content-security-policy"]), route).toContain("default-src 'none'");
      expect(String(response.headers["content-security-policy"]), route).toContain("script-src 'none'");
      expect(response.headers["access-control-allow-origin"], route).toBeUndefined();
    }

    const json = await httpGet(`${server.url}/api/runs`, { host });
    expect(String(json.headers["content-type"])).toContain("application/json");
    expect(String((await httpGet(`${server.url}/`, { host })).headers["content-type"])).toContain("text/html");
    expect((await httpGet(`${server.url}/nothing-here`, { host })).status).toBe(404);
  });

  it("renders executor markup and a marked-up root path as text", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "dh-run-mk-"));
    cleanups.push(parent);
    // No `/` in the name: `</b>` would be a second path segment. `<b>repo` is
    // markup enough to prove the escaping, and is one directory.
    const dir = path.join(parent, "<b>repo");
    await mkdir(dir);
    await git(dir, "init", "--quiet", "--initial-branch", "main");
    await git(dir, "config", "user.email", "harness@example.invalid");
    await git(dir, "config", "user.name", "Delivery Harness");
    await git(dir, "config", "commit.gpgsign", "false");
    await writeFile(path.join(dir, "harness.config.ts"), "export default {};\n", "utf8");
    await git(dir, "add", "-A");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "root");

    const runId = await executorOnlyRun(dir, "<script>alert(1)</script>");
    const { page, state } = await pageAndState(await serve([dir]));

    // Neither the rationale nor the root path in the note may reach the
    // browser as markup. Both are rendered; neither is a tag.
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toContain("<b>repo");
    // The NOTE's own line, not merely the escaped path — the path also reaches
    // the page through the repository heading, so asserting the escaped
    // spelling alone would hold with the note never rendered at all.
    expect(page).toContain(`note: no CLI gate completion in this journal; harness.config.ts present at ${escapedRoot(dir)}`);
    expect(runOf(state, runId).readout.note).toContain("<b>repo");
  });

  it("carries the readout labels, the writer roles, and the note exactly when runs show would", async () => {
    const withConfig = await initRepo();
    const withConfigRunId = await executorOnlyRun(withConfig);
    const withoutConfig = await initRepo({ withConfig: false });
    const withoutConfigRunId = await executorOnlyRun(withoutConfig);

    // Served SEPARATELY, because the claim under test is that one page does
    // not carry the note. One page over both repositories could only ever be
    // asked whether the note appears somewhere on it.
    const noted = await pageAndState(await serve([withConfig]));
    const unnoted = await pageAndState(await serve([withoutConfig]));

    // The readout block's own labelled line, which is the only place the
    // status and the three labels appear together. The page-wide banner also
    // prints the labels, so asserting them alone would hold with the whole
    // per-run readout deleted.
    expect(noted.page).toContain(`complete-executor-only — ${READOUT_LABELS}`);
    expect(noted.page).toContain("present: run.started, ticket.read");
    expect(noted.page).toContain("missing: command.completed:gate, command.completed:record");
    expect(noted.page).toContain("note: no CLI gate completion in this journal");
    expect(noted.page).toContain(`harness.config.ts present at ${escapedRoot(withConfig)}`);

    const notedRun = runOf(noted.state, withConfigRunId);
    expect(notedRun.readout.status).toBe("complete-executor-only");
    expect(notedRun.readout.missing).toContain("command.completed:gate");
    expect(notedRun.gate).toEqual({ outcome: "pass", writer: "executor" });
    expect(notedRun.timeline.find((entry) => entry.kind === "gate.reported")?.writer).toBe("executor");
    expect(notedRun.timeline.find((entry) => entry.kind === "pr.opened")?.writer).toBe("executor");
    // An adopter's gate is the executor's word, and the page says so.
    expect(noted.page).toContain("(executor-written)");
    expect(noted.page).not.toContain("(cli-written)");

    // The note is the presence check's, not the page's: the repository without
    // a config gets the same status and no note, exactly as `runs show` does.
    expect(unnoted.page).toContain(`complete-executor-only — ${READOUT_LABELS}`);
    expect(unnoted.page).not.toContain("no CLI gate completion in this journal");
    expect(runOf(unnoted.state, withoutConfigRunId).readout.note).toBeUndefined();

    const shownWith = await cli(withConfig, ["runs", "show", withConfigRunId]);
    const shownWithout = await cli(withoutConfig, ["runs", "show", withoutConfigRunId]);
    expect(shownWith.out).toContain("no CLI gate completion in this journal");
    expect(shownWithout.out).not.toContain("no CLI gate completion in this journal");
  });

  it("gives each run on one page its own timeline, rounds, notes, repository, and completeness", async () => {
    // Two repositories, both carrying a config, served TOGETHER — which is what
    // the separately-served rows above cannot do: with one run on the page,
    // rendering `runs[0]`'s readout under every heading is indistinguishable
    // from rendering each run's own.
    const finished = await initRepo();
    const finishedRunId = await executorOnlyRun(finished);
    const barelyStarted = await initRepo();
    const barelyStartedRunId = await startRun(barelyStarted);
    // One refused append, against the barely-started run alone. Notes are the
    // fourth per-run block, and with NEITHER run carrying one the block is
    // empty under both headings — which is exactly what a notes table read off
    // the page's first run also renders. The asymmetry is what makes the block
    // answerable at all.
    const refused = await emit(barelyStarted, ["not.a.kind"], { anything: true });
    expect(refused.code, refused.err).toBe(EXIT_POLICY);

    const { page, state } = await pageAndState(await serve([finished, barelyStarted]));
    expect([...state.runs].map((run) => run.runId).sort()).toEqual([finishedRunId, barelyStartedRunId].sort());
    expect(runOf(state, finishedRunId).readout.status).toBe("complete-executor-only");
    expect(runOf(state, barelyStartedRunId).readout.status).toBe("incomplete");

    // Each heading is followed by ITS run's completeness, not the page's first.
    const finishedBlock = sectionFor(page, finishedRunId);
    const barelyStartedBlock = sectionFor(page, barelyStartedRunId);
    expect(finishedBlock).toContain(`complete-executor-only — ${READOUT_LABELS}`);
    expect(barelyStartedBlock).toContain(`incomplete — ${READOUT_LABELS}`);
    expect(barelyStartedBlock).not.toContain("complete-executor-only");

    // The present row is the block's own too, asserted as the whole paragraph:
    // the finished journal's row starts with the barely-started one's, so a
    // containment check alone would hold with both blocks reading one run.
    expect(finishedBlock).toContain('<p class="meta">present: run.started, ticket.read,');
    expect(barelyStartedBlock).toContain('<p class="meta">present: run.started</p>');

    // The note belongs to the status that explains it, on the repository it
    // names — once on the whole page, under the heading of the run it is about.
    const note = "note: no CLI gate completion in this journal";
    expect(page.split(note).length - 1, "the note is rendered once, for one run").toBe(1);
    expect(finishedBlock).toContain(`${note}; harness.config.ts present at ${escapedRoot(finished)}`);
    expect(barelyStartedBlock).not.toContain(note);
    expect(runOf(state, barelyStartedRunId).readout.note).toBeUndefined();

    // The other three per-run blocks, and the repository line above them, each
    // asserted on the block that owns it and denied on the block that does not.
    // The two journals are deliberately unalike — one carries a gate, a closed
    // round, and no refusal; the other a single start and one refusal — so a
    // block rendered from the page's FIRST run reads wrong under one of the two
    // headings whichever of them happens to be first.

    // Its own timeline. `run.started` opens both journals, so the gate is the
    // discriminator: only the finished run ever reported one.
    expect(finishedBlock).toContain("<td>gate.reported</td>");
    expect(barelyStartedBlock).toContain("<td>run.started</td>");
    expect(barelyStartedBlock).not.toContain("<td>gate.reported</td>");

    // Its own rounds. The barely-started run opened none, and the table is
    // omitted entirely rather than rendered empty, so the heading is the
    // whole assertion.
    expect(finishedBlock).toContain("<h3>rounds</h3>");
    expect(barelyStartedBlock).not.toContain("<h3>rounds</h3>");

    // Its own refused appends, on the one run that has any.
    expect(barelyStartedBlock).toContain("<h3>refused appends</h3>");
    expect(barelyStartedBlock).toContain("<td>not.a.kind</td>");
    expect(finishedBlock).not.toContain("<h3>refused appends</h3>");

    // Its own repository path, asserted as the WHOLE paragraph: the page prints
    // both roots above the first heading, and the finished block names its root
    // again inside the config-presence note, so a bare containment check would
    // hold on a block that had been handed the other run's path.
    expect(finishedBlock).toContain(`<p class="meta">${escapedRoot(finished)}</p>`);
    expect(barelyStartedBlock).toContain(`<p class="meta">${escapedRoot(barelyStarted)}</p>`);
    expect(barelyStartedBlock).not.toContain(`<p class="meta">${escapedRoot(finished)}</p>`);
  });

  it("distinguishes a round that was never opened, exactly as runs show does", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const closed = (round: number) => ({
      round,
      candidateTreeSha: TREE_SHA,
      outcome: "aligned",
      findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
      cost: { unit: "usd", total: 0, reportedBy: "vitest" },
    });
    // Round 1 opened then closed; round 2 closed having never been opened. The
    // journal carries both so the distinction is read off ONE page: a cell
    // that said "never opened" unconditionally would pass over the second
    // round alone.
    expect(
      (await emit(dir, ["review.round.opened"], { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] })).code,
    ).toBe(EXIT_OK);
    expect((await emit(dir, ["review.round.closed"], closed(1))).code).toBe(EXIT_OK);
    expect((await emit(dir, ["review.round.closed"], closed(2))).code).toBe(EXIT_OK);

    const { page, state } = await pageAndState(await serve([dir]));
    const rounds = runOf(state, runId).roundDetail;
    expect(rounds.map((round) => round.round)).toEqual(["1", "2"]);
    expect(rounds[0]).toMatchObject({ opened: true, lenses: '["lens.outcome-correctness"]' });
    // An empty lenses cell is what an operator reads as "opened, carrying no
    // lens" — the one reading the page must not offer for a round that was
    // never opened at all.
    expect(rounds[1]).toMatchObject({ opened: false, lenses: "never opened" });

    // The rounds table's own cells, in order, so the assertion cannot be
    // satisfied by the words appearing anywhere else on the page.
    expect(page).toContain(`<td>1</td><td>${TREE_SHA}</td><td>[&quot;lens.outcome-correctness&quot;]</td>`);
    expect(page).toContain(`<td>2</td><td>${TREE_SHA}</td><td>never opened</td>`);

    // And the terminal says the same words over the same journal.
    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    // The rounds BLOCK, not any line mentioning a round: the timeline prints
    // `round 2 aligned ...` too, and reading that row instead would leave the
    // rounds table's own cell untested.
    const lines = shown.out.split("\n");
    const header = lines.findIndex((line) => line.trim() === "rounds:");
    expect(header, shown.out).toBeGreaterThan(-1);
    const rows = lines.slice(header + 1, header + 3);
    // The lens CELL, whole, not a substring of the row. `lenses never opened`
    // contains `never opened` too, so a substring check leaves the terminal
    // free to prefix the words the page prints bare — one journal answering
    // one question two ways, in the wording rather than in the verdict, which
    // is the divergence the shared projection exists to close.
    expect(cellsOf(rows[0]!)[2]).toBe('lenses ["lens.outcome-correctness"]');
    expect(cellsOf(rows[1]!)[2]).toBe("never opened");
    // The cell assertions bind one column. This one binds the WHOLE row of the
    // round that did open, because the words may not appear anywhere on it: a
    // surface that grew a second cell carrying them would say `never opened`
    // about an opened round while the page, over the same journal, does not.
    expect(rows[0]).not.toContain("never opened");
  });

  it("labels a CLI-written gate completion as the CLI's", async () => {
    const dir = await initRepo();
    const runId = await scriptedRun(dir);
    const { store, commonDir } = await storeOf(dir);
    // `gate` is a wrapped command, but driving a real gate needs a candidate;
    // the completion the boundary would write is planted through the store so
    // the writer label has a CLI-written gate to distinguish.
    const appended = await store.append(
      runId,
      buildRunEvent({
        runId,
        commonDir,
        kind: "command.completed",
        role: "cli",
        payload: { command: "gate", outcome: "ok", durationMs: 12 },
      }),
    );
    expect(appended.ok, JSON.stringify(appended)).toBe(true);

    const { page, state } = await pageAndState(await serve([dir]));
    expect(runOf(state, runId).gate).toEqual({ outcome: "ok", writer: "cli" });
    // The runs table's gate cell says who wrote the outcome down; without it
    // an adopter's self-reported gate and the product's own completion read
    // identically.
    expect(page).toContain("(cli-written)");
  });

  it("reports the last CLI completion of a re-run command, not the first", async () => {
    // THE SAME BINDING THE COMPLETENESS EVALUATOR SETTLED (V26-1709). The
    // table's gate and record cells answer the same question `cliCompletion`
    // does — which CLI completion of this command governs — from their own
    // `cliCompletionFor`. Left on the first, a page would report the outcome
    // of a gate the delivery re-ran and abandoned while the completeness block
    // beside it judged the re-run, so the two halves of one row would describe
    // two different gates.
    const dir = await initRepo();
    const runId = await scriptedRun(dir);
    const { store, commonDir } = await storeOf(dir);
    for (const [command, outcome] of [
      ["gate", "policy"],
      ["record", "policy"],
      ["gate", "ok"],
      ["record", "ok"],
    ] as const) {
      const appended = await store.append(
        runId,
        buildRunEvent({
          runId,
          commonDir,
          kind: "command.completed",
          role: "cli",
          payload: { command, outcome, durationMs: 12 },
        }),
      );
      expect(appended.ok, JSON.stringify(appended)).toBe(true);
    }

    const { state } = await pageAndState(await serve([dir]));
    expect(runOf(state, runId).gate).toEqual({ outcome: "ok", writer: "cli" });
    expect(runOf(state, runId).record).toEqual({ outcome: "ok", writer: "cli" });
  });

  it("renders a run whose journal will not read rather than failing the page", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const { runsDir } = await storeOf(dir);
    await chmod(path.join(runsDir, `${runId}.jsonl`), 0o644);

    const { page, state } = await pageAndState(await serve([dir]));
    expect(runOf(state, runId).readable).toBe(false);
    expect(page).toContain('<td class="open">unreadable</td>');
    expect(page).toContain("no readable events");
  });

  it("carries the labels banner and the empty-store cell over a store holding no runs", async () => {
    const dir = await initRepo();

    // Nothing has ever run here, so every per-run block is absent and the
    // page-wide banner is the ONLY place the disclaimer can come from. Deleting
    // it would leave this page with no disclaimer at all.
    const { page, state } = await pageAndState(await serve([dir]));
    expect(state.runs).toEqual([]);
    expect(state.labels).toBe(READOUT_LABELS);
    expect(page).toContain(`<p class="labels">${READOUT_LABELS}. Nothing here is read by admission, the gate, or the recorder.</p>`);

    // The runs table still renders, spanning every column it declares, rather
    // than collapsing to nothing an operator could mistake for a failed read.
    expect(page).toContain('<td colspan="10">no runs in this store</td>');
    expect(page).not.toContain("<h2>");
  });
});

/**
 * A run carrying two tickets — the dogfood item and the ordinary item it
 * delivered — with a posture, a gate, and a pull request bound to the one each
 * belongs to. Emitted through the real `emit`, so the store validates every
 * binding on the way in; read back through both viewers, which must agree.
 */
async function twoTicketRun(dir: string): Promise<string> {
  const runId = await startRun(dir);
  const steps: readonly (readonly [string, unknown])[] = [
    ["ticket.read", { ticket: "V26-1558", tracker: "linear" }],
    ["ticket.read", { ticket: "V26-1658", tracker: "linear" }],
    ["posture.declared", { posture: "sensor-only", ticket: "V26-1558" }],
    ["posture.declared", { posture: "characterization-first", ticket: "V26-1658" }],
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
    ["gate.reported", { command: "npm run check", outcome: "pass", durationMs: 5, ticket: "V26-1658" }],
    ["pr.opened", { url: "https://example.invalid/pr/1658", candidateTreeSha: TREE_SHA, ticket: "V26-1658" }],
    ["run.ended", { result: "complete", cost: { unit: "usd", total: 0, reportedBy: "vitest" } }],
  ];
  for (const [kind, payload] of steps) {
    const result = await emit(dir, [kind], payload);
    expect(result.code, `${kind}: ${result.err}`).toBe(EXIT_OK);
  }
  return runId;
}

describe("a run carrying more than one ticket", () => {
  it("binds a posture, a gate, and a pull request to the ticket each names, and reads the first as the run's", async () => {
    const dir = await initRepo();
    const runId = await twoTicketRun(dir);

    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    const row = (kind: string, contains: string): string =>
      shown.out.split("\n").find((line) => line.includes(kind) && line.includes(contains)) ?? "";

    // Each bound entry names its own ticket, and the two postures are told
    // apart by it rather than by which line came first.
    expect(row("posture.declared", "sensor-only")).toContain("V26-1558");
    expect(row("posture.declared", "characterization-first")).toContain("V26-1658");
    expect(row("gate.reported", "npm run check")).toContain("V26-1658");
    expect(row("pr.opened", "pr/1658")).toContain("V26-1658");

    // The run's own ticket is the first one it read, whatever the later
    // entries bind: an entry that omits the member binds to this one.
    const { page, state } = await pageAndState(await serve([dir]));
    const run = runOf(state, runId);
    expect(run.ticket).toBe("V26-1558");

    // The page renders what `runs show` rendered, from the one projection.
    const detailOfKind = (kind: string, contains: string): string =>
      run.timeline.find((entry) => entry.kind === kind && entry.detail.includes(contains))?.detail ?? "";
    expect(detailOfKind("posture.declared", "sensor-only")).toContain("V26-1558");
    expect(detailOfKind("posture.declared", "characterization-first")).toContain("V26-1658");
    expect(detailOfKind("gate.reported", "npm run check")).toContain("V26-1658");
    expect(detailOfKind("pr.opened", "pr/1658")).toContain("V26-1658");

    // The PAGE renders the binding too, not just the JSON: the bound row is
    // named verbatim, so a page that dropped the suffix goes red here rather
    // than passing on the `ticket.read` row that spells the same ticket.
    expect(page).toContain("npm run check pass in 5ms for V26-1658");

    // And nothing about the bindings makes the journal incomplete: the member
    // is optional, so this run reads exactly as an unbound one would.
    expect(run.readout.status).toBe("complete-executor-only");
  });

  it("leaves an unbound posture, gate report, and pull request rendered exactly as before", async () => {
    const dir = await initRepo();
    const runId = await executorOnlyRun(dir);
    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    const rowFor = (kind: string): string => shown.out.split("\n").find((line) => line.includes(kind)) ?? "";

    // The rendering an existing journal gets, unchanged: a posture is its
    // posture, a gate its command and outcome, a pull request its URL and
    // candidate, with no empty binding appended to any of them.
    expect(rowFor("posture.declared").trimEnd()).toMatch(/ {2}test-first$/);
    expect(rowFor("gate.reported").trimEnd()).toMatch(/ {2}npm run check pass in 5ms$/);
    expect(rowFor("pr.opened").trimEnd()).toMatch(new RegExp(`https://example\\.invalid/pr/1 on ${TREE_SHA}$`));
  });
});

describe("the runs serve command", () => {
  it("refuses a joined flag value, an unknown flag, and a missing value", async () => {
    const dir = await initRepo();
    for (const argv of [
      ["runs", "serve", "--port=8080"],
      ["runs", "serve", "--repo"],
      ["runs", "serve", "--port"],
      ["runs", "serve", "--nope", "x"],
      ["runs", "serve", "--port", "not-a-number"],
      ["runs", "serve", "--port", "70000"],
      ["runs", "serve", "extra"],
    ]) {
      const result = await cli(dir, argv);
      expect(result.code, argv.join(" ")).toBe(EXIT_USAGE);
    }
  });

  it("refuses a port a browser would elide from Host, and honours one it would not", async () => {
    const dir = await initRepo();

    // The page's `Host` check is exact equality against the `host:port` it
    // bound — it parses nothing and normalizes nothing, which is what makes
    // the loopback claim answerable by something other than itself. A browser
    // omits a scheme's default port from `Host`, so a page served on one could
    // never satisfy that check: the operator would get a URL they cannot open
    // and a 403 indistinguishable from a rebind. The port is refused where the
    // operator types it, which leaves the check exact.
    for (const port of ["80", "443"]) {
      const refused = await cli(dir, ["runs", "serve", "--port", port]);
      expect(refused.code, port).toBe(EXIT_USAGE);
      expect(refused.err, port).toContain("a browser omits");
    }

    // And it is those two ports, not every port: a parser that refused them
    // all would satisfy the rows above while serving nothing at all.
    const port = await freePort();
    const controller = new AbortController();
    const lines: string[] = [];
    const served = await cli(dir, ["runs", "serve", "--port", String(port)], {
      signal: controller.signal,
      stdout: (text: string) => {
        lines.push(text);
        if (text.includes("http://127.0.0.1:")) controller.abort();
      },
    });
    expect(served.code, served.err).toBe(EXIT_OK);
    expect(lines.join("")).toContain(`http://127.0.0.1:${port}`);
  });

  it("blocks on a --repo path that is not a repository", async () => {
    const dir = await initRepo();
    const outside = await mkdtemp(path.join(os.tmpdir(), "dh-run-out-"));
    cleanups.push(outside);
    const result = await cli(dir, ["runs", "serve", "--repo", outside]);
    expect(result.code).toBe(EXIT_POLICY);
    expect(result.err).toContain("run_store_unresolvable");
  });

  it("serves until it is signalled, naming the URL it bound", async () => {
    const dir = await initRepo();
    await startRun(dir);
    const controller = new AbortController();
    const lines: string[] = [];
    const result = await cli(dir, ["runs", "serve"], {
      signal: controller.signal,
      // The URL line is the operator's only way to reach the page, so it is
      // also what tells this test the socket is up.
      stdout: (text: string) => {
        lines.push(text);
        if (text.includes("http://127.0.0.1:")) controller.abort();
      },
    });
    expect(result.code, result.err).toBe(EXIT_OK);
    expect(lines.join("")).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
  });
});
