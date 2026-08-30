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
import { validateSensorResult } from "./capability.ts";
import { confirmationClassOf, validateOperatorConfirmation } from "./confirmation.ts";
import { validateFinishLineResult } from "./finish-line.ts";
import {
  boundedText,
  checkClosed,
  createSpineCollector,
  gitOid,
  isSpineRecord,
  nonNegativeInt,
  oneOf,
  positiveInt,
  sha256,
  specLiteral,
  spineId,
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

/** Payload tables for every ACTIVE (journal, kind) pair — frozen here. */
const PAYLOADS: Readonly<Record<string, PayloadCheck>> = Object.freeze({
  "intake/intake.state.changed": table([
    { name: "from", check: oneOf(INTAKE_STATES) },
    { name: "to", check: oneOf(INTAKE_STATES) },
  ]),
  "intake/operator.confirmation.recorded": confirmationPayload("contract-confirmation"),
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
  ]),
  "delivery/finish.line.recorded": table([{ name: "result", check: embedded(validateFinishLineResult) }]),
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
