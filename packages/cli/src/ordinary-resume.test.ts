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

async function fixture() {
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
  await run("emit", "run.started", "--json", JSON.stringify({ host: "codex", workflow: { releaseId: "test", profile: "linear" } }));
  return { dir, git, run, output, errors, changePolicy: () => { config = defineHarnessConfig({ ...config, activationThreshold: 200 }); } };
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
