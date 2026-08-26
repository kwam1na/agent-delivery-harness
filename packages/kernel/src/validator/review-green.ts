/**
 * The normative `review.green/1` payload validator (spec §9).
 *
 * The payload is a claim that an independent, complete code review of the final
 * candidate concluded green. The rules here never ask *how* the review was
 * conducted — reviewer selection, models and prompts belong to the provider
 * (§3, principle 5). They ask whether what is claimed is internally coherent and
 * bound to the candidate:
 *
 *   SELF-CONSISTENCY IS CHECKED, NOT TRUSTED (§3, principle 6). Every telemetry
 *   number the payload states is derivable from its own findings, so it is
 *   re-derived and compared rather than read. A count that contradicts the
 *   findings it counts is a rejection, not a display quirk.
 *
 *   APPROVALS RE-STATE THE BINDING (§9.2). Each selected reviewer is covered by
 *   exactly one approval stamp that repeats the provider triple, the workspace,
 *   and the whole candidate — so each stamp is independently interpretable in an
 *   audit, and a stamp from another run or another tree cannot be reused here.
 *
 *   GREEN IS AN ABSENCE OF OPEN WORK. A blocking finding, an actionable finding
 *   left unresolved or ignored, a deferral that skips the tracker or defers what
 *   may never be deferred — each contradicts the verdict, and RG-6 and RG-7 make
 *   the contradiction mechanical rather than editorial.
 *
 * PURITY. Approval stamps arrive as bytes the caller already read; this module
 * parses strings and touches no filesystem.
 */
import type { DeclaredArtifact } from "./envelope.ts";
import {
  DEFERRED_ISSUE_ID,
  GEN_1_UNKNOWN,
  GEN_4_MISSING,
  canonicallyEqual,
  checkMembers,
  isNonEmptyString,
  isRecord,
  member,
  pointer,
  type Collector,
  type MemberCodes,
} from "./grammar.ts";

// ── Enumerations ───────────────────────────────────────────────────────────

export const FINDING_SEVERITIES: readonly string[] = Object.freeze(["P0", "P1", "P2", "P3"]);
export const FINDING_SCOPES: readonly string[] = Object.freeze(["in_contract", "adjacent", "expansion"]);
export const FINDING_DISPOSITIONS: readonly string[] = Object.freeze([
  "resolved",
  "advisory",
  "pre_existing",
  "deferred",
  "unresolved",
  "ignored",
]);

/** RG-6: what an actionable finding may conclude in a green review. */
const SETTLED_DISPOSITIONS: readonly string[] = Object.freeze(["resolved", "pre_existing", "deferred"]);

/** RG-7: no P0 or P1 may ever be deferred, regardless of scope. */
const DEFERRABLE_SEVERITIES: readonly string[] = Object.freeze(["P2", "P3"]);

/** The artifact role §9.2 defines. */
export const REVIEWER_APPROVAL_ROLE = "reviewer-approval";

// ── Grammar tables ─────────────────────────────────────────────────────────

const PAYLOAD_MEMBERS = {
  required: ["verdict", "finalized", "editedAfterFinalPass", "reviewers", "findings", "telemetry"],
} as const;

const REVIEWERS_MEMBERS = { required: ["selected", "completed", "failed", "timedOut"] } as const;

const FINDING_MEMBERS = {
  required: ["id", "severity", "scope", "actionable", "blocking", "disposition"],
  optional: ["deferredIssueId"],
} as const;

const TELEMETRY_MEMBERS = {
  required: ["iterationCount", "findingCounts", "deferredExpansionCount", "deferredIssueIds"],
  optional: ["cost"],
} as const;

const FINDING_COUNTS_MEMBERS = { required: ["P0", "P1", "P2", "P3"] } as const;

const COST_MEMBERS = { required: ["unit", "total", "reportedBy"], optional: ["byReviewer"] } as const;

const APPROVAL_MEMBERS = {
  required: ["schemaVersion", "reviewerId", "result", "provider", "workspaceId", "candidate"],
} as const;

/**
 * The stamp's provider triple is closed like every other object in the
 * contract. The candidate inside a stamp is compared by canonical form, so an
 * extra member there is already a mismatch; this nested object is compared
 * member by member, so without its own table it would be the one place in the
 * §9.2 grammar something could ride along.
 */
const APPROVAL_PROVIDER_MEMBERS = { required: ["id", "runId", "finalPassId"] } as const;

const FINDING_CODES: MemberCodes = {
  unknown: GEN_1_UNKNOWN,
  missing: { code: "finding_invalid", rule: "RG-5" },
};

const COST_CODES: MemberCodes = {
  unknown: GEN_1_UNKNOWN,
  missing: { code: "invalid_cost", rule: "RG-10" },
};

const APPROVAL_CODES: MemberCodes = {
  unknown: { code: "approval_mismatch", rule: "RG-4" },
  missing: { code: "approval_mismatch", rule: "RG-4" },
};

// ── Input ──────────────────────────────────────────────────────────────────

export interface ReviewGreenClaimInput {
  readonly payload: Record<string, unknown>;
  /** Pointer to the payload inside the manifest. */
  readonly at: string;
  /** The envelope's provider triple, as submitted. Approval stamps must repeat it. */
  readonly provider: { readonly id: unknown; readonly runId: unknown; readonly finalPassId: unknown };
  /** The envelope's candidate, as submitted. Approval stamps must repeat it. */
  readonly candidate: unknown;
  readonly artifacts: readonly DeclaredArtifact[];
  readonly artifactContents: ReadonlyMap<string, string>;
  readonly runHistoryLength: number;
}

// ── Entry point ────────────────────────────────────────────────────────────

export function validateReviewGreenClaim(input: ReviewGreenClaimInput, collector: Collector): void {
  const { payload, at } = input;

  checkMembers(payload, at, PAYLOAD_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);

  checkVerdict(payload, at, collector);
  const selected = checkReviewers(payload, at, collector);
  const findings = checkFindings(payload, at, collector);
  checkApprovals(input, selected, collector);
  checkTelemetry(input, selected, findings, collector);
}

// ── RG-1 ───────────────────────────────────────────────────────────────────

function checkVerdict(payload: Record<string, unknown>, at: string, collector: Collector): void {
  const verdict = member(payload, "verdict");
  if (verdict !== undefined && verdict !== "green") {
    collector.emit("verdict_not_green", "RG-1", pointer(at, "verdict"), "a manifest is only submitted for a concluded, passing review");
  }
  const finalized = member(payload, "finalized");
  if (finalized !== undefined && finalized !== true) {
    collector.emit("not_finalized", "RG-1", pointer(at, "finalized"), "an unfinalized review has no claim to make");
  }
  const edited = member(payload, "editedAfterFinalPass");
  if (edited !== undefined && edited !== false) {
    collector.emit("edited_after_final_pass", "RG-1", pointer(at, "editedAfterFinalPass"), "the reviewed tree is not the tree being submitted");
  }
}

// ── RG-2, RG-3 ─────────────────────────────────────────────────────────────

function checkReviewers(payload: Record<string, unknown>, at: string, collector: Collector): readonly string[] {
  const reviewers = member(payload, "reviewers");
  const reviewersAt = pointer(at, "reviewers");

  if (!isRecord(reviewers)) {
    if (reviewers !== undefined) {
      collector.emit("reviewer_set_invalid", "RG-2", reviewersAt, "reviewers is not an object");
    }
    return [];
  }

  checkMembers(reviewers, reviewersAt, REVIEWERS_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);

  const selected = readReviewerList(reviewers, "selected", reviewersAt, collector);
  if (selected.length === 0) {
    collector.emit("reviewer_set_invalid", "RG-2", pointer(reviewersAt, "selected"), "a review with no reviewers is not a review");
  } else if (new Set(selected).size !== selected.length) {
    collector.emit("reviewer_set_invalid", "RG-2", pointer(reviewersAt, "selected"), "selected reviewers are not unique");
  }

  const completed = readReviewerList(reviewers, "completed", reviewersAt, collector);
  const selectedSet = new Set(selected);
  const completedSet = new Set(completed);
  const setEqual = selectedSet.size === completedSet.size && [...selectedSet].every((id) => completedSet.has(id));
  if (!setEqual) {
    collector.emit("reviewer_set_incomplete", "RG-3", pointer(reviewersAt, "completed"), "completed is not set-equal to selected");
  }

  // A degraded reviewer set is not green: whatever the provider chose, it has
  // to have finished.
  for (const name of ["failed", "timedOut"]) {
    const list = readReviewerList(reviewers, name, reviewersAt, collector);
    if (list.length > 0) {
      collector.emit("reviewer_set_incomplete", "RG-3", pointer(reviewersAt, name), "a reviewer that did not complete is present");
    }
  }

  return selected;
}

function readReviewerList(reviewers: Record<string, unknown>, name: string, at: string, collector: Collector): readonly string[] {
  const value = member(reviewers, name);
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    collector.emit("reviewer_set_invalid", "RG-2", pointer(at, name), "reviewer list is not an array");
    return [];
  }
  const entries: string[] = [];
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      collector.emit("reviewer_set_invalid", "RG-2", pointer(at, name, index), "reviewer id is empty or not a string");
      return;
    }
    entries.push(entry);
  });
  return entries;
}

// ── RG-5, RG-6, RG-7 ───────────────────────────────────────────────────────

interface DerivedFinding {
  readonly severity: unknown;
  readonly disposition: unknown;
  readonly deferredIssueId: unknown;
}

function checkFindings(payload: Record<string, unknown>, at: string, collector: Collector): readonly DerivedFinding[] {
  const findings = member(payload, "findings");
  const findingsAt = pointer(at, "findings");

  if (!Array.isArray(findings)) {
    if (findings !== undefined) collector.emit("finding_invalid", "RG-5", findingsAt, "findings is not an array");
    return [];
  }

  const derived: DerivedFinding[] = [];
  const ids = new Set<string>();

  findings.forEach((finding, index) => {
    const findingAt = pointer(findingsAt, index);
    if (!isRecord(finding)) {
      collector.emit("finding_invalid", "RG-5", findingAt, "finding is not an object");
      return;
    }

    checkMembers(finding, findingAt, FINDING_MEMBERS, FINDING_CODES, collector);

    const id = member(finding, "id");
    if (id !== undefined) {
      if (!isNonEmptyString(id)) {
        collector.emit("finding_invalid", "RG-5", pointer(findingAt, "id"), "finding id is empty or not a string");
      } else if (ids.has(id)) {
        collector.emit("finding_invalid", "RG-5", pointer(findingAt, "id"), "finding id is not unique");
      } else {
        ids.add(id);
      }
    }

    const severity = member(finding, "severity");
    if (severity !== undefined && !FINDING_SEVERITIES.includes(severity as string)) {
      collector.emit("finding_invalid", "RG-5", pointer(findingAt, "severity"), "severity is not a defined value");
    }
    const scope = member(finding, "scope");
    if (scope !== undefined && !FINDING_SCOPES.includes(scope as string)) {
      collector.emit("finding_invalid", "RG-5", pointer(findingAt, "scope"), "scope is not a defined value");
    }
    const disposition = member(finding, "disposition");
    if (disposition !== undefined && !FINDING_DISPOSITIONS.includes(disposition as string)) {
      collector.emit("finding_invalid", "RG-5", pointer(findingAt, "disposition"), "disposition is not a defined value");
    }

    const actionable = member(finding, "actionable");
    const blocking = member(finding, "blocking");
    if (actionable !== undefined && typeof actionable !== "boolean") {
      collector.emit("finding_invalid", "RG-5", pointer(findingAt, "actionable"), "actionable is not a boolean");
    }
    if (blocking !== undefined && typeof blocking !== "boolean") {
      collector.emit("finding_invalid", "RG-5", pointer(findingAt, "blocking"), "blocking is not a boolean");
    }

    // RG-6.
    if (blocking === true) {
      collector.emit("blocking_finding_present", "RG-6", pointer(findingAt, "blocking"), "a blocking finding contradicts a green verdict");
    }
    if (actionable === true && disposition !== undefined && !SETTLED_DISPOSITIONS.includes(disposition as string)) {
      collector.emit("actionable_unresolved", "RG-6", pointer(findingAt, "disposition"), "actionable work is neither resolved, pre-existing, nor deferred");
    }

    // RG-7.
    const deferredIssueId = member(finding, "deferredIssueId");
    if (disposition === "deferred") {
      const legal =
        actionable === true &&
        blocking === false &&
        DEFERRABLE_SEVERITIES.includes(severity as string) &&
        scope === "expansion" &&
        isNonEmptyString(deferredIssueId) &&
        DEFERRED_ISSUE_ID.test(deferredIssueId);
      if (!legal) {
        collector.emit("illegal_deferral", "RG-7", findingAt, "deferral does not satisfy every condition deferral requires");
      }
    } else if (deferredIssueId !== undefined) {
      collector.emit("illegal_deferral", "RG-7", pointer(findingAt, "deferredIssueId"), "a tracker id on a finding that was not deferred");
    }

    derived.push({ severity, disposition, deferredIssueId });
  });

  return derived;
}

// ── RG-4 ───────────────────────────────────────────────────────────────────

function checkApprovals(input: ReviewGreenClaimInput, selected: readonly string[], collector: Collector): void {
  const approvals = input.artifacts.filter((artifact) => artifact.role === REVIEWER_APPROVAL_ROLE);
  const covered = new Map<string, number>();

  for (const artifact of approvals) {
    const at = pointer("/artifacts", artifact.index);
    const content = input.artifactContents.get(artifact.path);
    if (content === undefined) {
      // No bytes, no stamp. An artifact the caller could not produce content
      // for is not evidence of anything.
      collector.emit("approval_mismatch", "RG-4", at, "approval artifact content is unavailable");
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      collector.emit("approval_mismatch", "RG-4", at, "approval artifact is not JSON");
      continue;
    }
    if (!isRecord(parsed)) {
      collector.emit("approval_mismatch", "RG-4", at, "approval artifact is not a JSON object");
      continue;
    }

    checkMembers(parsed, at, APPROVAL_MEMBERS, APPROVAL_CODES, collector);

    const reviewerId = member(parsed, "reviewerId");
    if (isNonEmptyString(reviewerId)) {
      covered.set(reviewerId, (covered.get(reviewerId) ?? 0) + 1);
    } else {
      collector.emit("approval_mismatch", "RG-4", pointer(at, "reviewerId"), "approval names no reviewer");
    }

    if (member(parsed, "schemaVersion") !== 1) {
      collector.emit("approval_mismatch", "RG-4", pointer(at, "schemaVersion"), "approval stamp schema version is not the one §9.2 defines");
    }
    if (member(parsed, "result") !== "approved") {
      collector.emit("approval_mismatch", "RG-4", pointer(at, "result"), "approval stamp does not record an approval");
    }

    const stampProvider = member(parsed, "provider");
    if (isRecord(stampProvider)) {
      checkMembers(stampProvider, pointer(at, "provider"), APPROVAL_PROVIDER_MEMBERS, APPROVAL_CODES, collector);
    }
    const providerMatches =
      isRecord(stampProvider) &&
      member(stampProvider, "id") === input.provider.id &&
      member(stampProvider, "runId") === input.provider.runId &&
      member(stampProvider, "finalPassId") === input.provider.finalPassId;
    if (!providerMatches) {
      collector.emit("approval_mismatch", "RG-4", pointer(at, "provider"), "approval stamp names a different provider, run, or pass");
    }

    const envelopeWorkspaceId = isRecord(input.candidate) ? member(input.candidate, "workspaceId") : undefined;
    if (member(parsed, "workspaceId") !== envelopeWorkspaceId) {
      collector.emit("approval_mismatch", "RG-4", pointer(at, "workspaceId"), "approval stamp names a different workspace");
    }

    if (!canonicallyEqual(member(parsed, "candidate"), input.candidate)) {
      collector.emit("approval_mismatch", "RG-4", pointer(at, "candidate"), "approval stamp restates a different candidate");
    }
  }

  // One-to-one correspondence with `selected`, in both directions.
  for (const reviewer of selected) {
    const count = covered.get(reviewer) ?? 0;
    if (count === 0) {
      collector.emit("approval_missing", "RG-4", "/artifacts", "a selected reviewer has no approval artifact");
    } else if (count > 1) {
      collector.emit("approval_mismatch", "RG-4", "/artifacts", "a selected reviewer is covered by more than one approval artifact");
    }
  }
  const selectedSet = new Set(selected);
  for (const reviewer of covered.keys()) {
    if (!selectedSet.has(reviewer)) {
      collector.emit("approval_mismatch", "RG-4", "/artifacts", "an approval artifact names a reviewer that was not selected");
    }
  }
}

// ── RG-8, RG-9, RG-10 ──────────────────────────────────────────────────────

function checkTelemetry(
  input: ReviewGreenClaimInput,
  selected: readonly string[],
  findings: readonly DerivedFinding[],
  collector: Collector,
): void {
  const at = pointer(input.at, "telemetry");
  const telemetry = member(input.payload, "telemetry");

  if (!isRecord(telemetry)) {
    if (telemetry !== undefined) collector.emit("telemetry_mismatch", "RG-8", at, "telemetry is not an object");
    return;
  }

  checkMembers(telemetry, at, TELEMETRY_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);

  // RG-9: one iteration per prepare-and-evaluate pass, and the run history is
  // the record of those passes.
  const iterationCount = member(telemetry, "iterationCount");
  if (iterationCount !== input.runHistoryLength) {
    collector.emit("iteration_count_mismatch", "RG-9", pointer(at, "iterationCount"), "iteration count disagrees with the number of run history entries");
  }

  // RG-8: re-derive, never trust.
  const derivedCounts: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    if (typeof finding.severity === "string" && Object.prototype.hasOwnProperty.call(derivedCounts, finding.severity)) {
      derivedCounts[finding.severity] = (derivedCounts[finding.severity] ?? 0) + 1;
    }
  }

  const declaredCounts = member(telemetry, "findingCounts");
  const countsAt = pointer(at, "findingCounts");
  if (isRecord(declaredCounts)) {
    checkMembers(declaredCounts, countsAt, FINDING_COUNTS_MEMBERS, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);
    for (const severity of FINDING_SEVERITIES) {
      if (member(declaredCounts, severity) !== derivedCounts[severity]) {
        collector.emit("telemetry_mismatch", "RG-8", pointer(countsAt, severity), "declared finding count disagrees with the findings");
      }
    }
  } else if (declaredCounts !== undefined) {
    collector.emit("telemetry_mismatch", "RG-8", countsAt, "findingCounts is not an object");
  }

  const deferred = findings.filter((finding) => finding.disposition === "deferred");
  if (member(telemetry, "deferredExpansionCount") !== deferred.length) {
    collector.emit("telemetry_mismatch", "RG-8", pointer(at, "deferredExpansionCount"), "deferral count disagrees with the findings");
  }

  const derivedIds = [...new Set(deferred.map((finding) => finding.deferredIssueId).filter(isNonEmptyString))].sort();
  const declaredIds = member(telemetry, "deferredIssueIds");
  if (!Array.isArray(declaredIds) || !canonicallyEqual(declaredIds, derivedIds)) {
    collector.emit("telemetry_mismatch", "RG-8", pointer(at, "deferredIssueIds"), "deferred issue ids disagree with the findings");
  }

  checkCost(telemetry, at, selected, collector);
}

function checkCost(telemetry: Record<string, unknown>, telemetryAt: string, selected: readonly string[], collector: Collector): void {
  const cost = member(telemetry, "cost");
  if (cost === undefined) return;

  const at = pointer(telemetryAt, "cost");
  if (!isRecord(cost)) {
    collector.emit("invalid_cost", "RG-10", at, "cost is not an object");
    return;
  }

  checkMembers(cost, at, COST_MEMBERS, COST_CODES, collector);

  if (!isNonEmptyString(member(cost, "unit"))) {
    collector.emit("invalid_cost", "RG-10", pointer(at, "unit"), "cost unit is empty or not a string");
  }
  if (!isNonEmptyString(member(cost, "reportedBy"))) {
    // Cost is provider-self-reported; who reported it is what makes a series
    // comparable at all, so an unattributed number is not a cost.
    collector.emit("invalid_cost", "RG-10", pointer(at, "reportedBy"), "cost reporter is empty or not a string");
  }

  const total = member(cost, "total");
  const totalIsNumber = typeof total === "number" && Number.isFinite(total);
  if (!totalIsNumber || total < 0) {
    collector.emit("invalid_cost", "RG-10", pointer(at, "total"), "cost total is not a non-negative number");
  }

  const byReviewer = member(cost, "byReviewer");
  if (byReviewer === undefined) return;
  if (!isRecord(byReviewer)) {
    collector.emit("invalid_cost", "RG-10", pointer(at, "byReviewer"), "cost breakdown is not an object");
    return;
  }

  const selectedSet = new Set(selected);
  let sum = 0;
  for (const reviewer of Object.keys(byReviewer)) {
    if (!selectedSet.has(reviewer)) {
      collector.emit("invalid_cost", "RG-10", pointer(at, "byReviewer", reviewer), "cost breakdown names a reviewer that was not selected");
    }
    const amount = member(byReviewer, reviewer);
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      collector.emit("invalid_cost", "RG-10", pointer(at, "byReviewer", reviewer), "cost share is not a non-negative number");
      continue;
    }
    sum += amount;
  }

  if (totalIsNumber && sum > total) {
    collector.emit("invalid_cost", "RG-10", pointer(at, "byReviewer"), "cost breakdown sums above the reported total");
  }
}
