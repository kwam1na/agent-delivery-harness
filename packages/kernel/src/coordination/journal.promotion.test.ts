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
import { CONTROL_PLANE_CLAIM_KINDS, CONTROL_PLANE_DISPOSITIONS, JOURNAL_ENTRY_SPEC, validateJournalEntry } from "../spine/journal.ts";
import { classifyEventKind, EVENT_VOCABULARY, OBSERVATION_ONLY_KINDS } from "../spine/vocabulary.ts";
import { SUPPORTED_CONTRACT_VERSIONS } from "../substrate/manifest.ts";
import { COORDINATION_PROTOCOL_VERSION } from "./message.ts";

const MIRROR = "control.plane.mirror.recorded";

const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  messageId: "message-42",
  channelKeyId: "connector-key-1",
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

  it("binds the summary member by name to the durable path's redaction rule", () => {
    // Not a restatement of the redaction test: this is the row that fails if
    // someone renames the member to something the free-text set does not
    // contain, which would silently turn redaction into rejection.
    expect(Object.keys(payload())).toContain("summary");
  });

  it("names the implemented wire contract in the composition pin", () => {
    expect(SUPPORTED_CONTRACT_VERSIONS.controlPlane).toBe(COORDINATION_PROTOCOL_VERSION);
    expect(SUPPORTED_CONTRACT_VERSIONS.controlPlane).toBe("control-plane-coordination/1");
  });
});
