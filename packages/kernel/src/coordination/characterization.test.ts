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
 *  - **The reservation, pinned as it stands.** `control.plane.mirror.recorded`
 *    is enumerated `reserved` with `observationOnly: true` and the owner
 *    string "control-plane coordination" — this unit. Reserved pairs reject
 *    with or without a payload. These rows are pinned here so the promotion
 *    out of reservation is a visible, reviewed diff rather than a silent
 *    widening, and they are the rows this delivery deliberately moves. The
 *    post-promotion behaviour is pinned in `journal.promotion.test.ts`.
 *
 * Nothing in this file imports the new unit; it characterizes the tree as it
 * was found.
 */
import { describe, expect, it } from "vitest";
import { applySecretDiscipline, FREE_TEXT_MEMBERS } from "../checkpoint/redaction.ts";
import { JOURNAL_ENTRY_SPEC, validateJournalEntry } from "../spine/journal.ts";
import { reduceDeliveryJournal } from "../spine/reducer.ts";
import { SUPPORTED_CONTRACT_VERSIONS } from "../substrate/manifest.ts";
import { classifyEventKind, EVENT_VOCABULARY, OBSERVATION_ONLY_KINDS } from "../spine/vocabulary.ts";

const DIGEST = "a".repeat(64);
const DIGEST2 = "c".repeat(64);
const OID = "b".repeat(40);
const MIRROR = "control.plane.mirror.recorded";

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

// ── The reservation, as found ──────────────────────────────────────────────

describe("the control-plane mirror pair before promotion", () => {
  it("is enumerated reserved, observation-only, and owned by this unit", () => {
    const found = EVENT_VOCABULARY.filter((entry) => entry.kind === MIRROR);
    expect(found.length).toBe(1);
    expect(found[0]).toEqual({
      journal: "delivery",
      kind: MIRROR,
      status: "reserved",
      observationOnly: true,
      owner: "control-plane coordination",
    });
  });

  it("classifies as reserved — the observation-only bit is not even reported while reserved", () => {
    expect(classifyEventKind("delivery", MIRROR)).toEqual({ status: "reserved" });
  });

  it("rejects the reserved kind with a payload and without one, both as reserved_kind", () => {
    expect(codesOf(deliveryEntry(3, MIRROR, { anything: 1 }))).toEqual(["reserved_kind"]);
    const bare = deliveryEntry(3, MIRROR, {});
    delete bare["payload"];
    expect(codesOf(bare)).toEqual(["reserved_kind"]);
  });

  it("sits in the three-kind exemption list even while reserved", () => {
    expect([...OBSERVATION_ONLY_KINDS]).toEqual(["activity.observed", "trust.epoch.observed", MIRROR]);
  });

  it("pins the contract-version slot as reserved/0", () => {
    expect(SUPPORTED_CONTRACT_VERSIONS.controlPlane).toBe("reserved/0");
  });
});

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
