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

// The git-private evidence record store, and the fs-free shapes pure modules
// read it through. The store owns the storage-dir resolver — records and
// preparation receipts are two leaves of one workspace namespace.
export {
  RECORDS_LEAF,
  RECORD_SCHEMA_VERSION,
  computeRecordId,
  discoverRecords,
  publishRecord,
  recordFileName,
  recordIdentity,
  resolveRecordStorage,
  type GitRunner,
  type PublishOptions,
  type RecordSelector,
  type RecordStorageOptions,
} from "./records.ts";
export type {
  EvidenceRecord,
  EvidenceRecordIdentity,
  EvidenceResolution,
  IgnoredStoreEntry,
  PublishRecordInput,
  PublishStatus,
  PublishedRecord,
  QuarantinedRecord,
  RecordCandidateBinding,
  RecordDiscovery,
  RecordIdentity,
  RecordQuarantineReason,
  RecordResolution,
  WaiverResolution,
  WaiverScope,
  WaiverRecordIdentity,
  WorkspaceStorage,
} from "./records.types.ts";
export { RECORD_QUARANTINE_REASONS, WAIVER_SCOPES } from "./records.types.ts";

// The normative manifest validator: the rejection-code registry, the
// delivery-evidence/1 envelope, and the review.green/1 payload. The published
// JSON Schemas sit beside them in validator/schemas/ and are cross-checked
// against this implementation rather than consulted by it.
export {
  CONFORMING_ATTESTATION_LEVEL,
  DELIVERY_EVIDENCE_1,
  MANIFEST_REJECTION_CODES,
  MANIFEST_REJECTION_REGISTRY,
  MANIFEST_RULE_IDS,
  META_RULE_IDS,
  RECORDER_EMITTED_CODES,
  REVIEW_GREEN_1,
  SUPPORTED_ENVELOPE_SPECS,
  SUPPORTED_PAYLOAD_SPECS,
  VALIDATOR_EMITTED_CODES,
  isManifestRejectionCode,
  type ManifestRejection,
  type ManifestRejectionCode,
  type ManifestRejectionCodeEntry,
  type ManifestRuleId,
  type ManifestValidation,
  type RejectionEmitter,
} from "./validator/codes.ts";
export {
  validateManifest,
  type DeclaredArtifact,
  type DeliveryEvidenceManifest,
  type ManifestArtifact,
  type ManifestAttestation,
  type ManifestBase,
  type ManifestCandidate,
  type ManifestClaim,
  type ManifestDeliverable,
  type ManifestProvider,
  type ManifestValidationContext,
  type RunHistoryEntry,
} from "./validator/envelope.ts";
export {
  FINDING_DISPOSITIONS,
  FINDING_SCOPES,
  FINDING_SEVERITIES,
  REVIEWER_APPROVAL_ROLE,
  validateReviewGreenClaim,
  type ReviewGreenClaimInput,
} from "./validator/review-green.ts";

// The candidate: what is about to be reviewed. The shapes and every decision
// that can be made about a candidate without touching a repository come from
// `candidate.types.ts`; the git-bound capture and projection sit beside them.
export {
  CANDIDATE_CAPTURE_CODES,
  CANDIDATE_DIFF_UNREADABLE,
  CANDIDATE_DRIFT_CLASSES,
  CANDIDATE_MODES,
  CANDIDATE_PATH_CLASSES,
  CANDIDATE_VCS,
  classifyCandidateDrift,
  classifyCandidatePath,
  isObligationActive,
  matchesPathMatcher,
  projectReviewActivation,
  sensitiveGroupsFor,
  type CandidateBase,
  type CandidateBinding,
  type CandidateCapture,
  type CandidateCaptureCode,
  type CandidateDeliverable,
  type CandidateDiffEntry,
  type CandidateDriftClass,
  type CandidateMode,
  type CandidatePathClass,
  type CandidateStatusEntry,
  type CandidateVcs,
  type CaptureCandidate,
  type CapturedCandidate,
  type ComputeIdentity,
  type DeliverableIdentityRequest,
  type ReviewActivationProjection,
} from "./candidate.types.ts";
export {
  DEFAULT_CAPTURE_ATTEMPTS,
  captureGitCandidate,
  createCandidateCapture,
  evaluateCandidateActivation,
  parseCandidateNumstat,
  runGitCommand,
  type CandidateActivationOptions,
  type CandidateCaptureOptions,
  type CandidateCommandResult,
  type CandidateCommandRunner,
} from "./candidate.ts";

// Preparation receipts: the ordering mechanism the review context and the gate
// both consult before anything else.
export {
  HARNESS_VERSION,
  PREPARATION_FAILURE_CLASSES,
  PREPARATION_RECEIPT_LEAF,
  PREPARATION_RECEIPT_SCHEMA_VERSION,
  computePreparationFingerprint,
  evaluatePreparationReceipt,
  publishPreparationReceipt,
  receiptFileName,
  resolveReceiptStorage,
  type PreparationCandidate,
  type PreparationEvaluation,
  type PreparationFailureClass,
  type PreparationInput,
  type PreparationOptions,
  type PreparationReceipt,
  type PublishedPreparationReceipt,
} from "./preparation.ts";
