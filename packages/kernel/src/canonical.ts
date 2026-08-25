/**
 * RFC 8785 (JSON Canonicalization Scheme) — the repository's only
 * canonicalizer.
 *
 * `manifestDigest`, `recordId`, and `workspaceId` are all digests over the
 * output of this module. A second canonicalizer would be a second definition
 * of identity, so there is exactly one, it lives in the kernel, and it has no
 * dependencies: the `canonicalize` npm package was rejected for supply-chain
 * surface on the most security-critical path in the system.
 *
 * This module is on the d1 kernel-import allowlist — pure modules import it —
 * so it imports nothing at all.
 *
 * Deliberate departures from `JSON.stringify`, all in the fail-closed
 * direction: `JSON.stringify` silently drops `undefined` members, symbol keys,
 * and functions, silently turns `NaN`/`Infinity` into `null`, and silently
 * renders a `Date` (or any object with `toJSON`) as something other than its
 * members. Every one of those is a canonical form that does not represent the
 * caller's value, which on this path means a digest over data nobody wrote.
 * All of them throw `CanonicalizationError` here.
 */

export type CanonicalErrorCode =
  /** `NaN`, `Infinity`, `-Infinity` — not representable in JSON (RFC 8785 §3.2.2.3). */
  | "non_finite_number"
  /** `undefined`, a function, a symbol, a bigint, or a non-plain object. */
  | "unsupported_value"
  /** An own symbol-keyed member, which has no JSON spelling. */
  | "symbol_key"
  /** A value that contains itself. */
  | "circular_reference";

/**
 * Thrown for input that has no canonical JSON form. `path` is a JSON Pointer
 * (RFC 6901) to the offending value, so a caller can name the member rather
 * than the whole document.
 */
export class CanonicalizationError extends Error {
  readonly code: CanonicalErrorCode;
  readonly path: string;

  constructor(code: CanonicalErrorCode, path: string, message: string) {
    super(`${message} (at ${path === "" ? "the document root" : path})`);
    this.name = "CanonicalizationError";
    this.code = code;
    this.path = path;
  }
}

/**
 * RFC 8785 §3.2.3 member ordering: compare UTF-16 code units, not code points
 * and not collation.
 *
 * The distinction is load-bearing for astral keys. U+1F600 is the surrogate
 * pair D83D DE00; its leading code unit 0xD83D sorts *below* a BMP key such as
 * U+FB33 or U+FF21, while its code point 0x1F600 sorts far above them.
 * A code-point sort or a `localeCompare` sort therefore produces different
 * bytes — and `localeCompare` is additionally locale- and ICU-build-dependent,
 * which is why Athena's `stableJson` was not ported.
 *
 * This is exactly the ECMAScript relational operator on strings; it is spelled
 * out rather than left to `Array.prototype.sort`'s default so the ordering the
 * spec depends on is stated in the code that depends on it.
 */
export function compareUtf16CodeUnits(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const left = a.charCodeAt(i);
    const right = b.charCodeAt(i);
    if (left !== right) return left - right;
  }
  return a.length - b.length;
}

/** RFC 6901 §3 escaping for one JSON Pointer reference token. */
const pointerSegment = (key: string): string => `/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`;

/**
 * RFC 8785 §3.2.2.3. Number serialization is the ECMAScript `Number::toString`
 * algorithm — shortest decimal that round-trips, with ECMAScript's exponent
 * thresholds — which is precisely what `String(number)` computes. `String(-0)`
 * is already `"0"`, which is the RFC's required output for negative zero.
 */
const serializeNumber = (value: number, path: string): string => {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(
      "non_finite_number",
      path,
      `${String(value)} has no JSON representation`,
    );
  }
  return String(value);
};

/**
 * RFC 8785 §3.2.2.2 defers string serialization to ECMAScript's
 * `QuoteJSONString`, which is what `JSON.stringify` applies to a string: the
 * short escapes for `"` `\` and the five named C0 controls, lowercase
 * `\u00xx` for the rest of U+0000–U+001F, lone surrogates escaped for
 * well-formed output (ES2019+), and every other character emitted literally.
 * Reimplementing that byte-for-byte would add a second, weaker definition of
 * the same normative algorithm.
 */
const serializeString = (value: string): string => JSON.stringify(value);

/** True for objects that came from JSON — no exotic prototype, no `toJSON`. */
const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
};

const describeValue = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  if (typeof value === "bigint") return "a bigint";
  return `a non-plain object (${Object.prototype.toString.call(value)})`;
};

const serialize = (value: unknown, path: string, ancestors: Set<object>): string => {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value, path);
    case "string":
      return serializeString(value);
    case "object":
      break;
    default:
      throw new CanonicalizationError(
        "unsupported_value",
        path,
        `${describeValue(value)} has no JSON representation`,
      );
  }

  const container = value as object;
  if (ancestors.has(container)) {
    throw new CanonicalizationError("circular_reference", path, "value contains itself");
  }
  ancestors.add(container);
  try {
    if (Array.isArray(container)) {
      const elements = (container as readonly unknown[]).map((element, index) =>
        serialize(element, `${path}/${index}`, ancestors),
      );
      return `[${elements.join(",")}]`;
    }

    if (!isPlainObject(container)) {
      throw new CanonicalizationError(
        "unsupported_value",
        path,
        `${describeValue(container)} has no JSON representation`,
      );
    }

    if (Object.getOwnPropertySymbols(container).length > 0) {
      throw new CanonicalizationError(
        "symbol_key",
        path,
        "object carries symbol-keyed members, which have no JSON representation",
      );
    }

    const record = container as Record<string, unknown>;
    const members = Object.keys(record)
      .sort(compareUtf16CodeUnits)
      .map((key) => {
        const child = serialize(record[key], `${path}${pointerSegment(key)}`, ancestors);
        return `${serializeString(key)}:${child}`;
      });
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(container);
  }
};

/**
 * Canonicalizes a JSON-representable value to its RFC 8785 form: members
 * sorted by UTF-16 code unit at every depth, no insignificant whitespace,
 * ECMAScript number and string serialization. Throws
 * {@link CanonicalizationError} for anything JSON cannot represent. Never
 * mutates its input.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, "", new Set<object>());
}

/**
 * The canonical form as UTF-8 bytes — RFC 8785 §3.3's serialization, and what
 * every digest in this system is computed over. No BOM.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
