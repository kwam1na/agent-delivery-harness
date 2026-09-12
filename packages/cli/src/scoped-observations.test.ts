import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { digestCanonical, resolveRecordStorage, type HarnessConfig, type ScopedCheckAttempt } from "@agent-delivery-harness/kernel";
import { AttemptStore } from "./scoped-attempts.ts";
import { readScopedCheckObservations } from "./index.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "scoped-observations-")); dirs.push(rootDir);
  execFileSync("git", ["init", "-q"], { cwd: rootDir });
  const config = { gateId: "test.gate", storageNamespace: "observations/", providers: ["a", "b"].map(id => ({ id: `check.${id}`, findingCodes: [], check: { command: ["true"], timeoutMs: 1000, scope: { version: "scoped-check/1", files: [], memberships: [], tests: [], cwd: ".", profile: "test", environment: [] } } })) } as Pick<HarnessConfig, "gateId" | "storageNamespace" | "providers">;
  const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace, leaf: "scoped-attempts" });
  const store = (id: string) => new AttemptStore(path.join(storage.storageDir, digestCanonical({ gate: config.gateId, provider: id })));
  const input = (providerId: string) => ({ version: "scoped-attempt/1", providerId, inputDigest: "a".repeat(64), profileDigest: "b".repeat(64), origin: { candidate: { treeSha: "a".repeat(40), deliverableDigest: "b".repeat(64), identityToken: "git-tree/v1", baseRef: "origin/main", baseTipSha: "c".repeat(40), mergeBaseSha: "c".repeat(40), workspaceId: "workspace" }, runId: "run" } }) as Omit<ScopedCheckAttempt, "attemptId" | "generation" | "status">;
  return { rootDir, config, store, input, storage };
}
it("reads absent history without creating storage", async () => {
  const f = await fixture(); const before = await readdir(path.join(f.rootDir, ".git"));
  expect(await readScopedCheckObservations(f)).toEqual({ version: "scoped-check-observations/1", providers: [{ providerId: "check.a", attempts: [] }, { providerId: "check.b", attempts: [] }] });
  expect(await readdir(path.join(f.rootDir, ".git"))).toEqual(before);
});
it("retains ordered native statuses and durations, separates providers and exposes no payload", async () => {
  const f = await fixture(); const a = f.store("check.a"), b = f.store("check.b");
  for (const [index, status] of (["passed", "failed", "interrupted"] as const).entries()) {
    const attempt = await a.allocate(f.input("check.a"));
    await a.finish(attempt, status, { durationMs: index + 10, outputs: [{ path: "secret.json", base64: "private", sha256: "private" }], log: "secret sentinel" });
  }
  await a.allocate(f.input("check.a")); const other = await b.allocate(f.input("check.b")); await b.finish(other, "failed", { outputs: [], durationMs: 0 });
  const result = await readScopedCheckObservations(f);
  expect(result.providers[0]!.attempts.map(row => [row.generation, row.status, row.durationMs])).toEqual([[1, "passed", 10], [2, "failed", 11], [3, "interrupted", 12], [4, "running", undefined]]);
  expect(result.providers[1]!.attempts).toHaveLength(1); expect(result.providers[1]!.attempts[0]!.durationMs).toBe(0);
  expect((await readScopedCheckObservations({ ...f, config: { ...f.config, gateId: "another.gate" } })).providers.every(provider => provider.attempts.length === 0)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/secret|private|payload|outputs|log|applicability|admitted/);
  expect((await readScopedCheckObservations({ ...f, config: { ...f.config, providers: [f.config.providers[1]!] } })).providers.map(row => row.providerId)).toEqual(["check.b"]);
});
it("refuses corrupted selected history instead of presenting an empty result", async () => {
  const f = await fixture(); const store = f.store("check.a"); await store.allocate(f.input("check.a"));
  await writeFile(path.join(store.root, "1/running.json"), "{}");
  await expect(readScopedCheckObservations(f)).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
it("refuses rehashed duration and provider corruption", async () => {
  const f = await fixture(); const store = f.store("check.a"), attempt = await store.allocate(f.input("check.a")); await store.finish(attempt, "failed", { outputs: [], durationMs: 10 });
  const file = path.join(store.root, "1/terminal.json"), original = await readFile(file, "utf8");
  for (const durationMs of [-1, "unknown", null]) {
    const row = JSON.parse(original); row.entry.payload.durationMs = durationMs; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
    await expect(readScopedCheckObservations(f)).rejects.toMatchObject({ code: "check_attempt_corrupt" });
  }
  await writeFile(file, original);
  for (const name of ["running.json", "terminal.json"]) {
    const target = path.join(store.root, "1", name); const row = JSON.parse(await readFile(target, "utf8")); row.entry.attempt.providerId = "check.b"; row.digest = digestCanonical(row.entry); await writeFile(target, JSON.stringify(row));
  }
  await expect(readScopedCheckObservations(f)).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
it.each(["inputDigest", "profileDigest", "origin", "origin.runId", "origin.candidate", ...["treeSha", "deliverableDigest", "identityToken", "baseRef", "baseTipSha", "mergeBaseSha", "workspaceId"].map(key => `origin.candidate.${key}`)])("refuses malformed native %s metadata with a recomputed checksum", async member => {
  const f = await fixture(); const store = f.store("check.a"); await store.allocate(f.input("check.a"));
  const file = path.join(store.root, "1/running.json"); const row = JSON.parse(await readFile(file, "utf8"));
  const keys = member.split("."), last = keys.pop()!; const target = keys.reduce((obj, key) => obj[key], row.entry.attempt);
  target[last] = 17; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(readScopedCheckObservations(f)).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
it("ignores unselected and unscoped provider history and never copies unexpected metadata keys", async () => {
  const f = await fixture(); const store = f.store("check.a"); await store.allocate(f.input("check.a"));
  const file = path.join(store.root, "1/running.json"); const row = JSON.parse(await readFile(file, "utf8")); row.entry.attempt.log = "private"; row.entry.attempt.origin.extra = "secret"; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  expect(JSON.stringify(await readScopedCheckObservations(f))).not.toMatch(/private|secret|extra|log/);
  await writeFile(file, "{}");
  expect((await readScopedCheckObservations({ ...f, config: { ...f.config, providers: [{ id: "check.a", findingCodes: [] }] } })).providers).toEqual([]);
  expect((await readScopedCheckObservations({ ...f, config: { ...f.config, providers: [f.config.providers[1]!] } })).providers).toEqual([{ providerId: "check.b", attempts: [] }]);
});
it("preserves complete native metadata and caller provider order", async () => {
  const f = await fixture();
  const a = await f.store("check.a").allocate({ ...f.input("check.a"), inputDigest: "1".repeat(64), profileDigest: "2".repeat(64), origin: {
    runId: "a-run", candidate: { treeSha: "3".repeat(40), deliverableDigest: "4".repeat(64), identityToken: "identity-a", baseRef: "origin/base-a", baseTipSha: "5".repeat(40), mergeBaseSha: "6".repeat(40), workspaceId: "workspace-a" },
  } });
  const b = await f.store("check.b").allocate({ ...f.input("check.b"), origin: { ...f.input("check.b").origin, runId: "b-run" } });
  await f.store("check.a").finish(a, "failed", { outputs: [], durationMs: 0 });
  expect(await readScopedCheckObservations({ ...f, config: { ...f.config, providers: [f.config.providers[1]!, f.config.providers[0]!] } })).toEqual({
    version: "scoped-check-observations/1", providers: [
      { providerId: "check.b", attempts: [b] },
      { providerId: "check.a", attempts: [{ ...a, status: "failed", durationMs: 0 }] },
    ],
  });
});
it.each([["origin.runId", ""], ["origin.candidate.treeSha", ""], ["inputDigest", "not-a-digest"], ["profileDigest", "A".repeat(64)]])("rejects invalid string %s metadata", async (member, value) => {
  const f = await fixture(); const store = f.store("check.a"); await store.allocate(f.input("check.a"));
  expect((await readScopedCheckObservations(f)).providers[0]!.attempts).toHaveLength(1);
  const file = path.join(store.root, "1/running.json"); const row = JSON.parse(await readFile(file, "utf8"));
  const keys = member.split("."), last = keys.pop()!; const target = keys.reduce((obj, key) => obj[key], row.entry.attempt);
  target[last] = value; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(readScopedCheckObservations(f)).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});
