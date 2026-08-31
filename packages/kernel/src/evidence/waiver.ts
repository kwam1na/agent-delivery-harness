/**
 * The waiver doctrine. A waiver is not an evidence shortcut and not a
 * disposition an agent can write for itself.
 *
 * EVERY WAIVER IS A SENSITIVE APPROVAL. An authorized repository role proposes
 * one — actor identity, reason, exact criterion — and the proposal is only a
 * proposal. It becomes valid when the delivery-bound sensitive-approval
 * assertion frozen by the composition-lifecycle unit is consumed against it:
 * one fresh model-external interactive evaluation, bound to delivery,
 * candidate, policy, both revocation epochs, the invocation fence, action,
 * expiry, and a single-use nonce. This module re-authors none of that contract;
 * it consumes it and adds only the rules a waiver needs on top.
 *
 * AN AGENT CANNOT PROPOSE AND APPROVE. The approving identity is carried in the
 * assertion's origin — the disclosure the interactive evaluation showed — and
 * an origin naming the proposing actor is refused outright. The assertion is
 * non-model-mintable by construction; the distinctness rule closes the
 * remaining case where the same authorized identity plays both parts.
 *
 * WHO DECIDES THAT AN OUTCOME CHANGED. Never the proposing agent. The
 * classification rides the approving action: `waive-criterion` records a
 * criterion the delivery proceeds without, while `confirm-outcome-amendment`
 * says the intended outcome itself moved — and that action is consumable only
 * from an origin the compiled policy declared an outcome authority. Absence of
 * a declared authority is denial, so a repository that declares none simply
 * cannot amend an outcome mid-delivery.
 *
 * BLANKET WAIVERS PRODUCE NOTHING. `checkPositiveCriterion` is the admission-
 * side statement of the rule the merge-ready finish line also enforces: at
 * least one acceptance criterion must have actually PASSED. An empty criterion
 * set fails it too — success is never passed by absence.
 */
import { validateSensitiveApprovalAssertion } from "../spine/assertion.ts";
import type { OutcomeCriterion } from "../spine/contract.ts";
import type { DeliveryState } from "../spine/vocabulary.ts";

/** The two approving actions, and the whole difference between them. */
export const WAIVER_ACTIONS = Object.freeze(["waive-criterion", "confirm-outcome-amendment"] as const);
export type WaiverAction = (typeof WAIVER_ACTIONS)[number];

/** The approving identity the assertion origin carries, and its prefix. */
export const WAIVER_APPROVAL_ORIGIN_PREFIX = "waiver-approval:";

/** The three states a proposal can be consumed in; anything later is post-admission. */
const CONSUMABLE_STATES: readonly DeliveryState[] = ["reviewing", "remediating", "admitting"];

export interface WaiverProposal {
  readonly requestKind: "waiver" | "amendment";
  readonly criterionId: string;
  readonly actorId: string;
  /** The candidate the proposal was made against; a later candidate stales it. */
  readonly candidateTreeSha: string;
}

export interface WaiverConsumptionContext {
  readonly deliveryId: string;
  readonly deliveryState: DeliveryState;
  readonly candidateTreeSha: string;
  readonly policyDigest: string;
  readonly productTrustRevocationEpoch: number;
  readonly repositoryAuthorityRevocationEpoch: number;
  readonly invocationFence: number;
  /** The pending proposal this consumption answers, when one is pending. */
  readonly proposal: WaiverProposal | undefined;
  readonly contractCriterionIds: readonly string[];
  /** Identities policy declared able to confirm an outcome amendment; empty is denial. */
  readonly outcomeAuthorities: readonly string[];
  readonly currentProfile: string;
  readonly consumedNonces: ReadonlySet<string>;
  /** The caller-observed instant; this module never reads a clock. */
  readonly now: string;
}

export interface WaiverRefusal {
  readonly code: string;
  readonly message: string;
}

export type WaiverConsumptionVerdict =
  | { readonly ok: true; readonly outcomeChanging: boolean; readonly criterionId: string }
  | { readonly ok: false; readonly blockers: readonly WaiverRefusal[] };

/** The approving identity an assertion origin names, when it names one. */
function approverOf(origin: unknown): string | undefined {
  if (typeof origin !== "string" || !origin.startsWith(WAIVER_APPROVAL_ORIGIN_PREFIX)) return undefined;
  // An empty or blank identity names nobody: it would pass the distinctness
  // rule against any real proposer while approving in nobody's name.
  const approver = origin.slice(WAIVER_APPROVAL_ORIGIN_PREFIX.length).trim();
  return approver.length > 0 ? approver : undefined;
}

export function evaluateWaiverConsumption(
  assertion: Record<string, unknown>,
  context: WaiverConsumptionContext,
): WaiverConsumptionVerdict {
  const blockers: WaiverRefusal[] = [];
  const refuse = (code: string, message: string): void => {
    blockers.push({ code, message });
  };

  const shape = validateSensitiveApprovalAssertion(assertion);
  if (!shape.ok || assertion["assertionClass"] !== "delivery-bound") {
    refuse("assertion_malformed", "the presented value is not a well-formed delivery-bound sensitive-approval assertion");
    return { ok: false, blockers };
  }

  const action = assertion["action"];
  if (typeof action !== "string" || !(WAIVER_ACTIONS as readonly string[]).includes(action)) {
    refuse("assertion_mismatch", `the assertion approves ${String(action)}, which is not a waiver action`);
    return { ok: false, blockers };
  }

  if (assertion["deliveryId"] !== context.deliveryId) {
    refuse("assertion_mismatch", "the assertion binds a different delivery");
  }
  if (assertion["candidateTreeSha"] !== context.candidateTreeSha) {
    refuse("assertion_mismatch", "the assertion binds a different candidate; a waiver is candidate-bound evidence");
  }
  if (assertion["policyDigest"] !== context.policyDigest) {
    refuse("assertion_mismatch", "the assertion binds a different compiled policy snapshot");
  }
  if (assertion["invocationFence"] !== context.invocationFence) {
    refuse("assertion_mismatch", "the assertion binds a superseded invocation fence");
  }
  if (assertion["productTrustRevocationEpoch"] !== context.productTrustRevocationEpoch) {
    refuse("assertion_stale", "the assertion was evaluated under a superseded product-trust revocation epoch");
  }
  if (assertion["repositoryAuthorityRevocationEpoch"] !== context.repositoryAuthorityRevocationEpoch) {
    refuse("assertion_stale", "the assertion was evaluated under a superseded repository authority-revocation epoch");
  }
  const expiry = assertion["expiry"];
  if (typeof expiry !== "string" || expiry < context.now) {
    refuse("assertion_stale", "the assertion expired; an expired evaluation is a cached credential, treated as invalid");
  }
  const nonce = assertion["nonce"];
  if (typeof nonce === "string" && context.consumedNonces.has(nonce)) {
    refuse("assertion_replayed", `nonce ${nonce} was already consumed by this delivery journal`);
  }
  if (assertion["assertionSource"] === "qualification-fixture" && context.currentProfile !== "confirmation-fixture") {
    refuse("assertion_source_mismatch", "a fixture-sourced assertion can never approve a waiver on a production installation");
  }

  // Waivers after admission are rejected: past `admitting` there is no review
  // context left to waive against, and the admitted evidence already stands.
  if (!CONSUMABLE_STATES.includes(context.deliveryState)) {
    refuse(
      "waiver_after_admission",
      `a waiver is consumed within ${CONSUMABLE_STATES.join(", ")}; the delivery is in ${context.deliveryState}`,
    );
  }

  const proposal = context.proposal;
  if (proposal === undefined) {
    refuse("waiver_unproposed", "no pending proposal is journaled for this delivery; a waiver is never self-standing");
    return { ok: false, blockers };
  }
  if (!context.contractCriterionIds.includes(proposal.criterionId)) {
    refuse("waiver_criterion_unknown", `criterion ${proposal.criterionId} is not an acceptance criterion of this contract`);
  }
  if (proposal.candidateTreeSha !== context.candidateTreeSha) {
    refuse(
      "waiver_proposal_stale",
      "the candidate changed since the proposal was journaled; the criterion binding is re-evaluated and the stale proposal voids",
    );
  }

  const approver = approverOf(assertion["origin"]);
  if (approver === undefined) {
    refuse("waiver_approver_unnamed", `the assertion origin does not name an approving identity (${WAIVER_APPROVAL_ORIGIN_PREFIX}<id>)`);
  } else if (approver === proposal.actorId) {
    refuse("waiver_self_approved", `${approver} both proposed and approved this waiver; an agent cannot propose and approve`);
  }

  const outcomeChanging = action === "confirm-outcome-amendment";
  if (outcomeChanging && (approver === undefined || !context.outcomeAuthorities.includes(approver))) {
    refuse(
      "outcome_authority_missing",
      `confirming that the intended outcome changed requires a policy-declared outcome authority; ${String(approver)} is not one`,
    );
  }

  return blockers.length === 0 ? { ok: true, outcomeChanging, criterionId: proposal.criterionId } : { ok: false, blockers };
}

export type PositiveCriterionVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly blockers: readonly WaiverRefusal[] };

/**
 * The admission-side blanket-waiver rule: at least one acceptance criterion
 * must have PASSED. Every criterion waived, or no criterion at all, is not a
 * delivery that succeeded.
 */
export function checkPositiveCriterion(criteria: readonly OutcomeCriterion[]): PositiveCriterionVerdict {
  if (criteria.some((criterion) => criterion.disposition === "passed")) return { ok: true };
  return {
    ok: false,
    blockers: [
      {
        code: "blanket_waiver",
        message:
          "no acceptance criterion passed; a blanket waiver cannot produce delivery success, and an empty criterion set cannot pass by absence",
      },
    ],
  };
}
