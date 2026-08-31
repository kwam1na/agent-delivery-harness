/**
 * The waiver doctrine: every waiver is a sensitive approval, an agent can
 * never propose and approve, an outcome-changing waiver needs a declared
 * outcome authority, and no arrangement of waivers produces delivery success
 * on its own.
 *
 * Written RED before `waiver.ts` existed.
 */
import { describe, expect, it } from "vitest";
import type { OutcomeCriterion } from "../spine/contract.ts";
import {
  WAIVER_ACTIONS,
  checkPositiveCriterion,
  evaluateWaiverConsumption,
  type WaiverConsumptionContext,
} from "./waiver.ts";

const CANDIDATE = "1".repeat(40);
const POLICY_DIGEST = "a".repeat(64);

const assertionFor = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  spec: "sensitive-approval-assertion/1",
  assertionClass: "delivery-bound",
  origin: "waiver-approval:ops-lead",
  action: "waive-criterion",
  expiry: "2099-01-01T00:00:00Z",
  nonce: "nonce-waiver-1",
  assertionSource: "os-native",
  productTrustRevocationEpoch: 3,
  repositoryAuthorityRevocationEpoch: 2,
  deliveryId: "dlv-1",
  candidateTreeSha: CANDIDATE,
  policyDigest: POLICY_DIGEST,
  invocationFence: 7,
  targetInstallationId: "absent-by-state",
  targetGenerationDigest: "absent-by-state",
  targetHighWaterMark: "absent-by-state",
  expectedJournalRevision: "absent-by-state",
  ...overrides,
});

const contextFor = (overrides: Partial<WaiverConsumptionContext> = {}): WaiverConsumptionContext => ({
  deliveryId: "dlv-1",
  deliveryState: "reviewing",
  candidateTreeSha: CANDIDATE,
  policyDigest: POLICY_DIGEST,
  productTrustRevocationEpoch: 3,
  repositoryAuthorityRevocationEpoch: 2,
  invocationFence: 7,
  proposal: {
    requestKind: "waiver",
    criterionId: "greeting-behavior",
    actorId: "agent.reviewer",
    candidateTreeSha: CANDIDATE,
  },
  contractCriterionIds: ["greeting-behavior", "coverage"],
  outcomeAuthorities: ["ops-lead"],
  currentProfile: "production",
  consumedNonces: new Set<string>(),
  now: "2026-08-30T00:00:00Z",
  ...overrides,
});

const codesOf = (verdict: ReturnType<typeof evaluateWaiverConsumption>): readonly string[] =>
  verdict.ok ? [] : verdict.blockers.map((blocker) => blocker.code);

describe("evaluateWaiverConsumption", () => {
  it("freezes exactly the two waiver actions", () => {
    expect([...WAIVER_ACTIONS]).toEqual(["waive-criterion", "confirm-outcome-amendment"]);
  });

  it("consumes a well-bound, independently approved, unexpired waiver", () => {
    const verdict = evaluateWaiverConsumption(assertionFor(), contextFor());
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    if (verdict.ok) {
      expect(verdict.outcomeChanging).toBe(false);
      expect(verdict.criterionId).toBe("greeting-behavior");
    }
  });

  it("refuses an assertion that is not a delivery-bound sensitive approval", () => {
    const verdict = evaluateWaiverConsumption(assertionFor({ assertionClass: "maintenance-lane" }), contextFor());
    expect(codesOf(verdict)).toContain("assertion_malformed");
  });

  it("refuses an action outside the frozen waiver set", () => {
    const verdict = evaluateWaiverConsumption(assertionFor({ action: "merge" }), contextFor());
    expect(codesOf(verdict)).toContain("assertion_mismatch");
  });

  it("refuses an assertion bound to another delivery, candidate, policy, or fence", () => {
    expect(codesOf(evaluateWaiverConsumption(assertionFor({ deliveryId: "dlv-2" }), contextFor()))).toContain("assertion_mismatch");
    expect(codesOf(evaluateWaiverConsumption(assertionFor({ candidateTreeSha: "2".repeat(40) }), contextFor()))).toContain(
      "assertion_mismatch",
    );
    expect(codesOf(evaluateWaiverConsumption(assertionFor({ policyDigest: "b".repeat(64) }), contextFor()))).toContain(
      "assertion_mismatch",
    );
    expect(codesOf(evaluateWaiverConsumption(assertionFor({ invocationFence: 6 }), contextFor()))).toContain("assertion_mismatch");
  });

  it("refuses a stale approval: superseded epochs, an expired evaluation, or a replayed nonce", () => {
    expect(codesOf(evaluateWaiverConsumption(assertionFor({ productTrustRevocationEpoch: 2 }), contextFor()))).toContain(
      "assertion_stale",
    );
    expect(codesOf(evaluateWaiverConsumption(assertionFor({ repositoryAuthorityRevocationEpoch: 1 }), contextFor()))).toContain(
      "assertion_stale",
    );
    expect(codesOf(evaluateWaiverConsumption(assertionFor({ expiry: "2026-08-29T00:00:00Z" }), contextFor()))).toContain(
      "assertion_stale",
    );
    expect(
      codesOf(evaluateWaiverConsumption(assertionFor(), contextFor({ consumedNonces: new Set(["nonce-waiver-1"]) }))),
    ).toContain("assertion_replayed");
  });

  it("refuses a waiver whose proposal was made against a superseded candidate", () => {
    const verdict = evaluateWaiverConsumption(
      assertionFor(),
      contextFor({
        proposal: {
          requestKind: "waiver",
          criterionId: "greeting-behavior",
          actorId: "agent.reviewer",
          candidateTreeSha: "2".repeat(40),
        },
      }),
    );
    expect(codesOf(verdict)).toContain("waiver_proposal_stale");
  });

  it("refuses a waiver with no pending proposal at all", () => {
    expect(codesOf(evaluateWaiverConsumption(assertionFor(), contextFor({ proposal: undefined })))).toContain(
      "waiver_unproposed",
    );
  });

  it("refuses a criterion the contract never named", () => {
    const verdict = evaluateWaiverConsumption(
      assertionFor(),
      contextFor({
        proposal: { requestKind: "waiver", criterionId: "invented", actorId: "agent.reviewer", candidateTreeSha: CANDIDATE },
      }),
    );
    expect(codesOf(verdict)).toContain("waiver_criterion_unknown");
  });

  it("refuses a proposer who is also the approver — an agent cannot propose and approve", () => {
    const verdict = evaluateWaiverConsumption(
      assertionFor({ origin: "waiver-approval:agent.reviewer" }),
      contextFor(),
    );
    expect(codesOf(verdict)).toContain("waiver_self_approved");
  });

  it("refuses an origin that names nobody — a blank identity approves in no one's name", () => {
    for (const origin of ["waiver-approval:", "waiver-approval:   ", "managed-delivery.facade"]) {
      expect(codesOf(evaluateWaiverConsumption(assertionFor({ origin }), contextFor()))).toContain(
        "waiver_approver_unnamed",
      );
    }
  });

  it("refuses consumption after admission — only reviewing, remediating, and admitting carry a waiver", () => {
    for (const state of ["recording", "ready", "completed"] as const) {
      expect(codesOf(evaluateWaiverConsumption(assertionFor(), contextFor({ deliveryState: state })))).toContain(
        "waiver_after_admission",
      );
    }
    for (const state of ["reviewing", "remediating", "admitting"] as const) {
      expect(codesOf(evaluateWaiverConsumption(assertionFor(), contextFor({ deliveryState: state })))).not.toContain(
        "waiver_after_admission",
      );
    }
  });

  it("refuses a fixture-sourced assertion on a production installation", () => {
    const verdict = evaluateWaiverConsumption(assertionFor({ assertionSource: "qualification-fixture" }), contextFor());
    expect(codesOf(verdict)).toContain("assertion_source_mismatch");
  });

  it("refuses an outcome-changing confirmation from an origin policy never declared an outcome authority", () => {
    const verdict = evaluateWaiverConsumption(
      assertionFor({ action: "confirm-outcome-amendment", origin: "waiver-approval:passer-by" }),
      contextFor({ proposal: { requestKind: "amendment", criterionId: "greeting-behavior", actorId: "agent.reviewer", candidateTreeSha: CANDIDATE } }),
    );
    expect(codesOf(verdict)).toContain("outcome_authority_missing");
  });

  it("accepts an outcome-changing confirmation from a declared outcome authority and reports it", () => {
    const verdict = evaluateWaiverConsumption(
      assertionFor({ action: "confirm-outcome-amendment" }),
      contextFor({ proposal: { requestKind: "amendment", criterionId: "greeting-behavior", actorId: "agent.reviewer", candidateTreeSha: CANDIDATE } }),
    );
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    if (verdict.ok) expect(verdict.outcomeChanging).toBe(true);
  });
});

describe("outcome authorities", () => {
  it("denies an outcome amendment outright when policy declares no authority", () => {
    const verdict = evaluateWaiverConsumption(
      assertionFor({ action: "confirm-outcome-amendment" }),
      contextFor({
        outcomeAuthorities: [],
        proposal: { requestKind: "amendment", criterionId: "greeting-behavior", actorId: "agent.reviewer", candidateTreeSha: CANDIDATE },
      }),
    );
    expect(codesOf(verdict)).toContain("outcome_authority_missing");
  });
});

describe("checkPositiveCriterion", () => {
  const criterion = (disposition: OutcomeCriterion["disposition"], id: string): OutcomeCriterion => ({
    criterionId: id,
    disposition,
    evidence: { kind: "sensor", reference: `${id}: ${disposition}` },
  });

  it("accepts a verification carrying at least one passed criterion", () => {
    expect(checkPositiveCriterion([criterion("passed", "a"), criterion("amended-waived", "b")]).ok).toBe(true);
  });

  it("refuses a blanket waiver — every criterion waived produces no delivery success", () => {
    const verdict = checkPositiveCriterion([criterion("amended-waived", "a"), criterion("amended-waived", "b")]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.blockers.map((blocker) => blocker.code)).toContain("blanket_waiver");
  });

  it("refuses an empty criterion set — success cannot be passed by absence", () => {
    expect(checkPositiveCriterion([]).ok).toBe(false);
  });
});
