/**
 * Shared policy-module fixtures: one well-formed declarative policy document
 * and the executable adapter descriptors the corpus tests mutate. Data only —
 * this module imports nothing, so the red-first tests could name the shapes
 * before the compiler existed.
 *
 * The default document grants NO external authority and only the merge-ready
 * finish line; the widened variants below add merge/deploy authority so the
 * contradiction and revocation rows have something real to narrow.
 */

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

export const trackerAdapterFixture = (): Record<string, unknown> => ({
  spec: "adapter-capability/1",
  capabilityId: "tracker.linear",
  kind: "tracker",
  version: "1",
  resultSpec: "operation-result/1",
  credentialId: "credential.tracker",
});

export const repositoryAdapterSetFixture = (): readonly Record<string, unknown>[] => [sensorAdapterFixture()];
