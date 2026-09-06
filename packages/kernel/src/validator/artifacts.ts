/** Shared ENV-10/ENV-11 judgments over observed artifact bytes. */
import type { ArtifactObservation } from "../artifacts.types.ts";
import type { ManifestRejection } from "./codes.ts";
const readMember = (value: unknown, key: string): unknown => value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
const RECORDER_MESSAGES = {
  artifact_outside_run_root: "the artifact resolves to a location outside the run root",
  artifact_missing: "no file is present at the declared path inside the run root",
  artifact_not_a_file: "the declared path names a directory or another non-regular entry, which has no bytes to digest",
  artifact_unreadable: "the artifact could not be read at submission",
  artifact_digest_mismatch: "the artifact's bytes at submission do not have the declared digest",
} as const;

/** One declared artifact entry, read defensively from an unvalidated manifest. */
export interface DeclaredArtifactEntry {
  readonly index: number;
  readonly path: string;
  readonly sha256: string | undefined;
}

export function declaredArtifacts(manifest: unknown): readonly DeclaredArtifactEntry[] {
  const artifacts = readMember(manifest, "artifacts");
  if (!Array.isArray(artifacts)) return [];
  const entries: DeclaredArtifactEntry[] = [];
  artifacts.forEach((entry, index) => {
    const declaredPath = readMember(entry, "path");
    if (typeof declaredPath !== "string") return;
    const sha256 = readMember(entry, "sha256");
    entries.push({ index, path: declaredPath, sha256: typeof sha256 === "string" ? sha256 : undefined });
  });
  return entries;
}

/**
 * ENV-10's realpath clause and ENV-11, decided from what the port found.
 *
 * The two mappings that matter are here rather than in the port, because they
 * are spec readings rather than filesystem facts:
 *
 *   A file that is not there is `artifact_digest_mismatch`, not
 *   `artifact_outside_run_root`. ENV-11 requires the declared digest to equal
 *   the digest of the referenced file's bytes at submission; with no bytes
 *   there is no equality, and the run root is not where the failure is. A
 *   directory and an unreadable file land in the same place for the same
 *   reason.
 *
 *   `artifact_outside_run_root` is reserved for a path that *does* resolve and
 *   resolves outside — the only case where the run root is the thing that was
 *   violated.
 *
 * A path the port refused produces nothing here: it is a shape failure, the
 * validator owns `artifact_path_invalid`, and emitting a second code for it
 * would report a filesystem check that never ran.
 */
export function judgeArtifact(entry: DeclaredArtifactEntry, observation: ArtifactObservation): ManifestRejection | null {
  const pointer = `/artifacts/${entry.index}`;
  switch (observation.status) {
    case "path_refused":
      return null;
    case "outside_run_root":
      return {
        code: "artifact_outside_run_root",
        rule: "ENV-10",
        pointer: `${pointer}/path`,
        message: RECORDER_MESSAGES.artifact_outside_run_root,
      };
    case "missing":
      return { code: "artifact_digest_mismatch", rule: "ENV-11", pointer, message: RECORDER_MESSAGES.artifact_missing };
    case "not_a_file":
      return { code: "artifact_digest_mismatch", rule: "ENV-11", pointer, message: RECORDER_MESSAGES.artifact_not_a_file };
    case "unreadable":
      return { code: "artifact_digest_mismatch", rule: "ENV-11", pointer, message: RECORDER_MESSAGES.artifact_unreadable };
    case "readable":
      // A declared digest that is not a digest is the validator's
      // `malformed_field`; comparing against it here would report the same
      // defect twice under a code that says something else.
      if (entry.sha256 === undefined || entry.sha256 === observation.sha256) return null;
      return {
        code: "artifact_digest_mismatch",
        rule: "ENV-11",
        pointer: `${pointer}/sha256`,
        message: RECORDER_MESSAGES.artifact_digest_mismatch,
      };
  }
}

