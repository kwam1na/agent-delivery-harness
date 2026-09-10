import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  requirePublishCommitOnDefaultBranch,
  type GitCommandResult,
  type GitCommandRunner,
} from "./check-publish-ancestor.ts";

const TAG_COMMIT = "1111111111111111111111111111111111111111";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(repoRoot, "scripts/check-publish-ancestor.ts");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function gitResult(status: number, stdout = "", stderr = ""): GitCommandResult {
  return { status, stdout, stderr };
}

describe("the publish tag ancestor guard", () => {
  it("accepts a tag commit that is an ancestor of the repository's default branch", () => {
    const run = vi
      .fn<GitCommandRunner>()
      .mockReturnValueOnce(gitResult(0))
      .mockReturnValueOnce(gitResult(0))
      .mockReturnValueOnce(gitResult(0));

    expect(requirePublishCommitOnDefaultBranch(TAG_COMMIT, "trunk", run)).toBe("refs/remotes/origin/trunk");
    expect(run).toHaveBeenNthCalledWith(1, "git", ["check-ref-format", "refs/heads/trunk"]);
    expect(run).toHaveBeenNthCalledWith(2, "git", [
      "fetch",
      "--no-tags",
      "origin",
      "+refs/heads/trunk:refs/remotes/origin/trunk",
    ]);
    expect(run).toHaveBeenNthCalledWith(3, "git", [
      "merge-base",
      "--is-ancestor",
      TAG_COMMIT,
      "refs/remotes/origin/trunk",
    ]);
  });

  it("refuses a tag commit that is not an ancestor of the default branch", () => {
    const run = vi
      .fn<GitCommandRunner>()
      .mockReturnValueOnce(gitResult(0))
      .mockReturnValueOnce(gitResult(0))
      .mockReturnValueOnce(gitResult(1));

    expect(() => requirePublishCommitOnDefaultBranch(TAG_COMMIT, "main", run)).toThrow(
      /tag commit .* is not an ancestor of the default branch main/u,
    );
  });

  it("fails closed when the default branch cannot be fetched", () => {
    const run = vi
      .fn<GitCommandRunner>()
      .mockReturnValueOnce(gitResult(0))
      .mockReturnValueOnce(gitResult(128, "", "fatal: unable to access origin"));

    expect(() => requirePublishCommitOnDefaultBranch(TAG_COMMIT, "main", run)).toThrow(
      /could not fetch the default branch main.*unable to access origin/su,
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the repository supplies an invalid default-branch ref", () => {
    const run = vi.fn<GitCommandRunner>(() => gitResult(1, "", "invalid ref"));

    expect(() => requirePublishCommitOnDefaultBranch(TAG_COMMIT, "bad branch", run)).toThrow(
      /invalid default branch.*bad branch/su,
    );
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("the publish ancestor command against a real repository", () => {
  it("accepts a default-branch commit and refuses an unmerged side-branch commit", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-publish-ancestor-"));
    const origin = path.join(dir, "origin.git");
    const work = path.join(dir, "work");
    const git = (cwd: string, args: readonly string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

    try {
      git(dir, ["init", "--bare", origin]);
      git(dir, ["init", "-b", "trunk", work]);
      git(work, ["config", "user.name", "Publish Guard Test"]);
      git(work, ["config", "user.email", "publish-guard@example.invalid"]);
      writeFileSync(path.join(work, "release.txt"), "base\n", "utf8");
      git(work, ["add", "release.txt"]);
      git(work, ["commit", "-m", "base"]);
      git(work, ["remote", "add", "origin", origin]);
      git(work, ["push", "-u", "origin", "trunk"]);

      writeFileSync(path.join(work, "release.txt"), "merged release\n", "utf8");
      git(work, ["commit", "-am", "merged release"]);
      const mergedCommit = git(work, ["rev-parse", "HEAD"]);
      git(work, ["push", "origin", "trunk"]);

      git(work, ["switch", "-c", "unmerged"]);
      writeFileSync(path.join(work, "release.txt"), "unmerged release\n", "utf8");
      git(work, ["commit", "-am", "unmerged release"]);
      const unmergedCommit = git(work, ["rev-parse", "HEAD"]);

      const accepted = spawnSync(
        process.execPath,
        ["--import", tsxLoader, helperPath, mergedCommit, "trunk"],
        { cwd: work, encoding: "utf8" },
      );
      expect({ status: accepted.status, stderr: accepted.stderr }).toEqual({ status: 0, stderr: "" });
      expect(accepted.stdout).toContain(`is reachable from refs/remotes/origin/trunk`);

      const refused = spawnSync(
        process.execPath,
        ["--import", tsxLoader, helperPath, unmergedCommit, "trunk"],
        { cwd: work, encoding: "utf8" },
      );
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`tag commit ${unmergedCommit} is not an ancestor of the default branch trunk`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
