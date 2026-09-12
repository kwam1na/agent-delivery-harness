import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createArtifactsPort, defineHarnessConfig, type HarnessConfigInput } from "@agent-delivery-harness/kernel";
import base from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";
const exec = promisify(execFile), dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "scoped-cli-")); dirs.push(dir);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "harness.config.ts"), "export default {};\n");
  await writeFile(path.join(dir, "source.txt"), "source"); await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "base"); await git("branch", "origin/main");
  const providers = ["a", "b"].map(id => ({ id: `check.${id}`, findingCodes: [], check: { command: [process.execPath, "-e", `if('${id}'==='b'&&process.env["FAIL"]==='1')process.exit(3);require('fs').writeFileSync('result-${id}.json',JSON.stringify({value:require('fs').readFileSync('source.txt','utf8')}))`], timeoutMs: 5000, outputs: [`result-${id}.json`], scope: { version: "scoped-check/1", files: ["source.txt"], memberships: [], tests: [], cwd: ".", profile: "fixture", environment: id === "b" ? [{ name: "FAIL", kind: "flag" }] : [] } } }));
  const input = { ...base, preparationWiringPaths: ["harness.config.ts"], preparationCommands: [], providers,
    obligations: providers.map(p => ({ ...base.obligations[0]!, id: `${p.id}.passed`, activation: { kind: "always" }, providers: [p.id], acceptedPayloadSpecs: ["checks.passed/1"], humanWaiverAllowed: false, allowedResolutionKinds: ["satisfied_evidence"] })),
    scopedExecution: { version: "scoped-execution/1", mechanicalProviders: [], profiles: [{ id: "fixture", dependencyInputs: [], mutableOutputs: ["result-a.json", "result-b.json"], credentialIdentities: {} }] } };
  let config = defineHarnessConfig(input as unknown as HarnessConfigInput);
  const artifacts = path.join(dir, ".git/artifacts"); await mkdir(artifacts);
  const out: string[] = [], err: string[] = [], env: Record<string, string> = { FAIL: "1" };
  const runtime: CliRuntime = { cwd: dir, env, stdinIsTTY: false, stdoutIsTTY: false, stdout: s => out.push(s), stderr: s => err.push(s), loadConfig: async () => config, artifacts: createArtifactsPort({ runRootBase: artifacts }) };
  const run = async (...args: string[]) => { out.length = 0; err.length = 0; return runCli(args, runtime); };
  return { dir, git, run, out, err, env, config, runtime, setConfig: (v: HarnessConfigInput) => { config = defineHarnessConfig(v); } };
}
it("retains A across B failure, retry and report replan, then records portable evidence", async () => {
  const f = await fixture(); expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(1);
  expect(f.out.join("\n")).toContain("checking check.a");
  f.env["FAIL"] = "0";
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("reusing check.a");
  expect(f.out.join("\n")).not.toContain("checking check.a");
  await mkdir(path.join(f.dir, "docs/reports"), { recursive: true }); await writeFile(path.join(f.dir, "docs/reports/report.md"), "report"); await f.git("add", "."); await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "report");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("reusing check.a"); expect(f.out.join("\n")).toContain("reusing check.b");
  await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  await expect(readFile(path.join(f.dir, "result-a.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await f.git("-c", "commit.gpgsign=false", "commit", "-qm", "record");
  const foreign = await mkdtemp(path.join(tmpdir(), "scoped-foreign-")); dirs.push(foreign);
  await exec("git", ["clone", "--no-local", f.dir, foreign]);
  await exec("git", ["update-ref", "refs/remotes/origin/main", await f.git("rev-parse", "origin/main")], { cwd: foreign });
  expect(await runCli(["verify"], { ...f.runtime, cwd: foreign }), f.err.join("\n")).toBe(0);
  const { readdir } = await import("node:fs/promises");
  const recordDir = path.join(f.dir, path.dirname(f.config.deliveryRecordPath));
  const recordFile = path.join(recordDir, (await readdir(recordDir))[0]!);
  const original = await readFile(recordFile, "utf8");
  const record = JSON.parse(original);
  const portable = record.claims[0].evidence.resolution.portable;
  portable.artifacts["scoped-inputs.json"] = Buffer.from("{}").toString("base64");
  await writeFile(recordFile, JSON.stringify(record)); await f.git("add", ".");
  expect(await f.run("verify")).toBe(1);
  expect(f.err.join("\n")).toContain("portable_scoped_inputs_invalid");
}, 60000);
it("captures untracked source without changing the author index", async () => {
  const f = await fixture();
  await writeFile(path.join(f.dir, "new-source.txt"), "untracked source");
  const before = await f.git("ls-files", "--stage");
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.git("ls-files", "--stage")).toBe(before);
  expect(await f.git("status", "--porcelain")).toContain("?? new-source.txt");
}, 60000);
it("requires mechanical scoped success before publishing a preparation receipt", async () => {
  const f = await fixture();
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.b"] } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(1);
  expect(await f.run("review-context"), f.err.join("\n")).toBe(1);
  f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.b");
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).not.toContain("checking check.b");
}, 60000);
it("runs secret-dependent checks fresh on the same candidate and retains no sentinel secret", async () => {
  const f = await fixture(); f.env["FAIL"] = "0"; f.env["API_TOKEN"] = "SENTINEL-private-credential-2065";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "console.log(process.env.API_TOKEN);require('fs').writeFileSync('result-a.json','{}')"], scope: { ...a.check!.scope!, environment: [{ name: "API_TOKEN", kind: "credential" }] } } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  for (let i = 0; i < 2; i++) { expect(await f.run("gate"), f.err.join("\n")).toBe(0); expect(f.out.join("\n")).toContain("checking check.a"); }
  expect(await f.run("record"), f.err.join("\n")).toBe(0);
  await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  const { readdir } = await import("node:fs/promises");
  const inspect = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await inspect(file); else if (entry.isFile()) expect((await readFile(file)).includes(Buffer.from(f.env["API_TOKEN"]!)), file).toBe(false); } };
  await inspect(f.dir);
}, 60000);
it("unsupported scoped execution fails before expensive preparation", async () => {
  const f = await fixture();
  const { scopedExecution: _unused, ...withoutExecutor } = f.config;
  f.setConfig({ ...withoutExecutor, preparationCommands: [{ id: "expensive", command: [process.execPath, "-e", "require('fs').writeFileSync('.git/expensive','ran')"], timeoutMs: 5000 }] });
  expect(await f.run("prepare")).toBe(1);
  expect(f.err.join("\n")).toContain("scoped_executor_required");
  await expect(readFile(path.join(f.dir, ".git/expensive"))).rejects.toMatchObject({ code: "ENOENT" });
}, 60000);
it.each([
  ["missing output", "", "check_output_missing"],
  ["source drift", "require('fs').writeFileSync('source.txt','drift');require('fs').writeFileSync('result-a.json','{}')", "check_snapshot_drift"],
  ["credential output", "require('fs').writeFileSync('result-a.json',process.env.API_TOKEN)", "check_output_missing"],
])("refuses %s and preserves the independent sibling", async (_label, command, code) => {
  const f = await fixture(); f.env["FAIL"] = "0"; f.env["API_TOKEN"] = "SECRET-output-sentinel";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", command], scope: { ...a.check!.scope!, environment: [{ name: "API_TOKEN", kind: "credential" }] } } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(1);
  expect(f.err.join("\n")).toContain(code);
  expect(f.out.join("\n")).toContain("passed check.b");
  expect(await readFile(path.join(f.dir, "source.txt"), "utf8")).toBe("source");
}, 60000);
it("retains cancellation as interrupted and retries without publishing success", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "setTimeout(()=>{},10000)"] } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const controller = new AbortController();
  const runtime = { ...f.runtime, signal: controller.signal, stdout: (s: string) => { f.out.push(s); if (s.includes("checking check.a")) controller.abort(); } };
  expect(await runCli(["gate"], runtime), f.err.join("\n")).toBe(130);
  const { resolveRecordStorage } = await import("@agent-delivery-harness/kernel");
  const { readdir } = await import("node:fs/promises");
  const storage = await resolveRecordStorage(f.dir, { storageNamespace: f.config.storageNamespace, leaf: "scoped-attempts" });
  const contents: string[] = [];
  const collect = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await collect(file); else contents.push(await readFile(file, "utf8")); } };
  await collect(storage.storageDir);
  expect(contents.join("\n")).toContain('"status":"interrupted"');
  expect(contents.join("\n")).not.toContain('"status":"passed"');
}, 60000);
