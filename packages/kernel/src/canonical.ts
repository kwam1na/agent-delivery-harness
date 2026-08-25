/**
 * TEST-FIRST STUB (V26-1331). The RFC 8785 suite in `canonical.test.ts` is
 * written and red against this stub; the implementation lands in the next
 * commit. Only the exported surface is real here.
 */

export type CanonicalErrorCode =
  | "non_finite_number"
  | "unsupported_value"
  | "symbol_key"
  | "circular_reference";

export class CanonicalizationError extends Error {
  readonly code: CanonicalErrorCode;
  readonly path: string;

  constructor(code: CanonicalErrorCode, path: string, message: string) {
    super(message);
    this.name = "CanonicalizationError";
    this.code = code;
    this.path = path;
  }
}

const notImplemented = (): never => {
  throw new Error("V26-1331: canonicalizer not implemented yet (test-first stub)");
};

export function compareUtf16CodeUnits(_a: string, _b: string): number {
  return notImplemented();
}

export function canonicalize(_value: unknown): string {
  return notImplemented();
}

export function canonicalBytes(_value: unknown): Uint8Array {
  return notImplemented();
}
