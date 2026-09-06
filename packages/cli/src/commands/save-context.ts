import { buildRunEvent } from "../run-surface.ts";
import { installedRelease, policyDigest, recoveryBlocker, recoveryRun } from "../ordinary-context.ts";
import type { CommandDescriptor } from "../boundary.ts";

export const saveContextCommand: CommandDescriptor = {
  name: "save-context", sourceId: "delivery-harness.cli.save-context",
  summary: "Save a bounded delivery contract and stage observation in the current run.",
  async run(context) {
    if (context.args.length !== 2 || context.args[0] !== "--json") return { kind: "usage", message: "Usage: delivery-harness save-context --json '{\"contract\":{\"objective\":\"...\",\"acceptanceCriteria\":[\"...\"],\"finishLine\":\"merge-ready\"},\"stage\":\"work\"}'" };
    let input: { contract?: unknown; stage?: unknown };
    try {
      const value: unknown = JSON.parse(context.args[1]!);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "contract" && key !== "stage")) throw new Error();
      input = value;
    } catch { return { kind: "usage", message: "Context must be a JSON object with only contract and stage." }; }
    const run = await recoveryRun(context.rootDir);
    if (!run.ok) return { kind: "blocked", blockers: [run.blocker] };
    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    if (!capture.ok) return { kind: "blocked", blockers: capture.blockers };
    let release;
    try { release = await installedRelease(context.rootDir); }
    catch { return { kind: "blocked", blockers: [recoveryBlocker("resume_release_unreadable", "The installed workflow release identity cannot be read; restore a valid installation before saving context.")] }; }
    const candidate = capture.candidate;
    const payload = { spec: "ordinary-run-context/1", contract: input.contract, stage: input.stage,
      candidateTreeSha: candidate.treeSha,
      candidateBinding: { deliverableDigest: candidate.deliverable.digest, identity: candidate.deliverable.identity,
        baseRef: candidate.base.ref, baseTipSha: candidate.base.tipSha, mergeBaseSha: candidate.base.mergeBaseSha, workspaceId: candidate.workspaceId },
      policyDigest: policyDigest(context), release };
    const appended = await run.surface.store.append(run.runId, buildRunEvent({ runId: run.runId, commonDir: run.surface.commonDir, kind: "context.saved", role: "executor", payload }));
    if (!appended.ok) return { kind: "blocked", blockers: [recoveryBlocker("resume_context_invalid", "Context was refused by the bounded run-event contract; inspect contract, stage, and secret-free inputs.")] };
    return { kind: "ok", summary: `saved ordinary context for ${run.runId}; stage is an observation, not evidence` };
  },
};
