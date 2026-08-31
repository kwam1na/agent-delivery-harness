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
 * the two facts itself, from binding-owned state:
 *
 *   - the projection digest, from the materialization receipt in the binding's
 *     own directory, re-verified against the worktree bytes; and
 *   - the marker, read back out of the receipted projection subtree.
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
 */
import { readFile, writeFile } from "node:fs/promises";

import { readConsumptionMarker, verifyProjection } from "./claude-code.ts";

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
  | "marker-names-another-run";

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

  const record: ProjectionConsumptionRecord = {
    source: "binding",
    affirmative: true,
    projectionDigest: projection.projectionDigest,
    marker: { deliveryId: marker.deliveryId, fence: marker.fence, consumed: marker.consumed },
  };

  // ── The durable entry ─────────────────────────────────────────────────────
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
  const entry = {
    ...existing,
    id: input.deliveryId,
    category: input.category,
    // The admission the record justifies, written only alongside it. An entry
    // the binding never affirmed is never reached by this line at all.
    countedInComparisonSet: true,
    projectionConsumption: record,
  };
  if (index >= 0) deliveries[index] = entry;
  else deliveries.push(entry);

  try {
    await writeFile(input.gateRecordPath, `${JSON.stringify({ ...document, deliveries }, null, 2)}\n`);
  } catch (error) {
    return fail(
      "gate_record_write_failed",
      `writing ${input.gateRecordPath} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ok: true, emitted: true, record };
}
