/**
 * The policy module's V-slice: ONE fixed disposable policy and ONE fixed
 * stage grant, compiled — not configured — so the walking skeleton has a
 * policy whose digest recomputes and whose grants the frozen spine validates.
 *
 * Written RED before `disposable.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import { validateCapabilityDescriptor } from "../spine/capability.ts";
import { checkContractWithinPolicy, validateAcceptedContract, type AcceptedContract } from "../spine/contract.ts";
import { validateExecutionGrant } from "../spine/grant.ts";
import { validatePolicySnapshot } from "../spine/policy.ts";
import {
  DISPOSABLE_SENSOR_CAPABILITY,
  DISPOSABLE_STAGE_GRANT,
  MANDATORY_LENS_CATEGORIES,
  compileDisposablePolicy,
} from "./disposable.ts";

const compiled = compileDisposablePolicy({
  repositoryId: "disposable-skeleton",
  productTrustRevocationEpoch: 0,
  repositoryAuthorityRevocationEpoch: 0,
});

describe("the fixed disposable policy", () => {
  it("compiles to a valid policy snapshot whose digest recomputes", () => {
    const verdict = validatePolicySnapshot(compiled);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    const { policyDigest, ...body } = compiled;
    expect(digestCanonical(body)).toBe(policyDigest);
  });

  it("activates both mandatory review lenses — the review floor is not lowered", () => {
    const categories = compiled.reviewLenses.map((lens) => lens.category);
    for (const category of MANDATORY_LENS_CATEGORIES) {
      expect(categories).toContain(category);
    }
  });

  it("activates a non-empty obligation set — admission cannot be passed by absence", () => {
    expect(compiled.obligations.length).toBeGreaterThan(0);
  });

  it("grants exactly the merge-ready finish line and no external authority", () => {
    expect(compiled.grantedFinishLines).toEqual(["merge-ready"]);
    expect(compiled.grantedAuthority).toEqual([]);
  });
});

describe("the fixed stage grant", () => {
  it("is a valid checkpoint-profile execution grant", () => {
    const verdict = validateExecutionGrant(DISPOSABLE_STAGE_GRANT);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(DISPOSABLE_STAGE_GRANT.profile).toBe("checkpoint");
  });

  it("protects the delivery authority paths and the materialized projection", () => {
    expect(DISPOSABLE_STAGE_GRANT.protectedPaths).toContain(".git");
    expect(DISPOSABLE_STAGE_GRANT.protectedPaths).toContain(".managed-projection");
  });
});

describe("the one trusted sensor capability", () => {
  it("is a valid capability descriptor of the frozen sensor kind", () => {
    const verdict = validateCapabilityDescriptor(DISPOSABLE_SENSOR_CAPABILITY.descriptor);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(DISPOSABLE_SENSOR_CAPABILITY.descriptor.kind).toBe("sensor");
  });

  it("names its trusted-base source path — the candidate's copy never governs", () => {
    expect(DISPOSABLE_SENSOR_CAPABILITY.trustedBasePath.length).toBeGreaterThan(0);
  });
});

describe("policy over contracts", () => {
  const contract: AcceptedContract = {
    spec: "scoped-delivery-contract/1",
    contractId: "contract-1",
    task: "add a greeting",
    intendedOutcome: "greet() returns the contracted greeting",
    acceptanceCriteria: [{ criterionId: "greeting-behavior", statement: "greet() returns 'hello, skeleton'" }],
    nonGoals: ["no second host"],
    repository: { repositoryId: "disposable-skeleton", baseRef: "main" },
    requestedFinishLine: "merge-ready",
    requestedAuthority: [],
    unresolvedDecisions: [],
  };

  it("accepts the skeleton's contract within the compiled grant", () => {
    expect(validateAcceptedContract(contract).ok).toBe(true);
    expect(checkContractWithinPolicy(contract, compiled).ok).toBe(true);
  });

  it("denies a requested authority the policy does not grant — absence is denial", () => {
    const widened = { ...contract, requestedAuthority: ["merge"] };
    const verdict = checkContractWithinPolicy(widened, compiled);
    expect(verdict.ok).toBe(false);
  });
});
