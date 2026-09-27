import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "./run-store.ts";
import { validateRunEventInput, type RunEventInput, type RunEventKind } from "./run-event.ts";
import { reconciliationActions } from "../spine/run-action-reconciliation.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "action-reconciliation-")); dirs.push(dir);
  const store = createRunStore(dir);
  const allocated = await store.allocate(); if (!allocated.ok) throw Error("allocation failed");
  const runId = allocated.runId;
  const event = (id: string, kind: RunEventKind, payload: Record<string, unknown>): RunEventInput => ({
    version: "run-event/2", eventId: id, runId, at: "2026-09-27T10:00:00Z", repo: { commonDir: dir },
    actor: { role: "executor" }, attestation: "self", kind, payload,
  });
  const append = (e: RunEventInput) => store.append(runId, e);
  expect((await append(event("start", "run.started", { host: "codex", workflow: { releaseId: "test", profile: "linear" } }))).ok).toBe(true);
  const history = async () => { const r = await store.read(runId); if (!r.ok) throw Error(JSON.stringify(r)); return r.events; };
  const observed = (id: string, outcome = "succeeded", reference = "repo/pr/851", actionId = "push-1") => event(id, "action.observed", { actionId, outcome, reference });
  const reconcile = async (id = "reconcile") => {
    const action = reconciliationActions(await history())[0]!;
    return event(id, "action.reconciled", { actionId: action.actionId, historyDigest: action.historyDigest, observedReference: action.reference,
      outcome: "succeeded", evidenceReference: "https://github.com/example/repo/pull/851", reason: "Host verified exact merged head and timestamp." });
  };
  const file = path.join(dir, "managed-delivery/runs", `${runId}.jsonl`);
  return { store, runId, event, append, history, observed, reconcile, file };
}

it("preserves exact prefix bytes, acknowledges orphan once and retains host evidence", async () => {
  const f = await fixture(); await f.append(f.observed("orphan"));
  const prefix = await readFile(f.file, "utf8"); const e = await f.reconcile();
  expect((await f.append(e)).ok).toBe(true);
  expect((await readFile(f.file, "utf8")).startsWith(prefix)).toBe(true);
  expect((await f.append(e)).ok).toBe(true);
  const events = await f.history(); expect(events).toHaveLength(3);
  expect(reconciliationActions(events)).toMatchObject([{ inconsistent: false, outcome: "succeeded", reconciliation: { eventId: "reconcile", evidenceReference: e.payload["evidenceReference"] } }]);
  expect(events.filter(e => e.kind === "action.intent")).toHaveLength(0);
});

it.each(["history", "reference", "action", "unknown", "extra", "v1", "evidence", "reason"])("refuses %s mismatch without modifying the journal", async variant => {
  const f = await fixture(); await f.append(f.observed("orphan")); let e = await f.reconcile();
  const before = await readFile(f.file, "utf8");
  if (variant === "v1") { const { eventId: _, ...rest } = e; e = { ...rest, version: "run-event/1" }; }
  else { const field = { history: "historyDigest", reference: "observedReference", action: "actionId", unknown: "outcome", extra: "force", evidence: "evidenceReference", reason: "reason" }[variant]!;
    e = { ...e, payload: { ...e.payload, [field]: variant === "history" ? "0".repeat(64) : ["evidence", "reason"].includes(variant) ? "" : "wrong" } }; }
  expect((await f.append(e)).ok).toBe(false);
  expect(await readFile(f.file, "utf8")).toBe(before);
  expect(reconciliationActions(await f.history())[0]?.inconsistent).toBe(true);
});

it("rejects stale history after an identical later observation and binds the run", async () => {
  const f = await fixture(); await f.append(f.observed("orphan")); const stale = await f.reconcile();
  await f.append(f.observed("later")); expect((await f.append(stale)).ok).toBe(false);
  const other = await fixture(); await other.append(other.observed("orphan"));
  expect((await other.append({ ...stale, runId: other.runId, repo: { commonDir: path.dirname(path.dirname(path.dirname(other.file))) } })).ok).toBe(false);
});

it("serializes competing acknowledgements and accepts only one current history", async () => {
  const f = await fixture(); await f.append(f.observed("orphan")); const a = await f.reconcile("a"), b = await f.reconcile("b");
  const results = await Promise.all([f.append(a), f.append(b)]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect((await f.history()).filter(e => e.kind === "action.reconciled")).toHaveLength(1);
});

it.each(["outcome", "reference", "intent"])("reblocks a later conflicting %s and permits a newly bound acknowledgement", async variant => {
  const f = await fixture(); await f.append(f.observed("orphan")); const old = await f.reconcile(); await f.append(old);
  const conflict = variant === "intent" ? f.event("later", "action.intent", { actionId: "push-1", operation: "push", reference: "repo/pr/851" })
    : f.observed("later", variant === "outcome" ? "failed" : "succeeded", variant === "reference" ? "repo/pr/852" : "repo/pr/851");
  expect((await f.append(conflict)).ok).toBe(true);
  expect(reconciliationActions(await f.history())[0]?.inconsistent).toBe(true);
  expect((await f.append(old)).ok).toBe(true); // transport retry must not reapply the historical acknowledgement
  expect(reconciliationActions(await f.history())[0]?.inconsistent).toBe(true);
  expect((await f.append({ ...old, eventId: "stale-copy" })).ok).toBe(false);
  expect((await f.append(await f.reconcile("fresh"))).ok).toBe(true);
  expect(reconciliationActions(await f.history())[0]?.inconsistent).toBe(false);
});

it("reconciles contradictory terminal observations but never an absent or consistent action", async () => {
  const f = await fixture();
  await f.append(f.event("intent", "action.intent", { actionId: "push-1", operation: "push", reference: "repo/pr/851" }));
  expect((await f.append(await f.reconcile())).ok).toBe(false);
  await f.append(f.observed("failed", "failed"));
  expect((await f.append(await f.reconcile())).ok).toBe(false);
  await f.append(f.observed("success")); expect((await f.append(await f.reconcile())).ok).toBe(true);
  expect(reconciliationActions(await f.history())[0]?.operation).toBe("push");
});

it("ignores unrelated observations for binding and never repairs another action", async () => {
  const f = await fixture(); await f.append(f.observed("orphan")); const e = await f.reconcile();
  await f.append(f.observed("other", "failed", "repo/pr/852", "push-2"));
  await f.append(f.event("note", "decision.recorded", { fork: "inspection", choice: "external state checked" }));
  expect((await f.append(e)).ok).toBe(true);
  expect(reconciliationActions(await f.history()).map(a => a.inconsistent)).toEqual([false, true]);
});

it("fails closed on a tampered reconciliation at read and reduction", async () => {
  const f = await fixture(); await f.append(f.observed("orphan")); await f.append(await f.reconcile());
  const events = await f.history(); const invalid = events.map(e => e.kind === "action.reconciled" ? { ...e, payload: { ...e.payload, historyDigest: "0".repeat(64) } } : e);
  expect(reconciliationActions(invalid)[0]?.inconsistent).toBe(true);
  await writeFile(f.file, invalid.map(e => JSON.stringify(e)).join("\n") + "\n");
  expect((await f.store.read(f.runId)).ok).toBe(false);
});

it("rejects credentials in structural evidence and refuses unknown outcome at grammar boundary", async () => {
  const f = await fixture(); await f.append(f.observed("orphan")); const e = await f.reconcile();
  expect(validateRunEventInput({ ...e, payload: { ...e.payload, outcome: "unknown" } }).ok).toBe(false);
  expect((await f.append({ ...e, payload: { ...e.payload, evidenceReference: "https://user:password@example.com/pr/851" } })).ok).toBe(false);
});
