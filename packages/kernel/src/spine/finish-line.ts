/**
 * The merge-ready finish-line result — the ONLY finish-line result the spine
 * freezes. `merge` and `deploy` results are post-action payloads owned by the
 * finish-line/actions units; a result claiming them here rejects.
 *
 * WHAT THE RESULT BINDS. A merge-ready result is the delivery's terminal
 * success, so it carries every value that success was decided from and nothing
 * that could be re-derived favourably later: the run, the reviewed candidate
 * the outcome verification names, the POST-RECORD candidate and the base it
 * stands on, the compiled policy's digest, the obligations that actually
 * completed, the tracked record's digest, the external verifier's result, and
 * the product-trust level the substrate declares. Two of those are frozen to a
 * single spelling on purpose — a result exists only when the external verifier
 * PASSED, and only under the substrate's own declared trust label — so a
 * caller cannot write a weaker claim into the journal and have it accepted.
 *
 * `checkMergeReadyAgainstOutcome` enforces the two rules that keep a blanket
 * waiver from producing delivery success: every criterion must be resolved
 * (`passed` or `amended-waived`, never `blocked`), and at least one positive
 * criterion must have PASSED.
 */
import { PRODUCT_TRUST_LABEL } from "./composition.ts";
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
  stringArray,
  type MemberRule,
  type SpineVerdict,
} from "./grammar.ts";
import type { OutcomeVerification } from "./contract.ts";

export const FINISH_LINE_RESULT_SPEC = "finish-line-result/1";

/**
 * The external actions a finish line beyond merge-ready would invoke. Frozen
 * here because the journal's post-action payloads name them and the spine may
 * not reach into the policy module; the policy module's grant model consumes
 * this same list rather than re-authoring one.
 */
export const EXTERNAL_ACTIONS = Object.freeze(["pr-creation", "merge", "deploy"] as const);
export type ExternalAction = (typeof EXTERNAL_ACTIONS)[number];

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
  {
    name: "recordedCandidate",
    check: closed([
      { name: "treeSha", check: gitOid },
      { name: "baseTipSha", check: gitOid },
    ]),
  },
  { name: "policyDigest", check: sha256 },
  { name: "completedObligations", check: stringArray({ minItems: 1, item: spineId }) },
  { name: "trackedRecordDigest", check: sha256 },
  { name: "externalVerification", check: literal("passed") },
  { name: "productTrustLabel", check: literal(PRODUCT_TRUST_LABEL) },
  { name: "outcomeVerificationDigest", check: sha256 },
  { name: "mergeReadyObligationsSatisfied", check: literal(true) },
];

export interface FinishLineResult {
  readonly spec: typeof FINISH_LINE_RESULT_SPEC;
  readonly finishLine: "merge-ready";
  readonly deliveryId: string;
  /** The reviewed candidate — the one the outcome verification names. */
  readonly candidate: { readonly treeSha: string; readonly deliverableDigest: string };
  /** The candidate after the tracked record was committed, and its base tip. */
  readonly recordedCandidate: { readonly treeSha: string; readonly baseTipSha: string };
  readonly policyDigest: string;
  readonly completedObligations: readonly string[];
  readonly trackedRecordDigest: string;
  readonly externalVerification: "passed";
  readonly productTrustLabel: typeof PRODUCT_TRUST_LABEL;
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
