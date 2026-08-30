/**
 * The sensitive-approval assertion contract — the second, stronger class of
 * user-originated authorization beside the operator confirmation, frozen here
 * by the composition-lifecycle unit whose maintenance lane is its first
 * consumer.
 *
 * NON-MODEL-MINTABLE. An assertion exists only because an assertion source —
 * host-native where the host provides one, OS-native interactive
 * authentication where it does not, or the qualification fixture source valid
 * only under the confirmation-fixture composition profile — performed one
 * fresh interactive evaluation for one single-use nonce, with credential
 * caching disabled or treated as invalid. The evaluating provider and the
 * consuming lane are model-external; this module freezes only the record the
 * evaluation binds, and the consumption sites enforce nonce single-use,
 * expiry, epoch freshness, and binding equality.
 *
 * THREE CLASSES, three binding profiles:
 *
 *   - `delivery-bound` (waiver validity/confirmation and the policy-required
 *     merge/deploy approvals): binds origin, delivery, candidate, policy,
 *     BOTH revocation epochs, the invocation fence, action, expiry, and a
 *     single-use nonce.
 *   - `maintenance-lane` (update, rollback, and trust-state maintenance):
 *     binds the target installation and generation identities in place of
 *     delivery/candidate/fence; the high-water-mark advance binds the target
 *     mark instead of a generation. Only the product-trust revocation epoch
 *     exists in this lane — there is no delivery, so the repository authority
 *     epoch is recorded explicitly absent-by-state.
 *   - `security-blocked-migration`: binds the target installation and
 *     generation identities (the target generation being non-revoked is a
 *     consumption rule) plus the target delivery identity and its expected
 *     journal revision, in place of candidate/fence. The consuming site
 *     rejects on any mismatch; the mandatory full re-preparation recaptures
 *     candidate, fence, and policy, so none of those is bound here.
 *
 * The evaluating prompt disclosed the exact target and action being approved;
 * the members here are that disclosure's machine half.
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

export const SENSITIVE_APPROVAL_ASSERTION_SPEC = "sensitive-approval-assertion/1";

export const ASSERTION_CLASSES = Object.freeze([
  "delivery-bound",
  "maintenance-lane",
  "security-blocked-migration",
] as const);
export type AssertionClass = (typeof ASSERTION_CLASSES)[number];

/** Where the interactive evaluation ran. The fixture source is profile-gated. */
export const ASSERTION_SOURCES = Object.freeze(["host-native", "os-native", "qualification-fixture"] as const);
export type AssertionSource = (typeof ASSERTION_SOURCES)[number];

/** The maintenance-lane actions in the sensitive set, frozen. */
export const SENSITIVE_MAINTENANCE_ACTIONS = Object.freeze([
  "update",
  "rollback",
  "pin",
  "revoke",
  "unrevoke",
  "advance-high-water-mark",
] as const);
export type SensitiveMaintenanceAction = (typeof SENSITIVE_MAINTENANCE_ACTIONS)[number];

export const SECURITY_BLOCKED_MIGRATION_ACTION = "migrate-security-blocked";

const ASSERTION_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(SENSITIVE_APPROVAL_ASSERTION_SPEC) },
  { name: "assertionClass", check: oneOf(ASSERTION_CLASSES) },
  { name: "origin", check: text },
  { name: "action", check: text },
  { name: "expiry", check: instant },
  { name: "nonce", check: spineId },
  { name: "assertionSource", check: oneOf(ASSERTION_SOURCES) },
  { name: "productTrustRevocationEpoch", check: nonNegativeInt },
  { name: "repositoryAuthorityRevocationEpoch", check: orAbsentByState(nonNegativeInt) },
  { name: "deliveryId", check: orAbsentByState(spineId) },
  { name: "candidateTreeSha", check: orAbsentByState(gitOid) },
  { name: "policyDigest", check: orAbsentByState(sha256) },
  { name: "invocationFence", check: orAbsentByState(positiveInt) },
  { name: "targetInstallationId", check: orAbsentByState(spineId) },
  { name: "targetGenerationDigest", check: orAbsentByState(sha256) },
  { name: "targetHighWaterMark", check: orAbsentByState(nonNegativeInt) },
  { name: "expectedJournalRevision", check: orAbsentByState(nonNegativeInt) },
];

const requireReal = (record: Record<string, unknown>, name: string, collector: SpineCollector): void => {
  if (isAbsentByState(record[name])) {
    collector.emit(
      "unsupported_combination",
      spinePointer("", name),
      `this assertion class binds ${name} for real; "absent-by-state" is not a supported combination here`,
    );
  }
};

const requireAbsent = (record: Record<string, unknown>, name: string, collector: SpineCollector): void => {
  if (record[name] !== undefined && !isAbsentByState(record[name])) {
    collector.emit(
      "unsupported_combination",
      spinePointer("", name),
      `this assertion class records ${name} explicitly "absent-by-state"; a populated value is not a supported combination`,
    );
  }
};

export function validateSensitiveApprovalAssertion(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  const record = checkClosed(value, "", ASSERTION_RULES, collector);
  if (record !== undefined) {
    const assertionClass = record["assertionClass"];

    if (assertionClass === "delivery-bound") {
      requireReal(record, "deliveryId", collector);
      requireReal(record, "candidateTreeSha", collector);
      requireReal(record, "policyDigest", collector);
      requireReal(record, "invocationFence", collector);
      requireReal(record, "repositoryAuthorityRevocationEpoch", collector);
      requireAbsent(record, "targetInstallationId", collector);
      requireAbsent(record, "targetGenerationDigest", collector);
      requireAbsent(record, "targetHighWaterMark", collector);
      requireAbsent(record, "expectedJournalRevision", collector);
    }

    if (assertionClass === "maintenance-lane") {
      const action = record["action"];
      if (typeof action === "string" && !SENSITIVE_MAINTENANCE_ACTIONS.includes(action as never)) {
        collector.emit(
          "unsupported_combination",
          "/action",
          `${action} is not in the frozen sensitive maintenance action set`,
        );
      }
      requireReal(record, "targetInstallationId", collector);
      if (action === "advance-high-water-mark") {
        // The advance approves a mark, not a generation; its prompt disclosed
        // the exact mark being advanced to.
        requireReal(record, "targetHighWaterMark", collector);
        requireAbsent(record, "targetGenerationDigest", collector);
      } else {
        requireReal(record, "targetGenerationDigest", collector);
        requireAbsent(record, "targetHighWaterMark", collector);
      }
      requireAbsent(record, "deliveryId", collector);
      requireAbsent(record, "candidateTreeSha", collector);
      requireAbsent(record, "policyDigest", collector);
      requireAbsent(record, "invocationFence", collector);
      requireAbsent(record, "repositoryAuthorityRevocationEpoch", collector);
      requireAbsent(record, "expectedJournalRevision", collector);
    }

    if (assertionClass === "security-blocked-migration") {
      if (record["action"] !== SECURITY_BLOCKED_MIGRATION_ACTION) {
        collector.emit(
          "unsupported_combination",
          "/action",
          `the migration class carries exactly the ${SECURITY_BLOCKED_MIGRATION_ACTION} action`,
        );
      }
      requireReal(record, "targetInstallationId", collector);
      requireReal(record, "targetGenerationDigest", collector);
      requireReal(record, "deliveryId", collector);
      requireReal(record, "expectedJournalRevision", collector);
      requireAbsent(record, "candidateTreeSha", collector);
      requireAbsent(record, "policyDigest", collector);
      requireAbsent(record, "invocationFence", collector);
      requireAbsent(record, "repositoryAuthorityRevocationEpoch", collector);
      requireAbsent(record, "targetHighWaterMark", collector);
    }
  }
  return collector.verdict();
}

/** The class the given assertion value declares, when it declares one. */
export function assertionClassOf(value: unknown): AssertionClass | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const declared = (value as Record<string, unknown>)["assertionClass"];
  return ASSERTION_CLASSES.includes(declared as never) ? (declared as AssertionClass) : undefined;
}
