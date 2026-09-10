/**
 * `run-event/1` — the RUN family's closed contract.
 *
 * A SEPARATE FAMILY, NOT SPINE KINDS. The frozen `(journal, kind)` vocabulary
 * is a contract-freeze surface: adding a kind there is a spine revision. Run
 * events are observability — they must never be able to advance or block a
 * delivery — so they get their own version, their own validator, and their own
 * store. What they DO reuse is the spine's closed-grammar machinery
 * (`spine/grammar.ts`), because a second hand-rolled member walker would be a
 * second place for a stranger member to land.
 *
 * ENVELOPE/PAYLOAD AGREEMENT. `ticket` and `candidateTreeSha` appear in the
 * envelope so every reader reads ONE place, and in the payload of the kinds
 * that own them. The two must agree exactly: absent where the payload carries
 * the member, present where the payload does not (on ANY kind, including one
 * whose payload never names it), or differing is a rejection. The check lives
 * here rather than in the emitting command so that every appender — today's
 * `emit`, tomorrow's — is held to it at the store boundary.
 *
 * A RUN MAY CARRY MORE THAN ONE TICKET. A dogfood delivery is the ordinary
 * case: one run, one ticket for the thing being dogfooded and one for the
 * ordinary item it delivered, each with its own posture. So `posture.declared`,
 * `gate.reported`, and `pr.opened` each take an OPTIONAL `ticket`, of the same
 * shape `ticket.read` uses, naming which of the run's tickets the entry belongs
 * to. The member is optional rather than required because binding by adjacency
 * is what every single-ticket journal already does and those journals stay
 * readable: an entry that omits it binds to the run's PRIMARY ticket, which
 * `runPrimaryTicket` below defines. Nothing requires the member — the
 * completeness evaluator does not name it — so adding it opens no journal that
 * was closed and closes none that was open.
 *
 * SELF-ATTESTED. Every event carries `attestation: "self"`. Nothing
 * authoritative reads this family; see the run store's header.
 */

import {
  MAX_FREE_TEXT,
  checkClosed as checkSpineClosed,
  createSpineCollector,
  isSpineRecord,
  spinePointer,
  type MemberCheck,
  type MemberRule,
  type SpineCollector,
  type SpineVerdict,
} from "../spine/grammar.ts";

/** The family's spec string; `version` is the envelope member that carries it. */
export const RUN_EVENT_SPEC = "run-event/1";
export const RUN_EVENT_SPEC_V2 = "run-event/2";
export type RunEventVersion = typeof RUN_EVENT_SPEC | typeof RUN_EVENT_SPEC_V2;

/**
 * Run ids name FILES in the store, so their charset is deliberately narrower
 * than the kernel's `RUN_ID`: no `.`, which keeps `.`, `..`, and a `.jsonl`
 * suffix unconstructible and keeps the notes subdirectory unreachable by id.
 */
export const RUN_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The kernel's existing `RUN_ID` charset and length, reused for `ticket`. */
export const RUN_TICKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A git object id in either object format, lowercase hex only. */
export const RUN_CANDIDATE_TREE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The `PROVIDER_ID` precedent from `artifacts.ts`: bounded charset and length. */
export const RUN_PROVIDER_ID = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
export const MAX_RUN_PROVIDER_ID = 128;

/** A bounded structural label: adopter command names, postures, trackers, hosts. */
export const MAX_RUN_LABEL = 128;

/** Paths and URLs are bounded too — nothing in this family is a dumping ground. */
export const MAX_RUN_PATH = 4096;
export const MAX_RUN_URL = 2048;

/** Lens id lists are bounded: a selection, never a transcript. */
export const MAX_RUN_LENSES = 32;

/**
 * The run family's free-text members: redacted on a secret rather than
 * rejected, exactly as the spine's `summary` and `reason` are. Every OTHER
 * member of this family is structural and rejects on a secret.
 */
export const RUN_FREE_TEXT_MEMBERS: ReadonlySet<string> = new Set(["rationale", "summary", "choice", "cited", "fork", "nextStep", "reason", "nextAction", "scope", "resolution"]);

/** Who wrote the event. The store, not `emit`, decides which role is legal per kind. */
export const RUN_ACTOR_ROLES = Object.freeze(["cli", "executor"] as const);
export type RunActorRole = (typeof RUN_ACTOR_ROLES)[number];

/**
 * `command.completed`'s outcome is a closed enum of the CLI boundary's OWN
 * result categories — the four classes it maps to exit codes (0, 1, 2, 130).
 * It deliberately carries no argv, stdout, stderr, or blocker text.
 */
export const RUN_COMMAND_OUTCOMES = Object.freeze(["ok", "policy", "usage", "interrupted"] as const);
export type RunCommandOutcome = (typeof RUN_COMMAND_OUTCOMES)[number];

/** An adopter whose gate is not a product command reports one of these instead. */
export const RUN_GATE_REPORTED_OUTCOMES = Object.freeze(["pass", "fail", "blocked", "interrupted"] as const);

/** How a run ended. */
export const RUN_ENDED_RESULTS = Object.freeze(["complete", "partial", "blocked"] as const);

/** The v1 kind vocabulary, in the order the plan's payload table states it. */
export const RUN_EVENT_KINDS_V1 = Object.freeze([
  "run.started",
  "run.ended",
  "ticket.read",
  "posture.declared",
  "lens.selected",
  "review.round.opened",
  "review.round.closed",
  "command.completed",
  "gate.reported",
  "pr.opened",
  "blocker.recorded",
  "decision.recorded",
  "compounding.recorded",
  "context.saved",
  "action.intent",
  "action.observed",
] as const);
export const RUN_EVENT_KINDS = Object.freeze([...RUN_EVENT_KINDS_V1,
  "activity.observed", "wait.started", "wait.resolved", "finding.observed",
  "report.referenced", "artifact.referenced", "finish.step.observed",
] as const);
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(RUN_EVENT_KINDS);

export function isRunEventKind(value: unknown): value is RunEventKind {
  return typeof value === "string" && KIND_SET.has(value);
}

// ── Member checks ──────────────────────────────────────────────────────────

const malformed = (collector: SpineCollector, at: string, message: string): void => {
  collector.emit("malformed_member", at, message);
};

/** Closed vocabularies attached to the exact checks the validator executes. */
const CHECK_VALUES = new WeakMap<MemberCheck, readonly string[]>();

/**
 * Applies the spine's closed-object validator while making its active table
 * discoverable in a refusal. This wrapper is deliberately local to run events:
 * their hand-authored payloads are an operator surface, while the other spine
 * families are consumed as typed documents rather than composed at the CLI.
 */
function checkRunClosed(
  value: unknown,
  at: string,
  rules: readonly MemberRule[],
  collector: SpineCollector,
): ReturnType<typeof checkSpineClosed> {
  const accepted = rules.map(rule => rule.name).join(", ");
  return checkSpineClosed(value, at, rules, {
    emit(code, pointer, message) {
      const relative = pointer.startsWith(`${at}/`) ? pointer.slice(at.length + 1) : "";
      const directMember = relative !== "" && !relative.includes("/");
      collector.emit(
        code,
        pointer,
        directMember && (code === "unknown_member" || code === "missing_member")
          ? `${message}; accepted members: ${accepted}`
          : message,
      );
    },
    verdict: () => collector.verdict(),
  });
}

const boundedString =
  (maximum: number, what: string): MemberCheck =>
  (value, at, collector) => {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
      malformed(collector, at, `expected ${what}: a non-empty string of at most ${maximum} characters`);
    }
  };

const patterned =
  (pattern: RegExp, maximum: number, what: string): MemberCheck =>
  (value, at, collector) => {
    if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) {
      malformed(collector, at, `expected ${what}`);
    }
  };

const oneOf = (values: readonly string[]): MemberCheck => {
  const check: MemberCheck = (value, at, collector) => {
    if (typeof value !== "string" || !values.includes(value)) {
      const encoded = at.split("/").at(-1) ?? "member";
      const member = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
      malformed(collector, at, `${member} accepts only: ${values.join(", ")}`);
    }
  };
  CHECK_VALUES.set(check, values);
  return check;
};

const runStoreId = patterned(RUN_STORE_ID, 128, "a run id matching the run-store charset");
const ticketId = patterned(RUN_TICKET, 128, "a ticket identity matching the kernel run-id charset");
const treeSha = patterned(RUN_CANDIDATE_TREE_SHA, 64, "a lowercase-hex git object id of 40 or 64 characters");
const providerId = patterned(RUN_PROVIDER_ID, MAX_RUN_PROVIDER_ID, "a bounded provider-id-shaped identity");
const label = boundedString(MAX_RUN_LABEL, "a bounded label");
const freeText = boundedString(MAX_FREE_TEXT, "bounded free text");

/**
 * A UTC instant, shape-checked only. The store reads no clock (GEN-5); `at` is
 * the writing process's own instant, handed in by the caller.
 */
const RUN_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const instant = patterned(RUN_INSTANT, 20, "a UTC instant of the form YYYY-MM-DDTHH:MM:SSZ");

export function isRunInstant(value: unknown): value is string {
  return typeof value === "string" && RUN_INSTANT.test(value);
}

const nonNegativeInt: MemberCheck = (value, at, collector) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    malformed(collector, at, "expected a non-negative safe integer");
  }
};

const positiveInt: MemberCheck = (value, at, collector) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    malformed(collector, at, "expected a positive safe integer");
  }
};

const idList =
  (maximum: number): MemberCheck =>
  (value, at, collector) => {
    if (!Array.isArray(value) || value.length > maximum) {
      malformed(collector, at, `expected an array of at most ${maximum} bounded ids`);
      return;
    }
    for (const [index, item] of value.entries()) providerId(item, spinePointer(at, index), collector);
  };

/**
 * `http` or `https` only, parsed rather than pattern-matched, so a
 * `javascript:` or `data:` locator can never reach the viewer's renderer.
 */
const httpUrl: MemberCheck = (value, at, collector) => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RUN_URL) {
    malformed(collector, at, `expected a non-empty URL of at most ${MAX_RUN_URL} characters`);
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    malformed(collector, at, "expected an absolute URL");
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    malformed(collector, at, "expected an http or https URL");
  }
};

/** The `delivery-evidence/1` cost shape, reused verbatim: `{unit, total, reportedBy}`. */
const COST_MEMBERS: readonly MemberRule[] = [
  { name: "unit", check: label },
  { name: "total", check: (value, at, collector) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      malformed(collector, at, "expected a finite non-negative number");
    }
  } },
  { name: "reportedBy", check: label },
];

const cost: MemberCheck = (value, at, collector) => {
  // Legacy measured entries stay readable. Unknown coverage carries no numeric
  // total: zero would claim a measurement the host did not make.
  if (isSpineRecord(value) && value["coverage"] === "unreported") {
    checkRunClosed(value, at, [
      { name: "coverage", check: oneOf(["unreported"]) },
      { name: "reportedBy", check: label },
    ], collector);
  } else {
    checkRunClosed(value, at, [...COST_MEMBERS, { name: "coverage", check: oneOf(["complete", "partial"]), required: false }], collector);
  }
};

const digest = patterned(/^[0-9a-f]{64}$/, 64, "a sha256 digest");
const contract: MemberCheck = (value, at, collector) => {
  checkRunClosed(value, at, [
    { name: "objective", check: freeText },
    { name: "finishLine", check: label },
    { name: "acceptanceCriteria", check: (items, pointer, c) => {
      if (!Array.isArray(items) || items.length === 0 || items.length > 32) {
        malformed(c, pointer, "expected 1 to 32 bounded acceptance criteria");
        return;
      }
      items.forEach((item, index) => freeText(item, spinePointer(pointer, index), c));
    } },
  ], collector);
};

const FINDINGS_MEMBERS: readonly MemberRule[] = [
  { name: "P0", check: nonNegativeInt },
  { name: "P1", check: nonNegativeInt },
  { name: "P2", check: nonNegativeInt },
  { name: "P3", check: nonNegativeInt },
];

const findings: MemberCheck = (value, at, collector) => {
  checkRunClosed(value, at, FINDINGS_MEMBERS, collector);
};

const WORKFLOW_MEMBERS: readonly MemberRule[] = [
  { name: "releaseId", check: label },
  { name: "profile", check: label },
];

const workflow: MemberCheck = (value, at, collector) => {
  checkRunClosed(value, at, WORKFLOW_MEMBERS, collector);
};

// ── Payload tables ─────────────────────────────────────────────────────────

const PAYLOAD_MEMBERS: Readonly<Record<(typeof RUN_EVENT_KINDS_V1)[number], readonly MemberRule[]>> = Object.freeze({
  "context.saved": [
    { name: "spec", check: oneOf(["ordinary-run-context/1"]) },
    { name: "contract", check: contract },
    { name: "stage", check: label },
    { name: "candidateTreeSha", check: treeSha },
    { name: "candidateBinding", check: (value, at, c) => void checkRunClosed(value, at, [
      { name: "deliverableDigest", check: digest },
      { name: "identity", check: label },
      { name: "baseRef", check: label },
      { name: "baseTipSha", check: treeSha },
      { name: "mergeBaseSha", check: treeSha },
      { name: "workspaceId", check: label },
    ], c) },
    { name: "policyDigest", check: digest },
    { name: "release", check: (value, at, c) => void checkRunClosed(value, at, [
      { name: "runtimeVersion", check: label },
      { name: "releaseId", check: label },
      { name: "profile", check: label },
      { name: "archiveSha256", check: digest },
    ], c) },
  ],
  "action.intent": [
    { name: "actionId", check: runStoreId },
    { name: "operation", check: label },
    { name: "reference", check: boundedString(MAX_RUN_URL, "a reconciliation reference without credentials") },
  ],
  "action.observed": [
    { name: "actionId", check: runStoreId },
    { name: "outcome", check: oneOf(["succeeded", "failed", "not-performed", "unknown"]) },
    { name: "reference", check: boundedString(MAX_RUN_URL, "an observed reconciliation reference without credentials") },
  ],
  "run.started": [
    { name: "ticket", check: ticketId, required: false },
    { name: "host", check: label },
    { name: "workflow", check: workflow },
    { name: "displacedRunId", check: runStoreId, required: false },
  ],
  "run.ended": [
    { name: "result", check: oneOf(RUN_ENDED_RESULTS) },
    { name: "cost", check: cost },
  ],
  "ticket.read": [
    { name: "ticket", check: ticketId },
    { name: "posture", check: label, required: false },
    { name: "tracker", check: label },
  ],
  "posture.declared": [
    { name: "posture", check: label },
    { name: "ticket", check: ticketId, required: false },
  ],
  "lens.selected": [
    // Arity is deliberately NOT checked here: `mandated-pair-mismatch` is the
    // evaluator's finding, and a pair the validator refused to store could
    // never be found.
    { name: "mandated", check: idList(MAX_RUN_LENSES) },
    { name: "selected", check: idList(MAX_RUN_LENSES) },
    { name: "rationale", check: freeText },
  ],
  "review.round.opened": [
    { name: "round", check: positiveInt },
    { name: "candidateTreeSha", check: treeSha },
    { name: "lenses", check: idList(MAX_RUN_LENSES) },
  ],
  "review.round.closed": [
    { name: "round", check: positiveInt },
    { name: "candidateTreeSha", check: treeSha },
    { name: "outcome", check: label },
    { name: "findings", check: findings },
    { name: "cost", check: cost },
  ],
  "command.completed": [
    { name: "command", check: providerId },
    { name: "outcome", check: oneOf(RUN_COMMAND_OUTCOMES) },
    { name: "durationMs", check: nonNegativeInt },
    { name: "digest", check: patterned(/^[0-9a-f]{64}$/, 64, "a lowercase-hex sha256 digest"), required: false },
  ],
  "gate.reported": [
    { name: "command", check: label },
    { name: "outcome", check: oneOf(RUN_GATE_REPORTED_OUTCOMES) },
    { name: "durationMs", check: nonNegativeInt },
    { name: "ticket", check: ticketId, required: false },
  ],
  "pr.opened": [
    { name: "url", check: httpUrl },
    { name: "candidateTreeSha", check: treeSha },
    { name: "ticket", check: ticketId, required: false },
  ],
  "blocker.recorded": [
    { name: "code", check: label },
    { name: "summary", check: freeText },
  ],
  "decision.recorded": [
    { name: "fork", check: freeText },
    { name: "choice", check: freeText },
    { name: "cited", check: freeText, required: false },
  ],
  "compounding.recorded": [
    { name: "outcome", check: label },
    { name: "reference", check: label, required: false },
  ],
});

/** v2 is opt-in; no new member is admitted under a v1 envelope. */
export const RUN_ACTIVITY_STATES = ["queued", "running", "waiting", "completed", "failed", "interrupted"] as const;
export type RunActivityState = (typeof RUN_ACTIVITY_STATES)[number];
const binding: readonly MemberRule[] = [
  { name: "activityId", check: runStoreId }, { name: "attemptId", check: runStoreId },
  { name: "candidateTreeSha", check: treeSha },
];
const roundBinding: readonly MemberRule[] = [
  { name: "roundId", check: runStoreId, required: false },
  { name: "round", check: positiveInt, required: false },
  { name: "lensId", check: providerId, required: false },
];
const V2_PAYLOAD_MEMBERS: Readonly<Record<RunEventKind, readonly MemberRule[]>> = {
  ...PAYLOAD_MEMBERS,
  "run.started": [...PAYLOAD_MEMBERS["run.started"], { name: "predecessorRunId", check: runStoreId, required: false }],
  "review.round.opened": [...PAYLOAD_MEMBERS["review.round.opened"],
    { name: "roundId", check: runStoreId }, { name: "bound", check: positiveInt, required: false },
    { name: "grace", check: (v,a,c) => { if(typeof v !== "boolean") malformed(c,a,"expected a boolean"); }, required: false },
    { name: "reopensRoundId", check: runStoreId, required: false }],
  "review.round.closed": [...PAYLOAD_MEMBERS["review.round.closed"], { name: "roundId", check: runStoreId }],
  "activity.observed": [...binding, ...roundBinding,
    { name: "state", check: oneOf(RUN_ACTIVITY_STATES) },
    { name: "owner", check: label }, { name: "phase", check: label },
    { name: "supersedesAttemptId", check: runStoreId, required: false },
    { name: "nextStep", check: freeText, required: false },
    { name: "verdict", check: oneOf(["approved", "changes-requested", "unknown"]), required: false },
    { name: "cost", check: cost, required: false }],
  "wait.started": [...binding,
    { name: "waitId", check: runStoreId }, { name: "owner", check: label },
    { name: "waitingOn", check: oneOf(["human", "agent", "external", "unknown"]) },
    { name: "reason", check: freeText }, { name: "nextAction", check: freeText },
    { name: "scope", check: freeText }, { name: "reference", check: httpUrl, required: false }],
  "wait.resolved": [...binding, { name: "waitId", check: runStoreId },
    { name: "resolution", check: freeText }, { name: "scope", check: freeText }],
  "finding.observed": [...binding, ...roundBinding,
    { name: "findingId", check: runStoreId }, { name: "reportId", check: runStoreId },
    { name: "state", check: oneOf(["unresolved", "resolved", "deferred"]) },
    { name: "severity", check: oneOf(["P0", "P1", "P2", "P3"]) },
    { name: "deferredIssueId", check: ticketId, required: false }],
  "report.referenced": [...binding, ...roundBinding,
    { name: "reportId", check: runStoreId }, { name: "role", check: oneOf(["review", "reduction", "clarification", "partial-output"]) },
    { name: "artifactId", check: runStoreId, required: false },
    { name: "originatingReportId", check: runStoreId, required: false },
    { name: "findingId", check: runStoreId, required: false },
    { name: "availability", check: oneOf(["referenced", "unavailable"]) },
    { name: "reason", check: freeText, required: false }],
  "artifact.referenced": [...binding, ...roundBinding,
    { name: "artifactId", check: runStoreId }, { name: "digest", check: digest },
    { name: "sizeBytes", check: nonNegativeInt }, { name: "mediaType", check: label },
    { name: "producer", check: providerId }],
  "finish.step.observed": [ { name: "stepId", check: runStoreId },
    { name: "candidateTreeSha", check: treeSha }, { name: "name", check: label },
    { name: "state", check: oneOf(["pending", "running", "completed", "deferred", "unknown"]) },
    { name: "owner", check: label }, { name: "reason", check: freeText, required: false }],
};

export const RUN_EVENT_PAYLOAD_GRAMMAR_SPEC = "run-event-payload-grammar/1";

export interface RunEventPayloadMemberGrammar {
  readonly name: string;
  readonly required: boolean;
  readonly values?: readonly string[];
}

export interface RunEventPayloadGrammar {
  readonly spec: typeof RUN_EVENT_PAYLOAD_GRAMMAR_SPEC;
  readonly version: RunEventVersion;
  readonly kind: RunEventKind;
  readonly members: readonly RunEventPayloadMemberGrammar[];
}

/**
 * Describes the exact top-level payload table the validator selects. Enum
 * values come from the same `oneOf` check instance, so this read surface cannot
 * drift into a second remembered vocabulary.
 */
export function describeRunEventPayload(kind: string, version: RunEventVersion): RunEventPayloadGrammar | undefined {
  if (!isRunEventKind(kind)) return undefined;
  if (version === RUN_EVENT_SPEC && !(RUN_EVENT_KINDS_V1 as readonly string[]).includes(kind)) return undefined;
  const rules = version === RUN_EVENT_SPEC_V2
    ? V2_PAYLOAD_MEMBERS[kind]
    : PAYLOAD_MEMBERS[kind as (typeof RUN_EVENT_KINDS_V1)[number]];
  return {
    spec: RUN_EVENT_PAYLOAD_GRAMMAR_SPEC,
    version,
    kind,
    members: rules.map(rule => {
      const values = CHECK_VALUES.get(rule.check);
      return { name: rule.name, required: rule.required !== false, ...(values === undefined ? {} : { values: [...values] }) };
    }),
  };
}

/** The kinds whose payload owns each envelope-mirrored member. */
const MIRRORED_MEMBERS = Object.freeze(["ticket", "candidateTreeSha"] as const);

// ── Envelope ───────────────────────────────────────────────────────────────

const REPO_MEMBERS: readonly MemberRule[] = [
  { name: "commonDir", check: boundedString(MAX_RUN_PATH, "an absolute common-directory path") },
  { name: "remote", check: boundedString(MAX_RUN_URL, "a remote locator"), required: false },
];

const ACTOR_MEMBERS: readonly MemberRule[] = [
  { name: "role", check: oneOf(RUN_ACTOR_ROLES) },
  { name: "id", check: providerId, required: false },
];

function envelopeMembers(withSeq: boolean, v2: boolean): readonly MemberRule[] {
  return [
    { name: "version", check: oneOf([RUN_EVENT_SPEC, RUN_EVENT_SPEC_V2]) },
    ...(v2 ? [{ name: "eventId", check: runStoreId }] : []),
    { name: "runId", check: runStoreId },
    ...(withSeq ? [{ name: "seq", check: positiveInt }] : []),
    { name: "at", check: instant },
    { name: "repo", check: (value, at, collector) => void checkRunClosed(value, at, REPO_MEMBERS, collector) },
    { name: "kind", check: oneOf(RUN_EVENT_KINDS) },
    { name: "actor", check: (value, at, collector) => void checkRunClosed(value, at, ACTOR_MEMBERS, collector) },
    { name: "ticket", check: ticketId, required: false },
    { name: "candidateTreeSha", check: treeSha, required: false },
    { name: "attestation", check: oneOf(["self"]) },
    { name: "payload", check: () => undefined },
  ];
}

export interface RunEventRepo {
  readonly commonDir: string;
  readonly remote?: string;
}

export interface RunEventActor {
  readonly role: RunActorRole;
  readonly id?: string;
}

/** The envelope as it reaches the store: `seq` is the store's to assign. */
export interface RunEventInput {
  readonly version: RunEventVersion;
  readonly eventId?: string;
  readonly runId: string;
  readonly at: string;
  readonly repo: RunEventRepo;
  readonly kind: RunEventKind;
  readonly actor: RunEventActor;
  readonly ticket?: string;
  readonly candidateTreeSha?: string;
  readonly attestation: "self";
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A durable event: the input plus the store-assigned sequence number. */
export interface RunEvent extends RunEventInput {
  readonly seq: number;
}

/**
 * Validates one run event. `seq` is required unless the caller says the store
 * has not assigned it yet.
 *
 * ORDER IS LOAD-BEARING: an unknown kind is reported AS an unknown kind and
 * its payload is not walked, so a hostile payload can never dilute the one
 * diagnostic that names what was actually wrong.
 */
export function validateRunEvent(value: unknown, options: { readonly seqAssigned?: boolean } = {}): SpineVerdict {
  const collector = createSpineCollector();
  const withSeq = options.seqAssigned !== false;

  if (!isSpineRecord(value)) {
    collector.emit("not_an_object", "", "expected a JSON object");
    return collector.verdict();
  }
  const v2 = value["version"] === RUN_EVENT_SPEC_V2;
  if (value["version"] !== RUN_EVENT_SPEC && !v2) {
    collector.emit("unsupported_spec", "/version", `expected exactly ${JSON.stringify(RUN_EVENT_SPEC)}`);
    return collector.verdict();
  }
  const kind = value["kind"];
  if (!isRunEventKind(kind) || (!v2 && !(RUN_EVENT_KINDS_V1 as readonly string[]).includes(kind))) {
    collector.emit("unknown_kind", "/kind", "kind is not defined by the run-event/1 vocabulary");
    return collector.verdict();
  }

  checkRunClosed(value, "", envelopeMembers(withSeq, v2), collector);
  const payload = value["payload"];
  checkRunClosed(payload, "/payload", v2 ? V2_PAYLOAD_MEMBERS[kind] : PAYLOAD_MEMBERS[kind as (typeof RUN_EVENT_KINDS_V1)[number]], collector);
  if (v2 && isSpineRecord(payload)) {
    if (payload["lensId"] !== undefined && (payload["roundId"] === undefined || payload["round"] === undefined)) {
      collector.emit("unsupported_combination", "/payload/lensId", "a review lens requires roundId and round");
    }
    if (kind === "finding.observed" && payload["state"] === "deferred" && payload["deferredIssueId"] === undefined) {
      collector.emit("unsupported_combination", "/payload/deferredIssueId", "a deferred finding requires its follow-up issue");
    }
    if (kind === "report.referenced" && (payload["availability"] === "referenced" ? payload["artifactId"] === undefined : payload["reason"] === undefined)) {
      collector.emit("unsupported_combination", "/payload/availability", "a referenced report requires artifactId; unavailable output requires reason");
    }
  }

  // The envelope is what every reader reads; the payload is what the emitter
  // wrote. They agree exactly, on every kind, or the event is not admissible.
  if (isSpineRecord(payload)) {
    for (const member of MIRRORED_MEMBERS) {
      const inPayload = Object.prototype.hasOwnProperty.call(payload, member) ? payload[member] : undefined;
      const inEnvelope = Object.prototype.hasOwnProperty.call(value, member) ? value[member] : undefined;
      if (inPayload === undefined && inEnvelope === undefined) continue;
      if (inPayload === undefined) {
        collector.emit(
          "unsupported_combination",
          spinePointer("", member),
          `the envelope carries ${member} but this kind's payload does not; the two must agree exactly`,
        );
        continue;
      }
      if (inEnvelope === undefined) {
        collector.emit(
          "unsupported_combination",
          spinePointer("", member),
          `the payload carries ${member} but the envelope does not; the two must agree exactly`,
        );
        continue;
      }
      if (inEnvelope !== inPayload) {
        collector.emit(
          "unsupported_combination",
          spinePointer("", member),
          `the envelope's ${member} differs from the payload's; the two must agree exactly`,
        );
      }
    }
  }

  return collector.verdict();
}

/**
 * The run's primary ticket: the first ticket the journal names, in `seq` order.
 *
 * WHY THE FIRST, AND WHY FROM THE ENVELOPE. A run that carries more than one
 * `ticket.read` needs one of them to be the ticket the run is ABOUT — the one
 * a runs table names in its row and the one an entry that omits `ticket` binds
 * to. Order is the only thing that distinguishes them without asking the
 * executor to declare a primary it could get wrong, so the first wins. The
 * envelope is what is read rather than each kind's payload, for the same
 * reason every other reader reads it: the validator holds the two to exact
 * agreement, so the envelope is the ONE place a ticket lives whatever kind
 * carries it — `run.started`'s when a run named its ticket at the start, the
 * first `ticket.read`'s otherwise.
 *
 * `undefined` for a journal that names no ticket at all, which is an ordinary
 * run rather than a defect: nothing in the family requires one.
 */
export function runPrimaryTicket(events: readonly RunEvent[]): string | undefined {
  for (const event of events) {
    if (event.ticket !== undefined) return event.ticket;
  }
  return undefined;
}

/** The store's own entry point: an event whose `seq` it has not assigned yet. */
export function validateRunEventInput(value: unknown): SpineVerdict {
  return validateRunEvent(value, { seqAssigned: false });
}

/**
 * Reduces an arbitrary string to what a note may carry for a rejected kind:
 * the `PROVIDER_ID` charset and length, so an unbounded or hostile kind string
 * never becomes durable and never reaches the viewer.
 */
export function reduceToProviderId(value: string): string {
  const reduced = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/[._-]{2,}/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, MAX_RUN_PROVIDER_ID)
    .replace(/[._-]+$/, "");
  return reduced.length > 0 ? reduced : "unknown";
}
