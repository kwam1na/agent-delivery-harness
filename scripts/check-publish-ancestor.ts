import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface GitCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitCommandRunner = (command: string, args: readonly string[]) => GitCommandResult;

const runGit: GitCommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error === undefined ? "" : `${result.error.message}\n`}`,
  };
};

function failureOutput(result: GitCommandResult): string {
  return `${result.stdout}${result.stderr}`.trim() || `git exited ${result.status}`;
}

/** Fetch and require the tag commit to be reachable from the actual default branch. */
export function requirePublishCommitOnDefaultBranch(
  tagCommit: string,
  defaultBranch: string,
  run: GitCommandRunner = runGit,
): string {
  if (tagCommit.length === 0 || defaultBranch.length === 0) {
    throw new Error("publish ancestor check requires a tag commit and default branch");
  }

  const branchRef = `refs/heads/${defaultBranch}`;
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  const validRef = run("git", ["check-ref-format", branchRef]);
  if (validRef.status !== 0) {
    throw new Error(`invalid default branch ${JSON.stringify(defaultBranch)}: ${failureOutput(validRef)}`);
  }

  const fetched = run("git", ["fetch", "--no-tags", "origin", `+${branchRef}:${remoteRef}`]);
  if (fetched.status !== 0) {
    throw new Error(`could not fetch the default branch ${defaultBranch}: ${failureOutput(fetched)}`);
  }

  const ancestor = run("git", ["merge-base", "--is-ancestor", tagCommit, remoteRef]);
  if (ancestor.status === 1) {
    throw new Error(`tag commit ${tagCommit} is not an ancestor of the default branch ${defaultBranch}`);
  }
  if (ancestor.status !== 0) {
    throw new Error(`could not verify tag commit ${tagCommit} against ${defaultBranch}: ${failureOutput(ancestor)}`);
  }
  return remoteRef;
}

function main(): void {
  const [tagCommit, defaultBranch] = process.argv.slice(2);
  if (tagCommit === undefined || defaultBranch === undefined) {
    console.error("usage: check-publish-ancestor <tag-commit> <default-branch>");
    process.exitCode = 1;
    return;
  }

  try {
    const remoteRef = requirePublishCommitOnDefaultBranch(tagCommit, defaultBranch);
    console.log(`publish ancestry: ${tagCommit} is reachable from ${remoteRef}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === path.resolve(invokedPath)) main();
