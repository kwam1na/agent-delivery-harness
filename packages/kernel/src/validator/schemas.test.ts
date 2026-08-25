/**
 * The published JSON Schemas are the spec's, byte for byte.
 *
 * Appendices A and B are normative shape. Publishing a copy of them is only
 * useful if the copy cannot drift, so the copy is compared against the vendored
 * spec text itself — not against a paraphrase, and not merely by parsed value:
 * the file content and the appendix's fenced block are the same bytes.
 *
 * Where the schemas are exercised *against the corpus* is the conformance
 * package, because that check is keyed by vector id and the vectors live there.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DELIVERY_EVIDENCE_1, REVIEW_GREEN_1 } from "./codes.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.join(HERE, "..", "..", "..", "..", "docs", "spec", "delivery-evidence-1.md");

function specJsonBlocks(): readonly string[] {
  const spec = readFileSync(SPEC_PATH, "utf8");
  return [...spec.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] as string);
}

function published(name: string): string {
  return readFileSync(path.join(HERE, "schemas", name), "utf8");
}

describe("the published schemas", () => {
  const blocks = specJsonBlocks();

  it("are the spec's appendix blocks verbatim", () => {
    const envelope = blocks.find((block) => block.includes(`"$id": "${DELIVERY_EVIDENCE_1}/envelope"`));
    const payload = blocks.find((block) => block.includes(`"$id": "${REVIEW_GREEN_1}/payload"`));
    expect(envelope, "Appendix A block").toBeDefined();
    expect(payload, "Appendix B block").toBeDefined();
    expect(published("envelope.schema.json")).toBe(envelope);
    expect(published("review-green.schema.json")).toBe(payload);
  });

  it("parse, and declare draft 2020-12", () => {
    for (const name of ["envelope.schema.json", "review-green.schema.json"]) {
      const schema = JSON.parse(published(name)) as Record<string, unknown>;
      expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema["additionalProperties"]).toBe(false);
    }
  });

  it("close both grammars, which is what makes GEN-1 expressible in shape as well as in code", () => {
    const envelope = JSON.parse(published("envelope.schema.json")) as Record<string, unknown>;
    const properties = envelope["properties"] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "artifacts",
      "attestation",
      "candidate",
      "claims",
      "provider",
      "recordedAt",
      "repository",
      "runHistory",
      "spec",
    ]);
  });
});
