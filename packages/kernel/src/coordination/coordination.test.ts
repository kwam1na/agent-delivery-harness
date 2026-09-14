/**
 * The control-plane coordination unit, by the three acceptance criteria and
 * the nine named test scenarios.
 *
 * A note on how these rows are written, because the ticket asks for it
 * explicitly: most of what this unit promises is an ABSENCE — no state moved,
 * no obligation satisfied, no revision advanced, no confirmation voided — and
 * an absence assertion passes for free when the mechanism is missing entirely.
 * So every absence row here is paired with a presence row proving the
 * mechanism ran: the message really was admitted, the mirror record really was
 * produced, the blocker really was recorded the first time. A row that only
 * said "nothing happened" would be green against a unit that does nothing.
 */
import { describe, expect, it } from "vitest";
import { admitCoordinationMessage, COORDINATION_REFUSALS, type CoordinationAdmissionView } from "./admission.ts";
import {
  COORDINATION_MESSAGE_KINDS,
  COORDINATION_MESSAGE_SPEC,
  COORDINATION_PROTOCOL_VERSION,
  CONTROL_PLANE_CLAIMS,
  validateCoordinationMessage,
  type CoordinationMessage,
} from "./message.ts";
import {
  claimContradictsLocalHistory,
  conflictBlockerEpochOf,
  CONTROL_PLANE_CONFLICT_BLOCKER_CODE,
  localFactEpochOf,
  reconcileRemoteClaim,
  type ClaimReconciliation,
  type LocalHistoryView,
  type MirrorRecordView,
} from "./reconcile.ts";
import { COORDINATION_PORT_UNBOUND_CODE, UNBOUND_COORDINATION_PORT } from "./port.ts";
import { createCoordinationSimulator } from "./simulator.ts";
import { OBSERVATION_ONLY_KINDS } from "../spine/vocabulary.ts";

const CHANNEL = "d".repeat(64);
const OTHER_CHANNEL = "e".repeat(64);
const KEY = "connector-key-1";
const RELEASE_KEY = "release-signing-key-1";

const message = (overrides: Partial<CoordinationMessage> = {}): CoordinationMessage => ({
  spec: COORDINATION_MESSAGE_SPEC,
  protocolVersion: COORDINATION_PROTOCOL_VERSION,
  messageId: "message-1",
  nonce: "nonce-1",
  sequence: 4,
  repositoryId: "repo-1",
  deliveryId: "delivery-1",
  kind: "mirror",
  claim: "enqueued",
  authentication: { keyId: KEY, channelDigest: CHANNEL },
  summary: "the control plane enqueued this delivery",
  ...overrides,
});

const view = (overrides: Partial<CoordinationAdmissionView> = {}): CoordinationAdmissionView => ({
  repositoryId: "repo-1",
  deliveryId: "delivery-1",
  trustedKeyIds: [KEY],
  establishedChannelDigests: [CHANNEL],
  releaseSigningKeyIds: [RELEASE_KEY],
  consumedNonces: new Set<string>(),
  highestSequence: 3,
  approvalAuthorityIsLocallyValid: false,
  ...overrides,
});

const local = (overrides: Partial<LocalHistoryView> = {}): LocalHistoryView => ({
  localFactEpoch: 6,
  locallyTerminal: false,
  localEvidenceContradictsCompletion: false,
  conflictBlockerAtEpoch: -1,
  ...overrides,
});

const isObservationOnly = (kind: string): boolean => (OBSERVATION_ONLY_KINDS as readonly string[]).includes(kind);

/**
 * A delivery journal the reconciliation rows actually append to.
 *
 * It exists because the two numbers reconciliation turns on — the local fact
 * epoch and the coalescing window — are only correct in RELATION to each other,
 * and a fixture that sets both by hand can state a relation the running system
 * never produces. So this composes them the way the unit's header says the
 * caller must: derive the epoch with the unit's own `localFactEpochOf` over the
 * real observation-only partition, append `blocker.recorded` BEFORE the mirror
 * record when the reconciliation advances, stamp the mirror record with
 * `mirroredAtEpoch`, and read the window back with `conflictBlockerEpochOf`.
 * Nothing here is hand-written except the local facts a local delivery would
 * have recorded anyway.
 */
const localJournal = (history: { locallyTerminal: boolean; localEvidenceContradictsCompletion: boolean }) => {
  const entryKinds: string[] = ["delivery.registered", "policy.snapshot.bound", "transition.committed"];
  const mirrors: MirrorRecordView[] = [];
  const epoch = (): number => localFactEpochOf(entryKinds, isObservationOnly);
  return {
    epoch,
    window: (): number => conflictBlockerEpochOf(mirrors),
    view: (): LocalHistoryView => ({
      localFactEpoch: epoch(),
      locallyTerminal: history.locallyTerminal,
      localEvidenceContradictsCompletion: history.localEvidenceContradictsCompletion,
      conflictBlockerAtEpoch: conflictBlockerEpochOf(mirrors),
    }),
    apply: (outcome: ClaimReconciliation): void => {
      if (outcome.advancesJournalRevision) entryKinds.push("blocker.recorded");
      entryKinds.push("control.plane.mirror.recorded");
      mirrors.push({ disposition: outcome.disposition, localFactEpoch: outcome.mirroredAtEpoch });
    },
    recordLocalFact: (kind: string): void => {
      entryKinds.push(kind);
    },
    blockerAppends: (): number => entryKinds.filter((kind) => kind === "blocker.recorded").length,
    mirrorAppends: (): number => entryKinds.filter((kind) => kind === "control.plane.mirror.recorded").length,
  };
};

const codesOf = (result: ReturnType<typeof admitCoordinationMessage>): string[] =>
  result.ok ? [] : result.refusals.map((refusal) => refusal.code);

// ── The message family ─────────────────────────────────────────────────────

describe("the coordination message grammar", () => {
  it("accepts a well-formed message and freezes both vocabularies verbatim", () => {
    expect(validateCoordinationMessage(message())).toEqual({ ok: true });
    expect([...COORDINATION_MESSAGE_KINDS]).toEqual([
      "enqueue",
      "mirror",
      "host.start.requested",
      "approval.notified",
      "terminal.projection",
    ]);
    expect([...CONTROL_PLANE_CLAIMS]).toEqual([
      "enqueued",
      "advanced",
      "completed",
      "cancelled",
      "approval-notified",
      "host-start-requested",
    ]);
    expect([...COORDINATION_REFUSALS]).toEqual([
      "message_malformed",
      "protocol_unsupported",
      "channel_unrecognized",
      "trust_root_confusion",
      "repository_scope_mismatch",
      "delivery_scope_mismatch",
      "nonce_replayed",
      "sequence_regressed",
      "authority_not_local",
    ]);
  });

  it("has no cancel kind — local cancellation authority is never carried on the wire", () => {
    // Round 1 retired this row's first half, a regex over kind NAMES claiming
    // to fail "the moment someone adds one that could" complete an obligation.
    // A kind named `execution.occurred` passes that regex, so it pinned a
    // spelling convention and not the property. The property is pinned by the
    // verbatim enumeration above, which catches any added kind whatever it is
    // called, and by the rows below showing that a claim is admitted, mirrored,
    // and applied to nothing. What remains here is the one specific absence
    // this unit chose deliberately and a reader would otherwise assume was an
    // oversight.
    expect(COORDINATION_MESSAGE_KINDS).not.toContain("cancel");
  });

  it("is closed — a stranger member rejects, and every member is required", () => {
    expect(validateCoordinationMessage({ ...message(), token: "x" })).toEqual({
      ok: false,
      rejections: [{ code: "unknown_member", pointer: "/token", message: "member is not defined by this frozen grammar" }],
    });
    for (const name of Object.keys(message())) {
      const partial = { ...message() } as Record<string, unknown>;
      delete partial[name];
      const verdict = validateCoordinationMessage(partial);
      expect(verdict.ok, name).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.rejections.map((rejection) => rejection.code), name).toEqual(["missing_member"]);
    }
  });

  it("closes the nested authentication object too — key material has nowhere to land", () => {
    const smuggled = { ...message(), authentication: { keyId: KEY, channelDigest: CHANNEL, privateKey: "-----BEGIN" } };
    const verdict = validateCoordinationMessage(smuggled);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejections).toEqual([
      { code: "unknown_member", pointer: "/authentication/privateKey", message: "member is not defined by this frozen grammar" },
    ]);
  });
});

// ── Admission: the forged / replayed / cross-repository corpus ─────────────

describe("admission", () => {
  it("admits a well-formed, in-scope, fresh message — the mechanism really runs", () => {
    const admitted = admitCoordinationMessage(message(), view());
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.message.messageId).toBe("message-1");
  });

  it("refuses an unsupported protocol version rather than partially understanding it", () => {
    expect(codesOf(admitCoordinationMessage(message({ protocolVersion: "control-plane-coordination.2" }), view()))).toEqual([
      "protocol_unsupported",
    ]);
  });

  it("refuses a coordination key that is also a release-signing key", () => {
    const refused = admitCoordinationMessage(
      message({ authentication: { keyId: RELEASE_KEY, channelDigest: CHANNEL } }),
      view({ trustedKeyIds: [KEY, RELEASE_KEY] }),
    );
    // Trusted as a coordination key AND a release-signing key: the overlap is
    // refused even though the key id is in the trusted set, which is the only
    // way "distinct from the release-signing trust root" is enforceable here.
    expect(codesOf(refused)).toEqual(["trust_root_confusion"]);

    // And the no-short-circuit rule holds at the one place round 1 found it
    // being described rather than enforced: a key that is the release-signing
    // root AND absent from the trusted connector set earned two refusals, and
    // the corpus reports both. The row above is the ONLY vector in which the
    // overlapped key is also trusted, which is exactly why the suppression
    // hid there.
    const bothEarned = admitCoordinationMessage(
      message({ authentication: { keyId: RELEASE_KEY, channelDigest: CHANNEL } }),
      view({ trustedKeyIds: [KEY] }),
    );
    expect(codesOf(bothEarned)).toEqual(["trust_root_confusion", "channel_unrecognized"]);
  });

  it("refuses an unknown key id, and refuses a valid key on an unestablished channel", () => {
    expect(codesOf(admitCoordinationMessage(message({ authentication: { keyId: "who", channelDigest: CHANNEL } }), view()))).toEqual([
      "channel_unrecognized",
    ]);
    expect(codesOf(admitCoordinationMessage(message({ authentication: { keyId: KEY, channelDigest: OTHER_CHANNEL } }), view()))).toEqual([
      "channel_unrecognized",
    ]);
  });

  it("refuses a cross-repository and a cross-delivery message", () => {
    expect(codesOf(admitCoordinationMessage(message({ repositoryId: "repo-2" }), view()))).toEqual([
      "repository_scope_mismatch",
    ]);
    expect(codesOf(admitCoordinationMessage(message({ deliveryId: "delivery-2" }), view()))).toEqual([
      "delivery_scope_mismatch",
    ]);
  });

  it("refuses a replayed nonce and a regressed or repeated sequence — duplicates and reorderings", () => {
    expect(codesOf(admitCoordinationMessage(message(), view({ consumedNonces: new Set(["nonce-1"]) })))).toEqual([
      "nonce_replayed",
    ]);
    // Equal to the high-water mark is a duplicate; below it is a reordering.
    expect(codesOf(admitCoordinationMessage(message({ sequence: 3 }), view()))).toEqual(["sequence_regressed"]);
    expect(codesOf(admitCoordinationMessage(message({ sequence: 1 }), view()))).toEqual(["sequence_regressed"]);
    // And the next one in order is admitted, so the check is not simply always red.
    expect(admitCoordinationMessage(message({ sequence: 4 }), view()).ok).toBe(true);
  });

  it("refuses a remote cancellation and a remote approval without locally valid authority", () => {
    for (const claim of ["cancelled", "approval-notified"] as const) {
      expect(codesOf(admitCoordinationMessage(message({ claim, kind: "approval.notified" }), view())), claim).toEqual([
        "authority_not_local",
      ]);
      // With local authority independently valid, the same message is admitted
      // — so the refusal is the authority check, not the claim being unknown.
      expect(
        admitCoordinationMessage(message({ claim, kind: "approval.notified" }), view({ approvalAuthorityIsLocallyValid: true })).ok,
        claim,
      ).toBe(true);
    }
  });

  it("reports every refusal a message earned, not just the first", () => {
    const forged = message({
      protocolVersion: "control-plane-coordination.9",
      repositoryId: "repo-2",
      deliveryId: "delivery-2",
      sequence: 0,
      claim: "cancelled",
      authentication: { keyId: "who", channelDigest: OTHER_CHANNEL },
    });
    expect(codesOf(admitCoordinationMessage(forged, view({ consumedNonces: new Set(["nonce-1"]) }))).sort()).toEqual(
      [
        "authority_not_local",
        "channel_unrecognized",
        "channel_unrecognized",
        "delivery_scope_mismatch",
        "nonce_replayed",
        "protocol_unsupported",
        "repository_scope_mismatch",
        "sequence_regressed",
      ].sort(),
    );
  });

  it("refuses a malformed message as malformed and asks no further question of it", () => {
    const refused = admitCoordinationMessage({ nonsense: true }, view());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // Every refusal is a shape refusal, and every shape rejection is carried
    // through rather than collapsed to one: the presence half is that the
    // count matches the grammar's own verdict exactly.
    expect(new Set(refused.refusals.map((refusal) => refusal.code))).toEqual(new Set(["message_malformed"]));
    const shape = validateCoordinationMessage({ nonsense: true });
    expect(shape.ok).toBe(false);
    if (shape.ok) return;
    expect(refused.refusals.length).toBe(shape.rejections.length);
    expect(refused.refusals.map((refusal) => refusal.pointer)).toEqual(
      shape.rejections.map((rejection) => rejection.pointer),
    );
  });
});

// ── The conflict truth table ───────────────────────────────────────────────

describe("reconciliation", () => {
  it("mirrors a consistent claim and advances nothing", () => {
    const outcome = reconcileRemoteClaim(message({ claim: "enqueued" }), local());
    expect(outcome.disposition).toBe("mirror-only");
    expect(outcome.advancesJournalRevision).toBe(false);
    expect(outcome.mirrored).toBe(true);
    expect(outcome.blockerCode).toBeUndefined();
  });

  it("carries the whole truth table for which claims can contradict local history", () => {
    const rows: readonly (readonly [string, LocalHistoryView, boolean])[] = [
      ["enqueued", local({ locallyTerminal: true }), false],
      ["approval-notified", local({ locallyTerminal: true }), false],
      ["host-start-requested", local({ locallyTerminal: true }), false],
      ["advanced", local({ locallyTerminal: false }), false],
      ["advanced", local({ locallyTerminal: true }), true],
      ["cancelled", local({ locallyTerminal: false }), false],
      ["cancelled", local({ locallyTerminal: true }), true],
      // Completion is the asymmetric one: claiming it against a delivery that
      // has not locally finished contradicts, and so does claiming it when
      // local evidence says otherwise even though the delivery IS terminal.
      ["completed", local({ locallyTerminal: true }), false],
      ["completed", local({ locallyTerminal: false }), true],
      ["completed", local({ locallyTerminal: true, localEvidenceContradictsCompletion: true }), true],
    ];
    for (const [claim, history, contradicts] of rows) {
      expect(
        claimContradictsLocalHistory(message({ claim: claim as CoordinationMessage["claim"] }), history),
        `${claim} / terminal=${history.locallyTerminal} / evidence=${history.localEvidenceContradictsCompletion}`,
      ).toBe(contradicts);
    }
  });

  it("costs exactly one advancing blocker for the first contradiction in a local-fact epoch", () => {
    const first = reconcileRemoteClaim(message({ claim: "completed" }), local({ localEvidenceContradictsCompletion: true, locallyTerminal: true }));
    expect(first.disposition).toBe("blocker");
    expect(first.advancesJournalRevision).toBe(true);
    expect(first.blockerCode).toBe(CONTROL_PLANE_CONFLICT_BLOCKER_CODE);
    expect(first.mirrored).toBe(true);
  });

  // Both rows below used to hand-write `localFactEpoch: 6` alongside
  // `conflictBlockerAtEpoch: 6` — a pairing composed to make coalescing true
  // and then asserted to be true. Round 1 found the defect that hid behind
  // exactly that: `blocker.recorded` is an ADVANCING kind, so the one permitted
  // blocker increments the epoch its own window is keyed on, and a flush cost
  // one advancing blocker per claim. Nothing short of deriving both numbers
  // from one journal can see it, so these rows walk one.

  it("costs exactly one advancing blocker for a 1000-claim reconnect flush against one unchanged local history", () => {
    const journal = localJournal({ locallyTerminal: true, localEvidenceContradictsCompletion: true });
    const before = journal.epoch();

    const flush = Array.from({ length: 1000 }, (_unused, index) => {
      const outcome = reconcileRemoteClaim(
        message({ claim: "completed", messageId: `m-${index}`, sequence: index }),
        journal.view(),
      );
      journal.apply(outcome);
      return outcome;
    });

    // The absence half, computed rather than assumed: the journal itself holds
    // one blocker, and the epoch moved by exactly that one.
    expect(journal.blockerAppends()).toBe(1);
    expect(journal.epoch()).toBe(before + 1);
    expect(flush.filter((outcome) => outcome.advancesJournalRevision).length).toBe(1);
    expect(flush[0]?.disposition).toBe("blocker");
    expect(flush.slice(1).every((outcome) => outcome.disposition === "coalesced")).toBe(true);
    // The presence half: every one of them is still mirrored, so the detail
    // survives in the audit rather than being dropped on the floor — and the
    // thousand mirror records did not themselves move the epoch.
    expect(flush.every((outcome) => outcome.mirrored)).toBe(true);
    expect(journal.mirrorAppends()).toBe(1000);
  });

  it("reopens the window only when a local fact supersedes — never when the control plane keeps talking", () => {
    const journal = localJournal({ locallyTerminal: true, localEvidenceContradictsCompletion: true });
    journal.apply(reconcileRemoteClaim(message({ claim: "completed" }), journal.view()));
    expect(journal.blockerAppends()).toBe(1);

    // The control plane asking again, however it varies the claim, buys nothing.
    for (const claim of ["completed", "advanced", "cancelled", "completed"] as const) {
      const outcome = reconcileRemoteClaim(message({ claim }), journal.view());
      expect(outcome.disposition, claim).toBe("coalesced");
      journal.apply(outcome);
    }
    expect(journal.blockerAppends()).toBe(1);

    // A superseding LOCAL fact moves the epoch, and the next contradiction
    // costs its one blocker again — and only one.
    journal.recordLocalFact("stage.result.recorded");
    const reopened = reconcileRemoteClaim(message({ claim: "completed" }), journal.view());
    expect(reopened.disposition).toBe("blocker");
    journal.apply(reopened);
    expect(journal.blockerAppends()).toBe(2);
    expect(reconcileRemoteClaim(message({ claim: "completed" }), journal.view()).disposition).toBe("coalesced");
  });

  it("stamps every mirror record with the epoch the journal carried when it was appended", () => {
    // This is what makes the window a READ rather than a computation: the
    // blocker's own mirror record carries the post-append epoch, so
    // `conflictBlockerEpochOf` needs no arithmetic and cannot drift from the
    // one place that decided the value.
    const journal = localJournal({ locallyTerminal: true, localEvidenceContradictsCompletion: true });
    const judged = journal.view().localFactEpoch;

    const blocker = reconcileRemoteClaim(message({ claim: "completed" }), journal.view());
    expect(blocker.mirroredAtEpoch).toBe(judged + 1);
    journal.apply(blocker);
    expect(journal.window()).toBe(journal.epoch());

    const coalesced = reconcileRemoteClaim(message({ claim: "completed" }), journal.view());
    expect(coalesced.mirroredAtEpoch).toBe(journal.epoch());
    journal.apply(coalesced);
    expect(journal.window()).toBe(judged + 1);

    // And a consistent claim, which advances nothing, is stamped at the epoch
    // it was judged against and leaves the window alone.
    const consistent = reconcileRemoteClaim(message({ claim: "enqueued" }), journal.view());
    expect(consistent.disposition).toBe("mirror-only");
    expect(consistent.mirroredAtEpoch).toBe(journal.epoch());
    journal.apply(consistent);
    expect(journal.window()).toBe(judged + 1);
  });

  it("never records a blocker before one is earned — an empty journal has no window", () => {
    // The anti-vacuity half of the reader: -1 is an epoch no journal reaches,
    // so a fresh delivery cannot accidentally compare equal and coalesce the
    // first genuine contradiction into a blocker that was never recorded.
    const journal = localJournal({ locallyTerminal: true, localEvidenceContradictsCompletion: true });
    expect(journal.window()).toBe(-1);
    expect(journal.epoch()).toBeGreaterThanOrEqual(0);
    expect(conflictBlockerEpochOf([])).toBe(-1);
    expect(conflictBlockerEpochOf([{ disposition: "mirror-only", localFactEpoch: 0 }])).toBe(-1);
  });

  it("computes the local fact epoch from local advancing entries only — mirrors cannot open their own window", () => {
    const isObservationOnly = (kind: string): boolean => (OBSERVATION_ONLY_KINDS as readonly string[]).includes(kind);
    const kinds = ["delivery.registered", "policy.snapshot.bound", "transition.committed"];
    expect(localFactEpochOf(kinds, isObservationOnly)).toBe(3);
    // A thousand mirror records later, the epoch has not moved.
    const flooded = [...kinds, ...Array.from({ length: 1000 }, () => "control.plane.mirror.recorded")];
    expect(localFactEpochOf(flooded, isObservationOnly)).toBe(3);
    // Activity and trust observations are exempt too, and a real local fact
    // does move it — the presence half.
    expect(localFactEpochOf([...flooded, "activity.observed", "trust.epoch.observed"], isObservationOnly)).toBe(3);
    expect(localFactEpochOf([...flooded, "stage.result.recorded"], isObservationOnly)).toBe(4);
  });
});

// ── The port and the no-control-plane path ────────────────────────────────

describe("the unbound port — core delivery depends on no connector", () => {
  it("refuses every send and every host-start request, and yields nothing", async () => {
    const sent = await UNBOUND_COORDINATION_PORT.send(message());
    expect(sent.ok).toBe(false);
    expect(sent.code).toBe(COORDINATION_PORT_UNBOUND_CODE);
    const started = await UNBOUND_COORDINATION_PORT.requestHostStart("delivery-1");
    expect(started.ok).toBe(false);
    expect(started.code).toBe(COORDINATION_PORT_UNBOUND_CODE);
    expect(await UNBOUND_COORDINATION_PORT.receive()).toEqual([]);
  });
});

// ── The simulator: the named partition / reordering scenarios ─────────────

describe("the deterministic simulator", () => {
  const options = { repositoryId: "repo-1", deliveryId: "delivery-1", keyId: KEY, channelDigest: CHANNEL };

  it("mints an identical transcript on every run — no clock, no randomness", () => {
    const a = createCoordinationSimulator(options);
    const b = createCoordinationSimulator(options);
    expect([a.mint(), a.mint(), a.mint()]).toEqual([b.mint(), b.mint(), b.mint()]);
  });

  it("routes every decision through the real modules rather than re-deciding", () => {
    const simulator = createCoordinationSimulator(options);
    const minted = simulator.mint({ claim: "completed", sequence: 9 });
    const exchange = simulator.exchange(minted, view({ highestSequence: 8 }), local({ locallyTerminal: false }));
    expect(exchange.admission.ok).toBe(true);
    // The same inputs through the real functions directly produce the same
    // answer — so the simulator is not a second, weaker implementation.
    expect(exchange.reconciliation).toEqual(reconcileRemoteClaim(minted, local({ locallyTerminal: false })));
    expect(exchange.reconciliation?.disposition).toBe("blocker");
  });

  it("never reconciles a refused message — a refusal is not a claim", () => {
    const simulator = createCoordinationSimulator(options);
    const exchange = simulator.exchange(simulator.mint({ repositoryId: "repo-9" }), view(), local());
    expect(exchange.admission.ok).toBe(false);
    expect(exchange.reconciliation).toBeUndefined();
  });

  it("models an outage: sends refuse, receive is empty, and the local delivery is unaffected", async () => {
    const offline = createCoordinationSimulator({ ...options, offline: true });
    const sent = await offline.send(offline.mint());
    expect(sent.ok).toBe(false);
    expect(sent.code).toBe("control_plane_unreachable");
    expect(await offline.receive()).toEqual([]);
    expect((await offline.requestHostStart("delivery-1")).ok).toBe(false);
  });

  it("answers a host-start request without claiming execution occurred", async () => {
    const simulator = createCoordinationSimulator(options);
    const first = await simulator.requestHostStart("delivery-1");
    const second = await simulator.requestHostStart("delivery-1");
    // Duplicate host-start requests are both answered the same way: the
    // request was delivered. Neither says a runtime was created or that the
    // delivery ran, which the control plane is in no position to know.
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(first.message).toContain("no execution is claimed");
  });

  it("refuses a duplicate and a reordered message once the ledger has seen them", () => {
    const simulator = createCoordinationSimulator(options);
    const first = simulator.mint({ sequence: 5, nonce: "n-5" });
    expect(simulator.exchange(first, view({ highestSequence: 4 }), local()).admission.ok).toBe(true);
    // Replayed verbatim after the ledger advanced: both the nonce and the
    // sequence refuse, and neither is mirrored.
    const replayed = simulator.exchange(
      first,
      view({ highestSequence: 5, consumedNonces: new Set(["n-5"]) }),
      local(),
    );
    expect(codesOf(replayed.admission).sort()).toEqual(["nonce_replayed", "sequence_regressed"]);
    expect(replayed.reconciliation).toBeUndefined();
  });

  it("handles remote completion while a local sensor failed — mirrored, blocked once, never applied", () => {
    const simulator = createCoordinationSimulator(options);
    const history = local({ locallyTerminal: false, localEvidenceContradictsCompletion: true });
    const exchange = simulator.exchange(simulator.mint({ claim: "completed", sequence: 4 }), view(), history);
    expect(exchange.admission.ok).toBe(true);
    expect(exchange.reconciliation?.disposition).toBe("blocker");
    expect(exchange.reconciliation?.mirrored).toBe(true);
    // The presence half of "never applied": the outcome names no state, no
    // obligation and no transition, and offers the caller nothing to apply.
    // `mirroredAtEpoch` is a COUNT of local facts, not one of them — it tells
    // the caller what to stamp the observation with and nothing about what to
    // do — so the closed shape still carries no applicable member.
    expect(Object.keys(exchange.reconciliation ?? {}).sort()).toEqual(
      ["advancesJournalRevision", "blockerCode", "disposition", "mirrored", "mirroredAtEpoch", "reason"].sort(),
    );
  });

  it("reconciles a reconnect after local completion without contradicting it", () => {
    const simulator = createCoordinationSimulator(options);
    const history = local({ locallyTerminal: true, localEvidenceContradictsCompletion: false });
    const exchange = simulator.exchange(simulator.mint({ claim: "completed", sequence: 4 }), view(), history);
    expect(exchange.reconciliation?.disposition).toBe("mirror-only");
    expect(exchange.reconciliation?.advancesJournalRevision).toBe(false);
  });
});
