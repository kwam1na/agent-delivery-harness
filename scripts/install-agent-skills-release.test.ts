import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InstallError, install, checkInstalledStatus, parseInstallArgs } from "./install-agent-skills-release.ts";
const status = (overrides: Record<string, unknown> = {}): unknown => ({
  active: { archiveSha256: "a".repeat(64), generation: "a".repeat(64), profile: "linear", releaseId: "linear-v2" },
  blockers: [], lifecycle: "current", productReady: true, ...overrides,
});
const expected = { releaseId: "linear-v2", profile: "linear", archiveSha256: "a".repeat(64) };
it("takes distributed artifact paths and refuses source-build or ambiguous input", () => {
  expect(parseInstallArgs(["--archive", "release.zip", "--metadata", "release.json"])).toEqual({ archive: path.resolve("release.zip"), metadata: path.resolve("release.json") });
  for (const args of [[], ["--release-id", "old"], ["--archive", "a"], ["--archive", "a", "--archive", "b"], ["--archive", "a", "--metadata", ""]]) expect(() => parseInstallArgs(args)).toThrow(InstallError);
});
it("forwards an explicit first-policy bootstrap request without accepting duplicate flags", () => {
  expect(parseInstallArgs(["--bootstrap-policy", "--archive", "release.zip", "--metadata", "release.json"])).toEqual({ archive: path.resolve("release.zip"), metadata: path.resolve("release.json"), bootstrapPolicy: true });
  expect(() => parseInstallArgs(["--archive", "a", "--metadata", "b", "--bootstrap-policy", "--bootstrap-policy"])).toThrow(InstallError);
});
it("does not call a switched generation ready while policy reconciliation failed", () => {
  expect(() => checkInstalledStatus(status({ productReady: false }), expected)).toThrow(InstallError);
});
describe("the status the install must reach", () => {
  it("accepts a current lifecycle with no blockers and the new generation active", () => {
    expect(() => checkInstalledStatus(status(), expected)).not.toThrow();
  });

  it("refuses every status that is not that one", () => {
    // Each row is a way an install fails while the command still exits zero.
    expect(() => checkInstalledStatus(status({ lifecycle: "stale" }), expected)).toThrow(InstallError);
    expect(() => checkInstalledStatus(status({ blockers: ["journal_incomplete"] }), expected)).toThrow(InstallError);
    expect(() => checkInstalledStatus(status({ blockers: "none" }), expected)).toThrow(InstallError);
    // The generation that is active is the one just built, by digest. Without
    // this the script would report success over an unchanged installation.
    expect(() =>
      checkInstalledStatus(status({ active: { ...(status() as { active: object }).active, archiveSha256: "b".repeat(64) } }), expected),
    ).toThrow(InstallError);
    expect(() =>
      checkInstalledStatus(status({ active: { ...(status() as { active: object }).active, releaseId: "linear-v1" } }), expected),
    ).toThrow(InstallError);
    expect(() =>
      checkInstalledStatus(status({ active: { ...(status() as { active: object }).active, profile: "core" } }), expected),
    ).toThrow(InstallError);
    // A shape the lifecycle never emits is a refusal, not a pass: an absent
    // member must never read as an absent blocker.
    expect(() => checkInstalledStatus(status({ active: undefined }), expected)).toThrow(InstallError);
    expect(() => checkInstalledStatus(status({ blockers: undefined }), expected)).toThrow(InstallError);
    expect(() => checkInstalledStatus("current", expected)).toThrow(InstallError);
  });
});

it("rejects mismatched archive bytes before execution and executes matching bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "installer-checksum-"));
  try {
    const archive = path.join(dir, "product.zip"), metadata = path.join(dir, "release.json");
    const marker = path.join(dir, "executed-archive-marker");
    await promisify(execFile)("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], 'w'); z.writestr('__main__.py', \"from pathlib import Path\\nPath('executed-archive-marker').write_text('executed')\\nraise SystemExit(7)\\n\"); z.close()", archive]);
    const detached = { schemaVersion: "agent-skills-release-metadata/1", releaseId: "test", profile: "linear", archiveSha256: "0".repeat(64) };
    await writeFile(metadata, JSON.stringify(detached));
    await expect(install({ archive, metadata }, dir)).rejects.toThrow("release.archive_checksum");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(metadata, JSON.stringify({ ...detached, archiveSha256: createHash("sha256").update(await readFile(archive)).digest("hex") }));
    await expect(install({ archive, metadata }, dir)).rejects.toThrow("product lifecycle failed");
    expect(await readFile(marker, "utf8")).toBe("executed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
