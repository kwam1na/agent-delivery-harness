/**
 * Delivery harness kernel.
 *
 * The kernel's modules — canonical.ts, digest.ts, config.ts, blockers.ts,
 * candidate.ts, identity.ts, records.ts, validator/, evaluator.ts, context.ts,
 * recorder.ts, admission.ts, delivery-record.ts — land incrementally. The purity
 * sensor already registers the not-yet-created paths as pending, so the change
 * that creates one has to promote it to an enforced protected class.
 */

export const PACKAGE_NAME = "@delivery-harness/kernel";

// RFC 8785 canonical JSON and the digest helpers built on it.
export {
  CanonicalizationError,
  canonicalBytes,
  canonicalize,
  compareUtf16CodeUnits,
  type CanonicalErrorCode,
} from "./canonical.ts";
export {
  DigestError,
  assertSha256Hex,
  digestCanonical,
  digestsEqual,
  isSha256Hex,
  manifestDigest,
  sha256Hex,
  type DigestErrorCode,
} from "./digest.ts";

// The failure vocabulary: typed blockers, the gate's structural finding-code
// registry, and the one total renderer.
export * from "./blockers.ts";

// The injected policy surface: the config schema, its load-time invariants, and
// the neutral-matcher primitive the identity computation shares with it.
export * from "./config.ts";
