import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { defineHarnessConfig, type HarnessConfig, type RunEvent } from "@agent-delivery-harness/kernel";
import adopterConfig from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";
import { resolveRunSurface } from "./run-surface.ts";
import { parseRunExport } from "./run-export.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(version = 2) {
  const root = await mkdtemp(path.join(tmpdir(), "preparation-telemetry-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "harness.config.ts"), "export default {};\n");
  await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture"); git("branch", "origin/main");
  let config: HarnessConfig = defineHarnessConfig({ ...adopterConfig, preparationWiringPaths: ["harness.config.ts"], preparationCommands: [{
    id: "mechanical", timeoutMs: 5000,
    command: [process.execPath, "-e", "const f=require('fs');f.appendFileSync('.git/mechanical','x');if(f.existsSync('.git/fail'))process.exit(3)"],
  }] });
  const out: string[] = [], err: string[] = [];
  const runtime: CliRuntime = { cwd: root, env: {}, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: text => out.push(text), stderr: text => err.push(text), loadConfig: async () => config };
  const run = (...args: string[]) => runCli(args, runtime);
  expect(await run("emit", "run.started", "--version", String(version), ...(version === 2 ? ["--event-id", "start"] : []), "--json", JSON.stringify({ host: "codex", workflow: { releaseId: "fixture", profile: "core" } }))).toBe(0);
  const resolved = await resolveRunSurface(root); if (!resolved.ok) throw Error(resolved.reason);
  const { store, worktreeKey } = resolved.surface;
  const current = await store.current(worktreeKey); if (!current.ok || !current.runId) throw Error("missing run");
  const runId = current.runId;
  const read = async () => { const result = await store.read(runId); if (!result.ok) throw Error("invalid journal"); return result.events; };
  const completions = async () => (await read()).filter(event => event.kind === "command.completed" && event.payload["command"] === "prepare");
  return { root, git, run, runtime, out, err, runId, completions, setConfig: (value: HarnessConfig) => { config = value; }, getConfig: () => config };
}
const preparation = (event: RunEvent | undefined) => event?.payload["preparation"];

it("exports actual ordinary execution, neutral reuse, and invalidated refresh execution after source removal", async () => {
  const f = await fixture();
  expect(await f.run("prepare"), f.err.join("\n")).toBe(0);
  await mkdir(path.join(f.root, "delivery/records"), { recursive: true });
  await writeFile(path.join(f.root, "delivery/records/neutral.json"), "{}"); f.git("add", ".");
  expect(await f.run("prepare", "--refresh-record-neutral")).toBe(0);
  expect(await readFile(path.join(f.root, ".git/mechanical"), "utf8")).toBe("x");
  await writeFile(path.join(f.root, "source.ts"), "export const value = 2;\n"); f.git("add", ".");
  expect(await f.run("prepare", "--refresh-record-neutral")).toBe(0);
  expect(await readFile(path.join(f.root, ".git/mechanical"), "utf8")).toBe("xx");
  const destination = await mkdtemp(path.join(tmpdir(), "preparation-export-")); roots.push(destination);
  const output = path.join(destination, "run.json");
  expect(await f.run("runs", "export", f.runId, "--output", output)).toBe(0);
  await rm(f.root, { recursive: true, force: true });
  const transported = parseRunExport(await readFile(output, "utf8"));
  expect(transported.ok).toBe(true); if (!transported.ok) throw Error("invalid export");
  expect(transported.value.events.filter(event => event.kind === "command.completed").map(preparation)).toEqual([
    { checks: "executed", reason: "ordinary" },
    { checks: "reused", reason: "validation-equivalent" },
    { checks: "executed", reason: "receipt-not-reusable" },
  ]);
  // Earlier v2 producers omitted this optional member. The reader preserves
  // that absence even when adjacent completions have known decisions.
  const legacy = JSON.parse(await readFile(output, "utf8"));
  const lastCompletion = legacy.events.filter((event: RunEvent) => event.kind === "command.completed").at(-1);
  delete lastCompletion.payload.preparation;
  const older = parseRunExport(JSON.stringify(legacy));
  expect(older.ok).toBe(true); if (!older.ok) throw Error("invalid older export");
  expect(older.value.events.filter(event => event.kind === "command.completed").map(preparation)).toEqual([
    { checks: "executed", reason: "ordinary" },
    { checks: "reused", reason: "validation-equivalent" },
    undefined,
  ]);
}, 30_000);

it("keeps failure, interruption, and subsequent refresh authority intact without successful reuse telemetry", async () => {
  const f = await fixture();
  expect(await f.run("prepare")).toBe(0);
  await writeFile(path.join(f.root, "source.ts"), "changed\n"); f.git("add", ".");
  await writeFile(path.join(f.root, ".git/fail"), "fail");
  expect(await f.run("prepare", "--refresh-record-neutral")).toBe(1);
  expect(f.err.join("\n")).toContain("preparation_command_failed");
  expect((await f.completions()).at(-1)?.payload).toMatchObject({ outcome: "policy" });
  expect(preparation((await f.completions()).at(-1))).toBeUndefined();
  expect(await f.run("review-context")).toBe(1);
  await rm(path.join(f.root, ".git/fail"));
  expect(await f.run("prepare", "--refresh-record-neutral")).toBe(0);
  expect(preparation((await f.completions()).at(-1))).toEqual({ checks: "executed", reason: "receipt-not-reusable" });
  const controller = new AbortController(); controller.abort();
  expect(await runCli(["prepare", "--refresh-record-neutral"], { ...f.runtime, signal: controller.signal })).toBe(130);
  expect((await f.completions()).at(-1)?.payload["outcome"]).toBe("interrupted");
  expect(preparation((await f.completions()).at(-1))).toBeUndefined();
  expect(await f.run("review-context")).toBe(1);
  expect(await f.run("prepare", "--refresh-record-neutral")).toBe(0);
  expect(preparation((await f.completions()).at(-1))).toEqual({ checks: "executed", reason: "receipt-not-reusable" });
}, 30_000);

it("keeps legacy completions without a preparation field unknown through export", async () => {
  const f = await fixture(1);
  expect(await f.run("prepare")).toBe(0);
  expect(await f.run("prepare", "--refresh-record-neutral")).toBe(0);
  const destination = await mkdtemp(path.join(tmpdir(), "preparation-legacy-")); roots.push(destination);
  const output = path.join(destination, "run.json");
  expect(await f.run("runs", "export", f.runId, "--output", output)).toBe(0);
  const transported = parseRunExport(await readFile(output, "utf8"));
  expect(transported.ok).toBe(true); if (!transported.ok) throw Error("invalid export");
  expect(transported.value.events.filter(event => event.kind === "command.completed").map(preparation)).toEqual([undefined, undefined]);
}, 30_000);

it("records an interrupted executing check without a preparation success or reusable receipt", async () => {
  const f = await fixture();
  f.setConfig(defineHarnessConfig({ ...f.getConfig(), preparationCommands: [{ id: "mechanical", timeoutMs: 5000,
    command: [process.execPath, "-e", "require('fs').writeFileSync('.git/running','yes');setInterval(()=>{},1000)"],
  }] }));
  const controller = new AbortController();
  const pending = runCli(["prepare", "--refresh-record-neutral"], { ...f.runtime, signal: controller.signal });
  try {
    const deadline = Date.now() + 4000;
    while (!existsSync(path.join(f.root, ".git/running")) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(existsSync(path.join(f.root, ".git/running"))).toBe(true);
  } finally {
    controller.abort();
  }
  expect(await pending).toBe(130);
  expect((await f.completions()).at(-1)?.payload["outcome"]).toBe("interrupted");
  expect(preparation((await f.completions()).at(-1))).toBeUndefined();
  expect(await f.run("review-context")).toBe(1);
}, 30_000);
