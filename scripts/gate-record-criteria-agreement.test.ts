/**
 * THE GATE RECORD'S DECLARED CRITERIA AND THE SCORER'S APPLIED CRITERIA, PINNED
 * AGAINST EACH OTHER.
 *
 * The defect this closes is drift between two artifacts, not a wrong value in
 * one of them: the record declared an intervention criterion the scorer had
 * stopped applying, and nothing noticed until a delivery happened to read both.
 * So both sides are read live here — the record's declarations from its bytes,
 * the applied criteria from an actual scoring run — and compared.
 *
 * Reading one side and asserting something about it would pass for free: an
 * "every declared criterion is applied" check holds vacuously if the mechanism
 * producing the applied set is missing or returns nothing. The applied set is
 * therefore required to be non-empty and to come from a set the scorer actually
 * scored, before any comparison is made.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BASELINE_PATH,
  GATE_RECORD_PATH,
  INTERVENTION_REPORTING,
  VERDICT_PATH,
  repoRootFromHere,
  scoreShadowMilestone,
} from "./score-shadow-milestone.ts";

const repoRoot = repoRootFromHere();
const readJson = (relative: string): any => JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));

const baseline = readJson(BASELINE_PATH);
const record = readJson(GATE_RECORD_PATH);

const DIGEST = "b".repeat(64);

/**
 * A comparison set that satisfies the record's own mix and count, so the scorer
 * reaches the point where it applies criteria at all. The measurements are
 * deliberately neutral: what is under test is WHICH criteria are applied, not
 * how any of them falls.
 */
function scorableSet() {
  const mix: Record<string, number> = record.comparisonSetRequirement.mix;
  const deliveries = Object.entries(mix).flatMap(([category, count]) =>
    Array.from({ length: Number(count) }, (_unused, index) => {
      const id = `shadow-${category}-${index}`;
      return {
        id,
        category,
        countedInComparisonSet: true,
        projectionConsumption: {
          source: "binding",
          affirmative: true,
          projectionDigest: DIGEST,
          marker: { deliveryId: id, fence: 1, consumed: "generation-archive" },
        },
        window: {
          acceptedAt: "2026-08-30T11:00:00Z",
          finalCandidateSha: "c".repeat(40),
          externalVerification: {
            outcome: "passed",
            candidateSha: "c".repeat(40),
            completedAt: "2026-08-30T11:16:20Z",
            receipt: {
              source: "delivery-journal/finish.line.recorded",
              reference: "finish-line-result:" + "d".repeat(64),
              digest: "e".repeat(64),
            },
          },
          firstMergeReadyReportAfterExternalVerificationAt: "2026-08-30T11:16:40Z",
          windowSeconds: 1000,
          endpointEvidence: {
            candidateSha: "c".repeat(40),
            source: "managed-delivery-session-jsonl",
            transcriptEventTimestamp: "2026-08-30T11:16:40.500Z",
            jsonlRecordSha256: "f".repeat(64),
          },
        },
        score: {
          interventionCount: 0,
          policyRequiredInterruptionCount: 0,
          blockedSeconds: 0,
          progressingSeconds: 1000,
        },
      };
    }),
  );
  return { ...record, deliveries };
}

/** The criteria the shipped scorer applies, taken from a set it actually scored. */
function appliedCriterionIds(): string[] {
  const verdict = scoreShadowMilestone(baseline, scorableSet());
  // Without these two, an applied set that came back empty because the scoring
  // never happened would satisfy every comparison below.
  expect(verdict.incomplete).toEqual([]);
  expect(verdict.shadow).not.toBeNull();
  const ids = verdict.criteria.map((criterion) => criterion.id);
  expect(ids.length).toBeGreaterThan(0);
  return ids;
}

/**
 * The two fields of `gateMetrics` that name the gating criterion and where the
 * applied behaviour is recorded, rather than declaring a metric. They are
 * excluded from the requirement scan below: they carry ordinary prose, and an
 * ordinary sentence using the word "must" would otherwise be read as a fourth
 * metric declaring itself gating.
 */
const STRUCTURAL_FIELDS = new Set(["gatingCriterion", "appliedCriteriaRecordedIn"]);

/**
 * The record's metric declarations that state a requirement. A gate metric is
 * declared as gating by saying what the figure MUST do; the metrics reported
 * without gating say what is reported instead.
 *
 * This catches a metric that declares itself gating in those terms. It cannot
 * catch every possible phrasing — a requirement written without the word
 * carries no marker to scan for — so the metric this delivery corrected is not
 * left to it: that declaration is pinned whole below, the way
 * `policyRequiredInterruptions` is.
 */
function declaredGatingCriteria(): string[] {
  const metrics: Record<string, unknown> = record.gateMetrics;
  expect(Object.keys(metrics).length).toBeGreaterThan(0);
  return Object.entries(metrics)
    .filter(([name]) => !STRUCTURAL_FIELDS.has(name))
    .filter(([, declaration]) => typeof declaration === "string" && /\bmust\b/i.test(declaration))
    .map(([name]) => name);
}

const sorted = (values: readonly string[]) => [...values].sort();

describe("the gate record declares exactly the criteria the scorer applies", () => {
  it("names no gating criterion the scorer does not apply, and omits none it does", () => {
    expect(sorted(declaredGatingCriteria())).toEqual(sorted([...new Set(appliedCriterionIds())]));
  });

  it("names its sole gating criterion as the one the scorer applies", () => {
    const applied = [...new Set(appliedCriterionIds())];
    expect(applied).toHaveLength(1);
    expect(record.gateMetrics.gatingCriterion).toBe(applied[0]);
  });

  it("declares the superseded metric in exactly these words, so no rewording re-declares it as gating", () => {
    // Pinned whole rather than by a marker phrase. A scan for how a criterion
    // is worded can always be worded around — which is this metric's entire
    // history — and a declaration whose exactness is the product is one a
    // rewording should have to come here and restate.
    expect(record.gateMetrics.medianOperatorInterventionsAfterAcceptance).toBe(
      "reported in full and gates nothing. The baseline's own intervention counts are [2, 0, 0] — a median of 0, " +
        "which is the floor of the metric. No non-negative count can be strictly lower, so a baseline sitting at " +
        "the floor cannot demonstrate improvement in either direction. The baseline's limitations block concedes " +
        "the counts are lower bounds: transcripts do not record silently granted host permission prompts, so the " +
        "figure it reports is admittedly incomplete. Ceasing to gate on the figure is not licence to stop " +
        "measuring it; it becomes gating again only once the baseline is re-recorded under a rubric wide enough " +
        "to have headroom.",
    );
  });
});

describe("the record and the verdict state one position, not two versions of it", () => {
  it("agrees with the scorer's reported-not-gated block on which criterion gates", () => {
    expect(INTERVENTION_REPORTING.status).toBe("reported-not-gated");
    expect(record.gateMetrics.gatingCriterion).toBe(INTERVENTION_REPORTING.gatingCriterion);
    expect(readJson(VERDICT_PATH).interventionReporting.gatingCriterion).toBe(record.gateMetrics.gatingCriterion);
  });

  it("carries the headroom reasoning in the record's own words, matching the verdict's", () => {
    // Why the criterion was superseded has to be legible from the record alone,
    // or a later reader sees a gate dropped for convenience. The phrases are the
    // verdict's, so the two artifacts say the same thing rather than two things.
    const declaration: string = record.gateMetrics.medianOperatorInterventionsAfterAcceptance;
    const verdictReason = INTERVENTION_REPORTING.reason.join(" ");
    for (const phrase of ["floor of the metric", "lower bounds"]) {
      expect(declaration).toContain(phrase);
      expect(verdictReason).toContain(phrase);
    }
  });

  it("points a reader of the declarations at the artifact carrying the applied behaviour", () => {
    expect(record.gateMetrics.appliedCriteriaRecordedIn).toContain(VERDICT_PATH);
  });

  it("keeps the policy-required interruptions out of both figures and out of the gate", () => {
    expect(record.gateMetrics.policyRequiredInterruptions).toBe(
      "recorded and reported alongside interventions, never counted as interventions",
    );
  });
});
