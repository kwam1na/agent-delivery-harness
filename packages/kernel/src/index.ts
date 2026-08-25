/**
 * Delivery harness kernel.
 *
 * Scaffolded in U1 (V26-1329). Real modules — canonical.ts, digest.ts, config.ts,
 * blockers.ts, candidate.ts, identity.ts, records.ts, validator/, evaluator.ts,
 * context.ts, recorder.ts, admission.ts, delivery-record.ts — arrive in U15/U2/U3
 * and Phase B. The purity sensor already registers those paths as pending, so the
 * first unit that creates one has to promote it to an enforced protected class.
 */

export const PACKAGE_NAME = "@delivery-harness/kernel";

// U2 (V26-1331) — RFC 8785 canonical JSON and the digest helpers built on it.
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
