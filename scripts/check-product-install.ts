/** Exercise a supplied, already-built product artifact in an isolated consumer. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { install, parseInstallArgs } from "./install-agent-skills-release.ts";
import { buildProductRuntime } from "./build-product-runtime.ts";

async function main(): Promise<void> {
  const request = parseInstallArgs(process.argv.slice(2));
  const consumer = await mkdtemp(path.join(os.tmpdir(), "delivery-product-consumer-"));
  const run = promisify(execFile);
  try {
    await run("git", ["init", "-q", "-b", "main"], { cwd: consumer });
    await run("git", ["config", "user.name", "Artifact sensor"], { cwd: consumer });
    await run("git", ["config", "user.email", "artifact-sensor@example.invalid"], { cwd: consumer });
    await writeFile(path.join(consumer, "package.json"), '{"type":"module"}\n');
    // The adopter supplies configuration; only the installed artifact executes it.
    const config = (await readFile("harness.config.ts", "utf8")).replace(/preparationWiringPaths: \[[^\n]*\]/, 'preparationWiringPaths: ["harness.config.ts", "package.json"]').replace(/  preparationCommands: \[[\s\S]*?\n  \],\n/, "");
    await writeFile(path.join(consumer, "harness.config.ts"), config);
    await writeFile(path.join(consumer, ".gitignore"), ".agent-skills/\n.agents/\n.claude/\n");
    await run("git", ["add", "."], { cwd: consumer });
    await run("git", ["commit", "-qm", "consumer base"], { cwd: consumer });
    await run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: consumer });
    await install(request, consumer);
    // Producer qualification also proves the artifact carries this source's
    // exact runtime closure. Consumer execution below still uses installed bytes.
    const descriptor = JSON.parse(await readFile(path.join(consumer, ".agent-skills/current/runtime/runtime.json"), "utf8")) as { workflowContentSha256: string; files: unknown };
    const workflowManifest = path.join(consumer, "qualified-workflow.json");
    await writeFile(workflowManifest, JSON.stringify({ schemaVersion: "agent-skills-release/1", contentSha256: descriptor.workflowContentSha256 }));
    const rebuilt = path.join(consumer, "rebuilt-runtime");
    await buildProductRuntime(process.cwd(), workflowManifest, rebuilt);
    const currentDescriptor = JSON.parse(await readFile(path.join(rebuilt, "runtime.json"), "utf8")) as { files: unknown };
    if (JSON.stringify(currentDescriptor.files) !== JSON.stringify(descriptor.files)) throw new Error("artifact sensor: installed runtime differs from current producer source");
    await rm(rebuilt, { recursive: true });
    await rm(workflowManifest);
    await writeFile(path.join(consumer, "change.txt"), "candidate\n");
    await run("git", ["add", "change.txt"], { cwd: consumer });
    for (const host of [".agents", ".claude"]) await readFile(path.join(consumer, host, "skills/execute-work/SKILL.md"));
    const args = ["-B", path.join(consumer, ".agent-skills/current"), "--root", consumer, "harness"];
    for (const command of ["check", "prepare", "review-context"]) {
      const result = await run("python3", [...args, command], { cwd: consumer, timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONPATH: "", NODE_PATH: "" } });
      process.stdout.write(`${command}: ${result.stdout}\n`);
    }
    // No independent review was acquired here; the actual gate must refuse it.
    const gate = await run("python3", [...args, "gate"], { cwd: consumer, timeout: 60_000, maxBuffer: 1024 * 1024 }).then(
      () => { throw new Error("artifact sensor: gate accepted absent review evidence"); },
      (error: { stderr?: string }) => error.stderr ?? "",
    );
    if (!gate.includes("review") || !gate.includes("missing")) throw new Error(`artifact sensor: unexpected gate refusal: ${gate}`);
    process.stdout.write("artifact consumer: both exposures, installed check/prepare/context, and missing-review refusal passed\n");
  } finally { await rm(consumer, { recursive: true, force: true }); }
}

await main();
