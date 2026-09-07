import {
  applySecretDiscipline,
  canonicalize,
  MAX_PORTABLE_RECORD_BYTES,
  MAX_PORTABLE_ARTIFACTS,
  MAX_PORTABLE_EVIDENCE_BYTES,
  type RunArtifactResult,
  type RunEvent,
} from "@agent-delivery-harness/kernel";
import { buildRunExport, parseRunExport } from "./run-export.ts";
import {
  referencedAttachments,
  validateRunAttachments,
  type ArchivedAttachment,
} from "./run-attachments.ts";
export type RunArchiveBuildResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };
/** Capture a snapshot; does not write or modify the source journal. */
export async function buildRunArchive(input: {
  readonly runId: string;
  readonly events: readonly RunEvent[];
  readonly refusedAppends?: readonly unknown[];
  readonly readArtifact: (artifactId: string) => Promise<RunArtifactResult>;
}): Promise<RunArchiveBuildResult> {
  const base = buildRunExport(input);
  if (
    Buffer.byteLength(JSON.stringify(base), "utf8") > MAX_PORTABLE_RECORD_BYTES
  )
    return { ok: false, reason: "archive exceeds 16 MiB serialized limit" };
  if (!parseRunExport(JSON.stringify(base)).ok)
    return { ok: false, reason: "invalid run export" };
  if (!applySecretDiscipline(base, new Set()).ok)
    return { ok: false, reason: "archive contains a secret-like value" };
  const refs = referencedAttachments(input.events);
  if (refs && refs.size > MAX_PORTABLE_ARTIFACTS)
    return { ok: false, reason: "archive exceeds 128 attachments" };
  if (!refs)
    return { ok: false, reason: "conflicting attachment reference bindings" };
  const entries: ArchivedAttachment[] = [];
  const blobs: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  if (base.spec === "delivery-run-export/2")
    for (const metadata of refs.values()) {
      const artifact = await input.readArtifact(metadata.artifactId);
      if (!artifact.ok) {
        if (artifact.code !== "missing" && artifact.code !== "access_refused")
          return {
            ok: false,
            reason: `retained attachment ${artifact.code}; export refused`,
          };
        entries.push({
          metadata,
          availability: "unavailable",
          code: artifact.code,
          reason: artifact.reason.slice(0, 512),
        });
        continue;
      }
      if (canonicalize(artifact.metadata) !== canonicalize(metadata))
        return { ok: false, reason: "attachment binding differs from journal" };
      if (
        blobs[metadata.digest] !== undefined &&
        blobs[metadata.digest] !== artifact.base64
      )
        return { ok: false, reason: "conflicting attachment bytes" };
      blobs[metadata.digest] = artifact.base64;
      entries.push({ metadata, availability: "retained" });
      if (
        Buffer.byteLength(JSON.stringify({ entries, blobs }), "utf8") >
        MAX_PORTABLE_EVIDENCE_BYTES
      )
        return {
          ok: false,
          reason: "archive exceeds 8 MiB serialized attachment limit",
        };
    }
  const attachments = { entries, blobs };
  if (
    base.spec === "delivery-run-export/2" &&
    !validateRunAttachments(attachments, input.events)
  )
    return {
      ok: false,
      reason: "attachment bytes, bindings or serialized limits are invalid",
    };
  const text = JSON.stringify({
    ...base,
    ...(base.spec === "delivery-run-export/2" ? { attachments } : {}),
  });
  if (Buffer.byteLength(text, "utf8") > MAX_PORTABLE_RECORD_BYTES)
    return { ok: false, reason: "archive exceeds 16 MiB serialized limit" };
  return { ok: true, text };
}
/** Historical read only: never resumes, imports, verifies a candidate, or resolves paths. */
export function readArchiveArtifact(
  text: string,
  artifactId: string,
): RunArtifactResult {
  if (Buffer.byteLength(text, "utf8") > MAX_PORTABLE_RECORD_BYTES)
    return {
      ok: false,
      code: "invalid",
      reason: "archive exceeds 16 MiB serialized limit",
    };
  const parsed = parseRunExport(text);
  if (!parsed.ok)
    return { ok: false, code: "invalid", reason: "archive invalid" };
  const entry = parsed.value.attachments?.entries.find(
    (e) => e.metadata.artifactId === artifactId,
  );
  if (!entry)
    return {
      ok: false,
      code: "invalid",
      reason: "attachment not retained in this archive",
    };
  if (entry.availability === "unavailable")
    return { ok: false, code: entry.code!, reason: entry.reason! };
  return {
    ok: true,
    metadata: entry.metadata,
    base64: parsed.value.attachments!.blobs[entry.metadata.digest]!,
  };
}
