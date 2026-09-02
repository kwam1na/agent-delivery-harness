/**
 * `runs` — read the run store back: `runs list` and `runs show <id>`.
 *
 * THE VIEWER IS NOT A JUDGE. Everything rendered here is self-attested: an
 * executor wrote most of it, and the executor could have written anything.
 * Every readout says so in as many words, because the failure this surface
 * invites is an operator reading `complete` as though the product had verified
 * something. It has not. The completeness readout is observability, and the
 * viewer supplies no record tree SHA at all, so every rule phrased over a
 * record's candidate is evaluated over any paired round and labeled unbound.
 *
 * EVERY STRING HERE IS HOSTILE UNTIL RENDERED. Rationales, decisions, blocker
 * summaries and gate labels are executor-written free text on their way to a
 * terminal. `oneLine` neutralizes the escape sequences and collapses the
 * whitespace, so a rationale carrying a newline and a plausible-looking
 * completion row renders as one row's worth of text and forges nothing.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  RUN_JOURNAL_REQUIRED_ENTRIES,
  evaluateRunJournal,
  runJournalCarries,
  type RunEvent,
  type RunJournalEvaluation,
} from "@agent-delivery-harness/kernel";
import {
  harnessConfigPresentAt,
  oneLine,
  oneLineOf,
  resolveRunSurface,
  runSurfaceBlocker,
  type RunSurface,
} from "../run-surface.ts";
import type { CommandResult, ConfigFreeCommandContext, ConfigFreeCommandDescriptor } from "../boundary.ts";

const USAGE = "Usage: delivery-harness runs <list|show> [<run-id>]";

/** The three labels every readout carries, so no reader mistakes this for evidence. */
const READOUT_LABELS = "self-attested; observability, not evidence; unbound to a record";

const unresolvable = (reason: string): CommandResult => ({
  kind: "blocked",
  blockers: [
    runSurfaceBlocker({
      code: "run_store_unresolvable",
      summary: "The run store could not be resolved.",
      details: oneLine(reason, 200),
      remediation: {
        id: "run-inside-a-repository",
        summary: "Run this command inside a git repository; the run store lives under its common directory.",
      },
    }),
  ],
});

export const runsCommand: ConfigFreeCommandDescriptor = {
  name: "runs",
  sourceId: "delivery-harness.cli.runs",
  summary: "List and show the delivery runs this repository has recorded.",
  configFree: true,
  async run(context: ConfigFreeCommandContext): Promise<CommandResult> {
    const [subcommand, ...rest] = context.args;
    if (subcommand === undefined) return { kind: "usage", message: `runs needs a subcommand.\n${USAGE}` };
    if (subcommand !== "list" && subcommand !== "show") {
      return { kind: "usage", message: `Unknown runs subcommand ${oneLine(subcommand, 64)}.\n${USAGE}` };
    }
    if (subcommand === "show" && rest[0] === undefined) {
      return { kind: "usage", message: `runs show needs a run id.\n${USAGE}` };
    }

    const resolved = await resolveRunSurface(context.rootDir);
    if (!resolved.ok) return unresolvable(resolved.reason);

    return subcommand === "list"
      ? listRuns(resolved.surface, context)
      : showRun(resolved.surface, context, rest[0]!);
  },
};

// ── list ─────────────────────────────────────────────────────────────────────

/** The journal's size on disk, or zero where it cannot be measured. */
async function sizeOf(runsDir: string, runId: string): Promise<number> {
  try {
    return (await stat(path.join(runsDir, `${runId}.jsonl`))).size;
  } catch {
    return 0;
  }
}

async function listRuns(surface: RunSurface, context: ConfigFreeCommandContext): Promise<CommandResult> {
  const runIds = await surface.store.list();
  const current = await surface.store.current(surface.worktreeKey);
  const currentRunId = current.ok ? current.runId : undefined;

  // The status column carries a completeness verdict, so this readout is
  // labeled exactly like `show`'s. `list` is the command an operator reaches
  // for first, before it knows which id to show; an unlabeled `complete` here
  // is the misreading the labels exist to prevent.
  const lines: string[] = [`runs in ${oneLine(surface.runsDir, 400)}`, `  (${READOUT_LABELS})`];
  let total = 0;
  for (const runId of runIds) {
    const size = await sizeOf(surface.runsDir, runId);
    total += size;
    const read = await surface.store.read(runId);
    if (!read.ok) {
      lines.push(`  ${runId}  unreadable  ${size} bytes`);
      continue;
    }
    const evaluation = evaluateRunJournal(read.events);
    const open = !read.events.some((event) => event.kind === "run.ended");
    lines.push(
      `  ${runId}  ${evaluation.status}  ${open ? "open" : "ended"}${runId === currentRunId ? " current" : ""}  ${size} bytes`,
    );
  }
  lines.push(`total ${total} bytes across ${runIds.length} run(s)`);
  for (const line of lines) context.write(line);
  return { kind: "ok" };
}

// ── show ─────────────────────────────────────────────────────────────────────

const payloadOf = (event: RunEvent): Record<string, unknown> =>
  typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};

/**
 * One row's detail for one event: enough to read the run without printing the
 * whole payload back at the operator.
 */
function detailOf(event: RunEvent): string {
  const payload = payloadOf(event);
  switch (event.kind) {
    case "run.started":
      return oneLineOf(payload["host"]) + (payload["displacedRunId"] === undefined ? "" : ` displaced ${oneLineOf(payload["displacedRunId"])}`);
    case "run.ended":
      return `${oneLineOf(payload["result"])} cost ${oneLineOf((payload["cost"] as { total?: unknown } | undefined)?.total)}`;
    case "ticket.read":
      return `${oneLineOf(payload["ticket"])} via ${oneLineOf(payload["tracker"])}`;
    case "posture.declared":
      return oneLineOf(payload["posture"]);
    case "lens.selected":
      return `mandated ${oneLineOf(payload["mandated"])} selected ${oneLineOf(payload["selected"])} — ${oneLineOf(payload["rationale"])}`;
    case "review.round.opened":
      return `round ${oneLineOf(payload["round"])} on ${oneLineOf(event.candidateTreeSha)} lenses ${oneLineOf(payload["lenses"])}`;
    case "review.round.closed":
      return `round ${oneLineOf(payload["round"])} ${oneLineOf(payload["outcome"])} findings ${oneLineOf(payload["findings"])}`;
    case "command.completed":
      return `${oneLineOf(payload["command"])} ${oneLineOf(payload["outcome"])} in ${oneLineOf(payload["durationMs"])}ms`;
    case "gate.reported":
      return `${oneLineOf(payload["command"])} ${oneLineOf(payload["outcome"])} in ${oneLineOf(payload["durationMs"])}ms`;
    case "pr.opened":
      return `${oneLineOf(payload["url"], 400)} on ${oneLineOf(event.candidateTreeSha)}`;
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

/** One row per round, each carrying the candidate it was bound to. */
function roundRows(events: readonly RunEvent[]): readonly string[] {
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
    const closed = entry.closed === undefined ? undefined : payloadOf(entry.closed);
    return [
      `  round ${round}`,
      `candidate ${oneLineOf(anchor?.candidateTreeSha) || "(none)"}`,
      entry.opened === undefined ? "never opened" : `lenses ${oneLineOf(payloadOf(entry.opened)["lenses"])}`,
      closed === undefined ? "open" : `${oneLineOf(closed["outcome"])} findings ${oneLineOf(closed["findings"])} cost ${oneLineOf((closed["cost"] as { total?: unknown } | undefined)?.total)}`,
    ].join("  ");
  });
}

/**
 * The readout. Labeled three ways, listing what the journal has and what it
 * lacks under the ordered rule, with the config-presence note attached to the
 * one status it explains.
 */
function readoutRows(events: readonly RunEvent[], evaluation: RunJournalEvaluation, rootDir: string): readonly string[] {
  // Present is read off the journal, not inferred by subtracting `missing`
  // from the required list. The two are not complements: `gate.reported` is
  // required only of an executor-only journal, so a journal that never carried
  // one would otherwise be reported as HAVING it.
  //
  // The predicate is the evaluator's own, imported rather than restated. A
  // second implementation here would be a second answer to the same question,
  // and a reader would eventually be told an entry is both present and
  // missing — which is exactly what a rewritten copy of the pairing rule did.
  const present = RUN_JOURNAL_REQUIRED_ENTRIES.filter((entry) => runJournalCarries(events, entry));
  const rows = [
    `  completeness: ${evaluation.status}  (${READOUT_LABELS})`,
    `    present: ${present.length === 0 ? "(none)" : present.join(", ")}`,
    `    missing: ${evaluation.missing.length === 0 ? "(none)" : [...evaluation.missing].join(", ")}`,
  ];
  if (evaluation.violations.length > 0) rows.push(`    violations: ${[...evaluation.violations].join(", ")}`);
  if (evaluation.status === "complete-executor-only" && harnessConfigPresentAt(rootDir)) {
    rows.push(`    note: no CLI gate completion in this journal; harness.config.ts present at ${oneLine(rootDir, 400)}`);
  }
  return rows;
}

async function showRun(surface: RunSurface, context: ConfigFreeCommandContext, runId: string): Promise<CommandResult> {
  const read = await surface.store.read(runId);
  if (!read.ok) {
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_unresolvable",
          summary: "That run has no readable journal in this store.",
          details: `run ${oneLine(runId, 128)}: ${oneLine(read.rejections[0]?.message ?? "unreadable", 200)}`,
          remediation: { id: "list-the-runs", summary: "Run `delivery-harness runs list` to see the runs this repository holds." },
        }),
      ],
    };
  }

  const events = read.events;
  const open = !events.some((event) => event.kind === "run.ended");
  const current = await surface.store.current(surface.worktreeKey);
  const isCurrent = current.ok && current.runId === runId;

  context.write(`run ${runId}  ${open ? "open" : "ended"}${isCurrent ? "  current in this worktree" : ""}`);
  context.write("  events:");
  for (const event of events) {
    context.write(`    ${event.seq}  ${event.at}  ${event.kind.padEnd(20)}  ${event.actor.role.padEnd(8)}  ${detailOf(event)}`);
  }

  const rounds = roundRows(events);
  if (rounds.length > 0) {
    context.write("  rounds:");
    for (const row of rounds) context.write(`  ${row}`);
  }

  const decisions = events.filter((event) => event.kind === "decision.recorded");
  if (decisions.length > 0) {
    context.write("  decisions:");
    for (const decision of decisions) context.write(`    ${detailOf(decision)}`);
  }

  const notes = await surface.store.readNotes(runId);
  if (notes.length > 0) {
    context.write("  refused appends:");
    for (const entry of notes) {
      const note = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      context.write(
        `    ${oneLineOf(note["at"], 32)}  ${oneLineOf(note["kind"], 128)}  ${oneLineOf(note["code"], 64)}${note["pattern"] === undefined ? "" : `  ${oneLineOf(note["pattern"], 64)}`}`,
      );
    }
  }

  // No record tree sha and no mandated pair: the viewer has neither, and
  // pretending otherwise would turn an observation into a claim.
  for (const row of readoutRows(events, evaluateRunJournal(events), context.rootDir)) context.write(row);
  return { kind: "ok" };
}
