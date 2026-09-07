/** Shared interpretation of original host outcomes; used by emission and portable verification. */
import { digestCanonical } from "./digest.ts";
import { ReviewInputError as OutcomeError } from "./review-inputs.ts";
import type { CandidateBinding } from "./candidate.types.ts";
import type { ResolvedCharter } from "./review-inputs.ts";
export interface ReviewContextDocument {
  readonly spec: string;
  readonly digest: string;
  readonly binding: {
    readonly gate: { readonly obligationId: string; readonly providerId: string };
    readonly candidate: CandidateBinding & { readonly headSha: string };
    readonly preparationFingerprint: string;
    readonly configurationDigest: string;
    readonly policyDigest: string | null;
    readonly release: Readonly<Record<string, unknown>>;
    readonly workflowGraphSha256: string | null;
    readonly charters: readonly ResolvedCharter[];
  };
}
const REVIEW_CONTEXT_SPEC = "review-context/1";
const OUTCOME_SPEC = "review-outcome/1";
/** Reuse only the existing deliverable identity, with base, policy and wiring fixed. */
export function validateReviewedContext(original: unknown, current: ReviewContextDocument, outcome: unknown): void {
  if (!isRecord(original) || original["spec"] !== REVIEW_CONTEXT_SPEC ||
      Object.keys(original).sort().join(",") !== "binding,digest,spec" || !isRecord(original["binding"]) ||
      original["digest"] !== digestCanonical(original["binding"])) {
    throw new OutcomeError("the original review context is missing, malformed, or has a mismatched digest");
  }
  if (!isRecord(outcome) || outcome["contextDigest"] !== original["digest"]) {
    throw new OutcomeError("the outcome does not name the original review context digest");
  }
  const binding = original["binding"];
  const candidate = binding["candidate"];
  if (!isRecord(candidate) || !["treeSha", "headSha"].every((key) =>
    typeof candidate[key] === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate[key] as string))) {
    throw new OutcomeError("the original review context names no valid candidate");
  }
  // Raw tree and head may move when only review-neutral paths changed. Keep
  // the original coordinates in the retained context, while the manifest binds
  // the current prepared candidate, exactly as submission requires.
  const comparable = {
    ...binding,
    candidate: { ...candidate, treeSha: current.binding.candidate.treeSha, headSha: current.binding.candidate.headSha },
  };
  if (digestCanonical(comparable) !== digestCanonical(current.binding)) {
    throw new OutcomeError("the reviewed context differs from the current candidate, base, policy, wiring, release, or charters; acquire review for the current context");
  }
}

// ── The review outcome ───────────────────────────────────────────────────────

/** What one reviewer did. `approved` is the only result that stamps an approval. */
export const REVIEWER_RESULTS = ["approved", "rejected", "failed", "timed-out"] as const;
export type ReviewerResult = (typeof REVIEWER_RESULTS)[number];

export interface ReviewerOutcome {
  readonly id: string;
  readonly result: ReviewerResult;
}

export interface ReviewOutcome {
  readonly verdict: string;
  readonly reviewers: readonly ReviewerOutcome[];
  /** Findings, as the `review.green/1` payload defines them. Passed through. */
  readonly findings: readonly Record<string, unknown>[];
  readonly runHistory?: readonly Record<string, unknown>[];
  readonly finalPassId?: string;
  readonly cost?: Readonly<Record<string, unknown>>;
}

/** A refusal this emitter makes about its own inputs, before any manifest exists. */


const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read the outcome document, and hold it to the charter set. Nothing here
 * re-implements the `review.green/1` rules: findings travel through untouched
 * so the recorder — not this script — remains the judge of what green means.
 */
export function parseReviewOutcome(document: unknown, charters: readonly string[]): ReviewOutcome {
  if (!isRecord(document)) throw new OutcomeError("the review outcome is not a JSON object");
  if (document["spec"] !== OUTCOME_SPEC) {
    throw new OutcomeError(`the review outcome declares spec ${JSON.stringify(document["spec"])}, not ${OUTCOME_SPEC}`);
  }
  const verdict = document["verdict"];
  if (typeof verdict !== "string" || verdict === "") {
    throw new OutcomeError("the review outcome states no verdict");
  }
  const findings = document["findings"];
  if (!Array.isArray(findings) || !findings.every(isRecord)) {
    throw new OutcomeError("the review outcome's findings are not an array of objects");
  }

  const reviewers = document["reviewers"];
  if (!Array.isArray(reviewers)) throw new OutcomeError("the review outcome's reviewers are not an array");
  const named: ReviewerOutcome[] = [];
  const unnamed: ReviewerResult[] = [];
  const seen = new Set<string>();
  for (const entry of reviewers) {
    if (!isRecord(entry)) throw new OutcomeError("a reviewer outcome is not an object");
    const id = entry["id"];
    const result = entry["result"];
    // An absent id is the unnamed form, resolved below. A present one that is
    // not a usable id is still a document naming a reviewer it cannot name.
    const carriesId = id !== undefined;
    if (carriesId && (typeof id !== "string" || id === "")) {
      throw new OutcomeError("a reviewer outcome names no reviewer");
    }
    const subject = carriesId ? `reviewer ${id as string}` : "an unnamed reviewer outcome";
    if (typeof result !== "string" || !(REVIEWER_RESULTS as readonly string[]).includes(result)) {
      throw new OutcomeError(
        `${subject} reports result ${JSON.stringify(result)}, which is not one of ${REVIEWER_RESULTS.join(", ")}`,
      );
    }
    if (!carriesId) {
      unnamed.push(result as ReviewerResult);
      continue;
    }
    const reviewerId = id as string;
    if (seen.has(reviewerId)) throw new OutcomeError(`reviewer ${reviewerId} appears twice in the review outcome`);
    seen.add(reviewerId);
    named.push({ id: reviewerId, result: result as ReviewerResult });
  }

  // ── The unnamed form ───────────────────────────────────────────────────────
  //
  // The ids are this emitter's to resolve, not the caller's to restate: they
  // are charter-path basenames inside an installed archive that the compiled
  // policy selects from, and a caller who restates them is performing the same
  // resolution a second time with no way to check the answer. So an outcome
  // may carry results alone and take `charters` as its ids.
  //
  // It may not, however, DISTINGUISH its reviewers without naming them.
  // Nothing in the document says which result belongs to which lens, so the
  // assignment can only be positional — and a positional assignment that
  // matters is one where the wrong reviewer is silently stamped approved while
  // the one that failed is reported clean. Refusing every disagreeing unnamed
  // document keeps position load-bearing for nothing: the results are
  // interchangeable exactly when the order cannot matter.
  if (unnamed.length > 0) {
    if (named.length > 0) {
      throw new OutcomeError(
        `the review outcome names ${named.length} of its ${reviewers.length} reviewers and leaves the rest unnamed; a document that distinguishes its reviewers names every one of them`,
      );
    }
    if (unnamed.length !== charters.length) {
      throw new OutcomeError(
        `the review outcome carries ${unnamed.length} result(s) under no reviewer id, and the policy selects ${charters.length} reviewer(s): ${charters.join(", ")}`,
      );
    }
    const distinct = [...new Set(unnamed)];
    if (distinct.length > 1) {
      throw new OutcomeError(
        `the review outcome's unnamed results disagree (${distinct.join(", ")}), so which reviewer reported which would be decided by their order; name the reviewers instead`,
      );
    }
    for (const [index, result] of unnamed.entries()) {
      const reviewerId = charters[index]!;
      seen.add(reviewerId);
      named.push({ id: reviewerId, result });
    }
  }
  const parsed = named;

  // The charter set is the authority in both directions: a charter with no
  // outcome is a lens that did not review, and an outcome with no charter is a
  // reviewer this repository does not have.
  const charterSet = new Set(charters);
  const missing = charters.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new OutcomeError(
      `the review outcome leaves ${missing.length} charter(s) unrepresented: ${missing.join(", ")}`,
    );
  }
  const unknown = parsed.map((entry) => entry.id).filter((id) => !charterSet.has(id));
  if (unknown.length > 0) {
    throw new OutcomeError(
      `the review outcome names ${unknown.length} reviewer(s) no activated review lens defines: ${unknown.join(", ")}`,
    );
  }

  const runHistory = document["runHistory"];
  const finalPassId = document["finalPassId"];
  if (runHistory !== undefined && (!Array.isArray(runHistory) || runHistory.length === 0 || !runHistory.every(isRecord) ||
      typeof finalPassId !== "string" || finalPassId === "")) {
    throw new OutcomeError("review runHistory requires a nonempty history and its actual finalPassId");
  }
  const cost = document["cost"];
  if (cost !== undefined && (!isRecord(cost) || typeof document["costCoverage"] !== "string" || !document["costCoverage"].trim())) {
    throw new OutcomeError("reported review cost requires an explicit costCoverage description");
  }
  return {
    verdict, reviewers: parsed, findings: findings as Record<string, unknown>[],
    ...(runHistory === undefined ? {} : { runHistory: runHistory as Record<string, unknown>[], finalPassId: finalPassId as string }),
    ...(cost === undefined ? {} : { cost: cost as Record<string, unknown> }),
  };
}

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

/**
 * Telemetry, derived from the findings exactly the way RG-8 re-derives it:
 * counts per severity, deferrals, and the sorted unique tracker ids they name.
 */
export function deriveTelemetry(
  findings: readonly Record<string, unknown>[],
  iterationCount: number,
): Record<string, unknown> {
  const findingCounts: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    const severity = finding["severity"];
    if (typeof severity === "string" && (SEVERITIES as readonly string[]).includes(severity)) {
      findingCounts[severity] = (findingCounts[severity] ?? 0) + 1;
    }
  }
  const deferred = findings.filter((finding) => finding["disposition"] === "deferred");
  const deferredIssueIds = [
    ...new Set(
      deferred
        .map((finding) => finding["deferredIssueId"])
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ].sort();
  return {
    iterationCount,
    findingCounts,
    deferredExpansionCount: deferred.length,
    deferredIssueIds,
  };
}

/** The reviewer lists RG-2/RG-3 read, from what each reviewer actually did. */
export function reviewerLists(
  charters: readonly string[],
  outcome: ReviewOutcome,
): { selected: string[]; completed: string[]; failed: string[]; timedOut: string[]; approved: string[] } {
  const byId = new Map(outcome.reviewers.map((reviewer) => [reviewer.id, reviewer.result]));
  const withResult = (...results: readonly ReviewerResult[]): string[] =>
    charters.filter((id) => results.includes(byId.get(id)!));
  return {
    selected: [...charters],
    completed: withResult("approved", "rejected"),
    failed: withResult("failed"),
    timedOut: withResult("timed-out"),
    approved: withResult("approved"),
  };
}
