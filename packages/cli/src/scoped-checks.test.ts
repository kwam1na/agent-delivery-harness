import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
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
    scopedExecution: { version: "scoped-execution/1", mechanicalProviders: [], profiles: [{ id: "fixture", gitContext: "none", dependencyInputs: [], mutableOutputs: ["result-a.json", "result-b.json"], credentialIdentities: {} }] } };
  let config = defineHarnessConfig(input as unknown as HarnessConfigInput);
  const artifacts = path.join(dir, ".git/artifacts"); await mkdir(artifacts);
  const out: string[] = [], err: string[] = [], env: Record<string, string> = { FAIL: "1" };
  const runtime: CliRuntime = { cwd: dir, env, stdinIsTTY: false, stdoutIsTTY: false, stdout: s => out.push(s), stderr: s => err.push(s), loadConfig: async () => config, artifacts: createArtifactsPort({ runRootBase: artifacts }) };
  const run = async (...args: string[]) => { out.length = 0; err.length = 0; return runCli(args, runtime); };
  return { dir, git, run, out, err, env, get config() { return config; }, runtime, setConfig: (v: HarnessConfigInput) => { config = defineHarnessConfig(v); } };
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

it('a missing sibling output cannot borrow a previous check output',async()=>{
 const f=await fixture();f.env["FAIL"]='0';
 const a=f.config.providers[0]!, b=f.config.providers[1]!;
 f.setConfig({...f.config, providers:[a,{...b,check:{...b.check!,command:[process.execPath,'-e',''],outputs:['result-a.json']}}]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);
 const gate=await f.run('gate');
 expect(gate).toBe(1);
},60000);
it('preparation cannot attest source mutated after its validator',async()=>{
 const f=await fixture();f.env["FAIL"]='0';
 f.setConfig({...f.config,preparationCommands:[{id:'validate',command:[process.execPath,'-e',"if(require('fs').readFileSync('source.txt','utf8')!=='source')process.exit(1)"],timeoutMs:5000},{id:'mutate',command:[process.execPath,'-e',"require('fs').writeFileSync('source.txt','unvalidated')"],timeoutMs:5000}]});
 const prepared=await f.run('prepare');
 expect(prepared).toBe(1);
},60000);
it('nonreusable credentials portable fresh clone',async()=>{
 const f=await fixture();f.env["FAIL"]='0';f.env["API_TOKEN"]='secret';const a=f.config.providers[0]!;
 f.setConfig({...f.config,providers:[{...a,check:{...a.check!,scope:{...a.check!.scope!,environment:[{name:'API_TOKEN',kind:'credential'}]}}},f.config.providers[1]!]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);
 expect(await f.run('record'),f.err.join('\n')).toBe(0);
 await f.git('add','.');await f.git('-c','commit.gpgsign=false','commit','-qm','record');
 const foreign=await mkdtemp(path.join(tmpdir(),'scoped-oc-foreign-'));dirs.push(foreign);
 await exec('git',['clone','--no-local',f.dir,foreign]);await exec('git',['update-ref','refs/remotes/origin/main',await f.git('rev-parse','origin/main')],{cwd:foreign});
 const verified=await runCli(['verify'],{...f.runtime,cwd:foreign});expect(verified).toBe(0);
},60000);
it.each(['check', 'dependencies'])('rejects an absolute authoring executable in %s before setup', async kind => {
 const f=await fixture(); const script=path.join(f.dir,'check.cjs'); await writeFile(script,`#!${process.execPath}\nprocess.exit(7);\n`);
 const a=f.config.providers[0]!;
 f.setConfig(kind==='check' ? {...f.config,providers:[{...a,check:{...a.check!,command:[script]}},f.config.providers[1]!]} : {...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:[{...f.config.scopedExecution!.profiles[0]!,dependencies:{command:[script],timeoutMs:5000}}]}});
 expect(await f.run('prepare')).toBe(1);expect(f.err.join('\n')).toContain('check_runtime_author_path');
},60000);
it('missing dependency input is a named preflight blocker',async()=>{
 const f=await fixture();f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:[{...f.config.scopedExecution!.profiles[0]!,dependencyInputs:['missing.lock']}]}});
 expect(await f.run('prepare')).toBe(1);expect(f.err.join('\n')).toContain('check_dependency_input_missing');
},60000);
it('logical cwd resolves repository executable',async()=>{
 const f=await fixture();f.env["FAIL"]='0';await mkdir(path.join(f.dir,'scripts'));const script=path.join(f.dir,'scripts/check.cjs');await writeFile(script,`#!${process.execPath}\nrequire('fs').writeFileSync('../result-a.json','{}');\n`);(await import('node:fs')).chmodSync(script,0o755);
 const a=f.config.providers[0]!;f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:['./check.cjs'],scope:{...a.check!.scope!,cwd:'scripts',files:['scripts/check.cjs']}}},f.config.providers[1]!]});
 const code=await f.run('prepare');expect(code).toBe(0);expect(await f.run('gate'),f.err.join('\n')).toBe(0);
},60000);
it('executable mode drift invalidates executable proof',async()=>{
 const f=await fixture();f.env["FAIL"]='0';const script=path.join(f.dir,'check.cjs');await writeFile(script,`#!${process.execPath}\nrequire('fs').writeFileSync('result-a.json','{}');\n`);const fs=await import('node:fs');fs.chmodSync(script,0o755);
 const a=f.config.providers[0]!;f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:['./check.cjs'],scope:{...a.check!.scope!,files:['source.txt']}}},f.config.providers[1]!]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);expect(await f.run('gate'),f.err.join('\n')).toBe(0);
 fs.chmodSync(script,0o644);expect(await f.run('prepare'),f.err.join('\n')).toBe(0);const gate=await f.run('gate');expect(gate).toBe(1);
},60000);
it('mutable output cannot hide a tracked source directory',async()=>{
 const f=await fixture();f.env["FAIL"]='0';await mkdir(path.join(f.dir,'src'));await writeFile(path.join(f.dir,'src/app.txt'),'source');
 const a=f.config.providers[0]!;f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:[{...f.config.scopedExecution!.profiles[0]!,mutableOutputs:['src','result-a.json','result-b.json']}]},providers:[{...a,check:{...a.check!,command:[process.execPath,'-e',"require('fs').writeFileSync('src/app.txt','drift');require('fs').writeFileSync('result-a.json','{}')"],scope:{...a.check!.scope!,files:['src/app.txt']}}},f.config.providers[1]!]});
 const prepared=await f.run('prepare');const gate=prepared===0?await f.run('gate'):prepared;expect(gate).toBe(1);
},60000);
it("captures explicit repairs before validators and scoped mechanics", async () => {
  const f = await fixture(); f.env["FAIL"] = "0";
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: ["check.a"], repairCommands: [{ id: "repair-source", command: [process.execPath, "-e", "require('fs').writeFileSync('source.txt','repaired')"], timeoutMs: 5000 }] }, preparationCommands: [{ id: "validate-source", command: [process.execPath, "-e", "if(require('fs').readFileSync('source.txt','utf8')!=='repaired')process.exit(1)"], timeoutMs: 5000 }] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.a");
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
});
it("cannot accept output precreated by dependency setup", async () => {
  const f = await fixture(); const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", ""] } }, f.config.providers[1]!], scopedExecution: { ...f.config.scopedExecution!, profiles: [{ ...f.config.scopedExecution!.profiles[0]!, dependencies: { command: [process.execPath, "-e", "require('fs').writeFileSync('result-a.json','{}')"], timeoutMs: 5000 } }] } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate")).toBe(1); expect(f.err.join("\n")).toContain("check_output_missing");
});
it.each(["src", "src/"])("refuses output ancestor %s", async output => {
  const f = await fixture(); await mkdir(path.join(f.dir, "src")); await writeFile(path.join(f.dir, "src/file"), "source");
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, profiles: [{ ...f.config.scopedExecution!.profiles[0]!, mutableOutputs: [output, "result-a.json", "result-b.json"] }] } });
  expect(await f.run("prepare")).toBe(1); expect(f.err.join("\n")).toContain("check_output_overlaps_source");
});
it("injects declared flags and credentials while excluding an explicitly supplied undeclared variable", async () => {
  const f = await fixture(); f.env["FLAG"] = "yes"; f.env["TOKEN"] = "secret-sentinel"; f.env["UNDECLARED"] = "must-not-reach-command"; f.env["FAIL"] = "0";
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, command: [process.execPath, "-e", "if(process.env.FLAG!=='yes'||process.env.TOKEN!=='secret-sentinel'||process.env.UNDECLARED!==undefined)process.exit(7);require('fs').writeFileSync('result-a.json','{}')"], scope: { ...a.check!.scope!, environment: [{ name: "FLAG", kind: "flag" }, { name: "TOKEN", kind: "credential" }] } } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
});
it.each(["GIT_DIR", "DELIVERY_CHECK_ORIGIN_TREE", "PATH", "HOME", "TMPDIR", "TMP", "TEMP"])("refuses reserved environment input %s", async name => {
  const f = await fixture(), a = f.config.providers[0]!;
  expect(() => f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, scope: { ...a.check!.scope!, environment: [{ name, kind: "flag" }] } } }, f.config.providers[1]!] })).toThrow();
});
it("reruns only the dependency-affected profile and refuses stale portable dependency inputs", async () => {
  const f = await fixture(); f.env["FAIL"] = "0"; await writeFile(path.join(f.dir, "deps.lock"), "one");
  const a = f.config.providers[0]!, profile = f.config.scopedExecution!.profiles[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, scope: { ...a.check!.scope!, profile: "dependent" } } }, f.config.providers[1]!], scopedExecution: { ...f.config.scopedExecution!, profiles: [profile, { ...profile, id: "dependent", dependencyInputs: ["deps.lock"] }] } });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0); await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0); expect(f.out.join("\n")).toContain("reusing check.a");
  await writeFile(path.join(f.dir, "deps.lock"), "two"); await f.git("add", ".");
  expect(await f.run("verify")).toBe(1); expect(f.err.join("\n")).toContain("delivery_record_missing");
  const { capturePortableVerificationInputs, withDeliverableIdentity } = await import("@agent-delivery-harness/kernel");
  const { captureScopedCandidate } = await import("./scoped-candidate.ts");
  const { readdir } = await import("node:fs/promises");
  const recordRoot = path.join(f.dir, path.dirname(f.config.deliveryRecordPath));
  const record = JSON.parse(await readFile(path.join(recordRoot, (await readdir(recordRoot))[0]!), "utf8"));
  const capture = await captureScopedCandidate({ rootDir: f.dir, config: f.config, workspaceId: "foreign-verifier", computeIdentity: withDeliverableIdentity() });
  expect(capture.ok).toBe(true); if (!capture.ok) throw new Error("capture failed");
  await expect(capturePortableVerificationInputs(f.dir, f.config, capture.candidate, record)).rejects.toMatchObject({ blockers: [expect.objectContaining({ code: "portable_scoped_inputs_invalid" })] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.a"); expect(f.out.join("\n")).toContain("reusing check.b");
}, 60000);
it("fences an older completion after a newer execution publishes success", async () => {
  const { AttemptStore } = await import("./scoped-attempts.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const finish = AttemptStore.prototype.finish; let overlapped = false;
  const { ScopedChecks } = await import("./scoped-checks.ts");
  const execute = ScopedChecks.prototype.execute, failures: unknown[] = [];
  const executionSpy = vi.spyOn(ScopedChecks.prototype, "execute").mockImplementation(async function (this: import("./scoped-checks.ts").ScopedChecks, ...args) {
    try { return await execute.apply(this, args); } catch (error) { failures.push(error); throw error; }
  });
  const spy = vi.spyOn(AttemptStore.prototype, "finish").mockImplementation(async function (this: import("./scoped-attempts.ts").AttemptStore, attempt, status, payload) {
    await finish.call(this, attempt, status, payload);
    if (!overlapped && attempt.providerId === "check.a" && status === "passed") {
      overlapped = true;
      expect(await runCli(["gate"], f.runtime), f.err.join("\n")).toBe(0);
    }
  });
  try {
    expect(await f.run("gate"), f.err.join("\n")).toBe(0);
    expect(overlapped).toBe(true); expect(failures).toEqual([expect.objectContaining({ code: "check_attempt_superseded" })]);
    expect(f.out.filter(s => s.includes("passed check.a"))).toHaveLength(1);
  } finally { spy.mockRestore(); executionSpy.mockRestore(); }
  expect(await f.run("gate"), f.err.join("\n")).toBe(0);
}, 60000);
it.each(["failed", "interrupted"] as const)("newer %s completion blocks older publication and permits a valid retry", async status => {
  const { AttemptStore } = await import("./scoped-attempts.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const finish = AttemptStore.prototype.finish; let overlapped = false;
  const spy = vi.spyOn(AttemptStore.prototype, "finish").mockImplementation(async function (this: import("./scoped-attempts.ts").AttemptStore, attempt, result, payload) {
    await finish.call(this, attempt, result, payload);
    if (!overlapped && attempt.providerId === "check.a" && result === "passed") {
      overlapped = true;
      const newer = await this.allocate({ version: attempt.version, providerId: attempt.providerId, inputDigest: attempt.inputDigest, profileDigest: attempt.profileDigest, origin: { ...attempt.origin, runId: "newer-execution" } });
      await finish.call(this, newer, status, { outputs: [] });
    }
  });
  try {
    expect(await f.run("gate"), f.err.join("\n")).toBe(1);
    expect(f.err.join("\n")).toContain("check_attempt_superseded");
    expect(f.out.join("\n")).not.toContain("passed check.a");
  } finally { spy.mockRestore(); }
  expect(await f.run("gate"), f.err.join("\n")).toBe(0); expect(f.out.join("\n")).toContain("checking check.a");
}, 60000);
it("refuses retained output corruption independently of the attempt envelope checksum", async () => {
  const { ScopedChecks } = await import("./scoped-checks.ts");
  const { digestCanonical, resolveRecordStorage } = await import("@agent-delivery-harness/kernel");
  const { readdir } = await import("node:fs/promises");
  const f = await fixture(); f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  const create = ScopedChecks.create; let session: import("./scoped-checks.ts").ScopedChecks | undefined;
  const spy = vi.spyOn(ScopedChecks, "create").mockImplementation(async (...args) => { session = await create(...args); return session; });
  try { expect(await f.run("gate"), f.err.join("\n")).toBe(0); } finally { spy.mockRestore(); }
  expect(Buffer.from(await session!.readOutput("result-a.json", "check.a")).toString()).toBe('{"value":"source"}');
  const storage = await resolveRecordStorage(f.dir, { storageNamespace: f.config.storageNamespace, leaf: "scoped-attempts" });
  const root = path.join(storage.storageDir, digestCanonical({ gate: f.config.gateId, provider: "check.a" }));
  const generation = (await readdir(root))[0]!;
  const file = path.join(root, generation, "terminal.json"), row = JSON.parse(await readFile(file, "utf8"));
  row.entry.payload.outputs[0].base64 = Buffer.from("corrupt").toString("base64"); row.digest = digestCanonical(row.entry);
  await writeFile(file, JSON.stringify(row));
  await expect(session!.readOutput("result-a.json", "check.a")).rejects.toMatchObject({ code: "check_output_missing" });
}, 60000);
it.each(["command", "wiring"])("refuses %s repair failure before validators and revokes preparation", async kind => {
  const f = await fixture();
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  f.setConfig({ ...f.config, scopedExecution: { ...f.config.scopedExecution!, repairCommands: [{ id: "repair-source", command: [process.execPath, "-e", kind === "command" ? "process.exit(7)" : "require('fs').writeFileSync('harness.config.ts','changed')"], timeoutMs: 5000 }] }, preparationCommands: [{ id: "validator", command: [process.execPath, "-e", "require('fs').writeFileSync('.git/validator','ran')"], timeoutMs: 5000 }] });
  expect(await f.run("prepare")).toBe(1);
  expect(f.err.join("\n")).toContain(kind === "command" ? "preparation_repair_failed" : "preparation_candidate_changed");
  await expect(readFile(path.join(f.dir, ".git/validator"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.run("review-context")).toBe(1);
});

it.each(['files', 'tests', 'memberships', 'dependencyInputs'])('a declared helper executable mode is a scoped input via %s',async selected=>{
 const f=await fixture();f.env["FAIL"]='0';const fs=await import('node:fs');
 await mkdir(path.join(f.dir,'helpers'));await writeFile(path.join(f.dir,'helpers/helper.cjs'),`#!${process.execPath}\nprocess.exit(0);\n`);fs.chmodSync(path.join(f.dir,'helpers/helper.cjs'),0o755);
 const a=f.config.providers[0]!;f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:[{...f.config.scopedExecution!.profiles[0]!,dependencyInputs:selected==='dependencyInputs'?['helpers/helper.cjs']:[]}]},providers:[{...a,check:{...a.check!,command:[process.execPath,'-e',"if(require('child_process').spawnSync('./helpers/helper.cjs').status!==0)process.exit(7);require('fs').writeFileSync('result-a.json','{}')"],scope:{...a.check!.scope!,files:selected==='files'?['helpers/helper.cjs']:['source.txt'],tests:selected==='tests'?['helpers/helper.cjs']:[],memberships:selected==='memberships'?['helpers/']:[]}}},f.config.providers[1]!]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);expect(await f.run('gate'),f.err.join('\n')).toBe(0);
 fs.chmodSync(path.join(f.dir,'helpers/helper.cjs'),0o644);await expect(exec(process.execPath,f.config.providers[0]!.check!.command.slice(1),{cwd:f.dir})).rejects.toMatchObject({code:7});expect(await f.run('prepare'),f.err.join('\n')).toBe(0);const gate=await f.run('gate');expect(gate).toBe(1);
},60000);
it('repair cancellation preserves interrupted CLI outcome',async()=>{
 const f=await fixture();f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,repairCommands:[{id:'repair-wait',command:[process.execPath,'-e','setTimeout(()=>{},10000)'],timeoutMs:20000}]}});
 const controller=new AbortController();const code=await runCli(['prepare'],{...f.runtime,signal:controller.signal,stdout:(s:string)=>{f.out.push(s);if(s.includes('repairing repair-wait'))controller.abort();}});
 expect(code).toBe(130);
},60000);
it('a declared symlink target is a scoped input',async()=>{
 const f=await fixture();f.env["FAIL"]='0';const fs=await import('node:fs');await writeFile(path.join(f.dir,'other.txt'),'source');fs.symlinkSync('source.txt',path.join(f.dir,'alias'));
 const a=f.config.providers[0]!;f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:[process.execPath,'-e',"if(require('fs').readlinkSync('alias')!=='source.txt')process.exit(7);require('fs').writeFileSync('result-a.json','{}')"],scope:{...a.check!.scope!,files:['alias']}}},f.config.providers[1]!]});
 expect(await f.run('prepare'),f.err.join('\n')).toBe(0);expect(await f.run('gate'),f.err.join('\n')).toBe(0);
 fs.unlinkSync(path.join(f.dir,'alias'));fs.symlinkSync('other.txt',path.join(f.dir,'alias'));await expect(exec(process.execPath,f.config.providers[0]!.check!.command.slice(1),{cwd:f.dir})).rejects.toMatchObject({code:7});expect(await f.run('prepare'),f.err.join('\n')).toBe(0);const gate=await f.run('gate');expect(gate).toBe(1);
},60000);


it("historical workspace refuses non-record-neutral narration drift", async () => {
 const f=await fixture(); f.env["FAIL"]="0"; f.env["API_TOKEN"]="secret"; const a=f.config.providers[0]!;
 f.setConfig({...f.config,providers:[{...a,check:{...a.check!,scope:{...a.check!.scope!,environment:[{name:"API_TOKEN",kind:"credential"}]}}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);
 expect(await f.run("record"),f.err.join("\n")).toBe(0);
 await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","record");
 const foreign=await mkdtemp(path.join(tmpdir(),"scoped-probe-foreign-"));dirs.push(foreign);
 await exec("git",["clone","--no-local",f.dir,foreign]);await exec("git",["update-ref","refs/remotes/origin/main",await f.git("rev-parse","origin/main")],{cwd:foreign});
 await mkdir(path.join(foreign,"docs/reports"),{recursive:true});await writeFile(path.join(foreign,"docs/reports/later.md"),"later narration");await exec("git",["add","."],{cwd:foreign});
 expect(await runCli(["verify"],{...f.runtime,cwd:foreign}),f.err.join("\n")).toBe(1);
},60000);
it.each(["mode", "link"])("portable verification recomputes declared %s metadata", async kind => {
  const { chmod, symlink, unlink, readdir } = await import("node:fs/promises");
  const { capturePortableVerificationInputs, withDeliverableIdentity } = await import("@agent-delivery-harness/kernel");
  const { captureScopedCandidate } = await import("./scoped-candidate.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  await writeFile(path.join(f.dir, "other.txt"), "source");
  await symlink("source.txt", path.join(f.dir, "bridge"));
  await symlink("bridge", path.join(f.dir, "alias"));
  const a = f.config.providers[0]!;
  f.setConfig({ ...f.config, providers: [{ ...a, check: { ...a.check!, scope: { ...a.check!.scope!, files: ["alias"] } } }, f.config.providers[1]!] });
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0); await f.git("add", ".");
  expect(await f.run("verify"), f.err.join("\n")).toBe(0);
  if (kind === "mode") await chmod(path.join(f.dir, "source.txt"), 0o755);
  else { await unlink(path.join(f.dir, "bridge")); await symlink("other.txt", path.join(f.dir, "bridge")); }
  const recordRoot = path.join(f.dir, path.dirname(f.config.deliveryRecordPath));
  const record = JSON.parse(await readFile(path.join(recordRoot, (await readdir(recordRoot))[0]!), "utf8"));
  const capture = await captureScopedCandidate({ rootDir: f.dir, config: f.config, workspaceId: "foreign-verifier", computeIdentity: withDeliverableIdentity() });
  expect(capture.ok).toBe(true); if (!capture.ok) throw new Error("capture failed");
  await expect(capturePortableVerificationInputs(f.dir, f.config, capture.candidate, record)).rejects.toMatchObject({ blockers: [expect.objectContaining({ code: "portable_scoped_inputs_invalid" })] });
}, 60000);

it("binds changed injected base context", async () => {
 const f=await fixture(); f.env["FAIL"]="0"; const old=await f.git("rev-parse","origin/main"); f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(p=>({...p,gitContext:"full"}))}}); const a=f.config.providers[0]!;
 f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:[process.execPath,"-e",`if(require('child_process').execFileSync('git',['rev-parse',process.env.DELIVERY_CHECK_BASE_REF],{encoding:'utf8'}).trim()!==${JSON.stringify(old)})process.exit(7);require('fs').writeFileSync('result-a.json','{}')`]}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);
 const moved=await f.git("-c","commit.gpgsign=false","commit-tree",await f.git("rev-parse","origin/main^{tree}"),"-p",old,"-m","advance base");await f.git("update-ref","refs/heads/origin/main",moved);
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);
 expect(await f.run("gate"),f.err.join("\n")+f.out.join("\n")).toBe(1);
},60000);

it.each(["ref", "tipSha", "mergeBaseSha"] as const)("portable scoped identity binds selected base %s", async member => {
  const { readdir } = await import("node:fs/promises");
  const { capturePortableVerificationInputs, withDeliverableIdentity } = await import("@agent-delivery-harness/kernel");
  const { captureScopedCandidate } = await import("./scoped-candidate.ts");
  const f = await fixture(); f.env["FAIL"] = "0";
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(await f.run("record"), f.err.join("\n")).toBe(0); await f.git("add", ".");
  const recordRoot = path.join(f.dir, path.dirname(f.config.deliveryRecordPath));
  const record = JSON.parse(await readFile(path.join(recordRoot, (await readdir(recordRoot))[0]!), "utf8"));
  const capture = await captureScopedCandidate({ rootDir: f.dir, config: f.config, workspaceId: "foreign-verifier", computeIdentity: withDeliverableIdentity() });
  expect(capture.ok).toBe(true); if (!capture.ok) throw new Error("capture failed");
  await expect(capturePortableVerificationInputs(f.dir, f.config, capture.candidate, record)).resolves.toBeDefined();
  const changed = { ...capture.candidate, base: { ...capture.candidate.base, [member]: member === "ref" ? "origin/other" : "f".repeat(40) } };
  await expect(capturePortableVerificationInputs(f.dir, f.config, changed, record)).rejects.toMatchObject({ blockers: [expect.objectContaining({ code: "portable_scoped_inputs_invalid" })] });
}, 60000);

it("full Git context binds original HEAD independently of source and base", async () => {
 const f=await fixture();f.env["FAIL"]="0"; const old=await f.git("rev-parse","HEAD"); const a=f.config.providers[0]!;
 f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(p=>({...p,gitContext:"full"}))},providers:[{...a,check:{...a.check!,command:[process.execPath,"-e",`if(process.env.DELIVERY_CHECK_ORIGIN_HEAD!==${JSON.stringify(old)})process.exit(7);require('fs').writeFileSync('result-a.json','{}')`]}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);
 const tree=await f.git("rev-parse","HEAD^{tree}"); await f.git("-c","commit.gpgsign=false","commit","--allow-empty","-qm","advance HEAD only");expect(await f.git("rev-parse","HEAD^{tree}")).toBe(tree);
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.out.join("\n")+f.err.join("\n")).toBe(1);
},60000);
it("file-only checks cannot discover repository metadata or injected Git coordinates", async () => {
 const f=await fixture(); f.env["FAIL"]="0"; const a=f.config.providers[0]!;
 f.setConfig({...f.config,providers:[{...a,check:{...a.check!,command:[process.execPath,"-e","if(require('fs').existsSync('.git')||Object.keys(process.env).some(k=>k.startsWith('DELIVERY_CHECK_'))||require('child_process').spawnSync('git',['rev-parse','HEAD']).status===0)process.exit(7);require('fs').writeFileSync('result-a.json','{}')"]}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);
},60000);
it("full context verifies record-only transport but reruns on report changes", async () => {
 const f=await fixture(); f.env["FAIL"]="0";
 f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(({gitContext,...p})=>p)}});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("record"),f.err.join("\n")).toBe(0);
 await f.git("add",".");expect(await f.run("verify"),f.err.join("\n")).toBe(0);
 await f.git("-c","commit.gpgsign=false","commit","-qm","record");expect(await f.run("verify"),f.err.join("\n")).toBe(0);
 const foreign=await mkdtemp(path.join(tmpdir(),"scoped-full-foreign-"));dirs.push(foreign);
 await exec("git",["clone","--no-local",f.dir,foreign]);await exec("git",["update-ref","refs/remotes/origin/main",await f.git("rev-parse","origin/main")],{cwd:foreign});
 expect(await runCli(["verify"],{...f.runtime,cwd:foreign}),f.err.join("\n")).toBe(0);
 const transportHead=await f.git("rev-parse","HEAD");await f.git("-c","commit.gpgsign=false","commit","--allow-empty","-qm","arbitrary HEAD movement");
 expect(await f.run("verify"),f.err.join("\n")).toBe(1);expect(f.err.join("\n")).toContain("portable_scoped_inputs_invalid");
 await f.git("update-ref","HEAD",transportHead);
 await mkdir(path.join(f.dir,"docs/reports"),{recursive:true});await writeFile(path.join(f.dir,"docs/reports/new.md"),"report");await f.git("add",".");
 expect(await f.run("verify"),f.err.join("\n")).toBe(1);expect(f.err.join("\n")).toContain("portable_scoped_inputs_invalid");
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);expect(f.out.join("\n")).toContain("checking check.a");expect(f.out.join("\n")).not.toContain("reusing check.a");
},60000);
it("refuses an unknown Git context before expensive preparation", () => {
 const profile={id:"fixture",gitContext:"partial",dependencyInputs:[],mutableOutputs:[],credentialIdentities:{}};
 expect(()=>defineHarnessConfig({...base,scopedExecution:{version:"scoped-execution/1",mechanicalProviders:[],profiles:[profile]}} as unknown as HarnessConfigInput)).toThrow();
});

it("full Git context binds staged raw-tree changes with fixed HEAD and base", async()=>{
 const f=await fixture();f.env["FAIL"]="0";const old=await f.git("rev-parse","HEAD^{tree}");const head=await f.git("rev-parse","HEAD");const a=f.config.providers[0]!;
 f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(({gitContext,...p})=>p)},providers:[{...a,check:{...a.check!,command:[process.execPath,"-e",`if(process.env.DELIVERY_CHECK_ORIGIN_TREE!==${JSON.stringify(old)})process.exit(7);require('fs').writeFileSync('result-a.json','{}')`]}},f.config.providers[1]!]});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.err.join("\n")).toBe(0);
 await mkdir(path.join(f.dir,"docs/reports"),{recursive:true});await writeFile(path.join(f.dir,"docs/reports/new.md"),"report");await f.git("add",".");expect(await f.git("rev-parse","HEAD")).toBe(head);
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("gate"),f.out.join("\n")+f.err.join("\n")).toBe(1);
},60000);
it.each(["nonneutral","merge","bound"])("full-context transport rejects %s history",async(kind)=>{
 const f=await fixture();f.env["FAIL"]="0";f.setConfig({...f.config,scopedExecution:{...f.config.scopedExecution!,profiles:f.config.scopedExecution!.profiles.map(({gitContext,...p})=>p)}});
 expect(await f.run("prepare"),f.err.join("\n")).toBe(0);expect(await f.run("record"),f.err.join("\n")).toBe(0);await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","record");expect(await f.run("verify"),f.err.join("\n")).toBe(0);
 const transport=await f.git("rev-parse","HEAD");const tree=await f.git("rev-parse","HEAD^{tree}");
 if(kind==="nonneutral"){
  await writeFile(path.join(f.dir,"source.txt"),"changed");await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","nonneutral");
  await writeFile(path.join(f.dir,"source.txt"),"source");await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","restore");
 }else if(kind==="merge"){
  const side=await f.git("-c","commit.gpgsign=false","commit-tree",tree,"-p",transport,"-m","side");
  const merge=await f.git("-c","commit.gpgsign=false","commit-tree",tree,"-p",transport,"-p",side,"-m","merge");await f.git("update-ref","HEAD",merge);
 }else{
  const bump=path.join(f.dir,"delivery/records/transport.txt");
  for(let i=0;i<63;i++){await writeFile(bump,String(i));await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm",`transport ${i}`);}
  expect(await f.run("verify"),f.err.join("\n")).toBe(0);
  await writeFile(bump,"64");await f.git("add",".");await f.git("-c","commit.gpgsign=false","commit","-qm","transport 64");
 }
 if(kind!=="bound")expect(await f.git("rev-parse","HEAD^{tree}")).toBe(tree);
 expect(await f.run("verify"),f.err.join("\n")).toBe(1);expect(f.err.join("\n")).toContain("portable_scoped_inputs_invalid");
},120000);

// Dynamic adopters derive the selection from immutable Git objects, then put
// this native snapshot guard first in the mandatory mechanical provider list.
it.each(["candidate", "base", "head", "guard"])("a mandatory snapshot selection guard rejects the %s derivation race before selected checks", async (race) => {
  const f = await fixture(); f.env["FAIL"] = "0";
  const selected = { tree: await f.git("write-tree"), head: await f.git("rev-parse", "HEAD"), base: await f.git("rev-parse", "origin/main"), mergeBase: await f.git("merge-base", "HEAD", "origin/main") };
  Object.assign(f.env, { SELECTION_TREE: selected.tree, SELECTION_HEAD: selected.head, SELECTION_BASE: selected.base, SELECTION_MERGE_BASE: selected.mergeBase });
  const guard = {
    id: "check.selection", findingCodes: [], check: {
      command: [process.execPath, "-e", `const {execFileSync}=require('node:child_process');const expected={tree:process.env.SELECTION_TREE,head:process.env.SELECTION_HEAD,base:process.env.SELECTION_BASE,mergeBase:process.env.SELECTION_MERGE_BASE};const actual={tree:process.env.DELIVERY_CHECK_ORIGIN_TREE,head:process.env.DELIVERY_CHECK_ORIGIN_HEAD,base:execFileSync('git',['rev-parse',process.env.DELIVERY_CHECK_BASE_REF],{encoding:'utf8'}).trim(),mergeBase:process.env.DELIVERY_CHECK_MERGE_BASE};if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('selection_snapshot_mismatch');`],
      timeoutMs: 5000, scope: { version: "scoped-check/1", files: [], memberships: [], tests: [], cwd: ".", profile: "selection", environment: ["SELECTION_TREE", "SELECTION_HEAD", "SELECTION_BASE", "SELECTION_MERGE_BASE"].map(name => ({ name, kind: "flag" })) },
    },
  };
  f.setConfig({ ...f.config, providers: [guard, ...f.config.providers],
    obligations: [{ ...f.config.obligations[0]!, id: "selection.passed", providers: [guard.id] }, ...f.config.obligations],
    scopedExecution: { ...f.config.scopedExecution!, mechanicalProviders: [guard.id, "check.a"], profiles: [{ id: "selection", gitContext: "full", dependencyInputs: [], mutableOutputs: [], credentialIdentities: {} }, ...f.config.scopedExecution!.profiles] },
  } as unknown as HarnessConfigInput);
  // Clean positive control: the expected immutable objects are precisely the
  // captured snapshot, and downstream checks really execute.
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  expect(f.out.join("\n")).toContain("checking check.a");
  if (race === "candidate") await writeFile(path.join(f.dir, "new-consumer.ts"), "export const consumer = true;\n");
  if (race === "head") await f.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "head advanced");
  if (race === "base") {
    const moved = await f.git("-c", "commit.gpgsign=false", "commit-tree", selected.tree, "-p", selected.base, "-m", "base advanced");
    await f.git("update-ref", "refs/heads/origin/main", moved);
  }
  if (race === "guard") f.setConfig({ ...f.config, providers: f.config.providers.map(p => p.id === guard.id ? { ...p, check: { ...p.check!, command: [process.execPath, "-e", "process.exit(1)"] } } : p) });
  // Bypassing preparation cannot reuse the old successful guard or receipt.
  expect(await f.run("gate")).toBe(1);
  expect(f.out.join("\n")).not.toContain("checking check.a");
  expect(await f.run("record")).toBe(1);
  expect(await f.run("prepare"), f.err.join("\n")).toBe(1);
  expect(f.err.join("\n")).toContain("check_command_failed");
  expect(f.err.join("\n")).toContain("check.selection");
  expect(f.out.join("\n")).not.toContain("checking check.a");
  expect(await f.run("review-context")).toBe(1);
  expect(await f.run("gate")).toBe(1);
  expect(await f.run("record")).toBe(1);
}, 60000);
