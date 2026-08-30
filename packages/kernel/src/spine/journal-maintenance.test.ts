/**
 * The two event kinds the composition-lifecycle unit defines out of the
 * reserved vocabulary: `approval.assertion.consumed` (delivery journal) and
 * `maintenance.action.recorded` (maintenance journal). Defining a reserved
 * kind's payload is the sanctioned path — the vocabulary enumerated both pairs
 * with this owner from the start.
 */
import { describe, expect, it } from "vitest";
import { JOURNAL_ENTRY_SPEC, validateJournalEntry } from "./journal.ts";
import { SECURITY_BLOCKED_MIGRATION_ACTION, SENSITIVE_APPROVAL_ASSERTION_SPEC } from "./assertion.ts";

const SHA = "a".repeat(64);

const migrationAssertion = (): Record<string, unknown> => ({
  spec: SENSITIVE_APPROVAL_ASSERTION_SPEC,
  assertionClass: "security-blocked-migration",
  origin: "installer.maintenance",
  action: SECURITY_BLOCKED_MIGRATION_ACTION,
  expiry: "2026-08-31T12:00:00Z",
  nonce: "nonce-3",
  assertionSource: "os-native",
  productTrustRevocationEpoch: 3,
  repositoryAuthorityRevocationEpoch: "absent-by-state",
  deliveryId: "dlv-1",
  candidateTreeSha: "absent-by-state",
  policyDigest: "absent-by-state",
  invocationFence: "absent-by-state",
  targetInstallationId: "install-abc",
  targetGenerationDigest: SHA,
  targetHighWaterMark: "absent-by-state",
  expectedJournalRevision: 7,
});

const maintenanceAssertion = (action = "update", overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  spec: SENSITIVE_APPROVAL_ASSERTION_SPEC,
  assertionClass: "maintenance-lane",
  origin: "installer.maintenance",
  action,
  expiry: "2026-08-31T12:00:00Z",
  nonce: "nonce-2",
  assertionSource: "os-native",
  productTrustRevocationEpoch: 3,
  repositoryAuthorityRevocationEpoch: "absent-by-state",
  deliveryId: "absent-by-state",
  candidateTreeSha: "absent-by-state",
  policyDigest: "absent-by-state",
  invocationFence: "absent-by-state",
  targetInstallationId: "install-abc",
  targetGenerationDigest: SHA,
  targetHighWaterMark: "absent-by-state",
  expectedJournalRevision: "absent-by-state",
  ...overrides,
});

const consumedEntry = (payload: Record<string, unknown>): Record<string, unknown> => ({
  spec: JOURNAL_ENTRY_SPEC,
  journal: "delivery",
  subjectId: "dlv-1",
  expectedRevision: 7,
  idempotencyKey: "key-7",
  kind: "approval.assertion.consumed",
  payload,
});

const maintenanceEntry = (payload: Record<string, unknown>): Record<string, unknown> => ({
  spec: JOURNAL_ENTRY_SPEC,
  journal: "maintenance",
  subjectId: "install-abc",
  expectedRevision: 0,
  idempotencyKey: "key-0",
  kind: "maintenance.action.recorded",
  payload,
});

const codesOf = (value: unknown): string[] => {
  const verdict = validateJournalEntry(value);
  return verdict.ok ? [] : verdict.rejections.map((rejection) => rejection.code);
};

describe("approval.assertion.consumed — delivery journal", () => {
  it("accepts a consumed migration assertion recording the new registering installation", () => {
    const value = consumedEntry({ assertion: migrationAssertion(), newRegisteringInstallationId: "install-target" });
    expect(validateJournalEntry(value)).toEqual({ ok: true });
  });

  it("accepts a generation-change migration with the identity absent-by-state", () => {
    const value = consumedEntry({ assertion: migrationAssertion(), newRegisteringInstallationId: "absent-by-state" });
    expect(validateJournalEntry(value)).toEqual({ ok: true });
  });

  it("rejects a maintenance-lane assertion in the delivery journal — that consumption homes in the maintenance journal", () => {
    const value = consumedEntry({ assertion: maintenanceAssertion(), newRegisteringInstallationId: "absent-by-state" });
    expect(codesOf(value)).toContain("unsupported_combination");
  });

  it("rejects a malformed embedded assertion verbatim", () => {
    const value = consumedEntry({
      assertion: { ...migrationAssertion(), expectedJournalRevision: "absent-by-state" },
      newRegisteringInstallationId: "absent-by-state",
    });
    expect(codesOf(value)).toContain("unsupported_combination");
  });
});

describe("maintenance.action.recorded — maintenance journal", () => {
  it("accepts an update started under its maintenance-lane assertion", () => {
    const value = maintenanceEntry({
      action: "update",
      phase: "started",
      generationDigest: SHA,
      highWaterMark: "absent-by-state",
      assertion: maintenanceAssertion("update"),
    });
    expect(validateJournalEntry(value)).toEqual({ ok: true });
  });

  it("accepts the completion and recovery phases without repeating the assertion", () => {
    for (const phase of ["completed", "recovered"]) {
      const value = maintenanceEntry({
        action: "update",
        phase,
        generationDigest: SHA,
        highWaterMark: "absent-by-state",
        assertion: "absent-by-state",
      });
      expect(validateJournalEntry(value)).toEqual({ ok: true });
    }
  });

  it("accepts the first install with no assertion — the operator act precedes assertion hardening", () => {
    const value = maintenanceEntry({
      action: "first-install",
      phase: "completed",
      generationDigest: SHA,
      highWaterMark: "absent-by-state",
      assertion: "absent-by-state",
    });
    expect(validateJournalEntry(value)).toEqual({ ok: true });
  });

  it("rejects a sensitive instant action without its assertion — a model-driven trust-state write is impossible", () => {
    for (const action of ["pin", "revoke", "unrevoke"]) {
      const value = maintenanceEntry({
        action,
        phase: "completed",
        generationDigest: SHA,
        highWaterMark: "absent-by-state",
        assertion: "absent-by-state",
      });
      expect(codesOf(value)).toContain("unsupported_combination");
    }
  });

  it("rejects an update started without its assertion", () => {
    const value = maintenanceEntry({
      action: "update",
      phase: "started",
      generationDigest: SHA,
      highWaterMark: "absent-by-state",
      assertion: "absent-by-state",
    });
    expect(codesOf(value)).toContain("unsupported_combination");
  });

  it("binds the high-water-mark advance to its mark, matching the assertion", () => {
    const good = maintenanceEntry({
      action: "advance-high-water-mark",
      phase: "completed",
      generationDigest: "absent-by-state",
      highWaterMark: 9,
      assertion: maintenanceAssertion("advance-high-water-mark", {
        targetGenerationDigest: "absent-by-state",
        targetHighWaterMark: 9,
      }),
    });
    expect(validateJournalEntry(good)).toEqual({ ok: true });
    const mismatched = maintenanceEntry({
      action: "advance-high-water-mark",
      phase: "completed",
      generationDigest: "absent-by-state",
      highWaterMark: 8,
      assertion: maintenanceAssertion("advance-high-water-mark", {
        targetGenerationDigest: "absent-by-state",
        targetHighWaterMark: 9,
      }),
    });
    expect(codesOf(mismatched)).toContain("unsupported_combination");
  });

  it("rejects an assertion whose action or generation disagrees with the recorded action", () => {
    const wrongAction = maintenanceEntry({
      action: "revoke",
      phase: "completed",
      generationDigest: SHA,
      highWaterMark: "absent-by-state",
      assertion: maintenanceAssertion("update"),
    });
    expect(codesOf(wrongAction)).toContain("unsupported_combination");
    const wrongGeneration = maintenanceEntry({
      action: "revoke",
      phase: "completed",
      generationDigest: "b".repeat(64),
      highWaterMark: "absent-by-state",
      assertion: maintenanceAssertion("revoke"),
    });
    expect(codesOf(wrongGeneration)).toContain("unsupported_combination");
  });

  it("rejects an action outside the frozen maintenance vocabulary", () => {
    const value = maintenanceEntry({
      action: "reinitialize-epoch",
      phase: "completed",
      generationDigest: SHA,
      highWaterMark: "absent-by-state",
      assertion: "absent-by-state",
    });
    expect(validateJournalEntry(value).ok).toBe(false);
  });
});
