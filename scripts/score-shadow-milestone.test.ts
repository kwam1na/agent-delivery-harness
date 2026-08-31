/**
 * THE M1 SHADOW GATE SCORER, EXERCISED IN BOTH DIRECTIONS.
 *
 * Every rule here is pinned by a pair: a case that is admitted or passes AND a
 * case that is rejected or fails. A one-sided assertion cannot tell a rule
 * apart from a mechanism that answers the same way to everything — an
 * exclusion suite that only ever shows exclusions is satisfied by a scorer
 * that excludes every delivery.
 *
 * The set-level rules are exercised over the record's own `deliveries` list.
 * The trap being avoided is the free pass: "every counted delivery carries a
 * binding-sourced record" holds vacuously over an empty set, so each such rule
 * is paired with a case where the set is populated and the rule bites.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BASELINE_PATH,
  GATE_RECORD_PATH,
  MANUAL_CHOREOGRAPHY_BASELINE_SPEC,
  SHADOW_MILESTONE_VERDICT_SPEC,
  VERDICT_PATH,
  aggregateBlockedShare,
  median,
  readVerdictInputs,
  renderVerdict,
  repoRootFromHere,
  scoreShadowMilestone,
} from "./score-shadow-milestone.ts";

const repoRoot = repoRootFromHere();
const readJson = (relative: string): any => JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));

const DIGEST = "a".repeat(64);

type ScoreOverrides = Partial<{
  interventionCount: number;
  policyRequiredInterruptionCount: number;
  blockedSeconds: number;
  progressingSeconds: number;
}>;

const score = (overrides: ScoreOverrides = {}): Record<string, unknown> => ({
  interventionCount: 0,
  policyRequiredInterruptionCount: 0,
  blockedSeconds: 0,
  progressingSeconds: 1000,
  ...overrides,
});

const entry = (id: string, category: string, overrides: ScoreOverrides = {}): Record<string, unknown> => ({
  id,
  category,
  countedInComparisonSet: true,
  projectionConsumption: {
    source: "binding",
    affirmative: true,
    projectionDigest: DIGEST,
    marker: { deliveryId: id, fence: 1, consumed: "generation-archive" },
  },
  score: score(overrides),
});

/** A synthetic baseline with a non-zero median, so the strict-lower criterion is reachable. */
const syntheticBaseline = (deliveries: readonly ScoreOverrides[]): Record<string, unknown> => ({
  schemaVersion: MANUAL_CHOREOGRAPHY_BASELINE_SPEC,
  capturedAt: "2026-08-30T11:05:00Z",
  provingHost: "claude-code",
  operatorInterventionRubric: { sha256: "b".repeat(64) },
  mix: { code: 1, docs: 1, operations: 1, total: 3 },
  deliveries: deliveries.map((overrides, index) => ({ id: `baseline-${index}`, score: score(overrides) })),
});

const gateRecord = (deliveries: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  spec: "delivery-harness-shadow-milestone-gate-record/1",
  baseline: { provingHost: "claude-code" },
  comparisonSetRequirement: { mix: { code: 1, docs: 1, operations: 1 }, total: 3 },
  deliveries: [...deliveries],
});

/** The full three-slot set the baseline mix requires. */
const fullSet = (overrides: readonly [ScoreOverrides, ScoreOverrides, ScoreOverrides]) =>
  gateRecord([
    entry("shadow-code", "code", overrides[0]),
    entry("shadow-docs", "docs", overrides[1]),
    entry("shadow-operations", "operations", overrides[2]),
  ]);

/** A baseline whose median intervention count is 2 and whose blocked share is 50%. */
const reachableBaseline = syntheticBaseline([
  { interventionCount: 2, blockedSeconds: 500, progressingSeconds: 500 },
  { interventionCount: 2, blockedSeconds: 500, progressingSeconds: 500 },
  { interventionCount: 4, blockedSeconds: 500, progressingSeconds: 500 },
]);

describe("reduction arithmetic", () => {
  it("takes the middle value of an odd list and the mean of the two middle values of an even one", () => {
    // Three DISTINCT values, so an off-by-one on the middle index is visible:
    // [2, 0, 0] would pin nothing, because its lower-middle and middle are
    // both 0 and either index answers correctly.
    expect(median([5, 1, 3])).toBe(3);
    expect(median([2, 0, 0])).toBe(0);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("aggregates blocked share over the whole window rather than averaging per-delivery shares", () => {
    // Per-delivery shares would average to 0.25; the aggregate weights the
    // long delivery, which is the figure the gate is about.
    expect(aggregateBlockedShare(500, 500)).toBe(0.5);
    expect(aggregateBlockedShare(500, 3500)).toBe(0.125);
  });
});

describe("the frozen baseline is characterized before anything is scored against it", () => {
  const baseline = readJson(BASELINE_PATH);

  it("pins the baseline's own reduced figures", () => {
    const verdict = scoreShadowMilestone(baseline, gateRecord([]));
    expect(verdict.baseline.deliveryCount).toBe(3);
    expect([...verdict.baseline.interventionCounts].sort()).toEqual([0, 0, 2]);
    expect(verdict.baseline.medianOperatorInterventions).toBe(0);
    expect(verdict.baseline.totalOperatorInterventions).toBe(2);
    expect(verdict.baseline.policyRequiredInterruptionCount).toBe(0);
    expect(verdict.baseline.blockedSeconds).toBe(8933);
    expect(verdict.baseline.progressingSeconds).toBe(27081);
    expect(verdict.baseline.blockedShare).toBeCloseTo(0.24804, 5);
  });

  it("carries the rubric digest the operator scored against into the verdict", () => {
    const verdict = scoreShadowMilestone(baseline, gateRecord([]));
    expect(verdict.inputs.baseline.operatorInterventionRubricSha256).toBe(baseline.operatorInterventionRubric.sha256);
    expect(verdict.inputs.baseline.capturedAt).toBe(baseline.capturedAt);
  });

  it("reports that the frozen baseline's median sits at the floor, so strictly-lower is unsatisfiable", () => {
    const verdict = scoreShadowMilestone(baseline, gateRecord([]));
    expect(verdict.observations.map((note) => note.code)).toContain("intervention_criterion_unreachable");
  });

  it("does not report the criterion unreachable when the baseline median is above the floor", () => {
    const verdict = scoreShadowMilestone(reachableBaseline, gateRecord([]));
    expect(verdict.observations.map((note) => note.code)).not.toContain("intervention_criterion_unreachable");
  });

  it("refuses a baseline that is not the frozen manual-choreography artifact", () => {
    const verdict = scoreShadowMilestone({ ...reachableBaseline, schemaVersion: "something-else/1" }, gateRecord([]));
    expect(verdict.incomplete.map((note) => note.code)).toContain("baseline_unrecognized");
  });

  it("refuses to compare a set measured on a different proving host", () => {
    const record = fullSet([{}, {}, {}]);
    record["baseline"] = { provingHost: "codex" };
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.incomplete.map((note) => note.code)).toContain("baseline_host_mismatch");
    expect(verdict.status).toBe("incomplete");
  });

  it("compares like-for-like when the hosts agree", () => {
    const verdict = scoreShadowMilestone(reachableBaseline, fullSet([{}, {}, {}]));
    expect(verdict.incomplete.map((note) => note.code)).not.toContain("baseline_host_mismatch");
    expect(verdict.status).toBe("pass");
  });
});

describe("the comparison set is enumerated off the record's own deliveries list", () => {
  it("scores a verdict from three counted deliveries", () => {
    const verdict = scoreShadowMilestone(reachableBaseline, fullSet([{}, {}, {}]));
    expect(verdict.status).toBe("pass");
    expect(verdict.inputs.gateRecord.countedDeliveryIds).toEqual(["shadow-code", "shadow-docs", "shadow-operations"]);
    expect(verdict.shadow?.deliveryCount).toBe(3);
  });

  it("yields an incomplete result — never a provisional verdict — from two", () => {
    const record = gateRecord([entry("shadow-code", "code"), entry("shadow-docs", "docs")]);
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.status).toBe("incomplete");
    expect(verdict.incomplete.map((note) => note.code)).toContain("comparison_set_incomplete");
    expect(verdict.shadow).toBeNull();
    expect(verdict.criteria).toEqual([]);
  });

  it("says no delivery has been observed consuming a projection when the set is empty, and does not call that a failure", () => {
    const verdict = scoreShadowMilestone(reachableBaseline, gateRecord([]));
    expect(verdict.status).toBe("incomplete");
    expect(verdict.status).not.toBe("fail");
    const codes = verdict.incomplete.map((note) => note.code);
    expect(codes).toContain("no_observed_consumption");
    expect(codes).not.toContain("comparison_set_incomplete");
    const message = verdict.incomplete.find((note) => note.code === "no_observed_consumption")!.message;
    expect(message).toContain("no delivery has been observed consuming a projection");
    expect(message).not.toContain("nothing consumed");
    expect(verdict.failures).toEqual([]);
  });

  it("treats a missing deliveries list as unreadable rather than as an empty set that passes for free", () => {
    const record = gateRecord([]);
    delete record["deliveries"];
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.incomplete.map((note) => note.code)).toContain("gate_record_unrecognized");
    expect(verdict.status).toBe("incomplete");
  });

  it("treats an undeclared required total as incomplete, not as a size every set clears", () => {
    // The size check is written as a negated `>=` so an unparseable total
    // falls to the incomplete side. Written the natural way round, a record
    // that declares no required size at all would score a full verdict.
    const record = fullSet([{}, {}, {}]);
    delete (record["comparisonSetRequirement"] as Record<string, unknown>)["total"];
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.incomplete.map((note) => note.code)).toContain("comparison_set_incomplete");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.shadow).toBeNull();
  });

  it("requires the baseline's mix, not merely its total", () => {
    const record = gateRecord([
      entry("shadow-code", "code"),
      entry("shadow-code-2", "code"),
      entry("shadow-docs", "docs"),
    ]);
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.incomplete.map((note) => note.code)).toContain("comparison_set_mix_mismatch");
    expect(verdict.status).toBe("incomplete");
  });
});

describe("admission: only an affirmative binding-sourced record counts", () => {
  const withThirdEntry = (third: Record<string, unknown>) =>
    gateRecord([entry("shadow-code", "code"), entry("shadow-docs", "docs"), third]);

  it("counts a delivery whose record is binding-sourced and affirmative", () => {
    const verdict = scoreShadowMilestone(reachableBaseline, withThirdEntry(entry("shadow-operations", "operations")));
    expect(verdict.inputs.gateRecord.countedDeliveryIds).toContain("shadow-operations");
    expect(verdict.status).toBe("pass");
  });

  it("excludes an agent-supplied claim from both figures, and the set is then incomplete", () => {
    const agentSupplied = entry("shadow-operations", "operations", { interventionCount: 0 });
    (agentSupplied["projectionConsumption"] as Record<string, unknown>)["source"] = "session";
    const verdict = scoreShadowMilestone(reachableBaseline, withThirdEntry(agentSupplied));
    expect(verdict.inputs.gateRecord.countedDeliveryIds).not.toContain("shadow-operations");
    expect(verdict.inputs.gateRecord.excludedDeliveries.map((row) => row.id)).toContain("shadow-operations");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.shadow).toBeNull();
  });

  it("excludes a delivery carrying no consumption record at all", () => {
    const bare = entry("shadow-operations", "operations");
    delete bare["projectionConsumption"];
    const verdict = scoreShadowMilestone(reachableBaseline, withThirdEntry(bare));
    expect(verdict.inputs.gateRecord.countedDeliveryIds).not.toContain("shadow-operations");
  });

  it("excludes a delivery whose measurements would otherwise have moved the figures", () => {
    // The excluded entry carries an intervention count that would have raised
    // the median had it counted. Its exclusion must be visible in the figures,
    // not merely in the id list.
    const loud = entry("shadow-operations", "operations", { interventionCount: 99 });
    (loud["projectionConsumption"] as Record<string, unknown>)["affirmative"] = false;
    const record = gateRecord([
      entry("shadow-code", "code", { interventionCount: 1 }),
      entry("shadow-docs", "docs", { interventionCount: 1 }),
      loud,
      entry("shadow-ops-real", "operations", { interventionCount: 1 }),
    ]);
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.status).toBe("pass");
    expect(verdict.shadow?.interventionCounts).toEqual([1, 1, 1]);
    expect(verdict.shadow?.totalOperatorInterventions).toBe(3);
  });

  it("honours an explicit gate exclusion even on an affirmative record", () => {
    const excluded = entry("shadow-operations", "operations");
    excluded["countedInComparisonSet"] = false;
    const verdict = scoreShadowMilestone(reachableBaseline, withThirdEntry(excluded));
    expect(verdict.inputs.gateRecord.countedDeliveryIds).not.toContain("shadow-operations");
    expect(verdict.status).toBe("incomplete");
  });

  it("counts one run once however many times it appears", () => {
    const record = gateRecord([
      entry("shadow-code", "code"),
      entry("shadow-docs", "docs"),
      entry("shadow-docs", "docs"),
      entry("shadow-operations", "operations"),
    ]);
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.inputs.gateRecord.countedDeliveryIds).toEqual([
      "shadow-code",
      "shadow-docs",
      "shadow-operations",
    ]);
    expect(verdict.status).toBe("pass");
  });
});

describe("policy-required interruptions are reported, never counted as interventions", () => {
  it("does not move the intervention figures or the verdict", () => {
    const without = scoreShadowMilestone(reachableBaseline, fullSet([{}, {}, {}]));
    const withInterruptions = scoreShadowMilestone(
      reachableBaseline,
      fullSet([
        { policyRequiredInterruptionCount: 5 },
        { policyRequiredInterruptionCount: 7 },
        { policyRequiredInterruptionCount: 9 },
      ]),
    );
    expect(withInterruptions.shadow?.medianOperatorInterventions).toBe(without.shadow?.medianOperatorInterventions);
    expect(withInterruptions.shadow?.totalOperatorInterventions).toBe(without.shadow?.totalOperatorInterventions);
    expect(withInterruptions.status).toBe(without.status);
  });

  it("makes the split visible in the artifact rather than folding it away", () => {
    const verdict = scoreShadowMilestone(
      reachableBaseline,
      fullSet([{ policyRequiredInterruptionCount: 5 }, { policyRequiredInterruptionCount: 7 }, {}]),
    );
    expect(verdict.shadow?.policyRequiredInterruptionCount).toBe(12);
    expect(verdict.shadow?.totalOperatorInterventions).toBe(0);
  });

  it("requires the split to be stated rather than inferred from its absence", () => {
    const unsplit = entry("shadow-operations", "operations");
    delete (unsplit["score"] as Record<string, unknown>)["policyRequiredInterruptionCount"];
    const record = gateRecord([entry("shadow-code", "code"), entry("shadow-docs", "docs"), unsplit]);
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.incomplete.map((note) => note.code)).toContain("measurement_missing");
    expect(verdict.status).toBe("incomplete");
  });
});

describe("a malformed measurement makes the set incomplete, never a scored zero", () => {
  it("rejects a count that is not a non-negative integer rather than coercing it", () => {
    // `reduceScores` coerces with bare `Number(...)`, so this check is what
    // keeps a string or a negative out of the figures. Unpinned, a delivery
    // measured as "0" or -5 would score a clean pass.
    for (const field of ["interventionCount", "policyRequiredInterruptionCount"])
      for (const bogus of ["0", -5, 1.5, null]) {
        const malformed = entry("shadow-operations", "operations");
        (malformed["score"] as Record<string, unknown>)[field] = bogus;
        const record = gateRecord([entry("shadow-code", "code"), entry("shadow-docs", "docs"), malformed]);
        const verdict = scoreShadowMilestone(reachableBaseline, record);
        expect(verdict.incomplete.map((note) => note.code)).toContain("measurement_missing");
        expect(verdict.status).toBe("incomplete");
      }
  });

  it("rejects a non-finite or negative wall-clock split on either half", () => {
    // Both halves, because a NaN on the unpinned one survives the shape check
    // and the zero-window check, reduces to a NaN blocked share, and loses the
    // no-regression comparison — turning an unmeasured delivery into a scored
    // loss, which is the one thing this scorer must never do.
    for (const field of ["blockedSeconds", "progressingSeconds"])
      for (const bogus of ["500", -1, Number.NaN]) {
        const malformed = entry("shadow-operations", "operations");
        (malformed["score"] as Record<string, unknown>)[field] = bogus;
        const record = gateRecord([entry("shadow-code", "code"), entry("shadow-docs", "docs"), malformed]);
        const verdict = scoreShadowMilestone(reachableBaseline, record);
        expect(verdict.incomplete.map((note) => note.code)).toContain("measurement_missing");
        expect(verdict.status).toBe("incomplete");
      }
  });

  it("rejects a zero-length window instead of reading it as a perfect blocked share", () => {
    const verdict = scoreShadowMilestone(
      reachableBaseline,
      fullSet([
        { blockedSeconds: 0, progressingSeconds: 0 },
        { blockedSeconds: 0, progressingSeconds: 0 },
        { blockedSeconds: 0, progressingSeconds: 0 },
      ]),
    );
    expect(verdict.status).toBe("incomplete");
    expect(verdict.incomplete.map((note) => note.code)).toContain("measurement_missing");
    expect(verdict.shadow).toBeNull();
  });
});

describe("the gate can be lost", () => {
  it("fails when the median intervention count is not strictly lower", () => {
    const verdict = scoreShadowMilestone(
      reachableBaseline,
      fullSet([{ interventionCount: 2 }, { interventionCount: 2 }, { interventionCount: 2 }]),
    );
    expect(verdict.status).toBe("fail");
    expect(verdict.failures.map((note) => note.code)).toEqual(["intervention_median_not_lower"]);
    expect(verdict.criteria.find((row) => row.id === "medianOperatorInterventionsAfterAcceptance")?.met).toBe(false);
  });

  it("passes when the median intervention count is strictly lower", () => {
    const verdict = scoreShadowMilestone(
      reachableBaseline,
      fullSet([{ interventionCount: 1 }, { interventionCount: 1 }, { interventionCount: 1 }]),
    );
    expect(verdict.status).toBe("pass");
    expect(verdict.criteria.find((row) => row.id === "medianOperatorInterventionsAfterAcceptance")?.met).toBe(true);
  });

  it("fails on a regressed blocked share even when interventions improved", () => {
    const verdict = scoreShadowMilestone(
      reachableBaseline,
      fullSet([
        { interventionCount: 0, blockedSeconds: 900, progressingSeconds: 100 },
        { interventionCount: 0, blockedSeconds: 900, progressingSeconds: 100 },
        { interventionCount: 0, blockedSeconds: 900, progressingSeconds: 100 },
      ]),
    );
    expect(verdict.status).toBe("fail");
    expect(verdict.failures.map((note) => note.code)).toEqual(["blocked_share_regressed"]);
    expect(verdict.criteria.find((row) => row.id === "medianOperatorInterventionsAfterAcceptance")?.met).toBe(true);
  });

  it("clears the share criterion on an exactly equal share, which is a no-regression bar", () => {
    const verdict = scoreShadowMilestone(
      reachableBaseline,
      fullSet([
        { interventionCount: 0, blockedSeconds: 500, progressingSeconds: 500 },
        { interventionCount: 0, blockedSeconds: 500, progressingSeconds: 500 },
        { interventionCount: 0, blockedSeconds: 500, progressingSeconds: 500 },
      ]),
    );
    expect(verdict.status).toBe("pass");
    expect(verdict.criteria.find((row) => row.id === "blockedVersusProgressingShare")?.met).toBe(true);
  });
});

describe("the verdict records its inputs so it can be re-derived", () => {
  it("carries the per-delivery blocks the figures were reduced from", () => {
    const verdict = scoreShadowMilestone(
      reachableBaseline,
      fullSet([{ interventionCount: 1 }, { interventionCount: 0 }, { interventionCount: 1 }]),
    );
    const blocks = verdict.inputs.gateRecord.perDeliveryScores;
    expect(blocks).toHaveLength(3);
    const recomputed = median(blocks.map((block) => Number((block as Record<string, unknown>)["interventionCount"])));
    expect(recomputed).toBe(verdict.shadow?.medianOperatorInterventions);
    const blocked = blocks.reduce((sum, block) => sum + Number((block as Record<string, unknown>)["blockedSeconds"]), 0);
    const progressing = blocks.reduce(
      (sum, block) => sum + Number((block as Record<string, unknown>)["progressingSeconds"]),
      0,
    );
    expect(aggregateBlockedShare(blocked, progressing)).toBe(verdict.shadow?.blockedShare);
  });

  it("names why each uncounted delivery was left out", () => {
    const agentSupplied = entry("shadow-operations", "operations");
    (agentSupplied["projectionConsumption"] as Record<string, unknown>)["source"] = "session";
    const verdict = scoreShadowMilestone(reachableBaseline, gateRecord([agentSupplied]));
    expect(verdict.inputs.gateRecord.excludedDeliveries).toHaveLength(1);
    expect(verdict.inputs.gateRecord.excludedDeliveries[0]!.reason).toContain("only the binding's own per-run marker");
  });
});

describe("the committed verdict artifact matches the tree it was computed from", () => {
  it("is byte-identical to a fresh scoring of the current baseline and gate record", () => {
    const { baseline, gateRecord: record } = readVerdictInputs(repoRoot);
    const fresh = renderVerdict(scoreShadowMilestone(baseline, record));
    expect(readFileSync(path.join(repoRoot, VERDICT_PATH), "utf8")).toBe(fresh);
  });

  it("declares the verdict spec and reads the two artifacts it claims to read", () => {
    const committed = readJson(VERDICT_PATH);
    expect(committed.spec).toBe(SHADOW_MILESTONE_VERDICT_SPEC);
    expect(committed.inputs.baseline.path).toBe(BASELINE_PATH);
    expect(committed.inputs.gateRecord.path).toBe(GATE_RECORD_PATH);
  });

  it("states the measurement contract, including that the transcript must survive the session", () => {
    const committed = readJson(VERDICT_PATH);
    const names = committed.measurementContract.members.map((member: any) => member.name);
    expect(names).toEqual([
      "interventionCount",
      "policyRequiredInterruptionCount",
      "blockedSeconds / progressingSeconds",
    ]);
    expect(committed.measurementContract.preconditions.join(" ")).toContain("must survive the session");
  });

  it("records today's honest state: no delivery observed, so no verdict", () => {
    const committed = readJson(VERDICT_PATH);
    expect(committed.status).toBe("incomplete");
    expect(committed.incomplete.map((note: any) => note.code)).toContain("no_observed_consumption");
    expect(committed.shadow).toBeNull();
  });
});
