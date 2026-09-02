/**
 * WHERE THE SHARED STATE LIVES: the git COMMON directory of the repository the
 * caller was invoked in.
 *
 * Two conventions exist in this kernel. The record store resolves its
 * namespace through `git rev-parse --git-path`, which is worktree-PRIVATE, and
 * refuses a namespace that resolves into the common directory from a linked
 * worktree so that privacy cannot be silently void. The facade's
 * `managed-delivery` namespace is the other one: identical from every worktree,
 * because what it holds must outlive any one of them.
 *
 * The run store departs from the record store deliberately and takes the
 * facade's location. A run must survive the removal of the worktree it ran in
 * — worktrees are removed after merge — so the store is the repository's, not
 * the worktree's. The consequence is stated plainly: anything the owner
 * executes in ANY worktree, candidate scripts included, can read and append
 * it. That is acceptable ONLY because nothing authoritative reads it.
 *
 * THE RUNNER AND THE ENVIRONMENT COME FROM THE CALLER. The facade passes its
 * injected exec port and no environment override, so its resolution and its
 * recorded launch inventory are exactly what they were. Every caller that
 * resolves the RUN store passes a direct runner with the `GIT_` namespace
 * cleared, as the kernel's candidate capture does, so an inherited `GIT_DIR`
 * or `GIT_COMMON_DIR` can never relocate the store out from under the
 * owner-only ancestry the discipline assumes.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { sha256Hex } from "../digest.ts";

/** The facade's namespace, shared by the run store. */
export const MANAGED_DELIVERY_NAMESPACE = "managed-delivery";

/** One directory under the namespace holds every run of this repository. */
export const RUN_STORE_DIRECTORY = "runs";

export interface NamespaceGitLaunch {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}

export type NamespaceGitRunner = (launch: NamespaceGitLaunch) => Promise<{ code: number; stdout: string }>;

export interface NamespaceResolutionInput {
  readonly cwd: string;
  readonly run: NamespaceGitRunner;
  readonly env?: Record<string, string>;
}

export type NamespaceResolution =
  | { readonly ok: true; readonly commonDir: string; readonly namespaceDir: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves the shared namespace directory. This is the query the facade has
 * always made — same args, same cwd, one launch — so nothing about its
 * recorded process inventory changes by routing it through here.
 */
export async function resolveCommonDirectoryNamespace(input: NamespaceResolutionInput): Promise<NamespaceResolution> {
  const outcome = await input.run({
    cwd: input.cwd,
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  const commonDir = outcome.stdout.trim();
  if (outcome.code !== 0 || commonDir.length === 0) {
    return { ok: false, reason: `not a git repository: ${input.cwd}` };
  }
  return { ok: true, commonDir, namespaceDir: path.join(commonDir, MANAGED_DELIVERY_NAMESPACE) };
}

export type RunStoreLocation =
  | {
      readonly ok: true;
      /** The INVOKING worktree's own git directory — the pointer's identity. */
      readonly gitDir: string;
      readonly commonDir: string;
      readonly namespaceDir: string;
      readonly runsDir: string;
      /**
       * The per-worktree pointer key: a digest of the absolute git directory.
       * Config-independent, different in every worktree, and deliberately not
       * the record store's `workspaceId`, which depends on a configured
       * namespace this store does not have.
       */
      readonly worktreeKey: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves the run store and the invoking worktree's pointer key together. One
 * `rev-parse` names both paths; like the common-directory query it reads no
 * index and runs no hook, alias, or pager.
 */
export async function resolveRunStoreLocation(input: NamespaceResolutionInput): Promise<RunStoreLocation> {
  const outcome = await input.run({
    cwd: input.cwd,
    args: ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  const lines = outcome.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const gitDir = lines[0];
  const commonDir = lines[1];
  if (outcome.code !== 0 || gitDir === undefined || commonDir === undefined) {
    return { ok: false, reason: `not a git repository: ${input.cwd}` };
  }
  const namespaceDir = path.join(commonDir, MANAGED_DELIVERY_NAMESPACE);
  return {
    ok: true,
    gitDir,
    commonDir,
    namespaceDir,
    runsDir: path.join(namespaceDir, RUN_STORE_DIRECTORY),
    worktreeKey: sha256Hex(gitDir),
  };
}

/**
 * The `GIT_` namespace is dropped wholesale rather than by curated list,
 * because the failure mode of missing one is a store that looks perfectly
 * healthy and belongs to the wrong repository. `GIT_TERMINAL_PROMPT` because
 * nothing here may wait for someone to type; `GIT_OPTIONAL_LOCKS` because
 * these queries only observe.
 */
export function gitNamespaceClearedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("GIT_") || value === undefined) continue;
    environment[name] = value;
  }
  return { ...environment, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/**
 * A direct `git` runner for the callers that have no injected port: the CLI's
 * run-surface commands. It never throws — a resolution failure is a reported
 * outcome, never an exception that could change a wrapped command's exit code.
 */
export const runGitDirect: NamespaceGitRunner = (launch) =>
  new Promise((resolve) => {
    const child = spawn("git", [...launch.args], {
      cwd: launch.cwd,
      ...(launch.env === undefined ? {} : { env: launch.env }),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => resolve({ code: -1, stdout }));
    child.once("close", (code) => resolve({ code: code ?? -1, stdout }));
  });
