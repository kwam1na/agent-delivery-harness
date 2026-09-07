import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { buildProductRuntime } from "./build-product-runtime.ts";

it("runs bundled CLI and a typed consumer config without installed packages", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-"));
  try {
    const manifest = path.join(temporary, "workflow.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: "agent-skills-release/1", contentSha256: "a".repeat(64) }));
    const runtime = path.join(temporary, "runtime");
    await buildProductRuntime(process.cwd(), manifest, runtime);
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: temporary });
    await writeFile(path.join(temporary, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(temporary, "harness.config.ts"), (await readFile("harness.config.ts", "utf8")).replace("delivery-harness.pr-admission", "artifact-consumer"));
    const args = ["--experimental-strip-types", "--import", path.join(runtime, "bootstrap.mjs"), path.join(runtime, "cli.mjs")];
    const help = await run(process.execPath, [...args, "--help"], { cwd: temporary, env: { ...process.env, NODE_PATH: "" } });
    expect(help.stdout).toContain("submit-evidence");
    const check = await run(process.execPath, [...args, "check"], { cwd: temporary, env: { ...process.env, NODE_PATH: "" } });
    expect(check.stdout).toContain("artifact-consumer");
    await writeFile(path.join(temporary, "consumer.ts"), `
      import { parseDeliveryRecord, captureGitCandidate, digestDeliverableEntries } from "./runtime/kernel.mjs";
      import { runCli, buildRunExport, parseRunExport, type DeliveryRunExport, type RunExportParseResult, type CliRuntime } from "./runtime/cli-api.mjs";
      export const inspect = (text: string) => parseDeliveryRecord(text);
      export const check = (runtime: CliRuntime) => runCli(["check"], runtime);
      export const parse = (value: DeliveryRunExport): RunExportParseResult => parseRunExport(JSON.stringify(value));
      void buildRunExport;
      void captureGitCandidate; void digestDeliverableEntries;
      // @ts-expect-error The shipped parser must retain its actual typed input.
      parseDeliveryRecord(42);
    `);
    await run(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--types", "node", "--typeRoots", path.resolve("node_modules/@types"), "consumer.ts"], { cwd: temporary });
    const parsed = await run(process.execPath, ["--input-type=module", "-e", 'import { buildRunExport, parseRunExport } from "./runtime/cli-api.mjs"; const value = buildRunExport({ runId: "run-1234567890abcdef", events: [] }); if (!parseRunExport(JSON.stringify(value)).ok || parseRunExport("{}").ok) process.exit(1);'], { cwd: temporary, env: { ...process.env, NODE_PATH: "" } });
    expect(parsed.stderr).toBe("");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 15_000);
