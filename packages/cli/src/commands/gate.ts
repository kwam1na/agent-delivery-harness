/**
 * `gate` — evaluate the delivery gate and, under a TTY, offer a scoped waiver.
 *
 * The command classifies the execution context from this invocation's env and
 * TTY, then runs the admission adapter. The waiver prompt is the one piece of
 * interactive I/O the CLI owns: it is handed to admission only when the boundary
 * saw a real TTY (the boundary already gated `context.promptForWaiver` on that),
 * so a non-interactive run can never be prompted — it blocks. Admission itself
 * only ever offers a waiver to a `human` context, all-or-nothing over waivable
 * findings; the CLI adds no waiver logic of its own.
 */
import { BlockedError, runAdmission, type AdmissionResult, type LiveProviderResult } from "@agent-delivery-harness/kernel";
import { CliInterruption, type CommandContext, type CommandDescriptor, type CommandResult } from "../boundary.ts";

/**
 * Runs the ordinary admission first, invokes only configured providers that can
 * answer the resulting missing-evidence/live-result blocks, then re-evaluates
 * through the same admission adapter. Configs without provider commands take
 * the pre-existing path unchanged.
 */
export async function runProviderBackedAdmission(
  context: CommandContext,
  options: { readonly allowPrompt: boolean; readonly includeInjectedLiveResults: boolean },
): Promise<AdmissionResult> {
  const wiring = await context.wire();
  const admissionOptions = {
    captureCandidate: wiring.captureCandidate,
    projectActivation: wiring.projectActivation,
    ...wiring.storageOptions,
  };
  const input = {
    rootDir: context.rootDir,
    config: context.config,
    context: context.classifyContext(),
    ...(options.includeInjectedLiveResults && context.liveResults !== undefined ? { liveResults: context.liveResults } : {}),
  };

  const initial = await runAdmission(input, admissionOptions);
  if (initial.admitted || initial.decision === undefined || initial.candidate === undefined) return initial;

  const requested = new Map<string, { obligationIds: string[]; requiresEvidence: boolean; needsLiveResult: boolean }>();
  for (const resolution of initial.decision.resolutions) {
    if (resolution.kind !== "blocked") continue;
    const obligation = context.config.obligations.find((entry) => entry.id === resolution.obligationId);
    if (obligation === undefined) continue;
    const missingCode = obligation.freshness === "live" ? "live_provider_missing" : "review_evidence_missing";
    if (resolution.blockers.some((blocker) => blocker.code !== missingCode)) continue;
    for (const providerId of obligation.providers) {
      const registration = context.config.providers.find((provider) => provider.id === providerId);
      if (registration?.command === undefined) continue;
      const entry = requested.get(providerId) ?? { obligationIds: [], requiresEvidence: false, needsLiveResult: false };
      entry.obligationIds.push(obligation.id);
      entry.requiresEvidence ||= obligation.freshness === "exact_candidate";
      entry.needsLiveResult ||= obligation.freshness === "live";
      requested.set(providerId, entry);
    }
  }

  const liveResults: LiveProviderResult[] = options.includeInjectedLiveResults ? [...(context.liveResults ?? [])] : [];
  for (const [providerId, request] of requested) {
    const result = await context.invokeProvider?.({
      providerId,
      requiresEvidence: request.requiresEvidence,
      payload: {
        gateId: context.config.gateId,
        providerId,
        obligationIds: [...new Set(request.obligationIds)].sort(),
        candidate: initial.candidate,
      },
    });
    if (result === undefined) continue;
    if (result.kind === "interrupted") throw new CliInterruption("Provider invocation interrupted before a trustworthy terminal outcome.");
    if (result.kind === "blocked") throw new BlockedError(result.blockers);
    if (request.needsLiveResult) liveResults.push(result.liveResult);
  }

  return runAdmission(
    { ...input, ...(liveResults.length === 0 ? {} : { liveResults }) },
    {
      ...admissionOptions,
      ...(options.allowPrompt && context.promptForWaiver !== undefined ? { promptForWaiver: context.promptForWaiver } : {}),
    },
  );
}

export const gateCommand: CommandDescriptor = {
  name: "gate",
  sourceId: "delivery-harness.cli.gate",
  summary: "Evaluate the delivery gate for the current candidate.",
  async run(context: CommandContext): Promise<CommandResult> {
    const result = await runProviderBackedAdmission(context, { allowPrompt: true, includeInjectedLiveResults: true });

    if (result.admitted) {
      const waiverNote =
        result.waiver === "accepted"
          ? ` (waived: ${result.waivedObligationIds.join(", ")})`
          : "";
      const kinds = (result.decision?.resolutions ?? []).map((resolution) => `${resolution.obligationId}=${resolution.kind}`);
      return { kind: "ok", summary: `admitted${waiverNote}: ${kinds.join(", ")}` };
    }
    return { kind: "blocked", blockers: [...result.blockers] };
  },
};
