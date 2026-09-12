/** Opt-in worktree capture through a private index; the author's staging is untouched. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { captureGitCandidate, type CandidateCaptureOptions, type CandidateCommandRunner } from "@agent-delivery-harness/kernel";
const exec = promisify(execFile);
export async function captureScopedCandidate(options: CandidateCaptureOptions) {
  const dir = await mkdtemp(path.join(tmpdir(), "delivery-index-"));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_INDEX_FILE: path.join(dir, "index"), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  const run: CandidateCommandRunner = async (command, invocation) => {
    try {
      const result = await exec(command[0]!, command.slice(1), { cwd: invocation.cwd, env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      return { exitCode: 0, stdout: result.stdout.toString("utf8"), ...(invocation.captureBytes ? { stdoutBase64: result.stdout.toString("base64") } : {}), stderr: result.stderr.toString("utf8") };
    } catch (error) {
      const failure = error as { code?: number; stdout?: Buffer; stderr?: Buffer };
      return { exitCode: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout?.toString("utf8") ?? "", stderr: failure.stderr?.toString("utf8") ?? "Git capture failed" };
    }
  };
  try {
    for (const args of [["read-tree", "HEAD"], ["add", "--all"]]) {
      const result = await run(["git", ...args], { cwd: options.rootDir });
      if (result.exitCode !== 0) throw new Error("Cannot capture source into a private index");
    }
    return await captureGitCandidate({ ...options, run });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
