/**
 * The accepted scoped-delivery contract and the outcome-verification claim.
 *
 * The contract's shape is identical whether produced by direct operator
 * handoff or by later iterative intake — there are no intake-only members —
 * and an ACCEPTED contract carries no unresolved decisions: material
 * ambiguity remains in intake and cannot begin mutation.
 *
 * Outcome verification maps each acceptance criterion to exact candidate-
 * bound evidence and one disposition. Zero review attempts reject, duplicate
 * attempt identities reject, and every attempt binds a context digest so
 * reviewer independence stays falsifiable (rejecting same-context
 * re-invocation is the admission sensors' job, on top of this shape).
 */
import {
  checkClosed,
  closed,
  closedArray,
  createSpineCollector,
  gitOid,
  isSpineRecord,
  oneOf,
  sha256,
  specLiteral,
  spineId,
  spinePointer,
  stringArray,
  text,
  type MemberRule,
  type SpineVerdict,
} from "./grammar.ts";

export const SCOPED_DELIVERY_CONTRACT_SPEC = "scoped-delivery-contract/1";
export const OUTCOME_VERIFICATION_SPEC = "outcome-verification/1";

export const FINISH_LINES = Object.freeze(["merge-ready", "merge", "deploy"] as const);
export const CRITERION_DISPOSITIONS = Object.freeze(["passed", "amended-waived", "blocked"] as const);
export const EVIDENCE_KINDS = Object.freeze(["sensor", "artifact", "review", "operation"] as const);
export const REVIEW_VERDICTS = Object.freeze(["approved", "findings"] as const);

const CRITERION_RULES: readonly MemberRule[] = [
  { name: "criterionId", check: spineId },
  { name: "statement", check: text },
];

const CONTRACT_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(SCOPED_DELIVERY_CONTRACT_SPEC) },
  { name: "contractId", check: spineId },
  { name: "task", check: text },
  { name: "intendedOutcome", check: text },
  { name: "acceptanceCriteria", check: closedArray(CRITERION_RULES, { minItems: 1 }) },
  { name: "nonGoals", check: stringArray() },
  {
    name: "repository",
    check: closed([
      { name: "repositoryId", check: spineId },
      { name: "baseRef", check: text },
    ]),
  },
  { name: "requestedFinishLine", check: oneOf(FINISH_LINES) },
  { name: "requestedAuthority", check: stringArray() },
  { name: "unresolvedDecisions", check: stringArray() },
];

export interface AcceptedContract {
  readonly spec: typeof SCOPED_DELIVERY_CONTRACT_SPEC;
  readonly contractId: string;
  readonly task: string;
  readonly intendedOutcome: string;
  readonly acceptanceCriteria: readonly { readonly criterionId: string; readonly statement: string }[];
  readonly nonGoals: readonly string[];
  readonly repository: { readonly repositoryId: string; readonly baseRef: string };
  readonly requestedFinishLine: (typeof FINISH_LINES)[number];
  readonly requestedAuthority: readonly string[];
  readonly unresolvedDecisions: readonly string[];
}

export function validateAcceptedContract(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  const record = checkClosed(value, "", CONTRACT_RULES, collector);
  if (record !== undefined) {
    const unresolved = record["unresolvedDecisions"];
    if (Array.isArray(unresolved) && unresolved.length > 0) {
      collector.emit(
        "unsupported_combination",
        "/unresolvedDecisions",
        "an accepted contract cannot carry unresolved decisions; material ambiguity remains in intake",
      );
    }
    const criteria = record["acceptanceCriteria"];
    if (Array.isArray(criteria)) {
      const seen = new Set<string>();
      criteria.forEach((criterion, index) => {
        if (!isSpineRecord(criterion) || typeof criterion["criterionId"] !== "string") return;
        if (seen.has(criterion["criterionId"])) {
          collector.emit("malformed_member", spinePointer("/acceptanceCriteria", index, "criterionId"), "duplicate criterion id");
        }
        seen.add(criterion["criterionId"]);
      });
    }
  }
  return collector.verdict();
}

const OUTCOME_CRITERION_RULES: readonly MemberRule[] = [
  { name: "criterionId", check: spineId },
  { name: "disposition", check: oneOf(CRITERION_DISPOSITIONS) },
  {
    name: "evidence",
    check: closed([
      { name: "kind", check: oneOf(EVIDENCE_KINDS) },
      { name: "reference", check: text },
    ]),
  },
];

const REVIEW_ATTEMPT_RULES: readonly MemberRule[] = [
  { name: "attemptId", check: spineId },
  { name: "lensId", check: spineId },
  { name: "contextDigest", check: sha256 },
  { name: "verdict", check: oneOf(REVIEW_VERDICTS) },
];

const OUTCOME_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(OUTCOME_VERIFICATION_SPEC) },
  { name: "contractId", check: spineId },
  {
    name: "candidate",
    check: closed([
      { name: "treeSha", check: gitOid },
      { name: "deliverableDigest", check: sha256 },
    ]),
  },
  { name: "criteria", check: closedArray(OUTCOME_CRITERION_RULES, { minItems: 1 }) },
  { name: "reviewAttempts", check: closedArray(REVIEW_ATTEMPT_RULES) },
];

export interface OutcomeCriterion {
  readonly criterionId: string;
  readonly disposition: (typeof CRITERION_DISPOSITIONS)[number];
  readonly evidence: { readonly kind: (typeof EVIDENCE_KINDS)[number]; readonly reference: string };
}

export interface OutcomeVerification {
  readonly spec: typeof OUTCOME_VERIFICATION_SPEC;
  readonly contractId: string;
  readonly candidate: { readonly treeSha: string; readonly deliverableDigest: string };
  readonly criteria: readonly OutcomeCriterion[];
  readonly reviewAttempts: readonly {
    readonly attemptId: string;
    readonly lensId: string;
    readonly contextDigest: string;
    readonly verdict: (typeof REVIEW_VERDICTS)[number];
  }[];
}

export function validateOutcomeVerification(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  const record = checkClosed(value, "", OUTCOME_RULES, collector);
  if (record !== undefined) {
    const attempts = record["reviewAttempts"];
    if (Array.isArray(attempts)) {
      if (attempts.length === 0) {
        collector.emit("zero_review_attempts", "/reviewAttempts", "at least one completed review attempt is required");
      }
      const seen = new Set<string>();
      attempts.forEach((attempt, index) => {
        if (!isSpineRecord(attempt) || typeof attempt["attemptId"] !== "string") return;
        if (seen.has(attempt["attemptId"])) {
          collector.emit(
            "duplicate_review_attempt",
            spinePointer("/reviewAttempts", index, "attemptId"),
            "review attempts must complete under distinct attempt identities",
          );
        }
        seen.add(attempt["attemptId"]);
      });
    }
  }
  return collector.verdict();
}

/**
 * Every acceptance criterion of the contract must carry exactly one
 * disposition in the verification — an unmapped criterion is unverified and
 * blocks, and a verified criterion that the contract never named is a
 * mapping to nothing.
 */
export function checkOutcomeCoversContract(outcome: OutcomeVerification, contract: AcceptedContract): SpineVerdict {
  const collector = createSpineCollector();
  const verified = new Set(outcome.criteria.map((criterion) => criterion.criterionId));
  contract.acceptanceCriteria.forEach((criterion, index) => {
    if (!verified.has(criterion.criterionId)) {
      collector.emit(
        "criterion_unverified",
        spinePointer("/acceptanceCriteria", index, "criterionId"),
        `criterion ${criterion.criterionId} carries no disposition in the outcome verification`,
      );
    }
  });
  const named = new Set(contract.acceptanceCriteria.map((criterion) => criterion.criterionId));
  outcome.criteria.forEach((criterion, index) => {
    if (!named.has(criterion.criterionId)) {
      collector.emit(
        "criterion_unverified",
        spinePointer("/criteria", index, "criterionId"),
        `criterion ${criterion.criterionId} is not an acceptance criterion of the contract`,
      );
    }
  });
  return collector.verdict();
}

export interface PolicyGrantView {
  readonly grantedFinishLines: readonly string[];
  readonly grantedAuthority: readonly string[];
}

/**
 * The contract can request only a subset of what the compiled policy grants.
 * Policy always wins, and ABSENCE OF A GRANT IS DENIAL — nothing a model or
 * agent writes into a contract or result can widen this.
 */
export function checkContractWithinPolicy(contract: AcceptedContract, policy: PolicyGrantView): SpineVerdict {
  const collector = createSpineCollector();
  if (!policy.grantedFinishLines.includes(contract.requestedFinishLine)) {
    collector.emit(
      "authority_not_granted",
      "/requestedFinishLine",
      `finish line ${contract.requestedFinishLine} is not granted by the compiled policy`,
    );
  }
  contract.requestedAuthority.forEach((authority, index) => {
    if (!policy.grantedAuthority.includes(authority)) {
      collector.emit(
        "authority_not_granted",
        spinePointer("/requestedAuthority", index),
        `authority ${authority} is not granted by the compiled policy; absence of a grant is denial`,
      );
    }
  });
  return collector.verdict();
}
