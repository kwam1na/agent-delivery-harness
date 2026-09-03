/**
 * Run-journal completeness: does this journal describe a whole delivery run,
 * and in the order a whole run happens?
 *
 * OBSERVABILITY, NEVER EVIDENCE. Nothing authoritative reads this. Anything
 * the owner executes can append to the store, so a hostile executor can
 * batch-emit a plausible journal; the ordering rule makes that a deliberate
 * act rather than an afterthought, and no gate, admission, or record decision
 * depends on the answer.
 *
 * TWO CLOSED SETS, ONE PLACE EACH. `missing` carries required entries by name
 * and `violations` carries violated constraints by identifier. Both
 * vocabularies are enumerated exactly once — in `REQUIRED` and `VIOLATION`
 * below — and the evaluator emits only members of them, so a renamed or
 * dropped entry is a visible edit here and a red assertion in the suite rather
 * than a name that quietly stops appearing.
 *
 * ANCHORED CONSTRAINTS SKIP, THEY DO NOT FAIL. A constraint phrased over the
 * `gate` completion, the `record` completion, or (in an executor-only journal)
 * `gate.reported` is evaluated only when every anchor it names is present.
 * When one is absent the constraint is skipped and the absent anchor is
 * reported MISSING — an unfinished run is incomplete, not ill-ordered.
 */

import type { RunEvent, RunEventKind } from "./run-event.ts";

// ── The closed vocabularies ────────────────────────────────────────────────
//
// These two records are the ONLY place a violation identifier or a required
// entry name is spelled. Everything below refers to them by member.

const VIOLATION = Object.freeze({
  runStartedNotFirst: "run-started-not-first",
  prerequisitesAfterFirstRound: "prerequisites-after-first-round",
  roundClosedBeforeOpened: "round-closed-before-opened",
  gateBeforeClosedRound: "gate-before-closed-round",
  recordBeforeGate: "record-before-gate",
  prBeforeGate: "pr-before-gate",
  runEndedNotLast: "run-ended-not-last",
  gateReportedBeforeClosedRound: "gate-reported-before-closed-round",
  prBeforeGateReported: "pr-before-gate-reported",
  mandatedPairMismatch: "mandated-pair-mismatch",
  roundNotBoundToRecord: "round-not-bound-to-record",
} as const);

const REQUIRED = Object.freeze({
  runStarted: "run.started",
  ticketRead: "ticket.read",
  postureDeclared: "posture.declared",
  lensSelected: "lens.selected",
  roundOpened: "review.round.opened",
  roundClosed: "review.round.closed",
  gateCompletion: "command.completed:gate",
  recordCompletion: "command.completed:record",
  prOpened: "pr.opened",
  runEnded: "run.ended",
  gateReported: "gate.reported",
} as const);

/**
 * One identifier per ordering constraint the completeness rule states, in the
 * order it states them. `run-started-not-first` and `run-ended-not-last` are
 * the evaluator's own detections of conditions the STORE also refuses at
 * append time; the store's refusal is a separate enforcement with no
 * identifier of its own.
 */
export const RUN_JOURNAL_VIOLATIONS = Object.freeze([
  VIOLATION.runStartedNotFirst,
  VIOLATION.prerequisitesAfterFirstRound,
  VIOLATION.roundClosedBeforeOpened,
  VIOLATION.gateBeforeClosedRound,
  VIOLATION.recordBeforeGate,
  VIOLATION.prBeforeGate,
  VIOLATION.runEndedNotLast,
  VIOLATION.gateReportedBeforeClosedRound,
  VIOLATION.prBeforeGateReported,
  VIOLATION.mandatedPairMismatch,
  VIOLATION.roundNotBoundToRecord,
] as const);

export type RunJournalViolation = (typeof RUN_JOURNAL_VIOLATIONS)[number];

/**
 * The names `missing` can carry. The two CLI completions are named by kind AND
 * command, so each is its own entry.
 */
export const RUN_JOURNAL_REQUIRED_ENTRIES = Object.freeze([
  REQUIRED.runStarted,
  REQUIRED.ticketRead,
  REQUIRED.postureDeclared,
  REQUIRED.lensSelected,
  REQUIRED.roundOpened,
  REQUIRED.roundClosed,
  REQUIRED.gateCompletion,
  REQUIRED.recordCompletion,
  REQUIRED.prOpened,
  REQUIRED.runEnded,
  REQUIRED.gateReported,
] as const);

export type RunJournalRequiredEntry = (typeof RUN_JOURNAL_REQUIRED_ENTRIES)[number];

/** Every reader compares these by exact equality. */
export const RUN_JOURNAL_STATUSES = Object.freeze(["complete", "complete-executor-only", "incomplete", "absent"] as const);

export type RunJournalStatus = (typeof RUN_JOURNAL_STATUSES)[number];

export interface RunJournalEvaluation {
  readonly status: RunJournalStatus;
  readonly missing: readonly RunJournalRequiredEntry[];
  readonly violations: readonly RunJournalViolation[];
  /**
   * Whether a record's tree sha bound the round constraints. False means the
   * readout is unbound to a record and every rule phrased over the record's
   * tree sha was evaluated over any paired round.
   */
  readonly boundToRecord: boolean;
}

/**
 * One journal's completeness as a REPORTED ROW, rather than as the evaluator's
 * own return: the shape a reader — today only `verify` — attaches to something
 * it prints or returns.
 *
 * It carries the resolution as well as the verdict, because the question an
 * operator is really asking is "was THIS candidate journaled", and answering it
 * means saying which run was read and which other runs bound the same
 * candidate. `attestation` is the constant `"self"` for the same reason every
 * readout carries the label in prose: a row derived from a store anyone who can
 * execute in this repository may append to is never anything else.
 *
 * `absent` is the honest answer to "no journal bound this candidate", and it
 * carries no run id and no missing entries — nothing was evaluated.
 */
export interface RunJournalRow {
  /** The run whose journal was evaluated; absent when the status is `absent`. */
  readonly runId?: string;
  /** The other runs whose journals bind the same candidate, most recent first. */
  readonly alsoMatching?: readonly string[];
  readonly status: RunJournalStatus;
  readonly missing: readonly RunJournalRequiredEntry[];
  readonly violations?: readonly RunJournalViolation[];
  readonly attestation: "self";
}

// ── Journal projections ────────────────────────────────────────────────────

interface Indexed {
  readonly at: number;
  readonly event: RunEvent;
}

const payloadOf = (event: RunEvent): Record<string, unknown> =>
  typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};

const first = (events: readonly Indexed[]): Indexed | undefined => events[0];
const last = (events: readonly Indexed[]): Indexed | undefined => events[events.length - 1];

function indexBy(events: readonly RunEvent[], kind: RunEventKind): Indexed[] {
  return events.flatMap((event, at) => (event.kind === kind ? [{ at, event }] : []));
}

/**
 * A CLI-written completion of one registered command; nothing else counts.
 *
 * WHICH OF THEM, WHERE A COMMAND WAS RUN TWICE (settled 2026-09-03 under
 * V26-1709, closing `OC-1570-D1` and `AT-1570-02` from V26-1548's deferral 3).
 * The GOVERNING completion is the LAST — a command is re-run to SUPERSEDE its
 * earlier outcome, so the completion `gate-before-closed-round` and
 * `record-before-gate` are about is the one the delivery finally stood on.
 * Binding the first would judge a delivery on a gate it had already abandoned,
 * and would let a gate re-run AFTER the record was written read as clean
 * because an earlier gate happened to precede it. `pick` is what lets the one
 * constraint that asks a different question ask it: see `prBeforeGate` below.
 *
 * The decision was taken against a real journal rather than a synthetic one.
 * `run-01c68dea9d1d5fd0` in this repository's own run store — the V26-1580
 * delivery — runs the loop twice: it gates at index 13, records at 14, opens
 * its pull request at 17, then re-gates at 26 and re-records at 27. Under the
 * governing-completion reading its gate and record orderings are judged on the
 * second pass, which is the pass the delivery was recorded from.
 */
function cliCompletion(
  events: readonly RunEvent[],
  command: string,
  pick: (entries: readonly Indexed[]) => Indexed | undefined = last,
): Indexed | undefined {
  return pick(
    indexBy(events, "command.completed").filter(
      (entry) => entry.event.actor.role === "cli" && payloadOf(entry.event)["command"] === command,
    ),
  );
}

interface Pairing {
  /** Rounds whose opened event precedes a closed event of the same round. */
  readonly paired: readonly { readonly round: unknown; readonly openedAt: number; readonly closedAt: number; readonly closed: RunEvent }[];
  /** Rounds that carry both an opened and a closed event, closed first. */
  readonly inverted: boolean;
}

function pairRounds(events: readonly RunEvent[]): Pairing {
  const opened = indexBy(events, "review.round.opened");
  const closed = indexBy(events, "review.round.closed");
  const rounds = new Set<unknown>([...opened, ...closed].map((entry) => payloadOf(entry.event)["round"]));
  const paired: { round: unknown; openedAt: number; closedAt: number; closed: RunEvent }[] = [];
  let inverted = false;
  for (const round of rounds) {
    const firstOpened = first(opened.filter((entry) => payloadOf(entry.event)["round"] === round));
    const firstClosed = first(closed.filter((entry) => payloadOf(entry.event)["round"] === round));
    if (firstOpened === undefined || firstClosed === undefined) continue;
    if (firstClosed.at < firstOpened.at) {
      inverted = true;
      continue;
    }
    paired.push({ round, openedAt: firstOpened.at, closedAt: firstClosed.at, closed: firstClosed.event });
  }
  return { paired, inverted };
}

/**
 * Whether the journal carries one required entry, by that entry's own name.
 *
 * ONE PREDICATE, TWO READERS. `missing` below is this function's complement
 * over the required list, and every other reader — the `runs show` readout's
 * `present` row among them — answers from here too. Two entries are not plain
 * kind lookups: a completion counts only where the CLI wrote it, so an
 * executor's claim to have run a command is never read as the product's, and a
 * closed round counts only where it pairs with an open of the same number that
 * precedes it. Answering either of those twice is how a readout comes to name
 * one entry as both present and missing.
 */
export function runJournalCarries(events: readonly RunEvent[], entry: RunJournalRequiredEntry): boolean {
  switch (entry) {
    case REQUIRED.gateCompletion:
      return cliCompletion(events, "gate") !== undefined;
    case REQUIRED.recordCompletion:
      return cliCompletion(events, "record") !== undefined;
    case REQUIRED.roundClosed:
      return pairRounds(events).paired.length > 0;
    default:
      return indexBy(events, entry).length > 0;
  }
}

// ── The evaluator ──────────────────────────────────────────────────────────

/**
 * Evaluates one journal's completeness.
 *
 * @param events the journal in `seq` order.
 * @param treeSha the record's candidate tree sha, when a record supplies one.
 *   Only `verify` has one; the viewer supplies none and the readout is then
 *   labeled unbound to a record.
 * @param mandatedLensIds the two mandated lens ids, when the operator supplies
 *   them. Without them the mandate check is arity-and-non-emptiness only.
 */
export function evaluateRunJournal(
  events: readonly RunEvent[],
  treeSha?: string,
  mandatedLensIds?: readonly string[],
): RunJournalEvaluation {
  const missing: RunJournalRequiredEntry[] = [];
  const violations: RunJournalViolation[] = [];
  const boundToRecord = treeSha !== undefined;

  const runStarted = first(indexBy(events, "run.started"));
  const ticketRead = first(indexBy(events, "ticket.read"));
  const postureDeclared = first(indexBy(events, "posture.declared"));
  const lensSelected = first(indexBy(events, "lens.selected"));
  const roundsOpened = indexBy(events, "review.round.opened");
  const prOpened = first(indexBy(events, "pr.opened"));
  const runEnded = first(indexBy(events, "run.ended"));
  const gateReported = first(indexBy(events, "gate.reported"));
  const completions = indexBy(events, "command.completed");
  const gateCompletion = cliCompletion(events, "gate");
  const recordCompletion = cliCompletion(events, "record");
  /**
   * The gate the pull request had to follow, which is the OPENING one and not
   * the governing one. `pr-before-gate` asks whether the delivery opened its
   * pull request before it had gated at all; every other gate-anchored
   * constraint asks about the gate the delivery finally stood on. Anchored on
   * the governing gate this would fire on the ordinary review loop — gate,
   * record, open the pull request, then a further round and a further gate —
   * where the pull request precedes the last gate by construction and nothing
   * is out of order, and `run-01c68dea9d1d5fd0` is a journal in this
   * repository's own store with exactly that shape.
   */
  const openingGateCompletion = cliCompletion(events, "gate", first);

  /** No `command.completed` at all — an adopter that runs no product command. */
  const executorOnly = completions.length === 0;

  const { paired, inverted } = pairRounds(events);
  const qualifying = paired.filter((entry) => treeSha === undefined || payloadOf(entry.closed)["candidateTreeSha"] === treeSha);
  const requiredRound = first(
    qualifying.map((entry) => ({ at: entry.closedAt, event: entry.closed })).sort((left, right) => left.at - right.at),
  );

  // ── Required entries ─────────────────────────────────────────────────────
  //
  // Named in the declared order, each answered by the one shared predicate.
  // `gate.reported` is required only of an executor-only journal.
  for (const entry of RUN_JOURNAL_REQUIRED_ENTRIES) {
    if (entry === REQUIRED.gateReported && !executorOnly) continue;
    if (!runJournalCarries(events, entry)) missing.push(entry);
  }

  // ── Ordering constraints ─────────────────────────────────────────────────
  if (runStarted !== undefined && (runStarted.at !== 0 || indexBy(events, "run.started").length > 1)) {
    violations.push(VIOLATION.runStartedNotFirst);
  }

  // THE FIRST OF EACH PREREQUISITE KIND, NOT EVERY ENTRY OF IT. `ticketRead`,
  // `postureDeclared`, and `lensSelected` are each the FIRST of their kind, and
  // D12 binds exactly those three. A run may carry more than one ticket (D13),
  // and a delivery reads a further ticket mid-loop by design — a deferral's
  // follow-up item is filed and read during review, and a posture re-declared
  // after a finding is ordinary — so a second `ticket.read` or
  // `posture.declared` after the first round opened is CLEAN. What the
  // constraint is for is that the delivery started with its prerequisites in
  // hand before review opened, which the first of each kind establishes.
  const firstRound = first(roundsOpened);
  if (firstRound !== undefined) {
    const late = [ticketRead, postureDeclared, lensSelected].some((entry) => entry !== undefined && entry.at > firstRound.at);
    if (late) violations.push(VIOLATION.prerequisitesAfterFirstRound);
  }

  if (inverted) violations.push(VIOLATION.roundClosedBeforeOpened);

  if (gateCompletion !== undefined) {
    const closedFirst = qualifying.some((entry) => entry.closedAt < gateCompletion.at);
    if (!closedFirst) violations.push(VIOLATION.gateBeforeClosedRound);
    if (recordCompletion !== undefined && recordCompletion.at < gateCompletion.at) violations.push(VIOLATION.recordBeforeGate);
  }

  if (openingGateCompletion !== undefined && prOpened !== undefined && prOpened.at < openingGateCompletion.at) {
    violations.push(VIOLATION.prBeforeGate);
  }

  if (runEnded !== undefined && runEnded.at !== events.length - 1) violations.push(VIOLATION.runEndedNotLast);

  // `gate.reported` is ordered only where it stands in for the gate
  // completion: in a journal that has any CLI completion it carries no
  // ordering constraint and the CLI completion's constraints govern.
  if (executorOnly && gateReported !== undefined) {
    const closedFirst = qualifying.some((entry) => entry.closedAt < gateReported.at);
    if (!closedFirst) violations.push(VIOLATION.gateReportedBeforeClosedRound);
    if (prOpened !== undefined && prOpened.at < gateReported.at) violations.push(VIOLATION.prBeforeGateReported);
  }

  if (lensSelected !== undefined) {
    const mandated = payloadOf(lensSelected.event)["mandated"];
    const ids = Array.isArray(mandated) ? mandated : undefined;
    const wellFormed = ids !== undefined && ids.length === 2 && ids.every((id) => typeof id === "string" && id.length > 0);
    const agreed =
      mandatedLensIds === undefined ||
      (ids !== undefined && [...ids].map(String).sort().join(" ") === [...mandatedLensIds].sort().join(" "));
    if (!wellFormed || !agreed) violations.push(VIOLATION.mandatedPairMismatch);
  }

  if (treeSha !== undefined && requiredRound === undefined) violations.push(VIOLATION.roundNotBoundToRecord);

  // ── Status ───────────────────────────────────────────────────────────────
  //
  // The status describes the JOURNAL, not the repository: any violation forces
  // `incomplete` whatever the writer mix.
  const outstanding = new Set<RunJournalRequiredEntry>(missing);
  if (executorOnly) {
    // The two CLI completions are missing by construction and are exactly what
    // `complete-executor-only` means; nothing else may be.
    outstanding.delete(REQUIRED.gateCompletion);
    outstanding.delete(REQUIRED.recordCompletion);
  } else {
    outstanding.delete(REQUIRED.gateReported);
  }

  const status: RunJournalStatus =
    violations.length > 0 || outstanding.size > 0 ? "incomplete" : executorOnly ? "complete-executor-only" : "complete";

  return { status, missing, violations, boundToRecord };
}
