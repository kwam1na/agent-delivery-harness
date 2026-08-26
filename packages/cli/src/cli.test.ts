/**
 * The operator surface, end to end.
 *
 * Two kinds of test live here. The boundary tests drive synthetic commands to
 * pin the exit-code and rendering contract deterministically. The loop tests
 * drive the seven real commands against real temporary git repositories — the
 * only way to prove capture, the store, admission, the record write, and the
 * verify core agree about one repository. Nothing here stubs git.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BlockedError,
  captureGitCandidate,
  createArtifactsPort,
  createBlocker,
  defineHarnessConfig,
  deliveryRecordPathFor,
  resolveRecordStorage,
  sha256Hex,
  withDeliverableIdentity,
  type ArtifactsPort,
  type CapturedCandidate,
  type HarnessConfig,
  type HarnessConfigInput,
  type WaiverPrompt,
} from "@delivery-harness/kernel";
import {
  CliInterruption,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_POLICY,
  EXIT_USAGE,
  runCli,
  runCliBoundary,
  wireRepo,
  type CliRuntime,
  type CommandDescriptor,
} from "./index.ts";

const run = promisify(execFile);
const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Config ───────────────────────────────────────────────────────────────────

const PROVIDER = { id: "claude-code.ce-code-review", version: "1.0.0", runId: "r-cli-01", finalPassId: "pass-2" };
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
    gateId: "test.gate",
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

// ── Repo fixtures ────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(await os.tmpdir(), "dh-cli-"));
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

interface Runtime {
  readonly runtime: CliRuntime;
  readonly out: string[];
  readonly err: string[];
}

function makeRuntime(dir: string, config: HarnessConfig, artifacts: ArtifactsPort, overrides: Partial<CliRuntime> = {}): Runtime {
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
    ...overrides,
  };
  return { runtime, out, err };
}

async function makeArtifacts(): Promise<ArtifactsPort> {
  const base = await mkdtemp(path.join(await os.tmpdir(), "dh-runs-"));
  cleanups.push(base);
  return createArtifactsPort({ runRootBase: base });
}

function greenPayload(): unknown {
  return {
    verdict: "green",
    finalized: true,
    editedAfterFinalPass: false,
    reviewers: { selected: ["correctness"], completed: ["correctness"], failed: [], timedOut: [] },
    findings: [],
    telemetry: { iterationCount: 2, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, deferredExpansionCount: 0, deferredIssueIds: [] },
  };
}

/** Captures the candidate the way the CLI does, then builds an accepted manifest bound to it. */
async function buildAcceptSubmission(dir: string, config: HarnessConfig, artifacts: ArtifactsPort): Promise<string> {
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({
    rootDir: dir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
  });
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  const captured: CapturedCandidate = capture.candidate;
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
    recordedAt: "2026-08-25T00:00:00Z",
    claims: [{ obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload() }],
  };
  const manifestPath = path.join(runRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

async function commitRecord(dir: string): Promise<void> {
  await git(dir, "add", "-A", "telemetry");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "record");
}

async function captureDigest(dir: string, config: HarnessConfig): Promise<string> {
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({ rootDir: dir, config, workspaceId: storage.workspaceId, computeIdentity: withDeliverableIdentity() });
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  return capture.candidate.deliverable.digest;
}

// ── Boundary contract (synthetic commands) ───────────────────────────────────

function fakeCommand(name: string, result: CommandDescriptor["run"]): CommandDescriptor {
  return { name, sourceId: `delivery-harness.cli.${name}`, summary: `${name} summary`, run: result };
}

function boundaryRuntime(): Runtime {
  const out: string[] = [];
  const err: string[] = [];
  const runtime: CliRuntime = {
    cwd: process.cwd(),
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    loadConfig: async () => makeConfig(),
  };
  return { runtime, out, err };
}

describe("runCliBoundary exit codes", () => {
  it("returns 0 for a passing command", async () => {
    const { runtime } = boundaryRuntime();
    const code = await runCliBoundary(["ok"], [fakeCommand("ok", async () => ({ kind: "ok", summary: "done" }))], runtime);
    expect(code).toBe(EXIT_OK);
  });

  it("returns 1 for a policy block", async () => {
    const { runtime, err } = boundaryRuntime();
    const blocker = createBlocker({
      code: "blocked_thing",
      source: { kind: "command", id: "delivery-harness.cli.block" },
      summary: "blocked",
      remediations: [{ id: "do-x", kind: "manual_action", summary: "Do x." }],
    });
    const code = await runCliBoundary(["block"], [fakeCommand("block", async () => ({ kind: "blocked", blockers: [blocker] }))], runtime);
    expect(code).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("blocked_thing");
  });

  it("returns 2 for an unknown command", async () => {
    const { runtime, err } = boundaryRuntime();
    const code = await runCliBoundary(["nope"], [fakeCommand("ok", async () => ({ kind: "ok" }))], runtime);
    expect(code).toBe(EXIT_USAGE);
    expect(err.join("")).toContain("Unknown command");
  });

  it("returns 2 for a command-reported usage error", async () => {
    const { runtime } = boundaryRuntime();
    const code = await runCliBoundary(["u"], [fakeCommand("u", async () => ({ kind: "usage", message: "need --flag" }))], runtime);
    expect(code).toBe(EXIT_USAGE);
  });

  it("returns 130 when a command is interrupted (SIGINT)", async () => {
    const { runtime } = boundaryRuntime();
    const code = await runCliBoundary(
      ["i"],
      [
        fakeCommand("i", async () => {
          throw new CliInterruption();
        }),
      ],
      runtime,
    );
    expect(code).toBe(EXIT_INTERRUPTED);
  });

  it("maps an unexpected throw to a redacted internal_error, still exit 1", async () => {
    const { runtime, err } = boundaryRuntime();
    const code = await runCliBoundary(
      ["boom"],
      [
        fakeCommand("boom", async () => {
          throw new Error("secret token=ghp_0123456789abcdefghijでたらめ");
        }),
      ],
      runtime,
    );
    expect(code).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("internal_error");
    expect(err.join("")).not.toContain("ghp_0123456789abcdefghij");
  });

  it("neutralizes hostile blocker text at the CLI surface", async () => {
    const { runtime, err } = boundaryRuntime();
    const blocker = createBlocker({
      code: "hostile",
      source: { kind: "command", id: "delivery-harness.cli.hostile" },
      summary: "clean summary",
      details: "line[31mred[0m‮reversed",
      remediations: [{ id: "fix", kind: "manual_action", summary: "Fix it." }],
    });
    await runCliBoundary(["h"], [fakeCommand("h", async () => ({ kind: "blocked", blockers: [blocker] }))], runtime);
    const text = err.join("");
    expect(text).not.toContain("[31m");
    expect(text).not.toContain("‮");
    expect(text).not.toContain("");
  });
});

// ── U8 coherence ─────────────────────────────────────────────────────────────

describe("repo wiring coherence", () => {
  it("wires capture and the store from one root so their workspace ids agree", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
    const wiring = await wireRepo(dir, config);
    const capture = await wiring.captureCandidate();
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.candidate.workspaceId).toBe(storage.workspaceId);
    expect(wiring.workspaceId).toBe(storage.workspaceId);
  });
});

// ── The full loop ────────────────────────────────────────────────────────────

describe("the full delivery loop", () => {
  it("runs prepare → review-context → submit-evidence → gate → record → verify green", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_OK);

    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    const submitCode = await runCli(["submit-evidence", "--manifest", manifestPath], runtime);
    expect(err.join("")).not.toContain("[");
    expect(submitCode).toBe(EXIT_OK);

    expect(await runCli(["gate"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);

    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const written = await readdir(recordDir);
    expect(written.filter((name) => name.startsWith("record--") && name.endsWith(".json"))).toHaveLength(1);

    await commitRecord(dir);
    expect(await runCli(["verify"], runtime)).toBe(EXIT_OK);
  });
});

// ── Self-neutrality ──────────────────────────────────────────────────────────

describe("delivery record self-neutrality", () => {
  it("writing the record does not change the deliverable identity it attests", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);

    const before = await captureDigest(dir, config);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
    await commitRecord(dir);
    const after = await captureDigest(dir, config);
    expect(after).toBe(before);
  });

  it("negative control: a non-neutral path does change the deliverable identity", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const before = await captureDigest(dir, config);
    writeFileSync(path.join(dir, "poison.txt"), "not neutral\n", "utf8");
    await git(dir, "add", "poison.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "poison");
    const after = await captureDigest(dir, config);
    expect(after).not.toBe(before);
  });
});

// ── Waiver wiring ────────────────────────────────────────────────────────────

describe("waiver wiring", () => {
  it("never prompts and blocks when non-interactive, even for an all-waivable block", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const prompt: WaiverPrompt = vi.fn(async () => true);
    const { runtime } = makeRuntime(dir, config, artifacts, { stdinIsTTY: false, stdoutIsTTY: false, promptForWaiver: prompt });

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    // No evidence submitted: the obligation is active and blocked on a waivable code.
    expect(await runCli(["gate"], runtime)).toBe(EXIT_POLICY);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("waives end to end under a TTY when the operator accepts", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const prompt: WaiverPrompt = vi.fn(async () => true);
    const { runtime } = makeRuntime(dir, config, artifacts, { stdinIsTTY: true, stdoutIsTTY: true, promptForWaiver: prompt });

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_OK);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("returns 130 when the operator interrupts the waiver prompt", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const prompt: WaiverPrompt = async () => {
      throw new CliInterruption("Waiver prompt interrupted.");
    };
    const { runtime } = makeRuntime(dir, config, artifacts, { stdinIsTTY: true, stdoutIsTTY: true, promptForWaiver: prompt });

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_INTERRUPTED);
  });
});

// ── Error paths ──────────────────────────────────────────────────────────────

describe("error paths", () => {
  it("review-context without a receipt blocks and names prepare", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("prepare");
  });

  it("review-context on a stale receipt blocks with a class distinct from missing", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    // Move the candidate: a new commit changes the tree the receipt was cut for.
    writeFileSync(path.join(dir, "more.txt"), "more\n", "utf8");
    await git(dir, "add", "more.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "more");
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
    const text = err.join("");
    expect(text).toContain("preparation_");
    expect(text).not.toContain("preparation_missing");
  });

  it("submit-evidence after an edit rejects on a candidate mismatch", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    // Edit the tree after building the manifest: the re-captured candidate diverges.
    writeFileSync(path.join(dir, "src.txt"), "edited\n", "utf8");
    await git(dir, "add", "src.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "edit");
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_POLICY);
  });

  it("submit-evidence without --manifest is a usage error", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["submit-evidence"], runtime)).toBe(EXIT_USAGE);
  });

  it("record after an edit is refused", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);
    // Dirty the tree, then try to record.
    writeFileSync(path.join(dir, "src.txt"), "edited after gate\n", "utf8");
    expect(await runCli(["record"], runtime)).toBe(EXIT_POLICY);
  });

  it("check on a non-repository blocks with a typed store finding", async () => {
    const notARepo = await mkdtemp(path.join(await os.tmpdir(), "dh-norepo-"));
    cleanups.push(notARepo);
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(notARepo, config, artifacts);
    expect(await runCli(["check"], runtime)).toBe(EXIT_POLICY);
  });

  it("an invalid config is a typed policy block", async () => {
    const dir = await initRepo();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, makeConfig(), artifacts, {
      loadConfig: async () => {
        throw new BlockedError([
          createBlocker({
            code: "config_broken",
            source: { kind: "config", id: "delivery-harness.config" },
            summary: "config is invalid",
            remediations: [{ id: "fix-config", kind: "manual_action", summary: "Fix the config." }],
          }),
        ]);
      },
    });
    expect(await runCli(["check"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("config_broken");
  });

  it("check on a real repository reports readiness", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, out } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["check"], runtime)).toBe(EXIT_OK);
    expect(out.join("")).toContain("test.gate");
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe("concurrent record writes", () => {
  it("two branches with different deliverables write non-conflicting record files", async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digestMain = await captureDigest(dir, config);

    // A second branch with a different deliverable.
    await git(dir, "checkout", "--quiet", "-b", "feature");
    writeFileSync(path.join(dir, "feature.txt"), "feature work\n", "utf8");
    await git(dir, "add", "feature.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "feature");
    const digestFeature = await captureDigest(dir, config);

    expect(digestFeature).not.toBe(digestMain);
    expect(deliveryRecordPathFor(config, digestMain)).not.toBe(deliveryRecordPathFor(config, digestFeature));
  });
});
