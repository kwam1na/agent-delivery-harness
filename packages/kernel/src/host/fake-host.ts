/**
 * A FAKE HOST that satisfies the conformance contract with no host at all: no
 * worktree, no settings file, no hook, no sandbox. It exists so the contract
 * can be exercised — and a future host's implementation debugged — without any
 * authenticated session, and so the contract's normalized outcomes are visibly
 * separable from any one host's mechanism.
 *
 * Its admission decisions run through the SAME model-external validator the
 * real bindings use, so the fake host is a deterministic conformance fixture
 * rather than a second, weaker implementation of the rules.
 */
import { evaluateHostAdmission, evaluateToolInvocation, type CheckpointAdmissionExpectation } from "../binding/host-admission.ts";
import { grantDigest } from "../spine/grant.ts";
import { gradeResumeEligibility } from "./claude-code.ts";
import type {
  HostAdmissionScenario,
  HostIntegrationPort,
  HostInterceptionScenario,
  NormalizedAdmission,
  NormalizedInterception,
  NormalizedTermination,
  NormalizedTeardown,
} from "./conformance.ts";

const EXPECTATION: CheckpointAdmissionExpectation = Object.freeze({
  profile: "checkpoint",
  hostVersion: "fake-host/1.0.0",
  productTrustRevocationEpoch: 1,
  observedAt: "2026-08-30T12:00:00Z",
  deliveryId: "dlv-fake-01",
  invocationFence: 9,
  workspaceId: "ws-fake-01",
  projectionDigest: "c".repeat(64),
  discoveryConfigurationDigest: "d".repeat(64),
  registeringInstallationId: "install-fake-01",
  activeProfile: "default",
});

const GRANT = Object.freeze({
  spec: "execution-grant/1",
  profile: "checkpoint",
  allowedCapabilities: ["Read", "Write"],
  writablePaths: ["src"],
  protectedPaths: [".git", ".managed-projection"],
  forbiddenOperations: [],
});

const attestationFor = (expectation: CheckpointAdmissionExpectation): Record<string, unknown> => ({
  spec: "grant-attestation/1",
  profile: "checkpoint",
  hostVersion: expectation.hostVersion,
  grantDigest: grantDigest(GRANT),
  productTrustRevocationEpoch: expectation.productTrustRevocationEpoch,
  expiry: "2026-08-30T13:00:00Z",
  intakeDraftId: "absent-by-state",
  deliveryId: expectation.deliveryId,
  invocationFence: expectation.invocationFence,
  workspaceId: expectation.workspaceId,
  projectionDigest: expectation.projectionDigest,
  discoveryConfigurationDigest: expectation.discoveryConfigurationDigest,
  registeringInstallationId: expectation.registeringInstallationId,
  activeProfile: expectation.activeProfile,
});

/** The attestation each scenario presents against the port's CURRENT expectation. */
const attestationForScenario = (scenario: HostAdmissionScenario): unknown => {
  switch (scenario) {
    case "current":
      return attestationFor(EXPECTATION);
    case "before-attestation":
      return undefined;
    case "stale-fence":
      return attestationFor({ ...EXPECTATION, invocationFence: EXPECTATION.invocationFence - 1 });
    case "sibling-delivery":
      return attestationFor({ ...EXPECTATION, deliveryId: "dlv-fake-02" });
  }
};

const requestForScenario = (scenario: HostInterceptionScenario): Parameters<typeof evaluateToolInvocation>[3] => {
  switch (scenario) {
    case "granted-capability":
      return { capability: "Write", writes: ["src/module.ts"] };
    case "ungranted-capability":
      return { capability: "Bash" };
    case "protected-path-write":
      return { capability: "Write", writes: [".managed-projection/skills/SKILL.md"] };
    case "operator-confirmation":
      return { capability: "Read", operation: "operator-confirmation.takeover" };
  }
};

export function createFakeHostConformancePort(input: {
  readonly descendantTeardown: "verified" | "unverified";
}): HostIntegrationPort {
  // The fake host's "binding-written set": names only, since it writes no
  // bytes. Teardown empties it, and the residue check reads it back.
  let written: string[] = ["fake://settings", "fake://worktree-excludes", "fake://projection"];

  return {
    hostId: "fake-host",
    hostVersion: EXPECTATION.hostVersion,

    async admit(scenario: HostAdmissionScenario): Promise<NormalizedAdmission> {
      const decision = evaluateHostAdmission(EXPECTATION, GRANT, attestationForScenario(scenario));
      return decision.admitted
        ? { outcome: "admitted" }
        : { outcome: "denied", codes: decision.denials.map((denial) => denial.code) };
    },

    async intercept(scenario: HostInterceptionScenario): Promise<NormalizedInterception> {
      const decision = evaluateToolInvocation(
        EXPECTATION,
        GRANT,
        attestationFor(EXPECTATION),
        requestForScenario(scenario),
      );
      return decision.allowed
        ? { outcome: "allowed" }
        : { outcome: "denied", codes: decision.denials.map((denial) => denial.code) };
    },

    async terminate(): Promise<NormalizedTermination> {
      return {
        provenance: "graceful",
        descendantTeardown: input.descendantTeardown,
        resumeEligibility: gradeResumeEligibility({ descendantTeardown: input.descendantTeardown }),
      };
    },

    async tearDown(): Promise<NormalizedTeardown> {
      written = [];
      return { outcome: "torn-down", residue: written };
    },
  };
}
