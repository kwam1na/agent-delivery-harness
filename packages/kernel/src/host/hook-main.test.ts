/**
 * The model-external hook decisions: deny-until-attested from inside the
 * host's PreToolUse surface. The hook consumes the binding's state file and
 * the frozen admission decisions — a missing, unreadable, or stale state
 * denies everything, and no output the model produces can widen that.
 *
 * Written RED before `hook-main.ts` existed.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import { PROJECTION_DIR } from "./claude-code.ts";
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
  // What the materialization receipt lists: FILES only. No directory and no
  // glob is ever a receipted entry, which is the fact the lockout case below
  // turns on.
  const receipted = ["consumption.json", "workflows/delivery-v1.json", "skills/deliver-work/SKILL.md"];
  const touched = (toolInput: Record<string, unknown>) => projectionEntryTouched(root, toolInput, receipted);

  it("names the receipted entry a file-naming member resolves to", () => {
    expect(touched({ file_path: "/work/tree/.managed-projection/skills/deliver-work/SKILL.md" })).toBe(
      "skills/deliver-work/SKILL.md",
    );
    expect(touched({ path: ".managed-projection/workflows/delivery-v1.json" })).toBe("workflows/delivery-v1.json");
    expect(touched({ notebook_path: ".managed-projection/consumption.json" })).toBe("consumption.json");
  });

  it("names nothing for a RECEIPTED path a session merely mentions", () => {
    // The case that stayed open until the member restriction landed, and the
    // one worth asserting most: receipted paths are NOT secret —
    // consumption.json is constant and every skills/ and workflows/ entry is
    // enumerable from the pinned generation — so containment alone cannot
    // stop a session from naming a real one in free text. Only the member
    // restriction can, and each payload here names a genuinely receipted
    // entry, so the assertion fails the moment that restriction is dropped.
    const real = ".managed-projection/skills/deliver-work/SKILL.md";
    expect(touched({ command: "echo hi", description: real })).toBeUndefined();
    expect(touched({ command: `cat ${real}` })).toBeUndefined();
    expect(touched({ pattern: ".managed-projection/workflows/delivery-v1.json", path: "src" })).toBeUndefined();
    expect(touched({ file_path: "/work/tree/src/greet.mjs", old_string: real })).toBeUndefined();
    expect(touched({ prompt: `read ${real}` })).toBeUndefined();
  });

  it("names nothing the receipt does not list, so no unadmissible name burns the one-shot slot", () => {
    // THE LOCKOUT. The observation is recorded once per fence, so a name that
    // could never be admitted must not consume that slot. A Grep over the
    // skills directory names a DIRECTORY; the receipt lists files only.
    // Recording it would leave the honest Read that follows locked out and
    // the delivery excluded — and searching a directory before reading a file
    // in it is ordinary agent behavior.
    expect(touched({ pattern: "finish line", path: ".managed-projection/skills" })).toBeUndefined();
    expect(touched({ path: ".managed-projection/workflows" })).toBeUndefined();
    expect(touched({ file_path: ".managed-projection/skills/invented.md" })).toBeUndefined();
    expect(touched({ file_path: ".managed-projection" })).toBeUndefined();
    // ...and the honest read that follows still names its entry.
    expect(touched({ file_path: ".managed-projection/skills/deliver-work/SKILL.md" })).toBe(
      "skills/deliver-work/SKILL.md",
    );
  });

  it("names nothing for anything outside the projection subtree", () => {
    // A sibling whose name merely starts with the subtree's, a traversal back
    // out, the ambient vendored generation, another tree's projection, and
    // non-string arguments all name no entry — otherwise ordinary work, or a
    // delivery that never opened the subtree, would read as a projection touch.
    expect(touched({ file_path: "/work/tree/src/greet.mjs" })).toBeUndefined();
    expect(touched({ file_path: "/work/tree/.managed-projection-notes/consumption.json" })).toBeUndefined();
    expect(touched({ file_path: "/work/tree/.managed-projection/../src/a.ts" })).toBeUndefined();
    expect(touched({ file_path: "/work/tree/.agent-skills/workflows/delivery-v1.json" })).toBeUndefined();
    expect(touched({ file_path: "/elsewhere/.managed-projection/consumption.json" })).toBeUndefined();
    expect(touched({ count: 3, enabled: true, file_path: "" })).toBeUndefined();
  });

  it("sees nothing when the run reaches its workflow without naming a path", () => {
    // THE KNOWN UNDER-OBSERVATION, pinned so it cannot be forgotten or
    // quietly claimed away. A skill invocation names a skill, not a file, and
    // a shell command carrying arguments does not resolve as a path — so a
    // run that reaches its workflow source either way is invisible here and
    // its delivery is EXCLUDED rather than affirmed. That is the safe
    // direction, and it is why the milestone may stay unscoreable until the
    // binding can observe the host's own skill resolution.
    expect(touched({ skill: "deliver-work", args: "execute" })).toBeUndefined();
    expect(touched({ command: "cat .managed-projection/workflows/delivery-v1.json" })).toBeUndefined();
  });

  it("names the entry when the host reports the path through a symlinked root", () => {
    // REGRESSION, found by a live host probe and invisible to every fixture
    // that came before it: the host reports paths in resolved form while the
    // workspace root arrives as the operator wrote it. Under a symlinked
    // parent — the macOS system temp root is one, `/var` -> `/private/var` —
    // a lexical comparison turns every genuine read into an apparent escape
    // and observes NOTHING. That failure is silent by construction, because
    // an unobserved consumption is spelled exactly like an honest absence.
    const real = mkdtempSync(path.join(realpathSync(tmpdir()), "projection-symlink-"));
    const link = `${real}-link`;
    mkdirSync(path.join(real, PROJECTION_DIR, "workflows"), { recursive: true });
    writeFileSync(path.join(real, PROJECTION_DIR, "workflows", "delivery-v1.json"), "{}\n");
    symlinkSync(real, link);
    try {
      // Workspace root reached through the link; the host names the resolved
      // path, exactly as it did in the probe.
      expect(
        projectionEntryTouched(link, { file_path: path.join(real, PROJECTION_DIR, "workflows", "delivery-v1.json") }, [
          "workflows/delivery-v1.json",
        ]),
      ).toBe("workflows/delivery-v1.json");
      // And the converse pairing, so neither direction regresses.
      expect(
        projectionEntryTouched(real, { file_path: path.join(link, PROJECTION_DIR, "workflows", "delivery-v1.json") }, [
          "workflows/delivery-v1.json",
        ]),
      ).toBe("workflows/delivery-v1.json");
      // Resolving must not smuggle in a path outside the subtree.
      expect(projectionEntryTouched(link, { file_path: path.join(real, "elsewhere.md") }, ["elsewhere.md"])).toBeUndefined();
    } finally {
      unlinkSync(link);
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("names nothing when the receipt is unavailable", () => {
    // Fail-safe: no receipt, no admissible name, no observation.
    expect(projectionEntryTouched(root, { file_path: ".managed-projection/consumption.json" }, [])).toBeUndefined();
  });
});
