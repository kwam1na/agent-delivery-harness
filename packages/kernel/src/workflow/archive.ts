/**
 * A minimal, fail-closed reader for the exact pinned `agent-skills` release
 * archive (ZIP, stored or deflate entries) — zero runtime dependencies, pure
 * over the archive bytes.
 *
 * WHY THIS EXISTS. The composition substrate binds the archive BYTES by
 * SHA-256 before anything reads them, and the workflow graph inside carries
 * its own frozen digest pin. Both digests are verified by the consumers of
 * this module, so the reader's job is purely structural: locate entries and
 * inflate them, refusing anything it cannot account for. Internal CRCs are
 * deliberately not the integrity mechanism — the digest chain is — but the
 * declared uncompressed size is still enforced, because a size lie would
 * otherwise ride through inflation unnoticed.
 *
 * WHAT FAILS CLOSED: missing end-of-central-directory, ZIP64 markers (the
 * pinned release is small by construction; a marker means this is not that
 * release), unsupported compression methods, entry-count or signature drift,
 * and inflated bytes whose length differs from the declared size.
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;

const STORED = 0;
const DEFLATED = 8;

interface CentralEntry {
  readonly path: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readCentralDirectory(bytes: Uint8Array): CentralEntry[] {
  const buffer = asBuffer(bytes);
  if (buffer.length < 22) {
    throw new Error("not an archive: shorter than an end-of-central-directory record");
  }

  // The EOCD is the last record; scan backward through the trailing comment
  // window for its signature.
  let eocd = -1;
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("not an archive: no end-of-central-directory record");
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === ZIP64_MARKER_16 || centralSize === ZIP64_MARKER_32 || centralOffset === ZIP64_MARKER_32) {
    throw new Error("archive uses ZIP64 markers; the pinned release is not a ZIP64 archive — refusing");
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new Error("archive central directory extends past the end of the bytes — refusing");
  }

  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`archive central entry ${index} is malformed — refusing`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    if (compressedSize === ZIP64_MARKER_32 || uncompressedSize === ZIP64_MARKER_32 || localHeaderOffset === ZIP64_MARKER_32) {
      throw new Error(`archive entry ${index} uses ZIP64 markers — refusing`);
    }
    const entryPath = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    entries.push({ path: entryPath, method, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The archive's entry paths, in central-directory order. */
export function listArchiveEntries(bytes: Uint8Array): readonly string[] {
  return readCentralDirectory(bytes).map((entry) => entry.path);
}

/** The exact uncompressed bytes of one entry; any structural surprise throws. */
export function readArchiveEntry(bytes: Uint8Array, entryPath: string): Uint8Array {
  const buffer = asBuffer(bytes);
  const entry = readCentralDirectory(bytes).find((candidate) => candidate.path === entryPath);
  if (entry === undefined) {
    throw new Error(`archive has no entry ${JSON.stringify(entryPath)}`);
  }
  const header = entry.localHeaderOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new Error(`archive local header for ${JSON.stringify(entryPath)} is malformed — refusing`);
  }
  // Name/extra lengths in the LOCAL header may differ from the central ones;
  // the data starts after the local values.
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const dataStart = header + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new Error(`archive data for ${JSON.stringify(entryPath)} extends past the end of the bytes — refusing`);
  }
  const compressed = buffer.subarray(dataStart, dataEnd);

  let out: Buffer;
  if (entry.method === STORED) {
    out = Buffer.from(compressed);
  } else if (entry.method === DEFLATED) {
    out = inflateRawSync(compressed);
  } else {
    throw new Error(`archive entry ${JSON.stringify(entryPath)} uses unsupported compression method ${entry.method} — refusing`);
  }
  if (out.length !== entry.uncompressedSize) {
    throw new Error(
      `archive entry ${JSON.stringify(entryPath)} inflated to ${out.length} bytes, not the declared ${entry.uncompressedSize} — refusing`,
    );
  }
  return out;
}
