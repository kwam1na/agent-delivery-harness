/**
 * The cycle-time half of the shared run projection.
 *
 * These are unit tests over event arrays rather than CLI drives, because the
 * property under test is arithmetic over instants and the scenarios that matter
 * — a journal whose phases must still tile its span when two writers' clocks
 * disagree, a gate that was never journaled — are hours long or cannot be
 * produced by a real loop at all. The CLI surfaces that print these figures are
 * driven end to end in `runs-cycle-time.test.ts`.
 *
 * THE TILING IS THE POINT. Every scenario here asserts the three phases sum to
 * the run's own `durationSeconds` within per-phase rounding, because a
 * breakdown that does not add up is worse than no breakdown: an operator
 * comparing "review took 6 h" against a 4 h total has been told two things and
 * can act on neither.
 */
import { describe, expect, it } from "vitest";
import type { RunEvent } from "@agent-delivery-harness/kernel";
import { durationLabel, phaseRows, projectGateTime, projectRunPhases, summarize } from "./run-projection.ts";

const RUN_ID = "run-0000000000000001";
const TREE_SHA = "a".repeat(40);

/** One well-formed v2 event; only the members these projections read vary. */
function event(
  seq: number,
  at: string,
  kind: string,
  payload: Record<string, unknown> = {},
  role: "cli" | "executor" = "executor",
): RunEvent {
  return {
    version: "run-event/2",
    runId: RUN_ID,
    at,
    repo: { commonDir: "/tmp/.git" },
    kind: kind as RunEvent["kind"],
    actor: { role },
    attestation: "self",
    payload,
    seq,
  };
}

/** `2026-09-15T<hh>:<mm>:<ss>Z`, so a scenario reads as a clock. */
const at = (hour: number, minute = 0, second = 0): string =>
  `2026-09-15T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;

/** An ended delivery: two hours of implementation, three of review, one of tail. */
function endedDelivery(): readonly RunEvent[] {
  return [
    event(1, at(9), "run.started", { host: "vitest", workflow: { releaseId: "r", profile: "linear" } }),
    event(2, at(9, 30), "posture.declared", { posture: "test-first" }),
    event(3, at(11), "review.round.opened", { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }),
    event(4, at(12), "review.round.closed", { round: 1, candidateTreeSha: TREE_SHA, outcome: "changes-requested" }),
    event(5, at(13), "review.round.opened", { round: 2, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }),
    event(6, at(14), "review.round.closed", { round: 2, candidateTreeSha: TREE_SHA, outcome: "aligned" }),
    event(7, at(14, 30), "command.completed", { command: "gate", outcome: "admitted", durationMs: 600_000 }, "cli"),
    event(8, at(15), "run.ended", { result: "complete" }),
  ];
}

const tiles = (events: readonly RunEvent[]): void => {
  const summary = summarize(events);
  const { implementationSeconds, reviewSeconds, tailSeconds } = summary.phases;
  expect(Math.abs(implementationSeconds + reviewSeconds + tailSeconds - summary.durationSeconds)).toBeLessThanOrEqual(3);
};

describe("durationLabel", () => {
  it("reads as a clock at every magnitude, padding the smaller unit", () => {
    expect(durationLabel(0)).toBe("0s");
    expect(durationLabel(45)).toBe("45s");
    expect(durationLabel(723)).toBe("12m 03s");
    expect(durationLabel(3600)).toBe("1h 00m");
    expect(durationLabel(18_420)).toBe("5h 07m");
    // Hours are never folded into days: a journal spans hours, and a delivery
    // that ran across a weekend reads as the hours it took.
    expect(durationLabel(374_580)).toBe("104h 03m");
  });

  it("reports an impossible span as no time rather than as a negative one", () => {
    expect(durationLabel(-10)).toBe("0s");
    expect(durationLabel(Number.NaN)).toBe("0s");
  });
});

describe("projectRunPhases", () => {
  it("divides an ended delivery into implementation, review, and tail", () => {
    const phases = projectRunPhases(endedDelivery());
    expect(phases.implementationSeconds).toBe(2 * 3600);
    // Review runs from the FIRST round event to the LAST close, so the hour
    // between round 1 closing and round 2 opening — the fix — is review time.
    expect(phases.reviewSeconds).toBe(3 * 3600);
    expect(phases.tailSeconds).toBe(3600);
    expect(phases.rounds).toBe(2);
    tiles(endedDelivery());
  });

  it("times an open run to its last event and says the run is open", () => {
    const events = endedDelivery().slice(0, 7);
    const summary = summarize(events);
    expect(summary.open).toBe(true);
    expect(summary.durationSeconds).toBe(5.5 * 3600);
    expect(summary.phases.tailSeconds).toBe(1800);
    tiles(events);
    expect(phaseRows(events).at(-1)).toContain("(open; the tail is still accruing)");
  });

  it("gives a run with no rounds the whole span as implementation", () => {
    const events = [
      event(1, at(9), "run.started", { host: "vitest", workflow: { releaseId: "r", profile: "linear" } }),
      event(2, at(9, 40), "blocker.recorded", { code: "review.loop-bound-reached", summary: "no rounds" }),
      event(3, at(10), "run.ended", { result: "blocked" }),
    ];
    const phases = projectRunPhases(events);
    expect(phases).toMatchObject({ implementationSeconds: 3600, reviewSeconds: 0, tailSeconds: 0, rounds: 0 });
    tiles(events);
  });

  it("leaves no tail while a round is still open", () => {
    const events = [
      event(1, at(9), "run.started", { host: "vitest", workflow: { releaseId: "r", profile: "linear" } }),
      event(2, at(10), "review.round.opened", { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }),
      event(3, at(12), "decision.recorded", { fork: "branch name", choice: "the Linear branch" }),
    ];
    const phases = projectRunPhases(events);
    expect(phases).toMatchObject({ implementationSeconds: 3600, reviewSeconds: 2 * 3600, tailSeconds: 0, rounds: 1 });
    tiles(events);
  });

  it("still tiles the span when two writers' clocks disagree", () => {
    // The round opens BEFORE the run starts by this journal's own instants,
    // which is a clock skew rather than a time machine. The phases hold inside
    // the span instead of reporting a negative one and silently losing an hour.
    const events = [
      event(1, at(10), "run.started", { host: "vitest", workflow: { releaseId: "r", profile: "linear" } }),
      event(2, at(9), "review.round.opened", { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }),
      event(3, at(11), "review.round.closed", { round: 1, candidateTreeSha: TREE_SHA, outcome: "aligned" }),
      event(4, at(12), "run.ended", { result: "complete" }),
    ];
    const phases = projectRunPhases(events);
    expect(phases.implementationSeconds).toBe(0);
    expect(phases.reviewSeconds).toBe(3600);
    expect(phases.tailSeconds).toBe(3600);
    tiles(events);
  });

  it("still tiles when a round closes AFTER the journal's last instant", () => {
    // The other direction of the same skew, and the one the low clamp cannot
    // catch: by this journal's own instants the round closed two hours after
    // the run ended. Without the high clamp on the review end, review runs to
    // 14:00 and the three phases sum to five hours of a three-hour run.
    const events = [
      event(1, at(9), "run.started", { host: "vitest", workflow: { releaseId: "r", profile: "linear" } }),
      event(2, at(10), "review.round.opened", { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }),
      event(3, at(14), "review.round.closed", { round: 1, candidateTreeSha: TREE_SHA, outcome: "aligned" }),
      event(4, at(12), "run.ended", { result: "complete" }),
    ];
    const phases = projectRunPhases(events);
    expect(phases.implementationSeconds).toBe(3600);
    expect(phases.reviewSeconds).toBe(2 * 3600);
    expect(phases.tailSeconds).toBe(0);
    tiles(events);
  });

  it("still tiles when a round closes BEFORE the round that opened it", () => {
    // The review end is held at the review START, not at the run's start: a
    // close skewed behind its own open leaves an empty review phase and a tail
    // measured from the open, rather than a tail that double-counts the hour
    // before it.
    const events = [
      event(1, at(9), "run.started", { host: "vitest", workflow: { releaseId: "r", profile: "linear" } }),
      event(2, at(11), "review.round.opened", { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }),
      event(3, at(10), "review.round.closed", { round: 1, candidateTreeSha: TREE_SHA, outcome: "aligned" }),
      event(4, at(12), "run.ended", { result: "complete" }),
    ];
    const phases = projectRunPhases(events);
    expect(phases.implementationSeconds).toBe(2 * 3600);
    expect(phases.reviewSeconds).toBe(0);
    expect(phases.tailSeconds).toBe(3600);
    tiles(events);
  });

  it("reports an empty journal as no time at all", () => {
    expect(projectRunPhases([])).toMatchObject({ implementationSeconds: 0, reviewSeconds: 0, tailSeconds: 0, rounds: 0 });
  });
});

describe("projectGateTime", () => {
  it("sums every journaled gate, the CLI's and the executor's alike", () => {
    const events = [
      ...endedDelivery().slice(0, 7),
      event(8, at(14, 40), "gate.reported", { command: "npm run check", outcome: "pass", durationMs: 90_000 }),
      event(9, at(15), "run.ended", { result: "complete" }),
    ];
    // Two different gates, not two accounts of one: a product gate the CLI
    // completed and a repository gate the executor ran.
    expect(projectGateTime(events)).toEqual({ totalMs: 690_000, counted: 2, unreadable: 0, unseen: false });
  });

  it("sums a superseded gate too, because a delivery that gated twice spent both", () => {
    const events = [
      event(1, at(9), "run.started", { host: "vitest", workflow: { releaseId: "r", profile: "linear" } }),
      event(2, at(10), "command.completed", { command: "gate", outcome: "refused", durationMs: 120_000 }, "cli"),
      event(3, at(11), "command.completed", { command: "gate", outcome: "admitted", durationMs: 180_000 }, "cli"),
    ];
    expect(projectGateTime(events)).toMatchObject({ totalMs: 300_000, counted: 2 });
  });

  it("flags a journal with no gate completion as unseen rather than as free", () => {
    const events = endedDelivery().filter((entry) => entry.kind !== "command.completed");
    expect(projectGateTime(events)).toEqual({ totalMs: 0, counted: 0, unreadable: 0, unseen: true });
    expect(phaseRows(events).join("\n")).toContain("unseen — no gate completion is journaled");
  });

  it("counts a gate that journaled no readable duration as under-reported", () => {
    const events = [
      event(1, at(9), "run.started", { host: "vitest", workflow: { releaseId: "r", profile: "linear" } }),
      event(2, at(10), "gate.reported", { command: "npm run check", outcome: "pass" }),
    ];
    expect(projectGateTime(events)).toEqual({ totalMs: 0, counted: 1, unreadable: 1, unseen: false });
    expect(phaseRows(events).join("\n")).toContain("so the sum under-reports");
  });

  it("ignores a completion for some other command, and an executor's claim about the gate command", () => {
    const events = [
      event(1, at(9), "run.started", { host: "vitest", workflow: { releaseId: "r", profile: "linear" } }),
      event(2, at(10), "command.completed", { command: "prepare", outcome: "ok", durationMs: 900_000 }, "cli"),
      // Only the CLI writes a `command.completed`. One claiming to be the
      // product's gate from an executor is not the product's account of it.
      event(3, at(11), "command.completed", { command: "gate", outcome: "admitted", durationMs: 900_000 }),
    ];
    expect(projectGateTime(events)).toMatchObject({ totalMs: 0, counted: 0, unseen: true });
  });
});

describe("the phase rows", () => {
  it("name every phase, the round count, and the total the phases divide", () => {
    const rows = phaseRows(endedDelivery()).join("\n");
    expect(rows).toContain("implementation  2h 00m");
    expect(rows).toContain("review          3h 00m  over 2 round(s)");
    expect(rows).toContain("tail            1h 00m");
    expect(rows).toContain("gate time       10m 00s summed over 1 journaled gate completion(s)");
    expect(rows).toContain("total           6h 00m");
  });
});
