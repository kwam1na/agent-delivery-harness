/**
 * The operator surface, end to end.
 *
 * Two kinds of test live here. The boundary tests drive synthetic commands to
 * pin the exit-code and rendering contract deterministically. The loop tests
 * drive the evidence-loop commands against real temporary git repositories — the
 * only way to prove capture, the store, admission, the record write, and the
 * verify core agree about one repository. Nothing here stubs git.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BlockedError,
  captureGitCandidate,
  classifyExecutionContext,
  createArtifactsPort,
  createBlocker,
  defineHarnessConfig,
  deliveryRecordPathFor,
  parseDeliveryRecord,
  resolveRecordStorage,
  runAdmission,
  sha256Hex,
  withDeliverableIdentity,
  type ArtifactsPort,
  type CapturedCandidate,
  type HarnessConfig,
  type HarnessConfigInput,
  type WaiverPrompt,
} from "@agent-delivery-harness/kernel";
import {
  CliInterruption,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_POLICY,
  EXIT_USAGE,
  recordCommand,
  runCli,
  runCliBoundary,
  wireRepo,
  type CliRuntime,
  type CommandDescriptor,
} from "./index.ts";
import { runProviderBackedAdmission } from "./commands/gate.ts";
import type { ProviderRailMessage, ProviderRailSession } from "./provider-rails.ts";

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
async function buildAcceptSubmission(
  dir: string,
  config: HarnessConfig,
  artifacts: ArtifactsPort,
  provider = PROVIDER,
): Promise<string> {
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

  const allocation = await artifacts.allocateRunRoot({ providerId: provider.id, runId: provider.runId });
  if (!allocation.ok) throw new Error(`run root: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;

  const approval = `${JSON.stringify(
    {
      schemaVersion: 1,
      reviewerId: "correctness",
      result: "approved",
      provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId },
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
    provider,
    candidate,
    repository: null,
    runHistory: [
      { preparedTreeSha: "1".repeat(40), evaluatedInPassId: "pass-1" },
      { preparedTreeSha: captured.treeSha, evaluatedInPassId: provider.finalPassId },
    ],
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

// ── Repo coherence ───────────────────────────────────────────────────────────

describe("repo wiring coherence", () => {
  it("wires capture and the store from one root so their workspace ids agree", { timeout: 60000 }, async () => {
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
  it("runs prepare → review-context → submit-evidence → gate → record → verify green", { timeout: 60000 }, async () => {
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

  it("invokes an opt-in provider at the existing record boundary and promotes only its retained green evidence", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig({ providers: [{ id: PROVIDER.id, findingCodes: [], command: ["fake-review-provider"] }] });
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    let opened = 0;
    const railRuntime: CliRuntime = {
      ...runtime,
      openProviderRail: async (): Promise<ProviderRailSession> => {
        opened += 1;
        let receiveCount = 0;
        let terminal: ProviderRailMessage | null = null;
        return {
          async send(message) {
            if (message.kind !== "request") return;
            const manifestPath = await buildAcceptSubmission(dir, config, artifacts, {
              id: PROVIDER.id,
              version: PROVIDER.version,
              runId: message.requestId,
              finalPassId: "pass-2",
            });
            terminal = {
              kind: "terminal",
              outcome: "success",
              requestId: message.requestId,
              sequence: 1,
              summary: "Review complete",
              version: "delivery-provider-rails/1",
              result: { manifestPath },
            };
          },
          async receive() {
            receiveCount += 1;
            if (receiveCount === 1) {
              return {
                kind: "negotiation",
                outcome: "supported",
                selectedVersion: "delivery-provider-rails/1",
                supportedVersions: ["delivery-provider-rails/1"],
              };
            }
            return terminal;
          },
          async close() {},
        };
      },
    };

    expect(await runCli(["prepare"], railRuntime)).toBe(EXIT_OK);
    expect(await runCli(["record"], railRuntime)).toBe(EXIT_OK);
    expect(opened).toBe(1);

    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const recordName = (await readdir(recordDir)).find((name) => name.startsWith("record--") && name.endsWith(".json"));
    expect(recordName).toBeDefined();
    if (recordName === undefined) return;
    const parsed = parseDeliveryRecord(await readFile(path.join(recordDir, recordName), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.claims).toHaveLength(1);
    expect(parsed.record.claims[0]).toMatchObject({
      obligationId: "review.green",
      outcome: "satisfied_evidence",
      providerId: PROVIDER.id,
    });
  });

  it("maps provider success into the existing live-fact delivery claim", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig({
      providers: [{ id: PROVIDER.id, findingCodes: [], command: ["fake-live-provider"] }],
      obligations: [
        {
          id: "review.green",
          activation: { kind: "relevant_change" },
          freshness: "live",
          providers: [PROVIDER.id],
          acceptedPayloadSpecs: ["review.green/1"],
          allowedResolutionKinds: ["satisfied_live_fact", "not_applicable"],
          humanWaiverAllowed: false,
          minimumAttestationLevel: "self",
          ciDelegationPolicyIds: [],
          remediation: { default: [{ id: "run-provider", kind: "retry", summary: "Run the live provider." }] },
          waivableCodes: [],
          nonWaivableCodes: [...STRUCTURAL_WAIVABLE, ...STRUCTURAL_NONWAIVABLE],
        },
      ],
    });
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    let opened = 0;
    const railRuntime: CliRuntime = {
      ...runtime,
      openProviderRail: async (): Promise<ProviderRailSession> => {
        opened += 1;
        let receiveCount = 0;
        let requestId: string | undefined;
        return {
          async send(message) {
            if (message.kind === "request") requestId = message.requestId;
          },
          async receive() {
            receiveCount += 1;
            if (receiveCount === 1) {
              return {
                kind: "negotiation",
                outcome: "supported",
                selectedVersion: "delivery-provider-rails/1",
                supportedVersions: ["delivery-provider-rails/1"],
              };
            }
            if (requestId === undefined) return null;
            return {
              kind: "terminal",
              outcome: "success",
              requestId,
              sequence: 1,
              summary: "Live review complete",
              version: "delivery-provider-rails/1",
            };
          },
          async close() {},
        };
      },
    };

    expect(await runCli(["prepare"], railRuntime)).toBe(EXIT_OK);
    expect(await runCli(["record"], railRuntime)).toBe(EXIT_OK);
    expect(opened).toBe(1);

    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const recordName = (await readdir(recordDir)).find((name) => name.startsWith("record--") && name.endsWith(".json"));
    expect(recordName).toBeDefined();
    if (recordName === undefined) return;
    const parsed = parseDeliveryRecord(await readFile(path.join(recordDir, recordName), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.claims).toHaveLength(1);
    expect(parsed.record.claims[0]).toMatchObject({
      obligationId: "review.green",
      outcome: "satisfied_live_fact",
      providerId: PROVIDER.id,
    });
  });

  it("re-evaluates an existential live obligation after failure and stops after another provider succeeds", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const providerIds = ["failing.provider", "passing.provider"] as const;
    const config = makeConfig({
      providers: providerIds.map((id) => ({ id, findingCodes: [], command: [`fake-${id}`] })),
      obligations: [
        {
          id: "review.green",
          activation: { kind: "relevant_change" },
          freshness: "live",
          providers: providerIds,
          providerPolicy: "existential",
          acceptedPayloadSpecs: ["review.green/1"],
          allowedResolutionKinds: ["satisfied_live_fact", "not_applicable"],
          humanWaiverAllowed: false,
          minimumAttestationLevel: "self",
          ciDelegationPolicyIds: [],
          remediation: { default: [{ id: "run-provider", kind: "retry", summary: "Run an uncovered provider." }] },
          waivableCodes: [],
          nonWaivableCodes: [...STRUCTURAL_WAIVABLE, ...STRUCTURAL_NONWAIVABLE],
        },
      ],
    });
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    const opened: string[] = [];
    const railRuntime: CliRuntime = {
      ...runtime,
      openProviderRail: async ({ providerId }): Promise<ProviderRailSession> => {
        opened.push(providerId);
        let receiveCount = 0;
        let requestId: string | undefined;
        return {
          async send(message) {
            if (message.kind === "request") requestId = message.requestId;
          },
          async receive() {
            receiveCount += 1;
            if (receiveCount === 1) {
              return {
                kind: "negotiation",
                outcome: "supported",
                selectedVersion: "delivery-provider-rails/1",
                supportedVersions: ["delivery-provider-rails/1"],
              };
            }
            if (requestId === undefined) return null;
            return {
              kind: "terminal",
              outcome: providerId === "failing.provider" ? "failed" : "success",
              requestId,
              sequence: 1,
              summary: `${providerId} complete`,
              version: "delivery-provider-rails/1",
            };
          },
          async close() {},
        };
      },
    };

    expect(await runCli(["prepare"], railRuntime)).toBe(EXIT_OK);
    expect(await runCli(["record"], railRuntime)).toBe(EXIT_OK);
    expect(opened).toEqual(["failing.provider", "passing.provider"]);
  });

  it("invokes only the uncovered provider for an all-provider exact-evidence obligation", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const providerIds = ["first.provider", "second.provider"] as const;
    const config = makeConfig({
      providers: providerIds.map((id) => ({ id, findingCodes: [], command: [`fake-${id}`] })),
      obligations: [
        {
          id: "review.green",
          activation: { kind: "relevant_change" },
          freshness: "exact_candidate",
          providers: providerIds,
          providerPolicy: "all",
          acceptedPayloadSpecs: ["review.green/1"],
          allowedResolutionKinds: ["satisfied_evidence", "not_applicable"],
          humanWaiverAllowed: false,
          minimumAttestationLevel: "self",
          ciDelegationPolicyIds: [],
          remediation: { default: [{ id: "run-provider", kind: "retry", summary: "Run the uncovered provider." }] },
          waivableCodes: [],
          nonWaivableCodes: [...STRUCTURAL_WAIVABLE, ...STRUCTURAL_NONWAIVABLE],
        },
      ],
    });
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const existingManifest = await buildAcceptSubmission(dir, config, artifacts, {
      id: "first.provider",
      version: "1.0.0",
      runId: "first-run",
      finalPassId: "pass-2",
    });
    expect(await runCli(["submit-evidence", "--manifest", existingManifest], runtime)).toBe(EXIT_OK);

    const opened: string[] = [];
    const railRuntime: CliRuntime = {
      ...runtime,
      openProviderRail: async ({ providerId }): Promise<ProviderRailSession> => {
        opened.push(providerId);
        let receiveCount = 0;
        let terminal: ProviderRailMessage | null = null;
        return {
          async send(message) {
            if (message.kind !== "request") return;
            const manifestPath = await buildAcceptSubmission(dir, config, artifacts, {
              id: providerId,
              version: "1.0.0",
              runId: message.requestId,
              finalPassId: "pass-2",
            });
            terminal = {
              kind: "terminal",
              outcome: "success",
              requestId: message.requestId,
              sequence: 1,
              summary: "Review complete",
              version: "delivery-provider-rails/1",
              result: { manifestPath },
            };
          },
          async receive() {
            receiveCount += 1;
            if (receiveCount === 1) {
              return {
                kind: "negotiation",
                outcome: "supported",
                selectedVersion: "delivery-provider-rails/1",
                supportedVersions: ["delivery-provider-rails/1"],
              };
            }
            return terminal;
          },
          async close() {},
        };
      },
    };

    expect(await runCli(["record"], railRuntime)).toBe(EXIT_OK);
    expect(opened).toEqual(["second.provider"]);
  });
});

// ── Self-neutrality ──────────────────────────────────────────────────────────

describe("delivery record self-neutrality", () => {
  it("writing the record does not change the deliverable identity it attests", { timeout: 60000 }, async () => {
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

  it("negative control: a non-neutral path does change the deliverable identity", { timeout: 60000 }, async () => {
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
  it("keeps manual providers on one admission capture and evaluation pass", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);

    const wiring = await wireRepo(dir, config);
    let captures = 0;
    let projections = 0;
    const result = await runProviderBackedAdmission(
      {
        rootDir: dir,
        config,
        env: {},
        stdinIsTTY: false,
        stdoutIsTTY: false,
        args: [],
        wire: async () => ({
          ...wiring,
          captureCandidate: async () => {
            captures += 1;
            return wiring.captureCandidate();
          },
          projectActivation: async (candidate) => {
            projections += 1;
            return wiring.projectActivation(candidate);
          },
        }),
        artifacts,
        write: () => {},
        classifyContext: () => classifyExecutionContext({ config, env: {}, stdinIsTTY: false, stdoutIsTTY: false }),
      },
      { allowPrompt: true, includeInjectedLiveResults: true },
    );

    expect(result.admitted).toBe(false);
    expect(result.waiver).toBe("not_offered");
    expect(captures).toBe(1);
    expect(projections).toBe(1);
  });

  it("never prompts and blocks when non-interactive, even for an all-waivable block", { timeout: 60000 }, async () => {
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

  it("waives end to end under a TTY when the operator accepts", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const prompt: WaiverPrompt = vi.fn(async () => true);
    const { runtime } = makeRuntime(dir, config, artifacts, { stdinIsTTY: true, stdoutIsTTY: true, promptForWaiver: prompt });

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_OK);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("blocks with exit 1 and writes no waiver record when the operator declines", { timeout: 60000 }, async () => {
    // The decline path is also the EOF path: `createWaiverPrompt` resolves false
    // on Ctrl-D, and a declined waiver must be a policy block with nothing
    // written — never the silent success a never-settling prompt produced.
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const prompt: WaiverPrompt = vi.fn(async () => false);
    const { runtime } = makeRuntime(dir, config, artifacts, { stdinIsTTY: true, stdoutIsTTY: true, promptForWaiver: prompt });

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    expect(await runCli(["gate"], runtime)).toBe(EXIT_POLICY);
    expect(prompt).toHaveBeenCalledTimes(1);

    const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
    const stored = await readdir(storage.storageDir).catch(() => [] as string[]);
    expect(stored.filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });

  it("returns 130 when the operator interrupts the waiver prompt", { timeout: 60000 }, async () => {
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
  it("review-context without a receipt blocks and names prepare", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["review-context"], runtime)).toBe(EXIT_POLICY);
    expect(err.join("")).toContain("prepare");
  });

  it("review-context on a stale receipt blocks with a class distinct from missing", { timeout: 60000 }, async () => {
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

  it("submit-evidence after an edit rejects on a candidate mismatch", { timeout: 60000 }, async () => {
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

  it("submit-evidence without --manifest is a usage error", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);
    expect(await runCli(["submit-evidence"], runtime)).toBe(EXIT_USAGE);
  });

  it("record after an edit is refused", { timeout: 60000 }, async () => {
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

  it("check outside a repository blocks with a typed store finding", { timeout: 60000 }, async () => {
    const notARepo = await mkdtemp(path.join(await os.tmpdir(), "dh-norepo-"));
    cleanups.push(notARepo);
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(notARepo, config, artifacts);
    expect(await runCli(["check"], runtime)).toBe(EXIT_POLICY);
    // The rendered blocker names the store, so an operator learns which of the
    // two preflight halves failed rather than only that one did.
    expect(err.join("")).toMatch(/store|storage|repository/i);
    expect(err.join("")).toContain("Remediation:");
  });

  it("check on an unwritable store blocks with a typed finding", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime, err } = makeRuntime(dir, config, artifacts);

    // Plant a regular file where the storage namespace directory must be. Every
    // mkdir beneath it then fails with ENOTDIR — deterministically, and without
    // depending on the uid the suite runs as (a chmod-based fixture is a no-op
    // for root, which is exactly how this scenario rots in CI).
    const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
    await rm(storage.storageRoot, { recursive: true, force: true });
    await mkdir(path.dirname(storage.storageRoot), { recursive: true });
    await writeFile(storage.storageRoot, "not a directory\n", "utf8");

    expect(await runCli(["check"], runtime)).toBe(EXIT_POLICY);
    const text = err.join("");
    // A typed store finding, not an internal error. The distinction is the whole
    // point of the preflight: an unusable store is a condition the operator can
    // act on, and reporting it as an unexpected crash tells them nothing and
    // implicates the harness instead of their checkout.
    expect(text).toContain("artifact_write_failed");
    expect(text).not.toContain("internal_error");
    expect(text).toContain("Remediation:");
  });

  it("an invalid config is a typed policy block", { timeout: 60000 }, async () => {
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

  it("check on a real repository reports readiness", { timeout: 60000 }, async () => {
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
  it("two branches each write a record and both files coexist and parse", { timeout: 120000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);

    // Branch one: the full loop through a written record.
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestMain = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestMain], runtime)).toBe(EXIT_OK);
    const digestMain = await captureDigest(dir, config);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
    await commitRecord(dir);

    // Branch two: a different deliverable, its own loop, its own record. The
    // first branch's record file is carried along, which is what makes this the
    // collision test rather than two independent writes.
    await git(dir, "checkout", "--quiet", "-b", "feature");
    writeFileSync(path.join(dir, "feature.txt"), "feature work\n", "utf8");
    await git(dir, "add", "feature.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "feature");
    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestFeature = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestFeature], runtime)).toBe(EXIT_OK);
    const digestFeature = await captureDigest(dir, config);
    expect(await runCli(["record"], runtime)).toBe(EXIT_OK);
    await commitRecord(dir);

    expect(digestFeature).not.toBe(digestMain);
    const pathMain = deliveryRecordPathFor(config, digestMain);
    const pathFeature = deliveryRecordPathFor(config, digestFeature);
    expect(pathMain).not.toBe(pathFeature);

    // Both files exist side by side — no overwrite, no merge conflict — and both
    // are readable records bound to their own candidate.
    for (const [relative, digest] of [
      [pathMain, digestMain],
      [pathFeature, digestFeature],
    ] as const) {
      const parsed = parseDeliveryRecord(await readFile(path.join(dir, relative), "utf8"));
      expect(parsed.ok, `expected ${relative} to parse`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.record.candidateBinding.deliverableDigest).toBe(digest);
    }

    // And the feature branch verifies against its own record with both present.
    expect(await runCli(["verify"], runtime)).toBe(EXIT_OK);
  });
});

// ── The record-identity guard, witnessed directly ────────────────────────────

describe("record refuses when the identity moves under it", () => {
  /**
   * Drives the command with a wiring whose capture returns a *different*
   * deliverable digest on the recheck than it did for the gate. The loop-level
   * test cannot reach this guard: dirtying a real tree makes the candidate
   * unprepared, so capture fails first and the guard is never consulted. This
   * is the only witness that the recheck itself refuses.
   */
  it("blocks with record_identity_changed when the recheck capture disagrees", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { runtime } = makeRuntime(dir, config, artifacts);

    expect(await runCli(["prepare"], runtime)).toBe(EXIT_OK);
    const manifestPath = await buildAcceptSubmission(dir, config, artifacts);
    expect(await runCli(["submit-evidence", "--manifest", manifestPath], runtime)).toBe(EXIT_OK);

    const wiring = await wireRepo(dir, config);

    // How many captures admission itself consumes, measured rather than guessed:
    // the recheck is the command's *next* capture after that, and hard-coding an
    // index would silently stop targeting it the moment admission's own capture
    // count changed.
    let admissionCaptures = 0;
    await runAdmission(
      { rootDir: dir, config, context: classifyExecutionContext({ config, env: {}, stdinIsTTY: false, stdoutIsTTY: false }) },
      {
        captureCandidate: async () => {
          admissionCaptures += 1;
          return wiring.captureCandidate();
        },
        projectActivation: wiring.projectActivation,
        ...wiring.storageOptions,
      },
    );

    let calls = 0;
    const drifting: typeof wiring.captureCandidate = async () => {
      const capture = await wiring.captureCandidate();
      calls += 1;
      // Admission's captures pass through untouched; the recheck — the first
      // capture after them — reports a moved deliverable.
      if (!capture.ok || calls <= admissionCaptures) return capture;
      return {
        ...capture,
        candidate: {
          ...capture.candidate,
          deliverable: { ...capture.candidate.deliverable, digest: "f".repeat(64) },
        },
      };
    };

    const blockers: string[] = [];
    const result = await recordCommand.run({
      rootDir: dir,
      config,
      env: {},
      stdinIsTTY: false,
      stdoutIsTTY: false,
      args: [],
      wire: async () => ({ ...wiring, captureCandidate: drifting }),
      artifacts,
      write: () => {},
      classifyContext: () => classifyExecutionContext({ config, env: {}, stdinIsTTY: false, stdoutIsTTY: false }),
    });

    if (result.kind === "blocked") blockers.push(...result.blockers.map((blocker) => blocker.code));
    expect(result.kind).toBe("blocked");
    expect(blockers).toContain("record_identity_changed");

    // Nothing was written for the drifted identity.
    const recordDir = path.join(dir, "telemetry/delivery-runs");
    const written = await readdir(recordDir).catch(() => [] as string[]);
    expect(written.some((name) => name.includes("f".repeat(64)))).toBe(false);
  });
});
