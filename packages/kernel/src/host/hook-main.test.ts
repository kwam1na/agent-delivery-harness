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
import {
  decideHookInvocation,
  projectionEntryTouched,
  renderHookDecision,
  type HookBindingState,
} from "./hook-main.ts";

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

describe("projectionEntryTouched", () => {
  const root = "/work/tree";

  it("names the projection path an invocation names, in whichever argument carries it", () => {
    // No member allowlist: the member carrying a path differs per tool, and
    // trusting a fixed set would drop the next tool that reads a file while
    // buying nothing — a session willing to steer the observation would just
    // use a trusted member. What a NAMED path is worth is settled downstream,
    // where the writer requires it to be a receipted entry.
    expect(projectionEntryTouched(root, { file_path: "/work/tree/.managed-projection/skills/core/SKILL.md" })).toBe(
      "skills/core/SKILL.md",
    );
    expect(projectionEntryTouched(root, { path: ".managed-projection/workflows/delivery-v1.json" })).toBe(
      "workflows/delivery-v1.json",
    );
    expect(projectionEntryTouched(root, { pattern: "**/*.ts", path: ".managed-projection/consumption.json" })).toBe(
      "consumption.json",
    );
  });

  it("names nothing for anything outside the projection subtree", () => {
    // The negative half, asserted as specifically as the positive: a sibling
    // whose name merely starts with the subtree's, a traversal back out, the
    // ambient vendored generation, another tree's projection, the subtree root
    // itself, and non-string arguments all name no entry — otherwise ordinary
    // work would read as a projection touch.
    expect(projectionEntryTouched(root, { file_path: "/work/tree/src/greet.mjs" })).toBeUndefined();
    expect(projectionEntryTouched(root, { file_path: "/work/tree/.managed-projection-notes/x.md" })).toBeUndefined();
    expect(projectionEntryTouched(root, { file_path: "/work/tree/.managed-projection/../src/a.ts" })).toBeUndefined();
    expect(projectionEntryTouched(root, { file_path: "/work/tree/.agent-skills/skills/core/SKILL.md" })).toBeUndefined();
    expect(projectionEntryTouched(root, { file_path: "/work/tree/.managed-projection" })).toBeUndefined();
    expect(projectionEntryTouched(root, { file_path: "/elsewhere/.managed-projection/a.md" })).toBeUndefined();
    expect(projectionEntryTouched(root, { count: 3, enabled: true, empty: "" })).toBeUndefined();
  });

  it("sees nothing when the run reaches its workflow without naming a path", () => {
    // THE KNOWN UNDER-OBSERVATION, pinned so it cannot be forgotten or
    // quietly claimed away. A skill invocation names a skill, not a file, and
    // a shell command carrying arguments does not resolve as a path — so a
    // run that reaches its workflow source either way is invisible to this
    // predicate and its delivery is EXCLUDED from the comparison set rather
    // than affirmed. That is the safe direction, and it is also why the
    // milestone may stay unscoreable until the binding can observe the host's
    // own skill resolution.
    expect(projectionEntryTouched(root, { skill: "deliver-work", args: "execute" })).toBeUndefined();
    expect(projectionEntryTouched(root, { command: "cat .managed-projection/workflows/delivery-v1.json" })).toBeUndefined();

    // And the converse boundary: this function reports NAMING, not reading or
    // admissibility. A bare mention resolves, and the writer's receipt
    // containment is what separates a receipted entry from anything else.
    expect(projectionEntryTouched(root, { description: ".managed-projection/invented.md" })).toBe("invented.md");
  });
});
