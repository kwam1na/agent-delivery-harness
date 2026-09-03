/**
 * `runs` — read the run store back: `runs list`, `runs show <id>`, and
 * `runs serve`, the local page over the same files.
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
import { evaluateRunJournal } from "@agent-delivery-harness/kernel";
import {
  READOUT_LABELS,
  detailOf,
  readoutRows,
  roundRows,
} from "../run-projection.ts";
import { startRunServer, type RunServerHandle } from "../run-server.ts";
import { oneLine, oneLineOf, resolveRunSurface, runSurfaceBlocker, type RunSurface } from "../run-surface.ts";
import type { CommandResult, ConfigFreeCommandContext, ConfigFreeCommandDescriptor } from "../boundary.ts";

const USAGE = [
  "Usage: delivery-harness runs list",
  "       delivery-harness runs show <run-id>",
  "       delivery-harness runs serve [--repo <path>]... [--port <n>]",
].join("\n");

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
  summary: "List, show, and serve the delivery runs this repository has recorded.",
  configFree: true,
  async run(context: ConfigFreeCommandContext): Promise<CommandResult> {
    const [subcommand, ...rest] = context.args;
    if (subcommand === undefined) return { kind: "usage", message: `runs needs a subcommand.\n${USAGE}` };
    if (subcommand !== "list" && subcommand !== "show" && subcommand !== "serve") {
      return { kind: "usage", message: `Unknown runs subcommand ${oneLine(subcommand, 64)}.\n${USAGE}` };
    }
    if (subcommand === "show" && rest[0] === undefined) {
      return { kind: "usage", message: `runs show needs a run id.\n${USAGE}` };
    }
    // `serve` resolves its OWN repositories — one per `--repo`, none of them
    // necessarily the invoking worktree — so it never asks the invoking
    // worktree's store to resolve first.
    if (subcommand === "serve") return serveRuns(context, rest);

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

// ── serve ────────────────────────────────────────────────────────────────────

interface ServeArgs {
  readonly repos: readonly string[];
  readonly port?: number;
}

type ServeParse = { readonly ok: true; readonly args: ServeArgs } | { readonly ok: false; readonly message: string };

/**
 * The separate-argument form every other command uses. `--flag=value` is
 * REFUSED rather than accepted as a convenience: one spelling means an
 * operator who mistypes a path gets a usage error instead of a server quietly
 * watching a repository named `--repo=/some/path`.
 */
function parseServeArgs(args: readonly string[], rootDir: string): ServeParse {
  const repos: string[] = [];
  let port: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--repo" || token === "--port") {
      const value = args[index + 1];
      if (value === undefined) return { ok: false, message: `${token} needs a value.\n${USAGE}` };
      index += 1;
      if (token === "--repo") {
        repos.push(path.resolve(rootDir, value));
        continue;
      }
      if (!/^\d{1,5}$/.test(value)) return { ok: false, message: `--port needs a port number.\n${USAGE}` };
      const parsed = Number(value);
      if (parsed > 65535) return { ok: false, message: `--port needs a port number.\n${USAGE}` };
      port = parsed;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, message: `Unknown flag ${oneLine(token, 64)}.\n${USAGE}` };
    return { ok: false, message: `runs serve takes no positional arguments.\n${USAGE}` };
  }

  // No `--repo` means the worktree the operator is standing in, which is the
  // only repository they can have meant.
  return { ok: true, args: { repos: repos.length === 0 ? [rootDir] : repos, ...(port === undefined ? {} : { port }) } };
}

/**
 * Serves until the invocation is signalled.
 *
 * There is no other exit. A viewer's job is to be there while the operator
 * watches, and the operator ends it with the interrupt the boundary already
 * maps; a run ending is not a reason to stop serving, because the next run
 * starts in the same store.
 */
async function serveRuns(context: ConfigFreeCommandContext, args: readonly string[]): Promise<CommandResult> {
  const parsed = parseServeArgs(args, context.rootDir);
  if (!parsed.ok) return { kind: "usage", message: parsed.message };

  const started = await startRunServer({ repos: parsed.args.repos, ...(parsed.args.port === undefined ? {} : { port: parsed.args.port }) });
  if (!started.ok) return unresolvable(started.reason);

  const server: RunServerHandle = started.server;
  context.write(`serving ${parsed.args.repos.length} repository path(s) at ${server.url}`);
  context.write(`  (${READOUT_LABELS})`);
  try {
    await untilSignalled(context.signal);
  } finally {
    await server.close();
  }
  return { kind: "ok" };
}

/** Resolves when the invocation's signal aborts; never, when it has none. */
function untilSignalled(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
