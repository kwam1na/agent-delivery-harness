import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { checkInstalledGenerationIntegrity } from "./installed-generation-integrity.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "installed-generation-integrity-"));
  cleanups.push(root);
  const archiveDigest = "a".repeat(64);
  const generationDir = path.join(root, ".agent-skills", "generations", archiveDigest);
  await mkdir(path.join(generationDir, "skills", "plan-work"), { recursive: true });
  const skill = "# Plan work\n";
  await writeFile(path.join(generationDir, "skills", "plan-work", "SKILL.md"), skill, "utf8");
  await symlink(path.join("generations", archiveDigest), path.join(root, ".agent-skills", "current"));
  await writeFile(
    path.join(root, ".agent-skills", "active.json"),
    `${JSON.stringify({
      release: { archiveSha256: archiveDigest },
      files: [{ path: "skills/plan-work/SKILL.md", sha256: sha256(skill) }],
    }, null, 2)}\n`,
    "utf8",
  );
  return { root, generationDir };
}

describe("installed generation integrity", () => {
  it("accepts every byte named by the active receipt and its selected pointer", async () => {
    const { root } = await fixture();
    expect(await checkInstalledGenerationIntegrity(root)).toEqual([]);
  });

  it("reports a changed installed byte and names the manifest path", async () => {
    const { root, generationDir } = await fixture();
    await writeFile(path.join(generationDir, "skills", "plan-work", "SKILL.md"), "# Corrupted\n", "utf8");

    const findings = await checkInstalledGenerationIntegrity(root);
    expect(findings.map((finding) => finding.code)).toContain("installed_generation_file_drift");
    expect(findings.some((finding) => finding.message.includes("skills/plan-work/SKILL.md"))).toBe(true);
  });

  it("reports when current selects a generation other than active.json's release", async () => {
    const { root } = await fixture();
    const other = "b".repeat(64);
    await mkdir(path.join(root, ".agent-skills", "generations", other), { recursive: true });
    await rm(path.join(root, ".agent-skills", "current"));
    await symlink(path.join("generations", other), path.join(root, ".agent-skills", "current"));

    const findings = await checkInstalledGenerationIntegrity(root);
    expect(findings.map((finding) => finding.code)).toContain("installed_generation_pointer_drift");
  });

  it("passes against this repository's active installed generation", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    expect(await checkInstalledGenerationIntegrity(root)).toEqual([]);
    expect(JSON.parse(await readFile(path.join(root, ".agent-skills", "active.json"), "utf8"))).toHaveProperty("files");
  });
});
