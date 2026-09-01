import { describe, expect, it } from "vitest";
import { digestCanonical, sha256Hex } from "../digest.ts";
import { createManagedDeliveryFacade } from "./managed-delivery.ts";
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
    const personaBytes: Readonly<Record<string, string>> = {
      ...original.personaBytes,
      "persona.outcome-correctness": "# Adopter outcome lens\n",
      "persona.testing-policy": "# Adopter testing lens\n",
    };
    const { policyDigest: _policyDigest, ...snapshotWithoutDigest } = original.compiledPolicy.snapshot;
    const snapshotBody = {
      ...snapshotWithoutDigest,
      reviewLenses: original.compiledPolicy.snapshot.reviewLenses.map((lens) => ({
        ...lens,
        personaDigest: sha256Hex(personaBytes[lens.personaId] as string),
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
          personaBytes,
          sensor: { capabilityId: "sensor.adopter", trustedBasePath: "tools/adopter-sensor.mjs" },
          outcomeAuthorities: ["repository-owner"],
        },
        installation: { installationPath: "/tmp/installation", receiptDir: "/tmp/receipts" },
        hostVersion: "test",
      }),
    ).not.toThrow();
  });
});
