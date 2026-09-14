/**
 * The Codex app-server binding's adapter onto the host-neutral conformance
 * contract. Everything Codex-specific lives here — the per-fence named
 * permission profile, the synchronous `pre_tool_use` command hook, the
 * in-memory thread-start configuration and its applied-configuration check —
 * and none of it escapes into the contract, which sees only normalized
 * outcomes.
 *
 * A QUALIFICATION surface, not a delivery lane, and MODEL-FREE: it drives the
 * same binding functions the facade drives, on a real worktree, and it
 * launches nothing. No app-server process is started, no thread is opened, and
 * no turn runs. What stands in for the host is the applied-configuration
 * report the port is handed, which is exactly the seam a live operator-owned
 * lane would fill with the host's own answer.
 *
 * The ordering this port exists to prove: the applied configuration is
 * verified BEFORE an attestation is minted, so a host that applied something
 * else admits nothing.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  evaluateHostAdmission,
  evaluateToolInvocation,
  type CheckpointAdmissionExpectation,
} from "../binding/host-admission.ts";
import {
  CODEX_APP_SERVER_HOST_ID,
  CODEX_HOOK_EVENT,
  CODEX_HOOK_EXECUTION_MODE,
  codexAppServerBinding,
  composeCodexAppServerThread,
  verifyAppliedCodexThreadConfiguration,
  type CodexAppliedThreadConfiguration,
  type ComposeCodexAppServerThreadResult,
} from "./codex-app-server.ts";
import {
  PROJECTION_DIR,
  PROJECTION_RECEIPT_FILE,
  WORKTREE_EXCLUDES_FILE,
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
  NormalizedTeardown,
  NormalizedTermination,
} from "./conformance.ts";
import { createExecPort } from "./exec-port.ts";

export interface CodexAppServerConformancePortInput {
  readonly worktreeDir: string;
  readonly generationRoot: string;
  readonly bindingDir: string;
  readonly deliveryId: string;
  readonly fence: number;
  readonly hostVersion: string;
  /**
   * The graded teardown status this qualification port reports. A FIXTURE
   * parameter, exactly as the Claude port's is: the delivery lane reads the
   * grade from the pinned generation's capability record instead. Codex is
   * graded Tier 0 here, so a caller pairing `verified` with a real Codex
   * version is stating a contradiction.
   */
  readonly descendantTeardown: "verified" | "unverified";
  /**
   * What the host reports it applied, which a live operator-owned lane would
   * read off the app server. Omitted means the host reported nothing, which is
   * the deny case: nothing is verified, so nothing is attested.
   */
  readonly appliedConfiguration?: (composed: ComposeCodexAppServerThreadResult) => CodexAppliedThreadConfiguration;
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

/**
 * The honest applied-configuration report for a host that applied exactly what
 * was composed. Exported because the live lane and the model-free lane must
 * agree on what "applied correctly" means, rather than each writing its own.
 */
export function faithfullyAppliedCodexConfiguration(
  composed: ComposeCodexAppServerThreadResult,
): CodexAppliedThreadConfiguration {
  const hooks = composed.request.params.config["hooks"] as Record<
    string,
    readonly { readonly hooks: readonly { readonly command: string }[] }[]
  >;
  return {
    permissionProfileId: composed.profile.id,
    sandboxMode: composed.profile.sandboxMode,
    writableRoots: composed.profile.writableRoots,
    deniedWriteRoots: composed.profile.denyWriteRoots,
    deniedReadRoots: composed.profile.denyReadRoots,
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
    hookEvent: CODEX_HOOK_EVENT,
    hookCommand: hooks[CODEX_HOOK_EVENT]?.[0]?.hooks[0]?.command,
    hookExecutionMode: CODEX_HOOK_EXECUTION_MODE,
    enabledUnenforceableToolSources: [],
    configurationDigest: composed.discoveryConfigurationDigest,
  };
}

export function createCodexAppServerConformancePort(
  input: CodexAppServerConformancePortInput,
): HostIntegrationPort {
  const exec = createExecPort();
  let expectation: CheckpointAdmissionExpectation | undefined;
  let prepared: Promise<void> | undefined;

  /**
   * Materializes the projection, composes the thread admission, and — only if
   * the host's applied configuration verifies — mints the expectation the
   * validator checks against. Any failure leaves `expectation` undefined,
   * which denies everything: an unverified application yields no
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
    const commonGitDir = (
      await exec.run({
        command: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: input.worktreeDir,
      })
    ).stdout.trim();

    const composed = await composeCodexAppServerThread({
      bindingDir: input.bindingDir,
      statePath: path.join(input.bindingDir, `state-${input.fence}.json`),
      hookCommand: ["node", "--import", "tsx", "codex-hook-main.ts"],
      fence: input.fence,
      workspaceRoot: input.worktreeDir,
      commonGitDir,
      authorityDir: input.bindingDir,
      grant: STAGE_GRANT,
    });

    // THE ORDERING THIS PORT EXISTS FOR. Verification of what the host applied
    // comes before the expectation exists at all, so no attestation can be
    // minted against an unverified application.
    const applied = input.appliedConfiguration?.(composed);
    if (applied === undefined) return;
    if (!verifyAppliedCodexThreadConfiguration(composed, applied).verified) return;

    expectation = {
      profile: "checkpoint",
      hostVersion: input.hostVersion,
      productTrustRevocationEpoch: 0,
      observedAt: "2026-08-30T12:00:00Z",
      deliveryId: input.deliveryId,
      invocationFence: input.fence,
      workspaceId: `ws-${input.deliveryId}`,
      projectionDigest: materialized.projectionDigest,
      discoveryConfigurationDigest: composed.discoveryConfigurationDigest,
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
    hostId: CODEX_APP_SERVER_HOST_ID,
    hostVersion: input.hostVersion,

    async admit(scenario: HostAdmissionScenario): Promise<NormalizedAdmission> {
      const current = await ready();
      if (current === undefined) {
        return { outcome: "denied", codes: ["applied_configuration_unverified"] };
      }
      const decision = evaluateHostAdmission(current, STAGE_GRANT, attestationFor(current, scenario));
      return decision.admitted
        ? { outcome: "admitted" }
        : { outcome: "denied", codes: decision.denials.map((denial) => denial.code) };
    },

    async intercept(scenario: HostInterceptionScenario): Promise<NormalizedInterception> {
      const current = await ready();
      if (current === undefined) {
        return { outcome: "denied", codes: ["applied_configuration_unverified"] };
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

    /**
     * Codex's descendant teardown is NOT observed by this lane: the host owns
     * interruption and cancellation, and nothing here watches its process
     * tree. The graded status is reported as it is given, and the resume
     * position is derived from it by the one derivation, so this port cannot
     * claim a position the grade does not support.
     */
    async terminate(): Promise<NormalizedTermination> {
      return {
        provenance: "graceful",
        descendantTeardown: input.descendantTeardown,
        resumeEligibility: gradeResumeEligibility({ descendantTeardown: input.descendantTeardown }),
      };
    },

    async tearDown(): Promise<NormalizedTeardown> {
      await ready();
      // The admission configuration is NAMED through the seam rather than
      // respelled here, so teardown removes exactly the file a compose at this
      // fence wrote — one definition, not two that can drift.
      const admissionConfigurationPath = codexAppServerBinding.admissionConfigurationPath(input.bindingDir, input.fence);
      const torn = await tearDownProjection({
        worktreeDir: input.worktreeDir,
        bindingDir: input.bindingDir,
        settingsPath: admissionConfigurationPath,
        exec,
      });
      if (!torn.ok) {
        return { outcome: "failed", residue: torn.blockers.map((blocker) => blocker.code) };
      }
      const residue = [
        path.join(input.worktreeDir, PROJECTION_DIR),
        admissionConfigurationPath,
        path.join(input.bindingDir, WORKTREE_EXCLUDES_FILE),
        path.join(input.bindingDir, PROJECTION_RECEIPT_FILE),
      ].filter((candidate) => existsSync(candidate));
      return { outcome: "torn-down", residue };
    },
  };
}
