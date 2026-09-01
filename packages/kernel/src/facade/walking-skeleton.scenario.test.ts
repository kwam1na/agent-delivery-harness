/**
 * THE WALKING-SKELETON SCENARIO — the milestone gate's decidable sensor.
 *
 * One disposable git repository, one already-scoped contract, one real
 * installed composition (confirmation-fixture profile), and the full
 * checkpoint path driven end to end through the facade the way a host task
 * drives it: plan -> implement -> validate -> review -> admit -> record ->
 * merge-ready — with the planted failures the milestone names:
 *
 *   - a planted implementation defect the trusted sensor catches
 *     (validation loop through remediation);
 *   - the candidate rewriting its tracked sensor while the TRUSTED-BASE copy
 *     keeps governing;
 *   - a planted reviewer finding looping through remediation and a fresh
 *     aligned review;
 *   - a same-context reviewer re-invocation that does not count;
 *   - host-task interruption after an intermediate checkpoint, honest Tier 2
 *     `paused`, and resume in a fresh task as an operator-authorized takeover
 *     into a fresh worktree — with NO accepted work replayed;
 *   - model-minted confirmation attempts refused on both confirmation
 *     classes;
 *   - the operator-intervention counter pinned at zero while the host could
 *     proceed, with the two policy-required confirmations counted separately;
 *   - and the negative assertion that the PRODUCT launches no agent process:
 *     every process the facade ran is inventoried through the exec port.
 *
 * The driver below stands in for the Claude Code task (the product must never
 * launch one); the live host drive is a separate qualification leg recorded
 * in qualifications/walking-skeleton-m0.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJournalStore } from "../checkpoint/journal-store.ts";
import { CONFIRMATION_FIXTURE_PROFILE } from "../substrate/manifest.ts";
import { installComposition, packComposition } from "../substrate/installer.ts";
import { createQualificationFixtureAssertionSource } from "../substrate/assertion-source.ts";
import { maintainTrustState } from "../substrate/lifecycle.ts";
import { createExecPort, type ExecInvocation, type ExecPort } from "../host/exec-port.ts";
import { decideHookInvocation, type HookBindingState } from "../host/hook-main.ts";
import type { ConfirmationEchoAttempt, RenderedConfirmationChallenge } from "../binding/host-admission.ts";
import { createManagedDeliveryFacade, type ManagedDeliveryFacade } from "./managed-delivery.ts";
import {
  DISPOSABLE_CONTRACT,
  GREET_RIGHT,
  GREET_WRONG,
  buildDisposableRepository,
  disposableHarnessConfig,
  disposablePolicyBinding,
  disposablePolicyBindingForInstallation,
  fixtureProviderBindingCapability,
  fixtureProviderReview,
  ingestFixtureProviderReview,
  typedStageResultBytes,
} from "./disposable-repository.fixture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const FIXTURES = path.join(REPO_ROOT, "qualifications", "fixtures");

const NOW = "2026-08-30T12:00:00Z";
const LATER = "2026-08-30T12:00:30Z";
const EXPIRY = "2026-08-31T12:00:00Z";

let scratch: string;
let installationPath: string;
let receiptDir: string;
let repoDir: string;
let baseCommit: string;
let facade: ManagedDeliveryFacade;
let launches: ExecInvocation[];

/** Every process the PRODUCT launches rides this port and is inventoried. */
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

const treeOf = (worktree: string): string => git(worktree, "rev-parse", "HEAD^{tree}");

/** The operator side of the fixture confirmation channel. */
const operatorEcho = (channelPath: string, observedAt = NOW): ConfirmationEchoAttempt => {
  const pending = JSON.parse(readFileSync(channelPath, "utf8")) as { rendered: RenderedConfirmationChallenge };
  return {
    presentedChallenge: pending.rendered.challenge,
    presentedOnChannelId: pending.rendered.channelId,
    observedAt,
    viaModelVisibleSurface: false,
    interactive: true,
  };
};

const restoreWritable = (dir: string): void => {
  try {
    execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
  } catch {
    /* removal surfaces the real failure */
  }
};

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "walking-skeleton-"));
  launches = [];

  // A real packed and installed composition, confirmation-fixture profile.
  const packed = await packComposition({
    sourceRoot: REPO_ROOT,
    skillsArchivePath: path.join(FIXTURES, "agent-skills-core-v1-composition.zip"),
    skillsMetadataPath: path.join(FIXTURES, "agent-skills-core-v1-composition.metadata.json"),
    compositionProfile: CONFIRMATION_FIXTURE_PROFILE,
    compositionSequence: 1,
    outDir: path.join(scratch, "pack"),
  });
  expect(packed.ok, JSON.stringify(packed)).toBe(true);
  if (!packed.ok) throw new Error("unreachable");

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
  expect(installed.ok, JSON.stringify(installed)).toBe(true);

  const repo = buildDisposableRepository(path.join(scratch, "repo"));
  repoDir = repo.repoDir;
  baseCommit = repo.baseCommit;

  facade = createManagedDeliveryFacade({
    repoDir,
    policyBinding: disposablePolicyBinding(),
    installation: { installationPath, receiptDir },
    hostVersion: "2.1.97",
    exec: recordingExecPort(),
  });
}, 120_000);

afterAll(async () => {
  restoreWritable(scratch);
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

describe("the thin one-handoff walking skeleton", () => {
  let deliveryId: string;
  let worktreeA: string;
  let worktreeB: string;

  it("carries one already-scoped contract to merge-ready through the frozen checkpoint path", { timeout: 240_000 }, async () => {
    // ── Contract handoff: present, refuse the model-minted echo, confirm ──
    const presented = await facade.presentContract({ contract: DISPOSABLE_CONTRACT, expiry: EXPIRY });
    expect(presented.ok, JSON.stringify(presented)).toBe(true);
    if (!presented.ok) return;

    // Model-minted confirmation fixture: an echo arriving through a
    // model-visible surface is refused even with the right challenge bytes.
    const modelMinted = await facade.confirmContract({
      intakeId: presented.intakeId,
      echo: { ...operatorEcho(presented.channelPath), viaModelVisibleSurface: true },
    });
    expect(modelMinted.ok).toBe(false);

    // A detached descendant of an ended invocation holds no channel.
    const detached = await facade.confirmContract({
      intakeId: presented.intakeId,
      echo: { ...operatorEcho(presented.channelPath), presentedOnChannelId: "chan-orphaned" },
    });
    expect(detached.ok).toBe(false);

    const confirmed = await facade.confirmContract({
      intakeId: presented.intakeId,
      echo: operatorEcho(presented.channelPath),
    });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;
    deliveryId = confirmed.deliveryId;

    // A freshly registered delivery has no lifecycle events at all, so it
    // reports activity `unknown` and resume `takeover-required` before any
    // workspace exists. The status model must still name the way forward here:
    // binding the workspace MINTS the first fence rather than carrying one, so
    // the stale-fence suppression must not reach it. Read through the real
    // facade rather than a composed fixture, because the fixture is what missed
    // this the first time.
    const beforeBinding = await facade.status({ deliveryId, observedAt: LATER });
    expect(beforeBinding.ok, JSON.stringify(beforeBinding)).toBe(true);
    if (!beforeBinding.ok) return;
    expect(beforeBinding.status.hostActivity).toBe("unknown");
    expect(beforeBinding.status.nextCheckpoint.kind).toBe("bind-workspace");
    expect(beforeBinding.status.authorizedNextActions).toContain("bindWorkspace");
    expect(beforeBinding.status.authorizedNextActions).not.toContain("presentTakeover");

    // ── The HOST creates the isolated worktree; the facade only binds it ──
    worktreeA = path.join(scratch, "worktree-a");
    git(repoDir, "worktree", "add", "--quiet", "-b", "delivery", worktreeA, "main");
    const bound = await facade.bindWorkspace({
      deliveryId,
      worktreeDir: worktreeA,
      hostTaskId: "host-task-1",
      observedAt: NOW,
      attestationExpiry: EXPIRY,
      providerReviewBindingCapability: fixtureProviderBindingCapability(deliveryId),
    });
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    if (!bound.ok) return;
    expect(bound.fence).toBe(1);

    // Candidate-planted setting scopes are excluded at admission — the
    // composed selection loads no ambient scope at all.
    expect(bound.cliArgs).toContain("--setting-sources");
    expect(bound.cliArgs[bound.cliArgs.indexOf("--setting-sources") + 1]).toBe("");

    // The model-external interceptor governs the session: a write under a
    // protected authority path is denied, an in-grant write is allowed.
    const bindingState = JSON.parse(readFileSync(bound.statePath, "utf8")) as HookBindingState;
    expect(
      decideHookInvocation(bindingState, { tool_name: "Write", tool_input: { file_path: path.join(worktreeA, ".managed-projection", "x") } }, LATER, bindingState.expectation.invocationFence).allowed,
    ).toBe(false);
    expect(
      decideHookInvocation(bindingState, { tool_name: "Write", tool_input: { file_path: path.join(worktreeA, "src", "greet.mjs") } }, LATER, bindingState.expectation.invocationFence).allowed,
    ).toBe(true);
    expect(decideHookInvocation(bindingState, { tool_name: "operator-confirmation.takeover-authorization", tool_input: {} }, LATER, bindingState.expectation.invocationFence).allowed).toBe(false);

    // ── Plan checkpoint ──
    const statusPlanning = await facade.status({ deliveryId, observedAt: LATER });
    expect(statusPlanning.ok && statusPlanning.status.delivery.state === "planning" && statusPlanning.status.hostActivity === "active").toBe(true);
    const planned = await facade.submitStageResult({
      deliveryId,
      stageId: "plan",
      resultBytes: typedStageResultBytes({ stageId: "plan", deliveryId, outputKind: "bounded-plan", candidate: treeOf(worktreeA) }),
      fence: bound.fence,
    });
    expect(planned.ok && planned.state === "implementing").toBe(true);

    // ── Interruption after an intermediate checkpoint (Tier 2) ──
    const endedEarly = await facade.sessionEnded({ deliveryId, fence: bound.fence });
    expect(endedEarly.ok).toBe(true);
    const statusPaused = await facade.status({ deliveryId, observedAt: LATER });
    expect(statusPaused.ok, JSON.stringify(statusPaused)).toBe(true);
    if (!statusPaused.ok) return;
    // Honest paused; the underlying checkpoint did NOT move.
    expect(statusPaused.status.hostActivity).toBe("paused");
    expect(statusPaused.status.delivery.state).toBe("implementing");
    expect(statusPaused.status.resume).toBe("takeover-required");

    // ── Fresh task: operator-authorized takeover into a fresh worktree ──
    const takeover = await facade.presentTakeover({ deliveryId, expiry: EXPIRY });
    expect(takeover.ok, JSON.stringify(takeover)).toBe(true);
    if (!takeover.ok) return;
    expect(takeover.supersededFence).toBe(1);
    expect(takeover.targetBaseCommit).toBe(baseCommit); // the last trusted commit

    // Model-minted takeover authorization refused.
    const modelTakeover = await facade.confirmTakeover({
      deliveryId,
      echo: { ...operatorEcho(takeover.channelPath), viaModelVisibleSurface: true },
    });
    expect(modelTakeover.ok).toBe(false);

    const authorized = await facade.confirmTakeover({ deliveryId, echo: operatorEcho(takeover.channelPath) });
    expect(authorized.ok, JSON.stringify(authorized)).toBe(true);
    if (!authorized.ok) return;

    // A consumed takeover quarantines the prior workspace for real: no
    // checkpoint operation runs until the authorized fresh worktree is bound,
    // so a superseded-but-still-running task keeps no write path.
    const quarantined = await facade.runSensor({ deliveryId, fence: bound.fence });
    expect(quarantined.ok).toBe(false);
    if (!quarantined.ok) {
      expect(quarantined.blockers[0]?.code).toBe("takeover_pending");
    }

    worktreeB = path.join(scratch, "worktree-b");
    git(repoDir, "worktree", "add", "--quiet", "-b", authorized.takeoverBranchRef, worktreeB, authorized.targetBaseCommit);
    const rebound = await facade.bindWorkspace({
      deliveryId,
      worktreeDir: worktreeB,
      hostTaskId: "host-task-2",
      observedAt: LATER,
      attestationExpiry: EXPIRY,
      providerReviewBindingCapability: fixtureProviderBindingCapability(deliveryId),
    });
    expect(rebound.ok, JSON.stringify(rebound)).toBe(true);
    if (!rebound.ok) return;
    expect(rebound.fence).toBe(2); // monotonic supersession

    // NO replay of accepted work: the plan checkpoint stands, and the next
    // checkpoint is implementation — not a second plan.
    const resumed = await facade.status({ deliveryId, observedAt: LATER });
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.status.delivery.state).toBe("implementing");
    expect(resumed.status.hostActivity).toBe("active");
    expect(resumed.status.nextCheckpoint).toMatchObject({ kind: "workflow-stage", stageId: "implement" });

    // The superseded invocation opens no tools, twice over. Its binding state
    // is fence-scoped, so the rebind wrote a new file rather than overwriting
    // it — and supersession voided the one it still reads.
    const staleStatePath = await facadeStatePath(deliveryId, 1);
    const supersededState = JSON.parse(readFileSync(staleStatePath, "utf8")) as HookBindingState;
    expect(supersededState.attestation).toBeNull();
    expect(decideHookInvocation(supersededState, { tool_name: "Read", tool_input: {} }, LATER, 1).allowed).toBe(false);

    const freshState = JSON.parse(readFileSync(await facadeStatePath(deliveryId), "utf8")) as HookBindingState;
    expect(freshState.expectation.invocationFence).toBe(2);
    // And a fence 1 attestation presented against the current expectation is
    // rejected on its own terms, independently of the voiding.
    expect(
      decideHookInvocation(
        { ...freshState, attestation: bindingState.attestation },
        { tool_name: "Read", tool_input: {} },
        LATER,
        freshState.expectation.invocationFence,
      ).allowed,
    ).toBe(false);

    // ── Implement: PLANTED DEFECT first ──
    writeFileSync(path.join(worktreeB, "src", "greet.mjs"), GREET_WRONG);
    commitAll(worktreeB, "implement the greeting (planted defect)");
    const checkpointed = await facade.checkpointCandidate({
      deliveryId,
      resultBytes: typedStageResultBytes({ stageId: "implement", deliveryId, outputKind: "delivery-candidate", candidate: treeOf(worktreeB) }),
      fence: rebound.fence,
    });
    expect(checkpointed.ok && checkpointed.state === "validating").toBe(true);

    // The trusted sensor catches the planted defect: validation -> remediation.
    const redSensor = await facade.runSensor({ deliveryId, fence: rebound.fence });
    expect(redSensor.ok, JSON.stringify(redSensor)).toBe(true);
    if (!redSensor.ok) return;
    expect(redSensor.outcome).toBe("failed");
    expect(redSensor.state).toBe("remediating");

    // ── Candidate rewrites its sensor; the TRUSTED-BASE copy governs ──
    writeFileSync(path.join(worktreeB, "tools", "sensor.mjs"), "process.exit(0);\n");
    commitAll(worktreeB, "candidate rewrites its own sensor to always pass");
    const rewritten = await facade.checkpointCandidate({
      deliveryId,
      resultBytes: typedStageResultBytes({ stageId: "implement", deliveryId, outputKind: "delivery-candidate", candidate: treeOf(worktreeB) }),
      fence: rebound.fence,
    });
    expect(rewritten.ok && rewritten.state === "validating").toBe(true);
    const governed = await facade.runSensor({ deliveryId, fence: rebound.fence });
    expect(governed.ok, JSON.stringify(governed)).toBe(true);
    if (!governed.ok) return;
    expect(governed.outcome).toBe("failed"); // the always-pass rewrite did not govern
    expect(governed.state).toBe("remediating");

    // ── Real remediation ──
    writeFileSync(path.join(worktreeB, "src", "greet.mjs"), GREET_RIGHT);
    git(worktreeB, "checkout", "main", "--", "tools/sensor.mjs");
    commitAll(worktreeB, "remediate: contracted greeting, sensor restored");
    const remediated = await facade.checkpointCandidate({
      deliveryId,
      resultBytes: typedStageResultBytes({ stageId: "implement", deliveryId, outputKind: "delivery-candidate", candidate: treeOf(worktreeB) }),
      fence: rebound.fence,
    });
    expect(remediated.ok && remediated.state === "validating").toBe(true);
    const greenSensor = await facade.runSensor({ deliveryId, fence: rebound.fence });
    expect(greenSensor.ok, JSON.stringify(greenSensor)).toBe(true);
    if (!greenSensor.ok) return;
    expect(greenSensor.outcome).toBe("passed");
    expect(greenSensor.state).toBe("reviewing");

    // ── Review round 1: a PLANTED FINDING loops through remediation ──
    const firstReview = await ingestFixtureProviderReview({
      facade,
      deliveryId,
      fence: rebound.fence,
      runId: "run-review-round-1",
      verdict: "changes_requested",
    });
    expect(firstReview.ok, JSON.stringify(firstReview)).toBe(true);
    const round1 = await facade.reduceReview({ deliveryId, fence: rebound.fence });
    expect(round1.ok && round1.state === "remediating").toBe(true);

    writeFileSync(path.join(worktreeB, "src", "greet.mjs"), `/** The contracted greeting. */\n${GREET_RIGHT}`);
    commitAll(worktreeB, "address the review finding");
    const reReviewed = await facade.checkpointCandidate({
      deliveryId,
      resultBytes: typedStageResultBytes({ stageId: "implement", deliveryId, outputKind: "delivery-candidate", candidate: treeOf(worktreeB) }),
      fence: rebound.fence,
    });
    expect(reReviewed.ok && reReviewed.state === "validating").toBe(true);
    const green2 = await facade.runSensor({ deliveryId, fence: rebound.fence });
    expect(green2.ok, JSON.stringify(green2)).toBe(true);
    if (!green2.ok) return;
    expect(green2.state).toBe("reviewing");

    // ── Review round 2: SAME context/lens relabeling cannot synthesize an
    //    independent reviewer; an unretained invocation proof cannot be forged ──
    const preparedReview = await fixtureProviderReview({ facade, deliveryId, fence: rebound.fence, runId: "run-review-round-2" });
    expect("result" in preparedReview, JSON.stringify(preparedReview)).toBe(true);
    if (!("result" in preparedReview)) return;
    const poisoned = await facade.ingestProviderReviewResult({
      deliveryId,
      handoffId: preparedReview.handoff.handoffId,
      resultBytes: JSON.stringify(preparedReview.result),
      fence: rebound.fence,
      invocationCapability: { id: preparedReview.invocationCapability.id, secret: "forged".repeat(8) },
    });
    expect(poisoned.ok).toBe(false);
    if (!poisoned.ok) expect(poisoned.blockers[0]?.code).toBe("provider_invocation_capability_refused");

    const aligned = await ingestFixtureProviderReview({
      facade,
      deliveryId,
      fence: rebound.fence,
      runId: "run-review-round-2-aligned",
    });
    expect(aligned.ok, JSON.stringify(aligned)).toBe(true);
    const round2 = await facade.reduceReview({ deliveryId, fence: rebound.fence });
    expect(round2.ok, JSON.stringify(round2)).toBe(true);
    if (!round2.ok) return;
    expect(round2.state).toBe("compounding");

    // ── Compound (no repository mutation) -> admission ──
    const compounded = await facade.submitStageResult({
      deliveryId,
      stageId: "compound",
      resultBytes: typedStageResultBytes({ stageId: "compound", deliveryId, outputKind: "no-reusable-learning", candidate: treeOf(worktreeB) }),
      fence: rebound.fence,
    });
    expect(compounded.ok && compounded.state === "admitting").toBe(true);

    // ── Admission through the EXISTING harness boundary ──
    const admitted = await facade.admit({ deliveryId, recordedAtInstant: LATER, env: { CLAUDECODE: "1" }, fence: rebound.fence });
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.state).toBe("recording");

    // ── Tracked record: neutral commit plus the external verifier core ──
    const prepared = await facade.prepareTrackedRecord({ deliveryId, env: { CLAUDECODE: "1" }, fence: rebound.fence });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    commitAll(worktreeB, "tracked delivery record");
    const recorded = await facade.confirmTrackedRecord({ deliveryId, fence: rebound.fence });
    expect(recorded.ok, JSON.stringify(recorded)).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.state).toBe("ready");

    // ── Merge-ready ──
    const finished = await facade.completeFinishLine({ deliveryId, fence: rebound.fence });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    if (!finished.ok) return;
    expect(finished.state).toBe("completed");
  });

  it("kept the operator-intervention counter at zero while counting the two policy-required interruptions", async () => {
    const status = await facade.status({ deliveryId, observedAt: LATER });
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    expect(status.status.delivery.state).toBe("completed");
    expect(status.status.operatorInterventions).toBe(0);
    // Exactly two: the contract confirmation and the takeover authorization.
    expect(status.status.policyRequiredInterruptions).toBe(2);
  });

  it("reports the obligations admission actually completed, not an empty set", async () => {
    // An enumerated status field that is only ever observed empty is satisfied
    // vacuously. Admission rejects an empty activated-obligation set, so a
    // completed delivery must report the ones it discharged — including the
    // candidate-bound outcome verification.
    const status = await facade.status({ deliveryId, observedAt: LATER });
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    expect(status.status.delivery.state).toBe("completed");
    expect(status.status.completedObligations.length).toBeGreaterThan(0);
    expect(status.status.completedObligations).toContain("outcome.verification");
    // Sorted and deduplicated, as the projection any future surface consumes.
    expect([...status.status.completedObligations]).toEqual([...new Set(status.status.completedObligations)].sort());
  });

  it("accepted no replayed work: each workflow checkpoint's stage result is durable exactly once per acceptance", async () => {
    const store = createJournalStore(path.join(await facade.namespaceDir(), "deliveries", deliveryId, "journal.jsonl"));
    const read = await store.read();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const entries = read.entries as { kind: string; payload: Record<string, unknown> }[];
    const stageResults = entries.filter((entry) => entry.kind === "stage.result.recorded");
    expect(stageResults.filter((entry) => entry.payload["stageId"] === "plan")).toHaveLength(1);
    expect(stageResults.filter((entry) => entry.payload["stageId"] === "compound")).toHaveLength(1);
    // The journal is append-only and the frozen reducer accepted every entry;
    // re-reducing the durable bytes proves the recovery path reads clean.
    const reduced = await store.state();
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;
    expect(reduced.state.state).toBe("completed");
    expect(reduced.state.lastFence).toBe(2);
  });

  it("does not reopen a terminal success when the generation is revoked afterwards", async () => {
    // The revocation race's terminal leg: revoking the pinned generation
    // AFTER merge-ready completion neither reopens the terminal journal nor
    // rewrites the delivery's history — revocation fences live work, it does
    // not unwind finished work.
    const installedGeneration = JSON.parse(
      readFileSync(path.join(installationPath, "pointers", "active.json"), "utf8"),
    ) as { generationDigest: string };
    const revoked = await maintainTrustState({
      installationPath,
      receiptDir,
      operation: "revoke",
      generationDigest: installedGeneration.generationDigest,
      assertionSource: createQualificationFixtureAssertionSource(),
      now: NOW,
    });
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true);

    const status = await facade.status({ deliveryId, observedAt: LATER });
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    expect(status.status.delivery.state).toBe("completed");

    // A mutation-capable operation refuses rather than reopening the journal.
    const refused = await facade.submitStageResult({ deliveryId, stageId: "plan", resultBytes: "late", fence: status.status.delivery.fence });
    expect(refused.ok).toBe(false);
    const still = await facade.status({ deliveryId, observedAt: LATER });
    expect(still.ok && still.status.delivery.state === "completed").toBe(true);

    // Restore trust for the fixture drives that follow.
    const unrevoked = await maintainTrustState({
      installationPath,
      receiptDir,
      operation: "unrevoke",
      generationDigest: installedGeneration.generationDigest,
      assertionSource: createQualificationFixtureAssertionSource(),
      now: NOW,
    });
    expect(unrevoked.ok, JSON.stringify(unrevoked)).toBe(true);
  });

  it("launched no product-owned agent process or daemon — the exec inventory is git, node, and nothing else", () => {
    expect(launches.length).toBeGreaterThan(0);
    const commands = [...new Set(launches.map((launch) => path.basename(launch.command)))];
    for (const command of commands) {
      expect(["git", "node"]).toContain(command);
    }
    for (const launch of launches) {
      const line = `${launch.command} ${launch.args.join(" ")}`;
      expect(line).not.toMatch(/claude|codex|anthropic|openai/i);
      // The product never creates or deletes a workspace: worktree lifecycle
      // stays with the host (the test driver above).
      expect(launch.args[0]).not.toBe("worktree");
    }
  });

  it("leaves a typed blocker readable without inspecting internal module commands", async () => {
    // A second delivery whose projection is tampered mid-run: the canonical
    // recheck fails closed, records a typed blocker, and `explain` renders it
    // with a remediation that names no internal command.
    // This is a NEW delivery after the prior test's revoke/unrevoke cycle.
    // Rebind only this new registration to the current trust epoch.
    facade = createManagedDeliveryFacade({
      repoDir,
      policyBinding: disposablePolicyBindingForInstallation(installationPath),
      installation: { installationPath, receiptDir },
      hostVersion: "2.1.97",
      exec: recordingExecPort(),
    });
    const presented = await facade.presentContract({
      contract: { ...DISPOSABLE_CONTRACT, contractId: "contract-greeting-2" },
      expiry: EXPIRY,
    });
    expect(presented.ok, JSON.stringify(presented)).toBe(true);
    if (!presented.ok) return;
    const confirmed = await facade.confirmContract({ intakeId: presented.intakeId, echo: operatorEcho(presented.channelPath) });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;

    const worktreeC = path.join(scratch, "worktree-c");
    git(repoDir, "worktree", "add", "--quiet", "-b", "delivery-c", worktreeC, "main");
    const bound = await facade.bindWorkspace({
      deliveryId: confirmed.deliveryId,
      worktreeDir: worktreeC,
      hostTaskId: "host-task-3",
      observedAt: NOW,
      attestationExpiry: EXPIRY,
      providerReviewBindingCapability: fixtureProviderBindingCapability(confirmed.deliveryId),
    });
    expect(bound.ok, JSON.stringify(bound)).toBe(true);

    const marker = path.join(worktreeC, ".managed-projection", "consumption.json");
    expect(existsSync(marker)).toBe(true);
    execFileSync("chmod", ["u+w", marker]);
    writeFileSync(marker, "{\"tampered\":true}\n");

    if (!bound.ok) return;
    const refused = await facade.submitStageResult({ deliveryId: confirmed.deliveryId, stageId: "plan", resultBytes: "plan", fence: bound.fence });
    expect(refused.ok).toBe(false);

    const status = await facade.status({ deliveryId: confirmed.deliveryId, observedAt: LATER });
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    expect(status.status.delivery.state).toBe("blocked");

    const explained = await facade.explainBlocker({ deliveryId: confirmed.deliveryId });
    expect(explained.ok, JSON.stringify(explained)).toBe(true);
    if (!explained.ok) return;
    expect(explained.blocker?.code).toBe("projection.tampered");
    // Typed and actionable without internal module commands.
    for (const text of [explained.blocker?.summary ?? "", explained.blocker?.remediation ?? ""]) {
      expect(text).not.toMatch(/--import|tsx|hook-main|managed-delivery\.ts|node /);
    }

    // The remediation the blocker advertises actually works: an authorized
    // takeover into a fresh worktree resumes the blocked delivery at its last
    // trustworthy checkpoint.
    const resumeTakeover = await facade.presentTakeover({ deliveryId: confirmed.deliveryId, expiry: EXPIRY });
    expect(resumeTakeover.ok, JSON.stringify(resumeTakeover)).toBe(true);
    if (!resumeTakeover.ok) return;
    const resumeAuthorized = await facade.confirmTakeover({
      deliveryId: confirmed.deliveryId,
      echo: operatorEcho(resumeTakeover.channelPath),
    });
    expect(resumeAuthorized.ok, JSON.stringify(resumeAuthorized)).toBe(true);
    if (!resumeAuthorized.ok) return;
    const worktreeD = path.join(scratch, "worktree-d");
    git(repoDir, "worktree", "add", "--quiet", "-b", resumeAuthorized.takeoverBranchRef, worktreeD, resumeAuthorized.targetBaseCommit);
    const rebound = await facade.bindWorkspace({
      deliveryId: confirmed.deliveryId,
      worktreeDir: worktreeD,
      hostTaskId: "host-task-4",
      observedAt: LATER,
      attestationExpiry: EXPIRY,
      providerReviewBindingCapability: fixtureProviderBindingCapability(confirmed.deliveryId),
    });
    expect(rebound.ok, JSON.stringify(rebound)).toBe(true);
    const resumedStatus = await facade.status({ deliveryId: confirmed.deliveryId, observedAt: LATER });
    expect(resumedStatus.ok, JSON.stringify(resumedStatus)).toBe(true);
    if (!resumedStatus.ok) return;
    expect(resumedStatus.status.delivery.state).toBe("planning"); // the last trustworthy checkpoint, not a dead end
    expect(resumedStatus.status.nextCheckpoint).toMatchObject({ kind: "workflow-stage", stageId: "plan" });

    // Falsifiability of the intervention counter: a journaled operator-input
    // blocker moves it.
    const store = createJournalStore(path.join(await facade.namespaceDir(), "deliveries", confirmed.deliveryId, "journal.jsonl"));
    const read = await store.read();
    const reduced = await store.state();
    expect(read.ok && reduced.ok).toBe(true);
    if (!read.ok || !reduced.ok) return;
    const appended = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: confirmed.deliveryId,
      expectedRevision: reduced.state.expectedRevision,
      idempotencyKey: `e${read.entries.length}-blocker.recorded`,
      kind: "blocker.recorded",
      payload: { code: "operator.input-required", summary: "planted intervention for counter falsifiability" },
    });
    expect(appended.ok, JSON.stringify(appended)).toBe(true);
    const counted = await facade.status({ deliveryId: confirmed.deliveryId, observedAt: LATER });
    expect(counted.ok && counted.status.operatorInterventions === 1).toBe(true);
  });
});

async function facadeStatePath(deliveryId: string, fence?: number): Promise<string> {
  // Fence-scoped: a rebind writes a new file instead of overwriting this one,
  // so a suite can name a SUPERSEDED invocation's state explicitly.
  const deliveryDir = path.join(await facade.namespaceDir(), "deliveries", deliveryId);
  const current = (JSON.parse(readFileSync(path.join(deliveryDir, "workspace.json"), "utf8")) as { fence: number }).fence;
  return path.join(deliveryDir, "binding", `state-${fence ?? current}.json`);
}
