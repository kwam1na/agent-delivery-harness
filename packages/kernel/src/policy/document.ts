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
  oneOf,
  positiveInt,
  specLiteral,
  spineId,
  spinePointer,
  stringArray,
  text,
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

export interface RepositoryPolicyDocument {
  readonly spec: typeof REPOSITORY_POLICY_DOCUMENT_SPEC;
  readonly repositoryId: string;
  readonly policyGeneration: number;
  readonly grantedFinishLines: readonly (typeof FINISH_LINES)[number][];
  readonly grantedAuthority: readonly string[];
  readonly forbiddenAuthority: readonly string[];
  readonly reviewLenses: readonly { readonly lensId: string; readonly category: (typeof REVIEW_LENS_CATEGORIES)[number] }[];
  readonly obligations: readonly { readonly obligationId: string }[];
  readonly requiredCapabilities: readonly { readonly capabilityId: string; readonly kind: string; readonly version: string }[];
  readonly approvals: readonly { readonly action: string; readonly approval: (typeof APPROVAL_REQUIREMENTS)[number] }[];
  readonly trackerAbsenceFallback: (typeof TRACKER_ABSENCE_FALLBACKS)[number];
  readonly checkpoints?: readonly CheckpointOverride[];
  /** The admission gate, validated by the characterized `HarnessConfig` loader at compile time. */
  readonly admission?: unknown;
}

const LENS_RULES: readonly MemberRule[] = [
  { name: "lensId", check: spineId },
  { name: "category", check: oneOf(REVIEW_LENS_CATEGORIES) },
];

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

const closedArrayWithOptionals =
  (required: readonly MemberRule[], collectorRef: PolicyCollector) =>
  (value: unknown, at: string): void => {
    if (!Array.isArray(value)) {
      collectorRef.emit("malformed_member", at, "expected an array");
      return;
    }
    value.forEach((entry, index) => {
      checkClosedWithOptionals(entry, spinePointer(at, index), required, [], collectorRef);
    });
  };

export function validateRepositoryPolicyDocument(value: unknown): PolicyVerdict {
  const collector = createPolicyCollector();
  const view = spineView(collector);
  const nestedClosed =
    (rules: readonly MemberRule[]) =>
    (nested: unknown, at: string): void =>
      closedArrayWithOptionals(rules, collector)(nested, at);

  const REQUIRED: readonly MemberRule[] = [
    { name: "spec", check: specLiteral(REPOSITORY_POLICY_DOCUMENT_SPEC) },
    { name: "repositoryId", check: spineId },
    { name: "policyGeneration", check: positiveInt },
    { name: "grantedFinishLines", check: stringArray({ minItems: 1, item: oneOf(FINISH_LINES) }) },
    { name: "grantedAuthority", check: stringArray({ item: oneOf(PRIVILEGED_ACTIONS) }) },
    { name: "forbiddenAuthority", check: stringArray({ item: oneOf(PRIVILEGED_ACTIONS) }) },
    { name: "reviewLenses", check: (nested, at) => nestedClosed(LENS_RULES)(nested, at) },
    { name: "obligations", check: (nested, at) => nestedClosed(OBLIGATION_RULES)(nested, at) },
    { name: "requiredCapabilities", check: (nested, at) => nestedClosed(REQUIRED_CAPABILITY_RULES)(nested, at) },
    { name: "approvals", check: (nested, at) => nestedClosed(APPROVAL_RULES)(nested, at) },
    { name: "trackerAbsenceFallback", check: oneOf(TRACKER_ABSENCE_FALLBACKS) },
  ];
  const OPTIONAL: readonly MemberRule[] = [
    { name: "checkpoints", check: (nested, at) => nestedClosed(CHECKPOINT_REQUIRED)(nested, at) },
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
