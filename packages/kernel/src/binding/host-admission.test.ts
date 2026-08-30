/**
 * Unit edges of the model-external admission decisions. The scenario battery
 * lives in the frozen qualification fixtures and runs from
 * `scripts/check-host-admission-capabilities.test.ts`; this suite pins the
 * local decision edges those fixtures do not enumerate: fail-closed caller
 * input, expiry boundary semantics, denial totality, and path scoping edges.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import {
  evaluateConfirmationEcho,
  evaluateHostAdmission,
  evaluateToolInvocation,
  type CheckpointAdmissionExpectation,
} from "./host-admission.ts";

const grant = {
  spec: "execution-grant/1",
  profile: "checkpoint",
  allowedCapabilities: ["fs.write"],
  writablePaths: ["src"],
  protectedPaths: [".git"],
  forbiddenOperations: [],
};

const sha = (label: string): string => digestCanonical({ label });

const expectation: CheckpointAdmissionExpectation = {
  profile: "checkpoint",
  hostVersion: "unit-host/1",
  productTrustRevocationEpoch: 1,
  observedAt: "2026-08-30T12:00:00Z",
  deliveryId: "dlv-unit",
  invocationFence: 2,
  workspaceId: "ws-unit",
  projectionDigest: sha("projection"),
  discoveryConfigurationDigest: sha("discovery"),
  registeringInstallationId: "install-unit",
  activeProfile: "default",
};

const attestation = {
  spec: "grant-attestation/1",
  profile: "checkpoint",
  hostVersion: "unit-host/1",
  grantDigest: digestCanonical(grant),
  productTrustRevocationEpoch: 1,
  expiry: "2026-08-30T12:01:00Z",
  intakeDraftId: "absent-by-state",
  deliveryId: "dlv-unit",
  invocationFence: 2,
  workspaceId: "ws-unit",
  projectionDigest: sha("projection"),
  discoveryConfigurationDigest: sha("discovery"),
  registeringInstallationId: "install-unit",
  activeProfile: "default",
};

describe("evaluateHostAdmission edges", () => {
  it("admits the aligned pair", () => {
    expect(evaluateHostAdmission(expectation, grant, attestation).admitted).toBe(true);
  });

  it("fails closed on a malformed caller expectation", () => {
    const bad = { ...expectation, observedAt: "yesterday-ish" };
    const decision = evaluateHostAdmission(bad, grant, attestation);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) expect(decision.denials[0]?.code).toBe("malformed_expectation");
  });

  it("treats expiry equal to the observation instant as expired", () => {
    const decision = evaluateHostAdmission(expectation, grant, { ...attestation, expiry: expectation.observedAt });
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) expect(decision.denials.map((d) => d.code)).toContain("attestation_expired");
  });

  it("reports every mismatch, not the first one", () => {
    const drifted = { ...attestation, invocationFence: 1, workspaceId: "ws-other", projectionDigest: sha("tampered") };
    const decision = evaluateHostAdmission(expectation, grant, drifted);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      const codes = decision.denials.map((d) => d.code);
      expect(codes).toContain("fence_mismatch");
      expect(codes).toContain("workspace_mismatch");
      expect(codes).toContain("projection_digest_mismatch");
    }
  });
});

describe("evaluateToolInvocation path scoping", () => {
  const decide = (writes: readonly string[]) =>
    evaluateToolInvocation(expectation, grant, attestation, { capability: "fs.write", writes });

  it("a prefix sibling is outside the grant", () => {
    const decision = decide(["srcx/file.ts"]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.denials[0]?.code).toBe("write_outside_grant");
  });

  it("the writable root itself is inside the grant", () => {
    expect(decide(["src"]).allowed).toBe(true);
  });

  it("absolute, dot-segment, and empty-segment paths fail closed as unnormalized", () => {
    for (const write of ["/etc/passwd", "src/./x.ts", "src//x.ts", ""]) {
      const decision = decide([write]);
      expect(decision.allowed, write).toBe(false);
      if (!decision.allowed) expect(decision.denials[0]?.code).toBe("unnormalized_path");
    }
  });

  it("one bad path denies the whole invocation", () => {
    const decision = decide(["src/ok.ts", ".git/config"]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.denials.map((d) => d.code)).toContain("protected_path");
  });
});

describe("evaluateConfirmationEcho totality", () => {
  it("accumulates every failing condition", () => {
    const decision = evaluateConfirmationEcho(
      { channelId: "ch-1", channelOpen: false, interactive: true, challenge: "c-1", consumed: true, expiry: "2026-08-30T12:00:00Z" },
      { presentedChallenge: "c-2", presentedOnChannelId: "ch-2", observedAt: "2026-08-30T12:00:00Z", viaModelVisibleSurface: true, interactive: false },
    );
    expect(decision.completed).toBe(false);
    if (!decision.completed) {
      const codes = decision.denials.map((d) => d.code).sort();
      expect(codes).toEqual([
        "challenge_consumed",
        "challenge_expired",
        "challenge_mismatch",
        "channel_closed",
        "model_visible_surface_refused",
        "non_interactive_refused",
        "wrong_channel",
      ]);
    }
  });
});
