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
 *   - a qualified host adapter's post-invocation observation of THIS run's
 *     exact read of the canonical workflow graph.
 *
 * THE THIRD FACT IS THE ONLY ONE ABOUT THE RUN. The first two are both true
 * the instant materialization returns: the receipt matches the bytes the
 * binding just wrote, and the marker is a file the binding itself put there.
 * A record resting on those alone would affirm that a projection was
 * MATERIALIZED, and the milestone would then score deliveries that resolved
 * everything from ambient discovery and never opened the run-pinned subtree.
 *
 * WHAT THE RECORD THEREFORE CERTIFIES, IN PLAIN WORDS: that the qualified
 * host emitted a PostToolUse event for its Read of the receipt-derived,
 * canonical workflow graph path, bound to this delivery, fence, invocation,
 * and projection digest. Reads that do not use this qualified surface —
 * including unsupported hosts and host-internal reads — are excluded rather
 * than inferred.
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
 * The writer consumes one host-neutral observation contract. A host without a
 * qualified adapter simply produces no affirmative evidence.
 */
import { lstat, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { PROJECTION_DIR, readConsumptionMarker, verifyProjection } from "./projection.ts";
import {
  parseProjectionConsumptionObservation,
  projectionConsumptionObservationFile,
} from "../projection-consumption-observation.ts";
import { WORKFLOW_GRAPH_ENTRY } from "../workflow/graph.ts";

/**
 * The gate-record artifact spec, matched by SUFFIX.
 *
 * Every consumer owns its own copy of this artifact and names the spec after
 * itself — `athena-shadow-milestone-gate-record/1` in Athena, and
 * `delivery-harness-shadow-milestone-gate-record/1` in this repository's own
 * shadow window — while the record contract inside is identical. Pinning one
 * consumer's full string would make the product able to record consumption for
 * exactly one repository, which is the opposite of what a product-side writer
 * is for; it refused this repository's own artifact until this was widened.
 *
 * The suffix still carries the version, so a `/2` artifact is refused rather
 * than written into with `/1` semantics. This is a shape guard, not an
 * authorization, and it never was one: the public facade derives one canonical
 * target from its protected repository context, and this writer rechecks that
 * target record's repository identity before it creates a lock or replaces a
 * byte. A hostile spec therefore grants nothing.
 *
 * The suffix permits adopters to keep their own record spelling, while the
 * derived expected repository identity prevents one adopter's delivery from
 * entering another adopter's comparison set.
 */
export const SHADOW_MILESTONE_GATE_RECORD_SPEC_SUFFIX = "shadow-milestone-gate-record/1";

/** Athena's spelling of it — the first consumer, kept for callers that name it. */
export const SHADOW_MILESTONE_GATE_RECORD_SPEC = `athena-${SHADOW_MILESTONE_GATE_RECORD_SPEC_SUFFIX}`;

/** The only milestone record a delivery facade may address in its repository. */
export const SHADOW_MILESTONE_GATE_RECORD_PATH = ".agents/policy/shadow-milestone-gate-record.json";

const isGateRecordSpec = (value: unknown): boolean =>
  typeof value === "string" &&
  value.endsWith(SHADOW_MILESTONE_GATE_RECORD_SPEC_SUFFIX) &&
  value.length > SHADOW_MILESTONE_GATE_RECORD_SPEC_SUFFIX.length;

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
  "gate_record_repository_mismatch",
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
  /** The facade-resolved canonical milestone record in the consuming repository. */
  readonly gateRecordPath: string;
  /** The facade's repository root, used to refuse path aliases that escape it. */
  readonly repositoryRoot: string;
  /** Derived from the accepted delivery contract, never from the session. */
  readonly expectedRepositoryId: string;
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
  let observation;
  try {
    observation = parseProjectionConsumptionObservation(JSON.parse(
      await readFile(
        path.join(input.bindingDir, projectionConsumptionObservationFile(input.fence)),
        "utf8",
      ),
    ));
  } catch {
    return unobserved("projection-not-consumed");
  }
  if (observation === undefined) return unobserved("projection-not-consumed");
  let canonicalWorkflowPath: string;
  try {
    canonicalWorkflowPath = await realpath(
      path.join(input.worktreeDir, PROJECTION_DIR, ...WORKFLOW_GRAPH_ENTRY.split("/")),
    );
  } catch {
    return unobserved("projection-not-consumed");
  }
  if (
    observation.deliveryId !== input.deliveryId ||
    observation.fence !== input.fence ||
    observation.entry !== WORKFLOW_GRAPH_ENTRY ||
    observation.canonicalProjectionPath !== canonicalWorkflowPath ||
    observation.projectionDigest !== projection.projectionDigest ||
    typeof observation.hostInvocationId !== "string" ||
    observation.hostInvocationId.length === 0 ||
    // CONTAINMENT. DO NOT DELETE THIS AS A DUPLICATE OF THE BINDING'S CHECK —
    // it is the same question asked of differently trusted state.
    //
    // The binding checks containment before recording, and must: the
    // observation is one-shot per fence, so an unadmissible name would lock
    // out the honest read that follows. But it reads the receipt as plain
    // JSON — no self-binding digest check, no byte verification — because at
    // interception time that is all it can afford. The check HERE runs
    // against `verifyProjection`'s entries, which come from a receipt that
    // binds its own digest and whose every byte was re-hashed against the
    // worktree moments ago.
    //
    // So the binding's check is about slot economy against an unvalidated
    // receipt; this one is the admissibility rule, against a validated one.
    // Removing either brings back a defect the other does not cover.
    //
    // The gap between interception and this check is real but cannot make the
    // record false: every projection byte is re-verified above, so a run whose
    // worktree changed after the observation fails verification rather than
    // emitting. The most a delay can cost is a stale provenance, never a
    // claim about bytes that are no longer there.
    !projection.entries.includes(WORKFLOW_GRAPH_ENTRY)
  ) {
    return unobserved("projection-not-consumed");
  }

  const record: ProjectionConsumptionRecord = {
    source: "binding",
    affirmative: true,
    projectionDigest: projection.projectionDigest,
    marker: { deliveryId: marker.deliveryId, fence: marker.fence, consumed: marker.consumed },
  };

  // A repository-relative spelling is not containment when an ancestor is a
  // symlink. Resolve the repository and record before touching either the
  // artifact or an adjacent lock, then use those resolved paths for every
  // later I/O so aliases of the same in-repository record share one lock.
  const target = await resolveGateRecordTarget(input);
  if ("ok" in target) return target;
  const scopedInput: EmitProjectionConsumptionInput = {
    ...input,
    gateRecordPath: target.gateRecordPath,
    repositoryRoot: target.repositoryRoot,
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
  // Refuse an unrecognised or cross-repository target before creating even the
  // adjacent lock file. The lock serializes an otherwise valid writer; it is
  // not authority to touch an arbitrary artifact.
  const preflight = await readGateRecord(scopedInput);
  if ("ok" in preflight) return preflight;

  const lockPath = `${scopedInput.gateRecordPath}.lock`;
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
    return await writeEntry(scopedInput, record, lockPath);
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function resolveGateRecordTarget(
  input: EmitProjectionConsumptionInput,
): Promise<
  | { readonly repositoryRoot: string; readonly gateRecordPath: string }
  | EmitProjectionConsumptionResult
> {
  let repositoryRoot: string;
  let gateRecordParent: string;
  let gateRecordPath: string;
  let recordLink: Awaited<ReturnType<typeof lstat>>;
  let recordStat: Awaited<ReturnType<typeof stat>>;
  try {
    repositoryRoot = await realpath(input.repositoryRoot);
    const expectedParent = path.join(repositoryRoot, ".agents", "policy");
    const expectedRecord = path.join(expectedParent, SHADOW_MILESTONE_GATE_RECORD_PATH.split("/").at(-1)!);
    [gateRecordParent, gateRecordPath, recordLink, recordStat] = await Promise.all([
      realpath(path.dirname(input.gateRecordPath)),
      realpath(input.gateRecordPath),
      lstat(expectedRecord),
      stat(expectedRecord),
    ]);
    if (
      gateRecordParent !== expectedParent ||
      gateRecordPath !== expectedRecord ||
      !recordLink.isFile() ||
      recordLink.isSymbolicLink() ||
      recordStat.nlink !== 1
    ) {
      return fail(
        "gate_record_repository_mismatch",
        `${input.gateRecordPath} is not the single-link protected gate record at ${expectedRecord}; the writer refuses a same-repository alias before changing either record`,
      );
    }
  } catch (error) {
    return fail(
      "gate_record_unreadable",
      `${input.gateRecordPath} cannot be resolved inside its repository: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { repositoryRoot, gateRecordPath };
}

async function writeEntry(
  input: EmitProjectionConsumptionInput,
  record: ProjectionConsumptionRecord,
  lockPath: string,
): Promise<EmitProjectionConsumptionResult> {
  // The first check happened before claiming the lock. Repeat it while the
  // lock is held before reading and immediately before publishing, so a
  // same-repository symlink or hardlink swap never redirects this writer into
  // a model-writable inode between those operations.
  const beforeRead = await resolveGateRecordTarget(input);
  if ("ok" in beforeRead) return beforeRead;
  const loaded = await readGateRecord(input);
  if ("ok" in loaded) return loaded;

  const document = loaded.document;
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
    const beforePublish = await resolveGateRecordTarget(input);
    if ("ok" in beforePublish) return beforePublish;
    await writeFile(tempPath, `${JSON.stringify({ ...document, deliveries }, null, 2)}\n`);
    await rename(tempPath, input.gateRecordPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    return fail(
      "gate_record_write_failed",
      `writing ${input.gateRecordPath} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { ok: true, emitted: true, record };
}

async function readGateRecord(
  input: EmitProjectionConsumptionInput,
): Promise<{ readonly document: Record<string, unknown> } | EmitProjectionConsumptionResult> {
  let text: string;
  try {
    text = await readFile(input.gateRecordPath, "utf8");
  } catch (error) {
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
    return fail("gate_record_unreadable", `${input.gateRecordPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    typeof document !== "object" ||
    document === null ||
    !isGateRecordSpec(document["spec"]) ||
    !Array.isArray(document["deliveries"])
  ) {
    return fail(
      "gate_record_unrecognized",
      `${input.gateRecordPath} does not declare a <consumer>-${SHADOW_MILESTONE_GATE_RECORD_SPEC_SUFFIX} spec with a deliveries list; the writer edits a milestone gate record and nothing else`,
    );
  }
  if (document["repositoryId"] !== input.expectedRepositoryId) {
    return fail(
      "gate_record_repository_mismatch",
      `${input.gateRecordPath} declares repositoryId ${JSON.stringify(document["repositoryId"])}, but this delivery is bound to ${JSON.stringify(input.expectedRepositoryId)}; the writer refuses a cross-repository gate target before changing either record`,
    );
  }
  return { document };
}
