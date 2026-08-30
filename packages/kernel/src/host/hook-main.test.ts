/**
 * The model-external hook decisions: deny-until-attested from inside the
 * host's PreToolUse surface. The hook consumes the binding's state file and
 * the frozen admission decisions — a missing, unreadable, or stale state
 * denies everything, and no output the model produces can widen that.
 *
 * Written RED before `hook-main.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import { decideHookInvocation, renderHookDecision, type HookBindingState } from "./hook-main.ts";

const grant = {
  spec: "execution-grant/1",
  profile: "checkpoint",
  allowedCapabilities: ["Bash", "Write", "Read"],
  writablePaths: ["src", "tests", "tools"],
  protectedPaths: [".git", ".managed-projection"],
  forbiddenOperations: [],
};

const expectation = {
  profile: "checkpoint",
  hostVersion: "2.1.97",
  productTrustRevocationEpoch: 0,
  observedAt: "2026-08-30T12:00:00Z",
  deliveryId: "dlv-hook",
  invocationFence: 1,
  workspaceId: "ws-hook",
  projectionDigest: "a".repeat(64),
  discoveryConfigurationDigest: "b".repeat(64),
  registeringInstallationId: "install-1",
  activeProfile: "confirmation-fixture",
} as const;

const attestation = {
  spec: "grant-attestation/1",
  profile: "checkpoint",
  hostVersion: "2.1.97",
  grantDigest: digestCanonical(grant),
  productTrustRevocationEpoch: 0,
  expiry: "2026-08-30T13:00:00Z",
  intakeDraftId: "absent-by-state",
  deliveryId: "dlv-hook",
  invocationFence: 1,
  workspaceId: "ws-hook",
  projectionDigest: "a".repeat(64),
  discoveryConfigurationDigest: "b".repeat(64),
  registeringInstallationId: "install-1",
  activeProfile: "confirmation-fixture",
};

/** The fence this fixture session was admitted under — the expectation's own. */
const SESSION_FENCE = expectation.invocationFence;

const state: HookBindingState = {
  expectation,
  grant,
  attestation,
  workspaceRoot: "/work/tree",
  observationPath: "/ns/observation.json",
};

describe("decideHookInvocation", () => {
  it("allows a granted capability writing inside the grant", () => {
    const decision = decideHookInvocation(state, {
      tool_name: "Write",
      tool_input: { file_path: "/work/tree/src/greet.mjs" },
    }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(true);
  });

  it("denies a write under a protected authority path", () => {
    const decision = decideHookInvocation(state, {
      tool_name: "Write",
      tool_input: { file_path: "/work/tree/.managed-projection/consumption.json" },
    }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });

  it("denies a write outside the workspace entirely", () => {
    const decision = decideHookInvocation(state, {
      tool_name: "Write",
      tool_input: { file_path: "/etc/passwd" },
    }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });

  it("denies a capability outside the attested grant", () => {
    const decision = decideHookInvocation(state, { tool_name: "WebFetch", tool_input: {} }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });

  it("denies a confirmation-class operation even though the model can name it", () => {
    const decision = decideHookInvocation(
      state,
      { tool_name: "operator-confirmation.takeover-authorization", tool_input: {} },
      "2026-08-30T12:01:00Z",
      SESSION_FENCE,
    );
    expect(decision.allowed).toBe(false);
  });

  it("denies everything when no binding state exists — deny-until-attested", () => {
    const decision = decideHookInvocation(undefined, { tool_name: "Read", tool_input: {} }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });

  it("re-denies once the attestation expires at the observation instant", () => {
    const decision = decideHookInvocation(state, { tool_name: "Read", tool_input: {} }, "2026-08-30T13:00:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });
});

describe("the superseded-session check", () => {
  it("denies every tool when the session's admitted fence is not the state file's", () => {
    const decision = decideHookInvocation(state, { tool_name: "Read", tool_input: {} }, "2026-08-30T12:01:00Z", SESSION_FENCE + 1);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("superseded_session");
  });
});

describe("renderHookDecision", () => {
  it("renders a deny as the host's PreToolUse deny document", () => {
    const rendered = JSON.parse(
      renderHookDecision({ allowed: false, reason: "capability outside the attested grant" }),
    ) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    expect(rendered.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(rendered.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(rendered.hookSpecificOutput.permissionDecisionReason).toContain("grant");
  });

  it("renders an allow as an empty defer — the host's own permission system still applies", () => {
    expect(renderHookDecision({ allowed: true })).toBe("");
  });
});
