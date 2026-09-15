/**
 * The mirror kind after promotion: what the frozen payload table now accepts,
 * and — the rows that matter more — what it still refuses.
 *
 * `characterization.test.ts` pins the reservation as it was found. This file
 * pins what replaced it. Read together they are the whole promotion diff, and
 * the two reserved-rejection rows that moved out of `spine/journal.test.ts`
 * land here rather than disappearing.
 */
import { describe, expect, it } from "vitest";
import { applySecretDiscipline } from "../checkpoint/redaction.ts";
import { CONTROL_PLANE_CLAIM_KINDS, CONTROL_PLANE_DISPOSITIONS, JOURNAL_ENTRY_SPEC, validateJournalEntry } from "../spine/journal.ts";
import { classifyEventKind, EVENT_VOCABULARY, OBSERVATION_ONLY_KINDS } from "../spine/vocabulary.ts";
import { SUPPORTED_CONTRACT_VERSIONS } from "../substrate/manifest.ts";
import { COORDINATION_PROTOCOL_VERSION } from "./message.ts";

const MIRROR = "control.plane.mirror.recorded";

const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  messageId: "message-42",
  channelKeyId: "connector-key-1",
  nonce: "sim-nonce-42",
  channelDigest: "d".repeat(64),
  claim: "completed",
  remoteSequence: 11,
  localFactEpoch: 6,
  disposition: "blocker",
  summary: "the control plane claims completion against contradicting local evidence",
  ...overrides,
});

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  spec: JOURNAL_ENTRY_SPEC,
  journal: "delivery",
  subjectId: "delivery-1",
  expectedRevision: 6,
  idempotencyKey: "dk-mirror-1",
  kind: MIRROR,
  payload: payload(),
  ...overrides,
});

const codesOf = (value: unknown): string[] => {
  const verdict = validateJournalEntry(value);
  return verdict.ok ? [] : verdict.rejections.map((rejection) => rejection.code);
};

describe("the promoted mirror pair", () => {
  it("is active and observation-only, and is no longer owned-but-undefined", () => {
    const found = EVENT_VOCABULARY.filter((candidate) => candidate.kind === MIRROR);
    expect(found.length).toBe(1);
    expect(found[0]).toEqual({ journal: "delivery", kind: MIRROR, status: "active", observationOnly: true });
    expect(classifyEventKind("delivery", MIRROR)).toEqual({ status: "active", observationOnly: true });
    expect([...OBSERVATION_ONLY_KINDS]).toEqual(["activity.observed", "trust.epoch.observed", MIRROR]);
  });

  it("accepts a well-formed mirror record", () => {
    expect(validateJournalEntry(entry())).toEqual({ ok: true });
  });

  it("accepts every claim in the frozen vocabulary and every disposition, and refuses one outside each", () => {
    for (const claim of CONTROL_PLANE_CLAIM_KINDS) {
      expect(validateJournalEntry(entry({ payload: payload({ claim }) })), claim).toEqual({ ok: true });
    }
    for (const disposition of CONTROL_PLANE_DISPOSITIONS) {
      expect(validateJournalEntry(entry({ payload: payload({ disposition }) })), disposition).toEqual({ ok: true });
    }
    expect(codesOf(entry({ payload: payload({ claim: "succeeded" }) }))).toEqual(["malformed_member"]);
    expect(codesOf(entry({ payload: payload({ disposition: "applied" }) }))).toEqual(["malformed_member"]);
  });

  it("freezes both vocabularies verbatim", () => {
    expect([...CONTROL_PLANE_CLAIM_KINDS]).toEqual([
      "enqueued",
      "advanced",
      "completed",
      "cancelled",
      "approval-notified",
      "host-start-requested",
    ]);
    expect([...CONTROL_PLANE_DISPOSITIONS]).toEqual(["mirror-only", "blocker", "coalesced"]);
    expect(Object.isFrozen(CONTROL_PLANE_CLAIM_KINDS)).toBe(true);
    expect(Object.isFrozen(CONTROL_PLANE_DISPOSITIONS)).toBe(true);
  });

  it("requires every member — the table is closed in both directions", () => {
    for (const name of Object.keys(payload())) {
      const partial = payload();
      delete partial[name];
      expect(codesOf(entry({ payload: partial })), name).toEqual(["missing_member"]);
    }
  });

  it("pins the VALUE rule of every member — this is the only durable payload whose content comes from outside", () => {
    // Round 2 found that only two of this table's seven members had a reject
    // vector, so five of them could be weakened to `text` or to a bare number
    // with every suite green. Presence rows (`missing_member` for each member)
    // and closure rows (`unknown_member` for a stranger) both pass against a
    // table whose rules accept anything, which is precisely the shape a
    // remote-authored payload must not have.
    const vectors: readonly (readonly [string, unknown])[] = [
      ["messageId", "message 42"],
      ["messageId", "id/with/slashes"],
      ["channelKeyId", "connector key 1"],
      ["nonce", "nonce with spaces"],
      ["channelDigest", "not-a-digest"],
      ["channelDigest", "D".repeat(64)],
      ["remoteSequence", -1],
      ["remoteSequence", 2.5],
      // The member `conflictBlockerEpochOf` reads the coalescing window back
      // off. `-1` is that reader's "no blocker was ever recorded" sentinel, so
      // a negative value here is a value that means something else entirely.
      ["localFactEpoch", -1],
      ["localFactEpoch", 1.5],
      // The bound on how much remote-authored free text one claim can push
      // into the durable journal. "Minimally redacted" is the ticket's word.
      ["summary", "s".repeat(2001)],
    ];
    for (const [name, value] of vectors) {
      const label = `${name}=${JSON.stringify(value)}`;
      expect(codesOf(entry({ payload: payload({ [name]: value }) })), label).toEqual(["malformed_member"]);
    }

    // The presence half: the boundary value on the accepting side of each
    // rule, so none of the rejections above is passing against a table that
    // refuses everything.
    for (const accepted of [
      { remoteSequence: 0 },
      { localFactEpoch: 0 },
      { summary: "s".repeat(2000) },
      { messageId: "message-42.v1_b" },
    ]) {
      expect(validateJournalEntry(entry({ payload: payload(accepted) })), JSON.stringify(accepted)).toEqual({ ok: true });
    }
  });

  it("offers no member through which a remote claim could become a local fact", () => {
    // Each of these is a member some OTHER active payload carries. None of
    // them exists here, and the closed table is what makes that mechanical.
    for (const smuggled of [
      { state: "completed" },
      { to: "completed" },
      { treeSha: "b".repeat(40) },
      { policyDigest: "a".repeat(64) },
      { fence: 3 },
      { evidenceRef: "review.green" },
      { expectedRevision: 9 },
    ]) {
      expect(codesOf(entry({ payload: payload(smuggled) })), JSON.stringify(smuggled)).toEqual(["unknown_member"]);
    }
  });

  it("binds the summary member by name to the durable path's redaction rule — a secret there is redacted, the same secret elsewhere is refused", () => {
    // Round 1 found the earlier version of this row asserting its own fixture
    // (`Object.keys(payload())` contains "summary"), which tests the test. The
    // member name is load-bearing because `FREE_TEXT_MEMBERS` is keyed on it,
    // so the row that means anything runs the durable path's actual discipline
    // over a mirror entry — the only durable payload whose content originates
    // OUTSIDE this installation, which is why the distinction matters here.
    const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz12";

    const inSummary = applySecretDiscipline(entry({ payload: payload({ summary: `the peer said ${token}` }) }));
    expect(inSummary.ok).toBe(true);
    if (inSummary.ok) {
      expect(inSummary.redactions).toContain("github-token");
      expect(JSON.stringify(inSummary.entry)).not.toContain(token);
    }

    // The presence half, and the reason the member name cannot be changed
    // casually: the identical secret in any other member is REFUSED, not
    // redacted. Rename `summary` and this entry stops being redactable and
    // starts being rejected.
    const elsewhere = applySecretDiscipline(entry({ payload: payload({ channelKeyId: token }) }));
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) {
      expect(elsewhere.matches.map((match) => match.pointer)).toContain("/payload/channelKeyId");
    }

    // And redaction is not acceptance: the redacted entry still has to satisfy
    // the frozen payload table.
    if (inSummary.ok) expect(codesOf(inSummary.entry)).toEqual([]);
  });

  it("names the implemented wire contract in the composition pin", () => {
    expect(SUPPORTED_CONTRACT_VERSIONS.controlPlane).toBe(COORDINATION_PROTOCOL_VERSION);
    expect(SUPPORTED_CONTRACT_VERSIONS.controlPlane).toBe("control-plane-coordination/1");
  });
});
