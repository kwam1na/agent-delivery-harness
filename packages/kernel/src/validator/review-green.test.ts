/**
 * The `review.green/1` payload rules, exercised directly.
 *
 * The kit proves each rejection happens; this proves each *clause* is doing
 * work. Deferral is the clearest case and the one with the most clauses: RG-7
 * legalizes exactly one combination — actionable, non-blocking, P2 or P3,
 * expansion-scope, with a real tracker id — and every vector in the kit deviates
 * in one of those dimensions. A validator that dropped the severity clause would
 * still pass most of them. Here the legal combination is asserted accepted and
 * each single deviation asserted rejected, so dropping any clause turns this
 * file red immediately.
 */
import { describe, expect, it } from "vitest";
import { createCollector } from "./grammar.ts";
import { validateReviewGreenClaim, type ReviewGreenClaimInput } from "./review-green.ts";

const CANDIDATE = {
  vcs: "git",
  treeSha: "1".repeat(40),
  deliverable: { digest: "a".repeat(64), identity: "deliverable-tree/v1" },
  base: { ref: "origin/main", tipSha: "3".repeat(40), mergeBaseSha: "4".repeat(40) },
  workspaceId: "w-unit",
};

const PROVIDER = { id: "unit.provider", runId: "r-1", finalPassId: "pass-2" };

function approval(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    reviewerId: "solo",
    result: "approved",
    provider: PROVIDER,
    workspaceId: "w-unit",
    candidate: CANDIDATE,
    ...over,
  });
}

interface PayloadOverrides {
  readonly findings?: readonly Record<string, unknown>[];
  readonly telemetry?: Record<string, unknown>;
  readonly reviewers?: Record<string, unknown>;
}

function payload(over: PayloadOverrides = {}): Record<string, unknown> {
  const findings = over.findings ?? [];
  const counts: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    const severity = finding["severity"];
    if (typeof severity === "string" && severity in counts) counts[severity] = (counts[severity] ?? 0) + 1;
  }
  const deferred = findings.filter((finding) => finding["disposition"] === "deferred");
  return {
    verdict: "green",
    finalized: true,
    editedAfterFinalPass: false,
    reviewers: over.reviewers ?? { selected: ["solo"], completed: ["solo"], failed: [], timedOut: [] },
    findings,
    telemetry: {
      iterationCount: 2,
      findingCounts: counts,
      deferredExpansionCount: deferred.length,
      deferredIssueIds: deferred.map((finding) => finding["deferredIssueId"]).filter((id) => typeof id === "string").sort(),
      ...(over.telemetry ?? {}),
    },
  };
}

function codesFor(over: PayloadOverrides = {}, input: Partial<ReviewGreenClaimInput> = {}): readonly string[] {
  const collector = createCollector();
  validateReviewGreenClaim(
    {
      payload: payload(over),
      at: "/claims/0/payload",
      provider: PROVIDER,
      candidate: CANDIDATE,
      artifacts: [{ index: 0, path: "reviewers/solo.json", sha256: "b".repeat(64), role: "reviewer-approval" }],
      artifactContents: new Map([["reviewers/solo.json", approval()]]),
      runHistoryLength: 2,
      ...input,
    },
    collector,
  );
  return collector.list().map((rejection) => rejection.code);
}

const LEGAL_DEFERRAL = {
  id: "f-1",
  severity: "P2",
  scope: "expansion",
  actionable: true,
  blocking: false,
  disposition: "deferred",
  deferredIssueId: "EX-1300",
};

describe("a green payload", () => {
  it("passes with no findings", () => {
    expect(codesFor()).toEqual([]);
  });

  it("passes with a legal deferral", () => {
    expect(codesFor({ findings: [LEGAL_DEFERRAL] })).toEqual([]);
  });
});

// ── RG-7, clause by clause ─────────────────────────────────────────────────

describe("deferral", () => {
  const deviations: Readonly<Record<string, Record<string, unknown>>> = {
    "a P0": { severity: "P0" },
    "a P1": { severity: "P1" },
    "in-contract scope": { scope: "in_contract" },
    "adjacent scope": { scope: "adjacent" },
    "a blocking finding": { blocking: true },
    "a non-actionable finding": { actionable: false },
    "a placeholder tracker id": { deferredIssueId: "TODO" },
    "a lowercase tracker id": { deferredIssueId: "ex-1300" },
  };

  for (const [name, deviation] of Object.entries(deviations)) {
    it(`is illegal for ${name}`, () => {
      expect(codesFor({ findings: [{ ...LEGAL_DEFERRAL, ...deviation }] })).toContain("illegal_deferral");
    });
  }

  it("is illegal without a tracker id at all", () => {
    const finding: Record<string, unknown> = { ...LEGAL_DEFERRAL };
    delete finding["deferredIssueId"];
    expect(codesFor({ findings: [finding] })).toContain("illegal_deferral");
  });

  it("is illegal to carry a tracker id on a finding that was not deferred", () => {
    expect(codesFor({ findings: [{ ...LEGAL_DEFERRAL, disposition: "resolved" }] })).toContain("illegal_deferral");
  });
});

// ── RG-6 ───────────────────────────────────────────────────────────────────

describe("open work", () => {
  it("contradicts green when a finding blocks", () => {
    expect(codesFor({ findings: [{ id: "f", severity: "P2", scope: "in_contract", actionable: true, blocking: true, disposition: "resolved" }] })).toContain(
      "blocking_finding_present",
    );
  });

  it("contradicts green when actionable work is unresolved or ignored", () => {
    for (const disposition of ["unresolved", "ignored", "advisory"]) {
      expect(
        codesFor({ findings: [{ id: "f", severity: "P2", scope: "in_contract", actionable: true, blocking: false, disposition }] }),
        disposition,
      ).toContain("actionable_unresolved");
    }
  });

  it("permits a non-actionable advisory finding", () => {
    expect(codesFor({ findings: [{ id: "f", severity: "P3", scope: "adjacent", actionable: false, blocking: false, disposition: "advisory" }] })).toEqual([]);
  });
});

// ── RG-8, RG-9 ─────────────────────────────────────────────────────────────

describe("telemetry", () => {
  it("is re-derived rather than trusted", () => {
    expect(codesFor({ findings: [LEGAL_DEFERRAL], telemetry: { findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 } } })).toContain("telemetry_mismatch");
    expect(codesFor({ findings: [LEGAL_DEFERRAL], telemetry: { deferredExpansionCount: 0 } })).toContain("telemetry_mismatch");
    expect(codesFor({ findings: [LEGAL_DEFERRAL], telemetry: { deferredIssueIds: ["EX-9999"] } })).toContain("telemetry_mismatch");
  });

  it("requires deferred issue ids sorted and deduplicated", () => {
    const two = [
      { ...LEGAL_DEFERRAL, id: "f-1", deferredIssueId: "EX-2" },
      { ...LEGAL_DEFERRAL, id: "f-2", deferredIssueId: "EX-1" },
    ];
    expect(codesFor({ findings: two })).toEqual([]);
    expect(codesFor({ findings: two, telemetry: { deferredIssueIds: ["EX-2", "EX-1"] } })).toContain("telemetry_mismatch");
  });

  it("counts iterations against the run history, not against itself", () => {
    expect(codesFor({}, {})).toEqual([]);
    expect(codesFor({ telemetry: { iterationCount: 7 } })).toContain("iteration_count_mismatch");
    expect(codesFor({}, { runHistoryLength: 3 })).toContain("iteration_count_mismatch");
  });
});

// ── RG-10 ──────────────────────────────────────────────────────────────────

describe("self-reported cost", () => {
  const reviewers = { selected: ["solo", "second"], completed: ["second", "solo"], failed: [], timedOut: [] };
  const twoApprovals: Partial<ReviewGreenClaimInput> = {
    artifacts: [
      { index: 0, path: "reviewers/solo.json", sha256: "b".repeat(64), role: "reviewer-approval" },
      { index: 1, path: "reviewers/second.json", sha256: "c".repeat(64), role: "reviewer-approval" },
    ],
    artifactContents: new Map([
      ["reviewers/solo.json", approval()],
      ["reviewers/second.json", approval({ reviewerId: "second" })],
    ]),
  };

  it("is optional", () => {
    expect(codesFor()).toEqual([]);
  });

  it("accepts a breakdown that sums below the total", () => {
    expect(
      codesFor({ reviewers, telemetry: { cost: { unit: "tokens", total: 100, reportedBy: "unit", byReviewer: { solo: 60, second: 30 } } } }, twoApprovals),
    ).toEqual([]);
  });

  it("rejects a breakdown that sums above the total", () => {
    expect(
      codesFor({ reviewers, telemetry: { cost: { unit: "tokens", total: 100, reportedBy: "unit", byReviewer: { solo: 60, second: 50 } } } }, twoApprovals),
    ).toContain("invalid_cost");
  });

  it("rejects a breakdown naming a reviewer that was not selected", () => {
    expect(codesFor({ telemetry: { cost: { unit: "tokens", total: 100, reportedBy: "unit", byReviewer: { ghost: 1 } } } })).toContain("invalid_cost");
  });

  it("rejects an unattributed or unitless cost", () => {
    expect(codesFor({ telemetry: { cost: { unit: "tokens", total: 1, reportedBy: "" } } })).toContain("invalid_cost");
    expect(codesFor({ telemetry: { cost: { unit: "", total: 1, reportedBy: "unit" } } })).toContain("invalid_cost");
    expect(codesFor({ telemetry: { cost: { total: 1, reportedBy: "unit" } } })).toContain("invalid_cost");
  });

  it("rejects a total that is negative, null, or not a number", () => {
    for (const total of [-1, null, "free", Number.NaN]) {
      expect(codesFor({ telemetry: { cost: { unit: "tokens", total, reportedBy: "unit" } } }), String(total)).toContain("invalid_cost");
    }
  });
});

// ── RG-4 ───────────────────────────────────────────────────────────────────

describe("approval stamps", () => {
  it("must exist for every selected reviewer", () => {
    expect(
      codesFor(
        { reviewers: { selected: ["solo", "second"], completed: ["solo", "second"], failed: [], timedOut: [] } },
      ),
    ).toContain("approval_missing");
  });

  it("must not cover a reviewer twice", () => {
    expect(
      codesFor(
        {},
        {
          artifacts: [
            { index: 0, path: "reviewers/solo.json", sha256: "b".repeat(64), role: "reviewer-approval" },
            { index: 1, path: "reviewers/solo-again.json", sha256: "c".repeat(64), role: "reviewer-approval" },
          ],
          artifactContents: new Map([
            ["reviewers/solo.json", approval()],
            ["reviewers/solo-again.json", approval()],
          ]),
        },
      ),
    ).toContain("approval_mismatch");
  });

  it("must restate the provider triple, the workspace, and the whole candidate", () => {
    const deviations: readonly Record<string, unknown>[] = [
      { provider: { ...PROVIDER, runId: "r-other" } },
      { provider: { ...PROVIDER, finalPassId: "pass-1" } },
      { provider: { ...PROVIDER, id: "other.provider" } },
      { workspaceId: "w-other" },
      { candidate: { ...CANDIDATE, treeSha: "9".repeat(40) } },
      { result: "advisory" },
      { schemaVersion: 2 },
    ];
    for (const deviation of deviations) {
      expect(
        codesFor({}, { artifactContents: new Map([["reviewers/solo.json", approval(deviation)]]) }),
        JSON.stringify(deviation),
      ).toContain("approval_mismatch");
    }
  });

  it("must be closed against unknown members in the nested provider triple too", () => {
    // The stamp's own grammar is closed at the root and inside the candidate;
    // an open nested object would be the one place a member could ride along.
    expect(
      codesFor({}, { artifactContents: new Map([["reviewers/solo.json", approval({ provider: { ...PROVIDER, smuggled: "x" } })]]) }),
    ).toContain("approval_mismatch");
  });

  it("must be JSON, present, and closed against unknown members", () => {
    expect(codesFor({}, { artifactContents: new Map([["reviewers/solo.json", "not json"]]) })).toContain("approval_mismatch");
    expect(codesFor({}, { artifactContents: new Map() })).toContain("approval_mismatch");
    expect(
      codesFor({}, { artifactContents: new Map([["reviewers/solo.json", approval({ notes: "looks fine" })]]) }),
    ).toContain("approval_mismatch");
  });

  it("ignores artifacts in other roles", () => {
    expect(
      codesFor(
        {},
        {
          artifacts: [
            { index: 0, path: "reviewers/solo.json", sha256: "b".repeat(64), role: "reviewer-approval" },
            { index: 1, path: "logs/run.txt", sha256: "c".repeat(64), role: "run-log" },
          ],
        },
      ),
    ).toEqual([]);
  });
});

// ── RG-2, RG-3 ─────────────────────────────────────────────────────────────

describe("the reviewer set", () => {
  it("accepts completion in a different order", () => {
    expect(
      codesFor(
        { reviewers: { selected: ["solo", "second"], completed: ["second", "solo"], failed: [], timedOut: [] } },
        {
          artifacts: [
            { index: 0, path: "reviewers/solo.json", sha256: "b".repeat(64), role: "reviewer-approval" },
            { index: 1, path: "reviewers/second.json", sha256: "c".repeat(64), role: "reviewer-approval" },
          ],
          artifactContents: new Map([
            ["reviewers/solo.json", approval()],
            ["reviewers/second.json", approval({ reviewerId: "second" })],
          ]),
        },
      ),
    ).toEqual([]);
  });

  it("rejects an empty or duplicated selection", () => {
    expect(codesFor({ reviewers: { selected: [], completed: [], failed: [], timedOut: [] } })).toContain("reviewer_set_invalid");
    expect(codesFor({ reviewers: { selected: ["solo", "solo"], completed: ["solo"], failed: [], timedOut: [] } })).toContain("reviewer_set_invalid");
  });

  it("rejects a degraded set", () => {
    expect(codesFor({ reviewers: { selected: ["solo"], completed: ["solo"], failed: ["ghost"], timedOut: [] } })).toContain("reviewer_set_incomplete");
    expect(codesFor({ reviewers: { selected: ["solo"], completed: ["solo"], failed: [], timedOut: ["ghost"] } })).toContain("reviewer_set_incomplete");
  });
});
