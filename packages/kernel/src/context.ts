/**
 * Who is running the gate, and what that entitles them to.
 *
 * THE LADDER IS ASYMMETRIC ON PURPOSE. Four rungs, in strictly descending
 * order of what they may do:
 *
 *   ci     — repository-authorized automation. May carry a delegated
 *            obligation, because a declared policy says which job answers for
 *            it and the environment corroborates that the job is the one
 *            running. It may not waive: nobody is present to accept anything.
 *   agent  — a recognized coding agent. May satisfy an obligation with
 *            evidence, and may never waive one. An agent that could waive
 *            could waive its own review.
 *   human  — an interactive person, both streams on a terminal. The only rung
 *            the waiver door opens for, and only for the codes the config
 *            classifies as waivable.
 *   unknown— everything else. Satisfies nothing on its own.
 *
 * THE ENVIRONMENT IS A PARAMETER. This module never touches `process`. The
 * caller hands over a snapshot, which is what lets the whole gate be exercised
 * as a decision table and keeps the module inside the purity sensor's d1 class.
 *
 * A PARTIAL CI MATCH IS AN UNAUTHORIZED AUTOMATION, NEVER A DOWNGRADE. This is
 * the rule with the most ways to get subtly wrong, so it is stated once and
 * applied in every direction: if anything in the environment claims to be a
 * declared automation — the policy env key naming a policy, or any declared
 * policy's corroborating variable already standing at its declared value — then
 * the run must match one declared policy *completely* or it is
 * `unauthorized_automation`. It does not fall back to "an ordinary shell", and
 * a terminal does not rescue it. The failure mode being closed off is the one
 * where an automation with a half-configured environment quietly acquires the
 * rights of whichever rung it happens to land on next.
 *
 * A PTY NEVER PROMOTES AN AGENT. Agents attach terminals; the interactive check
 * runs strictly after the agent check, so no arrangement of streams turns a
 * recognized agent into a person.
 *
 * NOTHING HERE IS A LITERAL. Athena's classifier hardcoded one workflow, one
 * job, one event name and one policy id. Every one of those is config data
 * here, and the returned CI context carries the matched policy's own values, so
 * a caller reads what authorized this run rather than what this module was
 * written believing.
 */
import type { EnvironmentRequirement, HarnessConfig } from "./config.ts";

/** The four rungs. Ordered as the ladder is ordered. */
export const EXECUTION_CONTEXT_KINDS = ["ci", "agent", "human", "unknown"] as const;
export type ExecutionContextKind = (typeof EXECUTION_CONTEXT_KINDS)[number];

/**
 * Why a run is anonymous. The two are kept apart because they mean opposite
 * things to an operator: one is an automation that failed to prove itself and
 * should be repaired, the other is an ordinary non-interactive shell and is
 * nobody's defect.
 */
export const UNKNOWN_CONTEXT_REASONS = ["unauthorized_automation", "noninteractive_unrecognized"] as const;
export type UnknownContextReason = (typeof UNKNOWN_CONTEXT_REASONS)[number];

export interface CiExecutionContext {
  readonly kind: "ci";
  /** The id of the policy that matched — the config's value, not a literal. */
  readonly policyId: string;
  /** The corroboration that matched, carried so a caller can show its work. */
  readonly requiredEnv: readonly EnvironmentRequirement[];
}

export interface AgentExecutionContext {
  readonly kind: "agent";
  /** The declared signal that identified the agent, as the config named it. */
  readonly signal: string;
}

export interface HumanExecutionContext {
  readonly kind: "human";
  /** Always true: a non-interactive human is indistinguishable from a script. */
  readonly interactive: true;
}

export interface UnknownExecutionContext {
  readonly kind: "unknown";
  readonly reason: UnknownContextReason;
}

export type ExecutionContext = CiExecutionContext | AgentExecutionContext | HumanExecutionContext | UnknownExecutionContext;

/** A read-only view of the environment, handed in rather than reached for. */
export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

export interface ClassifyExecutionContextInput {
  readonly config: HarnessConfig;
  readonly env: EnvSnapshot;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

/**
 * Whether a declared signal variable is *asserting* something.
 *
 * The four denied spellings are the ones a shell produces when something is
 * switched off rather than absent — an unset variable, an empty one, and the
 * two falsey words CI systems write. Treating `AGENT=false` as "an agent is
 * present" would let a switched-off signal confer a rung.
 */
export function isEnvSignalPresent(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function isCorroborated(requiredEnv: readonly EnvironmentRequirement[], env: EnvSnapshot): boolean {
  return requiredEnv.every((requirement) => env[requirement.variable] === requirement.equals);
}

/**
 * Whether the environment shows any sign of a declared automation.
 *
 * Deliberately a *partial* test: one corroborating variable already standing at
 * its declared value is enough to make the run a claim that must be proven in
 * full. Athena reached the same place through a vendor literal
 * (`GITHUB_ACTIONS === "true"`); the vendor-neutral reading is that the config's
 * own corroboration surface is what defines "looks like automation here". The
 * cost is that a shell which happens to export one of those variables is
 * classified as an unauthorized automation rather than as a person — which is
 * the fail-closed direction, and is repaired by unsetting the variable rather
 * than by weakening the rule.
 */
function claimsAutomation(config: HarnessConfig, env: EnvSnapshot): boolean {
  return config.ciPolicies.some((policy) =>
    policy.requiredEnv.some((requirement) => env[requirement.variable] === requirement.equals),
  );
}

export function classifyExecutionContext({ config, env, stdinIsTTY, stdoutIsTTY }: ClassifyExecutionContextInput): ExecutionContext {
  const declaredPolicyId = env[config.ciPolicyEnvKey];
  const declared = isEnvSignalPresent(declaredPolicyId) ? declaredPolicyId : undefined;

  if (declared !== undefined || claimsAutomation(config, env)) {
    // Two halves, and both must hold: the run has to *name* the policy it is
    // running under, and the environment has to agree. Naming without
    // corroboration is a copied variable; corroboration without naming is a job
    // that never declared itself. Neither is authorization.
    const named = config.ciPolicies.find((policy) => policy.id === declared);
    if (named !== undefined && isCorroborated(named.requiredEnv, env)) {
      return { kind: "ci", policyId: named.id, requiredEnv: named.requiredEnv };
    }
    return { kind: "unknown", reason: "unauthorized_automation" };
  }

  for (const signal of config.agentEnvSignals) {
    if (isEnvSignalPresent(env[signal])) return { kind: "agent", signal };
  }

  // Both streams, because one is what a pipeline leaves behind. A prompt read
  // from a pipe is not a person answering it.
  if (stdinIsTTY && stdoutIsTTY) return { kind: "human", interactive: true };

  return { kind: "unknown", reason: "noninteractive_unrecognized" };
}
