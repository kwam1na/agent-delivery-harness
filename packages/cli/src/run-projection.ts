/**
 * One projection of a run journal, shared by every surface that renders it.
 *
 * WHY THIS MODULE EXISTS. `runs show` renders a journal to a terminal and
 * `runs serve` renders the same journal to a page. Two renderers is fine; two
 * ANSWERS is not. If each surface decided for itself which round a
 * `review.round.closed` pairs with, what a `gate.reported` means next to a
 * CLI-written `command.completed`, or which required entries a journal
 * carries, an operator reading the page and the terminal would eventually be
 * told two different things about one file on disk. So the semantics live here
 * once — pairing, writer roles, gate and record outcomes, the readout rows —
 * and the surfaces own only their own escaping and layout.
 *
 * WHAT STAYS WITH THE SURFACE. Neutralization. A terminal and a browser are
 * hostile to different bytes: the terminal to escape sequences and newlines
 * that forge a row, the browser to markup. `detailOf` collapses a value to one
 * line's worth of neutralized text because BOTH surfaces want that; the page
 * then escapes the result as markup and the terminal prints it. Nothing here
 * emits markup, and nothing here decides a layout.
 */
import {
  RUN_JOURNAL_REQUIRED_ENTRIES,
  runJournalCarries,
  runPrimaryTicket,
  type RunEvent,
  type RunJournalEvaluation,
  type RunJournalRequiredEntry,
} from "@agent-delivery-harness/kernel";
import { harnessConfigPresentAt, oneLine, oneLineOf } from "./run-surface.ts";

/** The three labels every readout carries, so no reader mistakes this for evidence. */
export const READOUT_LABELS = "self-attested; observability, not evidence; unbound to a record";

export const payloadOf = (event: RunEvent): Record<string, unknown> =>
  typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};

/**
 * The ticket an entry BOUND ITSELF to, as a row suffix, or nothing.
 *
 * Only the entry's own binding is rendered. An entry that omits `ticket` binds
 * to the run's primary, which the runs table already names in the row above
 * every timeline — repeating it on each unbound line would turn the one thing
 * the member exists to say, that THIS entry belongs to THAT ticket, into
 * boilerplate an operator learns to skip. The envelope is read rather than the
 * payload because the validator holds the two to exact agreement and the
 * envelope is what every other reader here reads.
 */
const boundTicket = (event: RunEvent): string => (event.ticket === undefined ? "" : ` for ${oneLineOf(event.ticket, 128)}`);

/**
 * One row's detail for one event: enough to read the run without printing the
 * whole payload back at the operator.
 */
export function detailOf(event: RunEvent): string {
  const payload = payloadOf(event);
  switch (event.kind) {
    case "run.started":
      return oneLineOf(payload["host"]) + (payload["displacedRunId"] === undefined ? "" : ` displaced ${oneLineOf(payload["displacedRunId"])}`);
    case "run.ended":
      return `${oneLineOf(payload["result"])} cost ${oneLineOf((payload["cost"] as { total?: unknown } | undefined)?.total)}`;
    case "ticket.read":
      return `${oneLineOf(payload["ticket"])} via ${oneLineOf(payload["tracker"])}`;
    case "posture.declared":
      return oneLineOf(payload["posture"]) + boundTicket(event);
    case "lens.selected":
      return `mandated ${oneLineOf(payload["mandated"])} selected ${oneLineOf(payload["selected"])} — ${oneLineOf(payload["rationale"])}`;
    case "review.round.opened":
      return `round ${oneLineOf(payload["round"])} on ${oneLineOf(event.candidateTreeSha)} lenses ${oneLineOf(payload["lenses"])}`;
    case "review.round.closed":
      return `round ${oneLineOf(payload["round"])} ${oneLineOf(payload["outcome"])} findings ${oneLineOf(payload["findings"])}`;
    case "command.completed":
      return `${oneLineOf(payload["command"])} ${oneLineOf(payload["outcome"])} in ${oneLineOf(payload["durationMs"])}ms`;
    case "gate.reported":
      return `${oneLineOf(payload["command"])} ${oneLineOf(payload["outcome"])} in ${oneLineOf(payload["durationMs"])}ms${boundTicket(event)}`;
    case "pr.opened":
      return `${oneLineOf(payload["url"], 400)} on ${oneLineOf(event.candidateTreeSha)}${boundTicket(event)}`;
    case "blocker.recorded":
      return `${oneLineOf(payload["code"])} — ${oneLineOf(payload["summary"])}`;
    case "decision.recorded":
      return `${oneLineOf(payload["fork"])} — ${oneLineOf(payload["choice"])}${payload["cited"] === undefined ? "" : ` (cited ${oneLineOf(payload["cited"])})`}`;
    case "compounding.recorded":
      return `${oneLineOf(payload["outcome"])}${payload["reference"] === undefined ? "" : ` — ${oneLineOf(payload["reference"])}`}`;
    default:
      return "";
  }
}

// ── Rounds ───────────────────────────────────────────────────────────────────

export interface RoundEntry {
  /** The round label as the executor wrote it, reduced to one line. */
  readonly round: string;
  /**
   * The candidate this round was bound to, taken from the ENVELOPE of the
   * opening event (or the closing one when a round was never opened). The
   * envelope is what the store holds to agreement with the payload, so it is
   * the member every reader reads.
   */
  readonly candidateTreeSha: string;
  readonly opened?: RunEvent;
  readonly closed?: RunEvent;
}

/** One entry per round, in the order the journal first mentions it. */
export function roundEntries(events: readonly RunEvent[]): readonly RoundEntry[] {
  const rounds = new Map<string, { opened?: RunEvent; closed?: RunEvent }>();
  for (const event of events) {
    if (event.kind !== "review.round.opened" && event.kind !== "review.round.closed") continue;
    const key = oneLineOf(payloadOf(event)["round"], 32);
    const entry = rounds.get(key) ?? {};
    if (event.kind === "review.round.opened") entry.opened = event;
    else entry.closed = event;
    rounds.set(key, entry);
  }
  return [...rounds.entries()].map(([round, entry]) => {
    const anchor = entry.opened ?? entry.closed;
    return {
      round,
      candidateTreeSha: oneLineOf(anchor?.candidateTreeSha),
      ...(entry.opened === undefined ? {} : { opened: entry.opened }),
      ...(entry.closed === undefined ? {} : { closed: entry.closed }),
    };
  });
}

/** One text row per round, each carrying the candidate it was bound to. */
export function roundRows(events: readonly RunEvent[]): readonly string[] {
  return roundEntries(events).map((entry) => {
    const closed = entry.closed === undefined ? undefined : payloadOf(entry.closed);
    return [
      `  round ${entry.round}`,
      `candidate ${entry.candidateTreeSha || "(none)"}`,
      entry.opened === undefined ? "never opened" : `lenses ${oneLineOf(payloadOf(entry.opened)["lenses"])}`,
      closed === undefined ? "open" : `${oneLineOf(closed["outcome"])} findings ${oneLineOf(closed["findings"])} cost ${oneLineOf((closed["cost"] as { total?: unknown } | undefined)?.total)}`,
    ].join("  ");
  });
}

// ── The readout ──────────────────────────────────────────────────────────────

export interface Readout {
  readonly status: RunJournalEvaluation["status"];
  readonly present: readonly RunJournalRequiredEntry[];
  readonly missing: readonly RunJournalRequiredEntry[];
  readonly violations: readonly string[];
  /** The config-presence note, present on exactly the status that it explains. */
  readonly note?: string;
}

/**
 * What a journal carries and what it lacks.
 *
 * Present is read off the journal, not inferred by subtracting `missing` from
 * the required list. The two are not complements: `gate.reported` is required
 * only of an executor-only journal, so a journal that never carried one would
 * otherwise be reported as HAVING it.
 *
 * The predicate is the evaluator's own, imported rather than restated. A
 * second implementation here would be a second answer to the same question,
 * and a reader would eventually be told an entry is both present and missing —
 * which is exactly what a rewritten copy of the pairing rule did.
 */
export function readoutOf(events: readonly RunEvent[], evaluation: RunJournalEvaluation, rootDir: string): Readout {
  const present = RUN_JOURNAL_REQUIRED_ENTRIES.filter((entry) => runJournalCarries(events, entry));
  const note =
    evaluation.status === "complete-executor-only" && harnessConfigPresentAt(rootDir)
      ? `no CLI gate completion in this journal; harness.config.ts present at ${oneLine(rootDir, 400)}`
      : undefined;
  return {
    status: evaluation.status,
    present,
    missing: evaluation.missing,
    violations: evaluation.violations,
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * The readout as text rows. Labeled three ways, listing what the journal has
 * and what it lacks under the ordered rule, with the config-presence note
 * attached to the one status it explains.
 */
export function readoutRows(events: readonly RunEvent[], evaluation: RunJournalEvaluation, rootDir: string): readonly string[] {
  const readout = readoutOf(events, evaluation, rootDir);
  const rows = [
    `  completeness: ${readout.status}  (${READOUT_LABELS})`,
    `    present: ${readout.present.length === 0 ? "(none)" : readout.present.join(", ")}`,
    `    missing: ${readout.missing.length === 0 ? "(none)" : [...readout.missing].join(", ")}`,
  ];
  if (readout.violations.length > 0) rows.push(`    violations: ${[...readout.violations].join(", ")}`);
  if (readout.note !== undefined) rows.push(`    note: ${readout.note}`);
  return rows;
}

// ── The run's headline ───────────────────────────────────────────────────────

/** One command outcome and the role of whoever wrote it down. */
export interface WrittenOutcome {
  readonly outcome: string;
  readonly writer: "cli" | "executor";
}

export interface RunSummary {
  /**
   * The run's PRIMARY ticket, by the family's own rule: the first the journal
   * names. A run that read two — a dogfood item and the ordinary item it
   * delivered — is named here by the first, and every entry that bound no
   * ticket of its own belongs to it.
   */
  readonly ticket: string;
  /** A run with no `run.ended` is open, whatever else it holds. */
  readonly open: boolean;
  readonly startedAt: string;
  readonly lastAt: string;
  /**
   * The journal's own span, first event to last, in whole seconds.
   *
   * NOT "now minus the start". The viewer renders a file, and a file's span is
   * a property of the file: two operators refreshing the page a minute apart
   * must be told the same thing about the same run, and a run whose journal
   * ends is not still accruing duration. `at` is second-granularity, so this
   * is too.
   */
  readonly durationSeconds: number;
  readonly roundsOpened: number;
  readonly roundsClosed: number;
  readonly findings: { readonly P0: number; readonly P1: number; readonly P2: number; readonly P3: number };
  /**
   * The gate outcome and who claimed it: the CLI-written `command.completed`
   * for `gate` when there is one, the executor's `gate.reported` otherwise.
   * The writer is the point of the label — an adopter whose gate is not a
   * product command has only the executor's word for it.
   */
  readonly gate?: WrittenOutcome;
  readonly record?: WrittenOutcome;
  /** `run.ended`'s result, when the run has ended. */
  readonly result?: string;
}

const cliCompletionFor = (events: readonly RunEvent[], command: string): RunEvent | undefined =>
  events.find(
    (event) => event.kind === "command.completed" && event.actor.role === "cli" && payloadOf(event)["command"] === command,
  );

const severityOf = (value: unknown, key: string): number => {
  const findings = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const count = findings[key];
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
};

/** Seconds between two contract instants, or zero when either cannot be read. */
function spanSeconds(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 1000);
}

export function summarize(events: readonly RunEvent[]): RunSummary {
  const first = events[0];
  const last = events[events.length - 1];
  const startedAt = first?.at ?? "";
  const lastAt = last?.at ?? "";
  const ended = events.find((event) => event.kind === "run.ended");
  const gateCompletion = cliCompletionFor(events, "gate");
  const gateReported = events.find((event) => event.kind === "gate.reported");
  const recordCompletion = cliCompletionFor(events, "record");
  const closed = events.filter((event) => event.kind === "review.round.closed");

  const gate =
    gateCompletion !== undefined
      ? { outcome: oneLineOf(payloadOf(gateCompletion)["outcome"], 64), writer: "cli" as const }
      : gateReported !== undefined
        ? { outcome: oneLineOf(payloadOf(gateReported)["outcome"], 64), writer: "executor" as const }
        : undefined;

  return {
    ticket: oneLineOf(runPrimaryTicket(events), 128),
    open: ended === undefined,
    startedAt,
    lastAt,
    durationSeconds: spanSeconds(startedAt, lastAt),
    roundsOpened: events.filter((event) => event.kind === "review.round.opened").length,
    roundsClosed: closed.length,
    findings: {
      P0: closed.reduce((total, event) => total + severityOf(payloadOf(event)["findings"], "P0"), 0),
      P1: closed.reduce((total, event) => total + severityOf(payloadOf(event)["findings"], "P1"), 0),
      P2: closed.reduce((total, event) => total + severityOf(payloadOf(event)["findings"], "P2"), 0),
      P3: closed.reduce((total, event) => total + severityOf(payloadOf(event)["findings"], "P3"), 0),
    },
    ...(gate === undefined ? {} : { gate }),
    ...(recordCompletion === undefined
      ? {}
      : { record: { outcome: oneLineOf(payloadOf(recordCompletion)["outcome"], 64), writer: "cli" as const } }),
    ...(ended === undefined ? {} : { result: oneLineOf(payloadOf(ended)["result"], 64) }),
  };
}
