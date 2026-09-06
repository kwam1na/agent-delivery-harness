/** Hand-authored valid evidence for Action decision-table fixtures; no emitter implementation. */
import {
  buildDeliveryRecord, capturePortableEvidenceContext, repositoryEvidenceReader, createArtifactsPort,
  computeRecordId, computePreparationFingerprint, evaluateCandidateActivation, evaluateGate, digestCanonical, sha256Hex, manifestDigest,
  type HarnessConfig, type DeliveryRecord, type EvidenceRecord,
} from "@agent-delivery-harness/kernel";

export async function withPortableEvidence(rootDir: string, config: HarnessConfig, summary: DeliveryRecord): Promise<DeliveryRecord> {
  const b = summary.candidateBinding;
  const context = await capturePortableEvidenceContext(config, repositoryEvidenceReader(rootDir, createArtifactsPort()), await computePreparationFingerprint(rootDir, config));
  const candidate = { vcs: "git" as const, treeSha: b.treeSha, headSha: b.treeSha, mode: "clean" as const, statusEntries: [], untrackedFiles: [],
    deliverable: { digest: b.deliverableDigest, identity: b.identityToken }, base: { ref: b.baseRef, tipSha: b.baseTipSha, mergeBaseSha: b.mergeBaseSha }, workspaceId: b.workspaceId };
  const evidenceRecords: EvidenceRecord[] = [];
  for (const claim of summary.claims) {
    const provider = { id: claim.providerId!, version: "1", runId: "run-1", finalPassId: "pass-2" };
    const manifestCandidate = { vcs: "git", treeSha: b.treeSha, deliverable: candidate.deliverable, base: candidate.base, workspaceId: b.workspaceId };
    const bytes = JSON.stringify({ schemaVersion: 1, reviewerId: "fixture-reviewer", result: "approved",
      provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId }, workspaceId: b.workspaceId, candidate: manifestCandidate });
    const manifest = { spec: "delivery-evidence/1", provider, candidate: manifestCandidate, repository: null, recordedAt: "2026-09-06T00:00:00Z",
      runHistory: [{ preparedTreeSha: b.treeSha, evaluatedInPassId: provider.finalPassId }], attestation: { level: "self", signatures: [] },
      artifacts: [{ path: "reviewer.json", role: "reviewer-approval", sha256: sha256Hex(bytes) }],
      claims: [{ obligation: claim.obligationId, payloadSpec: "review.green/1", payload: { verdict: "green", finalized: true, editedAfterFinalPass: false,
        reviewers: { selected: ["fixture-reviewer"], completed: ["fixture-reviewer"], failed: [], timedOut: [] }, findings: [],
        telemetry: { iterationCount: 1, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, deferredExpansionCount: 0, deferredIssueIds: [] } } }] };
    const input = { gateId: config.gateId, obligationId: claim.obligationId, candidateBinding: b,
      resolution: { kind: "evidence" as const, providerId: provider.id, runId: provider.runId, finalPassId: provider.finalPassId, manifestDigest: manifestDigest(manifest),
        portable: { version: "portable-evidence/1" as const, manifest, artifacts: { "reviewer.json": Buffer.from(bytes).toString("base64") }, context } } };
    evidenceRecords.push({ ...input, schemaVersion: 1, workspaceId: b.workspaceId, recordId: computeRecordId(b.workspaceId, input) });
  }
  const projection = await evaluateCandidateActivation({ rootDir, config, candidate });
  const decision = evaluateGate({ config, candidate, projection, context: { kind: "agent", signal: "fixture" }, records: evidenceRecords });
  const built = buildDeliveryRecord({ config, decision, evidenceRecords, context });
  if (!built.ok) throw new Error(JSON.stringify(built.blockers));
  const { integrityDigest: _, ...record } = { ...built.record, gateId: summary.gateId, identityToken: summary.identityToken, attestation: summary.attestation, claims: built.record.claims.filter(claim => summary.claims.some(original => original.obligationId === claim.obligationId)) };
  return { ...record, integrityDigest: digestCanonical(record) };
}
