import { describe, expect, it } from "vitest";
import { composeManagedStatus, type ManagedStatusInput } from "./status.ts";

const baseInput = (overrides: Partial<ManagedStatusInput> = {}): ManagedStatusInput => ({
  deliveryId: "delivery-1",
  intake: { state: "accepted_contract", expectedRevision: 4 },
  delivery: { state: "implementing", expectedRevision: 9, fence: 1 },
  hostActivity: "active",
  completedObligations: [],
  productTrust: {
    label: "local-digest / operator-pinned",
    pinnedGenerationDigest: "a".repeat(64),
    revocationEpoch: 0,
    generation: "eligible",
  },
  assertionSource: {
    availability: "available",
    detail: "os-native",
    lanes: { sensitiveApprovals: "available", operatorConfirmations: "available", mergeReadyLane: "available" },
  },
  quarantinedWorkspaces: [],
  candidate: { treeSha: "b".repeat(40), branchRefValue: "refs/heads/delivery" },
  pendingDecision: undefined,
  registrationBinding: { recorded: undefined, current: undefined, mismatch: "none" },
  lastWorkspaceDisposition: undefined,
  terminationVerifiedAtCurrentFence: false,
  workspaceBound: true,
  nextCheckpoint: { kind: "workflow-stage", stageId: "implement", remediation: false, grantDigest: "c".repeat(64) },
  resume: "none",
  blockers: [],
  policyRequiredInterruptions: 1,
  operatorInterventions: 0,
  ...overrides,
});

describe("the typed status model", () => {
  it("carries every fact the operator-facing projection contracts", () => {
    const status = composeManagedStatus(baseInput());
    expect(status.deliveryId).toBe("delivery-1");
    expect(status.intake?.state).toBe("accepted_contract");
    expect(status.delivery.state).toBe("implementing");
    expect(status.hostActivity).toBe("active");
    expect(status.candidate?.treeSha).toBe("b".repeat(40));
    expect(status.productTrust.label).toBe("local-digest / operator-pinned");
    expect(status.assertionSource.availability).toBe("available");
    expect(status.quarantinedWorkspaces).toEqual([]);
    expect(status.completedObligations).toEqual([]);
    expect(status.nextCheckpoint.kind).toBe("workflow-stage");
  });

  it("reports the checkpoint's own operation as the first authorized next action", () => {
    const status = composeManagedStatus(baseInput());
    expect(status.authorizedNextActions[0]).toBe("submitStageResult");
  });

  it("names only operations the inventory declares", () => {
    const cases: ManagedStatusInput[] = [
      baseInput(),
      baseInput({ nextCheckpoint: { kind: "bind-workspace" }, workspaceBound: false }),
      baseInput({ nextCheckpoint: { kind: "repository-sensor", capabilityId: "sensor.check" } }),
      baseInput({ nextCheckpoint: { kind: "review", stageId: "review", lenses: ["a"] } }),
      baseInput({ nextCheckpoint: { kind: "admission" } }),
      baseInput({ nextCheckpoint: { kind: "tracked-record" } }),
      baseInput({ nextCheckpoint: { kind: "finish-line" } }),
      baseInput({ delivery: { state: "completed", expectedRevision: 20, fence: 1 }, nextCheckpoint: { kind: "complete" } }),
    ];
    for (const input of cases) {
      const status = composeManagedStatus(input);
      for (const action of status.authorizedNextActions) {
        expect(status.operationContracts.some((contract) => contract.operation === action)).toBe(true);
      }
    }
  });

  it("offers only read and retention operations once the delivery is terminal", () => {
    const status = composeManagedStatus(
      baseInput({ delivery: { state: "completed", expectedRevision: 20, fence: 1 }, nextCheckpoint: { kind: "complete" } }),
    );
    expect(status.authorizedNextActions).toContain("exportDelivery");
    expect(status.authorizedNextActions).toContain("deleteDelivery");
    expect(status.authorizedNextActions).not.toContain("submitStageResult");
  });
});

describe("the security-blocked migration path", () => {
  const blocked = (mismatch: "none" | "identity" | "profile"): ManagedStatusInput =>
    baseInput({
      delivery: { state: "security_blocked", expectedRevision: 12, fence: 1 },
      nextCheckpoint: { kind: "blocked", code: "trust.installation-mismatch", summary: "bound elsewhere" },
      blockers: [{ code: "trust.installation-mismatch", summary: "bound elsewhere" }],
      registrationBinding: {
        recorded: { registeringInstallationId: "install-a", activeCompositionProfile: "production" },
        current: {
          registeringInstallationId: mismatch === "none" ? "install-a" : "install-b",
          activeCompositionProfile: mismatch === "profile" ? "confirmation-fixture" : "production",
        },
        mismatch,
      },
    });

  it("reports the rebinding migration for an identity-mismatched, profile-matched delivery", () => {
    const status = composeManagedStatus(blocked("identity"));
    expect(status.authorizedNextActions).toContain("recoverSecurityBlocked");
    expect(status.migrationPath).toBe("rebinding-migration");
  });

  it("reports a typed blocker and NO migration path for a profile-mismatched delivery", () => {
    const status = composeManagedStatus(blocked("profile"));
    expect(status.authorizedNextActions).not.toContain("recoverSecurityBlocked");
    expect(status.migrationPath).toBe("none");
    expect(status.blockers.map((blocker) => blocker.code)).toContain("trust.installation-mismatch");
  });

  it("offers re-preparation when neither identity nor profile moved", () => {
    const status = composeManagedStatus(blocked("none"));
    expect(status.authorizedNextActions).toContain("recoverSecurityBlocked");
    expect(status.migrationPath).toBe("re-preparation");
  });

  it("offers no migration while the installation cannot be resolved at all", () => {
    const status = composeManagedStatus(
      baseInput({
        delivery: { state: "security_blocked", expectedRevision: 12, fence: 1 },
        nextCheckpoint: { kind: "blocked", code: "trust.unresolved", summary: "no receipt" },
        registrationBinding: { recorded: undefined, current: undefined, mismatch: "unresolved" },
      }),
    );
    expect(status.migrationPath).toBe("none");
    expect(status.authorizedNextActions).not.toContain("recoverSecurityBlocked");
  });
});

describe("mutation verification and retry safety", () => {
  it("is not applicable before a workspace is bound", () => {
    const status = composeManagedStatus(baseInput({ workspaceBound: false, hostActivity: "unknown" }));
    expect(status.mutationVerification).toBe("not-applicable");
    expect(status.retrySafety).toBe("safe");
  });

  it("is unverified while a quarantined workspace stands", () => {
    const status = composeManagedStatus(
      baseInput({ hostActivity: "unknown", lastWorkspaceDisposition: "quarantined", quarantinedWorkspaces: ["ws-1"] }),
    );
    expect(status.mutationVerification).toBe("unverified");
    expect(status.retrySafety).toBe("unverified-prior-mutation");
  });

  it("is unverified while cancellation is pending", () => {
    const status = composeManagedStatus(baseInput({ hostActivity: "cancellation_pending" }));
    expect(status.mutationVerification).toBe("unverified");
  });

  it("is verified once the trusted lifecycle event verified descendant teardown", () => {
    const status = composeManagedStatus(baseInput({ hostActivity: "paused", terminationVerifiedAtCurrentFence: true }));
    expect(status.mutationVerification).toBe("verified");
    expect(status.retrySafety).toBe("safe");
  });

  it("never invites a repeat of an external action whose verification failed", () => {
    const status = composeManagedStatus(
      baseInput({
        delivery: { state: "action_succeeded_verification_failed", expectedRevision: 30, fence: 1 },
        nextCheckpoint: { kind: "blocked", code: "action.verification-failed", summary: "unverified" },
      }),
    );
    expect(status.retrySafety).toBe("never-repeat-external-action");
    expect(status.authorizedNextActions).not.toContain("completeFinishLine");
  });
});

describe("pending decisions and interruption", () => {
  it("offers the sensitive approval while a proposal is pending", () => {
    const status = composeManagedStatus(
      baseInput({
        delivery: { state: "reviewing", expectedRevision: 14, fence: 1 },
        nextCheckpoint: { kind: "review", stageId: "review", lenses: ["a"] },
        pendingDecision: { requestKind: "waiver", criterionId: "c1", actorId: "actor-a", candidateTreeSha: "b".repeat(40) },
      }),
    );
    expect(status.pendingDecision?.criterionId).toBe("c1");
    expect(status.authorizedNextActions).toContain("consumeWaiver");
  });

  it("withholds the sensitive approval when no assertion source is available", () => {
    const status = composeManagedStatus(
      baseInput({
        delivery: { state: "reviewing", expectedRevision: 14, fence: 1 },
        nextCheckpoint: { kind: "review", stageId: "review", lenses: ["a"] },
        pendingDecision: { requestKind: "waiver", criterionId: "c1", actorId: "actor-a", candidateTreeSha: "b".repeat(40) },
        assertionSource: {
          availability: "unavailable",
          detail: "no interactive context",
          lanes: {
            sensitiveApprovals: "fail_closed_no_assertion_source",
            operatorConfirmations: "available",
            mergeReadyLane: "available",
          },
        },
      }),
    );
    expect(status.authorizedNextActions).not.toContain("consumeWaiver");
  });

  it("offers the takeover presentation when resuming needs one", () => {
    const status = composeManagedStatus(baseInput({ hostActivity: "unknown", resume: "takeover-required" }));
    expect(status.authorizedNextActions).toContain("presentTakeover");
  });

  it("offers cancellation finalization once cancellation was requested", () => {
    const status = composeManagedStatus(
      baseInput({
        delivery: { state: "cancellation_requested", expectedRevision: 18, fence: 1 },
        hostActivity: "cancellation_pending",
        nextCheckpoint: { kind: "blocked", code: "cancellation.requested", summary: "cancelling" },
      }),
    );
    expect(status.authorizedNextActions).toContain("finalizeCancellation");
  });
});
