/**
 * The deliverable-identity goldens: crafted trees, and the digests Athena's
 * implementation produced for them.
 *
 * WHY THESE ARE GOLDENS AND NOT ASSERTIONS ABOUT THE PORT. `deliverable-tree/v1`
 * is not a name this repository is free to define. Athena already computes it,
 * already has review evidence bound to it, and a digest that differs by one
 * byte under the same token would silently invalidate every one of those
 * bindings while looking perfectly healthy. So the expectations below were not
 * derived from the port — they were *captured* from Athena's
 * `scripts/harness-review-identity.ts` before the port existed, by building each
 * tree in a real repository and running Athena's `computeDeliverableTreeIdentity`
 * over it. The port then had to reproduce them.
 *
 * WHAT A GOLDEN CARRIES. Each one is self-contained: the recipe that builds the
 * tree, the neutral set the digest was computed under, the tree sha the recipe
 * must produce, and the expected digest. The tree sha is the cross-check that
 * matters — it proves the machine reproducing a golden built the same tree as
 * the machine that captured it, so a digest mismatch can only be the digest.
 *
 * WHY THE RECIPE FEEDS THE INDEX DIRECTLY. Several goldens name paths a
 * worktree cannot carry portably — a newline, a tab, a symlink, a submodule
 * gitlink pointing at a commit that does not exist. `update-index --index-info`
 * writes those entries verbatim, applies no content filters, and depends on no
 * checkout, so the same recipe produces the same tree sha on any host.
 *
 * THE NEUTRAL SET IS PART OF THE GOLDEN, not an ambient constant. The identity
 * token binds the set it was computed under; recording one without the other
 * would leave a reader unable to tell which function the digest names.
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Shapes ─────────────────────────────────────────────────────────────────

/**
 * The four modes a `-r` tree listing can carry. `040000` is absent because a
 * recursive listing never emits a tree entry, and `100664` and friends do not
 * exist in git — the index normalizes every regular file to one of the two.
 */
export const GOLDEN_TREE_MODES = ["100644", "100755", "120000", "160000"] as const;
export type GoldenTreeMode = (typeof GOLDEN_TREE_MODES)[number];

export interface GoldenTreeEntry {
  readonly mode: GoldenTreeMode;
  readonly path: string;
  /**
   * The blob's bytes for a file, and the link target for a `120000` symlink —
   * a symlink is a blob whose contents are the target. Absent exactly for a
   * `160000` gitlink, which names a commit rather than content this repository
   * holds.
   */
  readonly content?: string;
  /** The commit a `160000` gitlink points at. Never needs to exist. */
  readonly objectSha?: string;
}

/** The `{prefix, suffix?}` matcher shape, restated so the corpus imports no kernel. */
export interface GoldenNeutralMatcher {
  readonly prefix: string;
  readonly suffix?: string;
}

export interface IdentityGolden {
  readonly name: string;
  /** What this tree is here to pin down. */
  readonly why: string;
  /** How the expectation below was obtained. */
  readonly capturedFrom: string;
  readonly identityToken: string;
  readonly reviewNeutral: readonly GoldenNeutralMatcher[];
  readonly entries: readonly GoldenTreeEntry[];
  readonly expected: {
    /** The tree the recipe must build. A mismatch here means the recipe drifted, not the digest. */
    readonly treeSha: string;
    readonly digest: string;
  };
}

// ── Loading ────────────────────────────────────────────────────────────────

const GOLDENS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loaded from disk rather than imported as modules so the corpus stays data.
 * The order is the file order, sorted, so a run reports the same sequence twice.
 */
export function loadIdentityGoldens(): readonly IdentityGolden[] {
  return readdirSync(GOLDENS_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => JSON.parse(readFileSync(path.join(GOLDENS_DIR, entry), "utf8")) as IdentityGolden);
}

// ── Building ───────────────────────────────────────────────────────────────

/**
 * Git configuration that could change what a recipe builds is removed rather
 * than trusted: a global `core.autocrlf`, a template directory, an inherited
 * `GIT_INDEX_FILE`. The goldens are only comparable across two machines if the
 * tree sha is a function of the recipe alone.
 */
function goldenGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("GIT_") || value === undefined) continue;
    environment[name] = value;
  }
  return { ...environment, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
}

function git(cwd: string, args: readonly string[], stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, env: goldenGitEnvironment(), encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${String(stderr)}`));
          return;
        }
        resolve(stdout);
      },
    );
    // Several of the recipes below run a git command that reads no stdin, and a
    // busy machine lets git exit before this write reaches it — an EPIPE on a
    // pipe nobody was listening to. Unhandled, it surfaces as a run-level error
    // even though every assertion passed. The command's own exit status stays
    // the verdict: a real failure arrives through the callback above. That
    // covers the recipes that *do* read stdin too — a write truncated by a
    // vanished reader produces a different tree, and the pinned golden shas are
    // what catch it, rather than an error on a pipe.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin ?? Buffer.alloc(0));
  });
}

/**
 * Builds the golden's tree in `repoDir`, which must be an empty directory, and
 * returns the tree sha.
 *
 * Nothing is committed and nothing is checked out. A tree is the whole subject
 * here, and a commit would only add an author, a date, and a message for a
 * later reader to wonder whether the digest depends on.
 */
export async function buildGoldenTree(golden: IdentityGolden, repoDir: string): Promise<string> {
  await git(repoDir, ["init", "--quiet", "--initial-branch=main", "."]);

  const records: Buffer[] = [];
  for (const entry of golden.entries) {
    let objectSha: string;
    if (entry.mode === "160000") {
      if (entry.objectSha === undefined) throw new Error(`golden ${golden.name}: gitlink ${entry.path} names no commit`);
      objectSha = entry.objectSha;
    } else {
      if (entry.content === undefined) throw new Error(`golden ${golden.name}: ${entry.path} carries no content`);
      objectSha = (await git(repoDir, ["hash-object", "-w", "--stdin"], Buffer.from(entry.content, "utf8"))).toString("utf8").trim();
    }
    // The `-z` index-info stream is the only input form that survives a path
    // containing a newline, a tab, or a quote — which is exactly what several
    // of these goldens are for.
    records.push(Buffer.from(`${entry.mode} ${objectSha}\t${entry.path}\0`, "utf8"));
  }
  await git(repoDir, ["update-index", "-z", "--index-info"], Buffer.concat(records));

  return (await git(repoDir, ["write-tree"])).toString("utf8").trim();
}
