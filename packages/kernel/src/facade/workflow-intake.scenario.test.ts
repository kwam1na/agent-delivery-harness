/**
 * THE EXECUTABLE-WORKFLOW SCENARIO — iterative intake and the typed
 * checkpoint reducer, driven end to end through the facade the way a host
 * task drives them.
 *
 * What this sensor proves, scenario by scenario:
 *
 *   - an outcome-only intake runs iteratively under the READ-ONLY intake
 *     grant, durably retains its clarification history and draft, presents
 *     ONE contract, and registers only after the operator confirmation —
 *     with the intake journal as the audit rail;
 *   - a draft mutated after presentation voids the pending confirmation;
 *   - a preflight failure in `validating_acceptance` blocks and retries
 *     WITHOUT a second confirmation — the consumed confirmation stands over
 *     the unchanged draft (the pinned intake-ordering rule);
 *   - the already-scoped fallback lane bypasses only clarification — never
 *     contract validation or the confirmation;
 *   - prose cannot advance a checkpoint: the reducer persists only typed
 *     `workflow-stage-result/1` documents validated against the pinned graph
 *     (plan precedes mutation; an implement result cannot nominate its own
 *     candidate; the explicit no-compound outcome is recorded);
 *   - review repeats until the selected lenses approve or the bounded-loop
 *     blocker records — the loop cannot spin forever.
 *
 * The whole drive runs trackerless: the compiled disposable policy declares
 * `proceed-without-tracker`, and no tracker transport exists to launch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIntakeJournalStore, createJournalStore } from "../checkpoint/journal-store.ts";
import { CONFIRMATION_FIXTURE_PROFILE } from "../substrate/manifest.ts";
import { installComposition, packComposition } from "../substrate/installer.ts";
import { createQualificationFixtureAssertionSource } from "../substrate/assertion-source.ts";
import { maintainTrustState } from "../substrate/lifecycle.ts";
import type { ConfirmationEchoAttempt, RenderedConfirmationChallenge } from "../binding/host-admission.ts";
import { createManagedDeliveryFacade, type ManagedDeliveryFacade } from "./managed-delivery.ts";
import {
  DISPOSABLE_CONTRACT,
  GREET_RIGHT,
  buildDisposableRepository,
  disposableHarnessConfig,
  disposablePolicyBinding,
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

let scratch: string;
let installationPath: string;
let receiptDir: string;
let repoDir: string;
let facade: ManagedDeliveryFacade;
let installedGenerationDigest: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const commitAll = (cwd: string, message: string): void => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "--no-gpg-sign", "-m", message);
};

const treeOf = (worktree: string): string => git(worktree, "rev-parse", "HEAD^{tree}");

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

const codesOf = (result: { ok: true } | { ok: false; blockers: readonly { code: string }[] }): string[] =>
  result.ok ? [] : result.blockers.map((blocker) => blocker.code);

const intakeEntriesOf = async (intakeId: string): Promise<{ kind: string; payload: Record<string, unknown> }[]> => {
  const store = createIntakeJournalStore(path.join(await facade.namespaceDir(), "intake", `${intakeId}.jsonl`));
  const read = await store.read();
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("unreachable");
  return read.entries as { kind: string; payload: Record<string, unknown> }[];
};

const deliveryEntriesOf = async (deliveryId: string): Promise<{ kind: string; payload: Record<string, unknown> }[]> => {
  const store = createJournalStore(path.join(await facade.namespaceDir(), "deliveries", deliveryId, "journal.jsonl"));
  const read = await store.read();
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("unreachable");
  return read.entries as { kind: string; payload: Record<string, unknown> }[];
};

const restoreWritable = (dir: string): void => {
  try {
    execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
  } catch {
    /* removal surfaces the real failure */
  }
};

let worktreeCounter = 0;
const bindFreshWorktree = async (deliveryId: string): Promise<{ worktree: string; fence: number }> => {
  worktreeCounter += 1;
  const worktree = path.join(scratch, `wt-${worktreeCounter}`);
  git(repoDir, "worktree", "add", "--quiet", "-b", `intake-scenario-${worktreeCounter}`, worktree, "main");
  const bound = await facade.bindWorkspace({
    deliveryId,
    worktreeDir: worktree,
    hostTaskId: `host-${worktreeCounter}`,
    observedAt: NOW,
    attestationExpiry: EXPIRY,
    providerReviewBindingCapability: fixtureProviderBindingCapability(deliveryId),
  });
  expect(bound.ok, JSON.stringify(bound)).toBe(true);
  if (!bound.ok) throw new Error("unreachable");
  return { worktree, fence: bound.fence };
};

/** Fallback-lane registration: present the already-scoped contract, confirm, done. */
const registerViaFallback = async (contractId: string): Promise<string> => {
  const presented = await facade.presentContract({ contract: { ...DISPOSABLE_CONTRACT, contractId }, expiry: EXPIRY });
  expect(presented.ok, JSON.stringify(presented)).toBe(true);
  if (!presented.ok) throw new Error("unreachable");
  const confirmed = await facade.confirmContract({ intakeId: presented.intakeId, echo: operatorEcho(presented.channelPath) });
  expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
  if (!confirmed.ok) throw new Error("unreachable");
  return confirmed.deliveryId;
};

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "workflow-intake-"));

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
  installedGenerationDigest = packed.generationDigest;

  installationPath = path.join(scratch, "installation");
  receiptDir = path.join(scratch, "user-config");
  const installed = await installComposition({
    packedDir: packed.packedDir,
    installationPath,
    receiptDir,
    qualification: { disposableRepositoryIds: [DISPOSABLE_CONTRACT.repository.repositoryId] },
    assertionProvider: { sourceKind: "qualification-fixture" },
  });
  expect(installed.ok, JSON.stringify(installed)).toBe(true);

  const repo = buildDisposableRepository(path.join(scratch, "repo"));
  repoDir = repo.repoDir;

  facade = createManagedDeliveryFacade({
    repoDir,
    policyBinding: disposablePolicyBinding(),
    installation: { installationPath, receiptDir },
    hostVersion: "2.1.97",
  });
}, 120_000);

afterAll(async () => {
  restoreWritable(scratch);
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

describe("iterative intake under the read-only grant", () => {
  it("retains clarifications and the draft, presents one contract, and registers only after confirmation", { timeout: 120_000 }, async () => {
    const opened = await facade.openIntake({
      workRequest: "customers should get a friendly greeting from the module",
      observedAt: NOW,
      attestationExpiry: EXPIRY,
    });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;

    // The intake turn runs under the READ-ONLY intake grant: no writable
    // paths, and an admission that is never mutation-capable.
    const grantFile = JSON.parse(readFileSync(opened.grantPath, "utf8")) as {
      grant: { profile: string; writablePaths: string[] };
      admission: { mutationCapable: boolean };
    };
    expect(grantFile.grant.profile).toBe("intake");
    expect(grantFile.grant.writablePaths).toEqual([]);
    expect(grantFile.admission.mutationCapable).toBe(false);

    // The scope workflow iterates: two clarifications, then the drafted contract.
    const clarified1 = await facade.recordClarification({
      intakeId: opened.intakeId,
      question: "Which module should carry the greeting?",
      answer: "src/greet.mjs",
    });
    expect(clarified1.ok, JSON.stringify(clarified1)).toBe(true);
    const clarified2 = await facade.recordClarification({
      intakeId: opened.intakeId,
      question: "What is the exact contracted text?",
      answer: "hello, skeleton",
    });
    expect(clarified2.ok, JSON.stringify(clarified2)).toBe(true);

    // No confirmation exists before presentation; registration cannot happen.
    const early = await facade.confirmContract({
      intakeId: opened.intakeId,
      echo: { presentedChallenge: "x", presentedOnChannelId: "chan-x", observedAt: NOW, viaModelVisibleSurface: false, interactive: true },
    });
    expect(early.ok).toBe(false);

    const draft = { ...DISPOSABLE_CONTRACT, contractId: "contract-intake-1" };
    const drafted = await facade.recordDraft({ intakeId: opened.intakeId, draft });
    expect(drafted.ok, JSON.stringify(drafted)).toBe(true);

    const presented = await facade.presentDraft({ intakeId: opened.intakeId, expiry: EXPIRY });
    expect(presented.ok, JSON.stringify(presented)).toBe(true);
    if (!presented.ok) return;

    const confirmed = await facade.confirmContract({ intakeId: opened.intakeId, echo: operatorEcho(presented.channelPath) });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    if (!confirmed.ok) return;

    // The intake journal is the audit rail for scoping: the frozen chain,
    // the clarification history, and the draft retention record.
    const entries = await intakeEntriesOf(opened.intakeId);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "intake.state.changed", // draft_scope -> awaiting_clarification
      "intake.clarification.recorded",
      "intake.clarification.recorded",
      "intake.draft.recorded",
      "intake.state.changed", // awaiting_clarification -> awaiting_confirmation
      "operator.confirmation.recorded",
      "intake.state.changed", // awaiting_confirmation -> validating_acceptance
      "intake.state.changed", // validating_acceptance -> accepted_contract
    ]);

    // Registration landed on the facade side, referencing this intake.
    const registered = (await deliveryEntriesOf(confirmed.deliveryId)).find((entry) => entry.kind === "delivery.registered");
    expect(registered?.payload["intakeId"]).toBe(opened.intakeId);
  });

  it("voids the pending confirmation when the draft mutates after presentation", { timeout: 120_000 }, async () => {
    const opened = await facade.openIntake({ workRequest: "another scoped outcome", observedAt: NOW, attestationExpiry: EXPIRY });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    const drafted = await facade.recordDraft({
      intakeId: opened.intakeId,
      draft: { ...DISPOSABLE_CONTRACT, contractId: "contract-intake-mutate-1" },
    });
    expect(drafted.ok).toBe(true);
    const presented = await facade.presentDraft({ intakeId: opened.intakeId, expiry: EXPIRY });
    expect(presented.ok, JSON.stringify(presented)).toBe(true);
    if (!presented.ok) return;
    const staleEcho = operatorEcho(presented.channelPath);

    // The draft mutates AFTER presentation: the pending confirmation is void.
    const mutated = await facade.recordDraft({
      intakeId: opened.intakeId,
      draft: { ...DISPOSABLE_CONTRACT, contractId: "contract-intake-mutate-2" },
    });
    expect(mutated.ok, JSON.stringify(mutated)).toBe(true);

    const voided = await facade.confirmContract({ intakeId: opened.intakeId, echo: staleEcho });
    expect(voided.ok).toBe(false);
    if (!voided.ok) expect(codesOf(voided)).toContain("confirmation_void");

    // A fresh presentation over the mutated draft confirms cleanly.
    const represented = await facade.presentDraft({ intakeId: opened.intakeId, expiry: EXPIRY });
    expect(represented.ok, JSON.stringify(represented)).toBe(true);
    if (!represented.ok) return;
    const confirmed = await facade.confirmContract({ intakeId: opened.intakeId, echo: operatorEcho(represented.channelPath) });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
  });

  it("blocks a validating_acceptance preflight failure and retries WITHOUT re-confirmation", { timeout: 120_000 }, async () => {
    const opened = await facade.openIntake({ workRequest: "a third scoped outcome", observedAt: NOW, attestationExpiry: EXPIRY });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    const drafted = await facade.recordDraft({
      intakeId: opened.intakeId,
      draft: { ...DISPOSABLE_CONTRACT, contractId: "contract-intake-preflight-1" },
    });
    expect(drafted.ok).toBe(true);
    const presented = await facade.presentDraft({ intakeId: opened.intakeId, expiry: EXPIRY });
    expect(presented.ok, JSON.stringify(presented)).toBe(true);
    if (!presented.ok) return;

    // Revoke the installed generation between presentation and confirmation:
    // the confirmation itself consumes, and the acceptance preflight then
    // fails closed — the ordering the spine froze.
    const revoked = await maintainTrustState({
      installationPath,
      receiptDir,
      operation: "revoke",
      generationDigest: installedGenerationDigest,
      assertionSource: createQualificationFixtureAssertionSource(),
      now: NOW,
    });
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true);

    const blocked = await facade.confirmContract({ intakeId: opened.intakeId, echo: operatorEcho(presented.channelPath) });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(codesOf(blocked)).toContain("trust_ineligible");

    // The consumed confirmation stands; a retry over the UNCHANGED draft
    // re-runs validation without a second operator confirmation.
    const unrevoked = await maintainTrustState({
      installationPath,
      receiptDir,
      operation: "unrevoke",
      generationDigest: installedGenerationDigest,
      assertionSource: createQualificationFixtureAssertionSource(),
      now: NOW,
    });
    expect(unrevoked.ok, JSON.stringify(unrevoked)).toBe(true);

    const retried = await facade.retryAcceptance({ intakeId: opened.intakeId });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    if (!retried.ok) return;

    // Exactly ONE operator confirmation in the whole intake journal.
    const entries = await intakeEntriesOf(opened.intakeId);
    expect(entries.filter((entry) => entry.kind === "operator.confirmation.recorded")).toHaveLength(1);
  });

  it("fallback lane: already-scoped work bypasses only clarification, never validation or the confirmation", { timeout: 120_000 }, async () => {
    const presented = await facade.presentContract({
      contract: { ...DISPOSABLE_CONTRACT, contractId: "contract-fallback-lane-1" },
      expiry: EXPIRY,
    });
    expect(presented.ok, JSON.stringify(presented)).toBe(true);
    if (!presented.ok) return;

    // Contract validation is not bypassed: material ambiguity still refuses.
    const ambiguous = await facade.presentContract({
      contract: { ...DISPOSABLE_CONTRACT, contractId: "contract-fallback-ambiguous", unresolvedDecisions: ["open question"] },
      expiry: EXPIRY,
    });
    expect(codesOf(ambiguous)).toContain("contract_rejected");

    const confirmed = await facade.confirmContract({ intakeId: presented.intakeId, echo: operatorEcho(presented.channelPath) });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);

    // No product-owned intake turn ran: zero clarifications — but the draft
    // retention and the frozen chain (including validation) are all there.
    const entries = await intakeEntriesOf(presented.intakeId);
    expect(entries.filter((entry) => entry.kind === "intake.clarification.recorded")).toHaveLength(0);
    expect(entries.filter((entry) => entry.kind === "intake.draft.recorded")).toHaveLength(1);
    const states = entries.filter((entry) => entry.kind === "intake.state.changed").map((entry) => entry.payload["to"]);
    expect(states).toEqual(["awaiting_clarification", "awaiting_confirmation", "validating_acceptance", "accepted_contract"]);
  });
});

describe("the typed checkpoint reducer", () => {
  let deliveryId: string;
  let worktree: string;
  let fence: number;

  it("refuses prose and admits only typed results validated against the pinned graph", { timeout: 240_000 }, async () => {
    deliveryId = await registerViaFallback("contract-typed-checkpoints-1");
    ({ worktree, fence } = await bindFreshWorktree(deliveryId));

    // Plan precedes mutation: nothing can checkpoint a candidate in planning.
    const premature = await facade.checkpointCandidate({
      deliveryId,
      resultBytes: typedStageResultBytes({ stageId: "implement", deliveryId, outputKind: "delivery-candidate", candidate: treeOf(worktree) }),
      fence,
    });
    expect(codesOf(premature)).toContain("wrong_state");

    // Prose cannot advance the reducer — skill text guides, results advance.
    const prose = await facade.submitStageResult({ deliveryId, stageId: "plan", resultBytes: "bounded plan: add src/greet.mjs", fence });
    expect(codesOf(prose)).toContain("stage_result_rejected");

    // A typed result bound to the wrong candidate is refused: the harness
    // supplies the trusted reference; a result cannot nominate its own.
    const wrongCandidate = await facade.submitStageResult({
      deliveryId,
      stageId: "plan",
      resultBytes: typedStageResultBytes({ stageId: "plan", deliveryId, outputKind: "bounded-plan", candidate: "not-the-tree" }),
      fence,
    });
    expect(codesOf(wrongCandidate)).toContain("stage_result_rejected");

    const planned = await facade.submitStageResult({
      deliveryId,
      stageId: "plan",
      resultBytes: typedStageResultBytes({ stageId: "plan", deliveryId, outputKind: "bounded-plan", candidate: treeOf(worktree) }),
      fence,
    });
    expect(planned.ok && planned.state === "implementing", JSON.stringify(planned)).toBe(true);

    // Implement: the produced candidate must be the independently captured tree.
    writeFileSync(path.join(worktree, "src", "greet.mjs"), GREET_RIGHT);
    commitAll(worktree, "implement the greeting");
    const selfClaimed = await facade.checkpointCandidate({
      deliveryId,
      resultBytes: typedStageResultBytes({ stageId: "implement", deliveryId, outputKind: "delivery-candidate", candidate: "tree-of-my-choosing" }),
      fence,
    });
    expect(codesOf(selfClaimed)).toContain("stage_result_rejected");

    const checkpointed = await facade.checkpointCandidate({
      deliveryId,
      resultBytes: typedStageResultBytes({ stageId: "implement", deliveryId, outputKind: "delivery-candidate", candidate: treeOf(worktree) }),
      fence,
    });
    expect(checkpointed.ok && checkpointed.state === "validating", JSON.stringify(checkpointed)).toBe(true);

    const sensed = await facade.runSensor({ deliveryId, fence });
    expect(sensed.ok, JSON.stringify(sensed)).toBe(true);
    if (!sensed.ok) return;
    expect(sensed.state).toBe("reviewing");

    const submitted = await ingestFixtureProviderReview({ facade, deliveryId, fence, runId: "run-typed-checkpoint" });
    expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
    const reduced = await facade.reduceReview({ deliveryId, fence });
    expect(reduced.ok, JSON.stringify(reduced)).toBe(true);
    if (!reduced.ok) return;
    expect(reduced.state).toBe("compounding");

    // The explicit no-compound outcome is a first-class typed result.
    const compounded = await facade.submitStageResult({
      deliveryId,
      stageId: "compound",
      resultBytes: typedStageResultBytes({ stageId: "compound", deliveryId, outputKind: "no-reusable-learning", candidate: treeOf(worktree) }),
      fence,
    });
    expect(compounded.ok && compounded.state === "admitting", JSON.stringify(compounded)).toBe(true);

    // The journal carries digest-bound typed results for every workflow
    // stage — plan, implement, review acquisition AND reduction, compound —
    // and each digest resolves to a persisted typed document.
    const entries = await deliveryEntriesOf(deliveryId);
    const stageResults = entries.filter((entry) => entry.kind === "stage.result.recorded");
    const stages = stageResults.map((entry) => entry.payload["stageId"]);
    for (const expected of ["plan", "implement", "review.acquire", "review.reduce", "compound"]) {
      expect(stages, expected).toContain(expected);
    }
    const namespace = await facade.namespaceDir();
    for (const entry of stageResults) {
      const persisted = path.join(namespace, "deliveries", deliveryId, "results", `${entry.payload["resultDigest"] as string}.json`);
      expect(existsSync(persisted), persisted).toBe(true);
      const parsed = JSON.parse(readFileSync(persisted, "utf8")) as { schemaVersion: string; status: string };
      expect(parsed.schemaVersion).toBe("workflow-stage-result/1");
      expect(parsed.status).toBe("succeeded");
    }
    const compoundEntry = stageResults.find((entry) => entry.payload["stageId"] === "compound");
    const compoundPersisted = JSON.parse(
      readFileSync(path.join(namespace, "deliveries", deliveryId, "results", `${compoundEntry?.payload["resultDigest"] as string}.json`), "utf8"),
    ) as { output: { kind: string } };
    expect(compoundPersisted.output.kind).toBe("no-reusable-learning");
  });

  it("repeats review until lenses approve or the bounded-loop blocker records", { timeout: 300_000 }, async () => {
    const loopDeliveryId = await registerViaFallback("contract-bounded-loop-1");
    const bound = await bindFreshWorktree(loopDeliveryId);

    const plan = await facade.submitStageResult({
      deliveryId: loopDeliveryId,
      stageId: "plan",
      resultBytes: typedStageResultBytes({ stageId: "plan", deliveryId: loopDeliveryId, outputKind: "bounded-plan", candidate: treeOf(bound.worktree) }),
      fence: bound.fence,
    });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);

    const implementAndValidate = async (marker: string): Promise<void> => {
      writeFileSync(path.join(bound.worktree, "src", "greet.mjs"), `// ${marker}\n${GREET_RIGHT}`);
      commitAll(bound.worktree, marker);
      const checkpointed = await facade.checkpointCandidate({
        deliveryId: loopDeliveryId,
        resultBytes: typedStageResultBytes({
          stageId: "implement",
          deliveryId: loopDeliveryId,
          outputKind: "delivery-candidate",
          candidate: treeOf(bound.worktree),
        }),
        fence: bound.fence,
      });
      expect(checkpointed.ok, JSON.stringify(checkpointed)).toBe(true);
      const sensed = await facade.runSensor({ deliveryId: loopDeliveryId, fence: bound.fence });
      expect(sensed.ok, JSON.stringify(sensed)).toBe(true);
      if (sensed.ok) expect(sensed.state).toBe("reviewing");
    };

    const reviewRound = async (round: number): Promise<{ ok: boolean; state?: string; codes: string[] }> => {
      const submitted = await ingestFixtureProviderReview({
        facade,
        deliveryId: loopDeliveryId,
        fence: bound.fence,
        runId: `run-loop-${round}`,
        verdict: "changes_requested",
      });
      expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
      const reduced = await facade.reduceReview({ deliveryId: loopDeliveryId, fence: bound.fence });
      return reduced.ok ? { ok: true, state: reduced.state, codes: [] } : { ok: false, codes: codesOf(reduced) };
    };

    await implementAndValidate("bounded-loop implementation");
    // Three findings rounds route to remediation — the loop is live but bounded.
    for (let round = 1; round <= 3; round += 1) {
      const outcome = await reviewRound(round);
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(outcome.state).toBe("remediating");
      await implementAndValidate(`bounded-loop remediation ${round}`);
    }
    // The fourth findings round records the bounded blocker instead of spinning.
    const fourth = await reviewRound(4);
    expect(fourth.ok, JSON.stringify(fourth)).toBe(true);
    expect(fourth.state).toBe("blocked");

    const entries = await deliveryEntriesOf(loopDeliveryId);
    const blocker = entries.filter((entry) => entry.kind === "blocker.recorded").at(-1);
    expect(blocker?.payload["code"]).toBe("review.loop-bound-reached");
  });

  it("counts a round whose persisted result was deleted — the journal, not the persistence, bounds the loop", { timeout: 300_000 }, async () => {
    // The bound must not be resettable by removing persisted documents: the
    // journal records THAT a round happened, so an unresolvable record counts.
    const deletedDeliveryId = await registerViaFallback("contract-bounded-loop-deleted-1");
    const bound = await bindFreshWorktree(deletedDeliveryId);
    const planned = await facade.submitStageResult({
      deliveryId: deletedDeliveryId,
      stageId: "plan",
      resultBytes: typedStageResultBytes({
        stageId: "plan",
        deliveryId: deletedDeliveryId,
        outputKind: "bounded-plan",
        candidate: treeOf(bound.worktree),
      }),
      fence: bound.fence,
    });
    expect(planned.ok, JSON.stringify(planned)).toBe(true);

    const namespace = await facade.namespaceDir();
    const runRound = async (round: number): Promise<string | undefined> => {
      writeFileSync(path.join(bound.worktree, "src", "greet.mjs"), `// deleted-persistence round ${round}\n${GREET_RIGHT}`);
      commitAll(bound.worktree, `deleted-persistence round ${round}`);
      const checkpointed = await facade.checkpointCandidate({
        deliveryId: deletedDeliveryId,
        resultBytes: typedStageResultBytes({
          stageId: "implement",
          deliveryId: deletedDeliveryId,
          outputKind: "delivery-candidate",
          candidate: treeOf(bound.worktree),
        }),
        fence: bound.fence,
      });
      expect(checkpointed.ok, JSON.stringify(checkpointed)).toBe(true);
      const sensed = await facade.runSensor({ deliveryId: deletedDeliveryId, fence: bound.fence });
      expect(sensed.ok, JSON.stringify(sensed)).toBe(true);
      const submitted = await ingestFixtureProviderReview({
        facade,
        deliveryId: deletedDeliveryId,
        fence: bound.fence,
        runId: `run-deleted-${round}`,
        verdict: "changes_requested",
      });
      expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
      const reduced = await facade.reduceReview({ deliveryId: deletedDeliveryId, fence: bound.fence });
      expect(reduced.ok, JSON.stringify(reduced)).toBe(true);
      return reduced.ok ? reduced.state : undefined;
    };

    for (let round = 1; round <= 3; round += 1) {
      expect(await runRound(round), `round ${round}`).toBe("remediating");
      // Delete every persisted review.reduce document before the next round.
      for (const entry of await deliveryEntriesOf(deletedDeliveryId)) {
        if (entry.kind !== "stage.result.recorded" || entry.payload["stageId"] !== "review.reduce") continue;
        rmSync(path.join(namespace, "deliveries", deletedDeliveryId, "results", `${entry.payload["resultDigest"] as string}.json`), {
          force: true,
        });
      }
    }
    // The bound still bites: the journal entries were never removable.
    expect(await runRound(4)).toBe("blocked");
    const blocker = (await deliveryEntriesOf(deletedDeliveryId)).filter((entry) => entry.kind === "blocker.recorded").at(-1);
    expect(blocker?.payload["code"]).toBe("review.loop-bound-reached");
  });
});
