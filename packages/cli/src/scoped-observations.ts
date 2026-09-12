import path from "node:path";
import { digestCanonical, resolveRecordStorage, type HarnessConfig, type ScopedCheckAttempt } from "@agent-delivery-harness/kernel";
import { AttemptStore } from "./scoped-attempts.ts";
import { CheckSnapshotError } from "./check-snapshot.ts";

export interface ScopedCheckObservations {
  readonly version: "scoped-check-observations/1";
  readonly providers: readonly {
    readonly providerId: string;
    readonly attempts: readonly (ScopedCheckAttempt & { readonly durationMs?: number })[];
  }[];
}

/**
 * Read retained attempts for the supplied scoped providers, in configuration
 * order and ascending generation order. This creates no directories or evidence.
 * Providers removed from this supplied configuration are not inventoried.
 * Absent history is empty; corrupt selected history throws. Durations are reported only
 * when recorded by the executor. These observations make no statement about
 * reuse, current applicability or admission; use the gate/verify for those.
 */
export async function readScopedCheckObservations(input: {
  readonly rootDir: string;
  readonly config: Pick<HarnessConfig, "gateId" | "storageNamespace" | "providers">;
}): Promise<ScopedCheckObservations> {
  const { rootDir, config } = input;
  const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace, leaf: "scoped-attempts" });
  const providers: ScopedCheckObservations["providers"][number][] = [];
  for (const provider of config.providers.filter(provider => provider.check?.scope !== undefined)) {
    const store = new AttemptStore(path.join(storage.storageDir, digestCanonical({ gate: config.gateId, provider: provider.id })));
    const retained = await store.read();
    if (retained.some(row => row.attempt.providerId !== provider.id)) {
      throw new CheckSnapshotError("check_attempt_corrupt", "Scoped check attempt history belongs to a different provider.");
    }
    providers.push({ providerId: provider.id, attempts: retained.map(({ attempt, payload }) => ({
      version: attempt.version, providerId: attempt.providerId, attemptId: attempt.attemptId,
      generation: attempt.generation, inputDigest: attempt.inputDigest, profileDigest: attempt.profileDigest,
      status: attempt.status, origin: { runId: attempt.origin.runId, candidate: {
        treeSha: attempt.origin.candidate.treeSha, deliverableDigest: attempt.origin.candidate.deliverableDigest,
        identityToken: attempt.origin.candidate.identityToken, baseRef: attempt.origin.candidate.baseRef,
        baseTipSha: attempt.origin.candidate.baseTipSha, mergeBaseSha: attempt.origin.candidate.mergeBaseSha,
        workspaceId: attempt.origin.candidate.workspaceId,
      } }, ...(payload?.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
    })) });
  }
  return { version: "scoped-check-observations/1", providers };
}
