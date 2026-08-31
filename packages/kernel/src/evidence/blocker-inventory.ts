/**
 * THE BLOCKER/REMEDIATION INVENTORY — the audit surface for review loops.
 *
 * A delivery that blocks, remediates, and blocks again leaves nothing readable
 * in its current state: the state field only ever says where it is now. The
 * inventory reads the journal instead, so the whole loop is visible at once —
 * every blocker that was recorded, what to do about it, and whether the
 * delivery actually left the suspended state it caused.
 *
 * The remediation table is closed on both sides, and a sensor in the test
 * suite holds it that way: every code the facade can journal must appear here,
 * and a remediation naming a code nothing journals is dead guidance. `resolved`
 * is derived by replaying the transitions after each blocker, never asserted
 * by a caller.
 */
import { SUSPENDED_DELIVERY_STATES, type DeliveryState } from "../spine/vocabulary.ts";

/** Every blocker code the delivery journal can carry, and its remediation. */
export const DELIVERY_BLOCKER_REMEDIATIONS: Readonly<Record<string, string>> = Object.freeze({
  "trust.generation-ineligible":
    "Restore local trust state through the operator maintenance lane, then leave security_blocked through full re-preparation.",
  "trust.installation-mismatch":
    "Rebinding a delivery to another installation is an explicit migration, not an ambient adoption; run the security-blocked migration.",
  "authority.epoch-changed":
    "The repository authority-revocation epoch moved; re-evaluate the delivery under the current compiled policy before continuing.",
  "discovery.configuration-tampered":
    "Quarantine the workspace and resume through an operator-authorized takeover into a fresh worktree.",
  "projection.tampered":
    "Quarantine the workspace and resume through an operator-authorized takeover into a fresh worktree.",
  "projection.consumption-marker-mismatch":
    "Only the projection this invocation materialized may carry its outputs; quarantine the workspace and take over into a fresh worktree.",
  "workspace.branch-collision":
    "Create the host worktree on the branch the delivery is bound to, or take over onto a fresh takeover branch.",
  "approval.proposal-voided":
    "The candidate changed since the proposal; re-propose the waiver against the current candidate if it still applies.",
  "review.loop-bound-reached":
    "Findings keep recurring; resolve them outside the loop — the bounded blocker exists so the loop cannot spin unobserved.",
  "review.floor-unmet":
    "Complete both mandatory lenses as distinct attempts with independently constructed contexts on the exact candidate.",
  "outcome.criterion-unverified":
    "Satisfy the criterion's sensor on the exact candidate, or carry an approved waiver for it, then re-validate.",
  "outcome.blanket-waiver":
    "At least one acceptance criterion must actually pass; rescope or cancel rather than waiving the whole outcome.",
  "evidence.rejected": "Read the manifest rejection codes verbatim and resubmit corrected evidence for the exact candidate.",
  "admission.refused": "Read the gate's blockers verbatim, satisfy the named obligations, and re-admit.",
  "record.non-neutral-change":
    "The recording commit may carry only review-neutral and record-neutral bytes; drop the non-neutral change and return through validation and a fresh aligned review.",
  "record.protected-authority-path":
    "Remove the projection or discovery-configuration path from the candidate tree; delivery-owned paths are never committed.",
});

const FALLBACK_REMEDIATION =
  "No remediation is declared for this code; read the blocker summary verbatim and resolve it before continuing.";

export function remediationFor(code: string): string {
  return DELIVERY_BLOCKER_REMEDIATIONS[code] ?? FALLBACK_REMEDIATION;
}

export interface BlockerInventoryEntry {
  readonly code: string;
  readonly summary: string;
  readonly remediation: string;
  /** Whether the delivery later stood in a non-suspended state again. */
  readonly resolved: boolean;
}

export interface JournalKindPayload {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

const isSuspended = (state: unknown): boolean =>
  typeof state === "string" && (SUSPENDED_DELIVERY_STATES as readonly string[]).includes(state);

/**
 * The inventory, in journal order. A blocker is `resolved` once a later
 * committed transition leaves the delivery in a non-suspended state — which
 * covers both the ordinary blocked-and-resumed loop and the typed escape that
 * records a blocker without suspending anything.
 */
export function composeBlockerInventory(views: readonly JournalKindPayload[]): readonly BlockerInventoryEntry[] {
  const entries: BlockerInventoryEntry[] = [];
  /** Recorded, with no suspension yet attached to them. */
  let pending: number[] = [];
  /** Recorded, and the delivery then suspended; outstanding until it leaves. */
  let attached: number[] = [];

  const resolve = (indices: readonly number[]): void => {
    for (const index of indices) {
      entries[index] = { ...(entries[index] as BlockerInventoryEntry), resolved: true };
    }
  };

  for (const view of views) {
    if (view.kind === "blocker.recorded") {
      const code = String(view.payload["code"] ?? "blocked");
      pending.push(entries.length);
      entries.push({
        code,
        summary: String(view.payload["summary"] ?? ""),
        remediation: remediationFor(code),
        resolved: false,
      });
      continue;
    }
    if (view.kind !== "transition.committed") continue;
    if (isSuspended(view.payload["to"] as DeliveryState)) {
      attached = [...attached, ...pending];
      pending = [];
      continue;
    }
    // The delivery stands unsuspended again: everything recorded so far was
    // either left behind or never suspended anything at all.
    resolve(attached);
    resolve(pending);
    attached = [];
    pending = [];
  }

  // A blocker that never suspended the delivery is the typed escape — it left
  // nothing outstanding. One the delivery is still suspended under has not
  // been resolved, and the inventory says so.
  resolve(pending);
  return entries;
}
