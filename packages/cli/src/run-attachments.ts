/** Bounded observational attachment transport; no path is followed by this parser. */
import {
  canonicalize,
  sha256Hex,
  portableArtifactContents,
  applySecretDiscipline,
  MAX_PORTABLE_ARTIFACTS,
  MAX_PORTABLE_EVIDENCE_BYTES,
  type RunArtifactMetadata,
  type RunEvent,
} from "@agent-delivery-harness/kernel";
export interface ArchivedAttachment {
  readonly metadata: RunArtifactMetadata;
  readonly availability: "retained" | "unavailable";
  readonly reason?: string;
  readonly code?: "missing" | "access_refused";
}
export interface RunAttachments {
  readonly entries: readonly ArchivedAttachment[];
  readonly blobs: Readonly<Record<string, string>>;
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function referencedAttachments(
  events: readonly RunEvent[],
): Map<string, RunArtifactMetadata> | undefined {
  const entries = new Map<string, RunArtifactMetadata>();
  for (const event of events) {
    if (event.kind !== "artifact.referenced") continue;
    const metadata = event.payload as unknown as RunArtifactMetadata;
    const prior = entries.get(metadata.artifactId);
    if (prior && canonicalize(prior) !== canonicalize(metadata))
      return undefined;
    entries.set(metadata.artifactId, metadata);
  }
  return entries;
}
export function validateRunAttachments(
  value: unknown,
  events: readonly RunEvent[],
): value is RunAttachments {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "blobs,entries" ||
    !Array.isArray(value["entries"]) ||
    !record(value["blobs"]) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") >
      MAX_PORTABLE_EVIDENCE_BYTES
  )
    return false;
  const refs = referencedAttachments(events);
  if (
    !refs ||
    refs.size > MAX_PORTABLE_ARTIFACTS ||
    value["entries"].length !== refs.size
  )
    return false;
  const seen = new Set<string>();
  const needed = new Set<string>();
  const read = portableArtifactContents(value["blobs"]);
  if (read.blockers.length) return false;
  for (const entry of value["entries"]) {
    if (!record(entry) || !record(entry["metadata"])) return false;
    const metadata = entry["metadata"] as unknown as RunArtifactMetadata;
    if (
      seen.has(metadata.artifactId) ||
      !refs.has(metadata.artifactId) ||
      canonicalize(metadata) !== canonicalize(refs.get(metadata.artifactId))
    )
      return false;
    seen.add(metadata.artifactId);
    if (entry["availability"] === "unavailable") {
      if (
        Object.keys(entry).sort().join(",") !==
          "availability,code,metadata,reason" ||
        !["missing", "access_refused"].includes(String(entry["code"])) ||
        typeof entry["reason"] !== "string" ||
        !entry["reason"].length ||
        entry["reason"].length > 512
      )
        return false;
    } else if (entry["availability"] === "retained") {
      if (Object.keys(entry).sort().join(",") !== "availability,metadata")
        return false;
      const observed = read.observations.get(metadata.digest);
      if (!observed || observed.base64 === undefined) return false;
      const bytes = Buffer.from(observed.base64, "base64");
      if (
        bytes.length !== metadata.sizeBytes ||
        sha256Hex(bytes) !== metadata.digest
      )
        return false;
      let structured: unknown = null;
      try {
        structured = JSON.parse(bytes.toString("utf8"));
      } catch {}
      if (
        !applySecretDiscipline(
          { text: bytes.toString("utf8"), structured },
          new Set(),
        ).ok
      )
        return false;
      needed.add(metadata.digest);
    } else return false;
  }
  return (
    Object.keys(value["blobs"]).length === needed.size &&
    Object.keys(value["blobs"]).every((key) => needed.has(key)) &&
    applySecretDiscipline(value["entries"], new Set()).ok
  );
}
