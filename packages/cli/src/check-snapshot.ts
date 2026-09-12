/** Private execution tree. Never shares writable source, objects, index or dependencies. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createExecPort, digestCanonical } from "@agent-delivery-harness/kernel";

const exec = promisify(execFile);
export class CheckSnapshotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export interface SnapshotRequest {
  readonly rootDir: string;
  readonly candidate: { readonly treeSha: string; readonly headSha: string; readonly base: { readonly ref: string; readonly tipSha: string; readonly mergeBaseSha: string } };
  readonly outputs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly dependencies?: { readonly command: readonly [string, ...string[]]; readonly timeoutMs: number };
  readonly signal?: AbortSignal;
}
export interface CheckSnapshot {
  readonly rootDir: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly dependencyDigest: string;
  verify(): Promise<void>;
  cleanup(): Promise<void>;
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Hash actual private bytes, including dependency symlinks, without following outside links. */
export async function snapshotInventory(root: string, exclude: (relative: string) => boolean): Promise<string> {
  const entries: unknown[] = [];
  const walk = async (relative: string): Promise<void> => {
    if (exclude(relative)) return;
    const absolute = path.join(root, relative), stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (path.isAbsolute(target) || !inside(root, path.resolve(path.dirname(absolute), target))) throw new CheckSnapshotError("check_snapshot_escape", "A snapshot link escapes its private execution tree.");
      // Resolve chains as well as the immediate lexical target.
      try { if (!inside(root, await realpath(absolute))) throw new CheckSnapshotError("check_snapshot_escape", "A snapshot link resolves outside its private execution tree."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      entries.push([relative, "link", target]);
    } else if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await walk(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) entries.push([relative, stat.mode & 0o111, createHash("sha256").update(await readFile(absolute)).digest("hex")]);
    else throw new CheckSnapshotError("check_snapshot_escape", "A snapshot contains an unsupported filesystem entry.");
  };
  await walk(""); return digestCanonical(entries);
}
export function executionPath(root: string, value: string): string {
  return value.split(path.delimiter).filter(p => p && path.isAbsolute(p) && !inside(root, p) && !p.split(path.sep).includes("node_modules")).join(path.delimiter) || "/usr/bin:/bin";
}
export async function createCheckSnapshot(input: SnapshotRequest): Promise<CheckSnapshot> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "delivery-check-"));
  const cleanEnv = { ...input.environment, PATH: executionPath(input.rootDir, input.environment["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
  const git = async (...args: string[]) => (await exec("git", args, { cwd: rootDir, env: cleanEnv, maxBuffer: 128 * 1024 * 1024, ...(input.signal ? { signal: input.signal } : {}) })).stdout.trim();
  const cleanup = async () => {
    try { await rm(rootDir, { recursive: true, force: true }); }
    catch { throw new CheckSnapshotError("check_snapshot_cleanup_failed", "Cannot remove the owned execution snapshot after retaining evidence."); }
  };
  try {
    await git("init", "-q");
    // Fetch transfers object bytes; unlike worktrees/alternates/local clones it
    // cannot create writable links back to the author's Git metadata.
    await git("fetch", "--no-tags", "--no-write-fetch-head", input.rootDir, input.candidate.headSha, input.candidate.base.tipSha, input.candidate.treeSha);
    await git("update-ref", "HEAD", input.candidate.headSha);
    await git("read-tree", input.candidate.treeSha);
    await git("checkout-index", "--all", "--force");
    if ((await git("ls-tree", "-r", "--name-only", input.candidate.treeSha)).split("\n").some(p => p.split("/").includes("node_modules"))) throw new CheckSnapshotError("check_dependency_source_overlap", "Tracked node_modules cannot be replaced by private dependency setup.");
    const candidateRef = "refs/delivery/candidate", baseRef = "refs/delivery/base";
    const candidateCommit = await git("-c", "user.name=Delivery", "-c", "user.email=delivery@example.invalid", "-c", "commit.gpgsign=false", "commit-tree", input.candidate.treeSha, "-p", input.candidate.headSha, "-m", "Prepared execution snapshot");
    await git("update-ref", candidateRef, candidateCommit);
    await git("update-ref", "refs/delivery/origin-head", input.candidate.headSha);
    await git("update-ref", "HEAD", candidateCommit);
    await git("update-ref", baseRef, input.candidate.base.tipSha);
    await git("update-ref", "refs/delivery/merge-base", input.candidate.base.mergeBaseSha);
    // Conventional branch refs also resolve to the pinned base for existing checks.
    if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.candidate.base.ref)) await git("update-ref", input.candidate.base.ref.startsWith("refs/") ? input.candidate.base.ref : `refs/remotes/${input.candidate.base.ref}`, input.candidate.base.tipSha);
    const output = (p: string) => input.outputs.some(o => o.endsWith("/") ? p === o.slice(0, -1) || p.startsWith(o) : p === o);
    const sourceExcluded = (p: string) => p === ".git" || p.split("/").includes("node_modules") || output(p);
    const sourceDigest = await snapshotInventory(rootDir, sourceExcluded);
    const environment = { ...input.environment, PATH: `${path.join(rootDir, "node_modules/.bin")}${path.delimiter}${cleanEnv["PATH"]}`, HOME: path.join(rootDir, ".git/home"), TMPDIR: path.join(rootDir, ".git/tmp"),
      DELIVERY_CHECK_BASE_REF: baseRef, DELIVERY_CHECK_CANDIDATE_REF: candidateRef, DELIVERY_CHECK_ORIGIN_HEAD: input.candidate.headSha, DELIVERY_CHECK_ORIGIN_TREE: input.candidate.treeSha, DELIVERY_CHECK_MERGE_BASE: input.candidate.base.mergeBaseSha };
    await mkdir(environment.HOME, { recursive: true }); await mkdir(environment.TMPDIR, { recursive: true });
    if (input.dependencies) {
      const result = await createExecPort().run({ command: input.dependencies.command[0], args: input.dependencies.command.slice(1), cwd: rootDir, env: environment, timeoutMs: input.dependencies.timeoutMs, maxBuffer: 1024 * 1024, ...(input.signal ? { signal: input.signal } : {}) });
      if (result.code !== 0 || input.signal?.aborted) throw new CheckSnapshotError("check_dependency_failed", "Private dependency installation did not complete successfully.");
    }
    if (sourceDigest !== await snapshotInventory(rootDir, sourceExcluded)) throw new CheckSnapshotError("check_snapshot_drift", "Dependency setup changed prepared source bytes.");
    const dependencyDigest = await snapshotInventory(rootDir, p => p === ".git" || output(p));
    // The second digest covers both source and installed dependency bytes and
    // all links. It intentionally excludes only declared mutable output paths.
    const verify = async () => {
      await snapshotInventory(rootDir, p => p === ".git");
      if (await git("write-tree") !== input.candidate.treeSha || await git("rev-parse", "HEAD") !== candidateCommit || await git("rev-parse", `${candidateRef}^{tree}`) !== input.candidate.treeSha || await git("rev-parse", baseRef) !== input.candidate.base.tipSha || dependencyDigest !== await snapshotInventory(rootDir, p => p === ".git" || output(p))) throw new CheckSnapshotError("check_snapshot_drift", "Execution changed the private source, dependencies or pinned Git context.");
    };
    return { rootDir, environment, dependencyDigest, verify, cleanup };
  } catch (error) {
    await cleanup();
    if (error instanceof CheckSnapshotError) throw error;
    throw new CheckSnapshotError("check_snapshot_unavailable", "The exact prepared Git tree could not be materialized privately.");
  }
}
