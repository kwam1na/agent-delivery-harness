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
import { describe, expect, it } from "vitest";
import {
  RUN_JOURNAL_REQUIRED_ENTRIES,
  RUN_JOURNAL_VIOLATIONS,
  evaluateRunJournal,
  type RunJournalRequiredEntry,
  type RunJournalViolation,
} from "./run-journal-completeness.ts";
import { runPrimaryTicket, type RunEvent, type RunEventKind } from "./run-event.ts";

const TREE = "a".repeat(40);
const OTHER_TREE = "b".repeat(40);
const MANDATED = ["lens.outcome-correctness", "lens.adversarial-testing"];
const COST = { unit: "usd", total: 1, reportedBy: "claude-code" };

interface Step {
  readonly kind: RunEventKind;
  readonly payload: Record<string, unknown>;
  readonly cli?: true;
}

const journal = (steps: readonly Step[]): readonly RunEvent[] =>
  steps.map((step, index) => {
    const payload = step.payload;
    const mirrored: Record<string, unknown> = {};
    if (typeof payload["ticket"] === "string") mirrored["ticket"] = payload["ticket"];
    if (typeof payload["candidateTreeSha"] === "string") mirrored["candidateTreeSha"] = payload["candidateTreeSha"];
    return {
      version: "run-event/1",
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
 * `ticket.read` is the run's primary ticket and an entry that omits `ticket`
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
        journal([started, ticketRead, posture, lenses(), opened(1), closed(1), closed(2), opened(2), completed("gate"), completed("record"), prOpened, ended]),
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
    const reGatedAfterPr = journal([
      started,
      ticketRead,
      posture,
      lenses(),
      opened(1),
      closed(1),
      completed("gate"),
      completed("record"),
      prOpened,
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
