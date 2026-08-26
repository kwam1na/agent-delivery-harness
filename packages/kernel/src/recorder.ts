/**
 * The submission flow (spec §8.3). Not yet implemented: the conformance kit's
 * integration mode is the failing suite this unit is written against.
 */
import type { Blocker, NonEmptyTuple } from "./blockers.ts";
import type { ArtifactsPort } from "./artifacts.types.ts";
import type { CandidateDriftClass, CaptureCandidate, CapturedCandidate } from "./candidate.types.ts";
import type { HarnessConfig } from "./config.ts";
import type { RecordStorageOptions } from "./records.ts";
import type { EvidenceRecord, PublishedRecord } from "./records.types.ts";
import type { ManifestRejection } from "./validator/codes.ts";

export interface SubmissionInput {
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly config: HarnessConfig;
}

export interface SubmissionOptions extends RecordStorageOptions {
  readonly captureCandidate: CaptureCandidate;
  readonly artifacts?: ArtifactsPort;
  readonly harnessVersion?: string;
}

export interface SubmissionRecord {
  readonly obligationId: string;
  readonly recordId: string;
  readonly path: string;
  readonly status: PublishedRecord["status"];
  readonly record: EvidenceRecord;
}

export type SubmissionOutcome =
  | { readonly status: "accepted"; readonly manifestDigest: string; readonly records: NonEmptyTuple<SubmissionRecord> }
  | { readonly status: "rejected"; readonly rejections: NonEmptyTuple<ManifestRejection>; readonly blockers: NonEmptyTuple<Blocker> }
  | { readonly status: "blocked"; readonly blockers: NonEmptyTuple<Blocker> };

export const SUBMISSION_CANDIDATE_FIELDS: readonly string[] = Object.freeze([
  "vcs",
  "treeSha",
  "headSha",
  "deliverable.digest",
  "deliverable.identity",
  "base.ref",
  "base.tipSha",
  "base.mergeBaseSha",
  "workspaceId",
]);

export interface CandidateComparison {
  readonly matches: boolean;
  readonly mismatchedFields: readonly string[];
  readonly driftClasses: readonly CandidateDriftClass[];
}

export function compareSubmissionCandidate(_submitted: unknown, _captured: CapturedCandidate): CandidateComparison {
  throw new Error("recorder is not implemented");
}

export function submitManifest(_input: SubmissionInput, _options: SubmissionOptions): Promise<SubmissionOutcome> {
  throw new Error("recorder is not implemented");
}
