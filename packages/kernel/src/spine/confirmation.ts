/**
 * The operator-confirmation contract, both frozen classes:
 *
 *   - `contract-confirmation` (intake handoff): binds origin, the intake
 *     draft, action, expiry, a single-use nonce, the product-trust revocation
 *     epoch, and the EXACT normalized-contract digest presented to the
 *     operator. It is minted at presentation — before `validating_acceptance`
 *     — so the repository authority epoch does not exist yet and is recorded
 *     absent-by-state, as are every delivery-scoped identity.
 *   - `takeover-authorization`: binds origin, the delivery, action, expiry, a
 *     single-use nonce, BOTH revocation epochs, the superseded invocation
 *     fence, the expected journal revision, and the target base commit —
 *     rejecting consumption on any mismatch is the reducer's job; carrying
 *     the exact bindings is this contract's.
 *
 * Neither class ever binds a new invocation fence or a candidate: both are
 * minted before those exist, so `boundInvocationFence` and
 * `boundCandidateTreeSha` are recorded explicitly absent-by-state in both
 * classes. Uniqueness of the nonce is a consumption rule, not a shape rule.
 */
import {
  checkClosed,
  createSpineCollector,
  gitOid,
  instant,
  isAbsentByState,
  nonNegativeInt,
  oneOf,
  orAbsentByState,
  positiveInt,
  sha256,
  specLiteral,
  spineId,
  spinePointer,
  text,
  type MemberRule,
  type SpineCollector,
  type SpineVerdict,
} from "./grammar.ts";

export const OPERATOR_CONFIRMATION_SPEC = "operator-confirmation/1";

export const CONFIRMATION_CLASSES = Object.freeze(["contract-confirmation", "takeover-authorization"] as const);
export type ConfirmationClass = (typeof CONFIRMATION_CLASSES)[number];

const CONFIRMATION_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(OPERATOR_CONFIRMATION_SPEC) },
  { name: "confirmationClass", check: oneOf(CONFIRMATION_CLASSES) },
  { name: "origin", check: text },
  { name: "action", check: text },
  { name: "expiry", check: instant },
  { name: "nonce", check: spineId },
  { name: "productTrustRevocationEpoch", check: nonNegativeInt },
  { name: "repositoryAuthorityRevocationEpoch", check: orAbsentByState(nonNegativeInt) },
  { name: "intakeDraftId", check: orAbsentByState(spineId) },
  { name: "deliveryId", check: orAbsentByState(spineId) },
  { name: "normalizedContractDigest", check: orAbsentByState(sha256) },
  { name: "supersededInvocationFence", check: orAbsentByState(positiveInt) },
  { name: "expectedJournalRevision", check: orAbsentByState(nonNegativeInt) },
  { name: "targetBaseCommit", check: orAbsentByState(gitOid) },
  { name: "boundInvocationFence", check: orAbsentByState(positiveInt) },
  { name: "boundCandidateTreeSha", check: orAbsentByState(gitOid) },
];

const requireReal = (record: Record<string, unknown>, name: string, collector: SpineCollector): void => {
  if (isAbsentByState(record[name])) {
    collector.emit(
      "unsupported_combination",
      spinePointer("", name),
      `this confirmation class binds ${name} for real; "absent-by-state" is not a supported combination here`,
    );
  }
};

const requireAbsent = (record: Record<string, unknown>, name: string, collector: SpineCollector): void => {
  if (record[name] !== undefined && !isAbsentByState(record[name])) {
    collector.emit(
      "unsupported_combination",
      spinePointer("", name),
      `this confirmation class records ${name} explicitly "absent-by-state"; a populated value is not a supported combination`,
    );
  }
};

export function validateOperatorConfirmation(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  const record = checkClosed(value, "", CONFIRMATION_RULES, collector);
  if (record !== undefined) {
    // Neither class binds a fence or candidate that does not exist yet.
    requireAbsent(record, "boundInvocationFence", collector);
    requireAbsent(record, "boundCandidateTreeSha", collector);

    if (record["confirmationClass"] === "contract-confirmation") {
      requireReal(record, "intakeDraftId", collector);
      requireReal(record, "normalizedContractDigest", collector);
      requireAbsent(record, "deliveryId", collector);
      requireAbsent(record, "supersededInvocationFence", collector);
      requireAbsent(record, "expectedJournalRevision", collector);
      requireAbsent(record, "targetBaseCommit", collector);
      // Minted before validating_acceptance: the repository authority epoch
      // does not exist yet.
      requireAbsent(record, "repositoryAuthorityRevocationEpoch", collector);
    }
    if (record["confirmationClass"] === "takeover-authorization") {
      requireReal(record, "deliveryId", collector);
      requireReal(record, "supersededInvocationFence", collector);
      requireReal(record, "expectedJournalRevision", collector);
      requireReal(record, "targetBaseCommit", collector);
      requireReal(record, "repositoryAuthorityRevocationEpoch", collector);
      requireAbsent(record, "intakeDraftId", collector);
      requireAbsent(record, "normalizedContractDigest", collector);
    }
  }
  return collector.verdict();
}

/** The class the given confirmation value declares, when it declares one. */
export function confirmationClassOf(value: unknown): ConfirmationClass | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const declared = (value as Record<string, unknown>)["confirmationClass"];
  return CONFIRMATION_CLASSES.includes(declared as never) ? (declared as ConfirmationClass) : undefined;
}
