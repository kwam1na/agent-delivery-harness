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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateToolInvocation,
  type CheckpointAdmissionExpectation,
} from "../binding/host-admission.ts";
import { createJournalStore } from "../checkpoint/journal-store.ts";

export interface HookBindingState {
  readonly expectation: CheckpointAdmissionExpectation;
  readonly grant: unknown;
  readonly attestation: unknown;
  readonly workspaceRoot: string;
  readonly observationPath: string;
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
