/**
 * Shared policy-module fixtures: one well-formed declarative policy document,
 * the executable adapter descriptors the corpus tests mutate, and the
 * repo-shaped admission gate. Data only — the single type-only import has no
 * runtime edge, so the red-first tests could name the shapes before the
 * compiler existed.
 *
 * The default document grants NO external authority and only the merge-ready
 * finish line; the widened variants below add merge/deploy authority so the
 * contradiction and revocation rows have something real to narrow.
 */
import type { HarnessConfigInput } from "../config.ts";

export const policyDocumentFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  spec: "repository-policy-document/1",
  repositoryId: "adopter-repo",
  policyGeneration: 1,
  grantedFinishLines: ["merge-ready"],
  grantedAuthority: [],
  forbiddenAuthority: [],
  reviewLenses: [
    { lensId: "lens.outcome-correctness", category: "outcome-correctness" },
    { lensId: "lens.testing-policy", category: "testing-policy" },
  ],
  obligations: [{ obligationId: "outcome.verification" }, { obligationId: "review.green" }],
  requiredCapabilities: [{ capabilityId: "sensor.acceptance", kind: "sensor", version: "1" }],
  approvals: [],
  trackerAbsenceFallback: "proceed-without-tracker",
  ...overrides,
});

/** The document widened to real merge authority, with its approval boundary. */
export const mergeAuthorityDocumentFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  policyDocumentFixture({
    grantedFinishLines: ["merge-ready", "merge"],
    grantedAuthority: ["merge"],
    approvals: [{ action: "merge", approval: "operator-required" }],
    ...overrides,
  });

export const sensorAdapterFixture = (): Record<string, unknown> => ({
  spec: "adapter-capability/1",
  capabilityId: "sensor.acceptance",
  kind: "sensor",
  version: "1",
  resultSpec: "sensor-result/1",
});

export const mergeAdapterFixture = (): Record<string, unknown> => ({
  spec: "adapter-capability/1",
  capabilityId: "operation.merge",
  kind: "merge",
  version: "1",
  resultSpec: "operation-result/1",
  credentialId: "credential.merge",
});

export const deployAdapterFixture = (): Record<string, unknown> => ({
  spec: "adapter-capability/1",
  capabilityId: "operation.deploy",
  kind: "deploy",
  version: "1",
  resultSpec: "operation-result/1",
  credentialId: "credential.deploy",
});

export const trackerAdapterFixture = (): Record<string, unknown> => ({
  spec: "adapter-capability/1",
  capabilityId: "tracker.linear",
  kind: "tracker",
  version: "1",
  resultSpec: "operation-result/1",
  credentialId: "credential.tracker",
});

export const repositoryAdapterSetFixture = (): readonly Record<string, unknown>[] => [sensorAdapterFixture()];

/** A repo-shaped admission gate, shared by the characterization and projection suites. */
export const admissionFixture = (): HarnessConfigInput =>
  ({
    gateId: "adopter.pr-admission",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: ["adopter-tree/v1"],
    computingIdentityVersion: "adopter-tree/v1",
    reviewNeutral: [{ prefix: "docs/reports/" }, { prefix: "delivery/records/" }],
    recordNeutral: [{ prefix: "delivery/records/" }],
    pathClassification: {
      generated: [],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [{ id: "gate-kernel", patterns: [{ kind: "prefix", value: "src/" }] }],
    activationThreshold: 1,
    providers: [{ id: "adopter.review-provider", findingCodes: [] }],
    agentEnvSignals: ["CLAUDE_CODE"],
    ciPolicies: [{ id: "github-actions", requiredEnv: [{ variable: "CI", equals: "true" }] }],
    ciPolicyEnvKey: "ADOPTER_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [
      {
        id: "review.green",
        activation: { kind: "relevant_change" },
        freshness: "exact_candidate",
        providers: ["adopter.review-provider"],
        acceptedPayloadSpecs: ["review.green/1"],
        allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
        humanWaiverAllowed: true,
        minimumAttestationLevel: "self",
        ciDelegationPolicyIds: [],
        remediation: {
          default: [{ id: "run-the-review", kind: "manual_action", summary: "Run the review and submit its manifest." }],
        },
        waivableCodes: ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings"],
        nonWaivableCodes: [
          "ambiguous_records",
          "malformed_record",
          "unknown_provider",
          "live_provider_missing",
          "ambiguous_live_provider",
          "live_provider_failed",
          "resolution_not_allowed",
        ],
      },
    ],
    deliveryRecordPath: "delivery/records/record.json",
  }) as HarnessConfigInput;
