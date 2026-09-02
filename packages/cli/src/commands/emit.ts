/**
 * `emit` — append one run event to the current delivery run's journal.
 *
 * THE EXECUTOR'S ONE WRITE PATH. Everything an executor knows that the product
 * cannot observe — which lenses it chose and why, what it decided at a fork,
 * what a review round cost — arrives here or is lost to a transcript. The
 * command is deliberately small: a kind, a JSON payload, and the store.
 *
 * WHAT `emit` MAY NOT SET. Not `seq`, which is the store's, taken inside its
 * critical section. Not `at`, which is this process's own instant. Not
 * `actor`, which is always `executor` here — the boundary wrap is the only
 * writer of `cli`, and the store refuses `cli` on any other kind. And not
 * `command.completed` at all: a completion is a claim that the product ran a
 * command, and only the product may make it. That refusal is noted in the
 * run's note exactly like any other refused append, so an executor that tries
 * leaves a trace rather than nothing.
 *
 * ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER.
 *   1. Arguments. A malformed invocation is a usage error and touches nothing.
 *   2. The repository. Outside one there is no store, so there is nowhere to
 *      write and nowhere to note.
 *   3. The run. Resolution precedes kind validation, because a refused append
 *      is recorded against a run — with no run there is nothing to note
 *      against, and inventing one would create a journal for a typo.
 *      `run.started` is the single exception: it allocates the run it needs.
 *   4. The store. Kind and payload validation, the secret discipline, and the
 *      note on refusal are all the store's, so there is exactly one
 *      implementation of each.
 */
import {
  RUN_STORE_ID,
  reduceToProviderId,
  type RunStore,
} from "@agent-delivery-harness/kernel";
import {
  buildRunEvent,
  oneLine,
  resolveRunSurface,
  runSurfaceBlocker,
  type RunSurface,
} from "../run-surface.ts";
import type { CommandResult, ConfigFreeCommandContext, ConfigFreeCommandDescriptor } from "../boundary.ts";

const USAGE = "Usage: delivery-harness emit <kind> [--run <id>] [--json <payload>] [--force]";

interface ParsedArgs {
  readonly kind: string;
  readonly run?: string;
  readonly json?: string;
  readonly force: boolean;
}

type ArgParse = { readonly ok: true; readonly args: ParsedArgs } | { readonly ok: false; readonly message: string };

function parseArgs(args: readonly string[]): ArgParse {
  let kind: string | undefined;
  let run: string | undefined;
  let json: string | undefined;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--force") {
      force = true;
      continue;
    }
    if (token === "--run" || token === "--json") {
      const value = args[index + 1];
      if (value === undefined) return { ok: false, message: `${token} needs a value.\n${USAGE}` };
      if (token === "--run") run = value;
      else json = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, message: `Unknown flag ${oneLine(token, 64)}.\n${USAGE}` };
    if (kind !== undefined) return { ok: false, message: `emit takes one kind.\n${USAGE}` };
    kind = token;
  }

  if (kind === undefined) return { ok: false, message: `emit needs a kind.\n${USAGE}` };
  return { ok: true, args: { kind, force, ...(run === undefined ? {} : { run }), ...(json === undefined ? {} : { json }) } };
}

/**
 * The payload as the caller supplied it. Text that is not JSON is passed
 * through as-is rather than rejected here: the store owns payload validation,
 * and routing it there is what puts the refusal in the run's note.
 */
function parsePayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

const noRun = (details: string) =>
  runSurfaceBlocker({
    code: "run_unresolvable",
    summary: "There is no current run to emit against.",
    details,
    remediation: {
      id: "start-a-run",
      summary: "Run `delivery-harness emit run.started` in this worktree, or name an existing run with --run.",
    },
  });

/**
 * Resolves the run this event belongs to: `--run` when given, else the
 * invoking worktree's pointer. An explicit `--run` resolves only when the id
 * passes the charset check AND its journal exists, so no arbitrary id ever
 * causes a journal or a note to be created.
 */
async function resolveRun(store: RunStore, surface: RunSurface, named: string | undefined): Promise<string | undefined> {
  if (named !== undefined) {
    if (named.length > 128 || !RUN_STORE_ID.test(named)) return undefined;
    const read = await store.read(named);
    return read.ok ? named : undefined;
  }
  const current = await store.current(surface.worktreeKey);
  return current.ok ? current.runId : undefined;
}

export const emitCommand: ConfigFreeCommandDescriptor = {
  name: "emit",
  sourceId: "delivery-harness.cli.emit",
  summary: "Append one run event to the current delivery run's journal.",
  configFree: true,
  async run(context: ConfigFreeCommandContext): Promise<CommandResult> {
    const parsed = parseArgs(context.args);
    if (!parsed.ok) return { kind: "usage", message: parsed.message };
    const { kind, run: named, force } = parsed.args;

    const resolved = await resolveRunSurface(context.rootDir);
    if (!resolved.ok) {
      return {
        kind: "blocked",
        blockers: [
          runSurfaceBlocker({
            code: "run_store_unresolvable",
            summary: "The run store could not be resolved.",
            details: oneLine(resolved.reason, 200),
            remediation: {
              id: "run-inside-a-repository",
              summary: "Run this command inside a git repository; the run store lives under its common directory.",
            },
          }),
        ],
      };
    }
    const surface = resolved.surface;
    const store = surface.store;

    if (kind === "run.started") {
      return startRun(surface, force, parsePayload(parsed.args.json ?? (await context.readStdin())));
    }

    const runId = await resolveRun(store, surface, named);
    if (runId === undefined) {
      return {
        kind: "blocked",
        blockers: [
          noRun(
            named === undefined
              ? "no current run is pointed at from this worktree, and no --run was given"
              : `--run ${oneLine(named, 128)} names no readable journal in this store`,
          ),
        ],
      };
    }

    const payload = parsePayload(parsed.args.json ?? (await context.readStdin()));
    const event = buildRunEvent({ runId, commonDir: surface.commonDir, kind, role: "executor", payload });

    // `command.completed` is the CLI's to write. The refusal is recorded in the
    // run's note through the store's one bounded note writer, so an attempt
    // leaves the same trace as any other refused append.
    if (kind === "command.completed") {
      await store.noteRefusal(runId, event, {
        code: "unsupported_combination",
        pointer: "/kind",
        message: "command.completed is written by the CLI; emit may not write it",
      });
      return {
        kind: "blocked",
        blockers: [
          runSurfaceBlocker({
            code: "run_event_refused",
            summary: "command.completed is written by the CLI, never by emit.",
            details: `run ${runId}: the product's own commands append their completions; an executor reports a non-product gate with gate.reported`,
            remediation: {
              id: "use-gate-reported",
              summary: "Emit gate.reported when the repository's gate is not a product command.",
            },
          }),
        ],
      };
    }

    const appended = await store.append(runId, event);
    if (!appended.ok) {
      const first = appended.rejections[0];
      return {
        kind: "blocked",
        blockers: [
          runSurfaceBlocker({
            code: "run_event_refused",
            // The rejected kind is echoed reduced to the bound the note records
            // it at, so the diagnostic and the durable line say the same thing
            // and neither can carry an escape sequence to the terminal.
            summary: `The run event was refused: ${reduceToProviderId(kind)}`,
            details: `run ${runId}: ${first === undefined ? "the store refused the append" : `${first.code} at ${oneLine(first.pointer, 64) || "/"}: ${oneLine(first.message, 200)}`}`,
            remediation: {
              id: "correct-the-event",
              summary: "Correct the kind or the payload against the run-event/1 contract and emit again.",
            },
          }),
        ],
      };
    }

    if (kind === "run.ended") await store.clearCurrent(surface.worktreeKey, runId);
    return { kind: "ok", summary: `emitted ${appended.event.kind} seq ${appended.event.seq} to run ${runId}` };
  },
};

/**
 * `run.started` is the one kind that allocates rather than resolves.
 *
 * The pointer is read BEFORE the journal is allocated, so the ordinary refusal
 * — a run is already current and no `--force` was given — leaves no orphan
 * journal behind. `--force` carries the displaced run's id into the new run's
 * own `run.started` payload, which is what makes a restarted delivery legible
 * afterwards.
 */
async function startRun(surface: RunSurface, force: boolean, supplied: unknown): Promise<CommandResult> {
  const store = surface.store;
  const existing = await store.current(surface.worktreeKey);
  const displaced = existing.ok ? existing.runId : undefined;
  if (displaced !== undefined && !force) {
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_already_current",
          summary: "A run is already current for this worktree.",
          details: `run ${displaced} is current; --force displaces it and records it as displacedRunId`,
          remediation: {
            id: "end-or-force",
            summary: "End the current run with `emit run.ended`, or start this one with --force.",
          },
        }),
      ],
    };
  }

  const allocated = await store.allocate();
  if (!allocated.ok) {
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_not_allocated",
          summary: "A run journal could not be allocated.",
          details: oneLine(allocated.rejections[0]?.message ?? "the store refused to allocate", 200),
          remediation: { id: "check-the-store", summary: "Check that the repository's git common directory is writable." },
        }),
      ],
    };
  }
  const runId = allocated.runId;

  const payload =
    typeof supplied === "object" && supplied !== null && displaced !== undefined
      ? { ...(supplied as Record<string, unknown>), displacedRunId: displaced }
      : supplied;

  const appended = await store.append(
    runId,
    buildRunEvent({ runId, commonDir: surface.commonDir, kind: "run.started", role: "executor", payload }),
  );
  if (!appended.ok) {
    const first = appended.rejections[0];
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_event_refused",
          summary: "The run event was refused: run.started",
          details: `run ${runId}: ${first === undefined ? "the store refused the append" : `${first.code} at ${oneLine(first.pointer, 64) || "/"}: ${oneLine(first.message, 200)}`}`,
          remediation: {
            id: "correct-the-event",
            summary: "Correct the payload against the run-event/1 contract and emit again.",
          },
        }),
      ],
    };
  }

  const pointed = await store.setCurrent(surface.worktreeKey, runId, { force });
  if (!pointed.ok) {
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_pointer_refused",
          summary: "The worktree pointer could not be written.",
          details: `run ${runId}: ${oneLine(pointed.rejections[0]?.message ?? "the pointer was refused", 200)}`,
          remediation: { id: "name-the-run", summary: "Pass --run explicitly, or resolve the conflicting pointer." },
        }),
      ],
    };
  }

  return {
    kind: "ok",
    summary: `started run ${runId}${displaced === undefined ? "" : ` (displaced ${displaced})`}`,
  };
}
