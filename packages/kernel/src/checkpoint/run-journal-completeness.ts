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
 *
 * EVERY VIOLATION EXPLAINS ITSELF. `explainRunJournal` answers, for each
 * violation this evaluator raised, the two questions a reader of a bare
 * identifier cannot answer: why it was raised, and whether it bears on the
 * current admission decision. The second answer is the constant `false`,
 * because nothing authoritative reads a journal — see the file header — and
 * the type says so rather than leaving a reader to infer it from prose. The
 * first is composed only from this file's own identifiers and the journal's
 * integer `seq` positions, NEVER from journal free text: a row anyone who can
 * execute here may append to is printed under a line an operator reads as a
 * verdict, so no attacker-chosen string may reach it.
 *
 * ONE ROOT CAUSE IS NOT TWO DEFECTS. `gate-before-closed-round` and
 * `gate-reported-before-closed-round` are each raised from two structurally
 * different conditions — a genuinely mis-ordered gate, and a governing round
 * bound to a candidate this record does not accept. In the second case the
 * explanation names `round-not-bound-to-record` as the warning it is a
 * consequence of, so an operator reading three rows does not go looking for
 * three separate mistakes.
 *
 * A REOPENED ROUND IS ONE ROUND, AND A REFUSED RE-GATE IS NOT THE GATE. Two
 * readings this evaluator got wrong until V26-2075, both found by real journals
 * in this repository's own store rather than by a fixture:
 *
 *   - A round replayed onto a moved base is REOPENED, not re-reviewed. Its
 *     opening carries a new `roundId` and names its predecessor in
 *     `reopensRoundId`; the chain is one logical round, an earlier close in it
 *     can be the review the gate stood on, and `logicalRounds` reports the
 *     count the bound is spent against. Reopening under the ORIGINAL id — all a
 *     version-1 journal can do, and what `run-752c1ec0d1804258` did at seq 84 —
 *     leaves two openings under one key. That is now paired from the LATEST
 *     opening and reported as `round-reopened-under-same-id` with the fix in
 *     the message, in place of the false `gate-before-closed-round` and
 *     `round-not-bound-to-record` pair it used to draw.
 *   - The governing CLI completion is the ADMITTING one. See `admitting`.
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
  roundReopenedUnderSameId: "round-reopened-under-same-id",
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
  VIOLATION.roundReopenedUnderSameId,
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
   * tree sha was evaluated over the governing paired round without a tree filter.
   */
  readonly boundToRecord: boolean;
}

/**
 * How the governing closed round's candidate reached the record this row was
 * resolved for. Only a caller that supplied a record tree sha has one.
 *
 * `reviewed-tree` is the case this whole vocabulary exists for: the round was
 * closed against an EARLIER raw tree, and the record's own verified
 * review-neutral projection is what accepted it. Saying so is not a claim that
 * the two trees are equal — they are not, and the row prints both.
 */
export const RUN_JOURNAL_ROUND_BINDINGS = Object.freeze(["record-tree", "reviewed-tree", "unbound"] as const);

export type RunJournalRoundBinding = (typeof RUN_JOURNAL_ROUND_BINDINGS)[number];

/**
 * One violation, with the two things its identifier alone does not say.
 *
 * `because` is composed in this file from this file's own identifiers and the
 * journal's integer `seq` positions only; no journal-supplied string reaches
 * it. `blocksAdmission` is the literal `false` rather than a boolean, because
 * there is no journal and no violation for which it could be anything else:
 * no gate, admission, or record decision reads this evaluator's output, and a
 * field that could be `true` would invite a caller to look for the case where
 * it is.
 */
export interface RunJournalExplanation {
  readonly violation: RunJournalViolation;
  readonly because: string;
  readonly blocksAdmission: false;
  /**
   * The violation this one merely restates, where it has one. Set only where
   * the SAME journal fact raised both, so an operator reading two rows looks
   * for one mistake rather than two.
   */
  readonly consequenceOf?: RunJournalViolation;
}

/**
 * The explanatory companion to {@link RunJournalEvaluation}, returned
 * separately so the evaluation's own shape — which several callers compare by
 * exact equality — stays as it was.
 */
export interface RunJournalDiagnostics {
  /** One entry per violation the same inputs raise, in the same order. */
  readonly explanations: readonly RunJournalExplanation[];
  /** Absent unless a record tree sha bound the evaluation. */
  readonly roundBinding?: RunJournalRoundBinding;
  /**
   * Rounds the bound was spent on, with each reopen chain counted once. Not a
   * violation and not a verdict: the journal states no bound this evaluator
   * could compare it against, and the count is here so a reader of a journal
   * with thirteen openings and nine reviews is told which number is which.
   */
  readonly logicalRounds: number;
  /**
   * `command.completed:gate` entries positioned after the governing one, by
   * `seq`. REPORTED, NEVER GOVERNING: a gate re-run after the delivery had
   * already been admitted is an attempt that changed nothing, and saying so is
   * how an operator who sees a refusal at the end of a journal learns that it
   * is not the gate the delivery stood on. Absent when there are none.
   */
  readonly supersededGates?: readonly number[];
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
  /** Record tree used to resolve this row when a verified projection exists. */
  readonly recordTreeSha?: string;
  /** Raw trees the verified record says were actually reviewed. */
  readonly reviewedCandidateTreeShas?: readonly string[];
  /** One per violation above, in the same order; absent when there are none. */
  readonly explanations?: readonly RunJournalExplanation[];
  /** How the governing round's candidate reached this record. */
  readonly roundBinding?: RunJournalRoundBinding;
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
function completionsOf(events: readonly RunEvent[], command: string): readonly Indexed[] {
  return indexBy(events, "command.completed").filter(
    (entry) => entry.event.actor.role === "cli" && payloadOf(entry.event)["command"] === command,
  );
}

/**
 * THE ADMITTING COMPLETION, NOT MERELY THE LAST (settled 2026-09-15 under
 * V26-2075). `ok` is the CLI boundary's only admitting outcome — `gate` returns
 * it exactly where `runProviderBackedAdmission` admitted — so the completion a
 * delivery STOOD ON is the last admitting one, and a later `policy` refusal is
 * an attempt that changed nothing. Reading the last completion of any outcome
 * instead let a refused re-gate govern: `run-752c1ec0d1804258` in this
 * repository's own store — the V26-1504 delivery — gates `ok` at seq 95 and
 * records `ok` at 98, then replays the round onto a moved base and re-gates to
 * `policy` at 107 with a `policy` record at 110. Under the positional reading
 * the governing gate was the refusal at 107 and the governing record the
 * refusal at 110, so every gate-anchored constraint was answered about a pass
 * the delivery never made. Where nothing ever admitted there is no admitting
 * completion to prefer and the last one governs, so a delivery that never got
 * past its gate is still judged on the gate it has.
 */
const admitting = (entries: readonly Indexed[]): Indexed | undefined =>
  last(entries.filter((entry) => payloadOf(entry.event)["outcome"] === "ok")) ?? last(entries);

function cliCompletion(
  events: readonly RunEvent[],
  command: string,
  pick: (entries: readonly Indexed[]) => Indexed | undefined = admitting,
): Indexed | undefined {
  return pick(completionsOf(events, command));
}

interface Paired {
  readonly round: unknown;
  readonly openedAt: number;
  readonly closedAt: number;
  readonly opened: RunEvent;
  readonly closed: RunEvent;
  /** The opening this pair reads from follows a close of its own round key. */
  readonly reopenedUnderSameId: boolean;
}

interface Pairing {
  /** Rounds whose opened event precedes a closed event of the same round. */
  readonly paired: readonly Paired[];
  /** Rounds that carry both an opened and a closed event, closed first. */
  readonly inverted: boolean;
}

// A replay keeps its counted round number, but has a fresh v2 roundId. Both
// fields must agree within a pair; legacy journals retain numeric pairing.
function roundKey(event: RunEvent): unknown {
  const payload = payloadOf(event);
  return event.version === "run-event/2"
    ? JSON.stringify([payload["roundId"], payload["round"]])
    : payload["round"];
}

/**
 * WHICH OPENING A ROUND KEY IS READ FROM, WHERE ONE KEY WAS OPENED TWICE
 * (settled 2026-09-15 under V26-2075). The LATEST opening of the key, paired
 * with the first close that follows it. Pairing the FIRST of each instead left
 * a key reopened under its own id with a pair — the original one — that
 * `governingRound` could never select, because it selects on the journal's
 * latest opening and latest close; the key then contributed no governing round
 * at all and the journal drew `gate-before-closed-round` and
 * `round-not-bound-to-record` for an ordering that was correct.
 * `run-752c1ec0d1804258` reopens `round-6` under `round-6` at seq 84, and the
 * runbook carried the resulting pair of warnings as a known-cosmetic defect of
 * `verify --require-run-journal`. A key whose latest opening has no later close
 * still contributes nothing: an unfinished reopen may not borrow the earlier
 * pass's completed review, which is the rule `governingRound` already stated.
 */
function pairRounds(events: readonly RunEvent[]): Pairing {
  const opened = indexBy(events, "review.round.opened");
  const closed = indexBy(events, "review.round.closed");
  const rounds = new Set<unknown>([...opened, ...closed].map((entry) => roundKey(entry.event)));
  const paired: Paired[] = [];
  let inverted = false;
  for (const round of rounds) {
    const openings = opened.filter((entry) => roundKey(entry.event) === round);
    const closes = closed.filter((entry) => roundKey(entry.event) === round);
    const firstOpened = first(openings);
    const firstClosed = first(closes);
    if (firstOpened === undefined || firstClosed === undefined) continue;
    if (firstClosed.at < firstOpened.at) {
      inverted = true;
      continue;
    }
    const opening = last(openings);
    if (opening === undefined) continue;
    const closing = first(closes.filter((entry) => entry.at > opening.at));
    if (closing === undefined) continue;
    paired.push({
      round,
      openedAt: opening.at,
      closedAt: closing.at,
      opened: opening.event,
      closed: closing.event,
      reopenedUnderSameId: closes.some((entry) => entry.at < opening.at) || selfReopening(opening.event),
    });
  }
  return { paired, inverted };
}

/** A v2 opening that names ITSELF as the round it continues. */
function selfReopening(event: RunEvent): boolean {
  const payload = payloadOf(event);
  return typeof payload["reopensRoundId"] === "string" && payload["reopensRoundId"] === payload["roundId"];
}

/**
 * ONE LOGICAL ROUND PER REOPEN CHAIN.
 *
 * A round reopened under a new `roundId` naming its predecessor in
 * `reopensRoundId` is the SAME review continued on a replayed candidate, not a
 * second review: `obtain-review` reopens rather than counts when the delivered
 * bytes are unchanged, so the bound is spent by what was reviewed and not by
 * how many times a replay was announced. This groups the journal's round keys
 * into those chains, which is what lets the count below fold them and what lets
 * the gate constraint read an earlier close of the SAME chain.
 *
 * A same-id reopen lands in one chain for free — the two openings share a key —
 * which is why it is reported rather than corrected: the chain reads right and
 * the two openings are still indistinguishable to every other reader.
 */
function reopenChains(events: readonly RunEvent[]): (key: unknown) => string {
  const opened = indexBy(events, "review.round.opened");
  const asString = (key: unknown): string => JSON.stringify(key ?? null);
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let current = key;
    while (parent.get(current) !== undefined && parent.get(current) !== current) current = parent.get(current) as string;
    return current;
  };
  const union = (a: string, b: string): void => {
    const [rootA, rootB] = [find(a), find(b)];
    if (rootA !== rootB) parent.set(rootA, rootB);
  };
  const byRoundId = new Map<string, Indexed>();
  for (const entry of opened) {
    const key = asString(roundKey(entry.event));
    if (parent.get(key) === undefined) parent.set(key, key);
    const roundId = payloadOf(entry.event)["roundId"];
    if (typeof roundId === "string" && !byRoundId.has(roundId)) byRoundId.set(roundId, entry);
  }
  for (const entry of opened) {
    const payload = payloadOf(entry.event);
    const reopens = payload["reopensRoundId"];
    if (typeof reopens !== "string" || selfReopening(entry.event)) continue;
    const predecessor = byRoundId.get(reopens);
    // An unresolvable `reopensRoundId` names no opening in this journal, so
    // there is no chain to join and the round stands on its own.
    if (predecessor !== undefined) union(asString(roundKey(entry.event)), asString(roundKey(predecessor.event)));
  }
  return (key: unknown) => find(asString(key));
}

/** How many rounds the bound was actually spent on. */
export function runJournalLogicalRounds(events: readonly RunEvent[]): number {
  const chainOf = reopenChains(events);
  return new Set(indexBy(events, "review.round.opened").map((entry) => chainOf(roundKey(entry.event)))).size;
}

function governingRound(events: readonly RunEvent[], pairing = pairRounds(events)): Pairing["paired"][number] | undefined {
  // Neither a new opening without a close nor an unmatched later close can
  // borrow the earlier candidate's completed review. Historical rounds remain
  // in the journal; only this pair can support the governing gate.
  const latestOpened = last(indexBy(events, "review.round.opened"));
  const latestClosed = last(indexBy(events, "review.round.closed"));
  return latestOpened === undefined || latestClosed === undefined ? undefined :
    pairing.paired.find(entry => entry.openedAt === latestOpened.at && entry.closedAt === latestClosed.at);
}

/**
 * Whether the journal carries one required entry, by that entry's own name.
 *
 * ONE PREDICATE, TWO READERS. `missing` below is this function's complement
 * over the required list, and every other reader — the `runs show` readout's
 * `present` row among them — answers from here too. Two entries are not plain
 * kind lookups: a completion counts only where the CLI wrote it, so an
 * executor's claim to have run a command is never read as the product's, and a
 * closed round counts only where the latest opening has its own later close.
 * Answering either of those twice is how a readout comes to name
 * one entry as both present and missing.
 */
export function runJournalCarries(events: readonly RunEvent[], entry: RunJournalRequiredEntry): boolean {
  switch (entry) {
    case REQUIRED.gateCompletion:
      return cliCompletion(events, "gate") !== undefined;
    case REQUIRED.recordCompletion:
      return cliCompletion(events, "record") !== undefined;
    case REQUIRED.roundClosed:
      return governingRound(events) !== undefined;
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
 * @param reviewedTreeShas additional raw trees accepted only after the caller
 *   has verified the record's retained review-neutral projection.
 */
export function evaluateRunJournal(
  events: readonly RunEvent[],
  treeSha?: string,
  mandatedLensIds?: readonly string[],
  reviewedTreeShas: readonly string[] = [],
): RunJournalEvaluation {
  const { status, missing, violations, boundToRecord } = analyze(events, treeSha, mandatedLensIds, reviewedTreeShas);
  return { status, missing, violations, boundToRecord };
}

/**
 * The same journal, read for WHY rather than for WHETHER.
 *
 * Takes the same arguments as {@link evaluateRunJournal} and shares its single
 * implementation, so the explanations cannot drift from the violations they
 * explain: an entry exists here exactly when the identifier appears there, in
 * that order. Call it with the arguments the evaluation was taken with — a
 * readout that evaluates unbound to a record explains unbound too.
 */
export function explainRunJournal(
  events: readonly RunEvent[],
  treeSha?: string,
  mandatedLensIds?: readonly string[],
  reviewedTreeShas: readonly string[] = [],
): RunJournalDiagnostics {
  const { explanations, roundBinding, logicalRounds, supersededGates } = analyze(events, treeSha, mandatedLensIds, reviewedTreeShas);
  return {
    explanations,
    logicalRounds,
    ...(roundBinding === undefined ? {} : { roundBinding }),
    ...(supersededGates === undefined ? {} : { supersededGates }),
  };
}

/**
 * The `seq` the store assigned, which is what `runs show` prints beside each
 * entry, so an explanation naming one can be looked up directly. It is a
 * validated positive integer in the event grammar — the only journal-derived
 * value an explanation may carry, and the reason explanations cannot smuggle
 * attacker-chosen text into a readout.
 */
const seqOf = (event: RunEvent): number => event.seq;

/** The one pass both public readers above project out of. */
function analyze(
  events: readonly RunEvent[],
  treeSha: string | undefined,
  mandatedLensIds: readonly string[] | undefined,
  reviewedTreeShas: readonly string[],
): RunJournalEvaluation & RunJournalDiagnostics {
  const missing: RunJournalRequiredEntry[] = [];
  const violations: RunJournalViolation[] = [];
  const explanations: RunJournalExplanation[] = [];
  const boundToRecord = treeSha !== undefined;
  /**
   * The one place a violation is recorded, so no arm can raise an identifier
   * without also saying why. `because` is this file's own prose; the only
   * journal-derived values it may interpolate are integer `seq` positions and
   * counts.
   */
  const raise = (violation: RunJournalViolation, because: string, consequenceOf?: RunJournalViolation): void => {
    violations.push(violation);
    explanations.push({ violation, because, blocksAdmission: false, ...(consequenceOf === undefined ? {} : { consequenceOf }) });
  };

  const runStarted = first(indexBy(events, "run.started"));
  // This is a linked attempt on an existing PR, not a claim that a prior gate
  // admits the new candidate. Every current round/gate/record rule still runs.
  const linkedRetry = runStarted?.event.version === "run-event/2" &&
    typeof payloadOf(runStarted.event)["predecessorRunId"] === "string";
  const ticketRead = first(indexBy(events, "ticket.read"));
  const postureDeclared = first(indexBy(events, "posture.declared"));
  const lensSelected = first(indexBy(events, "lens.selected"));
  const roundsOpened = indexBy(events, "review.round.opened");
  const prOpened = first(indexBy(events, "pr.opened"));
  const runEnded = first(indexBy(events, "run.ended"));
  const reportedGates = indexBy(events, "gate.reported");
  // The executor-written stand-in for the gate completion, chosen the same way:
  // `pass` is its admitting outcome, and a later `fail` is an attempt.
  const gateReported = last(reportedGates.filter((entry) => payloadOf(entry.event)["outcome"] === "pass")) ?? last(reportedGates);
  const openingGateReported = first(reportedGates);
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

  const pairing = pairRounds(events);
  const { inverted } = pairing;
  const acceptedTrees = new Set(treeSha === undefined ? [] : [treeSha, ...reviewedTreeShas]);
  const currentRound = governingRound(events, pairing);
  const requiredRound = currentRound !== undefined &&
    (treeSha === undefined || acceptedTrees.has(String(payloadOf(currentRound.closed)["candidateTreeSha"])))
    ? currentRound : undefined;

  /**
   * THE REVIEW THE GOVERNING GATE STOOD ON, WHICH MAY HAVE CLOSED EARLIER IN
   * THE SAME CHAIN. A round reopened after the gate is the same review replayed
   * onto a moved base, so the question `gate-before-closed-round` asks — did
   * this gate stand on a completed review of a candidate the record accepts —
   * is answered by ANY close of the governing round's own reopen chain that the
   * record accepts, not only by the last one. A FRESH round closing after the
   * gate is different and still fires: that is new review, and the gate that
   * preceded it did not stand on it.
   */
  const chainOf = reopenChains(events);
  const governingChain = currentRound === undefined ? undefined : chainOf(currentRound.round);
  const chainCloses = governingChain === undefined ? [] : indexBy(events, "review.round.closed").filter(
    (entry) => chainOf(roundKey(entry.event)) === governingChain &&
      (treeSha === undefined || acceptedTrees.has(String(payloadOf(entry.event)["candidateTreeSha"]))),
  );
  const reviewedBefore = (at: number): boolean => chainCloses.some((entry) => entry.at < at);
  const logicalRounds = runJournalLogicalRounds(events);

  // ── Required entries ─────────────────────────────────────────────────────
  //
  // Named in the declared order, each answered by the one shared predicate.
  // `gate.reported` is required only of an executor-only journal.
  for (const entry of RUN_JOURNAL_REQUIRED_ENTRIES) {
    if (entry === REQUIRED.gateReported && !executorOnly) continue;
    if (!runJournalCarries(events, entry)) missing.push(entry);
  }

  /**
   * WHY THE GOVERNING ROUND WAS OR WAS NOT ACCEPTED, said once.
   *
   * Three of the eleven constraints turn on the same fact, and stating it in
   * one place is what lets the three explanations agree. `unbound` covers both
   * shapes an operator has to tell apart: no governing paired round at all,
   * and a governing round closed against a candidate this record does not
   * accept.
   */
  const roundBinding: RunJournalRoundBinding | undefined = treeSha === undefined ? undefined
    : requiredRound === undefined ? "unbound"
    : String(payloadOf(requiredRound.closed)["candidateTreeSha"]) === treeSha ? "record-tree" : "reviewed-tree";
  /** The tree-binding refusal, phrased once for every constraint that inherits it. */
  const unacceptedRound = currentRound === undefined
    ? "the journal carries no round whose latest opening is closed by its own latest close, so no closed round governs"
    : `the governing round closed at seq ${seqOf(currentRound.closed)} binds a candidate tree that is not the record's and is not among the ${reviewedTreeShas.length} the record's verified review-neutral projection accepts`;

  // ── Ordering constraints ─────────────────────────────────────────────────
  if (runStarted !== undefined && (runStarted.at !== 0 || indexBy(events, "run.started").length > 1)) {
    raise(
      VIOLATION.runStartedNotFirst,
      `run.started is at journal position ${runStarted.at + 1} of ${events.length} and the journal carries ${indexBy(events, "run.started").length} of them; a whole run starts exactly once, at the first entry`,
    );
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
    const prerequisites = [
      { name: REQUIRED.ticketRead, entry: ticketRead },
      { name: REQUIRED.postureDeclared, entry: postureDeclared },
      { name: REQUIRED.lensSelected, entry: lensSelected },
    ];
    const late = prerequisites.flatMap((item) => item.entry !== undefined && item.entry.at > firstRound.at ? [{ name: item.name, entry: item.entry }] : []);
    if (late.length > 0) {
      raise(
        VIOLATION.prerequisitesAfterFirstRound,
        `${late.map((item) => `${item.name} (seq ${seqOf(item.entry.event)})`).join(" and ")} ${late.length === 1 ? "was" : "were"} recorded after the first review.round.opened at seq ${seqOf(firstRound.event)}; this is the order the executor journaled its own prerequisites in, and it is retained as history rather than corrected`,
      );
    }
  }

  if (inverted) {
    raise(
      VIOLATION.roundClosedBeforeOpened,
      "at least one round key carries its review.round.closed ahead of its review.round.opened, so that round cannot be read as a review that ran",
    );
  }

  if (gateCompletion !== undefined) {
    const closedFirst = requiredRound !== undefined &&
      (requiredRound.closedAt < gateCompletion.at || reviewedBefore(gateCompletion.at));
    if (!closedFirst) {
      raise(
        VIOLATION.gateBeforeClosedRound,
        requiredRound === undefined
          ? `the governing gate completion at seq ${seqOf(gateCompletion.event)} has no closed round this row accepts: ${unacceptedRound}`
          : `the governing gate completion at seq ${seqOf(gateCompletion.event)} precedes the governing closed round at seq ${seqOf(requiredRound.closed)}, so that gate did not stand on a completed review`,
        // Two rows, one fact: only the tree-binding arm inherits, and only
        // where a record supplied the trees that could have accepted the round.
        requiredRound === undefined && treeSha !== undefined ? VIOLATION.roundNotBoundToRecord : undefined,
      );
    }
    if (recordCompletion !== undefined && recordCompletion.at < gateCompletion.at) {
      raise(
        VIOLATION.recordBeforeGate,
        `the governing record completion at seq ${seqOf(recordCompletion.event)} precedes the governing gate completion at seq ${seqOf(gateCompletion.event)}, so the record was written before the gate it reports`,
      );
    }
  }

  if (!linkedRetry && openingGateCompletion !== undefined && prOpened !== undefined && prOpened.at < openingGateCompletion.at) {
    raise(
      VIOLATION.prBeforeGate,
      `pr.opened at seq ${seqOf(prOpened.event)} precedes the opening gate completion at seq ${seqOf(openingGateCompletion.event)}, so the delivery proposed a change before it had gated at all`,
    );
  }

  if (runEnded !== undefined && runEnded.at !== events.length - 1) {
    const after = events.length - runEnded.at - 1;
    raise(
      VIOLATION.runEndedNotLast,
      `run.ended is at journal position ${runEnded.at + 1} of ${events.length}, with ${after} later ${after === 1 ? "entry" : "entries"}; run.ended is terminal`,
    );
  }

  // `gate.reported` is ordered only where it stands in for the gate
  // completion: in a journal that has any CLI completion it carries no
  // ordering constraint and the CLI completion's constraints govern.
  if (executorOnly && gateReported !== undefined) {
    const closedFirst = requiredRound !== undefined &&
      (requiredRound.closedAt < gateReported.at || reviewedBefore(gateReported.at));
    if (!closedFirst) {
      raise(
        VIOLATION.gateReportedBeforeClosedRound,
        requiredRound === undefined
          ? `the governing gate.reported at seq ${seqOf(gateReported.event)} has no closed round this row accepts: ${unacceptedRound}`
          : `the governing gate.reported at seq ${seqOf(gateReported.event)} precedes the governing closed round at seq ${seqOf(requiredRound.closed)}, so that reported gate did not stand on a completed review`,
        requiredRound === undefined && treeSha !== undefined ? VIOLATION.roundNotBoundToRecord : undefined,
      );
    }
    if (!linkedRetry && openingGateReported !== undefined && prOpened !== undefined && prOpened.at < openingGateReported.at) {
      raise(
        VIOLATION.prBeforeGateReported,
        `pr.opened at seq ${seqOf(prOpened.event)} precedes the opening gate.reported at seq ${seqOf(openingGateReported.event)}, so the delivery proposed a change before it had reported a gate at all`,
      );
    }
  }

  if (lensSelected !== undefined) {
    const mandated = payloadOf(lensSelected.event)["mandated"];
    const ids = Array.isArray(mandated) ? mandated : undefined;
    const wellFormed = ids !== undefined && ids.length === 2 && ids.every((id) => typeof id === "string" && id.length > 0);
    const agreed =
      mandatedLensIds === undefined ||
      (ids !== undefined && [...ids].map(String).sort().join(" ") === [...mandatedLensIds].sort().join(" "));
    if (!wellFormed || !agreed) {
      raise(
        VIOLATION.mandatedPairMismatch,
        !wellFormed
          ? `lens.selected at seq ${seqOf(lensSelected.event)} does not declare a mandated pair of exactly two non-empty ids`
          : `lens.selected at seq ${seqOf(lensSelected.event)} declares a mandated set differing from the ${mandatedLensIds?.length ?? 0} id(s) the caller supplied with --mandated-lens`,
      );
    }
  }

  if (treeSha !== undefined && requiredRound === undefined) {
    raise(
      VIOLATION.roundNotBoundToRecord,
      `${unacceptedRound}; the record's own candidate tree and the ${reviewedTreeShas.length} reviewed tree(s) its verified review-neutral projection accepts are the only candidates a round may bind here`,
    );
  }

  // Raised of the GOVERNING round only. An earlier same-id reopen that a later
  // round has since superseded is history the journal retains, exactly as the
  // prerequisite ordering above is; what this names is the round being read
  // right now, whose two openings no reader can tell apart.
  if (currentRound !== undefined && currentRound.reopenedUnderSameId) {
    const earlier = last(indexBy(events, "review.round.closed").filter(
      (entry) => roundKey(entry.event) === currentRound.round && entry.at < currentRound.openedAt,
    ));
    raise(
      VIOLATION.roundReopenedUnderSameId,
      `the governing review.round.opened at seq ${seqOf(currentRound.opened)} continues a round that ${
        earlier === undefined
          ? "it names as itself in reopensRoundId"
          : `already closed at seq ${seqOf(earlier.event)} under the same round key`
      }, so the two openings are one key to every reader of this journal; reopen it under a new roundId whose reopensRoundId names the round it continues, which is a version-2 journal's own form for saying so`,
    );
  }

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

  const supersededGates = gateCompletion === undefined ? [] : completionsOf(events, "gate")
    .filter((entry) => entry.at > gateCompletion.at)
    .map((entry) => seqOf(entry.event));

  return {
    status, missing, violations, boundToRecord, explanations, logicalRounds,
    ...(roundBinding === undefined ? {} : { roundBinding }),
    ...(supersededGates.length === 0 ? {} : { supersededGates }),
  };
}
