/**
 * TEST-FIRST STUB (V26-1331). The digest suite in `digest.test.ts` is written
 * and red against this stub; the implementation lands in the next commit.
 */

export type DigestErrorCode = "not_sha256_hex";

export class DigestError extends Error {
  readonly code: DigestErrorCode;

  constructor(code: DigestErrorCode, message: string) {
    super(message);
    this.name = "DigestError";
    this.code = code;
  }
}

const notImplemented = (): never => {
  throw new Error("V26-1331: digest helpers not implemented yet (test-first stub)");
};

export function sha256Hex(_input: string | Uint8Array): string {
  return notImplemented();
}

export function digestCanonical(_value: unknown): string {
  return notImplemented();
}

export function manifestDigest(_manifest: unknown): string {
  return notImplemented();
}

export function isSha256Hex(_value: unknown): boolean {
  return notImplemented();
}

export function assertSha256Hex(_value: unknown): string {
  return notImplemented();
}

export function digestsEqual(_a: string, _b: string): boolean {
  return notImplemented();
}
