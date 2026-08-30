/**
 * The adapter SDK's typed capability descriptors — the seam through which a
 * repository exposes executable sensors and operations to the compiler.
 *
 * Two separations are mechanical here, not conventions:
 *
 *   - DISCOVERY NEVER GRANTS AUTHORITY. A descriptor says "this repository
 *     can execute X", never "this delivery may X". Authority enters the
 *     compiled snapshot only from the declarative policy document.
 *   - AN ADAPTER OUTPUT CANNOT CLAIM AN UNGRANTED ACTION. A claim is checked
 *     against the bound capability's kind and, for privileged actions,
 *     against the bound snapshot's granted authority — absence of a grant is
 *     denial.
 *
 * The spine's `capability-descriptor/1` (one frozen `sensor` kind) is the
 * walking skeleton's port and stays untouched; this module is the broadened
 * taxonomy the plan reserved for the adapter SDK.
 */
import { SENSOR_RESULT_SPEC } from "../spine/capability.ts";
import {
  oneOf,
  specLiteral,
  spineId,
  spinePointer,
  text,
  type MemberRule,
  type SpineCollector,
} from "../spine/grammar.ts";

// ── Rejections ─────────────────────────────────────────────────────────────

/** Policy-module rejections reuse the spine's record shape with a wider code set. */
export interface PolicyRejection {
  readonly code: string;
  /** RFC 6901 pointer to the offending value. */
  readonly pointer: string;
  readonly message: string;
}

export type PolicyVerdict = { readonly ok: true } | { readonly ok: false; readonly rejections: readonly PolicyRejection[] };

export interface PolicyCollector {
  emit(code: string, pointer: string, message: string): void;
  verdict(): PolicyVerdict;
}

export function createPolicyCollector(): PolicyCollector {
  const rejections: PolicyRejection[] = [];
  return {
    emit(code, pointer, message) {
      rejections.push({ code, pointer, message });
    },
    verdict() {
      return rejections.length === 0 ? { ok: true } : { ok: false, rejections };
    },
  };
}

/**
 * Spine member checks emit into a policy collector through this view; the
 * checks never read a verdict, so the view's verdict is inert by design.
 */
export const spineView = (collector: PolicyCollector): SpineCollector => ({
  emit(code, pointer, message) {
    collector.emit(code, pointer, message);
  },
  verdict: () => ({ ok: true }),
});

/**
 * `checkClosed` with declared optional members: closedness still rejects any
 * stranger, required members must be present, optional members are checked
 * only when present. Lives here rather than in the spine — the spine grammar
 * is frozen and carries no optionality on purpose.
 */
export function checkClosedWithOptionals(
  value: unknown,
  at: string,
  required: readonly MemberRule[],
  optional: readonly MemberRule[],
  collector: PolicyCollector,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    collector.emit("not_an_object", at, "expected a JSON object");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const defined = new Set([...required, ...optional].map((rule) => rule.name));
  for (const name of Object.keys(record)) {
    if (!defined.has(name)) {
      collector.emit("unknown_member", spinePointer(at, name), "member is not defined by this grammar");
    }
  }
  const view = spineView(collector);
  for (const rule of required) {
    if (!Object.prototype.hasOwnProperty.call(record, rule.name) || record[rule.name] === undefined) {
      collector.emit("missing_member", spinePointer(at, rule.name), "required member is absent");
      continue;
    }
    rule.check(record[rule.name], spinePointer(at, rule.name), view);
  }
  for (const rule of optional) {
    if (Object.prototype.hasOwnProperty.call(record, rule.name) && record[rule.name] !== undefined) {
      rule.check(record[rule.name], spinePointer(at, rule.name), view);
    }
  }
  return record;
}

// ── The taxonomy ───────────────────────────────────────────────────────────

export const ADAPTER_CAPABILITY_SPEC = "adapter-capability/1";
export const OPERATION_RESULT_SPEC = "operation-result/1";

/** The eight repository capability classes the compiler can bind. */
export const POLICY_CAPABILITY_KINDS = Object.freeze([
  "sensor",
  "mutation-stage",
  "pr-creation",
  "merge",
  "deploy",
  "approval-request",
  "tracker",
  "status-reconciliation",
] as const);
export type PolicyCapabilityKind = (typeof POLICY_CAPABILITY_KINDS)[number];

/** Kinds whose execution reads and never mutates. */
export const READ_ONLY_CAPABILITY_KINDS = Object.freeze(["sensor", "status-reconciliation"] as const);

/**
 * Kinds whose credentials are excluded from every model-driven execution
 * grant; they run only through bound adapters after authorization.
 */
export const PRIVILEGED_CAPABILITY_KINDS = Object.freeze(["pr-creation", "merge", "deploy", "approval-request"] as const);

/** The external actions a declarative document can grant as authority. */
export const PRIVILEGED_ACTIONS = Object.freeze(["pr-creation", "merge", "deploy"] as const);

/** Each kind's contracted result spec; a descriptor claiming another rejects. */
export const CAPABILITY_RESULT_SPECS: Readonly<Record<PolicyCapabilityKind, string>> = Object.freeze({
  sensor: SENSOR_RESULT_SPEC,
  "mutation-stage": OPERATION_RESULT_SPEC,
  "pr-creation": OPERATION_RESULT_SPEC,
  merge: OPERATION_RESULT_SPEC,
  deploy: OPERATION_RESULT_SPEC,
  "approval-request": OPERATION_RESULT_SPEC,
  tracker: OPERATION_RESULT_SPEC,
  "status-reconciliation": OPERATION_RESULT_SPEC,
});

export interface AdapterCapability {
  readonly spec: typeof ADAPTER_CAPABILITY_SPEC;
  readonly capabilityId: string;
  readonly kind: PolicyCapabilityKind;
  readonly version: string;
  readonly resultSpec: string;
  readonly credentialId?: string;
}

const ADAPTER_REQUIRED: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(ADAPTER_CAPABILITY_SPEC) },
  { name: "capabilityId", check: spineId },
  { name: "kind", check: oneOf(POLICY_CAPABILITY_KINDS) },
  { name: "version", check: text },
  { name: "resultSpec", check: text },
];

const ADAPTER_OPTIONAL: readonly MemberRule[] = [{ name: "credentialId", check: spineId }];

export function validateAdapterCapability(value: unknown): PolicyVerdict {
  const collector = createPolicyCollector();
  const record = checkClosedWithOptionals(value, "", ADAPTER_REQUIRED, ADAPTER_OPTIONAL, collector);
  if (record !== undefined) {
    const kind = record["kind"];
    const resultSpec = record["resultSpec"];
    if (typeof kind === "string" && (POLICY_CAPABILITY_KINDS as readonly string[]).includes(kind) && typeof resultSpec === "string") {
      const expected = CAPABILITY_RESULT_SPECS[kind as PolicyCapabilityKind];
      if (resultSpec !== expected) {
        collector.emit(
          "capability_contract_mismatch",
          "/resultSpec",
          `a ${kind} capability contracts ${expected}; ${JSON.stringify(resultSpec)} is a different integration`,
        );
      }
    }
  }
  return collector.verdict();
}

/** Validates a whole adapter set; duplicate capability ids reject. */
export function validateAdapterSet(values: readonly unknown[]): PolicyVerdict {
  const collector = createPolicyCollector();
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const at = `/${index}`;
    const verdict = validateAdapterCapability(value);
    if (!verdict.ok) {
      for (const rejection of verdict.rejections) collector.emit(rejection.code, `${at}${rejection.pointer}`, rejection.message);
      return;
    }
    const capability = value as AdapterCapability;
    if (seen.has(capability.capabilityId)) {
      collector.emit("duplicate_capability", `${at}/capabilityId`, `capability ${capability.capabilityId} is declared more than once`);
      return;
    }
    seen.add(capability.capabilityId);
  });
  return collector.verdict();
}

// ── Operation claims ───────────────────────────────────────────────────────

export const OPERATION_CLAIM_SPEC = "operation-claim/1";

const CLAIM_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(OPERATION_CLAIM_SPEC) },
  { name: "capabilityId", check: spineId },
  { name: "action", check: oneOf(POLICY_CAPABILITY_KINDS) },
];

/** The slice of a compiled policy a claim is judged against. */
export interface ClaimAuthorityView {
  readonly capabilities: readonly { readonly capabilityId: string; readonly kind: PolicyCapabilityKind }[];
  readonly snapshot: { readonly grantedAuthority: readonly string[] };
}

/**
 * Judges one adapter output claim against the bound compiled policy. The
 * claim must name a bound capability, the action must be that capability's
 * contracted kind, and a privileged action must be granted by the snapshot.
 */
export function checkClaimAuthorized(claim: unknown, compiled: ClaimAuthorityView): PolicyVerdict {
  const collector = createPolicyCollector();
  const record = checkClosedWithOptionals(claim, "", CLAIM_RULES, [], collector);
  const early = collector.verdict();
  if (record === undefined || !early.ok) return early;

  const capabilityId = record["capabilityId"] as string;
  const action = record["action"] as PolicyCapabilityKind;
  const capability = compiled.capabilities.find((entry) => entry.capabilityId === capabilityId);
  if (capability === undefined) {
    collector.emit("capability_unavailable", "/capabilityId", `no capability ${capabilityId} is bound in the compiled policy`);
    return collector.verdict();
  }
  if (capability.kind !== action) {
    collector.emit(
      "capability_contract_mismatch",
      "/action",
      `capability ${capabilityId} is bound as ${capability.kind}; it cannot substantiate a ${action} claim`,
    );
  }
  if ((PRIVILEGED_ACTIONS as readonly string[]).includes(action) && !compiled.snapshot.grantedAuthority.includes(action)) {
    collector.emit(
      "authority_not_granted",
      "/action",
      `the compiled policy grants no ${action} authority; an adapter output cannot claim an ungranted action`,
    );
  }
  return collector.verdict();
}
