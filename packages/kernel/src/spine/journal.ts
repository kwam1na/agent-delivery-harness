/**
 * The durable journal-entry envelope: one closed grammar over the frozen
 * (journal, kind) vocabulary, with a frozen closed payload table per ACTIVE
 * kind.
 *
 * Vocabulary application is deliberately ordered fail-closed: a reserved
 * pair rejects `reserved_kind` before any payload question is asked — with a
 * payload, without one, well-formed or not — and a pair outside the
 * enumeration rejects `unknown_kind` the same way. Only an active pair
 * proceeds to payload validation.
 *
 * `expectedRevision` is the journal revision this entry expects to observe.
 * Whether it advances is the reducer's business — the three observation-only
 * kinds never advance it — but the member itself is part of every entry, so
 * fences, assertions, and confirmations have one number to bind.
 */
import {
  SENSITIVE_MAINTENANCE_ACTIONS,
  assertionClassOf,
  validateSensitiveApprovalAssertion,
} from "./assertion.ts";
import { validateSensorResult } from "./capability.ts";
import { confirmationClassOf, validateOperatorConfirmation } from "./confirmation.ts";
import { EXTERNAL_ACTIONS, validateFinishLineResult } from "./finish-line.ts";
import {
  boundedText,
  checkClosed,
  closed,
  createSpineCollector,
  gitOid,
  isAbsentByState,
  isSpineRecord,
  nonNegativeInt,
  oneOf,
  orAbsentByState,
  positiveInt,
  sha256,
  specLiteral,
  spineId,
  stringArray,
  text,
  type MemberRule,
  type SpineCollector,
  type SpineVerdict,
} from "./grammar.ts";
import { DELIVERY_STATES, HOST_ACTIVITY_STATES, INTAKE_STATES, JOURNALS, classifyEventKind } from "./vocabulary.ts";

export const JOURNAL_ENTRY_SPEC = "journal-entry/1";

export const WORKSPACE_DISPOSITIONS = Object.freeze([
  "quarantined",
  "takeover",
  "reconciled",
  "prior_host_termination_unverified",
] as const);

export const APPROVAL_REQUEST_KINDS = Object.freeze(["waiver", "amendment"] as const);

/**
 * The maintenance journal's frozen action vocabulary. The sensitive subset
 * (update, rollback, pin, revoke, unrevoke, advance-high-water-mark) is
 * consumable only under a maintenance-lane assertion; first install and
 * installer repair are the operator's own interactive installer acts, and
 * garbage collection removes only unreferenced generations, so none of those
 * three carries one.
 */
export const MAINTENANCE_ACTIONS = Object.freeze([
  "first-install",
  "update",
  "rollback",
  "pin",
  "revoke",
  "unrevoke",
  "advance-high-water-mark",
  "installer-repair",
  "garbage-collection",
] as const);
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];

export const MAINTENANCE_PHASES = Object.freeze(["started", "completed", "recovered"] as const);

/** The multi-phase maintenance actions; every other action records one `completed` entry. */
export const PHASED_MAINTENANCE_ACTIONS = Object.freeze(["update", "rollback"] as const);

/** The frozen retention/export/deletion action vocabulary. */
export const RETENTION_ACTIONS = Object.freeze(["export", "delete"] as const);

/**
 * Termination provenance has two distinct forms, and only ONE of them is
 * expressible. Graceful provenance is a trusted host-runtime lifecycle event
 * at clean end. Crash provenance is structurally unavailable in V1 — no
 * supported host supplies it and no daemon exists to observe it — so the
 * vocabulary carries no discriminator for it and no record can claim one.
 */
export const TERMINATION_PROVENANCE_KINDS = Object.freeze(["graceful"] as const);

/** Whether the host's descendant teardown was verified for this host version. */
export const DESCENDANT_TEARDOWN_STATUSES = Object.freeze(["verified", "unverified"] as const);

/** The two resume positions the capability ladder defines. */
export const RESUME_ELIGIBILITIES = Object.freeze(["same-workspace", "fresh-worktree-only"] as const);

/** Whether the policy required an approval for the action the intent names. */
export const ACTION_APPROVALS = Object.freeze(["required", "not-required"] as const);

/**
 * What the host observed of the external action. `indeterminate` is a first-
 * class outcome, not an error: a lost response leaves an action that may well
 * have happened, and recording that honestly is what keeps it from being
 * repeated.
 */
export const EXTERNAL_ACTION_OUTCOMES = Object.freeze(["succeeded", "failed", "indeterminate"] as const);

/**
 * How the required post-action verification resolved. `not-attempted` means a
 * required check DID NOT RUN — it is never the spelling for "there was nothing
 * to verify", which records `passed`. The reducer reads it that way at both
 * the terminal edge and the next-action edge: an action whose required
 * verification did not run is not reconciled, and the delivery leaves through
 * `blocked` rather than through success or another action.
 */
export const ACTION_VERIFICATIONS = Object.freeze(["passed", "failed", "not-attempted"] as const);

type PayloadCheck = (payload: Record<string, unknown>, at: string, collector: SpineCollector) => void;

const table =
  (rules: readonly MemberRule[]): PayloadCheck =>
  (payload, at, collector) => {
    checkClosed(payload, at, rules, collector);
  };

/** A payload member that embeds another frozen family's value verbatim. */
const embedded =
  (validate: (value: unknown) => SpineVerdict): MemberRule["check"] =>
  (value, at, collector) => {
    const verdict = validate(value);
    if (verdict.ok) return;
    for (const rejection of verdict.rejections) {
      collector.emit(rejection.code, `${at}${rejection.pointer}`, rejection.message);
    }
  };

const confirmationPayload =
  (requiredClass: "contract-confirmation" | "takeover-authorization"): PayloadCheck =>
  (payload, at, collector) => {
    checkClosed(payload, at, [{ name: "confirmation", check: embedded(validateOperatorConfirmation) }], collector);
    const confirmation = payload["confirmation"];
    const declared = confirmationClassOf(confirmation);
    if (declared !== undefined && declared !== requiredClass) {
      collector.emit(
        "unsupported_combination",
        `${at}/confirmation/confirmationClass`,
        `this journal records only ${requiredClass} confirmations; the class scopes the payload to its journal`,
      );
    }
  };

const operationResultPayload: PayloadCheck = (payload, at, collector) => {
  checkClosed(
    payload,
    at,
    [
      { name: "capabilityId", check: spineId },
      { name: "result", check: embedded(validateSensorResult) },
    ],
    collector,
  );
  const result = payload["result"];
  if (isSpineRecord(result) && typeof payload["capabilityId"] === "string" && typeof result["capabilityId"] === "string") {
    if (payload["capabilityId"] !== result["capabilityId"]) {
      collector.emit(
        "unsupported_combination",
        `${at}/capabilityId`,
        "the envelope's capability id and the embedded result's capability id must agree",
      );
    }
  }
};

const TRANSITION_BASE_RULES: readonly MemberRule[] = [
  { name: "from", check: oneOf(DELIVERY_STATES) },
  { name: "to", check: oneOf(DELIVERY_STATES) },
];

const TRANSITION_TRACKED_RULES: readonly MemberRule[] = [
  ...TRANSITION_BASE_RULES,
  {
    name: "trackedRecord",
    check: (value, recordAt, recordCollector) => {
      checkClosed(
        value,
        recordAt,
        [
          { name: "path", check: text },
          { name: "sha256", check: sha256 },
        ],
        recordCollector,
      );
    },
  },
];

const transitionPayload: PayloadCheck = (payload, at, collector) => {
  // The tracked-record journaling rides exactly the recording -> ready edge;
  // on every other transition the member is a stranger and the base table
  // rejects it as unknown.
  const carriesRecord = Object.prototype.hasOwnProperty.call(payload, "trackedRecord");
  checkClosed(payload, at, carriesRecord ? TRANSITION_TRACKED_RULES : TRANSITION_BASE_RULES, collector);
  if (carriesRecord && (payload["from"] !== "recording" || payload["to"] !== "ready")) {
    collector.emit(
      "unsupported_combination",
      `${at}/trackedRecord`,
      "the tracked-record digest rides only the recording -> ready transition",
    );
  }
};

/**
 * `approval.assertion.consumed`: one consumed sensitive-approval assertion,
 * embedded verbatim. The delivery journal homes the delivery-bound and
 * security-blocked-migration classes; a maintenance-lane consumption homes in
 * the maintenance journal and is a stranger here. Only a rebinding migration
 * records a new registering-installation identity; every other consumption
 * records it explicitly absent-by-state.
 */
const assertionConsumedPayload: PayloadCheck = (payload, at, collector) => {
  checkClosed(
    payload,
    at,
    [
      { name: "assertion", check: embedded(validateSensitiveApprovalAssertion) },
      { name: "newRegisteringInstallationId", check: orAbsentByState(spineId) },
    ],
    collector,
  );
  const declaredClass = assertionClassOf(payload["assertion"]);
  if (declaredClass === "maintenance-lane") {
    collector.emit(
      "unsupported_combination",
      `${at}/assertion/assertionClass`,
      "a maintenance-lane consumption is recorded in the maintenance journal, never the delivery journal",
    );
  }
  if (!isAbsentByState(payload["newRegisteringInstallationId"]) && declaredClass !== "security-blocked-migration") {
    collector.emit(
      "unsupported_combination",
      `${at}/newRegisteringInstallationId`,
      "only a rebinding security-blocked migration records a new registering-installation identity",
    );
  }
};

/**
 * `maintenance.action.recorded`: one maintenance-lane operation against the
 * installation, in its frozen action vocabulary. The sensitive actions embed
 * the exact consumed assertion — on `started` for the phased actions, on
 * their sole `completed` entry for the instant trust-state operations — and
 * the embedded assertion must agree with the recorded action and target, so a
 * journal entry can never claim an approval it does not carry.
 */
const maintenanceActionPayload: PayloadCheck = (payload, at, collector) => {
  checkClosed(
    payload,
    at,
    [
      { name: "action", check: oneOf(MAINTENANCE_ACTIONS) },
      { name: "phase", check: oneOf(MAINTENANCE_PHASES) },
      { name: "generationDigest", check: orAbsentByState(sha256) },
      { name: "highWaterMark", check: orAbsentByState(nonNegativeInt) },
      { name: "assertion", check: orAbsentByState(embedded(validateSensitiveApprovalAssertion)) },
    ],
    collector,
  );
  const action = payload["action"];
  const phase = payload["phase"];
  if (typeof action !== "string" || typeof phase !== "string") return;

  const phased = PHASED_MAINTENANCE_ACTIONS.includes(action as never);
  if (!phased && phase === "started") {
    collector.emit("unsupported_combination", `${at}/phase`, `${action} is an instant action; it records one completed entry`);
  }

  const sensitive = SENSITIVE_MAINTENANCE_ACTIONS.includes(action as never);
  const assertionRequired = sensitive && (phased ? phase === "started" : phase === "completed");
  const assertionValue = payload["assertion"];
  const assertionAbsent = assertionValue === undefined || isAbsentByState(assertionValue);
  if (assertionRequired && assertionAbsent) {
    collector.emit(
      "unsupported_combination",
      `${at}/assertion`,
      `the sensitive ${action} action is recorded only under its consumed maintenance-lane assertion`,
    );
  }
  if (!sensitive && !assertionAbsent) {
    collector.emit("unsupported_combination", `${at}/assertion`, `${action} is not in the sensitive set and consumes no assertion`);
  }

  if (!assertionAbsent && isSpineRecord(assertionValue)) {
    if (assertionClassOf(assertionValue) !== "maintenance-lane") {
      collector.emit(
        "unsupported_combination",
        `${at}/assertion/assertionClass`,
        "the maintenance journal records only maintenance-lane consumptions",
      );
    }
    if (assertionValue["action"] !== action) {
      collector.emit("unsupported_combination", `${at}/assertion/action`, "the consumed assertion approves a different action");
    }
    const boundGeneration = assertionValue["targetGenerationDigest"];
    if (typeof boundGeneration === "string" && !isAbsentByState(boundGeneration) && boundGeneration !== payload["generationDigest"]) {
      collector.emit(
        "unsupported_combination",
        `${at}/generationDigest`,
        "the consumed assertion approves a different target generation",
      );
    }
    const boundMark = assertionValue["targetHighWaterMark"];
    if (typeof boundMark === "number" && boundMark !== payload["highWaterMark"]) {
      collector.emit(
        "unsupported_combination",
        `${at}/highWaterMark`,
        "the consumed assertion approves a different high-water mark",
      );
    }
  }
};

/**
 * `termination.provenance.recorded`: the trusted host-runtime lifecycle
 * provenance for one ended invocation. The honesty rule lives in the grammar
 * itself rather than in a caller: an UNVERIFIED descendant teardown may only
 * ever carry fresh-worktree-only resume, so a journal entry cannot record a
 * same-workspace claim the host's graded teardown behavior does not support.
 * A verified teardown may still choose the conservative position.
 */
const terminationProvenancePayload: PayloadCheck = (payload, at, collector) => {
  checkClosed(
    payload,
    at,
    [
      { name: "fence", check: positiveInt },
      { name: "hostVersion", check: text },
      { name: "provenance", check: oneOf(TERMINATION_PROVENANCE_KINDS) },
      { name: "descendantTeardown", check: oneOf(DESCENDANT_TEARDOWN_STATUSES) },
      { name: "resumeEligibility", check: oneOf(RESUME_ELIGIBILITIES) },
    ],
    collector,
  );
  if (payload["descendantTeardown"] === "unverified" && payload["resumeEligibility"] === "same-workspace") {
    collector.emit(
      "unsupported_combination",
      `${at}/resumeEligibility`,
      "same-workspace resume requires verified descendant teardown; an unverified teardown leaves the prior workspace unverified and resumes only into a fresh worktree",
    );
  }
};

/**
 * `contract.amended`: a confirmed outcome amendment or waiver that changed the
 * intended outcome. The whole point of the record is that it creates a NEW
 * contract identity, so an "amendment" whose new identity is the old one
 * rejects — an amendment that changes nothing is not one.
 */
const contractAmendedPayload: PayloadCheck = (payload, at, collector) => {
  checkClosed(
    payload,
    at,
    [
      { name: "previousContractId", check: spineId },
      { name: "contractId", check: spineId },
      { name: "contractDigest", check: sha256 },
      { name: "criterionId", check: spineId },
      { name: "assertionNonce", check: spineId },
    ],
    collector,
  );
  if (typeof payload["contractId"] === "string" && payload["contractId"] === payload["previousContractId"]) {
    collector.emit(
      "unsupported_combination",
      `${at}/contractId`,
      "a confirmed amendment creates a new contract identity; reusing the superseded identity is not an amendment",
    );
  }
};

/**
 * `action.result.recorded`: what the host observed after invoking the action
 * its intent named. PASSING VERIFICATION BELONGS TO A SUCCEEDED ACTION ALONE —
 * a failed or indeterminate action that claimed passing post-action evidence
 * would be a record of success the delivery never had, and the pairing is
 * exactly what separates `completed` from `action_succeeded_verification_failed`.
 */
const actionResultPayload: PayloadCheck = (payload, at, collector) => {
  checkClosed(
    payload,
    at,
    [
      { name: "intentId", check: spineId },
      { name: "action", check: oneOf(EXTERNAL_ACTIONS) },
      { name: "outcome", check: oneOf(EXTERNAL_ACTION_OUTCOMES) },
      { name: "verification", check: oneOf(ACTION_VERIFICATIONS) },
      { name: "externalReference", check: orAbsentByState(boundedText) },
    ],
    collector,
  );
  if (payload["verification"] === "passed" && payload["outcome"] !== "succeeded") {
    collector.emit(
      "unsupported_combination",
      `${at}/verification`,
      "post-action verification passes only over a succeeded action; a failed or indeterminate action carries no passing evidence",
    );
  }
};

/** Payload tables for every ACTIVE (journal, kind) pair — frozen here. */
const PAYLOADS: Readonly<Record<string, PayloadCheck>> = Object.freeze({
  "intake/intake.state.changed": table([
    { name: "from", check: oneOf(INTAKE_STATES) },
    { name: "to", check: oneOf(INTAKE_STATES) },
  ]),
  "intake/operator.confirmation.recorded": confirmationPayload("contract-confirmation"),
  // The iterative-intake payload family, frozen by its owning unit. A
  // clarification is one question-and-answer exchange of the product-owned
  // scope workflow; a draft record retains the current draft contract by
  // digest (the bytes live in the intake namespace; the journal is the audit
  // rail and digest binding). The reducer gates both to the intake states the
  // spine froze as discriminators.
  "intake/intake.clarification.recorded": table([
    { name: "question", check: boundedText },
    { name: "answer", check: boundedText },
  ]),
  "intake/intake.draft.recorded": table([{ name: "draftDigest", check: sha256 }]),
  "delivery/delivery.registered": table([
    { name: "contractDigest", check: sha256 },
    { name: "intakeId", check: spineId },
    { name: "confirmationNonce", check: spineId },
    { name: "activeCompositionProfile", check: text },
    { name: "registeringInstallationId", check: spineId },
  ]),
  "delivery/workspace.bound": table([
    { name: "workspaceId", check: spineId },
    { name: "repositoryId", check: spineId },
    { name: "baseRef", check: text },
    { name: "baseTipSha", check: gitOid },
    { name: "branchRef", check: text },
    { name: "branchRefValue", check: gitOid },
    { name: "worktreeId", check: spineId },
    { name: "baselineClassification", check: oneOf(["clean", "classified"]) },
  ]),
  "delivery/invocation.fenced": table([
    { name: "fence", check: positiveInt },
    { name: "hostTaskId", check: spineId },
    { name: "worktreeId", check: spineId },
    { name: "candidateTreeSha", check: gitOid },
    { name: "candidateBranchRefValue", check: gitOid },
    { name: "policyDigest", check: sha256 },
    { name: "authorityEpoch", check: nonNegativeInt },
    { name: "observationLifetimeSeconds", check: positiveInt },
  ]),
  "delivery/activity.observed": table([
    { name: "activity", check: oneOf(HOST_ACTIVITY_STATES) },
    { name: "fence", check: positiveInt },
  ]),
  "delivery/operator.confirmation.recorded": confirmationPayload("takeover-authorization"),
  "delivery/approval.request.recorded": table([
    { name: "requestKind", check: oneOf(APPROVAL_REQUEST_KINDS) },
    { name: "criterionId", check: spineId },
    { name: "actorId", check: spineId },
    { name: "reason", check: boundedText },
  ]),
  "delivery/operation.result.recorded": operationResultPayload,
  "delivery/workspace.disposition.recorded": table([
    { name: "workspaceId", check: spineId },
    { name: "disposition", check: oneOf(WORKSPACE_DISPOSITIONS) },
  ]),
  "delivery/transition.committed": transitionPayload,
  "delivery/stage.result.recorded": table([
    { name: "stageId", check: spineId },
    { name: "workflowGraphSha256", check: sha256 },
    { name: "resultDigest", check: sha256 },
  ]),
  "delivery/attempt.artifact.recorded": table([
    { name: "attemptId", check: spineId },
    { name: "lensId", check: spineId },
    { name: "contextDigest", check: sha256 },
    { name: "personaDigest", check: sha256 },
    { name: "artifactDigest", check: sha256 },
  ]),
  "delivery/evidence.reference.recorded": table([
    { name: "recordId", check: sha256 },
    { name: "manifestDigest", check: sha256 },
  ]),
  "delivery/candidate.recaptured": table([
    { name: "treeSha", check: gitOid },
    { name: "branchRefValue", check: gitOid },
  ]),
  "delivery/policy.snapshot.bound": table([
    { name: "policyDigest", check: sha256 },
    { name: "repositoryAuthorityEpoch", check: nonNegativeInt },
  ]),
  "delivery/generation.pinned": table([
    { name: "generationDigest", check: sha256 },
    { name: "releaseId", check: spineId },
    { name: "profile", check: text },
  ]),
  "delivery/trust.epoch.observed": table([
    { name: "productTrustEpoch", check: nonNegativeInt },
    { name: "repositoryAuthorityEpoch", check: nonNegativeInt },
  ]),
  "delivery/blocker.recorded": table([
    { name: "code", check: spineId },
    { name: "summary", check: boundedText },
    { name: "providerRunKey", check: sha256, required: false },
  ]),
  "delivery/finish.line.recorded": table([{ name: "result", check: embedded(validateFinishLineResult) }]),
  // The post-action family. The intent is the durable record the host writes
  // BEFORE invoking an authorized external action — it binds the action, the
  // candidate it is taken against, the policy that authorized it, and whether
  // an approval was required — so an action can never be observed without a
  // prior statement of what was about to happen.
  "delivery/action.intent.recorded": table([
    { name: "intentId", check: spineId },
    { name: "action", check: oneOf(EXTERNAL_ACTIONS) },
    {
      name: "candidate",
      check: closed([
        { name: "treeSha", check: gitOid },
        { name: "deliverableDigest", check: sha256 },
      ]),
    },
    { name: "policyDigest", check: sha256 },
    { name: "approval", check: oneOf(ACTION_APPROVALS) },
  ]),
  "delivery/action.result.recorded": actionResultPayload,
  "delivery/termination.provenance.recorded": terminationProvenancePayload,
  "delivery/approval.assertion.consumed": assertionConsumedPayload,
  "delivery/contract.amended": contractAmendedPayload,
  "maintenance/maintenance.action.recorded": maintenanceActionPayload,
  // The retention/export/deletion contract family. The record names its
  // target delivery, digests the produced artifact (the export bundle, or the
  // preserved minimal audit record a deletion leaves behind), and reports
  // which audit records policy required preserving — and it lives in the
  // installation-scoped maintenance journal precisely so it survives the
  // target's removal.
  "maintenance/retention.action.recorded": table([
    { name: "action", check: oneOf(RETENTION_ACTIONS) },
    { name: "subjectDeliveryId", check: spineId },
    { name: "artifactDigest", check: sha256 },
    { name: "preservedAuditRecords", check: stringArray() },
  ]),
});

const ENVELOPE_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(JOURNAL_ENTRY_SPEC) },
  { name: "journal", check: oneOf(JOURNALS) },
  { name: "subjectId", check: spineId },
  { name: "expectedRevision", check: nonNegativeInt },
  { name: "idempotencyKey", check: spineId },
  { name: "kind", check: text },
  // `payload` is validated per (journal, kind) below; its presence rule
  // depends on the kind's classification, so it is not in this table.
];

export function validateJournalEntry(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  if (!isSpineRecord(value)) {
    collector.emit("not_an_object", "", "expected a JSON object");
    return collector.verdict();
  }

  // Closed envelope: `payload` is a defined member, everything else strange
  // rejects.
  const defined = new Set([...ENVELOPE_RULES.map((rule) => rule.name), "payload"]);
  for (const name of Object.keys(value)) {
    if (!defined.has(name)) {
      collector.emit("unknown_member", `/${name}`, "member is not defined by this frozen grammar");
    }
  }
  for (const rule of ENVELOPE_RULES) {
    if (!Object.prototype.hasOwnProperty.call(value, rule.name) || value[rule.name] === undefined) {
      collector.emit("missing_member", `/${rule.name}`, "required member is absent");
      continue;
    }
    rule.check(value[rule.name], `/${rule.name}`, collector);
  }

  const journal = value["journal"];
  const kind = value["kind"];
  if (typeof journal !== "string" || typeof kind !== "string") return collector.verdict();

  const classification = classifyEventKind(journal, kind);
  if (classification.status === "reserved") {
    collector.emit(
      "reserved_kind",
      "/kind",
      `${kind} is reserved in the ${journal} journal until its owning unit defines its payload; it rejects with or without a payload`,
    );
    return collector.verdict();
  }
  if (classification.status === "unknown") {
    const elsewhere = classification.knownIn.length > 0 ? ` (enumerated only in: ${classification.knownIn.join(", ")})` : "";
    collector.emit(
      "unknown_kind",
      "/kind",
      `(${journal}, ${kind}) is outside the frozen event vocabulary${elsewhere}`,
    );
    return collector.verdict();
  }

  const payload = value["payload"];
  if (!isSpineRecord(payload)) {
    collector.emit("missing_member", "/payload", "an active kind requires its frozen payload object");
    return collector.verdict();
  }
  const check = PAYLOADS[`${journal}/${kind}`];
  if (check === undefined) {
    // Unreachable while the payload table covers every active pair; fail
    // closed if the tables ever drift apart.
    collector.emit("unknown_kind", "/kind", `no frozen payload table for active pair (${journal}, ${kind})`);
    return collector.verdict();
  }
  check(payload, "/payload", collector);
  return collector.verdict();
}
