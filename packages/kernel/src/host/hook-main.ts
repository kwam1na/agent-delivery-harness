/**
 * The model-external hook entry the composed session wires into Claude Code.
 *
 * `pre-tool-use` is the per-invocation interceptor branch the graded
 * capability record qualified for multi-stage sessions: every tool invocation
 * is re-evaluated against the binding's CURRENT state file through the frozen
 * admission decisions, so a superseded fence, revoked trust epoch, or expired
 * attestation re-denies on the next call without any callback plumbing. A
 * missing or unreadable state file denies everything — deny-until-attested.
 *
 * `session-end` records the Tier 2 trusted lifecycle evidence: an honest
 * `paused` appended to the delivery journal through the frozen append path.
 * The hook runs outside the model's control surface; it is binding-owned
 * code the HOST invokes, and it launches nothing.
 *
 * This file is a process boundary (like the CLI main): it reads the ambient
 * clock and stdin inside `main`, while every decision it takes is the pure
 * `decideHookInvocation` below.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateToolInvocation,
  type CheckpointAdmissionExpectation,
} from "../binding/host-admission.ts";
import { createJournalStore } from "../checkpoint/journal-store.ts";
import { PROJECTION_DIR } from "./claude-code.ts";

export interface HookBindingState {
  readonly expectation: CheckpointAdmissionExpectation;
  readonly grant: unknown;
  readonly attestation: unknown;
  readonly workspaceRoot: string;
  readonly observationPath: string;
  /**
   * Where this fence's projection-consumption observation is recorded, in the
   * binding's own directory. Absent on a state file written before the
   * observation existed, which records nothing rather than failing.
   */
  readonly projectionConsumptionPath?: string;
  /**
   * The binding's materialization receipt, whose entries bound which paths an
   * observation may name. Absent records nothing rather than failing.
   */
  readonly projectionReceiptPath?: string;
  readonly journalPath?: string;
  readonly deliveryId?: string;
}

export interface HookToolInput {
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
}

export type HookDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** The tool-input members that name a file the invocation intends to write. */
const WRITE_PATH_MEMBERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
});

function writesOf(state: HookBindingState, toolName: string, toolInput: Record<string, unknown>): string[] {
  const members = WRITE_PATH_MEMBERS[toolName] ?? [];
  const writes: string[] = [];
  for (const member of members) {
    const value = toolInput[member];
    if (typeof value !== "string" || value.length === 0) continue;
    // Workspace-relative, '/'-separated. A path outside the workspace stays
    // absolute or dot-segmented and fails the frozen normalization check —
    // fail closed, never silently in-scope.
    const relative = path.isAbsolute(value) ? path.relative(state.workspaceRoot, value) : value;
    writes.push(relative.split(path.sep).join("/"));
  }
  return writes;
}

/**
 * The tool-input members that NAME A PATH. Deliberately not "members an
 * invocation reads": `file_path` is also Write's and Edit's write member, and
 * `path` is Glob's and Grep's directory member. Neither is harmless because of
 * anything in this list — a write is harmless because the grant denies it in
 * the projection, and a directory is harmless because containment lists files
 * only. Reading a read-guarantee into this set would be reading in something
 * it does not carry.
 *
 * What the set DOES carry is that the string arrived in a member whose job is
 * to name a path, rather than in free text a session controls. It is also
 * flat rather than tool-keyed, unlike WRITE_PATH_MEMBERS above, so a `path`
 * member on any tool — an MCP tool included — counts; that stays bounded by
 * containment and inside what the record claims.
 *
 * Naming Claude Code's members here is not a coupling problem, because this
 * file IS the Claude Code binding — its whole job is that host's tool surface.
 * The host-neutral writer stays free of them.
 */
const READ_PATH_MEMBERS = Object.freeze(["file_path", "path", "notebook_path"] as const);

/**
 * Canonicalized, because the host reports paths in resolved form while the
 * workspace root arrives as the operator wrote it. On macOS a delivery
 * worktree under the system temp root is reached as `/var/folders/...` while
 * every tool argument comes back as `/private/var/folders/...`, and a purely
 * lexical comparison makes each genuine read look like an escape out of the
 * subtree. That silently observed NOTHING — the failure is invisible, because
 * an unobserved consumption is spelled the same as an honest absence.
 *
 * A path that cannot be resolved keeps its lexical form; containment then
 * rejects it, which is the same fail-safe direction as before. This mirrors
 * the run-root rule in `artifacts.ts`, which resolves for exactly this reason.
 */
const canonical = (value: string): string => {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
};

/**
 * The projection entry an invocation names, if it names a receipted one.
 *
 * WHAT THIS CERTIFIES, EXACTLY: that an allowed invocation of this run named,
 * in a member that names files, a path the materialization receipt lists. Not
 * that the run read the file, and not that the run resolved its workflow from
 * the projection. The interceptor is model-external code the HOST invokes with
 * the invocation's own arguments, so what it reports is a fact about the run
 * rather than a claim the session made about itself — but the fact is the
 * naming, and the record built on it must say so in those words.
 *
 * TWO CHECKS, CLOSING DIFFERENT THINGS, NEITHER SUFFICIENT ALONE:
 *
 *   - The MEMBER restriction closes free-text steering. Receipted paths are
 *     not secret — `consumption.json` is constant and every skills/ and
 *     workflows/ entry is enumerable from the pinned generation — so without
 *     it a session mints an observation by naming a real entry in a Bash
 *     description or an edit's replaced text.
 *   - RECEIPT CONTAINMENT closes invented paths, which the member restriction
 *     does not: a path member may still name bytes that were never
 *     materialized.
 *
 * CONTAINMENT IS CHECKED HERE, NOT ONLY IN THE WRITER, because the observation
 * is recorded once per fence. A name that could never be admitted must not
 * burn that one slot: a Grep over `.managed-projection/skills` names a
 * DIRECTORY, the receipt lists files only, and if that were recorded the
 * honest Read of a receipted file that follows would find the slot taken and
 * the delivery would be excluded. Searching a directory and then reading a
 * file in it is ordinary agent behavior, so the check belongs on the write
 * path. The writer checks containment again as defense in depth.
 *
 * WHAT IT DELIBERATELY DOES NOT SEE, and what it cannot rule out: a read the
 * host performs internally without routing a path through its tool surface is
 * invisible here, so a genuinely consuming delivery can go unobserved; and a
 * run that names a receipted file in a path member without reading it is
 * indistinguishable from one that reads it. The first fails safe — no
 * observation, no entry, never an unobserved affirmation. The second is why
 * the claim is worded as naming rather than consumption. Closing either needs
 * a binding capability that does not exist.
 */
export function projectionEntryTouched(
  workspaceRoot: string,
  toolInput: Record<string, unknown>,
  receiptedEntries: readonly string[],
): string | undefined {
  const root = canonical(path.resolve(workspaceRoot, PROJECTION_DIR));
  for (const member of READ_PATH_MEMBERS) {
    const value = toolInput[member];
    if (typeof value !== "string" || value.length === 0) continue;
    const absolute = canonical(path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value));
    const relative = path.relative(root, absolute);
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const entry = relative.split(path.sep).join("/");
    if (!receiptedEntries.includes(entry)) continue;
    return entry;
  }
  return undefined;
}

/**
 * The receipted entry paths, read from the binding's own materialization
 * receipt. Unreadable or malformed yields none, so the observation is simply
 * not recorded — the fail-safe direction.
 */
function receiptedEntriesOf(receiptPath: string | undefined): readonly string[] {
  if (receiptPath === undefined) return [];
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      entries?: readonly { path?: unknown }[];
    };
    if (!Array.isArray(receipt.entries)) return [];
    return receipt.entries
      .map((entry) => entry?.path)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

export function decideHookInvocation(
  state: HookBindingState | undefined,
  input: HookToolInput,
  observedAt: string,
  /**
   * The fence baked into THIS session's hook command at admission, and
   * REQUIRED — a denial this load-bearing must not be opt-in by argument
   * arity. The binding state and settings are fence-scoped, so a superseded
   * session normally reads its own now-voided state; this check is the second
   * lock, closing the case where it somehow reads a state file describing a
   * different invocation.
   */
  sessionFence: number,
): HookDecision {
  if (state === undefined) {
    return { allowed: false, reason: "no binding state is attested for this session; tools stay closed until the grant is applied" };
  }
  if (state.expectation.invocationFence !== sessionFence) {
    return {
      allowed: false,
      reason: `superseded_session: this session was admitted under fence ${sessionFence}, and the current fence is ${state.expectation.invocationFence}; a superseded invocation keeps no write path`,
    };
  }
  const toolName = input.tool_name;
  if (typeof toolName !== "string" || toolName.length === 0) {
    return { allowed: false, reason: "the invocation names no tool; nothing unnamed is admitted" };
  }
  const toolInput = typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {};
  const decision = evaluateToolInvocation(
    { ...state.expectation, observedAt },
    state.grant,
    state.attestation,
    { capability: toolName, writes: writesOf(state, toolName, toolInput) },
  );
  if (decision.allowed) return { allowed: true };
  return {
    allowed: false,
    reason: decision.denials.map((denial) => `${denial.code}: ${denial.message}`).join("; "),
  };
}

/** Claude Code's PreToolUse decision document; an allow defers to the host. */
export function renderHookDecision(decision: HookDecision): string {
  if (decision.allowed) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `outside the attested grant — ${decision.reason}`,
    },
  });
}

function loadState(statePath: string): HookBindingState | undefined {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as HookBindingState;
  } catch {
    return undefined;
  }
}

function nowInstant(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

async function main(argv: readonly string[]): Promise<number> {
  const [subcommand, statePath, fenceArg] = argv;
  if (statePath === undefined || (subcommand !== "pre-tool-use" && subcommand !== "session-end")) {
    process.stderr.write("usage: hook-main.ts <pre-tool-use|session-end> <state-path> <session-fence>\n");
    return 2;
  }
  // The session's own fence, baked into the command at admission. A malformed
  // or absent value denies rather than defers: an unidentifiable session is
  // exactly the superseded case this check exists for.
  const sessionFence = Number.parseInt(fenceArg ?? "", 10);
  if (!Number.isSafeInteger(sessionFence) || sessionFence < 1) {
    process.stderr.write("hook-main.ts: the session fence is required and must be a positive integer\n");
    return 2;
  }
  const state = loadState(statePath);

  if (subcommand === "pre-tool-use") {
    let input: HookToolInput = {};
    try {
      input = JSON.parse(readFileSync(0, "utf8")) as HookToolInput;
    } catch {
      input = {};
    }
    const observedAt = nowInstant();
    const decision = decideHookInvocation(state, input, observedAt, sessionFence);
    if (decision.allowed && state !== undefined) {
      // The invocation-fence observation the lazy-unknown rule consumes.
      try {
        writeFileSync(
          state.observationPath,
          `${JSON.stringify({ fence: state.expectation.invocationFence, observedAt })}\n`,
          { mode: 0o600 },
        );
      } catch {
        // An unrecorded observation only ages activity toward `unknown`; it
        // never widens the decision.
      }
      // The projection-consumption observation, recorded when this run first
      // reaches into the run-pinned projection. It is written ONCE per fence
      // and never rewritten: the fact is that consumption happened, and a
      // later invocation that touches nothing must not erase it.
      const entry = projectionEntryTouched(
        state.workspaceRoot,
        typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {},
        receiptedEntriesOf(state.projectionReceiptPath),
      );
      if (entry !== undefined && state.projectionConsumptionPath !== undefined) {
        try {
          writeFileSync(
            state.projectionConsumptionPath,
            `${JSON.stringify({
              deliveryId: state.deliveryId,
              fence: state.expectation.invocationFence,
              entry,
              observedAt,
            })}\n`,
            { mode: 0o600, flag: "wx" },
          );
        } catch {
          // Already recorded for this fence (the exclusive create fails), or
          // unwritable. Either way the decision above is untouched, and an
          // unrecorded consumption yields no gate-record entry rather than an
          // unobserved affirmation.
        }
      }
    }
    const rendered = renderHookDecision(decision);
    if (rendered.length > 0) process.stdout.write(`${rendered}\n`);
    return 0;
  }

  // session-end: trusted graceful lifecycle evidence — honest `paused`. A
  // superseded session reports nothing: its `paused` would name a fence that
  // is no longer current and would age the LIVE invocation toward unknown.
  if (state !== undefined && state.expectation.invocationFence !== sessionFence) return 0;
  //
  // TERMINATION PROVENANCE IS DELIBERATELY NOT WRITTEN HERE. Provenance
  // carries the host's graded descendant-teardown status, and that grade lives
  // in the pinned generation's capability record, which this hook has no
  // trustworthy path to. Reporting it from the binding state file would put a
  // Tier 3 gate inside a per-delivery file, so provenance enters only through
  // the facade's trusted lifecycle operation, which derives the grade itself.
  if (state?.journalPath === undefined || state.deliveryId === undefined) return 0;
  const store = createJournalStore(state.journalPath);
  const read = await store.read();
  const reduced = await store.state();
  if (!read.ok || !reduced.ok) return 0;
  await store.append({
    spec: "journal-entry/1",
    journal: "delivery",
    subjectId: state.deliveryId,
    expectedRevision: reduced.state.expectedRevision,
    idempotencyKey: `e${read.entries.length}-activity.observed`,
    kind: "activity.observed",
    payload: { activity: "paused", fence: state.expectation.invocationFence },
  });
  return 0;
}

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // A crashed hook must still fail CLOSED. The session's own permission
      // rules ALLOW the granted tools, so deferring would admit them with no
      // admission recheck — exit 2 is the host's blocking hook outcome, and a
      // crashed interceptor therefore denies rather than defers.
      process.exitCode = 2;
    });
}
