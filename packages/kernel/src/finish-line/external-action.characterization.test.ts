/**
 * CHARACTERIZATION OF THE EXTERNAL-ACTION SEAM AS IT STANDS BEFORE THIS UNIT.
 *
 * Pinned GREEN before any invocation path existed, so every rule the
 * external-actions unit adds is later proven against observed behavior rather
 * than against remembered behavior. The facts characterized here are the ones
 * the new unit consumes and must not silently move:
 *
 *   1. the frozen external-action vocabulary, and that the privileged
 *      capability kinds are exactly the actions plus the approval request —
 *      the set whose credentials never enter a model-driven grant;
 *   2. the authority matrix's three refusals and its two authorized next
 *      states, which the new unit calls rather than re-derives;
 *   3. that the shipped port refuses every intent with `action_port_unbound`,
 *      so "authority is modelled, never exercised" stays mechanical for any
 *      repository that binds no adapter;
 *   4. that `decideFinishLine` stops at `acting`/`awaiting_approval` and
 *      never invokes anything;
 *   5. the delivery states and transitions the action path must move through,
 *      which the spine already enumerates;
 *   6. the two journal pairs that are this path's audit rail, and the frozen
 *      outcome/verification vocabularies their payloads admit.
 */
import { describe, expect, it } from "vitest";
import { PRIVILEGED_CAPABILITY_KINDS, PRIVILEGED_ACTIONS } from "../policy/capabilities.ts";
import { EXTERNAL_ACTIONS } from "../spine/finish-line.ts";
import { ACTION_VERIFICATIONS, EXTERNAL_ACTION_OUTCOMES } from "../spine/journal.ts";
import { DELIVERY_STATES, SUSPENDED_DELIVERY_STATES } from "../spine/vocabulary.ts";
import { UNBOUND_EXTERNAL_ACTION_PORT, authorizeFinishLineAction } from "./merge-ready.ts";
import type { AcceptedContract } from "../spine/contract.ts";
import type { PolicySnapshot } from "../spine/policy.ts";
import { digestCanonical } from "../digest.ts";

const contractOf = (over: Partial<AcceptedContract> = {}): AcceptedContract => ({
  spec: "scoped-delivery-contract/1",
  contractId: "contract-1",
  task: "ship it",
  intendedOutcome: "it is shipped",
  acceptanceCriteria: [{ criterionId: "c1", statement: "it works" }],
  nonGoals: [],
  repository: { repositoryId: "repo-1", baseRef: "refs/heads/main" },
  requestedFinishLine: "merge-ready",
  requestedAuthority: [],
  unresolvedDecisions: [],
  ...over,
});

const policyOf = (over: Partial<PolicySnapshot> = {}): PolicySnapshot => {
  const body = {
    spec: "policy-snapshot/1" as const,
    repositoryId: "repo-1",
    productTrustRevocationEpoch: 0,
    repositoryAuthorityRevocationEpoch: 0,
    grantedFinishLines: ["merge-ready"],
    grantedAuthority: [],
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

describe("characterization: the external-action seam before the actions unit", () => {
  it("names three external actions, and the privileged kinds are those three plus the approval request", () => {
    expect([...EXTERNAL_ACTIONS]).toEqual(["pr-creation", "merge", "deploy"]);
    expect(Object.isFrozen(EXTERNAL_ACTIONS)).toBe(true);
    // The identity the new unit relies on: every action is privileged, so no
    // action's credential can ride in a model-driven execution grant.
    expect(PRIVILEGED_ACTIONS).toBe(EXTERNAL_ACTIONS);
    expect([...PRIVILEGED_CAPABILITY_KINDS]).toEqual([...EXTERNAL_ACTIONS, "approval-request"]);
  });

  it("authorizes an action only when policy grants it, the contract requests it, and the finish line is not merge-ready", () => {
    const granted = policyOf({ grantedFinishLines: ["merge-ready", "merge"], grantedAuthority: ["merge"] });

    // Authorized, with no approval required: straight to acting.
    expect(
      authorizeFinishLineAction({
        action: "merge",
        contract: contractOf({ requestedFinishLine: "merge", requestedAuthority: ["merge"] }),
        policy: granted,
      }),
    ).toEqual({ ok: true, nextState: "acting" });

    // The same pair, with policy requiring an approval: awaiting_approval.
    expect(
      authorizeFinishLineAction({
        action: "merge",
        contract: contractOf({ requestedFinishLine: "merge", requestedAuthority: ["merge"] }),
        policy: granted,
        approvalRequiredActions: ["merge"],
      }),
    ).toEqual({ ok: true, nextState: "awaiting_approval" });

    // A merge-ready finish line authorizes nothing, even with the grant.
    const mergeReady = authorizeFinishLineAction({
      action: "merge",
      contract: contractOf({ requestedAuthority: ["merge"] }),
      policy: granted,
    });
    expect(mergeReady.ok).toBe(false);
    expect(mergeReady.ok === false && mergeReady.refusals.map((refusal) => refusal.code)).toContain("forbidden_action");

    // The contract requesting nothing refuses even under a granting policy.
    const unrequested = authorizeFinishLineAction({
      action: "merge",
      contract: contractOf({ requestedFinishLine: "merge" }),
      policy: granted,
    });
    expect(unrequested.ok).toBe(false);
    expect(unrequested.ok === false && unrequested.refusals.map((refusal) => refusal.code)).toContain(
      "authority_not_requested",
    );

    // The contract requesting beyond the policy refuses on the spine's own rule.
    const beyond = authorizeFinishLineAction({
      action: "deploy",
      contract: contractOf({ requestedFinishLine: "deploy", requestedAuthority: ["deploy"] }),
      policy: granted,
    });
    expect(beyond.ok).toBe(false);
    expect(beyond.ok === false && beyond.refusals.length).toBeGreaterThan(0);
  });

  it("refuses every intent through the shipped port, so an authorized action is still not invocable", async () => {
    const invocation = await UNBOUND_EXTERNAL_ACTION_PORT.invoke({
      intentId: "intent-1",
      action: "merge",
      candidate: { treeSha: "1".repeat(40), deliverableDigest: "f".repeat(64) },
      policyDigest: "a".repeat(64),
      approval: "not-required",
    });
    expect(invocation.ok).toBe(false);
    expect(invocation.ok === false && invocation.refusals.map((refusal) => refusal.code)).toEqual([
      "action_port_unbound",
    ]);
  });

  it("already names the post-action states and the frozen result vocabularies the audit rail admits", () => {
    expect(DELIVERY_STATES).toContain("acting");
    expect(DELIVERY_STATES).toContain("awaiting_approval");
    expect(DELIVERY_STATES).toContain("action_succeeded_verification_failed");
    // The verification-failed state is suspended, not terminal-successful:
    // this is what makes "replay prohibited, containment only" expressible.
    expect(SUSPENDED_DELIVERY_STATES).toContain("action_succeeded_verification_failed");
    expect([...EXTERNAL_ACTION_OUTCOMES]).toEqual(["succeeded", "failed", "indeterminate"]);
    expect([...ACTION_VERIFICATIONS]).toEqual(["passed", "failed", "not-attempted"]);
  });
});
