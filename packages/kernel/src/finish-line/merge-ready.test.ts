/**
 * THE SAFE MERGE-READY FINISH LINE.
 *
 * Four sensor families, each falsifiable on its own:
 *
 *   - the AUTHORITY/REQUEST MATRIX: what the compiled policy grants, what the
 *     contract requests, and the state the pair authorizes next;
 *   - CANDIDATE AND BASE MOVEMENT: the post-record candidate and the base it
 *     stands on are rebound at terminal success, and either moving invalidates
 *     readiness;
 *   - HOSTED AND LOCAL EVIDENCE: the external verifier's result and the
 *     repository's own completed obligations each block on their own;
 *   - FORBIDDEN ACTIONS: a merge-ready finish line authorizes no pull-request
 *     creation, no merge, and no deployment, and no authorized action is
 *     invocable through the unbound operation port in this slice.
 *
 * Written RED against the thin skeleton module this unit hardens.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import { PRIVILEGED_ACTIONS } from "../policy/capabilities.ts";
import { PRODUCT_TRUST_LABEL } from "../spine/composition.ts";
import type { AcceptedContract, OutcomeVerification } from "../spine/contract.ts";
import { EXTERNAL_ACTIONS, validateFinishLineResult } from "../spine/finish-line.ts";
import type { PolicySnapshot } from "../spine/policy.ts";
import {
  UNBOUND_EXTERNAL_ACTION_PORT,
  authorizeFinishLineAction,
  decideFinishLine,
  type FinishLineInput,
} from "./merge-ready.ts";

const REVIEWED_TREE = "1".repeat(40);
const RECORD_TREE = "2".repeat(40);
const BASE_TIP = "3".repeat(40);
const DELIVERABLE = "f".repeat(64);
const RECORD_DIGEST = "e".repeat(64);

const codesOf = (decision: { kind: string } & Record<string, unknown>): readonly string[] =>
  decision.kind === "blocked" ? ((decision["refusals"] as { code: string }[]).map((refusal) => refusal.code)) : [];

const contractOf = (over: Partial<AcceptedContract> = {}): AcceptedContract => ({
  spec: "scoped-delivery-contract/1",
  contractId: "contract-1",
  task: "implement the greeting",
  intendedOutcome: "the greeting is contracted",
  acceptanceCriteria: [{ criterionId: "greeting-behavior", statement: "the greeting is right" }],
  nonGoals: [],
  repository: { repositoryId: "repo-1", baseRef: "refs/heads/main" },
  requestedFinishLine: "merge-ready",
  requestedAuthority: [],
  unresolvedDecisions: [],
  ...over,
});

const policyOf = (over: Partial<PolicySnapshot> = {}): PolicySnapshot => {
  const body = {
    spec: "policy-snapshot/1" as const,
    repositoryId: "repo-1",
    productTrustRevocationEpoch: 0,
    repositoryAuthorityRevocationEpoch: 0,
    grantedFinishLines: ["merge-ready"],
    grantedAuthority: [],
    reviewLenses: [
      {
        lensId: "lens.outcome-correctness",
        category: "outcome-correctness",
        personaId: "persona.outcome-correctness",
        personaDigest: "b".repeat(64),
      },
    ],
    obligations: [{ obligationId: "review-green" }],
    ...over,
  };
  return { ...body, policyDigest: digestCanonical(body) } as PolicySnapshot;
};

const outcomeOf = (disposition: "passed" | "blocked" = "passed"): OutcomeVerification => ({
  spec: "outcome-verification/1",
  contractId: "contract-1",
  candidate: { treeSha: REVIEWED_TREE, deliverableDigest: DELIVERABLE },
  criteria: [
    { criterionId: "greeting-behavior", disposition, evidence: { kind: "sensor", reference: "sensor.acceptance" } },
  ],
  reviewAttempts: [
    {
      attemptId: "attempt-1",
      lensId: "lens.outcome-correctness",
      contextDigest: "a".repeat(64),
      personaDigest: "b".repeat(64),
      verdict: "approved",
    },
  ],
});

const inputOf = (over: Partial<FinishLineInput> = {}): FinishLineInput => ({
  deliveryId: "dlv-1",
  contract: contractOf(),
  policy: policyOf(),
  outcome: outcomeOf(),
  record: { treeSha: RECORD_TREE, baseTipSha: BASE_TIP, digest: RECORD_DIGEST },
  observed: { treeSha: RECORD_TREE, baseTipSha: BASE_TIP },
  admission: { admitted: true, completedObligations: ["review-green"] },
  externalVerification: "passed",
  declaredProductTrustLabel: PRODUCT_TRUST_LABEL,
  ...over,
});

describe("the merge-ready decision", () => {
  it("terminates successfully and journals the full binding", () => {
    const decision = decideFinishLine(inputOf());
    expect(decision.kind, JSON.stringify(decision)).toBe("completed");
    if (decision.kind !== "completed") return;
    expect(validateFinishLineResult(decision.result)).toEqual({ ok: true });
    expect(decision.result).toEqual({
      spec: "finish-line-result/1",
      finishLine: "merge-ready",
      deliveryId: "dlv-1",
      candidate: { treeSha: REVIEWED_TREE, deliverableDigest: DELIVERABLE },
      recordedCandidate: { treeSha: RECORD_TREE, baseTipSha: BASE_TIP },
      policyDigest: policyOf().policyDigest,
      completedObligations: ["review-green"],
      trackedRecordDigest: RECORD_DIGEST,
      externalVerification: "passed",
      productTrustLabel: PRODUCT_TRUST_LABEL,
      outcomeVerificationDigest: digestCanonical(outcomeOf()),
      mergeReadyObligationsSatisfied: true,
    });
  });

  it("stops WITHOUT merging even when the policy grants merge authority", () => {
    // The contract requested merge-ready; a wider policy never widens it.
    const decision = decideFinishLine(
      inputOf({ policy: policyOf({ grantedFinishLines: ["merge-ready", "merge"], grantedAuthority: ["merge"] }) }),
    );
    expect(decision.kind).toBe("completed");
  });

  it("blocks when admission did not admit the candidate", () => {
    expect(codesOf(decideFinishLine(inputOf({ admission: { admitted: false, completedObligations: ["review-green"] } })))).toContain(
      "admission_incomplete",
    );
  });

  it("refuses to compose over an unresolved criterion", () => {
    const decision = decideFinishLine(inputOf({ outcome: outcomeOf("blocked") }));
    expect(codesOf(decision)).toContain("criterion_unverified");
  });

  it("refuses a product-trust level the substrate did not declare", () => {
    const decision = decideFinishLine(inputOf({ declaredProductTrustLabel: "signed / vendor-attested" }));
    expect(decision.kind).toBe("blocked");
    expect(codesOf(decision).length).toBeGreaterThan(0);
  });
});

describe("the authority and request matrix", () => {
  const cases: readonly {
    readonly name: string;
    readonly granted: readonly string[];
    readonly grantedAuthority: readonly string[];
    readonly requested: AcceptedContract["requestedFinishLine"];
    readonly requestedAuthority: readonly string[];
    readonly approvalRequired: readonly string[];
    readonly expect: "completed" | "acting" | "awaiting_approval" | "blocked";
    readonly code?: string;
  }[] = [
    {
      name: "merge-ready granted and requested",
      granted: ["merge-ready"],
      grantedAuthority: [],
      requested: "merge-ready",
      requestedAuthority: [],
      approvalRequired: [],
      expect: "completed",
    },
    {
      name: "merge granted, merge-ready requested",
      granted: ["merge-ready", "merge"],
      grantedAuthority: ["merge"],
      requested: "merge-ready",
      requestedAuthority: [],
      approvalRequired: [],
      expect: "completed",
    },
    {
      name: "merge requested, policy denies the finish line",
      granted: ["merge-ready"],
      grantedAuthority: [],
      requested: "merge",
      requestedAuthority: ["merge"],
      approvalRequired: [],
      expect: "blocked",
      code: "authority_not_granted",
    },
    {
      name: "merge finish line granted but the action authority is not",
      granted: ["merge-ready", "merge"],
      grantedAuthority: [],
      requested: "merge",
      requestedAuthority: ["merge"],
      approvalRequired: [],
      expect: "blocked",
      code: "authority_not_granted",
    },
    {
      name: "merge granted and requested, no approval required",
      granted: ["merge-ready", "merge"],
      grantedAuthority: ["merge"],
      requested: "merge",
      requestedAuthority: ["merge"],
      approvalRequired: [],
      expect: "acting",
    },
    {
      name: "merge granted and requested, policy requires an approval",
      granted: ["merge-ready", "merge"],
      grantedAuthority: ["merge"],
      requested: "merge",
      requestedAuthority: ["merge"],
      approvalRequired: ["merge"],
      expect: "awaiting_approval",
    },
    {
      name: "deploy finish line requested without requesting the action",
      granted: ["merge-ready", "deploy"],
      grantedAuthority: ["deploy"],
      requested: "deploy",
      requestedAuthority: [],
      approvalRequired: [],
      expect: "blocked",
      code: "authority_not_requested",
    },
    {
      name: "deploy granted and requested",
      granted: ["merge-ready", "deploy"],
      grantedAuthority: ["deploy"],
      requested: "deploy",
      requestedAuthority: ["deploy"],
      approvalRequired: [],
      expect: "acting",
    },
  ];

  for (const row of cases) {
    it(`${row.name} -> ${row.expect}`, () => {
      const decision = decideFinishLine(
        inputOf({
          contract: contractOf({ requestedFinishLine: row.requested, requestedAuthority: row.requestedAuthority }),
          policy: policyOf({ grantedFinishLines: row.granted as never, grantedAuthority: row.grantedAuthority }),
          approvalRequiredActions: row.approvalRequired,
        }),
      );
      expect(decision.kind, JSON.stringify(decision)).toBe(row.expect);
      if (row.code !== undefined) expect(codesOf(decision)).toContain(row.code);
    });
  }

  it("blocks a merge finish line on the SAME readiness a merge-ready one needs", () => {
    // The stronger state is never handed out on weaker evidence: a delivery
    // that cannot terminate at merge-ready is not authorized to act either.
    const decision = decideFinishLine(
      inputOf({
        contract: contractOf({ requestedFinishLine: "merge", requestedAuthority: ["merge"] }),
        policy: policyOf({ grantedFinishLines: ["merge-ready", "merge"], grantedAuthority: ["merge"] }),
        observed: { treeSha: "4".repeat(40), baseTipSha: BASE_TIP },
        externalVerification: "failed",
      }),
    );
    expect(decision.kind).toBe("blocked");
    expect(codesOf(decision)).toContain("candidate_moved");
    expect(codesOf(decision)).toContain("external_verification_missing");
  });

  it("blocks a merge finish line on the criteria rules merge-ready is blocked on", () => {
    // The blanket-waiver and unresolved-criterion rules are stated once,
    // ahead of the action dispatch — a stronger state is never reached on an
    // outcome merge-ready itself refuses.
    const blanketWaived = {
      ...outcomeOf(),
      criteria: [
        {
          criterionId: "greeting-behavior",
          disposition: "amended-waived" as const,
          evidence: { kind: "review" as const, reference: "waiver-1" },
        },
      ],
    };
    for (const outcome of [outcomeOf("blocked"), blanketWaived]) {
      const decision = decideFinishLine(
        inputOf({
          contract: contractOf({ requestedFinishLine: "merge", requestedAuthority: ["merge"] }),
          policy: policyOf({ grantedFinishLines: ["merge-ready", "merge"], grantedAuthority: ["merge"] }),
          outcome,
        }),
      );
      expect(decision.kind, JSON.stringify(decision)).toBe("blocked");
      expect(codesOf(decision)).toContain("criterion_unverified");
    }
  });

  it("never reaches a merge-ready RESULT on a merge or deploy finish line", () => {
    for (const finishLine of ["merge", "deploy"] as const) {
      const decision = decideFinishLine(
        inputOf({
          contract: contractOf({ requestedFinishLine: finishLine, requestedAuthority: [finishLine] }),
          policy: policyOf({ grantedFinishLines: ["merge-ready", finishLine], grantedAuthority: [finishLine] }),
        }),
      );
      expect(decision.kind).not.toBe("completed");
    }
  });
});

describe("forbidden actions", () => {
  it("names exactly the three external actions the grant model froze", () => {
    expect([...EXTERNAL_ACTIONS]).toEqual(["pr-creation", "merge", "deploy"]);
    expect([...PRIVILEGED_ACTIONS]).toEqual([...EXTERNAL_ACTIONS]);
  });

  it("refuses EVERY external action under a merge-ready finish line — a green review alone acts on nothing", () => {
    for (const action of EXTERNAL_ACTIONS) {
      const authorized = authorizeFinishLineAction({
        action,
        contract: contractOf({ requestedFinishLine: "merge-ready", requestedAuthority: [action] }),
        policy: policyOf({ grantedFinishLines: ["merge-ready"], grantedAuthority: [action] }),
      });
      expect(authorized.ok, `${action} must be forbidden under merge-ready`).toBe(false);
      if (authorized.ok) continue;
      expect(authorized.refusals.map((refusal) => refusal.code)).toContain("forbidden_action");
    }
  });

  it("refuses an action the contract never requested, even under a wider finish line", () => {
    const authorized = authorizeFinishLineAction({
      action: "pr-creation",
      contract: contractOf({ requestedFinishLine: "merge", requestedAuthority: ["merge"] }),
      policy: policyOf({ grantedFinishLines: ["merge-ready", "merge"], grantedAuthority: ["merge", "pr-creation"] }),
    });
    expect(authorized.ok).toBe(false);
    if (authorized.ok) return;
    expect(authorized.refusals.map((refusal) => refusal.code)).toContain("authority_not_requested");
  });

  it("cannot invoke ANY external action through the operation port in this slice", async () => {
    for (const action of EXTERNAL_ACTIONS) {
      const invoked = await UNBOUND_EXTERNAL_ACTION_PORT.invoke({
        intentId: "intent-1",
        action,
        candidate: { treeSha: RECORD_TREE, deliverableDigest: DELIVERABLE },
        policyDigest: policyOf().policyDigest,
        approval: "not-required",
      });
      expect(invoked.ok).toBe(false);
      if (invoked.ok) continue;
      expect(invoked.refusals.map((refusal) => refusal.code)).toContain("action_port_unbound");
    }
  });
});

describe("candidate and base movement", () => {
  it("invalidates readiness when the candidate moved since the recording transition", () => {
    const decision = decideFinishLine(
      inputOf({ observed: { treeSha: "4".repeat(40), baseTipSha: BASE_TIP } }),
    );
    expect(codesOf(decision)).toContain("candidate_moved");
  });

  it("invalidates readiness when the base tip moved since the recording transition", () => {
    const decision = decideFinishLine(
      inputOf({ observed: { treeSha: RECORD_TREE, baseTipSha: "5".repeat(40) } }),
    );
    expect(codesOf(decision)).toContain("base_moved");
  });
});

describe("hosted and local merge-ready evidence", () => {
  it("blocks when the external verifier did not run", () => {
    expect(codesOf(decideFinishLine(inputOf({ externalVerification: "unavailable" })))).toContain(
      "external_verification_missing",
    );
  });

  it("blocks when the external verifier failed", () => {
    expect(codesOf(decideFinishLine(inputOf({ externalVerification: "failed" })))).toContain(
      "external_verification_missing",
    );
  });

  it("blocks when a policy obligation carries no completed local evidence", () => {
    const decision = decideFinishLine(
      inputOf({
        policy: policyOf({ obligations: [{ obligationId: "review-green" }, { obligationId: "solution-note" }] }),
      }),
    );
    expect(codesOf(decision)).toContain("obligation_unsatisfied");
  });

  it("blocks on an empty completed-obligation set — merge-readiness is never vacuous", () => {
    const decision = decideFinishLine(
      inputOf({ policy: policyOf({ obligations: [] }), admission: { admitted: true, completedObligations: [] } }),
    );
    expect(codesOf(decision)).toContain("obligation_unsatisfied");
  });
});
