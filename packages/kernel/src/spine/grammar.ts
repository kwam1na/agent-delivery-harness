/**
 * The closed-grammar machinery the managed-delivery contract spine is written
 * in. Same discipline as the evidence validator's grammar — member tables,
 * a collector, no early return — but deliberately a separate module: the
 * evidence kernel and the spine stay independent by the dependency-direction
 * sensor, so neither may import the other's machinery. This module imports
 * nothing at all.
 *
 * Closedness is also the spine's first redaction rule: every grammar here is
 * a closed member table, so a free-form environment dump, transcript, or
 * secret-bearing stranger member has no place to land (D16's field
 * classification and retention arrive with their owning units). The one
 * free-text member family (summaries and reasons) is length-bounded.
 */

export type SpineRejectionCode =
  | "not_an_object"
  | "unsupported_spec"
  | "unknown_member"
  | "missing_member"
  | "malformed_member"
  | "unsupported_combination"
  | "reserved_kind"
  | "unknown_kind"
  | "zero_review_attempts"
  | "duplicate_review_attempt"
  | "criterion_unverified"
  | "authority_not_granted"
  | "vacuous_policy"
  | "digest_mismatch"
  | "revision_mismatch"
  | "duplicate_idempotency_key"
  | "non_monotonic_fence"
  | "fence_mismatch"
  | "invalid_transition"
  | "journal_terminal"
  | "subject_mismatch"
  | "registration_missing"
  | "secret_rejected";

export interface SpineRejection {
  readonly code: SpineRejectionCode;
  /** RFC 6901 pointer to the offending value. */
  readonly pointer: string;
  readonly message: string;
}

export type SpineVerdict = { readonly ok: true } | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export interface SpineCollector {
  emit(code: SpineRejectionCode, pointer: string, message: string): void;
  verdict(): SpineVerdict;
}

export function createSpineCollector(): SpineCollector {
  const rejections: SpineRejection[] = [];
  return {
    emit(code, pointer, message) {
      rejections.push({ code, pointer, message });
    },
    verdict() {
      return rejections.length === 0 ? { ok: true } : { ok: false, rejections };
    },
  };
}

/** RFC 6901 §3 escaping for pointer segments. */
export function spinePointer(base: string, ...segments: readonly (string | number)[]): string {
  let result = base;
  for (const segment of segments) {
    const token = typeof segment === "number" ? String(segment) : segment.replaceAll("~", "~0").replaceAll("/", "~1");
    result += `/${token}`;
  }
  return result;
}

// ── Value shapes ───────────────────────────────────────────────────────────

/** Stable spine identities: bounded, filename- and journal-safe. */
export const SPINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Lowercase-hex SHA-256, the only digest spelling this system emits. */
export const SPINE_SHA256 = /^[0-9a-f]{64}$/;

/** Git object ids are 40-hex lowercase; SHA-256 object format is out of scope. */
export const SPINE_GIT_OID = /^[0-9a-f]{40}$/;

/** A UTC instant. Shape only — no spine decision may consult a clock. */
export const SPINE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The explicit marker for an identity that does not exist yet in this state. */
export const ABSENT_BY_STATE = "absent-by-state";

/** Free-text members (summaries, reasons) are bounded, never a dumping ground. */
export const MAX_FREE_TEXT = 2000;

export function isSpineRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Member checks ──────────────────────────────────────────────────────────

/** One member's shape rule; emits into the collector, returns nothing. */
export type MemberCheck = (value: unknown, at: string, collector: SpineCollector) => void;

export interface MemberRule {
  readonly name: string;
  readonly check: MemberCheck;
  readonly required?: boolean;
}

/**
 * Checks one object against a closed member table: unknown members reject,
 * required members must be present, and every present member runs its shape
 * check. Nothing short-circuits — the verdict carries every violated rule.
 */
export function checkClosed(
  value: unknown,
  at: string,
  rules: readonly MemberRule[],
  collector: SpineCollector,
): Record<string, unknown> | undefined {
  if (!isSpineRecord(value)) {
    collector.emit("not_an_object", at, "expected a JSON object");
    return undefined;
  }
  const defined = new Set(rules.map((rule) => rule.name));
  for (const name of Object.keys(value)) {
    if (!defined.has(name)) {
      collector.emit("unknown_member", spinePointer(at, name), "member is not defined by this frozen grammar");
    }
  }
  for (const rule of rules) {
    if (!Object.prototype.hasOwnProperty.call(value, rule.name) || value[rule.name] === undefined) {
      if (rule.required !== false) collector.emit("missing_member", spinePointer(at, rule.name), "required member is absent");
      continue;
    }
    rule.check(value[rule.name], spinePointer(at, rule.name), collector);
  }
  return value;
}

const malformed = (collector: SpineCollector, at: string, message: string): void => {
  collector.emit("malformed_member", at, message);
};

export const isNonEmptyText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export const text: MemberCheck = (value, at, collector) => {
  if (!isNonEmptyText(value)) malformed(collector, at, "expected a non-empty string");
};

export const boundedText: MemberCheck = (value, at, collector) => {
  if (!isNonEmptyText(value) || value.length > MAX_FREE_TEXT) {
    malformed(collector, at, `expected a non-empty string of at most ${MAX_FREE_TEXT} characters`);
  }
};

export const spineId: MemberCheck = (value, at, collector) => {
  if (typeof value !== "string" || !SPINE_ID.test(value)) {
    malformed(collector, at, "expected a stable identity matching the spine id grammar");
  }
};

export const sha256: MemberCheck = (value, at, collector) => {
  if (typeof value !== "string" || !SPINE_SHA256.test(value)) {
    malformed(collector, at, "expected a lowercase-hex sha256 digest");
  }
};

export const gitOid: MemberCheck = (value, at, collector) => {
  if (typeof value !== "string" || !SPINE_GIT_OID.test(value)) {
    malformed(collector, at, "expected a lowercase 40-hex git object id");
  }
};

export const instant: MemberCheck = (value, at, collector) => {
  if (typeof value !== "string" || !SPINE_INSTANT.test(value)) {
    malformed(collector, at, "expected a UTC instant of the form YYYY-MM-DDTHH:MM:SSZ");
  }
};

export const nonNegativeInt: MemberCheck = (value, at, collector) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    malformed(collector, at, "expected a non-negative safe integer");
  }
};

export const positiveInt: MemberCheck = (value, at, collector) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    malformed(collector, at, "expected a positive safe integer");
  }
};

export const literal =
  (expected: string | number | boolean): MemberCheck =>
  (value, at, collector) => {
    if (value !== expected) malformed(collector, at, `expected exactly ${JSON.stringify(expected)}`);
  };

/** The `spec` member: a version token this frozen grammar does not support rejects as such. */
export const specLiteral =
  (expected: string): MemberCheck =>
  (value, at, collector) => {
    if (value !== expected) {
      collector.emit("unsupported_spec", at, `unsupported spec token ${JSON.stringify(value)}; this grammar freezes ${JSON.stringify(expected)}`);
    }
  };

export const oneOf =
  (allowed: readonly string[]): MemberCheck =>
  (value, at, collector) => {
    if (typeof value !== "string" || !allowed.includes(value)) {
      malformed(collector, at, `expected one of ${allowed.join(", ")}`);
    }
  };

/** An array of unique non-empty strings, optionally with a minimum size and per-item rule. */
export const stringArray =
  (options: { readonly minItems?: number; readonly item?: MemberCheck } = {}): MemberCheck =>
  (value, at, collector) => {
    if (!Array.isArray(value)) {
      malformed(collector, at, "expected an array");
      return;
    }
    if (value.length < (options.minItems ?? 0)) {
      malformed(collector, at, `expected at least ${options.minItems} entries`);
      return;
    }
    const seen = new Set<string>();
    value.forEach((entry, index) => {
      const itemAt = spinePointer(at, index);
      if (typeof entry !== "string" || entry.length === 0) {
        malformed(collector, itemAt, "expected a non-empty string");
        return;
      }
      if (seen.has(entry)) {
        malformed(collector, itemAt, "duplicate entry");
        return;
      }
      seen.add(entry);
      options.item?.(entry, itemAt, collector);
    });
  };

/** A nested closed object. */
export const closed =
  (rules: readonly MemberRule[]): MemberCheck =>
  (value, at, collector) => {
    checkClosed(value, at, rules, collector);
  };

/** An array of nested closed objects with a minimum size. */
export const closedArray =
  (rules: readonly MemberRule[], options: { readonly minItems?: number } = {}): MemberCheck =>
  (value, at, collector) => {
    if (!Array.isArray(value)) {
      malformed(collector, at, "expected an array");
      return;
    }
    if (value.length < (options.minItems ?? 0)) {
      malformed(collector, at, `expected at least ${options.minItems} entries`);
      return;
    }
    value.forEach((entry, index) => {
      checkClosed(entry, spinePointer(at, index), rules, collector);
    });
  };

/**
 * Either a real value (per `check`) or the literal absent-by-state marker.
 * Which of the two a given profile or confirmation class requires is a
 * cross-field rule the family validator enforces on top of this shape.
 */
export const orAbsentByState =
  (check: MemberCheck): MemberCheck =>
  (value, at, collector) => {
    if (value === ABSENT_BY_STATE) return;
    check(value, at, collector);
  };

/** True when the member value is the absent-by-state marker. */
export const isAbsentByState = (value: unknown): boolean => value === ABSENT_BY_STATE;
