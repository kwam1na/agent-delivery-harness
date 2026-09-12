import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AttemptStore } from "./scoped-attempts.ts";
import type { ScopedCheckAttempt } from "@agent-delivery-harness/kernel";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const input = { version: "scoped-attempt/1", providerId: "check.a", inputDigest: "a".repeat(64), profileDigest: "b".repeat(64), origin: { candidate: { treeSha: "a".repeat(40), deliverableDigest: "b".repeat(64), identityToken: "git-tree/v1", baseRef: "origin/main", baseTipSha: "c".repeat(40), mergeBaseSha: "c".repeat(40), workspaceId: "workspace" }, runId: "run" } } as Omit<ScopedCheckAttempt, "attemptId" | "generation" | "status">;
it("allocates concurrent generations before execution, retaining failed and running attempts ahead of old success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scoped-attempt-test-")); dirs.push(root);
  const store = new AttemptStore(root);
  const [a, b] = await Promise.all([store.allocate(input), store.allocate(input)]);
  expect(new Set([a.generation, b.generation])).toEqual(new Set([1, 2]));
  const old = a.generation < b.generation ? a : b, latest = old === a ? b : a;
  await store.finish(old, "passed", { outputs: [] });
  expect((await store.read()).map(a => a.attempt.status)).toEqual(["passed", "running"]);
  await store.finish(latest, "failed", { outputs: [] });
  expect((await store.read()).map(a => a.attempt.status)).toEqual(["passed", "failed"]);
  await expect(store.finish(latest, "passed", { outputs: [] })).rejects.toThrow();
});
it("refuses corrupt attempt storage rather than treating it as no evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scoped-attempt-test-")); dirs.push(root);
  const store = new AttemptStore(root); await store.allocate(input);
  await writeFile(path.join(root, "1", "running.json"), "{}");
  await expect(store.read()).rejects.toThrow();
});
it("rejects a meaningful payload edit even when the attempt shape stays valid", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "scoped-attempt-test-")); dirs.push(root);
  const store = new AttemptStore(root); await store.allocate(input);
  const file = path.join(root, "1/running.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.attempt.inputDigest = "c".repeat(64); await writeFile(file, JSON.stringify(row));
  await expect(store.read()).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
it.each(["version", "providerId", "attemptId", "generation", "inputDigest", "profileDigest", "origin.runId", ...["treeSha", "deliverableDigest", "identityToken", "baseRef", "baseTipSha", "mergeBaseSha", "workspaceId"].map(k => `origin.candidate.${k}`)])("rejects terminal %s drift with a recomputed checksum", async member => {
  const { readFile } = await import("node:fs/promises");
  const { digestCanonical } = await import("@agent-delivery-harness/kernel");
  const root = await mkdtemp(path.join(tmpdir(), "scoped-attempt-test-")); dirs.push(root);
  const store = new AttemptStore(root), attempt = await store.allocate(input);
  await store.finish(attempt, "passed", { outputs: [] });
  const file = path.join(root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  const keys = member.split("."), last = keys.pop()!;
  const target = keys.reduce((obj, key) => obj[key], row.entry.attempt);
  target[last] = member === "generation" ? 2 : "different";
  row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(store.read()).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
