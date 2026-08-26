/** Candidate capture and the activation projection. Implementation pending. */
import type { HarnessConfig } from "./config.ts";
import type {
  CandidateCapture,
  CandidateDiffEntry,
  CapturedCandidate,
  CaptureCandidate,
  ComputeIdentity,
  ReviewActivationProjection,
} from "./candidate.types.ts";

export const DEFAULT_CAPTURE_ATTEMPTS = 3;

export interface CandidateCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CandidateCommandRunner = (
  command: readonly string[],
  options: { readonly cwd: string },
) => Promise<CandidateCommandResult>;

export interface CandidateCaptureOptions {
  readonly rootDir: string;
  readonly config: HarnessConfig;
  readonly workspaceId: string;
  readonly computeIdentity: ComputeIdentity;
  readonly run?: CandidateCommandRunner;
  readonly maxAttempts?: number;
}

export interface CandidateActivationOptions {
  readonly rootDir: string;
  readonly candidate: CapturedCandidate;
  readonly config: HarnessConfig;
  readonly run?: CandidateCommandRunner;
}

const PENDING = "candidate capture is not implemented";

export const runGitCommand: CandidateCommandRunner = () => {
  throw new Error(PENDING);
};

export function captureGitCandidate(_options: CandidateCaptureOptions): Promise<CandidateCapture> {
  throw new Error(PENDING);
}

export function createCandidateCapture(_options: CandidateCaptureOptions): CaptureCandidate {
  throw new Error(PENDING);
}

export function parseCandidateNumstat(_output: string): CandidateDiffEntry[] {
  throw new Error(PENDING);
}

export function evaluateCandidateActivation(_options: CandidateActivationOptions): Promise<ReviewActivationProjection> {
  throw new Error(PENDING);
}
