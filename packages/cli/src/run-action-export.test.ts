import { expect, it } from "vitest";
import { digestCanonical, type RunEvent } from "@agent-delivery-harness/kernel";
import { buildRunExport, parseRunExport } from "./run-export.ts";

function events(): RunEvent[] {
  const base = { version: "run-event/2" as const, runId: "run-fixture", at: "2026-09-27T00:00:00Z", repo: { commonDir: "/repo/.git" }, actor: { role: "executor" as const }, attestation: "self" as const };
  const orphan: RunEvent = { ...base, seq: 2, eventId: "orphan", kind: "action.observed", payload: { actionId: "push-1", outcome: "succeeded", reference: "repo/pr/851" } };
  return [
    { ...base, seq: 1, eventId: "start", kind: "run.started", payload: { host: "codex", workflow: { releaseId: "test", profile: "linear" } } },
    orphan,
    { ...base, seq: 3, eventId: "reconcile", kind: "action.reconciled", payload: { actionId: "push-1", historyDigest: digestCanonical([orphan]), observedReference: "repo/pr/851", outcome: "succeeded", evidenceReference: "https://github.com/example/repo/pull/851", reason: "Host inspected exact remote result." } },
  ];
}

it("imports a valid retained acknowledgement and the original history", () => {
  const original = events();
  const result = parseRunExport(JSON.stringify(buildRunExport({ runId: "run-fixture", events: original })));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.events).toEqual(original);
});

it.each(["digest", "reference", "absent-action", "history-time"])("refuses %s mismatch even when all export projections are recomputed", variant => {
  const history = events(); const acknowledgement = history[2]!;
  if (variant === "history-time") history[1] = { ...history[1]!, at: "2026-09-27T00:00:01Z" };
  else history[2] = { ...acknowledgement, payload: { ...acknowledgement.payload,
    ...(variant === "digest" ? { historyDigest: "0".repeat(64) } : variant === "reference" ? { observedReference: "repo/pr/852" } : { actionId: "absent" }) } };
  expect(parseRunExport(JSON.stringify(buildRunExport({ runId: "run-fixture", events: history })))).toEqual({ ok: false, code: "run_export_invalid" });
});
