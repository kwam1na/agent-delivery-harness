/**
 * The merge-ready finish-line result — the ONLY finish-line result the spine
 * freezes. `merge` and `deploy` results are post-action payloads owned by the
 * finish-line/actions units; a result claiming them here rejects.
 *
 * The result binds the outcome verification by canonical digest, and
 * `checkMergeReadyAgainstOutcome` enforces the two rules that keep a blanket
 * waiver from producing delivery success: every criterion must be resolved
 * (`passed` or `amended-waived`, never `blocked`), and at least one positive
 * criterion must have PASSED.
 */
import { digestCanonical } from "../digest.ts";
import {
  checkClosed,
  closed,
  createSpineCollector,
  gitOid,
  literal,
  sha256,
  specLiteral,
  spineId,
  spinePointer,
  type MemberRule,
  type SpineVerdict,
} from "./grammar.ts";
import type { OutcomeVerification } from "./contract.ts";

export const FINISH_LINE_RESULT_SPEC = "finish-line-result/1";

const RESULT_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(FINISH_LINE_RESULT_SPEC) },
  { name: "finishLine", check: literal("merge-ready") },
  { name: "deliveryId", check: spineId },
  {
    name: "candidate",
    check: closed([
      { name: "treeSha", check: gitOid },
      { name: "deliverableDigest", check: sha256 },
    ]),
  },
  { name: "outcomeVerificationDigest", check: sha256 },
  { name: "mergeReadyObligationsSatisfied", check: literal(true) },
];

export interface FinishLineResult {
  readonly spec: typeof FINISH_LINE_RESULT_SPEC;
  readonly finishLine: "merge-ready";
  readonly deliveryId: string;
  readonly candidate: { readonly treeSha: string; readonly deliverableDigest: string };
  readonly outcomeVerificationDigest: string;
  readonly mergeReadyObligationsSatisfied: true;
}

export function validateFinishLineResult(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  checkClosed(value, "", RESULT_RULES, collector);
  return collector.verdict();
}

/**
 * A merge-ready result is only as good as the outcome verification it binds:
 * the digest must recompute, the candidates must agree, no criterion may
 * remain blocked, and at least one positive criterion must have passed.
 */
export function checkMergeReadyAgainstOutcome(result: FinishLineResult, outcome: OutcomeVerification): SpineVerdict {
  const collector = createSpineCollector();

  let computed: string | undefined;
  try {
    computed = digestCanonical(outcome);
  } catch {
    computed = undefined;
  }
  if (computed === undefined || computed !== result.outcomeVerificationDigest) {
    collector.emit(
      "digest_mismatch",
      "/outcomeVerificationDigest",
      "the result does not bind this outcome verification's canonical bytes",
    );
  }

  if (result.candidate.treeSha !== outcome.candidate.treeSha || result.candidate.deliverableDigest !== outcome.candidate.deliverableDigest) {
    collector.emit("digest_mismatch", "/candidate", "the result and the outcome verification name different candidates");
  }

  outcome.criteria.forEach((criterion, index) => {
    if (criterion.disposition === "blocked") {
      collector.emit(
        "criterion_unverified",
        spinePointer("/criteria", index, "disposition"),
        `criterion ${criterion.criterionId} is blocked; a merge-ready finish line requires every criterion resolved`,
      );
    }
  });
  if (!outcome.criteria.some((criterion) => criterion.disposition === "passed")) {
    collector.emit(
      "criterion_unverified",
      "/criteria",
      "no positive criterion passed; a blanket waiver cannot produce delivery success",
    );
  }

  return collector.verdict();
}
