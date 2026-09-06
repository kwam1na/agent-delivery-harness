import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactsPort, defineHarnessConfig, type HarnessConfigInput } from "@agent-delivery-harness/kernel";
import adopterConfig from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(command: readonly string[], outputs: string[] = [], timeoutMs = 5000) {
  const dir = await mkdtemp(path.join(tmpdir(), "declared-check-")); dirs.push(dir);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "harness.config.ts"), "export default {};\n");
  await writeFile(path.join(dir, "source.ts"), "export const value = 1;\n");
  await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "initial"); await git("branch", "origin/main");
  const input = { ...adopterConfig, preparationWiringPaths: ["harness.config.ts"], preparationCommands: [],
    providers: [...adopterConfig.providers, { id: "check.tests", findingCodes: [], check: { command, timeoutMs, outputs } }],
    obligations: [...adopterConfig.obligations, { ...adopterConfig.obligations[0]!, id: "validation.passed", activation: { kind: "always" }, providers: ["check.tests"], acceptedPayloadSpecs: ["checks.passed/1"], humanWaiverAllowed: false, allowedResolutionKinds: ["satisfied_evidence", "not_applicable"] }],
  };
  let config = defineHarnessConfig(input as unknown as HarnessConfigInput);
  const artifactDir = path.join(dir, ".git/artifacts"); await mkdir(artifactDir);
  const out: string[] = [], err: string[] = [];
  const runtime: CliRuntime = { cwd: dir, env: {}, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: text => out.push(text), stderr: text => err.push(text), loadConfig: async () => config,
    artifacts: createArtifactsPort({ runRootBase: artifactDir }),
  };
  const run = async (...args: string[]) => { out.length = 0; err.length = 0; return runCli(args, runtime); };
  return { dir, git, run, out, err, runtime, config, input, setConfig: (value: HarnessConfigInput) => { config = defineHarnessConfig(value); } };
}

describe("declared deterministic check providers", () => {
  it("executes argv, validates outputs and reuses unchanged evidence", async () => {
    const f = await fixture([process.execPath, "-e", "const f=require('fs');f.appendFileSync('.git/calls','x');f.writeFileSync('.git/result','passed')"], [".git/result"]);
    expect(await f.run("prepare")).toBe(0);
    expect(await f.run("gate")).toBe(0);
    expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("x");
  }, 30_000);
  it.each([
    ["exit", [process.execPath, "-e", "process.exit(3)"], [], 5000],
    ["spawn", ["/does-not-exist/check"], [], 5000],
    ["timeout", [process.execPath, "-e", "setInterval(()=>{},1000)"], [], 30],
    ["output-limit", [process.execPath, "-e", "process.stdout.write('x'.repeat(2*1024*1024))"], [], 5000],
    ["missing-output", [process.execPath, "-e", ""], ["missing.txt"], 5000],
  ] as const)("blocks %s without check evidence", async (_label, command, outputs, timeoutMs) => {
    const f = await fixture(command, [...outputs], timeoutMs);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toMatch(/check_(command_failed|output_missing)/);
  }, 30_000);
  it("does not execute expensive validation while active review is missing", async () => {
    const f = await fixture([process.execPath, "-e", "require('fs').writeFileSync('.git/expensive','ran')"]);
    await writeFile(path.join(f.dir, "source.ts"), "export const value = 2;\n"); await f.git("add", ".");
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(existsSync(path.join(f.dir, ".git/expensive"))).toBe(false);
  }, 30_000);
  it.each(["source.ts", "harness.config.ts"])("rejects a passing check that changes %s", async file => {
    const f = await fixture([process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(file)},'changed')`]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toMatch(/candidate_unprepared|check_candidate_changed/);
  }, 30_000);
  it("rechecks changed policy and the same provider id with changed argv", async () => {
    const command = [process.execPath, "-e", "require('fs').appendFileSync('.git/calls','x')"];
    const f = await fixture(command);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    f.setConfig({ ...f.config, activationThreshold: 2 });
    expect(await f.run("gate")).toBe(0);
    f.setConfig({ ...f.config, providers: f.config.providers.map(provider => provider.id === "check.tests" ? { ...provider, check: { command: [process.execPath, "-e", "require('fs').appendFileSync('.git/calls','y')"], timeoutMs: 5000 } } : provider) });
    expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xxy");
  }, 30_000);
  it("blocks a moved base until preparation and reruns its check", async () => {
    const f = await fixture([process.execPath, "-e", "require('fs').appendFileSync('.git/calls','x')"]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await f.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "move base"); await f.git("branch", "-f", "origin/main", "HEAD");
    expect(await f.run("gate")).toBe(1); expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xx");
  }, 30_000);
  it("invalidates validation for a review-neutral report but reuses after a record-neutral edit", async () => {
    const f = await fixture([process.execPath, "-e", "require('fs').appendFileSync('.git/calls','x')"]);
    f.setConfig({ ...f.config, activationThreshold: 100 });
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await mkdir(path.join(f.dir, "docs/reports"), { recursive: true }); await writeFile(path.join(f.dir, "docs/reports/report.md"), "new report"); await f.git("add", ".");
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await mkdir(path.join(f.dir, "delivery/records"), { recursive: true }); await writeFile(path.join(f.dir, "delivery/records/run.json"), "{}"); await f.git("add", ".");
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xx");
  }, 30_000);
  it("reruns when a required output disappears or changes", async () => {
    const f = await fixture([process.execPath, "-e", "const f=require('fs');f.appendFileSync('.git/calls','x');f.writeFileSync('.git/result','passed')"], [".git/result"]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await rm(path.join(f.dir, ".git/result")); expect(await f.run("gate")).toBe(0);
    await writeFile(path.join(f.dir, ".git/result"), "different"); expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xxx");
  }, 30_000);
  it("does not accept a caller parent-skip flag", async () => {
    const f = await fixture([process.execPath, "-e", "process.exit(3)"]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate", "--parent-passed")).not.toBe(0);
  }, 30_000);
  it("cancellation publishes no reusable evidence", async () => {
    const f = await fixture([process.execPath, "-e", "setInterval(()=>{},1000)"]);
    expect(await f.run("prepare")).toBe(0);
    const controller = new AbortController();
    const pending = runCli(["gate"], { ...f.runtime, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).not.toBe(0);
    expect(f.out.join("\n")).not.toContain("admitted");
  }, 30_000);

  it("rejects a moved base during an otherwise passing check", async () => {
    const f = await fixture([process.execPath, "-e", "const x=require('child_process');const id=x.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit-tree','HEAD^{tree}','-p','HEAD','-m','new base'],{encoding:'utf8'}).trim();x.execFileSync('git',['update-ref','refs/heads/origin/main',id])"]);
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toContain("check_candidate_changed");
  }, 30_000);
  it.each([
    { command: ["node"], timeoutMs: 0 },
    { command: ["node"], timeoutMs: 10, outputs: ["../outside"] },
    { command: ["node"], timeoutMs: 10, outputs: ["same", "same"] },
    { command: ["node"], timeoutMs: 10, parentPassed: true },
  ])("rejects invalid check configuration %j", async check => {
    const f = await fixture([process.execPath, "-e", ""]);
    expect(() => f.setConfig({ ...f.config, providers: [{ id: "check.tests", findingCodes: [], check }, ...f.config.providers.filter(provider => provider.id !== "check.tests")] } as unknown as HarnessConfigInput)).toThrow();
  }, 30_000);

  it("rechecks installed release swaps with the same package version and blocks corrupt receipts", async () => {
    const f = await fixture([process.execPath, "-e", "require('fs').appendFileSync('.git/calls','x')"]);
    await writeFile(path.join(f.dir, ".git/info/exclude"), ".agent-skills/\n");
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(0);
    await mkdir(path.join(f.dir, ".agent-skills"));
    const receipt = (releaseId: string) => JSON.stringify({ release: { releaseId, profile: "linear-v2", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64) } });
    await writeFile(path.join(f.dir, ".agent-skills/active.json"), receipt("first")); expect(await f.run("gate")).toBe(0);
    await writeFile(path.join(f.dir, ".agent-skills/active.json"), receipt("second")); expect(await f.run("gate")).toBe(0);
    expect(await readFile(path.join(f.dir, ".git/calls"), "utf8")).toBe("xxx");
    await writeFile(path.join(f.dir, ".agent-skills/active.json"), "broken"); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toContain("check_release_unreadable");
  }, 30_000);
  it("rejects an installed release change while checks run", async () => {
    const f = await fixture([process.execPath, "-e", "const f=require('fs');const p='.agent-skills/active.json';const v=JSON.parse(f.readFileSync(p));v.release.releaseId='changed';f.writeFileSync(p,JSON.stringify(v))"]);
    await writeFile(path.join(f.dir, ".git/info/exclude"), ".agent-skills/\n"); await mkdir(path.join(f.dir, ".agent-skills"));
    await writeFile(path.join(f.dir, ".agent-skills/active.json"), JSON.stringify({ release: { releaseId: "first", profile: "linear-v2", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64) } }));
    expect(await f.run("prepare")).toBe(0); expect(await f.run("gate")).toBe(1);
    expect(f.err.join("\n")).toContain("check_candidate_changed");
  }, 30_000);

});
