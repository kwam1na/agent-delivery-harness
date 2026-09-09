import { runViewCommand } from "../run-view-command.ts";
import { readArchiveFile } from "../run-archive-commands.ts";
import { runArchiveCommand } from "../run-archive-commands.ts";
import { runArtifactCommand } from "../run-artifact-commands.ts";
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
import { RUN_JOURNAL_STATUSES, evaluateRunJournal } from "@agent-delivery-harness/kernel";
import {
  READOUT_LABELS,
  detailOf,
  readoutRows,
  roundRows,
} from "../run-projection.ts";
import { buildRunExport } from "../run-export.ts";
import { startRunServer, type RunServerHandle } from "../run-server.ts";
import {
  oneLine,
  oneLineOf,
  resolveRunSurface,
  resolveWorktreeRoot,
  runSurfaceBlocker,
  type RunSurface,
} from "../run-surface.ts";
import type { CommandResult, ConfigFreeCommandContext, ConfigFreeCommandDescriptor } from "../boundary.ts";

const USAGE = [
  "Usage: delivery-harness runs capabilities --json",
  "       delivery-harness runs list [--json] [--limit <n>] [--status <status>] [--open|--ended]",
  "       delivery-harness runs show <run-id> [--json]",
  "       delivery-harness runs view <run-id> [--json] [--record <repository-relative-path>]",
  "       delivery-harness runs export <run-id> --output <file>",
  "       delivery-harness runs archive <file> [--artifact <id>]",
  "       delivery-harness runs capture <run-id> --json <request>",
  "       delivery-harness runs artifact <run-id> <artifact-id> [--json]",
  "       delivery-harness runs serve [--repo <path>]... [--archive <file>]... [--port <n>] [--freshness-seconds <n>] [--record <repository-relative-path>]",
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
  usage: USAGE,
  configFree: true,
  async run(context: ConfigFreeCommandContext): Promise<CommandResult> {
    const [subcommand, ...rest] = context.args;
    if (subcommand === "capabilities") {
      if (rest.length !== 1 || rest[0] !== "--json") return { kind: "usage", message: "Usage: runs capabilities --json" };
      context.write(`${JSON.stringify({ spec: "run-capabilities/1", writerVersions: ["run-event/1", "run-event/2"], artifactCapture: true })}\n`);
      return { kind: "ok" };
    }
    if (subcommand === "view") return runViewCommand(context, rest);
    if (subcommand === "export" || subcommand === "archive") return runArchiveCommand(context, subcommand, rest);
    if (subcommand === "capture" || subcommand === "artifact") return runArtifactCommand(context, subcommand, rest);
    if (subcommand === undefined) return { kind: "usage", message: `runs needs a subcommand.\n${USAGE}` };
    if (subcommand !== "list" && subcommand !== "show" && subcommand !== "serve") {
      return { kind: "usage", message: `Unknown runs subcommand ${oneLine(subcommand, 64)}.\n${USAGE}` };
    }
    if (subcommand === "show" && rest[0] === undefined) {
      return { kind: "usage", message: `runs show needs a run id.\n${USAGE}` };
    }
    if (subcommand === "show" && (rest.length > 2 || (rest[1] !== undefined && rest[1] !== "--json"))) {
      return { kind: "usage", message: `runs show accepts only a run id and optional --json.\n${USAGE}` };
    }
    // `serve` resolves its OWN repositories — one per `--repo`, none of them
    // necessarily the invoking worktree — so it never asks the invoking
    // worktree's store to resolve first.
    if (subcommand === "serve") return serveRuns(context, rest);

    // `list`'s argument surface is decided BEFORE the store is resolved. A
    // mistyped bound is a usage error wherever it was typed, and an operator
    // standing outside a repository should not have to fix the repository to
    // find out the flag was wrong.
    const listArgs = subcommand === "list" ? parseListArgs(rest) : undefined;
    if (listArgs !== undefined && !listArgs.ok) return { kind: "usage", message: listArgs.message };

    const resolved = await resolveRunSurface(context.rootDir);
    if (!resolved.ok) return unresolvable(resolved.reason);

    if (listArgs !== undefined && listArgs.ok) return listRuns(resolved.surface, context, listArgs.args);
    return showRun(resolved.surface, context, rest[0]!, rest[1] === "--json");
  },
};

// ── list ─────────────────────────────────────────────────────────────────────

/**
 * The one label this listing prints for a journal it could not read at all.
 * It is not a completeness verdict — nothing was evaluated — so it is not one
 * of the kernel's statuses, and it is spelled once, here.
 */
export const RUN_LIST_UNREADABLE = "unreadable";

/**
 * `absent` is the completeness vocabulary's answer to "no journal bound this
 * candidate", which an inventory of the journals that exist can never be. It
 * is excluded rather than accepted-and-never-matched, because a selector that
 * cannot select anything whatever the store holds is a false affordance: an
 * agent filtering on it would read the empty result as "no such runs" rather
 * than as "this question cannot be asked here".
 */
const STATUS_NEVER_LISTED = "absent";

/**
 * Exactly the statuses a row of this listing can carry, which is what
 * `--status` accepts. Derived from the kernel's closed vocabulary so a status
 * renamed there is a compile-and-test problem here rather than a filter that
 * silently stops matching.
 */
export const RUN_LIST_STATUSES: readonly string[] = Object.freeze([
  ...RUN_JOURNAL_STATUSES.filter((status) => status !== STATUS_NEVER_LISTED),
  RUN_LIST_UNREADABLE,
]);

/** The spec every machine-readable inventory carries, beside `runs show --json`'s export spec. */
export const RUN_INVENTORY_SPEC = "run-inventory/1";

interface ListArgs {
  readonly json: boolean;
  readonly limit?: number;
  readonly status?: string;
  /** True selects the runs with no `run.ended`; false selects the ended ones. */
  readonly open?: boolean;
}

type ListParse = { readonly ok: true; readonly args: ListArgs } | { readonly ok: false; readonly message: string };

/**
 * The separate-argument form the rest of this command uses, and the same
 * refusal discipline: an unknown flag, a repeated one, a positional, and a
 * value that is not a bound are all usage errors rather than conveniences.
 *
 * A LIMIT IS A COUNT OF ROWS, so it is a positive integer and nothing else.
 * `0` is refused rather than read as "no rows" or as "no bound": both readings
 * are plausible, an operator cannot tell which one they got from the output,
 * and neither is a thing anyone means to ask for.
 */
function parseListArgs(args: readonly string[]): ListParse {
  const refuse = (reason: string): ListParse => ({ ok: false, message: `runs list: ${reason}.\n${USAGE}` });
  let json = false;
  let limit: number | undefined;
  let status: string | undefined;
  let open: boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      if (json) return refuse("--json was given twice");
      json = true;
      continue;
    }
    if (token === "--open" || token === "--ended") {
      // Two names for one question, so asking it twice — however spelled —
      // has no answer to give.
      if (open !== undefined) return refuse("use at most one of --open and --ended");
      open = token === "--open";
      continue;
    }
    if (token === "--limit" || token === "--status") {
      const value = args[index + 1];
      if (value === undefined) return refuse(`${token} needs a value`);
      index += 1;
      if (token === "--limit") {
        if (limit !== undefined) return refuse("--limit was given twice");
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
          return refuse(`--limit needs a positive whole number, not ${oneLine(value, 64)}`);
        }
        limit = Number(value);
        continue;
      }
      if (status !== undefined) return refuse("--status was given twice");
      if (!RUN_LIST_STATUSES.includes(value)) {
        return refuse(`--status accepts ${RUN_LIST_STATUSES.join(", ")}, not ${oneLine(value, 64)}`);
      }
      status = value;
      continue;
    }
    if (token.startsWith("--")) return refuse(`unknown flag ${oneLine(token, 64)}`);
    return refuse("it takes no positional arguments");
  }

  return {
    ok: true,
    args: { json, ...(limit === undefined ? {} : { limit }), ...(status === undefined ? {} : { status }), ...(open === undefined ? {} : { open }) },
  };
}

/** The journal's size on disk, or zero where it cannot be measured. */
async function sizeOf(runsDir: string, runId: string): Promise<number> {
  try {
    return (await stat(path.join(runsDir, `${runId}.jsonl`))).size;
  } catch {
    return 0;
  }
}

/** One run as both surfaces see it: the same five facts, rendered or serialized. */
interface InventoryRow {
  readonly runId: string;
  readonly status: string;
  readonly open: boolean;
  readonly current: boolean;
  readonly bytes: number;
}

/**
 * Every run the store holds, in the store's own order.
 *
 * THE ORDER IS THE STORE'S, and the store sorts run ids ascending. That is
 * what makes a bounded listing reproducible: the same store bounded the same
 * way returns the same rows, and the row a `--limit 1` returns is the one an
 * unbounded listing printed first. Nothing here re-orders it, so the order
 * this surface documents is the order the store defines and not a second one
 * that happens to agree today.
 */
async function inventoryOf(
  surface: RunSurface,
): Promise<{ readonly rows: readonly InventoryRow[]; readonly currentRunId: string | undefined }> {
  const runIds = await surface.store.list();
  const current = await surface.store.current(surface.worktreeKey);
  const currentRunId = current.ok ? current.runId : undefined;

  const rows: InventoryRow[] = [];
  for (const runId of runIds) {
    const bytes = await sizeOf(surface.runsDir, runId);
    const read = await surface.store.read(runId);
    rows.push(
      read.ok
        ? {
            runId,
            status: evaluateRunJournal(read.events).status,
            open: !read.events.some((event) => event.kind === "run.ended"),
            current: runId === currentRunId,
            bytes,
          }
        : // Nothing was read, so nothing is claimed: an unreadable journal is
          // not open, not current, and carries no completeness verdict.
          { runId, status: RUN_LIST_UNREADABLE, open: false, current: false, bytes },
    );
  }
  return { rows, currentRunId };
}

/**
 * `runs list`, human and machine.
 *
 * THE FILTER RUNS BEFORE THE BOUND. A bound applied first would spend its rows
 * on runs the filter then discards, so `--status x --limit 1` could answer
 * "none" for a store that holds one — the bound is a bound on the ANSWER, not
 * on how far the store was read.
 *
 * WHAT `total` COUNTS is the set the filters selected, before the bound. That
 * is the number a reader needs to know it was bounded (`returned` below it
 * means rows were cut), and with no filter it is the whole store — which is
 * why the unfiltered human listing's total line is unchanged.
 */
async function listRuns(surface: RunSurface, context: ConfigFreeCommandContext, args: ListArgs): Promise<CommandResult> {
  const { rows, currentRunId } = await inventoryOf(surface);
  const selected = rows.filter(
    (row) => (args.status === undefined || row.status === args.status) && (args.open === undefined || row.open === args.open),
  );
  const totalBytes = selected.reduce((sum, row) => sum + row.bytes, 0);
  const shown = args.limit === undefined ? selected : selected.slice(0, args.limit);
  const truncated = shown.length < selected.length;

  if (args.json) {
    context.write(
      JSON.stringify(
        {
          spec: RUN_INVENTORY_SPEC,
          labels: READOUT_LABELS,
          runsDir: surface.runsDir,
          current: currentRunId ?? null,
          runs: shown,
          total: { count: selected.length, bytes: totalBytes },
          returned: shown.length,
          truncated,
        },
        null,
        2,
      ),
    );
    return { kind: "ok" };
  }

  // The status column carries a completeness verdict, so this readout is
  // labeled exactly like `show`'s. `list` is the command an operator reaches
  // for first, before it knows which id to show; an unlabeled `complete` here
  // is the misreading the labels exist to prevent.
  const lines: string[] = [`runs in ${oneLine(surface.runsDir, 400)}`, `  (${READOUT_LABELS})`];
  for (const row of shown) {
    lines.push(
      row.status === RUN_LIST_UNREADABLE
        ? `  ${row.runId}  ${RUN_LIST_UNREADABLE}  ${row.bytes} bytes`
        : `  ${row.runId}  ${row.status}  ${row.open ? "open" : "ended"}${row.current ? " current" : ""}  ${row.bytes} bytes`,
    );
  }
  lines.push(`total ${totalBytes} bytes across ${selected.length} run(s)`);
  // Said only when something was actually cut, so the unbounded listing keeps
  // the bytes it always had.
  if (truncated) lines.push(`showing ${shown.length} of ${selected.length} run(s) (--limit ${args.limit})`);
  for (const line of lines) context.write(line);
  return { kind: "ok" };
}

// ── show ─────────────────────────────────────────────────────────────────────

async function showRun(surface: RunSurface, context: ConfigFreeCommandContext, runId: string, json: boolean): Promise<CommandResult> {
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
  if (json) {
    const worktreeRoot = await resolveWorktreeRoot(context.rootDir);
    const rootDir = worktreeRoot.ok ? worktreeRoot.root : context.rootDir;
    context.write(JSON.stringify(buildRunExport({
      runId,
      events,
      rootDir,
      refusedAppends: await surface.store.readNotes(runId),
    }), null, 2));
    return { kind: "ok" };
  }
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
  //
  // THE ROOT IS THE WORKTREE'S, NOT THE INVOCATION'S. The config-presence note
  // is a question about the repository, and `runs serve` answers it at the
  // toplevel of the path it was given. Answering it here at the cwd would tell
  // an operator standing in `packages/cli` that this repository carries no
  // config while the page, over the same journal, says it carries one — two
  // answers to one question, which is the thing the shared projection exists
  // to prevent. The cwd stands in only where git can name no root at all, and
  // then it is the only root there is.
  const worktreeRoot = await resolveWorktreeRoot(context.rootDir);
  const rootDir = worktreeRoot.ok ? worktreeRoot.root : context.rootDir;
  for (const row of readoutRows(events, evaluateRunJournal(events), rootDir)) context.write(row);
  return { kind: "ok" };
}

// ── serve ────────────────────────────────────────────────────────────────────

interface ServeArgs {
 readonly archives:readonly string[];
 readonly recordPath?:string;
 readonly freshnessWindowMs?:number;
  readonly repos: readonly string[];
  readonly port?: number;
}

type ServeParse = { readonly ok: true; readonly args: ServeArgs } | { readonly ok: false; readonly message: string };

/**
 * The ports a browser leaves out of the `Host` header, being the defaults of
 * the schemes it would dial them under.
 *
 * `run-server.ts` decides whether a request is addressed to the socket it
 * arrived on by comparing `Host` against the bound `host:port` for EXACT
 * equality — it parses nothing, normalizes nothing, and matches no list of
 * names that "mean" loopback. That exactness is the property; it is what makes
 * the page's answer to a DNS rebind checkable rather than a matter of parsing
 * taste. A page served on one of these ports is one no browser can ever reach:
 * the request arrives carrying `Host: 127.0.0.1`, with no port at all, and is
 * answered 403 — the same 403 a rebind gets, with nothing to tell them apart.
 *
 * So the choice is between widening the check and refusing the port, and it is
 * settled by what each costs. Widening costs the property. Refusing costs an
 * operator nothing they wanted: a loopback viewer of a run store has no reason
 * to sit on a privileged port, and the ephemeral default is one flag away.
 * The refusal lives HERE, at the one surface an operator types a port at,
 * rather than beside the check it protects — a second guard inside the server
 * would make neither one provable.
 */
const BROWSER_ELIDED_PORTS: readonly number[] = [80, 443];

/**
 * The separate-argument form every other command uses. `--flag=value` is
 * REFUSED rather than accepted as a convenience: one spelling means an
 * operator who mistypes a path gets a usage error instead of a server quietly
 * watching a repository named `--repo=/some/path`.
 */
function parseServeArgs(args: readonly string[], rootDir: string): ServeParse {
  const repos: string[] = [];
  const archives:string[]=[];
  let recordPath:string|undefined;
  let freshnessWindowMs:number|undefined;
  let port: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--repo" || token === "--port" || token === "--archive" || token === "--freshness-seconds" || token === "--record") {
      const value = args[index + 1];
      if (value === undefined) return { ok: false, message: `${token} needs a value.\n${USAGE}` };
      index += 1;
      if(token==="--record"){if(recordPath!==undefined)return {ok:false,message:"Use one explicit record path"};recordPath=value;continue;}
      if(token==="--archive"){archives.push(path.resolve(rootDir,value));continue;}
      if(token==="--freshness-seconds"){if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>86400)return {ok:false,message:"freshness seconds must be between 0 and 86400"};freshnessWindowMs=Number(value)*1000;continue;}
      if (token === "--repo") {
        repos.push(path.resolve(rootDir, value));
        continue;
      }
      if (!/^\d{1,5}$/.test(value)) return { ok: false, message: `--port needs a port number.\n${USAGE}` };
      const parsed = Number(value);
      if (parsed > 65535) return { ok: false, message: `--port needs a port number.\n${USAGE}` };
      if (BROWSER_ELIDED_PORTS.includes(parsed)) {
        return {
          ok: false,
          message:
            `--port ${parsed} cannot be served: a browser omits a scheme's default port from the Host header, ` +
            `and this page answers only to the exact host:port it bound.\n${USAGE}`,
        };
      }
      port = parsed;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, message: `Unknown flag ${oneLine(token, 64)}.\n${USAGE}` };
    return { ok: false, message: `runs serve takes no positional arguments.\n${USAGE}` };
  }

  // No `--repo` means the worktree the operator is standing in, which is the
  // only repository they can have meant.
  return { ok: true, args: { repos: repos.length === 0 && archives.length===0 ? [rootDir] : repos, archives,...(recordPath===undefined?{}:{recordPath}),...(freshnessWindowMs===undefined?{}:{freshnessWindowMs}), ...(port === undefined ? {} : { port }) } };
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

  let archives:{label:string;text:string}[];try{archives=await Promise.all(parsed.args.archives.map(async file=>({label:path.basename(file),text:await readArchiveFile(file)})));}catch{return unresolvable("An explicitly selected archive could not be read within its size limit.");}
  const started = await startRunServer({ repos: parsed.args.repos,archives,...(parsed.args.recordPath===undefined?{}:{recordPath:parsed.args.recordPath}),...(parsed.args.freshnessWindowMs===undefined?{}:{freshnessWindowMs:parsed.args.freshnessWindowMs}), ...(parsed.args.port === undefined ? {} : { port: parsed.args.port }) });
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
