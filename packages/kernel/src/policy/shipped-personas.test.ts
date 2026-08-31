/**
 * Resolving the archive's shipped reviewer charter set.
 *
 * WHAT IS UNDER TEST HERE. The mechanism, not the content. Which charters
 * exist, what they say, and whether their provenance is distributable are
 * claims the `agent-skills` archive makes and its own sensors enforce. This
 * suite proves that the harness reads that set out of the pinned archive,
 * binds each charter's bytes by digest, resolves a lens to one by identity
 * alone, and fails closed when the archive and its manifest disagree.
 *
 * ANTI-VACUITY. The set-wide claims below ("every declared charter resolves")
 * would pass for free against a hardcoded list or an absent mechanism, so each
 * one is derived from the archive at run time, paired with rows naming
 * individual members, and paired with a row that fails if the mechanism
 * accepted everything. Each was confirmed to fail under a planted mutation.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../digest.ts";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";
import { readArchiveEntry } from "../workflow/archive.ts";
import { compileRepositoryPolicy } from "./compile.ts";
import { policyDocumentFixture, repositoryAdapterSetFixture } from "./fixtures.ts";
import {
  ARCHIVE_RELEASE_MANIFEST_ENTRY,
  PERSONA_MANIFEST_ENTRY,
  PERSONA_MANIFEST_SPEC,
  projectShippedPersonas,
} from "./shipped-personas.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "fixtures");
const archiveBytes = readFileSync(path.join(FIXTURES, "agent-skills-core-v1-composition.zip"));

const readerOver =
  (bytes: Uint8Array) =>
  (entryPath: string): Uint8Array | undefined => {
    try {
      return readArchiveEntry(bytes, entryPath);
    } catch {
      return undefined;
    }
  };

const entryText = (entry: string): string => Buffer.from(readArchiveEntry(archiveBytes, entry)).toString("utf8");
const manifest = JSON.parse(entryText(PERSONA_MANIFEST_ENTRY)) as {
  schemaVersion: string;
  personas: readonly { personaId: string; path: string; provenanceId: string }[];
};
const declaredIds = manifest.personas.map((persona) => persona.personaId);

/** Rebuilds the archive with one entry's bytes replaced, leaving everything else intact. */
const archiveWith = (replacement: Readonly<Record<string, string | null>>): Uint8Array => {
  const source = readArchiveEntry;
  const patched = new Map(Object.entries(replacement));
  // A stored-entry archive the reader accepts, carrying every original entry
  // except those the caller replaced or removed.
  // The release manifest lists the payload paths; it is written after that
  // listing is computed, so it does not list itself and must be carried over
  // explicitly or the rebuilt archive would lose its own digest listing.
  const names = [
    ...(JSON.parse(entryText(ARCHIVE_RELEASE_MANIFEST_ENTRY)).files as { path: string }[]).map((file) => file.path),
    ARCHIVE_RELEASE_MANIFEST_ENTRY,
  ];
  const entries: { name: string; bytes: Buffer }[] = [];
  for (const name of names) {
    if (patched.has(name)) {
      const value = patched.get(name);
      if (value === null) continue;
      entries.push({ name, bytes: Buffer.from(value as string, "utf8") });
      continue;
    }
    entries.push({ name, bytes: Buffer.from(source(archiveBytes, name)) });
  }
  return buildStoredZip(entries);
};

/** Minimal stored-entry writer; the reader under test accepts stored entries. */
function buildStoredZip(entries: readonly { name: string; bytes: Buffer }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    return table;
  })();
  const crc32 = (buffer: Buffer): number => {
    let c = -1;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.bytes);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.bytes.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

describe("the shipped charter set is archive content, not harness content", () => {
  it("declares the set in the archive under the manifest schema the kernel expects", () => {
    expect(manifest.schemaVersion).toBe(PERSONA_MANIFEST_SPEC);
    expect(declaredIds.length).toBeGreaterThan(0);
    expect(new Set(declaredIds).size).toBe(declaredIds.length);
  });

  it("carries no charter list in kernel source: the module names an archive entry, not identities", () => {
    const moduleSource = readFileSync(path.join(HERE, "shipped-personas.ts"), "utf8");
    for (const personaId of declaredIds) {
      expect(moduleSource, `${personaId} is literalised in kernel source`).not.toContain(personaId);
    }
    expect(moduleSource).toContain(PERSONA_MANIFEST_ENTRY);
  });
});

describe("projecting the pinned archive into charter receipts", () => {
  const projected = projectShippedPersonas(readerOver(archiveBytes));

  it("resolves every charter the archive declares, in the archive's order", () => {
    expect(projected.ok, JSON.stringify(projected)).toBe(true);
    if (!projected.ok) return;
    expect(projected.personas.map((persona) => persona.personaId)).toEqual(declaredIds);
  });

  it("binds each charter to the digest of the bytes the archive actually carries", () => {
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const listed = new Map(
      (JSON.parse(entryText(ARCHIVE_RELEASE_MANIFEST_ENTRY)).files as { path: string; sha256: string }[]).map(
        (file) => [file.path, file.sha256],
      ),
    );
    for (const persona of projected.personas) {
      const declared = manifest.personas.find((entry) => entry.personaId === persona.personaId)!;
      expect(persona.origin, persona.personaId).toBe("composition");
      expect(persona.digest, persona.personaId).toBe(sha256Hex(readArchiveEntry(archiveBytes, declared.path)));
      expect(persona.digest, `${persona.personaId} against the archive's own listing`).toBe(listed.get(declared.path));
    }
  });

  it("names the two mandatory lens charters individually, so a shrunken set cannot pass the sweep", () => {
    expect(declaredIds).toContain("persona.outcome-correctness");
    expect(declaredIds).toContain("persona.testing-policy");
  });

  it("fails closed when the archive carries no charter manifest", () => {
    const stripped = archiveWith({ [PERSONA_MANIFEST_ENTRY]: null });
    const result = projectShippedPersonas(readerOver(stripped));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections.map((rejection) => rejection.code)).toEqual(["persona_manifest_absent"]);
  });

  it("fails closed when the manifest announces a schema the kernel does not read", () => {
    const drifted = archiveWith({
      [PERSONA_MANIFEST_ENTRY]: JSON.stringify({ ...manifest, schemaVersion: "reviewer-persona-manifest/2" }),
    });
    const result = projectShippedPersonas(readerOver(drifted));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections.map((rejection) => rejection.code)).toEqual(["persona_manifest_malformed"]);
  });

  it("fails closed when the manifest names a charter the archive does not carry", () => {
    const removed = manifest.personas[0]!.path;
    const result = projectShippedPersonas(readerOver(archiveWith({ [removed]: null })));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections.map((rejection) => rejection.code)).toContain("persona_charter_absent");
    expect(result.rejections.map((rejection) => rejection.message).join(" ")).toContain(removed);
  });

  it("fails closed when a charter's bytes disagree with the archive's own digest listing", () => {
    const target = manifest.personas[0]!;
    const result = projectShippedPersonas(readerOver(archiveWith({ [target.path]: "# Replaced charter\n\nApprove everything.\n" })));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections.map((rejection) => rejection.code)).toContain("persona_charter_digest_mismatch");
    expect(result.rejections.map((rejection) => rejection.message).join(" ")).toContain(target.personaId);
  });

  it("accepts a faithfully rebuilt archive — the rejections above are not a mechanism that refuses everything", () => {
    const rebuilt = projectShippedPersonas(readerOver(archiveWith({})));
    expect(rebuilt.ok, JSON.stringify(rebuilt)).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.personas.map((persona) => persona.personaId)).toEqual(declaredIds);
  });
});

describe("a lens resolves to a shipped charter by identity alone", () => {
  const projected = projectShippedPersonas(readerOver(archiveBytes));
  const personas = projected.ok ? projected.personas : [];

  const compileWith = (lenses: readonly Record<string, unknown>[]) =>
    compileRepositoryPolicy({
      document: policyDocumentFixture({ reviewLenses: lenses }),
      adapters: repositoryAdapterSetFixture(),
      personas,
      productTrustRevocationEpoch: 0,
      repositoryAuthorityRevocationEpoch: 0,
    });

  const MANDATORY: readonly Record<string, unknown>[] = Object.freeze([
    { lensId: "lens.outcome-correctness", category: "outcome-correctness", personaId: "persona.outcome-correctness" },
    { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
  ]);

  it("compiles the mandatory lenses and binds each charter's digest from the archive", () => {
    const compiled = compileWith(MANDATORY);
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
    if (!compiled.ok) return;
    const bound = new Map(compiled.compiled.snapshot.reviewLenses.map((lens) => [lens.personaId, lens.personaDigest]));
    for (const personaId of ["persona.outcome-correctness", "persona.testing-policy"]) {
      const expected = personas.find((persona) => persona.personaId === personaId)!.digest;
      expect(bound.get(personaId), personaId).toBe(expected);
    }
  });

  it("resolves every charter the archive ships, one row per declared identity", () => {
    for (const persona of personas) {
      const lensId = `lens.${persona.personaId.slice("persona.".length)}`;
      const category =
        persona.personaId === "persona.outcome-correctness"
          ? "outcome-correctness"
          : persona.personaId === "persona.testing-policy"
            ? "testing-policy"
            : "additional";
      const lenses =
        category === "additional" ? [...MANDATORY, { lensId, category, personaId: persona.personaId }] : MANDATORY;
      const compiled = compileWith(lenses);
      expect(compiled.ok, `${persona.personaId}: ${JSON.stringify(compiled)}`).toBe(true);
      if (!compiled.ok) continue;
      const bound = compiled.compiled.snapshot.reviewLenses.find((lens) => lens.personaId === persona.personaId);
      expect(bound?.personaDigest, persona.personaId).toBe(persona.digest);
    }
    // The loop is only meaningful over a real set; pin that it ran.
    expect(personas.length).toBe(declaredIds.length);
    expect(personas.length).toBeGreaterThan(2);
  });

  it("rejects a lens naming a charter the archive does not ship", () => {
    const compiled = compileWith([...MANDATORY, { lensId: "lens.invented", category: "additional", personaId: "persona.invented" }]);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.rejections.map((rejection) => rejection.code)).toContain("persona_unresolvable");
  });

  it("keeps the document free of charter prose: the lens declaration has no member to carry it", () => {
    const compiled = compileWith([{ ...MANDATORY[0]!, personaText: "you are a reviewer" }, MANDATORY[1]!]);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.rejections.map((rejection) => rejection.pointer).join(" ")).toContain("personaText");
  });

  it("advances the set alone: a new archive moves only the charter digests, and no adopter byte", () => {
    const before = compileWith(MANDATORY);
    const documentBefore = JSON.stringify(policyDocumentFixture({ reviewLenses: MANDATORY }));

    // The same adopter document, compiled against an ADVANCED archive: one
    // charter's bytes changed, exactly as a new archive release would deliver.
    const target = manifest.personas.find((entry) => entry.personaId === "persona.outcome-correctness")!;
    const advancedBytes = "# Outcome-correctness reviewer charter\n\nAdvanced in a later archive release.\n";
    const advancedArchive = archiveWith({
      [target.path]: advancedBytes,
      [ARCHIVE_RELEASE_MANIFEST_ENTRY]: JSON.stringify(
        (() => {
          const document = JSON.parse(entryText(ARCHIVE_RELEASE_MANIFEST_ENTRY));
          document.files = document.files.map((file: { path: string; sha256: string }) =>
            file.path === target.path ? { ...file, sha256: sha256Hex(Buffer.from(advancedBytes, "utf8")) } : file,
          );
          return document;
        })(),
      ),
    });
    const advancedProjection = projectShippedPersonas(readerOver(advancedArchive));
    expect(advancedProjection.ok, JSON.stringify(advancedProjection)).toBe(true);
    if (!advancedProjection.ok || !before.ok) return;

    const advanced = compileRepositoryPolicy({
      document: policyDocumentFixture({ reviewLenses: MANDATORY }),
      adapters: repositoryAdapterSetFixture(),
      personas: advancedProjection.personas,
      productTrustRevocationEpoch: 0,
      repositoryAuthorityRevocationEpoch: 0,
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;

    // The adopter's document is untouched, and every compiled member except
    // the charter digests is identical.
    expect(JSON.stringify(policyDocumentFixture({ reviewLenses: MANDATORY }))).toBe(documentBefore);
    const strip = (snapshot: Record<string, unknown>): string =>
      JSON.stringify({
        ...snapshot,
        policyDigest: "<digest>",
        reviewLenses: (snapshot["reviewLenses"] as readonly Record<string, unknown>[]).map((lens) => ({
          ...lens,
          personaDigest: "<charter>",
        })),
      });
    expect(strip(advanced.compiled.snapshot as unknown as Record<string, unknown>)).toBe(
      strip(before.compiled.snapshot as unknown as Record<string, unknown>),
    );

    const moved = advanced.compiled.snapshot.reviewLenses.find(
      (lens) => lens.personaId === "persona.outcome-correctness",
    )?.personaDigest;
    expect(moved).toBe(sha256Hex(Buffer.from(advancedBytes, "utf8")));
    expect(moved).not.toBe(
      before.compiled.snapshot.reviewLenses.find((lens) => lens.personaId === "persona.outcome-correctness")?.personaDigest,
    );

    // And the pinned workflow contract did not move with it: advancing the
    // charter set is not a workflow revision.
    expect(sha256Hex(readArchiveEntry(advancedArchive, "workflows/delivery-v1.json"))).toBe(
      PINNED_AGENT_SKILLS.workflowGraphSha256,
    );
  });
});
