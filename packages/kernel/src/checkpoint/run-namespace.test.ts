/**
 * The common-directory namespace resolver: one place that turns "the worktree
 * I was invoked in" into "the store every worktree of this repository shares".
 *
 * Written RED before `run-namespace.ts` existed.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MANAGED_DELIVERY_NAMESPACE,
  gitNamespaceClearedEnvironment,
  resolveCommonDirectoryNamespace,
  resolveRunStoreLocation,
  runGitDirect,
  type NamespaceGitRunner,
} from "./run-namespace.ts";

let scratch: string;
let repo: string;
let linked: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "run-namespace-"));
  repo = path.join(scratch, "repo");
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" });
  git(repo, "config", "user.email", "harness@example.invalid");
  git(repo, "config", "user.name", "harness");
  await writeFile(path.join(repo, "file.txt"), "one\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-q", "-m", "one");
  linked = path.join(scratch, "linked");
  git(repo, "worktree", "add", "-q", "-b", "side", linked);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("the namespace resolver", () => {
  it("asks git for exactly the common directory, so the facade's launch inventory is unchanged", async () => {
    const launches: { cwd: string; args: readonly string[]; env?: Record<string, string> }[] = [];
    const run: NamespaceGitRunner = async (input) => {
      launches.push(input);
      return { code: 0, stdout: "/tmp/somewhere/.git\n" };
    };
    const resolved = await resolveCommonDirectoryNamespace({ cwd: "/tmp/anywhere", run });
    expect(launches).toEqual([{ cwd: "/tmp/anywhere", args: ["rev-parse", "--path-format=absolute", "--git-common-dir"] }]);
    expect(resolved).toEqual({
      ok: true,
      commonDir: "/tmp/somewhere/.git",
      namespaceDir: path.join("/tmp/somewhere/.git", MANAGED_DELIVERY_NAMESPACE),
    });
  });

  it("reports the missing repository rather than inventing a path", async () => {
    const run: NamespaceGitRunner = async () => ({ code: 128, stdout: "" });
    const resolved = await resolveCommonDirectoryNamespace({ cwd: "/tmp/nowhere", run });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("/tmp/nowhere");
  });

  it("passes the caller's environment through to the runner and to nothing else", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const run: NamespaceGitRunner = async (input) => {
      seen.push(input.env);
      return { code: 0, stdout: "/tmp/x/.git\n" };
    };
    await resolveCommonDirectoryNamespace({ cwd: "/tmp/x", run });
    await resolveCommonDirectoryNamespace({ cwd: "/tmp/x", run, env: { PATH: "/usr/bin" } });
    expect(seen).toEqual([undefined, { PATH: "/usr/bin" }]);
  });
});

describe("the run store location", () => {
  it("resolves the shared store and a per-worktree key from one rev-parse", async () => {
    const launches: readonly string[][] = [];
    const run: NamespaceGitRunner = async (input) => {
      (launches as string[][]).push([...input.args]);
      return { code: 0, stdout: "/tmp/repo/.git/worktrees/side\n/tmp/repo/.git\n" };
    };
    const resolved = await resolveRunStoreLocation({ cwd: "/tmp/linked", run });
    expect(launches).toEqual([["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.commonDir).toBe("/tmp/repo/.git");
    expect(resolved.runsDir).toBe(path.join("/tmp/repo/.git", MANAGED_DELIVERY_NAMESPACE, "runs"));
    expect(resolved.worktreeKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives every worktree of one repository the same store and its own pointer key", async () => {
    const env = gitNamespaceClearedEnvironment();
    const main = await resolveRunStoreLocation({ cwd: repo, run: runGitDirect, env });
    const side = await resolveRunStoreLocation({ cwd: linked, run: runGitDirect, env });
    expect(main.ok && side.ok).toBe(true);
    if (!main.ok || !side.ok) return;
    expect(side.runsDir).toBe(main.runsDir);
    expect(side.worktreeKey).not.toBe(main.worktreeKey);
  });

  it("ignores an inherited GIT_DIR and GIT_COMMON_DIR naming another repository", async () => {
    const elsewhere = path.join(scratch, "elsewhere.git");
    const honest = await resolveRunStoreLocation({ cwd: repo, run: runGitDirect, env: gitNamespaceClearedEnvironment() });
    const saved = { dir: process.env["GIT_DIR"], common: process.env["GIT_COMMON_DIR"] };
    process.env["GIT_DIR"] = elsewhere;
    process.env["GIT_COMMON_DIR"] = elsewhere;
    try {
      const scrubbed = await resolveRunStoreLocation({ cwd: repo, run: runGitDirect, env: gitNamespaceClearedEnvironment() });
      expect(scrubbed).toEqual(honest);
    } finally {
      if (saved.dir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved.dir;
      if (saved.common === undefined) delete process.env["GIT_COMMON_DIR"];
      else process.env["GIT_COMMON_DIR"] = saved.common;
    }
  });

  it("clears the whole GIT_ namespace and disables prompts and optional locks", () => {
    const saved = process.env["GIT_AUTHOR_NAME"];
    process.env["GIT_AUTHOR_NAME"] = "someone";
    try {
      const env = gitNamespaceClearedEnvironment();
      expect(Object.keys(env).filter((name) => name.startsWith("GIT_"))).toEqual(["GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS"]);
      expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
      expect(env["GIT_OPTIONAL_LOCKS"]).toBe("0");
    } finally {
      if (saved === undefined) delete process.env["GIT_AUTHOR_NAME"];
      else process.env["GIT_AUTHOR_NAME"] = saved;
    }
  });
});
