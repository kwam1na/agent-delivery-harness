import { describe, expect, it } from "vitest";
import {
  ASSERTION_CLASSES,
  ASSERTION_SOURCES,
  SENSITIVE_APPROVAL_ASSERTION_SPEC,
  SENSITIVE_MAINTENANCE_ACTIONS,
  SECURITY_BLOCKED_MIGRATION_ACTION,
  assertionClassOf,
  validateSensitiveApprovalAssertion,
} from "./assertion.ts";

const SHA = "a".repeat(64);
const OID = "b".repeat(40);

const deliveryBound = (): Record<string, unknown> => ({
  spec: SENSITIVE_APPROVAL_ASSERTION_SPEC,
  assertionClass: "delivery-bound",
  origin: "facade.approval",
  action: "waiver-confirmation",
  expiry: "2026-08-31T12:00:00Z",
  nonce: "nonce-1",
  assertionSource: "os-native",
  productTrustRevocationEpoch: 0,
  repositoryAuthorityRevocationEpoch: 0,
  deliveryId: "dlv-1",
  candidateTreeSha: OID,
  policyDigest: SHA,
  invocationFence: 1,
  targetInstallationId: "absent-by-state",
  targetGenerationDigest: "absent-by-state",
  targetHighWaterMark: "absent-by-state",
  expectedJournalRevision: "absent-by-state",
});

const maintenanceLane = (action = "update"): Record<string, unknown> => ({
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
});

const migration = (): Record<string, unknown> => ({
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

describe("the frozen assertion vocabulary", () => {
  it("freezes exactly three classes and three sources", () => {
    expect([...ASSERTION_CLASSES]).toEqual(["delivery-bound", "maintenance-lane", "security-blocked-migration"]);
    expect([...ASSERTION_SOURCES]).toEqual(["host-native", "os-native", "qualification-fixture"]);
  });

  it("freezes the sensitive maintenance action set element by element", () => {
    expect([...SENSITIVE_MAINTENANCE_ACTIONS]).toEqual([
      "update",
      "rollback",
      "pin",
      "revoke",
      "unrevoke",
      "advance-high-water-mark",
    ]);
  });
});

describe("delivery-bound assertions", () => {
  it("accepts the full delivery binding", () => {
    expect(validateSensitiveApprovalAssertion(deliveryBound()).ok).toBe(true);
  });

  it("rejects a delivery-bound assertion missing the invocation fence", () => {
    const verdict = validateSensitiveApprovalAssertion({ ...deliveryBound(), invocationFence: "absent-by-state" });
    expect(verdict.ok).toBe(false);
  });

  it("rejects a delivery-bound assertion carrying maintenance targets", () => {
    const verdict = validateSensitiveApprovalAssertion({ ...deliveryBound(), targetInstallationId: "install-abc" });
    expect(verdict.ok).toBe(false);
  });

  it("rejects an absent repository authority epoch on the delivery class", () => {
    const verdict = validateSensitiveApprovalAssertion({
      ...deliveryBound(),
      repositoryAuthorityRevocationEpoch: "absent-by-state",
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("maintenance-lane assertions", () => {
  it("accepts each sensitive maintenance action with its generation target", () => {
    for (const action of ["update", "rollback", "pin", "revoke", "unrevoke"]) {
      expect(validateSensitiveApprovalAssertion(maintenanceLane(action)).ok).toBe(true);
    }
  });

  it("binds the high-water mark, not a generation, for the advance action", () => {
    const advance = {
      ...maintenanceLane("advance-high-water-mark"),
      targetGenerationDigest: "absent-by-state",
      targetHighWaterMark: 9,
    };
    expect(validateSensitiveApprovalAssertion(advance).ok).toBe(true);
    // A generation-shaped advance and a markless advance both reject.
    expect(validateSensitiveApprovalAssertion(maintenanceLane("advance-high-water-mark")).ok).toBe(false);
    expect(
      validateSensitiveApprovalAssertion({ ...advance, targetHighWaterMark: "absent-by-state" }).ok,
    ).toBe(false);
  });

  it("rejects an action outside the sensitive maintenance set", () => {
    expect(validateSensitiveApprovalAssertion(maintenanceLane("garbage-collection")).ok).toBe(false);
    expect(validateSensitiveApprovalAssertion(maintenanceLane("first-install")).ok).toBe(false);
  });

  it("rejects delivery-scoped members on the maintenance class", () => {
    expect(validateSensitiveApprovalAssertion({ ...maintenanceLane(), deliveryId: "dlv-1" }).ok).toBe(false);
    expect(validateSensitiveApprovalAssertion({ ...maintenanceLane(), invocationFence: 4 }).ok).toBe(false);
    expect(validateSensitiveApprovalAssertion({ ...maintenanceLane(), candidateTreeSha: OID }).ok).toBe(false);
  });

  it("rejects a missing target installation", () => {
    const verdict = validateSensitiveApprovalAssertion({ ...maintenanceLane(), targetInstallationId: "absent-by-state" });
    expect(verdict.ok).toBe(false);
  });
});

describe("security-blocked migration assertions", () => {
  it("accepts the migration binding: installation, generation, delivery, journal revision", () => {
    expect(validateSensitiveApprovalAssertion(migration()).ok).toBe(true);
  });

  it("rejects a migration without its expected journal revision", () => {
    expect(validateSensitiveApprovalAssertion({ ...migration(), expectedJournalRevision: "absent-by-state" }).ok).toBe(false);
  });

  it("rejects a migration without the target delivery identity", () => {
    expect(validateSensitiveApprovalAssertion({ ...migration(), deliveryId: "absent-by-state" }).ok).toBe(false);
  });

  it("rejects any action other than the migration action", () => {
    expect(validateSensitiveApprovalAssertion({ ...migration(), action: "update" }).ok).toBe(false);
  });

  it("never binds a candidate or fence: the mandatory re-preparation recaptures them", () => {
    expect(validateSensitiveApprovalAssertion({ ...migration(), candidateTreeSha: OID }).ok).toBe(false);
    expect(validateSensitiveApprovalAssertion({ ...migration(), invocationFence: 2 }).ok).toBe(false);
  });
});

describe("shape discipline", () => {
  it("rejects an unknown member, a wrong spec, and a non-object", () => {
    expect(validateSensitiveApprovalAssertion({ ...deliveryBound(), extra: 1 }).ok).toBe(false);
    expect(validateSensitiveApprovalAssertion({ ...deliveryBound(), spec: "operator-confirmation/1" }).ok).toBe(false);
    expect(validateSensitiveApprovalAssertion("nope").ok).toBe(false);
  });

  it("rejects an unknown assertion source: a source outside the frozen set cannot be graded", () => {
    expect(validateSensitiveApprovalAssertion({ ...deliveryBound(), assertionSource: "model-minted" }).ok).toBe(false);
  });

  it("exposes the declared class for payload scoping", () => {
    expect(assertionClassOf(migration())).toBe("security-blocked-migration");
    expect(assertionClassOf({ assertionClass: "nope" })).toBeUndefined();
    expect(assertionClassOf(null)).toBeUndefined();
  });
});
