import { readFile } from "node:fs/promises";
import path from "node:path";
import { HARNESS_VERSION, digestCanonical, type Blocker, type RunEvent, type RunEventVersion } from "@agent-delivery-harness/kernel";
import { commandBlocker, type CommandContext } from "./boundary.ts";
import { oneLine, resolveRunSurface, type RunSurface } from "./run-surface.ts";

export function recoveryBlocker(code: string, summary: string, details?: string): Blocker {
  return commandBlocker({ code, sourceId: "delivery-harness.cli.resume", summary,
    ...(details === undefined ? {} : { details }),
    remediations: [{ id: "reconcile-delivery-context", kind: "manual_action", summary: "Inspect the saved context and actual workspace/external state with host tools; rerun preparation and gates where evidence is not current. Never replay an uncertain action automatically." }],
  });
}

/**
 * What a store rejection may say to an operator: the store's own code, the
 * JSON pointer at the offending member, and the store's own message. All three
 * are written by the store rather than taken from the refused payload, so the
 * diagnostic names the field without ever echoing its value — a contract a
 * caller must keep, because the payload it refused is the one place a
 * credential could have been.
 */
export function rejectionDetails(rejections: readonly { readonly code: string; readonly pointer: string; readonly message: string }[]): string {
  const first = rejections[0];
  if (first === undefined) return "the store refused the append";
  return `${oneLine(first.code, 64)} at ${oneLine(first.pointer, 128) || "/"}: ${oneLine(first.message, 200)}`;
}

/**
 * The writer members an ordinary-context event carries, for the version the
 * selected run was started at.
 *
 * WHY THE ID IS DERIVED FROM THE OBSERVATION. A v2 event id is a retry key:
 * the store admits a repeat of an id only when the whole event matches, and
 * refuses the id outright for different content. An id derived from the
 * payload's canonical digest is therefore exactly the key the contract wants —
 * the same save repeated is the same event and appends nothing new, while a
 * changed observation is a different id and a new entry, so neither an
 * interrupted retry nor a genuine second save can produce a refusal an
 * operator has to reason about. It is also stable across processes and hosts,
 * which a random id is not.
 */
export function ordinaryEventWriter(version: RunEventVersion, kind: string, payload: unknown): {
  readonly version: RunEventVersion;
  readonly eventId?: string;
} {
  if (version !== "run-event/2") return { version };
  // `kind` scopes the digest so two kinds can never collide on one id, and the
  // whole id stays inside the store's 128-character run-id charset.
  return { version, eventId: `${kind.replaceAll(".", "-")}-${digestCanonical({ kind, payload })}` };
}

export async function recoveryRun(rootDir: string, named?: string): Promise<
  { ok: true; surface: RunSurface; runId: string; events: readonly RunEvent[]; version: RunEventVersion } | { ok: false; blocker: Blocker }
> {
  const resolved = await resolveRunSurface(rootDir);
  if (!resolved.ok) return { ok: false, blocker: recoveryBlocker("resume_context_invalid", "The repository run store cannot be read.") };
  const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
  const runId = named ?? (current.ok ? current.runId : undefined);
  if (!runId) return { ok: false, blocker: recoveryBlocker("resume_context_missing", "No current delivery run was found; start a run or name its existing id with --run.") };
  const read = await resolved.surface.store.read(runId);
  if (!read.ok) return { ok: false, blocker: recoveryBlocker("resume_context_invalid", "The delivery journal is missing, corrupt, or inaccessible.", rejectionDetails(read.rejections)) };
  // The writer version is selected when the run starts and never upgraded, so
  // every writer into this journal reads it from the journal's first event.
  return { ok: true, surface: resolved.surface, runId, events: read.events, version: read.events[0]?.version ?? "run-event/1" };
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
