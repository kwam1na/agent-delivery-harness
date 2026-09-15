/**
 * Reconnect reconciliation: what an admitted remote claim is allowed to cost.
 *
 * The rule the ticket states, and the one implemented here, is narrow and
 * worth reading twice: a contradicted claim is journaled as ONE advancing
 * blocker, and every later claim contradicting the SAME local history is
 * coalesced into that blocker — its detail surviving in the non-advancing
 * mirror records — until the local delivery records a superseding local fact.
 *
 * Two failure modes this is written against:
 *
 *  - **The blocker storm.** A partitioned control plane that reconnects and
 *    flushes a thousand stale claims must not produce a thousand advancing
 *    blockers. Each advancing append moves the expected journal revision, so
 *    a storm would invalidate every pending confirmation and assertion the
 *    operator is in the middle of answering. The control plane would then be
 *    able to void a takeover confirmation by talking a lot, which is remote
 *    control of local state by another name.
 *
 *  - **The remote reset.** If the control plane could clear the blocker by
 *    withdrawing its claim, the coalescing window would be remote-controlled.
 *    So the window is keyed on the LOCAL FACT EPOCH — a count of the local
 *    delivery's own advancing facts — and only a new local fact opens a new
 *    one. The reset is journal-decidable: given the journal, any reader
 *    computes the same epoch, and no message is an input to it.
 *
 * **The blocker counts itself, and that is the subtle part.** `blocker.recorded`
 * is an advancing kind, so the one permitted blocker append increments the very
 * epoch the window is keyed on. If the window were recorded at the epoch the
 * claim was JUDGED against, the blocker would move the journal out from under
 * its own window and the next stale claim in an unchanged local history would
 * block again — one advancing blocker per claim, which is the storm, reached by
 * the back door. So the window is recorded at the epoch the journal carries
 * once the blocker has landed, and the rule that keeps the two definitions from
 * drifting is an ORDERING one, stated here because it is the caller's to honour:
 *
 *   1. append `blocker.recorded` (advancing), then
 *   2. append the claim's `control.plane.mirror.recorded` (observation-only),
 *      stamped with `mirroredAtEpoch`.
 *
 * Every mirror record then carries the same thing — the local fact epoch at the
 * moment it was appended — and `conflictBlockerEpochOf` reads the window back
 * off the journal with no arithmetic at all. A reader that had to add one
 * somewhere would be a second definition, and second definitions drift.
 */

import type { CoordinationMessage } from "./message.ts";

/**
 * The blocker code a coordination contradiction records. One code, because the
 * operator-visible question is always the same one — "the control plane
 * believes something this delivery's own history contradicts" — and the
 * varying detail belongs in the mirror records, not in a proliferation of
 * codes.
 */
export const CONTROL_PLANE_CONFLICT_BLOCKER_CODE = "control-plane.claim-contradicted";

/**
 * The claims that assert something about LOCAL progress, and so can contradict
 * local history. The others describe the control plane's own queue and cannot:
 * "I enqueued this" is never in conflict with anything local.
 */
const PROGRESS_CLAIMS: ReadonlySet<string> = new Set(["advanced", "completed", "cancelled"]);

export interface LocalHistoryView {
  /**
   * The local fact epoch: how many advancing facts this delivery's own journal
   * carries. Derived from the journal by `localFactEpochOf`, never from a
   * message. A superseding local fact increments it, which is exactly what
   * reopens the blocker window.
   */
  readonly localFactEpoch: number;
  /** Whether the local delivery has itself reached a terminal outcome. */
  readonly locallyTerminal: boolean;
  /**
   * Whether local evidence contradicts a claim of completion — for example a
   * sensor that failed while the control plane claims the delivery completed.
   * Decided by the local evidence lane and passed in, never imported.
   */
  readonly localEvidenceContradictsCompletion: boolean;
  /**
   * The coalescing window: the local fact epoch the journal carried once the
   * last coordination conflict blocker had landed, or -1 when none has. It is
   * read straight off the journal by `conflictBlockerEpochOf` — never computed
   * from the judged epoch by adding one — so two readers of the same journal
   * always agree.
   */
  readonly conflictBlockerAtEpoch: number;
}

/**
 * What reconciling one admitted claim costs.
 *
 * `mirror-only` is by far the common case and is the only one that writes
 * nothing but an observation-only record. `blocker` is the first contradiction
 * in a local-fact epoch. `coalesced` is every later contradiction in the same
 * epoch: still mirrored, still audited, but costing no second advancing
 * append.
 */
export type ClaimDisposition = "mirror-only" | "blocker" | "coalesced";

export interface ClaimReconciliation {
  readonly disposition: ClaimDisposition;
  /** True only for `blocker` — the single advancing append this may cost. */
  readonly advancesJournalRevision: boolean;
  /** Always true: every admitted claim is mirrored, contradicted or not. */
  readonly mirrored: boolean;
  readonly blockerCode?: typeof CONTROL_PLANE_CONFLICT_BLOCKER_CODE;
  /**
   * The local fact epoch this claim's mirror record must carry — the epoch the
   * journal holds at the moment that record is appended. For `mirror-only` and
   * `coalesced` that is the epoch the claim was judged against, because nothing
   * advanced. For `blocker` it is one higher, because the blocker append that
   * precedes the mirror record advanced the journal. Stamping this value is
   * what lets the next claim's window be read back rather than recomputed.
   */
  readonly mirroredAtEpoch: number;
  /** Why, in one bounded sentence, for the operator reading the audit. */
  readonly reason: string;
}

/**
 * Whether an admitted claim contradicts local history.
 *
 * Contradiction is decided entirely from the LOCAL view. The message supplies
 * only which claim is being made; it never supplies the evidence that the
 * claim is right, because a party allowed to bring its own evidence is a party
 * that cannot be contradicted.
 */
export function claimContradictsLocalHistory(message: CoordinationMessage, local: LocalHistoryView): boolean {
  if (!PROGRESS_CLAIMS.has(message.claim)) return false;
  if (message.claim === "completed") {
    return local.localEvidenceContradictsCompletion || !local.locallyTerminal;
  }
  // `advanced` and `cancelled` contradict a delivery that has already reached
  // its own terminal outcome: nothing remote can move a finished delivery.
  return local.locallyTerminal;
}

export function reconcileRemoteClaim(message: CoordinationMessage, local: LocalHistoryView): ClaimReconciliation {
  if (!claimContradictsLocalHistory(message, local)) {
    return {
      disposition: "mirror-only",
      advancesJournalRevision: false,
      mirrored: true,
      mirroredAtEpoch: local.localFactEpoch,
      reason: "the claim is consistent with local history, or asserts nothing about local progress; it is recorded as an observation and applied to nothing",
    };
  }
  if (local.conflictBlockerAtEpoch === local.localFactEpoch) {
    return {
      disposition: "coalesced",
      advancesJournalRevision: false,
      mirrored: true,
      mirroredAtEpoch: local.localFactEpoch,
      reason: `a coordination conflict is already blocking at local fact epoch ${local.localFactEpoch}; this claim's detail is kept in its mirror record and costs no second advancing append`,
    };
  }
  return {
    disposition: "blocker",
    advancesJournalRevision: true,
    mirrored: true,
    blockerCode: CONTROL_PLANE_CONFLICT_BLOCKER_CODE,
    // One higher than the judged epoch: the blocker append lands first and is
    // advancing, so this is what the journal carries when the mirror record
    // that pins the window is written. See the ordering contract in the header.
    mirroredAtEpoch: local.localFactEpoch + 1,
    reason: `the control plane claims ${message.claim} against a local history that contradicts it; recorded once for local fact epoch ${local.localFactEpoch}, which closes the coalescing window at epoch ${local.localFactEpoch + 1}`,
  };
}

/**
 * The local fact epoch, computed from the delivery journal's own entries.
 *
 * It counts entries that are NOT observation-only, which is the same partition
 * the reducer uses to advance the expected revision — so "a superseding local
 * fact" means exactly "something that moved the journal", with no second
 * definition to drift. Mirror records are observation-only and therefore
 * cannot increment it: the control plane cannot open its own next window by
 * talking.
 *
 * The caller supplies the kinds rather than the entries so that this unit
 * neither imports the journal store nor re-implements the reducer.
 */
export function localFactEpochOf(
  entryKinds: readonly string[],
  isObservationOnly: (kind: string) => boolean,
): number {
  return entryKinds.reduce((epoch, kind) => (isObservationOnly(kind) ? epoch : epoch + 1), 0);
}

/**
 * A mirror record as far as this unit needs to read one back: the disposition
 * it was written with and the local fact epoch it was stamped at. Structural on
 * purpose — the durable payload carries both members, and this unit neither
 * imports the journal store nor re-states its grammar.
 */
export interface MirrorRecordView {
  readonly disposition: ClaimDisposition;
  readonly localFactEpoch: number;
}

/**
 * The coalescing window, read off the journal's own mirror records.
 *
 * This is the ONLY way `LocalHistoryView.conflictBlockerAtEpoch` should be
 * obtained. It is the last epoch at which a blocker was recorded, and it is a
 * read rather than a computation: the arithmetic lives at the single point in
 * `reconcileRemoteClaim` that decided the value, so no caller can get it
 * subtly different. `-1` when no conflict blocker has ever been recorded, which
 * is an epoch no journal can reach and therefore never accidentally equal.
 */
export function conflictBlockerEpochOf(records: readonly MirrorRecordView[]): number {
  return records.reduce((epoch, record) => (record.disposition === "blocker" ? record.localFactEpoch : epoch), -1);
}
