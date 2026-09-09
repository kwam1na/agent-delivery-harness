import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactsPort, defineHarnessConfig } from "@agent-delivery-harness/kernel";
import adopterConfig from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";
import { resolveRunSurface } from "./run-surface.ts";
import { costLabel } from "./run-projection.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const contract = { objective: "Ship the change", acceptanceCriteria: ["Checks pass"], finishLine: "merge-ready" };

async function fixture(options: { readonly version?: "1" | "2" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ordinary-resume-")); dirs.push(dir);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await mkdir(path.join(dir, ".agent-skills"));
  await writeFile(path.join(dir, ".agent-skills/active.json"), JSON.stringify({ release: { releaseId: "test", profile: "linear", archiveSha256: "a".repeat(64) } }));
  await writeFile(path.join(dir, "harness.config.ts"), "export default {};\n");
  await writeFile(path.join(dir, "source.ts"), "export const value = 1;\n");
  await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "initial"); await git("branch", "origin/main");
  let config = defineHarnessConfig({ ...adopterConfig, preparationCommands: [], preparationWiringPaths: ["harness.config.ts"] });
  const output: string[] = [], errors: string[] = [];
  const runtime: CliRuntime = { cwd: dir, env: {}, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: text => output.push(text), stderr: text => errors.push(text),
    loadConfig: async () => config, artifacts: createArtifactsPort({ runRootBase: path.join(dir, ".git/artifacts") }),
  };
  const run = async (...args: string[]) => { output.length = 0; errors.length = 0; return runCli(args, runtime); };
  const started = { host: "codex", workflow: { releaseId: "test", profile: "linear" } };
  await run("emit", "run.started", ...(options.version === "2" ? ["--version", "2", "--event-id", "start-1"] : []), "--json", JSON.stringify(started));
  /** The run's journal as the store reads it back — never a projection of it. */
  const journal = async () => {
    const surface = await resolveRunSurface(dir); if (!surface.ok) throw new Error(surface.reason);
    const current = await surface.surface.store.current(surface.surface.worktreeKey);
    if (!current.ok || current.runId === undefined) throw new Error("no current run");
    const read = await surface.surface.store.read(current.runId);
    if (!read.ok) throw new Error(`journal unreadable: ${JSON.stringify(read.rejections)}`);
    return read.events;
  };
  return { dir, git, run, output, errors, journal, changePolicy: () => { config = defineHarnessConfig({ ...config, activationThreshold: 200 }); } };
}

describe("ordinary save and resume", () => {
  it("labels partial and unreported costs without displaying invented zeros", () => {
    expect(costLabel({ coverage: "unreported", reportedBy: "codex" })).toBe("unreported");
    expect(costLabel({ coverage: "partial", unit: "tokens", total: 12, reportedBy: "host" })).toBe("12 tokens (partial coverage)");
  });
  it("resumes after a real product process is interrupted and confirmed exited", async () => {
    const f = await fixture(); expect(await f.run("prepare"), f.errors.join("\n")).toBe(0);
    await f.run("save-context", "--json", JSON.stringify({ contract, stage: "inspect-runs" }));
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve("packages/cli/src/main.ts"), "runs", "serve", "--port", "0"], { cwd: f.dir, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Product server did not become ready")), 10000);
        child.stdout.on("data", chunk => { if (String(chunk).includes("serving")) { clearTimeout(timer); resolve(); } });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Product server exited before ready")); });
      });
      expect(child.exitCode).toBeNull();
      child.kill("SIGINT");
      const terminal = await exited;
      expect(terminal.code === 130 || terminal.signal === "SIGINT").toBe(true);
      expect(await f.run("resume")).toBe(0);
      expect(f.output.join("\n")).toContain('"stage":"inspect-runs"');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
  });
  it("reloads a contract and checks actual preparation instead of trusting stage observations", async () => {
    const f = await fixture();
    expect(await f.run("save-context", "--json", JSON.stringify({ contract, stage: "review" }))).toBe(0);
    expect(await f.run("resume")).toBe(1);
    expect(f.output.join("\n")).toContain("Ship the change");
    expect(f.output.join("\n")).toContain('"prepared":false');
    expect(await f.run("prepare")).toBe(0);
    expect(await f.run("resume")).toBe(0);
    expect(f.output.join("\n")).toContain('"prepared":true');
  });
  it.each(["source", "base", "policy", "release"])("refuses stale reuse after %s changes", async kind => {
    const f = await fixture();
    await f.run("prepare"); await f.run("save-context", "--json", JSON.stringify({ contract, stage: "validation" }));
    if (kind === "policy") f.changePolicy();
    else {
      const target = kind === "release" ? ".agent-skills/active.json" : "source.ts";
      await writeFile(path.join(f.dir, target), kind === "release" ? JSON.stringify({ release: { releaseId: "next", profile: "linear", archiveSha256: "b".repeat(64) } }) : "export const value = 2;\n");
      await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "change");
      if (kind === "base") await f.git("branch", "-f", "origin/main", "HEAD");
    }
    expect(await f.run("resume")).toBe(1);
    expect(f.output.join("\n")).toContain('"reuseAllowed":false');
  });
  it("keeps an intent unknown until the host records reconciliation, without replay", async () => {
    const f = await fixture(); expect(await f.run("prepare"), f.errors.join("\n")).toBe(0);
    await f.run("save-context", "--json", JSON.stringify({ contract, stage: "merge" }));
    await f.run("emit", "action.intent", "--json", JSON.stringify({ actionId: "merge-1", operation: "merge", reference: "repo/pr/1" }));
    expect(await f.run("resume")).toBe(1); expect(f.errors.join("\n")).toContain("resume_action_unreconciled");
    await f.run("emit", "action.observed", "--json", JSON.stringify({ actionId: "merge-1", outcome: "succeeded", reference: "repo/commit/abc" }));
    expect(await f.run("resume")).toBe(0);
    expect(f.output.join("\n")).toContain('"automaticReplay":false');
  });
  it("blocks missing context and a corrupted saved journal", async () => {
    const f = await fixture(); expect(await f.run("resume")).toBe(1);
    expect(f.errors.join("\n")).toContain("resume_context_missing");
    await f.run("save-context", "--json", JSON.stringify({ contract, stage: "work" }));
    const surface = await resolveRunSurface(f.dir); if (!surface.ok) throw new Error(surface.reason);
    const current = await surface.surface.store.current(surface.surface.worktreeKey); if (!current.ok || !current.runId) throw new Error("missing run");
    const file = path.join(surface.surface.runsDir, `${current.runId}.jsonl`);
    await writeFile(file, (await readFile(file, "utf8")) + "{corrupted\n");
    expect(await f.run("resume")).toBe(1); expect(f.errors.join("\n")).toContain("resume_context_invalid");
  });
});


it("refuses contradictory observed outcomes", async () => {
  const f = await fixture();
  expect(await f.run("prepare")).toBe(0);
  expect(await f.run("save-context", "--json", JSON.stringify({ contract, stage: "merge" }))).toBe(0);
  expect(await f.run("emit", "action.intent", "--json", JSON.stringify({ actionId: "a1", operation: "merge", reference: "pr1" }))).toBe(0);
  expect(await f.run("emit", "action.observed", "--json", JSON.stringify({ actionId: "a1", outcome: "failed", reference: "pr1" }))).toBe(0);
  expect(await f.run("emit", "action.observed", "--json", JSON.stringify({ actionId: "a1", outcome: "succeeded", reference: "pr1" }))).toBe(0);
  expect(await f.run("resume")).toBe(1);
  expect(f.errors.join("\n")).toContain("resume_action_unreconciled");
});

describe("the writer version a save-context observation is written at", () => {
  it("writes the selected run's version, so a run-event/2 journal accepts the save and resume reads it back", async () => {
    const f = await fixture({ version: "2" });
    expect(await f.run("prepare"), f.errors.join("\n")).toBe(0);
    expect(await f.run("save-context", "--json", JSON.stringify({ contract, stage: "work" })), f.errors.join("\n")).toBe(0);
    const saved = (await f.journal()).filter(event => event.kind === "context.saved");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.version).toBe("run-event/2");
    // The retry key is derived from the observation itself, so the same save
    // has the same id wherever it is repeated from.
    expect(saved[0]!.eventId).toMatch(/^context-saved-[0-9a-f]{64}$/);
    expect(await f.run("resume"), f.errors.join("\n")).toBe(0);
    expect(f.output.join("\n")).toContain('"stage":"work"');
  });

  it("keeps a legacy run at run-event/1, where an id-free save appends every time", async () => {
    const f = await fixture();
    expect(await f.run("prepare"), f.errors.join("\n")).toBe(0);
    expect(await f.run("save-context", "--json", JSON.stringify({ contract, stage: "work" })), f.errors.join("\n")).toBe(0);
    expect(await f.run("save-context", "--json", JSON.stringify({ contract, stage: "work" })), f.errors.join("\n")).toBe(0);
    const saved = (await f.journal()).filter(event => event.kind === "context.saved");
    expect(saved).toHaveLength(2);
    expect(saved.map(event => event.version)).toEqual(["run-event/1", "run-event/1"]);
    expect(saved.every(event => event.eventId === undefined)).toBe(true);
    expect(await f.run("resume"), f.errors.join("\n")).toBe(0);
  });

  it("is idempotent on an exact v2 retry and distinguishes a changed observation", async () => {
    const f = await fixture({ version: "2" });
    expect(await f.run("prepare"), f.errors.join("\n")).toBe(0);
    const payload = JSON.stringify({ contract, stage: "work" });
    expect(await f.run("save-context", "--json", payload), f.errors.join("\n")).toBe(0);
    const first = await f.journal();
    // The same observation, saved again: the same event, instant and sequence.
    expect(await f.run("save-context", "--json", payload), f.errors.join("\n")).toBe(0);
    expect(await f.journal()).toEqual(first);
    // A different stage is a different observation, so it is a different id.
    expect(await f.run("save-context", "--json", JSON.stringify({ contract, stage: "review" })), f.errors.join("\n")).toBe(0);
    const saved = (await f.journal()).filter(event => event.kind === "context.saved");
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map(event => event.eventId)).size).toBe(2);
  });

  it.each(["1", "2"] as const)("leaves a v%s journal unchanged when the store refuses the context, and names the rejection", async version => {
    const f = await fixture({ version });
    expect(await f.run("prepare"), f.errors.join("\n")).toBe(0);
    const before = await f.journal();
    // An empty acceptance-criteria list is refused by the bounded contract,
    // which is a refusal the command cannot see until the store answers.
    expect(await f.run("save-context", "--json", JSON.stringify({ contract: { ...contract, acceptanceCriteria: [] }, stage: "work" }))).toBe(1);
    const reported = f.errors.join("\n");
    expect(reported).toContain("resume_context_invalid");
    expect(reported).toContain("malformed_member");
    expect(reported).toContain("/payload/contract/acceptanceCriteria");
    // No false success, and no rewritten history.
    expect(await f.journal()).toEqual(before);
  });
});
