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
 * SELF-ATTESTED. Every event carries `attestation: "self"`. Nothing
 * authoritative reads this family; see the run store's header.
 */

import {
  MAX_FREE_TEXT,
  checkClosed,
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
export const RUN_FREE_TEXT_MEMBERS: ReadonlySet<string> = new Set(["rationale", "summary", "choice", "cited", "fork"]);

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
export const RUN_EVENT_KINDS = Object.freeze([
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

const oneOf =
  (values: readonly string[]): MemberCheck =>
  (value, at, collector) => {
    if (typeof value !== "string" || !values.includes(value)) {
      malformed(collector, at, `expected one of ${values.join(", ")}`);
    }
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
  checkClosed(value, at, COST_MEMBERS, collector);
};

const FINDINGS_MEMBERS: readonly MemberRule[] = [
  { name: "P0", check: nonNegativeInt },
  { name: "P1", check: nonNegativeInt },
  { name: "P2", check: nonNegativeInt },
  { name: "P3", check: nonNegativeInt },
];

const findings: MemberCheck = (value, at, collector) => {
  checkClosed(value, at, FINDINGS_MEMBERS, collector);
};

const WORKFLOW_MEMBERS: readonly MemberRule[] = [
  { name: "releaseId", check: label },
  { name: "profile", check: label },
];

const workflow: MemberCheck = (value, at, collector) => {
  checkClosed(value, at, WORKFLOW_MEMBERS, collector);
};

// ── Payload tables ─────────────────────────────────────────────────────────

const PAYLOAD_MEMBERS: Readonly<Record<RunEventKind, readonly MemberRule[]>> = Object.freeze({
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
  "posture.declared": [{ name: "posture", check: label }],
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
  ],
  "pr.opened": [
    { name: "url", check: httpUrl },
    { name: "candidateTreeSha", check: treeSha },
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

function envelopeMembers(withSeq: boolean): readonly MemberRule[] {
  return [
    { name: "version", check: oneOf([RUN_EVENT_SPEC]) },
    { name: "runId", check: runStoreId },
    ...(withSeq ? [{ name: "seq", check: positiveInt }] : []),
    { name: "at", check: instant },
    { name: "repo", check: (value, at, collector) => void checkClosed(value, at, REPO_MEMBERS, collector) },
    { name: "kind", check: oneOf(RUN_EVENT_KINDS) },
    { name: "actor", check: (value, at, collector) => void checkClosed(value, at, ACTOR_MEMBERS, collector) },
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
  readonly version: typeof RUN_EVENT_SPEC;
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
  if (value["version"] !== RUN_EVENT_SPEC) {
    collector.emit("unsupported_spec", "/version", `expected exactly ${JSON.stringify(RUN_EVENT_SPEC)}`);
    return collector.verdict();
  }
  const kind = value["kind"];
  if (!isRunEventKind(kind)) {
    collector.emit("unknown_kind", "/kind", "kind is not defined by the run-event/1 vocabulary");
    return collector.verdict();
  }

  checkClosed(value, "", envelopeMembers(withSeq), collector);
  const payload = value["payload"];
  checkClosed(payload, "/payload", PAYLOAD_MEMBERS[kind], collector);

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
