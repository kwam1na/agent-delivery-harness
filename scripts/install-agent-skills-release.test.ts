import path from "node:path";
import { describe, expect, it } from "vitest";
import { InstallError, checkInstalledStatus, parseInstallArgs } from "./install-agent-skills-release.ts";
const status = (overrides: Record<string, unknown> = {}): unknown => ({
  active: { archiveSha256: "a".repeat(64), generation: "a".repeat(64), profile: "linear", releaseId: "linear-v2" },
  blockers: [], lifecycle: "current", productReady: true, ...overrides,
});
const expected = { releaseId: "linear-v2", profile: "linear", archiveSha256: "a".repeat(64) };
it("takes distributed artifact paths and refuses source-build or ambiguous input", () => {
  expect(parseInstallArgs(["--archive", "release.zip", "--metadata", "release.json"])).toEqual({ archive: path.resolve("release.zip"), metadata: path.resolve("release.json") });
  for (const args of [[], ["--release-id", "old"], ["--archive", "a"], ["--archive", "a", "--archive", "b"], ["--archive", "a", "--metadata", ""]]) expect(() => parseInstallArgs(args)).toThrow(InstallError);
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
