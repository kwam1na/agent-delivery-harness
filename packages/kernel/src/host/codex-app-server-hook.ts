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
import {
  CODEX_UNENFORCEABLE_TOOL_SOURCES,
  codexEscalationTokens,
  codexHostTool,
} from "./codex-app-server.ts";

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
 * THE TWO HALVES MATCH DIFFERENTLY, ON PURPOSE.
 *
 * The host's own `tool_source` — its classification of where a tool came from
 * — is matched by SUBSTRING in the closed direction: an unrecognized spelling
 * such as `mcp-server` or `app_tool` must deny, and there the cost of a false
 * deny is one tool call.
 *
 * The tool NAME is matched by whole token, with the same splitter the
 * escalation refusal uses. A substring test on the name is not conservative,
 * it is wrong: `app` is a substring of `apply_patch`, the host's own patch
 * tool, so a substring test permanently denies the primary file-mutation tool
 * on every invocation while reporting that it is "served by a surface the
 * synchronous local hook cannot adjudicate" — a false statement about a
 * first-party local tool. Namespaced names (`__`, `/`, `:`) still deny outright,
 * which is how MCP and app tools actually arrive.
 *
 * Nothing here can widen a grant — a tool that passes still faces the full
 * admission re-evaluation.
 */
export function codexToolIsLocallyEnforceable(toolName: string, toolSource?: unknown): boolean {
  if (toolName.length === 0) return false;
  const folded = toolName.toLowerCase();
  const nameTokens = codexEscalationTokens(toolName);
  if (
    nameTokens.some((token) =>
      CODEX_UNENFORCEABLE_TOOL_SOURCES.some((source) => token === source || token === `${source}s`),
    )
  ) {
    return false;
  }
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
  const host = codexHostTool(toolName);
  if (host === undefined) {
    return {
      allowed: false,
      reason: `unmapped_host_tool: "${toolName}" is not one of the characterized Codex tools, so this hook cannot read its operands`,
    };
  }
  const toolInput =
    typeof input.tool_input === "object" && input.tool_input !== null && !Array.isArray(input.tool_input)
      ? (input.tool_input as Record<string, unknown>)
      : undefined;
  const writes = codexWrittenPaths(host.writePathMembers, toolInput);
  if (host.writes === "paths" && writes.length === 0) {
    // The tool writes by contract and named nothing this hook could read.
    // Proceeding would hand the shared decision an empty write set, which it
    // would correctly adjudicate as "writes nothing" — about an invocation
    // that writes. Deny instead.
    return {
      allowed: false,
      reason: `unreadable_write_operands: "${toolName}" writes files but named none this hook could read`,
    };
  }
  const shared: HookToolInput = {
    // Translated into the kernel's vocabulary: the capability the grant is
    // spelled in, and the write paths under the member name the shared
    // decision's own table reads for that capability.
    tool_name: host.capability,
    // THE PATH THIS HOOK READ WINS, exactly as it does on the multi-path branch
    // below. Spelling the injection first and spreading the host's document
    // over it let a `file_path` member the hook could not read — `[]`, `""`, a
    // number — override the path `codexWrittenPaths` actually resolved out of
    // `fileChanges`, so the same invocation was adjudicated on an unrelated
    // operand and refused with a reason that was false about it
    // (`unnormalized_path: write path ".."`), while the identical invocation
    // naming two written paths was allowed. Which branch ran was decided by a
    // path count that has no bearing on the question.
    tool_input: host.writes === "paths" ? { ...(toolInput ?? {}), file_path: writes[0] } : toolInput,
    tool_use_id: typeof input.tool_use_id === "string" ? input.tool_use_id : undefined,
  };
  if (host.writes === "paths" && writes.length > 1) {
    // Every written path faces containment, not just the first: a patch that
    // writes one admitted path and one denied path is a denied patch.
    for (const written of writes) {
      const decision = decideHookInvocation(
        state,
        { ...shared, tool_input: { ...(toolInput ?? {}), file_path: written } },
        observedAt,
        sessionFence,
      );
      if (!decision.allowed) return decision;
    }
    return { allowed: true };
  }
  return decideHookInvocation(state, shared, observedAt, sessionFence);
}

/**
 * The paths a host tool says it writes, read from the members the map names.
 * A member may be an array of paths, a single path, or — as the host's own
 * apply-patch surface spells it — an object KEYED by path. Anything else
 * contributes nothing, which for a `paths` tool is a denial above rather than
 * an empty write set handed onward.
 */
export function codexWrittenPaths(
  members: readonly string[],
  toolInput: Record<string, unknown> | undefined,
): readonly string[] {
  if (toolInput === undefined) return [];
  const found: string[] = [];
  for (const member of members) {
    const value = toolInput[member];
    if (typeof value === "string" && value.length > 0) found.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === "string" && entry.length > 0) found.push(entry);
    } else if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value as Record<string, unknown>)) if (key.length > 0) found.push(key);
    }
  }
  return [...new Set(found)];
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
  return renderCodexHookDecision(codexHookDecision(input));
}

/**
 * The same turn, stopping one step earlier — at the decision rather than at
 * the document. The process entry needs the decision itself, because an
 * ALLOWED invocation is also the activity observation the facade's
 * lazy-unknown rule consumes; rendering first would throw that away, and a
 * Codex-bound delivery would age to `activity: "unknown"` while its session
 * was working normally.
 */
export function codexHookDecision(input: {
  readonly state: HookBindingState | undefined;
  readonly rawInput: string;
  readonly observedAt: string;
  readonly sessionFence: number;
}): HookDecision {
  const parsed = parseCodexHookInput(input.rawInput);
  if (parsed === undefined) {
    return {
      allowed: false,
      reason: "the host's hook input could not be read; an unreadable invocation is refused rather than continued",
    };
  }
  return decideCodexHookInvocation(input.state, parsed, input.observedAt, input.sessionFence);
}
