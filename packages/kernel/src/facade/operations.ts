/**
 * The managed-delivery operation inventory: every facade operation, the
 * authorization capability it costs, whether it binds the invocation fence,
 * what it does to the expected journal revision, and which surfaces may reach
 * it.
 *
 * WHY THIS IS DATA AND NOT PROSE. The facade's boundary is a set of claims
 * that are easy to state and easy to erode: confirmations are served only by
 * the binding's model-external channel; termination provenance enters only
 * through the trusted lifecycle integration; the tool surfaces inspect rather
 * than orchestrate. Written as comments those claims decay the first time a
 * command is added. Written here they are checkable, and
 * `checkFacadeSurfaceInvariants` is what checks them — over this inventory in
 * the kernel's own suite, and over the CLI's and MCP's advertised surfaces in
 * the contract-inventory sensor that sits above both packages.
 *
 * THIS INVENTORY GRANTS NOTHING. It describes what an operation costs and
 * where it is reachable. Authority still enters only through the compiled
 * policy snapshot, the invocation fence, and the two non-model-mintable
 * authorization classes; an entry here cannot make an unauthorized call
 * succeed, and removing one cannot make an authorized call fail.
 */

// ── The authorization classes ──────────────────────────────────────────────

/**
 * The six capability classes an operation can cost.
 *
 * `read` observes and never writes. `control` is delivery progression driven
 * by a bound host task. `maintenance` is the installation-scoped lane: update,
 * rollback, trust-state edits, retention, and the security-blocked migration.
 * `approval` is a sensitive approval, which requires the host- or OS-native
 * assertion. `confirmation` is an operator confirmation, which requires no
 * assertion but is model-external by construction. `action` actions the
 * policy-selected finish line.
 */
export const FACADE_CAPABILITY_CLASSES = Object.freeze([
  "read",
  "control",
  "maintenance",
  "approval",
  "confirmation",
  "action",
] as const);
export type FacadeCapabilityClass = (typeof FACADE_CAPABILITY_CLASSES)[number];

/**
 * Where an operation can be reached from.
 *
 * `cli` and `mcp` are the model-visible tool surfaces. `binding-channel` is
 * the isolated interactive channel the qualified host binding owns, outside
 * the model-visible tool and shell surface. `integration-event` is the trusted
 * host-runtime lifecycle integration. `facade` means the operation is reachable
 * only as a library call by an embedding product surface.
 */
export const FACADE_SURFACES = Object.freeze(["cli", "mcp", "binding-channel", "integration-event", "facade"] as const);
export type FacadeSurface = (typeof FACADE_SURFACES)[number];

/**
 * Whether the operation binds the invocation fence of the task making it.
 * `absent-by-state` is the frozen spelling for a value that does not exist yet
 * or does not apply, and is never rechecked.
 */
export type FacadeFenceRule = "required" | "absent-by-state";

/**
 * What the operation does to the delivery journal's expected revision — the
 * value fences, assertions, and confirmations bind. `observation-only` appends
 * without advancing it; `none` appends nothing to the delivery journal, which
 * includes the maintenance-lane operations that write the installation's own
 * maintenance journal instead.
 */
export type FacadeJournalRule = "advances" | "observation-only" | "none";

export interface FacadeOperation {
  /** The facade method name, verbatim. */
  readonly operation: string;
  readonly capability: FacadeCapabilityClass;
  readonly fence: FacadeFenceRule;
  readonly journalRevision: FacadeJournalRule;
  readonly surfaces: readonly FacadeSurface[];
  readonly summary: string;
}

const entry = (
  operation: string,
  capability: FacadeCapabilityClass,
  fence: FacadeFenceRule,
  journalRevision: FacadeJournalRule,
  surfaces: readonly FacadeSurface[],
  summary: string,
): FacadeOperation => Object.freeze({ operation, capability, fence, journalRevision, surfaces: Object.freeze([...surfaces]), summary });

// ── The inventory ──────────────────────────────────────────────────────────

export const FACADE_OPERATIONS: readonly FacadeOperation[] = Object.freeze([
  // Read.
  entry("status", "read", "absent-by-state", "none", ["cli", "mcp"], "The one typed status model for a registered delivery."),
  entry("nextCheckpoint", "read", "absent-by-state", "none", ["cli", "mcp"], "The next valid checkpoint the delivery will accept."),
  entry("explainBlocker", "read", "absent-by-state", "none", ["cli", "mcp"], "The current blocker and its declared remediation."),
  entry("blockerInventory", "read", "absent-by-state", "none", ["cli", "mcp"], "Every blocker this delivery journaled and whether it was left."),

  // Control — intake.
  entry("openIntake", "control", "absent-by-state", "advances", ["facade"], "Opens an iterative intake under the read-only intake grant."),
  entry("recordClarification", "control", "absent-by-state", "advances", ["facade"], "Retains one clarification exchange of the scope workflow."),
  entry("recordDraft", "control", "absent-by-state", "advances", ["facade"], "Retains the current draft contract, voiding any pending confirmation."),
  entry("presentDraft", "control", "absent-by-state", "advances", ["facade"], "Presents the retained draft for the one operator confirmation."),
  entry("presentContract", "control", "absent-by-state", "advances", ["facade"], "The already-scoped fallback lane into the same confirmation chain."),
  entry("retryAcceptance", "control", "absent-by-state", "advances", ["facade"], "Re-runs acceptance validation on the standing confirmation."),

  // Control — delivery progression.
  entry("bindWorkspace", "control", "absent-by-state", "advances", ["facade"], "Binds the host-supplied worktree and mints the invocation fence."),
  entry("submitStageResult", "control", "required", "advances", ["cli"], "Submits a typed workflow-stage result for the current checkpoint."),
  entry("checkpointCandidate", "control", "required", "advances", ["cli"], "Checkpoints the versioned candidate the workspace now stands on."),
  entry("runSensor", "control", "required", "advances", ["cli"], "Runs the bound repository sensor and journals its typed result."),
  entry("submitReviewAttempt", "control", "required", "advances", ["cli"], "Records one reviewer attempt against the current candidate."),
  entry("reduceReview", "control", "required", "advances", ["cli"], "Reduces the recorded attempts to a review verdict."),
  entry("admit", "control", "required", "advances", ["cli"], "Runs admission over the activated obligations."),
  entry("prepareTrackedRecord", "control", "required", "advances", ["cli"], "Writes the tracked delivery record for native commit."),
  entry("confirmTrackedRecord", "control", "required", "advances", ["cli"], "Verifies the committed record is both-neutral."),
  entry("recordApprovalRequest", "control", "required", "advances", ["cli"], "Journals a waiver or amendment proposal and its pending marker."),
  entry("requestCancellation", "control", "absent-by-state", "advances", ["cli"], "Revokes the fence and requests native host cancellation."),
  entry("finalizeCancellation", "control", "absent-by-state", "advances", ["cli"], "Quarantines the prior workspace and reaches terminal cancelled."),
  entry("presentTakeover", "control", "absent-by-state", "advances", ["facade"], "Presents a takeover for the one operator authorization."),
  entry("tearDownWorkspaceProjection", "control", "absent-by-state", "none", ["facade"], "Tears the run-pinned projection down with the worktree."),
  entry("sessionEnded", "control", "required", "observation-only", ["facade"], "Observes that the bound host task is no longer active."),

  // Action.
  entry("completeFinishLine", "action", "required", "advances", ["cli"], "Actions the policy-selected finish line for the current candidate."),

  // Approval — the sensitive lane.
  entry("consumeWaiver", "approval", "required", "advances", ["facade"], "Consumes one fresh assertion against the pending proposal."),

  // Confirmation — the binding's model-external channel, and nowhere else.
  entry("confirmContract", "confirmation", "absent-by-state", "advances", ["binding-channel"], "Completes the contract confirmation by echoed challenge."),
  entry("confirmTakeover", "confirmation", "absent-by-state", "advances", ["binding-channel"], "Completes the takeover authorization by echoed challenge."),

  // Trusted integration event — never a model-callable operation.
  entry(
    "recordTerminationProvenance",
    "control",
    "required",
    "advances",
    ["integration-event"],
    "Admits graceful host-runtime termination provenance from the trusted lifecycle integration.",
  ),

  // Maintenance — the installation-scoped lane.
  entry("recoverSecurityBlocked", "maintenance", "absent-by-state", "advances", ["cli"], "Leaves security_blocked by re-preparation or a compatible migration."),
  entry("exportDelivery", "maintenance", "absent-by-state", "none", ["cli"], "Exports the delivery's durable detail to an owned path."),
  entry("deleteDelivery", "maintenance", "absent-by-state", "none", ["cli"], "Deletes a terminal delivery, preserving the required audit record."),
  entry("updateComposition", "maintenance", "absent-by-state", "none", ["cli"], "Updates the installation to a newer product generation."),
  entry("rollbackComposition", "maintenance", "absent-by-state", "none", ["cli"], "Restores a previously accepted product generation."),
  entry("maintainTrustState", "maintenance", "absent-by-state", "none", ["cli"], "Pins, revokes, un-revokes, or advances the trust high-water mark."),
]);

export function facadeOperation(operation: string): FacadeOperation | undefined {
  return FACADE_OPERATIONS.find((candidate) => candidate.operation === operation);
}

export function operationsOnSurface(surface: FacadeSurface): readonly FacadeOperation[] {
  return FACADE_OPERATIONS.filter((candidate) => candidate.surfaces.includes(surface));
}

// ── The invariants ─────────────────────────────────────────────────────────

export type FacadeSurfaceRule =
  | "confirmation-off-channel"
  | "mcp-not-read-only"
  | "termination-provenance-callable"
  | "duplicate-operation"
  | "fence-without-revision";

export interface FacadeSurfaceFinding {
  readonly rule: FacadeSurfaceRule;
  readonly operation: string;
  readonly message: string;
}

/** The operation whose provenance may never become model-callable. */
export const TERMINATION_PROVENANCE_OPERATION = "recordTerminationProvenance";

const MODEL_VISIBLE_SURFACES: readonly FacadeSurface[] = Object.freeze(["cli", "mcp"] as const);

/**
 * Judges an inventory against the boundary this facade exists to hold. Returns
 * every finding rather than the first, so one run reports the whole erosion.
 */
export function checkFacadeSurfaceInvariants(operations: readonly FacadeOperation[]): readonly FacadeSurfaceFinding[] {
  const findings: FacadeSurfaceFinding[] = [];
  const seen = new Set<string>();

  for (const operation of operations) {
    if (seen.has(operation.operation)) {
      findings.push({
        rule: "duplicate-operation",
        operation: operation.operation,
        message: `operation ${operation.operation} is declared more than once`,
      });
    }
    seen.add(operation.operation);

    if (operation.capability === "confirmation") {
      const offChannel = operation.surfaces.filter((surface) => surface !== "binding-channel");
      if (offChannel.length > 0) {
        findings.push({
          rule: "confirmation-off-channel",
          operation: operation.operation,
          message: `an operator confirmation is served only by the binding-owned channel; ${operation.operation} also names ${offChannel.join(", ")}`,
        });
      }
    }

    const modelVisible = operation.surfaces.filter((surface) => MODEL_VISIBLE_SURFACES.includes(surface));
    if (operation.operation === TERMINATION_PROVENANCE_OPERATION && modelVisible.length > 0) {
      findings.push({
        rule: "termination-provenance-callable",
        operation: operation.operation,
        message: `termination provenance enters only through the trusted integration event; ${operation.operation} names ${modelVisible.join(", ")}`,
      });
    }

    if (operation.surfaces.includes("mcp") && operation.capability !== "read") {
      findings.push({
        rule: "mcp-not-read-only",
        operation: operation.operation,
        message: `the MCP surface inspects rather than orchestrates; ${operation.operation} is ${operation.capability}, not read`,
      });
    }

    if (operation.fence === "required" && operation.journalRevision === "none") {
      findings.push({
        rule: "fence-without-revision",
        operation: operation.operation,
        message: `${operation.operation} binds the invocation fence but writes nothing the fence could be checked against`,
      });
    }
  }

  return findings;
}
