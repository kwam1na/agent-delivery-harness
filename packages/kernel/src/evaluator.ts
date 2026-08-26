/**
 * The pure gate evaluator.
 *
 * STUB. The tests beside this file were written first and every function here
 * throws, so the suite is red until the decision table lands.
 */
import type { Blocker, NonEmptyTuple } from "./blockers.ts";
import type { CandidateBinding, ReviewActivationProjection } from "./candidate.types.ts";
import type { HarnessConfig, ObligationPolicy } from "./config.ts";
import type { ExecutionContext } from "./context.ts";
import type { EvidenceRecord, QuarantinedRecord, RecordCandidateBinding, WaiverScope } from "./records.types.ts";

export const RESOLUTION_OUTCOMES = [
  "satisfied_live_fact",
  "satisfied_evidence",
  "waived",
  "delegated",
  "not_applicable",
  "blocked",
] as const;

export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

export interface LiveProviderFinding {
  readonly code: string;
  readonly summary: string;
  readonly details?: string;
}

export interface LiveProviderResult {
  readonly providerId: string;
  readonly runId: string;
  readonly status: "green" | "failed";
  readonly findings: readonly LiveProviderFinding[];
}

export interface UnreadableRecordInput {
  readonly gateId: string;
  readonly obligationId: string;
  readonly appliesToCandidate: boolean;
  readonly quarantined: QuarantinedRecord;
}

export interface ObligationFinding {
  readonly code: string;
  readonly obligationId: string;
  readonly providerId?: string;
  readonly recordId?: string;
  readonly blocker: Blocker;
}

interface ResolutionBase {
  readonly gateId: string;
  readonly obligationId: string;
}

export interface SatisfiedLiveFactResolution extends ResolutionBase {
  readonly kind: "satisfied_live_fact";
  readonly providerId: string;
  readonly runId: string;
}

export interface SatisfiedEvidenceResolution extends ResolutionBase {
  readonly kind: "satisfied_evidence";
  readonly providerId: string;
  readonly recordId: string;
  readonly runId: string;
  readonly finalPassId: string;
  readonly candidateBinding: RecordCandidateBinding;
}

export interface WaivedResolution extends ResolutionBase {
  readonly kind: "waived";
  readonly waiverRecordId: string;
  readonly scope: WaiverScope;
  readonly candidateBinding: RecordCandidateBinding;
}

export interface DelegatedResolution extends ResolutionBase {
  readonly kind: "delegated";
  readonly ciPolicyId: string;
}

export interface NotApplicableResolution extends ResolutionBase {
  readonly kind: "not_applicable";
  readonly activation: ReviewActivationProjection;
}

export interface BlockedResolution extends ResolutionBase {
  readonly kind: "blocked";
  readonly blockers: NonEmptyTuple<Blocker>;
}

export type ObligationResolution =
  | SatisfiedLiveFactResolution
  | SatisfiedEvidenceResolution
  | WaivedResolution
  | DelegatedResolution
  | NotApplicableResolution
  | BlockedResolution;

export interface EvaluateGateInput {
  readonly config: HarnessConfig;
  readonly candidate: CandidateBinding;
  readonly projection: ReviewActivationProjection;
  readonly context: ExecutionContext;
  readonly records: readonly EvidenceRecord[];
  readonly unreadable?: readonly UnreadableRecordInput[];
  readonly liveResults?: readonly LiveProviderResult[];
  readonly invocationWaiverRecordIds?: readonly string[];
}

export interface GateDecision {
  readonly gateId: string;
  readonly candidate: CandidateBinding;
  readonly admitted: boolean;
  readonly resolutions: readonly ObligationResolution[];
  readonly diagnostics: readonly ObligationFinding[];
  readonly blockers: readonly Blocker[];
}

export function isRecordFreshForCandidate(
  _config: HarnessConfig,
  _recorded: RecordCandidateBinding,
  _candidate: CandidateBinding,
): boolean {
  throw new Error("isRecordFreshForCandidate is not implemented yet.");
}

export function enforceAllowedResolution(
  _obligation: ObligationPolicy,
  _resolution: ObligationResolution,
): ObligationResolution {
  throw new Error("enforceAllowedResolution is not implemented yet.");
}

export function evaluateGate(_input: EvaluateGateInput): GateDecision {
  throw new Error("evaluateGate is not implemented yet.");
}
