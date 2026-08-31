/**
 * THE BINDING'S PROJECTION-CONSUMPTION WRITER.
 *
 * The binding already injects a per-run consumption marker into the
 * materialized projection and reads it back from fence-bound submissions.
 * What that mechanism produces is an OBSERVATION, alive only for the length of
 * one invocation. The shadow milestone's gate compares deliveries against a
 * frozen baseline, and it can only count a delivery that carries a durable
 * consumption record — so something has to turn the observation into an entry
 * in the consuming repository's gate-record artifact. This module is that step
 * and nothing more.
 *
 * WHY IT LIVES IN THE BINDING. The whole point of the consuming guard's rule
 * is that the claim is binding-sourced rather than agent-supplied: a session
 * asserting "I consumed the projection" proves nothing, because a session can
 * assert anything. So the writer takes NO claim from its caller. It re-derives
 * every fact itself, from binding-owned state:
 *
 *   - the projection digest, from the materialization receipt in the binding's
 *     own directory, re-verified against the worktree bytes;
 *   - the marker, read back out of the receipted projection subtree; and
 *   - the model-external interceptor's observation that an allowed invocation
 *     of THIS run named, in a member that names files, a receipted path under
 *     the projection subtree.
 *
 * THE THIRD FACT IS THE ONLY ONE ABOUT THE RUN. The first two are both true
 * the instant materialization returns: the receipt matches the bytes the
 * binding just wrote, and the marker is a file the binding itself put there.
 * A record resting on those alone would affirm that a projection was
 * MATERIALIZED, and the milestone would then score deliveries that resolved
 * everything from ambient discovery and never opened the run-pinned subtree.
 *
 * WHAT THE RECORD THEREFORE CERTIFIES, IN PLAIN WORDS: that an allowed
 * invocation of this run named, in a member that names files, a path the
 * materialization receipt lists. NOT that the run read that file, and NOT
 * that the run resolved its workflow from the projection. Two gaps stay open
 * and neither is closable from inside this module: a read the host performs
 * internally, without routing a path through its tool surface, is invisible —
 * a genuinely consuming delivery can go unobserved and is then excluded; and
 * a run that names a receipted file in a path member without reading it is
 * indistinguishable from one that reads it. The first fails safe. The second
 * is why this comment, the operation's own documentation, and anything
 * reporting on the milestone must say "named" and not "consumed".
 *
 * A THIRD GAP WAS CLOSED rather than documented: naming a receipted path in
 * FREE TEXT — a shell description, an edit's replaced text — used to mint an
 * observation, because receipted paths are not secret and are enumerable from
 * the pinned generation. The binding now considers only the members that name
 * files, which is where a host's tool vocabulary belongs.
 *
 * A caller supplies only WHICH run it is asking about (delivery and fence) and
 * which baseline category the delivery is measured under. If the binding's own
 * state does not affirm consumption for that run, nothing is written — the
 * delivery simply stays out of the comparison set, which is exactly the
 * admission rule the guard enforces from the other side.
 *
 * WHAT IT DOES NOT DO. Intervention counts and blocked-share measurements are
 * the gate's own work. This module owns one field of one entry — the
 * consumption record — plus the identity and admission flag that record
 * justifies, and preserves every other byte of the artifact it finds.
 *
 * WHAT IS HOST-NEUTRAL HERE, AND WHAT IS NOT. The record contract the
 * consuming guard reads knows nothing about hosts, and neither does this
 * writer: it names no tool, no tool-input member, and no host vocabulary. The
 * per-binding half is the observation PRODUCER — the surface on which a
 * binding notices that a run named a projection entry — and it reaches this
 * module only through the observation contract below, which any binding can
 * write. The receipt and marker readers this module imports from the Claude
 * Code binding are host-neutral in substance (they read the product's own
 * projection layout and receipt, and reference nothing host-specific); they
 * live in that module for historical reasons only, and a second host
 * integration should relocate them rather than duplicate this writer.
 */
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { readConsumptionMarker, verifyProjection } from "./claude-code.ts";

/**
 * THE BINDING-TO-WRITER OBSERVATION CONTRACT.
 *
 * One file per fence in the binding's own directory, written by the binding's
 * model-external surface and never by a session: the worktree is
 * session-writable, this directory is not.
 *
 * This shape, not the mechanism that produces it, is what the writer depends
 * on. HOW a run is observed to name a projection entry is per-binding and
 * host-specific — the Claude Code binding reads its PreToolUse interceptor's
 * arguments; another host's binding will have a different surface, and the
 * plan's rule is that host differences surface as graded capabilities rather
 * than divergent contracts. A second binding satisfies this by writing this
 * same file from whatever surface it has. Nothing here names a tool, a member,
 * or anything else from a host's vocabulary, and the writer's containment
 * check compares against the product's own receipt entries for the same
 * reason.
 */
export interface ProjectionConsumptionObservation {
  readonly deliveryId?: string;
  readonly fence?: number;
  /** The projection-relative entry an allowed invocation of this run named. */
  readonly entry?: string;
  readonly observedAt?: string;
}

export const projectionConsumptionObservationFile = (fence: number): string =>
  `projection-consumption-${fence}.json`;

/** The consuming repository's gate-record artifact spec, matched exactly. */
export const SHADOW_MILESTONE_GATE_RECORD_SPEC = "athena-shadow-milestone-gate-record/1";

/**
 * The record the guard admits: source, affirmation, the digest the binding
 * receipted at materialization, and the marker fields that tie it to one run.
 */
export interface ProjectionConsumptionRecord {
  readonly source: "binding";
  readonly affirmative: true;
  readonly projectionDigest: string;
  readonly marker: {
    readonly deliveryId: string;
    readonly fence: number;
    readonly consumed: string;
  };
}

export const CONSUMPTION_GATE_RECORD_BLOCKER_CODES = Object.freeze([
  "gate_record_unreadable",
  "gate_record_unrecognized",
  "gate_record_locked",
  "gate_record_write_failed",
] as const);
export type ConsumptionGateRecordBlockerCode = (typeof CONSUMPTION_GATE_RECORD_BLOCKER_CODES)[number];

/**
 * Why an observation did not become an entry. Each of these is an honest
 * absence, not a defect: the run did not consume THIS binding's projection, so
 * the delivery stays out of the comparison set.
 */
export type ProjectionConsumptionUnobserved =
  | "projection-unverified"
  | "marker-unreadable"
  | "marker-names-another-run"
  | "projection-not-consumed";

export type EmitProjectionConsumptionResult =
  | { readonly ok: true; readonly emitted: true; readonly record: ProjectionConsumptionRecord }
  | { readonly ok: true; readonly emitted: false; readonly reason: ProjectionConsumptionUnobserved }
  | {
      readonly ok: false;
      readonly blockers: readonly { readonly code: ConsumptionGateRecordBlockerCode; readonly message: string }[];
    };

export interface EmitProjectionConsumptionInput {
  /** The milestone gate-record artifact in the consuming repository. */
  readonly gateRecordPath: string;
  readonly worktreeDir: string;
  /** The binding's own directory, holding the materialization receipt. */
  readonly bindingDir: string;
  readonly deliveryId: string;
  readonly fence: number;
  /** The baseline mix category this delivery is measured under. */
  readonly category: string;
}

const fail = (
  code: ConsumptionGateRecordBlockerCode,
  message: string,
): EmitProjectionConsumptionResult => ({ ok: false, blockers: [{ code, message }] });

const unobserved = (reason: ProjectionConsumptionUnobserved): EmitProjectionConsumptionResult => ({
  ok: true,
  emitted: false,
  reason,
});

export async function emitProjectionConsumptionRecord(
  input: EmitProjectionConsumptionInput,
): Promise<EmitProjectionConsumptionResult> {
  // ── The observation, taken from binding-owned state only ──────────────────
  //
  // The receipt is re-verified against the worktree bytes rather than merely
  // read, so an entry is never written about a projection that no longer
  // matches what the binding materialized. A session can write the marker's
  // bytes into its own worktree; it cannot produce the receipt this check
  // needs, so a planted marker alone yields no entry.
  const projection = await verifyProjection({
    worktreeDir: input.worktreeDir,
    bindingDir: input.bindingDir,
  });
  if (!projection.ok) return unobserved("projection-unverified");

  const marker = await readConsumptionMarker({ worktreeDir: input.worktreeDir });
  if (!marker.ok) return unobserved("marker-unreadable");
  if (marker.deliveryId !== input.deliveryId || marker.fence !== input.fence) {
    // Another run's marker proves nothing about this one, which is the same
    // reading the guard takes of a mismatched marker in a written entry.
    return unobserved("marker-names-another-run");
  }

  // The only fact here that the run had to DO something to produce. Without
  // it the two checks above affirm materialization, not consumption.
  let observation: ProjectionConsumptionObservation;
  try {
    observation = JSON.parse(
      await readFile(
        path.join(input.bindingDir, projectionConsumptionObservationFile(input.fence)),
        "utf8",
      ),
    ) as ProjectionConsumptionObservation;
  } catch {
    return unobserved("projection-not-consumed");
  }
  if (
    observation.deliveryId !== input.deliveryId ||
    observation.fence !== input.fence ||
    typeof observation.entry !== "string" ||
    observation.entry.length === 0 ||
    // CONTAINMENT, as defense in depth. The binding checks this before it
    // records anything — it must, because the observation is one-shot per
    // fence and an unadmissible name would lock out the honest read that
    // follows. Checking again here costs nothing and keeps the writer's own
    // admissibility rule stated in the writer: an entry the materialization
    // receipt does not list, in the receipt whose every byte was just
    // re-verified above, names nothing that could have been read.
    !projection.entries.includes(observation.entry)
  ) {
    return unobserved("projection-not-consumed");
  }

  const record: ProjectionConsumptionRecord = {
    source: "binding",
    affirmative: true,
    projectionDigest: projection.projectionDigest,
    marker: { deliveryId: marker.deliveryId, fence: marker.fence, consumed: marker.consumed },
  };

  // ── The durable entry ─────────────────────────────────────────────────────
  //
  // Three shadow deliveries share ONE artifact, so the read-modify-write below
  // is held under an exclusive lock: without it two concurrent emissions both
  // read the same bytes and the later write silently discards the earlier
  // entry — and any measurement the gate had already recorded on it — with
  // neither caller seeing a failure. The lock is an exclusive-create file
  // released in `finally`, and the publish is temp-then-rename, so a crash
  // mid-write leaves the previous artifact intact rather than a truncated one.
  const lockPath = `${input.gateRecordPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    return fail(
      "gate_record_locked",
      `another writer holds ${lockPath}; the milestone gate record takes one writer at a time (remove the lock only if no writer is running): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    return await writeEntry(input, record, lockPath);
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function writeEntry(
  input: EmitProjectionConsumptionInput,
  record: ProjectionConsumptionRecord,
  lockPath: string,
): Promise<EmitProjectionConsumptionResult> {
  let text: string;
  try {
    text = await readFile(input.gateRecordPath, "utf8");
  } catch (error) {
    // The artifact belongs to the consuming repository and is created there.
    // Writing one here would invent a measurement surface out of a wrong path.
    return fail(
      "gate_record_unreadable",
      `${input.gateRecordPath} is not readable, so no consumption record can be added to it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    return fail(
      "gate_record_unreadable",
      `${input.gateRecordPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof document !== "object" ||
    document === null ||
    document["spec"] !== SHADOW_MILESTONE_GATE_RECORD_SPEC ||
    !Array.isArray(document["deliveries"])
  ) {
    return fail(
      "gate_record_unrecognized",
      `${input.gateRecordPath} does not declare ${SHADOW_MILESTONE_GATE_RECORD_SPEC} with a deliveries list; the writer edits the milestone gate record and nothing else`,
    );
  }

  const deliveries = [...(document["deliveries"] as unknown[])];
  const index = deliveries.findIndex(
    (entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["id"] === input.deliveryId,
  );
  // Upsert by delivery id: one run is one entry however often the binding
  // observes it, so a re-emission can never present a single run as two
  // members of the comparison set. Fields the gate wrote — the intervention
  // and blocked-share measurements — are carried through untouched.
  const existing = index >= 0 ? (deliveries[index] as Record<string, unknown>) : {};
  // The admission this record justifies — but an EXPLICIT exclusion the gate
  // already wrote stands. The gate excludes a delivery whose measurement it
  // invalidated, and silently re-admitting it on the next emission would undo
  // a decision this writer does not own. Absent or true, the record admits.
  const excluded = existing["countedInComparisonSet"] === false;
  const entry = {
    ...existing,
    id: input.deliveryId,
    category: input.category,
    countedInComparisonSet: !excluded,
    projectionConsumption: record,
  };
  if (index >= 0) deliveries[index] = entry;
  else deliveries.push(entry);

  // Publish atomically: the temp file is adjacent, so the rename is a
  // same-filesystem replace and a reader sees either the old artifact or the
  // new one, never a partial write.
  const tempPath = `${input.gateRecordPath}.${path.basename(lockPath)}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify({ ...document, deliveries }, null, 2)}\n`);
    await rename(tempPath, input.gateRecordPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    return fail(
      "gate_record_write_failed",
      `writing ${input.gateRecordPath} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ok: true, emitted: true, record };
}
