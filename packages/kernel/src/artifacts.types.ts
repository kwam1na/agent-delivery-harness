/**
 * The filesystem port's shapes, with no filesystem in them.
 *
 * WHY A PORT AT ALL. Three kernel modules — the recorder here, the admission
 * adapter, and the delivery record — are forbidden from importing `node:fs`
 * directly (sensor rule d2). That is not a style preference. Every filesystem
 * question those modules ask is a question the spec has an opinion about: what
 * a run root *is*, whether a resolved path is inside one, what "the digest of
 * the file's bytes at submission" means when the path names a directory. Left
 * to each caller, those answers drift; behind one port they are written once
 * and tested once.
 *
 * WHY THE SHAPES LIVE HERE. Same seam as `candidate.types.ts` and
 * `records.types.ts`: a module may import these shapes without acquiring an
 * edge to the implementation that produces them. Nothing in this file imports
 * anything, and nothing in it performs an operation.
 *
 * WHAT AN OBSERVATION IS. `observeArtifact` returns a *classification*, never a
 * verdict. It says what it found — the path was refused before it was touched,
 * the file is not there, it resolved outside the root, it is not a file, it
 * could not be read, or here are its bytes and their digest. Which rejection
 * code each of those maps to is the recorder's decision, because it is the
 * recorder that owns ENV-10 and ENV-11. A port that returned codes would be
 * making spec decisions from inside the filesystem layer, and the two mappings
 * that matter — a missing file is a digest failure, a file resolving outside
 * the root is not — would then be invisible to the module that has to justify
 * them.
 */

/** The provider coordinates a run root is derived from. */
export interface RunRootRequest {
  /** `provider.id` from the manifest. Must be a single safe path component. */
  readonly providerId: string;
  /** `provider.runId` from the manifest. Must be a single safe path component. */
  readonly runId: string;
}

/**
 * An allocated run root: the directory a provider writes its evidence into and
 * the only place a submission's files may live.
 *
 * `path` is always the *resolved* location. On macOS `os.tmpdir()` is a
 * symlinked `/var/...` alias of a real `/private/var/...` directory, so a run
 * root compared before resolution and a file compared after it would disagree
 * about containment for every artifact in the run — the alias, not an attack,
 * is what would fail the check.
 */
export interface RunRoot {
  readonly providerId: string;
  readonly runId: string;
  /** Absolute, symlink-resolved. */
  readonly path: string;
}

/**
 * Why a run root could not be derived. Both reasons are about the *shape* of a
 * provider-supplied identifier, which the port refuses to interpret as a path
 * before any filesystem call happens: `runId: "../run-a"` names another
 * provider's directory, and `runId: "."` names the pool itself.
 */
export const RUN_ROOT_REFUSAL_REASONS = ["unsafe_provider_id", "unsafe_run_id"] as const;

export type RunRootRefusalReason = (typeof RUN_ROOT_REFUSAL_REASONS)[number];

export type RunRootResolution =
  | { readonly ok: true; readonly runRoot: RunRoot }
  | { readonly ok: false; readonly reason: RunRootRefusalReason };

/**
 * What the port found at a declared artifact path.
 *
 *   `path_refused`      — the declared path was not a safe relative path; the
 *                         port never touched the filesystem with it.
 *   `missing`           — nothing resolves there.
 *   `outside_run_root`  — it resolves, and the resolution is not inside the
 *                         run root. A symlink that resolves *inside* is not
 *                         this: containment is judged after resolution, so a
 *                         link within the run is an ordinary file.
 *   `not_a_file`        — a directory, or another non-regular entry. It has no
 *                         "bytes at submission" to digest.
 *   `unreadable`        — it is a file and reading it failed.
 *   `readable`          — bytes were read; `sha256` and `contents` are present.
 */
export const ARTIFACT_OBSERVATION_STATUSES = [
  "path_refused",
  "missing",
  "outside_run_root",
  "not_a_file",
  "unreadable",
  "readable",
] as const;

export type ArtifactObservationStatus = (typeof ARTIFACT_OBSERVATION_STATUSES)[number];

export interface ArtifactObservation {
  /** Exactly the path the manifest declared, unmodified. */
  readonly declaredPath: string;
  readonly status: ArtifactObservationStatus;
  /** The symlink-resolved location, when there was one to resolve. */
  readonly resolvedPath: string | null;
  /** Lowercase-hex sha256 of the file's bytes. Present only when `readable`. */
  readonly sha256: string | null;
  /**
   * The bytes decoded as UTF-8. Present only when `readable`. Payload rules
   * read approval stamps from here; it is untrusted provider-authored text and
   * is never interpolated into a rejection message.
   */
  readonly contents: string | null;
  /** Operator-facing diagnostic for the failure statuses. Never parsed. */
  readonly detail: string | null;
}

/** Options for the port's one write path. */
export interface WriteFileOptions {
  /**
   * Permission bits for the written file. The default suits a tracked,
   * working-tree file — the delivery record — rather than the git-private
   * store, which owns its own stricter modes.
   */
  readonly mode?: number;
}

/**
 * The filesystem operations the recorder, the admission adapter and the
 * delivery record are allowed to perform, and the complete list of them.
 *
 * Deliberately narrow. There is no `exists`, no `mkdir`, no `readdir`: every
 * member here exists because a spec rule or a product artifact needs it, and a
 * general-purpose filesystem facade behind a d2 rule would be the rule with
 * extra steps.
 */
export interface ArtifactsPort {
  /**
   * Derives the run root for a provider run and creates it. Allocation is the
   * recorder's, never the provider's: a provider that could name its own root
   * could name a directory whose contents it did not produce (SUB-3).
   */
  allocateRunRoot(request: RunRootRequest): Promise<RunRootResolution>;
  /** The same derivation without creating anything. */
  resolveRunRoot(request: RunRootRequest): Promise<RunRootResolution>;
  /** Whether `target` resolves to a location strictly inside `runRootPath`. */
  isInsideRunRoot(runRootPath: string, target: string): Promise<boolean>;
  /** Classifies one declared artifact path against a run root. */
  observeArtifact(runRootPath: string, declaredPath: string): Promise<ArtifactObservation>;
  /** Reads a UTF-8 text file — the submitted manifest. */
  readTextFile(target: string): Promise<string>;
  /** Writes a UTF-8 text file atomically, creating parent directories. */
  writeTextFile(target: string, contents: string, options?: WriteFileOptions): Promise<void>;
}
