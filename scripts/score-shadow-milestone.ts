/**
 * THE M1 SHADOW GATE'S SCORER.
 *
 * The gate-record writer turns a live binding observation into a durable
 * per-delivery entry. That is the CONSUMPTION half of the milestone. This
 * module is the other half: it takes the counted comparison set and the frozen
 * manual-choreography baseline and computes the two figures the milestone
 * reports on —
 *
 *   - the MEDIAN OPERATOR INTERVENTION COUNT, reported in full and gating
 *     nothing, and
 *   - the BLOCKED-VERSUS-PROGRESSING SHARE, which must not regress against the
 *     baseline's, and which alone decides the verdict,
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
 * INTERVENTIONS ARE REPORTED IN FULL AND GATE NOTHING; BLOCKED SHARE GATES.
 * Both figures are still computed on both sides and both are still reported.
 * Only the blocked share decides the verdict, and the reason is recorded in
 * `INTERVENTION_REPORTING` below rather than left to a commit message:
 * the baseline's own intervention counts are [2, 0, 0], a median of 0, which is
 * the floor of the metric — nothing non-negative can be strictly lower, so a
 * baseline sitting there cannot demonstrate improvement — and the baseline's
 * `limitations` block concedes those counts are LOWER BOUNDS, because
 * transcripts do not record silently granted host permission prompts. The
 * metric has no headroom and the number it reports is admittedly incomplete.
 * Relaxing to `not higher` was rejected: tying a self-declared lower bound
 * proves close to nothing. Re-recording the baseline under a wider rubric is
 * what its own `reRecordTriggers` anticipate, and is the way this becomes a
 * gating criterion again.
 *
 * SO THE REPORTING GETS LOUDER, NOT QUIETER. Every orchestrator step-in stays
 * counted — a nudge to a stalled agent, a relayed verdict, a corrected tracker
 * state, a resume after a limit, re-dispatched work — because the intervention
 * profile is now an honest record rather than a scoreboard, and a record has
 * no incentive to be flattering.
 *
 * AND THE VERDICT CAN FAIL. If the blocked share regresses, the status is
 * `fail` and the unmet criterion is named. A gate that cannot fail is not a
 * gate.
 */
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyConsumptionRecord } from "./shadow-discovery-guard.ts";

export const SHADOW_MILESTONE_VERDICT_SPEC = "shadow-milestone-gate-verdict/1";
export const MANUAL_CHOREOGRAPHY_BASELINE_SPEC = "manual-choreography-baseline/1";

export const BASELINE_PATH = "qualifications/manual-choreography-baseline.json";
export const GATE_RECORD_PATH = ".agents/policy/shadow-milestone-gate-record.json";
export const VERDICT_PATH = "qualifications/shadow-milestone-gate-verdict.json";
export const SCORER_USAGE =
  "Usage: score-shadow-milestone [--write] [--baseline <path> --gate-record <path> --verdict <path>]";

export type ShadowMilestoneInputPaths = {
  readonly baseline: string;
  readonly gateRecord: string;
};

export type ShadowMilestoneFilePaths = ShadowMilestoneInputPaths & {
  readonly verdict: string;
};

const REPOSITORY_LOCAL_INPUT_PATHS: ShadowMilestoneInputPaths = Object.freeze({
  baseline: BASELINE_PATH,
  gateRecord: GATE_RECORD_PATH,
});

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
export type ShadowScoreFailureCode = "blocked_share_regressed";

/**
 * `interventions_reported_not_gated` carries the intervention comparison the
 * gate no longer decides on. It fires on every scored set, whichever way the
 * numbers fall, so the figures cannot quietly stop being reported once they
 * stop being flattering.
 */
export type ShadowScoreObservationCode = "interventions_reported_not_gated";

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
  readonly id: "blockedVersusProgressingShare";
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
  readonly interventionReporting: typeof INTERVENTION_REPORTING;
  readonly measurementContract: typeof MEASUREMENT_CONTRACT;
};

/**
 * WHY THE INTERVENTION FIGURES ARE REPORTED AND NOT GATED.
 *
 * In the artifact, not only in this file and not only in the pull request that
 * changed it. A reader six months from now must be able to see that the
 * criterion was dropped because the metric had no headroom — not because it
 * was inconvenient. Without this paragraph the change is indistinguishable
 * from a gate quietly relaxed to fit a result, which is the specific thing the
 * milestone exists to rule out.
 */
export const INTERVENTION_REPORTING = Object.freeze({
  status: "reported-not-gated",
  gatingCriterion: "blockedVersusProgressingShare",
  reason: Object.freeze([
    "The baseline's own intervention counts are [2, 0, 0] — a median of 0, which is the floor of the metric. No non-negative count can be strictly lower, so a baseline sitting at the floor cannot demonstrate improvement in either direction.",
    "The baseline's limitations block concedes the counts are lower bounds: transcripts do not record silently granted host permission prompts, so the figure it reports is admittedly incomplete.",
    "Relaxing the comparison to 'not higher' was rejected. Tying a self-declared lower bound proves close to nothing.",
    "Blocked share has real room to move and is measured from the same transcripts under the same rubric, so it carries the gate alone.",
  ]),
  stillCounted:
    "Every orchestrator step-in the baseline's rubric counts is still counted and still reported — nudging a stalled agent, relaying a verdict that could not reach its recipient, correcting a tracker state, resuming after a limit, re-dispatching lost work. Ceasing to gate on the figure is not licence to stop measuring it.",
  policyRequiredInterruptions:
    "Still tracked separately and still counted into neither figure. A product that blocks correctly must not improve its own score by asking the operator to press a key.",
  howItBecomesGatingAgain:
    "Re-record the baseline under a rubric wide enough to have headroom — which is what its own reRecordTriggers anticipate — and restore the comparison against the re-recorded figure.",
  supersedes:
    "The gate record's gateMetrics declares medianOperatorInterventionsAfterAcceptance reported in full and gating nothing, and names blockedVersusProgressingShare its sole gating criterion — the position this block states, in the same words. The record's earlier 'must be strictly lower than the baseline's' was superseded here and applied by nothing, and was corrected in a reviewed delivery's diff: the protection over .agents is that no execution grant may write the record at runtime, which stops a running session authoring its own entry and never barred a reviewed edit to the file.",
});

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

export function scoreShadowMilestone(
  baseline: any,
  gateRecord: any,
  inputPaths: ShadowMilestoneInputPaths = REPOSITORY_LOCAL_INPUT_PATHS,
): ShadowMilestoneVerdict {
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
  // BOTH SIDES MUST NAME A HOST. An undeclared host used to be tolerated, and
  // a record that simply omitted the field then scored as like-for-like
  // against a baseline captured on another host — an unestablished fact
  // reading as a satisfied one, which is the failure this module is built
  // around. Silence about the host is not agreement about it.
  const recordBaseline = gateRecord?.baseline ?? {};
  if (baseline?.provingHost === undefined || recordBaseline.provingHost === undefined) {
    incomplete.push({
      code: "baseline_host_mismatch",
      message: `like-for-like cannot be established: the baseline names ${JSON.stringify(
        baseline?.provingHost,
      )} as its proving host and the gate record names ${JSON.stringify(
        recordBaseline.provingHost,
      )}; both must say which host their deliveries ran on`,
    });
  } else if (baseline.provingHost !== recordBaseline.provingHost) {
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
    // REPORTED, NEVER GATED. Emitted unconditionally on a scored set — not
    // only when the numbers happen to favour the shadow run — so that a
    // mechanism which stopped reporting interventions could not pass for one
    // that reported a good result. Nothing here pushes to `failures`.
    observations.push({
      code: "interventions_reported_not_gated",
      message: `the shadow set's median operator-intervention count is ${shadowFigures.medianOperatorInterventions} against the baseline's ${baselineFigures.medianOperatorInterventions} (totals ${shadowFigures.totalOperatorInterventions} against ${baselineFigures.totalOperatorInterventions}, over ${shadowFigures.deliveryCount} and ${baselineFigures.deliveryCount} deliveries), with ${shadowFigures.policyRequiredInterruptionCount} policy-required interruptions counted separately; reported and not gated because the baseline's median sits at the metric's floor and its counts are lower bounds — see interventionReporting`,
    });
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

  const status: ShadowMilestoneVerdict["status"] =
    incomplete.length > 0 || shadowFigures === null ? "incomplete" : failures.length > 0 ? "fail" : "pass";

  const summary =
    status === "incomplete"
      ? `the M1 shadow gate is not scorable: ${incomplete.map((note) => note.code).join(", ") || "no comparison set"}`
      : status === "fail"
        ? `the M1 shadow gate is not met: ${failures.map((note) => note.code).join(", ")}`
        : "the M1 shadow gate is met: the counted comparison set does not regress the blocked share, and its operator-intervention figures are reported alongside without gating";

  return {
    spec: SHADOW_MILESTONE_VERDICT_SPEC,
    status,
    summary,
    incomplete,
    failures,
    observations,
    inputs: {
      baseline: {
        path: inputPaths.baseline,
        schemaVersion: baseline?.schemaVersion,
        capturedAt: baseline?.capturedAt,
        provingHost: baseline?.provingHost,
        operatorInterventionRubricSha256: baseline?.operatorInterventionRubric?.sha256,
        deliveryIds: baselineDeliveries.map((delivery) => String(delivery?.id ?? "<unnamed>")),
      },
      gateRecord: {
        path: inputPaths.gateRecord,
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
    interventionReporting: INTERVENTION_REPORTING,
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

export function readVerdictInputs(
  repoRoot: string,
  inputPaths?: ShadowMilestoneInputPaths,
): { baseline: any; gateRecord: any } {
  const paths =
    inputPaths ??
    ({
      baseline: path.join(repoRoot, BASELINE_PATH),
      gateRecord: path.join(repoRoot, GATE_RECORD_PATH),
    } satisfies ShadowMilestoneInputPaths);
  const read = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
  return { baseline: read(paths.baseline), gateRecord: read(paths.gateRecord) };
}

type ScorerArguments = {
  readonly explicitPaths: ShadowMilestoneFilePaths | null;
  readonly write: boolean;
};

function parseScorerArguments(args: readonly string[], cwd: string): ScorerArguments | undefined {
  const flags = ["--baseline", "--gate-record", "--verdict"] as const;
  const values = new Map<(typeof flags)[number], string>();
  let write = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--write") {
      if (write) return undefined;
      write = true;
      continue;
    }
    if (!flags.includes(argument as (typeof flags)[number])) return undefined;
    const flag = argument as (typeof flags)[number];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-") || values.has(flag)) return undefined;
    values.set(flag, path.resolve(cwd, value));
    index += 1;
  }

  if (values.size === 0) return { explicitPaths: null, write };
  if (values.size !== flags.length) return undefined;
  return {
    explicitPaths: {
      baseline: values.get("--baseline")!,
      gateRecord: values.get("--gate-record")!,
      verdict: values.get("--verdict")!,
    },
    write,
  };
}

const isMissingPath = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

function canonicalPath(file: string): string {
  try {
    return realpathSync(file);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return path.join(realpathSync(path.dirname(file)), path.basename(file));
  }
}

function existingFileIdentity(file: string): { readonly device: number; readonly inode: number } | undefined {
  try {
    const stats = statSync(file);
    return { device: stats.dev, inode: stats.ino };
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return undefined;
  }
}

function verdictInputAlias(paths: ShadowMilestoneFilePaths): "--baseline" | "--gate-record" | undefined {
  const verdictCanonical = canonicalPath(paths.verdict);
  const verdictIdentity = existingFileIdentity(paths.verdict);
  for (const [flag, input] of [
    ["--baseline", paths.baseline],
    ["--gate-record", paths.gateRecord],
  ] as const) {
    const sameCanonicalPath = verdictCanonical === canonicalPath(input);
    const inputIdentity = existingFileIdentity(input);
    const sameExistingFile =
      verdictIdentity !== undefined &&
      inputIdentity !== undefined &&
      verdictIdentity.device === inputIdentity.device &&
      verdictIdentity.inode === inputIdentity.inode;
    if (sameCanonicalPath || sameExistingFile) return flag;
  }
  return undefined;
}

function main(): void {
  const repoRoot = repoRootFromHere();
  const parsed = parseScorerArguments(process.argv.slice(2), process.cwd());
  if (parsed === undefined) {
    process.stderr.write(`${SCORER_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const { explicitPaths, write } = parsed;
  if (explicitPaths !== null) {
    const alias = verdictInputAlias(explicitPaths);
    if (alias !== undefined) {
      process.stderr.write(`score-shadow-milestone: --verdict path aliases the ${alias} input\n${SCORER_USAGE}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const { baseline, gateRecord } = readVerdictInputs(repoRoot, explicitPaths ?? undefined);
  const verdict = scoreShadowMilestone(
    baseline,
    gateRecord,
    explicitPaths ?? REPOSITORY_LOCAL_INPUT_PATHS,
  );
  const verdictPath = explicitPaths?.verdict ?? path.join(repoRoot, VERDICT_PATH);
  if (write) writeFileSync(verdictPath, renderVerdict(verdict));

  process.stdout.write(`score-shadow-milestone: ${verdict.status} — ${verdict.summary}\n`);
  for (const note of verdict.incomplete) process.stdout.write(`  incomplete ${note.code}\n      ${note.message}\n`);
  for (const note of verdict.failures) process.stdout.write(`  unmet ${note.code}\n      ${note.message}\n`);
  for (const note of verdict.observations) process.stdout.write(`  observation ${note.code}\n      ${note.message}\n`);
  if (write) process.stdout.write(`  wrote ${explicitPaths?.verdict ?? VERDICT_PATH}\n`);
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
