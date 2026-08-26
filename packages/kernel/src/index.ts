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

// The deliverable identity: the digest review evidence is bound to, and the two
// neutral predicates. Only `reviewNeutral` reaches the digest; `recordNeutral`
// is exported beside it so the difference is read in one place rather than
// re-derived. Byte-compatible with Athena's `deliverable-tree/v1` under that
// token's narration set, which the goldens corpus pins.
export {
  IDENTITY_DOMAIN,
  IDENTITY_FINDING_CODES,
  computeDeliverableIdentity,
  digestDeliverableEntries,
  identityDefinitionOf,
  isRecordNeutralPath,
  isReviewNeutralPath,
  parseTreeEntries,
  withDeliverableIdentity,
  type DeliverableIdentityDefinition,
  type DeliverableIdentityOptions,
  type DeliverableTreeEntry,
  type IdentityFindingCode,
} from "./identity.ts";

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

// Who is running the gate, and what that entitles them to. The classifier reads
// a *given* environment snapshot rather than the ambient process, so a caller
// decides what the gate is allowed to see.
export {
  EXECUTION_CONTEXT_KINDS,
  UNKNOWN_CONTEXT_REASONS,
  classifyExecutionContext,
  isEnvSignalPresent,
  type AgentExecutionContext,
  type CiExecutionContext,
  type ClassifyExecutionContextInput,
  type EnvSnapshot,
  type ExecutionContext,
  type ExecutionContextKind,
  type HumanExecutionContext,
  type UnknownContextReason,
  type UnknownExecutionContext,
} from "./context.ts";

// The pure gate evaluator: six outcomes that never stand in for one another,
// freshness judged by deliverable identity, and the waiver's narrow door.
export {
  RESOLUTION_OUTCOMES,
  enforceAllowedResolution,
  evaluateGate,
  isRecordFreshForCandidate,
  type BlockedResolution,
  type DelegatedResolution,
  type EvaluateGateInput,
  type GateDecision,
  type LiveProviderFinding,
  type LiveProviderResult,
  type NotApplicableResolution,
  type ObligationFinding,
  type ObligationResolution,
  type ResolutionOutcome,
  type SatisfiedEvidenceResolution,
  type SatisfiedLiveFactResolution,
  type UnreadableRecordInput,
  type WaivedResolution,
} from "./evaluator.ts";

// The filesystem port. Run roots, containment, artifact observation and one
// atomic write — the only place the submission path opens a file, which is what
// makes the no-ad-hoc-fs rule over the recorder enforceable.
export {
  ARTIFACT_OBSERVATION_STATUSES,
  RUN_ROOT_LEAF,
  RUN_ROOT_NAMESPACE,
  RUN_ROOT_REFUSAL_REASONS,
  createArtifactsPort,
  defaultRunRootBase,
  isInsideResolved,
  isSafeRelativePath,
  type ArtifactObservation,
  type ArtifactObservationStatus,
  type ArtifactsPort,
  type ArtifactsPortOptions,
  type RunRoot,
  type RunRootRefusalReason,
  type RunRootRequest,
  type RunRootResolution,
  type WriteFileOptions,
} from "./artifacts.ts";

// The submission flow: spec §8.3 from a manifest on disk to published records.
export {
  SUBMISSION_CANDIDATE_FIELDS,
  compareSubmissionCandidate,
  submitManifest,
  type CandidateComparison,
  type SubmissionInput,
  type SubmissionOptions,
  type SubmissionOutcome,
  type SubmissionRecord,
} from "./recorder.ts";
