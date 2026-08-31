/**
 * Pure reducers over the frozen state tables — no I/O, no clock, no ambient
 * anything. A journal is an ordered value; the reducer either accepts every
 * entry under the frozen discipline or reports typed rejections.
 *
 * THE DELIVERY MATRIX. `DELIVERY_TRANSITION_TABLE` is the plan's conditional
 * transition table row for row, with each row's condition text carried
 * verbatim as documentation of WHY the edge exists. On top of the table sit
 * exactly the typed entries the State and Authority Model names in prose:
 * product-trust revocation enters `security_blocked` from any non-terminal
 * state; a typed blocker enters `blocked`; cancellation enters
 * `cancellation_requested` and completes to `cancelled`; leaving
 * `security_blocked` requires full re-preparation (`preparing`); and a
 * blocked delivery resumes only at its last trustworthy checkpoint — a
 * journal-dependent rule the reducer enforces, not a static edge. Everything
 * else rejects, `failed` has NO entry whatsoever (the discriminator is
 * frozen verbatim; inventing an entry condition would be a spine revision),
 * and terminal states have no exits.
 *
 * REVISIONS, FENCES, KEYS. Every entry names the journal revision it expects;
 * the three observation-only kinds never advance it. Fences are monotonic
 * per delivery — an older or equal fence rejects permanently. Idempotency
 * keys are unique per journal — a replayed append is detected, never
 * double-applied. Authority bindings move ONLY on `policy.snapshot.bound`
 * and `generation.pinned`: no stage result, operation result, or any other
 * agent-produced append can touch them, which is the reducer half of "an
 * agent result cannot grant authority".
 */
import { createSpineCollector, isSpineRecord, type SpineRejection } from "./grammar.ts";
import { validateJournalEntry } from "./journal.ts";
import {
  SUSPENDED_DELIVERY_STATES,
  TERMINAL_DELIVERY_STATES,
  classifyEventKind,
  type DeliveryState,
  type IntakeState,
} from "./vocabulary.ts";

export interface DeliveryTransitionRow {
  readonly from: DeliveryState;
  readonly to: DeliveryState;
  /** The plan's condition text, verbatim, as documentation of the edge. */
  readonly condition: string;
}

export const DELIVERY_TRANSITION_TABLE: readonly DeliveryTransitionRow[] = Object.freeze([
  { from: "accepted", to: "preparing", condition: "Composition, policy, host integration, and workspace-binding preflight pass" },
  { from: "preparing", to: "planning", condition: "Host-supplied isolated workspace and initial checkpoint are durable" },
  { from: "planning", to: "implementing", condition: "Plan output is accepted" },
  { from: "implementing", to: "validating", condition: "Versioned candidate checkpoint created" },
  { from: "validating", to: "remediating", condition: "Required sensor fails or implementation repair is needed" },
  { from: "validating", to: "reviewing", condition: "Required sensors pass on current candidate" },
  { from: "reviewing", to: "remediating", condition: "Actionable finding exists" },
  { from: "remediating", to: "validating", condition: "Any candidate mutation is checkpointed" },
  { from: "reviewing", to: "compounding", condition: "Every selected lens approves the current candidate" },
  { from: "compounding", to: "admitting", condition: "No repository mutation" },
  { from: "compounding", to: "validating", condition: "Candidate changes" },
  { from: "admitting", to: "recording", condition: "Current preparation and all activated obligations pass" },
  { from: "recording", to: "ready", condition: "Tracked record is checkpoint-committed and both-neutral verification passes" },
  { from: "recording", to: "validating", condition: "Any non-neutral byte or identity changes" },
  { from: "ready", to: "completed", condition: "Finish line is merge-ready and repository merge-ready obligations pass" },
  { from: "ready", to: "awaiting_approval", condition: "Explicitly authorized merge/deploy action remains and policy requires an approval for that action" },
  { from: "ready", to: "acting", condition: "Explicitly authorized merge/deploy action remains and no approval is required" },
  { from: "awaiting_approval", to: "acting", condition: "Valid user-originated approval is consumed and all bindings remain current" },
  { from: "awaiting_approval", to: "blocked", condition: "Approval denied, expired, revoked, or unavailable (per policy)" },
  { from: "awaiting_approval", to: "cancelled", condition: "Approval denied, expired, revoked, or unavailable (per policy)" },
  { from: "awaiting_approval", to: "validating", condition: "Candidate, base, policy, authority epoch, or invocation fence changes" },
  { from: "acting", to: "completed", condition: "Action is reconciled and required post-action evidence passes" },
  { from: "acting", to: "acting", condition: "Action is reconciled; the next authorized acting step remains" },
  { from: "acting", to: "action_succeeded_verification_failed", condition: "External action succeeded but required verification failed" },
] as const);

const isTerminal = (state: DeliveryState): boolean => TERMINAL_DELIVERY_STATES.includes(state as never);
const isSuspended = (state: DeliveryState): boolean => SUSPENDED_DELIVERY_STATES.includes(state as never);

/**
 * The static half of the frozen matrix. The one journal-dependent rule —
 * `blocked` resuming at the delivery's last trustworthy checkpoint — lives in
 * the reducer, so here every `blocked -> *` edge except its enumerated rows
 * is false.
 */
export function isDeliveryTransitionValid(from: DeliveryState, to: DeliveryState): boolean {
  if (isTerminal(from)) return false;
  if (to === "failed") return false; // frozen verbatim; no entry is invented
  if (DELIVERY_TRANSITION_TABLE.some((row) => row.from === from && row.to === to)) return true;
  // Typed prose entries from the State and Authority Model:
  if (to === "security_blocked") return from !== "security_blocked";
  if (to === "cancellation_requested") return from !== "cancellation_requested";
  if (from === "cancellation_requested" && to === "cancelled") return true;
  if (from === "security_blocked" && to === "preparing") return true; // leaving always requires full re-preparation
  if (to === "blocked") return !isSuspended(from);
  return false;
}

// ── Intake matrix ──────────────────────────────────────────────────────────

const INTAKE_CHAIN: readonly (readonly [IntakeState, IntakeState])[] = [
  ["draft_scope", "awaiting_clarification"],
  ["awaiting_clarification", "awaiting_confirmation"],
  ["awaiting_confirmation", "validating_acceptance"],
  ["validating_acceptance", "accepted_contract"],
];

const INTAKE_TERMINAL: readonly IntakeState[] = ["accepted_contract", "abandoned"];

export function isIntakeTransitionValid(from: IntakeState, to: IntakeState): boolean {
  if (INTAKE_TERMINAL.includes(from)) return false;
  if (INTAKE_CHAIN.some(([chainFrom, chainTo]) => chainFrom === from && chainTo === to)) return true;
  // Preflight failure enters blocked with typed remediation and may retry.
  if (from === "validating_acceptance" && to === "blocked") return true;
  if (from === "blocked" && to === "validating_acceptance") return true;
  // A draft mutation after presentation voids the nonce and returns intake to
  // awaiting_confirmation.
  if (from === "validating_acceptance" && to === "awaiting_confirmation") return true;
  if (to === "abandoned") return true; // operator abandon, any non-terminal state
  return false;
}

// ── Delivery journal reducer ───────────────────────────────────────────────

export interface DeliveryJournalState {
  readonly deliveryId: string;
  readonly state: DeliveryState;
  readonly expectedRevision: number;
  readonly lastFence: number;
  readonly policyDigest?: string;
  readonly authorityEpoch?: number;
  readonly generationDigest?: string;
  /** The contract identity in force, once a confirmed amendment created one. */
  readonly contractId?: string;
  /** The last non-suspended state — where a blocked delivery may resume. */
  readonly lastActiveState: DeliveryState;
}

export type ReduceDeliveryResult =
  | { readonly ok: true; readonly state: DeliveryJournalState }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export function reduceDeliveryJournal(entries: readonly unknown[]): ReduceDeliveryResult {
  const collector = createSpineCollector();

  let deliveryId: string | undefined;
  let state: DeliveryState = "accepted";
  let expectedRevision = 0;
  let lastFence = 0;
  let policyDigest: string | undefined;
  let authorityEpoch: number | undefined;
  let generationDigest: string | undefined;
  let contractId: string | undefined;
  let lastActiveState: DeliveryState = "accepted";
  let registered = false;
  let finishLineRecorded = false;
  const idempotencyKeys = new Set<string>();
  /** Recorded action intents, and the verification each one's result observed. */
  const actionIntents = new Map<string, string | undefined>();

  entries.forEach((value, index) => {
    const at = `/${index}`;
    const shape = validateJournalEntry(value);
    if (!shape.ok) {
      for (const rejection of shape.rejections) collector.emit(rejection.code, `${at}${rejection.pointer}`, rejection.message);
      return;
    }
    const entry = value as Record<string, unknown>;
    if (entry["journal"] !== "delivery") {
      collector.emit("unsupported_combination", `${at}/journal`, "the delivery reducer consumes only delivery-journal entries");
      return;
    }
    const kind = entry["kind"] as string;
    const subjectId = entry["subjectId"] as string;
    const revision = entry["expectedRevision"] as number;
    const idempotencyKey = entry["idempotencyKey"] as string;
    const payload = entry["payload"] as Record<string, unknown>;

    if (!registered) {
      if (kind !== "delivery.registered") {
        collector.emit("registration_missing", at, "the first delivery-journal entry must be delivery.registered");
        return;
      }
    } else if (kind === "delivery.registered") {
      collector.emit("unsupported_combination", `${at}/kind`, "a delivery registers exactly once");
      return;
    }

    if (deliveryId === undefined) {
      deliveryId = subjectId;
    } else if (subjectId !== deliveryId) {
      collector.emit("subject_mismatch", `${at}/subjectId`, `entry names ${subjectId}; this journal belongs to ${deliveryId}`);
      return;
    }

    if (isTerminal(state)) {
      collector.emit("journal_terminal", at, `the delivery is ${state}; a terminal journal accepts no further entries`);
      return;
    }

    if (idempotencyKeys.has(idempotencyKey)) {
      collector.emit("duplicate_idempotency_key", `${at}/idempotencyKey`, `key ${idempotencyKey} was already consumed; a replay is detected, never double-applied`);
      return;
    }

    if (revision !== expectedRevision) {
      collector.emit(
        "revision_mismatch",
        `${at}/expectedRevision`,
        `entry expects revision ${revision}; the journal is at ${expectedRevision}`,
      );
      return;
    }

    // Kind-specific discipline.
    switch (kind) {
      case "invocation.fenced": {
        const fence = payload["fence"] as number;
        if (fence <= lastFence) {
          collector.emit("non_monotonic_fence", `${at}/payload/fence`, `fence ${fence} does not exceed the current fence ${lastFence}; outputs from an older fence are permanently rejected`);
          return;
        }
        lastFence = fence;
        break;
      }
      case "activity.observed": {
        const fence = payload["fence"] as number;
        if (fence !== lastFence) {
          collector.emit("fence_mismatch", `${at}/payload/fence`, `observation names fence ${fence}; the current fence is ${lastFence}`);
          return;
        }
        break;
      }
      case "approval.request.recorded": {
        // A pending waiver or contract-amendment proposal is consumed within
        // reviewing, remediating, or admitting without a dedicated wait
        // state; outside those states there is no review context to propose
        // against, and the delivery never leaves its current state for one.
        if (state !== "reviewing" && state !== "remediating" && state !== "admitting") {
          collector.emit(
            "invalid_transition",
            at,
            `an approval proposal is journaled within reviewing, remediating, or admitting; the delivery is in ${state}`,
          );
          return;
        }
        break;
      }
      case "contract.amended": {
        // A confirmed amendment is consumed exactly where its waiver is —
        // reviewing, remediating, or admitting — and it supersedes the
        // CURRENT contract identity, never an earlier one in the chain. It
        // moves no state on its own; the forced full re-evaluation is an
        // ordinary transition beside it.
        if (state !== "reviewing" && state !== "remediating" && state !== "admitting") {
          collector.emit(
            "invalid_transition",
            at,
            `a confirmed amendment is journaled within reviewing, remediating, or admitting; the delivery is in ${state}`,
          );
          return;
        }
        const previous = payload["previousContractId"] as string;
        if (contractId !== undefined && previous !== contractId) {
          collector.emit(
            "subject_mismatch",
            `${at}/payload/previousContractId`,
            `the amendment supersedes ${previous}; this delivery's contract identity is ${contractId}`,
          );
          return;
        }
        contractId = payload["contractId"] as string;
        break;
      }
      case "policy.snapshot.bound": {
        policyDigest = payload["policyDigest"] as string;
        authorityEpoch = payload["repositoryAuthorityEpoch"] as number;
        break;
      }
      case "generation.pinned": {
        generationDigest = payload["generationDigest"] as string;
        break;
      }
      case "finish.line.recorded": {
        // The finish-line result is composed at the terminal-success edge and
        // nowhere else; an approving review earlier in the loop composes
        // nothing on its own.
        if (state !== "ready") {
          collector.emit(
            "invalid_transition",
            at,
            `a finish-line result is recorded in ready; the delivery is in ${state}`,
          );
          return;
        }
        finishLineRecorded = true;
        break;
      }
      case "action.intent.recorded": {
        // The intent precedes the invocation, and the invocation only ever
        // happens while acting.
        if (state !== "acting") {
          collector.emit("invalid_transition", at, `an action intent is recorded while acting; the delivery is in ${state}`);
          return;
        }
        const intentId = payload["intentId"] as string;
        if (actionIntents.has(intentId)) {
          collector.emit("unsupported_combination", `${at}/payload/intentId`, `intent ${intentId} was already recorded`);
          return;
        }
        actionIntents.set(intentId, undefined);
        break;
      }
      case "action.result.recorded": {
        const intentId = payload["intentId"] as string;
        if (state !== "acting") {
          collector.emit("invalid_transition", at, `an action result is recorded while acting; the delivery is in ${state}`);
          return;
        }
        if (!actionIntents.has(intentId)) {
          collector.emit(
            "invalid_transition",
            `${at}/payload/intentId`,
            `no intent ${intentId} was recorded; an external action is never observed without its prior intent`,
          );
          return;
        }
        if (actionIntents.get(intentId) !== undefined) {
          // The irreversible action must never be repeated, so its observed
          // result is written exactly once.
          collector.emit(
            "unsupported_combination",
            `${at}/payload/intentId`,
            `intent ${intentId} already carries an observed result; an irreversible action is never repeated`,
          );
          return;
        }
        actionIntents.set(intentId, payload["verification"] as string);
        break;
      }
      case "transition.committed": {
        const from = payload["from"] as DeliveryState;
        const to = payload["to"] as DeliveryState;
        if (from !== state) {
          collector.emit("invalid_transition", `${at}/payload/from`, `transition leaves ${from}; the delivery is in ${state}`);
          return;
        }
        // Terminal success is never a bare edge. Out of `ready` it stands on a
        // recorded merge-ready result; out of `acting` it stands on an
        // observed action result whose verification passed — and the
        // verification-failed variant stands on exactly the opposite.
        if (from === "ready" && to === "completed" && !finishLineRecorded) {
          collector.emit(
            "invalid_transition",
            `${at}/payload/to`,
            "terminal success requires a recorded merge-ready finish-line result; a green review alone completes nothing",
          );
          return;
        }
        if (from === "acting" && (to === "completed" || to === "action_succeeded_verification_failed")) {
          const verifications = [...actionIntents.values()];
          const wanted = to === "completed" ? "passed" : "failed";
          if (!verifications.includes(wanted)) {
            collector.emit(
              "invalid_transition",
              `${at}/payload/to`,
              `acting -> ${to} requires an observed action result whose verification is ${wanted}`,
            );
            return;
          }
        }
        const blockedResume = from === "blocked" && to === lastActiveState;
        if (!blockedResume && !isDeliveryTransitionValid(from, to)) {
          collector.emit(
            "invalid_transition",
            `${at}/payload/to`,
            from === "blocked"
              ? `a blocked delivery resumes from its last trustworthy checkpoint (${lastActiveState}), not ${to}`
              : `${from} -> ${to} is outside the frozen transition matrix`,
          );
          return;
        }
        if (!isSuspended(state) && !isTerminal(state)) lastActiveState = state;
        state = to;
        break;
      }
      default:
        break; // every other active kind is an append with no state effect here
    }

    idempotencyKeys.add(idempotencyKey);
    if (kind === "delivery.registered") registered = true;
    const classification = classifyEventKind("delivery", kind);
    const observationOnly = classification.status === "active" && classification.observationOnly;
    if (!observationOnly) expectedRevision += 1;
  });

  const verdict = collector.verdict();
  if (!verdict.ok) return verdict;
  if (!registered || deliveryId === undefined) {
    return {
      ok: false,
      rejections: [{ code: "registration_missing", pointer: "", message: "an empty journal has no registered delivery" }],
    };
  }
  const base: DeliveryJournalState = {
    deliveryId,
    state,
    expectedRevision,
    lastFence,
    lastActiveState,
    ...(policyDigest === undefined ? {} : { policyDigest }),
    ...(authorityEpoch === undefined ? {} : { authorityEpoch }),
    ...(generationDigest === undefined ? {} : { generationDigest }),
    ...(contractId === undefined ? {} : { contractId }),
  };
  return { ok: true, state: base };
}

// ── Maintenance journal reducer ────────────────────────────────────────────

/**
 * The installation-scoped maintenance journal: an append log under the same
 * envelope grammar and revision/idempotency discipline, with no state
 * machine — maintenance records are facts about the installation, and the
 * retention family's records deliberately outlive the deliveries they name.
 * No maintenance kind is observation-only, so every entry advances the
 * revision.
 */
export interface MaintenanceJournalState {
  readonly subjectId: string;
  readonly expectedRevision: number;
}

export type ReduceMaintenanceResult =
  | { readonly ok: true; readonly state: MaintenanceJournalState }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export function reduceMaintenanceJournal(entries: readonly unknown[]): ReduceMaintenanceResult {
  const collector = createSpineCollector();

  let subjectId: string | undefined;
  let expectedRevision = 0;
  const idempotencyKeys = new Set<string>();

  entries.forEach((value, index) => {
    const at = `/${index}`;
    const shape = validateJournalEntry(value);
    if (!shape.ok) {
      for (const rejection of shape.rejections) collector.emit(rejection.code, `${at}${rejection.pointer}`, rejection.message);
      return;
    }
    const entry = value as Record<string, unknown>;
    if (entry["journal"] !== "maintenance") {
      collector.emit("unsupported_combination", `${at}/journal`, "the maintenance reducer consumes only maintenance-journal entries");
      return;
    }
    const subject = entry["subjectId"] as string;
    const revision = entry["expectedRevision"] as number;
    const idempotencyKey = entry["idempotencyKey"] as string;

    if (subjectId === undefined) {
      subjectId = subject;
    } else if (subject !== subjectId) {
      collector.emit("subject_mismatch", `${at}/subjectId`, `entry names ${subject}; this journal belongs to ${subjectId}`);
      return;
    }
    if (idempotencyKeys.has(idempotencyKey)) {
      collector.emit("duplicate_idempotency_key", `${at}/idempotencyKey`, `key ${idempotencyKey} was already consumed`);
      return;
    }
    if (revision !== expectedRevision) {
      collector.emit("revision_mismatch", `${at}/expectedRevision`, `entry expects revision ${revision}; the journal is at ${expectedRevision}`);
      return;
    }

    idempotencyKeys.add(idempotencyKey);
    expectedRevision += 1;
  });

  const verdict = collector.verdict();
  if (!verdict.ok) return verdict;
  if (subjectId === undefined) {
    return { ok: false, rejections: [{ code: "registration_missing", pointer: "", message: "an empty maintenance journal names no installation" }] };
  }
  return { ok: true, state: { subjectId, expectedRevision } };
}

// ── Intake journal reducer ─────────────────────────────────────────────────

export interface IntakeJournalState {
  readonly intakeId: string;
  readonly state: IntakeState;
  readonly expectedRevision: number;
  readonly contractConfirmed: boolean;
  /** How many clarification exchanges the scope workflow has retained. */
  readonly clarificationCount: number;
  /** The digest of the most recently retained draft, when one is retained. */
  readonly lastDraftDigest?: string;
}

export type ReduceIntakeResult =
  | { readonly ok: true; readonly state: IntakeJournalState }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export function reduceIntakeJournal(entries: readonly unknown[]): ReduceIntakeResult {
  const collector = createSpineCollector();

  let intakeId: string | undefined;
  let state: IntakeState = "draft_scope";
  let expectedRevision = 0;
  let contractConfirmed = false;
  let clarificationCount = 0;
  let lastDraftDigest: string | undefined;
  const idempotencyKeys = new Set<string>();

  entries.forEach((value, index) => {
    const at = `/${index}`;
    const shape = validateJournalEntry(value);
    if (!shape.ok) {
      for (const rejection of shape.rejections) collector.emit(rejection.code, `${at}${rejection.pointer}`, rejection.message);
      return;
    }
    const entry = value as Record<string, unknown>;
    if (entry["journal"] !== "intake") {
      collector.emit("unsupported_combination", `${at}/journal`, "the intake reducer consumes only intake-journal entries");
      return;
    }
    const kind = entry["kind"] as string;
    const subjectId = entry["subjectId"] as string;
    const revision = entry["expectedRevision"] as number;
    const idempotencyKey = entry["idempotencyKey"] as string;
    const payload = entry["payload"] as Record<string, unknown>;

    if (intakeId === undefined) {
      intakeId = subjectId;
    } else if (subjectId !== intakeId) {
      collector.emit("subject_mismatch", `${at}/subjectId`, `entry names ${subjectId}; this journal belongs to ${intakeId}`);
      return;
    }

    if (INTAKE_TERMINAL.includes(state)) {
      collector.emit("journal_terminal", at, `intake is ${state}; a terminal journal accepts no further entries`);
      return;
    }

    if (idempotencyKeys.has(idempotencyKey)) {
      collector.emit("duplicate_idempotency_key", `${at}/idempotencyKey`, `key ${idempotencyKey} was already consumed`);
      return;
    }

    if (revision !== expectedRevision) {
      collector.emit("revision_mismatch", `${at}/expectedRevision`, `entry expects revision ${revision}; the journal is at ${expectedRevision}`);
      return;
    }

    if (kind === "intake.state.changed") {
      const from = payload["from"] as IntakeState;
      const to = payload["to"] as IntakeState;
      if (from !== state) {
        collector.emit("invalid_transition", `${at}/payload/from`, `transition leaves ${from}; intake is in ${state}`);
        return;
      }
      if (!isIntakeTransitionValid(from, to)) {
        collector.emit("invalid_transition", `${at}/payload/to`, `${from} -> ${to} is outside the frozen intake chain`);
        return;
      }
      state = to;
    }
    if (kind === "operator.confirmation.recorded") {
      // A contract confirmation is presented and consumed at the confirmation
      // handoff; outside awaiting_confirmation there is nothing presented to
      // confirm.
      if (state !== "awaiting_confirmation") {
        collector.emit("invalid_transition", at, `a contract confirmation is consumed in awaiting_confirmation; intake is in ${state}`);
        return;
      }
      const confirmation = payload["confirmation"];
      if (isSpineRecord(confirmation) && confirmation["intakeDraftId"] !== subjectId) {
        collector.emit("subject_mismatch", `${at}/payload/confirmation/intakeDraftId`, "the confirmation binds a different intake draft");
        return;
      }
      // The confirmation binds the EXACT digest presented to the operator; a
      // draft retained since presentation carries a different digest, so the
      // pending confirmation is void — the reducer half of "a draft mutated
      // after presentation voids the pending confirmation".
      if (
        isSpineRecord(confirmation) &&
        lastDraftDigest !== undefined &&
        typeof confirmation["normalizedContractDigest"] === "string" &&
        confirmation["normalizedContractDigest"] !== lastDraftDigest
      ) {
        collector.emit(
          "digest_mismatch",
          `${at}/payload/confirmation/normalizedContractDigest`,
          "the confirmation binds a digest other than the retained draft's; a draft mutated after presentation voids the pending confirmation",
        );
        return;
      }
      contractConfirmed = true;
    }
    if (kind === "intake.clarification.recorded") {
      // Clarification exchanges belong to the scope workflow's iteration —
      // the awaiting_clarification discriminator the spine froze.
      if (state !== "awaiting_clarification") {
        collector.emit("invalid_transition", at, `a clarification is retained in awaiting_clarification; intake is in ${state}`);
        return;
      }
      clarificationCount += 1;
    }
    if (kind === "intake.draft.recorded") {
      // A draft may be retained while scoping (draft_scope,
      // awaiting_clarification) and after presentation (awaiting_confirmation
      // — where it voids the pending confirmation via the digest rule above).
      // After consumption the chain moves through validating_acceptance;
      // mutating the draft there is a facade-mediated return to
      // awaiting_confirmation, never a bare append.
      if (state !== "draft_scope" && state !== "awaiting_clarification" && state !== "awaiting_confirmation") {
        collector.emit("invalid_transition", at, `a draft is retained before acceptance validation begins; intake is in ${state}`);
        return;
      }
      lastDraftDigest = payload["draftDigest"] as string;
    }

    idempotencyKeys.add(idempotencyKey);
    expectedRevision += 1; // no intake kind is observation-only
  });

  const verdict = collector.verdict();
  if (!verdict.ok) return verdict;
  if (intakeId === undefined) {
    return { ok: false, rejections: [{ code: "registration_missing", pointer: "", message: "an empty intake journal names no draft" }] };
  }
  return {
    ok: true,
    state: {
      intakeId,
      state,
      expectedRevision,
      contractConfirmed,
      clarificationCount,
      ...(lastDraftDigest === undefined ? {} : { lastDraftDigest }),
    },
  };
}
