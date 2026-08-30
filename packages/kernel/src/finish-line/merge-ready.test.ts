/**
 * The finish-line module's V-slice: composing the ONE frozen merge-ready
 * result from an outcome verification, and refusing to compose one that the
 * spine's own cross-checks would reject.
 *
 * Written RED before `merge-ready.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import { checkMergeReadyAgainstOutcome, validateFinishLineResult } from "../spine/finish-line.ts";
import type { OutcomeVerification } from "../spine/contract.ts";
import { composeMergeReadyResult } from "./merge-ready.ts";

const candidate = { treeSha: "1".repeat(40), deliverableDigest: "f".repeat(64) };

const outcome = (disposition: "passed" | "blocked"): OutcomeVerification => ({
  spec: "outcome-verification/1",
  contractId: "contract-1",
  candidate,
  criteria: [
    {
      criterionId: "greeting-behavior",
      disposition,
      evidence: { kind: "sensor", reference: "sensor.acceptance" },
    },
  ],
  reviewAttempts: [
    {
      attemptId: "attempt-1",
      lensId: "lens.outcome-correctness",
      contextDigest: "a".repeat(64),
      verdict: "approved",
    },
  ],
});

describe("composeMergeReadyResult", () => {
  it("composes a valid result that binds the outcome verification by digest", () => {
    const composed = composeMergeReadyResult({ deliveryId: "dlv-1", outcome: outcome("passed") });
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    if (!composed.ok) return;
    expect(validateFinishLineResult(composed.result).ok).toBe(true);
    expect(composed.result.outcomeVerificationDigest).toBe(digestCanonical(outcome("passed")));
    expect(checkMergeReadyAgainstOutcome(composed.result, outcome("passed")).ok).toBe(true);
  });

  it("refuses to compose over a blocked criterion", () => {
    const composed = composeMergeReadyResult({ deliveryId: "dlv-1", outcome: outcome("blocked") });
    expect(composed.ok).toBe(false);
    if (composed.ok) return;
    expect(composed.rejections.map((rejection) => rejection.code)).toContain("criterion_unverified");
  });
});
