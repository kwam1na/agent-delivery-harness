/**
 * The host-neutral result of ONE native reviewer invocation.
 *
 * The model authors only `NativeReviewConclusion`. The operator-owned host
 * binds one native session/run, one persona, and the exact prompt/context
 * bytes before launch. This module launches nothing and owns no credentials,
 * tasks, worktrees, or provider-specific manifest builder.
 */
import { digestCanonical, sha256Hex } from "../digest.ts";

export const PROVIDER_REVIEW_HANDOFF_SPEC = "provider-review-handoff/1" as const;
export const PROVIDER_REVIEW_RESULT_SPEC = "provider-review-result/1" as const;
export type ProviderReviewVerdict = "approved" | "changes_requested";
export type ProviderReviewTerminalState = "completed" | "failed" | "timed_out" | "interrupted";

/** Supplied by the host and kept outside model-visible prompts, files, and tools. */
export interface ProviderReviewCapability {
  readonly id: string;
  readonly secret: string;
}

export interface ProviderReviewFinding {
  readonly id: string;
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly scope: "in_contract" | "adjacent" | "expansion";
  readonly actionable: boolean;
  readonly blocking: boolean;
  readonly disposition: "resolved" | "advisory" | "pre_existing" | "deferred" | "unresolved" | "ignored";
  readonly deferredIssueId?: string;
}

export interface ProviderReviewCandidate {
  readonly vcs: "git";
  readonly treeSha: string;
  readonly headSha: string;
  readonly deliverable: { readonly digest: string; readonly identity: string };
  readonly base: { readonly ref: string; readonly tipSha: string; readonly mergeBaseSha: string };
  readonly workspaceId: string;
}

export interface ProviderReviewHandoffReviewer {
  readonly attemptId: string;
  readonly lensId: string;
  readonly personaId: string;
  readonly personaDigest: string;
  readonly personaBytes: string;
  readonly contextDigest: string;
}

export interface ProviderReviewHandoff {
  readonly spec: typeof PROVIDER_REVIEW_HANDOFF_SPEC;
  readonly handoffId: string;
  readonly deliveryId: string;
  readonly provider: { readonly id: string; readonly version: string; readonly runId: string; readonly finalPassId: string };
  readonly nativeSessionId: string;
  readonly workspaceId: string;
  readonly fence: number;
  readonly productTrustRevocationEpoch: number;
  readonly candidate: ProviderReviewCandidate;
  readonly promptContextBytes: string;
  readonly promptContextDigest: string;
  readonly reviewer: ProviderReviewHandoffReviewer;
}

export interface ProviderReviewResult extends Omit<ProviderReviewHandoff, "spec"> {
  readonly spec: typeof PROVIDER_REVIEW_RESULT_SPEC;
  readonly nativeEnvelopeBytes: string;
  readonly nativeEnvelopeDigest: string;
  readonly terminalState: ProviderReviewTerminalState;
  readonly verdict: ProviderReviewVerdict;
  readonly findings: readonly ProviderReviewFinding[];
}

export interface NativeReviewConclusion {
  readonly verdict: ProviderReviewVerdict;
  readonly findings: readonly ProviderReviewFinding[];
}

type ParseFailure = { readonly ok: false; readonly code: "provider_result_invalid"; readonly message: string };
export type ProviderReviewParseResult = { readonly ok: true; readonly result: ProviderReviewResult } | ParseFailure;
export type ClaudeCodeReviewAdaptation =
  | { readonly ok: true; readonly result: ProviderReviewResult }
  | { readonly ok: false; readonly code: "provider_envelope_invalid" | "provider_session_mismatch" | "provider_prompt_mismatch" | "provider_conclusion_invalid"; readonly message: string };

const OID = /^[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PROVIDER = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERDICTS = new Set(["approved", "changes_requested"]);
const TERMINALS = new Set(["completed", "failed", "timed_out", "interrupted"]);
const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
const SCOPES = new Set(["in_contract", "adjacent", "expansion"]);
const DISPOSITIONS = new Set(["resolved", "advisory", "pre_existing", "deferred", "unresolved", "ignored"]);

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
};
const safeId = (value: unknown): value is string => text(value) && value.length <= 256 && SAFE_ID.test(value);

const finding = (value: unknown): value is ProviderReviewFinding =>
  record(value) && exact(value, ["id", "severity", "scope", "actionable", "blocking", "disposition"], ["deferredIssueId"]) &&
  text(value["id"]) && typeof value["severity"] === "string" && SEVERITIES.has(value["severity"]) &&
  typeof value["scope"] === "string" && SCOPES.has(value["scope"]) && typeof value["actionable"] === "boolean" &&
  typeof value["blocking"] === "boolean" && typeof value["disposition"] === "string" && DISPOSITIONS.has(value["disposition"]) &&
  (value["deferredIssueId"] === undefined || text(value["deferredIssueId"]));

const candidate = (value: unknown): value is ProviderReviewCandidate => {
  if (!record(value) || !exact(value, ["vcs", "treeSha", "headSha", "deliverable", "base", "workspaceId"])) return false;
  const deliverable = value["deliverable"];
  const base = value["base"];
  return value["vcs"] === "git" && typeof value["treeSha"] === "string" && OID.test(value["treeSha"]) &&
    typeof value["headSha"] === "string" && OID.test(value["headSha"]) && safeId(value["workspaceId"]) &&
    record(deliverable) && exact(deliverable, ["digest", "identity"]) && typeof deliverable["digest"] === "string" && SHA.test(deliverable["digest"]) && text(deliverable["identity"]) &&
    record(base) && exact(base, ["ref", "tipSha", "mergeBaseSha"]) && text(base["ref"]) &&
    typeof base["tipSha"] === "string" && OID.test(base["tipSha"]) && typeof base["mergeBaseSha"] === "string" && OID.test(base["mergeBaseSha"]);
};

const reviewer = (value: unknown): value is ProviderReviewHandoffReviewer =>
  record(value) && exact(value, ["attemptId", "lensId", "personaId", "personaDigest", "personaBytes", "contextDigest"]) &&
  safeId(value["attemptId"]) && safeId(value["lensId"]) && safeId(value["personaId"]) && text(value["personaBytes"]) &&
  typeof value["personaDigest"] === "string" && SHA.test(value["personaDigest"]) && sha256Hex(value["personaBytes"] as string) === value["personaDigest"] &&
  typeof value["contextDigest"] === "string" && SHA.test(value["contextDigest"]);

const provider = (value: unknown): boolean =>
  record(value) && exact(value, ["id", "version", "runId", "finalPassId"]) && typeof value["id"] === "string" && value["id"].length <= 128 && PROVIDER.test(value["id"]) &&
  text(value["version"]) && typeof value["runId"] === "string" && value["runId"].length <= 128 && RUN.test(value["runId"]) && value["runId"] !== "." &&
  value["runId"] !== ".." && safeId(value["finalPassId"]);

export function parseProviderReviewResult(bytes: string): ProviderReviewParseResult {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { return { ok: false, code: "provider_result_invalid", message: "provider result is not JSON" }; }
  const keys = ["spec", "handoffId", "deliveryId", "provider", "nativeSessionId", "workspaceId", "fence", "productTrustRevocationEpoch", "candidate", "promptContextBytes", "promptContextDigest", "reviewer", "nativeEnvelopeBytes", "nativeEnvelopeDigest", "terminalState", "verdict", "findings"];
  if (!record(value) || !exact(value, keys) || value["spec"] !== PROVIDER_REVIEW_RESULT_SPEC || !safeId(value["handoffId"]) || !safeId(value["deliveryId"]) || !provider(value["provider"]) ||
    !safeId(value["nativeSessionId"]) || !safeId(value["workspaceId"]) || !Number.isSafeInteger(value["fence"]) || (value["fence"] as number) < 1 ||
    !Number.isSafeInteger(value["productTrustRevocationEpoch"]) || (value["productTrustRevocationEpoch"] as number) < 0 || !candidate(value["candidate"]) ||
    !text(value["promptContextBytes"]) || typeof value["promptContextDigest"] !== "string" || sha256Hex(value["promptContextBytes"] as string) !== value["promptContextDigest"] || !reviewer(value["reviewer"]) ||
    !text(value["nativeEnvelopeBytes"]) || typeof value["nativeEnvelopeDigest"] !== "string" || sha256Hex(value["nativeEnvelopeBytes"] as string) !== value["nativeEnvelopeDigest"] ||
    typeof value["terminalState"] !== "string" || !TERMINALS.has(value["terminalState"]) || typeof value["verdict"] !== "string" || !VERDICTS.has(value["verdict"]) ||
    !Array.isArray(value["findings"]) || !value["findings"].every(finding)) {
    return { ok: false, code: "provider_result_invalid", message: "provider result is outside provider-review-result/1" };
  }
  return { ok: true, result: value as unknown as ProviderReviewResult };
}

function providerReviewPromptBytes(input: {
  readonly personaBytes: string;
  readonly contractBytes: string;
  readonly sensorEvidenceBytes: string;
  readonly reviewInstructionsBytes: string;
}): string {
  return `${JSON.stringify({
    persona: input.personaBytes,
    contract: input.contractBytes,
    sensorEvidence: input.sensorEvidenceBytes,
    instructions: input.reviewInstructionsBytes,
  }, null, 2)}\n`;
}

export function createProviderReviewHandoff(input: Omit<ProviderReviewHandoff, "spec" | "reviewer" | "promptContextBytes" | "promptContextDigest"> & {
  readonly reviewer: Omit<ProviderReviewHandoffReviewer, "contextDigest">;
  readonly contractBytes: string;
  readonly sensorEvidenceBytes: string;
  readonly reviewInstructionsBytes: string;
}): ProviderReviewHandoff {
  const { reviewer: suppliedReviewer, contractBytes, sensorEvidenceBytes, reviewInstructionsBytes, ...binding } = input;
  const promptContextBytes = providerReviewPromptBytes({
    personaBytes: suppliedReviewer.personaBytes,
    contractBytes,
    sensorEvidenceBytes,
    reviewInstructionsBytes,
  });
  const promptContextDigest = sha256Hex(promptContextBytes);
  const reviewer = {
    ...suppliedReviewer,
    contextDigest: digestCanonical({
      handoffId: input.handoffId,
      deliveryId: input.deliveryId,
      provider: input.provider,
      nativeSessionId: input.nativeSessionId,
      workspaceId: input.workspaceId,
      fence: input.fence,
      productTrustRevocationEpoch: input.productTrustRevocationEpoch,
      candidate: input.candidate,
      lensId: suppliedReviewer.lensId,
      personaId: suppliedReviewer.personaId,
      personaDigest: suppliedReviewer.personaDigest,
      promptContextDigest,
    }),
  };
  return { spec: PROVIDER_REVIEW_HANDOFF_SPEC, ...binding, promptContextBytes, promptContextDigest, reviewer };
}

export function adaptClaudeCodeReviewResult(input: {
  readonly handoff: ProviderReviewHandoff;
  readonly submittedPromptContextBytes: string;
  readonly nativeEnvelopeBytes: string;
}): ClaudeCodeReviewAdaptation {
  if (
    input.submittedPromptContextBytes !== input.handoff.promptContextBytes ||
    sha256Hex(input.submittedPromptContextBytes) !== input.handoff.promptContextDigest
  ) {
    return {
      ok: false,
      code: "provider_prompt_mismatch",
      message: "Claude Code was not invoked with the exact persona, contract, sensor evidence, and review instructions bound by the handoff",
    };
  }
  let envelope: unknown;
  try { envelope = JSON.parse(input.nativeEnvelopeBytes); } catch { return { ok: false, code: "provider_envelope_invalid", message: "Claude Code result envelope is not JSON" }; }
  if (!record(envelope) || envelope["type"] !== "result" || !text(envelope["subtype"]) || typeof envelope["is_error"] !== "boolean" || !safeId(envelope["session_id"]) || typeof envelope["result"] !== "string") {
    return { ok: false, code: "provider_envelope_invalid", message: "Claude Code result envelope is incomplete" };
  }
  if (envelope["session_id"] !== input.handoff.nativeSessionId) return { ok: false, code: "provider_session_mismatch", message: "Claude Code result belongs to another session" };
  let conclusion: unknown;
  try {
    conclusion = JSON.parse(envelope["result"]);
  } catch {
    const blocks = [...envelope["result"].matchAll(/```json\s*([\s\S]*?)```/gi)];
    if (blocks.length !== 1) return { ok: false, code: "provider_conclusion_invalid", message: "Claude Code conclusion is not JSON" };
    try { conclusion = JSON.parse(blocks[0]?.[1] ?? ""); } catch { return { ok: false, code: "provider_conclusion_invalid", message: "Claude Code conclusion is not JSON" }; }
  }
  if (!record(conclusion) || !exact(conclusion, ["verdict", "findings"]) || typeof conclusion["verdict"] !== "string" || !VERDICTS.has(conclusion["verdict"]) ||
    !Array.isArray(conclusion["findings"]) || !conclusion["findings"].every(finding)) {
    return { ok: false, code: "provider_conclusion_invalid", message: "Claude Code conclusion is outside the closed review grammar" };
  }
  return { ok: true, result: {
    ...input.handoff,
    spec: PROVIDER_REVIEW_RESULT_SPEC,
    nativeEnvelopeBytes: input.nativeEnvelopeBytes,
    nativeEnvelopeDigest: sha256Hex(input.nativeEnvelopeBytes),
    terminalState: envelope["subtype"] === "success" && envelope["is_error"] === false ? "completed" : "failed",
    verdict: conclusion["verdict"] as ProviderReviewVerdict,
    findings: conclusion["findings"] as ProviderReviewFinding[],
  } };
}
