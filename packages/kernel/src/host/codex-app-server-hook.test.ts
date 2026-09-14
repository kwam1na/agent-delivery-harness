/**
 * THE DENY-ONLY PRE-TOOL-USE WIRE.
 *
 * The characterized host accepts exactly one decision shape and rejects the
 * rest — `allow`, `ask`, `approve`, `continue:false`, `stopReason`,
 * `suppressOutput`, `updatedInput`, and a reasonless `deny` are all rejected,
 * and a rejected decision document is not a denial. So the properties pinned
 * here are: an allowed invocation renders NOTHING, a denial renders the one
 * accepted shape with a non-empty reason, and no defect anywhere on the path —
 * unreadable bytes, an unnamed tool, an unadjudicable surface, a superseded
 * fence — can produce a continuation.
 *
 * The grant decision itself is NOT re-asserted here; `hook-main.test.ts` owns
 * it. What is asserted is that this wire reaches it rather than re-authoring
 * it.
 *
 * Written RED before `codex-app-server-hook.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import {
  CODEX_HOOK_EVENT_NAME,
  codexHookTurn,
  codexToolIsLocallyEnforceable,
  decideCodexHookInvocation,
  parseCodexHookInput,
  renderCodexHookDecision,
} from "./codex-app-server-hook.ts";
import { CODEX_HOST_TOOLS, CODEX_UNENFORCEABLE_TOOL_SOURCES } from "./codex-app-server.ts";
import type { HookBindingState } from "./hook-main.ts";

const grant = {
  spec: "execution-grant/1",
  profile: "checkpoint",
  allowedCapabilities: ["Bash", "Write", "Read"],
  writablePaths: ["src"],
  protectedPaths: [".git", ".managed-projection"],
  forbiddenOperations: [],
};

const expectation = {
  profile: "checkpoint",
  hostVersion: "0.147.0",
  productTrustRevocationEpoch: 0,
  observedAt: "2026-08-30T12:00:00Z",
  deliveryId: "dlv-codex-hook",
  invocationFence: 4,
  workspaceId: "ws-codex",
  projectionDigest: "a".repeat(64),
  discoveryConfigurationDigest: "b".repeat(64),
  registeringInstallationId: "install-1",
  activeProfile: "confirmation-fixture",
} as const;

const attestation = {
  spec: "grant-attestation/1",
  profile: "checkpoint",
  hostVersion: "0.147.0",
  grantDigest: digestCanonical(grant),
  productTrustRevocationEpoch: 0,
  expiry: "2026-08-30T13:00:00Z",
  intakeDraftId: "absent-by-state",
  deliveryId: "dlv-codex-hook",
  invocationFence: 4,
  workspaceId: "ws-codex",
  projectionDigest: "a".repeat(64),
  discoveryConfigurationDigest: "b".repeat(64),
  registeringInstallationId: "install-1",
  activeProfile: "confirmation-fixture",
};

const SESSION_FENCE: number = expectation.invocationFence;
const OBSERVED_AT = "2026-08-30T12:01:00Z";

const state: HookBindingState = {
  expectation,
  grant,
  attestation,
  workspaceRoot: "/work/tree",
  observationPath: "/ns/observation.json",
};

const turn = (raw: string, fence = SESSION_FENCE): string =>
  codexHookTurn({ state, rawInput: raw, observedAt: OBSERVED_AT, sessionFence: fence });

const denial = (rendered: string): any => JSON.parse(rendered).hookSpecificOutput;

describe("which tools the synchronous local hook can adjudicate", () => {
  it("adjudicates a plain host tool", () => {
    expect(codexToolIsLocallyEnforceable("Write")).toBe(true);
    expect(codexToolIsLocallyEnforceable("Write", "builtin")).toBe(true);
  });

  it("refuses every surface whose calls it may not see, by name or by reported source", () => {
    for (const source of CODEX_UNENFORCEABLE_TOOL_SOURCES) {
      expect(codexToolIsLocallyEnforceable(`${source}_write`), source).toBe(false);
      expect(codexToolIsLocallyEnforceable("Write", source), source).toBe(false);
    }
    // Namespaced spellings are how MCP and app tools arrive; the hook cannot
    // tell which server answered one.
    for (const name of ["server__tool", "server/tool", "server:tool"]) {
      expect(codexToolIsLocallyEnforceable(name), name).toBe(false);
    }
    // An unnamed tool and a non-string source both deny.
    expect(codexToolIsLocallyEnforceable("")).toBe(false);
    expect(codexToolIsLocallyEnforceable("Write", 7)).toBe(false);
  });
});

describe("the host's own tool vocabulary", () => {
  it("pins the event name the host sends, independently of our own constant", () => {
    // The host matches by ITS spelling. Every other row reads this constant on
    // both sides, so a rename would keep them green while the host stopped
    // recognizing the document we render.
    expect(CODEX_HOOK_EVENT_NAME).toBe("PreToolUse");
  });

  it("adjudicates the tools Codex actually calls, not the capability names we use internally", () => {
    // `Write` and `Read` are OUR words. What arrives on this wire is
    // `apply_patch` and `shell`, and a hook that only knows the internal
    // vocabulary adjudicates nothing the host ever sends.
    for (const tool of CODEX_HOST_TOOLS) {
      expect(codexToolIsLocallyEnforceable(tool.hostName), tool.hostName).toBe(true);
    }
  });

  it("allows a patch inside the grant's writable paths and denies one outside them", () => {
    const allowed = decideCodexHookInvocation(
      state,
      { tool_name: "apply_patch", tool_input: { file_path: "/work/tree/src/a.ts" } },
      OBSERVED_AT,
      SESSION_FENCE,
    );
    // THE POSITIVE ROW. Without one, a hook that denied EVERY invocation would
    // satisfy every other assertion in this file: the whole wire could be
    // broken shut and read as maximally safe.
    expect(allowed.allowed, JSON.stringify(allowed)).toBe(true);

    const denied = decideCodexHookInvocation(
      state,
      { tool_name: "apply_patch", tool_input: { file_path: "/work/tree/.git/config" } },
      OBSERVED_AT,
      SESSION_FENCE,
    );
    expect(denied.allowed).toBe(false);
  });

  it("reads EVERY path a multi-path patch names, not merely the first", () => {
    // `apply_patch` carries its operands keyed by path. A hook that adjudicated
    // one of them would let a patch touching `src/a.ts` carry `.git/config`
    // along with it.
    const decision = decideCodexHookInvocation(
      state,
      {
        tool_name: "apply_patch",
        tool_input: { fileChanges: { "/work/tree/src/a.ts": {}, "/work/tree/.git/config": {} } },
      },
      OBSERVED_AT,
      SESSION_FENCE,
    );
    expect(decision.allowed).toBe(false);
  });

  it("denies a write whose operands it cannot read, and a tool it has never heard of", () => {
    const unreadable = decideCodexHookInvocation(
      state,
      { tool_name: "apply_patch", tool_input: {} },
      OBSERVED_AT,
      SESSION_FENCE,
    );
    expect(unreadable.allowed).toBe(false);
    if (!unreadable.allowed) expect(unreadable.reason).toContain("unreadable_write_operands");

    const unmapped = decideCodexHookInvocation(
      state,
      { tool_name: "some_future_tool", tool_input: { file_path: "/work/tree/src/a.ts" } },
      OBSERVED_AT,
      SESSION_FENCE,
    );
    expect(unmapped.allowed).toBe(false);
    if (!unmapped.allowed) expect(unmapped.reason).toContain("unmapped_host_tool");

    // A reported source this hook cannot see through denies even a mapped tool.
    for (const source of CODEX_UNENFORCEABLE_TOOL_SOURCES) {
      const decision = decideCodexHookInvocation(
        state,
        { tool_name: "apply_patch", tool_source: `${source}_server`, tool_input: { file_path: "/work/tree/src/a.ts" } },
        OBSERVED_AT,
        SESSION_FENCE,
      );
      expect(decision.allowed, source).toBe(false);
    }
  });
});

describe("the rendered decision document", () => {
  it("renders NOTHING for an allowed invocation — the host's own 'no opinion'", () => {
    expect(renderCodexHookDecision({ allowed: true })).toBe("");
    expect(
      turn(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "apply_patch",
          tool_input: { file_path: "/work/tree/src/a.ts" },
        }),
      ),
    ).toBe("");
  });

  it("renders exactly the one accepted deny shape, with a non-empty reason", () => {
    const rendered = renderCodexHookDecision({ allowed: false, reason: "outside" });
    const parsed = JSON.parse(rendered);
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
      "hookEventName",
      "permissionDecision",
      "permissionDecisionReason",
    ]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe(CODEX_HOOK_EVENT_NAME);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
  });

  it("never emits a member the host rejects — no allow, ask, approve, continue, stopReason, suppressOutput, or updatedInput", () => {
    const documents = [
      renderCodexHookDecision({ allowed: true }),
      renderCodexHookDecision({ allowed: false, reason: "outside" }),
      renderCodexHookDecision({ allowed: false, reason: "   " }),
      turn("not json at all"),
      turn(JSON.stringify({ tool_name: "mcp__server__tool" })),
    ];
    for (const document of documents) {
      if (document === "") continue;
      const parsed = JSON.parse(document);
      // The member set is asserted structurally: a rejected member cannot hide
      // in prose, and prose cannot fail the assertion.
      expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
      expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
        "hookEventName",
        "permissionDecision",
        "permissionDecisionReason",
      ]);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  it("still carries a reason when the decision arrived without one — a reasonless deny is rejected by the host", () => {
    expect(denial(renderCodexHookDecision({ allowed: false, reason: "" })).permissionDecisionReason.length).toBeGreaterThan(0);
    expect(denial(renderCodexHookDecision({ allowed: false, reason: "  \n " })).permissionDecisionReason.length).toBeGreaterThan(0);
  });
});

describe("reading the host's hook input", () => {
  it("answers undefined for anything that is not an object document — never an empty document", () => {
    for (const raw of ["", "not json", "[]", "null", "7", '"text"']) {
      expect(parseCodexHookInput(raw), raw).toBeUndefined();
    }
    expect(parseCodexHookInput("{}")).toEqual({});
  });

  it("denies unreadable input rather than continuing the call", () => {
    for (const raw of ["", "{", "[]", "null"]) {
      expect(denial(turn(raw)).permissionDecision, raw).toBe("deny");
    }
  });
});

describe("the interceptor decision", () => {
  it("denies an invocation that names no tool", () => {
    for (const input of [{}, { tool_name: "" }, { tool_name: 7 }]) {
      const decision = decideCodexHookInvocation(state, input, OBSERVED_AT, SESSION_FENCE);
      expect(decision.allowed).toBe(false);
    }
  });

  it("refuses an unadjudicable surface BEFORE the shared decision reads its absent operands", () => {
    const decision = decideCodexHookInvocation(
      state,
      { tool_name: "Write", tool_source: "mcp", tool_input: { file_path: "/work/tree/src/a.ts" } },
      OBSERVED_AT,
      SESSION_FENCE,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("unenforceable_tool_surface");
  });

  it("reaches the one shared grant decision rather than re-authoring it", () => {
    // Outside the grant's capabilities.
    expect(decideCodexHookInvocation(state, { tool_name: "Edit" }, OBSERVED_AT, SESSION_FENCE).allowed).toBe(false);
    // Inside the grant but writing a protected authority path.
    expect(
      decideCodexHookInvocation(
        state,
        { tool_name: "Write", tool_input: { file_path: "/work/tree/.git/config" } },
        OBSERVED_AT,
        SESSION_FENCE,
      ).allowed,
    ).toBe(false);
    // A superseded session's fence closes its tools.
    expect(
      decideCodexHookInvocation(
        state,
        { tool_name: "Write", tool_input: { file_path: "/work/tree/src/a.ts" } },
        OBSERVED_AT,
        SESSION_FENCE - 1,
      ).allowed,
    ).toBe(false);
    // No state at all denies everything.
    expect(
      decideCodexHookInvocation(undefined, { tool_name: "Read" }, OBSERVED_AT, SESSION_FENCE).allowed,
    ).toBe(false);
  });

  it("renders a denial for every one of those, so no defect becomes a continuation", () => {
    const documents = [
      turn(JSON.stringify({ tool_name: "Edit" })),
      turn(JSON.stringify({ tool_name: "Write", tool_source: "hosted" })),
      turn(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/work/tree/.git/config" } })),
      turn(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/work/tree/src/a.ts" } }), SESSION_FENCE - 1),
      turn("{}"),
    ];
    for (const document of documents) {
      expect(document.length, document).toBeGreaterThan(0);
      expect(denial(document).permissionDecision).toBe("deny");
      expect(denial(document).permissionDecisionReason.length).toBeGreaterThan(0);
    }
  });
});
