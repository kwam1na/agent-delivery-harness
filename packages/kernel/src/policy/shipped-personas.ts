/**
 * THE SHIPPED REVIEWER CHARTER SET, READ FROM THE ARCHIVE.
 *
 * WHERE THE SET LIVES. Not here. The charters, their manifest, and the
 * include/exclude adjudication behind them are content the `agent-skills`
 * archive carries; this module is only the mechanism that resolves them. That
 * split is what makes the set advanceable on its own: a new archive release
 * changes which charters exist and at what digests, and no byte of this
 * repository — or of any adopter's policy document — has to move. A hardcoded
 * list here would put the shipped set behind a harness release instead, which
 * is the same coupling the identity-only lens reference exists to avoid.
 *
 * WHAT A PERSONA IS HERE. Content the product ships, never behaviour it runs.
 * A persona changes what a reviewer is told; it never changes how a result is
 * interpreted. Nothing in this module reads charter prose: it hashes bytes and
 * binds identities. The reducer downstream compares digests and likewise never
 * reads content, so a charter cannot become a second source of orchestration
 * authority — it has no member the reducer consults.
 *
 * DIGEST CLOSURE. The archive already binds every byte it carries: its own
 * `release-manifest.json` lists each packed path with its digest, and the
 * archive bytes as a whole hash to the pinned release identity. This module
 * re-derives each charter's digest from the bytes it actually read and checks
 * it against that listing, so a manifest that names a charter the archive does
 * not carry, and a charter whose bytes drift from what the archive recorded,
 * are both rejected here rather than surfacing later as a lens that cannot be
 * satisfied.
 *
 * PURITY. Pure over a byte reader. Both the filesystem edge and the archive
 * decoding belong to the caller — the facade reads the archive out of the
 * run-pinned generation root and hands this module a reader over its entries,
 * exactly as it does for the workflow graph. This module is in the policy
 * layer, whose purity rule admits no fs, process, or decompression edge, and
 * the port is what keeps it there.
 *
 * PROVENANCE. Authorship, licence, and attribution for every charter live in
 * the archive's own `provenance.lock.json`, where the archive's manifest
 * closure and licence sensors already cover them. This module deliberately
 * declares no second licence vocabulary: a charter whose provenance would
 * block distribution is rejected in the archive, not restated here.
 */
import { sha256Hex } from "../digest.ts";
import type { AvailablePersona } from "./compile.ts";

/** The declared-data manifest the archive carries, and the schema it must announce. */
export const PERSONA_MANIFEST_ENTRY = "personas/manifest.json";
export const PERSONA_MANIFEST_SPEC = "reviewer-persona-manifest/1";
/** The archive's own per-file digest listing, which the charter bytes are checked against. */
export const ARCHIVE_RELEASE_MANIFEST_ENTRY = "release-manifest.json";

export type ShippedPersonaRejectionCode =
  | "persona_manifest_absent"
  | "persona_manifest_malformed"
  | "persona_charter_absent"
  | "persona_charter_digest_mismatch";

export interface ShippedPersonaRejection {
  readonly code: ShippedPersonaRejectionCode;
  readonly pointer: string;
  readonly message: string;
}

export type ProjectShippedPersonasResult =
  | { readonly ok: true; readonly personas: readonly AvailablePersona[] }
  | { readonly ok: false; readonly rejections: readonly ShippedPersonaRejection[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads one entry of the pinned archive, or reports it absent. Supplied by the caller. */
export type ArchiveEntryReader = (entryPath: string) => Uint8Array | undefined;

const parseJsonEntry = (read: ArchiveEntryReader, entry: string): unknown => {
  const bytes = read(entry);
  if (bytes === undefined) return undefined;
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
};

const parseJson = (text: unknown): unknown => {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The archive's recorded digest for each packed path, or an empty map if unreadable. */
const recordedDigests = (read: ArchiveEntryReader): ReadonlyMap<string, string> => {
  const document = parseJson(parseJsonEntry(read, ARCHIVE_RELEASE_MANIFEST_ENTRY));
  if (!isRecord(document) || !Array.isArray(document["files"])) return new Map();
  const listed = new Map<string, string>();
  for (const file of document["files"]) {
    if (isRecord(file) && typeof file["path"] === "string" && typeof file["sha256"] === "string") {
      listed.set(file["path"], file["sha256"]);
    }
  }
  return listed;
};

/**
 * Projects the pinned archive's charter set into compiler-consumable receipts,
 * in the order the archive declares them. Fail-closed and exhaustive: every
 * defect is reported rather than the first, because a caller that learns only
 * about the first missing charter cannot tell a single drift from a set that
 * did not ship at all.
 */
export function projectShippedPersonas(read: ArchiveEntryReader): ProjectShippedPersonasResult {
  const manifest = parseJson(parseJsonEntry(read, PERSONA_MANIFEST_ENTRY));
  if (manifest === undefined) {
    return {
      ok: false,
      rejections: [
        {
          code: "persona_manifest_absent",
          pointer: PERSONA_MANIFEST_ENTRY,
          message: `the pinned archive carries no ${PERSONA_MANIFEST_ENTRY}; no lens can resolve a shipped charter`,
        },
      ],
    };
  }
  if (!isRecord(manifest) || manifest["schemaVersion"] !== PERSONA_MANIFEST_SPEC || !Array.isArray(manifest["personas"])) {
    return {
      ok: false,
      rejections: [
        {
          code: "persona_manifest_malformed",
          pointer: PERSONA_MANIFEST_ENTRY,
          message: `the charter manifest is not a ${PERSONA_MANIFEST_SPEC} document declaring a charter list`,
        },
      ],
    };
  }

  const listed = recordedDigests(read);
  const personas: AvailablePersona[] = [];
  const rejections: ShippedPersonaRejection[] = [];
  const declared = manifest["personas"];

  for (let index = 0; index < declared.length; index += 1) {
    const entry = declared[index];
    const pointer = `${PERSONA_MANIFEST_ENTRY}#/personas/${index}`;
    if (!isRecord(entry) || typeof entry["personaId"] !== "string" || typeof entry["path"] !== "string") {
      rejections.push({
        code: "persona_manifest_malformed",
        pointer,
        message: "a charter record must name a charter identity and the path its bytes live at",
      });
      continue;
    }
    const personaId = entry["personaId"];
    const entryPath = entry["path"];
    const bytes = read(entryPath);
    if (bytes === undefined) {
      rejections.push({
        code: "persona_charter_absent",
        pointer,
        message: `the manifest names charter ${personaId} at ${entryPath}, and the archive carries no such entry`,
      });
      continue;
    }
    const digest = sha256Hex(bytes);
    const recorded = listed.get(entryPath);
    if (recorded !== undefined && recorded !== digest) {
      rejections.push({
        code: "persona_charter_digest_mismatch",
        pointer,
        message: `charter ${personaId} hashes to ${digest}, and the archive recorded ${recorded} for ${entryPath}`,
      });
      continue;
    }
    if (recorded === undefined) {
      rejections.push({
        code: "persona_charter_digest_mismatch",
        pointer,
        message: `charter ${personaId} at ${entryPath} is not listed in ${ARCHIVE_RELEASE_MANIFEST_ENTRY}, so its bytes are unbound`,
      });
      continue;
    }
    personas.push({ personaId, digest, origin: "composition" });
  }

  return rejections.length > 0 ? { ok: false, rejections } : { ok: true, personas };
}
