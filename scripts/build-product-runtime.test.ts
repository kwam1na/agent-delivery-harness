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
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 15_000);
