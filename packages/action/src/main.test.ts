/**
 * The Action surface, driven from simulated events.
 *
 * WHAT IS SIMULATED AND WHAT IS NOT. The *event* is simulated: every scenario
 * starts from a fixture under `fixtures/events/` carrying the env a runner would
 * export and the payload `GITHUB_EVENT_PATH` would point at, and `runAction` is
 * called as a function. Nothing here needs an Actions runner. Git is **not**
 * simulated: the repositories are real, the commits are real, and the synthetic
 * merge commit the head-vs-merge-ref proof turns on is a real two-parent merge
 * built by git itself. A stubbed git would let the proof pass against a fiction.
 *
 * THE PROOF THAT THE HEAD IS WHAT GETS VERIFIED runs in both directions:
 *   - a repository where verifying `GITHUB_SHA` would *pass* and the head fails,
 *     asserted by checking the same record against the merge tree's identity
 *     through the kernel core directly; and
 *   - a passing run whose `GITHUB_SHA` names a commit that does not exist, which
 *     no implementation that resolved it could survive.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile, mkdir } from "node:fs/promises";
import { realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  ATTESTATION_LABEL,
  BlockedError,
  DELIVERY_RECORD_VERSION,
  computeDeliverableIdentity,
  createBlocker,
  defineHarnessConfig,
  deliveryRecordPathFor,
  runGitCommand,
  verifyDeliveryRecord,
  type DeliveryRecord,
  type HarnessConfig,
  type HarnessConfigInput,
} from "@delivery-harness/kernel";
import { ACTION_EXIT_OK, ACTION_EXIT_POLICY, invokedDirectly, runAction, type ActionRuntime } from "./main.ts";

const run = promisify(execFile);
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "events");

const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Config ───────────────────────────────────────────────────────────────────

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

function obligation(id: string): HarnessConfigInput["obligations"][number] {
  return {
    id,
    activation: { kind: "relevant_change" },
    freshness: "exact_candidate",
    providers: [PROVIDER_ID],
    acceptedPayloadSpecs: ["review.green/1"],
    allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable", "delegated"],
    humanWaiverAllowed: true,
    minimumAttestationLevel: "self",
    ciDelegationPolicyIds: ["github-actions"],
    remediation: { default: [{ id: "submit-evidence", kind: "manual_action", summary: "Submit review evidence." }] },
    waivableCodes: [...STRUCTURAL_WAIVABLE],
    nonWaivableCodes: [...STRUCTURAL_NONWAIVABLE],
  };
}

/**
 * `main` rather than `origin/main`: the repositories here are standalone, and a
 * base ref the fixture repository cannot resolve would fail every scenario for a
 * reason that has nothing to do with what is under test.
 */
function makeConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "test.gate",
    baseRef: "main",
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
    ciPolicies: [
      {
        id: "github-actions",
        requiredEnv: [
          { variable: "GITHUB_ACTIONS", equals: "true" },
          { variable: "CI", equals: "true" },
        ],
      },
    ],
    ciPolicyEnvKey: "DH_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [obligation("review.green")],
    deliveryRecordPath: "telemetry/delivery-runs/record.json",
    deliveryRecordVerification: { baseMovement: "stale" },
    ...overrides,
  });
}

// ── Repositories ─────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

async function commit(dir: string, message: string): Promise<string> {
  await git(dir, "add", "--all");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

async function writeAt(dir: string, relativePath: string, contents: string): Promise<void> {
  const absolute = path.join(dir, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-action-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeAt(dir, "harness.config.ts", "export default {};\n");
  await commit(dir, "root");
  // Work happens on a branch, so committing a record does not advance the base
  // ref out from under the record that names it — which is a real base movement
  // and would stale every scenario for a reason that is not under test.
  await git(dir, "checkout", "--quiet", "-b", "feature");
  return dir;
}

async function identityOf(dir: string, config: HarnessConfig, rev: string): Promise<string> {
  const treeSha = await git(dir, "rev-parse", "--verify", `${rev}^{tree}`);
  return computeDeliverableIdentity({ rootDir: dir, treeSha, config });
}

// ── Records ──────────────────────────────────────────────────────────────────

interface RecordOverrides {
  readonly gateId?: string;
  readonly identityToken?: string;
  readonly deliverableDigest?: string;
  readonly bindingIdentityToken?: string;
  readonly baseRef?: string;
  readonly baseTipSha?: string;
  readonly mergeBaseSha?: string;
  readonly workspaceId?: string;
  readonly obligationIds?: readonly string[];
  readonly attestationLevel?: string;
}

async function buildRecord(dir: string, config: HarnessConfig, digest: string, overrides: RecordOverrides = {}): Promise<DeliveryRecord> {
  const baseRef = overrides.baseRef ?? config.baseRef;
  const baseTipSha = overrides.baseTipSha ?? (await git(dir, "rev-parse", "--verify", `${baseRef}^{commit}`));
  const mergeBaseSha = overrides.mergeBaseSha ?? (await git(dir, "merge-base", baseRef, "HEAD"));
  const treeSha = await git(dir, "rev-parse", "--verify", "HEAD^{tree}");
  return {
    version: DELIVERY_RECORD_VERSION,
    gateId: overrides.gateId ?? config.gateId,
    identityToken: overrides.identityToken ?? config.computingIdentityVersion,
    candidateBinding: {
      treeSha,
      deliverableDigest: overrides.deliverableDigest ?? digest,
      identityToken: overrides.bindingIdentityToken ?? config.computingIdentityVersion,
      baseRef,
      baseTipSha,
      mergeBaseSha,
      workspaceId: overrides.workspaceId ?? "workspace-local",
    },
    claims: (overrides.obligationIds ?? config.obligations.map((entry) => entry.id)).map((obligationId) => ({
      obligationId,
      outcome: "satisfied_evidence",
      providerId: PROVIDER_ID,
      recordId: "a".repeat(64),
      runId: "run-1",
      finalPassId: "pass-2",
      manifestDigest: "b".repeat(64),
    })),
    manifestDigest: "b".repeat(64),
    workspaceId: overrides.workspaceId ?? "workspace-local",
    attestation: { level: (overrides.attestationLevel ?? "self") as "self" },
  } as DeliveryRecord;
}

/** Writes a record at the digest-keyed path the Action recomputes, then commits it. */
async function commitRecord(dir: string, config: HarnessConfig, pathDigest: string, record: DeliveryRecord | string): Promise<string> {
  const relativePath = deliveryRecordPathFor(config, pathDigest);
  await writeAt(dir, relativePath, typeof record === "string" ? record : `${JSON.stringify(record)}\n`);
  await commit(dir, "record");
  return relativePath;
}

// ── The runtime seam ─────────────────────────────────────────────────────────

interface Fixture {
  readonly description: string;
  readonly env: Record<string, string>;
  readonly event: unknown;
}

interface Substitutions {
  readonly workspace: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeSha: string;
  readonly eventPath: string;
}

function substitute<T>(value: T, tokens: Substitutions): T {
  const replaced = JSON.stringify(value)
    .replaceAll("{{WORKSPACE}}", tokens.workspace)
    .replaceAll("{{EVENT_PATH}}", tokens.eventPath)
    .replaceAll("{{HEAD_SHA}}", tokens.headSha)
    .replaceAll("{{BASE_SHA}}", tokens.baseSha)
    .replaceAll("{{MERGE_SHA}}", tokens.mergeSha);
  return JSON.parse(replaced) as T;
}

interface Driven {
  readonly runtime: ActionRuntime;
  readonly summaries: string[];
  readonly logs: string[];
  /** What a runner would have written to `$GITHUB_OUTPUT`. */
  readonly outputs: Record<string, string>[];
}

interface DriveOptions {
  readonly fixture?: string;
  readonly config?: HarnessConfig;
  readonly loadConfig?: (rootDir: string) => Promise<HarnessConfig>;
  readonly headSha?: string;
  readonly mergeSha?: string;
  readonly baseSha?: string;
  readonly env?: Record<string, string>;
  /** Drives git from somewhere other than the repository root. */
  readonly workspace?: string;
  /** Wraps the real git port so one command can be made to fail. */
  readonly git?: (real: typeof runGitCommand) => typeof runGitCommand;
}

async function driveRuntime(dir: string, options: DriveOptions = {}): Promise<Driven> {
  const raw = JSON.parse(await readFile(path.join(FIXTURES, options.fixture ?? "pull-request-synchronize.json"), "utf8")) as Fixture;
  const headSha = options.headSha ?? (await git(dir, "rev-parse", "HEAD"));
  const baseSha = options.baseSha ?? (await git(dir, "rev-parse", "--verify", "main^{commit}"));
  // A commit that does not exist unless a scenario supplies a real one: an
  // implementation that resolved GITHUB_SHA would fail every default scenario.
  const mergeSha = options.mergeSha ?? "0".repeat(40);
  const eventDir = await mkdtemp(path.join(os.tmpdir(), "dh-action-event-"));
  cleanups.push(eventDir);
  const eventPath = path.join(eventDir, "event.json");
  const tokens: Substitutions = { workspace: dir, headSha, baseSha, mergeSha, eventPath };
  const fixture = substitute(raw, tokens);
  await writeFile(eventPath, `${JSON.stringify(fixture.event, null, 2)}\n`, "utf8");

  const summaries: string[] = [];
  const logs: string[] = [];
  const outputs: Record<string, string>[] = [];
  const config = options.config ?? makeConfig();
  const runtime: ActionRuntime = {
    env: { ...fixture.env, ...(options.env ?? {}) },
    workspace: options.workspace ?? dir,
    git: options.git === undefined ? runGitCommand : options.git(runGitCommand),
    readFile: (absolutePath) => readFile(absolutePath, "utf8"),
    loadConfig: options.loadConfig ?? (async () => config),
    writeSummary: async (markdown) => {
      summaries.push(markdown);
    },
    writeOutputs: async (written) => {
      outputs.push({ ...written });
    },
    log: (line) => logs.push(line),
  };
  return { runtime, summaries, logs, outputs };
}

function codesOf(blockers: readonly { readonly code: string }[]): string[] {
  return blockers.map((blocker) => blocker.code);
}

const TIMEOUT = { timeout: 60000 } as const;

// ── The head-vs-merge-ref contract ───────────────────────────────────────────

describe("the pull request head is what gets verified", () => {
  it(
    "fails on the head even when the synthetic merge commit would have passed",
    TIMEOUT,
    async () => {
      const dir = await initRepo();
      const config = makeConfig();
      const baseStart = await git(dir, "rev-parse", "HEAD");

      // The branch, one commit behind what the base will become.
      await writeAt(dir, "b.txt", "branch work\n");
      await commit(dir, "branch work");

      // The base advances underneath it.
      await git(dir, "checkout", "--quiet", "main");
      await writeAt(dir, "c.txt", "base work\n");
      const baseSha = await commit(dir, "base work");

      // The identity of the merge *tree*, computed before the record exists.
      // The record's path is review-neutral, so adding it to the head does not
      // move this digest — which is what makes the record plantable at all.
      await git(dir, "checkout", "--quiet", "-b", "probe", "feature");
      await git(dir, "merge", "--quiet", "--no-ff", "--no-gpg-sign", "-m", "probe merge", "main");
      const mergeDigest = await identityOf(dir, config, "HEAD");
      await git(dir, "checkout", "--quiet", "feature");
      await git(dir, "branch", "--quiet", "-D", "probe");

      // A record bound to the merge tree, committed onto the head.
      const record = await buildRecord(dir, config, mergeDigest, { baseTipSha: baseSha, mergeBaseSha: baseStart });
      await commitRecord(dir, config, mergeDigest, record);
      const headSha = await git(dir, "rev-parse", "HEAD");
      const headDigest = await identityOf(dir, config, "HEAD");

      // The real synthetic merge commit GitHub would build for this PR.
      await git(dir, "checkout", "--quiet", "-b", "merge-ref");
      await git(dir, "merge", "--quiet", "--no-ff", "--no-gpg-sign", "-m", "Merge into main", "main");
      const mergeSha = await git(dir, "rev-parse", "HEAD");
      await git(dir, "checkout", "--quiet", "feature");

      expect(await identityOf(dir, config, mergeSha)).toBe(mergeDigest);
      expect(headDigest).not.toBe(mergeDigest);

      // The control: against the merge tree's identity, this record verifies.
      const wouldPass = verifyDeliveryRecord(config, record, { deliverableDigest: mergeDigest, identityToken: config.computingIdentityVersion }, {
        ref: config.baseRef,
        tipSha: baseSha,
        mergeBaseSha: baseStart,
      });
      expect(wouldPass.ok).toBe(true);

      const { runtime, summaries } = await driveRuntime(dir, {
        fixture: "pull-request-merge-ref-would-pass.json",
        config,
        headSha,
        mergeSha,
        baseSha,
      });
      const result = await runAction(runtime);

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(ACTION_EXIT_POLICY);
      expect(result.headSha).toBe(headSha);
      expect(codesOf(result.blockers)).toContain("deliverable_identity_changed");
      expect(summaries.join("")).toContain(headSha);
    },
  );

  it("never resolves GITHUB_SHA: a passing run survives a merge sha that does not exist", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime } = await driveRuntime(dir, { config, mergeSha: "0".repeat(40) });
    const result = await runAction(runtime);
    expect(result.ok).toBe(true);
    expect(result.mergeRefSha).toBe("0".repeat(40));
  });

  it("refuses a pull_request_target delivery", TIMEOUT, async () => {
    const dir = await initRepo();
    const { runtime } = await driveRuntime(dir, { fixture: "pull-request-target.json" });
    const result = await runAction(runtime);
    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("unsupported_event");
  });

  it("refuses a delivery that is not a pull request", TIMEOUT, async () => {
    const dir = await initRepo();
    const { runtime } = await driveRuntime(dir, { fixture: "push.json" });
    const result = await runAction(runtime);
    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("unsupported_event");
  });

  it("fails closed on an event payload carrying no head sha", TIMEOUT, async () => {
    const dir = await initRepo();
    const { runtime } = await driveRuntime(dir, { fixture: "pull-request-headless-payload.json" });
    const result = await runAction(runtime);
    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("event_payload_unreadable");
  });
});

// ── The failure-class table ──────────────────────────────────────────────────

describe("the failure-class table", () => {
  it("passes a fresh record, naming the claims and the honest attestation label", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    const relativePath = await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime, summaries } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(ACTION_EXIT_OK);
    expect(result.recordPath).toBe(relativePath);
    expect(result.deliverableDigest).toBe(digest);
    const summary = summaries.join("");
    expect(summary).toContain(ATTESTATION_LABEL);
    expect(summary).toContain("review.green");
    expect(summary).toContain(relativePath);
  });

  it("names the drift class when no record describes the head's identity", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));
    // The work moves after the record was written.
    await writeAt(dir, "later.txt", "more work\n");
    await commit(dir, "more work");

    const { runtime, summaries } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("deliverable_identity_changed");
    expect(summaries.join("")).toContain("deliverable_identity_changed");
  });

  it("stales a record when the base moved, under the default policy", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    await writeAt(dir, "b.txt", "branch work\n");
    await commit(dir, "branch work");
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    // The base advances after the record was written.
    const headSha = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "--quiet", "main");
    await writeAt(dir, "c.txt", "base work\n");
    await commit(dir, "base work");
    await git(dir, "checkout", "--quiet", "feature");

    const { runtime } = await driveRuntime(dir, { config, headSha });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("base_tip_moved");
  });

  it("passes the same base movement under the allow policy, naming the relaxation", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig({ deliveryRecordVerification: { baseMovement: "allow" } });
    await writeAt(dir, "b.txt", "branch work\n");
    await commit(dir, "branch work");
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const headSha = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "--quiet", "main");
    await writeAt(dir, "c.txt", "base work\n");
    await commit(dir, "base work");
    await git(dir, "checkout", "--quiet", "feature");

    const { runtime, summaries } = await driveRuntime(dir, { config, headSha });
    const result = await runAction(runtime);

    expect(result.ok).toBe(true);
    const summary = summaries.join("");
    expect(summary).toContain("base_tip_moved");
    expect(summary.toLowerCase()).toContain("relax");
  });

  it("names the local command when no record is tracked at all", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const { runtime, summaries } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("delivery_record_missing");
    expect(summaries.join("")).toContain("delivery-harness record");
  });

  it("distinguishes a record that exists in the workspace but is untracked", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    // Written, never added: the tracked tree does not carry it.
    await writeAt(dir, deliveryRecordPathFor(config, digest), `${JSON.stringify(await buildRecord(dir, config, digest))}\n`);

    const { runtime, summaries } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("delivery_record_untracked");
    expect(summaries.join("")).toContain("git add");
  });

  it("reports an obligation the record leaves uncovered", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig({ obligations: [obligation("review.green"), obligation("security.scan")] });
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest, { obligationIds: ["review.green"] }));

    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("obligation_uncovered");
  });

  it("treats a malformed record as a finding, never as a skip", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, "{ this is not json\n");

    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("delivery_record_malformed");
  });

  it("fails closed when the configuration cannot be loaded", TIMEOUT, async () => {
    const dir = await initRepo();
    const { runtime } = await driveRuntime(dir, {
      loadConfig: async () => {
        throw new BlockedError([
          createBlocker({
            code: "config-unloadable",
            source: { kind: "config", id: "delivery-harness.action.config" },
            summary: "The harness configuration could not be loaded.",
            remediations: [{ id: "add-harness-config", kind: "manual_action", summary: "Add harness.config.ts." }],
          }),
        ]);
      },
    });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(ACTION_EXIT_POLICY);
    expect(codesOf(result.blockers)).toContain("config-unloadable");
  });

  it("fails closed when the configuration throws something untyped", TIMEOUT, async () => {
    const dir = await initRepo();
    const { runtime } = await driveRuntime(dir, {
      loadConfig: async () => {
        throw new Error("harness.config.ts: Unexpected token");
      },
    });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("internal_error");
  });

  it("fails closed when the head commit is not present in the checkout", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const { runtime } = await driveRuntime(dir, { config, headSha: "1".repeat(40) });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("head_commit_unavailable");
  });

  it("fails closed when the configured base ref does not resolve", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig({ baseRef: "origin/nonexistent" });
    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("base_ref_unresolved");
  });
});

// ── Record selection ─────────────────────────────────────────────────────────

describe("record selection", () => {
  it("selects the one record among several that binds to the head", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const foreignDigest = "c".repeat(64);
    await commitRecord(dir, config, foreignDigest, await buildRecord(dir, config, foreignDigest));
    const digest = await identityOf(dir, config, "HEAD");
    const relativePath = await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(true);
    expect(result.recordPath).toBe(relativePath);
  });

  it("refuses a foreign-candidate record planted at the head's own record path", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    // The right filename, a binding for somebody else's candidate.
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest, { deliverableDigest: "d".repeat(64) }));

    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("deliverable_identity_changed");
  });
});

// ── Cross-worktree ───────────────────────────────────────────────────────────

describe("cross-worktree verification", () => {
  it("verifies a record produced in another workspace: workspaceId is excluded", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    const record = await buildRecord(dir, config, digest, { workspaceId: "a-completely-different-workspace" });
    await commitRecord(dir, config, digest, record);

    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(true);
  });
});

// ── Delegated authority ──────────────────────────────────────────────────────

describe("delegated authority", () => {
  it("honors an exact ciPolicyId match", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime, summaries } = await driveRuntime(dir, { fixture: "pull-request-delegated.json", config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("delegated-authority");
    expect(summaries.join("")).toContain("github-actions");
  });

  it("rejects a near miss as unauthorized_automation rather than downgrading it", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime } = await driveRuntime(dir, { fixture: "pull-request-delegation-near-miss.json", config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("unauthorized_automation");
  });

  it("rejects a policy id that no config declares", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime } = await driveRuntime(dir, {
      fixture: "pull-request-delegated.json",
      config,
      env: { DELIVERY_HARNESS_CI_POLICY_ID: "github-actions-but-not-really" },
    });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("unauthorized_automation");
  });

  it("runs in verify mode when no delegation input is present", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("verify");
  });
});

// ── Neutralization ───────────────────────────────────────────────────────────

describe("the Action surface neutralizes hostile record text", () => {
  it("strips ANSI, bidi and control sequences a record carries into the summary", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    const hostileGateId = "\u001B[31mnot.your.gate\u001B[0m‮reversed";
    const record = await buildRecord(dir, config, digest, { gateId: hostileGateId });
    const bytes = `${JSON.stringify(record)}\n`;
    // Anti-vacuity: the record really does carry the hostile sequences. JSON
    // escapes them on the wire, so the assertion is on what a parse yields —
    // which is exactly what reaches the summary.
    expect((JSON.parse(bytes) as { gateId: string }).gateId).toContain("\u001B[31m");
    expect((JSON.parse(bytes) as { gateId: string }).gateId).toContain("‮");
    await commitRecord(dir, config, digest, bytes);

    const { runtime, summaries } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    const summary = summaries.join("");
    expect(summary).not.toContain("\u001B[31m");
    expect(summary).not.toContain("‮");
    expect(summary).toContain("record_gate_mismatch");
  });

  it("keeps a record's own text from forging markdown structure in the summary", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    const record = await buildRecord(dir, config, digest, { gateId: "```\n## Verified\nAll checks passed." });
    await commitRecord(dir, config, digest, `${JSON.stringify(record)}\n`);

    const { runtime, summaries } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    const summary = summaries.join("");
    // The fence the Action opened has to survive whatever the record contains.
    const headings = summary.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).not.toContain("## Verified");
  });

  it("prints only vocabulary the config declares or a grammar admits in the claims table", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    const record = await buildRecord(dir, config, digest);
    const tampered = {
      ...record,
      claims: [{ ...record.claims[0], providerId: "\u001B[31mevil\u001B[0m", recordId: "not a record id\u0007" }],
    };
    await commitRecord(dir, config, digest, `${JSON.stringify(tampered)}\n`);

    const { runtime, summaries } = await driveRuntime(dir, { config });
    await runAction(runtime);
    const summary = summaries.join("");
    expect(summary).not.toContain("\u001B[31m");
    expect(summary).not.toContain("\u0007");
  });
});

// ── The summary is always emitted ────────────────────────────────────────────

describe("the check summary", () => {
  it("is written on every path, including the ones that fail before verification", TIMEOUT, async () => {
    const dir = await initRepo();
    const { runtime, summaries } = await driveRuntime(dir, { fixture: "push.json" });
    await runAction(runtime);
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain("unsupported_event");
  });

  it("names the base-movement policy in force", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));
    const { runtime, summaries } = await driveRuntime(dir, { config });
    await runAction(runtime);
    expect(summaries.join("")).toContain("stale");
  });
});

// ── Review round 1: refused delegation is its own mode ───────────────────────

describe("a refused delegation claim is never reported as verify mode", () => {
  it("names the refused claim in the summary and in the step outputs", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime, summaries, outputs } = await driveRuntime(dir, {
      fixture: "pull-request-delegation-near-miss.json",
      config,
    });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    // "verify" would be the exact quiet downgrade the refusal exists to prevent.
    expect(result.mode).toBe("delegation-refused");
    expect(outputs[0]?.["mode"]).toBe("delegation-refused");
    expect(outputs[0]?.["verified"]).toBe("false");
    const summary = summaries.join("");
    expect(summary).toContain("delegation-refused");
    expect(summary).toContain("github-actions");
    expect(summary).not.toContain("| Mode | `verify` |");
  });

  it("reports plain verify mode only when no claim was made", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));
    const { runtime, outputs } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);
    expect(result.mode).toBe("verify");
    expect(outputs[0]?.["mode"]).toBe("verify");
  });
});

// ── Review round 1: no silent tie-break between records ──────────────────────

describe("two records binding one identity are never tie-broken", () => {
  it("blocks when a second record binds the head's identity under another name", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    const honest = await buildRecord(dir, config, digest);
    // A plant that sorts first lexicographically and claims the same identity.
    // Under a `[0]` tie-break its claims table would be the one published.
    const planted = { ...honest, claims: [{ ...honest.claims[0], recordId: "f".repeat(64) }] } as typeof honest;
    await commitRecord(dir, config, "0".repeat(64), planted);
    await commitRecord(dir, config, digest, honest);

    const { runtime, summaries } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("ambiguous_delivery_records");
    // Nothing from either record is published as a verified claim.
    expect(summaries.join("")).not.toContain("### Claims");
  });

  it("blocks a lone record that binds the identity from an unexpected path", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, "0".repeat(64), await buildRecord(dir, config, digest));

    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("delivery_record_path_unexpected");
  });

  it("still passes the honest record sitting at its own derived path", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    const expectedPath = deliveryRecordPathFor(config, digest);
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(true);
    expect(result.recordPath).toBe(expectedPath);
  });
});

// ── Review round 1: discovery is anchored at the repository root ─────────────

describe("record discovery does not depend on the directory git runs in", () => {
  it("finds the record when the action runs from a subdirectory", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    await writeAt(dir, "packages/app/index.ts", "export const x = 1;\n");
    await commit(dir, "nested work");
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    // What `working-directory` produces: git invoked below the repository root.
    const { runtime } = await driveRuntime(dir, { config, workspace: path.join(dir, "packages", "app") });
    const result = await runAction(runtime);

    expect(result.ok).toBe(true);
    expect(result.recordPath).toBe(deliveryRecordPathFor(config, digest));
  });
});

// ── Review round 1: the remaining implemented failure classes ────────────────

describe("failure classes that only a repository can produce", () => {
  it("fails closed when the head and the base share no history", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig({ baseRef: "unrelated" });
    // An orphan branch: a second root commit, no merge base with anything.
    await git(dir, "checkout", "--quiet", "--orphan", "unrelated");
    await git(dir, "rm", "-rq", "--cached", ".");
    await writeAt(dir, "unrelated.txt", "another history\n");
    await commit(dir, "unrelated root");
    await git(dir, "checkout", "--quiet", "feature");

    const { runtime } = await driveRuntime(dir, { config });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("merge_base_unavailable");
  });

  it("fails closed when the head's tree cannot be listed", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const { runtime } = await driveRuntime(dir, {
      config,
      // Everything stays real except the one listing, so the failure is the one
      // under test rather than a repository that was never usable.
      git: (real) => (command, options) =>
        command.includes("ls-tree") && command.includes("--name-only")
          ? Promise.resolve({ exitCode: 128, stdout: "", stderr: "fatal: not a tree object" })
          : real(command, options),
    });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("tracked_tree_unreadable");
  });

  it("fails closed when a discovered record's blob cannot be read", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));

    const { runtime } = await driveRuntime(dir, {
      config,
      git: (real) => (command, options) =>
        command.includes("cat-file")
          ? Promise.resolve({ exitCode: 128, stdout: "", stderr: "fatal: bad object" })
          : real(command, options),
    });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("delivery_record_unreadable");
  });
});

// ── Review round 1: the attestation label is unconditional ───────────────────

describe("the honest attestation label", () => {
  it("appears on every shape the summary can take, blocked ones included", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const digest = await identityOf(dir, config, "HEAD");

    const shapes: { readonly name: string; readonly drive: () => Promise<Driven> }[] = [
      { name: "not a pull request", drive: () => driveRuntime(dir, { fixture: "push.json", config }) },
      { name: "pull_request_target", drive: () => driveRuntime(dir, { fixture: "pull-request-target.json", config }) },
      { name: "headless payload", drive: () => driveRuntime(dir, { fixture: "pull-request-headless-payload.json", config }) },
      { name: "record missing", drive: () => driveRuntime(dir, { config }) },
      { name: "head absent", drive: () => driveRuntime(dir, { config, headSha: "1".repeat(40) }) },
      { name: "base unresolvable", drive: () => driveRuntime(dir, { config: makeConfig({ baseRef: "origin/nope" }) }) },
      { name: "delegation refused", drive: () => driveRuntime(dir, { fixture: "pull-request-delegation-near-miss.json", config }) },
    ];

    for (const shape of shapes) {
      const { runtime, summaries } = await shape.drive();
      const result = await runAction(runtime);
      expect(result.ok, shape.name).toBe(false);
      expect(summaries.join(""), shape.name).toContain(ATTESTATION_LABEL);
    }

    // And on the passing shape, so the assertion is not only about failures.
    await commitRecord(dir, config, digest, await buildRecord(dir, config, digest));
    const { runtime, summaries } = await driveRuntime(dir, { config });
    expect((await runAction(runtime)).ok).toBe(true);
    expect(summaries.join("")).toContain(ATTESTATION_LABEL);
  });
});

// ── Review round 1: summary and payload polish ───────────────────────────────

describe("the summary says nothing it does not know", () => {
  it("omits the verified-commit row entirely when there was no head", TIMEOUT, async () => {
    const dir = await initRepo();
    const { runtime, summaries } = await driveRuntime(dir, { fixture: "push.json" });
    await runAction(runtime);
    const summary = summaries.join("");
    expect(summary).not.toContain("Verified commit");
    expect(summary).not.toContain("[unprintable]");
  });

  it("refuses a head sha that is not a full object name", TIMEOUT, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const full = await git(dir, "rev-parse", "HEAD");
    const { runtime } = await driveRuntime(dir, { config, headSha: full.slice(0, 12) });
    const result = await runAction(runtime);
    expect(result.ok).toBe(false);
    expect(codesOf(result.blockers)).toContain("event_payload_unreadable");
  });
});

// ── Review round 1: the entry guard cannot fail silently ─────────────────────

describe("the executable entry guard", () => {
  it("matches through a symlinked invocation path", TIMEOUT, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-entry-"));
    cleanups.push(dir);
    const real = path.join(dir, "real");
    await mkdir(real, { recursive: true });
    const modulePath = path.join(real, "module.ts");
    await writeFile(modulePath, "export const x = 1;\n", "utf8");
    const linkedDir = path.join(dir, "linked");
    await symlink(real, linkedDir);

    // Realpathed, because that is what `import.meta.url` carries: Node resolves
    // a module's own URL through the filesystem. The temp root itself sits
    // behind a symlink on macOS, so building the href any other way would test
    // a shape production never sees.
    const moduleHref = pathToFileURL(realpathSync(modulePath)).href;
    // How a runner invokes this action: an absolute path through whatever
    // symlink the workspace happens to sit behind. A guard that compared the
    // spellings would decide this module was not the entry, skip `main`, and
    // exit 0 having verified nothing.
    expect(invokedDirectly(path.join(linkedDir, "module.ts"), moduleHref)).toBe(true);
    expect(invokedDirectly(path.join(real, "module.ts"), moduleHref)).toBe(true);
    expect(invokedDirectly(path.join(real, "other.ts"), moduleHref)).toBe(false);
    expect(invokedDirectly(undefined, moduleHref)).toBe(false);
  });
});
