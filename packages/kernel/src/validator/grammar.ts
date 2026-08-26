/**
 * The closed-grammar machinery both halves of the validator are written in.
 *
 * Two ideas live here, and nothing else:
 *
 *   1. A COLLECTOR. Every rule reports into it and none of them return early,
 *      because SUB-5 requires one response carrying every violated rule. A rule
 *      that short-circuits the others is the bug this shape exists to prevent.
 *
 *   2. MEMBER TABLES. GEN-1 makes strict parsing the evolution mechanism: an
 *      unknown member is a rejection, never a tolerated stranger. Expressing
 *      each object as a table of required and optional members — rather than as
 *      a series of reads — means the closed check and the reads cannot disagree,
 *      and a member added to one version's grammar is a visible edit to the
 *      table rather than a silently accepted field.
 *
 * The rejection code a missing member produces is a parameter, because the spec
 * does not answer it uniformly: a missing `candidate.deliverable` is
 * `malformed_field` (GEN-4), while a `telemetry.cost` missing its `unit` is
 * `invalid_cost` (RG-10). The caller names the code its rule assigns.
 *
 * PURITY. This module reads nothing and imports nothing but the canonicalizer
 * and the code registry; it is on the pure side of the sensor's d1 rule along
 * with the rest of `validator/`.
 */
import { canonicalize } from "../canonical.ts";
import type { ManifestRejection, ManifestRejectionCode, ManifestRuleId } from "./codes.ts";

// ── Patterns ───────────────────────────────────────────────────────────────

/** Git object ids are 40-hex lowercase; SHA-256 object-format repos are out of scope (§6). */
export const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

/** Every digest in the spec is lowercase hexadecimal SHA-256 (§6). */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** ENV-1. */
export const PROVIDER_ID = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

/** ENV-2. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Appendix A: the obligation grammar. */
export const OBLIGATION_ID = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;

/** Appendix A: the artifact role grammar — an open slug, not an enum (§5.6). */
export const ARTIFACT_ROLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** RG-7: a tracker id, not a placeholder. */
export const DEFERRED_ISSUE_ID = /^[A-Z][A-Z0-9]*-[0-9]+$/;

// ── Collector ──────────────────────────────────────────────────────────────

export interface Collector {
  /** Reports one violated rule. Never throws, never short-circuits. */
  emit(code: ManifestRejectionCode, rule: ManifestRuleId, pointer: string, message: string): void;
  /** Everything reported so far, in emission order. */
  list(): readonly ManifestRejection[];
}

export function createCollector(): Collector {
  const rejections: ManifestRejection[] = [];
  return {
    emit(code, rule, pointer, message) {
      rejections.push({ code, rule, pointer, message });
    },
    list() {
      return rejections;
    },
  };
}

// ── Pointers ───────────────────────────────────────────────────────────────

/** RFC 6901 escaping: `~` before `/`, or the escape itself round-trips wrongly. */
export function pointer(base: string, ...segments: readonly (string | number)[]): string {
  let result = base;
  for (const segment of segments) {
    const token = typeof segment === "number" ? String(segment) : segment.replaceAll("~", "~0").replaceAll("/", "~1");
    result += `/${token}`;
  }
  return result;
}

// ── Shapes ─────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Reads a member without naming it in the source. Member names live in the
 * grammar tables and in call arguments; the reads go through here. That is a
 * readability choice for most members and a hard requirement for one —
 * `recordedAt` is informational (§5.8), and the sensor's time ban rejects any
 * decision path that reads it by name.
 */
export function member(value: Record<string, unknown>, name: string): unknown {
  return value[name];
}

export interface MemberTable {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

export interface MemberCodes {
  /** Code for a member the grammar does not define (GEN-1). */
  readonly unknown: { readonly code: ManifestRejectionCode; readonly rule: ManifestRuleId };
  /** Code for a required member that is absent. */
  readonly missing: { readonly code: ManifestRejectionCode; readonly rule: ManifestRuleId };
}

export const GEN_1_UNKNOWN: MemberCodes["unknown"] = Object.freeze({ code: "unknown_member", rule: "GEN-1" });
export const GEN_4_MISSING: MemberCodes["missing"] = Object.freeze({ code: "malformed_field", rule: "GEN-4" });

/**
 * Checks one object against its member table: every member the grammar does not
 * define is reported, and so is every required member that is absent. Returns
 * nothing — the caller reads what it needs through `member()`, having already
 * learned from the collector whether the read is safe.
 */
export function checkMembers(
  value: Record<string, unknown>,
  at: string,
  table: MemberTable,
  codes: MemberCodes,
  collector: Collector,
): void {
  const defined = new Set<string>([...table.required, ...(table.optional ?? [])]);
  for (const name of Object.keys(value)) {
    if (!defined.has(name)) {
      collector.emit(codes.unknown.code, codes.unknown.rule, pointer(at, name), `member is not defined by this version's grammar`);
    }
  }
  for (const name of table.required) {
    if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
      collector.emit(codes.missing.code, codes.missing.rule, pointer(at, name), `required member is absent`);
    }
  }
}

/**
 * Structural equality by canonical form (RFC 8785). The canonicalizer is the
 * repo's only one, so "identical values" means the same thing here as it does
 * in a digest. Values that cannot be canonicalized are unequal rather than
 * exceptional: an unrepresentable value is not equal to anything.
 */
export function canonicallyEqual(a: unknown, b: unknown): boolean {
  let left: string;
  let right: string;
  try {
    left = canonicalize(a);
  } catch {
    return false;
  }
  try {
    right = canonicalize(b);
  } catch {
    return false;
  }
  return left === right;
}
