/**
 * The provider-result contract is shared by every native host binding. These
 * tests deliberately exercise Claude Code and a Codex-shaped fixture through
 * the same builder: host identity is data, never a reason to fork evidence
 * construction.
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../digest.ts";
import {
  adaptClaudeCodeReviewResult,
  createProviderReviewHandoff,
  parseProviderReviewResult,
} from "./provider-review-result.ts";

/** Shared by Claude and Codex rows; host identity is the only variant. */
const createProviderReviewConformanceFixture = (input: { providerId: string; providerVersion: string }) => {
  const personaBytes = "persona-charter";
  const contractBytes = '{"criterion":"preserve exact outcome"}\n';
  const sensorEvidenceBytes = '{"sensor":"passed"}\n';
  const reviewInstructionsBytes = "Review the exact candidate and return the closed JSON conclusion.";
  const handoff = createProviderReviewHandoff({
    handoffId: "handoff-conformance",
    deliveryId: "dlv-conformance",
    provider: { id: input.providerId, version: input.providerVersion, runId: "run-conformance", finalPassId: "pass-final" },
    nativeSessionId: "session-conformance",
    workspaceId: "ws-conformance",
    fence: 1,
    productTrustRevocationEpoch: 0,
    candidate: {
      vcs: "git",
      treeSha: "1".repeat(40),
      headSha: "2".repeat(40),
      deliverable: { digest: "3".repeat(64), identity: "deliverable-tree/v1" },
      base: { ref: "main", tipSha: "4".repeat(40), mergeBaseSha: "5".repeat(40) },
      workspaceId: "ws-conformance",
    },
    reviewInstructionsBytes,
    contractBytes,
    sensorEvidenceBytes,
    reviewer: {
      attemptId: "attempt-outcome",
      lensId: "lens.outcome-correctness",
      personaId: "outcome-correctness",
      personaDigest: sha256Hex(personaBytes),
      personaBytes,
    },
  });
  const conclusion = { verdict: "approved" as const, findings: [] };
  const adapted = adaptClaudeCodeReviewResult({
    handoff,
    submittedPromptContextBytes: handoff.promptContextBytes,
    nativeEnvelopeBytes: JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: handoff.nativeSessionId, result: JSON.stringify(conclusion) }),
  });
  if (!adapted.ok) throw new Error(adapted.message);
  return { handoff, conclusion, result: adapted.result, personaBytes, contractBytes, sensorEvidenceBytes, reviewInstructionsBytes };
};

describe("the host-neutral provider review result", () => {
  it.each([
    ["claude-code.ce-code-review", "claude-code/2.1.97"],
    ["codex.ce-code-review", "codex-app-server/0.1.0"],
  ])("parses the same closed contract for %s", (providerId, providerVersion) => {
    const fixture = createProviderReviewConformanceFixture({ providerId, providerVersion });
    const parsed = parseProviderReviewResult(JSON.stringify(fixture.result));
    expect(parsed).toEqual({ ok: true, result: fixture.result });
  });

  it("binds the exact persona, contract, sensor evidence, and instructions into the submitted prompt", () => {
    const fixture = createProviderReviewConformanceFixture({ providerId: "claude-code.ce-code-review", providerVersion: "claude-code/2.1.252" });
    expect(JSON.parse(fixture.handoff.promptContextBytes)).toEqual({
      persona: fixture.personaBytes,
      contract: fixture.contractBytes,
      sensorEvidence: fixture.sensorEvidenceBytes,
      instructions: fixture.reviewInstructionsBytes,
    });
    expect(fixture.handoff.promptContextDigest).toBe(sha256Hex(fixture.handoff.promptContextBytes));
  });

  it("rejects partial and open-shaped results", () => {
    const fixture = createProviderReviewConformanceFixture({
      providerId: "claude-code.ce-code-review",
      providerVersion: "claude-code/2.1.97",
    });
    const partial = { ...fixture.result, candidate: { treeSha: fixture.result.candidate.treeSha } };
    expect(parseProviderReviewResult(JSON.stringify(partial))).toMatchObject({ ok: false, code: "provider_result_invalid" });
    expect(parseProviderReviewResult(JSON.stringify({ ...fixture.result, surprise: true }))).toMatchObject({
      ok: false,
      code: "provider_result_invalid",
    });
  });
});

describe("the Claude Code native envelope adapter", () => {
  it("takes provenance from the native envelope and binding handoff, never the model conclusion", () => {
    const fixture = createProviderReviewConformanceFixture({
      providerId: "claude-code.ce-code-review",
      providerVersion: "claude-code/2.1.97",
    });
    const adapted = adaptClaudeCodeReviewResult({
      handoff: fixture.handoff,
      submittedPromptContextBytes: fixture.handoff.promptContextBytes,
      nativeEnvelopeBytes: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: fixture.handoff.nativeSessionId,
        result: JSON.stringify(fixture.conclusion),
      }),
    });
    expect(adapted).toEqual({ ok: true, result: fixture.result });
  });

  it("refuses a host callback that cannot prove the exact bound prompt bytes were submitted", () => {
    const fixture = createProviderReviewConformanceFixture({
      providerId: "claude-code.ce-code-review",
      providerVersion: "claude-code/2.1.252",
    });
    expect(adaptClaudeCodeReviewResult({
      handoff: fixture.handoff,
      submittedPromptContextBytes: "review without the bound persona, contract, or sensors",
      nativeEnvelopeBytes: fixture.result.nativeEnvelopeBytes,
    })).toMatchObject({ ok: false, code: "provider_prompt_mismatch" });
  });

  it("accepts one native JSON conclusion block but refuses ambiguous blocks", () => {
    const fixture = createProviderReviewConformanceFixture({
      providerId: "claude-code.ce-code-review",
      providerVersion: "claude-code/2.1.97",
    });
    const envelope = (result: string) => JSON.stringify({
      type: "result", subtype: "success", is_error: false, session_id: fixture.handoff.nativeSessionId, result,
    });
    const block = `review complete\n\n\`\`\`json\n${JSON.stringify(fixture.conclusion)}\n\`\`\``;
    expect(adaptClaudeCodeReviewResult({ handoff: fixture.handoff, submittedPromptContextBytes: fixture.handoff.promptContextBytes, nativeEnvelopeBytes: envelope(block) })).toMatchObject({
      ok: true,
      result: { handoffId: fixture.result.handoffId, verdict: "approved", findings: [] },
    });
    expect(adaptClaudeCodeReviewResult({ handoff: fixture.handoff, submittedPromptContextBytes: fixture.handoff.promptContextBytes, nativeEnvelopeBytes: envelope(`${block}\n${block}`) })).toMatchObject({
      ok: false,
      code: "provider_conclusion_invalid",
    });
  });

  it("refuses a wrong native session and a partial model conclusion", () => {
    const fixture = createProviderReviewConformanceFixture({
      providerId: "claude-code.ce-code-review",
      providerVersion: "claude-code/2.1.97",
    });
    const envelope = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-sibling",
      result: JSON.stringify(fixture.conclusion),
    };
    expect(adaptClaudeCodeReviewResult({ handoff: fixture.handoff, submittedPromptContextBytes: fixture.handoff.promptContextBytes, nativeEnvelopeBytes: JSON.stringify(envelope) })).toMatchObject({
      ok: false,
      code: "provider_session_mismatch",
    });
    expect(
      adaptClaudeCodeReviewResult({
        handoff: fixture.handoff,
        submittedPromptContextBytes: fixture.handoff.promptContextBytes,
        nativeEnvelopeBytes: JSON.stringify({ ...envelope, session_id: fixture.handoff.nativeSessionId, result: "{}" }),
      }),
    ).toMatchObject({ ok: false, code: "provider_conclusion_invalid" });
  });
});
