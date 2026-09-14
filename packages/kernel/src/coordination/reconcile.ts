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
   * The local fact epoch at which a coordination conflict blocker was last
   * recorded, or -1 when none has been. Read off the delivery journal, so two
   * readers of the same journal always agree.
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
      reason: "the claim is consistent with local history, or asserts nothing about local progress; it is recorded as an observation and applied to nothing",
    };
  }
  if (local.conflictBlockerAtEpoch === local.localFactEpoch) {
    return {
      disposition: "coalesced",
      advancesJournalRevision: false,
      mirrored: true,
      reason: `a coordination conflict is already blocking at local fact epoch ${local.localFactEpoch}; this claim's detail is kept in its mirror record and costs no second advancing append`,
    };
  }
  return {
    disposition: "blocker",
    advancesJournalRevision: true,
    mirrored: true,
    blockerCode: CONTROL_PLANE_CONFLICT_BLOCKER_CODE,
    reason: `the control plane claims ${message.claim} against a local history that contradicts it; recorded once for local fact epoch ${local.localFactEpoch}`,
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
