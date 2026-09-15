/**
 * The run-journal completeness evaluator: the closed identifier sets first,
 * then one vector per entry of each.
 *
 * Written RED before `run-journal-completeness.ts` existed.
 *
 * WHY THE CONSTANTS ARE ASSERTED AS LITERAL LISTS. Both sets are the product's
 * own vocabulary, enumerated by the plan's Completeness paragraph. Asserting
 * them as literal lists compared by exact equality in a fixed order is what
 * makes adding, removing, or renaming an entry a visible edit HERE as well as
 * in the plan — and the per-entry coverage below is what makes an entry no
 * journal can provoke in isolation fail rather than quietly rot.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RUN_JOURNAL_REQUIRED_ENTRIES,
  RUN_JOURNAL_VIOLATIONS,
  evaluateRunJournal,
  explainRunJournal,
  type RunJournalRequiredEntry,
  type RunJournalViolation,
} from "./run-journal-completeness.ts";
import {
  RUN_COMMAND_OUTCOMES,
  RUN_GATE_REPORTED_OUTCOMES,
  runPrimaryTicket,
  validateRunEvent,
  type RunEvent,
  type RunEventKind,
} from "./run-event.ts";

const TREE = "a".repeat(40);
const OTHER_TREE = "b".repeat(40);
const MANDATED = ["lens.outcome-correctness", "lens.adversarial-testing"];
const COST = { unit: "usd", total: 1, reportedBy: "claude-code" };

interface Step {
  readonly kind: RunEventKind;
  readonly payload: Record<string, unknown>;
  readonly cli?: true;
  readonly version?: "run-event/2";
}

const journal = (steps: readonly Step[]): readonly RunEvent[] => {
  const version = steps.some(step => step.version === "run-event/2") ? "run-event/2" : "run-event/1";
  return steps.map((step, index) => {
    const payload = version === "run-event/2" && (step.kind === "review.round.opened" || step.kind === "review.round.closed")
      ? { roundId: `round-${step.payload["round"]}`, ...step.payload } : step.payload;
    const mirrored: Record<string, unknown> = {};
    if (typeof payload["ticket"] === "string") mirrored["ticket"] = payload["ticket"];
    if (typeof payload["candidateTreeSha"] === "string") mirrored["candidateTreeSha"] = payload["candidateTreeSha"];
    return {
      version,
      runId: "run-0001",
      seq: index + 1,
      at: "2026-09-02T10:00:00Z",
      repo: { commonDir: "/tmp/repo/.git" },
      kind: step.kind,
      actor: { role: step.cli === true ? "cli" : "executor" },
      ...mirrored,
      attestation: "self",
      payload,
    } as RunEvent;
  });
};

const started: Step = {
  kind: "run.started",
  payload: { ticket: "V26-1548", host: "claude-code", workflow: { releaseId: "r1", profile: "linear" } },
};
const ticketRead: Step = { kind: "ticket.read", payload: { ticket: "V26-1548", tracker: "linear" } };
const posture: Step = { kind: "posture.declared", payload: { posture: "test-first" } };
const lenses = (mandated: readonly string[] = MANDATED): Step => ({
  kind: "lens.selected",
  payload: { mandated: [...mandated], selected: [...mandated], rationale: "the mandated pair" },
});
const opened = (round: number, tree = TREE): Step => ({
  kind: "review.round.opened",
  payload: { round, candidateTreeSha: tree, lenses: MANDATED },
});
const closed = (round: number, tree = TREE): Step => ({
  kind: "review.round.closed",
  payload: { round, candidateTreeSha: tree, outcome: "converged", findings: { P0: 0, P1: 0, P2: 0, P3: 0 }, cost: COST },
});
const completed = (command: string): Step => ({
  kind: "command.completed",
  payload: { command, outcome: "ok", durationMs: 10 },
  cli: true,
});
const gateReported: Step = { kind: "gate.reported", payload: { command: "pr:athena", outcome: "pass", durationMs: 10 } };
const prOpened: Step = {
  kind: "pr.opened",
  payload: { url: "https://github.com/owner/repo/pull/75", candidateTreeSha: TREE },
};
const ended: Step = { kind: "run.ended", payload: { result: "complete", cost: COST } };

/** The journal the complete rule describes, in the D12 order. */
const COMPLETE: readonly Step[] = [
  started,
  ticketRead,
  posture,
  lenses(),
  opened(1),
  closed(1),
  completed("gate"),
  completed("record"),
  prOpened,
  ended,
];

/** The same run in an adopter that runs no product command. */
const EXECUTOR_ONLY: readonly Step[] = [
  started,
  ticketRead,
  posture,
  lenses(),
  opened(1),
  closed(1),
  gateReported,
  prOpened,
  ended,
];

const without = (steps: readonly Step[], predicate: (step: Step) => boolean): readonly Step[] => steps.filter((step) => !predicate(step));

const isCompletion = (command: string) => (step: Step) =>
  step.kind === "command.completed" && step.payload["command"] === command;

const v2Round = (step: Step, roundId: string, reopensRoundId?: string): Step => ({
  ...step,
  version: "run-event/2",
  payload: { ...step.payload, roundId, ...(reopensRoundId === undefined ? {} : { reopensRoundId }) },
});

describe("retry and base-move replay completeness", () => {
  const retry: Step = { ...started, version: "run-event/2", payload: { ...started.payload, predecessorRunId: "run-previous" } };

  it.each([[1, 2], [2, 1]])("requires matching counted numbers for the same v2 round id (%i to %i)", (opening, closing) => {
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(opening), "same-round-id"), v2Round(closed(closing), "same-round-id"),
      completed("gate"), completed("record"), prOpened, ended,
    ]).map((entry, index) => ({ ...entry, eventId: `number-consistency-${index}` }));
    for (const entry of events) expect(validateRunEvent(entry)).toEqual({ ok: true });
    const result = evaluateRunJournal(events, TREE, MANDATED);
    expect(result.status).toBe("incomplete");
    expect(result.missing).toContain("review.round.closed");
    expect(result.violations).toContain("gate-before-closed-round");

    const matched = events.map(entry => entry.kind === "review.round.closed"
      ? { ...entry, payload: { ...entry.payload, round: opening } } : entry);
    expect(evaluateRunJournal(matched, TREE, MANDATED).status).toBe("complete");
  });

  it("retains an existing PR on a linked retry without requiring its opening after this attempt's gate", () => {
    const steps = [retry, ticketRead, posture, lenses(), prOpened, opened(1), closed(1), completed("gate"), completed("record"), ended];
    expect(evaluateRunJournal(journal(steps), TREE, MANDATED).status).toBe("complete");
    expect(evaluateRunJournal(journal([started, ...steps.slice(1)]), TREE, MANDATED).violations).toEqual(["pr-before-gate"]);
    expect(evaluateRunJournal(journal(without(steps, step => step.kind === "pr.opened")), TREE, MANDATED).missing).toContain("pr.opened");
  });

  it("applies the retry exemption to executor-only PR chronology, retaining gate ordering", () => {
    const steps = [retry, ticketRead, posture, lenses(), prOpened, opened(1), closed(1), gateReported, ended];
    expect(evaluateRunJournal(journal(steps), TREE, MANDATED).status).toBe("complete-executor-only");
    expect(evaluateRunJournal(journal([started, ...steps.slice(1)]), TREE, MANDATED).violations).toEqual(["pr-before-gate-reported"]);
  });

  it("pairs a v2 reopened round by roundId and judges the final gate on its refreshed candidate", () => {
    const replay = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1, OTHER_TREE), "round-original"), v2Round(closed(1, OTHER_TREE), "round-original"),
      completed("gate"), completed("record"), prOpened,
      completed("gate"),
      v2Round(opened(1), "round-replay", "round-original"), v2Round(closed(1), "round-replay"),
      completed("gate"), completed("record"), ended,
    ]);
    expect(evaluateRunJournal(replay, TREE, MANDATED)).toEqual({ status: "complete", missing: [], violations: [], boundToRecord: true });
    expect(replay.filter(event => event.kind === "review.round.closed")).toHaveLength(2);
  });

  it("does not let a historical matching round hide a final round closed after the governing gate", () => {
    const events = journal([started, ticketRead, posture, lenses(), opened(1), closed(1), completed("gate"), prOpened,
      opened(2), completed("gate"), closed(2), completed("record"), ended]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["gate-before-closed-round"]);
  });

  it("does not let a historical matching candidate hide a final round bound to a different tree", () => {
    const events = journal([started, ticketRead, posture, lenses(), opened(1), closed(1), completed("gate"), prOpened,
      opened(2, OTHER_TREE), closed(2, OTHER_TREE), completed("gate"), completed("record"), ended]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toContain("round-not-bound-to-record");
    expect(evaluateRunJournal(events, TREE, MANDATED).status).toBe("incomplete");
  });

  it("does not borrow an earlier close for an unfinished current v2 round with the same number", () => {
    const events = journal([started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-original"), v2Round(closed(1), "round-original"), completed("gate"), prOpened,
      v2Round(opened(1), "round-replay", "round-original"), completed("gate"), completed("record"), ended]);
    expect(evaluateRunJournal(events, TREE, MANDATED).missing).toContain("review.round.closed");
    expect(evaluateRunJournal(events, TREE, MANDATED).status).toBe("incomplete");
  });

  it("does not pair different v2 round ids that happen to share a round number", () => {
    const events = journal([started, ticketRead, posture, lenses(), v2Round(opened(1), "round-open"),
      v2Round(closed(1), "round-other"), completed("gate"), completed("record"), prOpened, ended]);
    expect(evaluateRunJournal(events, TREE, MANDATED).missing).toContain("review.round.closed");
  });

  it("does not borrow a historical opening for a later unmatched close", () => {
    const events = journal([started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-original"), v2Round(closed(1), "round-original"), completed("gate"), prOpened,
      v2Round(closed(1), "round-unopened"), completed("gate"), completed("record"), ended]);
    expect(evaluateRunJournal(events, TREE, MANDATED).missing).toContain("review.round.closed");
    expect(evaluateRunJournal(events, TREE, MANDATED).status).toBe("incomplete");
  });

  it("uses the final executor gate and current round while keeping the opening PR gate", () => {
    const events = journal([started, ticketRead, posture, lenses(), opened(1, OTHER_TREE), closed(1, OTHER_TREE),
      gateReported, prOpened, gateReported, opened(2), closed(2), gateReported, ended]);
    expect(evaluateRunJournal(events, TREE, MANDATED).status).toBe("complete-executor-only");
    const lateClose = journal([started, ticketRead, posture, lenses(), opened(1), closed(1), gateReported, prOpened,
      opened(2), gateReported, closed(2), ended]);
    expect(evaluateRunJournal(lateClose, TREE, MANDATED).violations).toEqual(["gate-reported-before-closed-round"]);
  });
});

/**
 * The two real journals, as committed vectors. The file is derived from the run
 * store rather than hand-authored; its own `purpose` states the reduction and
 * the drift repair.
 */
interface JournalVector {
  readonly ticket: string;
  readonly runId: string;
  readonly recordTreeSha: string;
  readonly reviewedTreeShas: readonly string[];
  readonly mandatedLensIds: readonly string[];
  readonly expect: Readonly<Record<string, unknown>>;
  readonly events: readonly unknown[];
}

const RUN_JOURNAL_VECTORS = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "vectors", "run-journals.json"), "utf8"),
) as { readonly journals: readonly JournalVector[] };

/**
 * V26-2075. Written RED against the two defects two REAL deliveries in this
 * repository's own run store exhibited, and the shapes below are theirs rather
 * than invented: `run-752c1ec0d1804258` (V26-1504) reopened `round-6` under its
 * own id and then re-gated to a refusal after it had already been admitted, and
 * `run-d6dd99f9034d9012` (V26-1485) reopened four rounds under fresh ids. The
 * journals themselves are pinned as vectors further down; these rows isolate
 * one rule each so a failure names the rule rather than the journal.
 */
describe("reopened rounds and the admitting completion", () => {
  const refused = (command: string): Step => ({
    kind: "command.completed",
    payload: { command, outcome: "policy", durationMs: 10 },
    cli: true,
  });
  const gateFailed: Step = { kind: "gate.reported", payload: { command: "npm run check", outcome: "fail", durationMs: 10 } };

  it("accepts a reopen carried under a new roundId and folds the chain into one logical round", () => {
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1, OTHER_TREE), "round-1"), v2Round(closed(1, OTHER_TREE), "round-1"),
      v2Round(opened(1), "round-1-replay", "round-1"), v2Round(closed(1), "round-1-replay"),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    for (const entry of events.map((e, i) => ({ ...e, eventId: `reopen-${i}` }))) {
      expect(validateRunEvent(entry)).toEqual({ ok: true });
    }
    expect(evaluateRunJournal(events, TREE, MANDATED)).toEqual({
      status: "complete", missing: [], violations: [], boundToRecord: true,
    });
    // Two openings, one logical round: the bound counts what was reviewed, not
    // how many times a replayed candidate was re-announced.
    expect(events.filter((event) => event.kind === "review.round.opened")).toHaveLength(2);
    expect(explainRunJournal(events, TREE, MANDATED).logicalRounds).toBe(1);
  });

  it("counts an unreopened later round as its own logical round", () => {
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1, OTHER_TREE), "round-1"), v2Round(closed(1, OTHER_TREE), "round-1"),
      v2Round(opened(2), "round-2"), v2Round(closed(2), "round-2"),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(explainRunJournal(events, TREE, MANDATED).logicalRounds).toBe(2);
  });

  it("reports a same-id reopen as one named violation rather than two misleading ones", () => {
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1, OTHER_TREE), "round-1"), v2Round(closed(1, OTHER_TREE), "round-1"),
      v2Round(opened(1), "round-1", "round-1"), v2Round(closed(1), "round-1"),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    const result = evaluateRunJournal(events, TREE, MANDATED);
    // The whole point: the pairing resolves, so the two consequences the wave
    // saw — a gate with no closed round, and a round bound to no record — are
    // gone, and what is left is the one thing that is actually wrong.
    expect(result.violations).toEqual(["round-reopened-under-same-id"]);
    expect(result.status).toBe("incomplete");
    const explanation = explainRunJournal(events, TREE, MANDATED).explanations[0];
    // The message names the fix, not merely the fault.
    expect(explanation?.because).toContain("reopen it under a new roundId");
    expect(explanation?.because).toContain("reopensRoundId");
    expect(explainRunJournal(events, TREE, MANDATED).logicalRounds).toBe(1);
  });

  it("reports a version-1 reopen, which cannot carry reopensRoundId, as the same one violation", () => {
    // `verify --require-run-journal` on such a run reported `gate-before-closed-round`
    // and `round-not-bound-to-record` and could never be cleared; now it reports
    // the reopen itself, and clearing it means moving the run to version 2.
    const events = journal([
      started, ticketRead, posture, lenses(),
      opened(1, OTHER_TREE), closed(1, OTHER_TREE), opened(1), closed(1),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["round-reopened-under-same-id"]);
  });

  it("does not let a refused gate after an admitting one become the governing gate", () => {
    const steps: readonly Step[] = [
      started, ticketRead, posture, lenses(), opened(1), closed(1),
      completed("gate"), completed("record"), prOpened, refused("gate"), ended,
    ];
    const events = journal(steps);
    // Before this delivery the LAST completion governed whatever it decided, so
    // the record written at index 7 preceded a "governing" gate at index 9 and
    // the journal reported `record-before-gate` for a delivery that had gated,
    // recorded and only then re-run a gate that refused.
    expect(evaluateRunJournal(events, TREE, MANDATED)).toEqual({
      status: "complete", missing: [], violations: [], boundToRecord: true,
    });
    const diagnostics = explainRunJournal(events, TREE, MANDATED);
    expect(diagnostics.supersededGates).toEqual([10]);
  });

  it("takes the admitting gate that follows a refused one, and reports nothing superseded", () => {
    const events = journal([
      started, ticketRead, posture, lenses(), opened(1), closed(1),
      refused("gate"), completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual([]);
    expect(explainRunJournal(events, TREE, MANDATED).supersededGates).toBeUndefined();
  });

  it("keeps the last refused gate governing when no gate ever admitted", () => {
    // Nothing admitted, so there is no admitting completion to prefer and the
    // last one still governs: the ordering rules must not go quiet on a
    // delivery that never got past its gate.
    const events = journal([
      started, ticketRead, posture, lenses(), opened(1), refused("gate"), closed(1),
      completed("record"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toContain("gate-before-closed-round");
  });

  it("prefers the last passing gate.reported in an executor-only journal", () => {
    const events = journal([
      started, ticketRead, posture, lenses(), opened(1), closed(1),
      gateReported, prOpened, gateFailed, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).status).toBe("complete-executor-only");
    const lateClose = journal([
      started, ticketRead, posture, lenses(), opened(1), gateReported, closed(1), gateFailed, prOpened, ended,
    ]);
    expect(evaluateRunJournal(lateClose, TREE, MANDATED).violations).toEqual(["gate-reported-before-closed-round"]);
  });

  it("lets an earlier close of the SAME chain support the gate a replayed round followed", () => {
    // The V26-1504 shape exactly: the candidate is gated and recorded, the
    // round is then replayed on the same tree after the base moved, and the
    // replay closes after the governing gate. One logical round was reviewed
    // before that gate, so nothing is out of order.
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"),
      completed("gate"), completed("record"),
      v2Round(opened(1), "round-1-replay", "round-1"), v2Round(closed(1), "round-1-replay"),
      prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual([]);
  });

  it("still refuses a FRESH round closed after the governing gate", () => {
    // The guard on the row above: only a reopen of the chain the gate stood on
    // may close after it. A new round is new review, and a gate that precedes
    // it did not stand on it.
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"),
      completed("gate"), completed("record"),
      v2Round(opened(2), "round-2"), v2Round(closed(2), "round-2"),
      prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["gate-before-closed-round"]);
  });

  // ── The refusal outcomes, driven off the closed vocabularies ─────────────
  //
  // `admitting` selects on ONE member of each vocabulary, so a row that names
  // only `policy` (or only `fail`) proves the rule for a quarter of the set and
  // leaves a narrowing — admit everything except `policy` — green. These two
  // blocks are generated from the exported constants, so a new outcome member
  // forces a case here rather than inheriting a proof it never got.

  const completedWith = (command: string, outcome: string): Step => ({
    kind: "command.completed",
    payload: { command, outcome, durationMs: 10 },
    cli: true,
  });
  const reportedWith = (outcome: string): Step => ({
    kind: "gate.reported",
    payload: { command: "npm run check", outcome, durationMs: 10 },
  });
  const REFUSED_COMMAND_OUTCOMES = RUN_COMMAND_OUTCOMES.filter((outcome) => outcome !== "ok");
  const REFUSED_REPORTED_OUTCOMES = RUN_GATE_REPORTED_OUTCOMES.filter((outcome) => outcome !== "pass");

  it.each(REFUSED_COMMAND_OUTCOMES)("does not let a %s gate after an admitting one govern", (outcome) => {
    const events = journal([
      started, ticketRead, posture, lenses(), opened(1), closed(1),
      completed("gate"), completed("record"), prOpened, completedWith("gate", outcome), ended,
    ]);
    // A gate run that was refused, that ran out of budget, or that DIED is an
    // attempt in all three cases. Reading any of them as the gate the delivery
    // stood on reinstates `record-before-gate` against a delivery that gated,
    // recorded, and only then re-ran.
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual([]);
    expect(explainRunJournal(events, TREE, MANDATED).supersededGates).toEqual([10]);
  });

  it.each(REFUSED_COMMAND_OUTCOMES)("does not let a %s record after an admitting one govern", (outcome) => {
    // The record half of the same rule, which the real journals cannot
    // discriminate: in `run-752c1ec0d1804258` the refused record falls after
    // the governing gate under either reading. Here it is the only thing that
    // decides whether a genuine `record-before-gate` is reported or silenced.
    const events = journal([
      started, ticketRead, posture, lenses(), opened(1), closed(1),
      completed("record"), completed("gate"), prOpened, completedWith("record", outcome), ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["record-before-gate"]);
  });

  it.each(REFUSED_REPORTED_OUTCOMES)("does not let a %s gate.reported after a passing one govern", (outcome) => {
    const events = journal([
      started, ticketRead, posture, lenses(), opened(1), gateReported, closed(1), reportedWith(outcome), prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["gate-reported-before-closed-round"]);
  });

  it("names a v2 opening that reopens ITSELF, with no earlier close of that key", () => {
    // The arm `selfReopening` exists for, and the only same-id shape a
    // well-formed version-2 journal produces on its own: one opening, one
    // close, and a `reopensRoundId` pointing at the opening's own `roundId`.
    // Every other same-id row reaches the violation through an earlier
    // announcement instead, so without this row the disjunct is deletable.
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1", "round-1"), v2Round(closed(1), "round-1"),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["round-reopened-under-same-id"]);
    const explanation = explainRunJournal(events, TREE, MANDATED).explanations[0];
    expect(explanation?.because).toContain("it names as itself in reopensRoundId");
    expect(explanation?.because).toContain("reopen it under a new roundId");
  });

  it("names a round key announced twice with no close between the announcements", () => {
    // The boundary the prior-close arm leaves open. Two openings under one key
    // are indistinguishable to every reader whether or not a close sits between
    // them, so this is the same fault and says which announcement it means.
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1"), v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["round-reopened-under-same-id"]);
    expect(explainRunJournal(events, TREE, MANDATED).explanations[0]?.because).toContain("was already announced at seq 5");
  });

  it("pairs the latest opening with the FIRST close that follows it, not the last", () => {
    // Two closes after one opening — one announcement, two claims to have
    // finished it. The pair is built from the FIRST close, so the second is an
    // unmatched later close and, by the rule `governingRound` already states,
    // contributes no governing round: the journal is incomplete rather than
    // silently read from whichever close came last. Pairing from the last close
    // instead would read this as a finished round and hide the second claim
    // entirely.
    const events = journal([
      started, ticketRead, posture, lenses(),
      opened(1), closed(1), closed(1),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    const result = evaluateRunJournal(events, TREE, MANDATED);
    expect(result.missing).toContain("review.round.closed");
    expect(result.violations).toContain("gate-before-closed-round");
    expect(result.status).toBe("incomplete");
  });

  it("counts logical rounds over OPENINGS, so a round still open is still a round", () => {
    // The count a bound is read against is how many rounds were entered, not
    // how many finished: counting closes instead would let an unfinished round
    // spend nothing and the reading differs exactly here.
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"),
      completed("gate"), completed("record"), prOpened, v2Round(opened(2), "round-2"), ended,
    ]);
    expect(explainRunJournal(events, TREE, MANDATED).logicalRounds).toBe(2);
  });

  it("gives a round whose reopensRoundId names no opening in this journal its own chain", () => {
    // Reachable on a linked retry, whose predecessor round lives in the
    // previous run's journal. Joining such rounds to a phantom root would merge
    // two unrelated rounds and undercount the bound.
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1", "round-elsewhere"), v2Round(closed(1), "round-1"),
      v2Round(opened(2), "round-2", "round-elsewhere"), v2Round(closed(2), "round-2"),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(explainRunJournal(events, TREE, MANDATED).logicalRounds).toBe(2);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual([]);
  });

  it("lets an earlier close of the same chain support a REPORTED gate, and still refuses a fresh round", () => {
    // The executor-only twin of the two rows above. The relaxation was added to
    // both arms in one hunk; only the CLI arm had rows.
    const chain = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"), gateReported,
      v2Round(opened(1), "round-1-replay", "round-1"), v2Round(closed(1), "round-1-replay"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(chain, TREE, MANDATED).violations).toEqual([]);
    expect(evaluateRunJournal(chain, TREE, MANDATED).status).toBe("complete-executor-only");
    const fresh = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"), gateReported,
      v2Round(opened(2), "round-2"), v2Round(closed(2), "round-2"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(fresh, TREE, MANDATED).violations).toEqual(["gate-reported-before-closed-round"]);
  });

  it("names the LATEST earlier announcement of the governing key, and only that key's", () => {
    // Every other row that reaches the prior-opening arm carries one round key
    // and one earlier announcement, so the arm's two selections — same key,
    // latest — are unproven for any journal with more than one round in it,
    // which is every real journal this evaluator reads.
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1"), v2Round(opened(1), "round-1"),
      v2Round(opened(2), "round-2"), v2Round(closed(2), "round-2"),
      v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["round-reopened-under-same-id"]);
    // seq 6 is the governing key's own second announcement: not seq 7, which is
    // a DIFFERENT key's opening, and not seq 5, which is stale.
    expect(explainRunJournal(events, TREE, MANDATED).explanations[0]?.because).toContain("was already announced at seq 6");
  });

  it("still reports a self-naming governing round as self-naming when other rounds precede it", () => {
    // The guard on the row above. Without the round-key filter an unrelated
    // earlier opening would be read as this round's own announcement and the
    // message would take the wrong arm entirely.
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"),
      v2Round(opened(2), "round-2", "round-2"), v2Round(closed(2), "round-2"),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["round-reopened-under-same-id"]);
    expect(explainRunJournal(events, TREE, MANDATED).explanations[0]?.because).toContain("it names as itself in reopensRoundId");
  });

  it("does not join two round numbers that share a roundId through a self-naming reopen", () => {
    // `reopenChains` skips a self-naming opening because `byRoundId` resolves
    // it to the FIRST opening under that id, which is a different round key
    // whenever one roundId was reused across two round numbers. Without the
    // skip the two rounds merge into one chain and the bound is undercounted.
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1), "round-x"), v2Round(closed(1), "round-x"),
      v2Round(opened(2), "round-x", "round-x"), v2Round(closed(2), "round-x"),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(explainRunJournal(events, TREE, MANDATED).logicalRounds).toBe(2);
  });

  it("does not let a chain close bound to an unaccepted tree support the gate", () => {
    const events = journal([
      started, ticketRead, posture, lenses(),
      v2Round(opened(1, OTHER_TREE), "round-1"), v2Round(closed(1, OTHER_TREE), "round-1"),
      completed("gate"), completed("record"),
      v2Round(opened(1), "round-1-replay", "round-1"), v2Round(closed(1), "round-1-replay"),
      prOpened, ended,
    ]);
    expect(evaluateRunJournal(events, TREE, MANDATED).violations).toEqual(["gate-before-closed-round"]);
  });
});

describe("the two real journals V26-2075 was taken from", () => {
  // Regression guard, not a repair: both journals already read clean under the
  // evaluator this delivery replaces, and the rules it changes are exactly the
  // rules that could stop them reading clean. A hand-written fixture cannot
  // hold that line, because the shapes here are ones nobody thought to write.
  for (const vector of RUN_JOURNAL_VECTORS.journals) {
    it(`reads ${vector.ticket} (${vector.runId}) exactly as the vector records`, () => {
      const events = vector.events as readonly RunEvent[];
      const evaluation = evaluateRunJournal(events, vector.recordTreeSha, vector.mandatedLensIds, vector.reviewedTreeShas);
      const diagnostics = explainRunJournal(events, vector.recordTreeSha, vector.mandatedLensIds, vector.reviewedTreeShas);
      expect({
        status: evaluation.status,
        missing: evaluation.missing,
        violations: evaluation.violations,
        boundToRecord: evaluation.boundToRecord,
        roundBinding: diagnostics.roundBinding,
        logicalRounds: diagnostics.logicalRounds,
        supersededGateSeqs: diagnostics.supersededGates,
      }).toEqual(vector.expect);
    });
  }

  it("keeps both journals free of the two warnings a regression here would draw", () => {
    for (const vector of RUN_JOURNAL_VECTORS.journals) {
      const { violations } = evaluateRunJournal(
        vector.events as readonly RunEvent[], vector.recordTreeSha, vector.mandatedLensIds, vector.reviewedTreeShas,
      );
      expect(violations).not.toContain("gate-before-closed-round");
      expect(violations).not.toContain("round-not-bound-to-record");
    }
  });
});

describe("the closed identifier sets", () => {
  it("names exactly the ordering constraints the completeness rule states, in a fixed order", () => {
    expect(RUN_JOURNAL_VIOLATIONS).toEqual([
      "run-started-not-first",
      "prerequisites-after-first-round",
      "round-closed-before-opened",
      "gate-before-closed-round",
      "record-before-gate",
      "pr-before-gate",
      "run-ended-not-last",
      "gate-reported-before-closed-round",
      "pr-before-gate-reported",
      "mandated-pair-mismatch",
      "round-not-bound-to-record",
      "round-reopened-under-same-id",
    ]);
  });

  it("names exactly the required entries the completeness rule states, in a fixed order", () => {
    expect(RUN_JOURNAL_REQUIRED_ENTRIES).toEqual([
      "run.started",
      "ticket.read",
      "posture.declared",
      "lens.selected",
      "review.round.opened",
      "review.round.closed",
      "command.completed:gate",
      "command.completed:record",
      "pr.opened",
      "run.ended",
      "gate.reported",
    ]);
  });
});

describe("the complete and executor-only readings", () => {
  it("returns complete with nothing missing and nothing violated for a bound journal", () => {
    expect(evaluateRunJournal(journal(COMPLETE), TREE, MANDATED)).toEqual({
      status: "complete",
      missing: [],
      violations: [],
      boundToRecord: true,
    });
  });

  it("returns complete-executor-only for an executor-only journal, both CLI completions listed missing", () => {
    const result = evaluateRunJournal(journal(EXECUTOR_ONLY), TREE);
    expect(result.status).toBe("complete-executor-only");
    expect(result.missing).toEqual(["command.completed:gate", "command.completed:record"]);
    expect(result.violations).toEqual([]);
  });

  it("never lets gate.reported satisfy the CLI gate completion", () => {
    // Every condition the complete rule states except the two CLI completions,
    // and a gate.reported in their place — but this journal also carries a CLI
    // completion, so it is not executor-only and the substitution is refused.
    const mixed = journal([...without(COMPLETE, isCompletion("gate")), gateReported]);
    const result = evaluateRunJournal(mixed, TREE, MANDATED);
    expect(result.status).toBe("incomplete");
    expect(result.missing).toContain("command.completed:gate");
  });

  it("does not apply gate.reported ordering to a journal governed by CLI completions", () => {
    const reportedAfterPr = journal([
      ...COMPLETE.slice(0, -1),
      gateReported,
      ended,
    ]);
    const reportedBeforeClose = journal([
      started, ticketRead, posture, lenses(), opened(1), gateReported, closed(1),
      completed("gate"), completed("record"), prOpened, ended,
    ]);
    expect(evaluateRunJournal(reportedAfterPr, TREE, MANDATED).violations).toEqual([]);
    expect(evaluateRunJournal(reportedBeforeClose, TREE, MANDATED).violations).toEqual([]);
  });

  it("refuses executor-only status to a journal that has any CLI completion", () => {
    // The row above is satisfied whether the executor-only test reads "no CLI
    // completion at all" or the weaker "no CLI GATE completion", because its
    // journal is ill-ordered and `incomplete` either way. This one is
    // well-ordered — gate.reported stands in its D12 place, before the CLI
    // record completion, with run.ended last — so `violations` is empty and the
    // status can only come from the executor-only decision itself.
    const mixed = journal([started, ticketRead, posture, lenses(), opened(1), closed(1), gateReported, completed("record"), prOpened, ended]);
    const result = evaluateRunJournal(mixed, TREE, MANDATED);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("incomplete");
    expect(result.missing).toContain("command.completed:gate");
  });

  it("refuses executor-only status to a journal whose only CLI completion is the gate", () => {
    // The mirror of the row above, entered from the other side: the weakening
    // that reads the executor-only test as "no CLI RECORD completion" is not
    // caught by any journal that carries one. Well-ordered for the same reason
    // — `violations` empty is what makes the status come from the decision.
    const mixed = journal([started, ticketRead, posture, lenses(), opened(1), closed(1), gateReported, completed("gate"), prOpened, ended]);
    const result = evaluateRunJournal(mixed, TREE, MANDATED);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("incomplete");
    expect(result.missing).toContain("command.completed:record");
  });

  it("refuses executor-only status to a journal whose only CLI completion is neither the gate nor the record", () => {
    // The two rows above enter the executor-only decision from each end and
    // between them pin the two SINGLE weakenings — "no CLI gate completion",
    // "no CLI record completion". Neither reaches the CONJUNCTIVE one, which
    // agrees with the real test on every journal carrying one of those two and
    // differs only where a CLI completion exists that is neither. `check` is
    // such a completion: the standalone preflight is a product command, so the
    // product wrote it, and one product completion is enough to make the
    // journal not executor-only however plausible its gate.reported looks.
    // Well-ordered for the same reason as its neighbours — `violations` empty
    // is what makes the status come from the decision alone.
    const mixed = journal([started, ticketRead, posture, lenses(), opened(1), closed(1), gateReported, completed("check"), prOpened, ended]);
    const result = evaluateRunJournal(mixed, TREE, MANDATED);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("incomplete");
    expect(result.missing).toContain("command.completed:gate");
    expect(result.missing).toContain("command.completed:record");
  });

  it("refuses executor-only status to a journal whose only completion is executor-written", () => {
    // The fourth and last weakening of the executor-only decision: reading it
    // as "no CLI completion" rather than "no completion at all". The three
    // rows above cannot reach it — every one of their journals carries a CLI
    // completion, on which the two readings agree — and neither can the
    // executor-written row at the foot of this file, whose journal also
    // carries a CLI `record`. Only a journal whose SOLE `command.completed` is
    // executor-written separates them: it is not executor-only, because a
    // `command.completed` is present, and the executor's claim to have run the
    // gate is not the product's, so both CLI completions stay missing and
    // gate.reported cannot stand in for either. Well-ordered for the same
    // reason as its neighbours — gate.reported in its D12 place, before the
    // completion, with run.ended last — so `violations` empty is what makes
    // the status come from the executor-only decision alone.
    const executorWritten = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      closed(1),
      gateReported,
      { kind: "command.completed", payload: { command: "gate", outcome: "ok", durationMs: 10 } },
      prOpened,
      ended,
    ]);
    const result = evaluateRunJournal(executorWritten, TREE, MANDATED);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("incomplete");
    expect(result.missing).toEqual(["command.completed:gate", "command.completed:record"]);
  });

  it("reports the evaluation unbound when no record tree sha is supplied", () => {
    const result = evaluateRunJournal(journal(COMPLETE));
    expect(result.boundToRecord).toBe(false);
    expect(result.status).toBe("complete");
  });

  it("accepts any paired round when no tree sha is supplied", () => {
    // The same journal is `incomplete` against a record that binds another
    // candidate, and `complete` when nothing binds it.
    expect(evaluateRunJournal(journal(COMPLETE), OTHER_TREE, MANDATED).status).toBe("incomplete");
    const elsewhere = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1, OTHER_TREE),
      closed(1, OTHER_TREE),
      completed("gate"),
      completed("record"),
      prOpened,
      ended,
    ]);
    expect(evaluateRunJournal(elsewhere).status).toBe("complete");
  });
});

/**
 * A run that carries two tickets: the dogfood item and the ordinary item it
 * delivered, each with its own posture, and the gate and pull request bound to
 * the one they belong to.
 *
 * The rule the contract states is that the binding is OPTIONAL — the first
 * ticket named in `seq` order is the primary ticket and an entry that omits `ticket`
 * binds to it — so completeness must read the bound and the unbound journal
 * exactly alike. These rows are what stop the member becoming a requirement by
 * accident, in either direction.
 */
const SECOND_TICKET = "V26-1658";

const secondTicketRead: Step = { kind: "ticket.read", payload: { ticket: SECOND_TICKET, tracker: "linear" } };
/** A run that named its ticket at the start, and a DIFFERENT one on its first `ticket.read`. */
const startedSecond: Step = {
  kind: "run.started",
  payload: { ticket: SECOND_TICKET, host: "claude-code", workflow: { releaseId: "r1", profile: "linear" } },
};
const boundPosture: Step = {
  kind: "posture.declared",
  payload: { posture: "characterization-first", ticket: SECOND_TICKET },
};
const boundGateReported: Step = {
  kind: "gate.reported",
  payload: { command: "npm run check", outcome: "pass", durationMs: 10, ticket: SECOND_TICKET },
};
const boundPrOpened: Step = {
  kind: "pr.opened",
  payload: { url: "https://github.com/owner/repo/pull/90", candidateTreeSha: TREE, ticket: SECOND_TICKET },
};

describe("a run carrying more than one ticket", () => {
  it("reads a two-ticket journal as complete when the posture and the pull request name the ticket they bind", () => {
    const twoTickets = journal([
      started,
      ticketRead,
      secondTicketRead,
      posture,
      boundPosture,
      lenses(),
      opened(1),
      closed(1),
      completed("gate"),
      completed("record"),
      boundPrOpened,
      ended,
    ]);
    expect(evaluateRunJournal(twoTickets, TREE, MANDATED)).toEqual({
      status: "complete",
      missing: [],
      violations: [],
      boundToRecord: true,
    });
  });

  it("reads a two-ticket executor-only journal as complete when its gate and pull request name their ticket", () => {
    const twoTickets = journal([
      started,
      ticketRead,
      secondTicketRead,
      posture,
      boundPosture,
      lenses(),
      opened(1),
      closed(1),
      boundGateReported,
      boundPrOpened,
      ended,
    ]);
    const result = evaluateRunJournal(twoTickets, TREE);
    expect(result.status).toBe("complete-executor-only");
    expect(result.missing).toEqual(["command.completed:gate", "command.completed:record"]);
    expect(result.violations).toEqual([]);
  });

  /**
   * THE SCOPE OF `prerequisites-after-first-round`, PINNED IN BOTH BINDINGS.
   *
   * D12's constraint binds the FIRST `ticket.read`, the FIRST
   * `posture.declared`, and the FIRST `lens.selected` — not every entry of
   * those kinds. D13 blesses a run that carries more than one ticket, and a
   * delivery reads a further ticket mid-loop by design (a deferral's follow-up
   * item is filed and read during review, and a posture re-declared after a
   * finding is ordinary), so binding every entry would make that conforming
   * behaviour a violation. What the constraint is for is that the delivery
   * started with its prerequisites in hand before review opened, which the
   * first of each kind establishes.
   *
   * These two rows are the falsifiable statement of that reading: the second
   * ticket's `ticket.read` and `posture.declared` land AFTER round 1 opened and
   * the journal is clean. Under the all-entries reading both rows go red —
   * `violations` gains `prerequisites-after-first-round` and `status` drops to
   * `incomplete` — which is exactly the discrimination the rows exist to make.
   * They are asserted bound to a record and unbound, because the prerequisite
   * ordering is phrased over no tree sha and must read alike either way.
   */
  const prerequisitesAfterTheFirstRound: readonly Step[] = [
    started,
    ticketRead,
    posture,
    lenses(),
    opened(1),
    // The SECOND `lens.selected` is here for the same reason the second ticket
    // is: `obtain-review` emits one before realizing the lenses of every round,
    // so a review of more than one round writes one after the first open. All
    // three prerequisite kinds therefore recur after the open in this journal,
    // and the clean verdict covers all three rather than two of them.
    lenses(),
    secondTicketRead,
    boundPosture,
    closed(1),
    completed("gate"),
    completed("record"),
    boundPrOpened,
    ended,
  ];

  it("reads a second ticket's prerequisites after the first round opened as clean, bound to a record", () => {
    expect(evaluateRunJournal(journal(prerequisitesAfterTheFirstRound), TREE, MANDATED)).toEqual({
      status: "complete",
      missing: [],
      violations: [],
      boundToRecord: true,
    });
  });

  it("reads the same journal alike unbound to a record", () => {
    expect(evaluateRunJournal(journal(prerequisitesAfterTheFirstRound))).toEqual({
      status: "complete",
      missing: [],
      violations: [],
      boundToRecord: false,
    });
  });

  it("still names prerequisites-after-first-round when the FIRST of a kind lands late in the same journal", () => {
    // The discrimination runs both ways: move the run's own first `ticket.read`
    // past the open and the constraint fires, on a journal otherwise identical
    // to the clean one above. Without this row a reading that never binds
    // `ticket.read` at all would satisfy the two rows above — and the late leg
    // is `ticket.read` rather than `posture.declared` because the per-identifier
    // reject vector below already moves the posture, so moving it here would
    // discriminate nothing the suite does not already have.
    const firstTicketReadLate = journal([
      started,
      posture,
      lenses(),
      opened(1),
      ticketRead,
      secondTicketRead,
      boundPosture,
      closed(1),
      completed("gate"),
      completed("record"),
      boundPrOpened,
      ended,
    ]);
    const result = evaluateRunJournal(firstTicketReadLate, TREE, MANDATED);
    expect(result.violations).toEqual(["prerequisites-after-first-round"]);
    expect(result.status).toBe("incomplete");
  });

  it("requires no ticket on a posture, a gate report, or a pull request", () => {
    // The same run with every binding dropped: one `ticket.read`, an unbound
    // posture, an unbound gate report, an unbound pull request. Nothing the
    // evaluator names may appear.
    const unbound = evaluateRunJournal(journal(EXECUTOR_ONLY), TREE);
    expect(unbound.status).toBe("complete-executor-only");
    expect(unbound.violations).toEqual([]);
    expect(unbound.missing).toEqual(["command.completed:gate", "command.completed:record"]);
  });

  it("reads the first ticket the journal names as the run's primary ticket", () => {
    expect(runPrimaryTicket(journal([started, ticketRead, secondTicketRead, boundPosture]))).toBe("V26-1548");
    expect(runPrimaryTicket(journal([ticketRead, secondTicketRead]))).toBe("V26-1548");
    expect(runPrimaryTicket(journal([secondTicketRead, ticketRead]))).toBe(SECOND_TICKET);
    expect(runPrimaryTicket(journal([posture, lenses()]))).toBeUndefined();
  });

  /**
   * The row above cannot tell the two SOURCES apart: `started` and `ticketRead`
   * name the same ticket, so a rule that read the first `ticket.read` rather
   * than the first ticket in `seq` order would answer it identically. Here the
   * two disagree, which is exactly the journal the docstring describes — one
   * that names its ticket on `run.started`. Order decides, so `run.started`
   * wins, and reading `ticket.read` instead would answer "V26-1548".
   */
  it("prefers the run.started ticket over a first ticket.read that names a different one", () => {
    expect(runPrimaryTicket(journal([startedSecond, ticketRead, secondTicketRead]))).toBe(SECOND_TICKET);
    // And with no `ticket.read` at all there is still a primary to read.
    expect(runPrimaryTicket(journal([startedSecond, posture, lenses()]))).toBe(SECOND_TICKET);
  });
});

describe("one reject vector per violation identifier", () => {
  const vectors: Readonly<Record<RunJournalViolation, () => ReturnType<typeof evaluateRunJournal>>> = {
    "run-started-not-first": () =>
      evaluateRunJournal(journal([ticketRead, started, posture, lenses(), opened(1), closed(1), completed("gate"), completed("record"), prOpened, ended])),
    "prerequisites-after-first-round": () =>
      evaluateRunJournal(journal([started, ticketRead, lenses(), opened(1), posture, closed(1), completed("gate"), completed("record"), prOpened, ended])),
    "round-closed-before-opened": () =>
      evaluateRunJournal(
        journal([started, ticketRead, posture, lenses(), closed(1), opened(1), opened(2), closed(2), completed("gate"), completed("record"), prOpened, ended]),
      ),
    "gate-before-closed-round": () =>
      evaluateRunJournal(journal([started, ticketRead, posture, lenses(), opened(1), completed("gate"), closed(1), completed("record"), prOpened, ended])),
    "record-before-gate": () =>
      evaluateRunJournal(journal([started, ticketRead, posture, lenses(), opened(1), closed(1), completed("record"), completed("gate"), prOpened, ended])),
    "pr-before-gate": () =>
      evaluateRunJournal(journal([started, ticketRead, posture, lenses(), opened(1), closed(1), prOpened, completed("gate"), completed("record"), ended])),
    "run-ended-not-last": () =>
      evaluateRunJournal(journal([started, ticketRead, posture, lenses(), opened(1), closed(1), completed("gate"), completed("record"), ended, prOpened])),
    "gate-reported-before-closed-round": () =>
      evaluateRunJournal(journal([started, ticketRead, posture, lenses(), opened(1), gateReported, closed(1), prOpened, ended])),
    "pr-before-gate-reported": () =>
      evaluateRunJournal(journal([started, ticketRead, posture, lenses(), opened(1), closed(1), prOpened, gateReported, ended])),
    "mandated-pair-mismatch": () =>
      evaluateRunJournal(
        journal([started, ticketRead, posture, lenses(["lens.outcome-correctness"]), opened(1), closed(1), completed("gate"), completed("record"), prOpened, ended]),
      ),
    // No gate anchor of either kind, so the only constraint the supplied tree
    // sha can violate is the bound-round one.
    "round-not-bound-to-record": () =>
      evaluateRunJournal(journal([started, ticketRead, posture, lenses(), opened(1), closed(1), prOpened, ended]), OTHER_TREE),
    // The governing round's own key was opened twice. Nothing else is out of
    // order, which is the whole claim: the pairing resolves and this is the one
    // identifier left.
    "round-reopened-under-same-id": () =>
      evaluateRunJournal(journal([started, ticketRead, posture, lenses(),
        v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"),
        v2Round(opened(1), "round-1", "round-1"), v2Round(closed(1), "round-1"),
        completed("gate"), completed("record"), prOpened, ended])),
  };

  for (const identifier of RUN_JOURNAL_VIOLATIONS) {
    it(`provokes exactly ${identifier} and no other constant entry`, () => {
      const result = vectors[identifier]();
      expect(result.violations).toEqual([identifier]);
      expect(result.status).toBe("incomplete");
    });
  }

  it("covers the constant exactly: the union of the vectors' identifiers is the whole set", () => {
    const seen = new Set<string>();
    for (const identifier of RUN_JOURNAL_VIOLATIONS) for (const found of vectors[identifier]().violations) seen.add(found);
    expect([...seen].sort()).toEqual([...RUN_JOURNAL_VIOLATIONS].sort());
  });

  it("names run-started-not-first for a second run.started even where the first stands at index 0", () => {
    // `run-started-not-first` is a disjunction, and the vector above enters
    // through the first disjunct alone: a run.started that is not the
    // journal's first entry. The second disjunct — more than one run.started
    // anywhere — has no vector of its own, and this journal is the one that
    // isolates it, satisfying the first disjunct's negation exactly. A run
    // restarted in place is the condition it describes.
    const restarted = journal([
      started,
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      closed(1),
      completed("gate"),
      completed("record"),
      prOpened,
      ended,
    ]);
    const result = evaluateRunJournal(restarted, TREE, MANDATED);
    expect(result.violations).toEqual(["run-started-not-first"]);
    expect(result.status).toBe("incomplete");
  });
});

describe("one missing vector per required entry", () => {
  const vectors: Readonly<Record<RunJournalRequiredEntry, () => ReturnType<typeof evaluateRunJournal>>> = {
    "run.started": () => evaluateRunJournal(journal(without(COMPLETE, (step) => step.kind === "run.started")), TREE, MANDATED),
    "ticket.read": () => evaluateRunJournal(journal(without(COMPLETE, (step) => step.kind === "ticket.read")), TREE, MANDATED),
    "posture.declared": () => evaluateRunJournal(journal(without(COMPLETE, (step) => step.kind === "posture.declared")), TREE, MANDATED),
    "lens.selected": () => evaluateRunJournal(journal(without(COMPLETE, (step) => step.kind === "lens.selected")), TREE, MANDATED),
    "review.round.opened": () =>
      evaluateRunJournal(journal(without(COMPLETE, (step) => step.kind === "review.round.opened")), TREE, MANDATED),
    "review.round.closed": () =>
      evaluateRunJournal(journal(without(COMPLETE, (step) => step.kind === "review.round.closed")), TREE, MANDATED),
    "command.completed:gate": () => evaluateRunJournal(journal(without(COMPLETE, isCompletion("gate"))), TREE, MANDATED),
    "command.completed:record": () => evaluateRunJournal(journal(without(COMPLETE, isCompletion("record"))), TREE, MANDATED),
    "pr.opened": () => evaluateRunJournal(journal(without(COMPLETE, (step) => step.kind === "pr.opened")), TREE, MANDATED),
    "run.ended": () => evaluateRunJournal(journal(without(COMPLETE, (step) => step.kind === "run.ended")), TREE, MANDATED),
    "gate.reported": () =>
      evaluateRunJournal(journal(without(EXECUTOR_ONLY, (step) => step.kind === "gate.reported")), TREE, MANDATED),
  };

  for (const entry of RUN_JOURNAL_REQUIRED_ENTRIES) {
    it(`names ${entry} missing when the complete rule's journal withholds exactly it`, () => {
      const result = vectors[entry]();
      expect(result.missing).toContain(entry);
      expect(result.status).toBe("incomplete");
    });
  }

  it("covers the constant exactly: the union of the vectors' missing names is the whole set", () => {
    const seen = new Set<string>();
    for (const entry of RUN_JOURNAL_REQUIRED_ENTRIES) for (const found of vectors[entry]().missing) seen.add(found);
    expect([...seen].sort()).toEqual([...RUN_JOURNAL_REQUIRED_ENTRIES].sort());
  });
});

describe("the anchored constraints and the round rules", () => {
  it("skips each anchored constraint only when its own anchor is absent", () => {
    // The record completion is present and precedes the gate completion, but
    // the gate anchor is gone: `record-before-gate` is skipped, not reported.
    const noGate = journal(without(COMPLETE, isCompletion("gate")));
    expect(evaluateRunJournal(noGate, TREE, MANDATED).violations).toEqual([]);
    // Restore the anchor in the wrong order and the same journal violates.
    const wrongOrder = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      closed(1),
      completed("record"),
      completed("gate"),
      prOpened,
      ended,
    ]);
    expect(evaluateRunJournal(wrongOrder, TREE, MANDATED).violations).toEqual(["record-before-gate"]);
  });

  it("names round-not-bound-to-record whatever the writer mix", () => {
    expect(evaluateRunJournal(journal(COMPLETE), OTHER_TREE, MANDATED).violations).toContain("round-not-bound-to-record");
    expect(evaluateRunJournal(journal(EXECUTOR_ONLY), OTHER_TREE).violations).toContain("round-not-bound-to-record");
    expect(evaluateRunJournal(journal(COMPLETE), OTHER_TREE, MANDATED).status).toBe("incomplete");
  });

  it("accepts a closed round bound to a verified review-neutral projection", () => {
    const result = evaluateRunJournal(journal(COMPLETE), OTHER_TREE, MANDATED, [TREE]);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("complete");
    expect(result.boundToRecord).toBe(true);

    expect(evaluateRunJournal(journal(COMPLETE), OTHER_TREE, MANDATED, ["c".repeat(40)]).violations)
      .toContain("round-not-bound-to-record");
  });

  it("names mandated-pair-mismatch whatever the writer mix", () => {
    // The mandate rule is phrased over the lens.selected event alone and reads
    // no completion, so it must name the same violation in an executor-only
    // journal as in a CLI-written one. Vectored on the CLI-written side only —
    // as every mismatch row before this one is — the universal would still
    // hold under an evaluator that checked the mandate for product-run
    // deliveries and let an adopter running no product command past it, which
    // is exactly the adopter the pair is mandated for.
    const misnamed = (steps: readonly Step[]): readonly Step[] =>
      steps.map((step) => (step.kind === "lens.selected" ? lenses(["lens.outcome-correctness"]) : step));

    const cliWritten = evaluateRunJournal(journal(misnamed(COMPLETE)), TREE, MANDATED);
    expect(cliWritten.violations).toEqual(["mandated-pair-mismatch"]);
    expect(cliWritten.status).toBe("incomplete");

    const executorWritten = evaluateRunJournal(journal(misnamed(EXECUTOR_ONLY)), TREE, MANDATED);
    expect(executorWritten.violations).toEqual(["mandated-pair-mismatch"]);
    expect(executorWritten.status).toBe("incomplete");
    expect(executorWritten.missing).toEqual(["command.completed:gate", "command.completed:record"]);
  });

  it("rejects a mandated pair that differs from the supplied one, and an arity failure with none supplied", () => {
    expect(evaluateRunJournal(journal(COMPLETE), TREE, ["lens.outcome-correctness", "lens.security"]).violations).toEqual([
      "mandated-pair-mismatch",
    ]);
    const single = journal([
      started,
      ticketRead,
      posture,
      lenses(["lens.outcome-correctness"]),
      opened(1),
      closed(1),
      completed("gate"),
      completed("record"),
      prOpened,
      ended,
    ]);
    expect(evaluateRunJournal(single).violations).toEqual(["mandated-pair-mismatch"]);
  });

  it("reports an unpaired journal as incomplete with no violation when no gate anchor exists", () => {
    const neverPairs = journal([started, ticketRead, posture, lenses(), opened(1), closed(2), prOpened, ended]);
    const result = evaluateRunJournal(neverPairs);
    expect(result.status).toBe("incomplete");
    expect(result.missing).toContain("review.round.closed");
    expect(result.missing).not.toContain("review.round.opened");
    expect(result.violations).toEqual([]);
  });

  it("names review.round.opened missing as well when the journal has no opened round at all", () => {
    const noRounds = journal([started, ticketRead, posture, lenses(), prOpened, ended]);
    const result = evaluateRunJournal(noRounds);
    expect(result.missing).toContain("review.round.opened");
    expect(result.missing).toContain("review.round.closed");
  });

  it("evaluates the gate-anchored and gate.reported orderings over any closed round when unbound", () => {
    const boundElsewhere = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1, OTHER_TREE),
      completed("gate"),
      closed(1, OTHER_TREE),
      completed("record"),
      prOpened,
      ended,
    ]);
    expect(evaluateRunJournal(boundElsewhere).violations).toEqual(["gate-before-closed-round"]);
    const reportedElsewhere = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1, OTHER_TREE),
      gateReported,
      closed(1, OTHER_TREE),
      prOpened,
      ended,
    ]);
    expect(evaluateRunJournal(reportedElsewhere).violations).toEqual(["gate-reported-before-closed-round"]);
  });

  it("rejects a command.completed whose actor is not the CLI", () => {
    const executorWritten = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      closed(1),
      { kind: "command.completed", payload: { command: "gate", outcome: "ok", durationMs: 10 } },
      completed("record"),
      prOpened,
      ended,
    ]);
    const result = evaluateRunJournal(executorWritten, TREE, MANDATED);
    expect(result.missing).toContain("command.completed:gate");
    // A command.completed is present, so the journal is not executor-only and
    // gate.reported could not have stood in for it either.
    expect(result.status).toBe("incomplete");
  });
});

describe("a journal that re-ran a command", () => {
  /**
   * THE FIRST-VERSUS-LAST BINDING, PINNED. `cliCompletion` binds the LAST CLI
   * completion of a command, and until this row nothing said which — every
   * journal above carries at most one completion per command, so `first` and
   * `last` agree on all of them and a binding flipped either way survived the
   * whole suite. The three journals here are the ones the two readings judge
   * differently: each carries two CLI completions of one command straddling a
   * gate-anchored constraint, so a `first` binding turns a clean verdict dirty
   * or a dirty one clean on every single one. `pr-before-gate` is not among
   * those constraints — it anchors on the OPENING gate for the reason the row
   * below states — so these journals separate the binding on
   * `gate-before-closed-round` and on `record-before-gate`.
   *
   * WHY LAST IS THE READING. A command is re-run to supersede its earlier
   * outcome, so the completion the two governing-gate constraints are about
   * is the one the delivery finally stood on — the latest. Under a `first`
   * binding a delivery could gate before its round closed, close the round,
   * re-run the gate, and be judged on the gate it had already abandoned; and a
   * gate re-run after the record was written — the ordering `record-before-gate`
   * exists to catch — would read as clean because an earlier gate preceded the
   * record.
   */
  it("binds the last CLI completion of a command, not the first", () => {
    // Gate re-run after the round closed: clean, because the gate that governs
    // is the second one. Under a `first` binding the abandoned gate governs
    // and the journal reads as gating before any round closed.
    const gateRerunAfterRound = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      completed("gate"),
      closed(1),
      completed("gate"),
      completed("record"),
      prOpened,
      ended,
    ]);
    const rerun = evaluateRunJournal(gateRerunAfterRound, TREE, MANDATED);
    expect(rerun.violations).toEqual([]);
    expect(rerun.status).toBe("complete");

    // Gate re-run after the record was written: dirty, because the governing
    // gate now follows the record. Under a `first` binding the earlier gate
    // precedes the record and the re-run disappears from the verdict.
    const gateRerunAfterRecord = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      closed(1),
      completed("gate"),
      completed("record"),
      completed("gate"),
      prOpened,
      ended,
    ]);
    expect(evaluateRunJournal(gateRerunAfterRecord, TREE, MANDATED).violations).toEqual(["record-before-gate"]);

    // The binding is `cliCompletion`'s, not the gate's: a re-run RECORD binds
    // last too, so a record written before the gate and rewritten after it is
    // clean rather than caught by `record-before-gate`.
    const recordRerun = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      closed(1),
      completed("record"),
      completed("gate"),
      completed("record"),
      prOpened,
      ended,
    ]);
    const rewritten = evaluateRunJournal(recordRerun, TREE, MANDATED);
    expect(rewritten.violations).toEqual([]);
    expect(rewritten.status).toBe("complete");
  });

  /**
   * THE ONE GATE-ANCHORED CONSTRAINT THAT DOES NOT FOLLOW THE BINDING.
   * `pr-before-gate` asks whether the delivery opened its pull request before
   * it had gated AT ALL, so its anchor is the OPENING gate completion and not
   * the governing one. Anchored on the governing gate it would fire on the
   * ordinary review loop this repository itself runs — gate, record, open the
   * pull request, then a further round and a further gate — where the pull
   * request precedes the last gate by construction and nothing is out of
   * order. `run-01c68dea9d1d5fd0`, this repository's own V26-1580 delivery, is
   * exactly such a journal: it opens its pull request at index 17 and re-gates
   * at index 26, and it is the journal the binding decision was taken against.
   */
  it("anchors pr-before-gate on the opening gate completion, not the governing one", () => {
    // The shape of the repository's own second-round loop. Clean: the pull
    // request followed a gate, and the re-gate that followed it is the one the
    // other two constraints are judged on.
    //
    // THE PULL REQUEST SITS BEFORE THE FIRST RECORD COMPLETION ON PURPOSE, and
    // that is what pins the anchor's COMMAND rather than only its position in
    // the run. With the pull request placed after it, this journal reads clean
    // under any "first CLI completion of some command" anchor, so an anchor
    // taken on `record` instead of `gate` would pass — and that anchor is wrong
    // in both directions: an unfinished run that has gated but not yet
    // recorded would report nothing at all, and this journal would be reported
    // out of order. Here the first record completion follows the pull request,
    // so a `record` anchor names it as late and the row fails.
    const reGatedAfterPr = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      closed(1),
      completed("gate"),
      prOpened,
      completed("record"),
      completed("gate"),
      completed("record"),
      ended,
    ]);
    const looped = evaluateRunJournal(reGatedAfterPr, TREE, MANDATED);
    expect(looped.violations).toEqual([]);
    expect(looped.status).toBe("complete");

    // The deny side survives the split: a pull request opened before the
    // opening gate is still out of order, two gates or one.
    const prFirst = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      closed(1),
      prOpened,
      completed("gate"),
      completed("gate"),
      completed("record"),
      ended,
    ]);
    expect(evaluateRunJournal(prFirst, TREE, MANDATED).violations).toEqual(["pr-before-gate"]);
  });
});


describe("each prerequisite binds the first opened round", () => {
  it.each([ticketRead, posture, lenses()])("rejects an individually late $kind", (late) => {
    const early = [ticketRead, posture, lenses()].filter(step => step.kind !== late.kind);
    const result = evaluateRunJournal(journal([
      started, ...early, opened(1), late, closed(1),
      completed("gate"), completed("record"), prOpened, ended,
    ]), TREE, MANDATED);
    expect(result.violations).toEqual(["prerequisites-after-first-round"]);
    expect(result.status).toBe("incomplete");
  });

  it("rejects a prerequisite between two otherwise complete rounds", () => {
    const result = evaluateRunJournal(journal([
      started, ticketRead, posture, opened(1), lenses(), closed(1),
      opened(2), closed(2), completed("gate"), completed("record"), prOpened, ended,
    ]), TREE, MANDATED);
    expect(result.violations).toEqual(["prerequisites-after-first-round"]);
    expect(result.status).toBe("incomplete");
  });

  it("finds a primary ticket after an event with no ticket", () => {
    expect(runPrimaryTicket(journal([posture, ticketRead]))).toBe("V26-1548");
  });
});

/**
 * The diagnostics half: WHY a warning exists, and whether it bears on the
 * current admission decision.
 *
 * Characterized against the journal SHAPE the V26-2059 reproduction describes
 * — the one PR kwam1na/athena#790 produced — rather than against a synthetic
 * one. The Athena artifacts live in that repository; what is reproducible here
 * is the shape, and the shape is all the evaluator reads: three prerequisites
 * journaled after the first round opened, three full rounds all closed against
 * one raw tree, then report/telemetry-only commits that move the record's tree
 * away from it.
 */
describe("explaining a journal's warnings", () => {
  /** The raw tree the ticket names as the final aligned review's candidate. */
  const REVIEWED = "222e7acb62c48f49e1bbf62208dfd4e6bdd686fd";
  /** Where the record landed after the report/telemetry-only commits. */
  const RECORDED = "d".repeat(40);

  const ATHENA: readonly Step[] = [
    started,
    opened(1, REVIEWED),
    ticketRead,
    posture,
    lenses(),
    closed(1, REVIEWED),
    opened(2, REVIEWED),
    closed(2, REVIEWED),
    opened(3, REVIEWED),
    closed(3, REVIEWED),
    completed("gate"),
    completed("record"),
    { kind: "pr.opened", payload: { url: "https://example.invalid/pr/790", candidateTreeSha: REVIEWED } },
    ended,
  ];

  const explain = (steps: readonly Step[], treeSha?: string, reviewed: readonly string[] = []) =>
    explainRunJournal(journal(steps), treeSha, MANDATED, reviewed);
  const evaluate = (steps: readonly Step[], treeSha?: string, reviewed: readonly string[] = []) =>
    evaluateRunJournal(journal(steps), treeSha, MANDATED, reviewed);
  const by = (diagnostics: ReturnType<typeof explainRunJournal>, violation: RunJournalViolation) =>
    diagnostics.explanations.find((entry) => entry.violation === violation);

  /**
   * One anchoring phrase per violation: the part of its reason that names the
   * entry the warning is ABOUT. Asserting these keeps every identifier's
   * sentence tied to its own subject, so a reason copied from another arm —
   * the one mistake a length check cannot see — fails here.
   */
  const BECAUSE: Readonly<Record<RunJournalViolation, string>> = {
    "run-started-not-first": "a whole run starts exactly once, at the first entry",
    "prerequisites-after-first-round": "recorded after the first review.round.opened at seq",
    "round-closed-before-opened": "carries its review.round.closed ahead of its review.round.opened",
    "gate-before-closed-round": "the governing gate completion at seq",
    "record-before-gate": "the record was written before the gate it reports",
    "pr-before-gate": "before it had gated at all",
    "run-ended-not-last": "run.ended is terminal",
    "gate-reported-before-closed-round": "the governing gate.reported at seq",
    "pr-before-gate-reported": "before it had reported a gate at all",
    "mandated-pair-mismatch": "lens.selected at seq",
    "round-not-bound-to-record": "are the only candidates a round may bind here",
    "round-reopened-under-same-id": "reopen it under a new roundId",
  };

  it("reproduces all three of the reported warnings when nothing accepts the reviewed tree", () => {
    expect(evaluate(ATHENA, RECORDED).violations).toEqual([
      "prerequisites-after-first-round",
      "gate-before-closed-round",
      "round-not-bound-to-record",
    ]);
  });

  it("names each warning's own journal positions rather than repeating the identifier", () => {
    const diagnostics = explain(ATHENA, RECORDED);
    // The three prerequisites sit at seq 3, 4 and 5, behind the round opened
    // at seq 2. Naming all three is what tells a reader this was one recording
    // slip rather than three separate omissions.
    expect(by(diagnostics, "prerequisites-after-first-round")?.because).toBe(
      "ticket.read (seq 3) and posture.declared (seq 4) and lens.selected (seq 5) were recorded after the first review.round.opened at seq 2; this is the order the executor journaled its own prerequisites in, and it is retained as history rather than corrected",
    );
    expect(by(diagnostics, "round-not-bound-to-record")?.because).toContain("the governing round closed at seq 10");
    expect(by(diagnostics, "round-not-bound-to-record")?.because).toContain("0 the record's verified review-neutral projection accepts");
  });

  it("says the tree-bound gate warning is the same fact restated, not a second mistake", () => {
    const diagnostics = explain(ATHENA, RECORDED);
    expect(by(diagnostics, "gate-before-closed-round")?.consequenceOf).toBe("round-not-bound-to-record");
    // The completion's own position and the round's, both named exactly, for
    // the same reason the bound arm names its two below.
    expect(by(diagnostics, "gate-before-closed-round")?.because).toBe(
      "the governing gate completion at seq 11 has no closed round this row accepts: the governing round closed at seq 10 binds a candidate tree that is not the record's and is not among the 0 the record's verified review-neutral projection accepts",
    );
    expect(diagnostics.roundBinding).toBe("unbound");
  });

  it("counts the accepted projection it actually got at both sentences that state it, not always zero", () => {
    // The sentence tells the operator how many trees the record's verified
    // review-neutral projection accepts, so that a round bound to none of them
    // reads as a fact they can check. Every other fixture here passes an empty
    // accepted set and pins the literal "the 0", which a hard-coded zero would
    // satisfy; this passes a non-empty one that still does not contain the
    // round's tree, so the count has to be computed. A wrong count would tell
    // an operator a record accepting one reviewed tree accepts none.
    expect(by(explain(ATHENA, RECORDED, [OTHER_TREE]), "gate-before-closed-round")?.because).toContain(
      "is not among the 1 the record's verified review-neutral projection accepts",
    );
    // TWO sentences state this count, raised from two different places, and
    // pinning one leaves the other free to say anything. This is the more
    // prominent of them: it is the reason `round-not-bound-to-record` gives,
    // the warning this whole delivery is about and the one the refusal names
    // first. The only other assertion touching this sentence is the
    // anchoring phrase above, which pins its closing clause and not the count.
    expect(by(explain(ATHENA, RECORDED, [OTHER_TREE]), "round-not-bound-to-record")?.because).toContain(
      "and the 1 reviewed tree(s) its verified review-neutral projection accepts",
    );
  });

  it("keeps a genuinely mis-ordered gate a defect of its own, with no inherited cause", () => {
    // The round binds the record's own tree, so nothing about the binding is
    // wrong: the gate simply ran before the round closed. This is the arm the
    // Athena journal does NOT enter, and telling the two apart is the point.
    const misordered = [started, ticketRead, posture, lenses(), opened(1), completed("gate"), closed(1), completed("record"), prOpened, ended];
    const diagnostics = explain(misordered, TREE);
    expect(evaluate(misordered, TREE).violations).toEqual(["gate-before-closed-round"]);
    expect(by(diagnostics, "gate-before-closed-round")?.consequenceOf).toBeUndefined();
    expect(by(diagnostics, "gate-before-closed-round")?.because).toBe(
      "the governing gate completion at seq 6 precedes the governing closed round at seq 7, so that gate did not stand on a completed review",
    );
    expect(diagnostics.roundBinding).toBe("record-tree");
  });

  it("clears both tree-derived warnings once the verified projection accepts the reviewed tree, and says which tree bound the round", () => {
    // The legitimate historical omission survives: accepting the reviewed
    // candidate says nothing about the order the prerequisites were recorded
    // in, and an accepted projection must not launder that away.
    expect(evaluate(ATHENA, RECORDED, [REVIEWED]).violations).toEqual(["prerequisites-after-first-round"]);
    const diagnostics = explain(ATHENA, RECORDED, [REVIEWED]);
    expect(diagnostics.roundBinding).toBe("reviewed-tree");
    expect(by(diagnostics, "prerequisites-after-first-round")).toBeDefined();
  });

  it("reports a real missing review as an absent governing round rather than as a binding mismatch", () => {
    const noClose = [started, ticketRead, posture, lenses(), opened(1, REVIEWED), completed("gate"), completed("record"), prOpened, ended];
    expect(evaluate(noClose, RECORDED, [REVIEWED]).missing).toContain("review.round.closed");
    const diagnostics = explain(noClose, RECORDED, [REVIEWED]);
    expect(by(diagnostics, "round-not-bound-to-record")?.because).toContain(
      "the journal carries no round whose latest opening is closed by its own latest close",
    );
    expect(diagnostics.roundBinding).toBe("unbound");
  });

  it("reports a failed preliminary gate under the record's own tree with no reviewed tree to blame", () => {
    // A gate run before any round closed, on the record's own candidate, with
    // a reviewed tree available that has nothing to do with it.
    const failedPreliminary = [started, ticketRead, posture, lenses(), completed("gate"), opened(1), closed(1), completed("record"), prOpened, ended];
    const diagnostics = explain(failedPreliminary, TREE, [REVIEWED]);
    expect(evaluate(failedPreliminary, TREE, [REVIEWED]).violations).toEqual(["gate-before-closed-round"]);
    expect(by(diagnostics, "gate-before-closed-round")?.consequenceOf).toBeUndefined();
    expect(diagnostics.roundBinding).toBe("record-tree");
  });

  it("answers the admission question the same way for every warning, because there is only one answer", () => {
    for (const steps of [ATHENA, EXECUTOR_ONLY, COMPLETE]) {
      const explanations = explain(steps, RECORDED).explanations;
      expect(explanations.length).toBeGreaterThan(0);
      for (const explanation of explanations) expect(explanation.blocksAdmission).toBe(false);
    }
  });

  it("carries no journal-supplied text, so a hostile payload cannot reach a readout", () => {
    // Every member an explanation could be tempted to quote is attacker-chosen
    // here, and the vectors between them provoke EVERY violation, so no
    // explanation builder is left unexercised under hostile input. Only `seq`
    // - a validated positive integer - may cross.
    const hostile = "\u001b[2Kmissing: (none)\n    violations: (none)";
    const startedH: Step = { kind: "run.started", payload: { ticket: hostile, host: hostile, workflow: { releaseId: hostile, profile: hostile } } };
    const ticketReadH: Step = { kind: "ticket.read", payload: { ticket: hostile, tracker: hostile } };
    const postureH: Step = { kind: "posture.declared", payload: { posture: hostile } };
    const lensesH = (ids: readonly string[]): Step => ({ kind: "lens.selected", payload: { mandated: [...ids], selected: [...ids], rationale: hostile } });
    const openedH = (round: number): Step => ({ kind: "review.round.opened", payload: { round, candidateTreeSha: hostile, lenses: [hostile] } });
    const closedH = (round: number): Step => ({
      kind: "review.round.closed",
      payload: { round, candidateTreeSha: hostile, outcome: hostile, findings: { P0: 0, P1: 0, P2: 0, P3: 0 }, cost: { ...COST, reportedBy: hostile } },
    });
    const completedH = (command: string): Step => ({ kind: "command.completed", payload: { command, outcome: hostile, durationMs: 10 }, cli: true });
    const gateReportedH: Step = { kind: "gate.reported", payload: { command: hostile, outcome: hostile, durationMs: 10 } };
    const prOpenedH: Step = { kind: "pr.opened", payload: { url: hostile, candidateTreeSha: hostile } };
    const endedH: Step = { kind: "run.ended", payload: { result: hostile, cost: { ...COST, reportedBy: hostile } } };
    // A version-2 pair under one attacker-chosen roundId, the opening naming
    // that same id as the round it continues.
    const openedSelfH: Step = {
      ...openedH(1), version: "run-event/2",
      payload: { ...openedH(1).payload, roundId: hostile, reopensRoundId: hostile },
    };
    const closedSelfH: Step = {
      ...closedH(1), version: "run-event/2",
      payload: { ...closedH(1).payload, roundId: hostile },
    };

    const poisoned: readonly (readonly [readonly Step[], string | undefined])[] = [
      // The reproduction's own shape, every payload hostile.
      [[startedH, openedH(1), ticketReadH, postureH, lensesH([hostile]), closedH(1), completedH("gate"), completedH("record"), prOpenedH, endedH], TREE],
      // A started-late, inverted, record-first, pr-first, ended-early journal.
      [[ticketReadH, startedH, postureH, lensesH(MANDATED), closedH(1), openedH(1), openedH(2), closedH(2), prOpenedH, completedH("record"), completedH("gate"), endedH, ticketReadH], undefined],
      // The adopter shape, where gate.reported carries the ordering instead.
      [[startedH, ticketReadH, postureH, lensesH(MANDATED), openedH(1), closedH(1), prOpenedH, gateReportedH, endedH], undefined],
      [[startedH, ticketReadH, postureH, lensesH(MANDATED), openedH(1), gateReportedH, closedH(1), prOpenedH, endedH], undefined],
      // The two arms a set over IDENTIFIERS would leave unexercised, reached
      // deliberately: the reported gate's unbound arm under a record that
      // accepts nothing the rounds bound, and the branch that speaks when no
      // paired round exists at all. Both are arms `verify` renders in
      // production, and each interpolates a different journal position.
      [[startedH, ticketReadH, postureH, lensesH(MANDATED), openedH(1), closedH(1), gateReportedH, prOpenedH, endedH], TREE],
      [[startedH, ticketReadH, postureH, lensesH(MANDATED), openedH(1), gateReportedH, prOpenedH, endedH], TREE],
      // The same two branches for the COMPLETED gate, whose sentence is the
      // one the reproduction's own row carries.
      [[startedH, ticketReadH, postureH, lensesH(MANDATED), openedH(1), completedH("gate"), completedH("record"), prOpenedH, endedH], TREE],
      // The completed gate's ORDERED arm - the one a CLI-driven journal
      // actually renders, where a closed round this row accepts exists and the
      // gate precedes it. Without this vector the sentence that interpolates
      // that round's position is never built from hostile input.
      [[startedH, ticketReadH, postureH, lensesH(MANDATED), openedH(1), completedH("gate"), closedH(1), completedH("record"), prOpenedH, endedH], undefined],
      // A governing round reopened under its own id, every payload hostile.
      // The remediation sentence names a form, never a journal string, and it
      // has THREE arms, each interpolating a different journal position: a key
      // closed and reopened, a key announced twice with no close between, and a
      // version-2 opening that names itself.
      [[startedH, ticketReadH, postureH, lensesH(MANDATED), openedH(1), closedH(1), openedH(1), closedH(1), completedH("gate"), completedH("record"), prOpenedH, endedH], TREE],
      [[startedH, ticketReadH, postureH, lensesH(MANDATED), openedH(1), openedH(1), closedH(1), completedH("gate"), completedH("record"), prOpenedH, endedH], TREE],
      [[startedH, ticketReadH, postureH, lensesH(MANDATED), openedSelfH, closedSelfH, completedH("gate"), completedH("record"), prOpenedH, endedH], TREE],
    ];

    const covered = new Set<string>();
    const arms = new Set<string>();
    for (const [steps, treeSha] of poisoned) {
      const diagnostics = explain(steps, treeSha);
      expect(diagnostics.explanations.length).toBeGreaterThan(0);
      for (const explanation of diagnostics.explanations) {
        expect(explanation.because).not.toContain("\u001b");
        expect(explanation.because).not.toContain("missing: (none)");
        expect(explanation.because).not.toContain("\n");
        covered.add(explanation.violation);
        // Which BRANCH of the two-armed explanations this vector entered, so
        // the closing assertion is about arms rather than identifiers.
        if (explanation.violation === "round-reopened-under-same-id") {
          arms.add(`round-reopened-under-same-id|${
            explanation.because.includes("already closed at seq") ? "prior close"
              : explanation.because.includes("was already announced at seq") ? "prior opening"
              : "self-naming"
          }`);
        }
        if (explanation.violation === "gate-before-closed-round" || explanation.violation === "gate-reported-before-closed-round") {
          arms.add(`${explanation.violation}|${
            !explanation.because.includes("has no closed round this row accepts") ? "ordered"
              : explanation.because.includes("carries no round whose latest opening") ? "no round"
              : "other tree"
          }`);
        }
      }
    }
    // Every builder ran against attacker-chosen payloads, not only the four a
    // single shape happens to provoke — and ARMS, not merely identifiers: an
    // explanation that reaches a reader by one branch of a conditional is not
    // protected by a hostile vector that only ever takes the other.
    expect([...covered].sort()).toEqual([...RUN_JOURNAL_VIOLATIONS].sort());
    expect([...arms].sort()).toEqual([
      "gate-before-closed-round|no round",
      "gate-before-closed-round|ordered",
      "gate-before-closed-round|other tree",
      "gate-reported-before-closed-round|no round",
      "gate-reported-before-closed-round|ordered",
      "gate-reported-before-closed-round|other tree",
      "round-reopened-under-same-id|prior close",
      "round-reopened-under-same-id|prior opening",
      "round-reopened-under-same-id|self-naming",
    ]);
  });

  it("inherits nothing on an unbound reading, where the cause was never raised", () => {
    // The inheritance is guarded twice: no accepted round AND a record that
    // supplied the trees which could have accepted one. Only the first half is
    // obvious; drop the second and an UNBOUND reading - the one `runs show`,
    // `buildRunExport` and the run server all take - starts naming
    // `round-not-bound-to-record` as the cause of its gate warning, while that
    // violation is not in the list beside it and cannot be, because it is only
    // ever raised against a record. A readout that points at a warning it does
    // not carry is worse than one that explains nothing.
    const noRound = [started, ticketRead, posture, lenses(), completed("gate"), completed("record"), prOpened, ended];
    expect(evaluate(noRound).violations).not.toContain("round-not-bound-to-record");
    expect(by(explain(noRound), "gate-before-closed-round")?.consequenceOf).toBeUndefined();
    const reportedNoRound = [started, ticketRead, posture, lenses(), gateReported, prOpened, ended];
    expect(evaluate(reportedNoRound).violations).not.toContain("round-not-bound-to-record");
    expect(by(explain(reportedNoRound), "gate-reported-before-closed-round")?.consequenceOf).toBeUndefined();
  });

  it("says nothing about a round binding when no record bound the reading", () => {
    // The readout evaluates unbound, and an unbound reading has no record whose
    // candidate a round could have bound. Naming one anyway would answer a
    // question nobody asked, in the vocabulary of a record that is not there.
    expect(explain(COMPLETE).roundBinding).toBeUndefined();
    expect(explain(COMPLETE, TREE).roundBinding).toBe("record-tree");
  });

  it("inherits the same cause for a reported gate as for a completed one", () => {
    // The adopter shape: no product command ran, so `gate.reported` stands in
    // the completion's ordered place. It is the shape the reproduction is
    // about, and the inheritance has to reach it too.
    const diagnostics = explain(EXECUTOR_ONLY, RECORDED);
    expect(evaluate(EXECUTOR_ONLY, RECORDED).violations).toContain("gate-reported-before-closed-round");
    expect(by(diagnostics, "gate-reported-before-closed-round")?.consequenceOf).toBe("round-not-bound-to-record");
    // Both positions named, exactly: the sentence's whole value is that its
    // numbers are lookup keys into `runs show`, so a swapped pair would be
    // worse than no numbers at all.
    expect(by(diagnostics, "gate-reported-before-closed-round")?.because).toBe(
      "the governing gate.reported at seq 7 has no closed round this row accepts: the governing round closed at seq 6 binds a candidate tree that is not the record's and is not among the 0 the record's verified review-neutral projection accepts",
    );
    // And where the round IS accepted, the same identifier means the ordering
    // defect it names, with no cause inherited from a binding that is fine.
    const misreported = [started, ticketRead, posture, lenses(), opened(1), gateReported, closed(1), prOpened, ended];
    expect(by(explain(misreported, TREE), "gate-reported-before-closed-round")?.consequenceOf).toBeUndefined();
    expect(by(explain(misreported, TREE), "gate-reported-before-closed-round")?.because).toBe(
      "the governing gate.reported at seq 6 precedes the governing closed round at seq 7, so that reported gate did not stand on a completed review",
    );
  });

  it("tells a malformed mandated declaration apart from a well-formed one that disagrees", () => {
    // One identifier, two different facts. A journal that declared a proper
    // pair and a caller who named another pair is a disagreement about WHICH
    // lenses were mandated; a journal that declared one id is a malformed
    // declaration. Reading the second sentence under the first fact would send
    // an operator to fix a declaration that is not broken.
    const malformed = [started, ticketRead, posture, lenses(["lens.outcome-correctness"]), opened(1), closed(1), completed("gate"), completed("record"), prOpened, ended];
    expect(by(explain(malformed), "mandated-pair-mismatch")?.because).toBe(
      "lens.selected at seq 4 does not declare a mandated pair of exactly two non-empty ids",
    );
    const disagreeing = [started, ticketRead, posture, lenses(["lens.security", "lens.performance"]), opened(1), closed(1), completed("gate"), completed("record"), prOpened, ended];
    expect(by(explain(disagreeing), "mandated-pair-mismatch")?.because).toBe(
      "lens.selected at seq 4 declares a mandated set differing from the 2 id(s) the caller supplied with --mandated-lens",
    );
  });

  it("explains exactly the violations the evaluator raises, in the same order, for every reject vector", () => {
    // The two public readers share one pass, and this is the pin that keeps
    // them sharing it: a violation raised without a `because` is impossible
    // only for as long as one writer appends to both lists.
    const vectors: readonly (readonly [readonly Step[], string | undefined, readonly string[]])[] = [
      [[ticketRead, started, posture, lenses(), opened(1), closed(1), completed("gate"), completed("record"), prOpened, ended], undefined, []],
      [[started, ticketRead, lenses(), opened(1), posture, closed(1), completed("gate"), completed("record"), prOpened, ended], undefined, []],
      [[started, ticketRead, posture, lenses(), closed(1), opened(1), opened(2), closed(2), completed("gate"), completed("record"), prOpened, ended], undefined, []],
      [[started, ticketRead, posture, lenses(), opened(1), completed("gate"), closed(1), completed("record"), prOpened, ended], undefined, []],
      [[started, ticketRead, posture, lenses(), opened(1), closed(1), completed("record"), completed("gate"), prOpened, ended], undefined, []],
      [[started, ticketRead, posture, lenses(), opened(1), closed(1), prOpened, completed("gate"), completed("record"), ended], undefined, []],
      [[started, ticketRead, posture, lenses(), opened(1), closed(1), completed("gate"), completed("record"), ended, prOpened], undefined, []],
      [[started, ticketRead, posture, lenses(), opened(1), gateReported, closed(1), prOpened, ended], undefined, []],
      [[started, ticketRead, posture, lenses(), opened(1), closed(1), prOpened, gateReported, ended], undefined, []],
      [[started, ticketRead, posture, lenses(["lens.outcome-correctness"]), opened(1), closed(1), completed("gate"), completed("record"), prOpened, ended], undefined, []],
      [[started, ticketRead, posture, lenses(), opened(1), closed(1), prOpened, ended], OTHER_TREE, []],
      [ATHENA, RECORDED, []],
      [ATHENA, RECORDED, [REVIEWED]],
      [[started, ticketRead, posture, lenses(), v2Round(opened(1), "round-1"), v2Round(closed(1), "round-1"),
        v2Round(opened(1), "round-1", "round-1"), v2Round(closed(1), "round-1"),
        completed("gate"), completed("record"), prOpened, ended], TREE, []],
    ];
    const covered = new Set<string>();
    for (const [steps, treeSha, reviewed] of vectors) {
      const events = journal(steps);
      const evaluation = evaluateRunJournal(events, treeSha, MANDATED, reviewed);
      const diagnostics = explainRunJournal(events, treeSha, MANDATED, reviewed);
      expect(diagnostics.explanations.map((entry) => entry.violation)).toEqual([...evaluation.violations]);
      for (const explanation of diagnostics.explanations) {
        // Anchored to its OWN subject, not merely non-empty: the sentences are
        // what this delivery ships, and a reason that named the wrong entry
        // would pass every check that only counted characters.
        expect(explanation.because).toContain(BECAUSE[explanation.violation]);
        expect(explanation.blocksAdmission).toBe(false);
        covered.add(explanation.violation);
      }
    }
    expect([...covered].sort()).toEqual([...RUN_JOURNAL_VIOLATIONS].sort());
  });
});
