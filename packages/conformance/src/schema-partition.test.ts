/**
 * The published JSON Schemas, cross-checked against the corpus.
 *
 * Appendix A and B describe shape; §8 and §9.3 define conformance. The schemas
 * are therefore necessary but not sufficient, and the interesting question is
 * exactly *where* they stop being sufficient. This file answers it as a
 * partition of the kit: the vectors a schema rejects, listed by id, and the
 * complement — every other vector passing both schemas, including every accept
 * vector.
 *
 * WHY THE PARTITION IS KEYED BY VECTOR AND NOT BY CODE. A code-keyed partition
 * would be unsound in both directions, and the corpus contains both proofs.
 * `invalid_cost` splits: a negative total is a schema violation, while a
 * breakdown summing above its total is not expressible in the schema at all.
 * `unsupported_attestation` splits the other way: an unknown level and a
 * non-empty signature array are schema violations, while `provider-signed` —
 * an enumerated level this version does not implement — passes the schema and
 * is rejected by the validator. So the boundary is drawn where it actually
 * falls, vector by vector.
 *
 * The list is maintained by hand and asserted exactly. A schema edit that
 * widened or narrowed the boundary shows up here as a failure naming the
 * vectors that moved.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadKitRepoConfig } from "../fixtures/repo-config-adapter.ts";
import { validateAgainstSchema } from "./json-schema.ts";
import { evaluateVector, loadKitEnvironment, loadKitIndex, loadKitVectors, type KitVector } from "./runner.ts";

const SCHEMA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "kernel",
  "src",
  "validator",
  "schemas",
);

const envelopeSchema = JSON.parse(readFileSync(path.join(SCHEMA_DIR, "envelope.schema.json"), "utf8"));
const payloadSchema = JSON.parse(readFileSync(path.join(SCHEMA_DIR, "review-green.schema.json"), "utf8"));

const vectors = loadKitVectors();
const index = loadKitIndex();
const kitConfig = loadKitRepoConfig();
const environment = loadKitEnvironment();

/**
 * The vectors the published schemas reject on shape alone. Everything else in
 * the kit — including all eight accept vectors — passes both schemas, which is
 * what makes the complement the interesting half: those rejections exist only
 * because a hand-rolled validator re-derives and cross-checks.
 */
const SCHEMA_FAILING_VECTORS: readonly string[] = [
  "gen-1-unknown-envelope-member",
  "gen-1-legacy-count-field",
  "gen-2-unsupported-spec",
  "env-2-run-id-1",
  "env-2-run-id-2",
  "env-2-run-id-3",
  "env-2-run-id-4",
  "env-2-run-id-5",
  "env-4-unsupported-vcs",
  "env-5-malformed-object-id",
  "env-6-missing-identity",
  "env-9-empty-run-history",
  "env-12-unknown-attestation-level",
  "env-13-nonempty-signatures",
  "env-14-no-claims",
  "rg-1-verdict-not-green",
  "rg-1-not-finalized",
  "rg-1-edited-after-final-pass",
  "rg-2-duplicate-selected",
  "rg-5-unknown-severity",
  "rg-5-unknown-scope",
  "rg-5-unknown-disposition",
  "rg-7-defer-placeholder-issue-id",
  "rg-7-defer-lowercase-issue-id",
  "rg-7-defer-missing-issue-id",
  "rg-10-cost-missing-unit",
  "rg-10-cost-empty-unit",
  "rg-10-cost-negative-total",
  "rg-10-cost-null-total",
  "rg-10-cost-negative-by-reviewer",
  "rg-10-cost-empty-reported-by",
];

/**
 * One vector, named, that the schemas accept and the validator rejects — the
 * proof that the boundary is real rather than an artifact of how the list was
 * gathered. Its payload is shaped correctly in every member; only the
 * relationship between two of them is wrong.
 */
const CROSS_FIELD_ONLY_VECTOR = "rg-10-cost-by-reviewer-exceeds-total";

function schemaViolations(vector: KitVector): readonly string[] {
  const manifest = vector.manifest as Record<string, unknown>;
  const violations = validateAgainstSchema(envelopeSchema, manifest).map((violation) => `envelope:${violation.keyword}${violation.pointer}`);

  const claims = manifest["claims"];
  if (Array.isArray(claims)) {
    claims.forEach((claim, claimIndex) => {
      if (claim === null || typeof claim !== "object") return;
      const entry = claim as Record<string, unknown>;
      if (entry["payloadSpec"] !== "review.green/1") return;
      const payload = entry["payload"];
      if (payload === null || typeof payload !== "object") return;
      for (const violation of validateAgainstSchema(payloadSchema, payload)) {
        violations.push(`payload:${violation.keyword}/claims/${claimIndex}/payload${violation.pointer}`);
      }
    });
  }
  return violations;
}

describe("the published schemas", () => {
  it("are the ones the spec's appendices publish", () => {
    expect(envelopeSchema["$id"]).toBe("delivery-evidence/1/envelope");
    expect(payloadSchema["$id"]).toBe("review.green/1/payload");
  });

  it("reject exactly the maintained list of vectors, and the list is not empty", () => {
    expect(SCHEMA_FAILING_VECTORS.length).toBeGreaterThan(0);
    const failing = vectors.filter((vector) => schemaViolations(vector).length > 0).map((vector) => vector.id);
    expect([...failing].sort()).toEqual([...SCHEMA_FAILING_VECTORS].sort());
  });

  it("accept every accept vector", () => {
    const accepts = index.vectors.filter((entry) => entry.expect.result === "accepted");
    expect(accepts).toHaveLength(8);
    for (const entry of accepts) {
      const vector = vectors.find((candidate) => candidate.id === entry.id);
      expect(schemaViolations(vector as KitVector), entry.id).toEqual([]);
    }
  });

  it("accept a vector the validator rejects on a cross-field rule alone", () => {
    const vector = vectors.find((candidate) => candidate.id === CROSS_FIELD_ONLY_VECTOR) as KitVector;
    expect(schemaViolations(vector)).toEqual([]);
    const outcome = evaluateVector(vector, kitConfig, environment);
    expect(outcome.accepted).toBe(false);
    expect(outcome.codes).toContain("invalid_cost");
  });

  it("split the same code across the boundary in both directions", () => {
    // invalid_cost: one shape violation, one relationship the schema cannot see.
    expect(SCHEMA_FAILING_VECTORS).toContain("rg-10-cost-negative-total");
    expect(SCHEMA_FAILING_VECTORS).not.toContain("rg-10-cost-by-reviewer-exceeds-total");
    // unsupported_attestation: an unknown level fails the schema, an enumerated
    // level this version does not implement passes it.
    expect(SCHEMA_FAILING_VECTORS).toContain("env-12-unknown-attestation-level");
    expect(SCHEMA_FAILING_VECTORS).not.toContain("env-8-repository-required");
  });
});

describe("the schema evaluator", () => {
  it("refuses a keyword it does not implement rather than ignoring it", () => {
    // The failure mode this evaluator cannot afford: silently reporting a pass
    // for a constraint it never applied.
    expect(() => validateAgainstSchema({ type: "string", contentEncoding: "base64" }, "x")).toThrow(/unsupported/);
  });

  it("refuses a $ref carrying constraints beside it, rather than dropping them", () => {
    // A sibling constraint next to $ref applies in 2020-12. Silently resolving
    // through it would report a pass for a constraint never applied — the same
    // failure the unsupported-keyword throw exists to prevent.
    expect(() => validateAgainstSchema({ $ref: "#/$defs/x", type: "string", $defs: { x: { type: "number" } } }, 1)).toThrow(/sibling/);
  });

  it("allows the metadata keywords that carry no constraint beside a $ref", () => {
    expect(validateAgainstSchema({ $ref: "#/$defs/x", title: "t", description: "d", $defs: { x: { type: "string" } } }, "a")).toEqual([]);
  });

  it("evaluates boolean subschemas as the schemas they are", () => {
    // `true` admits anything, `false` admits nothing — wherever a subschema is
    // allowed. Treating `true` as "no schema here" would fall through to
    // additionalProperties and invent a violation.
    expect(validateAgainstSchema({ type: "object", additionalProperties: false, properties: { a: true } }, { a: 1 })).toEqual([]);
    expect(validateAgainstSchema({ type: "object", properties: { a: false } }, { a: 1 })).toHaveLength(1);
    expect(validateAgainstSchema({ type: "object", additionalProperties: true }, { a: 1 })).toEqual([]);
    expect(validateAgainstSchema({ type: "array", items: true }, [1, "two"])).toEqual([]);
    expect(validateAgainstSchema({ type: "array", items: false }, [1])).toHaveLength(1);
  });

  it("finds the violations it claims to find", () => {
    expect(validateAgainstSchema({ type: "object", additionalProperties: false, properties: {} }, { extra: 1 })).toHaveLength(1);
    expect(validateAgainstSchema({ type: "array", uniqueItems: true }, ["a", "a"])).toHaveLength(1);
    expect(validateAgainstSchema({ type: ["string", "null"], minLength: 1 }, null)).toEqual([]);
  });
});
