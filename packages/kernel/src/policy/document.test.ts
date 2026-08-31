/**
 * The declarative repository policy document's schema vectors: one closed
 * grammar, mutated one member per row. Unknown fields reject — including
 * inside a checkpoint override, where the grammar deliberately offers NO
 * member that could remove a portable protection (only `additional*`
 * members exist, so weakening is unspellable, not just rejected).
 *
 * Written RED before `document.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { validateRepositoryPolicyDocument } from "./document.ts";
import { mergeAuthorityDocumentFixture, policyDocumentFixture } from "./fixtures.ts";

const codesOf = (value: unknown): readonly string[] => {
  const verdict = validateRepositoryPolicyDocument(value);
  return verdict.ok ? [] : verdict.rejections.map((rejection) => rejection.code);
};

describe("the repository policy document grammar", () => {
  it("accepts the base fixture and the merge-authority variant", () => {
    expect(codesOf(policyDocumentFixture())).toEqual([]);
    expect(codesOf(mergeAuthorityDocumentFixture())).toEqual([]);
  });

  it("accepts a checkpoint override that narrows tools and adds protections", () => {
    const document = policyDocumentFixture({
      checkpoints: [
        {
          stageId: "implement",
          allowedCapabilities: ["Read", "Edit"],
          writablePaths: ["src"],
          credentials: [],
          additionalProtectedPaths: ["infra"],
          additionalForbiddenOperations: ["network.publish"],
        },
      ],
    });
    expect(codesOf(document)).toEqual([]);
  });

  it("rejects a non-object and an unsupported spec token", () => {
    expect(codesOf("policy")).toContain("not_an_object");
    expect(codesOf(policyDocumentFixture({ spec: "repository-policy-document/2" }))).toContain("unsupported_spec");
  });

  it("rejects an unknown top-level member — unknown fields reject before mutation", () => {
    expect(codesOf(policyDocumentFixture({ emergencyOverride: true }))).toContain("unknown_member");
  });

  it("rejects a checkpoint override carrying a removal-shaped member — protections have no removal channel", () => {
    const document = policyDocumentFixture({
      checkpoints: [
        {
          stageId: "implement",
          allowedCapabilities: ["Read"],
          writablePaths: ["src"],
          credentials: [],
          additionalProtectedPaths: [],
          additionalForbiddenOperations: [],
          forbiddenOperations: [],
        },
      ],
    });
    expect(codesOf(document)).toContain("unknown_member");
  });

  it("rejects a missing required member", () => {
    const document = policyDocumentFixture();
    delete (document as Record<string, unknown>)["obligations"];
    expect(codesOf(document)).toContain("missing_member");
  });

  it("rejects a finish line or authority entry outside the frozen vocabularies", () => {
    expect(codesOf(policyDocumentFixture({ grantedFinishLines: ["ship-it"] }))).toContain("malformed_member");
    expect(codesOf(policyDocumentFixture({ grantedAuthority: ["sudo"] }))).toContain("malformed_member");
  });

  it("rejects prose where structure is required — a free-text authority sentence is not a grant", () => {
    expect(codesOf(policyDocumentFixture({ grantedAuthority: "the agent may merge when CI is green" }))).toContain(
      "malformed_member",
    );
  });

  it("accepts a lens referencing its reviewer charter by identity alone", () => {
    expect(codesOf(policyDocumentFixture())).toEqual([]);
  });

  it("accepts a lens referencing a repository-owned charter by identity and digest", () => {
    const document = policyDocumentFixture({
      reviewLenses: [
        {
          lensId: "lens.outcome-correctness",
          category: "outcome-correctness",
          personaId: "persona.outcome-correctness",
          personaDigest: "c".repeat(64),
        },
        { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
      ],
    });
    expect(codesOf(document)).toEqual([]);
  });

  it("rejects a lens that names no reviewer charter — a category label is not a charter", () => {
    const document = policyDocumentFixture({
      reviewLenses: [
        { lensId: "lens.outcome-correctness", category: "outcome-correctness" },
        { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
      ],
    });
    expect(codesOf(document)).toContain("missing_member");
  });

  it("rejects a charter digest outside the digest grammar", () => {
    const document = policyDocumentFixture({
      reviewLenses: [
        {
          lensId: "lens.outcome-correctness",
          category: "outcome-correctness",
          personaId: "persona.outcome-correctness",
          personaDigest: "not-a-digest",
        },
        { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
      ],
    });
    expect(codesOf(document)).toContain("malformed_member");
  });

  it("rejects inline charter prose in a lens declaration — policy is a place prose cannot be spelled", () => {
    const document = policyDocumentFixture({
      reviewLenses: [
        {
          lensId: "lens.outcome-correctness",
          category: "outcome-correctness",
          personaId: "persona.outcome-correctness",
          charter: "be adversarial and thorough",
        },
        { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
      ],
    });
    expect(codesOf(document)).toContain("unknown_member");
  });

  it("rejects an unknown checkpoint stage id", () => {
    const document = policyDocumentFixture({
      checkpoints: [
        {
          stageId: "exfiltrate",
          allowedCapabilities: ["Read"],
          writablePaths: [],
          credentials: [],
          additionalProtectedPaths: [],
          additionalForbiddenOperations: [],
        },
      ],
    });
    expect(codesOf(document)).toContain("unknown_checkpoint_stage");
  });
});
