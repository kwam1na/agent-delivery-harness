/**
 * The composition release lifecycle: update, rollback, trust-state
 * maintenance, referenced-generation retention with garbage collection,
 * journaled update recovery, installer repair, and read-only installation
 * inspection.
 *
 * EVERY TRUST-STORE EDIT AFTER THE GENUINELY-FIRST INSTALL IS SENSITIVE. The
 * operations here are the maintenance lane: each consumes one fresh
 * sensitive-approval assertion — evaluated by the installation's configured
 * assertion source, whose prompt disclosed the exact target and action —
 * before any mutation, and records the consumption verbatim in the
 * maintenance journal. The journal is the single-use nonce ledger, so a
 * replayed evaluation is detected against durable bytes, and an expired one
 * is treated as a cached credential and refused. With the provider
 * configuration absent or its source unavailable, the whole sensitive set
 * fails closed until an operator-performed installer repair re-establishes
 * the source; delivery-lane operator confirmations are untouched by that
 * loss.
 *
 * UPDATES ARE VALIDATED BEFORE MUTATION AND JOURNALED ACROSS IT. The packed
 * composition's full digest closure, the qualification custody rule, the
 * no-downgrade high-water mark, revocation, and the activation preflights all
 * run before the first byte moves. The mutation itself is phased —
 * materialize the read-only root, write trust state, write the rollback
 * pointer, switch the active pointer — between a `started` and a `completed`
 * journal record, so an interruption at any phase is recoverable: recovery
 * rolls forward exactly when the trust store already pins the target and
 * rolls back to the prior consistent state otherwise, and no other
 * maintenance operation runs while an interrupted one is unrecovered.
 *
 * ROLLBACK IS EXPLICIT AND BOUNDED. A rollback selects only a retained,
 * previously accepted, non-revoked generation; it neither advances nor
 * violates the high-water mark, which keeps forbidding the same archive from
 * re-entering through the install lane. Garbage collection removes only
 * generations referenced by nothing — not the active pointer, not the
 * rollback pointer, not any caller-supplied nonterminal delivery pin, and
 * never revoked bytes, which are retained for audit.
 */
import { readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  SECURITY_BLOCKED_MIGRATION_ACTION,
  validateSensitiveApprovalAssertion,
  type AssertionSource,
  type SensitiveMaintenanceAction,
} from "../spine/assertion.ts";
import { localDigestTrustPredicate, type ProductTrustPort, type ProductTrustState } from "../spine/composition.ts";
import type { CompositionProfile } from "./manifest.ts";
import {
  activePointerPathFor,
  assertionSourceForKind,
  checkQualificationFlag,
  generationRootFor,
  generationsDirFor,
  loadTrustState,
  materializeRoot,
  readInstallReceipt,
  rollbackPointerPathFor,
  runActivationPreflight,
  trustStorePathFor,
  verifyGenerationClosure,
  writeOwnerFile,
  ACTIVE_POINTER_SPEC,
  ROLLBACK_POINTER_SPEC,
  type InstallReceipt,
  type SubstrateBlockerCode,
  type SubstrateFailure,
} from "./installer.ts";
import {
  loadAssertionProviderConfig,
  type AssertionEvaluationRequest,
  type AssertionSourcePort,
} from "./assertion-source.ts";
import {
  appendMaintenanceAction,
  consumedNoncesOf,
  interruptedMaintenanceOf,
  lastActivatedGenerationOf,
  readMaintenanceJournal,
  type MaintenanceEntryView,
} from "./maintenance-journal.ts";
import type { PreflightProbes } from "./preflight.ts";

const fail = (code: SubstrateBlockerCode, message: string): SubstrateFailure => ({
  ok: false,
  blockers: [{ code, message }],
});

const nowInstant = (): string => `${new Date().toISOString().slice(0, 19)}Z`;

// ── Adopted-installation context ───────────────────────────────────────────

interface AdoptedInstallation {
  readonly state: ProductTrustState;
  readonly receipt: InstallReceipt;
  readonly journal: readonly MaintenanceEntryView[];
}

async function adoptInstallation(
  installationPath: string,
  receiptDir: string,
): Promise<AdoptedInstallation | SubstrateFailure> {
  const loaded = await loadTrustState(installationPath);
  if (!loaded.ok) return loaded;
  const receiptRead = await readInstallReceipt(receiptDir, installationPath);
  if (receiptRead.presence === "absent") {
    return fail("install_receipt_absent", "no install receipt resolves this installation; maintenance adopts, it never re-initializes");
  }
  if (receiptRead.presence === "corrupt") return fail("install_receipt_corrupt", receiptRead.message);
  const journal = await readMaintenanceJournal(installationPath);
  if (!journal.ok) return fail("maintenance_journal_corrupt", journal.message);
  const interrupted = interruptedMaintenanceOf(journal.entries);
  if (interrupted !== undefined) {
    return fail(
      "maintenance_in_progress",
      `an interrupted ${interrupted.action} targeting generation ${interrupted.generationDigest} is unrecovered; run maintenance recovery before any further operation`,
    );
  }
  return { state: loaded.state, receipt: receiptRead.receipt, journal: journal.entries };
}

// ── Assertion consumption ──────────────────────────────────────────────────

export interface SensitiveLaneInput {
  readonly installationPath: string;
  readonly receiptDir: string;
  /** Override the configured source's port (tests, host integrations). */
  readonly assertionSource?: AssertionSourcePort;
  /** The consumption instant; defaults to the wall clock. */
  readonly now?: string;
}

interface ConsumedAssertion {
  readonly record: Record<string, unknown>;
}

/**
 * One sensitive-approval consumption: resolve the configured source (fail
 * closed when the configuration is lost), run one fresh interactive
 * evaluation whose prompt disclosed the exact target and action, and bind
 * the maintenance-lane assertion — rejecting stale expiries and replayed
 * nonces against the durable journal.
 */
async function consumeMaintenanceAssertion(
  input: SensitiveLaneInput,
  adopted: AdoptedInstallation,
  action: SensitiveMaintenanceAction,
  target: { readonly generationDigest?: string; readonly highWaterMark?: number },
): Promise<ConsumedAssertion | SubstrateFailure> {
  const config = await loadAssertionProviderConfig(input.installationPath);
  if (!config.ok) {
    return fail(
      "assertion_source_unavailable",
      `the assertion provider configuration is ${config.reason}; sensitive operations fail closed until an operator-performed installer repair re-establishes the source`,
    );
  }
  if (config.config.sourceKind === "qualification-fixture" && adopted.receipt.installationProfile !== "confirmation-fixture") {
    return fail(
      "assertion_source_mismatch",
      "the qualification-fixture assertion source is valid only on a confirmation-fixture installation",
    );
  }
  const source = input.assertionSource ?? assertionSourceForKind(config.config.sourceKind);
  const availability = await source.probe();
  if (!availability.available) {
    return fail(
      "assertion_source_unavailable",
      `the configured assertion source is unavailable (${availability.detail}); sensitive operations fail closed until an operator-performed installer repair restores it`,
    );
  }

  const targetText =
    target.generationDigest !== undefined ? `generation ${target.generationDigest}` : `high-water mark ${target.highWaterMark}`;
  const request: AssertionEvaluationRequest = {
    action,
    disclosure: `Approve ${action} of ${targetText} on installation ${adopted.state.installationId}`,
  };
  const evaluation = await source.evaluate(request);
  if (!evaluation.ok) {
    return fail("assertion_refused", `the interactive evaluation was not granted: ${evaluation.reason}`);
  }
  if (evaluation.sourceKind === "qualification-fixture" && adopted.receipt.installationProfile !== "confirmation-fixture") {
    return fail(
      "assertion_source_mismatch",
      "a fixture-sourced assertion can never approve a sensitive operation on a production installation",
    );
  }
  const now = input.now ?? nowInstant();
  if (evaluation.expiry < now) {
    return fail(
      "assertion_stale",
      `the evaluation expired at ${evaluation.expiry}; an expired assertion is a cached credential and is treated as invalid`,
    );
  }
  if (consumedNoncesOf(adopted.journal).has(evaluation.nonce)) {
    return fail(
      "assertion_replayed",
      `nonce ${evaluation.nonce} was already consumed; a sensitive approval requires one fresh interactive evaluation per single-use nonce`,
    );
  }

  const record: Record<string, unknown> = {
    spec: "sensitive-approval-assertion/1",
    assertionClass: "maintenance-lane",
    origin: "installer.maintenance",
    action,
    expiry: evaluation.expiry,
    nonce: evaluation.nonce,
    assertionSource: evaluation.sourceKind,
    productTrustRevocationEpoch: adopted.state.revocationEpoch,
    repositoryAuthorityRevocationEpoch: "absent-by-state",
    deliveryId: "absent-by-state",
    candidateTreeSha: "absent-by-state",
    policyDigest: "absent-by-state",
    invocationFence: "absent-by-state",
    targetInstallationId: adopted.state.installationId,
    targetGenerationDigest: target.generationDigest ?? "absent-by-state",
    targetHighWaterMark: target.highWaterMark ?? "absent-by-state",
    expectedJournalRevision: "absent-by-state",
  };
  const verdict = validateSensitiveApprovalAssertion(record);
  if (!verdict.ok) {
    return fail(
      "assertion_refused",
      `the minted assertion is outside its frozen contract: ${verdict.rejections.map((rejection) => rejection.message).join("; ")}`,
    );
  }
  return { record };
}

const writeTrustState = async (installationPath: string, state: ProductTrustState): Promise<void> => {
  await writeOwnerFile(trustStorePathFor(installationPath), JSON.stringify(state));
};

const writePointer = async (pointerPath: string, spec: string, generationDigest: string): Promise<void> => {
  await writeOwnerFile(pointerPath, JSON.stringify({ spec, generationDigest }));
};

// ── Update ─────────────────────────────────────────────────────────────────

export interface UpdateCompositionInput extends SensitiveLaneInput {
  readonly packedDir: string;
  readonly qualification?: { readonly disposableRepositoryIds: readonly string[] };
  readonly preflight?: Partial<PreflightProbes>;
  readonly trust?: ProductTrustPort;
  /** Fault-injection seam for the update fault sensors; production passes none. */
  readonly hooks?: { readonly onPhase?: (phase: string) => void | Promise<void> };
}

export type UpdateCompositionResult =
  | {
      readonly ok: true;
      readonly generationDigest: string;
      readonly priorGenerationDigest: string;
      readonly root: string;
      readonly noOp: boolean;
    }
  | SubstrateFailure;

export async function updateComposition(input: UpdateCompositionInput): Promise<UpdateCompositionResult> {
  const trust = input.trust ?? localDigestTrustPredicate;

  // The COMPLETE composition is validated before any mutation.
  const closure = await verifyGenerationClosure(input.packedDir);
  if (!closure.ok) return closure;
  const generationDigest = closure.generationDigest;
  const manifestProfile = closure.manifest["compositionProfile"] as CompositionProfile;
  const compositionSequence = closure.manifest["compositionSequence"] as number;

  const flagVerdict = checkQualificationFlag(manifestProfile, input.qualification);
  if (flagVerdict !== undefined) return flagVerdict;

  const adopted = await adoptInstallation(input.installationPath, input.receiptDir);
  if ("ok" in adopted) return adopted;
  if (adopted.receipt.installationProfile !== manifestProfile) {
    return fail(
      "composition_profile_mismatch",
      `the manifest declares the ${manifestProfile} profile but this installation's receipt records ${adopted.receipt.installationProfile}`,
    );
  }

  const prior = adopted.state.pinnedManifestDigest;
  if (generationDigest === prior) {
    return {
      ok: true,
      generationDigest,
      priorGenerationDigest: prior,
      root: generationRootFor(input.installationPath, generationDigest),
      noOp: true,
    };
  }

  if (compositionSequence < adopted.state.highWaterMark) {
    return fail(
      "downgrade_rejected",
      `composition sequence ${compositionSequence} is below the persisted high-water mark ${adopted.state.highWaterMark}; an older archive can never silently replace the active generation — explicit rollback to a retained accepted generation is the sanctioned path`,
    );
  }
  const decision = trust.evaluate(generationDigest, { ...adopted.state, pinnedManifestDigest: generationDigest });
  if (!decision.eligible) {
    return fail("generation_revoked", `generation ${generationDigest} is revoked and can never activate`);
  }

  const config = await loadAssertionProviderConfig(input.installationPath);
  if (!config.ok) {
    return fail(
      "assertion_source_unavailable",
      `the assertion provider configuration is ${config.reason}; sensitive operations fail closed until an operator-performed installer repair re-establishes the source`,
    );
  }
  const source = input.assertionSource ?? assertionSourceForKind(config.config.sourceKind);
  const preflight = await runActivationPreflight(closure.manifest, source, input.preflight);
  if (preflight !== undefined) return preflight;

  const consumed = await consumeMaintenanceAssertion(input, adopted, "update", { generationDigest });
  if ("ok" in consumed) return consumed;

  const journalStarted = await appendMaintenanceAction(input.installationPath, adopted.state.installationId, {
    action: "update",
    phase: "started",
    generationDigest,
    highWaterMark: "absent-by-state",
    assertion: consumed.record,
  });
  if (!journalStarted.ok) return fail("maintenance_journal_corrupt", journalStarted.message);
  await input.hooks?.onPhase?.("started");

  const root = generationRootFor(input.installationPath, generationDigest);
  const rootPresent = await verifyGenerationClosure(root, generationDigest);
  if (!rootPresent.ok) {
    await materializeRoot(input.packedDir, root);
  }
  await input.hooks?.onPhase?.("root-materialized");

  const accepted = adopted.state.acceptedGenerationDigests.includes(generationDigest)
    ? adopted.state.acceptedGenerationDigests
    : [...adopted.state.acceptedGenerationDigests, generationDigest];
  await writeTrustState(input.installationPath, {
    ...adopted.state,
    pinnedManifestDigest: generationDigest,
    acceptedGenerationDigests: accepted,
    highWaterMark: Math.max(adopted.state.highWaterMark, compositionSequence),
  });
  await input.hooks?.onPhase?.("trust-state-written");

  await writePointer(rollbackPointerPathFor(input.installationPath), ROLLBACK_POINTER_SPEC, prior);
  await input.hooks?.onPhase?.("rollback-pointer-written");

  await writePointer(activePointerPathFor(input.installationPath), ACTIVE_POINTER_SPEC, generationDigest);
  await input.hooks?.onPhase?.("active-pointer-written");

  const journalCompleted = await appendMaintenanceAction(input.installationPath, adopted.state.installationId, {
    action: "update",
    phase: "completed",
    generationDigest,
    highWaterMark: "absent-by-state",
    assertion: "absent-by-state",
  });
  if (!journalCompleted.ok) return fail("maintenance_journal_corrupt", journalCompleted.message);

  return { ok: true, generationDigest, priorGenerationDigest: prior, root, noOp: false };
}

// ── Rollback ───────────────────────────────────────────────────────────────

export interface RollbackCompositionInput extends SensitiveLaneInput {
  readonly targetGenerationDigest: string;
  readonly trust?: ProductTrustPort;
}

export async function rollbackComposition(
  input: RollbackCompositionInput,
): Promise<{ readonly ok: true; readonly generationDigest: string } | SubstrateFailure> {
  const adopted = await adoptInstallation(input.installationPath, input.receiptDir);
  if ("ok" in adopted) return adopted;
  const target = input.targetGenerationDigest;

  // Only a retained, previously accepted, non-revoked generation — never an
  // arbitrary older archive.
  if (!adopted.state.acceptedGenerationDigests.includes(target)) {
    return fail(
      "rollback_target_not_accepted",
      `generation ${target} was never accepted under this installation's local trust policy; rollback can never adopt an arbitrary archive`,
    );
  }
  if (adopted.state.revokedGenerationDigests.includes(target)) {
    return fail("generation_revoked", `generation ${target} is revoked; a formerly valid rollback target stops being one`);
  }
  const root = generationRootFor(input.installationPath, target);
  const retained = await verifyGenerationClosure(root, target);
  if (!retained.ok) return retained;

  const prior = adopted.state.pinnedManifestDigest;
  if (target === prior) return { ok: true, generationDigest: target };

  const consumed = await consumeMaintenanceAssertion(input, adopted, "rollback", { generationDigest: target });
  if ("ok" in consumed) return consumed;

  const journalStarted = await appendMaintenanceAction(input.installationPath, adopted.state.installationId, {
    action: "rollback",
    phase: "started",
    generationDigest: target,
    highWaterMark: "absent-by-state",
    assertion: consumed.record,
  });
  if (!journalStarted.ok) return fail("maintenance_journal_corrupt", journalStarted.message);

  // Rollback re-pins without touching the high-water mark or accepted set:
  // it neither advances nor violates the no-downgrade policy.
  await writeTrustState(input.installationPath, { ...adopted.state, pinnedManifestDigest: target });
  await writePointer(rollbackPointerPathFor(input.installationPath), ROLLBACK_POINTER_SPEC, prior);
  await writePointer(activePointerPathFor(input.installationPath), ACTIVE_POINTER_SPEC, target);

  const journalCompleted = await appendMaintenanceAction(input.installationPath, adopted.state.installationId, {
    action: "rollback",
    phase: "completed",
    generationDigest: target,
    highWaterMark: "absent-by-state",
    assertion: "absent-by-state",
  });
  if (!journalCompleted.ok) return fail("maintenance_journal_corrupt", journalCompleted.message);
  return { ok: true, generationDigest: target };
}

// ── Trust-state maintenance ────────────────────────────────────────────────

export type MaintainTrustStateInput = SensitiveLaneInput &
  (
    | { readonly operation: "pin" | "revoke" | "unrevoke"; readonly generationDigest: string }
    | { readonly operation: "advance-high-water-mark"; readonly highWaterMark: number }
  );

export async function maintainTrustState(
  input: MaintainTrustStateInput,
): Promise<{ readonly ok: true; readonly state: ProductTrustState } | SubstrateFailure> {
  const adopted = await adoptInstallation(input.installationPath, input.receiptDir);
  if ("ok" in adopted) return adopted;
  const state = adopted.state;

  let next: ProductTrustState;
  if (input.operation === "advance-high-water-mark") {
    if (input.highWaterMark <= state.highWaterMark) {
      return fail(
        "epoch_rollback_rejected",
        `the high-water mark is ${state.highWaterMark} and only advances; ${input.highWaterMark} would rewind the no-downgrade policy`,
      );
    }
    next = { ...state, highWaterMark: input.highWaterMark };
  } else if (input.operation === "pin") {
    if (!state.acceptedGenerationDigests.includes(input.generationDigest)) {
      return fail(
        "rollback_target_not_accepted",
        `generation ${input.generationDigest} was never accepted under this installation's local trust policy`,
      );
    }
    if (state.revokedGenerationDigests.includes(input.generationDigest)) {
      return fail("generation_revoked", `generation ${input.generationDigest} is revoked and can never be pinned`);
    }
    next = { ...state, pinnedManifestDigest: input.generationDigest };
  } else if (input.operation === "revoke") {
    if (state.revokedGenerationDigests.includes(input.generationDigest)) {
      return fail("generation_revoked", `generation ${input.generationDigest} is already revoked`);
    }
    next = {
      ...state,
      revokedGenerationDigests: [...state.revokedGenerationDigests, input.generationDigest],
      revocationEpoch: state.revocationEpoch + 1,
    };
  } else {
    next = {
      ...state,
      revokedGenerationDigests: state.revokedGenerationDigests.filter((digest) => digest !== input.generationDigest),
      // Un-revocation is also a revocation-list change: the epoch counts
      // changes and never rewinds, so stale epoch-bound authority stays stale.
      revocationEpoch: state.revocationEpoch + 1,
    };
  }

  const target =
    input.operation === "advance-high-water-mark"
      ? { highWaterMark: input.highWaterMark }
      : { generationDigest: input.generationDigest };
  const consumed = await consumeMaintenanceAssertion(input, adopted, input.operation, target);
  if ("ok" in consumed) return consumed;

  const journaled = await appendMaintenanceAction(input.installationPath, state.installationId, {
    action: input.operation,
    phase: "completed",
    generationDigest: input.operation === "advance-high-water-mark" ? "absent-by-state" : input.generationDigest,
    highWaterMark: input.operation === "advance-high-water-mark" ? input.highWaterMark : "absent-by-state",
    assertion: consumed.record,
  });
  if (!journaled.ok) return fail("maintenance_journal_corrupt", journaled.message);

  await writeTrustState(input.installationPath, next);
  return { ok: true, state: next };
}

// ── Retention and garbage collection ───────────────────────────────────────

export interface GarbageCollectInput {
  readonly installationPath: string;
  /** Generation pins of every nonterminal delivery, supplied by the caller. */
  readonly referencedGenerationDigests: readonly string[];
}

const readPointerDigest = async (pointerPath: string): Promise<string | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
    const digest = parsed["generationDigest"];
    return typeof digest === "string" ? digest : undefined;
  } catch {
    return undefined;
  }
};

/** Restore owner-write depth-first so a read-only root can be removed. */
async function removeReadonlyTree(root: string): Promise<void> {
  const { chmod } = await import("node:fs/promises");
  const restore = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700).catch(() => undefined);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await restore(path.join(dir, entry.name));
    }
  };
  await restore(root);
  await rm(root, { recursive: true, force: true });
}

export async function garbageCollectGenerations(
  input: GarbageCollectInput,
): Promise<{ readonly ok: true; readonly removed: readonly string[] } | SubstrateFailure> {
  const loaded = await loadTrustState(input.installationPath);
  if (!loaded.ok) return loaded;
  const journal = await readMaintenanceJournal(input.installationPath);
  if (!journal.ok) return fail("maintenance_journal_corrupt", journal.message);
  if (interruptedMaintenanceOf(journal.entries) !== undefined) {
    return fail("maintenance_in_progress", "an interrupted maintenance operation is unrecovered; nothing is collected");
  }

  const retained = new Set<string>([
    loaded.state.pinnedManifestDigest,
    ...loaded.state.revokedGenerationDigests, // revoked bytes are retained for audit
    ...input.referencedGenerationDigests,
  ]);
  const active = await readPointerDigest(activePointerPathFor(input.installationPath));
  if (active !== undefined) retained.add(active);
  const rollback = await readPointerDigest(rollbackPointerPathFor(input.installationPath));
  if (rollback !== undefined) retained.add(rollback);

  let present: string[];
  try {
    present = await readdir(generationsDirFor(input.installationPath));
  } catch {
    return { ok: true, removed: [] };
  }
  const removed: string[] = [];
  for (const name of present.sort()) {
    if (!/^[0-9a-f]{64}$/.test(name) || retained.has(name)) continue;
    await removeReadonlyTree(generationRootFor(input.installationPath, name));
    removed.push(name);
    const journaled = await appendMaintenanceAction(input.installationPath, loaded.state.installationId, {
      action: "garbage-collection",
      phase: "completed",
      generationDigest: name,
      highWaterMark: "absent-by-state",
      assertion: "absent-by-state",
    });
    if (!journaled.ok) return fail("maintenance_journal_corrupt", journaled.message);
  }
  return { ok: true, removed };
}

// ── Journaled update recovery ──────────────────────────────────────────────

export async function recoverInterruptedMaintenance(input: {
  readonly installationPath: string;
}): Promise<{ readonly ok: true; readonly recovered: boolean } | SubstrateFailure> {
  const journal = await readMaintenanceJournal(input.installationPath);
  if (!journal.ok) return fail("maintenance_journal_corrupt", journal.message);
  const interrupted = interruptedMaintenanceOf(journal.entries);
  if (interrupted === undefined) return { ok: true, recovered: false };

  const loaded = await loadTrustState(input.installationPath);
  if (!loaded.ok) return loaded;
  const state = loaded.state;
  const target = interrupted.generationDigest;
  const installationId = state.installationId;

  if (state.pinnedManifestDigest === target) {
    // The trust store already pins the target: the point of no return was
    // passed, so recovery rolls FORWARD by finishing the pointer writes.
    const root = generationRootFor(input.installationPath, target);
    const closure = await verifyGenerationClosure(root, target);
    if (!closure.ok) return closure;
    const prior = lastActivatedGenerationOf(journal.entries);
    if (prior !== undefined && prior !== target) {
      await writePointer(rollbackPointerPathFor(input.installationPath), ROLLBACK_POINTER_SPEC, prior);
    }
    await writePointer(activePointerPathFor(input.installationPath), ACTIVE_POINTER_SPEC, target);
  } else {
    // The trust store still pins the prior generation: recovery rolls BACK
    // to it — the active pointer is restored and staging leftovers removed;
    // a fully materialized target root is harmless retained bytes, and a
    // partial one is removed.
    await writePointer(activePointerPathFor(input.installationPath), ACTIVE_POINTER_SPEC, state.pinnedManifestDigest);
    const generationsDir = generationsDirFor(input.installationPath);
    let entries: string[] = [];
    try {
      entries = await readdir(generationsDir);
    } catch {
      /* nothing staged */
    }
    for (const name of entries) {
      if (name.includes(".staging-")) await removeReadonlyTree(path.join(generationsDir, name));
    }
    const targetRoot = generationRootFor(input.installationPath, target);
    const closure = await verifyGenerationClosure(targetRoot, target);
    if (!closure.ok) {
      await removeReadonlyTree(targetRoot);
    }
  }

  const journaled = await appendMaintenanceAction(input.installationPath, installationId, {
    action: interrupted.action,
    phase: "recovered",
    generationDigest: target,
    highWaterMark: "absent-by-state",
    assertion: "absent-by-state",
  });
  if (!journaled.ok) return fail("maintenance_journal_corrupt", journaled.message);
  return { ok: true, recovered: true };
}

// ── Installer repair ───────────────────────────────────────────────────────

export interface RepairInstallationInput {
  readonly installationPath: string;
  readonly receiptDir: string;
  /** The repair is the operator's own interactive installer act. */
  readonly interactive: boolean;
  readonly source: { readonly sourceKind: AssertionSource; readonly port?: AssertionSourcePort };
}

/**
 * The operator-performed installer repair: re-establishes the assertion
 * provider after source loss. It adopts and never edits the existing trust
 * store and receipt (it asserts no profile and preserves the receipt's flag
 * state, disposable set, and registering-installation identity), and it is
 * refused while a working assertion source exists.
 */
export async function repairInstallation(
  input: RepairInstallationInput,
): Promise<{ readonly ok: true } | SubstrateFailure> {
  if (!input.interactive) {
    return fail("non_interactive_refused", "the installer repair is an interactive operator act; non-interactive, piped, or inherited input is refused");
  }
  const receiptRead = await readInstallReceipt(input.receiptDir, input.installationPath);
  if (receiptRead.presence === "absent") {
    return fail("install_receipt_absent", "no install receipt resolves this installation; a repair adopts an installation, it never creates one");
  }
  if (receiptRead.presence === "corrupt") return fail("install_receipt_corrupt", receiptRead.message);
  const loaded = await loadTrustState(input.installationPath);
  if (!loaded.ok) return loaded;

  const existing = await loadAssertionProviderConfig(input.installationPath);
  if (existing.ok) {
    const existingPort = assertionSourceForKind(existing.config.sourceKind);
    const availability = await existingPort.probe();
    if (availability.available) {
      return fail("repair_not_needed", "a working assertion source exists; the repair is refused while the sensitive set is serviceable");
    }
  }

  if (input.source.sourceKind === "qualification-fixture" && receiptRead.receipt.installationProfile !== "confirmation-fixture") {
    return fail("assertion_source_mismatch", "the qualification-fixture source is valid only on a confirmation-fixture installation");
  }
  const port = input.source.port ?? assertionSourceForKind(input.source.sourceKind);
  const availability = await port.probe();
  if (!availability.available) {
    return fail("assertion_source_unavailable", `the replacement assertion source is unavailable: ${availability.detail}`);
  }

  const { writeAssertionProviderConfig } = await import("./assertion-source.ts");
  await writeAssertionProviderConfig(input.installationPath, input.source.sourceKind);
  const journaled = await appendMaintenanceAction(input.installationPath, loaded.state.installationId, {
    action: "installer-repair",
    phase: "completed",
    generationDigest: "absent-by-state",
    highWaterMark: "absent-by-state",
    assertion: "absent-by-state",
  });
  if (!journaled.ok) return fail("maintenance_journal_corrupt", journaled.message);
  return { ok: true };
}

// ── Read-only inspection ───────────────────────────────────────────────────

export interface InspectedGeneration {
  readonly digest: string;
  readonly accepted: boolean;
  readonly revoked: boolean;
}

export interface InspectInstallationInput {
  readonly installationPath: string;
  readonly receiptDir: string;
}

/**
 * Read-only installation inventory: internal identities are exposed without
 * becoming selectable — nothing here mutates, and nothing here is an input
 * any activation path trusts.
 */
export async function inspectInstallation(input: InspectInstallationInput): Promise<
  | {
      readonly ok: true;
      readonly installationId: string;
      readonly profile: CompositionProfile;
      readonly pinnedGenerationDigest: string;
      readonly activeGenerationDigest: string | undefined;
      readonly rollbackGenerationDigest: string | undefined;
      readonly highWaterMark: number;
      readonly revocationEpoch: number;
      readonly assertionSourceKind: AssertionSource | undefined;
      readonly generations: readonly InspectedGeneration[];
    }
  | SubstrateFailure
> {
  const loaded = await loadTrustState(input.installationPath);
  if (!loaded.ok) return loaded;
  const receiptRead = await readInstallReceipt(input.receiptDir, input.installationPath);
  if (receiptRead.presence === "absent") return fail("install_receipt_absent", "no install receipt resolves this installation");
  if (receiptRead.presence === "corrupt") return fail("install_receipt_corrupt", receiptRead.message);

  let present: string[] = [];
  try {
    present = (await readdir(generationsDirFor(input.installationPath))).filter((name) => /^[0-9a-f]{64}$/.test(name));
  } catch {
    /* no generations directory */
  }
  const config = await loadAssertionProviderConfig(input.installationPath);
  return {
    ok: true,
    installationId: loaded.state.installationId,
    profile: receiptRead.receipt.installationProfile,
    pinnedGenerationDigest: loaded.state.pinnedManifestDigest,
    activeGenerationDigest: await readPointerDigest(activePointerPathFor(input.installationPath)),
    rollbackGenerationDigest: await readPointerDigest(rollbackPointerPathFor(input.installationPath)),
    highWaterMark: loaded.state.highWaterMark,
    revocationEpoch: loaded.state.revocationEpoch,
    assertionSourceKind: config.ok ? config.config.sourceKind : undefined,
    generations: present.sort().map((digest) => ({
      digest,
      accepted: loaded.state.acceptedGenerationDigests.includes(digest),
      revoked: loaded.state.revokedGenerationDigests.includes(digest),
    })),
  };
}

// Re-exported so the delivery-side migration consumption and the maintenance
// lane share one action literal.
export { SECURITY_BLOCKED_MIGRATION_ACTION };
