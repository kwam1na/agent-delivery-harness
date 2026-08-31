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
  reduceMaintenanceJournal,
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

// ── Approval requests and the remediating watch-item ───────────────────────

const transitions = (start: number, ...pairs: readonly (readonly [string, string])[]): Entry[] =>
  pairs.map(([from, to], index) => deliveryEntry(start + index, "transition.committed", { from, to }));

/** openingEntries() left the delivery in `preparing` at revision 6. */
const toState = (target: "implementing" | "validating" | "remediating" | "reviewing" | "admitting"): Entry[] => {
  const chain: (readonly [string, string])[] = [
    ["preparing", "planning"],
    ["planning", "implementing"],
  ];
  if (target !== "implementing") chain.push(["implementing", "validating"]);
  if (target === "remediating") chain.push(["validating", "remediating"]);
  if (target === "reviewing" || target === "admitting") chain.push(["validating", "reviewing"]);
  if (target === "admitting") chain.push(["reviewing", "compounding"], ["compounding", "admitting"]);
  return [...openingEntries(), ...transitions(6, ...chain)];
};

const waiverRequest = (revision: number): Entry =>
  deliveryEntry(revision, "approval.request.recorded", {
    requestKind: "waiver",
    criterionId: "greeting-behavior",
    actorId: "operator-1",
    reason: "criterion discharged by upstream fix; waiver proposed",
  });

describe("approval request discipline", () => {
  it("accepts a waiver or amendment proposal only within reviewing, remediating, or admitting", () => {
    for (const state of ["reviewing", "remediating", "admitting"] as const) {
      const entries = toState(state);
      const outcome = reduceDeliveryJournal([...entries, waiverRequest(entries.length)]);
      expect(outcome.ok, `${state} accepts a pending proposal`).toBe(true);
    }
    for (const state of ["implementing", "validating"] as const) {
      const entries = toState(state);
      expect(reduceCodes([...entries, waiverRequest(entries.length)]), `${state} rejects a proposal`).toContain(
        "invalid_transition",
      );
    }
    // Before any candidate exists there is nothing to waive against.
    expect(reduceCodes([...openingEntries(), waiverRequest(6)])).toContain("invalid_transition");
  });

  it("keeps the delivery in its current state while a proposal is pending — no dedicated wait state", () => {
    const entries = toState("reviewing");
    const outcome = reduceDeliveryJournal([...entries, waiverRequest(entries.length)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.state).toBe("reviewing");
  });
});

const amendment = (revision: number, previousContractId: string, contractId: string): Entry =>
  deliveryEntry(revision, "contract.amended", {
    previousContractId,
    contractId,
    contractDigest: DIGEST,
    criterionId: "greeting-behavior",
    assertionNonce: `nonce-${contractId}`,
  });

describe("confirmed outcome amendments", () => {
  it("records a new contract identity and carries it forward as the delivery's contract", () => {
    const entries = toState("reviewing");
    const outcome = reduceDeliveryJournal([...entries, amendment(entries.length, "contract-1", "contract-2")]);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.contractId).toBe("contract-2");
    // The amendment itself never moves the delivery; the forced re-evaluation
    // is a separate, ordinary transition.
    expect(outcome.state.state).toBe("reviewing");
  });

  it("chains: a second amendment must supersede the first, never the original", () => {
    const entries = toState("reviewing");
    const chained = [
      ...entries,
      amendment(entries.length, "contract-1", "contract-2"),
      amendment(entries.length + 1, "contract-2", "contract-3"),
    ];
    const outcome = reduceDeliveryJournal(chained);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (outcome.ok) expect(outcome.state.contractId).toBe("contract-3");

    expect(
      reduceCodes([
        ...entries,
        amendment(entries.length, "contract-1", "contract-2"),
        amendment(entries.length + 1, "contract-1", "contract-3"),
      ]),
    ).toContain("subject_mismatch");
  });

  it("is journaled only where a waiver is consumable — reviewing, remediating, admitting", () => {
    for (const state of ["reviewing", "remediating", "admitting"] as const) {
      const entries = toState(state);
      expect(reduceDeliveryJournal([...entries, amendment(entries.length, "contract-1", "contract-2")]).ok, state).toBe(true);
    }
    for (const state of ["implementing", "validating"] as const) {
      const entries = toState(state);
      expect(reduceCodes([...entries, amendment(entries.length, "contract-1", "contract-2")]), state).toContain(
        "invalid_transition",
      );
    }
  });
});

describe("the remediating zero-mutation watch-item", () => {
  // The state table's only exit from `remediating` is a checkpointed candidate
  // mutation. A finding discharged with zero mutation (a pending waiver) has
  // no direct edge back to validation: these tests prove the typed escape —
  // a bounded blocker.recorded — does not strand the delivery.
  it("records a blocker in remediating without leaving remediating — blocker.recorded alone never suspends", () => {
    const entries = toState("remediating");
    const outcome = reduceDeliveryJournal([
      ...entries,
      waiverRequest(entries.length),
      deliveryEntry(entries.length + 1, "blocker.recorded", {
        code: "approval.pending-decision",
        summary: "zero-mutation discharge awaits its approval lane; the mutation exit stays open",
      }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.state).toBe("remediating");
  });

  it("keeps the mutation exit open after the typed escape — remediating -> validating still stands", () => {
    const entries = toState("remediating");
    const outcome = reduceDeliveryJournal([
      ...entries,
      deliveryEntry(entries.length, "blocker.recorded", { code: "approval.pending-decision", summary: "typed escape" }),
      deliveryEntry(entries.length + 1, "candidate.recaptured", { treeSha: OID, branchRefValue: OID }),
      deliveryEntry(entries.length + 2, "transition.committed", { from: "remediating", to: "validating" }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.state).toBe("validating");
  });

  it("resumes a delivery blocked out of remediating back to remediating — parked, never stranded", () => {
    const entries = toState("remediating");
    const outcome = reduceDeliveryJournal([
      ...entries,
      deliveryEntry(entries.length, "blocker.recorded", { code: "operator.rescope-required", summary: "no candidate mutation discharges the finding" }),
      deliveryEntry(entries.length + 1, "transition.committed", { from: "remediating", to: "blocked" }),
      deliveryEntry(entries.length + 2, "transition.committed", { from: "blocked", to: "remediating" }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.state).toBe("remediating");
  });
});

// ── Maintenance journal reducer ────────────────────────────────────────────

const maintenanceEntry = (revision: number, payload: Record<string, unknown>, key = `mkey-${revision}`): Entry => ({
  spec: JOURNAL_ENTRY_SPEC,
  journal: "maintenance",
  subjectId: "install-1",
  expectedRevision: revision,
  idempotencyKey: key,
  kind: "retention.action.recorded",
  payload,
});

const retentionPayload = (action: "export" | "delete"): Record<string, unknown> => ({
  action,
  subjectDeliveryId: "dlv-1",
  artifactDigest: DIGEST,
  preservedAuditRecords: action === "delete" ? ["audit/dlv-1.json"] : [],
});

describe("the maintenance journal reducer", () => {
  it("reduces retention actions with revision and idempotency discipline — entries survive their target's removal", () => {
    const outcome = reduceMaintenanceJournal([
      maintenanceEntry(0, retentionPayload("export")),
      maintenanceEntry(1, retentionPayload("delete")),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toMatchObject({ subjectId: "install-1", expectedRevision: 2 });
  });

  it("rejects a revision mismatch, a duplicate idempotency key, and a foreign subject", () => {
    const opening = [maintenanceEntry(0, retentionPayload("export"))];
    const codes = (entries: readonly Entry[]): string[] => {
      const outcome = reduceMaintenanceJournal(entries);
      return outcome.ok ? [] : outcome.rejections.map((rejection) => rejection.code);
    };
    expect(codes([...opening, maintenanceEntry(2, retentionPayload("delete"))])).toContain("revision_mismatch");
    expect(codes([...opening, maintenanceEntry(1, retentionPayload("delete"), "mkey-0")])).toContain(
      "duplicate_idempotency_key",
    );
    expect(codes([...opening, { ...maintenanceEntry(1, retentionPayload("delete")), subjectId: "install-2" }])).toContain(
      "subject_mismatch",
    );
  });

  it("rejects a foreign-journal kind and a foreign-journal entry", () => {
    const codes = (entries: readonly Entry[]): string[] => {
      const outcome = reduceMaintenanceJournal(entries);
      return outcome.ok ? [] : outcome.rejections.map((rejection) => rejection.code);
    };
    expect(codes([{ ...maintenanceEntry(0, retentionPayload("export")), kind: "blocker.recorded" }])).toContain(
      "unknown_kind",
    );
    expect(codes([deliveryEntry(0, "candidate.recaptured", { treeSha: OID, branchRefValue: OID })])).toContain(
      "unsupported_combination",
    );
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

describe("the iterative-intake records", () => {
  const DRAFT_A = "a".repeat(64);
  const DRAFT_B = "b".repeat(64);
  const clarification = { question: "Which greeting text is contracted?", answer: "hello, skeleton" };

  it("retains clarification history while awaiting clarification, and counts it", () => {
    const outcome = reduceIntakeJournal([
      intakeEntry(0, "intake.state.changed", { from: "draft_scope", to: "awaiting_clarification" }),
      intakeEntry(1, "intake.clarification.recorded", clarification),
      intakeEntry(2, "intake.clarification.recorded", { question: "Which module?", answer: "src/greet.mjs" }),
      intakeEntry(3, "intake.draft.recorded", { draftDigest: DRAFT_A }),
      intakeEntry(4, "intake.state.changed", { from: "awaiting_clarification", to: "awaiting_confirmation" }),
    ]);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toMatchObject({
      state: "awaiting_confirmation",
      clarificationCount: 2,
      lastDraftDigest: DRAFT_A,
    });
  });

  it("rejects a clarification outside awaiting_clarification", () => {
    const outcome = reduceIntakeJournal([intakeEntry(0, "intake.clarification.recorded", clarification)]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((rejection) => rejection.code)).toContain("invalid_transition");
  });

  it("accepts a draft record in draft_scope, awaiting_clarification, and awaiting_confirmation — nowhere later", () => {
    const inDraftScope = reduceIntakeJournal([intakeEntry(0, "intake.draft.recorded", { draftDigest: DRAFT_A })]);
    expect(inDraftScope.ok, JSON.stringify(inDraftScope)).toBe(true);

    const afterConsumption = reduceIntakeJournal([
      intakeEntry(0, "intake.state.changed", { from: "draft_scope", to: "awaiting_clarification" }),
      intakeEntry(1, "intake.draft.recorded", { draftDigest: DRAFT_A }),
      intakeEntry(2, "intake.state.changed", { from: "awaiting_clarification", to: "awaiting_confirmation" }),
      intakeEntry(3, "operator.confirmation.recorded", {
        confirmation: { ...contractConfirmationPayload.confirmation, normalizedContractDigest: DRAFT_A },
      }),
      intakeEntry(4, "intake.state.changed", { from: "awaiting_confirmation", to: "validating_acceptance" }),
      intakeEntry(5, "intake.draft.recorded", { draftDigest: DRAFT_B }),
    ]);
    expect(afterConsumption.ok).toBe(false);
    if (afterConsumption.ok) return;
    expect(afterConsumption.rejections.map((rejection) => rejection.code)).toContain("invalid_transition");
  });

  it("rejects consuming a confirmation whose digest is not the retained draft — a mutated draft voids it", () => {
    const outcome = reduceIntakeJournal([
      intakeEntry(0, "intake.state.changed", { from: "draft_scope", to: "awaiting_clarification" }),
      intakeEntry(1, "intake.draft.recorded", { draftDigest: DRAFT_A }),
      intakeEntry(2, "intake.state.changed", { from: "awaiting_clarification", to: "awaiting_confirmation" }),
      // The draft mutates AFTER presentation; the pending confirmation still
      // binds the digest presented to the operator.
      intakeEntry(3, "intake.draft.recorded", { draftDigest: DRAFT_B }),
      intakeEntry(4, "operator.confirmation.recorded", {
        confirmation: { ...contractConfirmationPayload.confirmation, normalizedContractDigest: DRAFT_A },
      }),
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((rejection) => rejection.code)).toContain("digest_mismatch");
  });

  it("consumes a confirmation over the retained draft's exact digest", () => {
    const outcome = reduceIntakeJournal([
      intakeEntry(0, "intake.state.changed", { from: "draft_scope", to: "awaiting_clarification" }),
      intakeEntry(1, "intake.draft.recorded", { draftDigest: DRAFT_A }),
      intakeEntry(2, "intake.state.changed", { from: "awaiting_clarification", to: "awaiting_confirmation" }),
      intakeEntry(3, "operator.confirmation.recorded", {
        confirmation: { ...contractConfirmationPayload.confirmation, normalizedContractDigest: DRAFT_A },
      }),
      intakeEntry(4, "intake.state.changed", { from: "awaiting_confirmation", to: "validating_acceptance" }),
    ]);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.contractConfirmed).toBe(true);
  });
});
