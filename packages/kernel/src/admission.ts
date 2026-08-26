/**
 * The admission adapter — RED STUB.
 *
 * This is the throwing skeleton committed to record a failing suite before the
 * effectful seam exists. Every entry point rejects; the real orchestration
 * lands in the next commit.
 */
import type { Blocker } from "./blockers.ts";
import type { CandidateBinding, CapturedCandidate, CaptureCandidate, ReviewActivationProjection } from "./candidate.types.ts";
import type { HarnessConfig } from "./config.ts";
import type { ExecutionContext } from "./context.ts";
import type { GateDecision, LiveProviderResult } from "./evaluator.ts";
import type { PreparationEvaluation } from "./preparation.ts";
import type { RecordStorageOptions } from "./records.ts";
import type { PublishedRecord, RecordCandidateBinding, RecordDiscovery } from "./records.types.ts";

export const INVOCATION_WAIVER_SCOPE = "invocation" as const;

export type WaiverPrompt = (decision: GateDecision, obligationIds: readonly string[]) => Promise<boolean>;

export type WaiverPromptOutcome = "not_offered" | "accepted" | "declined" | "candidate_changed";

export interface AdmissionInput {
  readonly rootDir: string;
  readonly config: HarnessConfig;
  readonly context: ExecutionContext;
  readonly liveResults?: readonly LiveProviderResult[];
}

export interface AdmissionOptions extends RecordStorageOptions {
  readonly captureCandidate: CaptureCandidate;
  readonly projectActivation: (candidate: CapturedCandidate) => Promise<ReviewActivationProjection>;
  readonly promptForWaiver?: WaiverPrompt;
  readonly evaluatePreparation?: (rootDir: string, config: HarnessConfig, candidate: CapturedCandidate) => Promise<PreparationEvaluation>;
  readonly discoverRecords?: (rootDir: string, gateId: string, obligationId: string) => Promise<RecordDiscovery>;
  readonly publishWaiver?: (rootDir: string, binding: RecordCandidateBinding, obligationId: string) => Promise<PublishedRecord>;
  readonly harnessVersion?: string;
}

export interface AdmissionResult {
  readonly admitted: boolean;
  readonly blockers: readonly Blocker[];
  readonly decision?: GateDecision;
  readonly context?: ExecutionContext;
  readonly candidate?: CandidateBinding;
  readonly waiver: WaiverPromptOutcome;
  readonly waivedObligationIds: readonly string[];
  readonly waiverRecordIds: readonly string[];
}

export function runAdmission(_input: AdmissionInput, _options: AdmissionOptions): Promise<AdmissionResult> {
  throw new Error("V26-1340: admission adapter not implemented");
}
