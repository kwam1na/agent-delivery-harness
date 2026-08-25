/**
 * SHA-256 over canonical JSON, and the spec's `manifestDigest`.
 *
 * Everything the harness identifies by content — `manifestDigest` here,
 * `recordId` and `workspaceId` in U7 — is a lowercase-hex SHA-256 over the
 * RFC 8785 canonical bytes produced by `canonical.ts`. This module is on the
 * d1 kernel-import allowlist; `node:crypto` is not in the fs/process/os
 * specifier family the purity rules ban, and it is the only import here.
 *
 * Lowercase hex is a discipline, not a preference: digests travel through
 * filenames, JSON records, and cross-tool comparisons, and a comparison that
 * case-folds would accept a digest nobody in this system emits. The helpers
 * below therefore *reject* uppercase rather than normalizing it.
 */
import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.ts";

/** Lowercase hex, exactly 64 characters — the shape of every digest here. */
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export type DigestErrorCode = "not_sha256_hex";

/** Thrown when a value that must be a lowercase-hex SHA-256 digest is not one. */
export class DigestError extends Error {
  readonly code: DigestErrorCode;

  constructor(code: DigestErrorCode, message: string) {
    super(message);
    this.name = "DigestError";
    this.code = code;
  }
}

/** SHA-256 of a byte string, or of a string's UTF-8 bytes, as lowercase hex. */
export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(typeof input === "string" ? new TextEncoder().encode(input) : input);
  return hash.digest("hex");
}

/** SHA-256 of a value's RFC 8785 canonical bytes, as lowercase hex. */
export function digestCanonical(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

/** True when `value` is a lowercase-hex SHA-256 digest. */
export function isSha256Hex(value: unknown): boolean {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** Returns `value` when it is a lowercase-hex SHA-256 digest; throws otherwise. */
export function assertSha256Hex(value: unknown): string {
  if (!isSha256Hex(value)) {
    throw new DigestError(
      "not_sha256_hex",
      `expected a lowercase-hex sha256 digest, received ${JSON.stringify(value)}`,
    );
  }
  return value as string;
}

/**
 * Compares two digests, rejecting anything that is not already a
 * lowercase-hex SHA-256 digest. Deliberately not case-insensitive: an
 * uppercase digest reaching a comparison means something upstream emitted a
 * spelling this system does not produce, and quietly folding it would hide
 * that.
 */
export function digestsEqual(a: string, b: string): boolean {
  return assertSha256Hex(a) === assertSha256Hex(b);
}

/**
 * Replaces `attestation.signatures` with `[]` without mutating the input, and
 * without inventing an `attestation` member that was not there — a manifest
 * missing it is structurally invalid, and rejecting that is the validator's
 * job (U4), not this module's.
 */
const withEmptySignatures = (manifest: unknown): unknown => {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return manifest;

  const members = manifest as Record<string, unknown>;
  const attestation = members["attestation"];
  if (typeof attestation !== "object" || attestation === null || Array.isArray(attestation)) {
    return manifest;
  }

  return {
    ...members,
    attestation: { ...(attestation as Record<string, unknown>), signatures: [] },
  };
};

/**
 * The delivery-evidence/1 manifest digest (spec §6):
 *
 *     manifestDigest = lowerhex(sha256(JCS(manifest with attestation.signatures := [])))
 *
 * Emptying the signature array before digesting is what lets a future
 * signature sign the digest without signing itself, and what gives a level-
 * `self` manifest and its later-countersigned form one content identity. The
 * digest is therefore invariant under any change to `attestation.signatures`
 * — including its absence — and variant under every other member.
 */
export function manifestDigest(manifest: unknown): string {
  return sha256Hex(canonicalBytes(withEmptySignatures(manifest)));
}
