import { readFile } from "node:fs/promises";
import path from "node:path";
import { HARNESS_VERSION, digestCanonical, type Blocker, type RunEvent } from "@agent-delivery-harness/kernel";
import { commandBlocker, type CommandContext } from "./boundary.ts";
import { resolveRunSurface, type RunSurface } from "./run-surface.ts";

export function recoveryBlocker(code: string, summary: string): Blocker {
  return commandBlocker({ code, sourceId: "delivery-harness.cli.resume", summary,
    remediations: [{ id: "reconcile-delivery-context", kind: "manual_action", summary: "Inspect the saved context and actual workspace/external state with host tools; rerun preparation and gates where evidence is not current. Never replay an uncertain action automatically." }],
  });
}

export async function recoveryRun(rootDir: string, named?: string): Promise<
  { ok: true; surface: RunSurface; runId: string; events: readonly RunEvent[] } | { ok: false; blocker: Blocker }
> {
  const resolved = await resolveRunSurface(rootDir);
  if (!resolved.ok) return { ok: false, blocker: recoveryBlocker("resume_context_invalid", "The repository run store cannot be read.") };
  const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
  const runId = named ?? (current.ok ? current.runId : undefined);
  if (!runId) return { ok: false, blocker: recoveryBlocker("resume_context_missing", "No current delivery run was found; start a run or name its existing id with --run.") };
  const read = await resolved.surface.store.read(runId);
  if (!read.ok) return { ok: false, blocker: recoveryBlocker("resume_context_invalid", "The delivery journal is missing, corrupt, or inaccessible.") };
  return { ok: true, surface: resolved.surface, runId, events: read.events };
}

export async function installedRelease(rootDir: string) {
  const document: unknown = JSON.parse(await readFile(path.join(rootDir, ".agent-skills/active.json"), "utf8"));
  const release = (document as { release?: { releaseId?: unknown; profile?: unknown; archiveSha256?: unknown } } | null)?.release;
  if (!release || typeof release.releaseId !== "string" || typeof release.profile !== "string" ||
      typeof release.archiveSha256 !== "string" || !/^[0-9a-f]{64}$/.test(release.archiveSha256)) {
    throw new Error("Installed workflow release identity is missing or malformed.");
  }
  return { runtimeVersion: HARNESS_VERSION, releaseId: release.releaseId, profile: release.profile, archiveSha256: release.archiveSha256 };
}

export const policyDigest = (context: CommandContext) => digestCanonical({ config: context.config, policyBinding: context.policyBinding ?? null });

/** Observed action outcomes are a host handoff, never permission to invoke an action. */
export function reconciliationActions(events: readonly RunEvent[]) {
  const actions = new Map<string, { actionId: string; operation?: unknown; reference: unknown; outcome: string; inconsistent?: boolean }>();
  for (const event of events) {
    const p = event.payload;
    if (event.kind === "action.intent") {
      const actionId = p["actionId"] as string;
      const prior = actions.get(actionId);
      actions.set(actionId, { actionId, operation: p["operation"], reference: p["reference"], outcome: "unknown", ...(prior ? { inconsistent: true } : {}) });
    } else if (event.kind === "action.observed") {
      const actionId = p["actionId"] as string;
      const prior = actions.get(actionId);
      actions.set(actionId, { ...prior, actionId, reference: p["reference"], outcome: p["outcome"] as string,
        ...(!prior || prior.inconsistent || (prior.outcome !== "unknown" && prior.outcome !== p["outcome"]) ? { inconsistent: true } : {}) });
    }
  }
  return [...actions.values()];
}
