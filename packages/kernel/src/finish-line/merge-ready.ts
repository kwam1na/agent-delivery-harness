/**
 * The finish-line module's V-slice: composing the ONE frozen merge-ready
 * result from an outcome verification. Composition binds the verification by
 * canonical digest and immediately re-checks itself through the spine's own
 * cross-rules — a result the spine would refuse is never handed out. `merge`
 * and `deploy` are outside the skeleton entirely.
 */
import { digestCanonical } from "../digest.ts";
import type { OutcomeVerification } from "../spine/contract.ts";
import { checkMergeReadyAgainstOutcome, validateFinishLineResult, type FinishLineResult } from "../spine/finish-line.ts";
import type { SpineRejection } from "../spine/grammar.ts";

export type ComposeMergeReadyResult =
  | { readonly ok: true; readonly result: FinishLineResult }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export function composeMergeReadyResult(input: {
  readonly deliveryId: string;
  readonly outcome: OutcomeVerification;
}): ComposeMergeReadyResult {
  const result: FinishLineResult = {
    spec: "finish-line-result/1",
    finishLine: "merge-ready",
    deliveryId: input.deliveryId,
    candidate: { ...input.outcome.candidate },
    outcomeVerificationDigest: digestCanonical(input.outcome),
    mergeReadyObligationsSatisfied: true,
  };

  const shape = validateFinishLineResult(result);
  if (!shape.ok) return shape;
  const cross = checkMergeReadyAgainstOutcome(result, input.outcome);
  if (!cross.ok) return cross;
  return { ok: true, result };
}
