import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { digestCanonical, resolveRecordStorage, type HarnessConfig, type ScopedCheckAttempt } from "@agent-delivery-harness/kernel";
import { AttemptStore, type AttemptPayload } from "./scoped-attempts.ts";
import { readScopedCheckDiagnostics } from "./index.ts";
import { redactScopedOutput, scopedCommandDiagnostic, scopedDiagnosticFailure } from "./scoped-diagnostics.ts";
import { CheckSnapshotError } from "./check-snapshot.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "scoped-diagnostics-")); roots.push(rootDir);
  execFileSync("git", ["init", "-q"], { cwd: rootDir });
  const config = { gateId: "diagnostics", storageNamespace: "observations/", providers: ["a", "b"].map(id => ({ id, findingCodes: [], check: { command: ["true"], timeoutMs: 1000, scope: { version: "scoped-check/1", files: [], memberships: [], tests: [], cwd: ".", profile: "test", environment: [] } } })) } as Pick<HarnessConfig, "gateId" | "storageNamespace" | "providers">;
  const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace, leaf: "scoped-attempts" });
  const store = (provider: string) => new AttemptStore(path.join(storage.storageDir, digestCanonical({ gate: config.gateId, provider })));
  const input = (providerId: string) => ({ version: "scoped-attempt/1", providerId, inputDigest: "a".repeat(64), profileDigest: "b".repeat(64), origin: { runId: "run", candidate: { treeSha: "a".repeat(40), deliverableDigest: "b".repeat(64), identityToken: "tree/v1", baseRef: "origin/main", baseTipSha: "c".repeat(40), mergeBaseSha: "c".repeat(40), workspaceId: "workspace" } } }) as Omit<ScopedCheckAttempt, "attemptId" | "generation" | "status">;
  return { rootDir, config, store, input };
}
const diagnostic = { availability: "available", phase: "command", failure: { code: "check_command_failed" }, command: { exitCode: 7, outputTail: "assertion failed [REDACTED]", truncated: false } } as const;
it("returns exact requested native bindings and explicit absent, running and legacy states without writes", async () => {
  const f = await fixture(); const a = f.store("a"); const passed = await a.allocate(f.input("a"));
  await a.finish(passed, "passed", { outputs: [], log: "legacy private output", durationMs: 3 });
  const failed = await a.allocate(f.input("a"));
  await a.finish(failed, "failed", { outputs: [{ path: "private", base64: "private", sha256: "private" }], log: "private raw", diagnostic, durationMs: 10 } as AttemptPayload);
  const running = await a.allocate(f.input("a"));
  const before = await readFile(path.join(a.root, "2/terminal.json"));
  const result = await readScopedCheckDiagnostics({ ...f, attemptIds: [running.attemptId, failed.attemptId, passed.attemptId, "missing"] });
  expect(result).toEqual({ version: "scoped-check-diagnostics/1", providers: [
    { providerId: "a", attempts: [
      { ...passed, status: "passed", durationMs: 3, diagnostic: { availability: "unavailable", reason: "legacy" } },
      { ...failed, status: "failed", durationMs: 10, diagnostic },
      { ...running, diagnostic: { availability: "unavailable", reason: "running" } },
    ] }, { providerId: "b", attempts: [] },
  ], unavailableAttemptIds: ["missing"] });
  expect(JSON.stringify(result)).not.toMatch(/private|payload|outputs|admitted|applicability/);
  expect(await readFile(path.join(a.root, "2/terminal.json"))).toEqual(before);
  const only = await readScopedCheckDiagnostics({ ...f, attemptIds: [failed.attemptId] });
  expect(only.providers[0]!.attempts).toHaveLength(1);
});
it("does not create storage for absent or empty requests", async () => {
  const f = await fixture(); const before = await readdir(path.join(f.rootDir, ".git"));
  expect((await readScopedCheckDiagnostics({ ...f, attemptIds: ["missing"] })).unavailableAttemptIds).toEqual(["missing"]);
  expect((await readScopedCheckDiagnostics({ ...f, attemptIds: [] })).unavailableAttemptIds).toEqual([]);
  expect(await readdir(path.join(f.rootDir, ".git"))).toEqual(before);
  const hundred = Array.from({ length: 100 }, (_, i) => `missing-${i}`);
  expect((await readScopedCheckDiagnostics({ ...f, attemptIds: hundred })).unavailableAttemptIds).toEqual(hundred);
});
it.each([["same", "same"], [""], ["x".repeat(129)], Array.from({ length: 101 }, (_, i) => String(i))].map(attemptIds => ({ attemptIds })))("refuses invalid explicit requests without writes", async ({ attemptIds }) => {
  const f = await fixture(); const before = await readdir(path.join(f.rootDir, ".git"));
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds })).rejects.toMatchObject({ code: "check_diagnostics_request_invalid" });
  expect(await readdir(path.join(f.rootDir, ".git"))).toEqual(before);
});
it.each([
  ["phase", "private"], ["failure", { code: "private-secret" }],
  ["command", { exitCode: 7, outputTail: "x".repeat(4001), truncated: true }],
  ["command", { exitCode: "7", outputTail: "tail", truncated: false }],
  ["command", { unavailable: "invented" }],
  ["command", { unavailable: ["not-completed"] }], ["failure", { unavailable: ["not-failed"] }],
  ["failure", { code: "check_command_failed", executionErrorCode: "private-secret" }],
  ["availability", "unavailable"], ["command", { exitCode: -1, outputTail: "tail", truncated: false }],
  ["command", { exitCode: 7, outputTail: "tail", truncated: "false" }],
] as const)("refuses malformed selected diagnostic %s even with a recomputed checksum", async (member, value) => {
  const f = await fixture(), a = f.store("a"), attempt = await a.allocate(f.input("a"));
  await a.finish(attempt, "failed", { outputs: [], diagnostic } as AttemptPayload);
  const file = path.join(a.root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.diagnostic[member] = value; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] })).rejects.toMatchObject({ code: "check_attempt_corrupt" });
});

it.each(["ENOENT", "EACCES", "EPERM", "ABORT_ERR", "SIGKILL", "SIGTERM", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "execution_failed"])("does not mistake synthesized exit1 for a raw exit: %s", async errorCode => {
  const failure = scopedDiagnosticFailure(new CheckSnapshotError("check_command_failed", "private"), errorCode);
  expect(failure).toEqual({ code: "check_command_failed", executionErrorCode: errorCode });
  expect(scopedCommandDiagnostic({ code: 1, errorCode, stdout: "", stderr: "" }, [])).toEqual({ unavailable: ["ENOENT", "EACCES", "EPERM"].includes(errorCode) ? "not-started" : "not-completed" });
  expect(scopedCommandDiagnostic({ code: 1, errorCode, stdout: "captured secret", stderr: "" }, ["secret"])).toEqual({ exitCode: null, outputTail: "captured [REDACTED]\n", truncated: errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
});
it("retains genuine numeric exits and handles unknown failures without arbitrary text", () => {
  expect(scopedCommandDiagnostic({ code: 7, errorCode: "7", stdout: "assertion", stderr: "stderr" }, [])).toEqual({ exitCode: 7, outputTail: "assertion\nstderr", truncated: false });
  expect(scopedCommandDiagnostic({ code: 0, stdout: "", stderr: "" }, [])).toEqual({ exitCode: 0, outputTail: "\n", truncated: false });
  expect(scopedDiagnosticFailure(new Error("private"))).toEqual({ unavailable: "unclassified" });
  expect(scopedDiagnosticFailure(new CheckSnapshotError("private-secret", "private"))).toEqual({ unavailable: "unclassified" });
  expect(scopedDiagnosticFailure(new CheckSnapshotError("check_command_failed", "private"), "private")).toEqual({ code: "check_command_failed" });
  expect(redactScopedOutput("long-secret short", ["long", "long-secret", "short"])).toBe("[REDACTED] [REDACTED]");
});

it("strips unknown diagnostic properties and ignores removed provider history", async () => {
  const f = await fixture(), a = f.store("a"), attempt = await a.allocate(f.input("a"));
  await a.finish(attempt, "failed", { outputs: [], diagnostic } as AttemptPayload);
  const file = path.join(a.root, "1/terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.diagnostic.extra = "private"; row.entry.payload.diagnostic.failure.message = "secret";
  row.entry.payload.diagnostic.command.environment = "private"; row.digest = digestCanonical(row.entry); await writeFile(file, JSON.stringify(row));
  const result = await readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] });
  expect(result.providers[0]!.attempts[0]!.diagnostic).toEqual(diagnostic);
  expect(JSON.stringify(result)).not.toMatch(/private|secret|environment|extra|message/);
  await writeFile(file, "{}");
  await expect(readScopedCheckDiagnostics({ ...f, attemptIds: [attempt.attemptId] })).rejects.toMatchObject({ code: "check_attempt_corrupt" });
  expect((await readScopedCheckDiagnostics({ ...f, config: { ...f.config, providers: [f.config.providers[1]!] }, attemptIds: [attempt.attemptId] })).unavailableAttemptIds).toEqual([attempt.attemptId]);
});
