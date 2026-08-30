/**
 * The adapter SDK's typed capability descriptors and the claim check that
 * keeps adapter output inside granted authority.
 *
 * Two separations are proven here, both mechanical:
 *   - DISCOVERY NEVER GRANTS AUTHORITY: an adapter set can expose a merge
 *     capability all day; authority comes only from the declarative document.
 *   - AN ADAPTER OUTPUT CANNOT CLAIM AN UNGRANTED ACTION: a claim naming a
 *     privileged action is checked against the bound snapshot's granted
 *     authority, and absence of a grant is denial.
 *
 * Written RED before `capabilities.ts` existed.
 */
import { describe, expect, it } from "vitest";
import {
  PRIVILEGED_ACTIONS,
  PRIVILEGED_CAPABILITY_KINDS,
  POLICY_CAPABILITY_KINDS,
  READ_ONLY_CAPABILITY_KINDS,
  checkClaimAuthorized,
  validateAdapterCapability,
  validateAdapterSet,
} from "./capabilities.ts";
import { compileRepositoryPolicy } from "./compile.ts";
import {
  mergeAdapterFixture,
  mergeAuthorityDocumentFixture,
  policyDocumentFixture,
  sensorAdapterFixture,
} from "./fixtures.ts";

const codesOf = (verdict: { readonly ok: boolean }): readonly string[] =>
  verdict.ok
    ? []
    : (verdict as unknown as { rejections: readonly { code: string }[] }).rejections.map((rejection) => rejection.code);

describe("the capability taxonomy", () => {
  it("names the eight repository capability classes", () => {
    expect([...POLICY_CAPABILITY_KINDS].sort()).toEqual(
      [
        "approval-request",
        "deploy",
        "merge",
        "mutation-stage",
        "pr-creation",
        "sensor",
        "status-reconciliation",
        "tracker",
      ].sort(),
    );
  });

  it("classifies sensors and status reconciliation as read-only, and the external actions as privileged", () => {
    expect([...READ_ONLY_CAPABILITY_KINDS].sort()).toEqual(["sensor", "status-reconciliation"].sort());
    expect([...PRIVILEGED_CAPABILITY_KINDS].sort()).toEqual(["approval-request", "deploy", "merge", "pr-creation"].sort());
    expect([...PRIVILEGED_ACTIONS].sort()).toEqual(["deploy", "merge", "pr-creation"].sort());
  });
});

describe("adapter capability descriptors", () => {
  it("accepts the sensor and merge adapter fixtures", () => {
    expect(validateAdapterCapability(sensorAdapterFixture()).ok).toBe(true);
    expect(validateAdapterCapability(mergeAdapterFixture()).ok).toBe(true);
  });

  it("is a closed grammar — an unknown member rejects", () => {
    const verdict = validateAdapterCapability({ ...sensorAdapterFixture(), authorityGranted: ["merge"] });
    expect(codesOf(verdict)).toContain("unknown_member");
  });

  it("rejects a kind outside the frozen taxonomy", () => {
    const verdict = validateAdapterCapability({ ...sensorAdapterFixture(), kind: "root-shell" });
    expect(verdict.ok).toBe(false);
  });

  it("rejects a result spec that does not belong to the descriptor's kind", () => {
    const verdict = validateAdapterCapability({ ...sensorAdapterFixture(), resultSpec: "operation-result/1" });
    expect(codesOf(verdict)).toContain("capability_contract_mismatch");
  });

  it("rejects duplicate capability ids in one adapter set", () => {
    const verdict = validateAdapterSet([sensorAdapterFixture(), sensorAdapterFixture()]);
    expect(codesOf(verdict)).toContain("duplicate_capability");
  });
});

describe("operation claims against the compiled policy", () => {
  const compiledWith = (document: Record<string, unknown>, adapters: readonly Record<string, unknown>[]) => {
    const result = compileRepositoryPolicy({
      document,
      adapters,
      productTrustRevocationEpoch: 0,
      repositoryAuthorityRevocationEpoch: 0,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("fixture must compile");
    return result.compiled;
  };

  const claim = (capabilityId: string, action: string) => ({ spec: "operation-claim/1", capabilityId, action });

  it("authorizes a sensor claim through its bound capability without any authority grant", () => {
    const compiled = compiledWith(policyDocumentFixture(), [sensorAdapterFixture()]);
    expect(checkClaimAuthorized(claim("sensor.acceptance", "sensor"), compiled).ok).toBe(true);
  });

  it("denies a claim naming a capability the compiled policy never bound", () => {
    const compiled = compiledWith(policyDocumentFixture(), [sensorAdapterFixture()]);
    const verdict = checkClaimAuthorized(claim("operation.merge", "merge"), compiled);
    expect(codesOf(verdict)).toContain("capability_unavailable");
  });

  it("denies a privileged claim whose authority the document never granted, even with the adapter bound", () => {
    // Discovery never grants authority: the merge adapter is present and
    // discoverable, the declarative document grants nothing.
    const compiled = compiledWith(policyDocumentFixture(), [sensorAdapterFixture(), mergeAdapterFixture()]);
    expect(compiled.snapshot.grantedAuthority).toEqual([]);
    const verdict = checkClaimAuthorized(claim("operation.merge", "merge"), compiled);
    expect(codesOf(verdict)).toContain("authority_not_granted");
  });

  it("denies a claim whose action does not match the bound capability's kind — no shell/provider bypass through a milder descriptor", () => {
    const compiled = compiledWith(mergeAuthorityDocumentFixture(), [sensorAdapterFixture(), mergeAdapterFixture()]);
    const verdict = checkClaimAuthorized(claim("sensor.acceptance", "merge"), compiled);
    expect(codesOf(verdict)).toContain("capability_contract_mismatch");
  });

  it("authorizes the granted merge claim through its bound adapter", () => {
    const compiled = compiledWith(mergeAuthorityDocumentFixture(), [sensorAdapterFixture(), mergeAdapterFixture()]);
    expect(checkClaimAuthorized(claim("operation.merge", "merge"), compiled).ok).toBe(true);
  });
});
