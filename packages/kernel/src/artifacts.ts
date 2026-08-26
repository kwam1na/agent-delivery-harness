/**
 * The kernel's filesystem port: run roots, containment, artifact observation,
 * and one atomic write.
 *
 * This is the only module in the kernel's submission path that opens a file.
 * Everything else in that path — the recorder here, the admission adapter and
 * the delivery record later — reaches the filesystem through the interface in
 * `artifacts.types.ts`, which is what sensor rule d2 enforces. The rule buys
 * one concrete thing: the four filesystem decisions the spec cares about are
 * made in one place, with one set of tests, instead of being re-derived by each
 * caller that needs them.
 *
 * WHERE RUN ROOTS LIVE, AND WHY IT IS NOT CONFIGURABLE. Under the system
 * temporary directory, in a namespace this harness owns, keyed by provider and
 * run id. A run root is scratch space for one provider run: it holds evidence
 * files that have already been digested into a manifest, it is worthless once
 * the records are published, and it must not be inside the repository, where it
 * would perturb the deliverable identity the evidence is about. None of that
 * varies by repository, so a config member naming it would be a dimension with
 * no reader and one more thing a repository could get wrong — the closed
 * grammar stays closed. A caller that needs a different base (this kernel's own
 * tests, and the conformance runner, which must keep 89 vectors from sharing
 * one directory) constructs a port with one; that is an injected parameter, not
 * repository policy.
 *
 * RESOLVE BEFORE COMPARING. Every path here is resolved with `realpath` before
 * it is compared to another path. On macOS `os.tmpdir()` reports
 * `/var/folders/...`, which is a symlink to `/private/var/folders/...`; a run
 * root captured unresolved and an artifact resolved by `realpath` differ in
 * their first segment, so containment would fail for every artifact in every
 * run — an alias reported as an escape. Resolving both sides makes the check
 * mean what it says: the same rule then rejects a symlink that genuinely points
 * out of the run, and accepts one that points within it.
 *
 * REFUSE PROVIDER-SHAPED PATH COMPONENTS. `provider.id` and `provider.runId`
 * arrive from a submitted manifest, and both become path components. They are
 * checked against their grammar here, before any join, rather than trusted
 * because the validator will also check them: the validator produces a verdict,
 * this produces a directory, and a `runId` of `"../run-a"` must never reach
 * `path.join` on the way to being rejected.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BlockedError, createBlocker, sanitizedDetail, type Remediation } from "./blockers.ts";
import type {
  ArtifactObservation,
  ArtifactsPort,
  RunRoot,
  RunRootRequest,
  RunRootResolution,
  WriteFileOptions,
} from "./artifacts.types.ts";

export type {
  ArtifactObservation,
  ArtifactObservationStatus,
  ArtifactsPort,
  RunRoot,
  RunRootRefusalReason,
  RunRootRequest,
  RunRootResolution,
  WriteFileOptions,
} from "./artifacts.types.ts";
export { ARTIFACT_OBSERVATION_STATUSES, RUN_ROOT_REFUSAL_REASONS } from "./artifacts.types.ts";

/**
 * The namespace run roots live under, inside the system temporary directory.
 * A constant rather than a config member — see the module note.
 */
export const RUN_ROOT_NAMESPACE = "delivery-harness";

/** The leaf under the namespace, so a future sibling need not move this one. */
export const RUN_ROOT_LEAF = "runs";

/** Owner-only: a run root holds evidence bytes a digest is about to be taken of. */
const DIRECTORY_MODE = 0o700;

/** The default for the port's write path: a tracked working-tree file. */
const DEFAULT_FILE_MODE = 0o644;

/**
 * `provider.id` (ENV-1) and `provider.runId` (ENV-2) grammars, restated where
 * the join happens. They are deliberately a *second* copy of the validator's
 * rule rather than an import of it: this is the mechanical guard on a path
 * component, and it must hold even for a caller that never ran the validator.
 */
const PROVIDER_ID = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_RUN_ID_LENGTH = 128;

// ── Blockers ───────────────────────────────────────────────────────────────

const RETRY: Remediation = {
  id: "retry-filesystem-operation",
  kind: "retry",
  summary: "Re-run the command once the location is reachable.",
};

const CHECK_PATH: Remediation = {
  id: "check-artifact-location",
  kind: "manual_action",
  summary: "Check that the path exists and that this process can read it.",
};

function artifactsBlocker(
  code: "run_root_unwritable" | "artifact_file_unreadable" | "artifact_write_failed",
  summary: string,
  details: string,
  remediation: Remediation,
): BlockedError {
  const blocker = createBlocker({
    code,
    source: { kind: "provider", id: "delivery-harness.artifacts" },
    summary,
    details: sanitizedDetail(details, "Artifacts port detail"),
    remediations: [remediation],
  });
  return new BlockedError([blocker], blocker.summary);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

// ── Path primitives ────────────────────────────────────────────────────────

/**
 * The resolved location of `target`, or `null` when nothing resolves there.
 *
 * A missing intermediate directory and a missing leaf are the same answer on
 * purpose: the caller asked where a path points, and "nowhere" is one fact, not
 * two. Any other error propagates, because a permission failure while resolving
 * is not the same as an absence and must not be reported as one.
 */
async function resolvedOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * Strict containment over already-resolved paths: `child` is inside `parent`
 * and is not `parent` itself. A string-prefix test would put `/tmp/run-a2`
 * inside `/tmp/run-a`, which is a different run's directory.
 */
export function isInsideResolved(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Whether a manifest-declared artifact path may be joined to a run root at all:
 * relative, no traversal, no empty segment, no drive-absolute or UNC form.
 *
 * Character-for-character the validator's shape rule, and it has to stay that
 * way rather than merely being "at least as strict". A path this predicate
 * refused but the validator accepted would be an artifact the recorder never
 * digests and no rule ever rejects — a hole, not extra safety. The duplication
 * is deliberate all the same: the validator produces a verdict, this decides
 * whether a provider-supplied string reaches `path.join`, and that decision
 * must hold for a caller who never ran the validator.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value === "") return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const segments = value.split(/[/\\]/);
  return !segments.includes("..") && !segments.includes("");
}

// ── The port ───────────────────────────────────────────────────────────────

export interface ArtifactsPortOptions {
  /**
   * The directory run roots are created under. Defaults to the harness
   * namespace inside the system temporary directory. Callers pass one to keep
   * concurrent runs from sharing a provider's run id; it is not repository
   * configuration.
   */
  readonly runRootBase?: string;
}

/** The default base: `<tmpdir>/delivery-harness/runs`, resolved. */
export async function defaultRunRootBase(): Promise<string> {
  const base = path.join(tmpdir(), RUN_ROOT_NAMESPACE, RUN_ROOT_LEAF);
  try {
    await mkdir(base, { recursive: true, mode: DIRECTORY_MODE });
  } catch (error) {
    throw artifactsBlocker("run_root_unwritable", "The run-root directory could not be created.", `${base}: ${describe(error)}`, RETRY);
  }
  // Resolved once, here: `tmpdir()` is a symlink on macOS, and every
  // containment comparison downstream depends on both sides being physical.
  return realpath(base);
}

export function createArtifactsPort(options: ArtifactsPortOptions = {}): ArtifactsPort {
  const base = async (): Promise<string> =>
    options.runRootBase === undefined ? defaultRunRootBase() : realpath(options.runRootBase);

  const derive = async (request: RunRootRequest, create: boolean): Promise<RunRootResolution> => {
    if (!PROVIDER_ID.test(request.providerId)) return { ok: false, reason: "unsafe_provider_id" };
    if (
      request.runId.length > MAX_RUN_ID_LENGTH ||
      !RUN_ID.test(request.runId) ||
      request.runId === "." ||
      request.runId === ".."
    ) {
      return { ok: false, reason: "unsafe_run_id" };
    }

    const baseDir = await base();
    const target = path.join(baseDir, request.providerId, request.runId);
    if (create) {
      try {
        await mkdir(target, { recursive: true, mode: DIRECTORY_MODE });
        await chmod(target, DIRECTORY_MODE);
      } catch (error) {
        throw artifactsBlocker("run_root_unwritable", "The run root could not be created.", `${target}: ${describe(error)}`, RETRY);
      }
    }

    const resolved = await resolvedOrNull(target);
    const runRoot: RunRoot = {
      providerId: request.providerId,
      runId: request.runId,
      // An unallocated run root has no physical form yet; the derived path is
      // still the answer to "where would it be", and containment against a
      // directory that does not exist is false for every target anyway.
      path: resolved ?? target,
    };
    return { ok: true, runRoot };
  };

  return {
    allocateRunRoot: (request) => derive(request, true),
    resolveRunRoot: (request) => derive(request, false),

    async isInsideRunRoot(runRootPath, target) {
      const [root, resolved] = await Promise.all([resolvedOrNull(runRootPath), resolvedOrNull(target)]);
      if (root === null || resolved === null) return false;
      return isInsideResolved(root, resolved);
    },

    async observeArtifact(runRootPath, declaredPath) {
      const observation = (
        rest: Omit<ArtifactObservation, "declaredPath">,
      ): ArtifactObservation => ({ declaredPath, ...rest });

      if (!isSafeRelativePath(declaredPath)) {
        return observation({
          status: "path_refused",
          resolvedPath: null,
          sha256: null,
          contents: null,
          detail: "the declared path is not a safe relative path and was never joined to the run root",
        });
      }

      const root = await resolvedOrNull(runRootPath);
      if (root === null) {
        return observation({
          status: "missing",
          resolvedPath: null,
          sha256: null,
          contents: null,
          detail: "the run root does not exist",
        });
      }

      const resolved = await resolvedOrNull(path.join(root, declaredPath));
      if (resolved === null) {
        return observation({
          status: "missing",
          resolvedPath: null,
          sha256: null,
          contents: null,
          detail: "no file is present at this path inside the run root",
        });
      }
      // Containment is judged on the *resolved* location, which is what makes a
      // symlink pointing out of the run an escape and a symlink pointing within
      // it an ordinary file.
      if (!isInsideResolved(root, resolved)) {
        return observation({
          status: "outside_run_root",
          resolvedPath: resolved,
          sha256: null,
          contents: null,
          detail: "the path resolves to a location outside the run root",
        });
      }

      let isFile: boolean;
      try {
        isFile = (await stat(resolved)).isFile();
      } catch (error) {
        return observation({
          status: "unreadable",
          resolvedPath: resolved,
          sha256: null,
          contents: null,
          detail: `the path could not be inspected: ${describe(error)}`,
        });
      }
      if (!isFile) {
        return observation({
          status: "not_a_file",
          resolvedPath: resolved,
          sha256: null,
          contents: null,
          detail: "the path names a directory or another non-regular entry, which has no bytes to digest",
        });
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(resolved);
      } catch (error) {
        return observation({
          status: "unreadable",
          resolvedPath: resolved,
          sha256: null,
          contents: null,
          detail: `the file could not be read: ${describe(error)}`,
        });
      }

      return observation({
        status: "readable",
        resolvedPath: resolved,
        // Over the raw bytes, never over a decoded string: ENV-11 is about the
        // file's bytes at submission, and a lossy decode would digest something
        // the provider never wrote.
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contents: bytes.toString("utf8"),
        detail: null,
      });
    },

    async readTextFile(target) {
      try {
        return await readFile(target, "utf8");
      } catch (error) {
        throw artifactsBlocker(
          "artifact_file_unreadable",
          "A file this submission depends on could not be read.",
          `${target}: ${describe(error)}`,
          CHECK_PATH,
        );
      }
    },

    async writeTextFile(target, contents, writeOptions: WriteFileOptions = {}) {
      const mode = writeOptions.mode ?? DEFAULT_FILE_MODE;
      const directory = path.dirname(target);
      // Dot-prefixed and uniquely named so a crashed writer leaves something no
      // reader will serve, and so two writers never share a temporary.
      const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, contents, { mode, flag: "wx" });
        await chmod(temporary, mode);
        await syncFile(temporary);
        // `rename` replaces atomically: a reader sees the old file or the new
        // one, never a truncated one. That is the difference between this and
        // writing in place, and it is why the delivery record is written here
        // rather than by whichever command happens to produce it.
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw artifactsBlocker(
          "artifact_write_failed",
          "A file could not be written.",
          `${target}: ${describe(error)}`,
          RETRY,
        );
      }
    },
  };
}

/**
 * Flushes the temporary before it is renamed into place. Without it the rename
 * can be durable while the bytes it names are not, which is the one crash
 * window an atomic rename does not close on its own.
 */
async function syncFile(target: string): Promise<void> {
  const handle = await open(target, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
