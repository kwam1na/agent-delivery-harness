/**
 * The evidence module's V-slice: the mandatory review floor over recorded reviewer
 * attempts, and the criterion-by-criterion outcome composition that keeps a
 * green-but-unrelated change from passing.
 *
 * INDEPENDENCE IS FALSIFIABLE. Every attempt binds a context digest; two
 * attempts carrying the same digest are the same review invoked twice, and
 * re-invoking the same agent, prompt, and context under a fresh attempt
 * identity does not satisfy the floor. The floor also demands both mandatory
 * lenses, distinct attempt identities, and attempts bound to the CURRENT
 * candidate — an aligned final review after every mutation, never a stale
 * approval carried forward.
 *
 * CRITERION MAPPING. Each acceptance criterion maps to the trusted sensor's
 * latest result FOR THE EXACT CANDIDATE. A missing result, a failed result,
 * or a result naming a different candidate leaves the criterion `blocked` —
 * the disposition the merge-ready finish line refuses — which is precisely
 * how an unrelated green change fails criterion mapping instead of riding
 * through on repository-wide green.
 */
import { spinePointer, type SpineRejectionCode } from "../spine/grammar.ts";
import type { AcceptedContract, OutcomeVerification } from "../spine/contract.ts";

/** The evidence module's rejection vocabulary widens the spine's, never edits it. */
export type ReviewRejectionCode = SpineRejectionCode | "duplicate_review_context";

export interface ReviewRejection {
  readonly code: ReviewRejectionCode;
  readonly pointer: string;
  readonly message: string;
}

export type ReviewVerdict = { readonly ok: true } | { readonly ok: false; readonly rejections: readonly ReviewRejection[] };

export interface RecordedReviewAttempt {
  readonly attemptId: string;
  readonly lensId: string;
  readonly contextDigest: string;
  readonly artifactDigest: string;
  readonly verdict: "approved" | "findings";
  /** The candidate the attempt reviewed — independence is per candidate. */
  readonly candidateTreeSha: string;
}

export interface RecordedSensorResult {
  readonly capabilityId: string;
  readonly outcome: "passed" | "failed";
  readonly summary: string;
  readonly candidateTreeSha: string;
}

export interface ReviewLensSelection {
  readonly lensId: string;
  readonly category: string;
}

export interface QualifiedAttempts {
  /** Attempts that count toward independence, in submission order. */
  readonly qualified: readonly RecordedReviewAttempt[];
  /** Same-context re-invocations: recorded, but they can never count. */
  readonly disqualified: readonly { readonly attempt: RecordedReviewAttempt; readonly collidesWith: string }[];
}

/**
 * Same-context re-invocation under a fresh attempt identity does not qualify
 * as independence: the FIRST attempt carrying a context digest counts, and
 * every later attempt carrying the same digest is disqualified. Only attempts
 * bound to the current candidate are considered at all.
 */
export function qualifyReviewAttempts(
  attempts: readonly RecordedReviewAttempt[],
  candidateTreeSha: string,
): QualifiedAttempts {
  const qualified: RecordedReviewAttempt[] = [];
  const disqualified: { attempt: RecordedReviewAttempt; collidesWith: string }[] = [];
  const holders = new Map<string, string>();
  for (const attempt of attempts) {
    if (attempt.candidateTreeSha !== candidateTreeSha) continue;
    const holder = holders.get(attempt.contextDigest);
    if (holder !== undefined) {
      disqualified.push({ attempt, collidesWith: holder });
      continue;
    }
    holders.set(attempt.contextDigest, attempt.attemptId);
    qualified.push(attempt);
  }
  return { qualified, disqualified };
}

/**
 * The admission-side review floor. Considers only attempts bound to the
 * current candidate; everything else is a superseded review. A duplicated
 * attempt identity rejects outright; a duplicated context disqualifies the
 * re-invocation, so a mandatory lens covered only by a same-context
 * re-invocation is an uncovered lens.
 */
export function checkReviewFloor(input: {
  readonly attempts: readonly RecordedReviewAttempt[];
  readonly lenses: readonly ReviewLensSelection[];
  readonly candidateTreeSha: string;
}): ReviewVerdict {
  const rejections: ReviewRejection[] = [];
  const emit = (code: ReviewRejectionCode, pointer: string, message: string): void => {
    rejections.push({ code, pointer, message });
  };
  const current = input.attempts.filter((attempt) => attempt.candidateTreeSha === input.candidateTreeSha);

  if (current.length === 0) {
    emit(
      "zero_review_attempts",
      "/attempts",
      "no completed review attempt is bound to the current candidate; an aligned final review is mandatory after every mutation",
    );
    return { ok: false, rejections };
  }

  const seenAttemptIds = new Set<string>();
  current.forEach((attempt, index) => {
    if (seenAttemptIds.has(attempt.attemptId)) {
      emit(
        "duplicate_review_attempt",
        spinePointer("/attempts", index, "attemptId"),
        `attempt ${attempt.attemptId} appears twice; review attempts complete under distinct attempt identities`,
      );
    }
    seenAttemptIds.add(attempt.attemptId);
  });

  const { qualified, disqualified } = qualifyReviewAttempts(input.attempts, input.candidateTreeSha);
  for (const lens of input.lenses) {
    if (qualified.some((attempt) => attempt.lensId === lens.lensId)) continue;
    const collision = disqualified.find((entry) => entry.attempt.lensId === lens.lensId);
    if (collision !== undefined) {
      emit(
        "duplicate_review_context",
        "/attempts",
        `mandatory lens ${lens.lensId} is covered only by attempt ${collision.attempt.attemptId}, which carries the same context digest as ${collision.collidesWith}; same-context re-invocation under a fresh attempt identity does not qualify as independence`,
      );
      continue;
    }
    emit(
      "criterion_unverified",
      "/attempts",
      `mandatory lens ${lens.lensId} (${lens.category}) has no completed attempt on the current candidate`,
    );
  }

  return rejections.length === 0 ? { ok: true } : { ok: false, rejections };
}

/** One criterion whose waiver was CONSUMED — never merely proposed. */
export interface ConsumedWaiver {
  readonly criterionId: string;
  /** The approval this disposition rests on, named in the claim. */
  readonly reference: string;
}

/**
 * Composes the outcome-verification claim: each acceptance criterion mapped
 * to the trusted sensor's exact-candidate evidence and one disposition.
 * Composition never invents a pass — an unproven criterion is `blocked`.
 *
 * `amended-waived` appears ONLY where a waiver was consumed under the
 * sensitive-approval lane, and only where the criterion would otherwise have
 * blocked: a waiver is a way past missing evidence, never a way to relabel
 * evidence that exists.
 */
export function composeOutcomeVerification(input: {
  readonly contract: AcceptedContract;
  readonly candidate: { readonly treeSha: string; readonly deliverableDigest: string };
  readonly sensorResults: readonly RecordedSensorResult[];
  readonly attempts: readonly RecordedReviewAttempt[];
  readonly waivedCriteria?: readonly ConsumedWaiver[];
}): OutcomeVerification {
  const waived = new Map((input.waivedCriteria ?? []).map((entry) => [entry.criterionId, entry.reference]));
  const criteria: OutcomeVerification["criteria"][number][] = input.contract.acceptanceCriteria.map((criterion) => {
    // The skeleton's fixed policy carries one trusted sensor; every criterion
    // binds to its latest result. The result must name the exact candidate.
    const latest = [...input.sensorResults]
      .reverse()
      .find((result) => result.candidateTreeSha === input.candidate.treeSha);
    const passed = latest !== undefined && latest.outcome === "passed";
    const waiver = waived.get(criterion.criterionId);
    if (!passed && waiver !== undefined) {
      return {
        criterionId: criterion.criterionId,
        disposition: "amended-waived" as const,
        evidence: { kind: "review" as const, reference: waiver },
      };
    }
    return {
      criterionId: criterion.criterionId,
      disposition: (passed ? "passed" : "blocked") as "passed" | "blocked",
      evidence: {
        kind: "sensor" as const,
        reference:
          latest === undefined
            ? "sensor.acceptance: no exact-candidate result"
            : `${latest.capabilityId}@${latest.candidateTreeSha}: ${latest.outcome}`,
      },
    };
  });

  return {
    spec: "outcome-verification/1",
    contractId: input.contract.contractId,
    candidate: { ...input.candidate },
    criteria,
    reviewAttempts: qualifyReviewAttempts(input.attempts, input.candidate.treeSha).qualified
      .map((attempt) => ({
        attemptId: attempt.attemptId,
        lensId: attempt.lensId,
        contextDigest: attempt.contextDigest,
        verdict: attempt.verdict,
      })),
  };
}
