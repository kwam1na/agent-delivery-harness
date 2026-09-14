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
 *   - RECONCILE BEFORE RETRY: two of three findings forbid a second call, and
 *     the third forbids reusing the intent id;
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
    currentProfile: "linear",
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
      bound: { grantedFinishLines: [], grantedAuthority: ["merge"] },
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

  it("binds the evidence the action was taken on into the intent it returns", () => {
    const intent = boundIntent();
    // The allow side of the binding, not only the refusal side: an intent that
    // dropped its obligations would be an intent nobody could later audit
    // against the policy that authorized it.
    expect(intent.evidence).toEqual({ externalVerification: "passed", completedObligations: ["review-green"] });
    expect(intent.trackedRecordDigest).toBe(RECORD_DIGEST);
  });

  it("refuses when the candidate or the base moved away from the tracked record", () => {
    expect(codesOf(planExternalAction(planOf({ candidate: { treeSha: "9".repeat(40), deliverableDigest: DELIVERABLE } })))).toContain(
      "candidate_moved",
    );
    expect(codesOf(planExternalAction(planOf({ baseTipSha: "9".repeat(40) })))).toContain("base_moved");
  });

  it("carries no credential material into the intent it builds", () => {
    const intent = boundIntent();
    // The adapter is named, never quoted: the acting task holds no credential,
    // and nothing in the journaled payload could carry one.
    expect(intent.adapterCapabilityId).toBe("merge.github");
    expect(JSON.stringify(intent)).not.toContain("credential");
    expect(Object.keys(journalIntentPayload(intent)).sort()).toEqual([
      "action",
      "approval",
      "candidate",
      "intentId",
      "policyDigest",
    ]);
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
    expect(codesOf(withApproval({ invocationFence: 8 }))).toContain("approval_mismatch");
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
  });

  it("refuses a fixture-sourced approval on a production profile", () => {
    expect(codesOf(withApproval({ assertionSource: "qualification-fixture" }))).toContain("approval_source_mismatch");
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
        currentProfile: "linear",
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
    expect(codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { candidateTreeSha: "9".repeat(40) })))).toContain(
      "candidate_moved",
    );
    expect(codesOf(revalidateBeforeInvoke(intent, observationOf(intent, { baseTipSha: "9".repeat(40) })))).toContain(
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

  it("passes when nothing moved", () => {
    const intent = boundIntent();
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
    });
    expect(port.invoke).not.toHaveBeenCalled();
    expect(result.outcome).toBe("failed");
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
    });
    expect(port.invoke).not.toHaveBeenCalled();
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
      verify: verified,
    });
    expect(port.invoke).toHaveBeenCalledTimes(1);
    // What the adapter RECEIVES, not what the helper returns: minimal
    // disclosure is a property of the call, and an adapter handed the whole
    // bound intent would be handed the approver, both epochs and the record.
    expect(Object.keys(port.invoke.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      "action",
      "approval",
      "candidate",
      "intentId",
      "policyDigest",
    ]);
    // The post-action check runs over the reference the adapter returned, and
    // never over the intent id: a smoke check pointed at the wrong subject
    // passes for a reason that has nothing to do with the action.
    expect(verified).toHaveBeenCalledTimes(1);
    expect(verified).toHaveBeenCalledWith("https://example.test/pull/7");
    expect(result).toMatchObject({ outcome: "succeeded", verification: "passed", externalReference: "https://example.test/pull/7" });
  });

  it("records an absent verifier as not-attempted over a succeeded action, never as passed", async () => {
    const intent = boundIntent();
    const port = { invoke: vi.fn(fakePort("ok").invoke) };
    const result = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent),
      intentJournaled: true,
    });
    expect(port.invoke).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "succeeded",
      verification: "not-attempted",
      externalReference: "https://example.test/pull/7",
    });
    // And the classification of that result does not leave through success.
    expect(classifyActionOutcome({ result, containmentMoves: [] }).state).toBe("blocked");
  });

  it("never calls the adapter a second time under an intent that already has an observed result", async () => {
    const intent = boundIntent();
    const port = { invoke: vi.fn(fakePort("ok").invoke) };
    const first = await invokeExternalActionOnce({
      intent,
      port,
      observed: observationOf(intent),
      intentJournaled: true,
      verify: async () => false,
    });
    expect(first).toMatchObject({ outcome: "succeeded", verification: "failed" });
    expect(classifyActionOutcome({ result: first, containmentMoves: ["rollback"] }).state).toBe(
      "action_succeeded_verification_failed",
    );

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
    expect(second.outcome).toBe("failed");
    expect(codesOf(second)).toContain("action_replay_prohibited");
  });

  it("records a lost response as indeterminate and does not call again", async () => {
    const intent = boundIntent();
    const port = { invoke: vi.fn(fakePort("throw").invoke) };
    const result = await invokeExternalActionOnce({ intent, port, observed: observationOf(intent), intentJournaled: true });
    expect(port.invoke).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("indeterminate");
    expect(result.externalReference).toBe(ABSENT_BY_STATE);
  });

  it("records a success with no reference as indeterminate, because nothing could reconcile it", async () => {
    const intent = boundIntent();
    const result = await invokeExternalActionOnce({
      intent,
      port: fakePort("no-reference"),
      observed: observationOf(intent),
      intentJournaled: true,
    });
    expect(result.outcome).toBe("indeterminate");
  });

  it("records an adapter refusal as a failure that never happened", async () => {
    const intent = boundIntent();
    const result = await invokeExternalActionOnce({
      intent,
      port: fakePort("refuse"),
      observed: observationOf(intent),
      intentJournaled: true,
    });
    expect(result).toMatchObject({ outcome: "failed", verification: "not-attempted" });
    expect(codesOf(result)).toContain("adapter_refused");
  });

  it("records a failed verification over a succeeded action, and a throwing verifier as failed rather than absent", async () => {
    const intent = boundIntent();
    const failed = await invokeExternalActionOnce({
      intent,
      port: fakePort("ok"),
      observed: observationOf(intent),
      intentJournaled: true,
      verify: async () => false,
    });
    expect(failed).toMatchObject({ outcome: "succeeded", verification: "failed" });
    const threw = await invokeExternalActionOnce({
      intent,
      port: fakePort("ok"),
      observed: observationOf(intent),
      intentJournaled: true,
      verify: async () => {
        throw new Error("smoke check could not run");
      },
    });
    expect(threw).toMatchObject({ outcome: "succeeded", verification: "failed" });
  });

  it("still cannot act through the port the product ships", async () => {
    const intent = boundIntent();
    const result = await invokeExternalActionOnce({
      intent,
      port: UNBOUND_EXTERNAL_ACTION_PORT,
      observed: observationOf(intent),
      intentJournaled: true,
    });
    expect(codesOf(result)).toContain("action_port_unbound");
    expect(result.outcome).toBe("failed");
  });

  it("journals exactly the frozen result members", async () => {
    const intent = boundIntent();
    const result = await invokeExternalActionOnce({
      intent,
      port: fakePort("ok"),
      observed: observationOf(intent),
      intentJournaled: true,
      verify: async () => true,
    });
    expect(Object.keys(journalResultPayload(result)).sort()).toEqual([
      "action",
      "externalReference",
      "intentId",
      "outcome",
      "verification",
    ]);
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

  it("forbids a retry when reconciliation cannot tell", () => {
    const disposition = reconcileBeforeRetry({ indeterminate, finding: "unknown", nextIntentId: "intent-2" });
    expect(disposition.kind).toBe("blocked");
    expect(codesOf(disposition)).toContain("reconciliation_inconclusive");
  });

  it("authorizes a retry only under a new intent id", () => {
    expect(codesOf(reconcileBeforeRetry({ indeterminate, finding: "not-performed" }))).toContain(
      "action_replay_prohibited",
    );
    expect(codesOf(reconcileBeforeRetry({ indeterminate, finding: "not-performed", nextIntentId: "intent-1" }))).toContain(
      "action_replay_prohibited",
    );
    expect(reconcileBeforeRetry({ indeterminate, finding: "not-performed", nextIntentId: "intent-2" })).toEqual({
      kind: "retry-authorized",
      nextIntentId: "intent-2",
    });
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

  it("completes only on a succeeded action with passing verification", () => {
    expect(classifyActionOutcome({ result: resultOf("succeeded", "passed"), containmentMoves: ["rollback"] })).toEqual({
      state: "completed",
      replayProhibited: true,
      permittedMoves: [],
      refusals: [],
    });
  });

  it("enters action_succeeded_verification_failed, prohibits replay, and offers only policy-selected moves", () => {
    const classified = classifyActionOutcome({
      result: resultOf("succeeded", "failed"),
      containmentMoves: ["rollback", "escalate"],
    });
    expect(classified.state).toBe("action_succeeded_verification_failed");
    expect(classified.replayProhibited).toBe(true);
    expect(classified.permittedMoves).toEqual(["rollback", "escalate"]);
    expect(codesOf(classified)).toContain("action_succeeded_verification_failed");
    // A repository that selected no containment gets no moves invented for it.
    expect(classifyActionOutcome({ result: resultOf("succeeded", "failed"), containmentMoves: [] }).permittedMoves).toEqual([]);
  });

  it("does not call an unrun verification a passing one", () => {
    const classified = classifyActionOutcome({ result: resultOf("succeeded", "not-attempted"), containmentMoves: [] });
    expect(classified.state).toBe("blocked");
    expect(classified.replayProhibited).toBe(true);
    expect(codesOf(classified)).toContain("verification_not_attempted");
  });

  it("sends an indeterminate action to reconciliation and a failed one to blocked", () => {
    const unresolved = classifyActionOutcome({ result: resultOf("indeterminate", "not-attempted"), containmentMoves: [] });
    expect(unresolved.state).toBe("acting");
    expect(unresolved.permittedMoves).toEqual(["reconcile"]);
    expect(unresolved.replayProhibited).toBe(true);
    const failed = classifyActionOutcome({ result: resultOf("failed", "not-attempted"), containmentMoves: ["escalate"] });
    expect(failed.state).toBe("blocked");
    expect(failed.replayProhibited).toBe(false);
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
  });

  it("refuses a main that moved past the merge, and a dirty deployment source", () => {
    expect(codesOf(checkDeployPreconditions(deployInput({ mainTipSha: "9".repeat(40) })))).toContain("main_not_clean");
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
    expect(validateExternalActionResult({ ...result, finishLine: "deploy" }).ok).toBe(false);
    // merge-ready has its own frozen result and is not spellable here.
    expect(validateExternalActionResult({ ...result, finishLine: "merge-ready" }).ok).toBe(false);
    expect(validateExternalActionResult({ ...result, unexpected: 1 }).ok).toBe(false);
    expect(validateExternalActionResult({ ...result, externalReference: ABSENT_BY_STATE }).ok).toBe(true);
  });
});
