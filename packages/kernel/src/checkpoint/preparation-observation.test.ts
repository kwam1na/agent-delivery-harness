import { expect, it } from "vitest";
import { validateRunEvent } from "./run-event.ts";

function completion(preparation?: unknown, outcome = "ok", command = "prepare", version = "run-event/2") {
  return { version, ...(version === "run-event/2" ? { eventId: "completion" } : {}), runId: "run-test", seq: 1,
    at: "2026-09-10T00:00:00Z", repo: { commonDir: "/tmp/repo/.git" }, kind: "command.completed", actor: { role: "cli" }, attestation: "self",
    payload: { command, outcome, durationMs: 1, ...(preparation === undefined ? {} : { preparation }) } };
}
it.each([
  { checks: "executed", reason: "ordinary" },
  { checks: "executed", reason: "receipt-not-reusable" },
  { checks: "executed", reason: "preparation-fingerprint-changed" },
  { checks: "reused", reason: "validation-equivalent" },
])("accepts a product preparation observation %j", observation => {
  expect(validateRunEvent(completion(observation)).ok).toBe(true);
});
it.each([
  { checks: "reused", reason: "ordinary" },
  { checks: "executed", reason: "validation-equivalent" },
  { checks: "reused", reason: "estimated" },
  { checks: "reused" },
  { checks: "reused", reason: "validation-equivalent", passed: true },
])("refuses contradictory or malformed preparation %j", observation => {
  expect(validateRunEvent(completion(observation)).ok).toBe(false);
});
it.each(["policy", "interrupted", "usage"])("refuses successful preparation on %s completion", outcome => {
  expect(validateRunEvent(completion({ checks: "reused", reason: "validation-equivalent" }, outcome)).ok).toBe(false);
});
it("preserves the v1 contract and allows absent legacy observations in both versions", () => {
  expect(validateRunEvent(completion({ checks: "reused", reason: "validation-equivalent" }, "ok", "prepare", "run-event/1")).ok).toBe(false);
  expect(validateRunEvent(completion(undefined, "ok", "prepare", "run-event/1")).ok).toBe(true);
  expect(validateRunEvent(completion()).ok).toBe(true);
  expect(validateRunEvent(completion({ checks: "reused", reason: "validation-equivalent" }, "ok", "gate")).ok).toBe(false);
});
