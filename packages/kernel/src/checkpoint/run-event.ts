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

/** Successful prepare's actual check decision; absence means unreported. */
export type RunPreparationObservation =
  | { readonly checks: "executed"; readonly reason: "ordinary" | "receipt-not-reusable" | "preparation-fingerprint-changed" }
  | { readonly checks: "reused"; readonly reason: "validation-equivalent" };

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

/**
 * The described shape of each member check, keyed on the exact check INSTANCE
 * the validator runs. Member names and requiredness alone left a caller
 * guessing at value types, nested tables and array items, which is what made
 * `workflow` discoverable only by being refused (V26-2039) and `cited`
 * discoverable only by supplying an array (V26-2058). Keying on the instance is
 * what keeps this a projection of the active table rather than a second
 * remembered vocabulary: a check nobody described is not describable at all,
 * and every described example is walked by the same validator that refuses
 * everything else.
 *
 * The registration is a THUNK because a nested table describes its own members,
 * and a shape computed while this module is still initialising would read a
 * check that does not exist yet. Every call rebuilds the whole document, so a
 * consumer that mutates what it was handed cannot reach the next reader.
 */
const CHECK_SHAPES = new WeakMap<MemberCheck, () => RunEventValueGrammar>();

/** A member rule plus the concrete example the grammar publishes for it. */
interface RunMemberRule extends MemberRule {
  /** Overrides the check's generic example where a concrete one reads better. */
  readonly example?: unknown;
}

function describedAs(check: MemberCheck, shape: () => RunEventValueGrammar): MemberCheck {
  CHECK_SHAPES.set(check, shape);
  return check;
}

function describeValue(check: MemberCheck, at: string): RunEventValueGrammar {
  const shape = CHECK_SHAPES.get(check);
  if (shape === undefined) throw new Error(`run-event grammar: ${at} has no described shape`);
  return shape();
}

function describeMembers(rules: readonly RunMemberRule[], at: string): readonly RunEventPayloadMemberGrammar[] {
  return rules.map(rule => ({
    name: rule.name,
    required: rule.required !== false,
    ...describeValue(rule.check, `${at}.${rule.name}`),
    ...(rule.example === undefined ? {} : { example: rule.example }),
  }));
}

/**
 * The minimal payload: every required member at its own described example, plus
 * any member `alsoRequired` names — the optional members a combination rule
 * makes mandatory for the values published here.
 */
function exampleOf(rules: readonly RunMemberRule[], at: string, alsoRequired: readonly string[] = []): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const member of describeMembers(rules, at)) {
    if (member.required || alsoRequired.includes(member.name)) example[member.name] = member.example;
  }
  return example;
}

function describeTable(rules: readonly RunMemberRule[], at: string, constraint: string): RunEventValueGrammar {
  return { type: "object", constraint, members: describeMembers(rules, at), example: exampleOf(rules, at) };
}

/** A closed nested table, described by the same rules the validator walks. */
function closedObject(rules: readonly RunMemberRule[], what: string): MemberCheck {
  return describedAs(
    (value, at, collector) => void checkRunClosed(value, at, rules, collector),
    () => describeTable(rules, what, `a ${what} object`),
  );
}

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
      // A non-object supplied where a closed table belongs is the other way a
      // caller meets this table, and naming the members there is what turns
      // `not_an_object at /payload/workflow` into something constructible.
      const namesTheTable = (directMember && (code === "unknown_member" || code === "missing_member"))
        || (code === "not_an_object" && pointer === at);
      collector.emit(code, pointer, namesTheTable ? `${message}; accepted members: ${accepted}` : message);
    },
    verdict: () => collector.verdict(),
  });
}

const boundedString = (maximum: number, what: string, example: string): MemberCheck =>
  describedAs(
    (value, at, collector) => {
      if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
        malformed(collector, at, `expected ${what}: a non-empty string of at most ${maximum} characters`);
      }
    },
    () => ({ type: "string", constraint: `${what}: a non-empty string of at most ${maximum} characters`, example }),
  );

const patterned = (pattern: RegExp, maximum: number, what: string, example: string): MemberCheck =>
  describedAs(
    (value, at, collector) => {
      if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) {
        malformed(collector, at, `expected ${what}`);
      }
    },
    () => ({ type: "string", constraint: `${what}, matching ${pattern.source}`, example }),
  );

const oneOf = (values: readonly string[]): MemberCheck =>
  describedAs(
    (value, at, collector) => {
      if (typeof value !== "string" || !values.includes(value)) {
        const encoded = at.split("/").at(-1) ?? "member";
        const member = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
        malformed(collector, at, `${member} accepts only: ${values.join(", ")}`);
      }
    },
    () => ({ type: "string", constraint: "one of a closed vocabulary", values: [...values], example: values[0]! }),
  );

const runStoreId = patterned(RUN_STORE_ID, 128, "a run id matching the run-store charset", "id-1");
const ticketId = patterned(RUN_TICKET, 128, "a ticket identity matching the kernel run-id charset", "V26-0000");
const treeSha = patterned(RUN_CANDIDATE_TREE_SHA, 64, "a lowercase-hex git object id of 40 or 64 characters", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4");
const providerId = patterned(RUN_PROVIDER_ID, MAX_RUN_PROVIDER_ID, "a bounded provider-id-shaped identity", "delivery-harness.prepare");
const label = boundedString(MAX_RUN_LABEL, "a bounded label", "a-bounded-label");
const freeText = boundedString(MAX_FREE_TEXT, "bounded free text", "one bounded sentence");

/**
 * A UTC instant, shape-checked only. The store reads no clock (GEN-5); `at` is
 * the writing process's own instant, handed in by the caller.
 */
const RUN_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const instant = patterned(RUN_INSTANT, 20, "a UTC instant of the form YYYY-MM-DDTHH:MM:SSZ", "2026-01-01T00:00:00Z");

export function isRunInstant(value: unknown): value is string {
  return typeof value === "string" && RUN_INSTANT.test(value);
}

const nonNegativeInt: MemberCheck = describedAs(
  (value, at, collector) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      malformed(collector, at, "expected a non-negative safe integer");
    }
  },
  () => ({ type: "number", constraint: "a non-negative safe integer", example: 0 }),
);

const positiveInt: MemberCheck = describedAs(
  (value, at, collector) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      malformed(collector, at, "expected a positive safe integer");
    }
  },
  () => ({ type: "number", constraint: "a positive safe integer", example: 1 }),
);

const booleanValue: MemberCheck = describedAs(
  (value, at, collector) => {
    if (typeof value !== "boolean") malformed(collector, at, "expected a boolean");
  },
  () => ({ type: "boolean", constraint: "true or false", example: true }),
);

const idList = (maximum: number, example: readonly string[]): MemberCheck =>
  describedAs(
    (value, at, collector) => {
      if (!Array.isArray(value) || value.length > maximum) {
        malformed(collector, at, `expected an array of at most ${maximum} bounded ids`);
        return;
      }
      for (const [index, item] of value.entries()) providerId(item, spinePointer(at, index), collector);
    },
    () => ({
      type: "array",
      constraint: `an array of at most ${maximum} bounded ids`,
      items: describeValue(providerId, "id"),
      example: [...example],
    }),
  );

/**
 * `http` or `https` only, parsed rather than pattern-matched, so a
 * `javascript:` or `data:` locator can never reach the viewer's renderer.
 */
const httpUrl: MemberCheck = describedAs(
  (value, at, collector) => {
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
  },
  () => ({
    type: "string",
    constraint: `an absolute http or https URL of at most ${MAX_RUN_URL} characters`,
    example: "https://github.com/example/repository/pull/1",
  }),
);

const finiteNonNegative: MemberCheck = describedAs(
  (value, at, collector) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      malformed(collector, at, "expected a finite non-negative number");
    }
  },
  () => ({ type: "number", constraint: "a finite non-negative number", example: 0 }),
);

/** The `delivery-evidence/1` cost shape, reused verbatim: `{unit, total, reportedBy}`. */
const COST_MEMBERS: readonly RunMemberRule[] = [
  { name: "unit", check: label, example: "subagent-tokens" },
  { name: "total", check: finiteNonNegative, example: 152352 },
  { name: "reportedBy", check: label, example: "claude-code" },
];

/**
 * Unknown coverage carries no numeric total: zero would claim a measurement the
 * host did not make. Both arms are member tables rather than inline literals so
 * the grammar's two variants are the two tables the validator actually walks.
 */
const UNREPORTED_COST_MEMBERS: readonly RunMemberRule[] = [
  { name: "coverage", check: oneOf(["unreported"]) },
  { name: "reportedBy", check: label, example: "claude-code" },
];
const MEASURED_COST_MEMBERS: readonly RunMemberRule[] = [
  ...COST_MEMBERS,
  { name: "coverage", check: oneOf(["complete", "partial"]), required: false },
];

const cost: MemberCheck = describedAs(
  (value, at, collector) => {
    // Legacy measured entries stay readable.
    checkRunClosed(value, at, isSpineRecord(value) && value["coverage"] === "unreported"
      ? UNREPORTED_COST_MEMBERS
      : MEASURED_COST_MEMBERS, collector);
  },
  () => ({
    type: "object",
    constraint: "a cost: an unreported coverage, or a measured unit and total",
    variants: [
      describeTable(UNREPORTED_COST_MEMBERS, "cost", "coverage \"unreported\": the host metered nothing, so no total is written"),
      describeTable(MEASURED_COST_MEMBERS, "cost", "a measured cost, whose coverage is complete or partial when stated"),
    ],
    example: exampleOf(UNREPORTED_COST_MEMBERS, "cost"),
  }),
);

const digest = patterned(/^[0-9a-f]{64}$/, 64, "a sha256 digest", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

const acceptanceCriteria: MemberCheck = describedAs(
  (items, pointer, c) => {
    if (!Array.isArray(items) || items.length === 0 || items.length > 32) {
      malformed(c, pointer, "expected 1 to 32 bounded acceptance criteria");
      return;
    }
    items.forEach((item, index) => freeText(item, spinePointer(pointer, index), c));
  },
  () => ({
    type: "array",
    constraint: "1 to 32 bounded acceptance criteria",
    items: describeValue(freeText, "acceptanceCriteria item"),
    example: ["the repository gate is green"],
  }),
);

const CONTRACT_MEMBERS: readonly RunMemberRule[] = [
  { name: "objective", check: freeText, example: "what this delivery is for" },
  { name: "finishLine", check: label, example: "merge-ready" },
  { name: "acceptanceCriteria", check: acceptanceCriteria },
];
const contract: MemberCheck = closedObject(CONTRACT_MEMBERS, "contract");

const FINDINGS_MEMBERS: readonly RunMemberRule[] = [
  { name: "P0", check: nonNegativeInt },
  { name: "P1", check: nonNegativeInt },
  { name: "P2", check: nonNegativeInt },
  { name: "P3", check: nonNegativeInt },
];

const findings: MemberCheck = closedObject(FINDINGS_MEMBERS, "findings");

const WORKFLOW_MEMBERS: readonly RunMemberRule[] = [
  { name: "releaseId", check: label, example: "linear-concurrent-delivery-v1" },
  { name: "profile", check: label, example: "linear" },
];

const workflow: MemberCheck = closedObject(WORKFLOW_MEMBERS, "workflow");

/**
 * `reason`'s vocabulary depends on `checks`, so the grammar publishes the two
 * arms as variants built by this same factory: the validator and the discovery
 * surface cannot disagree about which reason belongs to which decision.
 */
const preparationMembers = (reused: boolean): readonly RunMemberRule[] => [
  { name: "checks", check: oneOf(["executed", "reused"]), example: reused ? "reused" : "executed" },
  { name: "reason", check: oneOf(reused
    ? ["validation-equivalent"]
    : ["ordinary", "receipt-not-reusable", "preparation-fingerprint-changed"]) },
];

const preparation: MemberCheck = describedAs(
  (value, at, collector) => {
    checkRunClosed(value, at, preparationMembers(isSpineRecord(value) && value["checks"] === "reused"), collector);
  },
  () => ({
    type: "object",
    constraint: "a preparation observation; reason's vocabulary follows checks",
    variants: [
      describeTable(preparationMembers(false), "preparation", "checks \"executed\": the configured checks ran"),
      describeTable(preparationMembers(true), "preparation", "checks \"reused\": a validation-equivalent receipt was reused"),
    ],
    example: exampleOf(preparationMembers(false), "preparation"),
  }),
);

// ── Payload tables ─────────────────────────────────────────────────────────

/**
 * The two lens ids the delivery product ships, published as the example value
 * for every lens-id list. An adopter's own selection is policy, not grammar.
 */
const LENS_IDS: readonly string[] = ["lens.outcome-correctness", "lens.adversarial-testing"];

const CANDIDATE_BINDING_MEMBERS: readonly RunMemberRule[] = [
  { name: "deliverableDigest", check: digest },
  { name: "identity", check: label, example: "delivery-harness.pr-admission" },
  { name: "baseRef", check: label, example: "origin/main" },
  { name: "baseTipSha", check: treeSha },
  { name: "mergeBaseSha", check: treeSha },
  { name: "workspaceId", check: label, example: "agent-delivery-harness" },
];

const RELEASE_MEMBERS: readonly RunMemberRule[] = [
  { name: "runtimeVersion", check: label, example: "1" },
  { name: "releaseId", check: label, example: "linear-concurrent-delivery-v1" },
  { name: "profile", check: label, example: "linear" },
  { name: "archiveSha256", check: digest },
];

const PAYLOAD_MEMBERS: Readonly<Record<(typeof RUN_EVENT_KINDS_V1)[number], readonly RunMemberRule[]>> = Object.freeze({
  "context.saved": [
    { name: "spec", check: oneOf(["ordinary-run-context/1"]) },
    { name: "contract", check: contract },
    { name: "stage", check: label, example: "implement" },
    { name: "candidateTreeSha", check: treeSha },
    { name: "candidateBinding", check: closedObject(CANDIDATE_BINDING_MEMBERS, "candidateBinding") },
    { name: "policyDigest", check: digest },
    { name: "release", check: closedObject(RELEASE_MEMBERS, "release") },
  ],
  "action.intent": [
    { name: "actionId", check: runStoreId, example: "action-1" },
    { name: "operation", check: label, example: "tracker.update-status" },
    { name: "reference", check: boundedString(MAX_RUN_URL, "a reconciliation reference without credentials", "tracker:V26-0000#status") },
  ],
  "action.observed": [
    { name: "actionId", check: runStoreId, example: "action-1" },
    { name: "outcome", check: oneOf(["succeeded", "failed", "not-performed", "unknown"]) },
    { name: "reference", check: boundedString(MAX_RUN_URL, "an observed reconciliation reference without credentials", "tracker:V26-0000#status") },
  ],
  "run.started": [
    { name: "ticket", check: ticketId, required: false },
    { name: "host", check: label, example: "claude-code" },
    { name: "workflow", check: workflow },
    { name: "displacedRunId", check: runStoreId, required: false, example: "run-0000000000000000" },
  ],
  "run.ended": [
    { name: "result", check: oneOf(RUN_ENDED_RESULTS) },
    { name: "cost", check: cost },
  ],
  "ticket.read": [
    { name: "ticket", check: ticketId },
    { name: "posture", check: label, required: false, example: "test-first" },
    { name: "tracker", check: label, example: "linear" },
  ],
  "posture.declared": [
    { name: "posture", check: label, example: "test-first" },
    { name: "ticket", check: ticketId, required: false },
  ],
  "lens.selected": [
    // Arity is deliberately NOT checked here: `mandated-pair-mismatch` is the
    // evaluator's finding, and a pair the validator refused to store could
    // never be found.
    { name: "mandated", check: idList(MAX_RUN_LENSES, LENS_IDS) },
    { name: "selected", check: idList(MAX_RUN_LENSES, LENS_IDS) },
    { name: "rationale", check: freeText, example: "the repository-mandated pair only" },
  ],
  "review.round.opened": [
    { name: "round", check: positiveInt },
    { name: "candidateTreeSha", check: treeSha },
    { name: "lenses", check: idList(MAX_RUN_LENSES, LENS_IDS) },
  ],
  "review.round.closed": [
    { name: "round", check: positiveInt },
    { name: "candidateTreeSha", check: treeSha },
    { name: "outcome", check: label, example: "aligned" },
    { name: "findings", check: findings },
    { name: "cost", check: cost },
  ],
  "command.completed": [
    { name: "command", check: providerId, example: "prepare" },
    { name: "outcome", check: oneOf(RUN_COMMAND_OUTCOMES) },
    { name: "durationMs", check: nonNegativeInt },
    { name: "digest", check: patterned(/^[0-9a-f]{64}$/, 64, "a lowercase-hex sha256 digest", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), required: false },
  ],
  "gate.reported": [
    { name: "command", check: label, example: "npm run check" },
    { name: "outcome", check: oneOf(RUN_GATE_REPORTED_OUTCOMES) },
    { name: "durationMs", check: nonNegativeInt, example: 615000 },
    { name: "ticket", check: ticketId, required: false },
  ],
  "pr.opened": [
    { name: "url", check: httpUrl },
    { name: "candidateTreeSha", check: treeSha },
    { name: "ticket", check: ticketId, required: false },
  ],
  "blocker.recorded": [
    { name: "code", check: label, example: "review.loop-bound-reached" },
    { name: "summary", check: freeText, example: "what is open, in one bounded sentence" },
  ],
  "decision.recorded": [
    { name: "fork", check: freeText, example: "the fork this delivery resolved by judgement" },
    { name: "choice", check: freeText, example: "the choice made, and why" },
    { name: "cited", check: freeText, required: false, example: "V26-0000" },
  ],
  "compounding.recorded": [
    { name: "outcome", check: label, example: "no-durable-learning" },
    { name: "reference", check: label, required: false, example: "docs/solutions/example.md" },
  ],
});

/** v2 is opt-in; no new member is admitted under a v1 envelope. */
export const RUN_ACTIVITY_STATES = ["queued", "running", "waiting", "completed", "failed", "interrupted"] as const;
export type RunActivityState = (typeof RUN_ACTIVITY_STATES)[number];
const binding: readonly RunMemberRule[] = [
  { name: "activityId", check: runStoreId, example: "activity-1" }, { name: "attemptId", check: runStoreId, example: "attempt-1" },
  { name: "candidateTreeSha", check: treeSha },
];
const roundBinding: readonly RunMemberRule[] = [
  { name: "roundId", check: runStoreId, required: false, example: "round-1" },
  { name: "round", check: positiveInt, required: false },
  { name: "lensId", check: providerId, required: false, example: "lens.outcome-correctness" },
];
const V2_PAYLOAD_MEMBERS: Readonly<Record<RunEventKind, readonly RunMemberRule[]>> = {
  ...PAYLOAD_MEMBERS,
  "command.completed": [...PAYLOAD_MEMBERS["command.completed"], { name: "preparation", check: preparation, required: false }],
  "run.started": [...PAYLOAD_MEMBERS["run.started"], { name: "predecessorRunId", check: runStoreId, required: false, example: "run-0000000000000000" }],
  "review.round.opened": [...PAYLOAD_MEMBERS["review.round.opened"],
    { name: "roundId", check: runStoreId, example: "round-1" }, { name: "bound", check: positiveInt, required: false, example: 4 },
    { name: "grace", check: booleanValue, required: false, example: false },
    { name: "reopensRoundId", check: runStoreId, required: false, example: "round-1" }],
  "review.round.closed": [...PAYLOAD_MEMBERS["review.round.closed"], { name: "roundId", check: runStoreId, example: "round-1" }],
  "activity.observed": [...binding, ...roundBinding,
    { name: "state", check: oneOf(RUN_ACTIVITY_STATES) },
    { name: "owner", check: label, example: "claude-code" }, { name: "phase", check: label, example: "review" },
    { name: "supersedesAttemptId", check: runStoreId, required: false, example: "attempt-0" },
    { name: "nextStep", check: freeText, required: false, example: "what happens after this activity" },
    { name: "verdict", check: oneOf(["approved", "changes-requested", "unknown"]), required: false },
    { name: "cost", check: cost, required: false }],
  "wait.started": [...binding,
    { name: "waitId", check: runStoreId, example: "wait-1" }, { name: "owner", check: label, example: "claude-code" },
    { name: "waitingOn", check: oneOf(["human", "agent", "external", "unknown"]) },
    { name: "reason", check: freeText, example: "why the work stopped here" }, { name: "nextAction", check: freeText, example: "what resolves the wait" },
    { name: "scope", check: freeText, example: "what the wait blocks" }, { name: "reference", check: httpUrl, required: false }],
  "wait.resolved": [...binding, { name: "waitId", check: runStoreId, example: "wait-1" },
    { name: "resolution", check: freeText, example: "how the wait was resolved" }, { name: "scope", check: freeText, example: "what the wait blocked" }],
  "finding.observed": [...binding, ...roundBinding,
    { name: "findingId", check: runStoreId, example: "finding-1" }, { name: "reportId", check: runStoreId, example: "report-1" },
    { name: "state", check: oneOf(["unresolved", "resolved", "deferred"]) },
    { name: "severity", check: oneOf(["P0", "P1", "P2", "P3"]) },
    { name: "deferredIssueId", check: ticketId, required: false }],
  "report.referenced": [...binding, ...roundBinding,
    { name: "reportId", check: runStoreId, example: "report-1" }, { name: "role", check: oneOf(["review", "reduction", "clarification", "partial-output"]) },
    { name: "artifactId", check: runStoreId, required: false, example: "artifact-1" },
    { name: "originatingReportId", check: runStoreId, required: false, example: "report-0" },
    { name: "findingId", check: runStoreId, required: false, example: "finding-1" },
    { name: "availability", check: oneOf(["referenced", "unavailable"]) },
    { name: "reason", check: freeText, required: false, example: "why the output is unavailable" }],
  "artifact.referenced": [...binding, ...roundBinding,
    { name: "artifactId", check: runStoreId, example: "artifact-1" }, { name: "digest", check: digest },
    { name: "sizeBytes", check: nonNegativeInt, example: 4096 }, { name: "mediaType", check: label, example: "application/json" },
    { name: "producer", check: providerId, example: "delivery-harness.cli" }],
  "finish.step.observed": [ { name: "stepId", check: runStoreId, example: "step-1" },
    { name: "candidateTreeSha", check: treeSha }, { name: "name", check: label, example: "merge" },
    { name: "state", check: oneOf(["pending", "running", "completed", "deferred", "unknown"]) },
    { name: "owner", check: label, example: "claude-code" }, { name: "reason", check: freeText, required: false, example: "why the step is in this state" }],
};

/**
 * `/2` rather than `/1`: the document gains `type`, `constraint` and `example`
 * on every member, plus `members`, `items` and `variants` where the value is
 * structured, and a whole-payload `example`. A closed document that gains
 * members is a revision here, exactly as `run-event/2` was.
 */
export const RUN_EVENT_PAYLOAD_GRAMMAR_SPEC = "run-event-payload-grammar/2";

export type RunEventValueType = "string" | "number" | "boolean" | "array" | "object";

/** One value's described shape: what the validator accepts, and one value it does. */
export interface RunEventValueGrammar {
  readonly type: RunEventValueType;
  /** The constraint in the words the validator itself refuses with. */
  readonly constraint: string;
  /** Present where the value is a closed vocabulary. */
  readonly values?: readonly string[];
  /** Present where the value is a closed object with one member table. */
  readonly members?: readonly RunEventPayloadMemberGrammar[];
  /** Present where the value is an array; describes one element. */
  readonly items?: RunEventValueGrammar;
  /** Present where which table applies depends on a sibling member's value. */
  readonly variants?: readonly RunEventValueGrammar[];
  /** A value this exact check accepts. */
  readonly example: unknown;
}

export interface RunEventPayloadMemberGrammar extends RunEventValueGrammar {
  readonly name: string;
  readonly required: boolean;
}

export interface RunEventPayloadGrammar {
  readonly spec: typeof RUN_EVENT_PAYLOAD_GRAMMAR_SPEC;
  readonly version: RunEventVersion;
  readonly kind: RunEventKind;
  readonly members: readonly RunEventPayloadMemberGrammar[];
  /** The minimal emittable payload: every required member, nothing else. */
  readonly example: Record<string, unknown>;
}

/**
 * The optional members the v2 combination rules in `validateRunEvent` make
 * MANDATORY for the values published as examples. A published example has to be
 * emittable, and `report.referenced`'s `availability: "referenced"` is the one
 * example value that owes a member the table itself calls optional. The grammar
 * test emits every published example through the validator, so a drift between
 * this table and those rules cannot stay quiet.
 */
const EXAMPLE_COMBINATION_MEMBERS: Partial<Record<RunEventKind, readonly string[]>> = {
  "report.referenced": ["artifactId"],
};

/**
 * Describes the exact top-level payload table the validator selects. Types,
 * vocabularies, nested tables and examples all come from the same check
 * INSTANCES the validator runs, so this read surface cannot drift into a second
 * remembered contract. It reads nothing and writes nothing.
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
    members: describeMembers(rules, kind),
    example: exampleOf(rules, kind, EXAMPLE_COMBINATION_MEMBERS[kind] ?? []),
  };
}

/** The kinds whose payload owns each envelope-mirrored member. */
const MIRRORED_MEMBERS = Object.freeze(["ticket", "candidateTreeSha"] as const);

// ── Envelope ───────────────────────────────────────────────────────────────

const REPO_MEMBERS: readonly RunMemberRule[] = [
  { name: "commonDir", check: boundedString(MAX_RUN_PATH, "an absolute common-directory path", "/repository/.git") },
  { name: "remote", check: boundedString(MAX_RUN_URL, "a remote locator", "https://github.com/example/repository.git"), required: false },
];

const ACTOR_MEMBERS: readonly RunMemberRule[] = [
  { name: "role", check: oneOf(RUN_ACTOR_ROLES) },
  { name: "id", check: providerId, required: false },
];

function envelopeMembers(withSeq: boolean, v2: boolean): readonly RunMemberRule[] {
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
  // Combination rules. `EXAMPLE_COMBINATION_MEMBERS` above names the optional
  // members these make mandatory for the grammar's published examples.
  if (v2 && isSpineRecord(payload)) {
    if (kind === "command.completed" && payload["preparation"] !== undefined &&
        (payload["command"] !== "prepare" || payload["outcome"] !== "ok")) {
      collector.emit("unsupported_combination", "/payload/preparation", "a preparation observation requires a successful prepare completion");
    }
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
