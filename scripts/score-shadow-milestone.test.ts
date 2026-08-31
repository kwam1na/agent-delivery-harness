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
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
const scorerPath = path.join(repoRoot, "scripts/score-shadow-milestone.ts");

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

const athenaGateRecord = (deliveries: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  ...gateRecord(deliveries),
  spec: "athena-shadow-milestone-gate-record/1",
  repositoryId: "athena",
});

const runScorer = (args: readonly string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", scorerPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });

describe("reduction arithmetic", () => {
  it("takes the middle value of an odd list and the mean of the two middle values of an even one", () => {
    // Three DISTINCT values, so an off-by-one on the middle index is visible:
    // [2, 0, 0] would pin nothing, because its lower-middle and middle are
    // both 0 and either index answers correctly.
    expect(median([5, 1, 3])).toBe(3);
    expect(median([2, 0, 0])).toBe(0);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    // Two-digit values, so a default lexicographic sort is visible: it would
    // order [2, 10, 3] as [10, 2, 3] and answer 2. Counts of ten and up are
    // ordinary under a rubric whose own limitations call them lower bounds.
    expect(median([10, 2, 3])).toBe(3);
    expect(median([1, 2, 10, 3])).toBe(2.5);
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

  it("records in the artifact itself why the intervention figures are reported and not gated", () => {
    // The rationale has to survive without this test file and without the pull
    // request that changed it. A reader must be able to see that the metric had
    // no headroom, rather than infer a criterion dropped for convenience.
    const verdict = scoreShadowMilestone(baseline, gateRecord([]));
    expect(verdict.interventionReporting.status).toBe("reported-not-gated");
    expect(verdict.interventionReporting.gatingCriterion).toBe("blockedVersusProgressingShare");
    const reason = verdict.interventionReporting.reason.join(" ");
    expect(reason).toContain("floor of the metric");
    expect(reason).toContain("lower bounds");
    expect(verdict.interventionReporting.stillCounted).toContain("still counted");
    expect(verdict.interventionReporting.howItBecomesGatingAgain).toContain("Re-record the baseline");
  });

  it("names the declaration it superseded and the record's corrected position", () => {
    // The record once declared the intervention criterion as gating. The
    // verdict names that superseded line and states the position the record
    // now carries, rather than leaving a reader to find two artifacts that
    // disagree and no statement of which one is in force.
    const verdict = scoreShadowMilestone(baseline, gateRecord([]));
    expect(verdict.interventionReporting.supersedes).toContain("medianOperatorInterventionsAfterAcceptance");
    expect(verdict.interventionReporting.supersedes).toContain("sole gating criterion");
    expect(verdict.interventionReporting.supersedes).toContain("applied by nothing");
  });

  it("pins the baseline figure the decision rests on: a median already at the floor", () => {
    const verdict = scoreShadowMilestone(baseline, gateRecord([]));
    expect(verdict.baseline.medianOperatorInterventions).toBe(0);
  });

  it("refuses to score against a baseline delivery whose own measurement is malformed", () => {
    // The baseline is half of the comparison, and the same rule governs it: a
    // verdict computed over the two baseline deliveries that happened to be
    // well-formed is a verdict against a baseline nobody froze.
    const malformed = syntheticBaseline([{}, {}, {}]);
    delete ((malformed["deliveries"] as any[])[2].score as Record<string, unknown>)["blockedSeconds"];
    const verdict = scoreShadowMilestone(malformed, fullSet([{}, {}, {}]));
    expect(verdict.incomplete.map((note) => note.code)).toContain("measurement_shape");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.shadow).toBeNull();
  });

  it("treats a baseline whose deliveries member is not a list as incomplete rather than crashing", () => {
    // The baseline-side twin of the gate-record case: deleting the key leaves
    // a correct and a lax implementation answering identically, so only a
    // present non-array separates them.
    const malformed = { ...reachableBaseline, deliveries: { "baseline-0": { score: {} } } };
    const verdict = scoreShadowMilestone(malformed, fullSet([{}, {}, {}]));
    expect(verdict.incomplete.map((note) => note.code)).toContain("baseline_unrecognized");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.shadow).toBeNull();
  });

  it("treats a baseline recording no delivery as incomplete, never as a gate the shadow set lost", () => {
    // Without this, the baseline's figures reduce to NaN, every `<=` against
    // them is false, and an absent baseline emits `blocked_share_regressed` —
    // an unmeasured comparison spelled exactly like a lost one.
    const verdict = scoreShadowMilestone({ ...reachableBaseline, deliveries: [] }, fullSet([{}, {}, {}]));
    expect(verdict.incomplete.map((note) => note.code)).toContain("baseline_unrecognized");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.failures).toEqual([]);
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

  it("refuses to call a comparison like-for-like when either side names no host", () => {
    // Silence about the host is not agreement about it. Tolerating an absent
    // field let a record that simply omitted it pass as like-for-like against
    // a baseline captured somewhere else.
    // Each silent side is checked by its own MESSAGE, not merely by the code:
    // a rule that required only one of the two would fall through to the
    // cross-host branch and emit the same code for the wrong reason. And the
    // both-silent case is the one no fall-through can catch — `undefined !==
    // undefined` is false, so a tolerant rule scores it as agreement.
    const recordSilent = fullSet([{}, {}, {}]);
    delete (recordSilent["baseline"] as Record<string, unknown>)["provingHost"];
    const baselineSilent = { ...reachableBaseline };
    delete (baselineSilent as Record<string, unknown>)["provingHost"];

    // The strongest form of record silence is no baseline block at all — a
    // record predating the field entirely, not one that merely dropped it.
    const recordBlockless = fullSet([{}, {}, {}]);
    delete recordBlockless["baseline"];

    const cases: [string, any, any][] = [
      ["the record is silent", reachableBaseline, recordSilent],
      ["the record carries no baseline block", reachableBaseline, recordBlockless],
      ["the baseline is silent", baselineSilent, fullSet([{}, {}, {}])],
      ["both are silent", baselineSilent, recordSilent],
    ];
    for (const [, side, record] of cases) {
      const verdict = scoreShadowMilestone(side, record);
      const note = verdict.incomplete.find((row) => row.code === "baseline_host_mismatch");
      expect(note).toBeDefined();
      expect(note!.message).toContain("both must say which host their deliveries ran on");
      expect(verdict.status).toBe("incomplete");
      expect(verdict.failures).toEqual([]);
      expect(verdict.shadow).toBeNull();
    }
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

  it("treats a deliveries member that is present but not a list the same way", () => {
    // Deleting the key leaves both a correct and a `?? []` implementation
    // answering the same way. A present non-array separates them: the lax one
    // tries to iterate an object and the scorer crashes instead of reporting.
    const record = gateRecord([]);
    record["deliveries"] = { "shadow-code": entry("shadow-code", "code") };
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.incomplete.map((note) => note.code)).toContain("gate_record_unrecognized");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.shadow).toBeNull();
  });

  it("treats a record declaring no comparison-set requirement as incomplete rather than crashing", () => {
    // Neither the requirement block nor its mix may be assumed present: a
    // record without them must still yield an honest incomplete result.
    const record = fullSet([{}, {}, {}]);
    delete record["comparisonSetRequirement"];
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.incomplete.map((note) => note.code)).toContain("comparison_set_incomplete");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.shadow).toBeNull();

    const noMix = fullSet([{}, {}, {}]);
    delete (noMix["comparisonSetRequirement"] as Record<string, unknown>)["mix"];
    const withoutMix = scoreShadowMilestone(reachableBaseline, noMix);
    expect(withoutMix.incomplete.map((note) => note.code)).toContain("comparison_set_mix_mismatch");
    expect(withoutMix.status).toBe("incomplete");
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

  it("refuses a category the baseline mix does not name at all", () => {
    // The other half of the mix rule. Two `code` entries trip only the
    // over-the-cap branch; a category the baseline never heard of reaches the
    // unrecognised branch, and a set of the right total size could otherwise
    // pass while measuring work the baseline never sampled.
    const record = gateRecord([
      entry("shadow-code", "code"),
      entry("shadow-docs", "docs"),
      entry("shadow-infra", "infra"),
    ]);
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.incomplete.map((note) => note.code)).toContain("comparison_set_mix_mismatch");
    const note = verdict.incomplete.find((row) => row.code === "comparison_set_mix_mismatch")!;
    // The unrecognised-category branch specifically. The over-cap branch emits
    // the same code and also interpolates the category name, so asserting the
    // code and "infra" alone is satisfied by the wrong branch.
    expect(note.message).toContain("which the baseline mix does not include");
    expect(note.message).toContain("infra");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.shadow).toBeNull();
  });

  it("refuses an entry that names no category at all, rather than letting it fill a mix slot", () => {
    // The absent-category sibling of the case above. Uncategorised is not a
    // category the baseline mix includes, so the entry must not silently
    // occupy the operations slot it was never shown to belong in.
    const uncategorised = entry("shadow-operations", "operations", { interventionCount: 99 });
    delete uncategorised["category"];
    const record = gateRecord([entry("shadow-code", "code"), entry("shadow-docs", "docs"), uncategorised]);
    const verdict = scoreShadowMilestone(reachableBaseline, record);
    expect(verdict.incomplete.map((note) => note.code)).toContain("comparison_set_mix_mismatch");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.shadow).toBeNull();
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
    // An honest negative is still an exclusion, and it must reach the ledger:
    // a delivery that vanishes silently cannot be told from one nobody ever
    // submitted.
    const row = verdict.inputs.gateRecord.excludedDeliveries.find((entry) => entry.id === "shadow-operations");
    expect(row).toBeDefined();
    expect(row!.reason).toContain("does not affirm consumption");
  });

  it("honours an explicit gate exclusion even on an affirmative record", () => {
    const excluded = entry("shadow-operations", "operations");
    excluded["countedInComparisonSet"] = false;
    const verdict = scoreShadowMilestone(reachableBaseline, withThirdEntry(excluded));
    expect(verdict.inputs.gateRecord.countedDeliveryIds).not.toContain("shadow-operations");
    expect(verdict.status).toBe("incomplete");
    // The exclusion must reach the ledger, not merely skip the set: a delivery
    // that vanishes silently is indistinguishable from one that was never
    // submitted.
    const row = verdict.inputs.gateRecord.excludedDeliveries.find((entry) => entry.id === "shadow-operations");
    expect(row).toBeDefined();
    expect(row!.reason).toContain("explicitly excluded");
  });

  it("counts only an explicit inclusion flag, so an entry that never states one stays out", () => {
    // Absent is not the same as true. An entry carrying an affirmative binding
    // record but no flag at all would otherwise walk into the set — and here it
    // carries a measurement loud enough to move the figures if it did.
    const unflagged = entry("shadow-operations", "operations", { interventionCount: 99 });
    delete unflagged["countedInComparisonSet"];
    const verdict = scoreShadowMilestone(reachableBaseline, withThirdEntry(unflagged));
    expect(verdict.inputs.gateRecord.countedDeliveryIds).not.toContain("shadow-operations");
    expect(verdict.status).toBe("incomplete");
    expect(verdict.shadow).toBeNull();
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
    const row = verdict.inputs.gateRecord.excludedDeliveries.find((entry) => entry.id === "shadow-docs");
    expect(row).toBeDefined();
    expect(row!.reason).toContain("appears more than once");
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
  it("rejects an entry carrying no score block at all", () => {
    // The ordinary shape the moment the binding writes an entry: consumption
    // observed, nothing scored yet. Unpinned, a weaker guard here reads the
    // members off `undefined` and the scorer throws instead of reporting an
    // unfinished measurement.
    // Both spellings of "not scored": the key absent, and the key present but
    // null. `typeof null` is "object", so the null half needs its own operand
    // in the guard and its own case here.
    for (const spelling of ["absent", "null"] as const) {
      const unscored = entry("shadow-operations", "operations");
      if (spelling === "absent") delete unscored["score"];
      else unscored["score"] = null;
      const record = gateRecord([entry("shadow-code", "code"), entry("shadow-docs", "docs"), unscored]);
      const verdict = scoreShadowMilestone(reachableBaseline, record);
      expect(verdict.incomplete.map((note) => note.code)).toContain("measurement_missing");
      const note = verdict.incomplete.find((row) => row.code === "measurement_missing")!;
      expect(note.message).toContain("carries no score block");
      expect(verdict.status).toBe("incomplete");
      expect(verdict.shadow).toBeNull();
    }
  });

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

describe("operator interventions are reported in full and gate nothing", () => {
  const worseInterventions = fullSet([
    { interventionCount: 9 },
    { interventionCount: 9 },
    { interventionCount: 9 },
  ]);

  it("does not fail a set whose interventions are far worse than the baseline's", () => {
    // The gating direction. A scorer that still gated on interventions would
    // fail this set — its median of 9 is well above the baseline's 2.
    const verdict = scoreShadowMilestone(reachableBaseline, worseInterventions);
    expect(verdict.status).toBe("pass");
    expect(verdict.failures).toEqual([]);
  });

  it("names blocked share as the only criterion the verdict is decided on", () => {
    const verdict = scoreShadowMilestone(reachableBaseline, worseInterventions);
    expect(verdict.criteria.map((row) => row.id)).toEqual(["blockedVersusProgressingShare"]);
  });

  it("still reports the intervention comparison, with its real figures, on that same set", () => {
    // The reporting direction, and the absence-assertion guard: a mechanism
    // that had stopped reporting interventions altogether would satisfy the
    // does-not-fail test above for free. The numbers must actually be there.
    const verdict = scoreShadowMilestone(reachableBaseline, worseInterventions);
    expect(verdict.shadow?.medianOperatorInterventions).toBe(9);
    expect(verdict.shadow?.totalOperatorInterventions).toBe(27);
    const note = verdict.observations.find((row) => row.code === "interventions_reported_not_gated");
    expect(note).toBeDefined();
    // Both sides, in one phrase, so a bare "reported" cannot satisfy this and
    // a stray digit elsewhere in the sentence cannot either.
    expect(note!.message).toContain("median operator-intervention count is 9 against the baseline's 2");
    expect(note!.message).toContain("totals 27 against 8");
  });

  it("reports them just the same when the set is favourable, so the figure cannot go quiet when it flatters", () => {
    const verdict = scoreShadowMilestone(
      reachableBaseline,
      fullSet([{ interventionCount: 0 }, { interventionCount: 0 }, { interventionCount: 0 }]),
    );
    expect(verdict.observations.map((row) => row.code)).toContain("interventions_reported_not_gated");
    expect(verdict.shadow?.medianOperatorInterventions).toBe(0);
    expect(verdict.status).toBe("pass");
  });

  it("reports nothing to compare when there is no scored set, rather than inventing a zero", () => {
    const verdict = scoreShadowMilestone(reachableBaseline, gateRecord([]));
    expect(verdict.observations.map((row) => row.code)).not.toContain("interventions_reported_not_gated");
    expect(verdict.shadow).toBeNull();
  });
});

describe("the gate can be lost", () => {
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
    // The criterion row is what a reader re-derives the decision from, so the
    // two sides must be recorded the right way round. `met: false` looks
    // identical whether or not they were swapped.
    const row = verdict.criteria.find((entry) => entry.id === "blockedVersusProgressingShare")!;
    expect(row.baselineValue).toBe(0.5);
    expect(row.shadowValue).toBeCloseTo(0.9, 10);
    // The row's own verdict, in the direction the other test cannot reach: a
    // criterion that always reported `met` would still look right wherever the
    // gate happened to be cleared.
    expect(row.met).toBe(false);
    // And the interventions are still reported on a set that LOSES. Every
    // other reporting assertion runs on a set that clears the share criterion,
    // so without this a scorer could go quiet on exactly the runs where the
    // gate is lost — which is when the figures matter most.
    const note = verdict.observations.find((row) => row.code === "interventions_reported_not_gated");
    expect(note).toBeDefined();
    expect(note!.message).toContain("median operator-intervention count is 0 against the baseline's 2");
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

  it("carries the reported-not-gated rationale, so the artifact explains itself without this repository's history", () => {
    const committed = readJson(VERDICT_PATH);
    expect(committed.interventionReporting.status).toBe("reported-not-gated");
    expect(committed.interventionReporting.reason.join(" ")).toContain("floor of the metric");
    expect(committed.interventionReporting.reason.join(" ")).toContain("lower bounds");
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

describe("the CLI supports one explicit adopter scoring seam", () => {
  const scratchDirectories: string[] = [];
  const makeScratch = (): string => {
    const directory = mkdtempSync(path.join(tmpdir(), "delivery-harness-m1-scorer-"));
    scratchDirectories.push(directory);
    return directory;
  };
  const writeJson = (file: string, value: unknown): void =>
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const explicitArgs = (baseline: string, gateRecord: string, verdict: string): string[] => [
    "--baseline",
    baseline,
    "--gate-record",
    gateRecord,
    "--verdict",
    verdict,
    "--write",
  ];
  const makeInputs = (scratch: string): { baseline: string; record: string } => {
    const baseline = path.join(scratch, "manual-choreography-baseline.json");
    const record = path.join(scratch, "athena-gate-record.json");
    copyFileSync(path.join(repoRoot, BASELINE_PATH), baseline);
    writeJson(record, athenaGateRecord([]));
    return { baseline, record };
  };

  afterEach(() => {
    for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("preserves the repository-local --write verdict byte for byte", () => {
    const localVerdict = path.join(repoRoot, VERDICT_PATH);
    const before = readFileSync(localVerdict, "utf8");
    const legacyOutput =
      "score-shadow-milestone: incomplete — the M1 shadow gate is not scorable: no_observed_consumption\n" +
      "  incomplete no_observed_consumption\n" +
      "      no delivery has been observed consuming a projection, so there is no comparison set to score; this is the absence of a measurement, not a measured absence\n";

    const readOnlyResult = runScorer([]);
    const writeResult = runScorer(["--write"]);

    expect(readOnlyResult.status).toBe(0);
    expect(readOnlyResult.stdout).toBe(legacyOutput);
    expect(writeResult.status).toBe(0);
    expect(writeResult.stdout).toBe(`${legacyOutput}  wrote ${VERDICT_PATH}\n`);
    expect(readFileSync(localVerdict, "utf8")).toBe(before);
  });

  it("scores an Athena-shaped 0/3 record as incomplete and records the exact explicit inputs", () => {
    const scratch = makeScratch();
    const baseline = path.join(repoRoot, BASELINE_PATH);
    const record = path.join(scratch, "athena-gate-record.json");
    const output = path.join(scratch, "athena-verdict.json");
    const localVerdict = path.join(repoRoot, VERDICT_PATH);
    const localBefore = readFileSync(localVerdict, "utf8");
    writeJson(record, athenaGateRecord([]));

    const result = runScorer(explicitArgs(baseline, record, output));
    const verdict = JSON.parse(readFileSync(output, "utf8"));

    expect(result.status).toBe(0);
    expect(verdict.status).toBe("incomplete");
    expect(verdict.incomplete.map((note: any) => note.code)).toContain("no_observed_consumption");
    expect(verdict.inputs.baseline.path).toBe(baseline);
    expect(verdict.inputs.gateRecord.path).toBe(record);
    expect(readFileSync(localVerdict, "utf8")).toBe(localBefore);
  });

  it("uses the explicit gate-record flag and writes a complete code/docs/operations verdict only to its explicit output", () => {
    const scratch = makeScratch();
    const baseline = path.join(repoRoot, BASELINE_PATH);
    const athenaRecord = path.join(scratch, "athena-gate-record.json");
    const athenaOutput = path.join(scratch, "athena-verdict.json");
    const harnessOutput = path.join(scratch, "harness-verdict.json");
    const localVerdict = path.join(repoRoot, VERDICT_PATH);
    const localBefore = readFileSync(localVerdict, "utf8");
    writeJson(
      athenaRecord,
      athenaGateRecord([
        entry("athena-code", "code"),
        entry("athena-docs", "docs"),
        entry("athena-operations", "operations"),
      ]),
    );

    const athenaResult = runScorer(explicitArgs(baseline, athenaRecord, athenaOutput));
    const harnessResult = runScorer(
      explicitArgs(baseline, path.join(repoRoot, GATE_RECORD_PATH), harnessOutput),
    );
    const athenaVerdict = JSON.parse(readFileSync(athenaOutput, "utf8"));
    const harnessVerdict = JSON.parse(readFileSync(harnessOutput, "utf8"));

    expect(athenaResult.status).toBe(0);
    expect(harnessResult.status).toBe(0);
    expect(athenaVerdict.status).toBe("pass");
    expect(athenaVerdict.inputs.gateRecord.countedDeliveryIds).toEqual([
      "athena-code",
      "athena-docs",
      "athena-operations",
    ]);
    expect(harnessVerdict.status).toBe("incomplete");
    expect(harnessVerdict.inputs.gateRecord.countedDeliveryIds).toEqual([]);
    expect(readFileSync(localVerdict, "utf8")).toBe(localBefore);
  });

  it("refuses every partial explicit-input invocation instead of mixing it with repository-local paths", () => {
    const scratch = makeScratch();
    const values = {
      "--baseline": path.join(repoRoot, BASELINE_PATH),
      "--gate-record": path.join(scratch, "athena-gate-record.json"),
      "--verdict": path.join(scratch, "athena-verdict.json"),
    } as const;
    writeJson(values["--gate-record"], athenaGateRecord([]));

    for (const omitted of Object.keys(values) as Array<keyof typeof values>) {
      const args = (Object.entries(values) as Array<[keyof typeof values, string]>).flatMap(([flag, value]) =>
        flag === omitted ? [] : [flag, value],
      );
      const result = runScorer([...args, "--write"]);
      expect(result.status, omitted).toBe(2);
      expect(result.stderr, omitted).toContain(
        "Usage: score-shadow-milestone [--write] [--baseline <path> --gate-record <path> --verdict <path>]",
      );
    }
  });

  it("fails unreadable explicit inputs instead of falling back to repository-local files", () => {
    const scratch = makeScratch();
    const missingBaseline = path.join(scratch, "missing-baseline.json");
    const malformedRecord = path.join(scratch, "malformed-gate-record.json");
    const validRecord = path.join(scratch, "athena-gate-record.json");
    const output = path.join(scratch, "athena-verdict.json");
    writeJson(validRecord, athenaGateRecord([]));
    writeFileSync(malformedRecord, "not JSON\n");

    const missing = runScorer(explicitArgs(missingBaseline, validRecord, output));
    const malformed = runScorer(explicitArgs(path.join(repoRoot, BASELINE_PATH), malformedRecord, output));

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("ENOENT");
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("SyntaxError");
  });

  it("rejects every token outside the closed CLI grammar", () => {
    const scratch = makeScratch();
    const { baseline, record } = makeInputs(scratch);
    const output = path.join(scratch, "athena-verdict.json");
    const valid = explicitArgs(baseline, record, output);
    const cases: Array<readonly [string, readonly string[]]> = [
      ["unknown option", [...valid, "--unknown"]],
      ["trailing token", [...valid, "trailing"]],
      [
        "equals form",
        [`--baseline=${baseline}`, "--gate-record", record, "--verdict", output, "--write"],
      ],
      ["duplicate baseline", [...valid, "--baseline", baseline]],
      ["duplicate gate record", [...valid, "--gate-record", record]],
      ["duplicate verdict", [...valid, "--verdict", output]],
      ["duplicate write", [...valid, "--write"]],
      ["missing value", ["--baseline"]],
      ["flag-looking value", ["--baseline", "--write"]],
    ];

    for (const [label, args] of cases) {
      const result = runScorer(args);
      expect(result.status, label).toBe(2);
      expect(result.stderr, label).toContain(
        "Usage: score-shadow-milestone [--write] [--baseline <path> --gate-record <path> --verdict <path>]",
      );
    }
    expect(existsSync(output)).toBe(false);
  });

  it("refuses a verdict path that is directly the baseline input without changing either input", () => {
    const scratch = makeScratch();
    const { baseline, record } = makeInputs(scratch);
    const baselineBefore = readFileSync(baseline, "utf8");
    const recordBefore = readFileSync(record, "utf8");

    const result = runScorer(explicitArgs(baseline, record, baseline));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--verdict path aliases the --baseline input");
    expect(readFileSync(baseline, "utf8")).toBe(baselineBefore);
    expect(readFileSync(record, "utf8")).toBe(recordBefore);
  });

  it("refuses a verdict symlink to the gate-record input without changing either input", () => {
    const scratch = makeScratch();
    const { baseline, record } = makeInputs(scratch);
    const output = path.join(scratch, "verdict-link.json");
    const baselineBefore = readFileSync(baseline, "utf8");
    const recordBefore = readFileSync(record, "utf8");
    symlinkSync(record, output);

    const result = runScorer(explicitArgs(baseline, record, output));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--verdict path aliases the --gate-record input");
    expect(readFileSync(baseline, "utf8")).toBe(baselineBefore);
    expect(readFileSync(record, "utf8")).toBe(recordBefore);
  });

  it("refuses an existing verdict hardlink to an input without changing either input", () => {
    const scratch = makeScratch();
    const { baseline, record } = makeInputs(scratch);
    const output = path.join(scratch, "verdict-hardlink.json");
    const baselineBefore = readFileSync(baseline, "utf8");
    const recordBefore = readFileSync(record, "utf8");
    linkSync(record, output);

    const result = runScorer(explicitArgs(baseline, record, output));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--verdict path aliases the --gate-record input");
    expect(readFileSync(baseline, "utf8")).toBe(baselineBefore);
    expect(readFileSync(record, "utf8")).toBe(recordBefore);
  });

  it("accepts a non-existing verdict through a symlinked parent and writes its canonical target", () => {
    const scratch = makeScratch();
    const realDirectory = path.join(scratch, "real");
    const linkedDirectory = path.join(scratch, "linked");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedDirectory, "dir");
    const { baseline, record } = makeInputs(scratch);
    const output = path.join(linkedDirectory, "athena-verdict.json");

    const result = runScorer(explicitArgs(baseline, record, output));

    expect(result.status).toBe(0);
    expect(existsSync(output)).toBe(true);
    expect(existsSync(path.join(realDirectory, "athena-verdict.json"))).toBe(true);
  });
});
