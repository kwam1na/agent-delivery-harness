/**
 * THE FINISH-LINE REDUCER AND ITS OPERATION PORT.
 *
 * MERGE-READY IS THE DEFAULT AND THE ONLY TERMINATION THIS SLICE REACHES. The
 * reducer converts an admitted, recorded, independently verified run into the
 * frozen merge-ready result, and it terminates successfully only when all of
 * admission, the tracked-record `recording` transition, and the repository's
 * merge-ready obligations hold — hosted evidence (the external verifier) and
 * local evidence (the completed obligations) each on their own.
 *
 * AUTHORITY IS MODELLED, NEVER EXERCISED. A finish line beyond merge-ready
 * needs a policy grant, a matching contract request, and — where policy says
 * so — an approval. The reducer decides which of `acting` or
 * `awaiting_approval` such a delivery is authorized to enter and stops there:
 * this slice binds no adapter, so `UNBOUND_EXTERNAL_ACTION_PORT` refuses every
 * intent. Pull-request creation, merge, and deployment are therefore
 * unreachable from here, and the merge-ready path forbids them outright — a
 * green review alone acts on nothing.
 *
 * The authority model itself is CONSUMED, not re-authored: the external-action
 * vocabulary is the spine's frozen list (the same one the policy module's
 * grant model names), and "the contract cannot request more than the policy
 * grants" is the spine's own `checkContractWithinPolicy`.
 */
import { digestCanonical } from "../digest.ts";
import type { AcceptedContract, OutcomeVerification } from "../spine/contract.ts";
import { checkContractWithinPolicy } from "../spine/contract.ts";
import {
  EXTERNAL_ACTIONS,
  checkMergeReadyAgainstOutcome,
  validateFinishLineResult,
  type ExternalAction,
  type FinishLineResult,
} from "../spine/finish-line.ts";
import type { PolicySnapshot } from "../spine/policy.ts";

/** This unit's refusal record: the spine's shape with a wider code set. */
export interface FinishLineRefusal {
  readonly code: string;
  /** RFC 6901 pointer to the offending value. */
  readonly pointer: string;
  readonly message: string;
}

/** How the external verifier — the hosted statement of the merge-ready rule — resolved. */
export const EXTERNAL_VERIFICATIONS = Object.freeze(["passed", "failed", "unavailable"] as const);
export type ExternalVerification = (typeof EXTERNAL_VERIFICATIONS)[number];

/** The action each finish line beyond merge-ready would have to invoke. */
export const FINISH_LINE_ACTIONS: Readonly<Record<string, ExternalAction | undefined>> = Object.freeze({
  "merge-ready": undefined,
  merge: "merge",
  deploy: "deploy",
});

// ── The authority matrix ───────────────────────────────────────────────────

export interface FinishLineActionInput {
  readonly action: ExternalAction;
  readonly contract: AcceptedContract;
  readonly policy: PolicySnapshot;
  /** The actions the compiled policy requires an approval for. */
  readonly approvalRequiredActions?: readonly string[];
}

export type FinishLineActionAuthorization =
  | { readonly ok: true; readonly nextState: "awaiting_approval" | "acting" }
  | { readonly ok: false; readonly refusals: readonly FinishLineRefusal[] };

/**
 * Is this external action authorized right now? Every rule is a conjunction
 * and each is reported on its own, so the matrix reads as a matrix:
 *
 *   1. the contract may not request beyond the compiled policy — which, once
 *      the action is required to be a REQUESTED authority, also makes an
 *      ungranted action unreachable;
 *   2. a merge-ready finish line authorizes no external action at all;
 *   3. the action must be one the contract actually requested.
 */
export function authorizeFinishLineAction(input: FinishLineActionInput): FinishLineActionAuthorization {
  const refusals: FinishLineRefusal[] = [];

  const withinPolicy = checkContractWithinPolicy(input.contract, input.policy);
  if (!withinPolicy.ok) {
    for (const rejection of withinPolicy.rejections) {
      refusals.push({ code: rejection.code, pointer: rejection.pointer, message: rejection.message });
    }
  }

  if (input.contract.requestedFinishLine === "merge-ready") {
    refusals.push({
      code: "forbidden_action",
      pointer: "/requestedFinishLine",
      message: `a merge-ready finish line authorizes no ${input.action}; a green review alone never creates a pull request, merges, or deploys`,
    });
  }

  if (!input.contract.requestedAuthority.includes(input.action)) {
    refusals.push({
      code: "authority_not_requested",
      pointer: "/requestedAuthority",
      message: `the contract requests no ${input.action} authority; an action nobody asked for is never taken`,
    });
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    nextState: (input.approvalRequiredActions ?? []).includes(input.action) ? "awaiting_approval" : "acting",
  };
}

// ── The operation port ─────────────────────────────────────────────────────

export interface ExternalActionIntent {
  readonly intentId: string;
  readonly action: ExternalAction;
  readonly candidate: { readonly treeSha: string; readonly deliverableDigest: string };
  readonly policyDigest: string;
  readonly approval: "required" | "not-required";
}

export type ExternalActionInvocation =
  | { readonly ok: true; readonly externalReference: string }
  | { readonly ok: false; readonly refusals: readonly FinishLineRefusal[] };

/**
 * The seam a repository's executable merge/deploy adapter binds to. The
 * concrete operations remain repository adapters; this unit owns only the
 * port's shape.
 */
export interface ExternalActionPort {
  invoke(intent: ExternalActionIntent): Promise<ExternalActionInvocation>;
}

/**
 * The port with no adapter bound — the only port this slice ships. An
 * authorized intent still cannot reach an external action through it, which is
 * what makes "authority is modelled, never exercised" mechanical rather than a
 * convention.
 */
export const UNBOUND_EXTERNAL_ACTION_PORT: ExternalActionPort = {
  invoke: (intent) =>
    Promise.resolve({
      ok: false,
      refusals: [
        {
          code: "action_port_unbound",
          pointer: "/action",
          message: `no executable ${intent.action} adapter is bound; external actions are modelled here and invoked by no path in this product slice`,
        },
      ],
    }),
};

// ── The reducer ────────────────────────────────────────────────────────────

export interface FinishLineInput {
  readonly deliveryId: string;
  readonly contract: AcceptedContract;
  readonly policy: PolicySnapshot;
  readonly outcome: OutcomeVerification;
  /** What the tracked-record `recording` transition bound. */
  readonly record: { readonly treeSha: string; readonly baseTipSha: string; readonly digest: string };
  /** The same two values observed now: terminal success is a canonical recheck site. */
  readonly observed: { readonly treeSha: string; readonly baseTipSha: string };
  readonly admission: { readonly admitted: boolean; readonly completedObligations: readonly string[] };
  readonly externalVerification: ExternalVerification;
  /** The product-trust level, read verbatim from the substrate. */
  readonly declaredProductTrustLabel: string;
  readonly approvalRequiredActions?: readonly string[];
}

export type FinishLineDecision =
  | { readonly kind: "completed"; readonly result: FinishLineResult }
  | { readonly kind: "awaiting_approval"; readonly action: ExternalAction }
  | { readonly kind: "acting"; readonly action: ExternalAction }
  | { readonly kind: "blocked"; readonly refusals: readonly FinishLineRefusal[] };

export function decideFinishLine(input: FinishLineInput): FinishLineDecision {
  const requested = input.contract.requestedFinishLine;

  // A finish line beyond merge-ready never terminates here: it is authorized
  // into its post-action state and stops, because no action is invocable.
  const action = FINISH_LINE_ACTIONS[requested];
  if (action !== undefined) {
    const authorized = authorizeFinishLineAction({
      action,
      contract: input.contract,
      policy: input.policy,
      ...(input.approvalRequiredActions === undefined ? {} : { approvalRequiredActions: input.approvalRequiredActions }),
    });
    return authorized.ok ? { kind: authorized.nextState, action } : { kind: "blocked", refusals: authorized.refusals };
  }

  const refusals: FinishLineRefusal[] = [];

  const withinPolicy = checkContractWithinPolicy(input.contract, input.policy);
  if (!withinPolicy.ok) {
    for (const rejection of withinPolicy.rejections) {
      refusals.push({ code: rejection.code, pointer: rejection.pointer, message: rejection.message });
    }
  }

  if (!input.admission.admitted) {
    refusals.push({
      code: "admission_incomplete",
      pointer: "/admission",
      message: "the candidate was never admitted; merge-readiness is admission plus recording, never recording alone",
    });
  }

  // Base and candidate movement invalidates readiness. The recording
  // transition bound both; terminal success rebinds them.
  if (input.observed.treeSha !== input.record.treeSha) {
    refusals.push({
      code: "candidate_moved",
      pointer: "/observed/treeSha",
      message: `the candidate is at ${input.observed.treeSha}; the recording transition bound ${input.record.treeSha}`,
    });
  }
  if (input.observed.baseTipSha !== input.record.baseTipSha) {
    refusals.push({
      code: "base_moved",
      pointer: "/observed/baseTipSha",
      message: `the base tip is at ${input.observed.baseTipSha}; the recording transition bound ${input.record.baseTipSha}`,
    });
  }

  // LOCAL merge-ready evidence: every policy obligation carries a completed
  // result, and an empty set is never merge-ready — vacuous satisfaction is
  // excluded here as it is at review and admission.
  const completed = new Set(input.admission.completedObligations);
  for (const obligation of input.policy.obligations) {
    if (!completed.has(obligation.obligationId)) {
      refusals.push({
        code: "obligation_unsatisfied",
        pointer: "/admission/completedObligations",
        message: `repository merge-ready obligation ${obligation.obligationId} carries no completed result`,
      });
    }
  }
  if (input.admission.completedObligations.length === 0) {
    refusals.push({
      code: "obligation_unsatisfied",
      pointer: "/admission/completedObligations",
      message: "no obligation completed; merge-readiness cannot be passed by absence",
    });
  }

  // HOSTED merge-ready evidence: the external verifier's own statement.
  if (input.externalVerification !== "passed") {
    refusals.push({
      code: "external_verification_missing",
      pointer: "/externalVerification",
      message: `the external verifier resolved ${input.externalVerification}; merge-readiness requires its passing result`,
    });
  }

  if (refusals.length > 0) return { kind: "blocked", refusals };

  const result = {
    spec: "finish-line-result/1",
    finishLine: "merge-ready",
    deliveryId: input.deliveryId,
    candidate: { ...input.outcome.candidate },
    recordedCandidate: { treeSha: input.record.treeSha, baseTipSha: input.record.baseTipSha },
    policyDigest: input.policy.policyDigest,
    completedObligations: [...input.admission.completedObligations],
    trackedRecordDigest: input.record.digest,
    externalVerification: "passed",
    productTrustLabel: input.declaredProductTrustLabel,
    outcomeVerificationDigest: digestCanonical(input.outcome),
    mergeReadyObligationsSatisfied: true,
  } as FinishLineResult;

  // The composed result is re-checked through the spine's own rules before it
  // is handed out: a result the spine would refuse is never journaled. This is
  // also where a product-trust level the substrate did not declare rejects —
  // the grammar admits exactly one spelling.
  const shape = validateFinishLineResult(result);
  if (!shape.ok) {
    return { kind: "blocked", refusals: shape.rejections.map((rejection) => ({ ...rejection })) };
  }
  const cross = checkMergeReadyAgainstOutcome(result, input.outcome);
  if (!cross.ok) {
    return { kind: "blocked", refusals: cross.rejections.map((rejection) => ({ ...rejection })) };
  }
  return { kind: "completed", result };
}
