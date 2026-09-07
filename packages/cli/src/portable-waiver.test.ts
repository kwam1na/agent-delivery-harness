import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it, expect } from "vitest";
import { defineHarnessConfig, createArtifactsPort, runGitCommand } from "@agent-delivery-harness/kernel";
import adopter from "../../../harness.config.ts";
import { runAction } from "../../action/src/main.ts";
import { runCli, type CliRuntime } from "./index.ts";

const exec = promisify(execFile);
it("rejects a report change after approval while allowing the record transport commit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "portable-waiver-"));
  try {
    const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
    const commit = async (message: string) => {
      await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", message);
    };
    await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
    await writeFile(path.join(dir, "harness.config.ts"), "export default {};\n");
    await writeFile(path.join(dir, "source.ts"), "base\n");
    await commit("base"); await git("branch", "origin/main");
    await writeFile(path.join(dir, "source.ts"), "change\n"); await commit("candidate");
    const config = defineHarnessConfig({ ...adopter, preparationCommands: [], preparationWiringPaths: ["harness.config.ts"],
      obligations: [{ ...adopter.obligations[0]!, activation: { kind: "always" }, humanWaiverAllowed: true,
        allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"] }],
    });
    const errors: string[] = [];
    const runtime: CliRuntime = { cwd: dir, env: {}, stdinIsTTY: true, stdoutIsTTY: true,
      stdout: () => {}, stderr: text => errors.push(text), loadConfig: async () => config,
      artifacts: createArtifactsPort({ runRootBase: path.join(dir, ".git/artifacts") }),
      promptForWaiver: async () => ({ author: "Operator", reason: "This candidate only" }),
    };
    const cli = async (...args: string[]) => { errors.length = 0; return runCli(args, runtime); };
    const action = async () => runAction({ workspace: dir,
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: ".git/event.json" }, git: runGitCommand,
      readFile: async () => JSON.stringify({ pull_request: {
        head: { sha: await git("rev-parse", "HEAD"), ref: "feature" },
        base: { sha: await git("rev-parse", "origin/main"), ref: "main" },
      } }), loadConfig: async () => config, writeSummary: async () => {}, log: () => {},
    });
    expect(await cli("prepare"), errors.join("\n")).toBe(0);
    expect(await cli("gate"), errors.join("\n")).toBe(0);
    expect(await cli("record"), errors.join("\n")).toBe(0);
    await commit("record");
    expect(await cli("verify"), errors.join("\n")).toBe(0);
    expect((await action()).ok).toBe(true);

    await mkdir(path.join(dir, "docs/reports"), { recursive: true });
    await writeFile(path.join(dir, "docs/reports/changed.md"), "Different operator report\n"); await commit("report");
    expect(await cli("verify")).toBe(1);
    expect(errors.join("\n")).toContain("record_waiver_invalid");
    const rejected = await action();
    expect(rejected.ok).toBe(false);
    expect(rejected.blockers.map(blocker => blocker.code)).toContain("record_waiver_invalid");
    expect(await cli("prepare")).toBe(0);
    expect(await runCli(["gate"], { ...runtime, promptForWaiver: async () => false })).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
