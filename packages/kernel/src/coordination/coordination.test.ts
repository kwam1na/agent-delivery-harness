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
import {
  admitCoordinationMessage,
  COORDINATION_REFUSALS,
  replayLedgerOf,
  type CoordinationAdmissionView,
} from "./admission.ts";
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
import { SIMULATED_MESSAGE_OPTION_NAMES, createCoordinationSimulator } from "./simulator.ts";
import { OBSERVATION_ONLY_KINDS } from "../spine/vocabulary.ts";
import { JOURNAL_ENTRY_SPEC, validateJournalEntry } from "../spine/journal.ts";
import { reduceDeliveryJournal } from "../spine/reducer.ts";
import { evaluateCanonicalRecheck } from "../checkpoint/recheck.ts";
import { evaluateMigrationConsumption } from "../facade/migration.ts";
import { CONFIRMATION_FIXTURE_PROFILE } from "../substrate/manifest.ts";
import { applySecretDiscipline, firstSecretIn, SECRET_PATTERNS } from "../checkpoint/redaction.ts";
import { SPINE_ID } from "../spine/grammar.ts";
import { CONTROL_PLANE_CLAIM_KINDS } from "../spine/journal.ts";

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
  establishedChannelDigest: CHANNEL,
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
    // Identity, not equality. The wire's claim list is the spine's list — the
    // header says so and the sensor allowlist is justified by it — and two
    // independent verbatim pins agree only because both were written from the
    // same list. `toBe` is the only assertion a restatement fails.
    expect(CONTROL_PLANE_CLAIMS).toBe(CONTROL_PLANE_CLAIM_KINDS);
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

  it("pins the VALUE rule of every member, not just its presence — a weakened rule is a widened wire", () => {
    // Round 2 found that this family's closed member vocabularies and value
    // shapes were pinned by nothing: `claim` could be weakened from
    // `oneOf(CONTROL_PLANE_CLAIMS)` to `text` — admitting a claim spelled
    // "cancel", which slips past `AUTHORITY_BEARING_CLAIMS` entirely — and
    // every suite stayed green. Presence-and-closure rows read like
    // enforcement and pin neither the vocabulary nor the shape, so this is the
    // reject half of the table, one vector per member with a rule.
    //
    // `protocolVersion` is deliberately absent: its rule IS `text`, because it
    // is the peer's claim about itself and must be able to hold a version this
    // product does not implement. Refusing it by name is `protocol_unsupported`
    // in admission, which has its own row.
    const vectors: readonly (readonly [string, unknown, string, string])[] = [
      // A message of another contract family must not be admitted as this one.
      // `specLiteral` has its own code, which is the point of using it here.
      ["spec", "coordination-message/2", "/spec", "unsupported_spec"],
      ["messageId", "not a spine id", "/messageId", "malformed_member"],
      ["nonce", "not a spine id", "/nonce", "malformed_member"],
      ["sequence", -1, "/sequence", "malformed_member"],
      ["sequence", 1.5, "/sequence", "malformed_member"],
      ["repositoryId", "repo/with/slashes", "/repositoryId", "malformed_member"],
      ["deliveryId", "delivery id", "/deliveryId", "malformed_member"],
      // Not in COORDINATION_MESSAGE_KINDS — near-misses, which is how a
      // widened rule actually gets exercised in the wild.
      ["kind", "cancel", "/kind", "malformed_member"],
      ["kind", "Mirror", "/kind", "malformed_member"],
      // Not in CONTROL_PLANE_CLAIMS. "cancel" is the one that matters: the
      // local-authority gate is keyed on the exact string "cancelled".
      ["claim", "cancel", "/claim", "malformed_member"],
      ["claim", "succeeded", "/claim", "malformed_member"],
      ["claim", "Cancelled", "/claim", "malformed_member"],
      ["summary", "s".repeat(2001), "/summary", "malformed_member"],
      ["authentication", { keyId: "key with spaces", channelDigest: CHANNEL }, "/authentication/keyId", "malformed_member"],
      // The member that binds a message to the channel it arrived on: a
      // replay onto another channel must not verify, which needs a digest.
      ["authentication", { keyId: KEY, channelDigest: "not-a-digest" }, "/authentication/channelDigest", "malformed_member"],
      ["authentication", { keyId: KEY, channelDigest: CHANNEL.toUpperCase() }, "/authentication/channelDigest", "malformed_member"],
    ];
    for (const [name, value, pointer, code] of vectors) {
      const verdict = validateCoordinationMessage({ ...message(), [name]: value });
      const label = `${name}=${JSON.stringify(value)}`;
      expect(verdict.ok, label).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.rejections.map((rejection) => rejection.pointer), label).toEqual([pointer]);
      expect(verdict.rejections.map((rejection) => rejection.code), label).toEqual([code]);
    }

    // The presence half. Every member above is asserted to REJECT a bad value,
    // and an assertion like that passes for free against a grammar that
    // rejects everything — so the boundary value on each side is accepted.
    expect(validateCoordinationMessage({ ...message(), sequence: 0 }).ok).toBe(true);
    expect(validateCoordinationMessage({ ...message(), summary: "s".repeat(2000) }).ok).toBe(true);
    for (const kind of COORDINATION_MESSAGE_KINDS) {
      expect(validateCoordinationMessage({ ...message(), kind }).ok, kind).toBe(true);
    }
    for (const claim of CONTROL_PLANE_CLAIMS) {
      expect(validateCoordinationMessage({ ...message(), claim }).ok, claim).toBe(true);
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

// ── The replay ledger across a restart ────────────────────────────────────

describe("the replay ledger rebuilt from the journal", () => {
  const simulatorOptions = { repositoryId: "repo-1", deliveryId: "delivery-1", keyId: KEY, channelDigest: CHANNEL };

  // Round 3 found that the two admission-view members documented as coming
  // from the journal ("the replay ledger is the local journal") could not be
  // rebuilt from it: the durable mirror record carried no nonce at all, and
  // identified the peer by KEY where the high-water mark is defined per
  // CHANNEL. Replay protection that empties on reconnect is not replay
  // protection, and reconnect is one of this ticket's named scenarios. The
  // record now carries both members and this is the row that walks the loop.
  const mirroredFrom = (message: CoordinationMessage) => ({
    nonce: message.nonce,
    channelDigest: message.authentication.channelDigest,
    remoteSequence: message.sequence,
  });

  it("refuses a nonce and a sequence the journal already holds — a restart forgets nothing", () => {
    const simulator = createCoordinationSimulator(simulatorOptions);
    const first = simulator.mint({ sequence: 4 });
    const admitted = admitCoordinationMessage(first, view({ consumedNonces: new Set(), highestSequence: 3 }));
    expect(admitted.ok).toBe(true);

    // The process restarts. Everything is rebuilt from the durable records.
    const records = [mirroredFrom(first)];
    const ledger = replayLedgerOf(records, CHANNEL);
    expect(ledger.highestSequence).toBe(4);
    expect(ledger.consumedNonces.has(first.nonce)).toBe(true);

    const rebuilt = view({ consumedNonces: ledger.consumedNonces, highestSequence: ledger.highestSequence });
    expect(codesOf(admitCoordinationMessage(first, rebuilt))).toEqual(["nonce_replayed", "sequence_regressed"]);
    // A reordered message below the rebuilt mark is refused on the sequence
    // alone, so the two checks are visibly independent.
    expect(codesOf(admitCoordinationMessage(simulator.mint({ sequence: 2 }), rebuilt))).toEqual(["sequence_regressed"]);

    // The presence half: genuinely new traffic still gets through after the
    // restart, so the ledger is not simply refusing everything.
    expect(admitCoordinationMessage(simulator.mint({ sequence: 5 }), rebuilt).ok).toBe(true);
  });

  it("keeps the ledger per channel — one connector key serving two channels does not conflate their marks", () => {
    const simulator = createCoordinationSimulator(simulatorOptions);
    const busy = simulator.mint({ sequence: 9, channelDigest: OTHER_CHANNEL });
    const quiet = simulator.mint({ sequence: 4 });
    const ledger = replayLedgerOf([mirroredFrom(busy), mirroredFrom(quiet)], CHANNEL);

    // The other channel's high-water mark is not this channel's. Pooling them
    // would refuse legitimate traffic here and admit a replay captured there.
    expect(ledger.highestSequence).toBe(4);
    expect(ledger.consumedNonces.has(busy.nonce)).toBe(false);
    expect(ledger.consumedNonces.has(quiet.nonce)).toBe(true);
    expect(replayLedgerOf([mirroredFrom(busy), mirroredFrom(quiet)], OTHER_CHANNEL).highestSequence).toBe(9);
    // An empty journal yields a mark no message can regress against.
    expect(replayLedgerOf([], CHANNEL)).toEqual({ consumedNonces: new Set(), highestSequence: -1 });
    expect(admitCoordinationMessage(simulator.mint({ sequence: 0 }), view({ highestSequence: -1 })).ok).toBe(true);
  });

  // Round 4 found this one. The two channel-scoped members below it
  // (`consumedNonces`, `highestSequence`) are rebuilt per channel by
  // `replayLedgerOf`, but the channel check was a MEMBERSHIP test against a
  // set of established digests — so a verbatim replay captured on one
  // established channel was re-admitted against another established channel's
  // ledger, which has never seen that nonce and sits below that sequence.
  it("binds a message to the one channel its view's ledger was rebuilt from — a replay captured on another established channel is refused", () => {
    const simulator = createCoordinationSimulator(simulatorOptions);
    // Two channels are live at once, same connector key, both established.
    // A message is admitted and mirrored on the other one.
    const onOther = simulator.mint({ sequence: 7, channelDigest: OTHER_CHANNEL });
    expect(
      admitCoordinationMessage(onOther, view({ establishedChannelDigest: OTHER_CHANNEL, highestSequence: 6 })).ok,
    ).toBe(true);

    // The same bytes are replayed here. This channel's ledger, rebuilt from
    // this channel's records alone, has never seen the nonce and sits below
    // the sequence — so neither replay member can refuse it, and the channel
    // binding is the only thing that can.
    const ledger = replayLedgerOf([mirroredFrom(onOther)], CHANNEL);
    expect(ledger.consumedNonces.has(onOther.nonce)).toBe(false);
    expect(onOther.sequence).toBeGreaterThan(ledger.highestSequence);
    const rebuilt = view({ consumedNonces: ledger.consumedNonces, highestSequence: ledger.highestSequence });
    expect(codesOf(admitCoordinationMessage(onOther, rebuilt))).toEqual(["channel_unrecognized"]);

    // The presence half: this channel's own legitimate traffic is admitted
    // against the very same view, so the refusal above is the binding rather
    // than a view that refuses everything.
    expect(admitCoordinationMessage(simulator.mint({ sequence: 0 }), rebuilt).ok).toBe(true);
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

  // The line above compares the constant to itself and is satisfied by any
  // string whatever — including one the journal grammar refuses, which would
  // make the single permitted advancing blocker UNAPPENDABLE and satisfy
  // "at most one advancing blocker" by costing zero. So the code is pinned
  // verbatim, the way this file pins every other frozen literal, and then run
  // through the real `delivery/blocker.recorded` grammar it has to satisfy.
  it("pins the conflict blocker code verbatim, and proves the journal grammar accepts it", () => {
    expect(CONTROL_PLANE_CONFLICT_BLOCKER_CODE).toBe("control-plane.claim-contradicted");
    const blockerEntry = (code: string): Record<string, unknown> => ({
      spec: JOURNAL_ENTRY_SPEC,
      journal: "delivery",
      subjectId: "delivery-1",
      expectedRevision: 7,
      idempotencyKey: "key-7",
      kind: "blocker.recorded",
      payload: { code, summary: "a remote claim contradicted local history" },
    });
    expect(validateJournalEntry(blockerEntry(CONTROL_PLANE_CONFLICT_BLOCKER_CODE))).toEqual({ ok: true });
    // Anti-vacuity: the entry is not accepted regardless of its code. The
    // grammar checks `code` with the spine id rule, and a value outside it —
    // exactly what a careless edit to the constant would produce — rejects.
    expect(validateJournalEntry(blockerEntry("control plane/claim contradicted!"))).toEqual({
      ok: false,
      rejections: [
        {
          code: "malformed_member",
          pointer: "/payload/code",
          message: expect.any(String) as unknown as string,
        },
      ],
    });
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

// ── AC1's second clause, end to end ───────────────────────────────────────

describe("a reconnect flush against a pending takeover confirmation", () => {
  // Round 2 found that AC1's second clause — mirror appends "void no pending
  // confirmation or assertion" — was argued rather than evidenced: the flush
  // rows walk a `localFactEpochOf` count and the reducer row appends two
  // mirrors, and the step to "no confirmation voided" was left to the reader.
  // This row closes it with the product's own two mechanisms: the real reducer
  // produces the observed revision, and the real `evaluateCanonicalRecheck`
  // takeover consumption is what a pending takeover authorization is actually
  // rechecked by.
  const DIGEST = "a".repeat(64);
  const DIGEST2 = "c".repeat(64);
  const OID = "b".repeat(40);

  const deliveryEntry = (revision: number, kind: string, payload: Record<string, unknown>, key = `key-${revision}-${kind}`) => ({
    spec: JOURNAL_ENTRY_SPEC,
    journal: "delivery",
    subjectId: "delivery-1",
    expectedRevision: revision,
    idempotencyKey: key,
    kind,
    payload,
  });

  const openingEntries = () => [
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
    deliveryEntry(5, "invocation.fenced", {
      fence: 1,
      hostTaskId: "task-1",
      worktreeId: "worktree-1",
      candidateTreeSha: OID,
      candidateBranchRefValue: OID,
      policyDigest: DIGEST,
      authorityEpoch: 4,
      observationLifetimeSeconds: 900,
    }),
  ];

  const mirrorEntry = (revision: number, index: number) =>
    deliveryEntry(
      revision,
      "control.plane.mirror.recorded",
      {
        messageId: `message-${index}`,
        channelKeyId: "connector-key-1",
        nonce: `nonce-${index}`,
        channelDigest: CHANNEL,
        claim: "completed",
        remoteSequence: index,
        localFactEpoch: revision,
        disposition: index === 0 ? "blocker" : "coalesced",
        summary: `the control plane claims completion, flush entry ${index}`,
      },
      `mirror-${index}`,
    );

  const migrationConsumption = (boundRevision: number, observedRevision: number) =>
    evaluateMigrationConsumption(
      {
        spec: "sensitive-approval-assertion/1",
        assertionClass: "security-blocked-migration",
        origin: "installer.maintenance",
        action: "migrate-security-blocked",
        expiry: "2026-08-31T12:00:00Z",
        nonce: "migration-nonce-1",
        assertionSource: "qualification-fixture",
        productTrustRevocationEpoch: 0,
        repositoryAuthorityRevocationEpoch: "absent-by-state",
        deliveryId: "delivery-1",
        candidateTreeSha: "absent-by-state",
        policyDigest: "absent-by-state",
        invocationFence: "absent-by-state",
        targetInstallationId: "install-1",
        targetGenerationDigest: DIGEST,
        targetHighWaterMark: "absent-by-state",
        expectedJournalRevision: boundRevision,
      },
      {
        deliveryId: "delivery-1",
        expectedJournalRevision: observedRevision,
        currentInstallationId: "install-1",
        currentProfile: CONFIRMATION_FIXTURE_PROFILE,
        recordedProfile: CONFIRMATION_FIXTURE_PROFILE,
        recordedInstallationId: "install-0",
        trustState: {
          spec: "product-trust-state/1" as const,
          installationId: "install-1",
          pinnedManifestDigest: DIGEST,
          acceptedGenerationDigests: [DIGEST],
          revokedGenerationDigests: [],
          revocationEpoch: 0,
          highWaterMark: 1,
        },
        consumedNonces: new Set<string>(),
        now: "2026-08-30T12:00:00Z",
      },
    );

  const takeoverRecheck = (boundRevision: number, observedRevision: number) =>
    evaluateCanonicalRecheck({
      consumption: {
        kind: "takeover",
        supersededFence: { kind: "compare", expected: 1, observed: 1 },
        expectedJournalRevision: { kind: "compare", expected: boundRevision, observed: observedRevision },
        targetBaseCommit: { kind: "compare", expected: OID, observed: OID },
      },
      values: {
        "product-trust": { kind: "eligible", ok: true },
        "repository-authority-epoch": { kind: "compare", expected: 4, observed: 4 },
        "invocation-fence": "absent-by-state",
        "registering-installation-id": { kind: "compare", expected: "install-1", observed: "install-1" },
        "active-profile": { kind: "compare", expected: "core", observed: "core" },
        "projection-digest": "absent-by-state",
        "discovery-configuration-digest": "absent-by-state",
      },
    });

  it("leaves the pending confirmation consumable — 1000 mirror records move the bound revision not at all", () => {
    const opening = openingEntries();
    const bound = reduceDeliveryJournal(opening);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    // The operator's takeover authorization is minted here, binding whatever
    // revision the journal carried at that moment.
    const boundRevision = bound.state.expectedRevision;

    const flushed = reduceDeliveryJournal([
      ...opening,
      ...Array.from({ length: 1000 }, (_unused, index) => mirrorEntry(boundRevision, index)),
    ]);
    expect(flushed.ok).toBe(true);
    if (!flushed.ok) return;
    expect(flushed.state.expectedRevision).toBe(boundRevision);

    // The product's own recheck, not a restatement of it: the consumption that
    // a pending takeover authorization goes through still passes.
    expect(takeoverRecheck(boundRevision, flushed.state.expectedRevision)).toEqual({ ok: true });

    // The presence half, and the reason this row is not vacuous: the SAME
    // recheck fails the moment the observed revision really does move, so it
    // is genuinely observing the number the flush left alone.
    const advanced = reduceDeliveryJournal([
      ...opening,
      ...Array.from({ length: 1000 }, (_unused, index) => mirrorEntry(boundRevision, index)),
      deliveryEntry(boundRevision, "transition.committed", { from: "preparing", to: "planning" }),
    ]);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.state.expectedRevision).toBe(boundRevision + 1);
    const voided = takeoverRecheck(boundRevision, advanced.state.expectedRevision);
    expect(voided.ok).toBe(false);
    if (voided.ok) return;
    expect(voided.failures.map((failure) => failure.value)).toContain("expected-journal-revision");
  });

  it("leaves a pending migration assertion consumable too — the scenario names both, so both are pinned", () => {
    // Round 3: the takeover half above was evidenced and the migration half
    // was still argued. The ticket's scenario is verbatim "does not void a
    // pending takeover confirmation OR MIGRATION ASSERTION", and the two are
    // consumed by different modules, so following the reducer number from one
    // to the other is a reader's inference, not a pinned fact.
    const opening = openingEntries();
    const bound = reduceDeliveryJournal(opening);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const boundRevision = bound.state.expectedRevision;

    const flushed = reduceDeliveryJournal([
      ...opening,
      ...Array.from({ length: 1000 }, (_unused, index) => mirrorEntry(boundRevision, index)),
    ]);
    expect(flushed.ok).toBe(true);
    if (!flushed.ok) return;

    expect(migrationConsumption(boundRevision, flushed.state.expectedRevision).ok).toBe(true);

    // The presence half: the same consumption refuses once a real local
    // transition moves the revision the assertion bound.
    const advanced = reduceDeliveryJournal([
      ...opening,
      ...Array.from({ length: 1000 }, (_unused, index) => mirrorEntry(boundRevision, index)),
      deliveryEntry(boundRevision, "transition.committed", { from: "preparing", to: "planning" }),
    ]);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const refused = migrationConsumption(boundRevision, advanced.state.expectedRevision);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.blockers.map((blocker) => blocker.code)).toContain("assertion_mismatch");
  });
});

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

  it("honours every override it declares, and declares every member of the message", () => {
    // The kit's own API claim, pinned rather than narrated. `mint`'s comment
    // says a corpus can bend exactly one member; round 9 found that six of the
    // ten overrides then declared were honoured by nothing any row could tell
    // apart from a hardcoded default — `mint` could have ignored `kind`,
    // `keyId`, `deliveryId`, `protocolVersion`, `summary` or `repositoryId`
    // and the whole suite stayed green — and that two message members,
    // `spec` and `messageId`, could not be bent at all. `messageId` is the
    // member round 5's P0 turns on, so the kit could not mint the vector its
    // own delivery found; it is now an override. `spec` stays fixed, because
    // the message type admits exactly one value for it — the kit's doc comment
    // now says that rather than claiming a bend it cannot perform, and the
    // foreign-envelope vector is pinned against the grammar, which takes
    // `unknown`, by the `unsupported_spec` row above.
    //
    // The table's keys are asserted to BE the declared surface, and that
    // surface answers to the WIRE: `SIMULATED_MESSAGE_OPTION_NAMES` is
    // `OPTION_PRESENCE`'s keys, and that record is typed over the options
    // interface intersected with the message's own bendable members, so a
    // member added to either without being declared is a compile error at its
    // declaration. A member added to the kit therefore turns
    // this row red until someone says where it lands on the wire.
    const BENT: Readonly<Record<string, { readonly value: unknown; readonly read: (minted: CoordinationMessage) => unknown }>> = {
      messageId: { value: "bent-message-id", read: (minted) => minted.messageId },
      kind: { value: "terminal.projection", read: (minted) => minted.kind },
      claim: { value: "cancelled", read: (minted) => minted.claim },
      sequence: { value: 41, read: (minted) => minted.sequence },
      nonce: { value: "bent-nonce", read: (minted) => minted.nonce },
      repositoryId: { value: "repo-bent", read: (minted) => minted.repositoryId },
      deliveryId: { value: "delivery-bent", read: (minted) => minted.deliveryId },
      keyId: { value: "key-bent", read: (minted) => minted.authentication.keyId },
      channelDigest: { value: "channel-bent", read: (minted) => minted.authentication.channelDigest },
      protocolVersion: { value: "control-plane-coordination.9", read: (minted) => minted.protocolVersion },
      summary: { value: "a bent summary", read: (minted) => minted.summary },
    };
    expect(Object.keys(BENT).sort()).toEqual([...SIMULATED_MESSAGE_OPTION_NAMES].sort());

    const simulator = createCoordinationSimulator(options);
    // The second clause of this row's name, read off a message the kit
    // actually minted rather than off the list that claims to describe it.
    // Round 10 found the clause circular: "every member" meant "every member
    // the kit remembered to declare", so a member added to the wire and
    // hardcoded in `mint` left the suite green. `OPTION_PRESENCE`'s type now
    // makes that a compile error; this is the same fact stated where a reader
    // of the row can see it, and it fails at runtime on a minted message that
    // carries a member no override can bend.
    const wireMembers = [
      ...Object.keys(simulator.mint()).filter((name) => name !== "spec" && name !== "authentication"),
      ...Object.keys(simulator.mint().authentication),
    ].sort();
    expect([...SIMULATED_MESSAGE_OPTION_NAMES].sort()).toEqual(wireMembers);
    for (const name of SIMULATED_MESSAGE_OPTION_NAMES) {
      const bent = BENT[name];
      expect(bent, `${name} is declared but this row says nothing about it`).toBeDefined();
      if (bent === undefined) continue;
      const minted = simulator.mint({ [name]: bent.value } as never);
      expect(bent.read(minted), `mint ignored the ${name} override`).toEqual(bent.value);
    }

    // And the bend the kit exists for: the round-5 vector, minted THROUGH the
    // kit rather than hand-rolled, refused by the real admission. A corpus
    // that has to reach around `mint` to express its most important vector is
    // not the kit this module claims to be.
    const shaped = simulator.mint({ messageId: `ghp_${"A".repeat(24)}` });
    expect(codesOf(admitCoordinationMessage(shaped, view()))).toEqual(["message_malformed"]);
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
    // The sequence is deliberately ahead of the view's high-water mark, so the
    // ONE thing refusing this message is the repository scope. Round 9 found
    // the earlier spelling minting at `sequence: 1` against a view whose mark
    // is 3, which earns `sequence_regressed` on its own — so the row was false
    // whether or not the `repositoryId` override was honoured at all.
    const exchange = simulator.exchange(simulator.mint({ repositoryId: "repo-9", sequence: 9 }), view(), local());
    expect(exchange.admission.ok).toBe(false);
    expect(codesOf(exchange.admission)).toEqual(["repository_scope_mismatch"]);
    expect(exchange.reconciliation).toBeUndefined();
  });

  it("delivers on the online path — the contrast the outage row needs to mean anything", async () => {
    // Round 3: `receive()` was only ever asserted on the OFFLINE simulator,
    // where an empty outbox makes `[]` true on both sides of its own guard,
    // and the success side of `send` was asserted nowhere. Emptying both
    // methods left every row green. This module ships as the conformance kit
    // a real control plane is later checked against, so its delivery path is
    // the thing being qualified, not scaffolding.
    const simulator = createCoordinationSimulator(options);
    const first = simulator.mint({ sequence: 1 });
    const second = simulator.mint({ sequence: 2 });
    const sent = await simulator.send(first);
    expect(sent.ok).toBe(true);
    expect(sent.message).toContain(first.messageId);
    expect(await simulator.receive()).toEqual([first]);
    expect((await simulator.send(second)).ok).toBe(true);
    expect(await simulator.receive()).toEqual([first, second]);
    const started = await simulator.requestHostStart("delivery-1");
    expect(started.ok).toBe(true);
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

// ── Admitted implies appendable ────────────────────────────────────────────

/**
 * Round 5's P0. `SPINE_ID` admits `_`, `-` and `.`, so most of the durable
 * path's secret corpus is expressible as a valid spine id — and `messageId`
 * and `nonce` are authored entirely by the peer and reach the frozen mirror
 * payload. The durable path REJECTS a secret in a structural member, which is
 * right, and which is exactly what a peer can weaponise: the reconciliation
 * still owes an advancing `blocker.recorded` (no peer-authored member, so it
 * lands) while the mirror record that carries the coalescing window and the
 * replay nonce does not. The window never closes, so every further
 * contradiction costs another advancing blocker — the storm AC2 forbids —
 * and the nonce is never consumed, so the message replays forever.
 *
 * The invariant these rows pin is one sentence: a message this unit ADMITS
 * can always be mirrored. It is asserted in both directions, because the
 * harmful half is only visible against a message that is refused.
 */
describe("a message this unit admits can always be mirrored", () => {
  const mirrorPayloadOf = (message: CoordinationMessage) => ({
    messageId: message.messageId,
    channelKeyId: message.authentication.keyId,
    nonce: message.nonce,
    channelDigest: message.authentication.channelDigest,
    claim: message.claim,
    remoteSequence: message.sequence,
    localFactEpoch: 7,
    disposition: "blocker",
    summary: message.summary,
  });
  const mirrorEntryOf = (message: CoordinationMessage): Record<string, unknown> => ({
    spec: JOURNAL_ENTRY_SPEC,
    journal: "delivery",
    subjectId: "delivery-1",
    expectedRevision: 8,
    idempotencyKey: "mirror-1",
    kind: "control.plane.mirror.recorded",
    payload: mirrorPayloadOf(message),
  });

  /**
   * One entry per corpus pattern, and the row below asserts the KEYS are the
   * corpus — so a tenth pattern turns that row red the day it lands, until
   * someone classifies it. Round 6 found what a hand-listed table costs: it
   * said "six of the nine" and missed `slack-token`, whose hyphen-and-alnum
   * shape is a perfectly good spine id, so one seventh of the hazard was
   * pinned by nothing and a probe that skipped that one pattern stayed green.
   *
   * An empty array means "no spine id can spell this one", and the row below
   * does not take that on trust either: the entry owes whitespace-free
   * spellings of its own shape in `WHITESPACE_FREE_SPELLINGS`, and the row
   * asserts the corpus matches none of them. Round 7 found why that has to be a
   * property of the PATTERN rather than of its source text: the first version
   * of this row asked whether the source MENTIONED whitespace, which `\s*`,
   * `[\s\S]` and a space inside a character class all satisfy while requiring
   * none — so widening `bearer-credential` from `\s+` to `\s*`, the most
   * ordinary edit a credential pattern receives, made it spine-id spellable
   * with this row green.
   *
   * Where a shape has a case-insensitive spelling, both are listed. All-
   * uppercase vectors alone cannot tell the corpus probe apart from a
   * character-class heuristic — a rule of "credential material is mixed case"
   * would have passed every vector in the round-5 table while admitting the
   * lowercase spelling of the same credential.
   */
  const CORPUS_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
    "private-key-block": [],
    "bearer-credential": [],
    "aws-access-key-id": [`AKIA${"A".repeat(16)}`],
    "github-token": [`ghp_${"A".repeat(24)}`, `ghp_${"a".repeat(24)}`],
    "github-fine-grained-token": [`github_pat_${"A".repeat(24)}`, `github_pat_${"a".repeat(24)}`],
    "slack-token": [`xoxb-${"A".repeat(12)}`, `xoxb-${"a".repeat(12)}`],
    "openai-key": [`sk-${"A".repeat(24)}`, `sk-${"a".repeat(24)}`],
    "google-api-key": [`AIza${"A".repeat(32)}`, `AIza${"a".repeat(32)}`],
    jwt: [`eyJhbGciOiJI.eyJzdWIiOiI.${"A".repeat(10)}`, `eyJhbGciOiJI.eyJzdWIiOiI.${"a".repeat(10)}`],
  };
  /**
   * For each entry claiming unspellability: whitespace-free spellings of that
   * credential's own shape, including the separators a spine id CAN hold
   * (`.`, `_`, `-`). If the corpus matches any of them, the pattern does not
   * require whitespace and the entry's `[]` is wrong.
   *
   * What this proves and what it does not, stated plainly rather than
   * overclaimed — round 7 found the first version of this check asserting a
   * universal ("no spine id can spell this one") while executing a substring
   * test over the regex source. Sampling cannot prove a universal either.
   * What it does prove is that the pattern still rejects the spellings a
   * widening would most plausibly admit, which is the case round 7 actually
   * demonstrated. The universal the delivery genuinely relies on is a
   * different one and is pinned separately, over all nine patterns rather than
   * over these seven, by "consults every corpus pattern when it decides a
   * reference is key material": `reference` consults the WHOLE corpus, not a
   * subset — delete that call, replace it with a heuristic, or skip a single
   * pattern, and that row goes red for the pattern it dropped.
   */
  const WHITESPACE_FREE_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
    "private-key-block": [
      `-----BEGINPRIVATEKEY-----${"A".repeat(24)}-----ENDPRIVATEKEY-----`,
      `BEGINPRIVATEKEY${"A".repeat(24)}`,
      `PRIVATEKEY_${"A".repeat(24)}`,
      `PRIVATE-KEY-${"A".repeat(24)}`,
    ],
    "bearer-credential": [
      `Bearer${"A".repeat(24)}`,
      `Bearer.${"A".repeat(24)}`,
      `Bearer_${"A".repeat(24)}`,
      `Bearer-${"A".repeat(24)}`,
    ],
  };

  /**
   * One value per corpus pattern that the corpus actually matches, whether or
   * not a spine id can hold it. The two whitespace-requiring shapes are spelled
   * here with their whitespace, so the row below can state its universal over
   * ALL NINE patterns rather than over the seven a spine id can spell.
   *
   * Round 8 found why that distinction matters: while the only row exercising
   * `reference` against the corpus iterated the spellable seven, skipping
   * `private-key-block` or `bearer-credential` inside `firstSecretIn` left the
   * suite green. Harmless today — neither is spine-id spellable, so the skip
   * changes no verdict until someone widens the pattern — but the comment
   * beside it claimed a universal the suite did not hold, and a claim that
   * outruns its evidence is the defect, not the mutant it failed to catch.
   */
  const WHITESPACE_BEARING_SPELLINGS: Readonly<Record<string, string>> = {
    "private-key-block": `-----BEGIN RSA PRIVATE KEY-----\n${"A".repeat(24)}\n-----END RSA PRIVATE KEY-----`,
    "bearer-credential": `Bearer ${"A".repeat(24)}`,
  };

  /** A value the corpus matches for `id` — the spine-id spelling if there is one. */
  const matchingValueFor = (id: string): string | undefined =>
    (CORPUS_SPELLINGS[id] ?? [])[0] ?? WHITESPACE_BEARING_SPELLINGS[id];

  const spellableSecrets = (): readonly (readonly [string, string])[] =>
    SECRET_PATTERNS.flatMap((pattern) =>
      (CORPUS_SPELLINGS[pattern.id] ?? []).map((value) => [pattern.id, value] as const),
    );

  it("classifies every corpus pattern — spellable as a spine id, or requiring whitespace", () => {
    // The premise of everything below, and the part a hand-written table gets
    // wrong. The classification is asserted to COVER the corpus, so it cannot
    // silently fall behind it, and each half is checked against the product's
    // own grammar and its own matcher rather than a restatement of either.
    expect(Object.keys(CORPUS_SPELLINGS).sort()).toEqual(SECRET_PATTERNS.map((pattern) => pattern.id).sort());
    // And the unspellable half owes exactly as many whitespace-free spellings
    // as it claims entries, so neither table can drift behind the other.
    expect(Object.keys(WHITESPACE_FREE_SPELLINGS).sort()).toEqual(
      Object.entries(CORPUS_SPELLINGS)
        .filter(([, spellings]) => spellings.length === 0)
        .map(([id]) => id)
        .sort(),
    );
    for (const pattern of SECRET_PATTERNS) {
      const spellings = CORPUS_SPELLINGS[pattern.id] ?? [];
      if (spellings.length === 0) {
        // Unspellable for a checkable reason rather than by assertion, and the
        // reason is a property of the pattern: strip the whitespace out of the
        // credential's own shape and the corpus stops matching it, so no value
        // SPINE_ID can hold is a match. A source-text check would pass here on
        // `\s*` or `[\s\S]` while the pattern required nothing.
        const candidates = WHITESPACE_FREE_SPELLINGS[pattern.id] ?? [];
        expect(candidates.length, `${pattern.id} owes whitespace-free spellings`).toBeGreaterThan(0);
        for (const candidate of candidates) {
          expect(firstSecretIn(candidate), `${pattern.id} matched "${candidate}" without whitespace`).toBeUndefined();
        }
        continue;
      }
      for (const value of spellings) {
        expect(SPINE_ID.test(value), `${pattern.id}: ${value} is spine-id shaped`).toBe(true);
        expect(firstSecretIn(value), `${pattern.id}: ${value} is a corpus match`).toBe(pattern.id);
      }
      // Where the pattern accepts a lowercase spelling, one is owed. An
      // all-uppercase vector set cannot tell the corpus probe apart from a
      // character-class heuristic — round 6's second surviving mutation — and
      // a spelling silently trimmed from the list would restore that.
      if (firstSecretIn((spellings[0] ?? "").toLowerCase()) === pattern.id) {
        expect(
          spellings.some((value) => !/[A-Z]/.test(value)),
          `${pattern.id} accepts a lowercase spelling and owes one`,
        ).toBe(true);
      }
    }
    // Seven of the nine, which is what `message.ts` says. Pinned as a number
    // so the prose and the corpus cannot drift apart silently.
    expect(SECRET_PATTERNS.filter((pattern) => (CORPUS_SPELLINGS[pattern.id] ?? []).length > 0)).toHaveLength(7);
    expect(SECRET_PATTERNS).toHaveLength(9);
  });

  it("refuses a credential-shaped value in every peer-authored reference member", () => {
    for (const [id, token] of spellableSecrets()) {
      expect(codesOf(admitCoordinationMessage(message({ messageId: token }), view())), id).toEqual([
        "message_malformed",
      ]);
      expect(codesOf(admitCoordinationMessage(message({ nonce: token }), view())), id).toEqual([
        "message_malformed",
      ]);
    }
    const token = `ghp_${"A".repeat(24)}`;
    // The rule is stated over every reference member the peer authors, not
    // only the two that reach the durable payload, so it is pinned over all of
    // them. These three earn the shape refusal ALONE: a malformed member
    // short-circuits admission before any scope question is asked, which is
    // deliberate — no scope verdict can honestly be computed over a member
    // whose shape was never established — and is pinned in its own right by
    // "refuses a malformed message as malformed and asks no further question
    // of it". The no-short-circuit corpus governs the checks that run AFTER
    // the shape verdict, and is pinned separately beside it.
    expect(codesOf(admitCoordinationMessage(message({ repositoryId: token }), view()))).toEqual([
      "message_malformed",
    ]);
    expect(codesOf(admitCoordinationMessage(message({ deliveryId: token }), view()))).toEqual([
      "message_malformed",
    ]);
    expect(
      codesOf(
        admitCoordinationMessage(message({ authentication: { keyId: token, channelDigest: CHANNEL } }), view()),
      ),
    ).toEqual(["message_malformed"]);
    // The rejection names the member, so an operator reading the refusal can
    // tell which one the peer shaped.
    const verdict = validateCoordinationMessage(message({ nonce: token }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejections.map((rejection) => [rejection.code, rejection.pointer])).toEqual([
      ["malformed_member", "/nonce"],
    ]);
  });

  it("consults every corpus pattern when it decides a reference is key material", () => {
    // The universal the delivery actually relies on, stated over the WHOLE
    // corpus rather than over the part a spine id can spell. For every entry
    // of `SECRET_PATTERNS` there is a value the corpus matches, and that value
    // in `messageId` draws a rejection naming that pattern id — so removing
    // any single pattern from the consultation, or swapping the corpus call
    // for a heuristic, turns this row red for the pattern it dropped.
    //
    // The two whitespace-bearing values are rejected TWICE over, by the spine
    // id grammar and by the corpus check, because `reference` runs both and
    // the collector keeps both rejections. That is the point: the corpus
    // verdict is not conditional on the grammar verdict, so it stays a real
    // assertion about the corpus even where the grammar would have refused the
    // value anyway.
    for (const pattern of SECRET_PATTERNS) {
      const value = matchingValueFor(pattern.id);
      expect(value, `${pattern.id} owes a matching value`).toBeDefined();
      if (value === undefined) continue;
      expect(firstSecretIn(value), `${pattern.id}: its own value is a corpus match`).toBe(pattern.id);
      const verdict = validateCoordinationMessage(message({ messageId: value }));
      expect(verdict.ok, `${pattern.id} was admitted into a reference member`).toBe(false);
      if (verdict.ok) continue;
      expect(
        verdict.rejections.some(
          (rejection) =>
            rejection.code === "malformed_member" &&
            rejection.pointer === "/messageId" &&
            rejection.message.includes(`${pattern.id} shape`),
        ),
        `${pattern.id} was not named in the rejection of /messageId`,
      ).toBe(true);
    }
  });

  it("mirrors what it admits — and would have failed to mirror what it used to admit", () => {
    // The presence half: an admitted message projects to a mirror record the
    // durable path accepts, both by the frozen payload table and by the secret
    // discipline that runs before any byte is written.
    const admitted = message();
    expect(admitCoordinationMessage(admitted, view()).ok).toBe(true);
    expect(validateJournalEntry(mirrorEntryOf(admitted))).toEqual({ ok: true });
    expect(applySecretDiscipline(mirrorEntryOf(admitted)).ok).toBe(true);

    // The harm half, against the message this unit now refuses. The frozen
    // payload table is satisfied — the value IS a well-formed spine id — and
    // the secret discipline refuses it at the structural member. That is the
    // append that would never have landed, while the blocker beside it would
    // have.
    const shaped = message({ messageId: `ghp_${"A".repeat(24)}` });
    expect(validateJournalEntry(mirrorEntryOf(shaped))).toEqual({ ok: true });
    const disciplined = applySecretDiscipline(mirrorEntryOf(shaped));
    expect(disciplined.ok).toBe(false);
    if (disciplined.ok) return;
    expect(disciplined.matches).toEqual([{ pointer: "/payload/messageId", id: "github-token" }]);
  });

  it("closes the coalescing window and consumes the nonce for every admitted contradiction", () => {
    // The consequence, walked over a real journal. Ten contradicting claims
    // arrive; each is admitted only if it can be mirrored, and the window and
    // the ledger are read back off the mirror records that actually landed.
    const journal = localJournal({ locallyTerminal: true, localEvidenceContradictsCompletion: true });
    const mirrored: { nonce: string; channelDigest: string; remoteSequence: number }[] = [];
    for (let index = 0; index < 10; index += 1) {
      // Every other peer shapes its message id like a credential.
      const claim = message({
        messageId: index % 2 === 0 ? `message-${index}` : `ghp_${"A".repeat(24)}`,
        nonce: `nonce-${index}`,
        sequence: index,
        claim: "completed",
      });
      const admission = admitCoordinationMessage(claim, view({ highestSequence: index - 1 }));
      if (!admission.ok) continue;
      const outcome = reconcileRemoteClaim(claim, journal.view());
      // Admitted means appendable: the record this reconciliation produces is
      // accepted by the durable path, so the window record cannot go missing
      // while its blocker lands.
      expect(applySecretDiscipline(mirrorEntryOf(claim)).ok).toBe(true);
      journal.apply(outcome);
      mirrored.push({
        nonce: claim.nonce,
        channelDigest: claim.authentication.channelDigest,
        remoteSequence: claim.sequence,
      });
    }
    // Five were admitted, and they cost exactly one advancing blocker between
    // them. Before the refusal existed, each of the five would still have been
    // admitted and each would have cost its own.
    expect(journal.mirrorAppends()).toBe(5);
    expect(journal.blockerAppends()).toBe(1);
    // And every admitted message's nonce is consumed, so none of them replays.
    const ledger = replayLedgerOf(mirrored, CHANNEL);
    expect(ledger.consumedNonces.size).toBe(5);
    expect(ledger.highestSequence).toBe(8);
  });
});
