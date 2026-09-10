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
  return { root, generationDir, archiveDigest };
}

describe("installed generation integrity", () => {
  it("accepts every byte named by the active receipt and its selected pointer", async () => {
    const { root } = await fixture();
    expect(await checkInstalledGenerationIntegrity(root)).toEqual([]);
  });

  it.each(["missing receipt", "invalid JSON", "invalid receipt shape", "non-link pointer"])(
    "reports unreadable installation inputs: %s", async (failure) => {
      const { root } = await fixture();
      const receipt = path.join(root, ".agent-skills", "active.json");
      const pointer = path.join(root, ".agent-skills", "current");
      if (failure === "missing receipt") await rm(receipt);
      else if (failure === "invalid JSON") await writeFile(receipt, "{", "utf8");
      else if (failure === "invalid receipt shape") await writeFile(receipt, "{}", "utf8");
      else {
        await rm(pointer);
        await writeFile(pointer, "not a symlink", "utf8");
      }

      expect(await checkInstalledGenerationIntegrity(root)).toEqual([{
        code: "installed_generation_receipt_unreadable",
        message: expect.stringContaining(".agent-skills/active.json or .agent-skills/current is unreadable"),
      }]);
    },
  );

  it("reports a changed installed byte and names the manifest path", async () => {
    const { root, generationDir } = await fixture();
    await writeFile(path.join(generationDir, "skills", "plan-work", "SKILL.md"), "# Corrupted\n", "utf8");

    const findings = await checkInstalledGenerationIntegrity(root);
    expect(findings.map((finding) => finding.code)).toContain("installed_generation_file_drift");
    expect(findings.some((finding) => finding.message.includes("skills/plan-work/SKILL.md"))).toBe(true);
  });

  it("reports the full refusal when a receipt file is missing", async () => {
    const { root, generationDir } = await fixture();
    await rm(path.join(generationDir, "skills", "plan-work", "SKILL.md"));

    expect(await checkInstalledGenerationIntegrity(root)).toEqual([{
      code: "installed_generation_file_drift",
      message: expect.stringContaining(
        "skills/plan-work/SKILL.md is missing or unreadable in the installed generation:",
      ),
    }]);
  });

  it("refuses a receipt path that escapes the selected generation", async () => {
    const { root, generationDir, archiveDigest } = await fixture();
    const escapedPath = "../outside.md";
    const outside = "# Outside generation\n";
    await writeFile(path.resolve(generationDir, escapedPath), outside, "utf8");
    await writeFile(
      path.join(root, ".agent-skills", "active.json"),
      `${JSON.stringify({
        release: { archiveSha256: archiveDigest },
        files: [{ path: escapedPath, sha256: sha256(outside) }],
      }, null, 2)}\n`,
      "utf8",
    );

    expect(await checkInstalledGenerationIntegrity(root)).toEqual([{
      code: "installed_generation_file_drift",
      message: "../outside.md escapes the installed generation selected by .agent-skills/current",
    }]);
  });

  it("checks every receipt file after the first valid entry", async () => {
    const { root, generationDir, archiveDigest } = await fixture();
    const valid = "# Plan work\n";
    const expected = "# Execute work\n";
    const corrupted = "# Corrupted execute work\n";
    const laterPath = "skills/execute-work/SKILL.md";
    await mkdir(path.dirname(path.join(generationDir, laterPath)), { recursive: true });
    await writeFile(path.join(generationDir, laterPath), corrupted, "utf8");
    await writeFile(
      path.join(root, ".agent-skills", "active.json"),
      `${JSON.stringify({
        release: { archiveSha256: archiveDigest },
        files: [
          { path: "skills/plan-work/SKILL.md", sha256: sha256(valid) },
          { path: laterPath, sha256: sha256(expected) },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    expect(await checkInstalledGenerationIntegrity(root)).toEqual([{
      code: "installed_generation_file_drift",
      message: `${laterPath} has sha256 ${sha256(corrupted)}, not the ${sha256(expected)} recorded by .agent-skills/active.json`,
    }]);
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
