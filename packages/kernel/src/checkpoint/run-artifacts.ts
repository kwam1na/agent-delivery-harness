/** Run attachments are untrusted observations, never submission/admission evidence. */
import { constants } from "node:fs";
import { mkdir, open, rename, rm, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createArtifactsPort, isSafeRelativePath } from "../artifacts.ts";
import { sha256Hex } from "../digest.ts";
import {
  MAX_PORTABLE_ARTIFACT_BYTES,
  MAX_PORTABLE_ARTIFACTS,
  MAX_PORTABLE_EVIDENCE_BYTES,
} from "../portable-limits.ts";
import {
  appendDecided,
  ownerOnlyRegularFile,
  OWNER_DIR,
  OWNER_FILE,
  readRawJournal,
  parseJournalLines,
} from "./append-only-file.ts";
import { applySecretDiscipline } from "./redaction.ts";
import { RUN_STORE_ID, validateRunEventInput } from "./run-event.ts";
import type { RunStore } from "./run-store.ts";

export interface RunArtifactMetadata {
  readonly artifactId: string;
  readonly activityId: string;
  readonly attemptId: string;
  readonly candidateTreeSha: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly producer: string;
  readonly roundId?: string;
  readonly round?: number;
  readonly lensId?: string;
}
export type RunArtifactFailureCode =
  "missing" | "corrupt" | "access_refused" | "unsafe" | "invalid";
export type RunArtifactResult =
  | {
      readonly ok: true;
      readonly metadata: RunArtifactMetadata;
      readonly base64: string;
    }
  | {
      readonly ok: false;
      readonly code: RunArtifactFailureCode;
      readonly reason: string;
    };
const discipline = {
  extraFlags: constants.O_NOFOLLOW,
  verify: ownerOnlyRegularFile,
  refuseOnError: true,
};
function containsSecret(
  contents: string,
  metadata?: RunArtifactMetadata,
): boolean {
  let structured: unknown;
  try {
    structured = JSON.parse(contents);
  } catch {
    structured = null;
  }
  return !applySecretDiscipline({ contents, structured, metadata }, new Set())
    .ok;
}
const refused = (
  reason: string,
  code: RunArtifactFailureCode = "invalid",
): RunArtifactResult => ({ ok: false, code, reason });
class AttachmentReadFailure extends Error {
  readonly failureCode: RunArtifactFailureCode;
  constructor(failureCode: RunArtifactFailureCode, message: string) {
    super(message);
    this.failureCode = failureCode;
  }
}
const safeId = (id: string) =>
  typeof id === "string" && id.length <= 128 && RUN_STORE_ID.test(id);
function validMetadata(
  metadata: unknown,
  runId: string,
): metadata is RunArtifactMetadata {
  return validateRunEventInput({
    version: "run-event/2",
    eventId: "validate",
    runId,
    at: "2026-09-07T00:00:00Z",
    repo: { commonDir: "/" },
    actor: { role: "cli" },
    attestation: "self",
    kind: "artifact.referenced",
    candidateTreeSha: (metadata as RunArtifactMetadata)?.candidateTreeSha,
    payload: metadata,
  }).ok;
}
function same(a: RunArtifactMetadata, b: RunArtifactMetadata): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([k, v]) => b[k as keyof RunArtifactMetadata] === v)
  );
}
const directory = (store: RunStore, runId: string) =>
  path.join(store.runsDir, "artifacts", runId);
async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await h.stat();
    const reason = ownerOnlyRegularFile(stat);
    if (reason !== undefined)
      throw new AttachmentReadFailure(
        "access_refused",
        "attachment access refused",
      );
    if (stat.size > limit)
      throw new AttachmentReadFailure(
        "corrupt",
        "retained attachment exceeds size limit",
      );
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const r = await h.read(bytes, offset, bytes.length - offset, null);
      if (r.bytesRead === 0) break;
      offset += r.bytesRead;
    }
    if (offset !== stat.size || offset > limit)
      throw new AttachmentReadFailure("corrupt", "attachment size changed");
    return bytes.subarray(0, offset);
  } finally {
    await h.close();
  }
}
async function checkDirectory(store: RunStore, runId: string): Promise<void> {
  const base = await realpath(store.runsDir);
  for (const dir of [
    path.join(store.runsDir, "artifacts"),
    directory(store, runId),
  ]) {
    const info = await lstat(dir);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    )
      throw new AttachmentReadFailure(
        "access_refused",
        "attachment directory access refused",
      );
    const resolved = await realpath(dir);
    if (!resolved.startsWith(base + path.sep))
      throw new AttachmentReadFailure(
        "access_refused",
        "attachment directory outside run store",
      );
  }
}
async function index(
  store: RunStore,
  runId: string,
): Promise<readonly RunArtifactMetadata[]> {
  await checkDirectory(store, runId);
  await boundedRead(
    path.join(directory(store, runId), "index.jsonl"),
    128 * 4096,
  );
  const raw = await readRawJournal(
    path.join(directory(store, runId), "index.jsonl"),
    discipline,
  );
  const parsed = parseJournalLines(raw.lines);
  if (!parsed.ok)
    throw new AttachmentReadFailure("corrupt", "attachment index corrupt");
  const entries = parsed.entries;
  if (
    entries.length > MAX_PORTABLE_ARTIFACTS ||
    !entries.every((e) => validMetadata(e, runId))
  )
    throw new AttachmentReadFailure("corrupt", "attachment index corrupt");
  const ids = new Set(entries.map((e) => e.artifactId));
  if (ids.size !== entries.length)
    throw new AttachmentReadFailure("corrupt", "attachment index duplicate");
  return entries;
}
async function atomicBlob(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let h;
  try {
    h = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      OWNER_FILE,
    );
    await h.writeFile(bytes);
    await h.sync();
    await h.close();
    h = undefined;
    await rename(temporary, file);
  } finally {
    await h?.close();
    await rm(temporary, { force: true });
  }
}
/** Explicit selected-file capture. Does not append a successful artifact event. */
export async function captureRunArtifact(input: {
  readonly store: RunStore;
  readonly runId: string;
  readonly metadata: RunArtifactMetadata;
  readonly sourceRoot: string;
  readonly sourcePath: string;
}): Promise<RunArtifactResult> {
  const { store, runId, metadata } = input;
  if (!safeId(runId) || !validMetadata(metadata, runId))
    return refused("invalid attachment binding");
  const journal = await store.read(runId);
  if (
    !journal.ok ||
    journal.events.length === 0 ||
    journal.events[0]?.version !== "run-event/2"
  )
    return refused("attachment capture requires an existing run-event/2 run");
  if (!applySecretDiscipline(metadata, new Set()).ok)
    return refused("attachment metadata contains a secret-like value");
  if (metadata.sizeBytes > MAX_PORTABLE_ARTIFACT_BYTES)
    return refused("attachment exceeds 2 MiB limit");
  if (!isSafeRelativePath(input.sourcePath))
    return refused("unsafe attachment source path");
  // Once exact bytes and their immutable binding are durable, reference
  // publication can be retried without the ingestion-only scratch file.
  const retained = await readRunArtifact(store, runId, metadata.artifactId);
  if (retained.ok)
    return same(retained.metadata, metadata)
      ? retained
      : refused("attachment id conflicts with retained binding");
  const observed = await createArtifactsPort()
    .observeArtifact(input.sourceRoot, input.sourcePath)
    .catch(() => null);
  if (
    observed === null ||
    observed.status !== "readable" ||
    observed.base64 === undefined
  )
    return refused(`attachment source ${observed?.status ?? "unreadable"}`);
  const base64 = observed.base64;
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length !== metadata.sizeBytes ||
    sha256Hex(bytes) !== metadata.digest
  )
    return refused("attachment digest or size mismatch");
  if (containsSecret(bytes.toString("utf8")))
    return refused("attachment contains a secret-like value");
  const dir = directory(store, runId);
  try {
    for (const component of [path.join(store.runsDir, "artifacts"), dir]) {
      await mkdir(component, { mode: OWNER_DIR }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const info = await lstat(component);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && info.uid !== process.getuid())
      )
        throw new AttachmentReadFailure(
          "access_refused",
          "attachment directory access refused",
        );
    }
    await checkDirectory(store, runId);
    const outcome = await appendDecided<RunArtifactResult, string>({
      journalPath: path.join(dir, "index.jsonl"),
      discipline,
      crossProcess: true,
      decide: async (read) => {
        try {
          await boundedRead(path.join(dir, "index.jsonl"), 128 * 4096);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const parsed = await read();
        if (!parsed.ok || !parsed.entries.every((e) => validMetadata(e, runId)))
          return { ok: false, rejected: "attachment index corrupt" };
        const entries = parsed.entries as RunArtifactMetadata[];
        const existing = entries.find(
          (e) => e.artifactId === metadata.artifactId,
        );
        if (existing && !same(existing, metadata))
          return {
            ok: false,
            rejected: "attachment id conflicts with retained binding",
          };
        const all = existing ? entries : [...entries, metadata];
        if (all.length > MAX_PORTABLE_ARTIFACTS)
          return { ok: false, rejected: "run exceeds 128 attachments" };
        const payloads: Record<string, string> = Object.create(null) as Record<
          string,
          string
        >;
        for (const entry of all) {
          if (payloads[entry.digest] !== undefined) continue;
          if (entry.digest === metadata.digest) {
            payloads[entry.digest] = base64;
            continue;
          }
          const prior = await boundedRead(
            path.join(dir, `${entry.digest}.blob`),
            MAX_PORTABLE_ARTIFACT_BYTES,
          );
          if (
            sha256Hex(prior) !== entry.digest ||
            prior.length !== entry.sizeBytes
          )
            return { ok: false, rejected: "retained attachment corrupt" };
          payloads[entry.digest] = prior.toString("base64");
        }
        if (
          Buffer.byteLength(
            JSON.stringify({ attachments: all, payloads }),
            "utf8",
          ) > MAX_PORTABLE_EVIDENCE_BYTES
        )
          return {
            ok: false,
            rejected: "run exceeds 8 MiB serialized attachment limit",
          };
        // Atomic bytes first; an interrupted index append is repaired by appendDecided.
        await atomicBlob(path.join(dir, `${metadata.digest}.blob`), bytes);
        const accepted: RunArtifactResult = { ok: true, metadata, base64 };
        return existing
          ? { ok: true, accepted }
          : { ok: true, accepted, entry: metadata };
      },
    });
    return outcome.ok ? outcome.accepted : refused(outcome.rejected);
  } catch {
    return refused("attachment storage unavailable or access refused");
  }
}
/** No arbitrary path input, and no admission/evidence inference. */
export async function readRunArtifact(
  store: RunStore,
  runId: string,
  artifactId: string,
): Promise<RunArtifactResult> {
  if (!safeId(runId) || !safeId(artifactId))
    return refused("invalid run or attachment id");
  try {
    const entries = await index(store, runId);
    const metadata = entries.find((e) => e.artifactId === artifactId);
    if (metadata === undefined)
      return refused("attachment unavailable in this run", "missing");
    const bytes = await boundedRead(
      path.join(directory(store, runId), `${metadata.digest}.blob`),
      MAX_PORTABLE_ARTIFACT_BYTES,
    );
    if (
      bytes.length !== metadata.sizeBytes ||
      sha256Hex(bytes) !== metadata.digest
    )
      return refused("retained attachment digest or size mismatch", "corrupt");
    if (containsSecret(bytes.toString("utf8"), metadata))
      return refused(
        "retained attachment contains a secret-like value",
        "unsafe",
      );
    return { ok: true, metadata, base64: bytes.toString("base64") };
  } catch (error) {
    if (error instanceof AttachmentReadFailure)
      return refused(error.message, error.failureCode);
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return refused("attachment missing", "missing");
    return refused("attachment access refused", "access_refused");
  }
}
