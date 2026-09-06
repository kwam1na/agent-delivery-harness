import { describe, expect, it } from "vitest";
import { validateRunEventInput } from "./run-event.ts";

const event = (kind: string, payload: Record<string, unknown>) => ({
  version: "run-event/1", runId: "run-test", at: "2026-09-06T00:00:00Z",
  repo: { commonDir: "/repo/.git" }, actor: { role: "executor" }, attestation: "self", kind, payload,
});

describe("ordinary recovery observations", () => {
  it("records an outcome without inventing measured cost", () => {
    expect(validateRunEventInput(event("run.ended", { result: "partial", cost: { coverage: "unreported", reportedBy: "codex" } }))).toEqual({ ok: true });
    expect(validateRunEventInput(event("run.ended", { result: "partial", cost: { coverage: "partial", unit: "tokens", total: 12, reportedBy: "host" } }))).toEqual({ ok: true });
    expect(validateRunEventInput(event("run.ended", { result: "partial", cost: { coverage: "unreported", total: 0, reportedBy: "codex" } })).ok).toBe(false);
  });
  it("records reconciliation references without accepting executable commands", () => {
    expect(validateRunEventInput(event("action.intent", { actionId: "pr-1", operation: "pr-create", reference: "repo/branch:codex/example" }))).toEqual({ ok: true });
    expect(validateRunEventInput(event("action.observed", { actionId: "pr-1", outcome: "succeeded", reference: "https://github.com/org/repo/pull/1" }))).toEqual({ ok: true });
    expect(validateRunEventInput(event("action.intent", { actionId: "pr-1", operation: "pr-create", reference: "repo/branch", command: "gh pr create" })).ok).toBe(false);
  });
});
