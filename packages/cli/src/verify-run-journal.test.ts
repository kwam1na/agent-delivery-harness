/**
 * `verify`'s run-journal completeness row, driven the way an operator drives it.
 *
 * Every scenario here runs the real CLI against a real temporary git
 * repository: the whole delivery loop to a committed record, and a real run
 * journal written through `emit` and the boundary wrap. Nothing stubs git and
 * nothing stubs the store, because the one claim this row makes — that THIS
 * record's candidate was journaled completely — is a claim about two
 * independently written artifacts agreeing on one tree sha.
 *
 * THE ROW IS NEVER EVIDENCE. `verify` passes on an absent or incomplete
 * journal exactly as it did before; only the local `--require-run-journal`
 * opt-in fails on one, and that flag reaches neither CI nor the gate.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  MAX_RUN_PROVIDER_ID,
  captureGitCandidate,
  createArtifactsPort,
  defineHarnessConfig,
  resolveRecordStorage,
  sha256Hex,
  withDeliverableIdentity,
  type ArtifactsPort,
  type HarnessConfig,
  type HarnessConfigInput,
  type RunStore,
} from "@agent-delivery-harness/kernel";
import { EXIT_OK, EXIT_POLICY, EXIT_USAGE, runCli, type CliRuntime } from "./index.ts";
import { resolveRunSurface } from "./run-surface.ts";

const exec = promisify(execFile);
const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const PROVIDER = { id: "claude-code.ce-code-review", version: "1.0.0", runId: "r-verify-01", finalPassId: "pass-1" };
const OTHER_TREE_SHA = "b".repeat(40);
const MANDATED = ["lens.outcome-correctness", "lens.adversarial-testing"] as const;
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

function makeConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "verify.run-journal.gate",
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
    providers: [{ id: PROVIDER.id, findingCodes: [] }],
    agentEnvSignals: ["CLAUDE_CODE"],
    ciPolicies: [],
    ciPolicyEnvKey: "DH_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [
      {
        id: "review.green",
        activation: { kind: "relevant_change" },
        freshness: "exact_candidate",
        providers: [PROVIDER.id],
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
    ...overrides,
  });
}

// ── Repository, CLI, and store fixtures ──────────────────────────────────────

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-verify-run-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "harness.config.ts"), "export default {};\n", "utf8");
  await git(dir, "add", "harness.config.ts");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "root");
  await git(dir, "branch", "origin/main");
  writeFileSync(path.join(dir, "src.txt"), "hello world\n", "utf8");
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "work");
  return dir;
}

interface Invocation {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

interface Harness {
  readonly dir: string;
  readonly config: HarnessConfig;
  readonly artifacts: ArtifactsPort;
  /** The candidate tree sha the record will bind, captured before the loop runs. */
  readonly treeSha: string;
  cli(argv: readonly string[]): Promise<Invocation>;
  emit(kind: string, payload: unknown): Promise<Invocation>;
}

async function makeArtifacts(): Promise<ArtifactsPort> {
  const base = await mkdtemp(path.join(os.tmpdir(), "dh-verify-runroot-"));
  cleanups.push(base);
  return createArtifactsPort({ runRootBase: base });
}

async function captureTreeSha(dir: string, config: HarnessConfig): Promise<string> {
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({
    rootDir: dir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
  });
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  return capture.candidate.treeSha;
}

async function makeHarness(overrides: Partial<HarnessConfigInput> = {}): Promise<Harness> {
  const dir = await initRepo();
  const config = makeConfig(overrides);
  const artifacts = await makeArtifacts();
  const treeSha = await captureTreeSha(dir, config);
  const cli = async (argv: readonly string[], extra: Partial<CliRuntime> = {}): Promise<Invocation> => {
    const out: string[] = [];
    const err: string[] = [];
    const runtime: CliRuntime = {
      cwd: dir,
      env: {},
      stdinIsTTY: false,
      stdoutIsTTY: false,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      loadConfig: async () => config,
      artifacts,
      ...extra,
    };
    const code = await runCli(argv, runtime);
    return { code, out: out.join(""), err: err.join("") };
  };
  return {
    dir,
    config,
    artifacts,
    treeSha,
    cli: (argv) => cli(argv),
    emit: (kind, payload) => cli(["emit", kind], { readStdin: async () => JSON.stringify(payload) }),
  };
}

/**
 * The store an invocation from `dir` actually resolves, which under this
 * suite's pinned `DELIVERY_HARNESS_RUN_STORE` is not the one this repository
 * owns. Every assertion here reads back through the same resolver the CLI
 * wrote through, so the two can never disagree about which store was meant.
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

async function currentRun(dir: string): Promise<string | undefined> {
  const { store, worktreeKey } = await storeOf(dir);
  const current = await store.current(worktreeKey);
  if (!current.ok) throw new Error("the pointer is unreadable");
  return current.runId;
}

/** `emit run.started`, returning the run id the store allocated. */
async function startRun(harness: Harness, extra: readonly string[] = []): Promise<string> {
  const started = await harness.cli([
    "emit",
    "run.started",
    ...extra,
    "--json",
    JSON.stringify({ host: "vitest", workflow: { releaseId: "test-release", profile: "linear" } }),
  ]);
  expect(started.code, started.err).toBe(EXIT_OK);
  const runId = await currentRun(harness.dir);
  if (runId === undefined) throw new Error("run.started left no current run");
  return runId;
}

// ── The delivery loop, to a committed record ─────────────────────────────────

function greenPayload(): unknown {
  return {
    verdict: "green",
    finalized: true,
    editedAfterFinalPass: false,
    reviewers: { selected: ["correctness"], completed: ["correctness"], failed: [], timedOut: [] },
    findings: [],
    telemetry: { iterationCount: 1, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, deferredExpansionCount: 0, deferredIssueIds: [] },
  };
}

async function buildAcceptSubmission(harness: Harness): Promise<string> {
  const { dir, config, artifacts } = harness;
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({
    rootDir: dir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
  });
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  const captured = capture.candidate;
  const candidate = {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    headSha: captured.headSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId,
  };
  const allocation = await artifacts.allocateRunRoot({ providerId: PROVIDER.id, runId: PROVIDER.runId });
  if (!allocation.ok) throw new Error(`run root: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;
  const approval = `${JSON.stringify(
    {
      schemaVersion: 1,
      reviewerId: "correctness",
      result: "approved",
      provider: { id: PROVIDER.id, runId: PROVIDER.runId, finalPassId: PROVIDER.finalPassId },
      workspaceId: candidate.workspaceId,
      candidate,
    },
    null,
    2,
  )}\n`;
  await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
  await writeFile(path.join(runRoot, "reviewers/correctness.json"), approval, "utf8");
  const manifest = {
    spec: "delivery-evidence/1",
    provider: PROVIDER,
    candidate,
    repository: null,
    runHistory: [{ preparedTreeSha: captured.treeSha, evaluatedInPassId: PROVIDER.finalPassId }],
    artifacts: [{ path: "reviewers/correctness.json", sha256: sha256Hex(approval), role: "reviewer-approval" }],
    attestation: { level: "self", signatures: [] },
    recordedAt: "2026-09-02T00:00:00Z",
    claims: [{ obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload() }],
  };
  const manifestPath = path.join(runRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

/** `prepare` through `record`, then commit the record. The tree the record binds is unchanged by any of it. */
async function deliverRecord(harness: Harness, options: { readonly between?: () => Promise<void> } = {}): Promise<void> {
  const prepared = await harness.cli(["prepare"]);
  expect(prepared.code, prepared.err).toBe(EXIT_OK);
  const context = await harness.cli(["review-context"]);
  expect(context.code, context.err).toBe(EXIT_OK);
  if (options.between !== undefined) await options.between();
  const manifestPath = await buildAcceptSubmission(harness);
  const submitted = await harness.cli(["submit-evidence", "--manifest", manifestPath]);
  expect(submitted.code, submitted.err).toBe(EXIT_OK);
  const gated = await harness.cli(["gate"]);
  expect(gated.code, gated.err).toBe(EXIT_OK);
  const recorded = await harness.cli(["record"]);
  expect(recorded.code, recorded.err).toBe(EXIT_OK);
}

async function commitRecord(dir: string): Promise<void> {
  await git(dir, "add", "-A", "telemetry");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "record");
}

/** The tree sha the written record actually bound, read back off the tracked record. */
async function recordedTreeSha(dir: string): Promise<string> {
  const recordDir = path.join(dir, "telemetry/delivery-runs");
  const names = (await readdir(recordDir)).filter((name) => name.startsWith("record--") && name.endsWith(".json"));
  expect(names).toHaveLength(1);
  const parsed = JSON.parse(await readFile(path.join(recordDir, names[0]!), "utf8")) as {
    candidateBinding: { treeSha: string };
  };
  return parsed.candidateBinding.treeSha;
}

// ── Journal shapes ───────────────────────────────────────────────────────────

const prerequisites = (): readonly (readonly [string, unknown])[] => [
  ["ticket.read", { ticket: "V26-1556", tracker: "linear" }],
  ["posture.declared", { posture: "test-first" }],
  ["lens.selected", { mandated: [...MANDATED], selected: [...MANDATED], rationale: "the shipped pair" }],
];

const roundOpened = (treeSha: string): readonly [string, unknown] => [
  "review.round.opened",
  { round: 1, candidateTreeSha: treeSha, lenses: [...MANDATED] },
];

const roundClosed = (treeSha: string): readonly [string, unknown] => [
  "review.round.closed",
  {
    round: 1,
    candidateTreeSha: treeSha,
    outcome: "aligned",
    findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
    cost: { unit: "usd", total: 0, reportedBy: "vitest" },
  },
];

const ended = (): readonly [string, unknown] => [
  "run.ended",
  { result: "complete", cost: { unit: "usd", total: 0, reportedBy: "vitest" } },
];

async function emitAll(harness: Harness, steps: readonly (readonly [string, unknown])[]): Promise<void> {
  for (const [kind, payload] of steps) {
    const result = await harness.emit(kind, payload);
    expect(result.code, `${kind}: ${result.err}`).toBe(EXIT_OK);
  }
}

/**
 * A run journaled the way the harness's own delivery journals one: the CLI
 * writes the `gate` and `record` completions from inside the loop, and the
 * executor writes everything around them.
 */
async function journaledDelivery(
  harness: Harness,
  options: { readonly withPrOpened?: boolean; readonly roundTreeSha?: string } = {},
): Promise<string> {
  const runId = await startRun(harness);
  const roundSha = options.roundTreeSha ?? harness.treeSha;
  await emitAll(harness, [...prerequisites(), roundOpened(roundSha), roundClosed(roundSha)]);
  await deliverRecord(harness);
  if (options.withPrOpened !== false) {
    await emitAll(harness, [["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: harness.treeSha }]]);
  }
  await commitRecord(harness.dir);
  await emitAll(harness, [ended()]);
  return runId;
}

/**
 * Athena's finished state: no product command ran, so the journal carries no
 * CLI completion at all and `gate.reported` stands in its ordered place. The
 * record is delivered first, with no run current, so the boundary wrap writes
 * nothing into it.
 */
async function executorOnlyDelivery(harness: Harness): Promise<string> {
  await deliverRecord(harness);
  await commitRecord(harness.dir);
  const runId = await startRun(harness);
  await emitAll(harness, [
    ...prerequisites(),
    roundOpened(harness.treeSha),
    roundClosed(harness.treeSha),
    ["gate.reported", { command: "npm run check", outcome: "pass", durationMs: 5 }],
    ["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: harness.treeSha }],
    ended(),
  ]);
  return runId;
}

/** The row `verify` printed, as the lines under its `run journal:` heading. */
function rowOf(out: string): string {
  const lines = out.split("\n");
  const start = lines.findIndex((line) => line.includes("run journal:"));
  expect(start, `verify printed a run-journal row:\n${out}`).toBeGreaterThanOrEqual(0);
  return lines.slice(start).join("\n");
}

// ── Scenarios ────────────────────────────────────────────────────────────────

describe("verify's run-journal completeness row", () => {
  it("reports complete for a record whose candidate has a complete journal", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    expect(await recordedTreeSha(harness.dir)).toBe(harness.treeSha);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain("complete");
    expect(row).not.toContain("incomplete");
    expect(row).toContain(runId);
    expect(row).toContain("self-attested");
    expect(row).toContain("observability, not evidence");
    // The label that separates this caller from the viewer's: `verify` judged
    // the round constraints against THIS record's candidate.
    expect(row).toContain("bound to the record");

    // The opt-in agrees with the row it reads.
    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code, required.err).toBe(EXIT_OK);
  });

  it("finds the journal by the record's tree sha after the run ended and the pointer was cleared", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    expect(await currentRun(harness.dir), "run.ended clears its own worktree pointer").toBeUndefined();

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    expect(rowOf(verified.out)).toContain(runId);
  });

  it("fails under the opt-in on an incomplete journal, naming the missing kinds, and passes without it", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    await journaledDelivery(harness, { withPrOpened: false });

    const relaxed = await harness.cli(["verify"]);
    expect(relaxed.code, relaxed.err).toBe(EXIT_OK);
    expect(rowOf(relaxed.out)).toContain("pr.opened");

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("pr.opened");
  });

  it("fails under the opt-in on an executor-only journal, naming both CLI completions", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await executorOnlyDelivery(harness);

    const relaxed = await harness.cli(["verify"]);
    expect(relaxed.code, relaxed.err).toBe(EXIT_OK);
    const row = rowOf(relaxed.out);
    expect(row).toContain("complete-executor-only");
    expect(row).toContain(runId);
    expect(row).toContain("command.completed:gate");
    expect(row).toContain("command.completed:record");

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("command.completed:gate");
    expect(required.err).toContain("command.completed:record");
  });

  it("reports mandated-pair-mismatch when --mandated-lens differs from the journal's pair", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    await journaledDelivery(harness);

    const verified = await harness.cli(["verify", "--mandated-lens", "lens.security", "--mandated-lens", "lens.performance"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain("incomplete");
    expect(row).toContain("mandated-pair-mismatch");

    // The journal's own pair, supplied, agrees.
    const agreeing = await harness.cli(["verify", "--mandated-lens", MANDATED[0], "--mandated-lens", MANDATED[1]]);
    expect(agreeing.code, agreeing.err).toBe(EXIT_OK);
    expect(rowOf(agreeing.out)).not.toContain("mandated-pair-mismatch");
  });

  it("reports round-not-bound-to-record when the only paired round binds another tree", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    // Selected on the `pr.opened` that carries the record's tree sha, and still
    // unbound: no CLOSED ROUND names it.
    await deliverRecord(harness);
    await commitRecord(harness.dir);
    const runId = await startRun(harness);
    await emitAll(harness, [
      ...prerequisites(),
      roundOpened(OTHER_TREE_SHA),
      roundClosed(OTHER_TREE_SHA),
      ["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: harness.treeSha }],
      ended(),
    ]);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain(runId);
    expect(row).toContain("incomplete");
    expect(row).toContain("round-not-bound-to-record");

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("round-not-bound-to-record");
  });

  it("resolves two journals binding the record's tree to one run, naming the other in alsoMatching", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const displaced = await startRun(harness);
    await emitAll(harness, [...prerequisites(), roundOpened(harness.treeSha), roundClosed(harness.treeSha)]);

    // The second start displaces the first run's pointer; the first journal is
    // left incomplete and still binds the record's candidate.
    const later = await startRun(harness, ["--force"]);
    expect(later).not.toBe(displaced);
    await emitAll(harness, [...prerequisites(), roundOpened(harness.treeSha), roundClosed(harness.treeSha)]);
    await deliverRecord(harness);
    await emitAll(harness, [["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: harness.treeSha }]]);
    await commitRecord(harness.dir);
    await emitAll(harness, [ended()]);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    // One journal is selected and the other is named beside it; which is which
    // is the store's ranking, asserted where that ranking lives.
    expect(row).toContain(displaced);
    expect(row).toContain(later);
    expect(row).toContain("also matching");
  });

  it("reports absent when the only matching journal refuses the read discipline", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    const { runsDir } = await storeOf(harness.dir);
    // Group-readable: the store's owner-only discipline refuses it, so the scan
    // skips it and there is nothing else to find.
    await chmod(path.join(runsDir, `${runId}.jsonl`), 0o644);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain("absent");
    expect(row).not.toContain(runId);

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("absent");
    await chmod(path.join(runsDir, `${runId}.jsonl`), 0o600);
  });

  it("finds the journal in a repository with a non-default storage namespace", { timeout: 120000 }, async () => {
    const harness = await makeHarness({ storageNamespace: "custom-delivery-namespace/" });
    const runId = await journaledDelivery(harness);

    const verified = await harness.cli(["verify"]);
    expect(verified.code, verified.err).toBe(EXIT_OK);
    const row = rowOf(verified.out);
    expect(row).toContain("complete");
    expect(row).toContain(runId);
  });

  it("resolves the store under the invoking worktree even with GIT_DIR and GIT_COMMON_DIR planted", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    const runId = await journaledDelivery(harness);
    const elsewhere = await makeHarness();
    const saved = { dir: process.env["GIT_DIR"], common: process.env["GIT_COMMON_DIR"] };
    process.env["GIT_DIR"] = path.join(elsewhere.dir, ".git");
    process.env["GIT_COMMON_DIR"] = path.join(elsewhere.dir, ".git");
    try {
      const verified = await harness.cli(["verify"]);
      expect(verified.code, verified.err).toBe(EXIT_OK);
      expect(rowOf(verified.out)).toContain(runId);
      // The planted repository's own store was never read into this row.
      expect(await (await storeOf(elsewhere.dir)).store.list()).toEqual([]);
    } finally {
      if (saved.dir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved.dir;
      if (saved.common === undefined) delete process.env["GIT_COMMON_DIR"];
      else process.env["GIT_COMMON_DIR"] = saved.common;
    }
  });

  it("names the record's own drift, not the journal, when both are wrong under the opt-in", { timeout: 120000 }, async () => {
    const harness = await makeHarness();
    // Incomplete on purpose, and the opt-in is on: if the row were judged
    // before the record, this is the invocation that would say so.
    await journaledDelivery(harness, { withPrOpened: false });
    // The base moves under the `stale` policy, so the record is stale while
    // still being the record this candidate's identity resolves to.
    await git(harness.dir, "branch", "--force", "origin/main", "HEAD");

    const required = await harness.cli(["verify", "--require-run-journal"]);
    expect(required.code).toBe(EXIT_POLICY);
    expect(required.err).toContain("base_tip_moved");
    expect(required.err, "the journal must never stand in for the record's own verdict").not.toContain("run_journal_incomplete");
    expect(required.err).not.toContain("pr.opened");
  });
});

// ── The argument surface ─────────────────────────────────────────────────────

describe("verify's argument surface", () => {
  it("refuses the --flag=value form, an unknown flag, and a --mandated-lens with no value", async () => {
    const harness = await makeHarness();
    for (const argv of [
      ["verify", "--require-run-journal=true"],
      ["verify", "--mandated-lens=lens.outcome-correctness"],
      ["verify", "--unknown-flag"],
      ["verify", "--mandated-lens"],
    ]) {
      const result = await harness.cli(argv);
      expect(result.code, `${argv.join(" ")}: ${result.out}${result.err}`).toBe(EXIT_USAGE);
    }
  });

  /**
   * The charset bound is what keeps an id out of the row it would otherwise be
   * echoed into, so it is pinned on each of the three ways a value can leave
   * the family: empty, out of charset, and over length.
   */
  it("refuses a --mandated-lens id outside the bounded charset or length", async () => {
    const harness = await makeHarness();
    const rejected: readonly string[] = [
      "",
      "Lens Outcome Correctness",
      "lens.Outcome/../x",
      "lens.outcome correctness",
      "lens.outcome\ncorrectness",
      "a".repeat(MAX_RUN_PROVIDER_ID + 1),
    ];
    for (const value of rejected) {
      const result = await harness.cli(["verify", "--mandated-lens", value]);
      expect(result.code, `${JSON.stringify(value)}: ${result.out}${result.err}`).toBe(EXIT_USAGE);
    }
    // And the boundary length itself is accepted, so the bound is a bound and
    // not a blanket refusal.
    const accepted = await harness.cli(["verify", "--mandated-lens", "a".repeat(MAX_RUN_PROVIDER_ID)]);
    expect(accepted.code, accepted.err).not.toBe(EXIT_USAGE);
  });

  it("refuses a positional argument", async () => {
    const harness = await makeHarness();
    const result = await harness.cli(["verify", "record.json"]);
    expect(result.code, result.err).toBe(EXIT_USAGE);
  });

  /**
   * A usage error an operator can act on names the token it refused and the
   * flags it would have accepted, by the exact strings the parser matches.
   */
  it("names the offending token and both accepted flags in every usage refusal", async () => {
    const harness = await makeHarness();
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["verify", "--unknown-flag"], "--unknown-flag"],
      [["verify", "--mandated-lens=lens.outcome-correctness"], "--mandated-lens=lens.outcome-correctness"],
      [["verify", "--mandated-lens"], "--mandated-lens"],
      [["verify", "--mandated-lens", "Lens Outcome Correctness"], "Lens Outcome Correctness"],
      [["verify", "record.json"], "record.json"],
    ];
    for (const [argv, token] of cases) {
      const result = await harness.cli(argv);
      const message = `${result.out}${result.err}`;
      expect(result.code, message).toBe(EXIT_USAGE);
      expect(message, `${argv.join(" ")} names its token`).toContain(token);
      expect(message).toContain("--require-run-journal");
      expect(message).toContain("--mandated-lens");
    }
  });
});
