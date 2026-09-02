/**
 * GOLDEN VECTORS: the proof surface of the `run-event/1` contract.
 *
 * `vectors/run-events.json` carries hand-authored accept and reject vectors
 * for every kind in the v1 vocabulary, plus the envelope-level vectors that
 * belong to no single kind. The vectors are claims about the closed contract —
 * the implementation must match them, never the other way around. Every kind
 * must carry at least one accept and one reject vector, and every reject
 * vector's expected codes must all be reported, so a grammar that silently
 * opens (or a validator that silently vanishes) goes red here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUN_EVENT_KINDS, validateRunEvent } from "./run-event.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Vector {
  readonly name: string;
  readonly codes?: readonly string[];
  readonly value: unknown;
}

interface KindVectors {
  readonly kind: string;
  readonly accept: readonly Vector[];
  readonly reject: readonly Vector[];
}

const doc = JSON.parse(readFileSync(path.join(HERE, "vectors", "run-events.json"), "utf8")) as {
  kinds: readonly KindVectors[];
  envelope: { accept: readonly Vector[]; reject: readonly Vector[] };
};

const expectAccepted = (vector: Vector): void => {
  const verdict = validateRunEvent(vector.value);
  expect(verdict, `${vector.name}: ${JSON.stringify(verdict)}`).toEqual({ ok: true });
};

const expectRejected = (vector: Vector): void => {
  const verdict = validateRunEvent(vector.value);
  expect(verdict.ok, vector.name).toBe(false);
  if (verdict.ok) return;
  const reported = verdict.rejections.map((rejection) => rejection.code);
  for (const code of vector.codes ?? []) {
    expect(reported, `${vector.name} should report ${code}; reported ${reported.join(", ")}`).toContain(code);
  }
};

describe("the run-event/1 golden vectors", () => {
  it("cover every kind in the v1 vocabulary with at least one accept and one reject vector", () => {
    expect(doc.kinds.map((entry) => entry.kind)).toEqual([...RUN_EVENT_KINDS]);
    for (const entry of doc.kinds) {
      expect(entry.accept.length, `${entry.kind} has no accept vector`).toBeGreaterThan(0);
      expect(entry.reject.length, `${entry.kind} has no reject vector`).toBeGreaterThan(0);
    }
  });

  for (const entry of doc.kinds) {
    describe(entry.kind, () => {
      for (const vector of entry.accept) it(`accepts ${vector.name}`, () => expectAccepted(vector));
      for (const vector of entry.reject) it(`rejects ${vector.name}`, () => expectRejected(vector));
    });
  }

  describe("the envelope", () => {
    for (const vector of doc.envelope.accept) it(`accepts ${vector.name}`, () => expectAccepted(vector));
    for (const vector of doc.envelope.reject) it(`rejects ${vector.name}`, () => expectRejected(vector));
  });
});
