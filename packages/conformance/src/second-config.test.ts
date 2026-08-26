/**
 * Config-independence, second half: the kernel exercised under the
 * full-divergence configuration.
 *
 * The kit-variant configuration holds the vector-bound dimensions still and
 * re-drives the conformance kit in both modes (`runner.test.ts`). This file
 * drives the kernel itself under `second-config.ts`, where nothing is shared
 * with the kit's configuration except the three values this version's scope
 * fixes. Every assertion is one the kernel can only satisfy by reading policy
 * from the config parameter it was handed: a kernel that special-cased a kit
 * value — the narration set, the identity token, the obligation's name, the
 * record path, the base-movement default — turns one of these red, and the
 * divergence assertions in `fixture-configs.test.ts` are what keep that claim
 * from decaying (a fixture quietly converging on the kit's config would make
 * this file prove nothing, and is itself a red test there).
 *
 * ZERO KERNEL DIFF IS A REVIEW CRITERION, NOT A TEST ASSERTION. "This file
 * went green without touching the kernel" is a claim about the change that
 * introduced it, so it is checked by reviewing that change's diff — no test
 * can assert its own diff context, and one that pretended to would be a
 * vacuous sensor.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  DELIVERY_RECORD_VERSION,
  captureGitCandidate,
  computeDeliverableIdentity,
  deliveryRecordPathFor,
  evaluateGate,
  isRecordNeutralPath,
  isReviewNeutralPath,
  resolveRecordStorage,
  verifyDeliveryRecord,
  withDeliverableIdentity,
  type CandidateBinding,
  type DeliveryRecord,
  type ExecutionContext,
  type GateDecision,
  type ReviewActivationProjection,
} from "@v26labs/delivery-harness-kernel";
import { secondConfig } from "../fixtures/second-config.ts";

const run = promisify(execFile);
const TIMEOUT = { timeout: 60000 } as const;

const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ── A repository shaped the way this config expects ──────────────────────────

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, "add", "--all");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

async function writeAt(dir: string, relativePath: string, contents: string): Promise<void> {
  const absolute = path.join(dir, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

/** A standalone repository whose base resolves under this config's own `baseRef`. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-second-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "work");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeAt(dir, "second.config.ts", "export default {};\n");
  await commitAll(dir, "root");
  await git(dir, "branch", secondConfig.baseRef);
  await writeAt(dir, "lib/feature.ts", "export const feature = 1;\n");
  await commitAll(dir, "work");
  return dir;
}

async function digestOf(dir: string): Promise<string> {
  const treeSha = await git(dir, "rev-parse", "--verify", "HEAD^{tree}");
  return computeDeliverableIdentity({ rootDir: dir, treeSha, config: secondConfig });
}

// ── Identity: the consumer token and its own neutral set ─────────────────────

describe("deliverable identity under the full-divergence config", () => {
  it("computes under the consumer token, neutral to this config's set and to nothing else", TIMEOUT, async () => {
    const dir = await initRepo();
    const storage = await resolveRecordStorage(dir, { storageNamespace: secondConfig.storageNamespace });
    const capture = await captureGitCandidate({
      rootDir: dir,
      config: secondConfig,
      workspaceId: storage.workspaceId,
      computeIdentity: withDeliverableIdentity(),
    });
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.candidate.deliverable.identity).toBe("second-tree/v2");
    const before = capture.candidate.deliverable.digest;

    // This config's own neutral set excludes: prefix `notes/`, and `audit/`
    // narrowed by suffix `.json`.
    await writeAt(dir, "notes/scratch.md", "narration\n");
    await writeAt(dir, "audit/run.json", "{}\n");
    await commitAll(dir, "neutral additions");
    expect(await digestOf(dir)).toBe(before);

    // The `audit/` matcher carries a suffix, so a non-.json file under it is
    // NOT neutral — the {prefix, suffix} matcher is read whole.
    await writeAt(dir, "audit/run.txt", "not neutral\n");
    await commitAll(dir, "suffix miss");
    const afterSuffixMiss = await digestOf(dir);
    expect(afterSuffixMiss).not.toBe(before);

    // The kit's narration set has no authority here: `docs/reports/` moves this
    // config's digest. A kernel that hardcoded the deliverable-tree/v1 set
    // instead of reading `config.reviewNeutral` goes red on this line.
    await writeAt(dir, "docs/reports/report.md", "kit-neutral, not second-neutral\n");
    await commitAll(dir, "kit narration path");
    expect(await digestOf(dir)).not.toBe(afterSuffixMiss);
  });

  it("keeps the two neutral predicates independent", () => {
    // Review-neutral but not record-neutral: the wider set's own territory.
    expect(isReviewNeutralPath(secondConfig, "notes/scratch.md")).toBe(true);
    expect(isRecordNeutralPath(secondConfig, "notes/scratch.md")).toBe(false);
    // The record directory satisfies both — the double-neutrality the tracked
    // record depends on.
    expect(isReviewNeutralPath(secondConfig, "notes/records/promotion.json")).toBe(true);
    expect(isRecordNeutralPath(secondConfig, "notes/records/promotion.json")).toBe(true);
    // The kit's neutral paths are ordinary content here.
    expect(isReviewNeutralPath(secondConfig, "telemetry/delivery-runs/record.json")).toBe(false);
  });
});

// ── The gate: divergent obligation name, live freshness, divergent providers ─

const SECOND_CANDIDATE: CandidateBinding = {
  treeSha: "a".repeat(40),
  deliverable: { digest: "d".repeat(64), identity: "second-tree/v2" },
  base: { ref: secondConfig.baseRef, tipSha: "b".repeat(40), mergeBaseSha: "c".repeat(40) },
  workspaceId: "w".repeat(64),
};

const ACTIVE_PROJECTION: ReviewActivationProjection = {
  relevantLineCount: 200,
  relevantPaths: ["lib/feature.ts"],
  excludedPaths: [],
  binaryPaths: [],
  sensitivePathIds: [],
  hasRelevantBinaryChange: false,
  hasRelevantZeroLineChange: false,
  changedEntryCount: 1,
};

const UNKNOWN: ExecutionContext = { kind: "unknown", reason: "noninteractive_unrecognized" };

function evaluate(liveResults: Parameters<typeof evaluateGate>[0]["liveResults"]): GateDecision {
  return evaluateGate({
    config: secondConfig,
    candidate: SECOND_CANDIDATE,
    projection: ACTIVE_PROJECTION,
    context: UNKNOWN,
    records: [],
    liveResults,
  });
}

describe("the gate under the full-divergence config", () => {
  it("admits a green live result from this config's own provider", () => {
    const decision = evaluate([{ providerId: "second.auditor", runId: "live-1", status: "green", findings: [] }]);
    expect(decision.admitted).toBe(true);
    expect(decision.resolutions).toEqual([
      {
        kind: "satisfied_live_fact",
        gateId: "second.promotion-gate",
        obligationId: "code.reviewed",
        providerId: "second.auditor",
        runId: "live-1",
      },
    ]);
  });

  it("blocks when the live provider returned nothing for this invocation", () => {
    const decision = evaluate([]);
    expect(decision.admitted).toBe(false);
    expect(decision.blockers.map((blocker) => blocker.code)).toContain("live_provider_missing");
  });

  it("applies the provider's own declared finding codes, not the kit's", () => {
    const decision = evaluate([
      {
        providerId: "second.auditor",
        runId: "live-2",
        status: "failed",
        findings: [{ code: "audit-dissent", summary: "a reviewer dissented" }],
      },
    ]);
    expect(decision.admitted).toBe(false);
    expect(decision.blockers.map((blocker) => blocker.code)).toContain("audit-dissent");
  });
});

// ── The tracked record: divergent path, divergent verification policy ────────

function secondRecord(overrides: { identityToken?: string; baseTipSha?: string } = {}): DeliveryRecord {
  const identityToken = overrides.identityToken ?? secondConfig.computingIdentityVersion;
  return {
    version: DELIVERY_RECORD_VERSION,
    gateId: secondConfig.gateId,
    identityToken,
    candidateBinding: {
      treeSha: SECOND_CANDIDATE.treeSha,
      deliverableDigest: SECOND_CANDIDATE.deliverable.digest,
      identityToken,
      baseRef: secondConfig.baseRef,
      baseTipSha: overrides.baseTipSha ?? SECOND_CANDIDATE.base.tipSha,
      mergeBaseSha: SECOND_CANDIDATE.base.mergeBaseSha,
      workspaceId: SECOND_CANDIDATE.workspaceId,
    },
    claims: [{ obligationId: "code.reviewed", outcome: "satisfied_live_fact", providerId: "second.auditor", runId: "live-1" }],
    manifestDigest: null,
    workspaceId: SECOND_CANDIDATE.workspaceId,
    attestation: { level: "self" },
  };
}

describe("the delivery record under the full-divergence config", () => {
  it("derives the record path from this config's own declaration", () => {
    const derived = deliveryRecordPathFor(secondConfig, SECOND_CANDIDATE.deliverable.digest);
    expect(derived.startsWith("notes/records/promotion--")).toBe(true);
    expect(derived.endsWith(".json")).toBe(true);
    expect(derived).toContain(SECOND_CANDIDATE.deliverable.digest);
  });

  it("relaxes base movement under this config's `allow` policy, and names the relaxation", () => {
    const check = verifyDeliveryRecord(
      secondConfig,
      secondRecord({ baseTipSha: "e".repeat(40) }),
      { deliverableDigest: SECOND_CANDIDATE.deliverable.digest, identityToken: secondConfig.computingIdentityVersion },
      { ref: secondConfig.baseRef, tipSha: SECOND_CANDIDATE.base.tipSha, mergeBaseSha: SECOND_CANDIDATE.base.mergeBaseSha },
    );
    // The kit's config stales on base movement; this one is configured to
    // relax it — a kernel reading a hardcoded default goes red here.
    expect(check.ok).toBe(true);
    expect(check.baseMovementRelaxed).toBe(true);
    expect(check.relaxedDriftClasses).toEqual(["base_tip_moved"]);
  });

  it("refuses the kit's identity token: this config never accepted it", () => {
    const check = verifyDeliveryRecord(
      secondConfig,
      secondRecord({ identityToken: "deliverable-tree/v1" }),
      { deliverableDigest: SECOND_CANDIDATE.deliverable.digest, identityToken: secondConfig.computingIdentityVersion },
      { ref: secondConfig.baseRef, tipSha: SECOND_CANDIDATE.base.tipSha, mergeBaseSha: SECOND_CANDIDATE.base.mergeBaseSha },
    );
    expect(check.ok).toBe(false);
    expect(check.blockers.map((blocker) => blocker.code)).toContain("record_identity_token_unknown");
  });
});
