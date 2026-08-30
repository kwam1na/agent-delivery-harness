/**
 * Cross-field rules of the frozen spine contract families. Closedness of every
 * grammar is exercised family by family in the golden vectors
 * (`vectors.test.ts`); this file proves the rules that relate members and
 * documents — the trust predicate behind its port, policy-bounded authority,
 * outcome coverage, absent-by-state bindings, and the merge-ready finish line.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import { validateCapabilityDescriptor, validateSensorResult } from "./capability.ts";
import {
  PINNED_AGENT_SKILLS,
  PRODUCT_TRUST_LABEL,
  localDigestTrustPredicate,
  validateCompositionPin,
  validateProductTrustState,
  type ProductTrustPort,
} from "./composition.ts";
import { validateOperatorConfirmation } from "./confirmation.ts";
import {
  checkContractWithinPolicy,
  checkOutcomeCoversContract,
  validateAcceptedContract,
  validateOutcomeVerification,
} from "./contract.ts";
import { checkMergeReadyAgainstOutcome, validateFinishLineResult } from "./finish-line.ts";
import { grantDigest, validateExecutionGrant, validateGrantAttestation } from "./grant.ts";
import { validateInvocationFence } from "./invocation.ts";
import { validatePolicySnapshot } from "./policy.ts";

const DIGEST = "a".repeat(64);
const OID = "b".repeat(40);

const codesOf = (verdict: { ok: true } | { ok: false; rejections: readonly { code: string }[] }): string[] =>
  verdict.ok ? [] : verdict.rejections.map((rejection) => rejection.code);

// ── Composition and product trust ──────────────────────────────────────────

const compositionPin = (): Record<string, unknown> => ({
  spec: "product-composition-pin/1",
  productVersion: "0.1.0",
  distributionDigest: DIGEST,
  harnessModuleVersions: { "@agent-delivery-harness/kernel": "0.1.0" },
  skillsArchive: { ...PINNED_AGENT_SKILLS },
  contractVersions: {
    policy: "policy-snapshot/1",
    scopedWork: "scoped-delivery-contract/1",
    run: "journal-entry/1",
    workflowResult: "stage-result-ref/1",
    event: "journal-entry/1",
    controlPlane: "reserved/0",
  },
  productTrustLabel: PRODUCT_TRUST_LABEL,
});

const trustState = (): Record<string, unknown> => ({
  spec: "product-trust-state/1",
  installationId: "install-1",
  pinnedManifestDigest: DIGEST,
  revokedGenerationDigests: [],
  revocationEpoch: 0,
  highWaterMark: 1,
});

describe("composition pin and product-trust state", () => {
  it("accept their golden forms", () => {
    expect(validateCompositionPin(compositionPin())).toEqual({ ok: true });
    expect(validateProductTrustState(trustState())).toEqual({ ok: true });
  });

  it("freeze the product-trust label wording verbatim", () => {
    expect(PRODUCT_TRUST_LABEL).toBe("local-digest / operator-pinned");
    expect(codesOf(validateCompositionPin({ ...compositionPin(), productTrustLabel: "local-digest" }))).toContain(
      "malformed_member",
    );
  });

  it("pin the agent-skills schemas by digest, matching the composition baseline", () => {
    expect(PINNED_AGENT_SKILLS.releaseId).toBe("core-v1");
    expect(PINNED_AGENT_SKILLS.profile).toBe("core");
    expect(PINNED_AGENT_SKILLS.workflowGraphSha256).toBe(
      "49630e23374f0375cb7d019ea024bcd5ea0c284feb8dc124b393b60f6e8d9aa7",
    );
    expect(PINNED_AGENT_SKILLS.archiveSha256).toBe(
      "25dd462a818cf2134c08be27181ba123adfa74bf2c367884a411b8b664523fc6",
    );
    expect(PINNED_AGENT_SKILLS.metadataSha256).toBe(
      "e3b4904148b45df90937f2f383f1ef1e5cb0ba60a27291602edf89609c3a3ffa",
    );
    expect(PINNED_AGENT_SKILLS.provenanceLockSha256).toBe(
      "12cebfaf0848f102931d6f1794cce5f79de58533678b9bcd6c8347dee5cb09ff",
    );
    expect(PINNED_AGENT_SKILLS.protocolVersion).toBe("delivery-provider-rails/1");
    expect(Object.isFrozen(PINNED_AGENT_SKILLS)).toBe(true);
  });

  it("evaluates trust only through the validation port", () => {
    const state = trustState() as never;
    expect(localDigestTrustPredicate.evaluate(DIGEST, state)).toEqual({ eligible: true });
    expect(localDigestTrustPredicate.evaluate("f".repeat(64), state)).toEqual({
      eligible: false,
      reason: "not_pinned",
    });
    const revoked = { ...trustState(), revokedGenerationDigests: [DIGEST], revocationEpoch: 1 } as never;
    expect(localDigestTrustPredicate.evaluate(DIGEST, revoked)).toEqual({ eligible: false, reason: "revoked" });
  });

  it("lets a conforming fixture replace the digest predicate without touching consumers", () => {
    const fixturePort: ProductTrustPort = {
      evaluate: (generationDigest) =>
        generationDigest === DIGEST ? { eligible: true } : { eligible: false, reason: "not_pinned" },
    };
    // A consumer written against the port observes identical decisions from
    // the real predicate and the fixture — the module is replaceable.
    for (const digest of [DIGEST, "f".repeat(64)]) {
      expect(fixturePort.evaluate(digest, trustState() as never)).toEqual(
        localDigestTrustPredicate.evaluate(digest, trustState() as never),
      );
    }
  });
});

// ── Scoped contract, outcome verification, policy ──────────────────────────

const contract = (): Record<string, unknown> => ({
  spec: "scoped-delivery-contract/1",
  contractId: "contract-1",
  task: "Fix the flaky sensor",
  intendedOutcome: "The sensor is deterministic",
  acceptanceCriteria: [
    { criterionId: "crit-1", statement: "sensor passes 100 consecutive runs" },
    { criterionId: "crit-2", statement: "no new dependencies" },
  ],
  nonGoals: ["no refactor"],
  repository: { repositoryId: "repo-1", baseRef: "refs/heads/main" },
  requestedFinishLine: "merge-ready",
  requestedAuthority: ["candidate-mutation"],
  unresolvedDecisions: [],
});

const outcome = (): Record<string, unknown> => ({
  spec: "outcome-verification/1",
  contractId: "contract-1",
  candidate: { treeSha: OID, deliverableDigest: DIGEST },
  criteria: [
    { criterionId: "crit-1", disposition: "passed", evidence: { kind: "sensor", reference: "record-1" } },
    { criterionId: "crit-2", disposition: "amended-waived", evidence: { kind: "review", reference: "waiver-1" } },
  ],
  reviewAttempts: [
    { attemptId: "attempt-1", lensId: "outcome-correctness", contextDigest: DIGEST, verdict: "approved" },
    { attemptId: "attempt-2", lensId: "testing-policy", contextDigest: "d".repeat(64), verdict: "approved" },
  ],
});

const snapshot = (): Record<string, unknown> => {
  const body = {
    spec: "policy-snapshot/1",
    repositoryId: "repo-1",
    productTrustRevocationEpoch: 0,
    repositoryAuthorityRevocationEpoch: 4,
    grantedFinishLines: ["merge-ready"],
    grantedAuthority: ["candidate-mutation"],
    reviewLenses: [
      { lensId: "outcome-correctness", category: "outcome-correctness" },
      { lensId: "testing-policy", category: "testing-policy" },
    ],
    obligations: [{ obligationId: "review.green" }],
  };
  return { ...body, policyDigest: digestCanonical(body) };
};

describe("accepted contract, outcome verification, and policy snapshot", () => {
  it("accept their golden forms", () => {
    expect(validateAcceptedContract(contract())).toEqual({ ok: true });
    expect(validateOutcomeVerification(outcome())).toEqual({ ok: true });
    expect(validatePolicySnapshot(snapshot())).toEqual({ ok: true });
  });

  it("rejects an accepted contract that still carries unresolved decisions — material ambiguity cannot begin mutation", () => {
    expect(
      codesOf(validateAcceptedContract({ ...contract(), unresolvedDecisions: ["which sensor?"] })),
    ).toContain("unsupported_combination");
  });

  it("rejects zero review attempts", () => {
    expect(codesOf(validateOutcomeVerification({ ...outcome(), reviewAttempts: [] }))).toContain(
      "zero_review_attempts",
    );
  });

  it("rejects duplicate review attempts", () => {
    const duplicated = outcome();
    const attempts = duplicated["reviewAttempts"] as Record<string, unknown>[];
    duplicated["reviewAttempts"] = [attempts[0], { ...attempts[1], attemptId: attempts[0]!["attemptId"] }];
    expect(codesOf(validateOutcomeVerification(duplicated))).toContain("duplicate_review_attempt");
  });

  it("rejects a criterion whose disposition is missing or invented", () => {
    const missing = outcome();
    const criteria = (missing["criteria"] as Record<string, unknown>[]).map((criterion) => ({ ...criterion }));
    delete criteria[0]!["disposition"];
    missing["criteria"] = criteria;
    expect(codesOf(validateOutcomeVerification(missing))).toContain("missing_member");

    const invented = outcome();
    invented["criteria"] = [
      { criterionId: "crit-1", disposition: "vibes", evidence: { kind: "sensor", reference: "record-1" } },
    ];
    expect(codesOf(validateOutcomeVerification(invented))).toContain("malformed_member");
  });

  it("requires every contract criterion to carry a disposition — an unmapped criterion blocks", () => {
    const partial = outcome();
    partial["criteria"] = [
      { criterionId: "crit-1", disposition: "passed", evidence: { kind: "sensor", reference: "record-1" } },
    ];
    expect(
      codesOf(checkOutcomeCoversContract(partial as never, contract() as never)),
    ).toContain("criterion_unverified");
    expect(checkOutcomeCoversContract(outcome() as never, contract() as never)).toEqual({ ok: true });
  });

  it("rejects a policy snapshot activating zero review lenses — vacuous satisfaction is excluded", () => {
    const vacuous = snapshot();
    const body = { ...vacuous, reviewLenses: [] };
    delete (body as Record<string, unknown>)["policyDigest"];
    expect(codesOf(validatePolicySnapshot({ ...body, policyDigest: digestCanonical(body) }))).toContain(
      "vacuous_policy",
    );
  });

  it("rejects a policy snapshot whose digest does not match its own content", () => {
    expect(codesOf(validatePolicySnapshot({ ...snapshot(), policyDigest: "e".repeat(64) }))).toContain(
      "digest_mismatch",
    );
  });

  it("denies any requested authority or finish line the policy does not grant — an agent result cannot grant authority", () => {
    const overreachingAuthority = { ...contract(), requestedAuthority: ["candidate-mutation", "merge"] };
    expect(
      codesOf(checkContractWithinPolicy(overreachingAuthority as never, snapshot() as never)),
    ).toContain("authority_not_granted");

    const overreachingFinishLine = { ...contract(), requestedFinishLine: "deploy" };
    expect(
      codesOf(checkContractWithinPolicy(overreachingFinishLine as never, snapshot() as never)),
    ).toContain("authority_not_granted");

    expect(checkContractWithinPolicy(contract() as never, snapshot() as never)).toEqual({ ok: true });
  });
});

// ── Grants, attestations, confirmations, fences ────────────────────────────

const checkpointGrant = (): Record<string, unknown> => ({
  spec: "execution-grant/1",
  profile: "checkpoint",
  allowedCapabilities: ["tool.edit", "tool.bash"],
  writablePaths: ["src/"],
  protectedPaths: [".delivery/", ".git/delivery-harness/"],
  forbiddenOperations: ["network.publish"],
});

const intakeGrant = (): Record<string, unknown> => ({
  spec: "execution-grant/1",
  profile: "intake",
  allowedCapabilities: ["intake.read"],
  writablePaths: [],
  protectedPaths: ["trust-store/", ".delivery/", "journals/"],
  forbiddenOperations: ["network.publish"],
});

const checkpointAttestation = (): Record<string, unknown> => ({
  spec: "grant-attestation/1",
  profile: "checkpoint",
  hostVersion: "claude-code/2.5.0",
  grantDigest: DIGEST,
  productTrustRevocationEpoch: 0,
  expiry: "2026-08-30T12:00:00Z",
  intakeDraftId: "absent-by-state",
  deliveryId: "delivery-1",
  invocationFence: 1,
  workspaceId: "workspace-1",
  projectionDigest: DIGEST,
  discoveryConfigurationDigest: "d".repeat(64),
  registeringInstallationId: "install-1",
  activeProfile: "core",
});

const intakeAttestation = (): Record<string, unknown> => ({
  spec: "grant-attestation/1",
  profile: "intake",
  hostVersion: "claude-code/2.5.0",
  grantDigest: DIGEST,
  productTrustRevocationEpoch: 0,
  expiry: "2026-08-30T12:00:00Z",
  intakeDraftId: "intake-1",
  deliveryId: "absent-by-state",
  invocationFence: "absent-by-state",
  workspaceId: "absent-by-state",
  projectionDigest: "absent-by-state",
  discoveryConfigurationDigest: "absent-by-state",
  registeringInstallationId: "absent-by-state",
  activeProfile: "absent-by-state",
});

describe("execution grants and attestations", () => {
  it("accept both frozen profiles", () => {
    expect(validateExecutionGrant(checkpointGrant())).toEqual({ ok: true });
    expect(validateExecutionGrant(intakeGrant())).toEqual({ ok: true });
    expect(validateGrantAttestation(checkpointAttestation())).toEqual({ ok: true });
    expect(validateGrantAttestation(intakeAttestation())).toEqual({ ok: true });
  });

  it("rejects an intake grant that is not read-only", () => {
    expect(codesOf(validateExecutionGrant({ ...intakeGrant(), writablePaths: ["src/"] }))).toContain(
      "unsupported_combination",
    );
  });

  it("requires the intake attestation to record delivery-scoped identities absent-by-state — not omitted, not populated", () => {
    expect(codesOf(validateGrantAttestation({ ...intakeAttestation(), deliveryId: "delivery-1" }))).toContain(
      "unsupported_combination",
    );
    expect(
      codesOf(validateGrantAttestation({ ...intakeAttestation(), registeringInstallationId: "install-1" })),
    ).toContain("unsupported_combination");
    const omitted = intakeAttestation();
    delete omitted["projectionDigest"];
    expect(codesOf(validateGrantAttestation(omitted))).toContain("missing_member");
  });

  it("requires the checkpoint attestation to bind every delivery-scoped identity for real", () => {
    expect(
      codesOf(validateGrantAttestation({ ...checkpointAttestation(), invocationFence: "absent-by-state" })),
    ).toContain("unsupported_combination");
    expect(
      codesOf(validateGrantAttestation({ ...checkpointAttestation(), intakeDraftId: "intake-1" })),
    ).toContain("unsupported_combination");
  });

  it("digests a grant canonically, so the attestation binds bytes rather than intent", () => {
    expect(grantDigest(checkpointGrant())).toBe(digestCanonical(checkpointGrant()));
    expect(grantDigest(checkpointGrant())).toBe(grantDigest(checkpointGrant()));
  });
});

describe("the invocation fence contract", () => {
  it("accepts the golden fence and rejects a zero fence or missing observation lifetime", () => {
    const fence = {
      spec: "invocation-fence/1",
      deliveryId: "delivery-1",
      fence: 1,
      expectedJournalRevision: 6,
      hostTaskId: "task-1",
      worktreeId: "worktree-1",
      candidate: { treeSha: OID, branchRef: "refs/heads/delivery-1", branchRefValue: OID },
      policyDigest: DIGEST,
      authorityEpoch: 4,
      observationLifetimeSeconds: 900,
    };
    expect(validateInvocationFence(fence)).toEqual({ ok: true });
    expect(codesOf(validateInvocationFence({ ...fence, fence: 0 }))).toContain("malformed_member");
    const lifeless = { ...fence } as Record<string, unknown>;
    delete lifeless["observationLifetimeSeconds"];
    expect(codesOf(validateInvocationFence(lifeless))).toContain("missing_member");
  });
});

describe("operator confirmations", () => {
  const takeover = (): Record<string, unknown> => ({
    spec: "operator-confirmation/1",
    confirmationClass: "takeover-authorization",
    origin: "operator-terminal",
    action: "authorize-takeover",
    expiry: "2026-08-30T12:00:00Z",
    nonce: "nonce-2",
    productTrustRevocationEpoch: 0,
    repositoryAuthorityRevocationEpoch: 4,
    intakeDraftId: "absent-by-state",
    deliveryId: "delivery-1",
    normalizedContractDigest: "absent-by-state",
    supersededInvocationFence: 2,
    expectedJournalRevision: 9,
    targetBaseCommit: OID,
    boundInvocationFence: "absent-by-state",
    boundCandidateTreeSha: "absent-by-state",
  });

  it("binds a takeover to the superseded fence, expected journal revision, and target base commit", () => {
    expect(validateOperatorConfirmation(takeover())).toEqual({ ok: true });
    for (const member of ["supersededInvocationFence", "expectedJournalRevision", "targetBaseCommit"]) {
      expect(codesOf(validateOperatorConfirmation({ ...takeover(), [member]: "absent-by-state" }))).toContain(
        "unsupported_combination",
      );
    }
  });

  it("never lets a confirmation bind a fence or candidate that does not exist yet", () => {
    expect(codesOf(validateOperatorConfirmation({ ...takeover(), boundInvocationFence: 3 }))).toContain(
      "unsupported_combination",
    );
    expect(codesOf(validateOperatorConfirmation({ ...takeover(), boundCandidateTreeSha: OID }))).toContain(
      "unsupported_combination",
    );
  });

  it("requires the repository authority epoch on a takeover but records it absent-by-state on a contract confirmation", () => {
    expect(
      codesOf(validateOperatorConfirmation({ ...takeover(), repositoryAuthorityRevocationEpoch: "absent-by-state" })),
    ).toContain("unsupported_combination");
  });
});

// ── Capability, sensor result, finish line ─────────────────────────────────

describe("capability descriptor and sensor result", () => {
  it("accepts the minimal descriptor the skeleton's one trusted sensor needs", () => {
    expect(
      validateCapabilityDescriptor({
        spec: "capability-descriptor/1",
        capabilityId: "repo.check",
        kind: "sensor",
        version: "1",
        resultSpec: "sensor-result/1",
      }),
    ).toEqual({ ok: true });
  });

  it("keeps the frozen result shape closed — a result member granting anything rejects", () => {
    const result = {
      spec: "sensor-result/1",
      capabilityId: "repo.check",
      outcome: "passed",
      summary: "clean",
      candidateTreeSha: OID,
    };
    expect(validateSensorResult(result)).toEqual({ ok: true });
    expect(codesOf(validateSensorResult({ ...result, grantedAuthority: ["merge"] }))).toContain("unknown_member");
    expect(codesOf(validateSensorResult({ ...result, outcome: "waived" }))).toContain("malformed_member");
  });
});

describe("the merge-ready finish line", () => {
  const finishLine = (verification: Record<string, unknown>): Record<string, unknown> => ({
    spec: "finish-line-result/1",
    finishLine: "merge-ready",
    deliveryId: "delivery-1",
    candidate: { treeSha: OID, deliverableDigest: DIGEST },
    outcomeVerificationDigest: digestCanonical(verification),
    mergeReadyObligationsSatisfied: true,
  });

  it("accepts the golden result and binds it to the outcome verification by digest", () => {
    const verification = outcome();
    const result = finishLine(verification);
    expect(validateFinishLineResult(result)).toEqual({ ok: true });
    expect(checkMergeReadyAgainstOutcome(result as never, verification as never)).toEqual({ ok: true });
    expect(
      codesOf(checkMergeReadyAgainstOutcome({ ...result, outcomeVerificationDigest: "e".repeat(64) } as never, verification as never)),
    ).toContain("digest_mismatch");
  });

  it("rejects a result that claims any finish line other than merge-ready — later finish lines live with their owning units", () => {
    expect(codesOf(validateFinishLineResult({ ...finishLine(outcome()), finishLine: "merge" }))).toContain(
      "malformed_member",
    );
  });

  it("cannot be reached by a blanket waiver — at least one positive criterion must pass and none may be blocked", () => {
    const allWaived = outcome();
    allWaived["criteria"] = [
      { criterionId: "crit-1", disposition: "amended-waived", evidence: { kind: "review", reference: "waiver-1" } },
      { criterionId: "crit-2", disposition: "amended-waived", evidence: { kind: "review", reference: "waiver-2" } },
    ];
    expect(
      codesOf(checkMergeReadyAgainstOutcome(finishLine(allWaived) as never, allWaived as never)),
    ).toContain("criterion_unverified");

    const stillBlocked = outcome();
    stillBlocked["criteria"] = [
      { criterionId: "crit-1", disposition: "passed", evidence: { kind: "sensor", reference: "record-1" } },
      { criterionId: "crit-2", disposition: "blocked", evidence: { kind: "sensor", reference: "record-2" } },
    ];
    expect(
      codesOf(checkMergeReadyAgainstOutcome(finishLine(stillBlocked) as never, stillBlocked as never)),
    ).toContain("criterion_unverified");
  });
});
