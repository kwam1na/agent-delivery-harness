/**
 * The admission projection of the compiled repository policy: the existing
 * harness admission configuration is DERIVED from the compiled snapshot — the
 * compiler carries it, validates it with the characterized loader (see
 * `harness-config.characterization.test.ts`, captured green first), and
 * refuses an admission gate that names an obligation the declarative policy
 * never activated. `HarnessConfig` is the admission projection of the policy
 * model, not the entire policy model.
 *
 * Written RED before `compile.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { validateHarnessConfig, type HarnessConfigInput } from "../config.ts";
import { compileRepositoryPolicy } from "./compile.ts";
import { admissionFixture, policyDocumentFixture, repositoryAdapterSetFixture } from "./fixtures.ts";

const compile = (document: unknown) =>
  compileRepositoryPolicy({
    document,
    adapters: repositoryAdapterSetFixture(),
    productTrustRevocationEpoch: 0,
    repositoryAuthorityRevocationEpoch: 0,
  });

describe("the admission projection of the compiled policy", () => {
  it("derives the validated harness admission configuration from the compiled snapshot", () => {
    const compiled = compile(policyDocumentFixture({ admission: admissionFixture() }));
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
    if (!compiled.ok) return;
    const direct = validateHarnessConfig(admissionFixture());
    expect(direct.ok).toBe(true);
    if (direct.ok) expect(compiled.compiled.admission).toEqual(direct.config);
  });

  it("rejects an admission gate naming an obligation the declarative policy never activated", () => {
    const compiled = compile(
      policyDocumentFixture({
        admission: admissionFixture(),
        obligations: [{ obligationId: "outcome.verification" }],
      }),
    );
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.rejections.map((rejection) => rejection.code)).toContain("admission_obligation_unactivated");
    }
  });

  it("rejects a malformed admission gate with the loader's own characterized codes", () => {
    const compiled = compile(
      policyDocumentFixture({ admission: { ...admissionFixture(), surprise: true } as HarnessConfigInput }),
    );
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.rejections.map((rejection) => rejection.code)).toContain("config_unknown_member");
    }
  });

  it("compiles no admission gate when the document declares none — the projection is absent, not invented", () => {
    const compiled = compile(policyDocumentFixture());
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
    if (compiled.ok) expect(compiled.compiled.admission).toBeUndefined();
  });
});
