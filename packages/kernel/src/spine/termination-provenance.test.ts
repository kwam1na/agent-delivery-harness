/**
 * THE TERMINATION-PROVENANCE CONTRACT, defined out of reservation by the
 * trusted host lifecycle integration — the sanctioned per-tranche path: the
 * (delivery, termination.provenance.recorded) pair was enumerated with this
 * owner from the start, and its payload is frozen here.
 *
 * The contract's whole point is honesty about what a host lifecycle event can
 * and cannot prove:
 *
 *   - Only GRACEFUL provenance is expressible. Crash provenance is
 *     structurally unavailable — no supported host can supply it and no daemon
 *     exists to observe it — so the vocabulary carries no discriminator for it
 *     and a record cannot claim one.
 *   - Descendant teardown is recorded as VERIFIED or UNVERIFIED, and the
 *     honest verdict is a cross-member rule of the frozen grammar itself: an
 *     unverified teardown may only ever carry fresh-worktree-only resume. A
 *     journal entry therefore cannot record a Tier 3 same-workspace claim the
 *     host's graded behavior does not support.
 *   - It is NOT observation-only. A termination record is a durable fact about
 *     the prior invocation and advances the expected journal revision, unlike
 *     the activity marker it is explicitly distinct from.
 *
 * Written RED before the kind left reservation.
 */
import { describe, expect, it } from "vitest";
import {
  DESCENDANT_TEARDOWN_STATUSES,
  RESUME_ELIGIBILITIES,
  TERMINATION_PROVENANCE_KINDS,
  validateJournalEntry,
} from "./journal.ts";
import { classifyEventKind } from "./vocabulary.ts";

const entry = (payload: unknown): Record<string, unknown> => ({
  spec: "journal-entry/1",
  journal: "delivery",
  subjectId: "dlv-term-1",
  expectedRevision: 4,
  idempotencyKey: "e4-termination.provenance.recorded",
  kind: "termination.provenance.recorded",
  ...(payload === undefined ? {} : { payload }),
});

const codes = (value: unknown): string[] => {
  const verdict = validateJournalEntry(value);
  return verdict.ok ? [] : verdict.rejections.map((rejection) => rejection.code);
};

describe("the frozen termination-provenance vocabularies", () => {
  it("expresses graceful provenance only — crash provenance has no discriminator", () => {
    expect([...TERMINATION_PROVENANCE_KINDS]).toEqual(["graceful"]);
  });

  it("records descendant teardown as verified or unverified, and nothing else", () => {
    expect([...DESCENDANT_TEARDOWN_STATUSES]).toEqual(["verified", "unverified"]);
  });

  it("offers exactly the two resume positions the capability ladder defines", () => {
    expect([...RESUME_ELIGIBILITIES]).toEqual(["same-workspace", "fresh-worktree-only"]);
  });
});

describe("the termination-provenance event kind", () => {
  it("is active in the delivery journal and advances the expected revision", () => {
    expect(classifyEventKind("delivery", "termination.provenance.recorded")).toEqual({
      status: "active",
      observationOnly: false,
    });
  });

  it("is not homed in the intake or maintenance journals", () => {
    expect(classifyEventKind("intake", "termination.provenance.recorded").status).toBe("unknown");
    expect(classifyEventKind("maintenance", "termination.provenance.recorded").status).toBe("unknown");
  });
});

describe("the frozen termination-provenance payload", () => {
  const verifiedTeardown = {
    fence: 3,
    hostVersion: "claude-code/9.9.9",
    provenance: "graceful",
    descendantTeardown: "verified",
    resumeEligibility: "same-workspace",
  };
  const unverifiedTeardown = {
    fence: 3,
    hostVersion: "claude-code/2.1.97",
    provenance: "graceful",
    descendantTeardown: "unverified",
    resumeEligibility: "fresh-worktree-only",
  };

  it("accepts a verified-teardown record claiming same-workspace resume", () => {
    expect(validateJournalEntry(entry(verifiedTeardown)).ok).toBe(true);
  });

  it("accepts an unverified-teardown record confined to fresh-worktree-only resume", () => {
    expect(validateJournalEntry(entry(unverifiedTeardown)).ok).toBe(true);
  });

  it("accepts a verified-teardown record that still chooses the conservative resume position", () => {
    expect(validateJournalEntry(entry({ ...verifiedTeardown, resumeEligibility: "fresh-worktree-only" })).ok).toBe(true);
  });

  it("REJECTS an unverified-teardown record claiming same-workspace resume — the honesty rule is in the grammar", () => {
    expect(codes(entry({ ...unverifiedTeardown, resumeEligibility: "same-workspace" }))).toContain(
      "unsupported_combination",
    );
  });

  it("rejects a crash-provenance claim: the vocabulary cannot express one", () => {
    expect(codes(entry({ ...unverifiedTeardown, provenance: "crash" }))).toContain("malformed_member");
  });

  it("rejects an unknown teardown status and an unknown resume position", () => {
    expect(codes(entry({ ...unverifiedTeardown, descendantTeardown: "probably" }))).toContain("malformed_member");
    expect(codes(entry({ ...unverifiedTeardown, resumeEligibility: "wherever" }))).toContain("malformed_member");
  });

  it("rejects a stranger member — the payload is closed", () => {
    expect(codes(entry({ ...unverifiedTeardown, priorTaskStopped: true }))).toContain("unknown_member");
  });

  it("rejects a missing member and a zero fence", () => {
    const { hostVersion: _dropped, ...withoutHost } = unverifiedTeardown;
    expect(codes(entry(withoutHost))).toContain("missing_member");
    expect(codes(entry({ ...unverifiedTeardown, fence: 0 }))).toContain("malformed_member");
  });

  it("still rejects an entry with no payload at all", () => {
    expect(codes(entry(undefined))).toContain("missing_member");
  });
});
