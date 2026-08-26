/**
 * Preparation receipts — the kernel's ordering mechanism.
 *
 * STUB. Every function here throws. The tests in `preparation.test.ts` are
 * written first and must be red against this file; the implementation lands in
 * the next commit. Only the declared shapes and the two enumerations the test
 * tables are driven from are real, because a table over an empty constant
 * asserts nothing.
 */
import type { Blocker, NonEmptyTuple } from "./blockers.ts";
import type { CandidateBinding, CandidateMode } from "./candidate.types.ts";
import type { HarnessConfig } from "./config.ts";
import type { RecordStorageOptions } from "./records.ts";
import type { WorkspaceStorage } from "./records.types.ts";

export const PREPARATION_RECEIPT_SCHEMA_VERSION = 1;

export const PREPARATION_RECEIPT_LEAF = "preparation";

export const HARNESS_VERSION = "0.0.0";

export const PREPARATION_FAILURE_CLASSES = ["missing", "invalid", "wiring_mismatch", "base_changed", "stale"] as const;

export type PreparationFailureClass = (typeof PREPARATION_FAILURE_CLASSES)[number];

export type PreparationCandidate = CandidateBinding & {
  readonly headSha: string;
  readonly mode: CandidateMode;
};

export interface PreparationReceipt {
  readonly schemaVersion: number;
  readonly gateId: string;
  readonly workspaceId: string;
  readonly treeSha: string;
  readonly headSha: string;
  readonly mode: CandidateMode;
  readonly deliverableDigest: string;
  readonly identityToken: string;
  readonly baseRef: string;
  readonly baseTipSha: string;
  readonly mergeBaseSha: string;
  readonly candidateWorkspaceId: string;
  readonly preparationFingerprint: string;
}

export interface PreparationOptions extends RecordStorageOptions {
  readonly harnessVersion?: string;
}

export interface PreparationInput {
  readonly config: HarnessConfig;
  readonly candidate: PreparationCandidate;
}

export interface PublishedPreparationReceipt {
  readonly path: string;
  readonly receipt: PreparationReceipt;
  readonly workspaceId: string;
}

export type PreparationEvaluation =
  | {
      readonly prepared: true;
      readonly receipt: PreparationReceipt;
      readonly receiptPath: string;
      readonly workspaceId: string;
    }
  | {
      readonly prepared: false;
      readonly failure: PreparationFailureClass;
      readonly reason: string;
      readonly receiptPath: string;
      readonly workspaceId: string;
      readonly blockers: NonEmptyTuple<Blocker>;
    };

function unimplemented(name: string): never {
  throw new Error(`${name} is not implemented`);
}

export function receiptFileName(_gateId: string): string {
  return unimplemented("receiptFileName");
}

export function resolveReceiptStorage(_rootDir: string, _options: PreparationOptions = {}): Promise<WorkspaceStorage> {
  return unimplemented("resolveReceiptStorage");
}

export function computePreparationFingerprint(
  _rootDir: string,
  _config: HarnessConfig,
  _options: PreparationOptions = {},
): Promise<string> {
  return unimplemented("computePreparationFingerprint");
}

export function publishPreparationReceipt(
  _rootDir: string,
  _input: PreparationInput,
  _options: PreparationOptions = {},
): Promise<PublishedPreparationReceipt> {
  return unimplemented("publishPreparationReceipt");
}

export function evaluatePreparationReceipt(
  _rootDir: string,
  _input: PreparationInput,
  _options: PreparationOptions = {},
): Promise<PreparationEvaluation> {
  return unimplemented("evaluatePreparationReceipt");
}
