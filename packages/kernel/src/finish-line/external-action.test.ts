/**
 * SEPARATELY AUTHORIZED MERGE AND DEPLOYMENT ACTIONS.
 *
 * Six sensor families, each falsifiable on its own:
 *
 *   - the EXTERNAL-OPERATION AUTHORITY MATRIX: grant, request, finish line and
 *     adapter, each refusing on its own;
 *   - APPROVAL BINDING: an approval is usable for exactly one delivery, one
 *     action, one candidate, one policy, one fence, one pair of epochs and one
 *     nonce, and never for the identity that is acting;
 *   - the FAKE ADAPTER AT EVERY INDETERMINATE BOUNDARY: thrown, refused,
 *     referenceless, and reconciled-after-loss;
 *   - RECONCILE BEFORE RETRY: all three findings forbid a second call, and
 *     offering the indeterminate intent's own id keeps its sharper refusal;
 *   - the POST-ACTION CLASSIFICATION, including the success-with-failed-
 *     verification state whose only exits are policy-selected;
 *   - DEPLOYMENT's additional preconditions: a reconciled merge, a clean
 *     merged main, provenance over the same artifact, and a preflight that ran.
 */
import { describe, expect, it, vi } from "vitest";
import { digestCanonical } from "../digest.ts";
import { checkActionAuthorization } from "../policy/authority.ts";
import type { AcceptedContract } from "../spine/contract.ts";
import { ABSENT_BY_STATE } from "../spine/grammar.ts";
import { validateSensitiveApprovalAssertion } from "../spine/assertion.ts";
import { WAIVER_APPROVAL_ORIGIN_PREFIX } from "../evidence/waiver.ts";
import type { PolicySnapshot } from "../spine/policy.ts";
import type { ExternalActionPort } from "./merge-ready.ts";
import { UNBOUND_EXTERNAL_ACTION_PORT } from "./merge-ready.ts";
import {
  ACTION_APPROVAL_ORIGIN_PREFIX,
  EXTERNAL_ACTION_RESULT_SPEC,
  actionChainDigest,
  checkDeployPreconditions,
  classifyActionOutcome,
  evaluateActionApproval,
  invokeExternalActionOnce,
  journalIntentPayload,
  journalResultPayload,
  planExternalAction,
  reconcileBeforeRetry,
  revalidateBeforeInvoke,
  validateExternalActionResult,
  type BoundActionIntent,
  type InvocationOutcome,
  type ObservedActionResult,
  type PlanExternalActionInput,
  type RevalidationObservation,
} from "./external-action.ts";

const TREE = "1".repeat(40);
const BASE = "3".repeat(40);
const DELIVERABLE = "f".repeat(64);
const RECORD_DIGEST = "e".repeat(64);
const NOW = "2026-01-01T00:00:00Z";
const LATER = "2026-06-01T00:00:00Z";

const codesOf = (value: unknown): string[] => {
  const refusals = (value as { refusals?: readonly { code: string }[] }).refusals;
  return (refusals ?? []).map((entry) => entry.code);
};

const contractOf = (over: Partial<AcceptedContract> = {}): AcceptedContract => ({
  spec: "scoped-delivery-contract/1",
  contractId: "contract-1",
  task: "ship it",
  intendedOutcome: "it is shipped",
  acceptanceCriteria: [{ criterionId: "c1", statement: "it works" }],
  nonGoals: [],
  repository: { repositoryId: "repo-1", baseRef: "refs/heads/main" },
  requestedFinishLine: "merge",
  requestedAuthority: ["merge"],
  unresolvedDecisions: [],
  ...over,
});

const policyOf = (over: Partial<PolicySnapshot> = {}): PolicySnapshot => {
  const body = {
    spec: "policy-snapshot/1" as const,
    repositoryId: "repo-1",
    productTrustRevocationEpoch: 4,
    repositoryAuthorityRevocationEpoch: 7,
    grantedFinishLines: ["merge-ready", "merge"],
    grantedAuthority: ["merge"],
    reviewLenses: [
      {
        lensId: "lens.outcome-correctness",
        category: "outcome-correctness",
        personaId: "persona.outcome-correctness",
        personaDigest: "b".repeat(64),
      },
    ],
    obligations: [{ obligationId: "review-green" }],
    ...over,
  };
  return { ...body, policyDigest: digestCanonical(body) } as PolicySnapshot;
};

const approvalOf = (policy: PolicySnapshot, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  spec: "sensitive-approval-assertion/1",
  assertionClass: "delivery-bound",
  origin: `${ACTION_APPROVAL_ORIGIN_PREFIX}release-manager`,
  action: "merge",
  expiry: LATER,
  nonce: "nonce-1",
  assertionSource: "host-native",
  productTrustRevocationEpoch: policy.productTrustRevocationEpoch,
  repositoryAuthorityRevocationEpoch: policy.repositoryAuthorityRevocationEpoch,
  deliveryId: "delivery-1",
  candidateTreeSha: TREE,
  policyDigest: policy.policyDigest,
  invocationFence: 9,
  targetInstallationId: ABSENT_BY_STATE,
  targetGenerationDigest: ABSENT_BY_STATE,
  targetHighWaterMark: ABSENT_BY_STATE,
  expectedJournalRevision: ABSENT_BY_STATE,
  ...over,
});

const planOf = (over: Partial<PlanExternalActionInput> = {}): PlanExternalActionInput => {
  const policy = over.policy ?? policyOf();
  return {
    deliveryId: "delivery-1",
    intentId: "intent-1",
    action: "merge",
    contract: contractOf(),
    policy,
    actingActorId: "agent-task-1",
    invocationFence: 9,
    candidate: { treeSha: TREE, deliverableDigest: DELIVERABLE },
    baseTipSha: BASE,
    record: { treeSha: TREE, baseTipSha: BASE, digest: RECORD_DIGEST },
    adapter: { capabilityId: "merge.github", kind: "merge", hasCredential: true },
    evidence: { externalVerification: "passed", completedObligations: ["review-green"] },
    chain: [],
    consumedNonces: new Set<string>(),
    currentProfile: "production",
    now: NOW,
    ...over,
  };
};

const boundIntent = (): BoundActionIntent => {
  const planned = planExternalAction(planOf());
  if (!planned.ok) throw new Error(`the fixture plan must succeed: ${codesOf(planned).join(", ")}`);
  return planned.intent;
};

const observationOf = (intent: BoundActionIntent, over: Partial<RevalidationObservation> = {}): RevalidationObservation => ({
  invocationFence: intent.invocationFence,
  productTrustRevocationEpoch: intent.productTrustRevocationEpoch,
  candidateTreeSha: intent.candidate.treeSha,
  baseTipSha: intent.baseTipSha,
  externalVerification: "passed",
  recheckAuthority: () =>
    checkActionAuthorization({
      action: intent.action,
      bound: { grantedFinishLines: [], grantedAuthority: ["merge", "deploy"] },
      revocation: {
        spec: "authority-revocation/1",
        epoch: intent.repositoryAuthorityRevocationEpoch,
        revokedAuthority: [],
        revokedFinishLines: [],
      },
      highestObservedEpoch: intent.repositoryAuthorityRevocationEpoch,
    }),
  ...over,
});

/** The same recheck the facade would run, over a store the caller supplies. */
const recheckWith = (intent: BoundActionIntent, revocation: Record<string, unknown>, floor?: number) => () =>
  checkActionAuthorization({
    action: intent.action,
    bound: { grantedFinishLines: [], grantedAuthority: ["merge"] },
    revocation,
    highestObservedEpoch: floor ?? intent.repositoryAuthorityRevocationEpoch,
  });

/** The deploy fixture: a deploy contract, a deploy grant, a deploy adapter. */
const deployPolicy = (over: Partial<PolicySnapshot> = {}): PolicySnapshot =>
  policyOf({ grantedFinishLines: ["merge-ready", "merge", "deploy"], grantedAuthority: ["merge", "deploy"], ...over });

const deployChain = [
  { intentId: "intent-1", action: "merge" as const, outcome: "succeeded" as const, verification: "passed" as const },
];

const deployPlanOf = (over: Partial<PlanExternalActionInput> = {}): PlanExternalActionInput =>
  planOf({
    intentId: "intent-2",
    action: "deploy",
    contract: contractOf({ requestedFinishLine: "deploy", requestedAuthority: ["merge", "deploy"] }),
    policy: deployPolicy(),
    adapter: { capabilityId: "deploy.fly", kind: "deploy", hasCredential: true },
    chain: deployChain,
    ...over,
  });

const deployIntent = (): BoundActionIntent => {
  const planned = planExternalAction(deployPlanOf());
  if (!planned.ok) throw new Error(`the deploy fixture must plan: ${codesOf(planned).join(", ")}`);
  return planned.intent;
};

/** Unwraps an invocation this unit actually made; a refusal is never a result. */
const observedResult = (outcome: InvocationOutcome): ObservedActionResult => {
  if (outcome.kind !== "observed") {
    throw new Error(`expected an observation, got refusals: ${codesOf(outcome).join(", ")}`);
  }
  return outcome.result;
};

/** The fake adapter. Its every mode is a boundary this unit has to survive. */
const fakePort = (mode: "ok" | "refuse" | "throw" | "no-reference"): ExternalActionPort => ({
  invoke: async () => {
    if (mode === "throw") throw new Error("connection reset after the request left");
    if (mode === "refuse") return { ok: false, refusals: [{ code: "adapter_refused", pointer: "/action", message: "no" }] };
    return { ok: true, externalReference: mode === "no-reference" ? "" : "https://example.test/pull/7" };
  },
});

describe("the external-operation authority matrix", () => {
  it("refuses a merge-ready contract even when policy grants merge", () => {
    const planned = planExternalAction(
      planOf({ contract: contractOf({ requestedFinishLine: "merge-ready", requestedAuthority: ["merge"] }) }),
    );
    expect(planned.ok).toBe(false);
    expect(codesOf(planned)).toContain("forbidden_action");
  });

  it("refuses a merge the policy does not grant, however the contract asks", () => {
    const planned = planExternalAction(
      planOf({ policy: policyOf({ grantedFinishLines: ["merge-ready"], grantedAuthority: [] }) }),
    );
    expect(planned.ok).toBe(false);
    expect(codesOf(planned).length).toBeGreaterThan(0);
  });

  it("refuses a deploy on a merge contract, so a wider grant never reaches the further finish line", () => {
    const planned = planExternalAction(
      planOf({
        action: "deploy",
        policy: policyOf({ grantedFinishLines: ["merge-ready", "merge", "deploy"], grantedAuthority: ["merge", "deploy"] }),
        adapter: { capabilityId: "deploy.fly", kind: "deploy", hasCredential: true },
      }),
    );
    expect(planned.ok).toBe(false);
    expect(codesOf(planned)).toContain("action_finish_line_mismatch");
  });

  it("plans the merge a deploy contract has to take first, so the deploy preconditions are satisfiable", () => {
    // A deploy contract REACHES the merge it deploys: `checkDeployPreconditions`
    // refuses a deploy that does not follow a succeeded, verified merge, so a
    // finish-line check that demanded equality would make the merge unplannable
    // and every deploy permanently blocked on a merge nothing could take.
    const deployPolicy = policyOf({
      grantedFinishLines: ["merge-ready", "merge", "deploy"],
      grantedAuthority: ["merge", "deploy"],
    });
    const deployContract = contractOf({ requestedFinishLine: "deploy", requestedAuthority: ["merge", "deploy"] });
    const merge = planExternalAction(planOf({ contract: deployContract, policy: deployPolicy }));
    expect(merge.ok).toBe(true);
    expect(merge.ok === true && merge.intent.action).toBe("merge");
    expect(merge.ok === true && merge.intent.requestedFinishLine).toBe("deploy");

    const deploy = planExternalAction(
      planOf({
        action: "deploy",
        contract: deployContract,
        policy: deployPolicy,
        adapter: { capabilityId: "deploy.fly", kind: "deploy", hasCredential: true },
        chain: [{ intentId: "intent-1", action: "merge", outcome: "succeeded", verification: "passed" }],
      }),
    );
    expect(deploy.ok).toBe(true);

    // A merge-ready contract still reaches no action at all.
    expect(
      codesOf(planExternalAction(planOf({ contract: contractOf({ requestedFinishLine: "merge-ready", requestedAuthority: ["merge"] }) }))),
    ).toContain("action_finish_line_mismatch");
  });

  it("refuses an adapter bound for another kind, and one that binds no credential", () => {
    expect(
      codesOf(planExternalAction(planOf({ adapter: { capabilityId: "deploy.fly", kind: "deploy", hasCredential: true } }))),
    ).toContain("adapter_contract_mismatch");
    expect(
      codesOf(planExternalAction(planOf({ adapter: { capabilityId: "merge.github", kind: "merge", hasCredential: false } }))),
    ).toContain("adapter_credential_absent");
  });

  it("refuses when the hosted check or the local obligations no longer stand", () => {
    expect(
      codesOf(planExternalAction(planOf({ evidence: { externalVerification: "failed", completedObligations: ["review-green"] } }))),
    ).toContain("external_verification_missing");
    // `unavailable` is the third member of the union and refuses the same way:
    // a hosted check that never resolved is not a hosted check that passed.
    expect(
      codesOf(
        planExternalAction(planOf({ evidence: { externalVerification: "unavailable", completedObligations: ["review-green"] } })),
      ),
    ).toContain("external_verification_missing");
    expect(
      codesOf(planExternalAction(planOf({ evidence: { externalVerification: "passed", completedObligations: [] } }))),
    ).toContain("obligation_unsatisfied");
    // Not merely a non-empty set: EVERY obligation the current policy carries.
    // A policy recompiled between merge-readiness and the action can add one,
    // and the completed set that satisfied the old policy does not satisfy it.
    const widened = policyOf({ obligations: [{ obligationId: "review-green" }, { obligationId: "security-scan" }] });
    const refused = planExternalAction(
      planOf({ policy: widened, evidence: { externalVerification: "passed", completedObligations: ["review-green"] } }),
    );
    expect(codesOf(refused)).toContain("obligation_unsatisfied");
    expect(
      planExternalAction(
        planOf({
          policy: widened,
          evidence: { externalVerification: "passed", completedObligations: ["review-green", "security-scan"] },
        }),
      ).ok,
    ).toBe(true);
  });

  it("binds a deploy as a deploy, all the way through the adapter call and both journal payloads", () => {
    // Every other row in this file runs over the merge fixture, so `action`
    // and everything derived from it could be replaced by the literal "merge"
    // throughout the unit and stay green — the irreversible call and the
    // record that it was about to happen would both name the wrong action.
    expect(deployIntent()).toEqual({
      intentId: "intent-2",
      deliveryId: "delivery-1",
      action: "deploy",
      actingActorId: "agent-task-1",
      approval: "not-required",
      candidate: { treeSha: TREE, deliverableDigest: DELIVERABLE },
      baseTipSha: BASE,
      policyDigest: deployPolicy().policyDigest,
      invocationFence: 9,
      productTrustRevocationEpoch: 4,
      repositoryAuthorityRevocationEpoch: 7,
      requestedFinishLine: "deploy",
      adapterCapabilityId: "deploy.fly",
      actionChainDigest: actionChainDigest(deployChain, "deploy"),
      evidence: { externalVerification: "passed", completedObligations: ["review-green"] },
      trackedRecordDigest: RECORD_DIGEST,
    });
    // The chain digest is the deploy's, not the merge's over the same history.
    expect(deployIntent().actionChainDigest).not.toBe(actionChainDigest(deployChain, "merge"));
  });

  it("hands the adapter and the journal the deploy that was authorized", async () => {
    const intent = deployIntent();
    const port = { invoke: vi.fn(fakePort("ok").invoke) };
    const result = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
      verify: async () => true,
    });
    expect(port.invoke.mock.calls[0]?.[0]).toEqual({
      intentId: "intent-2",
      action: "deploy",
      candidate: { treeSha: TREE, deliverableDigest: DELIVERABLE },
      policyDigest: deployPolicy().policyDigest,
      approval: "not-required",
    });
    expect(journalResultPayload(observedResult(result))).toEqual({
      intentId: "intent-2",
      action: "deploy",
      outcome: "succeeded",
      verification: "passed",
      externalReference: "https://example.test/pull/7",
    });
    // And every refusal path keeps the deploy too.
    const lost = await invokeExternalActionOnce({
      intent,
      port: fakePort("throw"),
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
    });
    expect(observedResult(lost)).toMatchObject({ intentId: "intent-2", action: "deploy", outcome: "indeterminate" });
  });

  it("reads the approval requirement per action, so a deploy-only requirement is not a merge's", () => {
    const policy = deployPolicy();
    // Policy requires an approval for the DEPLOY alone.
    const unapproved = planExternalAction(deployPlanOf({ policy, approvalRequiredActions: ["deploy"] }));
    expect(codesOf(unapproved)).toContain("approval_absent");

    const approved = planExternalAction(
      deployPlanOf({
        policy,
        approvalRequiredActions: ["deploy"],
        approval: approvalOf(policy, { action: "deploy", candidateTreeSha: TREE }),
        approvedChainDigest: actionChainDigest(deployChain, "deploy"),
      }),
    );
    expect(approved.ok).toBe(true);
    expect(approved.ok === true && approved.intent.approval).toBe("required");
    expect(approved.ok === true && approved.intent.approverId).toBe("release-manager");
    // The JOURNALED payload, not just the in-memory intent. `approval` was
    // pinned on the payload only for "not-required", so the derivation was
    // proven on one value of a two-value member: a payload hardcoding
    // "not-required" passed every row. The entry written before the
    // irreversible call is the only record that a non-model-mintable approval
    // was consumed, so it must say so. `toEqual` and not a member read, so the
    // closed `action.intent.recorded` grammar also stays proven here: adding
    // `approverId` would make the entry unwritable.
    expect(approved.ok === true && journalIntentPayload(approved.intent)).toEqual({
      intentId: "intent-2",
      action: "deploy",
      candidate: { treeSha: TREE, deliverableDigest: DELIVERABLE },
      policyDigest: policy.policyDigest,
      approval: "required",
    });

    // The merge under that same policy requires none, and presenting one is
    // the disagreement `approval_unexpected` names.
    const merge = planExternalAction(
      planOf({
        policy,
        contract: contractOf({ requestedFinishLine: "deploy", requestedAuthority: ["merge", "deploy"] }),
        approvalRequiredActions: ["deploy"],
      }),
    );
    expect(merge.ok).toBe(true);
    expect(merge.ok === true && merge.intent.approval).toBe("not-required");

    // And an approval shown for the merge never authorizes the deploy.
    expect(
      codesOf(
        planExternalAction(
          deployPlanOf({
            policy,
            approvalRequiredActions: ["deploy"],
            approval: approvalOf(policy, { action: "merge" }),
            approvedChainDigest: actionChainDigest(deployChain, "deploy"),
          }),
        ),
      ),
    ).toContain("approval_mismatch");
  });

  it("refuses an action on a policy that carries no obligation at all, so absence never passes", () => {
    // The anti-vacuity half of the check, which the per-obligation loop cannot
    // stand in for: a repository whose compiled policy activates no obligation
    // would otherwise take an irreversible merge on an empty evidence set.
    expect(
      codesOf(
        planExternalAction(
          planOf({
            policy: policyOf({ obligations: [] }),
            evidence: { externalVerification: "passed", completedObligations: [] },
          }),
        ),
      ),
    ).toContain("obligation_unsatisfied");
  });

  it("binds every value the ticket names, asserted against a literal rather than against itself", () => {
    // The whole intent at once, member by member, against values written out
    // here. Asserting single members leaves the rest free, and the revalidation
    // fixture is built FROM the intent, so a mis-bound fence or epoch would
    // revalidate against its own mirror and then take an irreversible action.
    const policy = policyOf();
    expect(boundIntent()).toEqual({
      intentId: "intent-1",
      deliveryId: "delivery-1",
      action: "merge",
      actingActorId: "agent-task-1",
      approval: "not-required",
      candidate: { treeSha: TREE, deliverableDigest: DELIVERABLE },
      baseTipSha: BASE,
      policyDigest: policy.policyDigest,
      invocationFence: 9,
      productTrustRevocationEpoch: 4,
      repositoryAuthorityRevocationEpoch: 7,
      requestedFinishLine: "merge",
      adapterCapabilityId: "merge.github",
      actionChainDigest: actionChainDigest([], "merge"),
      evidence: { externalVerification: "passed", completedObligations: ["review-green"] },
      trackedRecordDigest: RECORD_DIGEST,
    });
    // The two epochs are distinct values, so an intent that carried one twice
    // could not tell a product-trust revocation from an authority revocation.
    expect(policy.productTrustRevocationEpoch).not.toBe(policy.repositoryAuthorityRevocationEpoch);
    // And the approved intent names its approver, distinct from the actor.
    const approved = planExternalAction(
      planOf({
        policy,
        approvalRequiredActions: ["merge"],
        approval: approvalOf(policy),
        approvedChainDigest: actionChainDigest([], "merge"),
      }),
    );
    expect(approved.ok === true && approved.intent.approverId).toBe("release-manager");
    expect(approved.ok === true && approved.intent.approval).toBe("required");
  });

  it("refuses when the candidate or the base moved away from the tracked record", () => {
    expect(codesOf(planExternalAction(planOf({ candidate: { treeSha: "9".repeat(40), deliverableDigest: DELIVERABLE } })))).toContain(
      "candidate_moved",
    );
    expect(codesOf(planExternalAction(planOf({ baseTipSha: "9".repeat(40) })))).toContain("base_moved");
    // Both sides of each exact-equality compare: a tree that sorts below the
    // recorded one moved just as far as one that sorts above it.
    expect(codesOf(planExternalAction(planOf({ candidate: { treeSha: "0".repeat(40), deliverableDigest: DELIVERABLE } })))).toContain(
      "candidate_moved",
    );
    expect(codesOf(planExternalAction(planOf({ baseTipSha: "0".repeat(40) })))).toContain("base_moved");
  });

  it("carries no credential material into the intent it builds", () => {
    const intent = boundIntent();
    // The adapter is named, never quoted: the acting task holds no credential,
    // and nothing in the journaled payload could carry one.
    expect(intent.adapterCapabilityId).toBe("merge.github");
    expect(JSON.stringify(intent)).not.toContain("credential");
    // By value, not by key set: a payload carrying the record digest where the
    // policy digest belongs has the right shape and the wrong content, and the
    // adapter is handed this same object.
    expect(journalIntentPayload(intent)).toEqual({
      intentId: "intent-1",
      action: "merge",
      candidate: { treeSha: TREE, deliverableDigest: DELIVERABLE },
      policyDigest: policyOf().policyDigest,
      approval: "not-required",
    });
  });
});

describe("approval binding", () => {
  const withApproval = (over: Record<string, unknown> = {}, plan: Partial<PlanExternalActionInput> = {}) => {
    const policy = plan.policy ?? policyOf();
    const chain = plan.chain ?? [];
    return planExternalAction(
      planOf({
        policy,
        approvalRequiredActions: ["merge"],
        approval: approvalOf(policy, over),
        approvedChainDigest: actionChainDigest(chain, plan.action ?? "merge"),
        ...plan,
      }),
    );
  };

  it("accepts an approval bound to this delivery, action, candidate, policy, fence and epochs", () => {
    const planned = withApproval();
    expect(planned.ok).toBe(true);
    expect(planned.ok === true && planned.intent.approval).toBe("required");
    expect(planned.ok === true && planned.intent.approverId).toBe("release-manager");
  });

  it("records approval: not-required when policy required none, rather than claiming a human approved", () => {
    const intent = boundIntent();
    expect(intent.approval).toBe("not-required");
    expect(intent.approverId).toBeUndefined();
    // The journaled payload is the audit rail's statement of this fact.
    expect(journalIntentPayload(intent).approval).toBe("not-required");
  });

  it("refuses an approval shown for a different action chain than the one that reached this action", () => {
    // The approval was minted while the chain was empty; the action is now
    // taken after an attempt that failed for a reason nobody has looked at.
    const refused = withApproval({}, {
      chain: [{ intentId: "intent-0", action: "merge", outcome: "failed", verification: "not-attempted" }],
      approvedChainDigest: actionChainDigest([], "merge"),
    });
    expect(refused.ok).toBe(false);
    expect(codesOf(refused)).toContain("approval_mismatch");
    // The same chain on both sides accepts.
    expect(
      withApproval({}, {
        chain: [{ intentId: "intent-0", action: "merge", outcome: "failed", verification: "not-attempted" }],
      }).ok,
    ).toBe(true);
    // An approval presented with no recorded chain digest at all refuses.
    const policy = policyOf();
    expect(
      codesOf(planExternalAction(planOf({ policy, approvalRequiredActions: ["merge"], approval: approvalOf(policy) }))),
    ).toContain("approval_mismatch");
  });

  it("refuses an absent approval where policy requires one", () => {
    const planned = planExternalAction(planOf({ approvalRequiredActions: ["merge"] }));
    expect(codesOf(planned)).toContain("approval_absent");
  });

  it("refuses an approval nobody required, because the caller and the policy then disagree", () => {
    const policy = policyOf();
    expect(codesOf(planExternalAction(planOf({ policy, approval: approvalOf(policy) })))).toContain("approval_unexpected");
  });

  it("refuses reuse after any single binding changes", () => {
    // One row per binding the acceptance criterion names. Each changes exactly
    // one value, so no row can pass for another row's reason.
    expect(codesOf(withApproval({ candidateTreeSha: "9".repeat(40) }))).toContain("approval_mismatch");
    expect(codesOf(withApproval({ policyDigest: "a".repeat(64) }))).toContain("approval_mismatch");
    // Every binding below is an EXACT-equality rule, and every probe above sits
    // on one side of the bound value. Shas and digests are uniform hex and
    // epochs are ordinals, so a `>` or `<` mutant would let roughly half of all
    // real divergences through unseen. Each rule therefore gets a probe on the
    // other side as well.
    expect(codesOf(withApproval({ candidateTreeSha: "0".repeat(40) }))).toContain("approval_mismatch");
    expect(codesOf(withApproval({ policyDigest: "0".repeat(64) }))).toContain("approval_mismatch");
    expect(codesOf(withApproval({ policyDigest: "f".repeat(64) }))).toContain("approval_mismatch");
    expect(codesOf(withApproval({ deliveryId: "delivery-0" }))).toContain("approval_mismatch");
    expect(codesOf(withApproval({ productTrustRevocationEpoch: 5 }))).toContain("approval_stale");
    expect(codesOf(withApproval({ repositoryAuthorityRevocationEpoch: 8 }))).toContain("approval_stale");
    expect(codesOf(withApproval({ invocationFence: 8 }))).toContain("approval_mismatch");
    expect(codesOf(withApproval({ invocationFence: 10 }))).toContain("approval_mismatch");
    expect(codesOf(withApproval({ deliveryId: "delivery-2" }))).toContain("approval_mismatch");
    expect(codesOf(withApproval({ productTrustRevocationEpoch: 3 }))).toContain("approval_stale");
    expect(codesOf(withApproval({ repositoryAuthorityRevocationEpoch: 6 }))).toContain("approval_stale");
    // The base is bound through the intent rather than the assertion, and a
    // moved base refuses the plan the approval was presented to.
    expect(codesOf(withApproval({}, { baseTipSha: "9".repeat(40) }))).toContain("base_moved");
  });

  it("refuses an approval shown for a different action, an expired one, and a replayed nonce", () => {
    expect(codesOf(withApproval({ action: "deploy" }))).toContain("approval_mismatch");
    expect(codesOf(withApproval({ expiry: "2025-01-01T00:00:00Z" }))).toContain("approval_stale");
    const policy = policyOf();
    expect(
      codesOf(
        planExternalAction(
          planOf({
            policy,
            approvalRequiredActions: ["merge"],
            approval: approvalOf(policy),
            approvedChainDigest: actionChainDigest([], "merge"),
            consumedNonces: new Set(["nonce-1"]),
          }),
        ),
      ),
    ).toContain("approval_replayed");
  });

  it("refuses an approval the acting identity minted for itself, and one that names nobody", () => {
    expect(codesOf(withApproval({ origin: `${ACTION_APPROVAL_ORIGIN_PREFIX}agent-task-1` }))).toContain(
      "approval_not_distinct",
    );
    expect(codesOf(withApproval({ origin: `${ACTION_APPROVAL_ORIGIN_PREFIX}   ` }))).toContain("approval_unattributed");
    expect(codesOf(withApproval({ origin: "someone" }))).toContain("approval_unattributed");
    // "someone" is SHORTER than the 16-character prefix, so deleting the
    // startsWith guard leaves it refused for the empty-slice reason instead —
    // the assertion was vacuous about the mechanism it names. The waiver lane's
    // prefix is exactly as long, so under that mutant a waiver approval becomes
    // a merge approval and its identity is accepted as the distinct approver.
    expect(codesOf(withApproval({ origin: `${WAIVER_APPROVAL_ORIGIN_PREFIX}release-manager` }))).toContain(
      "approval_unattributed",
    );
  });

  it("refuses a fixture-sourced approval on a production profile", () => {
    // `currentProfile` is the active COMPOSITION profile, whose frozen
    // vocabulary is exactly ["production", "confirmation-fixture"]. Pinning
    // this against any other string would leave the product's only production
    // profile unproven, which is the installation the rule exists for.
    expect(
      codesOf(withApproval({ assertionSource: "qualification-fixture" }, { currentProfile: "production" })),
    ).toContain("approval_source_mismatch");
    expect(codesOf(withApproval({ assertionSource: "qualification-fixture" }))).toContain("approval_source_mismatch");
    // `currentProfile` is typed `string` and the rule is fail-closed by design:
    // anything that is not the confirmation fixture refuses. A third value
    // proves the shape, so narrowing the rule to `=== "production"` cannot
    // survive a profile added later or an unvalidated value crossing in.
    expect(
      codesOf(withApproval({ assertionSource: "qualification-fixture" }, { currentProfile: "some-other-profile" })),
    ).toContain("approval_source_mismatch");
    const policy = policyOf();
    expect(
      planExternalAction(
        planOf({
          policy,
          approvalRequiredActions: ["merge"],
          approval: approvalOf(policy, { assertionSource: "qualification-fixture" }),
          approvedChainDigest: actionChainDigest([], "merge"),
          currentProfile: "confirmation-fixture",
        }),
      ).ok,
    ).toBe(true);
  });

  it("refuses an approval the spine's own validator rejects, and one that is merely the wrong class", () => {
    const policy = policyOf();
    const plan = (approval: Record<string, unknown>) =>
      planExternalAction(
        planOf({
          policy,
          approvalRequiredActions: ["merge"],
          approval,
          approvedChainDigest: actionChainDigest([], "merge"),
        }),
      );
    // Well-formed delivery-bound assertion, so the class guard passes: only
    // `validateSensitiveApprovalAssertion` can refuse this, and it must — an
    // assertion carrying a member the closed spine grammar does not admit is
    // not the spine's non-model-mintable assertion at all. Without that call
    // the nonce need not even be a string, and a non-string nonce can never
    // match the consumed-nonce ledger: one approval, unbounded merges.
    expect(codesOf(plan(approvalOf(policy, { smuggled: "anything at all" })))).toContain("approval_malformed");
    expect(codesOf(plan(approvalOf(policy, { nonce: { forged: true } })))).toContain("approval_malformed");
    const { expiry: _dropped, ...missingExpiry } = approvalOf(policy);
    expect(codesOf(plan(missingExpiry))).toContain("approval_malformed");
    // And an assertion the spine's validator ACCEPTS whose only fault is its
    // class. This is a real maintenance-lane approval — every member that arm
    // requires is real and every member it forbids is "absent-by-state" — so
    // the shape guard has nothing to say about it and only the class
    // comparison can refuse it. An installer's approval to roll a generation
    // back is not an approval to merge a delivery.
    const maintenanceLane: Record<string, unknown> = {
      spec: "sensitive-approval-assertion/1",
      assertionClass: "maintenance-lane",
      origin: `${ACTION_APPROVAL_ORIGIN_PREFIX}release-manager`,
      action: "rollback",
      expiry: LATER,
      nonce: "nonce-2",
      assertionSource: "host-native",
      productTrustRevocationEpoch: policy.productTrustRevocationEpoch,
      repositoryAuthorityRevocationEpoch: ABSENT_BY_STATE,
      deliveryId: ABSENT_BY_STATE,
      candidateTreeSha: ABSENT_BY_STATE,
      policyDigest: ABSENT_BY_STATE,
      invocationFence: ABSENT_BY_STATE,
      targetInstallationId: "install-abc",
      targetGenerationDigest: "b".repeat(64),
      targetHighWaterMark: ABSENT_BY_STATE,
      expectedJournalRevision: ABSENT_BY_STATE,
    };
    expect(validateSensitiveApprovalAssertion(maintenanceLane).ok).toBe(true);
    expect(codesOf(plan(maintenanceLane))).toEqual(["approval_malformed"]);
  });

  it("refuses a malformed approval without reading any further binding off it", () => {
    const verdict = evaluateActionApproval(
      { spec: "sensitive-approval-assertion/1", assertionClass: "maintenance-lane" },
      {
        deliveryId: "delivery-1",
        action: "merge",
        candidateTreeSha: TREE,
        policyDigest: "a".repeat(64),
        invocationFence: 9,
        productTrustRevocationEpoch: 4,
        repositoryAuthorityRevocationEpoch: 7,
        actionChainDigest: actionChainDigest([], "merge"),
        approvedChainDigest: actionChainDigest([], "merge"),
        actingActorId: "agent-task-1",
        consumedNonces: new Set<string>(),
        currentProfile: "production",
        now: NOW,
      },
    );
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(["approval_malformed"]);
  });
});

describe("the recheck immediately before the call", () => {
  it("blocks on a superseded fence, a moved candidate or base, and a stale product-trust epoch", () => {
    const intent = boundIntent();
    expect(codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { invocationFence: 10 })))).toContain(
      "fence_superseded",
    );
    // Both directions: a store rolled BACKWARD restores nothing, so a fence or
    // an epoch below the one the intent bound is as disqualifying as one above.
    expect(codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { invocationFence: 8 })))).toContain(
      "fence_superseded",
    );
    expect(
      codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { productTrustRevocationEpoch: 3 }))),
    ).toContain("product_trust_stale");
    expect(codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { candidateTreeSha: "9".repeat(40) })))).toContain(
      "candidate_moved",
    );
    expect(codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { baseTipSha: "9".repeat(40) })))).toContain(
      "base_moved",
    );
    // This is the recheck that runs in the same breath as the irreversible
    // call, so its compares matter most: under a `>` mutant a candidate that
    // moved DOWN revalidates ok, and half of all real movements are invisible.
    expect(codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { candidateTreeSha: "0".repeat(40) })))).toContain(
      "candidate_moved",
    );
    expect(codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { baseTipSha: "0".repeat(40) })))).toContain(
      "base_moved",
    );
    expect(
      codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { productTrustRevocationEpoch: 5 }))),
    ).toContain("product_trust_stale");
  });

  it("blocks when authority is revoked after the delivery was already ready", () => {
    const intent = boundIntent();
    const revoked = observationOf(intent, {
      recheckAuthority: recheckWith(intent, {
        spec: "authority-revocation/1",
        epoch: intent.repositoryAuthorityRevocationEpoch + 1,
        revokedAuthority: ["merge"],
        revokedFinishLines: [],
      }),
    });
    expect(codesOf(revalidateBeforeInvoke(intent, revoked))).toContain("authority_revoked");
  });

  it("blocks on an authority store rolled backward, which restores nothing", () => {
    const intent = boundIntent();
    const rolled = observationOf(intent, {
      recheckAuthority: recheckWith(
        intent,
        { spec: "authority-revocation/1", epoch: 1, revokedAuthority: [], revokedFinishLines: [] },
        7,
      ),
    });
    expect(codesOf(revalidateBeforeInvoke(intent, rolled))).toContain("epoch_rollback");
  });

  it("blocks when the hosted evidence stopped standing between the bind and the call", () => {
    const intent = boundIntent();
    // As mutable as the candidate sha and rechecked in the same breath: a
    // required hosted check that turns red after the bind stops the call it
    // was standing under.
    expect(codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { externalVerification: "failed" })))).toContain(
      "external_verification_missing",
    );
    expect(
      codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { externalVerification: "unavailable" }))),
    ).toContain("external_verification_missing");
  });

  it("passes when nothing moved, against an observation written out rather than copied off the intent", () => {
    const intent = boundIntent();
    // Written out: an observation built FROM the intent agrees with it whatever
    // the intent binds, which would make every row in this block vacuous.
    expect(
      revalidateBeforeInvoke(intent, {
        invocationFence: 9,
        productTrustRevocationEpoch: 4,
        candidateTreeSha: TREE,
        baseTipSha: BASE,
        externalVerification: "passed",
        recheckAuthority: () => ({ ok: true }),
      }).ok,
    ).toBe(true);
    // Each live value one at a time against the same literal observation.
    const observation = {
      invocationFence: 9,
      productTrustRevocationEpoch: 4,
      candidateTreeSha: TREE,
      baseTipSha: BASE,
      externalVerification: "passed" as const,
      recheckAuthority: () => ({ ok: true }) as const,
    };
    expect(codesOf(revalidateBeforeInvoke(intent, { ...observation, invocationFence: 10 }))).toContain(
      "fence_superseded",
    );
    expect(codesOf(revalidateBeforeInvoke(intent, { ...observation, productTrustRevocationEpoch: 7 }))).toContain(
      "product_trust_stale",
    );
    expect(revalidateBeforeInvoke(intent, observationOf(intent)).ok).toBe(true);
  });
});

describe("the single invocation, against a fake adapter at every boundary", () => {
  it("never calls the adapter before the intent is journaled", async () => {
    const intent = boundIntent();
    const port = { invoke: vi.fn(fakePort("ok").invoke) };
    const result = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent),
      intentJournaled: false,
      intentAlreadyObserved: false,
    });
    expect(port.invoke).not.toHaveBeenCalled();
    // A refusal to call is not an observation: there is no result to journal.
    expect(result.kind).toBe("refused");
    expect(codesOf(result)).toContain("intent_not_journaled");
  });

  it("never calls the adapter when the recheck blocks", async () => {
    const intent = boundIntent();
    const port = { invoke: vi.fn(fakePort("ok").invoke) };
    const result = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent, { invocationFence: 10 }),
      intentJournaled: true,
      intentAlreadyObserved: false,
    });
    expect(port.invoke).not.toHaveBeenCalled();
    expect(result.kind).toBe("refused");
    expect(codesOf(result)).toContain("fence_superseded");
  });

  it("calls the adapter exactly once, hands it only the frozen payload, and verifies the reference it returned", async () => {
    const intent = boundIntent();
    const port = { invoke: vi.fn(fakePort("ok").invoke) };
    const verified = vi.fn(async (_reference: string) => true);
    const result = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
      verify: verified,
    });
    expect(port.invoke).toHaveBeenCalledTimes(1);
    // What the adapter RECEIVES, not what the helper returns: minimal
    // disclosure is a property of the call, and an adapter handed the whole
    // bound intent would be handed the approver, both epochs and the record.
    expect(port.invoke.mock.calls[0]?.[0]).toEqual({
      intentId: "intent-1",
      action: "merge",
      candidate: { treeSha: TREE, deliverableDigest: DELIVERABLE },
      policyDigest: policyOf().policyDigest,
      approval: "not-required",
    });
    // The post-action check runs over the reference the adapter returned, and
    // never over the intent id: a smoke check pointed at the wrong subject
    // passes for a reason that has nothing to do with the action.
    expect(verified).toHaveBeenCalledTimes(1);
    expect(verified).toHaveBeenCalledWith("https://example.test/pull/7");
    expect(observedResult(result)).toMatchObject({
      outcome: "succeeded",
      verification: "passed",
      externalReference: "https://example.test/pull/7",
    });
  });

  it("records an absent verifier as not-attempted over a succeeded action, never as passed", async () => {
    const intent = boundIntent();
    const port = { invoke: vi.fn(fakePort("ok").invoke) };
    const result = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
    });
    expect(port.invoke).toHaveBeenCalledTimes(1);
    expect(observedResult(result)).toMatchObject({
      outcome: "succeeded",
      verification: "not-attempted",
      externalReference: "https://example.test/pull/7",
    });
    // And the classification of that result does not leave through success.
    expect(
      classifyActionOutcome({ result: observedResult(result), containmentMoves: [], requestedFinishLine: "merge" }).state,
    ).toBe("blocked");
  });

  it("never calls the adapter a second time under an intent that already has an observed result", async () => {
    const intent = boundIntent();
    const port = { invoke: vi.fn(fakePort("ok").invoke) };
    const first = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
      verify: async () => false,
    });
    expect(observedResult(first)).toMatchObject({ outcome: "succeeded", verification: "failed" });
    expect(
      classifyActionOutcome({
        result: observedResult(first),
        containmentMoves: ["rollback"],
        requestedFinishLine: "merge",
      }).state,
    ).toBe("action_succeeded_verification_failed");

    // The second call is the replay that would rewrite that state into
    // `completed`. `replayProhibited` is advisory; this is what stops it.
    const second = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: true,
      verify: async () => true,
    });
    expect(port.invoke).toHaveBeenCalledTimes(1);
    // The refusal carries NO result. A fabricated failed/not-attempted here
    // would be byte-identical, in every member the frozen payload keeps, to a
    // merge that never happened — and classifying it would report `blocked`
    // with `action_failed` about a merge that succeeded.
    expect(second.kind).toBe("refused");
    expect(second).not.toHaveProperty("result");
    expect(codesOf(second)).toContain("action_replay_prohibited");
  });

  it("records a lost response as indeterminate and does not call again", async () => {
    const intent = boundIntent();
    const port = { invoke: vi.fn(fakePort("throw").invoke) };
    const result = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
    });
    expect(port.invoke).toHaveBeenCalledTimes(1);
    expect(observedResult(result).outcome).toBe("indeterminate");
    expect(observedResult(result).externalReference).toBe(ABSENT_BY_STATE);
  });

  it("records a success with no reference as indeterminate, because nothing could reconcile it", async () => {
    const intent = boundIntent();
    const result = await invokeExternalActionOnce({
      intent,
      port: fakePort("no-reference"),
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
    });
    expect(observedResult(result).outcome).toBe("indeterminate");
  });

  it("records an adapter refusal as a failure that never happened", async () => {
    const intent = boundIntent();
    const result = await invokeExternalActionOnce({
      intent,
      port: fakePort("refuse"),
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
    });
    // The ADAPTER reported that it did not act. That is an observation, and
    // it is journaled as one — unlike a call this unit refused to make.
    expect(observedResult(result)).toMatchObject({ outcome: "failed", verification: "not-attempted" });
    expect(codesOf(observedResult(result))).toContain("adapter_refused");
    // The journal payload is the five frozen members and NOTHING else — this
    // is the one result that carries a sixth (`refusals`), and the frozen
    // `action.result.recorded` grammar is closed, so a payload that spread the
    // whole result would make the record of a failed action unwritable.
    expect(journalResultPayload(observedResult(result))).toEqual({
      intentId: "intent-1",
      action: "merge",
      outcome: "failed",
      verification: "not-attempted",
      externalReference: ABSENT_BY_STATE,
    });
  });

  it("records a failed verification over a succeeded action, and a throwing verifier as failed rather than absent", async () => {
    const intent = boundIntent();
    const failed = await invokeExternalActionOnce({
      intent,
      port: fakePort("ok"),
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
      verify: async () => false,
    });
    expect(observedResult(failed)).toMatchObject({ outcome: "succeeded", verification: "failed" });
    const threw = await invokeExternalActionOnce({
      intent,
      port: fakePort("ok"),
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
      verify: async () => {
        throw new Error("smoke check could not run");
      },
    });
    expect(observedResult(threw)).toMatchObject({ outcome: "succeeded", verification: "failed" });
  });

  it("still cannot act through the port the product ships", async () => {
    const intent = boundIntent();
    const result = await invokeExternalActionOnce({
      intent,
      port: UNBOUND_EXTERNAL_ACTION_PORT,
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
    });
    expect(codesOf(observedResult(result))).toContain("action_port_unbound");
    expect(observedResult(result).outcome).toBe("failed");
  });

  it("journals exactly the frozen result members", async () => {
    const intent = boundIntent();
    const result = await invokeExternalActionOnce({
      intent,
      port: fakePort("ok"),
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
      verify: async () => true,
    });
    expect(journalResultPayload(observedResult(result))).toEqual({
      intentId: "intent-1",
      action: "merge",
      outcome: "succeeded",
      verification: "passed",
      externalReference: "https://example.test/pull/7",
    });
    // A verification that failed is journaled as failed, not as never run: the
    // record left behind by `action_succeeded_verification_failed` is the whole
    // evidence that the state was entered.
    const unverified = await invokeExternalActionOnce({
      intent,
      port: fakePort("ok"),
      observed: observationOf(intent),
      intentJournaled: true,
      intentAlreadyObserved: false,
      verify: async () => false,
    });
    expect(journalResultPayload(observedResult(unverified))).toEqual({
      intentId: "intent-1",
      action: "merge",
      outcome: "succeeded",
      verification: "failed",
      externalReference: "https://example.test/pull/7",
    });
  });
});

describe("reconcile before retry", () => {
  const indeterminate = {
    intentId: "intent-1",
    action: "merge" as const,
    outcome: "indeterminate" as const,
    verification: "not-attempted" as const,
    externalReference: ABSENT_BY_STATE,
  };

  it("treats a reconciled merge as already performed, never as something to do again", () => {
    const disposition = reconcileBeforeRetry({
      indeterminate,
      finding: "performed",
      observedReference: "https://example.test/pull/7",
    });
    expect(disposition.kind).toBe("already-performed");
    expect(disposition.kind === "already-performed" && disposition.result).toMatchObject({
      intentId: "intent-1",
      action: "merge",
      outcome: "succeeded",
      // The action happened; its required post-action check never ran, because
      // the response that would have carried it was lost. Recording `passed`
      // here would clear `merge_not_reconciled` for a merge nobody verified.
      verification: "not-attempted",
      externalReference: "https://example.test/pull/7",
    });
    expect(
      disposition.kind === "already-performed" &&
        checkDeployPreconditions({
          merge: disposition.result,
          mainTipSha: BASE,
          mergedCommitSha: BASE,
          workingTreeClean: true,
          provenance: { present: true, subjectDigest: DELIVERABLE, candidateDeliverableDigest: DELIVERABLE },
          preflight: { ran: true, passed: true },
        }).ok,
    ).toBe(false);
    // Reconciliation that found the action performed but observed no reference
    // says so by state rather than by inventing one.
    const unreferenced = reconcileBeforeRetry({ indeterminate, finding: "performed" });
    expect(unreferenced.kind === "already-performed" && unreferenced.result.externalReference).toBe(ABSENT_BY_STATE);
  });

  it("carries the reconciled action through, rather than the one the fixture happens to use", () => {
    const disposition = reconcileBeforeRetry({
      indeterminate: { ...indeterminate, intentId: "intent-7", action: "deploy" },
      finding: "performed",
      observedReference: "https://example.test/deploy/9",
    });
    expect(disposition.kind === "already-performed" && disposition.result).toMatchObject({
      intentId: "intent-7",
      action: "deploy",
      outcome: "succeeded",
      verification: "not-attempted",
      externalReference: "https://example.test/deploy/9",
    });
  });

  it("forbids a retry when reconciliation cannot tell", () => {
    const disposition = reconcileBeforeRetry({ indeterminate, finding: "unknown", nextIntentId: "intent-2" });
    expect(disposition.kind).toBe("blocked");
    expect(codesOf(disposition)).toContain("reconciliation_inconclusive");
  });

  it("refuses the retry an action that positively did not happen looks like it should get", () => {
    // The frozen delivery reducer admits a second `action.intent.recorded`
    // only once EVERY prior intent is reconciled — succeeded with a passing
    // verification — and an indeterminate action never becomes that, because
    // its result is written exactly once and nothing records a reconciliation
    // as a result. A `retry-authorized` here would be an authorization the
    // product refuses, leaving the delivery in `acting` holding it.
    const offered = reconcileBeforeRetry({ indeterminate, finding: "not-performed", nextIntentId: "intent-2" });
    expect(offered.kind).toBe("blocked");
    expect(codesOf(offered)).toContain("retry_not_admissible");
    expect(codesOf(reconcileBeforeRetry({ indeterminate, finding: "not-performed" }))).toContain(
      "retry_not_admissible",
    );
    // Offering the indeterminate intent's OWN id is the sharper error and
    // keeps its own refusal.
    expect(codesOf(reconcileBeforeRetry({ indeterminate, finding: "not-performed", nextIntentId: "intent-1" }))).toContain(
      "action_replay_prohibited",
    );
  });

  it("refuses to reconcile an action that already resolved", () => {
    const disposition = reconcileBeforeRetry({
      indeterminate: { ...indeterminate, outcome: "succeeded", verification: "passed", externalReference: "ref" },
      finding: "performed",
    });
    expect(codesOf(disposition)).toContain("reconciliation_not_applicable");
  });
});

describe("the post-action classification", () => {
  const resultOf = (outcome: "succeeded" | "failed" | "indeterminate", verification: "passed" | "failed" | "not-attempted") => ({
    intentId: "intent-1",
    action: "deploy" as const,
    outcome,
    verification,
    externalReference: "https://example.test/deploy/9",
  });

  /** The deploy is the last action a deploy contract takes, so it completes. */
  const classify = (
    result: ReturnType<typeof resultOf>,
    containmentMoves: readonly string[],
    requestedFinishLine = "deploy",
  ) => classifyActionOutcome({ result, containmentMoves, requestedFinishLine });

  it("completes only on a succeeded action with passing verification", () => {
    expect(classify(resultOf("succeeded", "passed"), ["rollback"])).toEqual({
      state: "completed",
      replayProhibited: true,
      permittedMoves: [],
      refusals: [],
    });
  });

  it("leaves a deploy contract acting after its merge, and completes only at the action the finish line asked for", () => {
    const merged = {
      intentId: "intent-1",
      action: "merge" as const,
      outcome: "succeeded" as const,
      verification: "passed" as const,
      externalReference: "https://example.test/pull/7",
    };
    // Under a deploy contract the merge is the first of two acting steps. A
    // `completed` here would terminate the delivery having never deployed, on
    // a transition the journal accepts — the blocker one function downstream
    // of the one the plan refuses.
    const afterMerge = classifyActionOutcome({ result: merged, containmentMoves: [], requestedFinishLine: "deploy" });
    expect(afterMerge.state).toBe("acting");
    expect(afterMerge.permittedMoves).toEqual(["deploy"]);
    expect(afterMerge.replayProhibited).toBe(true);
    expect(codesOf(afterMerge)).toContain("finish_line_not_reached");

    // The same merge under a merge contract is the finish line, and completes.
    expect(
      classifyActionOutcome({ result: merged, containmentMoves: [], requestedFinishLine: "merge" }),
    ).toEqual({ state: "completed", replayProhibited: true, permittedMoves: [], refusals: [] });

    // And the deploy that follows completes the deploy contract.
    expect(classify(resultOf("succeeded", "passed"), []).state).toBe("completed");
  });

  it("never completes a finish line that does not reach the action that was taken", () => {
    const merged = {
      intentId: "intent-1",
      action: "merge" as const,
      outcome: "succeeded" as const,
      verification: "passed" as const,
      externalReference: "https://example.test/pull/7",
    };
    // `merge-ready` reaches no action at all, and an unrecognized finish line
    // reaches nothing either. Neither may fall through to `completed` — that
    // is the same fail-open direction the deploy contract's merge had.
    for (const requestedFinishLine of ["merge-ready", "some-other-finish-line"]) {
      const classified = classifyActionOutcome({ result: merged, containmentMoves: ["rollback"], requestedFinishLine });
      expect(classified.state).toBe("blocked");
      expect(classified.replayProhibited).toBe(true);
      expect(codesOf(classified)).toContain("finish_line_not_reached");
    }
    // A merge under a merge-only finish line is the one that completes.
    expect(
      classifyActionOutcome({ result: merged, containmentMoves: [], requestedFinishLine: "merge" }).state,
    ).toBe("completed");
  });

  it("enters action_succeeded_verification_failed, prohibits replay, and offers only policy-selected moves", () => {
    const classified = classify(resultOf("succeeded", "failed"), ["rollback", "escalate"]);
    expect(classified.state).toBe("action_succeeded_verification_failed");
    expect(classified.replayProhibited).toBe(true);
    expect(classified.permittedMoves).toEqual(["rollback", "escalate"]);
    expect(codesOf(classified)).toContain("action_succeeded_verification_failed");
    // A repository that selected no containment gets no moves invented for it.
    expect(classify(resultOf("succeeded", "failed"), []).permittedMoves).toEqual([]);
  });

  it("does not call an unrun verification a passing one", () => {
    const classified = classify(resultOf("succeeded", "not-attempted"), []);
    expect(classified.state).toBe("blocked");
    expect(classified.replayProhibited).toBe(true);
    expect(codesOf(classified)).toContain("verification_not_attempted");
  });

  it("sends an indeterminate action to reconciliation and a failed one to blocked", () => {
    const unresolved = classify(resultOf("indeterminate", "not-attempted"), []);
    expect(unresolved.state).toBe("acting");
    expect(unresolved.permittedMoves).toEqual(["reconcile"]);
    expect(unresolved.replayProhibited).toBe(true);
    const failed = classify(resultOf("failed", "not-attempted"), ["escalate"]);
    expect(failed.state).toBe("blocked");
    // Every branch prohibits the replay. `blocked` is not `acting`, and the
    // frozen reducer admits no second intent from there either, so telling a
    // host otherwise would promise an attempt the product refuses.
    expect(failed.replayProhibited).toBe(true);
    // An action that did not happen still leaves through the containment the
    // policy selected, not through nothing at all.
    expect(failed.permittedMoves).toEqual(["escalate"]);
    expect(codesOf(failed)).toContain("action_failed");
  });
});

describe("deployment's additional preconditions", () => {
  const mergeOf = (over: Partial<{ outcome: "succeeded" | "failed" | "indeterminate"; verification: "passed" | "failed" | "not-attempted" }> = {}) => ({
    intentId: "intent-1",
    action: "merge" as const,
    outcome: "succeeded" as const,
    verification: "passed" as const,
    externalReference: "https://example.test/pull/7",
    ...over,
  });

  const deployInput = (over: Record<string, unknown> = {}) => ({
    merge: mergeOf(),
    mainTipSha: BASE,
    mergedCommitSha: BASE,
    workingTreeClean: true,
    provenance: { present: true, subjectDigest: DELIVERABLE, candidateDeliverableDigest: DELIVERABLE },
    preflight: { ran: true, passed: true },
    ...over,
  });

  it("passes when the merge reconciled, main is that merge, provenance matches and the preflight ran", () => {
    expect(checkDeployPreconditions(deployInput()).ok).toBe(true);
  });

  it("refuses a deploy with no merge, or a merge that did not verify", () => {
    expect(codesOf(checkDeployPreconditions(deployInput({ merge: undefined })))).toContain("merge_not_reconciled");
    expect(
      codesOf(checkDeployPreconditions(deployInput({ merge: mergeOf({ verification: "not-attempted" }) }))),
    ).toContain("merge_not_reconciled");
    expect(
      codesOf(checkDeployPreconditions(deployInput({ merge: mergeOf({ outcome: "indeterminate", verification: "not-attempted" }) }))),
    ).toContain("merge_not_reconciled");
    // Both halves on their own: a merge that failed with a passing verifier is
    // as unreconciled as a merge that succeeded with a failing one.
    expect(codesOf(checkDeployPreconditions(deployInput({ merge: mergeOf({ verification: "failed" }) })))).toContain(
      "merge_not_reconciled",
    );
    expect(
      codesOf(checkDeployPreconditions(deployInput({ merge: mergeOf({ outcome: "failed", verification: "passed" }) }))),
    ).toContain("merge_not_reconciled");
  });

  it("refuses a main that moved past the merge, and a dirty deployment source", () => {
    expect(codesOf(checkDeployPreconditions(deployInput({ mainTipSha: "9".repeat(40) })))).toContain("main_not_clean");
    expect(codesOf(checkDeployPreconditions(deployInput({ mainTipSha: "0".repeat(40) })))).toContain("main_not_clean");
    expect(codesOf(checkDeployPreconditions(deployInput({ workingTreeClean: false })))).toContain("main_not_clean");
  });

  it("refuses missing provenance and provenance over another artifact", () => {
    expect(
      codesOf(
        checkDeployPreconditions(
          deployInput({ provenance: { present: false, subjectDigest: DELIVERABLE, candidateDeliverableDigest: DELIVERABLE } }),
        ),
      ),
    ).toContain("provenance_missing");
    expect(
      codesOf(
        checkDeployPreconditions(
          deployInput({ provenance: { present: true, subjectDigest: "a".repeat(64), candidateDeliverableDigest: DELIVERABLE } }),
        ),
      ),
    ).toContain("provenance_mismatch");
    expect(
      codesOf(
        checkDeployPreconditions(
          deployInput({ provenance: { present: true, subjectDigest: "0".repeat(64), candidateDeliverableDigest: DELIVERABLE } }),
        ),
      ),
    ).toContain("provenance_mismatch");
    // DELIVERABLE is "f" repeated, the maximum hex string, so no probe subject
    // digest can sort above it. The other operand moves down instead, which is
    // the same asymmetry seen from the other end.
    expect(
      codesOf(
        checkDeployPreconditions(
          deployInput({ provenance: { present: true, subjectDigest: DELIVERABLE, candidateDeliverableDigest: "a".repeat(64) } }),
        ),
      ),
    ).toContain("provenance_mismatch");
  });

  it("separates a preflight that failed from one that never ran", () => {
    expect(codesOf(checkDeployPreconditions(deployInput({ preflight: { ran: false, passed: false } })))).toContain(
      "preflight_not_attempted",
    );
    expect(codesOf(checkDeployPreconditions(deployInput({ preflight: { ran: true, passed: false } })))).toContain(
      "preflight_failed",
    );
  });
});

describe("the action chain and the post-action result grammar", () => {
  it("digests a different chain to a different value, in order", () => {
    const first = actionChainDigest([], "merge");
    const afterMerge = actionChainDigest(
      [{ intentId: "intent-1", action: "merge", outcome: "succeeded", verification: "passed" }],
      "deploy",
    );
    const afterTwo = actionChainDigest(
      [
        { intentId: "intent-1", action: "merge", outcome: "failed", verification: "not-attempted" },
        { intentId: "intent-2", action: "merge", outcome: "succeeded", verification: "passed" },
      ],
      "deploy",
    );
    expect(new Set([first, afterMerge, afterTwo]).size).toBe(3);
    // Order is part of the identity: the same links reversed are a different chain.
    const forward = actionChainDigest(
      [
        { intentId: "intent-1", action: "merge", outcome: "succeeded", verification: "passed" },
        { intentId: "intent-2", action: "deploy", outcome: "failed", verification: "not-attempted" },
      ],
      "deploy",
    );
    const reversed = actionChainDigest(
      [
        { intentId: "intent-2", action: "deploy", outcome: "failed", verification: "not-attempted" },
        { intentId: "intent-1", action: "merge", outcome: "succeeded", verification: "passed" },
      ],
      "deploy",
    );
    expect(forward).not.toBe(reversed);
  });

  it("digests every member of every link, and the action about to be taken", () => {
    // One member at a time, so no row can pass for another row's reason. The
    // chain is the whole mechanism by which an approval is unusable for a
    // different sequence, which makes its member set load-bearing.
    const base = [{ intentId: "intent-1", action: "merge" as const, outcome: "succeeded" as const, verification: "passed" as const }];
    const digest = actionChainDigest(base, "deploy");
    expect(actionChainDigest([{ ...base[0]!, outcome: "failed" }], "deploy")).not.toBe(digest);
    expect(actionChainDigest([{ ...base[0]!, verification: "not-attempted" }], "deploy")).not.toBe(digest);
    expect(actionChainDigest([{ ...base[0]!, intentId: "intent-9" }], "deploy")).not.toBe(digest);
    expect(actionChainDigest([{ ...base[0]!, action: "deploy" }], "deploy")).not.toBe(digest);
    // And the action about to be taken over an identical history.
    expect(actionChainDigest(base, "merge")).not.toBe(digest);
  });

  it("binds the plan's intent to the chain it was taken after", () => {
    const after = planExternalAction(
      planOf({ chain: [{ intentId: "intent-0", action: "merge", outcome: "failed", verification: "not-attempted" }] }),
    );
    expect(after.ok).toBe(true);
    expect(after.ok === true && after.intent.actionChainDigest).toBe(
      actionChainDigest([{ intentId: "intent-0", action: "merge", outcome: "failed", verification: "not-attempted" }], "merge"),
    );
    expect(after.ok === true && after.intent.actionChainDigest).not.toBe(boundIntent().actionChainDigest);
  });

  it("accepts a well-formed merge result and refuses the combinations that cannot be true", () => {
    const result = {
      spec: EXTERNAL_ACTION_RESULT_SPEC,
      finishLine: "merge",
      deliveryId: "delivery-1",
      intentId: "intent-1",
      action: "merge",
      candidate: { treeSha: TREE, deliverableDigest: DELIVERABLE },
      policyDigest: "a".repeat(64),
      approval: "required",
      outcome: "succeeded",
      verification: "passed",
      externalReference: "https://example.test/pull/7",
      actionChainDigest: actionChainDigest([], "merge"),
      invocationFence: 9,
      productTrustRevocationEpoch: 4,
      repositoryAuthorityRevocationEpoch: 7,
      trackedRecordDigest: RECORD_DIGEST,
    };
    expect(validateExternalActionResult(result).ok).toBe(true);
    expect(validateExternalActionResult({ ...result, verification: "passed", outcome: "indeterminate" }).ok).toBe(false);
    // A deploy contract's merge is a real result and has to be recordable, by
    // the same reachability relation the plan binds under.
    expect(validateExternalActionResult({ ...result, finishLine: "deploy" }).ok).toBe(true);
    // A merge contract's deploy is not reachable and stays unsayable.
    expect(
      validateExternalActionResult({ ...result, finishLine: "merge", action: "deploy" }).ok,
    ).toBe(false);
    // merge-ready has its own frozen result and is not spellable here.
    expect(validateExternalActionResult({ ...result, finishLine: "merge-ready" }).ok).toBe(false);
    expect(validateExternalActionResult({ ...result, unexpected: 1 }).ok).toBe(false);
    expect(validateExternalActionResult({ ...result, externalReference: ABSENT_BY_STATE }).ok).toBe(true);
  });

  it("refuses a result whose every member fails its own check, one member at a time", () => {
    // Closedness and the two cross-member rules were pinned; the member rules
    // themselves were not, so the freeze the unit claims over this payload was
    // carried by nothing. One substitution per row, so no row can pass for
    // another row's reason.
    const valid = {
      spec: EXTERNAL_ACTION_RESULT_SPEC,
      finishLine: "merge",
      deliveryId: "delivery-1",
      intentId: "intent-1",
      action: "merge",
      candidate: { treeSha: TREE, deliverableDigest: DELIVERABLE },
      policyDigest: "a".repeat(64),
      approval: "required",
      outcome: "succeeded",
      verification: "passed",
      externalReference: "https://example.test/pull/7",
      actionChainDigest: actionChainDigest([], "merge"),
      invocationFence: 9,
      productTrustRevocationEpoch: 4,
      repositoryAuthorityRevocationEpoch: 7,
      trackedRecordDigest: RECORD_DIGEST,
    };
    expect(validateExternalActionResult(valid).ok).toBe(true);
    const ill: readonly Record<string, unknown>[] = [
      { deliveryId: "" },
      { intentId: "" },
      { candidate: { treeSha: "not-an-oid", deliverableDigest: DELIVERABLE } },
      { candidate: { treeSha: TREE, deliverableDigest: "not-a-digest" } },
      { policyDigest: "not-a-digest" },
      { actionChainDigest: "not-a-digest" },
      { trackedRecordDigest: "not-a-digest" },
      // A fence is taken, never absent: zero is not a fence anybody holds.
      { invocationFence: 0 },
      { productTrustRevocationEpoch: -1 },
      { repositoryAuthorityRevocationEpoch: -1 },
      { approval: "maybe" },
      { outcome: "partly" },
      { verification: "probably" },
      { spec: "external-action-result/2" },
    ];
    for (const over of ill) {
      expect(validateExternalActionResult({ ...valid, ...over })).toMatchObject({ ok: false });
    }
  });
});
