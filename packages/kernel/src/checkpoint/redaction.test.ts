/**
 * The secret-rejection/redaction corpus for the durable protection lifecycle:
 * secret-like values are redacted inside the spine's bounded free-text
 * members (`summary`, `reason`) and rejected anywhere else, BEFORE any byte
 * becomes durable. The corpus is deliberately high-precision — each pattern
 * names a concrete credential shape — because a false positive here blocks a
 * legitimate audit record.
 *
 * Written RED before `redaction.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS, applySecretDiscipline, redactSecretText } from "./redaction.ts";

const CORPUS: readonly { readonly id: string; readonly sample: string }[] = [
  { id: "aws-access-key-id", sample: "AKIAIOSFODNN7EXAMPLE" },
  { id: "github-token", sample: "ghp_0123456789abcdefghijklmnopqrstuvwxyz12" },
  { id: "github-fine-grained-token", sample: "github_pat_11ABCDEFG0123456789_abcdefghij" },
  // Assembled at runtime so forge-side push protection never mistakes the
  // synthetic corpus fixture for a live credential.
  { id: "slack-token", sample: ["xoxb", "123456789012", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("-") },
  { id: "openai-key", sample: "sk-proj0123456789abcdefghij" },
  { id: "google-api-key", sample: "AIzaSyA0123456789abcdefghijklmnopqrstuv" },
  { id: "jwt", sample: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4" },
  { id: "bearer-credential", sample: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" },
  {
    id: "private-key-block",
    sample: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----",
  },
];

const CLEAN: readonly string[] = [
  "the sensor failed with exit code 1",
  "refs/heads/kwamina0x00/v26-1475-add-durable-delivery-checkpoints",
  "sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa recomputed clean",
  "a skeleton greeting: hello, skeleton",
  "task-1 paused at fence 2; resume via takeover",
];

describe("the secret corpus", () => {
  it("redacts every corpus sample out of free text, naming the pattern", () => {
    for (const { id, sample } of CORPUS) {
      const outcome = redactSecretText(`prefix ${sample} suffix`);
      expect(outcome.redacted, id).toContain(id);
      expect(outcome.text, id).not.toContain(sample.split("\n")[0] as string);
      expect(outcome.text, id).toContain(`[redacted:${id}]`);
    }
  });

  it("leaves clean audit prose untouched — high precision, no dumping-ground erasure", () => {
    for (const sample of CLEAN) {
      const outcome = redactSecretText(sample);
      expect(outcome.redacted, sample).toHaveLength(0);
      expect(outcome.text, sample).toBe(sample);
    }
  });

  it("names every pattern with a stable id", () => {
    const ids = SECRET_PATTERNS.map((pattern) => pattern.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { id } of CORPUS) expect(ids).toContain(id);
  });
});

describe("applySecretDiscipline over a journal entry", () => {
  const entry = (payload: Record<string, unknown>): Record<string, unknown> => ({
    spec: "journal-entry/1",
    journal: "delivery",
    subjectId: "dlv-1",
    expectedRevision: 1,
    idempotencyKey: "e1-blocker.recorded",
    kind: "blocker.recorded",
    payload,
  });

  it("redacts free-text members in place and reports what it redacted", () => {
    const outcome = applySecretDiscipline(
      entry({ code: "sensor.failure", summary: "output held AKIAIOSFODNN7EXAMPLE" }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const disciplined = outcome.entry as { payload: { summary: string } };
    expect(disciplined.payload.summary).toContain("[redacted:aws-access-key-id]");
    expect(outcome.redactions).toContain("aws-access-key-id");
  });

  it("rejects a secret anywhere outside the free-text members, pointing at the member", () => {
    const outcome = applySecretDiscipline(entry({ code: "AKIAIOSFODNN7EXAMPLE", summary: "clean" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.matches[0]?.pointer).toBe("/payload/code");
    expect(outcome.matches[0]?.id).toBe("aws-access-key-id");
  });

  it("keeps a bounded free-text member bounded when redaction tokens grow it — redaction never turns a valid value invalid", () => {
    // Candidate-crafted sensor output: a near-bound summary stuffed with
    // credential shapes whose redaction tokens are longer than the originals.
    const keys = Array.from({ length: 13 }, () => "AKIAIOSFODNN7EXAMPLE").join(" x ");
    const summary = `${keys} ${"pad".repeat(Math.max(0, Math.floor((1900 - keys.length) / 3)))}`.slice(0, 1900);
    expect(summary.length).toBeLessThanOrEqual(2000);
    const outcome = applySecretDiscipline(entry({ code: "sensor.failure", summary }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const disciplined = outcome.entry as { payload: { summary: string } };
    expect(disciplined.payload.summary.length).toBeLessThanOrEqual(2000);
    expect(disciplined.payload.summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("passes a clean entry through byte-identical", () => {
    const value = entry({ code: "sensor.failure", summary: "exit code 1" });
    const outcome = applySecretDiscipline(value);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entry).toEqual(value);
    expect(outcome.redactions).toHaveLength(0);
  });
});
