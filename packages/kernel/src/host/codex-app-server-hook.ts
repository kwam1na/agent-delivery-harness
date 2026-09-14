/**
 * THE CODEX PRE-TOOL-USE WIRE.
 *
 * The admission decision itself is NOT re-authored here. `decideHookInvocation`
 * in `./hook-main.ts` is the one interceptor decision — fence recheck, frozen
 * admission re-evaluation, filesystem-walked write containment — and this
 * module is the two things that are genuinely Codex's: which tool names the
 * synchronous local hook is able to adjudicate at all, and the exact document
 * the host reads back. A second copy of the grant logic is how two bindings
 * drift apart, so there isn't one.
 *
 * THE WIRE IS DENY-ONLY, and that is a characterized property of the host
 * rather than a choice. The installed host rejects `permissionDecision:allow`,
 * `permissionDecision:ask`, `decision:approve`, `continue:false`, `stopReason`,
 * `suppressOutput`, and `updatedInput` outright, and rejects a `deny` carrying
 * an empty reason. So an allowed invocation renders NOTHING — deferring to the
 * host's own permission system, which the composed profile has already
 * narrowed to the grant — and a denial renders exactly one accepted shape with
 * a non-empty reason. Emitting an `allow` would not widen the grant; it would
 * make the host treat the hook's output as invalid, which is the case the
 * caller below turns into a refusal rather than a continuation.
 */
import { decideHookInvocation, type HookBindingState, type HookDecision, type HookToolInput } from "./hook-main.ts";
import { CODEX_UNENFORCEABLE_TOOL_SOURCES } from "./codex-app-server.ts";

/** The host's own spelling of this event inside the decision document. */
export const CODEX_HOOK_EVENT_NAME = "PreToolUse";

/**
 * The host's hook input document. Member names are the host's, read
 * defensively: every one of them is optional because a malformed document must
 * deny rather than throw.
 */
export interface CodexHookInput {
  readonly hook_event_name?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_use_id?: unknown;
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  /** The host's own classification of where this tool came from, when it gives one. */
  readonly tool_source?: unknown;
}

/**
 * A tool the synchronous local hook can adjudicate is one whose invocation
 * reaches this hook with operands it can read. A tool served by MCP, by an
 * installed app, by a hosted surface, by a dynamic registration, or by a
 * plugin is not: its call may be decided somewhere this process does not run.
 * The composed thread configuration disables those surfaces; this predicate is
 * the second half, because a boundary resting only on configuration the
 * binding cannot re-verify per invocation is not a boundary.
 *
 * Case-folded and substring-matched in the closed direction: an unrecognized
 * spelling of a hosted source denies, and a name that merely resembles one is
 * denied rather than admitted. Nothing here can widen a grant — a tool that
 * passes still faces the full admission re-evaluation.
 */
export function codexToolIsLocallyEnforceable(toolName: string, toolSource?: unknown): boolean {
  if (toolName.length === 0) return false;
  const folded = toolName.toLowerCase();
  if (CODEX_UNENFORCEABLE_TOOL_SOURCES.some((source) => folded.includes(source))) return false;
  // A namespaced tool name is how MCP and app tools arrive; the local hook
  // cannot tell which server answered one.
  if (folded.includes("__") || folded.includes("/") || folded.includes(":")) return false;
  if (toolSource === undefined) return true;
  if (typeof toolSource !== "string") return false;
  const foldedSource = toolSource.toLowerCase();
  return !CODEX_UNENFORCEABLE_TOOL_SOURCES.some((source) => foldedSource.includes(source));
}

/**
 * The Codex interceptor decision. The unenforceable-surface refusal runs
 * BEFORE the shared decision, because a call this hook cannot adjudicate must
 * not be handed to a decision procedure that would read its absent operands as
 * "writes nothing".
 */
export function decideCodexHookInvocation(
  state: HookBindingState | undefined,
  input: CodexHookInput,
  observedAt: string,
  sessionFence: number,
): HookDecision {
  const toolName = input.tool_name;
  if (typeof toolName !== "string" || toolName.length === 0) {
    return { allowed: false, reason: "the invocation names no tool; nothing unnamed is admitted" };
  }
  if (!codexToolIsLocallyEnforceable(toolName, input.tool_source)) {
    return {
      allowed: false,
      reason: `unenforceable_tool_surface: "${toolName}" is served by a surface the synchronous local hook cannot adjudicate`,
    };
  }
  const shared: HookToolInput = {
    tool_name: toolName,
    tool_input: typeof input.tool_input === "object" && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : undefined,
    tool_use_id: typeof input.tool_use_id === "string" ? input.tool_use_id : undefined,
  };
  return decideHookInvocation(state, shared, observedAt, sessionFence);
}

/**
 * The document the host reads. An allow renders the empty string, which is the
 * host's "no opinion" and defers to the profile the binding already narrowed.
 * A denial renders the one accepted shape, and its reason is non-empty by
 * construction — the host rejects a reasonless deny, and a rejected decision
 * document is not a denial.
 */
export function renderCodexHookDecision(decision: HookDecision): string {
  if (decision.allowed) return "";
  const reason = decision.reason.trim();
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: CODEX_HOOK_EVENT_NAME,
      permissionDecision: "deny",
      permissionDecisionReason: `outside the attested grant — ${reason.length === 0 ? "no reason was recorded, which is itself a refusal" : reason}`,
    },
  });
}

/**
 * Reads the host's hook document from raw stdin bytes. Unparseable input is
 * NOT an empty document: an empty document names no tool and denies, and this
 * returns `undefined` so the caller denies for the reason that actually
 * applies. No invalid-response path may continue a tool call.
 */
export function parseCodexHookInput(raw: string): CodexHookInput | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as CodexHookInput) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The whole hook turn as one pure function: bytes in, the host's decision
 * document out. Unparseable input, an unnamed tool, an unenforceable surface,
 * a superseded fence, and a failed admission all take the same exit — a
 * rendered denial — so there is no path from a defect to a continued call.
 */
export function codexHookTurn(input: {
  readonly state: HookBindingState | undefined;
  readonly rawInput: string;
  readonly observedAt: string;
  readonly sessionFence: number;
}): string {
  const parsed = parseCodexHookInput(input.rawInput);
  if (parsed === undefined) {
    return renderCodexHookDecision({
      allowed: false,
      reason: "the host's hook input could not be read; an unreadable invocation is refused rather than continued",
    });
  }
  return renderCodexHookDecision(decideCodexHookInvocation(input.state, parsed, input.observedAt, input.sessionFence));
}
