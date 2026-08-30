/**
 * The evidence module's V-slice: the D14 review floor over reviewer attempts,
 * and the criterion mapping that keeps a green-but-unrelated change from
 * passing. Independence is falsifiable through the context digest — distinct
 * attempt identities carrying identical contexts are exactly what these
 * checks exist to reject.
 *
 * Written RED before `review.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import type { AcceptedContract } from "../spine/contract.ts";
import {
  checkReviewFloor,
  composeOutcomeVerification,
  type RecordedReviewAttempt,
  type RecordedSensorResult,
} from "./review.ts";

const LENSES = [
  { lensId: "lens.outcome-correctness", category: "outcome-correctness" },
  { lensId: "lens.testing-policy", category: "testing-policy" },
] as const;

const candidateTreeSha = "1".repeat(40);

const attempt = (overrides: Partial<RecordedReviewAttempt>): RecordedReviewAttempt => ({
  attemptId: "attempt-1",
  lensId: "lens.outcome-correctness",
  contextDigest: digestCanonical({ context: "outcome" }),
  artifactDigest: digestCanonical({ artifact: "outcome" }),
  verdict: "approved",
  candidateTreeSha,
  ...overrides,
});

describe("checkReviewFloor", () => {
  const goodAttempts = [
    attempt({}),
    attempt({
      attemptId: "attempt-2",
      lensId: "lens.testing-policy",
      contextDigest: digestCanonical({ context: "testing" }),
      artifactDigest: digestCanonical({ artifact: "testing" }),
    }),
  ];

  it("accepts two distinct-lens, distinct-context attempts on the current candidate", () => {
    expect(checkReviewFloor({ attempts: goodAttempts, lenses: LENSES, candidateTreeSha }).ok).toBe(true);
  });

  it("rejects zero attempts", () => {
    const verdict = checkReviewFloor({ attempts: [], lenses: LENSES, candidateTreeSha });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejections.map((rejection) => rejection.code)).toContain("zero_review_attempts");
  });

  it("rejects a missing mandatory lens", () => {
    const verdict = checkReviewFloor({ attempts: [goodAttempts[0]!], lenses: LENSES, candidateTreeSha });
    expect(verdict.ok).toBe(false);
  });

  it("rejects duplicated attempt identities", () => {
    const verdict = checkReviewFloor({
      attempts: [goodAttempts[0]!, { ...goodAttempts[1]!, attemptId: "attempt-1" }],
      lenses: LENSES,
      candidateTreeSha,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejections.map((rejection) => rejection.code)).toContain("duplicate_review_attempt");
  });

  it("rejects same-context re-invocation under a fresh attempt identity", () => {
    const verdict = checkReviewFloor({
      attempts: [goodAttempts[0]!, { ...goodAttempts[1]!, contextDigest: goodAttempts[0]!.contextDigest }],
      lenses: LENSES,
      candidateTreeSha,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejections.map((rejection) => rejection.code)).toContain("duplicate_review_context");
  });

  it("recovers when the affected lens completes a fresh attempt with its own context", () => {
    const verdict = checkReviewFloor({
      attempts: [
        goodAttempts[0]!,
        { ...goodAttempts[1]!, contextDigest: goodAttempts[0]!.contextDigest }, // disqualified re-invocation
        { ...goodAttempts[1]!, attemptId: "attempt-3" }, // fresh, independently constructed
      ],
      lenses: LENSES,
      candidateTreeSha,
    });
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });

  it("ignores attempts bound to a superseded candidate — an aligned final review is per candidate", () => {
    const verdict = checkReviewFloor({
      attempts: [goodAttempts[0]!, { ...goodAttempts[1]!, candidateTreeSha: "2".repeat(40) }],
      lenses: LENSES,
      candidateTreeSha,
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("composeOutcomeVerification", () => {
  const contract: AcceptedContract = {
    spec: "scoped-delivery-contract/1",
    contractId: "contract-1",
    task: "add a greeting",
    intendedOutcome: "greet() returns the contracted greeting",
    acceptanceCriteria: [{ criterionId: "greeting-behavior", statement: "greet() returns 'hello, skeleton'" }],
    nonGoals: [],
    repository: { repositoryId: "disposable-skeleton", baseRef: "main" },
    requestedFinishLine: "merge-ready",
    requestedAuthority: [],
    unresolvedDecisions: [],
  };

  const sensorPassed: RecordedSensorResult = {
    capabilityId: "sensor.acceptance",
    outcome: "passed",
    summary: "acceptance sensor green",
    candidateTreeSha,
  };

  const attempts = [
    attempt({}),
    attempt({
      attemptId: "attempt-2",
      lensId: "lens.testing-policy",
      contextDigest: digestCanonical({ context: "testing" }),
    }),
  ];

  it("maps a criterion to passed sensor evidence on the exact candidate", () => {
    const outcome = composeOutcomeVerification({
      contract,
      candidate: { treeSha: candidateTreeSha, deliverableDigest: "f".repeat(64) },
      sensorResults: [sensorPassed],
      attempts,
    });
    expect(outcome.criteria).toHaveLength(1);
    expect(outcome.criteria[0]?.disposition).toBe("passed");
    expect(outcome.reviewAttempts).toHaveLength(2);
  });

  it("marks a criterion blocked when its sensor failed — a green-but-unrelated change fails criterion mapping", () => {
    const outcome = composeOutcomeVerification({
      contract,
      candidate: { treeSha: candidateTreeSha, deliverableDigest: "f".repeat(64) },
      sensorResults: [{ ...sensorPassed, outcome: "failed" }],
      attempts,
    });
    expect(outcome.criteria[0]?.disposition).toBe("blocked");
  });

  it("marks a criterion blocked when its sensor evidence names a different candidate", () => {
    const outcome = composeOutcomeVerification({
      contract,
      candidate: { treeSha: candidateTreeSha, deliverableDigest: "f".repeat(64) },
      sensorResults: [{ ...sensorPassed, candidateTreeSha: "2".repeat(40) }],
      attempts,
    });
    expect(outcome.criteria[0]?.disposition).toBe("blocked");
  });

  it("marks a criterion blocked when no sensor evidence exists at all", () => {
    const outcome = composeOutcomeVerification({
      contract,
      candidate: { treeSha: candidateTreeSha, deliverableDigest: "f".repeat(64) },
      sensorResults: [],
      attempts,
    });
    expect(outcome.criteria[0]?.disposition).toBe("blocked");
  });
});
