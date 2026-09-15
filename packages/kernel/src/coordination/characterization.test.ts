/**
 * Characterization of the surfaces the control-plane coordination unit is
 * about to extend, pinned BEFORE it extends them.
 *
 * Two kinds of row live here, and the difference is the point of the file:
 *
 *  - **Invariants.** Rows that must read the same after this unit lands as
 *    before it. The observation-only exemption's meaning (an exempt append
 *    advances no expected journal revision, and an entry that assumes it did
 *    is a `revision_mismatch`), the fact that `blocker.recorded` advances and
 *    moves no state by itself, and the secret discipline's free-text set are
 *    all invariants. If this unit breaks one of them it has moved authority,
 *    which is the one thing the ticket forbids.
 *
 *  - **The reservation, as it was found.** `control.plane.mirror.recorded`
 *    was enumerated `reserved` with `observationOnly: true` and the owner
 *    string "control-plane coordination" — this unit — and rejected with or
 *    without a payload. Those rows were committed GREEN against the
 *    unmodified tree in `9cbf3a1`, before a line of the unit existed, which
 *    is what makes the promotion a reviewed diff rather than a silent
 *    widening. They are deliberately not carried forward here: their
 *    successors, asserting the payload table that replaced the reservation,
 *    live in `journal.promotion.test.ts`. A characterization row kept alive
 *    by editing its expected value to match the change pins nothing.
 *
 * Nothing in this file imports the new unit; it characterizes the tree as it
 * was found.
 */
import { describe, expect, it } from "vitest";
import { applySecretDiscipline, FREE_TEXT_MEMBERS } from "../checkpoint/redaction.ts";
import { JOURNAL_ENTRY_SPEC, validateJournalEntry } from "../spine/journal.ts";
import { reduceDeliveryJournal } from "../spine/reducer.ts";

const DIGEST = "a".repeat(64);
const DIGEST2 = "c".repeat(64);
const OID = "b".repeat(40);

type Entry = Record<string, unknown>;

const deliveryEntry = (
  revision: number,
  kind: string,
  payload: Record<string, unknown>,
  key = `key-${revision}-${kind}`,
): Entry => ({
  spec: JOURNAL_ENTRY_SPEC,
  journal: "delivery",
  subjectId: "delivery-1",
  expectedRevision: revision,
  idempotencyKey: key,
  kind,
  payload,
});

const openingEntries = (): Entry[] => [
  deliveryEntry(0, "delivery.registered", {
    contractDigest: DIGEST,
    intakeId: "intake-1",
    confirmationNonce: "nonce-1",
    activeCompositionProfile: "core",
    registeringInstallationId: "install-1",
  }),
  deliveryEntry(1, "policy.snapshot.bound", { policyDigest: DIGEST, repositoryAuthorityEpoch: 4 }),
  deliveryEntry(2, "generation.pinned", { generationDigest: DIGEST2, releaseId: "core-v1", profile: "core" }),
  deliveryEntry(3, "transition.committed", { from: "accepted", to: "preparing" }),
  deliveryEntry(4, "workspace.bound", {
    workspaceId: "workspace-1",
    repositoryId: "repo-1",
    baseRef: "refs/heads/main",
    baseTipSha: OID,
    branchRef: "refs/heads/delivery-1",
    branchRefValue: OID,
    worktreeId: "worktree-1",
    baselineClassification: "clean",
  }),
];

const codesOf = (value: unknown): string[] => {
  const verdict = validateJournalEntry(value);
  return verdict.ok ? [] : verdict.rejections.map((rejection) => rejection.code);
};

// ── Invariants this unit must not move ─────────────────────────────────────

describe("the observation-only exemption's meaning — an invariant", () => {
  it("advances no expected revision for an exempt append, and advances for an ordinary one", () => {
    const outcome = reduceDeliveryJournal([
      ...openingEntries(),
      deliveryEntry(5, "trust.epoch.observed", { productTrustEpoch: 1, repositoryAuthorityEpoch: 4 }),
      deliveryEntry(5, "transition.committed", { from: "preparing", to: "planning" }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.expectedRevision).toBe(6);
    expect(outcome.state.state).toBe("planning");
  });

  it("rejects an exempt append that claims to have advanced the revision", () => {
    const outcome = reduceDeliveryJournal([
      ...openingEntries(),
      deliveryEntry(5, "trust.epoch.observed", { productTrustEpoch: 1, repositoryAuthorityEpoch: 4 }),
      deliveryEntry(6, "trust.epoch.observed", { productTrustEpoch: 2, repositoryAuthorityEpoch: 4 }, "key-b"),
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((rejection) => rejection.code)).toContain("revision_mismatch");
  });
});

describe("blocker.recorded — an invariant", () => {
  it("advances the expected revision and moves no state by itself", () => {
    const outcome = reduceDeliveryJournal([
      ...openingEntries(),
      deliveryEntry(5, "blocker.recorded", { code: "control-plane.conflict", summary: "a contradiction" }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.expectedRevision).toBe(6);
    expect(outcome.state.state).toBe("preparing");
  });

  it("carries a closed three-member payload — a stranger member rejects", () => {
    expect(codesOf(deliveryEntry(3, "blocker.recorded", { code: "c.d", summary: "s", remoteClaim: "x" }))).toEqual([
      "unknown_member",
    ]);
  });
});

describe("secret discipline over durable bytes — an invariant", () => {
  it("names exactly two redactable free-text members", () => {
    expect([...FREE_TEXT_MEMBERS].sort()).toEqual(["reason", "summary"]);
  });

  it("redacts a secret inside summary and rejects the same secret in a structural member", () => {
    const token = `ghp_${"A".repeat(24)}`;
    const redacted = applySecretDiscipline(deliveryEntry(3, "blocker.recorded", { code: "c.d", summary: token }));
    expect(redacted.ok).toBe(true);
    if (!redacted.ok) return;
    expect(redacted.redactions).toEqual(["github-token"]);
    expect(JSON.stringify(redacted.entry)).toContain("[redacted:github-token]");
    expect(JSON.stringify(redacted.entry)).not.toContain(token);

    const rejected = applySecretDiscipline(deliveryEntry(3, "blocker.recorded", { code: "c.d", providerRunKey: token }));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.matches).toEqual([{ pointer: "/payload/providerRunKey", id: "github-token" }]);
  });
});
