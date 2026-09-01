import { describe, expect, it } from "vitest";
import { digestCanonical, sha256Hex } from "../digest.ts";
import { compiledAdopterPolicyBindingDigest, createManagedDeliveryFacade, type ResolvedPersonaSource } from "./managed-delivery.ts";
import { disposablePolicyBinding } from "./disposable-repository.fixture.ts";

describe("compiled adopter policy binding", () => {
  it("fails before facade construction when admission is absent", () => {
    const binding = disposablePolicyBinding();
    const { admission: _admission, ...withoutAdmission } = binding.compiledPolicy;

    expect(() =>
      createManagedDeliveryFacade({
        repoDir: "/tmp/disposable-skeleton",
        policyBinding: { ...binding, compiledPolicy: withoutAdmission },
        installation: { installationPath: "/tmp/installation", receiptDir: "/tmp/receipts" },
        hostVersion: "test",
      }),
    ).toThrow("no admission projection");
  });

  it("accepts adopter-specific grants, lenses, sensor identity, and authority", () => {
    const original = disposablePolicyBinding("adopter-shaped-repository");
    const personaSources: Readonly<Record<string, ResolvedPersonaSource>> = {
      ...original.personaSources,
      "persona.outcome-correctness": { origin: "composition" as const, bytes: "# Adopter outcome lens\n", digest: sha256Hex("# Adopter outcome lens\n") },
      "persona.testing-policy": { origin: "composition" as const, bytes: "# Adopter testing lens\n", digest: sha256Hex("# Adopter testing lens\n") },
    };
    const { policyDigest: _policyDigest, ...snapshotWithoutDigest } = original.compiledPolicy.snapshot;
    const snapshotBody = {
      ...snapshotWithoutDigest,
      reviewLenses: original.compiledPolicy.snapshot.reviewLenses.map((lens) => ({
        ...lens,
        personaDigest: personaSources[lens.personaId]!.digest,
      })),
    };
    const snapshot = { ...snapshotBody, policyDigest: digestCanonical(snapshotBody) };
    const grant = {
      ...original.compiledPolicy.checkpointGrants[0]!.grant,
      writablePaths: ["app"],
    };
    const checkpointGrants = original.compiledPolicy.checkpointGrants.map((entry) => ({ ...entry, grant: { ...grant } }));
    const { compiledDigest: _compiledDigest, ...compiledWithoutDigest } = original.compiledPolicy;
    const compiledBody = {
      ...compiledWithoutDigest,
      snapshot,
      capabilities: [{ ...original.compiledPolicy.capabilities[0]!, capabilityId: "sensor.adopter" }],
      checkpointGrants,
    };
    const compiledPolicy = { ...compiledBody, compiledDigest: digestCanonical(compiledBody) };

    expect(() =>
      createManagedDeliveryFacade({
        repoDir: "/tmp/adopter-shaped-repository",
        policyBinding: {
          compiledPolicy,
          personaSources,
          sensor: { capabilityId: "sensor.adopter", trustedBasePath: "tools/adopter-sensor.mjs" },
          outcomeAuthorities: ["repository-owner"],
        },
        installation: { installationPath: "/tmp/installation", receiptDir: "/tmp/receipts" },
        hostVersion: "test",
      }),
    ).not.toThrow();
  });

  it("includes every native binding field in the canonical drift identity", () => {
    const binding = disposablePolicyBinding();
    const baseline = compiledAdopterPolicyBindingDigest(binding);
    expect(compiledAdopterPolicyBindingDigest({ ...binding, outcomeAuthorities: ["different-owner"] })).not.toBe(baseline);
    expect(
      compiledAdopterPolicyBindingDigest({
        ...binding,
        sensor: { ...binding.sensor, trustedBasePath: "tools/other-sensor.mjs" },
      }),
    ).not.toBe(baseline);
    expect(
      compiledAdopterPolicyBindingDigest({
        ...binding,
        personaSources: {
          ...binding.personaSources,
          "persona.testing-policy": {
            ...binding.personaSources["persona.testing-policy"]!,
            bytes: "# drifted\n",
          },
        },
      }),
    ).not.toBe(baseline);
    expect(
      compiledAdopterPolicyBindingDigest({
        ...binding,
        compiledPolicy: { ...binding.compiledPolicy, policyGeneration: binding.compiledPolicy.policyGeneration + 1 },
      }),
    ).not.toBe(baseline);
  });
});
