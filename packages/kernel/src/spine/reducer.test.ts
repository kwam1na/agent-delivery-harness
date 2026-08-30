/**
 * The pure reducers over the frozen state tables. The transition matrices are
 * asserted row by row against the plan's State and Authority Model; the
 * journal reducers prove expected-revision discipline (with the three-kind
 * observation-only exemption), monotonic fences, idempotency keys, stable
 * subject identity, and that no agent-produced result can move an authority
 * binding.
 */
import { describe, expect, it } from "vitest";
import { JOURNAL_ENTRY_SPEC } from "./journal.ts";
import {
  DELIVERY_TRANSITION_TABLE,
  isDeliveryTransitionValid,
  isIntakeTransitionValid,
  reduceDeliveryJournal,
  reduceIntakeJournal,
} from "./reducer.ts";
import { DELIVERY_STATES, INTAKE_STATES, TERMINAL_DELIVERY_STATES } from "./vocabulary.ts";

const DIGEST = "a".repeat(64);
const DIGEST2 = "c".repeat(64);
const OID = "b".repeat(40);

// ── Delivery transition matrix ─────────────────────────────────────────────

describe("the frozen delivery transition table", () => {
  it("carries the enumerated conditional rows verbatim", () => {
    const rows = DELIVERY_TRANSITION_TABLE.map((row) => `${row.from}->${row.to}`);
    expect(rows).toEqual([
      "accepted->preparing",
      "preparing->planning",
      "planning->implementing",
      "implementing->validating",
      "validating->remediating",
      "validating->reviewing",
      "reviewing->remediating",
      "remediating->validating",
      "reviewing->compounding",
      "compounding->admitting",
      "compounding->validating",
      "admitting->recording",
      "recording->ready",
      "recording->validating",
      "ready->completed",
      "ready->awaiting_approval",
      "ready->acting",
      "awaiting_approval->acting",
      "awaiting_approval->blocked",
      "awaiting_approval->cancelled",
      "awaiting_approval->validating",
      "acting->completed",
      "acting->acting",
      "acting->action_succeeded_verification_failed",
    ]);
    for (const row of DELIVERY_TRANSITION_TABLE) {
      expect(row.condition.length).toBeGreaterThan(0);
      expect(isDeliveryTransitionValid(row.from, row.to)).toBe(true);
    }
  });

  it("never enters `failed` — the discriminator is frozen verbatim with no invented entry condition", () => {
    for (const from of DELIVERY_STATES) {
      expect(isDeliveryTransitionValid(from, "failed"), `${from}->failed`).toBe(false);
    }
  });

  it("gives terminal states no exits", () => {
    for (const from of TERMINAL_DELIVERY_STATES) {
      for (const to of DELIVERY_STATES) {
        expect(isDeliveryTransitionValid(from, to), `${from}->${to}`).toBe(false);
      }
    }
  });

  it("has no admission edge from remediating — a final aligned review is mandatory after every mutation", () => {
    expect(isDeliveryTransitionValid("remediating", "validating")).toBe(true);
    expect(isDeliveryTransitionValid("remediating", "reviewing")).toBe(false);
    expect(isDeliveryTransitionValid("remediating", "admitting")).toBe(false);
  });

  it("reaches security_blocked from every non-terminal state, and leaves it only through full re-preparation", () => {
    for (const from of DELIVERY_STATES) {
      const expected = !TERMINAL_DELIVERY_STATES.includes(from as never) && from !== "security_blocked";
      expect(isDeliveryTransitionValid(from, "security_blocked"), `${from}->security_blocked`).toBe(expected);
    }
    expect(isDeliveryTransitionValid("security_blocked", "preparing")).toBe(true);
    expect(isDeliveryTransitionValid("security_blocked", "validating")).toBe(false);
    expect(isDeliveryTransitionValid("security_blocked", "ready")).toBe(false);
  });

  it("routes cancellation through cancellation_requested to cancelled", () => {
    expect(isDeliveryTransitionValid("implementing", "cancellation_requested")).toBe(true);
    expect(isDeliveryTransitionValid("cancellation_requested", "cancelled")).toBe(true);
    expect(isDeliveryTransitionValid("cancellation_requested", "implementing")).toBe(false);
  });

  it("rejects the skips the table does not enumerate", () => {
    expect(isDeliveryTransitionValid("accepted", "implementing")).toBe(false);
    expect(isDeliveryTransitionValid("planning", "validating")).toBe(false);
    expect(isDeliveryTransitionValid("validating", "admitting")).toBe(false);
    expect(isDeliveryTransitionValid("admitting", "ready")).toBe(false);
  });
});

// ── Intake transition matrix ───────────────────────────────────────────────

describe("the frozen intake transition table", () => {
  it("accepts the linear chain verbatim and nothing that skips it", () => {
    expect(isIntakeTransitionValid("draft_scope", "awaiting_clarification")).toBe(true);
    expect(isIntakeTransitionValid("awaiting_clarification", "awaiting_confirmation")).toBe(true);
    expect(isIntakeTransitionValid("awaiting_confirmation", "validating_acceptance")).toBe(true);
    expect(isIntakeTransitionValid("validating_acceptance", "accepted_contract")).toBe(true);
    expect(isIntakeTransitionValid("draft_scope", "awaiting_confirmation")).toBe(false);
    expect(isIntakeTransitionValid("awaiting_clarification", "accepted_contract")).toBe(false);
  });

  it("enters blocked from validating_acceptance and may retry validating_acceptance", () => {
    expect(isIntakeTransitionValid("validating_acceptance", "blocked")).toBe(true);
    expect(isIntakeTransitionValid("blocked", "validating_acceptance")).toBe(true);
    expect(isIntakeTransitionValid("blocked", "accepted_contract")).toBe(false);
  });

  it("returns to awaiting_confirmation when the presented draft mutates", () => {
    expect(isIntakeTransitionValid("validating_acceptance", "awaiting_confirmation")).toBe(true);
  });

  it("can be abandoned from every non-terminal state, and terminal states have no exits", () => {
    for (const from of INTAKE_STATES) {
      const terminal = from === "accepted_contract" || from === "abandoned";
      expect(isIntakeTransitionValid(from, "abandoned"), `${from}->abandoned`).toBe(!terminal);
      if (terminal) {
        for (const to of INTAKE_STATES) {
          expect(isIntakeTransitionValid(from, to), `${from}->${to}`).toBe(false);
        }
      }
    }
  });
});

// ── Delivery journal reducer ───────────────────────────────────────────────

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

const registration = (revision = 0): Entry =>
  deliveryEntry(revision, "delivery.registered", {
    contractDigest: DIGEST,
    intakeId: "intake-1",
    confirmationNonce: "nonce-1",
    activeCompositionProfile: "core",
    registeringInstallationId: "install-1",
  });

const openingEntries = (): Entry[] => [
  registration(),
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

const reduceCodes = (entries: readonly Entry[]): string[] => {
  const outcome = reduceDeliveryJournal(entries);
  return outcome.ok ? [] : outcome.rejections.map((rejection) => rejection.code);
};

describe("the delivery journal reducer", () => {
  it("reduces a well-formed opening journal to its bound state", () => {
    const outcome = reduceDeliveryJournal(openingEntries());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toMatchObject({
      deliveryId: "delivery-1",
      state: "preparing",
      expectedRevision: 6,
      lastFence: 1,
      policyDigest: DIGEST,
      authorityEpoch: 4,
      generationDigest: DIGEST2,
    });
  });

  it("requires the first entry to be the registration", () => {
    expect(reduceCodes([deliveryEntry(0, "candidate.recaptured", { treeSha: OID, branchRefValue: OID })])).toContain(
      "registration_missing",
    );
    expect(reduceCodes([...openingEntries(), registration(6)])).toContain("unsupported_combination");
  });

  it("never advances the expected revision for an observation-only append", () => {
    const entries = [
      ...openingEntries(),
      deliveryEntry(6, "activity.observed", { activity: "active", fence: 1 }),
      deliveryEntry(6, "trust.epoch.observed", { productTrustEpoch: 1, repositoryAuthorityEpoch: 4 }),
      deliveryEntry(6, "transition.committed", { from: "preparing", to: "planning" }),
    ];
    const outcome = reduceDeliveryJournal(entries);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.expectedRevision).toBe(7);
    expect(outcome.state.state).toBe("planning");

    // An observation claiming to advance the revision is a mismatch.
    expect(
      reduceCodes([...openingEntries(), deliveryEntry(7, "activity.observed", { activity: "active", fence: 1 })]),
    ).toContain("revision_mismatch");
    // And a fenced append that assumes the observation advanced it is too.
    expect(
      reduceCodes([
        ...openingEntries(),
        deliveryEntry(6, "activity.observed", { activity: "active", fence: 1 }),
        deliveryEntry(7, "transition.committed", { from: "preparing", to: "planning" }),
      ]),
    ).toContain("revision_mismatch");
  });

  it("rejects a reserved kind — the exemption list does not resurrect it", () => {
    expect(reduceCodes([...openingEntries(), deliveryEntry(6, "control.plane.mirror.recorded", {})])).toContain(
      "reserved_kind",
    );
  });

  it("rejects a duplicate idempotency key", () => {
    expect(
      reduceCodes([
        ...openingEntries(),
        deliveryEntry(6, "candidate.recaptured", { treeSha: OID, branchRefValue: OID }, "key-5-invocation.fenced"),
      ]),
    ).toContain("duplicate_idempotency_key");
  });

  it("rejects a non-monotonic fence and accepts the next fence", () => {
    const again = (fence: number): Entry =>
      deliveryEntry(6, "invocation.fenced", {
        fence,
        hostTaskId: "task-2",
        worktreeId: "worktree-1",
        candidateTreeSha: OID,
        candidateBranchRefValue: OID,
        policyDigest: DIGEST,
        authorityEpoch: 4,
        observationLifetimeSeconds: 900,
      });
    expect(reduceCodes([...openingEntries(), again(1)])).toContain("non_monotonic_fence");
    expect(reduceDeliveryJournal([...openingEntries(), again(2)]).ok).toBe(true);
  });

  it("rejects an activity observation for a fence that is not the current one", () => {
    expect(
      reduceCodes([...openingEntries(), deliveryEntry(6, "activity.observed", { activity: "paused", fence: 7 })]),
    ).toContain("fence_mismatch");
  });

  it("rejects an entry whose subject is another delivery", () => {
    const foreign = { ...deliveryEntry(6, "candidate.recaptured", { treeSha: OID, branchRefValue: OID }), subjectId: "delivery-2" };
    expect(reduceCodes([...openingEntries(), foreign])).toContain("subject_mismatch");
  });

  it("rejects a transition whose `from` is not the current state, and any pair outside the frozen matrix", () => {
    expect(
      reduceCodes([...openingEntries(), deliveryEntry(6, "transition.committed", { from: "planning", to: "implementing" })]),
    ).toContain("invalid_transition");
    expect(
      reduceCodes([...openingEntries(), deliveryEntry(6, "transition.committed", { from: "preparing", to: "reviewing" })]),
    ).toContain("invalid_transition");
  });

  it("keeps authority bindings immutable under agent results — a result can never grant authority", () => {
    const entries = [
      ...openingEntries(),
      deliveryEntry(6, "stage.result.recorded", { stageId: "implement", workflowGraphSha256: DIGEST2, resultDigest: DIGEST }),
      deliveryEntry(7, "operation.result.recorded", {
        capabilityId: "repo.check",
        result: { spec: "sensor-result/1", capabilityId: "repo.check", outcome: "passed", summary: "clean", candidateTreeSha: OID },
      }),
    ];
    const outcome = reduceDeliveryJournal(entries);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.policyDigest).toBe(DIGEST);
    expect(outcome.state.authorityEpoch).toBe(4);
    expect(outcome.state.generationDigest).toBe(DIGEST2);
  });

  it("resumes a blocked delivery only at its last trustworthy checkpoint", () => {
    const blockedEntries = [
      ...openingEntries(),
      deliveryEntry(6, "blocker.recorded", { code: "sensor-unavailable", summary: "required sensor missing" }),
      deliveryEntry(7, "transition.committed", { from: "preparing", to: "blocked" }),
    ];
    const resumed = reduceDeliveryJournal([
      ...blockedEntries,
      deliveryEntry(8, "transition.committed", { from: "blocked", to: "preparing" }),
    ]);
    expect(resumed.ok).toBe(true);
    expect(
      reduceCodes([...blockedEntries, deliveryEntry(8, "transition.committed", { from: "blocked", to: "reviewing" })]),
    ).toContain("invalid_transition");
  });

  it("accepts nothing after a terminal state", () => {
    const toCompleted = [
      ...openingEntries(),
      deliveryEntry(6, "transition.committed", { from: "preparing", to: "cancellation_requested" }),
      deliveryEntry(7, "workspace.disposition.recorded", { workspaceId: "workspace-1", disposition: "quarantined" }),
      deliveryEntry(8, "transition.committed", { from: "cancellation_requested", to: "cancelled" }),
    ];
    expect(reduceDeliveryJournal(toCompleted).ok).toBe(true);
    expect(
      reduceCodes([...toCompleted, deliveryEntry(9, "activity.observed", { activity: "unknown", fence: 1 })]),
    ).toContain("journal_terminal");
  });
});

// ── Intake journal reducer ─────────────────────────────────────────────────

const intakeEntry = (revision: number, kind: string, payload: Record<string, unknown>): Entry => ({
  spec: JOURNAL_ENTRY_SPEC,
  journal: "intake",
  subjectId: "intake-1",
  expectedRevision: revision,
  idempotencyKey: `ikey-${revision}`,
  kind,
  payload,
});

const contractConfirmationPayload = {
  confirmation: {
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
  },
};

describe("the intake journal reducer", () => {
  const chain = (): Entry[] => [
    intakeEntry(0, "intake.state.changed", { from: "draft_scope", to: "awaiting_clarification" }),
    intakeEntry(1, "intake.state.changed", { from: "awaiting_clarification", to: "awaiting_confirmation" }),
    intakeEntry(2, "operator.confirmation.recorded", contractConfirmationPayload),
    intakeEntry(3, "intake.state.changed", { from: "awaiting_confirmation", to: "validating_acceptance" }),
    intakeEntry(4, "intake.state.changed", { from: "validating_acceptance", to: "accepted_contract" }),
  ];

  it("reduces the confirmation chain to accepted_contract", () => {
    const outcome = reduceIntakeJournal(chain());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toMatchObject({ intakeId: "intake-1", state: "accepted_contract", expectedRevision: 5 });
  });

  it("accepts a contract confirmation only while the draft awaits confirmation", () => {
    const early = [
      intakeEntry(0, "intake.state.changed", { from: "draft_scope", to: "awaiting_clarification" }),
      intakeEntry(1, "operator.confirmation.recorded", contractConfirmationPayload),
    ];
    const outcome = reduceIntakeJournal(early);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((rejection) => rejection.code)).toContain("invalid_transition");
  });

  it("rejects an intake transition outside the frozen chain", () => {
    const outcome = reduceIntakeJournal([
      intakeEntry(0, "intake.state.changed", { from: "draft_scope", to: "accepted_contract" }),
    ]);
    expect(outcome.ok).toBe(false);
  });

  it("accepts nothing after a terminal intake state", () => {
    const outcome = reduceIntakeJournal([
      ...chain(),
      intakeEntry(5, "intake.state.changed", { from: "accepted_contract", to: "abandoned" }),
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((rejection) => rejection.code)).toContain("journal_terminal");
  });
});
