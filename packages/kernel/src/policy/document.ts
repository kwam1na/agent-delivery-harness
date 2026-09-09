/**
 * The declarative repository policy document — layer one of the compiled
 * policy. A repository declares WHAT it activates, grants, and protects;
 * executable adapters (layer two) declare what it can DO; the compiler joins
 * both with the portable defaults.
 *
 * The grammar is closed: unknown fields reject the delivery before mutation.
 * Checkpoint overrides deliberately carry only `additional*` members for
 * protections and forbidden operations — weakening a portable protection is
 * unspellable in this grammar, not merely rejected.
 *
 * Authority is typed, never prose: `grantedAuthority` admits only the frozen
 * privileged-action vocabulary, so a free-text sentence about merging has no
 * member to land in.
 */
import { FINISH_LINES } from "../spine/contract.ts";
import {
  boundedText,
  closed,
  closedArray,
  literal,
  MAX_FREE_TEXT,
  oneOf,
  positiveInt,
  sha256,
  specLiteral,
  spineId,
  spinePointer,
  stringArray,
  text,
  SPINE_INSTANT,
  SPINE_ID,
  type MemberCheck,
  type MemberRule,
} from "../spine/grammar.ts";
import { REVIEW_LENS_CATEGORIES } from "../spine/policy.ts";
import {
  PRIVILEGED_ACTIONS,
  POLICY_CAPABILITY_KINDS,
  checkClosedWithOptionals,
  createPolicyCollector,
  spineView,
  type PolicyCollector,
  type PolicyVerdict,
} from "./capabilities.ts";

export const REPOSITORY_POLICY_DOCUMENT_SPEC = "repository-policy-document/1";

/** The model-driven workflow stages the compiler emits grant envelopes for. */
export const PORTABLE_MODEL_DRIVEN_STAGES = Object.freeze(["plan", "implement", "compound"] as const);

export const TRACKER_ABSENCE_FALLBACKS = Object.freeze(["proceed-without-tracker", "block"] as const);
export const APPROVAL_REQUIREMENTS = Object.freeze(["operator-required", "none"] as const);

export interface CheckpointOverride {
  readonly stageId: (typeof PORTABLE_MODEL_DRIVEN_STAGES)[number];
  readonly allowedCapabilities: readonly string[];
  readonly writablePaths: readonly string[];
  readonly credentials: readonly string[];
  readonly additionalProtectedPaths: readonly string[];
  readonly additionalForbiddenOperations: readonly string[];
}

/** The repository and target branch to which an owner exemption applies. */
export interface HostedCheckExemptionScope {
  readonly repositoryId: string;
  readonly baseRef: string;
}

/** An attributed, expiring owner declaration. It is never agent-minted. */
export interface HostedCheckExemption {
  readonly scope: HostedCheckExemptionScope;
  readonly reason: string;
  readonly grantedBy: string;
  readonly until: string;
}

/** Hosted checks remain required; exemptions can only make an attributed exception visible. */
export interface HostedChecksPolicy {
  readonly required: true;
  readonly exemptions: readonly HostedCheckExemption[];
}

export interface RepositoryPolicyDocument {
  readonly spec: typeof REPOSITORY_POLICY_DOCUMENT_SPEC;
  readonly repositoryId: string;
  readonly policyGeneration: number;
  readonly grantedFinishLines: readonly (typeof FINISH_LINES)[number][];
  readonly grantedAuthority: readonly string[];
  readonly forbiddenAuthority: readonly string[];
  readonly reviewLenses: readonly {
    readonly lensId: string;
    readonly category: (typeof REVIEW_LENS_CATEGORIES)[number];
    /** The reviewer charter this lens hands its reviewer, referenced by identity. */
    readonly personaId: string;
    /**
     * Present only for a repository-owned charter: those bytes belong to the
     * repository, so the document pins them. A charter shipped in the
     * authenticated composition is referenced by identity alone, so advancing
     * the shipped set never edits this document.
     */
    readonly personaDigest?: string;
  }[];
  readonly obligations: readonly { readonly obligationId: string }[];
  readonly requiredCapabilities: readonly { readonly capabilityId: string; readonly kind: string; readonly version: string }[];
  readonly approvals: readonly { readonly action: string; readonly approval: (typeof APPROVAL_REQUIREMENTS)[number] }[];
  readonly trackerAbsenceFallback: (typeof TRACKER_ABSENCE_FALLBACKS)[number];
  readonly hostedChecks?: HostedChecksPolicy;
  readonly checkpoints?: readonly CheckpointOverride[];
  /** The admission gate, validated by the characterized `HarnessConfig` loader at compile time. */
  readonly admission?: unknown;
}

const LENS_RULES: readonly MemberRule[] = [
  { name: "lensId", check: spineId },
  { name: "category", check: oneOf(REVIEW_LENS_CATEGORIES) },
  { name: "personaId", check: spineId },
];

/** Identity plus digest is the repository-owned reference form; identity alone is the shipped one. */
const LENS_OPTIONAL_RULES: readonly MemberRule[] = [{ name: "personaDigest", check: sha256 }];

const OBLIGATION_RULES: readonly MemberRule[] = [{ name: "obligationId", check: spineId }];

const REQUIRED_CAPABILITY_RULES: readonly MemberRule[] = [
  { name: "capabilityId", check: spineId },
  { name: "kind", check: oneOf(POLICY_CAPABILITY_KINDS) },
  { name: "version", check: text },
];

const APPROVAL_RULES: readonly MemberRule[] = [
  { name: "action", check: oneOf(PRIVILEGED_ACTIONS) },
  { name: "approval", check: oneOf(APPROVAL_REQUIREMENTS) },
];

const CHECKPOINT_REQUIRED: readonly MemberRule[] = [
  {
    name: "stageId",
    check: (value, at, collector) => {
      if (typeof value !== "string" || !(PORTABLE_MODEL_DRIVEN_STAGES as readonly string[]).includes(value)) {
        collector.emit(
          "unknown_checkpoint_stage" as never,
          at,
          `no model-driven stage ${JSON.stringify(value)} exists; envelopes attach only to ${PORTABLE_MODEL_DRIVEN_STAGES.join(", ")}`,
        );
      }
    },
  },
  { name: "allowedCapabilities", check: stringArray() },
  { name: "writablePaths", check: stringArray() },
  { name: "credentials", check: stringArray() },
  { name: "additionalProtectedPaths", check: stringArray() },
  { name: "additionalForbiddenOperations", check: stringArray() },
];

const boundedIdentity: MemberCheck = (value, at, collector): void => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    collector.emit("malformed_member", at, "expected a non-empty identity of at most 256 characters");
  }
};

const boundedBaseRef: MemberCheck = (value, at, collector): void => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000\r\n]/.test(value)) {
    collector.emit("malformed_member", at, "expected a non-empty single-line base ref of at most 256 characters");
  }
};

/** Shape plus calendar validity. The compiler compares only supplied instants and never reads a clock. */
export function isHostedCheckInstant(value: unknown): value is string {
  if (typeof value !== "string" || !SPINE_INSTANT.test(value)) return false;
  const [year, month, day, hour, minute, second] = value.slice(0, -1).split(/[-T:]/).map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return false;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0);
}

const hostedCheckInstant: MemberCheck = (value, at, collector): void => {
  if (!isHostedCheckInstant(value)) {
    collector.emit("malformed_member", at, "expected a valid UTC instant of the form YYYY-MM-DDTHH:MM:SSZ");
  }
};

const HOSTED_CHECK_SCOPE_RULES: readonly MemberRule[] = [
  { name: "repositoryId", check: spineId },
  { name: "baseRef", check: boundedBaseRef },
];

const HOSTED_CHECK_EXEMPTION_RULES: readonly MemberRule[] = [
  { name: "scope", check: closed(HOSTED_CHECK_SCOPE_RULES) },
  { name: "reason", check: boundedText },
  { name: "grantedBy", check: boundedIdentity },
  { name: "until", check: hostedCheckInstant },
];

const HOSTED_CHECK_RULES: readonly MemberRule[] = [
  { name: "required", check: literal(true) },
  { name: "exemptions", check: closedArray(HOSTED_CHECK_EXEMPTION_RULES) },
];

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");

/** Runtime shape guard shared by compiled-policy and delivery-record verification. */
export function isHostedCheckExemption(value: unknown): value is HostedCheckExemption {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const exemption = value as Record<string, unknown>;
  if (!hasExactKeys(exemption, ["scope", "reason", "grantedBy", "until"])) return false;
  const scope = exemption["scope"];
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return false;
  const scoped = scope as Record<string, unknown>;
  return hasExactKeys(scoped, ["repositoryId", "baseRef"]) &&
    typeof scoped["repositoryId"] === "string" && SPINE_ID.test(scoped["repositoryId"]) &&
    typeof scoped["baseRef"] === "string" && scoped["baseRef"].length > 0 && scoped["baseRef"].length <= 256 &&
      !/[\u0000\r\n]/.test(scoped["baseRef"]) &&
    typeof exemption["reason"] === "string" && exemption["reason"].length > 0 && exemption["reason"].length <= MAX_FREE_TEXT &&
    typeof exemption["grantedBy"] === "string" && exemption["grantedBy"].trim().length > 0 && exemption["grantedBy"].length <= 256 &&
    isHostedCheckInstant(exemption["until"]);
}

export function isHostedChecksPolicy(value: unknown): value is HostedChecksPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return hasExactKeys(policy, ["required", "exemptions"]) && policy["required"] === true &&
    Array.isArray(policy["exemptions"]) && policy["exemptions"].every(isHostedCheckExemption);
}

const closedArrayWithOptionals =
  (required: readonly MemberRule[], collectorRef: PolicyCollector, optional: readonly MemberRule[] = []) =>
  (value: unknown, at: string): void => {
    if (!Array.isArray(value)) {
      collectorRef.emit("malformed_member", at, "expected an array");
      return;
    }
    value.forEach((entry, index) => {
      checkClosedWithOptionals(entry, spinePointer(at, index), required, optional, collectorRef);
    });
  };

export function validateRepositoryPolicyDocument(value: unknown): PolicyVerdict {
  const collector = createPolicyCollector();
  const view = spineView(collector);
  const nestedClosed =
    (rules: readonly MemberRule[], optional: readonly MemberRule[] = []) =>
    (nested: unknown, at: string): void =>
      closedArrayWithOptionals(rules, collector, optional)(nested, at);

  const REQUIRED: readonly MemberRule[] = [
    { name: "spec", check: specLiteral(REPOSITORY_POLICY_DOCUMENT_SPEC) },
    { name: "repositoryId", check: spineId },
    { name: "policyGeneration", check: positiveInt },
    { name: "grantedFinishLines", check: stringArray({ minItems: 1, item: oneOf(FINISH_LINES) }) },
    { name: "grantedAuthority", check: stringArray({ item: oneOf(PRIVILEGED_ACTIONS) }) },
    { name: "forbiddenAuthority", check: stringArray({ item: oneOf(PRIVILEGED_ACTIONS) }) },
    { name: "reviewLenses", check: (nested, at) => nestedClosed(LENS_RULES, LENS_OPTIONAL_RULES)(nested, at) },
    { name: "obligations", check: (nested, at) => nestedClosed(OBLIGATION_RULES)(nested, at) },
    { name: "requiredCapabilities", check: (nested, at) => nestedClosed(REQUIRED_CAPABILITY_RULES)(nested, at) },
    { name: "approvals", check: (nested, at) => nestedClosed(APPROVAL_RULES)(nested, at) },
    { name: "trackerAbsenceFallback", check: oneOf(TRACKER_ABSENCE_FALLBACKS) },
  ];
  const OPTIONAL: readonly MemberRule[] = [
    { name: "checkpoints", check: (nested, at) => nestedClosed(CHECKPOINT_REQUIRED)(nested, at) },
    { name: "hostedChecks", check: closed(HOSTED_CHECK_RULES) },
    {
      name: "admission",
      check: (nested, at) => {
        if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
          view.emit("not_an_object", at, "the admission gate is an object the harness config loader validates");
        }
      },
    },
  ];
  checkClosedWithOptionals(value, "", REQUIRED, OPTIONAL, collector);
  return collector.verdict();
}
