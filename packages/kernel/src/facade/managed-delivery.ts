/**
 * The facade module's V-slice: ONE typed operation surface over the walking
 * skeleton's modules — accept an already-scoped contract, bind the
 * host-supplied workspace, drive the checkpoint path, and reconstruct
 * status/resume from durable state — with every mutation-capable operation
 * passing the canonical rechecks (product trust, registering installation and
 * active profile, projection digest) before it touches the journal.
 *
 * WHAT THIS FACADE NEVER DOES: launch a coding agent, schedule a subagent,
 * create or delete a worktree, or advance a checkpoint from a host-activity
 * observation. Worktrees are host-created and handed in; the only processes
 * the facade runs — git plumbing and the trusted-base sensor — go through the
 * injected exec port so the scenario sensor can assert the complete launch
 * inventory.
 *
 * CONFIRMATIONS. Contract confirmation and takeover authorization are
 * operator confirmations: excluded from every execution grant, denied by the
 * interceptor, and served only by this facade's channel. The walking skeleton
 * runs under the composition's `confirmation-fixture` profile — valid only in
 * disposable-repository qualification runs and production-rejected by the
 * installer — where the binding renders the challenge into the
 * installation-scoped confirmation channel file instead of an interactive
 * display. Echo evaluation still runs the frozen model-external decision:
 * a model-visible surface, a closed channel, a consumed or expired challenge,
 * or a wrong echo refuses exactly as in production.
 *
 * RESUME. This host is graded Tier 2: graceful SessionEnd reports honest
 * `paused`, and resume is ALWAYS an operator-authorized takeover into a fresh
 * host-created worktree reconstructed from the last trusted commit — never
 * same-worktree reuse. The takeover confirmation binds the superseded fence,
 * the expected journal revision, and the target base commit, and consumption
 * rejects on any mismatch. The single policy-required authorization is
 * counted as an interruption, never as an operator intervention.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateConfirmationEcho,
  evaluateHostAdmission,
  type CheckpointAdmissionExpectation,
  type ConfirmationEchoAttempt,
  type IntakeAdmissionExpectation,
  type RenderedConfirmationChallenge,
} from "../binding/host-admission.ts";
import { createBlocker, type Blocker } from "../blockers.ts";
import {
  createIntakeJournalStore,
  createJournalStore,
  type IntakeJournalStore,
  type JournalStore,
} from "../checkpoint/journal-store.ts";
import { evaluateCanonicalRecheck, type CompareCheck, type RecheckValues, type ValueCheck } from "../checkpoint/recheck.ts";
import {
  deleteDelivery as runDeliveryDeletion,
  exportDelivery as runDeliveryExport,
  type RetentionContext,
} from "../checkpoint/retention.ts";
import { digestCanonical, sha256Hex } from "../digest.ts";
import { createArtifactsPort } from "../artifacts.ts";
import { runAdmission } from "../admission.ts";
import { buildDeliveryRecord, deliveryRecordBytes, deliveryRecordPathFor, parseDeliveryRecord, verifyDeliveryRecord } from "../delivery-record.ts";
import { publishPreparationReceipt } from "../preparation.ts";
import { discoverRecords, resolveRecordStorage } from "../records.ts";
import { submitManifest } from "../recorder.ts";
import { createCandidateCapture, evaluateCandidateActivation, type CandidateCommandRunner } from "../candidate.ts";
import { withDeliverableIdentity } from "../identity.ts";
import { classifyExecutionContext, type EnvSnapshot } from "../context.ts";
import type { HarnessConfig } from "../config.ts";
import type { CaptureCandidate, CapturedCandidate } from "../candidate.types.ts";
import {
  DISPOSABLE_INTAKE_GRANT,
  DISPOSABLE_REVIEW_LENSES,
  DISPOSABLE_SENSOR_CAPABILITY,
  DISPOSABLE_STAGE_GRANT,
  compileDisposablePolicy,
} from "../policy/disposable.ts";
import {
  checkReviewFloor,
  composeOutcomeVerification,
  qualifyReviewAttempts,
  type RecordedReviewAttempt,
  type RecordedSensorResult,
} from "../evidence/review.ts";
import { composeMergeReadyResult } from "../finish-line/merge-ready.ts";
import {
  GENERATION_SKILLS_ARCHIVE,
  composeClaudeCodeSession,
  materializeProjection,
  mintGrantAttestation,
  verifyProjection,
} from "../host/claude-code.ts";
import { createExecPort, type ExecPort } from "../host/exec-port.ts";
import { PINNED_AGENT_SKILLS, type ProductTrustState } from "../spine/composition.ts";
import { checkContractWithinPolicy, validateAcceptedContract, type AcceptedContract, type OutcomeVerification } from "../spine/contract.ts";
import { validateSensorResult } from "../spine/capability.ts";
import type { PolicySnapshot } from "../spine/policy.ts";
import type { DeliveryState } from "../spine/vocabulary.ts";
import {
  assertionSourceForKind,
  loadPinnedGeneration,
  registrationBinding,
  resolveActiveGeneration,
  trustStorePathFor,
} from "../substrate/installer.ts";
import { loadAssertionProviderConfig, type AssertionSourcePort } from "../substrate/assertion-source.ts";
import { SECURITY_BLOCKED_MIGRATION_ACTION } from "../spine/assertion.ts";
import { evaluateMigrationConsumption } from "./migration.ts";
import { parseTrustState } from "../substrate/trust-store.ts";
import {
  loadBundledWorkflowGraph,
  workflowStageBindingFor,
  workflowStageOf,
  type WorkflowGraph,
} from "../workflow/graph.ts";
import {
  WORKFLOW_CANDIDATE_REF_SPEC,
  WORKFLOW_STAGE_RESULT_SPEC,
  WORKFLOW_SUBJECT_REF_SPEC,
  evaluateStagePrerequisites,
  validateWorkflowStageResult,
  type AcceptedStageResult,
  type CompletedStageSummary,
} from "../workflow/result.ts";

// ── Result and blocker plumbing ────────────────────────────────────────────

const SOURCE = { kind: "command", id: "managed-delivery.facade" } as const;

export type FacadeFailure = { readonly ok: false; readonly blockers: readonly Blocker[] };

const refuse = (code: string, summary: string, remediation: string): FacadeFailure => ({
  ok: false,
  blockers: [
    createBlocker({
      code,
      source: SOURCE,
      summary,
      remediations: [{ id: `${code.replaceAll("_", "-")}-remediation`, kind: "manual_action", summary: remediation }],
    }),
  ],
});

const refuseWith = (blockers: readonly Blocker[]): FacadeFailure => ({ ok: false, blockers });

// ── Durable layout ─────────────────────────────────────────────────────────

const NAMESPACE = "managed-delivery";
const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const HOOK_MAIN = path.resolve(HERE, "..", "host", "hook-main.ts");
const TSX_BIN = path.join(CHECKOUT_ROOT, "node_modules", ".bin", "tsx");

export interface ManagedInstallation {
  readonly installationPath: string;
  readonly receiptDir: string;
}

export interface CreateFacadeInput {
  /** Any checkout of the disposable repository (root or linked worktree). */
  readonly repoDir: string;
  readonly config: HarnessConfig;
  readonly installation: ManagedInstallation;
  readonly hostVersion: string;
  readonly exec?: ExecPort;
}

interface DeliveryMeta {
  readonly contract: AcceptedContract;
  readonly policy: PolicySnapshot;
  readonly generationDigest: string;
  readonly intakeId: string;
}

/**
 * The presentation-time binding of one intake draft: the presented contract,
 * the policy and generation it validated against, and the single-use nonce of
 * the pending confirmation. A draft mutation after presentation clears the
 * nonce — the operator confirmed different bytes.
 */
interface IntakeMeta {
  readonly contract: AcceptedContract;
  readonly policy: PolicySnapshot;
  readonly generationDigest: string;
  readonly nonce?: string;
}

/** The four-member verified release projection every typed stage result binds. */
const RELEASE_IDENTITY = Object.freeze({
  releaseId: PINNED_AGENT_SKILLS.releaseId,
  profile: PINNED_AGENT_SKILLS.profile,
  archiveSha256: PINNED_AGENT_SKILLS.archiveSha256,
  metadataSha256: PINNED_AGENT_SKILLS.metadataSha256,
});

/**
 * Findings-driven review rounds allowed before the bounded-loop blocker
 * records: review repeats until the selected lenses approve OR this bound is
 * reached — the loop cannot spin unobserved forever.
 */
const REVIEW_ROUND_BOUND = 3;

interface WorkspaceMeta {
  readonly worktreeDir: string;
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly branchRef: string;
  readonly observationLifetimeSeconds: number;
  readonly workflowGraphSha256: string;
  readonly discoveryConfigurationDigest: string;
  readonly projectionDigest: string;
}

interface PendingTakeover {
  readonly targetBaseCommit: string;
  readonly takeoverBranchRef: string;
  readonly supersededFence: number;
}

interface PendingConfirmation {
  readonly rendered: RenderedConfirmationChallenge;
  readonly confirmation: Record<string, unknown>;
  readonly subject: string;
}

interface AttemptFile {
  readonly attempt: RecordedReviewAttempt;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

async function writeOwned(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: OWNER_DIR });
  await writeFile(target, contents, { mode: OWNER_FILE });
  await chmod(target, OWNER_FILE);
}

async function readJson<T>(target: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// ── Journal reading helpers ────────────────────────────────────────────────

interface JournalEntryView {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

const viewsOf = (entries: readonly unknown[]): JournalEntryView[] =>
  entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    return { kind: record["kind"] as string, payload: record["payload"] as Record<string, unknown> };
  });

const lastOf = (views: readonly JournalEntryView[], kind: string): JournalEntryView | undefined =>
  [...views].reverse().find((view) => view.kind === kind);

interface CurrentCandidate {
  readonly treeSha: string;
  readonly branchRefValue: string;
}

function currentCandidateOf(views: readonly JournalEntryView[]): CurrentCandidate | undefined {
  const recaptured = lastOf(views, "candidate.recaptured");
  if (recaptured !== undefined) {
    return {
      treeSha: recaptured.payload["treeSha"] as string,
      branchRefValue: recaptured.payload["branchRefValue"] as string,
    };
  }
  const fenced = lastOf(views, "invocation.fenced");
  if (fenced !== undefined) {
    return {
      treeSha: fenced.payload["candidateTreeSha"] as string,
      branchRefValue: fenced.payload["candidateBranchRefValue"] as string,
    };
  }
  return undefined;
}

interface RecordedRegistrationBinding {
  readonly registeringInstallationId: string;
  readonly activeCompositionProfile: string;
}

/**
 * The delivery's registration binding as CURRENTLY recorded: the identity
 * minted at registration, replaced by each consumed rebinding migration —
 * the recheck resolves the latest recorded binding, never only the original.
 */
function recordedBindingOf(views: readonly JournalEntryView[]): RecordedRegistrationBinding | undefined {
  const registered = views.find((view) => view.kind === "delivery.registered");
  if (registered === undefined) return undefined;
  let registeringInstallationId = registered.payload["registeringInstallationId"] as string;
  const activeCompositionProfile = registered.payload["activeCompositionProfile"] as string;
  for (const view of views) {
    if (view.kind !== "approval.assertion.consumed") continue;
    const rebound = view.payload["newRegisteringInstallationId"];
    if (typeof rebound === "string" && rebound !== "absent-by-state") {
      registeringInstallationId = rebound;
    }
  }
  return { registeringInstallationId, activeCompositionProfile };
}

/** Every assertion nonce this delivery journal has consumed. */
function consumedAssertionNoncesOf(views: readonly JournalEntryView[]): Set<string> {
  const nonces = new Set<string>();
  for (const view of views) {
    if (view.kind !== "approval.assertion.consumed") continue;
    const assertion = view.payload["assertion"];
    if (typeof assertion === "object" && assertion !== null) {
      const nonce = (assertion as Record<string, unknown>)["nonce"];
      if (typeof nonce === "string") nonces.add(nonce);
    }
  }
  return nonces;
}

function sensorResultsOf(views: readonly JournalEntryView[]): RecordedSensorResult[] {
  return views
    .filter((view) => view.kind === "operation.result.recorded")
    .map((view) => view.payload["result"] as unknown as RecordedSensorResult & { spec: string });
}

// ── The facade ─────────────────────────────────────────────────────────────

export interface ManagedDeliveryFacade {
  readonly namespaceDir: () => Promise<string>;

  /**
   * The host-native intake entrypoint: opens an iterative intake for an
   * outcome-only work request. The scope workflow the host runs against it
   * executes under the READ-ONLY intake grant minted here — the admission is
   * never mutation-capable, and every delivery-scoped identity is recorded
   * explicitly absent-by-state.
   */
  openIntake(input: {
    readonly workRequest: string;
    readonly observedAt: string;
    readonly attestationExpiry: string;
  }): Promise<
    { readonly ok: true; readonly intakeId: string; readonly grantDigest: string; readonly grantPath: string } | FacadeFailure
  >;

  /** Durably retains one clarification exchange of the scope workflow. */
  recordClarification(input: {
    readonly intakeId: string;
    readonly question: string;
    readonly answer: string;
  }): Promise<{ readonly ok: true } | FacadeFailure>;

  /**
   * Durably retains the current draft contract. A draft recorded after
   * presentation VOIDS the pending confirmation — the operator confirmed
   * different bytes — and a draft recorded while acceptance is blocked
   * returns intake to the confirmation handoff through the frozen chain.
   */
  recordDraft(input: {
    readonly intakeId: string;
    readonly draft: unknown;
  }): Promise<{ readonly ok: true; readonly draftDigest: string } | FacadeFailure>;

  /** Presents the retained draft for the ONE operator confirmation. */
  presentDraft(input: {
    readonly intakeId: string;
    readonly expiry: string;
  }): Promise<
    | { readonly ok: true; readonly nonce: string; readonly normalizedContractDigest: string; readonly channelPath: string }
    | FacadeFailure
  >;

  /**
   * Re-runs acceptance validation after a preflight failure, WITHOUT a new
   * operator confirmation: the journal guarantees the draft cannot have
   * changed since the consumed confirmation, so the confirmation stands.
   */
  retryAcceptance(input: { readonly intakeId: string }): Promise<{ readonly ok: true; readonly deliveryId: string } | FacadeFailure>;

  /**
   * The already-scoped fallback lane: no product-owned intake turn runs, but
   * the frozen chain is identical from the draft record on — contract
   * validation and the operator confirmation are never bypassed.
   */
  presentContract(input: {
    readonly contract: AcceptedContract;
    readonly expiry: string;
  }): Promise<
    | { readonly ok: true; readonly intakeId: string; readonly nonce: string; readonly normalizedContractDigest: string; readonly channelPath: string }
    | FacadeFailure
  >;

  /**
   * Consumes the operator confirmation at the EXIT of awaiting_confirmation,
   * runs acceptance validation in validating_acceptance, and — only when it
   * passes — completes registration at accepted_contract, on the facade side,
   * outside intake's capability set. A preflight failure blocks the intake
   * with the consumed confirmation intact for `retryAcceptance`.
   */
  confirmContract(input: {
    readonly intakeId: string;
    readonly echo: ConfirmationEchoAttempt;
  }): Promise<{ readonly ok: true; readonly deliveryId: string } | FacadeFailure>;

  bindWorkspace(input: {
    readonly deliveryId: string;
    readonly worktreeDir: string;
    readonly hostTaskId: string;
    readonly observedAt: string;
    readonly attestationExpiry: string;
    readonly observationLifetimeSeconds?: number;
  }): Promise<
    | {
        readonly ok: true;
        readonly fence: number;
        readonly workspaceId: string;
        readonly statePath: string;
        readonly settingsPath: string;
        readonly cliArgs: readonly string[];
        readonly projectionDigest: string;
      }
    | FacadeFailure
  >;

  status(input: { readonly deliveryId: string; readonly observedAt: string }): Promise<
    | {
        readonly ok: true;
        readonly state: DeliveryState;
        readonly activity: "active" | "paused" | "unknown" | "cancellation_pending";
        readonly expectedRevision: number;
        readonly fence: number;
        readonly nextCheckpoint: ManagedCheckpoint;
        readonly policyRequiredInterruptions: number;
        readonly operatorInterventions: number;
        readonly resume: "none" | "takeover-required";
        readonly blockers: readonly { readonly code: string; readonly summary: string }[];
      }
    | FacadeFailure
  >;

  nextCheckpoint(input: { readonly deliveryId: string }): Promise<{ readonly ok: true; readonly checkpoint: ManagedCheckpoint } | FacadeFailure>;

  submitStageResult(input: {
    readonly deliveryId: string;
    readonly stageId: "plan" | "compound";
    readonly resultBytes: string;
    /** The fence the invoking task was bound under; an older fence's output is permanently rejected, and omitting it fails closed. */
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  checkpointCandidate(input: {
    readonly deliveryId: string;
    readonly resultBytes: string;
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState; readonly treeSha: string } | FacadeFailure>;

  runSensor(input: { readonly deliveryId: string; readonly fence: number }): Promise<
    { readonly ok: true; readonly outcome: "passed" | "failed"; readonly state: DeliveryState } | FacadeFailure
  >;

  submitReviewAttempt(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly lensId: string;
    readonly verdict: "approved" | "findings";
    readonly contextBytes: string;
    readonly artifactBytes: string;
    readonly fence: number;
  }): Promise<{ readonly ok: true } | FacadeFailure>;

  reduceReview(input: { readonly deliveryId: string; readonly fence: number }): Promise<
    { readonly ok: true; readonly state: DeliveryState } | FacadeFailure
  >;

  admit(input: {
    readonly deliveryId: string;
    readonly recordedAtInstant: string;
    readonly env: EnvSnapshot;
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  prepareTrackedRecord(input: {
    readonly deliveryId: string;
    readonly env: EnvSnapshot;
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly relativePath: string } | FacadeFailure>;

  confirmTrackedRecord(input: { readonly deliveryId: string; readonly fence: number }): Promise<
    { readonly ok: true; readonly state: DeliveryState } | FacadeFailure
  >;

  completeFinishLine(input: { readonly deliveryId: string; readonly fence: number }): Promise<
    { readonly ok: true; readonly state: DeliveryState; readonly resultDigest: string } | FacadeFailure
  >;

  sessionEnded(input: { readonly deliveryId: string; readonly fence: number }): Promise<{ readonly ok: true } | FacadeFailure>;

  /**
   * A waiver or contract-amendment proposal: journaled with a pending marker
   * while the delivery remains in its current state. Consumption belongs to
   * the sensitive-approval lane (its journal kind stays reserved here); a
   * candidate change since proposal voids the stale proposal with a typed
   * blocker record.
   */
  recordApprovalRequest(input: {
    readonly deliveryId: string;
    readonly requestKind: "waiver" | "amendment";
    readonly criterionId: string;
    readonly actorId: string;
    readonly reason: string;
    readonly fence: number;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  /**
   * Cancellation, first half: enter `cancellation_requested`, revoke the
   * invocation fence for the model-external interceptor, and request native
   * host cancellation (fence-revocation-only on hosts without a trusted
   * cancellation acknowledgement). The delivery is NOT terminal yet.
   */
  requestCancellation(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly state: DeliveryState } | FacadeFailure
  >;

  /**
   * Cancellation, second half: terminal `cancelled` through permanent
   * quarantine of the prior workspace and preservation of the last trusted
   * candidate. This path never claims that the prior task or its descendants
   * terminated.
   */
  finalizeCancellation(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly state: DeliveryState } | FacadeFailure
  >;

  /** Export the delivery's durable detail to an owned namespace path; journaled to the maintenance journal. */
  exportDelivery(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly exportPath: string; readonly artifactDigest: string } | FacadeFailure
  >;

  /**
   * Delete a TERMINAL delivery's durable detail, preserving the minimum
   * candidate/policy/evidence/action audit record first. The maintenance
   * journal record survives the target's removal and reports what was
   * preserved.
   */
  deleteDelivery(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly preservedAuditRecords: readonly string[] } | FacadeFailure
  >;

  presentTakeover(input: {
    readonly deliveryId: string;
    readonly expiry: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly nonce: string;
        readonly channelPath: string;
        readonly supersededFence: number;
        readonly expectedJournalRevision: number;
        readonly targetBaseCommit: string;
        readonly takeoverBranchRef: string;
      }
    | FacadeFailure
  >;

  confirmTakeover(input: {
    readonly deliveryId: string;
    readonly echo: ConfirmationEchoAttempt;
  }): Promise<
    { readonly ok: true; readonly targetBaseCommit: string; readonly takeoverBranchRef: string } | FacadeFailure
  >;

  explainBlocker(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly blocker: { readonly code: string; readonly summary: string; readonly remediation: string } | undefined } | FacadeFailure
  >;

  /**
   * The maintenance-lane exit from `security_blocked`. Always: current local
   * trust state, full re-preparation, and invalidation of revoked-era
   * candidate-bound evidence. When the generation changed or the delivery is
   * being rebound to a different registering installation, additionally
   * consumes the security-blocked migration assertion — without re-fencing.
   */
  recoverSecurityBlocked(input: {
    readonly deliveryId: string;
    /** Defaults to the delivery's recorded generation pin. */
    readonly targetGenerationDigest?: string;
    readonly assertionSource?: AssertionSourcePort;
    /** The consumption instant; the facade never consults a clock itself. */
    readonly now: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly mode: "re-preparation" | "generation-change-migration" | "rebinding-migration";
        readonly state: DeliveryState;
      }
    | FacadeFailure
  >;
}

export type ManagedCheckpoint =
  | { readonly kind: "bind-workspace" }
  | { readonly kind: "workflow-stage"; readonly stageId: string; readonly remediation: boolean; readonly grantDigest: string }
  | { readonly kind: "repository-sensor"; readonly capabilityId: string }
  | { readonly kind: "review"; readonly stageId: string; readonly lenses: readonly string[] }
  | { readonly kind: "admission" }
  | { readonly kind: "tracked-record" }
  | { readonly kind: "finish-line" }
  | { readonly kind: "complete" }
  | { readonly kind: "blocked"; readonly code: string; readonly summary: string };

export function createManagedDeliveryFacade(input: CreateFacadeInput): ManagedDeliveryFacade {
  const exec = input.exec ?? createExecPort();

  const git = async (cwd: string, ...args: string[]): Promise<{ code: number; out: string }> => {
    const outcome = await exec.run({ command: "git", args, cwd });
    return { code: outcome.code, out: outcome.stdout.trim() };
  };

  /**
   * The evidence kernel's capture/activation git plumbing, routed through the
   * SAME exec port as every other product launch — the inventory the negative
   * process sensor asserts is complete only because nothing bypasses the
   * port. The kernel's scrubbed-environment semantics are preserved: the
   * whole GIT_ namespace is dropped and prompts/optional locks are disabled,
   * exactly as the kernel's own default runner does.
   */
  const candidateRunner: CandidateCommandRunner = async (command, options) => {
    const [executable, ...args] = command;
    if (executable === undefined) return { exitCode: -1, stdout: "", stderr: "no command was given" };
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith("GIT_") || value === undefined) continue;
      environment[name] = value;
    }
    const outcome = await exec.run({
      command: executable,
      args,
      cwd: options.cwd,
      env: { ...environment, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    return { exitCode: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr };
  };

  /**
   * The record-storage flavor of the same rule: every `RecordStorageOptions`
   * consumer the facade drives (store resolution, receipts, submission,
   * admission, record discovery) resolves git through the port. Throws on a
   * non-zero exit, exactly like the kernel's default runner.
   */
  const storageGitRunner = async (cwd: string, args: readonly string[]): Promise<string> => {
    const outcome = await exec.run({ command: "git", args: [...args], cwd });
    if (outcome.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${outcome.code}): ${outcome.stderr.trim()}`);
    }
    return outcome.stdout.trim();
  };

  let namespaceDirCache: string | undefined;
  const namespaceDir = async (): Promise<string> => {
    if (namespaceDirCache !== undefined) return namespaceDirCache;
    const common = await git(input.repoDir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (common.code !== 0) throw new Error(`not a git repository: ${input.repoDir}`);
    namespaceDirCache = path.join(common.out, NAMESPACE);
    return namespaceDirCache;
  };

  const deliveryDir = async (deliveryId: string): Promise<string> => path.join(await namespaceDir(), "deliveries", deliveryId);
  const journalStoreFor = async (deliveryId: string): Promise<JournalStore> =>
    createJournalStore(path.join(await deliveryDir(deliveryId), "journal.jsonl"));
  const confirmationPath = (nonce: string): string => path.join(input.installation.installationPath, "confirmations", `${nonce}.json`);

  const readTrust = async (): Promise<ProductTrustState | undefined> => {
    try {
      const parsed = parseTrustState(await readFile(trustStorePathFor(input.installation.installationPath), "utf8"));
      return parsed.ok ? parsed.state : undefined;
    } catch {
      return undefined;
    }
  };

  const appendEntry = async (
    store: JournalStore,
    deliveryId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | FacadeFailure> => {
    const read = await store.read();
    if (!read.ok) return refuse("journal_unreadable", "The delivery journal is unreadable.", "Inspect the durable journal file.");
    let expectedRevision = 0;
    if (read.entries.length > 0) {
      const reduced = await store.state();
      if (!reduced.ok) {
        return refuse("journal_rejected", "The durable journal does not reduce.", "Inspect the durable journal file.");
      }
      expectedRevision = reduced.state.expectedRevision;
    }
    const appended = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: deliveryId,
      expectedRevision,
      idempotencyKey: `e${read.entries.length}-${kind}`,
      kind,
      payload,
    });
    if (!appended.ok) {
      return refuse(
        "journal_rejected",
        `The frozen journal reducer refused a ${kind} append: ${appended.rejections.map((rejection) => rejection.message).join("; ")}`,
        "The refused entry is reported verbatim; correct the calling state.",
      );
    }
    return { ok: true };
  };

  const recordBlockerAndTransition = async (
    store: JournalStore,
    deliveryId: string,
    fromState: DeliveryState,
    code: string,
    summary: string,
    to: "blocked" | "security_blocked",
  ): Promise<void> => {
    await appendEntry(store, deliveryId, "blocker.recorded", { code, summary });
    await appendEntry(store, deliveryId, "transition.committed", { from: fromState, to });
  };

  interface GuardedContext {
    readonly store: JournalStore;
    readonly meta: DeliveryMeta;
    readonly state: DeliveryState;
    readonly lastActiveState: DeliveryState;
    readonly expectedRevision: number;
    readonly lastFence: number;
    readonly views: readonly JournalEntryView[];
    readonly workspace: WorkspaceMeta | undefined;
    readonly generationRoot: string;
    /** The gathered observations, reusable by consumption-substituted rechecks. */
    readonly recheckValues: RecheckValues;
  }

  /**
   * THE CANONICAL RECHECK every mutation-capable operation runs, routed
   * through the single substitution-aware helper: product trust, the
   * repository authority-revocation epoch, the invocation fence, the
   * registering installation identity and active profile, and the projection
   * and discovery-configuration digests. The helper decides; this function
   * gathers observations and maps failures onto the typed blocker/transition
   * behavior — trust and installation failures fence into `security_blocked`,
   * authority and workspace-integrity failures block, and a stale invoking
   * fence is permanently refused without touching the journal.
   */
  const guard = async (
    deliveryId: string,
    options: {
      readonly requireState?: readonly DeliveryState[];
      readonly verifyWorkspace?: boolean;
      /** Only the takeover rebind consumes a pending authorization. */
      readonly allowPendingTakeover?: boolean;
      /** The invoking task's claimed fence; an older fence is permanently rejected. */
      readonly invokingFence?: number;
      /** Fence-carrying operations fail closed when no fence is presented. */
      readonly fenceRequired?: boolean;
    } = {},
  ): Promise<GuardedContext | FacadeFailure> => {
    const dir = await deliveryDir(deliveryId);
    const meta = await readJson<DeliveryMeta>(path.join(dir, "delivery.json"));
    if (meta === undefined) {
      return refuse("unknown_delivery", `No registered delivery ${deliveryId}.`, "Register a delivery through the contract handoff first.");
    }
    // A consumed takeover authorization quarantines the prior workspace; no
    // checkpoint operation runs until the authorized fresh worktree is bound.
    // A superseded-but-still-running task keeps no write path this way.
    if (options.allowPendingTakeover !== true && (await readJson<PendingTakeover>(path.join(dir, "takeover.json"))) !== undefined) {
      return refuse(
        "takeover_pending",
        "A consumed takeover authorization is pending; the quarantined workspace accepts no further checkpoints.",
        "Bind the fresh worktree the takeover authorized, then continue from the last trustworthy checkpoint.",
      );
    }
    const store = await journalStoreFor(deliveryId);
    const reduced = await store.state();
    if (!reduced.ok) {
      return refuse("journal_rejected", "The durable journal does not reduce.", "Inspect the durable journal file.");
    }
    const read = await store.read();
    if (!read.ok) return refuse("journal_unreadable", "The delivery journal is unreadable.", "Inspect the durable journal file.");
    const views = viewsOf(read.entries);
    const workspace = await readJson<WorkspaceMeta>(path.join(dir, "workspace.json"));

    const pinned = reduced.state.generationDigest;
    if (pinned === undefined) {
      return refuse("unregistered", "The delivery has no pinned generation.", "Register the delivery first.");
    }

    // ── Gather the frozen rechecked-value observations ──
    // Product trust at the pinned generation, resolved only from the
    // installation store — planted repository-local trust files are ignored
    // by construction.
    const generation = await loadPinnedGeneration({
      installationPath: input.installation.installationPath,
      generationDigest: pinned,
    });
    const trustCheck: ValueCheck = generation.ok
      ? { kind: "eligible", ok: true }
      : {
          kind: "eligible",
          ok: false,
          detail: generation.blockers.map((blocker) => blocker.message).join("; ").slice(0, 1900),
        };

    // The recheck resolves the LATEST recorded binding, so a consumed
    // rebinding migration moves service to the new installation and away
    // from the old one.
    const recordedBinding = recordedBindingOf(views);
    const binding = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    const installationCheck: CompareCheck = {
      kind: "compare",
      expected: recordedBinding?.registeringInstallationId ?? "recorded-installation",
      observed: binding.ok ? binding.registeringInstallationId : "unresolved-installation",
    };
    const profileCheck: CompareCheck = {
      kind: "compare",
      expected: recordedBinding?.activeCompositionProfile ?? "recorded-profile",
      observed: binding.ok ? binding.activeCompositionProfile : "unresolved-profile",
    };

    const epochCheck: ValueCheck =
      reduced.state.authorityEpoch === undefined
        ? "absent-by-state"
        : { kind: "compare", expected: reduced.state.authorityEpoch, observed: meta.policy.repositoryAuthorityRevocationEpoch };

    if (options.fenceRequired === true && options.invokingFence === undefined) {
      // A fence-carrying operation records host-task output; without the
      // invoking fence the canonical recheck would be vacuous, so it fails
      // closed instead.
      return refuse(
        "missing_fence",
        "This operation records host-task output and presented no invocation fence.",
        "Present the fence the invocation was bound under; only the currently fenced invocation may record outputs.",
      );
    }
    const fenceCheck: ValueCheck = {
      kind: "compare",
      expected: reduced.state.lastFence,
      observed: options.invokingFence ?? reduced.state.lastFence,
    };

    let projectionCheck: ValueCheck = "absent-by-state";
    let discoveryCheck: ValueCheck = "absent-by-state";
    if (options.verifyWorkspace === true && workspace !== undefined) {
      // A vanished workspace is a typed refusal, not a mismatch: the delivery
      // itself is unharmed and resumes through an authorized takeover.
      try {
        await stat(workspace.worktreeDir);
      } catch {
        return refuse(
          "workspace_missing",
          "The bound worktree no longer exists on disk.",
          "Resume through an operator-authorized takeover into a fresh host-created worktree.",
        );
      }
      const projection = await verifyProjection({
        worktreeDir: workspace.worktreeDir,
        bindingDir: path.join(dir, "binding"),
      });
      projectionCheck = {
        kind: "compare",
        expected: workspace.projectionDigest,
        observed: projection.ok
          ? projection.projectionDigest
          : `unverifiable: ${projection.blockers.map((blocker) => blocker.message).join("; ")}`.slice(0, 1900),
      };
      let observedDiscovery: string;
      try {
        const settingsBytes = await readFile(path.join(dir, "binding", "settings.json"), "utf8");
        const excludesBytes = await readFile(path.join(dir, "binding", "worktree-excludes"), "utf8");
        observedDiscovery = digestCanonical({ settings: settingsBytes, worktreeExcludes: excludesBytes });
      } catch {
        observedDiscovery = "unreadable-discovery-configuration";
      }
      discoveryCheck = { kind: "compare", expected: workspace.discoveryConfigurationDigest, observed: observedDiscovery };
    }

    const recheckValues: RecheckValues = {
      "product-trust": trustCheck,
      "repository-authority-epoch": epochCheck,
      "invocation-fence": fenceCheck,
      "registering-installation-id": installationCheck,
      "active-profile": profileCheck,
      "projection-digest": projectionCheck,
      "discovery-configuration-digest": discoveryCheck,
    };
    const recheck = evaluateCanonicalRecheck({ consumption: { kind: "standard" }, values: recheckValues });
    if (!recheck.ok) {
      const failure = recheck.failures[0];
      if (failure === undefined) {
        return refuse("recheck_failed", "The canonical recheck failed without a named value.", "Inspect the durable journal file.");
      }
      switch (failure.value) {
        case "product-trust": {
          if (reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(store, deliveryId, reduced.state.state, "trust.generation-ineligible", failure.message.slice(0, 1900), "security_blocked");
          }
          return refuse(
            "trust_ineligible",
            "The pinned generation is no longer execution-eligible under current local trust state.",
            "Restore local trust state through the operator maintenance lane.",
          );
        }
        case "registering-installation-id":
        case "active-profile": {
          if (reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(
              store,
              deliveryId,
              reduced.state.state,
              "trust.installation-mismatch",
              "the registering installation identity or active profile no longer matches this installation",
              "security_blocked",
            );
          }
          return refuse(
            "installation_mismatch",
            "This delivery is bound to a different registering installation or profile.",
            "Rebinding a delivery is an explicit migration, not an ambient adoption.",
          );
        }
        case "repository-authority-epoch": {
          if (reduced.state.state !== "blocked" && reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(store, deliveryId, reduced.state.state, "authority.epoch-changed", failure.message.slice(0, 1900), "blocked");
          }
          return refuse(
            "authority_epoch_changed",
            "The repository authority-revocation epoch changed; the delivery returns to policy evaluation.",
            "Re-evaluate under the current compiled policy before continuing.",
          );
        }
        case "invocation-fence": {
          // Outputs from an older fence are PERMANENTLY rejected; the journal
          // is untouched and the delivery itself is unharmed.
          return refuse(
            "stale_fence",
            `The invocation fence ${String(options.invokingFence)} is not the current fence ${reduced.state.lastFence}; outputs from an older fence are permanently rejected.`,
            "Only the currently fenced invocation may record outputs; resume through an authorized takeover.",
          );
        }
        case "discovery-configuration-digest": {
          if (reduced.state.state !== "blocked" && reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(store, deliveryId, reduced.state.state, "discovery.configuration-tampered", failure.message.slice(0, 1900), "blocked");
          }
          return refuse(
            "discovery_configuration_tampered",
            "The binding-written host discovery configuration no longer matches its application digest.",
            "Quarantine the workspace and resume through an authorized takeover.",
          );
        }
        default: {
          if (reduced.state.state !== "blocked" && reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(store, deliveryId, reduced.state.state, "projection.tampered", failure.message.slice(0, 1900), "blocked");
          }
          return refuse(
            "projection_tampered",
            "The receipted projection subtree no longer matches its materialization digest.",
            "Quarantine the workspace and resume through an authorized takeover.",
          );
        }
      }
    }

    // The qualification profile's use-time binding: a fixture installation
    // advances deliveries only in its receipt-listed disposable
    // repositories. The receipt is the ONLY source of eligibility;
    // repository content can never make itself eligible.
    if (
      binding.ok &&
      binding.activeCompositionProfile === "confirmation-fixture" &&
      !(binding.disposableRepositoryIds ?? []).includes(meta.contract.repository.repositoryId)
    ) {
      return refuse(
        "disposable_repository_refused",
        "A qualification installation serves only its receipt-listed disposable repositories; this repository is not listed.",
        "Qualification runs happen in the disposable repositories named at install time; production repositories need a production installation.",
      );
    }

    return options.requireState !== undefined && !options.requireState.includes(reduced.state.state)
      ? refuse(
          "wrong_state",
          `This operation runs in ${options.requireState.join("/")}; the delivery is in ${reduced.state.state}.`,
          "Read `status` for the next valid checkpoint.",
        )
      : {
          store,
          meta,
          state: reduced.state.state,
          lastActiveState: reduced.state.lastActiveState,
          expectedRevision: reduced.state.expectedRevision,
          lastFence: reduced.state.lastFence,
          views,
          workspace,
          generationRoot: generation.ok ? generation.root : "",
          recheckValues,
        };
  };

  const attemptsOf = async (deliveryId: string): Promise<RecordedReviewAttempt[]> => {
    const dir = path.join(await deliveryDir(deliveryId), "attempts");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const attempts: RecordedReviewAttempt[] = [];
    for (const name of names.sort()) {
      const file = await readJson<AttemptFile>(path.join(dir, name));
      if (file !== undefined) attempts.push(file.attempt);
    }
    return attempts;
  };

  const nextCheckpointOf = (state: DeliveryState, views: readonly JournalEntryView[]): ManagedCheckpoint => {
    const grantDigest = digestCanonical(DISPOSABLE_STAGE_GRANT);
    switch (state) {
      case "accepted":
      case "preparing":
        return { kind: "bind-workspace" };
      case "planning":
        return { kind: "workflow-stage", stageId: "plan", remediation: false, grantDigest };
      case "implementing":
        return { kind: "workflow-stage", stageId: "implement", remediation: false, grantDigest };
      case "remediating":
        return { kind: "workflow-stage", stageId: "implement", remediation: true, grantDigest };
      case "validating":
        return { kind: "repository-sensor", capabilityId: DISPOSABLE_SENSOR_CAPABILITY.descriptor.capabilityId };
      case "reviewing":
        return { kind: "review", stageId: "review.acquire", lenses: DISPOSABLE_REVIEW_LENSES.map((lens) => lens.lensId) };
      case "admitting":
        return { kind: "admission" };
      case "recording":
        return { kind: "tracked-record" };
      case "ready":
        return { kind: "finish-line" };
      case "completed":
        return { kind: "complete" };
      case "compounding":
        return { kind: "workflow-stage", stageId: "compound", remediation: false, grantDigest };
      default: {
        const blocker = lastOf(views, "blocker.recorded");
        return {
          kind: "blocked",
          code: (blocker?.payload["code"] as string | undefined) ?? "blocked",
          summary: (blocker?.payload["summary"] as string | undefined) ?? `the delivery is ${state}`,
        };
      }
    }
  };

  const renderChallenge = async (
    nonce: string,
    confirmation: Record<string, unknown>,
    subject: string,
    expiry: string,
  ): Promise<{ readonly ok: true; readonly channelPath: string } | FacadeFailure> => {
    // The fixture channel is profile-gated: only the confirmation-fixture
    // composition profile may render a durable challenge file, and the
    // installer already refuses that profile on a production installation.
    const binding = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    if (!binding.ok) {
      return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
    }
    if (binding.activeCompositionProfile !== "confirmation-fixture") {
      return refuse(
        "interactive_channel_required",
        "Production confirmations complete only on the binding's interactive channel, which this facade slice does not render.",
        "Run qualification under the confirmation-fixture profile, or use the interactive facade once it lands.",
      );
    }
    const pending: PendingConfirmation = {
      rendered: {
        channelId: `chan-${nonce}`,
        channelOpen: true,
        interactive: true,
        challenge: hex(16),
        consumed: false,
        expiry,
      },
      confirmation,
      subject,
    };
    const channelPath = confirmationPath(nonce);
    await writeOwned(channelPath, `${JSON.stringify(pending)}\n`);
    return { ok: true, channelPath };
  };

  const consumeChallenge = async (
    nonce: string,
    echo: ConfirmationEchoAttempt,
  ): Promise<{ confirmation: Record<string, unknown> } | FacadeFailure> => {
    const channelPath = confirmationPath(nonce);
    const pending = await readJson<PendingConfirmation>(channelPath);
    if (pending === undefined) {
      return refuse("confirmation_unknown", "No rendered confirmation challenge matches this nonce.", "Present the confirmation first.");
    }
    const decision = evaluateConfirmationEcho(pending.rendered, echo);
    if (!decision.completed) {
      return refuse(
        "confirmation_refused",
        `The confirmation echo was refused: ${decision.denials.map((denial) => `${denial.code}: ${denial.message}`).join("; ")}`,
        "Complete the echo on the same open, interactive, binding-owned channel it was rendered on.",
      );
    }
    await writeOwned(channelPath, `${JSON.stringify({ ...pending, rendered: { ...pending.rendered, consumed: true } })}\n`);
    return { confirmation: pending.confirmation };
  };

  const retentionContext = async (): Promise<RetentionContext | FacadeFailure> => {
    const binding = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    if (!binding.ok) {
      return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
    }
    return {
      namespaceDir: await namespaceDir(),
      installationId: binding.registeringInstallationId,
      maintenanceJournalPath: path.join(input.installation.installationPath, "maintenance.jsonl"),
    };
  };

  // ── Intake plumbing ──────────────────────────────────────────────────────

  const intakePath = async (intakeId: string, suffix: string): Promise<string> =>
    path.join(await namespaceDir(), "intake", `${intakeId}${suffix}`);
  const intakeStoreFor = async (intakeId: string): Promise<IntakeJournalStore> =>
    createIntakeJournalStore(await intakePath(intakeId, ".jsonl"));

  /** Appends one intake-journal entry under the frozen reducer's discipline. */
  const appendIntake = async (
    store: IntakeJournalStore,
    intakeId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | FacadeFailure> => {
    const read = await store.read();
    if (!read.ok) return refuse("intake_journal_unreadable", "The intake journal is unreadable.", "Inspect the durable intake journal file.");
    let expectedRevision = 0;
    if (read.entries.length > 0) {
      const reduced = await store.state();
      if (!reduced.ok) return refuse("intake_journal_rejected", "The durable intake journal does not reduce.", "Inspect the durable intake journal file.");
      expectedRevision = reduced.state.expectedRevision;
    }
    const appended = await store.append({
      spec: "journal-entry/1",
      journal: "intake",
      subjectId: intakeId,
      expectedRevision,
      idempotencyKey: `e${read.entries.length}-${kind}`,
      kind,
      payload,
    });
    if (!appended.ok) {
      return refuse(
        "intake_journal_rejected",
        `The frozen intake reducer refused a ${kind} append: ${appended.rejections.map((rejection) => rejection.message).join("; ")}`,
        "The refused entry is reported verbatim; correct the calling state.",
      );
    }
    return { ok: true };
  };

  const intakeStateOf = async (
    store: IntakeJournalStore,
  ): Promise<{ readonly state: string; readonly lastDraftDigest?: string } | FacadeFailure> => {
    const reduced = await store.state();
    if (!reduced.ok) {
      return refuse("intake_unknown", "No intake journal reduces under this identity.", "Open an intake or present a contract first.");
    }
    return { state: reduced.state.state, ...(reduced.state.lastDraftDigest === undefined ? {} : { lastDraftDigest: reduced.state.lastDraftDigest }) };
  };

  interface PresentValidated {
    readonly contract: AcceptedContract;
    readonly policy: PolicySnapshot;
    readonly generationDigest: string;
    readonly trust: ProductTrustState;
  }

  /**
   * The presentation-time validation both lanes run before anything reaches
   * the operator: frozen contract grammar, an execution-eligible active
   * generation, readable trust state, the qualification profile's use-time
   * binding, and the compiled policy's authority ceiling.
   */
  const presentValidation = async (contractValue: unknown): Promise<PresentValidated | FacadeFailure> => {
    const contractVerdict = validateAcceptedContract(contractValue);
    if (!contractVerdict.ok) {
      return refuse(
        "contract_rejected",
        `The scoped contract is outside its frozen grammar: ${contractVerdict.rejections.map((rejection) => rejection.message).join("; ")}`,
        "Fix the contract; material ambiguity remains in intake.",
      );
    }
    const contract = contractValue as AcceptedContract;

    const active = await resolveActiveGeneration(input.installation.installationPath);
    if (!active.ok) {
      return refuse("no_active_generation", "No active composition generation is installed.", "Install and activate a composition first.");
    }
    const generation = await loadPinnedGeneration({
      installationPath: input.installation.installationPath,
      generationDigest: active.generationDigest,
    });
    if (!generation.ok) {
      return refuse(
        "trust_ineligible",
        `The active generation fails its trust checks: ${generation.blockers.map((blocker) => blocker.message).join("; ")}`,
        "Restore local trust state through the operator maintenance lane.",
      );
    }
    const trust = await readTrust();
    if (trust === undefined) {
      return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
    }

    // The qualification profile's use-time binding at registration: a fixture
    // installation registers deliveries only in its receipt-listed disposable
    // repositories, and only the receipt decides.
    const registration = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    if (!registration.ok) {
      return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
    }
    if (
      registration.activeCompositionProfile === "confirmation-fixture" &&
      !(registration.disposableRepositoryIds ?? []).includes(contract.repository.repositoryId)
    ) {
      return refuse(
        "disposable_repository_refused",
        "A qualification installation registers deliveries only in its receipt-listed disposable repositories; this repository is not listed.",
        "Qualification runs happen in the disposable repositories named at install time; production repositories need a production installation.",
      );
    }

    const policy = compileDisposablePolicy({
      repositoryId: contract.repository.repositoryId,
      productTrustRevocationEpoch: trust.revocationEpoch,
      repositoryAuthorityRevocationEpoch: 0,
    });
    const withinPolicy = checkContractWithinPolicy(contract, policy);
    if (!withinPolicy.ok) {
      return refuse(
        "authority_not_granted",
        `The contract requests authority the compiled policy does not grant: ${withinPolicy.rejections.map((rejection) => rejection.message).join("; ")}`,
        "Absence of a grant is denial; narrow the contract or widen repository policy through its owners.",
      );
    }
    return { contract, policy, generationDigest: active.generationDigest, trust };
  };

  /** Mints and renders one contract-confirmation for the presented draft. */
  const presentForConfirmation = async (
    intakeId: string,
    contract: AcceptedContract,
    validated: PresentValidated,
    expiry: string,
  ): Promise<{ readonly ok: true; readonly nonce: string; readonly normalizedContractDigest: string; readonly channelPath: string } | FacadeFailure> => {
    const nonce = `nonce-${hex(8)}`;
    const normalizedContractDigest = digestCanonical(contract);
    const confirmation = {
      spec: "operator-confirmation/1",
      confirmationClass: "contract-confirmation",
      origin: "managed-delivery.facade",
      action: "confirm-contract",
      expiry,
      nonce,
      productTrustRevocationEpoch: validated.trust.revocationEpoch,
      repositoryAuthorityRevocationEpoch: "absent-by-state",
      intakeDraftId: intakeId,
      deliveryId: "absent-by-state",
      normalizedContractDigest,
      supersededInvocationFence: "absent-by-state",
      expectedJournalRevision: "absent-by-state",
      targetBaseCommit: "absent-by-state",
      boundInvocationFence: "absent-by-state",
      boundCandidateTreeSha: "absent-by-state",
    };
    const rendered = await renderChallenge(nonce, confirmation, intakeId, expiry);
    if (!rendered.ok) return rendered;
    await writeOwned(
      await intakePath(intakeId, ".meta.json"),
      `${JSON.stringify({ contract, policy: validated.policy, generationDigest: validated.generationDigest, nonce } satisfies IntakeMeta)}\n`,
    );
    return { ok: true, nonce, normalizedContractDigest, channelPath: rendered.channelPath };
  };

  interface AcceptancePreflight {
    readonly binding: { readonly registeringInstallationId: string; readonly activeCompositionProfile: string };
    readonly sensorBytes: string;
  }

  /**
   * The validating_acceptance preflight, run AFTER the confirmation is
   * consumed — the pinned intake ordering. Everything here may drift between
   * presentation and consumption (trust state, installation resolution, the
   * trusted-base sensor), so a failure blocks with the consumed confirmation
   * intact and `retryAcceptance` re-runs it over the unchanged draft.
   */
  const acceptancePreflight = async (meta: IntakeMeta): Promise<AcceptancePreflight | FacadeFailure> => {
    const contractVerdict = validateAcceptedContract(meta.contract);
    if (!contractVerdict.ok) {
      return refuse(
        "contract_rejected",
        `The presented contract is outside its frozen grammar: ${contractVerdict.rejections.map((rejection) => rejection.message).join("; ")}`,
        "Fix the contract; material ambiguity remains in intake.",
      );
    }
    const binding = await registrationBinding({
      installationPath: input.installation.installationPath,
      receiptDir: input.installation.receiptDir,
    });
    if (!binding.ok) {
      return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
    }
    const generation = await loadPinnedGeneration({
      installationPath: input.installation.installationPath,
      generationDigest: meta.generationDigest,
    });
    if (!generation.ok) {
      return refuse(
        "trust_ineligible",
        "The generation bound at presentation is not execution-eligible under current local trust state.",
        "Restore local trust state through the operator maintenance lane, then retry acceptance.",
      );
    }
    const withinPolicy = checkContractWithinPolicy(meta.contract, meta.policy);
    if (!withinPolicy.ok) {
      return refuse(
        "authority_not_granted",
        `The contract requests authority the compiled policy does not grant: ${withinPolicy.rejections.map((rejection) => rejection.message).join("; ")}`,
        "Absence of a grant is denial; narrow the contract or widen repository policy through its owners.",
      );
    }
    // The trusted-base sensor: copied from the base commit NOW, executed only
    // from that copy — the candidate's tracked rewrite never governs.
    const shown = await exec.run({
      command: "git",
      args: ["show", `${meta.contract.repository.baseRef}:${DISPOSABLE_SENSOR_CAPABILITY.trustedBasePath}`],
      cwd: input.repoDir,
    });
    if (shown.code !== 0) {
      return refuse(
        "trusted_sensor_missing",
        `The trusted pre-run base ${meta.contract.repository.baseRef} carries no ${DISPOSABLE_SENSOR_CAPABILITY.trustedBasePath}.`,
        "The repository's sensor must exist at the base; candidate-supplied sensors never govern.",
      );
    }
    return { binding, sensorBytes: shown.stdout };
  };

  /** Registration at accepted_contract: facade-side, outside intake's capability set. */
  const registerDelivery = async (
    intakeId: string,
    meta: IntakeMeta,
    preflight: AcceptancePreflight,
  ): Promise<{ readonly ok: true; readonly deliveryId: string } | FacadeFailure> => {
    const trust = await readTrust();
    if (trust === undefined) {
      return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
    }
    if (meta.nonce === undefined) {
      return refuse("confirmation_void", "No consumed confirmation is bound to this intake draft.", "Present the draft and complete the operator confirmation first.");
    }
    const ns = await namespaceDir();
    const deliveryId = `dlv-${hex(6)}`;
    const dir = await deliveryDir(deliveryId);
    const store = await journalStoreFor(deliveryId);

    const registered = await appendEntry(store, deliveryId, "delivery.registered", {
      contractDigest: digestCanonical(meta.contract),
      intakeId,
      confirmationNonce: meta.nonce,
      activeCompositionProfile: preflight.binding.activeCompositionProfile,
      registeringInstallationId: preflight.binding.registeringInstallationId,
    });
    if (!registered.ok) return registered;
    await appendEntry(store, deliveryId, "generation.pinned", {
      generationDigest: meta.generationDigest,
      releaseId: PINNED_AGENT_SKILLS.releaseId,
      profile: preflight.binding.activeCompositionProfile,
    });
    await appendEntry(store, deliveryId, "policy.snapshot.bound", {
      policyDigest: meta.policy.policyDigest,
      repositoryAuthorityEpoch: meta.policy.repositoryAuthorityRevocationEpoch,
    });
    await appendEntry(store, deliveryId, "trust.epoch.observed", {
      productTrustEpoch: trust.revocationEpoch,
      repositoryAuthorityEpoch: meta.policy.repositoryAuthorityRevocationEpoch,
    });

    await writeOwned(path.join(dir, "trusted-sensor.mjs"), preflight.sensorBytes);
    await writeOwned(
      path.join(dir, "delivery.json"),
      `${JSON.stringify({ contract: meta.contract, policy: meta.policy, generationDigest: meta.generationDigest, intakeId } satisfies DeliveryMeta)}\n`,
    );

    // The namespace pointer the host-facing CLI resolves the facade from:
    // installation paths and host version, in the product namespace, never
    // in candidate-writable paths.
    await writeOwned(
      path.join(ns, "facade.json"),
      `${JSON.stringify({
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
        hostVersion: input.hostVersion,
      })}\n`,
    );

    const transitioned = await appendEntry(store, deliveryId, "transition.committed", { from: "accepted", to: "preparing" });
    if (!transitioned.ok) return transitioned;
    return { ok: true, deliveryId };
  };

  /**
   * The validating_acceptance leg shared by confirmation and retry: preflight
   * under the already-consumed confirmation, then either the accepted_contract
   * transition plus registration, or the typed blocked transition.
   */
  const runAcceptance = async (
    intakeId: string,
    store: IntakeJournalStore,
    meta: IntakeMeta,
  ): Promise<{ readonly ok: true; readonly deliveryId: string } | FacadeFailure> => {
    const preflight = await acceptancePreflight(meta);
    if (!("binding" in preflight)) {
      await appendIntake(store, intakeId, "intake.state.changed", { from: "validating_acceptance", to: "blocked" });
      return preflight;
    }
    const accepted = await appendIntake(store, intakeId, "intake.state.changed", { from: "validating_acceptance", to: "accepted_contract" });
    if (!accepted.ok) return accepted;
    return registerDelivery(intakeId, meta, preflight);
  };

  // ── Typed workflow-checkpoint plumbing ───────────────────────────────────

  const loadGraph = async (
    generationRoot: string,
  ): Promise<{ readonly graph: WorkflowGraph; readonly graphSha256: string } | FacadeFailure> => {
    let archiveBytes: Uint8Array;
    try {
      archiveBytes = await readFile(path.join(generationRoot, ...GENERATION_SKILLS_ARCHIVE.split("/")));
    } catch {
      return refuse("workflow_graph_rejected", "The pinned generation's skills archive is unreadable.", "Restore the installation through the operator maintenance lane.");
    }
    const loaded = loadBundledWorkflowGraph(archiveBytes);
    if (!loaded.ok) {
      return refuse(
        "workflow_graph_rejected",
        `The bundled workflow graph failed its pin: ${loaded.blockers.map((blocker) => blocker.message).join("; ")}`,
        "Only the exact pinned graph governs checkpoints.",
      );
    }
    return { graph: loaded.graph, graphSha256: loaded.graphSha256 };
  };

  const persistedResultPath = (dir: string, digest: string): string => path.join(dir, "results", `${digest}.json`);

  /** Reads one persisted typed result back, verifying its journal digest binding. */
  const persistedResultOf = async (dir: string, digest: string): Promise<AcceptedStageResult | undefined> => {
    try {
      const bytes = await readFile(persistedResultPath(dir, digest), "utf8");
      if (sha256Hex(bytes) !== digest) return undefined; // tampered persistence satisfies nothing
      const parsed = JSON.parse(bytes) as { status?: unknown; stageId?: unknown; output?: { kind?: unknown } };
      if (typeof parsed.status !== "string" || typeof parsed.stageId !== "string") return undefined;
      return {
        stageId: parsed.stageId,
        status: parsed.status,
        ...(typeof parsed.output?.kind === "string" ? { outputKind: parsed.output.kind } : {}),
        evidenceRefs: [],
        limitations: [],
      };
    } catch {
      return undefined;
    }
  };

  /**
   * The harness-retained prerequisite summaries, rebuilt from the journal's
   * digest-bound stage records and their persisted typed documents. The
   * registration itself is the scoped-subject evidence — an accepted contract
   * IS intake's success output.
   */
  const retainedSummaries = async (
    deliveryId: string,
    views: readonly JournalEntryView[],
  ): Promise<Map<string, CompletedStageSummary>> => {
    const map = new Map<string, CompletedStageSummary>();
    if (views.some((view) => view.kind === "delivery.registered")) {
      map.set("intake", { status: "succeeded", outputKind: "scoped-subject" });
    }
    const dir = await deliveryDir(deliveryId);
    for (const view of views) {
      if (view.kind !== "stage.result.recorded") continue;
      const persisted = await persistedResultOf(dir, view.payload["resultDigest"] as string);
      if (persisted === undefined) continue;
      map.set(view.payload["stageId"] as string, {
        status: persisted.status,
        ...(persisted.outputKind === undefined ? {} : { outputKind: persisted.outputKind }),
      });
    }
    return map;
  };

  interface ProcessedStageResult {
    readonly bytes: string;
    readonly digest: string;
    readonly result: AcceptedStageResult;
  }

  /**
   * The checkpoint reducer's admission of one typed result: parse, validate
   * against the pinned graph and release under the stage's released
   * candidate-binding policy, then evaluate the graph-declared prerequisites
   * over harness-retained summaries. Prose, unknown members, self-nominated
   * candidates, and unmet prerequisites all refuse — host-facing skill text
   * guides execution but cannot advance the reducer.
   */
  const processStageResult = (processInput: {
    readonly resultBytes: string;
    readonly graph: WorkflowGraph;
    readonly graphSha256: string;
    readonly stageId: string;
    readonly deliveryId: string;
    readonly currentCandidate?: string;
    readonly producedCandidate?: string;
    readonly summaries: ReadonlyMap<string, CompletedStageSummary>;
    readonly repairLoop?: boolean;
    readonly productRealized?: readonly string[];
  }): ProcessedStageResult | FacadeFailure => {
    let parsed: unknown = processInput.resultBytes;
    try {
      parsed = JSON.parse(processInput.resultBytes);
    } catch {
      /* validation reports the typed refusal for non-JSON bytes */
    }
    const verdict = validateWorkflowStageResult(parsed, {
      graph: processInput.graph,
      graphSha256: processInput.graphSha256,
      release: RELEASE_IDENTITY,
      expectedStageId: processInput.stageId,
      expectedSubject: processInput.deliveryId,
      ...(processInput.currentCandidate === undefined ? {} : { currentCandidate: processInput.currentCandidate }),
      ...(processInput.producedCandidate === undefined ? {} : { producedCandidate: processInput.producedCandidate }),
    });
    if (!verdict.ok) {
      return refuse(
        "stage_result_rejected",
        `The ${processInput.stageId} result is outside the released workflow contract: ${verdict.rejections
          .map((rejection) => rejection.message)
          .join("; ")
          .slice(0, 1500)}`,
        "Submit a typed workflow-stage-result/1 document; host-facing skill text guides execution but cannot advance a checkpoint.",
      );
    }
    const stage = workflowStageOf(processInput.graph, processInput.stageId);
    if (stage === undefined) {
      return refuse("stage_result_rejected", `The pinned graph declares no ${processInput.stageId} stage.`, "Read `next-checkpoint`.");
    }
    const prerequisites = evaluateStagePrerequisites(stage, processInput.summaries, {
      ...(processInput.repairLoop === undefined ? {} : { repairLoop: processInput.repairLoop }),
      ...(processInput.productRealized === undefined ? {} : { productRealized: processInput.productRealized }),
    });
    if (!prerequisites.ok) {
      return refuse(
        "stage_prerequisite_unmet",
        `The ${processInput.stageId} stage's graph-declared prerequisites are not admitted: ${prerequisites.rejections
          .map((rejection) => rejection.message)
          .join("; ")
          .slice(0, 1500)}`,
        "Admit the prerequisite stage's typed result first; the frozen checkpoint order is not advisory.",
      );
    }
    return { bytes: processInput.resultBytes, digest: sha256Hex(processInput.resultBytes), result: verdict.result };
  };

  return {
    namespaceDir,

    async openIntake({ workRequest, observedAt, attestationExpiry }) {
      if (workRequest.trim().length === 0) {
        return refuse("work_request_empty", "An intake opens over a non-empty work request.", "State the intended outcome, then open the intake.");
      }
      const trust = await readTrust();
      if (trust === undefined) {
        return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
      }
      const intakeId = `intake-${hex(6)}`;

      // The product-owned scope workflow executes only under the READ-ONLY
      // intake grant: no writable paths, every delivery-scoped identity
      // explicitly absent-by-state, and an admission that is never
      // mutation-capable.
      const expectation: IntakeAdmissionExpectation = {
        profile: "intake",
        hostVersion: input.hostVersion,
        productTrustRevocationEpoch: trust.revocationEpoch,
        observedAt,
        intakeDraftId: intakeId,
      };
      const attestation = mintGrantAttestation({ grant: DISPOSABLE_INTAKE_GRANT, expectation, expiry: attestationExpiry });
      const admission = evaluateHostAdmission(expectation, DISPOSABLE_INTAKE_GRANT, attestation);
      if (!admission.admitted) {
        return refuse(
          "host_admission_refused",
          `The minted intake attestation does not admit against the binding's own expectation: ${admission.denials.map((denial) => denial.code).join(", ")}`,
          "Missing or failed grant application yields no intake invocation token.",
        );
      }

      const store = await intakeStoreFor(intakeId);
      const openedTransition = await appendIntake(store, intakeId, "intake.state.changed", {
        from: "draft_scope",
        to: "awaiting_clarification",
      });
      if (!openedTransition.ok) return openedTransition;
      await writeOwned(await intakePath(intakeId, ".request.json"), `${JSON.stringify({ workRequest })}\n`);
      const grantPath = await intakePath(intakeId, ".grant.json");
      await writeOwned(grantPath, `${JSON.stringify({ grant: DISPOSABLE_INTAKE_GRANT, expectation, attestation, admission })}\n`);
      return { ok: true, intakeId, grantDigest: admission.grantDigest, grantPath };
    },

    async recordClarification({ intakeId, question, answer }) {
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;
      return appendIntake(store, intakeId, "intake.clarification.recorded", { question, answer });
    },

    async recordDraft({ intakeId, draft }) {
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;

      if (state.state === "blocked") {
        // A draft mutation after a blocked acceptance preflight: the frozen
        // chain returns intake to the confirmation handoff — the consumed
        // confirmation covered different bytes and cannot carry the retry.
        const reopened = await appendIntake(store, intakeId, "intake.state.changed", { from: "blocked", to: "validating_acceptance" });
        if (!reopened.ok) return reopened;
        const returned = await appendIntake(store, intakeId, "intake.state.changed", {
          from: "validating_acceptance",
          to: "awaiting_confirmation",
        });
        if (!returned.ok) return returned;
      }

      const draftDigest = digestCanonical(draft);
      const recorded = await appendIntake(store, intakeId, "intake.draft.recorded", { draftDigest });
      if (!recorded.ok) return recorded;
      await writeOwned(await intakePath(intakeId, ".draft.json"), `${JSON.stringify(draft)}\n`);

      // A draft recorded after presentation VOIDS the pending confirmation:
      // the operator confirmed the previous digest, so the rendered channel
      // is destroyed and a fresh presentation is required.
      const metaPath = await intakePath(intakeId, ".meta.json");
      const meta = await readJson<IntakeMeta>(metaPath);
      if (meta?.nonce !== undefined) {
        await rm(confirmationPath(meta.nonce), { force: true });
        const { nonce: _voided, ...rest } = meta;
        await writeOwned(metaPath, `${JSON.stringify(rest)}\n`);
      }
      return { ok: true, draftDigest };
    },

    async presentDraft({ intakeId, expiry }) {
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;
      if (state.state !== "awaiting_clarification" && state.state !== "awaiting_confirmation") {
        return refuse(
          "wrong_state",
          `A draft is presented from awaiting_clarification or awaiting_confirmation; intake is in ${state.state}.`,
          "Record the draft, then present it.",
        );
      }
      const draft = await readJson<unknown>(await intakePath(intakeId, ".draft.json"));
      if (draft === undefined || state.lastDraftDigest === undefined) {
        return refuse("draft_missing", "No draft is retained for this intake.", "Record the completed draft contract first.");
      }
      const validated = await presentValidation(draft);
      if (!("policy" in validated)) return validated;

      if (state.state === "awaiting_clarification") {
        const presentedTransition = await appendIntake(store, intakeId, "intake.state.changed", {
          from: "awaiting_clarification",
          to: "awaiting_confirmation",
        });
        if (!presentedTransition.ok) return presentedTransition;
      }
      return presentForConfirmation(intakeId, validated.contract, validated, expiry);
    },

    async presentContract({ contract, expiry }) {
      const validated = await presentValidation(contract);
      if (!("policy" in validated)) return validated;

      // The direct already-scoped handoff still walks the frozen intake
      // chain — it bypasses only clarification, never the draft retention,
      // acceptance validation, or the operator confirmation.
      const intakeId = `intake-${hex(6)}`;
      const store = await intakeStoreFor(intakeId);
      const opened = await appendIntake(store, intakeId, "intake.state.changed", { from: "draft_scope", to: "awaiting_clarification" });
      if (!opened.ok) return opened;
      const draftDigest = digestCanonical(contract);
      const drafted = await appendIntake(store, intakeId, "intake.draft.recorded", { draftDigest });
      if (!drafted.ok) return drafted;
      await writeOwned(await intakePath(intakeId, ".draft.json"), `${JSON.stringify(contract)}\n`);
      const presentedTransition = await appendIntake(store, intakeId, "intake.state.changed", {
        from: "awaiting_clarification",
        to: "awaiting_confirmation",
      });
      if (!presentedTransition.ok) return presentedTransition;

      const presented = await presentForConfirmation(intakeId, validated.contract, validated, expiry);
      if (!presented.ok) return presented;
      return { ok: true, intakeId, nonce: presented.nonce, normalizedContractDigest: presented.normalizedContractDigest, channelPath: presented.channelPath };
    },

    async confirmContract({ intakeId, echo }) {
      const meta = await readJson<IntakeMeta>(await intakePath(intakeId, ".meta.json"));
      if (meta === undefined) {
        return refuse("intake_unknown", `No presented intake draft ${intakeId}.`, "Present the contract first.");
      }
      if (meta.nonce === undefined) {
        return refuse(
          "confirmation_void",
          "No confirmation is pending: the draft mutated after presentation, so the operator's confirmation covered different bytes.",
          "Present the current draft for a fresh operator confirmation.",
        );
      }
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;
      if (state.state !== "awaiting_confirmation") {
        return refuse(
          "wrong_state",
          `A contract confirmation is consumed in awaiting_confirmation; intake is in ${state.state}.`,
          state.state === "blocked" ? "Retry acceptance; the consumed confirmation stands over the unchanged draft." : "Present the draft first.",
        );
      }
      const consumed = await consumeChallenge(meta.nonce, echo);
      if (!("confirmation" in consumed)) return consumed;

      // The confirmation is consumed at the EXIT of awaiting_confirmation;
      // acceptance validation runs AFTER it, and registration completes only
      // at accepted_contract.
      const recorded = await appendIntake(store, intakeId, "operator.confirmation.recorded", { confirmation: consumed.confirmation });
      if (!recorded.ok) return recorded;
      const validating = await appendIntake(store, intakeId, "intake.state.changed", {
        from: "awaiting_confirmation",
        to: "validating_acceptance",
      });
      if (!validating.ok) return validating;
      return runAcceptance(intakeId, store, meta);
    },

    async retryAcceptance({ intakeId }) {
      const meta = await readJson<IntakeMeta>(await intakePath(intakeId, ".meta.json"));
      if (meta === undefined) {
        return refuse("intake_unknown", `No presented intake draft ${intakeId}.`, "Present the contract first.");
      }
      const store = await intakeStoreFor(intakeId);
      const state = await intakeStateOf(store);
      if (!("state" in state)) return state;
      if (state.state !== "blocked") {
        return refuse(
          "wrong_state",
          `retryAcceptance re-runs a blocked acceptance preflight; intake is in ${state.state}.`,
          "Only a blocked validating_acceptance retries without a fresh confirmation.",
        );
      }
      // The journal guarantees the draft cannot have changed since the
      // consumed confirmation — a retry over the unchanged draft re-runs
      // validation under that confirmation; no fresh confirmation is minted.
      const retried = await appendIntake(store, intakeId, "intake.state.changed", { from: "blocked", to: "validating_acceptance" });
      if (!retried.ok) return retried;
      return runAcceptance(intakeId, store, meta);
    },

    async bindWorkspace({ deliveryId, worktreeDir, hostTaskId, observedAt, attestationExpiry, observationLifetimeSeconds }) {
      const guarded = await guard(deliveryId, { allowPendingTakeover: true });
      if (!("store" in guarded)) return guarded;
      const takeover = await readJson<PendingTakeover>(path.join(await deliveryDir(deliveryId), "takeover.json"));
      if (guarded.state !== "preparing" && takeover === undefined) {
        return refuse(
          "wrong_state",
          `bindWorkspace runs in preparing or after an authorized takeover; the delivery is in ${guarded.state}.`,
          "Read `status` for the next valid checkpoint.",
        );
      }

      // The workspace is host-created; the facade only validates and binds.
      const top = await git(worktreeDir, "rev-parse", "--show-toplevel");
      const commonOfWorktree = await git(worktreeDir, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const commonOfRepo = await git(input.repoDir, "rev-parse", "--path-format=absolute", "--git-common-dir");
      if (top.code !== 0 || commonOfWorktree.code !== 0 || commonOfWorktree.out !== commonOfRepo.out) {
        return refuse("workspace_invalid", "The supplied worktree does not belong to this repository.", "Hand in a host-created worktree of this repository.");
      }
      const porcelain = await git(worktreeDir, "status", "--porcelain");
      if (porcelain.code !== 0 || porcelain.out !== "") {
        return refuse("workspace_dirty", "The supplied worktree carries uncommitted or untracked work.", "Dirty baselines fail closed; hand in a clean worktree.");
      }
      const branchRef = (await git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD")).out;
      const branchRefValue = (await git(worktreeDir, "rev-parse", `refs/heads/${branchRef}`)).out;
      const headCommit = (await git(worktreeDir, "rev-parse", "HEAD")).out;
      const treeSha = (await git(worktreeDir, "rev-parse", "HEAD^{tree}")).out;
      const baseTipSha = (await git(input.repoDir, "rev-parse", guarded.meta.contract.repository.baseRef)).out;

      if (takeover !== undefined) {
        if (headCommit !== takeover.targetBaseCommit || branchRef !== takeover.takeoverBranchRef) {
          return refuse(
            "takeover_mismatch",
            `The fresh worktree must sit on ${takeover.takeoverBranchRef} at the authorized last trusted commit ${takeover.targetBaseCommit}.`,
            "Recreate the worktree from the takeover authorization's target base commit.",
          );
        }
      }

      const dir = await deliveryDir(deliveryId);
      const bindingDir = path.join(dir, "binding");
      const workspaceId = `ws-${hex(6)}`;
      const worktreeId = `wt-${sha256Hex(worktreeDir).slice(0, 16)}`;

      const bound = await appendEntry(guarded.store, deliveryId, "workspace.bound", {
        workspaceId,
        repositoryId: guarded.meta.contract.repository.repositoryId,
        baseRef: guarded.meta.contract.repository.baseRef,
        baseTipSha,
        branchRef: `refs/heads/${branchRef}`,
        branchRefValue,
        worktreeId,
        baselineClassification: "clean",
      });
      if (!bound.ok) return bound;

      const materialized = await materializeProjection({
        worktreeDir,
        generationRoot: guarded.generationRoot,
        deliveryId,
        bindingDir,
        exec,
      });
      if (!materialized.ok) {
        return refuse(
          "projection_failed",
          `Materializing the run-pinned projection failed: ${materialized.blockers.map((blocker) => blocker.message).join("; ")}`,
          "A missing or unmaterializable pinned root blocks rather than falling forward.",
        );
      }

      const statePath = path.join(bindingDir, "state.json");
      const session = await composeClaudeCodeSession({
        bindingDir,
        statePath,
        hookCommand: [TSX_BIN, HOOK_MAIN],
        grant: DISPOSABLE_STAGE_GRANT,
      });
      if (!session.ok) {
        return refuse(
          "session_composition_failed",
          `Composing the host admission failed: ${session.blockers.map((blocker) => blocker.message).join("; ")}`,
          "Materialize the projection before composing the session.",
        );
      }

      // The bundled graph rides in through the pinned generation; binding
      // validates the checkpoint mapping against it.
      const archiveBytes = await readFile(path.join(guarded.generationRoot, ...GENERATION_SKILLS_ARCHIVE.split("/")));
      const graph = loadBundledWorkflowGraph(archiveBytes);
      if (!graph.ok) {
        return refuse(
          "workflow_graph_rejected",
          `The bundled workflow graph failed its pin: ${graph.blockers.map((blocker) => blocker.message).join("; ")}`,
          "Only the exact pinned graph governs checkpoints.",
        );
      }

      const trust = await readTrust();
      if (trust === undefined) {
        return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
      }
      const registered = lastOf(guarded.views, "delivery.registered");
      const fence = guarded.lastFence + 1;
      const expectation: CheckpointAdmissionExpectation = {
        profile: "checkpoint",
        hostVersion: input.hostVersion,
        productTrustRevocationEpoch: trust.revocationEpoch,
        observedAt,
        deliveryId,
        invocationFence: fence,
        workspaceId,
        projectionDigest: materialized.projectionDigest,
        discoveryConfigurationDigest: session.discoveryConfigurationDigest,
        registeringInstallationId: registered?.payload["registeringInstallationId"] as string,
        activeProfile: registered?.payload["activeCompositionProfile"] as string,
      };
      const attestation = mintGrantAttestation({ grant: DISPOSABLE_STAGE_GRANT, expectation, expiry: attestationExpiry });
      const admission = evaluateHostAdmission(expectation, DISPOSABLE_STAGE_GRANT, attestation);
      if (!admission.admitted) {
        return refuse(
          "host_admission_refused",
          `The minted attestation does not admit against the binding's own expectation: ${admission.denials.map((denial) => denial.code).join(", ")}`,
          "Missing or failed grant application yields no mutation-capable invocation token.",
        );
      }

      const observationPath = path.join(bindingDir, "observation.json");
      await writeOwned(
        statePath,
        `${JSON.stringify({
          expectation,
          grant: DISPOSABLE_STAGE_GRANT,
          attestation,
          workspaceRoot: worktreeDir,
          observationPath,
          journalPath: guarded.store.journalPath,
          deliveryId,
        })}\n`,
      );
      await writeOwned(observationPath, `${JSON.stringify({ fence, observedAt })}\n`);
      const lifetime = observationLifetimeSeconds ?? 900;
      await writeOwned(
        path.join(dir, "workspace.json"),
        `${JSON.stringify({
          worktreeDir,
          workspaceId,
          worktreeId,
          branchRef,
          observationLifetimeSeconds: lifetime,
          workflowGraphSha256: graph.graphSha256,
          discoveryConfigurationDigest: session.discoveryConfigurationDigest,
          projectionDigest: materialized.projectionDigest,
        } satisfies WorkspaceMeta)}\n`,
      );

      const fenced = await appendEntry(guarded.store, deliveryId, "invocation.fenced", {
        fence,
        hostTaskId,
        worktreeId,
        candidateTreeSha: treeSha,
        candidateBranchRefValue: branchRefValue,
        policyDigest: guarded.meta.policy.policyDigest,
        authorityEpoch: guarded.meta.policy.repositoryAuthorityRevocationEpoch,
        observationLifetimeSeconds: lifetime,
      });
      if (!fenced.ok) return fenced;
      await appendEntry(guarded.store, deliveryId, "activity.observed", { activity: "active", fence });

      if (takeover !== undefined) {
        await appendEntry(guarded.store, deliveryId, "workspace.disposition.recorded", {
          workspaceId,
          disposition: "takeover",
        });
        // A blocked delivery resumes at its last trustworthy checkpoint — the
        // frozen reducer's journal-dependent rule — once the authorized fresh
        // worktree stands. (Leaving security_blocked stays a maintenance-lane
        // operation outside this skeleton; the trust recheck above already
        // refuses that path.)
        if (guarded.state === "blocked") {
          const resumed = await appendEntry(guarded.store, deliveryId, "transition.committed", {
            from: "blocked",
            to: guarded.lastActiveState,
          });
          if (!resumed.ok) return resumed;
        }
        await rm(path.join(dir, "takeover.json"), { force: true });
      } else {
        const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "preparing", to: "planning" });
        if (!transitioned.ok) return transitioned;
      }

      return {
        ok: true,
        fence,
        workspaceId,
        statePath,
        settingsPath: session.settingsPath,
        cliArgs: session.cliArgs,
        projectionDigest: materialized.projectionDigest,
      };
    },

    async status({ deliveryId, observedAt }) {
      const dir = await deliveryDir(deliveryId);
      const meta = await readJson<DeliveryMeta>(path.join(dir, "delivery.json"));
      if (meta === undefined) {
        return refuse("unknown_delivery", `No registered delivery ${deliveryId}.`, "Register a delivery through the contract handoff first.");
      }
      const store = await journalStoreFor(deliveryId);
      const reduced = await store.state();
      const read = await store.read();
      if (!reduced.ok || !read.ok) {
        return refuse("journal_rejected", "The durable journal does not reduce.", "Inspect the durable journal file.");
      }
      const views = viewsOf(read.entries);
      const workspace = await readJson<WorkspaceMeta>(path.join(dir, "workspace.json"));

      // Host activity: the trusted lifecycle observations, aged lazily by the
      // fence's declared observation lifetime — timeout never proves
      // termination, so an aged `active` becomes `unknown`, never `ended`.
      type HostActivity = "active" | "paused" | "unknown" | "cancellation_pending";
      const lastActivity = lastOf(views, "activity.observed");
      let activity: HostActivity =
        lastActivity !== undefined && lastActivity.payload["fence"] === reduced.state.lastFence
          ? (lastActivity.payload["activity"] as HostActivity)
          : "unknown";
      if (activity === "active" && workspace !== undefined) {
        const observation = await readJson<{ fence: number; observedAt: string }>(path.join(dir, "binding", "observation.json"));
        if (observation === undefined || observation.fence !== reduced.state.lastFence) {
          activity = "unknown";
        } else {
          const ageSeconds = instantSeconds(observedAt) - instantSeconds(observation.observedAt);
          if (Number.isNaN(ageSeconds) || ageSeconds > workspace.observationLifetimeSeconds) activity = "unknown";
        }
      }

      const confirmations = views.filter((view) => view.kind === "operator.confirmation.recorded").length;
      const interventions = views.filter(
        (view) => view.kind === "blocker.recorded" && String(view.payload["code"]).startsWith("operator."),
      ).length;

      const terminal = reduced.state.state === "completed" || reduced.state.state === "cancelled" || reduced.state.state === "failed";
      const resume = !terminal && activity !== "active" ? "takeover-required" : "none";

      const blockers =
        reduced.state.state === "blocked" || reduced.state.state === "security_blocked"
          ? views
              .filter((view) => view.kind === "blocker.recorded")
              .slice(-1)
              .map((view) => ({ code: view.payload["code"] as string, summary: view.payload["summary"] as string }))
          : [];

      return {
        ok: true,
        state: reduced.state.state,
        activity,
        expectedRevision: reduced.state.expectedRevision,
        fence: reduced.state.lastFence,
        nextCheckpoint: nextCheckpointOf(reduced.state.state, views),
        policyRequiredInterruptions: confirmations + 1, // + the intake contract confirmation
        operatorInterventions: interventions,
        resume,
        blockers,
      };
    },

    async nextCheckpoint({ deliveryId }) {
      const guarded = await guard(deliveryId);
      if (!("store" in guarded)) return guarded;
      return { ok: true, checkpoint: nextCheckpointOf(guarded.state, guarded.views) };
    },

    async submitStageResult({ deliveryId, stageId, resultBytes, fence }) {
      const expected: readonly DeliveryState[] = stageId === "plan" ? ["planning"] : ["compounding"];
      const guarded = await guard(deliveryId, { requireState: expected, verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const binding = workflowStageBindingFor(guarded.state);
      if (binding === undefined || binding.stageId !== stageId) {
        return refuse("wrong_stage", `Stage ${stageId} is not the bundled graph's checkpoint for ${guarded.state}.`, "Read `next-checkpoint`.");
      }
      const loaded = await loadGraph(guarded.generationRoot);
      if (!("graph" in loaded)) return loaded;

      const current = currentCandidateOf(guarded.views);
      if (stageId === "compound") {
        // No repository mutation may ride the compounding checkpoint.
        const treeSha = (await git(workspace.worktreeDir, "rev-parse", "HEAD^{tree}")).out;
        if (current !== undefined && treeSha !== current.treeSha) {
          const recorded = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "compounding", to: "validating" });
          if (!recorded.ok) return recorded;
          return { ok: true, state: "validating" };
        }
      }

      // The checkpoint reducer admits only a typed result validated against
      // the pinned graph, then evaluates the graph-declared prerequisites.
      const summaries = await retainedSummaries(deliveryId, guarded.views);
      const processed = processStageResult({
        resultBytes,
        graph: loaded.graph,
        graphSha256: loaded.graphSha256,
        stageId,
        deliveryId,
        ...(current === undefined ? {} : { currentCandidate: current.treeSha }),
        summaries,
        productRealized: binding.productRealizedPrerequisites,
      });
      if (!("result" in processed)) return processed;

      await writeOwned(persistedResultPath(await deliveryDir(deliveryId), processed.digest), processed.bytes);
      const stage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId,
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: processed.digest,
      });
      if (!stage.ok) return stage;

      if (processed.result.status !== "succeeded") {
        // A typed non-success result is persisted, then blocks with its own
        // actionable next step — it never advances the happy edge.
        await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
          code: `workflow.stage-${processed.result.status}`,
          summary: (processed.result.nextStep ?? `the ${stageId} stage reported ${processed.result.status}`).slice(0, 1900),
        });
        const blocked = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: guarded.state, to: "blocked" });
        if (!blocked.ok) return blocked;
        return { ok: true, state: "blocked" };
      }

      const to: DeliveryState = stageId === "plan" ? "implementing" : "admitting";
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: guarded.state, to });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: to };
    },

    async checkpointCandidate({ deliveryId, resultBytes, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["implementing", "remediating"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");

      const porcelain = await git(workspace.worktreeDir, "status", "--porcelain");
      if (porcelain.code !== 0 || porcelain.out !== "") {
        return refuse(
          "candidate_uncommitted",
          "The worktree carries uncommitted work; the host commits through its native git tooling before a checkpoint.",
          "Commit the mutation in the worktree, then checkpoint.",
        );
      }
      const treeSha = (await git(workspace.worktreeDir, "rev-parse", "HEAD^{tree}")).out;
      const branchRefValue = (await git(workspace.worktreeDir, "rev-parse", `refs/heads/${workspace.branchRef}`)).out;
      const previous = currentCandidateOf(guarded.views);

      // A candidate checkpoints only under a typed `implement` success whose
      // candidate reference is the INDEPENDENTLY captured tree above — the
      // released produced-on-success rule; a result cannot nominate its own.
      const loaded = await loadGraph(guarded.generationRoot);
      if (!("graph" in loaded)) return loaded;
      const summaries = await retainedSummaries(deliveryId, guarded.views);
      const processed = processStageResult({
        resultBytes,
        graph: loaded.graph,
        graphSha256: loaded.graphSha256,
        stageId: "implement",
        deliveryId,
        ...(previous === undefined ? {} : { currentCandidate: previous.treeSha }),
        producedCandidate: treeSha,
        summaries,
      });
      if (!("result" in processed)) return processed;
      if (processed.result.status !== "succeeded") {
        return refuse(
          "stage_result_rejected",
          "checkpointCandidate records a PRODUCED candidate; a non-success implement result checkpoints nothing.",
          "Checkpoint only a produced candidate; a blocked implementation is reported without a checkpoint.",
        );
      }

      const recaptured = await appendEntry(guarded.store, deliveryId, "candidate.recaptured", { treeSha, branchRefValue });
      if (!recaptured.ok) return recaptured;
      // A candidate change since a pending waiver/amendment proposal voids
      // the stale proposal with a typed blocker record — its criterion
      // binding must be re-evaluated against the new candidate. The delivery
      // does not leave its state for this; blocker.recorded alone never
      // suspends.
      if (previous === undefined || previous.treeSha !== treeSha) {
        const proposals = guarded.views.filter((view) => view.kind === "approval.request.recorded").length;
        const voided = guarded.views.filter(
          (view) => view.kind === "blocker.recorded" && view.payload["code"] === "approval.proposal-voided",
        ).length;
        for (let index = voided; index < proposals; index += 1) {
          await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
            code: "approval.proposal-voided",
            summary: "the candidate changed since the proposal; the stale waiver/amendment proposal is void and must be re-proposed against the new candidate",
          });
        }
      }
      // Every checkpointed revision — first implementation AND each
      // remediation — records its typed `implement` result: the graph's
      // produce-or-revise-candidate stage covers both.
      await writeOwned(persistedResultPath(await deliveryDir(deliveryId), processed.digest), processed.bytes);
      const stage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId: "implement",
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: processed.digest,
      });
      if (!stage.ok) return stage;
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", {
        from: guarded.state,
        to: "validating",
      });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "validating", treeSha };
    },

    async runSensor({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["validating"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");

      // The TRUSTED-BASE copy governs — never the candidate's tracked file.
      const trustedSensor = path.join(await deliveryDir(deliveryId), "trusted-sensor.mjs");
      const run = await exec.run({ command: process.execPath, args: [trustedSensor], cwd: workspace.worktreeDir });
      const outcome: "passed" | "failed" = run.code === 0 ? "passed" : "failed";
      const treeSha = (await git(workspace.worktreeDir, "rev-parse", "HEAD^{tree}")).out;
      const summaryRaw = `${run.stdout}\n${run.stderr}`.trim().slice(0, 1900);
      const result = {
        spec: "sensor-result/1",
        capabilityId: DISPOSABLE_SENSOR_CAPABILITY.descriptor.capabilityId,
        outcome,
        summary: summaryRaw.length > 0 ? summaryRaw : `sensor ${outcome} with no output`,
        candidateTreeSha: treeSha,
      };
      const shape = validateSensorResult(result);
      if (!shape.ok) {
        return refuse("sensor_result_rejected", "The sensor result is outside its frozen shape.", "Inspect the trusted sensor's output.");
      }
      const recorded = await appendEntry(guarded.store, deliveryId, "operation.result.recorded", {
        capabilityId: result.capabilityId,
        result,
      });
      if (!recorded.ok) return recorded;
      const to: DeliveryState = outcome === "passed" ? "reviewing" : "remediating";
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "validating", to });
      if (!transitioned.ok) return transitioned;
      return { ok: true, outcome, state: to };
    },

    async submitReviewAttempt({ deliveryId, attemptId, lensId, verdict, contextBytes, artifactBytes, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["reviewing"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      if (!DISPOSABLE_REVIEW_LENSES.some((lens) => lens.lensId === lensId)) {
        return refuse("unknown_lens", `Lens ${lensId} is not selected by the compiled policy.`, "Use a policy-selected lens.");
      }
      const current = currentCandidateOf(guarded.views);
      if (current === undefined) return refuse("no_candidate", "No candidate is checkpointed.", "Checkpoint a candidate first.");

      // Attempt identities are single-use: a recorded attempt — verdict and
      // all — is never replaced, so a findings verdict cannot be laundered
      // into an approval by re-submitting under the same identity.
      const attemptPath = path.join(await deliveryDir(deliveryId), "attempts", `${attemptId}.json`);
      if ((await readJson<AttemptFile>(attemptPath)) !== undefined) {
        return refuse(
          "duplicate_attempt",
          `Attempt ${attemptId} is already recorded; review attempts complete under distinct, single-use identities.`,
          "Submit a fresh attempt under a new identity with an independently constructed context.",
        );
      }

      // Independence is falsifiable: the digest is over the attempt's own
      // context materials, so identically-contexted lenses collide.
      const contextDigest = digestCanonical({ candidateTreeSha: current.treeSha, context: contextBytes });
      const attempt: RecordedReviewAttempt = {
        attemptId,
        lensId,
        contextDigest,
        artifactDigest: sha256Hex(artifactBytes),
        verdict,
        candidateTreeSha: current.treeSha,
      };
      const recorded = await appendEntry(guarded.store, deliveryId, "attempt.artifact.recorded", {
        attemptId,
        lensId,
        contextDigest,
        artifactDigest: attempt.artifactDigest,
      });
      if (!recorded.ok) return recorded;
      await writeOwned(
        path.join(await deliveryDir(deliveryId), "attempts", `${attemptId}.json`),
        `${JSON.stringify({ attempt } satisfies AttemptFile)}\n`,
      );
      return { ok: true };
    },

    async reduceReview({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["reviewing"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const current = currentCandidateOf(guarded.views);
      if (current === undefined) return refuse("no_candidate", "No candidate is checkpointed.", "Checkpoint a candidate first.");
      const attempts = (await attemptsOf(deliveryId)).filter((attempt) => attempt.candidateTreeSha === current.treeSha);

      const floor = checkReviewFloor({
        attempts,
        lenses: DISPOSABLE_REVIEW_LENSES.map((lens) => ({ ...lens })),
        candidateTreeSha: current.treeSha,
      });
      if (!floor.ok) {
        return refuse(
          "review_floor_unmet",
          `The mandatory review floor is not met: ${floor.rejections.map((rejection) => rejection.message).join("; ")}`,
          "Complete both mandatory lenses as distinct attempts with independently constructed contexts.",
        );
      }

      const loaded = await loadGraph(guarded.generationRoot);
      if (!("graph" in loaded)) return loaded;
      const summaries = await retainedSummaries(deliveryId, guarded.views);
      const dir = await deliveryDir(deliveryId);

      // A repair round follows recorded changes-requested evidence — the
      // graph's own repair-loop prerequisite, satisfied by the retained
      // review.reduce summary of the previous round.
      const repairLoop = summaries.get("review.reduce")?.outputKind === "review-round-changes-requested";

      // The product composes the review stage results itself, but they pass
      // through the SAME released-contract validation as host-submitted
      // results — the parity the qualification corpus freezes.
      const composeReviewResult = (stageId: "review.acquire" | "review.reduce", outputKind: string, evidence: unknown, evidenceRefs: readonly string[]) =>
        JSON.stringify({
          schemaVersion: WORKFLOW_STAGE_RESULT_SPEC,
          release: RELEASE_IDENTITY,
          graphSha256: loaded.graphSha256,
          stageId,
          subjectRef: { schemaVersion: WORKFLOW_SUBJECT_REF_SPEC, opaque: deliveryId },
          candidateRef: { schemaVersion: WORKFLOW_CANDIDATE_REF_SPEC, opaque: current.treeSha },
          status: "succeeded",
          output: { kind: outputKind, evidenceRef: digestCanonical(evidence) },
          evidenceRefs,
          limitations: [],
        });

      const acquisitionBytes = composeReviewResult(
        "review.acquire",
        "review-acquisition-envelope",
        attempts,
        attempts.map((attempt) => attempt.attemptId),
      );
      const processedAcquire = processStageResult({
        resultBytes: acquisitionBytes,
        graph: loaded.graph,
        graphSha256: loaded.graphSha256,
        stageId: "review.acquire",
        deliveryId,
        currentCandidate: current.treeSha,
        summaries,
        repairLoop,
      });
      if (!("result" in processedAcquire)) return processedAcquire;
      await writeOwned(persistedResultPath(dir, processedAcquire.digest), processedAcquire.bytes);
      const acquireStage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId: "review.acquire",
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: processedAcquire.digest,
      });
      if (!acquireStage.ok) return acquireStage;

      const qualified = qualifyReviewAttempts(attempts, current.treeSha).qualified;
      const anyFindings = qualified.some((attempt) => attempt.verdict === "findings");
      const roundKind = anyFindings ? "review-round-changes-requested" : "review-round-aligned";
      const reductionBytes = composeReviewResult("review.reduce", roundKind, qualified, []);
      const reduceSummaries = new Map(summaries);
      reduceSummaries.set("review.acquire", { status: "succeeded", outputKind: "review-acquisition-envelope" });
      const processedReduce = processStageResult({
        resultBytes: reductionBytes,
        graph: loaded.graph,
        graphSha256: loaded.graphSha256,
        stageId: "review.reduce",
        deliveryId,
        currentCandidate: current.treeSha,
        summaries: reduceSummaries,
      });
      if (!("result" in processedReduce)) return processedReduce;
      await writeOwned(persistedResultPath(dir, processedReduce.digest), processedReduce.bytes);
      const reduceStage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId: "review.reduce",
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: processedReduce.digest,
      });
      if (!reduceStage.ok) return reduceStage;

      if (anyFindings) {
        // Review repeats until the selected lenses approve — but bounded: a
        // findings round beyond the bound records a typed blocker instead of
        // spinning the loop unobserved.
        let changesRequestedRounds = 1; // this round
        for (const view of guarded.views) {
          if (view.kind !== "stage.result.recorded" || view.payload["stageId"] !== "review.reduce") continue;
          const persisted = await persistedResultOf(dir, view.payload["resultDigest"] as string);
          if (persisted?.outputKind === "review-round-changes-requested") changesRequestedRounds += 1;
        }
        if (changesRequestedRounds > REVIEW_ROUND_BOUND) {
          await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
            code: "review.loop-bound-reached",
            summary: `review round ${changesRequestedRounds} still requests changes; after ${REVIEW_ROUND_BOUND} findings-driven rounds the loop records a bounded blocker instead of repeating`,
          });
          const blocked = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "reviewing", to: "blocked" });
          if (!blocked.ok) return blocked;
          return { ok: true, state: "blocked" };
        }
      }

      const to: DeliveryState = anyFindings ? "remediating" : "compounding";
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "reviewing", to });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: to };
    },

    async admit({ deliveryId, recordedAtInstant, env, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["admitting"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const current = currentCandidateOf(guarded.views);
      if (current === undefined) return refuse("no_candidate", "No candidate is checkpointed.", "Checkpoint a candidate first.");

      // Vacuous satisfaction is excluded: the compiled policy's obligation set
      // is non-empty by construction, and admission evaluates every one.
      const attempts = (await attemptsOf(deliveryId)).filter((attempt) => attempt.candidateTreeSha === current.treeSha);
      const floor = checkReviewFloor({
        attempts,
        lenses: DISPOSABLE_REVIEW_LENSES.map((lens) => ({ ...lens })),
        candidateTreeSha: current.treeSha,
      });
      if (!floor.ok) {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "review.floor-unmet",
          floor.rejections.map((rejection) => rejection.message).join("; ").slice(0, 1900),
          "blocked",
        );
        return refuse("review_floor_unmet", "The mandatory review floor is not met at admission.", "Complete both mandatory lenses on the exact candidate.");
      }

      const rootDir = workspace.worktreeDir;
      const capture = await captureFor(rootDir, input.config, candidateRunner, storageGitRunner);
      if (!capture.ok) return capture.failure;
      const captured = capture.candidate;
      if (captured.treeSha !== current.treeSha) {
        return refuse("candidate_moved", "The worktree moved after its last checkpoint.", "Re-checkpoint the candidate, then admit.");
      }

      const outcome = composeOutcomeVerification({
        contract: guarded.meta.contract,
        candidate: { treeSha: current.treeSha, deliverableDigest: captured.deliverable.digest },
        sensorResults: sensorResultsOf(guarded.views),
        attempts,
      });
      const unresolved = outcome.criteria.filter((criterion) => criterion.disposition !== "passed");
      if (unresolved.length > 0) {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "outcome.criterion-unverified",
          `criterion mapping failed: ${unresolved.map((criterion) => `${criterion.criterionId} (${criterion.evidence.reference})`).join("; ")}`.slice(0, 1900),
          "blocked",
        );
        return refuse(
          "criterion_unverified",
          "An acceptance criterion carries no passing exact-candidate evidence; a green-but-unrelated change fails criterion mapping.",
          "Satisfy the criterion's sensor on the exact candidate, then re-validate.",
        );
      }

      // The EXISTING harness admission: preparation receipt, evidence
      // manifest from the two lens attempts, submission, and the gate.
      const storage = await resolveRecordStorage(rootDir, { storageNamespace: input.config.storageNamespace, runGit: storageGitRunner });
      await publishPreparationReceipt(rootDir, { config: input.config, candidate: captured }, { storageNamespace: input.config.storageNamespace, runGit: storageGitRunner });

      const artifacts = createArtifactsPort();
      const providerRegistration = input.config.providers[0];
      if (providerRegistration === undefined) {
        return refuse("no_provider", "The repository gate registers no provider.", "Register the review provider in the harness config.");
      }
      const provider = { id: providerRegistration.id, version: "1.0.0", runId: `r-${hex(5)}`, finalPassId: "pass-1" };
      const allocation = await artifacts.allocateRunRoot({ providerId: provider.id, runId: provider.runId });
      if (!allocation.ok) {
        return refuse("run_root_refused", `The artifacts port refused a run root: ${allocation.reason}`, "Inspect the artifacts port.");
      }
      const runRoot = allocation.runRoot.path;
      const candidateForManifest = {
        vcs: captured.vcs,
        treeSha: captured.treeSha,
        headSha: captured.headSha,
        deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
        base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
        workspaceId: captured.workspaceId,
      };
      const qualified = qualifyReviewAttempts(attempts, current.treeSha).qualified;
      const manifestArtifacts: { path: string; sha256: string; role: string }[] = [];
      await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
      for (const attempt of qualified) {
        // The reviewer-approval artifact keeps the recorder's closed grammar;
        // the attempt identity, context digest, and artifact digest are bound
        // in the delivery journal's attempt records, not smuggled in here.
        const approval = `${JSON.stringify({
          schemaVersion: 1,
          reviewerId: attempt.lensId,
          result: attempt.verdict === "approved" ? "approved" : "changes-requested",
          provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId },
          workspaceId: captured.workspaceId,
          candidate: candidateForManifest,
        }, null, 2)}\n`;
        const relative = `reviewers/${attempt.lensId}.json`;
        await writeFile(path.join(runRoot, relative), approval, "utf8");
        manifestArtifacts.push({ path: relative, sha256: sha256Hex(approval), role: "reviewer-approval" });
      }
      const manifest = {
        spec: "delivery-evidence/1",
        provider,
        candidate: candidateForManifest,
        repository: null,
        runHistory: [{ preparedTreeSha: captured.treeSha, evaluatedInPassId: provider.finalPassId }],
        artifacts: manifestArtifacts,
        attestation: { level: "self", signatures: [] },
        recordedAt: recordedAtInstant,
        claims: [
          {
            obligation: "review.green",
            payloadSpec: "review.green/1",
            payload: {
              verdict: "green",
              finalized: true,
              editedAfterFinalPass: false,
              reviewers: {
                selected: qualified.map((attempt) => attempt.lensId).sort(),
                completed: qualified.map((attempt) => attempt.lensId).sort(),
                failed: [],
                timedOut: [],
              },
              findings: [],
              telemetry: {
                iterationCount: 1,
                findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
                deferredExpansionCount: 0,
                deferredIssueIds: [],
              },
            },
          },
        ],
      };
      const manifestPath = path.join(runRoot, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const submission = await submitManifest(
        { rootDir, manifestPath, config: input.config },
        { captureCandidate: capture.captureCandidate, artifacts, storageNamespace: input.config.storageNamespace, runGit: storageGitRunner },
      );
      if (submission.status !== "accepted") {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "evidence.rejected",
          submission.blockers.map((blocker) => blocker.summary).join("; ").slice(0, 1900),
          "blocked",
        );
        return refuseWith(submission.blockers);
      }

      const admission = await runAdmission(
        { rootDir, config: input.config, context: classifyExecutionContext({ config: input.config, env, stdinIsTTY: false, stdoutIsTTY: false }) },
        {
          captureCandidate: capture.captureCandidate,
          projectActivation: (candidate: CapturedCandidate) => evaluateCandidateActivation({ rootDir, candidate, config: input.config, run: candidateRunner }),
          storageNamespace: input.config.storageNamespace,
          runGit: storageGitRunner,
        },
      );
      if (!admission.admitted) {
        await recordBlockerAndTransition(
          guarded.store,
          deliveryId,
          guarded.state,
          "admission.refused",
          admission.blockers.map((blocker) => blocker.summary).join("; ").slice(0, 1900),
          "blocked",
        );
        return refuseWith(admission.blockers);
      }

      const record = submission.records[0];
      const referenced = await appendEntry(guarded.store, deliveryId, "evidence.reference.recorded", {
        recordId: record === undefined ? sha256Hex("") : record.recordId,
        manifestDigest: submission.manifestDigest,
      });
      if (!referenced.ok) return referenced;

      await writeOwned(path.join(await deliveryDir(deliveryId), "outcome.json"), `${JSON.stringify(outcome)}\n`);
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "admitting", to: "recording" });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "recording" };
    },

    async prepareTrackedRecord({ deliveryId, env, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["recording"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const rootDir = workspace.worktreeDir;
      const capture = await captureFor(rootDir, input.config, candidateRunner, storageGitRunner);
      if (!capture.ok) return capture.failure;

      const admission = await runAdmission(
        { rootDir, config: input.config, context: classifyExecutionContext({ config: input.config, env, stdinIsTTY: false, stdoutIsTTY: false }) },
        {
          captureCandidate: capture.captureCandidate,
          projectActivation: (candidate: CapturedCandidate) => evaluateCandidateActivation({ rootDir, candidate, config: input.config, run: candidateRunner }),
          storageNamespace: input.config.storageNamespace,
          runGit: storageGitRunner,
        },
      );
      if (!admission.admitted || admission.decision === undefined) {
        return refuseWith(admission.blockers);
      }
      const evidenceRecords = [];
      for (const obligation of input.config.obligations) {
        const discovery = await discoverRecords(rootDir, {
          gateId: input.config.gateId,
          obligationId: obligation.id,
          storageNamespace: input.config.storageNamespace,
          runGit: storageGitRunner,
        });
        evidenceRecords.push(...discovery.records);
      }
      const built = buildDeliveryRecord({ config: input.config, decision: admission.decision, evidenceRecords });
      if (!built.ok) return refuseWith(built.blockers);
      const relativePath = deliveryRecordPathFor(input.config, admission.decision.candidate.deliverable.digest);
      await mkdir(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
      await writeFile(path.join(rootDir, relativePath), deliveryRecordBytes(built.record), "utf8");
      return { ok: true, relativePath };
    },

    async confirmTrackedRecord({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["recording"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const rootDir = workspace.worktreeDir;

      const porcelain = await git(rootDir, "status", "--porcelain");
      if (porcelain.code !== 0 || porcelain.out !== "") {
        return refuse("record_uncommitted", "The tracked record is not checkpoint-committed.", "Commit the record through the host's native git tooling.");
      }
      const capture = await captureFor(rootDir, input.config, candidateRunner, storageGitRunner);
      if (!capture.ok) return capture.failure;
      const captured = capture.candidate;

      const relativePath = deliveryRecordPathFor(input.config, captured.deliverable.digest);
      let recordText: string;
      try {
        recordText = await readFile(path.join(rootDir, relativePath), "utf8");
      } catch {
        return refuse("record_missing", `No tracked record at ${relativePath}.`, "Prepare and commit the tracked record first.");
      }
      const parsed = parseDeliveryRecord(recordText);
      if (!parsed.ok) return refuseWith(parsed.blockers);

      // The compiled external verifier's pure core — the same check the
      // repository's pull-request Action runs.
      const check = verifyDeliveryRecord(
        input.config,
        parsed.record,
        { deliverableDigest: captured.deliverable.digest, identityToken: captured.deliverable.identity },
        { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
      );
      if (!check.ok) return refuseWith(check.blockers);

      const treeSha = (await git(rootDir, "rev-parse", "HEAD^{tree}")).out;
      const branchRefValue = (await git(rootDir, "rev-parse", `refs/heads/${workspace.branchRef}`)).out;
      const recaptured = await appendEntry(guarded.store, deliveryId, "candidate.recaptured", { treeSha, branchRefValue });
      if (!recaptured.ok) return recaptured;
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", {
        from: "recording",
        to: "ready",
        trackedRecord: { path: relativePath, sha256: sha256Hex(recordText) },
      });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "ready" };
    },

    async completeFinishLine({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { requireState: ["ready"], verifyWorkspace: true, invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const outcome = await readJson<OutcomeVerification>(path.join(await deliveryDir(deliveryId), "outcome.json"));
      if (outcome === undefined) {
        return refuse("outcome_missing", "No outcome verification is on file for this delivery.", "Admit the delivery first.");
      }
      const composed = composeMergeReadyResult({ deliveryId, outcome });
      if (!composed.ok) {
        return refuse(
          "finish_line_refused",
          `The merge-ready result failed the spine's cross-checks: ${composed.rejections.map((rejection) => rejection.message).join("; ")}`,
          "Resolve every criterion, then complete the finish line.",
        );
      }
      const recorded = await appendEntry(guarded.store, deliveryId, "finish.line.recorded", { result: composed.result });
      if (!recorded.ok) return recorded;
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "ready", to: "completed" });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "completed", resultDigest: digestCanonical(composed.result) };
    },

    async sessionEnded({ deliveryId, fence }) {
      const guarded = await guard(deliveryId, { invokingFence: fence, fenceRequired: true });
      if (!("store" in guarded)) return guarded;
      const appended = await appendEntry(guarded.store, deliveryId, "activity.observed", {
        activity: "paused",
        fence: guarded.lastFence,
      });
      if (!appended.ok) return appended;
      return { ok: true };
    },

    async recordApprovalRequest({ deliveryId, requestKind, criterionId, actorId, reason, fence }) {
      const guarded = await guard(deliveryId, {
        requireState: ["reviewing", "remediating", "admitting"],
        verifyWorkspace: true,
        invokingFence: fence,
        fenceRequired: true,
      });
      if (!("store" in guarded)) return guarded;
      const appended = await appendEntry(guarded.store, deliveryId, "approval.request.recorded", {
        requestKind,
        criterionId,
        actorId,
        reason,
      });
      if (!appended.ok) return appended;
      // The proposal and its pending marker are journaled; the delivery
      // remains in its current state. Consumption belongs to the
      // sensitive-approval lane, whose journal kind stays reserved here.
      return { ok: true, state: guarded.state };
    },

    async requestCancellation({ deliveryId }) {
      const guarded = await guard(deliveryId, { allowPendingTakeover: true });
      if (!("store" in guarded)) return guarded;
      if (guarded.state === "cancellation_requested") {
        return refuse(
          "cancellation_already_requested",
          "Cancellation is already requested; finalize it through quarantine or trusted termination.",
          "Call finalizeCancellation once the prior workspace is quarantined.",
        );
      }
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", {
        from: guarded.state,
        to: "cancellation_requested",
      });
      if (!transitioned.ok) return transitioned;

      // Fence revocation, immediately: the model-external interceptor is
      // deny-until-attested, so voiding the attestation in the binding state
      // re-denies every subsequent tool invocation — including a late
      // subagent's — without any callback plumbing. Native host cancellation
      // is then requested through the host's own primitive where one is
      // qualified; on this fixture host the revocation IS the request
      // (fence-revocation-only), and no claim of termination is made.
      const statePath = path.join(await deliveryDir(deliveryId), "binding", "state.json");
      const bindingState = await readJson<Record<string, unknown>>(statePath);
      if (bindingState !== undefined) {
        await writeOwned(statePath, `${JSON.stringify({ ...bindingState, attestation: null })}\n`);
      }
      if (guarded.lastFence > 0) {
        await appendEntry(guarded.store, deliveryId, "activity.observed", {
          activity: "cancellation_pending",
          fence: guarded.lastFence,
        });
      }
      return { ok: true, state: "cancellation_requested" };
    },

    async finalizeCancellation({ deliveryId }) {
      const guarded = await guard(deliveryId, { allowPendingTakeover: true });
      if (!("store" in guarded)) return guarded;
      if (guarded.state !== "cancellation_requested") {
        return refuse(
          "cancellation_not_requested",
          `finalizeCancellation completes a requested cancellation; the delivery is in ${guarded.state}.`,
          "Request cancellation first.",
        );
      }
      // Terminal cancellation through PERMANENT QUARANTINE of the prior
      // workspace and preservation of the last trusted candidate. Trusted
      // termination provenance is the other path, and its journal kind stays
      // reserved until the qualified host integration defines it — so this
      // record never claims that the prior task or its descendants stopped.
      const boundWorkspace = lastOf(guarded.views, "workspace.bound");
      const disposed = await appendEntry(guarded.store, deliveryId, "workspace.disposition.recorded", {
        workspaceId: (boundWorkspace?.payload["workspaceId"] as string | undefined) ?? "ws-unbound",
        disposition: "quarantined",
      });
      if (!disposed.ok) return disposed;
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", {
        from: "cancellation_requested",
        to: "cancelled",
      });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "cancelled" };
    },

    async exportDelivery({ deliveryId }) {
      const context = await retentionContext();
      if (!("namespaceDir" in context)) return context;
      const outcome = await runDeliveryExport(context, deliveryId);
      if (!outcome.ok) return refuse(outcome.code, outcome.summary, outcome.remediation);
      return { ok: true, exportPath: outcome.exportPath, artifactDigest: outcome.artifactDigest };
    },

    async deleteDelivery({ deliveryId }) {
      const context = await retentionContext();
      if (!("namespaceDir" in context)) return context;
      const outcome = await runDeliveryDeletion(context, deliveryId);
      if (!outcome.ok) return refuse(outcome.code, outcome.summary, outcome.remediation);
      return { ok: true, preservedAuditRecords: outcome.preservedAuditRecords };
    },

    async presentTakeover({ deliveryId, expiry }) {
      const guarded = await guard(deliveryId);
      if (!("store" in guarded)) return guarded;
      const trust = await readTrust();
      if (trust === undefined) {
        return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
      }
      const current = currentCandidateOf(guarded.views);
      const bound = lastOf(guarded.views, "workspace.bound");
      const targetBaseCommit =
        current !== undefined ? current.branchRefValue : (bound?.payload["baseTipSha"] as string | undefined);
      if (targetBaseCommit === undefined) {
        return refuse("no_trusted_commit", "No trusted commit exists to reconstruct from.", "Bind a workspace first.");
      }
      const nonce = `nonce-${hex(8)}`;
      // Branch names are repository-global; the delivery identity keeps two
      // deliveries' takeover branches from colliding in one repository.
      const takeoverBranchRef = `takeover-${deliveryId}-${guarded.lastFence + 1}`;
      // A pre-existing branch of that name is a collision: a takeover
      // reconstructs onto a DISTINCT branch and never adopts an existing ref,
      // however plausible its tip. Checkpointed and failed closed.
      const collision = await git(input.repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${takeoverBranchRef}`);
      if (collision.code === 0) {
        await appendEntry(guarded.store, deliveryId, "blocker.recorded", {
          code: "workspace.branch-collision",
          summary: `branch ${takeoverBranchRef} already exists; a takeover reconstructs onto a fresh branch and never adopts an existing ref`,
        });
        return refuse(
          "branch_collision",
          `The takeover branch ${takeoverBranchRef} already exists in this repository.`,
          "Remove or rename the colliding branch through the host's native git tooling, then present the takeover again.",
        );
      }
      const confirmation = {
        spec: "operator-confirmation/1",
        confirmationClass: "takeover-authorization",
        origin: "managed-delivery.facade",
        action: "authorize-takeover",
        expiry,
        nonce,
        productTrustRevocationEpoch: trust.revocationEpoch,
        repositoryAuthorityRevocationEpoch: guarded.meta.policy.repositoryAuthorityRevocationEpoch,
        intakeDraftId: "absent-by-state",
        deliveryId,
        normalizedContractDigest: "absent-by-state",
        supersededInvocationFence: guarded.lastFence,
        expectedJournalRevision: guarded.expectedRevision,
        targetBaseCommit,
        boundInvocationFence: "absent-by-state",
        boundCandidateTreeSha: "absent-by-state",
      };
      const rendered = await renderChallenge(nonce, confirmation, deliveryId, expiry);
      if (!rendered.ok) return rendered;
      await writeOwned(
        path.join(await deliveryDir(deliveryId), "takeover-pending.json"),
        `${JSON.stringify({ nonce, targetBaseCommit, takeoverBranchRef, supersededFence: guarded.lastFence })}\n`,
      );
      return {
        ok: true,
        nonce,
        channelPath: confirmationPath(nonce),
        supersededFence: guarded.lastFence,
        expectedJournalRevision: guarded.expectedRevision,
        targetBaseCommit,
        takeoverBranchRef,
      };
    },

    async confirmTakeover({ deliveryId, echo }) {
      const guarded = await guard(deliveryId);
      if (!("store" in guarded)) return guarded;
      const dir = await deliveryDir(deliveryId);
      const pending = await readJson<PendingTakeover & { nonce: string }>(path.join(dir, "takeover-pending.json"));
      if (pending === undefined) {
        return refuse("takeover_unknown", "No presented takeover authorization is pending.", "Present the takeover first.");
      }
      const consumed = await consumeChallenge(pending.nonce, echo);
      if (!("confirmation" in consumed)) return consumed;

      // Consumption rechecks through the canonical helper's takeover
      // substitution: the superseded fence, expected journal revision, and
      // target base commit are evaluated IN PLACE OF the current fence and
      // the prior worktree's projection and discovery-configuration digests,
      // while every unsubstituted frozen value is still evaluated. Any
      // mismatch rejects; observation-only appends never advanced the bound
      // revision, so they never void a pending authorization.
      const confirmation = consumed.confirmation;
      if (confirmation["deliveryId"] !== deliveryId) {
        return refuse(
          "takeover_stale",
          "The takeover authorization binds a different delivery; nothing was consumed into the journal.",
          "Present a fresh takeover against current durable state.",
        );
      }
      const boundWorkspace = lastOf(guarded.views, "workspace.bound");
      const currentTrusted = currentCandidateOf(guarded.views);
      const observedTarget =
        currentTrusted !== undefined
          ? currentTrusted.branchRefValue
          : ((boundWorkspace?.payload["baseTipSha"] as string | undefined) ?? "no-trusted-commit");
      const consumptionRecheck = evaluateCanonicalRecheck({
        consumption: {
          kind: "takeover",
          supersededFence: { kind: "compare", expected: Number(confirmation["supersededInvocationFence"]), observed: guarded.lastFence },
          expectedJournalRevision: { kind: "compare", expected: Number(confirmation["expectedJournalRevision"]), observed: guarded.expectedRevision },
          targetBaseCommit: { kind: "compare", expected: String(confirmation["targetBaseCommit"]), observed: observedTarget },
        },
        values: {
          ...guarded.recheckValues,
          "invocation-fence": "absent-by-state",
          "projection-digest": "absent-by-state",
          "discovery-configuration-digest": "absent-by-state",
        },
      });
      if (!consumptionRecheck.ok) {
        return refuse(
          "takeover_stale",
          `The takeover authorization no longer matches durable state (${consumptionRecheck.failures.map((failure) => failure.value).join(", ")}); nothing was consumed into the journal.`,
          "Present a fresh takeover against current durable state.",
        );
      }

      const recorded = await appendEntry(guarded.store, deliveryId, "operator.confirmation.recorded", { confirmation });
      if (!recorded.ok) return recorded;
      const bound = lastOf(guarded.views, "workspace.bound");
      const priorWorkspace = (bound?.payload["workspaceId"] as string | undefined) ?? "ws-unbound";
      await appendEntry(guarded.store, deliveryId, "workspace.disposition.recorded", {
        workspaceId: priorWorkspace,
        disposition: "quarantined",
      });
      await writeOwned(
        path.join(dir, "takeover.json"),
        `${JSON.stringify({
          targetBaseCommit: pending.targetBaseCommit,
          takeoverBranchRef: pending.takeoverBranchRef,
          supersededFence: pending.supersededFence,
        } satisfies PendingTakeover)}\n`,
      );
      await rm(path.join(dir, "takeover-pending.json"), { force: true });
      return { ok: true, targetBaseCommit: pending.targetBaseCommit, takeoverBranchRef: pending.takeoverBranchRef };
    },

    async explainBlocker({ deliveryId }) {
      const store = await journalStoreFor(deliveryId);
      const read = await store.read();
      if (!read.ok) return refuse("journal_unreadable", "The delivery journal is unreadable.", "Inspect the durable journal file.");
      const blocker = lastOf(viewsOf(read.entries), "blocker.recorded");
      if (blocker === undefined) return { ok: true, blocker: undefined };
      const code = blocker.payload["code"] as string;
      const remediation = code.startsWith("trust.")
        ? "Restore local product trust through the operator maintenance lane, then resume."
        : code.startsWith("projection.")
          ? "Quarantine the workspace and resume through an authorized takeover into a fresh worktree."
          : code.startsWith("outcome.")
            ? "Satisfy the named acceptance criterion on the exact candidate, then re-validate."
            : code.startsWith("review.")
              ? "Complete both mandatory review lenses on the exact candidate, then re-admit."
              : "Read the summary; the journal carries the full typed record.";
      return { ok: true, blocker: { code, summary: blocker.payload["summary"] as string, remediation } };
    },

    async recoverSecurityBlocked({ deliveryId, targetGenerationDigest, assertionSource, now }) {
      const dir = await deliveryDir(deliveryId);
      const meta = await readJson<DeliveryMeta>(path.join(dir, "delivery.json"));
      if (meta === undefined) {
        return refuse("unknown_delivery", `No registered delivery ${deliveryId}.`, "Register a delivery through the contract handoff first.");
      }
      const store = await journalStoreFor(deliveryId);
      const reduced = await store.state();
      const read = await store.read();
      if (!reduced.ok || !read.ok) {
        return refuse("journal_rejected", "The durable journal does not reduce.", "Inspect the durable journal file.");
      }
      if (reduced.state.state !== "security_blocked") {
        return refuse(
          "wrong_state",
          `Leaving security_blocked is a maintenance-lane operation; the delivery is in ${reduced.state.state}.`,
          "Read `status` for the next valid checkpoint.",
        );
      }
      const views = viewsOf(read.entries);
      const recorded = recordedBindingOf(views);
      const recordedPin = reduced.state.generationDigest;
      if (recorded === undefined || recordedPin === undefined) {
        return refuse("unregistered", "The delivery has no recorded registration binding or generation pin.", "Register the delivery first.");
      }
      const binding = await registrationBinding({
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
      });
      if (!binding.ok) {
        return refuse("installation_unresolved", "No install receipt resolves this installation.", "Install the composition first.");
      }
      const trust = await readTrust();
      if (trust === undefined) {
        return refuse("trust_state_unreadable", "The installation trust store is absent or corrupt.", "Absent trust state fails closed; reinstall or repair.");
      }

      const target = targetGenerationDigest ?? recordedPin;
      const rebinding = binding.registeringInstallationId !== recorded.registeringInstallationId;
      const generationChange = target !== recordedPin;
      const mode = rebinding ? "rebinding-migration" : generationChange ? "generation-change-migration" : "re-preparation";

      if (mode === "re-preparation") {
        // Leaving security_blocked always requires CURRENT local trust
        // state: the recorded pin must be execution-eligible again (for
        // example after an explicit un-revocation).
        const load = await loadPinnedGeneration({
          installationPath: input.installation.installationPath,
          generationDigest: recordedPin,
        });
        if (!load.ok) {
          return refuse(
            "trust_ineligible",
            "The recorded generation pin is not execution-eligible under current local trust state.",
            "Restore trust through the operator maintenance lane, or migrate to an accepted generation.",
          );
        }
      } else {
        // The migration lane: one fresh interactive evaluation from the
        // installation's configured assertion source, consumed against the
        // exact bindings — and never a new invocation fence.
        const config = await loadAssertionProviderConfig(input.installation.installationPath);
        if (!config.ok) {
          return refuse(
            "assertion_source_unavailable",
            "The assertion provider configuration is absent or corrupt; sensitive operations fail closed.",
            "An operator-performed installer repair re-establishes the assertion source.",
          );
        }
        const source = assertionSource ?? assertionSourceForKind(config.config.sourceKind);
        const availability = await source.probe();
        if (!availability.available) {
          return refuse(
            "assertion_source_unavailable",
            `The configured assertion source is unavailable: ${availability.detail}`,
            "An operator-performed installer repair re-establishes the assertion source.",
          );
        }
        const evaluation = await source.evaluate({
          action: SECURITY_BLOCKED_MIGRATION_ACTION,
          disclosure: `Approve security-blocked migration of delivery ${deliveryId} at journal revision ${reduced.state.expectedRevision} to generation ${target} on installation ${binding.registeringInstallationId}`,
        });
        if (!evaluation.ok) {
          return refuse("assertion_refused", `The interactive evaluation was not granted: ${evaluation.reason}`, "The operator declined; the delivery remains security_blocked.");
        }
        const assertion: Record<string, unknown> = {
          spec: "sensitive-approval-assertion/1",
          assertionClass: "security-blocked-migration",
          origin: "managed-delivery.facade",
          action: SECURITY_BLOCKED_MIGRATION_ACTION,
          expiry: evaluation.expiry,
          nonce: evaluation.nonce,
          assertionSource: evaluation.sourceKind,
          productTrustRevocationEpoch: trust.revocationEpoch,
          repositoryAuthorityRevocationEpoch: "absent-by-state",
          deliveryId,
          candidateTreeSha: "absent-by-state",
          policyDigest: "absent-by-state",
          invocationFence: "absent-by-state",
          targetInstallationId: binding.registeringInstallationId,
          targetGenerationDigest: target,
          targetHighWaterMark: "absent-by-state",
          expectedJournalRevision: reduced.state.expectedRevision,
        };
        const consumption = evaluateMigrationConsumption(assertion, {
          deliveryId,
          expectedJournalRevision: reduced.state.expectedRevision,
          currentInstallationId: binding.registeringInstallationId,
          currentProfile: binding.activeCompositionProfile,
          recordedInstallationId: recorded.registeringInstallationId,
          recordedProfile: recorded.activeCompositionProfile,
          trustState: trust,
          consumedNonces: consumedAssertionNoncesOf(views),
          now,
        });
        if (!consumption.ok) {
          return refuseWith(
            consumption.blockers.map((blocker) =>
              createBlocker({
                code: blocker.code,
                source: SOURCE,
                summary: blocker.message,
                remediations: [
                  {
                    id: `${blocker.code.replaceAll("_", "-")}-remediation`,
                    kind: "manual_action",
                    summary: "The migration assertion rejects on any binding mismatch; the delivery remains security_blocked.",
                  },
                ],
              }),
            ),
          );
        }
        // The target must also be a retained, closure-verified root on this
        // installation.
        const load = await loadPinnedGeneration({
          installationPath: input.installation.installationPath,
          generationDigest: target,
        });
        if (!load.ok) {
          return refuse(
            "trust_ineligible",
            "The migration's target generation is not a retained, execution-eligible root on this installation.",
            "Install or update to the target generation first.",
          );
        }

        const consumed = await appendEntry(store, deliveryId, "approval.assertion.consumed", {
          assertion,
          newRegisteringInstallationId: rebinding ? binding.registeringInstallationId : "absent-by-state",
        });
        if (!consumed.ok) return consumed;
        if (target !== recordedPin) {
          const pinned = await appendEntry(store, deliveryId, "generation.pinned", {
            generationDigest: target,
            releaseId: PINNED_AGENT_SKILLS.releaseId,
            profile: binding.activeCompositionProfile,
          });
          if (!pinned.ok) return pinned;
        }
      }

      // Full re-preparation with invalidation of revoked-era candidate-bound
      // evidence: prior review attempts are quarantined out of the reduction
      // set (retained for audit under a dead name), and the workspace binding
      // is dropped so the delivery re-prepares from scratch.
      const attemptsDir = path.join(dir, "attempts");
      try {
        await readdir(attemptsDir);
        const { rename } = await import("node:fs/promises");
        await rename(attemptsDir, path.join(dir, `attempts-invalidated-r${reduced.state.expectedRevision}`));
      } catch {
        /* no attempts to invalidate */
      }
      await rm(path.join(dir, "workspace.json"), { force: true });
      await rm(path.join(dir, "takeover.json"), { force: true });

      const transitioned = await appendEntry(store, deliveryId, "transition.committed", {
        from: "security_blocked",
        to: "preparing",
      });
      if (!transitioned.ok) return transitioned;
      return { ok: true, mode, state: "preparing" };
    },
  };
}

// ── Small shared helpers ───────────────────────────────────────────────────

type CaptureOutcome =
  | { readonly ok: true; readonly candidate: CapturedCandidate; readonly captureCandidate: CaptureCandidate }
  | { readonly ok: false; readonly failure: FacadeFailure };

async function captureFor(
  rootDir: string,
  config: HarnessConfig,
  run: CandidateCommandRunner,
  runGit: (cwd: string, args: readonly string[]) => Promise<string>,
): Promise<CaptureOutcome> {
  const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace, runGit });
  const captureCandidate = createCandidateCapture({
    rootDir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
    run,
  });
  const capture = await captureCandidate();
  if (!capture.ok) {
    return { ok: false, failure: { ok: false, blockers: capture.blockers } };
  }
  return { ok: true, candidate: capture.candidate, captureCandidate };
}

/** Seconds since epoch for the spine's fixed-width UTC instant (shape-checked upstream). */
function instantSeconds(instant: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(instant);
  if (match === null) return Number.NaN;
  return (
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ) / 1000
  );
}
