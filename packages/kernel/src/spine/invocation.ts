/**
 * The fenced host invocation and the reviewer attempt.
 *
 * A fence is an atomic, monotonically increasing acquisition bound to the
 * delivery, the expected journal revision, the host task, the worktree, the
 * candidate (branch ref VALUE as well as tree — a stale host writing the old
 * branch ref must produce a detectable mismatch, never silent adoption), the
 * policy snapshot, and the authority epoch. It also declares its observation
 * lifetime: an invocation-fence observation older than this many seconds
 * marks host activity `unknown` lazily — the shape carries the declaration;
 * no spine decision ever consults a clock.
 *
 * A reviewer attempt binds a context digest so independence is falsifiable:
 * distinct attempt identities with identical contexts are exactly what the
 * admission sensors exist to reject.
 */
import {
  checkClosed,
  closed,
  createSpineCollector,
  gitOid,
  nonNegativeInt,
  oneOf,
  positiveInt,
  sha256,
  specLiteral,
  spineId,
  text,
  type MemberRule,
  type SpineVerdict,
} from "./grammar.ts";
import { REVIEW_VERDICTS } from "./contract.ts";

export const INVOCATION_FENCE_SPEC = "invocation-fence/1";
export const REVIEWER_ATTEMPT_SPEC = "reviewer-attempt/1";

const FENCE_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(INVOCATION_FENCE_SPEC) },
  { name: "deliveryId", check: spineId },
  { name: "fence", check: positiveInt },
  { name: "expectedJournalRevision", check: nonNegativeInt },
  { name: "hostTaskId", check: spineId },
  { name: "worktreeId", check: spineId },
  {
    name: "candidate",
    check: closed([
      { name: "treeSha", check: gitOid },
      { name: "branchRef", check: text },
      { name: "branchRefValue", check: gitOid },
    ]),
  },
  { name: "policyDigest", check: sha256 },
  { name: "authorityEpoch", check: nonNegativeInt },
  { name: "observationLifetimeSeconds", check: positiveInt },
];

export function validateInvocationFence(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  checkClosed(value, "", FENCE_RULES, collector);
  return collector.verdict();
}

const ATTEMPT_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(REVIEWER_ATTEMPT_SPEC) },
  { name: "attemptId", check: spineId },
  { name: "deliveryId", check: spineId },
  { name: "lensId", check: spineId },
  { name: "contextDigest", check: sha256 },
  { name: "personaDigest", check: sha256 },
  { name: "verdict", check: oneOf(REVIEW_VERDICTS) },
];

export function validateReviewerAttempt(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  checkClosed(value, "", ATTEMPT_RULES, collector);
  return collector.verdict();
}
