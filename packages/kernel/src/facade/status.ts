/**
 * The one typed status model, and the projection that composes it.
 *
 * WHY ONE MODEL. Every operator-facing surface — the CLI, the MCP tool, and
 * any later control-plane or UI projection — asks the same question of a
 * managed delivery, and each one answering it from raw journal facts is how
 * two surfaces come to disagree about whether a delivery may be resumed. This
 * module is the single answer: the facade gathers the raw facts, this composes
 * them, and every surface renders the result without re-deciding anything.
 *
 * THE PROJECTION IS PURE. It performs no I/O and consults no clock. Aging an
 * observation, reading the trust store, and probing the assertion source are
 * the facade's work; what arrives here is already decided, so the derivations
 * that matter — authorized next actions, mutation verification, retry safety,
 * and the migration path — are directly testable without a repository.
 *
 * IT IS ALSO AN AUDIT PROJECTION. `authorizedNextActions` names operations the
 * inventory declares, and `operationContracts` carries their capability, fence,
 * and journal-revision rules alongside, so a reader can see not just what may
 * be done next but what it costs. Naming an action here still grants nothing:
 * the operation itself rechecks every binding when it is called.
 */
import type { LaneAvailability } from "../binding/host-admission.ts";
import type { WaiverProposal } from "../evidence/waiver.ts";
import type { DeliveryState, HostActivityState, IntakeState } from "../spine/vocabulary.ts";
import { FACADE_OPERATIONS, type FacadeOperation } from "./operations.ts";

/** The workspace dispositions a delivery journal can record. */
export type WorkspaceDisposition = "quarantined" | "takeover" | "reconciled" | "prior_host_termination_unverified";

/**
 * The next valid checkpoint, as the reducer's state determines it. Defined
 * here because the status model carries it and every surface renders it.
 */
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

export interface RecordedRegistrationBinding {
  readonly registeringInstallationId: string;
  readonly activeCompositionProfile: string;
}

/**
 * How the delivery's recorded registration binding compares to the
 * installation observed now. `identity` and `profile` are deliberately
 * distinct: only the first has a migration path.
 */
export type RegistrationMismatch = "none" | "identity" | "profile" | "unresolved";

export interface RegistrationBindingView {
  readonly recorded: RecordedRegistrationBinding | undefined;
  readonly current: RecordedRegistrationBinding | undefined;
  readonly mismatch: RegistrationMismatch;
}

export interface ProductTrustView {
  /** The declared product-trust level, read verbatim from the substrate. */
  readonly label: string;
  readonly pinnedGenerationDigest: string;
  readonly revocationEpoch: number;
  /** Whether the delivery's pinned generation may execute right now. */
  readonly generation: "eligible" | "revoked" | "not_pinned" | "unreadable";
}

export interface AssertionSourceView {
  readonly availability: "available" | "unavailable" | "unconfigured";
  readonly detail: string;
  readonly lanes: LaneAvailability;
}

export interface ManagedStatusInput {
  readonly deliveryId: string;
  readonly intake: { readonly state: IntakeState; readonly expectedRevision: number } | undefined;
  readonly delivery: { readonly state: DeliveryState; readonly expectedRevision: number; readonly fence: number };
  readonly hostActivity: HostActivityState;
  readonly completedObligations: readonly string[];
  readonly productTrust: ProductTrustView;
  readonly assertionSource: AssertionSourceView;
  readonly quarantinedWorkspaces: readonly string[];
  readonly candidate: { readonly treeSha: string; readonly branchRefValue: string } | undefined;
  readonly pendingDecision: WaiverProposal | undefined;
  readonly registrationBinding: RegistrationBindingView;
  readonly lastWorkspaceDisposition: WorkspaceDisposition | undefined;
  /** A trusted lifecycle event at the current fence that verified descendant teardown. */
  readonly terminationVerifiedAtCurrentFence: boolean;
  readonly workspaceBound: boolean;
  readonly nextCheckpoint: ManagedCheckpoint;
  readonly resume: "none" | "takeover-required" | "same-workspace";
  readonly blockers: readonly { readonly code: string; readonly summary: string }[];
  readonly policyRequiredInterruptions: number;
  readonly operatorInterventions: number;
}

/** Whether the prior workspace's mutation has been accounted for. */
export type MutationVerification = "not-applicable" | "verified" | "unverified";

/**
 * Whether re-driving the delivery is safe. `never-repeat-external-action` is
 * the one value that is not about doubt: an irreversible action succeeded and
 * its verification did not, so the action must never be repeated.
 */
export type RetrySafety = "safe" | "unverified-prior-mutation" | "never-repeat-external-action";

/** The exit available from `security_blocked`, if any. */
export type MigrationPath = "none" | "re-preparation" | "generation-change-migration" | "rebinding-migration";

export interface ManagedDeliveryStatus {
  readonly deliveryId: string;
  readonly intake: { readonly state: IntakeState; readonly expectedRevision: number } | undefined;
  readonly delivery: { readonly state: DeliveryState; readonly expectedRevision: number; readonly fence: number };
  readonly hostActivity: HostActivityState;
  readonly completedObligations: readonly string[];
  readonly productTrust: ProductTrustView;
  readonly assertionSource: AssertionSourceView;
  readonly quarantinedWorkspaces: readonly string[];
  readonly candidate: { readonly treeSha: string; readonly branchRefValue: string } | undefined;
  readonly pendingDecision: WaiverProposal | undefined;
  readonly registrationBinding: RegistrationBindingView;
  readonly mutationVerification: MutationVerification;
  readonly retrySafety: RetrySafety;
  readonly migrationPath: MigrationPath;
  readonly nextCheckpoint: ManagedCheckpoint;
  readonly resume: "none" | "takeover-required" | "same-workspace";
  readonly blockers: readonly { readonly code: string; readonly summary: string }[];
  readonly authorizedNextActions: readonly string[];
  /** The inventory entries for the actions named above, in the same order. */
  readonly operationContracts: readonly FacadeOperation[];
  readonly policyRequiredInterruptions: number;
  readonly operatorInterventions: number;
}

const TERMINAL_STATES: readonly DeliveryState[] = ["completed", "cancelled", "failed"];

/**
 * The states in which a waiver or amendment proposal is accepted. The
 * operation guards exactly these, so naming it anywhere else would promise a
 * refusal.
 */
const APPROVAL_PROPOSAL_STATES: readonly DeliveryState[] = ["reviewing", "remediating", "admitting"];

const READ_ACTIONS: readonly string[] = ["status", "nextCheckpoint", "explainBlocker", "blockerInventory"];
const RETENTION_ACTIONS: readonly string[] = ["exportDelivery", "deleteDelivery"];

/** The operation that drives each checkpoint kind. */
function checkpointAction(checkpoint: ManagedCheckpoint): string | undefined {
  switch (checkpoint.kind) {
    case "bind-workspace":
      return "bindWorkspace";
    case "workflow-stage":
      return "submitStageResult";
    case "repository-sensor":
      return "runSensor";
    case "review":
      return "prepareProviderReviewHandoff";
    case "admission":
      return "admit";
    case "tracked-record":
      return "prepareTrackedRecord";
    case "finish-line":
      return "completeFinishLine";
    default:
      return undefined;
  }
}

function deriveMutationVerification(input: ManagedStatusInput): MutationVerification {
  if (!input.workspaceBound) return "not-applicable";
  if (input.hostActivity === "cancellation_pending") return "unverified";
  if (input.lastWorkspaceDisposition === "quarantined" || input.lastWorkspaceDisposition === "prior_host_termination_unverified") {
    return "unverified";
  }
  if (input.hostActivity === "active") return "not-applicable";
  if (input.lastWorkspaceDisposition === "reconciled" || input.terminationVerifiedAtCurrentFence) return "verified";
  return "unverified";
}

function deriveRetrySafety(input: ManagedStatusInput, mutation: MutationVerification): RetrySafety {
  if (input.delivery.state === "action_succeeded_verification_failed") return "never-repeat-external-action";
  if (mutation === "unverified") return "unverified-prior-mutation";
  return "safe";
}

/**
 * The exit from `security_blocked`.
 *
 * A profile mismatch has no path at all: a rebinding migration requires the
 * target installation's active profile to equal the delivery's recorded
 * profile, so the delivery reports a typed blocker instead of an operation
 * that is guaranteed to refuse. An unresolved installation is likewise no
 * path — there is nothing to migrate to.
 */
function deriveMigrationPath(input: ManagedStatusInput): MigrationPath {
  if (input.delivery.state !== "security_blocked") return "none";
  switch (input.registrationBinding.mismatch) {
    case "profile":
    case "unresolved":
      return "none";
    case "identity":
      return "rebinding-migration";
    default:
      return input.productTrust.generation === "eligible" ? "re-preparation" : "generation-change-migration";
  }
}

function deriveAuthorizedNextActions(
  input: ManagedStatusInput,
  mutation: MutationVerification,
  migration: MigrationPath,
): readonly string[] {
  const actions: string[] = [];

  // While a takeover is required the bound task is gone and its invocation
  // fence is superseded, so every operation that CARRIES a fence refuses on it
  // and the takeover is the real next action.
  //
  // "Carries" is the whole distinction, and getting it wrong is how this rule
  // suppressed the happy path once already. `bindWorkspace` MINTS the fence
  // rather than carrying one — a freshly confirmed delivery has no lifecycle
  // events, so it reports `takeover-required` before any workspace exists, and
  // suppressing its checkpoint action there leaves a delivery with no way
  // forward named at all. The inventory already records which operations carry
  // a fence, so this reads that rather than keeping a second list to drift.
  const takeoverFirst = input.resume === "takeover-required" && input.hostActivity !== "active";
  const carriesFence = (action: string): boolean =>
    FACADE_OPERATIONS.find((operation) => operation.operation === action)?.fence === "required";

  const add = (action: string | undefined): void => {
    if (action === undefined || actions.includes(action)) return;
    if (takeoverFirst && carriesFence(action)) return;
    actions.push(action);
  };

  if (TERMINAL_STATES.includes(input.delivery.state)) {
    for (const action of READ_ACTIONS) add(action);
    for (const action of RETENTION_ACTIONS) add(action);
    return actions;
  }

  if (input.delivery.state === "security_blocked") {
    if (migration !== "none") add("recoverSecurityBlocked");
    for (const action of READ_ACTIONS) add(action);
    add("requestCancellation");
    return actions;
  }

  if (input.delivery.state === "cancellation_requested") {
    add("finalizeCancellation");
    for (const action of READ_ACTIONS) add(action);
    return actions;
  }

  // A pending proposal is answered from the sensitive lane, and only where an
  // assertion source can actually evaluate one.
  if (input.pendingDecision !== undefined && input.assertionSource.lanes.sensitiveApprovals === "available") {
    add("consumeWaiver");
  }

  // An action is named only where the operation ACCEPTS it. Naming one that is
  // guaranteed to refuse is worse than naming nothing: the refusal's own
  // remediation sends the reader back to this very projection, so the surface
  // that told them to act is the surface that tells them to re-read it. The
  // stale-fence half of that rule lives in `add` above, so it applies to every
  // operation named here rather than to whichever site remembered it.
  if (input.delivery.state !== "blocked" && input.delivery.state !== "action_succeeded_verification_failed") {
    add(checkpointAction(input.nextCheckpoint));
  }
  // Proposing binds the review lane's own states; everywhere else the
  // operation refuses on state.
  if (APPROVAL_PROPOSAL_STATES.includes(input.delivery.state)) add("recordApprovalRequest");

  // Presenting a takeover reads the last trusted commit, so a delivery that
  // never bound a workspace has nothing to supersede.
  if (takeoverFirst && input.workspaceBound) add("presentTakeover");
  if (mutation === "unverified") add("exportDelivery");

  for (const action of READ_ACTIONS) add(action);
  add("requestCancellation");
  return actions;
}

export function composeManagedStatus(input: ManagedStatusInput): ManagedDeliveryStatus {
  const mutationVerification = deriveMutationVerification(input);
  const retrySafety = deriveRetrySafety(input, mutationVerification);
  const migrationPath = deriveMigrationPath(input);
  const authorizedNextActions = deriveAuthorizedNextActions(input, mutationVerification, migrationPath);
  const operationContracts = authorizedNextActions
    .map((action) => FACADE_OPERATIONS.find((operation) => operation.operation === action))
    .filter((operation): operation is FacadeOperation => operation !== undefined);

  return {
    deliveryId: input.deliveryId,
    intake: input.intake,
    delivery: input.delivery,
    hostActivity: input.hostActivity,
    completedObligations: input.completedObligations,
    productTrust: input.productTrust,
    assertionSource: input.assertionSource,
    quarantinedWorkspaces: input.quarantinedWorkspaces,
    candidate: input.candidate,
    pendingDecision: input.pendingDecision,
    registrationBinding: input.registrationBinding,
    mutationVerification,
    retrySafety,
    migrationPath,
    nextCheckpoint: input.nextCheckpoint,
    resume: input.resume,
    blockers: input.blockers,
    authorizedNextActions,
    operationContracts,
    policyRequiredInterruptions: input.policyRequiredInterruptions,
    operatorInterventions: input.operatorInterventions,
  };
}
