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
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateConfirmationEcho,
  evaluateHostAdmission,
  type CheckpointAdmissionExpectation,
  type ConfirmationEchoAttempt,
  type RenderedConfirmationChallenge,
} from "../binding/host-admission.ts";
import { createBlocker, type Blocker } from "../blockers.ts";
import { createIntakeJournalStore, createJournalStore, type JournalStore } from "../checkpoint/journal-store.ts";
import { digestCanonical, sha256Hex } from "../digest.ts";
import { createArtifactsPort } from "../artifacts.ts";
import { runAdmission } from "../admission.ts";
import { buildDeliveryRecord, deliveryRecordBytes, deliveryRecordPathFor, parseDeliveryRecord, verifyDeliveryRecord } from "../delivery-record.ts";
import { publishPreparationReceipt } from "../preparation.ts";
import { discoverRecords, resolveRecordStorage } from "../records.ts";
import { submitManifest } from "../recorder.ts";
import { createCandidateCapture, evaluateCandidateActivation } from "../candidate.ts";
import { withDeliverableIdentity } from "../identity.ts";
import { classifyExecutionContext, type EnvSnapshot } from "../context.ts";
import type { HarnessConfig } from "../config.ts";
import type { CaptureCandidate, CapturedCandidate } from "../candidate.types.ts";
import {
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
import { loadPinnedGeneration, registrationBinding, resolveActiveGeneration, trustStorePathFor } from "../substrate/installer.ts";
import { parseTrustState } from "../substrate/trust-store.ts";
import { loadBundledWorkflowGraph, workflowStageBindingFor } from "../workflow/graph.ts";

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

function sensorResultsOf(views: readonly JournalEntryView[]): RecordedSensorResult[] {
  return views
    .filter((view) => view.kind === "operation.result.recorded")
    .map((view) => view.payload["result"] as unknown as RecordedSensorResult & { spec: string });
}

// ── The facade ─────────────────────────────────────────────────────────────

export interface ManagedDeliveryFacade {
  readonly namespaceDir: () => Promise<string>;

  presentContract(input: {
    readonly contract: AcceptedContract;
    readonly expiry: string;
  }): Promise<
    | { readonly ok: true; readonly intakeId: string; readonly nonce: string; readonly normalizedContractDigest: string; readonly channelPath: string }
    | FacadeFailure
  >;

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
  }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  checkpointCandidate(input: {
    readonly deliveryId: string;
    readonly resultBytes: string;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState; readonly treeSha: string } | FacadeFailure>;

  runSensor(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly outcome: "passed" | "failed"; readonly state: DeliveryState } | FacadeFailure
  >;

  submitReviewAttempt(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly lensId: string;
    readonly verdict: "approved" | "findings";
    readonly contextBytes: string;
    readonly artifactBytes: string;
  }): Promise<{ readonly ok: true } | FacadeFailure>;

  reduceReview(input: { readonly deliveryId: string }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  admit(input: {
    readonly deliveryId: string;
    readonly recordedAtInstant: string;
    readonly env: EnvSnapshot;
  }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  prepareTrackedRecord(input: {
    readonly deliveryId: string;
    readonly env: EnvSnapshot;
  }): Promise<{ readonly ok: true; readonly relativePath: string } | FacadeFailure>;

  confirmTrackedRecord(input: { readonly deliveryId: string }): Promise<{ readonly ok: true; readonly state: DeliveryState } | FacadeFailure>;

  completeFinishLine(input: { readonly deliveryId: string }): Promise<
    { readonly ok: true; readonly state: DeliveryState; readonly resultDigest: string } | FacadeFailure
  >;

  sessionEnded(input: { readonly deliveryId: string }): Promise<{ readonly ok: true } | FacadeFailure>;

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
    readonly expectedRevision: number;
    readonly lastFence: number;
    readonly views: readonly JournalEntryView[];
    readonly workspace: WorkspaceMeta | undefined;
    readonly generationRoot: string;
  }

  /** The canonical rechecks every mutation-capable operation runs. */
  const guard = async (
    deliveryId: string,
    options: { readonly requireState?: readonly DeliveryState[]; readonly verifyWorkspace?: boolean } = {},
  ): Promise<GuardedContext | FacadeFailure> => {
    const dir = await deliveryDir(deliveryId);
    const meta = await readJson<DeliveryMeta>(path.join(dir, "delivery.json"));
    if (meta === undefined) {
      return refuse("unknown_delivery", `No registered delivery ${deliveryId}.`, "Register a delivery through the contract handoff first.");
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

    // Product trust at the pinned generation, resolved only from the
    // installation store — planted repository-local trust files are ignored
    // by construction.
    const pinned = reduced.state.generationDigest;
    if (pinned !== undefined) {
      const generation = await loadPinnedGeneration({
        installationPath: input.installation.installationPath,
        generationDigest: pinned,
      });
      if (!generation.ok) {
        if (!(reduced.state.state === "security_blocked")) {
          await recordBlockerAndTransition(
            store,
            deliveryId,
            reduced.state.state,
            "trust.generation-ineligible",
            generation.blockers.map((blocker) => blocker.message).join("; ").slice(0, 1900),
            "security_blocked",
          );
        }
        return refuse(
          "trust_ineligible",
          "The pinned generation is no longer execution-eligible under current local trust state.",
          "Restore local trust state through the operator maintenance lane.",
        );
      }

      // Registering installation and active profile are canonical recheck
      // values: a different installation's trust state can never serve this
      // delivery.
      const registered = lastOf(views, "delivery.registered");
      const binding = await registrationBinding({
        installationPath: input.installation.installationPath,
        receiptDir: input.installation.receiptDir,
      });
      if (
        !binding.ok ||
        registered === undefined ||
        binding.registeringInstallationId !== registered.payload["registeringInstallationId"] ||
        binding.activeCompositionProfile !== registered.payload["activeCompositionProfile"]
      ) {
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

      if (options.verifyWorkspace === true && workspace !== undefined) {
        const projection = await verifyProjection({
          worktreeDir: workspace.worktreeDir,
          bindingDir: path.join(dir, "binding"),
        });
        if (!projection.ok) {
          if (reduced.state.state !== "blocked" && reduced.state.state !== "security_blocked") {
            await recordBlockerAndTransition(
              store,
              deliveryId,
              reduced.state.state,
              "projection.tampered",
              projection.blockers.map((blocker) => blocker.message).join("; ").slice(0, 1900),
              "blocked",
            );
          }
          return refuse(
            "projection_tampered",
            "The receipted projection subtree no longer matches its materialization digest.",
            "Quarantine the workspace and resume through an authorized takeover.",
          );
        }
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
            expectedRevision: reduced.state.expectedRevision,
            lastFence: reduced.state.lastFence,
            views,
            workspace,
            generationRoot: generation.root,
          };
    }
    return refuse("unregistered", "The delivery has no pinned generation.", "Register the delivery first.");
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

  return {
    namespaceDir,

    async presentContract({ contract, expiry }) {
      const contractVerdict = validateAcceptedContract(contract);
      if (!contractVerdict.ok) {
        return refuse(
          "contract_rejected",
          `The scoped contract is outside its frozen grammar: ${contractVerdict.rejections.map((rejection) => rejection.message).join("; ")}`,
          "Fix the contract; material ambiguity remains in intake.",
        );
      }

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

      const intakeId = `intake-${hex(6)}`;
      const nonce = `nonce-${hex(8)}`;
      const normalizedContractDigest = digestCanonical(contract);
      const confirmation = {
        spec: "operator-confirmation/1",
        confirmationClass: "contract-confirmation",
        origin: "managed-delivery.facade",
        action: "confirm-contract",
        expiry,
        nonce,
        productTrustRevocationEpoch: trust.revocationEpoch,
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

      const ns = await namespaceDir();
      const intakeStore = createIntakeJournalStore(path.join(ns, "intake", `${intakeId}.jsonl`));
      const appendIntake = async (kind: string, payload: Record<string, unknown>, index: number, revision: number) =>
        intakeStore.append({
          spec: "journal-entry/1",
          journal: "intake",
          subjectId: intakeId,
          expectedRevision: revision,
          idempotencyKey: `e${index}-${kind}`,
          kind,
          payload,
        });
      // The direct already-scoped handoff still walks the frozen intake chain
      // to the confirmation handoff.
      await appendIntake("intake.state.changed", { from: "draft_scope", to: "awaiting_clarification" }, 0, 0);
      await appendIntake("intake.state.changed", { from: "awaiting_clarification", to: "awaiting_confirmation" }, 1, 1);

      const rendered = await renderChallenge(nonce, confirmation, intakeId, expiry);
      if (!rendered.ok) return rendered;

      await writeOwned(
        path.join(ns, "intake", `${intakeId}.meta.json`),
        `${JSON.stringify({ contract, policy, generationDigest: active.generationDigest, nonce })}\n`,
      );
      return { ok: true, intakeId, nonce, normalizedContractDigest, channelPath: rendered.channelPath };
    },

    async confirmContract({ intakeId, echo }) {
      const ns = await namespaceDir();
      const meta = await readJson<{ contract: AcceptedContract; policy: PolicySnapshot; generationDigest: string; nonce: string }>(
        path.join(ns, "intake", `${intakeId}.meta.json`),
      );
      if (meta === undefined) {
        return refuse("intake_unknown", `No presented intake draft ${intakeId}.`, "Present the contract first.");
      }
      const consumed = await consumeChallenge(meta.nonce, echo);
      if (!("confirmation" in consumed)) return consumed;

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

      const intakeStore = createIntakeJournalStore(path.join(ns, "intake", `${intakeId}.jsonl`));
      const intakeAppend = async (kind: string, payload: Record<string, unknown>, index: number, revision: number) =>
        intakeStore.append({
          spec: "journal-entry/1",
          journal: "intake",
          subjectId: intakeId,
          expectedRevision: revision,
          idempotencyKey: `e${index}-${kind}`,
          kind,
          payload,
        });
      await intakeAppend("operator.confirmation.recorded", { confirmation: consumed.confirmation }, 2, 2);
      await intakeAppend("intake.state.changed", { from: "awaiting_confirmation", to: "validating_acceptance" }, 3, 3);
      await intakeAppend("intake.state.changed", { from: "validating_acceptance", to: "accepted_contract" }, 4, 4);

      const deliveryId = `dlv-${hex(6)}`;
      const dir = await deliveryDir(deliveryId);
      const store = await journalStoreFor(deliveryId);

      const registered = await appendEntry(store, deliveryId, "delivery.registered", {
        contractDigest: digestCanonical(meta.contract),
        intakeId,
        confirmationNonce: meta.nonce,
        activeCompositionProfile: binding.activeCompositionProfile,
        registeringInstallationId: binding.registeringInstallationId,
      });
      if (!registered.ok) return registered;
      await appendEntry(store, deliveryId, "generation.pinned", {
        generationDigest: meta.generationDigest,
        releaseId: PINNED_AGENT_SKILLS.releaseId,
        profile: binding.activeCompositionProfile,
      });
      await appendEntry(store, deliveryId, "policy.snapshot.bound", {
        policyDigest: meta.policy.policyDigest,
        repositoryAuthorityEpoch: meta.policy.repositoryAuthorityRevocationEpoch,
      });
      await appendEntry(store, deliveryId, "trust.epoch.observed", {
        productTrustEpoch: trust.revocationEpoch,
        repositoryAuthorityEpoch: meta.policy.repositoryAuthorityRevocationEpoch,
      });

      // The trusted-base sensor: copied from the base commit NOW, executed
      // only from this copy — the candidate's tracked rewrite never governs.
      const baseRef = meta.contract.repository.baseRef;
      const shown = await exec.run({
        command: "git",
        args: ["show", `${baseRef}:${DISPOSABLE_SENSOR_CAPABILITY.trustedBasePath}`],
        cwd: input.repoDir,
      });
      if (shown.code !== 0) {
        return refuse(
          "trusted_sensor_missing",
          `The trusted pre-run base ${baseRef} carries no ${DISPOSABLE_SENSOR_CAPABILITY.trustedBasePath}.`,
          "The repository's sensor must exist at the base; candidate-supplied sensors never govern.",
        );
      }
      await writeOwned(path.join(dir, "trusted-sensor.mjs"), shown.stdout);
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
    },

    async bindWorkspace({ deliveryId, worktreeDir, hostTaskId, observedAt, attestationExpiry, observationLifetimeSeconds }) {
      const guarded = await guard(deliveryId);
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

    async submitStageResult({ deliveryId, stageId, resultBytes }) {
      const expected: readonly DeliveryState[] = stageId === "plan" ? ["planning"] : ["compounding"];
      const guarded = await guard(deliveryId, { requireState: expected, verifyWorkspace: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const binding = workflowStageBindingFor(guarded.state);
      if (binding === undefined || binding.stageId !== stageId) {
        return refuse("wrong_stage", `Stage ${stageId} is not the bundled graph's checkpoint for ${guarded.state}.`, "Read `next-checkpoint`.");
      }

      if (stageId === "compound") {
        // No repository mutation may ride the compounding checkpoint.
        const current = currentCandidateOf(guarded.views);
        const treeSha = (await git(workspace.worktreeDir, "rev-parse", "HEAD^{tree}")).out;
        if (current !== undefined && treeSha !== current.treeSha) {
          const recorded = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "compounding", to: "validating" });
          if (!recorded.ok) return recorded;
          return { ok: true, state: "validating" };
        }
      }

      const stage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId,
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: sha256Hex(resultBytes),
      });
      if (!stage.ok) return stage;
      const to: DeliveryState = stageId === "plan" ? "implementing" : "admitting";
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: guarded.state, to });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: to };
    },

    async checkpointCandidate({ deliveryId, resultBytes }) {
      const guarded = await guard(deliveryId, { requireState: ["implementing", "remediating"], verifyWorkspace: true });
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

      const recaptured = await appendEntry(guarded.store, deliveryId, "candidate.recaptured", { treeSha, branchRefValue });
      if (!recaptured.ok) return recaptured;
      if (guarded.state === "implementing") {
        const stage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
          stageId: "implement",
          workflowGraphSha256: workspace.workflowGraphSha256,
          resultDigest: sha256Hex(resultBytes),
        });
        if (!stage.ok) return stage;
      }
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", {
        from: guarded.state,
        to: "validating",
      });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: "validating", treeSha };
    },

    async runSensor({ deliveryId }) {
      const guarded = await guard(deliveryId, { requireState: ["validating"], verifyWorkspace: true });
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

    async submitReviewAttempt({ deliveryId, attemptId, lensId, verdict, contextBytes, artifactBytes }) {
      const guarded = await guard(deliveryId, { requireState: ["reviewing"], verifyWorkspace: true });
      if (!("store" in guarded)) return guarded;
      if (!DISPOSABLE_REVIEW_LENSES.some((lens) => lens.lensId === lensId)) {
        return refuse("unknown_lens", `Lens ${lensId} is not selected by the compiled policy.`, "Use a policy-selected lens.");
      }
      const current = currentCandidateOf(guarded.views);
      if (current === undefined) return refuse("no_candidate", "No candidate is checkpointed.", "Checkpoint a candidate first.");

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

    async reduceReview({ deliveryId }) {
      const guarded = await guard(deliveryId, { requireState: ["reviewing"], verifyWorkspace: true });
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

      const stage = await appendEntry(guarded.store, deliveryId, "stage.result.recorded", {
        stageId: "review.acquire",
        workflowGraphSha256: workspace.workflowGraphSha256,
        resultDigest: digestCanonical(attempts),
      });
      if (!stage.ok) return stage;

      const anyFindings = qualifyReviewAttempts(attempts, current.treeSha).qualified.some(
        (attempt) => attempt.verdict === "findings",
      );
      const to: DeliveryState = anyFindings ? "remediating" : "compounding";
      const transitioned = await appendEntry(guarded.store, deliveryId, "transition.committed", { from: "reviewing", to });
      if (!transitioned.ok) return transitioned;
      return { ok: true, state: to };
    },

    async admit({ deliveryId, recordedAtInstant, env }) {
      const guarded = await guard(deliveryId, { requireState: ["admitting"], verifyWorkspace: true });
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
      const capture = await captureFor(rootDir, input.config);
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
      const storage = await resolveRecordStorage(rootDir, { storageNamespace: input.config.storageNamespace });
      await publishPreparationReceipt(rootDir, { config: input.config, candidate: captured }, { storageNamespace: input.config.storageNamespace });

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
        { captureCandidate: capture.captureCandidate, artifacts, storageNamespace: input.config.storageNamespace },
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
          projectActivation: (candidate: CapturedCandidate) => evaluateCandidateActivation({ rootDir, candidate, config: input.config }),
          storageNamespace: input.config.storageNamespace,
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

    async prepareTrackedRecord({ deliveryId, env }) {
      const guarded = await guard(deliveryId, { requireState: ["recording"], verifyWorkspace: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const rootDir = workspace.worktreeDir;
      const capture = await captureFor(rootDir, input.config);
      if (!capture.ok) return capture.failure;

      const admission = await runAdmission(
        { rootDir, config: input.config, context: classifyExecutionContext({ config: input.config, env, stdinIsTTY: false, stdoutIsTTY: false }) },
        {
          captureCandidate: capture.captureCandidate,
          projectActivation: (candidate: CapturedCandidate) => evaluateCandidateActivation({ rootDir, candidate, config: input.config }),
          storageNamespace: input.config.storageNamespace,
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

    async confirmTrackedRecord({ deliveryId }) {
      const guarded = await guard(deliveryId, { requireState: ["recording"], verifyWorkspace: true });
      if (!("store" in guarded)) return guarded;
      const workspace = guarded.workspace;
      if (workspace === undefined) return refuse("workspace_unbound", "No workspace is bound.", "Bind the host-supplied worktree first.");
      const rootDir = workspace.worktreeDir;

      const porcelain = await git(rootDir, "status", "--porcelain");
      if (porcelain.code !== 0 || porcelain.out !== "") {
        return refuse("record_uncommitted", "The tracked record is not checkpoint-committed.", "Commit the record through the host's native git tooling.");
      }
      const capture = await captureFor(rootDir, input.config);
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

    async completeFinishLine({ deliveryId }) {
      const guarded = await guard(deliveryId, { requireState: ["ready"], verifyWorkspace: true });
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

    async sessionEnded({ deliveryId }) {
      const guarded = await guard(deliveryId);
      if (!("store" in guarded)) return guarded;
      const appended = await appendEntry(guarded.store, deliveryId, "activity.observed", {
        activity: "paused",
        fence: guarded.lastFence,
      });
      if (!appended.ok) return appended;
      return { ok: true };
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
      const takeoverBranchRef = `takeover-${guarded.lastFence + 1}`;
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

      // Consumption rechecks the bound identities against the CURRENT journal
      // — any mismatch rejects.
      const confirmation = consumed.confirmation;
      if (
        confirmation["supersededInvocationFence"] !== guarded.lastFence ||
        confirmation["expectedJournalRevision"] !== guarded.expectedRevision ||
        confirmation["deliveryId"] !== deliveryId
      ) {
        return refuse(
          "takeover_stale",
          "The takeover authorization no longer matches the journal's fence or revision; nothing was consumed into the journal.",
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
  };
}

// ── Small shared helpers ───────────────────────────────────────────────────

type CaptureOutcome =
  | { readonly ok: true; readonly candidate: CapturedCandidate; readonly captureCandidate: CaptureCandidate }
  | { readonly ok: false; readonly failure: FacadeFailure };

async function captureFor(rootDir: string, config: HarnessConfig): Promise<CaptureOutcome> {
  const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace });
  const captureCandidate = createCandidateCapture({
    rootDir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
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
