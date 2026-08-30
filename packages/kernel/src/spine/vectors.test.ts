/**
 * GOLDEN VECTORS: the proof surface of the frozen spine.
 *
 * `vectors/spine-families.json` carries hand-authored accept and reject
 * vectors for every frozen contract family, including one golden journal
 * entry per active (journal, kind) pair. The vectors are claims about the
 * frozen grammar — the implementation must match them, never the other way
 * around. Every family must carry at least one accept and one reject vector,
 * and every reject vector's expected codes must all be reported, so a grammar
 * that silently opens (or a validator that silently vanishes) goes red here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateCapabilityDescriptor, validateSensorResult } from "./capability.ts";
import { validateCompositionPin, validateProductTrustState } from "./composition.ts";
import { validateOperatorConfirmation } from "./confirmation.ts";
import { validateAcceptedContract, validateOutcomeVerification } from "./contract.ts";
import { validateFinishLineResult } from "./finish-line.ts";
import { validateExecutionGrant, validateGrantAttestation } from "./grant.ts";
import { validateInvocationFence, validateReviewerAttempt } from "./invocation.ts";
import { validateJournalEntry } from "./journal.ts";
import { validatePolicySnapshot } from "./policy.ts";
import type { SpineVerdict } from "./grammar.ts";
import { EVENT_VOCABULARY } from "./vocabulary.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const VALIDATORS: Record<string, (value: unknown) => SpineVerdict> = {
  "journal-entry": validateJournalEntry,
  "product-composition-pin": validateCompositionPin,
  "product-trust-state": validateProductTrustState,
  "scoped-delivery-contract": validateAcceptedContract,
  "outcome-verification": validateOutcomeVerification,
  "policy-snapshot": validatePolicySnapshot,
  "invocation-fence": validateInvocationFence,
  "reviewer-attempt": validateReviewerAttempt,
  "execution-grant": validateExecutionGrant,
  "grant-attestation": validateGrantAttestation,
  "operator-confirmation": validateOperatorConfirmation,
  "capability-descriptor": validateCapabilityDescriptor,
  "sensor-result": validateSensorResult,
  "finish-line-result": validateFinishLineResult,
};

interface Vector {
  readonly name: string;
  readonly verdict: "accept" | "reject";
  readonly codes?: readonly string[];
  readonly value: unknown;
}

interface FamilyVectors {
  readonly family: string;
  readonly vectors: readonly Vector[];
}

const doc = JSON.parse(readFileSync(path.join(HERE, "vectors", "spine-families.json"), "utf8")) as {
  families: readonly FamilyVectors[];
};

describe("the spine golden vectors", () => {
  it("cover every frozen family with at least one accept and one reject vector", () => {
    const covered = doc.families.map((entry) => entry.family).sort();
    expect(covered).toEqual(Object.keys(VALIDATORS).sort());
    for (const family of doc.families) {
      expect(
        family.vectors.some((vector) => vector.verdict === "accept"),
        `${family.family} has no accept vector`,
      ).toBe(true);
      expect(
        family.vectors.some((vector) => vector.verdict === "reject"),
        `${family.family} has no reject vector`,
      ).toBe(true);
    }
  });

  it("carry one golden journal entry per active (journal, kind) pair", () => {
    const journalFamily = doc.families.find((entry) => entry.family === "journal-entry");
    const accepted = (journalFamily?.vectors ?? []).filter((vector) => vector.verdict === "accept");
    const acceptedPairs = new Set(
      accepted.map((vector) => {
        const value = vector.value as { journal: string; kind: string };
        return `${value.journal}/${value.kind}`;
      }),
    );
    for (const entry of EVENT_VOCABULARY) {
      if (entry.status !== "active") continue;
      expect(acceptedPairs.has(`${entry.journal}/${entry.kind}`), `${entry.journal}/${entry.kind}`).toBe(true);
    }
  });

  for (const family of doc.families) {
    describe(family.family, () => {
      for (const vector of family.vectors) {
        it(`${vector.verdict}s ${vector.name}`, () => {
          const validate = VALIDATORS[family.family];
          expect(validate, `no validator for ${family.family}`).toBeDefined();
          const verdict = (validate as (value: unknown) => SpineVerdict)(vector.value);
          if (vector.verdict === "accept") {
            expect(verdict).toEqual({ ok: true });
            return;
          }
          expect(verdict.ok).toBe(false);
          if (verdict.ok) return;
          const reported = verdict.rejections.map((rejection) => rejection.code);
          for (const code of vector.codes ?? []) {
            expect(reported, `${vector.name} should report ${code}; reported ${reported.join(", ")}`).toContain(code);
          }
        });
      }
    });
  }
});
