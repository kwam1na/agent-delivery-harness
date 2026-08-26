/**
 * Who is running the gate, and what that entitles them to.
 *
 * STUB. The tests beside this file were written first and every function here
 * throws, so the suite is red until the classifier lands.
 */
import type { EnvironmentRequirement, HarnessConfig } from "./config.ts";

export const EXECUTION_CONTEXT_KINDS = ["ci", "agent", "human", "unknown"] as const;
export type ExecutionContextKind = (typeof EXECUTION_CONTEXT_KINDS)[number];

export const UNKNOWN_CONTEXT_REASONS = ["unauthorized_automation", "noninteractive_unrecognized"] as const;
export type UnknownContextReason = (typeof UNKNOWN_CONTEXT_REASONS)[number];

export interface CiExecutionContext {
  readonly kind: "ci";
  readonly policyId: string;
  readonly requiredEnv: readonly EnvironmentRequirement[];
}

export interface AgentExecutionContext {
  readonly kind: "agent";
  readonly signal: string;
}

export interface HumanExecutionContext {
  readonly kind: "human";
  readonly interactive: true;
}

export interface UnknownExecutionContext {
  readonly kind: "unknown";
  readonly reason: UnknownContextReason;
}

export type ExecutionContext = CiExecutionContext | AgentExecutionContext | HumanExecutionContext | UnknownExecutionContext;

export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

export interface ClassifyExecutionContextInput {
  readonly config: HarnessConfig;
  readonly env: EnvSnapshot;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

export function isEnvSignalPresent(_value: string | undefined): boolean {
  throw new Error("isEnvSignalPresent is not implemented yet.");
}

export function classifyExecutionContext(_input: ClassifyExecutionContextInput): ExecutionContext {
  throw new Error("classifyExecutionContext is not implemented yet.");
}
