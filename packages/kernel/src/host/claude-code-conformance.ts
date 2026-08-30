/**
 * The Claude Code binding's adapter onto the host-neutral conformance
 * contract. Everything host-specific lives here — the materialized projection,
 * the worktree-scoped exclusion, the composed session settings, the
 * model-external hook wiring — and none of it escapes into the contract, which
 * sees only normalized outcomes.
 *
 * The adapter is a QUALIFICATION surface, not a delivery lane: it drives the
 * same binding functions the facade drives, so what the contract exercises is
 * the real projection lifecycle and the real admission validator, on a real
 * worktree. It launches nothing — composing a session returns admission data
 * that a test harness or an operator hands to the host.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { evaluateHostAdmission, evaluateToolInvocation, type CheckpointAdmissionExpectation } from "../binding/host-admission.ts";
import {
  PROJECTION_DIR,
  PROJECTION_RECEIPT_FILE,
  SESSION_SETTINGS_FILE,
  WORKTREE_EXCLUDES_FILE,
  composeClaudeCodeSession,
  gradeResumeEligibility,
  materializeProjection,
  mintGrantAttestation,
  tearDownProjection,
} from "./claude-code.ts";
import type {
  HostAdmissionScenario,
  HostIntegrationPort,
  HostInterceptionScenario,
  NormalizedAdmission,
  NormalizedInterception,
  NormalizedTermination,
  NormalizedTeardown,
} from "./conformance.ts";
import { createExecPort } from "./exec-port.ts";

export interface ClaudeCodeConformancePortInput {
  readonly worktreeDir: string;
  readonly generationRoot: string;
  readonly bindingDir: string;
  readonly deliveryId: string;
  readonly fence: number;
  readonly hostVersion: string;
  /**
   * The graded teardown status this qualification port reports. It is a
   * FIXTURE parameter, so the contract can be exercised against both grades
   * without waiting for a Tier 3 host to exist — the delivery lane reads the
   * grade from the pinned generation's capability record instead and accepts
   * no such parameter. A caller pairing `verified` with a host version the
   * record grades below Tier 3 is stating a contradiction, so tests pair
   * `verified` with a hypothetical version.
   */
  readonly descendantTeardown: "verified" | "unverified";
}

/**
 * The stage grant this qualification lane applies. `.git` and the receipted
 * projection subtree are protected authority paths; operator confirmations are
 * excluded from every grant by construction, not by this list.
 */
const STAGE_GRANT = Object.freeze({
  spec: "execution-grant/1",
  profile: "checkpoint",
  allowedCapabilities: ["Read", "Write"],
  writablePaths: ["src"],
  protectedPaths: [".git", PROJECTION_DIR],
  forbiddenOperations: [],
});

export function createClaudeCodeConformancePort(input: ClaudeCodeConformancePortInput): HostIntegrationPort {
  const exec = createExecPort();
  let expectation: CheckpointAdmissionExpectation | undefined;
  let prepared: Promise<void> | undefined;

  /**
   * Materializes the projection and composes the session once, then mints the
   * expectation the validator checks against. Failure leaves `expectation`
   * undefined, which denies everything — a failed grant application yields no
   * mutation-capable invocation token.
   */
  const prepare = async (): Promise<void> => {
    const materialized = await materializeProjection({
      worktreeDir: input.worktreeDir,
      generationRoot: input.generationRoot,
      deliveryId: input.deliveryId,
      fence: input.fence,
      bindingDir: input.bindingDir,
      exec,
    });
    if (!materialized.ok) return;
    const session = await composeClaudeCodeSession({
      bindingDir: input.bindingDir,
      statePath: path.join(input.bindingDir, "state.json"),
      hookCommand: ["node", "--import", "tsx", "hook-main.ts"],
      fence: input.fence,
      grant: STAGE_GRANT,
    });
    if (!session.ok) return;
    expectation = {
      profile: "checkpoint",
      hostVersion: input.hostVersion,
      productTrustRevocationEpoch: 0,
      observedAt: "2026-08-30T12:00:00Z",
      deliveryId: input.deliveryId,
      invocationFence: input.fence,
      workspaceId: `ws-${input.deliveryId}`,
      projectionDigest: materialized.projectionDigest,
      discoveryConfigurationDigest: session.discoveryConfigurationDigest,
      registeringInstallationId: "install-conformance",
      activeProfile: "confirmation-fixture",
    };
  };

  const ready = async (): Promise<CheckpointAdmissionExpectation | undefined> => {
    prepared ??= prepare();
    await prepared;
    return expectation;
  };

  const attestationFor = (current: CheckpointAdmissionExpectation, scenario: HostAdmissionScenario): unknown => {
    switch (scenario) {
      case "current":
        return mintGrantAttestation({ grant: STAGE_GRANT, expectation: current, expiry: "2026-08-30T13:00:00Z" });
      case "before-attestation":
        return undefined;
      case "stale-fence":
        return mintGrantAttestation({
          grant: STAGE_GRANT,
          expectation: { ...current, invocationFence: current.invocationFence - 1 },
          expiry: "2026-08-30T13:00:00Z",
        });
      case "sibling-delivery":
        return mintGrantAttestation({
          grant: STAGE_GRANT,
          expectation: { ...current, deliveryId: `${current.deliveryId}-sibling` },
          expiry: "2026-08-30T13:00:00Z",
        });
    }
  };

  const requestFor = (scenario: HostInterceptionScenario): Parameters<typeof evaluateToolInvocation>[3] => {
    switch (scenario) {
      case "granted-capability":
        return { capability: "Write", writes: ["src/module.ts"] };
      case "ungranted-capability":
        return { capability: "Bash" };
      case "protected-path-write":
        return { capability: "Write", writes: [`${PROJECTION_DIR}/consumption.json`] };
      case "operator-confirmation":
        return { capability: "Read", operation: "operator-confirmation.contract" };
    }
  };

  return {
    hostId: "claude-code",
    hostVersion: input.hostVersion,

    async admit(scenario: HostAdmissionScenario): Promise<NormalizedAdmission> {
      const current = await ready();
      if (current === undefined) {
        return { outcome: "denied", codes: ["grant_application_failed"] };
      }
      const decision = evaluateHostAdmission(current, STAGE_GRANT, attestationFor(current, scenario));
      return decision.admitted
        ? { outcome: "admitted" }
        : { outcome: "denied", codes: decision.denials.map((denial) => denial.code) };
    },

    async intercept(scenario: HostInterceptionScenario): Promise<NormalizedInterception> {
      const current = await ready();
      if (current === undefined) {
        return { outcome: "denied", codes: ["grant_application_failed"] };
      }
      const decision = evaluateToolInvocation(
        current,
        STAGE_GRANT,
        mintGrantAttestation({ grant: STAGE_GRANT, expectation: current, expiry: "2026-08-30T13:00:00Z" }),
        requestFor(scenario),
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
      await ready();
      const torn = await tearDownProjection({
        worktreeDir: input.worktreeDir,
        bindingDir: input.bindingDir,
        exec,
      });
      if (!torn.ok) {
        return { outcome: "failed", residue: torn.blockers.map((blocker) => blocker.code) };
      }
      const residue = [
        path.join(input.worktreeDir, PROJECTION_DIR),
        path.join(input.bindingDir, SESSION_SETTINGS_FILE),
        path.join(input.bindingDir, WORKTREE_EXCLUDES_FILE),
        path.join(input.bindingDir, PROJECTION_RECEIPT_FILE),
      ].filter((candidate) => existsSync(candidate));
      return { outcome: "torn-down", residue };
    },
  };
}
