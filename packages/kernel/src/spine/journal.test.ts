/**
 * The journal-entry envelope: one closed grammar over the frozen (journal,
 * kind) vocabulary. A reserved kind rejects unconditionally — with or without
 * a payload — until its owning unit defines it; a kind outside the enumeration
 * rejects as unknown; an active kind's payload is a closed member table.
 */
import { describe, expect, it } from "vitest";
import { JOURNAL_ENTRY_SPEC, validateJournalEntry } from "./journal.ts";

const DIGEST = "a".repeat(64);
const OID = "b".repeat(40);

export const entry = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  spec: JOURNAL_ENTRY_SPEC,
  journal: "delivery",
  subjectId: "delivery-1",
  expectedRevision: 3,
  idempotencyKey: "key-3",
  kind: "candidate.recaptured",
  payload: { treeSha: OID, branchRefValue: OID },
  ...overrides,
});

const codesOf = (value: unknown): string[] => {
  const verdict = validateJournalEntry(value);
  return verdict.ok ? [] : verdict.rejections.map((rejection) => rejection.code);
};

describe("the journal-entry envelope", () => {
  it("accepts a well-formed active entry", () => {
    expect(validateJournalEntry(entry({}))).toEqual({ ok: true });
  });

  it("rejects a non-object and a wrong spec token", () => {
    expect(codesOf("not an object")).toContain("not_an_object");
    expect(codesOf(entry({ spec: "journal-entry/2" }))).toContain("unsupported_spec");
  });

  it("rejects an unknown envelope member — the grammar is closed", () => {
    expect(codesOf(entry({ invented: true }))).toContain("unknown_member");
  });

  it("rejects a missing required member", () => {
    const value = entry({});
    delete value["idempotencyKey"];
    expect(codesOf(value)).toContain("missing_member");
  });

  it("rejects a reserved kind WITH a payload", () => {
    const codes = codesOf(entry({ kind: "contract.amended", payload: { anything: 1 } }));
    expect(codes).toContain("reserved_kind");
  });

  it("rejects a reserved kind WITHOUT a payload", () => {
    const value = entry({ kind: "contract.amended" });
    delete value["payload"];
    expect(codesOf(value)).toContain("reserved_kind");
  });

  it("rejects the reserved observation-only mirror kind the same way", () => {
    expect(codesOf(entry({ kind: "control.plane.mirror.recorded", payload: {} }))).toContain("reserved_kind");
  });

  it("rejects an out-of-vocabulary kind as unknown", () => {
    expect(codesOf(entry({ kind: "delivery.invented", payload: {} }))).toContain("unknown_kind");
  });

  it("rejects a known kind in the wrong journal as unknown — the vocabulary is (journal, kind) pairs", () => {
    expect(
      codesOf(entry({ journal: "maintenance", subjectId: "install-1", kind: "candidate.recaptured" })),
    ).toContain("unknown_kind");
  });

  it("accepts operator.confirmation.recorded in BOTH of its enumerated homes, class-scoped", () => {
    const contractConfirmation = {
      spec: "operator-confirmation/1",
      confirmationClass: "contract-confirmation",
      origin: "operator-terminal",
      action: "confirm-contract",
      expiry: "2026-08-30T12:00:00Z",
      nonce: "nonce-1",
      productTrustRevocationEpoch: 0,
      repositoryAuthorityRevocationEpoch: "absent-by-state",
      intakeDraftId: "intake-1",
      deliveryId: "absent-by-state",
      normalizedContractDigest: DIGEST,
      supersededInvocationFence: "absent-by-state",
      expectedJournalRevision: "absent-by-state",
      targetBaseCommit: "absent-by-state",
      boundInvocationFence: "absent-by-state",
      boundCandidateTreeSha: "absent-by-state",
    };
    const takeover = {
      ...contractConfirmation,
      confirmationClass: "takeover-authorization",
      action: "authorize-takeover",
      repositoryAuthorityRevocationEpoch: 4,
      intakeDraftId: "absent-by-state",
      deliveryId: "delivery-1",
      normalizedContractDigest: "absent-by-state",
      supersededInvocationFence: 2,
      expectedJournalRevision: 9,
      targetBaseCommit: OID,
    };

    expect(
      validateJournalEntry(
        entry({
          journal: "intake",
          subjectId: "intake-1",
          kind: "operator.confirmation.recorded",
          payload: { confirmation: contractConfirmation },
        }),
      ),
    ).toEqual({ ok: true });

    expect(
      validateJournalEntry(
        entry({ kind: "operator.confirmation.recorded", payload: { confirmation: takeover } }),
      ),
    ).toEqual({ ok: true });

    // The class scopes the payload to the journal: a takeover authorization
    // cannot ride the intake journal, nor a contract confirmation the
    // delivery journal.
    expect(
      codesOf(
        entry({
          journal: "intake",
          subjectId: "intake-1",
          kind: "operator.confirmation.recorded",
          payload: { confirmation: takeover },
        }),
      ),
    ).toContain("unsupported_combination");
    expect(
      codesOf(entry({ kind: "operator.confirmation.recorded", payload: { confirmation: contractConfirmation } })),
    ).toContain("unsupported_combination");
  });

  it("rejects an unknown payload member on an active kind — payloads are closed too", () => {
    expect(
      codesOf(entry({ payload: { treeSha: OID, branchRefValue: OID, extra: 1 } })),
    ).toContain("unknown_member");
  });

  it("rejects an agent result payload that tries to grant authority", () => {
    const codes = codesOf(
      entry({
        kind: "stage.result.recorded",
        payload: {
          stageId: "implement",
          workflowGraphSha256: DIGEST,
          resultDigest: DIGEST,
          grantedAuthority: ["merge"],
        },
      }),
    );
    expect(codes).toContain("unknown_member");
  });

  it("accepts an operation result whose payload embeds the adapter's typed sensor result", () => {
    const result = {
      spec: "sensor-result/1",
      capabilityId: "repo.check",
      outcome: "passed",
      summary: "sensors clean",
      candidateTreeSha: OID,
    };
    expect(
      validateJournalEntry(
        entry({ kind: "operation.result.recorded", payload: { capabilityId: "repo.check", result } }),
      ),
    ).toEqual({ ok: true });

    // The embedded result is validated for real, and its capability id must
    // match the envelope's.
    expect(
      codesOf(
        entry({
          kind: "operation.result.recorded",
          payload: { capabilityId: "repo.other", result },
        }),
      ),
    ).toContain("unsupported_combination");
    expect(
      codesOf(
        entry({
          kind: "operation.result.recorded",
          payload: { capabilityId: "repo.check", result: { ...result, authority: "merge" } },
        }),
      ),
    ).toContain("unknown_member");
  });

  it("permits transition.committed to carry the tracked-record digest only on the recording -> ready edge", () => {
    const tracked = { path: "delivery/records/record--abc.json", sha256: DIGEST };
    expect(
      validateJournalEntry(
        entry({
          kind: "transition.committed",
          payload: { from: "recording", to: "ready", trackedRecord: tracked },
        }),
      ),
    ).toEqual({ ok: true });
    expect(
      codesOf(
        entry({
          kind: "transition.committed",
          payload: { from: "validating", to: "reviewing", trackedRecord: tracked },
        }),
      ),
    ).toContain("unsupported_combination");
  });
});
