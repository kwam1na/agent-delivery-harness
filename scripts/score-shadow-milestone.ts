/**
 * THE M1 SHADOW GATE'S SCORER.
 *
 * The gate-record writer turns a live binding observation into a durable
 * per-delivery entry. That is the CONSUMPTION half of the milestone. This
 * module is the other half: it takes the counted comparison set and the frozen
 * manual-choreography baseline and computes the two figures the gate actually
 * decides on —
 *
 *   - the MEDIAN OPERATOR INTERVENTION COUNT, which must be strictly lower
 *     than the baseline's, and
 *   - the BLOCKED-VERSUS-PROGRESSING SHARE, which must not regress against the
 *     baseline's,
 *
 * — and writes a verdict carrying every input it used, so the number can be
 * re-derived rather than trusted.
 *
 * WHAT IT IS NOT. It is arithmetic over recorded facts. It measures nothing
 * itself, it reads no transcript, and it spawns no host. Each counted entry
 * must already carry a `score` block, scored by an operator against the
 * baseline's own rubric; if one does not, the result is INCOMPLETE, never a
 * verdict computed over the entries that happened to be scored.
 *
 * LIKE-FOR-LIKE IS BY CONSTRUCTION, NOT BY ASSERTION. A counted entry's `score`
 * block uses the same member names and the same units as the baseline's own
 * per-delivery `score` block, and both sides are reduced by the identical
 * functions below. The comparison cannot drift to fit the result, because
 * there is only one implementation of each figure. The rubric the operator
 * scored against is pinned into the verdict by its digest: if the plan's
 * rubric text is ever amended, the baseline's recorded digest stops matching
 * it, the baseline's own re-record trigger fires, and the verdict names the
 * digest it was computed under.
 *
 * POLICY-REQUIRED INTERRUPTIONS ARE NEVER INTERVENTIONS. The rubric puts
 * admission-grant prompts, the contract confirmation, takeover authorizations
 * and sensitive approvals in a separate category, and the walking skeleton
 * already established that precedent. They are summed, reported beside the
 * intervention figures, and enter no comparison. Nothing else is excluded: a
 * nudge to a stalled agent, a relayed verdict, a corrected tracker state, a
 * resume after a limit are all interventions, and a gate that scored lower by
 * dropping the awkward categories would prove nothing.
 *
 * THE EMPTY SET IS NOT A NEGATIVE FINDING. An unobserved consumption is
 * spelled identically to an honest absence, and only a live host tells them
 * apart. So a comparison set with no counted delivery reports that NO DELIVERY
 * HAS BEEN OBSERVED CONSUMING A PROJECTION. It never says the gate failed and
 * never says nothing consumed — both would read an absent measurement as a
 * measured zero.
 *
 * AND THE VERDICT CAN FAIL. If the figures do not clear the bar, the status is
 * `fail` and the unmet criterion is named. A gate that cannot fail is not a
 * gate. The converse is checked too: if the baseline's own median already sits
 * at the floor, `strictly lower` is unsatisfiable by any non-negative count,
 * and the verdict says so as an observation rather than passing that off as an
 * ordinary loss.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyConsumptionRecord } from "./shadow-discovery-guard.ts";

export const SHADOW_MILESTONE_VERDICT_SPEC = "shadow-milestone-gate-verdict/1";
export const MANUAL_CHOREOGRAPHY_BASELINE_SPEC = "manual-choreography-baseline/1";

export const BASELINE_PATH = "qualifications/manual-choreography-baseline.json";
export const GATE_RECORD_PATH = ".agents/policy/shadow-milestone-gate-record.json";
export const VERDICT_PATH = "qualifications/shadow-milestone-gate-verdict.json";

/**
 * Why a set could not be scored. Distinct from a criterion the set was scored
 * against and lost: an incomplete result is the absence of a verdict, and
 * collapsing the two is how an unmeasured milestone comes to read as a failed
 * one.
 */
export type ShadowScoreIncompleteCode =
  | "baseline_unrecognized"
  | "baseline_host_mismatch"
  | "gate_record_unrecognized"
  | "no_observed_consumption"
  | "comparison_set_incomplete"
  | "comparison_set_mix_mismatch"
  | "measurement_missing"
  | "measurement_shape";

/** A gate criterion the scored set did not clear. */
export type ShadowScoreFailureCode = "intervention_median_not_lower" | "blocked_share_regressed";

export type ShadowScoreObservationCode = "intervention_criterion_unreachable";

export type ShadowScoreNote<Code extends string> = { readonly code: Code; readonly message: string };

/** The reduced figures of one side of the comparison. */
export type ShadowScoreFigures = {
  readonly deliveryCount: number;
  readonly interventionCounts: readonly number[];
  readonly medianOperatorInterventions: number;
  readonly totalOperatorInterventions: number;
  readonly policyRequiredInterruptionCount: number;
  readonly blockedSeconds: number;
  readonly progressingSeconds: number;
  readonly blockedShare: number;
};

export type ShadowScoreCriterion = {
  readonly id: "medianOperatorInterventionsAfterAcceptance" | "blockedVersusProgressingShare";
  readonly requirement: string;
  readonly baselineValue: number;
  readonly shadowValue: number;
  readonly met: boolean;
};

export type ShadowMilestoneVerdict = {
  readonly spec: typeof SHADOW_MILESTONE_VERDICT_SPEC;
  readonly status: "pass" | "fail" | "incomplete";
  readonly summary: string;
  readonly incomplete: readonly ShadowScoreNote<ShadowScoreIncompleteCode>[];
  readonly failures: readonly ShadowScoreNote<ShadowScoreFailureCode>[];
  readonly observations: readonly ShadowScoreNote<ShadowScoreObservationCode>[];
  readonly inputs: {
    readonly baseline: {
      readonly path: string;
      readonly schemaVersion: unknown;
      readonly capturedAt: unknown;
      readonly provingHost: unknown;
      readonly operatorInterventionRubricSha256: unknown;
      readonly deliveryIds: readonly string[];
    };
    readonly gateRecord: {
      readonly path: string;
      readonly countedDeliveryIds: readonly string[];
      readonly excludedDeliveries: readonly { readonly id: string; readonly reason: string }[];
      readonly perDeliveryScores: readonly Record<string, unknown>[];
    };
  };
  readonly baseline: ShadowScoreFigures;
  readonly shadow: ShadowScoreFigures | null;
  readonly criteria: readonly ShadowScoreCriterion[];
  readonly measurementContract: typeof MEASUREMENT_CONTRACT;
};

/**
 * WHAT A COUNTED DELIVERY MUST CARRY, AND WHERE IT COMES FROM.
 *
 * Stated in the artifact rather than only in this file, because the operator
 * who has to produce these numbers reads the artifact. Two of the three are
 * NOT derivable from anything the product records: the journal carries no
 * wall-clock, and the binding registers no hook on operator input, so nothing
 * the product owns can see an operator prompt or time a stall. They come from
 * the host's own session transcript, scored exactly the way the baseline was
 * scored — which is also why the transcript has to survive the session.
 */
export const MEASUREMENT_CONTRACT = Object.freeze({
  scoredBy: "operator",
  againstRubric: "the baseline's operatorInterventionRubric, by the baseline's own method.scoring steps",
  members: Object.freeze([
    Object.freeze({
      name: "interventionCount",
      source: "host session transcript",
      note: "operator inputs the delivery could not proceed without while the host had stopped; inputs made while the host was progressing are steering, not interventions",
    }),
    Object.freeze({
      name: "policyRequiredInterruptionCount",
      source: "the delivery journal, cross-checked against the transcript",
      note: "admission-grant prompts, the contract confirmation, takeover authorizations and sensitive approvals; recorded beside the interventions and counted into neither figure",
    }),
    Object.freeze({
      name: "blockedSeconds / progressingSeconds",
      source: "host session transcript",
      note: "blocked is the sum over interventions of the idle gap from the host's last event to the operator input that restarted it; all remaining window time is progressing",
    }),
  ]),
  preconditions: Object.freeze([
    "The host session transcript must survive the session. A disposable host configuration directory takes the transcript with it when it is removed, and the two wall-clock figures become unrecoverable — the delivery can then never be counted, whatever the binding observed.",
    "The delivery window's start and end must be identifiable in the transcript: the operator's scoped handoff message opens it, the merge closes it.",
  ]),
});

// ── Reduction ────────────────────────────────────────────────────────────────

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The median of a non-empty list. An even-sized list takes the mean of the two
 * middle values, which is why the figure is not always an integer even though
 * every intervention count is.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of an empty list is undefined");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The aggregate blocked share: blocked wall-clock over the whole window of the
 * set, NOT the mean of the per-delivery shares. A mean of shares weights a
 * forty-minute delivery the same as a seven-hour one, and the figure is about
 * how much of the operator's actual elapsed time the choreography spent
 * stopped.
 *
 * A set whose total window is zero has no share to speak of; the caller
 * rejects that as a measurement defect rather than dividing by zero here.
 */
export function aggregateBlockedShare(blockedSeconds: number, progressingSeconds: number): number {
  const window = blockedSeconds + progressingSeconds;
  return window === 0 ? 0 : blockedSeconds / window;
}

/** Reduce a list of per-delivery `score` blocks to one side's figures. */
function reduceScores(scores: readonly Record<string, any>[]): ShadowScoreFigures {
  const interventionCounts = scores.map((score) => Number(score["interventionCount"]));
  const blockedSeconds = scores.reduce((sum, score) => sum + Number(score["blockedSeconds"]), 0);
  const progressingSeconds = scores.reduce((sum, score) => sum + Number(score["progressingSeconds"]), 0);
  return {
    deliveryCount: scores.length,
    interventionCounts,
    medianOperatorInterventions: median(interventionCounts),
    totalOperatorInterventions: interventionCounts.reduce((sum, value) => sum + value, 0),
    policyRequiredInterruptionCount: scores.reduce(
      (sum, score) => sum + Number(score["policyRequiredInterruptionCount"]),
      0,
    ),
    blockedSeconds,
    progressingSeconds,
    blockedShare: aggregateBlockedShare(blockedSeconds, progressingSeconds),
  };
}

/**
 * The members every scored delivery must carry, on both sides. Absent or
 * malformed, the set is INCOMPLETE — the delivery is not scored as a zero.
 */
function scoreDefect(id: string, score: unknown): string | undefined {
  if (typeof score !== "object" || score === null) {
    return `delivery ${id} is counted in the comparison set but carries no score block; it cannot be measured against the baseline`;
  }
  const block = score as Record<string, unknown>;
  if (!isNonNegativeInteger(block["interventionCount"])) {
    return `delivery ${id} carries no non-negative integer interventionCount`;
  }
  if (!isNonNegativeInteger(block["policyRequiredInterruptionCount"])) {
    return `delivery ${id} carries no non-negative integer policyRequiredInterruptionCount; the split from interventions must be explicit, not inferred`;
  }
  if (!isNonNegativeFinite(block["blockedSeconds"]) || !isNonNegativeFinite(block["progressingSeconds"])) {
    return `delivery ${id} carries no non-negative blockedSeconds and progressingSeconds wall-clock split`;
  }
  if ((block["blockedSeconds"] as number) + (block["progressingSeconds"] as number) === 0) {
    return `delivery ${id} has a zero-length delivery window, so it contributes no measurable blocked share`;
  }
  return undefined;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export function scoreShadowMilestone(baseline: any, gateRecord: any): ShadowMilestoneVerdict {
  const incomplete: ShadowScoreNote<ShadowScoreIncompleteCode>[] = [];
  const failures: ShadowScoreNote<ShadowScoreFailureCode>[] = [];
  const observations: ShadowScoreNote<ShadowScoreObservationCode>[] = [];

  // ── The baseline's rubric is pinned before anything is computed against it ──
  if (baseline?.schemaVersion !== MANUAL_CHOREOGRAPHY_BASELINE_SPEC) {
    incomplete.push({
      code: "baseline_unrecognized",
      message: `the baseline declares ${JSON.stringify(
        baseline?.schemaVersion,
      )} rather than ${MANUAL_CHOREOGRAPHY_BASELINE_SPEC}; the scorer compares against the frozen manual-choreography baseline and nothing else`,
    });
  }
  const recordBaseline = gateRecord?.baseline ?? {};
  if (
    baseline?.provingHost !== undefined &&
    recordBaseline.provingHost !== undefined &&
    baseline.provingHost !== recordBaseline.provingHost
  ) {
    incomplete.push({
      code: "baseline_host_mismatch",
      message: `the gate record measures deliveries on ${JSON.stringify(
        recordBaseline.provingHost,
      )} while the baseline was captured on ${JSON.stringify(
        baseline.provingHost,
      )}; a cross-host comparison is not like-for-like`,
    });
  }

  const baselineDeliveries: any[] = Array.isArray(baseline?.deliveries) ? baseline.deliveries : [];
  for (const delivery of baselineDeliveries) {
    const defect = scoreDefect(String(delivery?.id ?? "<unnamed>"), delivery?.score);
    if (defect !== undefined) incomplete.push({ code: "measurement_shape", message: `baseline: ${defect}` });
  }
  if (baselineDeliveries.length === 0) {
    incomplete.push({
      code: "baseline_unrecognized",
      message: "the baseline records no delivery, so it fixes no figure to compare against",
    });
  }

  // ── The counted comparison set ─────────────────────────────────────────────
  if (!Array.isArray(gateRecord?.deliveries)) {
    incomplete.push({
      code: "gate_record_unrecognized",
      message: `the gate record carries no deliveries list; the counted set is enumerated from that list and from nothing else`,
    });
  }
  // ENUMERATED OFF THE RECORD'S OWN LIST. Deriving the set from anywhere else —
  // a directory scan, a journal sweep — is how an "every counted delivery
  // carries a binding-sourced record" claim comes to hold vacuously: when the
  // enumerating mechanism goes missing, the set is empty and the claim passes
  // for free.
  const entries: any[] = Array.isArray(gateRecord?.deliveries) ? gateRecord.deliveries : [];
  const countedDeliveryIds: string[] = [];
  const excludedDeliveries: { id: string; reason: string }[] = [];
  const countedScores: Record<string, any>[] = [];
  const countedByCategory = new Map<string, number>();

  for (const entry of entries) {
    const id = String(entry?.id ?? "<unnamed>");
    const admission = classifyConsumptionRecord(entry);
    if (!admission.admissible) {
      excludedDeliveries.push({
        id,
        reason:
          admission.defect?.message ??
          `delivery ${id} carries a binding-sourced record that does not affirm consumption, so it is not counted`,
      });
      continue;
    }
    if (entry?.countedInComparisonSet !== true) {
      excludedDeliveries.push({
        id,
        reason: `delivery ${id} carries an affirmative binding-sourced record but the gate has explicitly excluded it from the comparison set`,
      });
      continue;
    }
    if (countedDeliveryIds.includes(id)) {
      excludedDeliveries.push({ id, reason: `delivery ${id} appears more than once; one run is one member of the set` });
      continue;
    }
    countedDeliveryIds.push(id);
    const category = String(entry?.category ?? "<uncategorised>");
    countedByCategory.set(category, (countedByCategory.get(category) ?? 0) + 1);
    const defect = scoreDefect(id, entry?.score);
    if (defect === undefined) countedScores.push(entry.score as Record<string, any>);
    else incomplete.push({ code: "measurement_missing", message: defect });
  }

  // ── Size and mix ───────────────────────────────────────────────────────────
  const requirement = gateRecord?.comparisonSetRequirement ?? {};
  const requiredMix: Record<string, unknown> = requirement.mix ?? {};
  const requiredTotal = Number(requirement.total ?? NaN);

  if (countedDeliveryIds.length === 0) {
    // NOT a failure and NOT "nothing consumed". The measurement has not been
    // taken; that is all this says.
    incomplete.push({
      code: "no_observed_consumption",
      message:
        "no delivery has been observed consuming a projection, so there is no comparison set to score; this is the absence of a measurement, not a measured absence",
    });
  } else if (!(countedDeliveryIds.length >= requiredTotal)) {
    // Negated `>=` so an unparseable total falls to the incomplete side.
    incomplete.push({
      code: "comparison_set_incomplete",
      message: `the comparison set holds ${countedDeliveryIds.length} of the ${requiredTotal} deliveries the baseline mix requires; a partial set yields no verdict, provisional or otherwise`,
    });
  }
  for (const [category, count] of countedByCategory) {
    const allowed = Object.hasOwn(requiredMix, category) ? Number(requiredMix[category]) : undefined;
    if (allowed === undefined || !Number.isFinite(allowed)) {
      incomplete.push({
        code: "comparison_set_mix_mismatch",
        message: `the comparison set counts a ${category} delivery, which the baseline mix does not include`,
      });
    } else if (count !== allowed) {
      incomplete.push({
        code: "comparison_set_mix_mismatch",
        message: `the comparison set counts ${count} ${category} deliveries against the baseline's ${allowed}; the set must match the baseline's mix, not merely its total`,
      });
    }
  }

  // ── Figures ────────────────────────────────────────────────────────────────
  const baselineScorable = baselineDeliveries
    .map((delivery) => delivery?.score)
    .filter((score): score is Record<string, any> => scoreDefect("baseline", score) === undefined);
  const baselineFigures =
    baselineScorable.length > 0
      ? reduceScores(baselineScorable)
      : {
          deliveryCount: 0,
          interventionCounts: [],
          medianOperatorInterventions: Number.NaN,
          totalOperatorInterventions: 0,
          policyRequiredInterruptionCount: 0,
          blockedSeconds: 0,
          progressingSeconds: 0,
          blockedShare: Number.NaN,
        };

  const scorable = incomplete.length === 0 && countedScores.length === countedDeliveryIds.length && countedScores.length > 0;
  const shadowFigures = scorable ? reduceScores(countedScores) : null;

  const criteria: ShadowScoreCriterion[] = [];
  if (shadowFigures !== null) {
    const medianMet = shadowFigures.medianOperatorInterventions < baselineFigures.medianOperatorInterventions;
    criteria.push({
      id: "medianOperatorInterventionsAfterAcceptance",
      requirement: "must be strictly lower than the baseline's",
      baselineValue: baselineFigures.medianOperatorInterventions,
      shadowValue: shadowFigures.medianOperatorInterventions,
      met: medianMet,
    });
    if (!medianMet) {
      failures.push({
        code: "intervention_median_not_lower",
        message: `the shadow set's median operator-intervention count is ${shadowFigures.medianOperatorInterventions} against the baseline's ${baselineFigures.medianOperatorInterventions}; the gate requires strictly lower`,
      });
    }
    // Not regressed, so equal clears it: the criterion is worded as a
    // no-regression bar, and reading it as strict improvement would fail a
    // choreography that spent exactly as little time blocked.
    const shareMet = shadowFigures.blockedShare <= baselineFigures.blockedShare;
    criteria.push({
      id: "blockedVersusProgressingShare",
      requirement: "must not regress against the baseline's",
      baselineValue: baselineFigures.blockedShare,
      shadowValue: shadowFigures.blockedShare,
      met: shareMet,
    });
    if (!shareMet) {
      failures.push({
        code: "blocked_share_regressed",
        message: `the shadow set spends ${(shadowFigures.blockedShare * 100).toFixed(2)}% of its window blocked against the baseline's ${(
          baselineFigures.blockedShare * 100
        ).toFixed(2)}%; the gate requires no regression`,
      });
    }
  }

  // A floor at zero makes `strictly lower` unsatisfiable by any non-negative
  // count. Reported wherever the baseline is legible, complete set or not:
  // an operator learning this only after running three sessions learns it too
  // late.
  if (baselineFigures.medianOperatorInterventions === 0) {
    observations.push({
      code: "intervention_criterion_unreachable",
      message:
        "the baseline's median operator-intervention count is already 0, so no non-negative count can be strictly lower; as worded, this criterion cannot be cleared by any shadow set and needs an explicit decision before the comparison means anything",
    });
  }

  const status: ShadowMilestoneVerdict["status"] =
    incomplete.length > 0 || shadowFigures === null ? "incomplete" : failures.length > 0 ? "fail" : "pass";

  const summary =
    status === "incomplete"
      ? `the M1 shadow gate is not scorable: ${incomplete.map((note) => note.code).join(", ") || "no comparison set"}`
      : status === "fail"
        ? `the M1 shadow gate is not met: ${failures.map((note) => note.code).join(", ")}`
        : "the M1 shadow gate is met: the counted comparison set improves the median operator-intervention count and does not regress the blocked share";

  return {
    spec: SHADOW_MILESTONE_VERDICT_SPEC,
    status,
    summary,
    incomplete,
    failures,
    observations,
    inputs: {
      baseline: {
        path: BASELINE_PATH,
        schemaVersion: baseline?.schemaVersion,
        capturedAt: baseline?.capturedAt,
        provingHost: baseline?.provingHost,
        operatorInterventionRubricSha256: baseline?.operatorInterventionRubric?.sha256,
        deliveryIds: baselineDeliveries.map((delivery) => String(delivery?.id ?? "<unnamed>")),
      },
      gateRecord: {
        path: GATE_RECORD_PATH,
        countedDeliveryIds,
        excludedDeliveries,
        // The per-delivery blocks the figures were reduced from, copied into
        // the verdict so the arithmetic is re-derivable from the artifact
        // alone rather than by re-reading a record that has since moved on.
        perDeliveryScores: countedScores,
      },
    },
    baseline: baselineFigures,
    shadow: shadowFigures,
    criteria,
    measurementContract: MEASUREMENT_CONTRACT,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function renderVerdict(verdict: ShadowMilestoneVerdict): string {
  return `${JSON.stringify(verdict, null, 2)}\n`;
}

export function readVerdictInputs(repoRoot: string): { baseline: any; gateRecord: any } {
  const read = (relative: string): any => JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));
  return { baseline: read(BASELINE_PATH), gateRecord: read(GATE_RECORD_PATH) };
}

export function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function main(): void {
  const repoRoot = repoRootFromHere();
  const { baseline, gateRecord } = readVerdictInputs(repoRoot);
  const verdict = scoreShadowMilestone(baseline, gateRecord);
  const write = process.argv.includes("--write");
  if (write) writeFileSync(path.join(repoRoot, VERDICT_PATH), renderVerdict(verdict));

  process.stdout.write(`score-shadow-milestone: ${verdict.status} — ${verdict.summary}\n`);
  for (const note of verdict.incomplete) process.stdout.write(`  incomplete ${note.code}\n      ${note.message}\n`);
  for (const note of verdict.failures) process.stdout.write(`  unmet ${note.code}\n      ${note.message}\n`);
  for (const note of verdict.observations) process.stdout.write(`  observation ${note.code}\n      ${note.message}\n`);
  if (write) process.stdout.write(`  wrote ${VERDICT_PATH}\n`);
  // An incomplete set is not a failed run: the operator has not finished
  // measuring, and exiting non-zero would make an unfinished milestone
  // indistinguishable from a lost one in CI.
  process.exitCode = verdict.status === "fail" ? 1 : 0;
}

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) main();
