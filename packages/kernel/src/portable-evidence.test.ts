import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactsPort } from "./artifacts.ts";
import { portableArtifactContents, MAX_PORTABLE_ARTIFACT_BYTES, MAX_PORTABLE_RECORD_BYTES } from "./portable-evidence.ts";
import { parseDeliveryRecord } from "./delivery-record.ts";
import { resolveReviewCharters } from "./review-inputs.ts";
import { sha256Hex } from "./digest.ts";

describe("portable byte transport", () => {
  it("preserves binary bytes and refuses an oversized original before decoding", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "portable-bytes-"));
    try {
      const bytes = Buffer.from([0, 255, 128, 1]);
      await writeFile(path.join(dir, "binary"), bytes);
      const observed = await createArtifactsPort().observeArtifact(dir, "binary");
      expect(observed.base64).toBe(bytes.toString("base64"));
      expect(portableArtifactContents({ binary: observed.base64 }).observations.get("binary")?.sha256).toBe(sha256Hex(bytes));
      await writeFile(path.join(dir, "large"), Buffer.alloc(MAX_PORTABLE_ARTIFACT_BYTES + 1));
      expect((await createArtifactsPort().observeArtifact(dir, "large")).status).toBe("unreadable");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each([{ "../escape": "eA==" }, { x: "eA" }, { x: "eB==" }, { x: 12 }, { x: "x".repeat(Math.ceil(MAX_PORTABLE_ARTIFACT_BYTES / 3) * 4 + 1) }])("refuses unsafe or noncanonical bounded artifacts", input => {
    expect(portableArtifactContents(input).blockers.length).toBeGreaterThan(0);
  });
  it("bounds the serialized record before parsing", () => {
    const result = parseDeliveryRecord(" ".repeat(MAX_PORTABLE_RECORD_BYTES + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0].details).toContain("size limit");
  });
});

describe("declared compilation provenance", () => {
  const charter = Buffer.from("Reviewer charter\n");
  const document = Buffer.from("{}\n");
  const release = { releaseId: "fixture", profile: "core", archiveSha256: "a".repeat(64), metadataSha256: "b".repeat(64) };
  function inputs() {
    const snapshot = { compiledWith: { personaSource: { archiveSha256: release.archiveSha256 } }, inputDigests: { "repository-policy.json": sha256Hex(document) },
      compiled: { snapshot: { reviewLenses: [{ lensId: "lens.fixture", personaId: "persona.fixture", personaDigest: sha256Hex(charter) }] } } };
    return new Map<string, Uint8Array>([
      [".agents/policy/compiled-snapshot.json", Buffer.from(JSON.stringify(snapshot))],
      [".agents/policy/repository-policy.json", document],
      [".agent-skills/active.json", Buffer.from(JSON.stringify({ release }))],
      [".agent-skills/current/personas/manifest.json", Buffer.from(JSON.stringify({ schemaVersion: "reviewer-persona-manifest/1", personas: [{ personaId: "persona.fixture", path: "personas/fixture.md" }] }))],
      [".agent-skills/current/personas/fixture.md", charter],
    ]);
  }
  it("accepts current declared input hashes and generation, rejecting each independent mismatch", async () => {
    const files = inputs();
    const read = async (file: string) => files.get(file) ?? null;
    expect(await resolveReviewCharters(read)).toHaveLength(1);
    files.set(".agents/policy/repository-policy.json", Buffer.from("changed"));
    await expect(resolveReviewCharters(read)).rejects.toThrow("declared input bytes");
    files.set(".agents/policy/repository-policy.json", document);
    files.set(".agent-skills/active.json", Buffer.from(JSON.stringify({ release: { ...release, archiveSha256: "c".repeat(64) } })));
    await expect(resolveReviewCharters(read)).rejects.toThrow("active workflow generation");
  });
});
