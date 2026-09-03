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
