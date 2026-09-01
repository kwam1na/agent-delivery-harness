/**
 * DURABLE CHECKPOINTS AND HOST-DRIVEN RECOVERY — the scenario sensors for the
 * checkpoint unit, layered on the walking skeleton's fixtures:
 *
 *   - end and resume a host task at EVERY stage, always through an
 *     operator-authorized takeover into a fresh host-created worktree;
 *   - race a superseded task against the live fence: stale transition,
 *     evidence, and action outputs are permanently rejected while the live
 *     fence proceeds;
 *   - observation-only appends never void a pending takeover confirmation —
 *     an advancing append does;
 *   - refuse same-worktree resume (no termination provenance exists on this
 *     host tier), branch collisions, dirty candidates, and vanished
 *     workspaces — all typed, all recoverable through takeover;
 *   - cancel before/during/after mutation: fence revocation denies late
 *     subagent activity, terminal cancellation quarantines and preserves the
 *     workspace, and nothing ever claims the prior task terminated;
 *   - pending waiver/amendment proposals void on candidate change, and a
 *     zero-mutation discharge parks with a typed escape instead of stranding;
 *   - a dirty ROOT checkout is preserved untouched and never becomes
 *     delivery input;
 *   - evidence stays worktree-local, the worktree-scoped exclusion does not
 *     interfere with other worktrees, and the interceptor denies authority
 *     store writes;
 *   - terminal delivery detail exports and deletes through the maintenance
 *     journal, whose records survive the target's removal;
 *   - and the PRODUCT still launches no agent process and creates no
 *     worktree — the exec inventory proves it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJournalStore, createMaintenanceJournalStore } from "../checkpoint/journal-store.ts";
import { CONFIRMATION_FIXTURE_PROFILE } from "../substrate/manifest.ts";
import { installComposition, packComposition } from "../substrate/installer.ts";
import { createExecPort, type ExecInvocation, type ExecPort } from "../host/exec-port.ts";
import { decideHookInvocation, type HookBindingState } from "../host/hook-main.ts";
import { discoverRecords } from "../records.ts";
import type { ConfirmationEchoAttempt, RenderedConfirmationChallenge } from "../binding/host-admission.ts";
import type { DeliveryState } from "../spine/vocabulary.ts";
import { createManagedDeliveryFacade, type ManagedDeliveryFacade } from "./managed-delivery.ts";
import {
  DISPOSABLE_CONTRACT,
  GREET_RIGHT,
  GREET_WRONG,
  buildDisposableRepository,
  disposableHarnessConfig,
  fixtureProviderBindingCapability,
  ingestFixtureProviderReview,
  typedStageResultBytes,
} from "./disposable-repository.fixture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const FIXTURES = path.join(REPO_ROOT, "qualifications", "fixtures");

const NOW = "2026-08-30T12:00:00Z";
const LATER = "2026-08-30T12:00:30Z";
const EXPIRY = "2026-08-31T12:00:00Z";
const ENV = { CLAUDECODE: "1" } as const;

let scratch: string;
let installationPath: string;
let receiptDir: string;
let repoDir: string;
let facade: ManagedDeliveryFacade;
let launches: ExecInvocation[];

function recordingExecPort(): ExecPort {
  const inner = createExecPort();
  return {
    run(invocation) {
      launches.push(invocation);
      return inner.run(invocation);
    },
  };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const commitAll = (cwd: string, message: string): void => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "--no-gpg-sign", "-m", message);
};

const operatorEcho = (channelPath: string): ConfirmationEchoAttempt => {
  const pending = JSON.parse(readFileSync(channelPath, "utf8")) as { rendered: RenderedConfirmationChallenge };
  return {
    presentedChallenge: pending.rendered.challenge,
    presentedOnChannelId: pending.rendered.channelId,
    observedAt: NOW,
    viaModelVisibleSurface: false,
    interactive: true,
  };
};

function must<T extends { ok: boolean }>(value: T, label: string): asserts value is Extract<T, { ok: true }> {
  if (!value.ok) throw new Error(`${label}: ${JSON.stringify(value)}`);
}

const restoreWritable = (dir: string): void => {
  try {
    execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
  } catch {
    /* removal surfaces the real failure */
  }
};

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "checkpoint-recovery-"));
  launches = [];

  const packed = await packComposition({
    sourceRoot: REPO_ROOT,
    skillsArchivePath: path.join(FIXTURES, "agent-skills-core-v1-composition.zip"),
    skillsMetadataPath: path.join(FIXTURES, "agent-skills-core-v1-composition.metadata.json"),
    compositionProfile: CONFIRMATION_FIXTURE_PROFILE,
    compositionSequence: 1,
    outDir: path.join(scratch, "pack"),
  });
  if (!packed.ok) throw new Error(JSON.stringify(packed));

  installationPath = path.join(scratch, "installation");
  receiptDir = path.join(scratch, "user-config");
  const installed = await installComposition({
    packedDir: packed.packedDir,
    installationPath,
    receiptDir,
    // The explicit operator-supplied qualification flag with its disposable
    // repository set — the fixture profile activates no other way.
    qualification: { disposableRepositoryIds: [DISPOSABLE_CONTRACT.repository.repositoryId] },
    assertionProvider: { sourceKind: "qualification-fixture" },
  });
  if (!installed.ok) throw new Error(JSON.stringify(installed));

  repoDir = buildDisposableRepository(path.join(scratch, "repo")).repoDir;

  facade = createManagedDeliveryFacade({
    repoDir,
    config: disposableHarnessConfig(),
    installation: { installationPath, receiptDir },
    hostVersion: "2.1.97",
    exec: recordingExecPort(),
  });
}, 120_000);

afterAll(async () => {
  restoreWritable(scratch);
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

// ── The delivery driver: the host side of the checkpoint path ──────────────

interface Driven {
  deliveryId: string;
  worktree: string;
  branch: string;
  fence: number;
  round: number;
}

let sequence = 0;

async function newDelivery(): Promise<Driven> {
  sequence += 1;
  const contract = { ...DISPOSABLE_CONTRACT, contractId: `contract-recovery-${sequence}` };
  const presented = await facade.presentContract({ contract, expiry: EXPIRY });
  must(presented, "presentContract");
  const confirmed = await facade.confirmContract({ intakeId: presented.intakeId, echo: operatorEcho(presented.channelPath) });
  must(confirmed, "confirmContract");
  const branch = `recovery-${sequence}`;
  const worktree = path.join(scratch, `wt-${sequence}`);
  git(repoDir, "worktree", "add", "--quiet", "-b", branch, worktree, "main");
  const bound = await facade.bindWorkspace({
    deliveryId: confirmed.deliveryId,
    worktreeDir: worktree,
    hostTaskId: `host-${sequence}`,
    observedAt: NOW,
    attestationExpiry: EXPIRY,
    providerReviewBindingCapability: fixtureProviderBindingCapability(confirmed.deliveryId),
  });
  must(bound, "bindWorkspace");
  return { deliveryId: confirmed.deliveryId, worktree, branch, fence: bound.fence, round: 0 };
}

const treeOf = (worktree: string): string => git(worktree, "rev-parse", "HEAD^{tree}");

async function plan(driven: Driven): Promise<void> {
  const planned = await facade.submitStageResult({
    deliveryId: driven.deliveryId,
    stageId: "plan",
    resultBytes: typedStageResultBytes({ stageId: "plan", deliveryId: driven.deliveryId, outputKind: "bounded-plan", candidate: treeOf(driven.worktree) }),
    fence: driven.fence,
  });
  must(planned, "plan");
}

async function implement(driven: Driven, bytes: string, message: string): Promise<void> {
  writeFileSync(path.join(driven.worktree, "src", "greet.mjs"), bytes);
  commitAll(driven.worktree, message);
  const checkpointed = await facade.checkpointCandidate({
    deliveryId: driven.deliveryId,
    resultBytes: typedStageResultBytes({
      stageId: "implement",
      deliveryId: driven.deliveryId,
      outputKind: "delivery-candidate",
      candidate: treeOf(driven.worktree),
    }),
    fence: driven.fence,
  });
  must(checkpointed, "checkpointCandidate");
}

async function sensor(driven: Driven, expected: "passed" | "failed"): Promise<void> {
  const sensed = await facade.runSensor({ deliveryId: driven.deliveryId, fence: driven.fence });
  must(sensed, "runSensor");
  expect(sensed.outcome).toBe(expected);
}

async function review(driven: Driven): Promise<void> {
  driven.round += 1;
  const ingested = await ingestFixtureProviderReview({
    facade,
    deliveryId: driven.deliveryId,
    fence: driven.fence,
    runId: `run-${driven.round}-${driven.deliveryId}`,
  });
  must(ingested, "ingestProviderReviewResult");
  const reduced = await facade.reduceReview({ deliveryId: driven.deliveryId, fence: driven.fence });
  must(reduced, "reduceReview");
}

async function compound(driven: Driven): Promise<void> {
  const compounded = await facade.submitStageResult({
    deliveryId: driven.deliveryId,
    stageId: "compound",
    resultBytes: typedStageResultBytes({
      stageId: "compound",
      deliveryId: driven.deliveryId,
      outputKind: "no-reusable-learning",
      candidate: treeOf(driven.worktree),
    }),
    fence: driven.fence,
  });
  must(compounded, "compound");
}

async function admitStep(driven: Driven): Promise<void> {
  const admitted = await facade.admit({ deliveryId: driven.deliveryId, recordedAtInstant: LATER, env: ENV, fence: driven.fence });
  must(admitted, "admit");
}

async function record(driven: Driven): Promise<void> {
  const prepared = await facade.prepareTrackedRecord({ deliveryId: driven.deliveryId, env: ENV, fence: driven.fence });
  must(prepared, "prepareTrackedRecord");
  commitAll(driven.worktree, "tracked delivery record");
  const confirmed = await facade.confirmTrackedRecord({ deliveryId: driven.deliveryId, fence: driven.fence });
  must(confirmed, "confirmTrackedRecord");
}

type Stage = Extract<
  DeliveryState,
  "planning" | "implementing" | "validating" | "remediating" | "reviewing" | "compounding" | "admitting" | "recording" | "ready"
>;

async function driveTo(stage: Stage): Promise<Driven> {
  const driven = await newDelivery(); // state: planning
  if (stage === "planning") return driven;
  await plan(driven); // implementing
  if (stage === "implementing") return driven;
  if (stage === "remediating") {
    await implement(driven, GREET_WRONG, "planted defect");
    await sensor(driven, "failed");
    return driven;
  }
  await implement(driven, GREET_RIGHT, "implement the greeting");
  if (stage === "validating") return driven;
  await sensor(driven, "passed"); // reviewing
  if (stage === "reviewing") return driven;
  await review(driven); // compounding
  if (stage === "compounding") return driven;
  await compound(driven); // admitting
  if (stage === "admitting") return driven;
  await admitStep(driven); // recording
  if (stage === "recording") return driven;
  await record(driven); // ready
  return driven;
}

async function takeoverResume(driven: Driven): Promise<void> {
  const ended = await facade.sessionEnded({ deliveryId: driven.deliveryId, fence: driven.fence });
  must(ended, "sessionEnded");
  const presented = await facade.presentTakeover({ deliveryId: driven.deliveryId, expiry: EXPIRY });
  must(presented, "presentTakeover");
  const authorized = await facade.confirmTakeover({ deliveryId: driven.deliveryId, echo: operatorEcho(presented.channelPath) });
  must(authorized, "confirmTakeover");
  const fresh = path.join(scratch, `wt-${sequence}-takeover-${presented.supersededFence + 1}`);
  git(repoDir, "worktree", "add", "--quiet", "-b", authorized.takeoverBranchRef, fresh, authorized.targetBaseCommit);
  const rebound = await facade.bindWorkspace({
    deliveryId: driven.deliveryId,
    worktreeDir: fresh,
    hostTaskId: `host-${sequence}-resume`,
    observedAt: LATER,
    attestationExpiry: EXPIRY,
    providerReviewBindingCapability: fixtureProviderBindingCapability(driven.deliveryId),
  });
  must(rebound, "rebind after takeover");
  driven.worktree = fresh;
  driven.branch = authorized.takeoverBranchRef;
  driven.fence = rebound.fence;
}

const stateOf = async (deliveryId: string): Promise<DeliveryState> => {
  const status = await facade.status({ deliveryId, observedAt: LATER });
  must(status, "status");
  return status.status.delivery.state;
};

let completedDeliveryId: string;
let evidenceWorktree: string;

// ── The scenarios ──────────────────────────────────────────────────────────

describe("durable checkpoints and host-driven recovery", () => {
  it("registers a frozen-shape contract from any origin and rejects material ambiguity before mutation", async () => {
    // A structurally identical contract authored outside the fixture module:
    // registration accepts the frozen shape regardless of origin.
    const foreignOrigin = {
      spec: "scoped-delivery-contract/1",
      contractId: "contract-foreign-origin-1",
      task: "add the contracted greeting module",
      intendedOutcome: "src/greet.mjs exports greet() returning exactly 'hello, skeleton'",
      acceptanceCriteria: [{ criterionId: "greeting-behavior", statement: "greet() returns 'hello, skeleton'" }],
      nonGoals: ["none"],
      repository: { repositoryId: "disposable-skeleton", baseRef: "main" },
      requestedFinishLine: "merge-ready",
      requestedAuthority: [],
      unresolvedDecisions: [],
    } as typeof DISPOSABLE_CONTRACT;
    const presented = await facade.presentContract({ contract: foreignOrigin, expiry: EXPIRY });
    must(presented, "foreign-origin presentContract");

    // Material ambiguity remains in intake and cannot begin mutation.
    const ambiguous = await facade.presentContract({
      contract: { ...foreignOrigin, contractId: "contract-ambiguous-1", unresolvedDecisions: ["which greeting text?"] },
      expiry: EXPIRY,
    });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.blockers[0]?.code).toBe("contract_rejected");
  });

  it("ends and resumes a host task at every stage — always a fresh-worktree takeover, never a replay", { timeout: 300_000 }, async () => {
    const stages: readonly Stage[] = [
      "planning",
      "implementing",
      "validating",
      "remediating",
      "reviewing",
      "compounding",
      "admitting",
      "recording",
      "ready",
    ];
    for (const stage of stages) {
      const driven = await driveTo(stage);
      expect(await stateOf(driven.deliveryId), `pre-takeover at ${stage}`).toBe(stage);
      // The recording-stage drive ran admission in this worktree, so its
      // git-private namespace holds accepted evidence for the locality test.
      if (stage === "recording") evidenceWorktree = driven.worktree;
      await takeoverResume(driven);
      // The underlying checkpoint did not move: resume lands exactly where
      // the interrupted task stood, with accepted work never replayed.
      expect(await stateOf(driven.deliveryId), `post-takeover at ${stage}`).toBe(stage);
      if (stage === "ready") {
        const finished = await facade.completeFinishLine({ deliveryId: driven.deliveryId, fence: driven.fence });
        must(finished, "completeFinishLine after resume");
        expect(finished.state).toBe("completed");
        completedDeliveryId = driven.deliveryId;
      }
    }
  });

  it("permanently rejects outputs from a superseded fence while the live fence proceeds", { timeout: 120_000 }, async () => {
    const driven = await driveTo("implementing");
    const staleFence = driven.fence;
    const staleWorktree = driven.worktree;
    await takeoverResume(driven); // the live task now holds a NEWER fence

    // The superseded-but-still-live task races: its transition, evidence,
    // and action outputs are permanently rejected at the canonical recheck.
    const staleOutputs = [
      await facade.checkpointCandidate({ deliveryId: driven.deliveryId, resultBytes: "stale", fence: staleFence }),
      await facade.ingestProviderReviewResult({
        deliveryId: driven.deliveryId,
        handoffId: "handoff-stale",
        resultBytes: "stale",
        fence: staleFence,
        invocationCapability: { id: "stale-invocation", secret: "x".repeat(64) },
      }),
      await facade.runSensor({ deliveryId: driven.deliveryId, fence: staleFence }),
      await facade.completeFinishLine({ deliveryId: driven.deliveryId, fence: staleFence }),
      await facade.submitStageResult({ deliveryId: driven.deliveryId, stageId: "plan", resultBytes: "stale", fence: staleFence }),
    ];
    for (const output of staleOutputs) {
      expect(output.ok).toBe(false);
      if (!output.ok) expect(output.blockers[0]?.code).toBe("stale_fence");
    }

    // Omitting the fence is not an escape hatch: a fence-carrying operation
    // invoked without one fails closed rather than fabricating a vacuous
    // recheck. (Cast past the required parameter the way an untyped caller
    // would.)
    const fenceless = await (facade.checkpointCandidate as (input: { deliveryId: string; resultBytes: string }) => ReturnType<ManagedDeliveryFacade["checkpointCandidate"]>)({
      deliveryId: driven.deliveryId,
      resultBytes: "no fence presented",
    });
    expect(fenceless.ok).toBe(false);
    if (!fenceless.ok) expect(fenceless.blockers[0]?.code).toBe("missing_fence");

    // Same-worktree resume is refused: no termination provenance exists on
    // this host tier, so the quarantined worktree cannot be re-bound.
    const ended = await facade.sessionEnded({ deliveryId: driven.deliveryId, fence: driven.fence });
    must(ended, "sessionEnded");
    const presented = await facade.presentTakeover({ deliveryId: driven.deliveryId, expiry: EXPIRY });
    must(presented, "presentTakeover");
    const authorized = await facade.confirmTakeover({ deliveryId: driven.deliveryId, echo: operatorEcho(presented.channelPath) });
    must(authorized, "confirmTakeover");
    const sameWorktree = await facade.bindWorkspace({
      deliveryId: driven.deliveryId,
      worktreeDir: staleWorktree,
      hostTaskId: "host-same-worktree",
      observedAt: LATER,
      attestationExpiry: EXPIRY,
      providerReviewBindingCapability: fixtureProviderBindingCapability(driven.deliveryId),
    });
    expect(sameWorktree.ok).toBe(false);
    if (!sameWorktree.ok) expect(sameWorktree.blockers[0]?.code).toBe("takeover_mismatch");

    // The authorized fresh worktree still completes the resume.
    const fresh = path.join(scratch, `wt-race-fresh`);
    git(repoDir, "worktree", "add", "--quiet", "-b", authorized.takeoverBranchRef, fresh, authorized.targetBaseCommit);
    const rebound = await facade.bindWorkspace({
      deliveryId: driven.deliveryId,
      worktreeDir: fresh,
      hostTaskId: "host-race-fresh",
      observedAt: LATER,
      attestationExpiry: EXPIRY,
      providerReviewBindingCapability: fixtureProviderBindingCapability(driven.deliveryId),
    });
    must(rebound, "fresh-worktree rebind");
    const liveResult = await facade.submitStageResult({
      deliveryId: driven.deliveryId,
      stageId: "plan",
      resultBytes: "live plan",
      fence: rebound.fence,
    });
    expect(liveResult.ok).toBe(false); // wrong state (implementing), not stale
    if (!liveResult.ok) expect(liveResult.blockers[0]?.code).toBe("wrong_state");
  });

  it("never voids a pending takeover confirmation through an observation-only append — an advancing append does", { timeout: 120_000 }, async () => {
    const observed = await driveTo("implementing");
    const presented = await facade.presentTakeover({ deliveryId: observed.deliveryId, expiry: EXPIRY });
    must(presented, "presentTakeover");
    // An observation-only append between presentation and consumption: the
    // expected journal revision the confirmation binds does not advance.
    const ended = await facade.sessionEnded({ deliveryId: observed.deliveryId, fence: observed.fence });
    must(ended, "sessionEnded (observation-only)");
    const authorized = await facade.confirmTakeover({ deliveryId: observed.deliveryId, echo: operatorEcho(presented.channelPath) });
    must(authorized, "confirmTakeover after observation-only append");

    // And the contrast: an append that DOES advance the revision voids the
    // pending authorization at consumption.
    const advanced = await driveTo("implementing");
    const presentedStale = await facade.presentTakeover({ deliveryId: advanced.deliveryId, expiry: EXPIRY });
    must(presentedStale, "presentTakeover");
    await implement(advanced, GREET_RIGHT, "advance the journal after presentation");
    const refused = await facade.confirmTakeover({ deliveryId: advanced.deliveryId, echo: operatorEcho(presentedStale.channelPath) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.blockers[0]?.code).toBe("takeover_stale");
  });

  it("cancels before, during, and after mutation — fence revoked, late activity denied, workspace preserved", { timeout: 120_000 }, async () => {
    // BEFORE mutation.
    const before = await driveTo("planning");
    const requested = await facade.requestCancellation({ deliveryId: before.deliveryId });
    must(requested, "requestCancellation");
    expect(requested.state).toBe("cancellation_requested");
    const status = await facade.status({ deliveryId: before.deliveryId, observedAt: LATER });
    must(status, "status");
    expect(status.status.hostActivity).toBe("cancellation_pending");
    // The fence is revoked for the interceptor: the voided attestation
    // re-denies every tool, including a late subagent's.
    // The binding state is fence-scoped, so a rebind writes a new file rather
    // than overwriting the predecessor's; the current one is named by the
    // bound workspace's fence.
    const statePath = (await (async () => {
      const deliveryDir = path.join(await facade.namespaceDir(), "deliveries", before.deliveryId);
      const meta = JSON.parse(readFileSync(path.join(deliveryDir, "workspace.json"), "utf8")) as { fence: number };
      return path.join(deliveryDir, "binding", `state-${meta.fence}.json`);
    })());
    const revokedState = JSON.parse(readFileSync(statePath, "utf8")) as HookBindingState;
    expect(decideHookInvocation(revokedState, { tool_name: "Read", tool_input: {} }, LATER, revokedState.expectation.invocationFence).allowed).toBe(false);
    // Checkpoint operations refuse in cancellation_requested.
    const lateStage = await facade.submitStageResult({ deliveryId: before.deliveryId, stageId: "plan", resultBytes: "late", fence: before.fence });
    expect(lateStage.ok).toBe(false);
    const finalized = await facade.finalizeCancellation({ deliveryId: before.deliveryId });
    must(finalized, "finalizeCancellation");
    expect(finalized.state).toBe("cancelled");
    // Terminal: even the honest lifecycle append is refused now.
    const lateEnd = await facade.sessionEnded({ deliveryId: before.deliveryId, fence: before.fence });
    expect(lateEnd.ok).toBe(false);
    // The workspace was quarantined, never cleaned: the host owns worktrees.
    expect(existsSync(before.worktree)).toBe(true);

    // DURING mutation: uncommitted work in the worktree survives quarantine.
    const during = await driveTo("implementing");
    writeFileSync(path.join(during.worktree, "src", "greet.mjs"), GREET_WRONG);
    must(await facade.requestCancellation({ deliveryId: during.deliveryId }), "requestCancellation during");
    must(await facade.finalizeCancellation({ deliveryId: during.deliveryId }), "finalizeCancellation during");
    expect(readFileSync(path.join(during.worktree, "src", "greet.mjs"), "utf8")).toBe(GREET_WRONG);

    // AFTER mutation: the last trusted candidate is preserved in the journal.
    const after = await driveTo("validating");
    must(await facade.requestCancellation({ deliveryId: after.deliveryId }), "requestCancellation after");
    must(await facade.finalizeCancellation({ deliveryId: after.deliveryId }), "finalizeCancellation after");
    const store = createJournalStore(path.join(await facade.namespaceDir(), "deliveries", after.deliveryId, "journal.jsonl"));
    const read = await store.read();
    must(read, "journal read");
    const kinds = (read.entries as { kind: string; payload: Record<string, unknown> }[]).map((entry) => entry.kind);
    expect(kinds).toContain("candidate.recaptured");
    expect(kinds).toContain("workspace.disposition.recorded");
    const reduced = await store.state();
    must(reduced, "journal reduce");
    expect(reduced.state.state).toBe("cancelled");
  });

  it("voids a pending waiver proposal on candidate change and parks a zero-mutation discharge without stranding", { timeout: 120_000 }, async () => {
    const driven = await driveTo("remediating");
    const proposed = await facade.recordApprovalRequest({
      deliveryId: driven.deliveryId,
      requestKind: "waiver",
      criterionId: "greeting-behavior",
      actorId: "operator-1",
      reason: "finding judged non-blocking; waiver proposed for the criterion",
      fence: driven.fence,
    });
    must(proposed, "recordApprovalRequest");
    expect(proposed.state).toBe("remediating"); // no dedicated wait state

    // A proposal outside reviewing/remediating/admitting is refused.
    const wrongState = await driveTo("implementing");
    const misplaced = await facade.recordApprovalRequest({
      deliveryId: wrongState.deliveryId,
      requestKind: "waiver",
      criterionId: "greeting-behavior",
      actorId: "operator-1",
      reason: "premature",
      fence: wrongState.fence,
    });
    expect(misplaced.ok).toBe(false);

    // The candidate changes: the stale proposal voids with a typed blocker
    // record, and the delivery proceeds through validation as usual.
    await implement(driven, GREET_RIGHT, "remediate the planted defect");
    const store = createJournalStore(path.join(await facade.namespaceDir(), "deliveries", driven.deliveryId, "journal.jsonl"));
    const read = await store.read();
    must(read, "journal read");
    const voided = (read.entries as { kind: string; payload: Record<string, unknown> }[]).filter(
      (entry) => entry.kind === "blocker.recorded" && entry.payload["code"] === "approval.proposal-voided",
    );
    expect(voided).toHaveLength(1);
    expect(await stateOf(driven.deliveryId)).toBe("validating");

    // The zero-mutation discharge: a pending waiver in remediating with NO
    // candidate change cannot skip validation or review — an identical-tree
    // re-checkpoint loops back through the still-binding finding — and the
    // typed escape (cancellation) stays open, so the delivery parks without
    // stranding until the approval lane can consume the proposal.
    const parked = await driveTo("remediating");
    must(
      await facade.recordApprovalRequest({
        deliveryId: parked.deliveryId,
        requestKind: "waiver",
        criterionId: "greeting-behavior",
        actorId: "operator-1",
        reason: "zero-mutation discharge attempt",
        fence: parked.fence,
      }),
      "recordApprovalRequest (parked)",
    );
    const rechk = await facade.checkpointCandidate({
      deliveryId: parked.deliveryId,
      resultBytes: typedStageResultBytes({
        stageId: "implement",
        deliveryId: parked.deliveryId,
        outputKind: "delivery-candidate",
        candidate: treeOf(parked.worktree),
      }),
      fence: parked.fence,
    });
    must(rechk, "identical-tree re-checkpoint");
    await sensor(parked, "failed"); // the planted defect still fails the trusted sensor
    expect(await stateOf(parked.deliveryId)).toBe("remediating"); // back where it parked — never admitted
    must(await facade.requestCancellation({ deliveryId: parked.deliveryId }), "typed escape stays open");
  });

  it("preserves a dirty root checkout and never treats it as delivery input", { timeout: 120_000 }, async () => {
    const untracked = path.join(repoDir, "operator-scratch-note.txt");
    writeFileSync(untracked, "unrelated operator work\n");
    const tracked = path.join(repoDir, "src", "README.md");
    const trackedBefore = readFileSync(tracked, "utf8");
    writeFileSync(tracked, `${trackedBefore}uncommitted root edit\n`);

    const driven = await driveTo("validating");
    // The root's dirt never entered the candidate...
    const candidateTree = git(driven.worktree, "ls-tree", "-r", "--name-only", "HEAD");
    expect(candidateTree).not.toContain("operator-scratch-note.txt");
    // ...and both root files are preserved byte for byte.
    expect(readFileSync(untracked, "utf8")).toBe("unrelated operator work\n");
    expect(readFileSync(tracked, "utf8")).toBe(`${trackedBefore}uncommitted root edit\n`);

    git(repoDir, "checkout", "--", "src/README.md");
  });

  it("fails closed on a takeover branch collision, with a typed journal record", { timeout: 120_000 }, async () => {
    const driven = await driveTo("planning");
    must(await facade.sessionEnded({ deliveryId: driven.deliveryId, fence: driven.fence }), "sessionEnded");
    // The colliding branch pre-exists with the deterministic takeover name.
    const collidingRef = `takeover-${driven.deliveryId}-${driven.fence + 1}`;
    git(repoDir, "branch", collidingRef, "main");
    const collided = await facade.presentTakeover({ deliveryId: driven.deliveryId, expiry: EXPIRY });
    expect(collided.ok).toBe(false);
    if (!collided.ok) expect(collided.blockers[0]?.code).toBe("branch_collision");
    // Removing the collision unblocks the takeover.
    git(repoDir, "branch", "-D", collidingRef);
    const presented = await facade.presentTakeover({ deliveryId: driven.deliveryId, expiry: EXPIRY });
    must(presented, "presentTakeover after collision removed");
  });

  it("refuses operations on a vanished workspace and resumes through takeover", { timeout: 120_000 }, async () => {
    const driven = await driveTo("planning");
    git(repoDir, "worktree", "remove", "--force", driven.worktree);
    const refused = await facade.submitStageResult({ deliveryId: driven.deliveryId, stageId: "plan", resultBytes: "plan", fence: driven.fence });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.blockers[0]?.code).toBe("workspace_missing");
    await takeoverResume(driven);
    expect(await stateOf(driven.deliveryId)).toBe("planning");
    must(
      await facade.submitStageResult({
        deliveryId: driven.deliveryId,
        stageId: "plan",
        resultBytes: typedStageResultBytes({ stageId: "plan", deliveryId: driven.deliveryId, outputKind: "bounded-plan", candidate: treeOf(driven.worktree) }),
        fence: driven.fence,
      }),
      "plan after resume",
    );
  });

  it("keeps evidence worktree-local — another worktree resolves a disjoint store with no records", async () => {
    expect(evidenceWorktree).toBeDefined();
    const runGit = (cwd: string, args: readonly string[]): Promise<string> =>
      Promise.resolve(git(cwd, ...args));
    const config = disposableHarnessConfig();
    const foreign = path.join(scratch, "wt-foreign-evidence");
    git(repoDir, "worktree", "add", "--quiet", "-b", "foreign-evidence", foreign, "main");

    const storeOf = (dir: string): string => git(dir, "rev-parse", "--path-format=absolute", "--git-path", config.storageNamespace);
    expect(storeOf(foreign)).not.toBe(storeOf(evidenceWorktree));

    const mine = await discoverRecords(evidenceWorktree, {
      gateId: config.gateId,
      obligationId: "review.green",
      storageNamespace: config.storageNamespace,
      runGit,
    });
    expect(mine.records.length).toBeGreaterThan(0);
    const theirs = await discoverRecords(foreign, {
      gateId: config.gateId,
      obligationId: "review.green",
      storageNamespace: config.storageNamespace,
      runGit,
    });
    expect(theirs.records).toHaveLength(0);
  });

  it("keeps the worktree-scoped exclusion from interfering with other worktrees", async () => {
    const driven = await driveTo("planning");
    // The bound worktree hides the projection subtree through its
    // worktree-scoped excludes file.
    expect(git(driven.worktree, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(driven.worktree, ".managed-projection", "consumption.json"))).toBe(true);

    // A sibling worktree shares the common configuration write
    // (extensions.worktreeConfig) but NOT the exclusion: the same directory
    // name there is plainly visible, and no excludes file is configured.
    const sibling = path.join(scratch, "wt-exclusion-sibling");
    git(repoDir, "worktree", "add", "--quiet", "-b", "exclusion-sibling", sibling, "main");
    mkdirSync(path.join(sibling, ".managed-projection"), { recursive: true });
    writeFileSync(path.join(sibling, ".managed-projection", "probe.txt"), "visible\n");
    expect(git(sibling, "status", "--porcelain")).toContain(".managed-projection/");
    let siblingExcludes = "";
    try {
      siblingExcludes = git(sibling, "config", "--worktree", "--get", "core.excludesFile");
    } catch {
      siblingExcludes = "";
    }
    expect(siblingExcludes).toBe("");
  });

  it("denies authority-store writes through the model-external interceptor", async () => {
    const driven = await driveTo("planning");
    const statePath = (await (async () => {
      const deliveryDir = path.join(await facade.namespaceDir(), "deliveries", driven.deliveryId);
      const meta = JSON.parse(readFileSync(path.join(deliveryDir, "workspace.json"), "utf8")) as { fence: number };
      return path.join(deliveryDir, "binding", `state-${meta.fence}.json`);
    })());
    const bindingState = JSON.parse(readFileSync(statePath, "utf8")) as HookBindingState;
    // The delivery authority namespace lives under the common git directory —
    // outside the workspace and inside the protected `.git` space; both
    // spellings deny.
    const journalTarget = path.join(await facade.namespaceDir(), "deliveries", driven.deliveryId, "journal.jsonl");
    expect(decideHookInvocation(bindingState, { tool_name: "Write", tool_input: { file_path: journalTarget } }, LATER, bindingState.expectation.invocationFence).allowed).toBe(false);
    expect(
      decideHookInvocation(bindingState, { tool_name: "Write", tool_input: { file_path: path.join(driven.worktree, ".git") } }, LATER, bindingState.expectation.invocationFence).allowed,
    ).toBe(false);
    // A direct byte-level tamper of the journal fails the whole journal
    // closed at the next read (proven at the store layer); the interceptor
    // above is what keeps a model-driven task from reaching those bytes.
  });

  it("invalidates the candidate-bound stage when the candidate changes after review", { timeout: 120_000 }, async () => {
    const driven = await driveTo("compounding");
    writeFileSync(path.join(driven.worktree, "src", "greet.mjs"), `/** post-review edit */\n${GREET_RIGHT}`);
    commitAll(driven.worktree, "candidate changes after review");
    const compounded = await facade.submitStageResult({ deliveryId: driven.deliveryId, stageId: "compound", resultBytes: "compound", fence: driven.fence });
    must(compounded, "compound with changed candidate");
    expect(compounded.state).toBe("validating"); // back through validation and a fresh aligned review
  });

  it("exports and deletes terminal delivery detail through the maintenance journal", async () => {
    expect(completedDeliveryId).toBeDefined();

    // A non-terminal delivery's detail is not deletable.
    const inFlight = await driveTo("planning");
    const early = await facade.deleteDelivery({ deliveryId: inFlight.deliveryId });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.blockers[0]?.code).toBe("delivery_not_terminal");

    const exported = await facade.exportDelivery({ deliveryId: completedDeliveryId });
    must(exported, "exportDelivery");
    expect(existsSync(exported.exportPath)).toBe(true);
    expect(statSync(exported.exportPath).mode & 0o777).toBe(0o600);

    const deleted = await facade.deleteDelivery({ deliveryId: completedDeliveryId });
    must(deleted, "deleteDelivery");
    const deliveryDir = path.join(await facade.namespaceDir(), "deliveries", completedDeliveryId);
    expect(existsSync(deliveryDir)).toBe(false);
    // The preserved minimum audit record and the export both survive.
    for (const relative of deleted.preservedAuditRecords) {
      expect(existsSync(path.join(await facade.namespaceDir(), relative))).toBe(true);
    }
    expect(existsSync(exported.exportPath)).toBe(true);

    // The maintenance journal carries both actions, reduces clean, and — by
    // living in the installation scope — survived its target's removal.
    const maintenance = createMaintenanceJournalStore(path.join(installationPath, "maintenance.jsonl"));
    const read = await maintenance.read();
    must(read, "maintenance read");
    const actions = (read.entries as { kind: string; payload: Record<string, unknown> }[])
      .filter((entry) => entry.payload["subjectDeliveryId"] === completedDeliveryId)
      .map((entry) => entry.payload["action"]);
    expect(actions).toEqual(["export", "delete"]);
    must(await maintenance.state(), "maintenance reduce");

    const unknown = await facade.exportDelivery({ deliveryId: completedDeliveryId });
    expect(unknown.ok).toBe(false); // the detail is gone; only the audit trail remains
  });

  it("launched no product-owned agent process and created no worktree across every scenario", () => {
    expect(launches.length).toBeGreaterThan(0);
    const commands = [...new Set(launches.map((launch) => path.basename(launch.command)))];
    for (const command of commands) {
      expect(["git", "node"]).toContain(command);
    }
    for (const launch of launches) {
      const line = `${launch.command} ${launch.args.join(" ")}`;
      expect(line).not.toMatch(/claude|codex|anthropic|openai/i);
      expect(launch.args[0]).not.toBe("worktree");
    }
  });
});
