/**
 * SEPARATELY AUTHORIZED MERGE AND DEPLOYMENT ACTIONS.
 *
 * The merge-ready unit decides WHETHER a delivery may act and stops there.
 * This unit owns the only sequence by which acting ever actually happens, and
 * every rule in it exists because an external action is irreversible:
 *
 *   1. BIND, then persist, then invoke. An authorized action first becomes a
 *      BOUND INTENT — actor, delivery, invocation fence, candidate, policy,
 *      both revocation epochs, requested finish line, the adapter that will be
 *      called, the action chain so far, and the hosted and local evidence as
 *      they stand. The intent is journaled BEFORE the adapter is called, so an
 *      action can never be observed without a prior statement of what was
 *      about to happen.
 *   2. REVALIDATE IMMEDIATELY BEFORE THE CALL. Authorization decided earlier
 *      is not authorization now: the fence, the product-trust epoch, the
 *      repository authority (through the policy module's canonical recheck),
 *      the candidate and the base are all rechecked against the values the
 *      intent bound, in the same breath as the invocation. A revocation
 *      observed here blocks even though the delivery is already `acting`.
 *   3. INVOKE ONCE. `invokeExternalActionOnce` calls the port exactly once and
 *      turns a thrown or lost response into the `indeterminate` outcome rather
 *      than into a retry. It has no retry in it at all — retrying is not this
 *      function's decision to make.
 *   4. RECONCILE BEFORE RETRY. An indeterminate action is reconciled through a
 *      `status-reconciliation` observation, never by trying again to see what
 *      happens. Reconciliation that finds the action already performed forbids
 *      the replay outright; reconciliation that cannot tell also forbids it.
 *      Only a reconciliation that positively establishes the action did NOT
 *      happen authorizes a second intent, and that intent is a NEW intent with
 *      its own id — never the first one replayed.
 *   5. SUCCESS PLUS FAILED VERIFICATION IS ITS OWN STATE. An action that
 *      succeeded whose required post-action verification failed enters
 *      `action_succeeded_verification_failed`. The action is never replayed
 *      from there; the only moves are the containment the policy itself
 *      selected.
 *
 * THE CREDENTIAL NEVER REACHES THE MODEL-DRIVEN TASK. Every external action is
 * a privileged capability kind, which is what excludes its credential from the
 * execution grant; this unit adds the second half of that guarantee by
 * carrying no credential material in the intent it builds. The adapter is
 * named by `capabilityId`, and the binding is asserted to hold a credential
 * only so the absence of one can be refused — the value itself is never read,
 * copied, or journaled here.
 *
 * THE AUTHORITY MODEL IS STILL NOT RE-AUTHORED HERE. The canonical recheck —
 * "is this action authorized right now?", epochs and revocations included — is
 * the policy module's `checkActionAuthorization`, and this unit imports it from
 * nowhere: the caller passes it in as `recheckAuthority`, and this unit CALLS
 * it during revalidation rather than accepting a verdict computed earlier. A
 * verdict handed in already-computed could have been computed before the fence
 * was taken; a function called here cannot have been.
 *
 * WHAT THIS UNIT DOES NOT DO. It binds no adapter. `UNBOUND_EXTERNAL_ACTION_PORT`
 * remains the only port the product ships, so a repository that binds nothing
 * still cannot act; what changes is that the sequence an adapter would run
 * through is now specified and falsifiable rather than absent.
 */
import { digestCanonical } from "../digest.ts";
import type { PolicyCapabilityKind } from "../policy/capabilities.ts";
import { validateSensitiveApprovalAssertion } from "../spine/assertion.ts";
import type { AcceptedContract } from "../spine/contract.ts";
import { EXTERNAL_ACTIONS, type ExternalAction } from "../spine/finish-line.ts";
import {
  ABSENT_BY_STATE,
  boundedText,
  checkClosed,
  closed,
  createSpineCollector,
  gitOid,
  nonNegativeInt,
  oneOf,
  orAbsentByState,
  positiveInt,
  sha256,
  specLiteral,
  spineId,
  type MemberRule,
  type SpineVerdict,
} from "../spine/grammar.ts";
import { ACTION_APPROVALS, ACTION_VERIFICATIONS, EXTERNAL_ACTION_OUTCOMES } from "../spine/journal.ts";
import type { PolicySnapshot } from "../spine/policy.ts";
import type { DeliveryState } from "../spine/vocabulary.ts";
import {
  authorizeFinishLineAction,
  type ExternalActionIntent,
  type ExternalActionPort,
  type FinishLineRefusal,
} from "./merge-ready.ts";

type ActionApproval = (typeof ACTION_APPROVALS)[number];
type ExternalActionOutcome = (typeof EXTERNAL_ACTION_OUTCOMES)[number];
type ActionVerification = (typeof ACTION_VERIFICATIONS)[number];

/** The approving identity an action approval's origin carries, and its prefix. */
export const ACTION_APPROVAL_ORIGIN_PREFIX = "action-approval:";

const refusal = (code: string, pointer: string, message: string): FinishLineRefusal => ({ code, pointer, message });

// ── The action chain ───────────────────────────────────────────────────────

/**
 * One link of the chain: an action this delivery already took, and how it
 * came out. The chain is what makes an approval unusable for a DIFFERENT
 * action sequence than the one it was shown — approving a deploy after one
 * merge is not approving a deploy after a merge, a failure, and a second
 * merge.
 */
export interface ActionChainLink {
  readonly intentId: string;
  readonly action: ExternalAction;
  readonly outcome: ExternalActionOutcome;
  readonly verification: ActionVerification;
}

/** The digest of the ordered chain plus the action about to be taken. */
export function actionChainDigest(chain: readonly ActionChainLink[], next: ExternalAction): string {
  return digestCanonical({
    chain: chain.map((link) => ({
      intentId: link.intentId,
      action: link.action,
      outcome: link.outcome,
      verification: link.verification,
    })),
    next,
  });
}

// ── The approval ───────────────────────────────────────────────────────────

export interface ActionApprovalContext {
  readonly deliveryId: string;
  readonly action: ExternalAction;
  readonly candidateTreeSha: string;
  readonly policyDigest: string;
  readonly invocationFence: number;
  readonly productTrustRevocationEpoch: number;
  readonly repositoryAuthorityRevocationEpoch: number;
  /**
   * The chain digest this action is about to be taken under. The approval was
   * requested against a chain, and an approval shown for "merge, first
   * attempt" is not an approval for "merge, after an attempt that failed for a
   * reason nobody has looked at". `sensitive-approval-assertion/1` is a closed
   * grammar with no chain member, so the comparison is against the digest the
   * delivery recorded when the approval was requested, carried here.
   */
  readonly actionChainDigest: string;
  readonly approvedChainDigest: string;
  /** The identity the agent task runs as; it may never approve its own action. */
  readonly actingActorId: string;
  /** Nonces this delivery's journal already consumed, for replay refusal. */
  readonly consumedNonces: ReadonlySet<string>;
  readonly currentProfile: string;
  /** The caller-observed instant; this module never reads a clock. */
  readonly now: string;
}

export type ActionApprovalVerdict =
  | { readonly ok: true; readonly approverId: string; readonly nonce: string }
  | { readonly ok: false; readonly refusals: readonly FinishLineRefusal[] };

const approverOf = (origin: unknown): string | undefined => {
  if (typeof origin !== "string" || !origin.startsWith(ACTION_APPROVAL_ORIGIN_PREFIX)) return undefined;
  const approver = origin.slice(ACTION_APPROVAL_ORIGIN_PREFIX.length).trim();
  return approver.length > 0 ? approver : undefined;
};

/**
 * Consumes one non-model-mintable approval for one external action. Every
 * binding the acceptance criterion names — candidate, policy, both epochs,
 * fence — is compared, and the delivery, the action, the expiry, the nonce and
 * the source are compared beside them. An approval that matches on everything
 * but the action approves nothing: it was shown for a different decision.
 */
export function evaluateActionApproval(
  assertion: Record<string, unknown>,
  context: ActionApprovalContext,
): ActionApprovalVerdict {
  const refusals: FinishLineRefusal[] = [];
  const refuse = (code: string, pointer: string, message: string): void => {
    refusals.push(refusal(code, pointer, message));
  };

  const shape = validateSensitiveApprovalAssertion(assertion);
  if (!shape.ok || assertion["assertionClass"] !== "delivery-bound") {
    refuse(
      "approval_malformed",
      "/assertion",
      "the presented value is not a well-formed delivery-bound sensitive-approval assertion",
    );
    return { ok: false, refusals };
  }

  if (assertion["action"] !== context.action) {
    refuse(
      "approval_mismatch",
      "/action",
      `the approval was shown for ${String(assertion["action"])}, not for ${context.action}; an approval is per-action`,
    );
    return { ok: false, refusals };
  }

  if (assertion["deliveryId"] !== context.deliveryId) {
    refuse("approval_mismatch", "/deliveryId", "the approval binds a different delivery");
  }
  if (assertion["candidateTreeSha"] !== context.candidateTreeSha) {
    refuse(
      "approval_mismatch",
      "/candidateTreeSha",
      "the approval binds a different candidate; a candidate that moved was never the one approved",
    );
  }
  if (assertion["policyDigest"] !== context.policyDigest) {
    refuse("approval_mismatch", "/policyDigest", "the approval binds a different compiled policy snapshot");
  }
  if (assertion["invocationFence"] !== context.invocationFence) {
    refuse("approval_mismatch", "/invocationFence", "the approval binds a superseded invocation fence");
  }
  if (context.approvedChainDigest !== context.actionChainDigest) {
    refuse(
      "approval_mismatch",
      "/actionChainDigest",
      "the approval was shown for a different action chain; the sequence that reached this action is not the one that was approved",
    );
  }
  if (assertion["productTrustRevocationEpoch"] !== context.productTrustRevocationEpoch) {
    refuse("approval_stale", "/productTrustRevocationEpoch", "the approval predates the current product-trust revocation epoch");
  }
  if (assertion["repositoryAuthorityRevocationEpoch"] !== context.repositoryAuthorityRevocationEpoch) {
    refuse(
      "approval_stale",
      "/repositoryAuthorityRevocationEpoch",
      "the approval predates the current repository authority-revocation epoch",
    );
  }
  const expiry = assertion["expiry"];
  if (typeof expiry !== "string" || expiry < context.now) {
    refuse("approval_stale", "/expiry", "the approval expired; an expired evaluation is a cached credential, treated as invalid");
  }
  const nonce = assertion["nonce"];
  if (typeof nonce === "string" && context.consumedNonces.has(nonce)) {
    refuse("approval_replayed", "/nonce", `nonce ${nonce} was already consumed by this delivery journal`);
  }
  if (assertion["assertionSource"] === "qualification-fixture" && context.currentProfile !== "confirmation-fixture") {
    refuse(
      "approval_source_mismatch",
      "/assertionSource",
      "a fixture-sourced approval can never authorize a real external action on a production installation",
    );
  }
  const approver = approverOf(assertion["origin"]);
  if (approver === undefined) {
    refuse(
      "approval_unattributed",
      "/origin",
      `the approval names no approving identity; its origin must read ${ACTION_APPROVAL_ORIGIN_PREFIX}<identity>`,
    );
  } else if (approver === context.actingActorId) {
    refuse(
      "approval_not_distinct",
      "/origin",
      "the acting identity approved its own external action; proposing and approving are never the same party",
    );
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, approverId: approver as string, nonce: nonce as string };
}

// ── The bound intent ───────────────────────────────────────────────────────

/** The adapter the action will be invoked through. No credential travels here. */
export interface ActionAdapterBinding {
  readonly capabilityId: string;
  readonly kind: PolicyCapabilityKind;
  /** Whether the compiled policy bound a credential to this adapter. */
  readonly hasCredential: boolean;
}

/** The hosted and local evidence as it stands at the moment of binding. */
export interface ActionEvidence {
  readonly externalVerification: "passed" | "failed" | "unavailable";
  readonly completedObligations: readonly string[];
}

export interface PlanExternalActionInput {
  readonly deliveryId: string;
  readonly intentId: string;
  readonly action: ExternalAction;
  readonly contract: AcceptedContract;
  readonly policy: PolicySnapshot;
  readonly approvalRequiredActions?: readonly string[];
  /** The approval assertion, when policy requires one for this action. */
  readonly approval?: Record<string, unknown>;
  /**
   * The chain digest the delivery recorded when this approval was requested.
   * Required exactly when `approval` is presented.
   */
  readonly approvedChainDigest?: string;
  readonly actingActorId: string;
  readonly invocationFence: number;
  readonly candidate: { readonly treeSha: string; readonly deliverableDigest: string };
  readonly baseTipSha: string;
  readonly record: { readonly treeSha: string; readonly baseTipSha: string; readonly digest: string };
  readonly adapter: ActionAdapterBinding;
  readonly evidence: ActionEvidence;
  readonly chain: readonly ActionChainLink[];
  readonly consumedNonces: ReadonlySet<string>;
  readonly currentProfile: string;
  readonly now: string;
}

/**
 * Everything the invocation is bound to. The journaled intent is the small
 * frozen subset of this — `journalIntentPayload` produces exactly it — while
 * the rest is what the pre-invocation recheck compares against.
 */
export interface BoundActionIntent {
  readonly intentId: string;
  readonly deliveryId: string;
  readonly action: ExternalAction;
  readonly actingActorId: string;
  readonly approval: ActionApproval;
  readonly approverId?: string;
  readonly candidate: { readonly treeSha: string; readonly deliverableDigest: string };
  readonly baseTipSha: string;
  readonly policyDigest: string;
  readonly invocationFence: number;
  readonly productTrustRevocationEpoch: number;
  readonly repositoryAuthorityRevocationEpoch: number;
  readonly requestedFinishLine: string;
  readonly adapterCapabilityId: string;
  readonly actionChainDigest: string;
  readonly evidence: ActionEvidence;
  readonly trackedRecordDigest: string;
}

/**
 * The actions a requested finish line reaches, in the order they are taken.
 * `merge-ready` reaches none — it is where the merge-ready unit stops — and
 * `deploy` reaches the merge first, because `checkDeployPreconditions` refuses
 * a deploy that does not follow a succeeded, verified merge.
 */
const FINISH_LINE_REACHED_ACTIONS: Readonly<Record<string, readonly ExternalAction[]>> = Object.freeze({
  "merge-ready": Object.freeze([] as readonly ExternalAction[]),
  merge: Object.freeze(["merge"] as readonly ExternalAction[]),
  deploy: Object.freeze(["merge", "deploy"] as readonly ExternalAction[]),
});

const finishLineReaches = (requestedFinishLine: string, action: ExternalAction): boolean =>
  (FINISH_LINE_REACHED_ACTIONS[requestedFinishLine] ?? []).includes(action);

export type PlanExternalActionVerdict =
  | { readonly ok: true; readonly intent: BoundActionIntent }
  | { readonly ok: false; readonly refusals: readonly FinishLineRefusal[] };

/**
 * Binds one authorized action to everything that authorized it. Refuses for
 * the authority matrix's reasons, for an adapter that cannot execute the
 * action, for evidence that no longer stands, and — where policy requires an
 * approval — for every way an approval can fail to be this action's approval.
 */
export function planExternalAction(input: PlanExternalActionInput): PlanExternalActionVerdict {
  const refusals: FinishLineRefusal[] = [];

  const authorized = authorizeFinishLineAction({
    action: input.action,
    contract: input.contract,
    policy: input.policy,
    ...(input.approvalRequiredActions === undefined ? {} : { approvalRequiredActions: input.approvalRequiredActions }),
  });
  if (!authorized.ok) refusals.push(...authorized.refusals);

  // The finish line the contract requested has to REACH this action. A merge
  // contract never reaches a deploy through a wider grant; a deploy contract
  // does reach the merge it deploys, because the deploy preconditions in this
  // same file require that merge to have been taken and reconciled. Equality
  // here would make a deploy contract's merge unplannable and therefore its
  // own deploy preconditions permanently unsatisfiable.
  if (!finishLineReaches(input.contract.requestedFinishLine, input.action)) {
    refusals.push(
      refusal(
        "action_finish_line_mismatch",
        "/action",
        `the contract requests the ${input.contract.requestedFinishLine} finish line, which is not served by ${input.action}`,
      ),
    );
  }

  // The adapter must be bound for this exact action and hold a credential.
  // The credential VALUE is never read here — only its presence, so that its
  // absence refuses rather than surfacing at the adapter as a runtime error.
  if (input.adapter.kind !== input.action) {
    refusals.push(
      refusal(
        "adapter_contract_mismatch",
        "/adapter/kind",
        `adapter ${input.adapter.capabilityId} is bound as ${input.adapter.kind}; it cannot perform a ${input.action}`,
      ),
    );
  }
  if (!input.adapter.hasCredential) {
    refusals.push(
      refusal(
        "adapter_credential_absent",
        "/adapter",
        `adapter ${input.adapter.capabilityId} binds no credential; the acting task holds none of its own and cannot supply one`,
      ),
    );
  }

  // The evidence that made the delivery merge-ready still has to stand.
  if (input.evidence.externalVerification !== "passed") {
    refusals.push(
      refusal(
        "external_verification_missing",
        "/evidence/externalVerification",
        `the external verifier resolved ${input.evidence.externalVerification}; an action stands on the same hosted evidence merge-readiness does`,
      ),
    );
  }
  // Every obligation the CURRENT policy carries, not merely a non-empty set:
  // a policy recompiled between merge-readiness and the action can add one,
  // and the merge-ready reducer's per-obligation check has to keep standing at
  // the moment the irreversible call is made.
  const completedObligations = new Set(input.evidence.completedObligations);
  for (const obligation of input.policy.obligations) {
    if (!completedObligations.has(obligation.obligationId)) {
      refusals.push(
        refusal(
          "obligation_unsatisfied",
          "/evidence/completedObligations",
          `repository obligation ${obligation.obligationId} carries no completed result`,
        ),
      );
    }
  }
  if (input.evidence.completedObligations.length === 0) {
    refusals.push(
      refusal(
        "obligation_unsatisfied",
        "/evidence/completedObligations",
        "no obligation completed; an external action is never passed by absence",
      ),
    );
  }
  if (input.candidate.treeSha !== input.record.treeSha) {
    refusals.push(
      refusal(
        "candidate_moved",
        "/candidate/treeSha",
        `the candidate is at ${input.candidate.treeSha}; the recording transition bound ${input.record.treeSha}`,
      ),
    );
  }
  if (input.baseTipSha !== input.record.baseTipSha) {
    refusals.push(
      refusal(
        "base_moved",
        "/baseTipSha",
        `the base tip is at ${input.baseTipSha}; the tracked record binds ${input.record.baseTipSha}`,
      ),
    );
  }

  const chainDigest = actionChainDigest(input.chain, input.action);
  const approvalRequired = (input.approvalRequiredActions ?? []).includes(input.action);
  let approverId: string | undefined;
  if (approvalRequired) {
    if (input.approval === undefined) {
      refusals.push(
        refusal("approval_absent", "/approval", `policy requires an approval for ${input.action} and none was presented`),
      );
    } else {
      const verdict = evaluateActionApproval(input.approval, {
        deliveryId: input.deliveryId,
        actionChainDigest: chainDigest,
        approvedChainDigest: input.approvedChainDigest ?? ABSENT_BY_STATE,
        action: input.action,
        candidateTreeSha: input.candidate.treeSha,
        policyDigest: input.policy.policyDigest,
        invocationFence: input.invocationFence,
        productTrustRevocationEpoch: input.policy.productTrustRevocationEpoch,
        repositoryAuthorityRevocationEpoch: input.policy.repositoryAuthorityRevocationEpoch,
        actingActorId: input.actingActorId,
        consumedNonces: input.consumedNonces,
        currentProfile: input.currentProfile,
        now: input.now,
      });
      if (verdict.ok) approverId = verdict.approverId;
      else refusals.push(...verdict.refusals);
    }
  } else if (input.approval !== undefined) {
    // An approval nobody required is not a bonus; it is evidence that
    // something disagrees about what this action needs.
    refusals.push(
      refusal(
        "approval_unexpected",
        "/approval",
        `policy requires no approval for ${input.action}; presenting one means the caller and the policy disagree about this action`,
      ),
    );
  }

  if (refusals.length > 0) return { ok: false, refusals };

  return {
    ok: true,
    intent: {
      intentId: input.intentId,
      deliveryId: input.deliveryId,
      action: input.action,
      actingActorId: input.actingActorId,
      approval: approvalRequired ? "required" : "not-required",
      ...(approverId === undefined ? {} : { approverId }),
      candidate: { ...input.candidate },
      baseTipSha: input.baseTipSha,
      policyDigest: input.policy.policyDigest,
      invocationFence: input.invocationFence,
      productTrustRevocationEpoch: input.policy.productTrustRevocationEpoch,
      repositoryAuthorityRevocationEpoch: input.policy.repositoryAuthorityRevocationEpoch,
      requestedFinishLine: input.contract.requestedFinishLine,
      adapterCapabilityId: input.adapter.capabilityId,
      actionChainDigest: chainDigest,
      evidence: { externalVerification: input.evidence.externalVerification, completedObligations: [...input.evidence.completedObligations] },
      trackedRecordDigest: input.record.digest,
    },
  };
}

/** Exactly the frozen `action.intent.recorded` payload, and nothing else. */
export function journalIntentPayload(intent: BoundActionIntent): ExternalActionIntent {
  return {
    intentId: intent.intentId,
    action: intent.action,
    candidate: { treeSha: intent.candidate.treeSha, deliverableDigest: intent.candidate.deliverableDigest },
    policyDigest: intent.policyDigest,
    approval: intent.approval,
  };
}

// ── The pre-invocation recheck ─────────────────────────────────────────────

export interface RevalidationObservation {
  readonly invocationFence: number;
  readonly productTrustRevocationEpoch: number;
  readonly candidateTreeSha: string;
  readonly baseTipSha: string;
  /**
   * The hosted evidence as it stands NOW. A required hosted check that turns
   * red between the bind and the call is as much a reason to stop as a fence
   * that moved, and it is at least as mutable as the candidate sha.
   */
  readonly externalVerification: "passed" | "failed" | "unavailable";
  /**
   * The policy module's canonical action-authorization recheck, passed as a
   * function and CALLED during revalidation. This unit authors no authority
   * model: it only insists the check happen at the moment of the call rather
   * than at some earlier, more convenient moment.
   */
  readonly recheckAuthority: () => AuthorityRecheckVerdict;
}

/** Exactly the shape `checkActionAuthorization` returns; nothing is re-derived from it. */
export type AuthorityRecheckVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejections: readonly { readonly code: string; readonly pointer: string; readonly message: string }[] };

/**
 * The recheck that runs in the same breath as the invocation. It repeats work
 * `planExternalAction` already did, deliberately: between binding and calling,
 * a fence can be superseded, an epoch can advance, authority can be revoked,
 * and the candidate or base can move — and any of those makes the authorization
 * this intent carries no longer true.
 */
export function revalidateBeforeInvoke(
  intent: BoundActionIntent,
  observed: RevalidationObservation,
): { readonly ok: true } | { readonly ok: false; readonly refusals: readonly FinishLineRefusal[] } {
  const refusals: FinishLineRefusal[] = [];

  if (observed.invocationFence !== intent.invocationFence) {
    refusals.push(
      refusal(
        "fence_superseded",
        "/invocationFence",
        `the live fence is ${observed.invocationFence}; this intent was bound under ${intent.invocationFence} and another host now holds the delivery`,
      ),
    );
  }
  if (observed.productTrustRevocationEpoch !== intent.productTrustRevocationEpoch) {
    refusals.push(
      refusal(
        "product_trust_stale",
        "/productTrustRevocationEpoch",
        `product trust is at epoch ${observed.productTrustRevocationEpoch}; this intent was bound under ${intent.productTrustRevocationEpoch}`,
      ),
    );
  }
  if (observed.candidateTreeSha !== intent.candidate.treeSha) {
    refusals.push(refusal("candidate_moved", "/candidate/treeSha", "the candidate moved after the intent was bound"));
  }
  if (observed.baseTipSha !== intent.baseTipSha) {
    refusals.push(refusal("base_moved", "/baseTipSha", "the base moved after the intent was bound"));
  }
  if (observed.externalVerification !== "passed") {
    refusals.push(
      refusal(
        "external_verification_missing",
        "/externalVerification",
        `the external verifier now resolves ${observed.externalVerification}; hosted evidence that stopped standing stops the call it was standing under`,
      ),
    );
  }

  const authority = observed.recheckAuthority();
  if (!authority.ok) {
    for (const rejection of authority.rejections) {
      refusals.push(refusal(rejection.code, rejection.pointer, rejection.message));
    }
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true };
}

// ── The single invocation ──────────────────────────────────────────────────

export interface ObservedActionResult {
  readonly intentId: string;
  readonly action: ExternalAction;
  readonly outcome: ExternalActionOutcome;
  readonly verification: ActionVerification;
  readonly externalReference: string;
  readonly refusals?: readonly FinishLineRefusal[];
}

export interface InvokeExternalActionInput {
  readonly intent: BoundActionIntent;
  readonly port: ExternalActionPort;
  readonly observed: RevalidationObservation;
  /** Whether the intent was journaled before this call. Nothing else proves it. */
  readonly intentJournaled: boolean;
  /**
   * Whether this intent already has an observed result in the journal. An
   * intent that produced one is spent: `classifyActionOutcome`'s
   * `replayProhibited` is advisory, and this is the fact that actually stops
   * the second call — including the call that would rewrite
   * `action_succeeded_verification_failed` into `completed`.
   */
  readonly intentAlreadyObserved: boolean;
  /**
   * The required post-action verification, run by the caller over the observed
   * reference. Absent means it did not run, which records `not-attempted` —
   * never `passed`.
   */
  readonly verify?: (externalReference: string) => Promise<boolean>;
}

/**
 * What one attempted invocation produced. A REFUSAL IS NOT AN OBSERVATION: a
 * call this unit declined to make produces no result to journal or classify,
 * because a fabricated `failed`/`not-attempted` is byte-identical — in every
 * member the frozen result payload keeps — to a genuine statement that the
 * action did not happen. That matters most for the replay refusal, where the
 * action DID happen: classifying such a result would report `blocked` with
 * `action_failed` about an action that succeeded.
 */
export type InvocationOutcome =
  | { readonly kind: "observed"; readonly result: ObservedActionResult }
  | { readonly kind: "refused"; readonly refusals: readonly FinishLineRefusal[] };

/**
 * Invokes the action exactly once. There is no retry here and no loop: a
 * thrown adapter, a rejected promise, or a port that resolves without a
 * reference all record `indeterminate`, which is the honest statement that the
 * action MAY have happened and must be reconciled rather than repeated. A call
 * this unit refuses to make returns `refused` and no result at all.
 */
export async function invokeExternalActionOnce(input: InvokeExternalActionInput): Promise<InvocationOutcome> {
  const observed = (result: ObservedActionResult): InvocationOutcome => ({ kind: "observed", result });
  const notPerformed = (refusals: readonly FinishLineRefusal[]): InvocationOutcome => ({ kind: "refused", refusals });

  if (!input.intentJournaled) {
    return notPerformed([
      refusal(
        "intent_not_journaled",
        "/intentId",
        "the intent was not journaled before the call; an action is never invoked ahead of the record that it was about to be",
      ),
    ]);
  }

  if (input.intentAlreadyObserved) {
    return notPerformed([
      refusal(
        "action_replay_prohibited",
        "/intentId",
        "this intent already has an observed result; an irreversible action is taken once per intent, and a second call under the same intent is the replay the post-action state forbids",
      ),
    ]);
  }

  const revalidated = revalidateBeforeInvoke(input.intent, input.observed);
  if (!revalidated.ok) return notPerformed(revalidated.refusals);

  let invocation: Awaited<ReturnType<ExternalActionPort["invoke"]>>;
  try {
    invocation = await input.port.invoke(journalIntentPayload(input.intent));
  } catch {
    // The call left; whether it arrived is unknown. This is the whole reason
    // `indeterminate` exists, and the reason nothing here tries again. It IS
    // an observation: the action may have happened.
    return observed({
      intentId: input.intent.intentId,
      action: input.intent.action,
      outcome: "indeterminate",
      verification: "not-attempted",
      externalReference: ABSENT_BY_STATE,
    });
  }

  if (!invocation.ok) {
    // The adapter itself reported that it did not act. That is an observation
    // rather than a refusal by this unit, and it is journaled as one.
    return observed({
      intentId: input.intent.intentId,
      action: input.intent.action,
      outcome: "failed",
      verification: "not-attempted",
      externalReference: ABSENT_BY_STATE,
      refusals: invocation.refusals,
    });
  }

  if (invocation.externalReference.length === 0) {
    // A success without a reference cannot be verified or reconciled against
    // anything, so it is not recorded as a success.
    return observed({
      intentId: input.intent.intentId,
      action: input.intent.action,
      outcome: "indeterminate",
      verification: "not-attempted",
      externalReference: ABSENT_BY_STATE,
    });
  }

  if (input.verify === undefined) {
    return observed({
      intentId: input.intent.intentId,
      action: input.intent.action,
      outcome: "succeeded",
      verification: "not-attempted",
      externalReference: invocation.externalReference,
    });
  }

  let verified: boolean;
  try {
    verified = await input.verify(invocation.externalReference);
  } catch {
    verified = false;
  }
  return observed({
    intentId: input.intent.intentId,
    action: input.intent.action,
    outcome: "succeeded",
    verification: verified ? "passed" : "failed",
    externalReference: invocation.externalReference,
  });
}

/** Exactly the frozen `action.result.recorded` payload, and nothing else. */
export function journalResultPayload(result: ObservedActionResult): {
  readonly intentId: string;
  readonly action: ExternalAction;
  readonly outcome: ExternalActionOutcome;
  readonly verification: ActionVerification;
  readonly externalReference: string;
} {
  return {
    intentId: result.intentId,
    action: result.action,
    outcome: result.outcome,
    verification: result.verification,
    externalReference: result.externalReference,
  };
}

// ── Reconciliation before retry ────────────────────────────────────────────

/** What the `status-reconciliation` adapter could establish about the action. */
export const RECONCILIATION_FINDINGS = Object.freeze(["performed", "not-performed", "unknown"] as const);
export type ReconciliationFinding = (typeof RECONCILIATION_FINDINGS)[number];

export type ReconciliationDisposition =
  | { readonly kind: "already-performed"; readonly result: ObservedActionResult }
  | { readonly kind: "blocked"; readonly refusals: readonly FinishLineRefusal[] };

export interface ReconcileInput {
  readonly indeterminate: ObservedActionResult;
  readonly finding: ReconciliationFinding;
  /** The reference the reconciliation observed, when it found the action performed. */
  readonly observedReference?: string;
  /** The id a retry would be taken under; never the indeterminate intent's own. */
  readonly nextIntentId?: string;
}

/**
 * Decides what may follow an indeterminate action. ALL THREE FINDINGS FORBID A
 * SECOND CALL, and the third — the action positively did not happen — forbids
 * it for a reason worth stating at length, because the obvious reading is that
 * a retry should be authorized there.
 *
 * The frozen delivery reducer admits `action.intent.recorded` only once EVERY
 * prior intent is reconciled, and reconciled means succeeded with a PASSING
 * verification (`spine/reducer.ts`). An indeterminate action never becomes
 * that: its result is written exactly once, so it cannot be re-observed, and
 * nothing in the product records a reconciliation as a result. A second intent
 * is therefore inadmissible whatever this function says, and a disposition
 * that authorized one would hand the caller an authorization the product
 * refuses — the delivery would sit in `acting` holding it, and the only
 * refusal anyone would see would name the first intent's observation rather
 * than the rule that actually forbids the step.
 *
 * So the honest answer is: an indeterminate action ends the delivery through
 * containment, and this function says so rather than promising a retry. The id
 * a caller offers is still checked, because reusing the indeterminate intent's
 * own id is a sharper error than proposing a new one and deserves its own
 * refusal.
 */
export function reconcileBeforeRetry(input: ReconcileInput): ReconciliationDisposition {
  if (input.indeterminate.outcome !== "indeterminate") {
    return {
      kind: "blocked",
      refusals: [
        refusal(
          "reconciliation_not_applicable",
          "/indeterminate/outcome",
          `reconciliation answers an indeterminate action; this one resolved ${input.indeterminate.outcome}`,
        ),
      ],
    };
  }

  if (input.finding === "performed") {
    return {
      kind: "already-performed",
      result: {
        intentId: input.indeterminate.intentId,
        action: input.indeterminate.action,
        outcome: "succeeded",
        verification: "not-attempted",
        externalReference: input.observedReference ?? ABSENT_BY_STATE,
      },
    };
  }

  if (input.finding === "unknown") {
    return {
      kind: "blocked",
      refusals: [
        refusal(
          "reconciliation_inconclusive",
          "/finding",
          "reconciliation could not establish whether the action happened; an unresolved action is never retried on the chance that it did not",
        ),
      ],
    };
  }

  if (input.nextIntentId !== undefined && input.nextIntentId === input.indeterminate.intentId) {
    return {
      kind: "blocked",
      refusals: [
        refusal(
          "action_replay_prohibited",
          "/nextIntentId",
          "the indeterminate intent's own id is offered for the retry; that is the replay this path exists to forbid",
        ),
      ],
    };
  }

  return {
    kind: "blocked",
    refusals: [
      refusal(
        "retry_not_admissible",
        "/finding",
        "reconciliation established the action did not happen, and a second intent is admitted only once every prior action is reconciled — which an indeterminate action never becomes, because its result is written exactly once. The delivery leaves through policy-selected containment rather than through a retry",
      ),
    ],
  };
}

// ── The post-action classification ─────────────────────────────────────────

export interface ActionClassification {
  readonly state: DeliveryState;
  readonly replayProhibited: boolean;
  /** The moves policy itself selected; empty when the action simply completed. */
  readonly permittedMoves: readonly string[];
  readonly refusals: readonly FinishLineRefusal[];
}

export interface ClassifyActionInput {
  readonly result: ObservedActionResult;
  /**
   * The finish line the accepted contract requested, carried on the intent
   * this result answers. A succeeded, verified MERGE under a `deploy` contract
   * is not a completed delivery: the next authorized acting step remains, and
   * the `acting -> acting` edge of the frozen transition table is exactly it.
   */
  readonly requestedFinishLine: string;
  /** The containment moves the compiled policy selected for this repository. */
  readonly containmentMoves: readonly string[];
}

/**
 * Where the delivery stands after one observed action. The pairing that
 * matters is success with a failed verification: the action happened, the
 * evidence that it did the right thing did not, and neither replaying it nor
 * calling the delivery complete is available — only containment, and only the
 * containment the policy selected in advance.
 */
export function classifyActionOutcome(input: ClassifyActionInput): ActionClassification {
  const { outcome, verification } = input.result;

  if (outcome === "succeeded" && verification === "passed") {
    // The action that served the requested finish line completes the delivery.
    // An earlier action in the chain — the merge a deploy contract deploys —
    // leaves the delivery acting, with the next step named rather than
    // invented, and never terminates it as though the finish line were reached.
    const reached = FINISH_LINE_REACHED_ACTIONS[input.requestedFinishLine];
    const position = reached === undefined ? -1 : reached.indexOf(input.result.action);
    if (position < 0) {
      // A finish line that does not reach the action that was taken cannot be
      // the finish line this result completes. Nothing upstream can produce
      // one — `finishLineReaches` refuses the plan — so this is the direction
      // the branch fails in when something upstream stops holding, and it is
      // never `completed`.
      return {
        state: "blocked",
        replayProhibited: true,
        permittedMoves: [...input.containmentMoves],
        refusals: [
          refusal(
            "finish_line_not_reached",
            "/requestedFinishLine",
            `the ${input.requestedFinishLine} finish line does not reach the ${input.result.action} that was taken; a result cannot complete a finish line it never served`,
          ),
        ],
      };
    }
    const remaining = (reached ?? []).slice(position + 1);
    if (remaining.length === 0) {
      return { state: "completed", replayProhibited: true, permittedMoves: [], refusals: [] };
    }
    return {
      state: "acting",
      replayProhibited: true,
      permittedMoves: [...remaining],
      refusals: [
        refusal(
          "finish_line_not_reached",
          "/requestedFinishLine",
          `the ${input.result.action} succeeded and verified, and the contract requested the ${input.requestedFinishLine} finish line; the delivery is still acting and the next authorized step is ${remaining[0] as string}`,
        ),
      ],
    };
  }

  if (outcome === "succeeded" && verification === "failed") {
    return {
      state: "action_succeeded_verification_failed",
      replayProhibited: true,
      permittedMoves: [...input.containmentMoves],
      refusals: [
        refusal(
          "action_succeeded_verification_failed",
          "/verification",
          "the action succeeded and its required verification failed; the action is never replayed and the delivery proceeds only through policy-selected containment, rollback, or escalation",
        ),
      ],
    };
  }

  if (outcome === "succeeded") {
    // `not-attempted` over a succeeded action: the required check did not run,
    // so the delivery is not reconciled and does not leave through success.
    return {
      state: "blocked",
      replayProhibited: true,
      permittedMoves: [...input.containmentMoves],
      refusals: [
        refusal(
          "verification_not_attempted",
          "/verification",
          "the required post-action verification did not run; an unrun check is not a passing one, and the action that already happened is not repeated to produce one",
        ),
      ],
    };
  }

  if (outcome === "indeterminate") {
    return {
      state: "acting",
      replayProhibited: true,
      permittedMoves: ["reconcile"],
      refusals: [
        refusal(
          "reconciliation_required",
          "/outcome",
          "the action's outcome is unknown; it is reconciled through the status-reconciliation adapter before anything else happens",
        ),
      ],
    };
  }

  return {
    state: "blocked",
    // The action did not happen, and it is still not taken again under this
    // intent. The frozen reducer admits a second `action.intent.recorded` only
    // while `acting` and only once every prior intent is succeeded/passed, and
    // this classification has just put the delivery in `blocked` — so a `false`
    // here would tell a host a second attempt is available that the product
    // refuses, which is exactly the shape of promise this unit removed from
    // reconciliation. Every branch prohibits the replay; the delivery leaves
    // through the containment the policy selected.
    replayProhibited: true,
    permittedMoves: [...input.containmentMoves],
    refusals: [
      refusal("action_failed", "/outcome", "the action did not happen; the delivery is blocked rather than acting"),
    ],
  };
}

// ── Deployment's additional preconditions ──────────────────────────────────

export interface DeployPreconditionInput {
  /** The merge this deploy follows, as the journal recorded it. */
  readonly merge: ObservedActionResult | undefined;
  /** Whether `main` is clean: the merge commit is its tip and nothing else moved. */
  readonly mainTipSha: string;
  readonly mergedCommitSha: string;
  readonly workingTreeClean: boolean;
  /** The provenance the repository requires for a deployable artifact. */
  readonly provenance: { readonly present: boolean; readonly subjectDigest: string; readonly candidateDeliverableDigest: string };
  /** The repository-specific preflight, already run by the caller. */
  readonly preflight: { readonly ran: boolean; readonly passed: boolean };
}

/**
 * Deployment is not merge with a different adapter. It follows a merge that
 * was actually reconciled, onto a `main` that is exactly that merge, with
 * provenance over the same deliverable and a preflight that ran.
 */
export function checkDeployPreconditions(
  input: DeployPreconditionInput,
): { readonly ok: true } | { readonly ok: false; readonly refusals: readonly FinishLineRefusal[] } {
  const refusals: FinishLineRefusal[] = [];

  if (input.merge === undefined) {
    refusals.push(
      refusal("merge_not_reconciled", "/merge", "no merge was recorded; a deployment never precedes the merge it deploys"),
    );
  } else if (input.merge.outcome !== "succeeded" || input.merge.verification !== "passed") {
    refusals.push(
      refusal(
        "merge_not_reconciled",
        "/merge",
        `the merge resolved ${input.merge.outcome}/${input.merge.verification}; a deployment follows a merge that succeeded and verified, and nothing weaker`,
      ),
    );
  }

  if (input.mainTipSha !== input.mergedCommitSha) {
    refusals.push(
      refusal(
        "main_not_clean",
        "/mainTipSha",
        `main is at ${input.mainTipSha} and the merge produced ${input.mergedCommitSha}; deploying a main that moved deploys something nobody reviewed`,
      ),
    );
  }
  if (!input.workingTreeClean) {
    refusals.push(refusal("main_not_clean", "/workingTreeClean", "the deployment source carries uncommitted content"));
  }

  if (!input.provenance.present) {
    refusals.push(refusal("provenance_missing", "/provenance", "the artifact carries no provenance statement"));
  } else if (input.provenance.subjectDigest !== input.provenance.candidateDeliverableDigest) {
    refusals.push(
      refusal(
        "provenance_mismatch",
        "/provenance/subjectDigest",
        "the provenance describes a different artifact than the candidate this delivery recorded",
      ),
    );
  }

  if (!input.preflight.ran) {
    refusals.push(refusal("preflight_not_attempted", "/preflight", "the repository preflight did not run; an unrun preflight is not a passing one"));
  } else if (!input.preflight.passed) {
    refusals.push(refusal("preflight_failed", "/preflight", "the repository preflight failed"));
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true };
}

// ── The post-action result grammar ─────────────────────────────────────────

/**
 * The frozen result for a finish line BEYOND merge-ready. `finish-line-result/1`
 * freezes `merge-ready` alone and says so; this is the payload the actions unit
 * owns, and it is bound to the intent, the chain, the fence, both epochs and
 * the tracked record, so a result cannot be read apart from what authorized it.
 */
export const EXTERNAL_ACTION_RESULT_SPEC = "external-action-result/1";

const RESULT_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(EXTERNAL_ACTION_RESULT_SPEC) },
  { name: "finishLine", check: oneOf(["merge", "deploy"] as const) },
  { name: "deliveryId", check: spineId },
  { name: "intentId", check: spineId },
  { name: "action", check: oneOf(EXTERNAL_ACTIONS) },
  {
    name: "candidate",
    check: closed([
      { name: "treeSha", check: gitOid },
      { name: "deliverableDigest", check: sha256 },
    ]),
  },
  { name: "policyDigest", check: sha256 },
  { name: "approval", check: oneOf(ACTION_APPROVALS) },
  { name: "outcome", check: oneOf(EXTERNAL_ACTION_OUTCOMES) },
  { name: "verification", check: oneOf(ACTION_VERIFICATIONS) },
  { name: "externalReference", check: orAbsentByState(boundedText) },
  { name: "actionChainDigest", check: sha256 },
  { name: "invocationFence", check: positiveInt },
  { name: "productTrustRevocationEpoch", check: nonNegativeInt },
  { name: "repositoryAuthorityRevocationEpoch", check: nonNegativeInt },
  { name: "trackedRecordDigest", check: sha256 },
];

export function validateExternalActionResult(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  const record = checkClosed(value, "", RESULT_RULES, collector);
  if (record !== undefined) {
    // The same pairing the journal enforces, restated over the result: a
    // passing verification belongs to a succeeded action alone.
    if (record["verification"] === "passed" && record["outcome"] !== "succeeded") {
      collector.emit(
        "unsupported_combination",
        "/verification",
        "post-action verification passes only over a succeeded action",
      );
    }
    // The finish line has to REACH the action, by the same relation the plan
    // binds under: a deploy contract's merge is a real result that has to be
    // recordable, while a merge contract's deploy is not. `merge-ready` is
    // already unspellable through the `finishLine` member's own check.
    if (!finishLineReaches(record["finishLine"] as string, record["action"] as ExternalAction)) {
      collector.emit(
        "unsupported_combination",
        "/action",
        `the ${String(record["finishLine"])} finish line does not reach a ${String(record["action"])} action`,
      );
    }
  }
  return collector.verdict();
}
