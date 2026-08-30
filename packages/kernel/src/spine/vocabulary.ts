/**
 * THE FROZEN VOCABULARY, verbatim from the plan's State and Authority Model
 * (docs/plans/2026-08-29-001-feat-managed-agent-delivery-system-plan.md in
 * the Athena repository, the contract-freeze authority).
 *
 * Three frozen surfaces live here and nowhere else:
 *
 *   1. The intake and delivery state discriminator lists, plus the
 *      host-activity marker list. `failed` is frozen as a terminal delivery
 *      discriminator even though no enumerated transition ever enters it —
 *      an unreachable discriminator is fail-safe, and inventing an entry
 *      condition would be a spine revision requiring contract-freeze owner
 *      approval, so none is invented.
 *   2. The closed durable event-kind vocabulary, keyed by (journal, kind)
 *      PAIRS — never by a kind→journal map, because
 *      `operator.confirmation.recorded` legitimately homes in two journals
 *      (intake for contract confirmations, delivery for takeover
 *      authorizations) and a single-home map would wrongly reject one of
 *      them. Active kinds have their payloads frozen in `journal.ts`;
 *      reserved kinds reject unconditionally — with or without a payload —
 *      until their owning unit defines them; a pair outside the enumeration
 *      rejects as unknown.
 *   3. The three-kind observation-only exemption: `activity.observed`,
 *      `trust.epoch.observed`, and `control.plane.mirror.recorded` never
 *      advance the expected journal revision that fences, assertions, and
 *      confirmations bind. The mirror kind is simultaneously reserved: the
 *      exemption records where it will sit once its owning unit defines it,
 *      and until then the reserved rejection wins.
 *
 * Adding any kind, state, or journal — active or reserved — is a spine
 * contract revision requiring contract-freeze owner approval. The vocabulary
 * tests assert these lists element by element to make a silent edit
 * impossible.
 */

export const JOURNALS = Object.freeze(["intake", "delivery", "maintenance"] as const);
export type Journal = (typeof JOURNALS)[number];

export const INTAKE_STATES = Object.freeze([
  "draft_scope",
  "awaiting_clarification",
  "awaiting_confirmation",
  "validating_acceptance",
  "accepted_contract",
  "blocked",
  "abandoned",
] as const);
export type IntakeState = (typeof INTAKE_STATES)[number];

export const DELIVERY_STATES = Object.freeze([
  "accepted",
  "preparing",
  "planning",
  "implementing",
  "validating",
  "remediating",
  "reviewing",
  "compounding",
  "admitting",
  "recording",
  "ready",
  "awaiting_approval",
  "acting",
  "completed",
  "blocked",
  "security_blocked",
  "cancellation_requested",
  "action_succeeded_verification_failed",
  "cancelled",
  "failed",
] as const);
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** The suspended-or-terminal variants, reachable only through typed transitions. */
export const SUSPENDED_DELIVERY_STATES = Object.freeze([
  "blocked",
  "security_blocked",
  "cancellation_requested",
  "awaiting_approval",
  "action_succeeded_verification_failed",
] as const);

export const TERMINAL_DELIVERY_STATES = Object.freeze(["completed", "cancelled", "failed"] as const);

/** Host activity is tracked separately and never changes the delivery state. */
export const HOST_ACTIVITY_STATES = Object.freeze(["active", "paused", "unknown", "cancellation_pending"] as const);
export type HostActivityState = (typeof HOST_ACTIVITY_STATES)[number];

export interface EventKindEntry {
  readonly journal: Journal;
  readonly kind: string;
  readonly status: "active" | "reserved";
  /** Never advances the expected journal revision. Delivery journal only. */
  readonly observationOnly: boolean;
  /** For reserved kinds: the plan unit that owns the payload definition. */
  readonly owner?: string;
}

const entry = (
  journal: Journal,
  kind: string,
  status: "active" | "reserved",
  observationOnly = false,
  owner?: string,
): EventKindEntry => Object.freeze({ journal, kind, status, observationOnly, ...(owner === undefined ? {} : { owner }) });

export const EVENT_VOCABULARY: readonly EventKindEntry[] = Object.freeze([
  // Intake journal — active.
  entry("intake", "intake.state.changed", "active"),
  entry("intake", "operator.confirmation.recorded", "active"),
  // Delivery journal — active.
  entry("delivery", "delivery.registered", "active"),
  entry("delivery", "workspace.bound", "active"),
  entry("delivery", "invocation.fenced", "active"),
  entry("delivery", "activity.observed", "active", true),
  entry("delivery", "operator.confirmation.recorded", "active"),
  entry("delivery", "approval.request.recorded", "active"),
  entry("delivery", "operation.result.recorded", "active"),
  entry("delivery", "workspace.disposition.recorded", "active"),
  entry("delivery", "transition.committed", "active"),
  entry("delivery", "stage.result.recorded", "active"),
  entry("delivery", "attempt.artifact.recorded", "active"),
  entry("delivery", "evidence.reference.recorded", "active"),
  entry("delivery", "candidate.recaptured", "active"),
  entry("delivery", "policy.snapshot.bound", "active"),
  entry("delivery", "generation.pinned", "active"),
  entry("delivery", "trust.epoch.observed", "active", true),
  entry("delivery", "blocker.recorded", "active"),
  entry("delivery", "finish.line.recorded", "active"),
  // Defined by the composition-lifecycle unit out of reservation — the
  // sanctioned per-tranche path: the pair was enumerated with this owner from
  // the start, and its payload is now frozen in `journal.ts`.
  entry("delivery", "approval.assertion.consumed", "active"),
  entry("maintenance", "maintenance.action.recorded", "active"),
  // Reserved — payloads belong to their owning units; reject until defined.
  entry("maintenance", "retention.action.recorded", "reserved", false, "retention/export/deletion"),
  entry("intake", "intake.clarification.recorded", "reserved", false, "iterative intake"),
  entry("intake", "intake.draft.recorded", "reserved", false, "iterative intake"),
  entry("delivery", "termination.provenance.recorded", "reserved", false, "trusted host lifecycle integration"),
  entry("delivery", "contract.amended", "reserved", false, "amendment/waiver admission"),
  entry("delivery", "action.intent.recorded", "reserved", false, "finish-line actions"),
  entry("delivery", "action.result.recorded", "reserved", false, "finish-line actions"),
  entry("delivery", "control.plane.mirror.recorded", "reserved", true, "control-plane coordination"),
]);

/** The three-kind observation-only exemption, verbatim. */
export const OBSERVATION_ONLY_KINDS = Object.freeze([
  "activity.observed",
  "trust.epoch.observed",
  "control.plane.mirror.recorded",
] as const);

export type EventClassification =
  | { readonly status: "active"; readonly observationOnly: boolean }
  | { readonly status: "reserved" }
  | { readonly status: "unknown"; readonly knownIn: readonly Journal[] };

/**
 * Classifies one (journal, kind) pair against the frozen vocabulary. A pair
 * outside the enumeration is unknown even when the kind exists in another
 * journal — `knownIn` names the kind's real homes so the rejection message
 * can say so without ever accepting the pair.
 */
export function classifyEventKind(journal: string, kind: string): EventClassification {
  const match = EVENT_VOCABULARY.find((candidate) => candidate.journal === journal && candidate.kind === kind);
  if (match !== undefined) {
    return match.status === "active"
      ? { status: "active", observationOnly: match.observationOnly }
      : { status: "reserved" };
  }
  const knownIn = EVENT_VOCABULARY.filter((candidate) => candidate.kind === kind).map(
    (candidate) => candidate.journal,
  );
  return { status: "unknown", knownIn };
}
