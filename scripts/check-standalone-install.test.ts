/**
 * The standalone-install sensor's readable half.
 *
 * The sensor's whole point is the part that cannot be unit-tested: five real
 * `npm pack` runs and five real `npm install` runs into temp trees outside the
 * workspace. That leg is wired where the release checks run
 * (`npm run sensor:standalone`), not into this suite, because it takes seconds
 * rather than milliseconds.
 *
 * What IS falsified here is everything the slow leg depends on being right: the
 * manifest reader that decides which sibling edges get asserted, and the two
 * anti-vacuity guards that stop a run which packed nothing, or which could not
 * load TypeScript at all, from reporting a clean sensor. Both guards return
 * before any subprocess, so these tests spawn nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PACKAGE_SCOPE,
  readWorkspacePackages,
  runStandaloneInstallCheck,
} from "./check-standalone-install.ts";

const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface FixturePackage {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

function makeFixture(packages: readonly FixturePackage[], options: { readonly withLoader?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-standalone-test-"));
  cleanups.push(dir);
  mkdirSync(path.join(dir, "packages"), { recursive: true });
  for (const pkg of packages) {
    const pkgDir = path.join(dir, "packages", pkg.name.replace(/^@[^/]+\//u, ""));
    mkdirSync(pkgDir, { recursive: true });
    const manifest: Record<string, unknown> = { name: pkg.name, version: "0.1.0" };
    if (pkg.dependencies !== undefined) manifest["dependencies"] = pkg.dependencies;
    writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  if (options.withLoader === true) {
    const loaderDir = path.join(dir, "node_modules", "tsx", "dist");
    mkdirSync(loaderDir, { recursive: true });
    writeFileSync(path.join(loaderDir, "loader.mjs"), "", "utf8");
  }
  return dir;
}

describe("readWorkspacePackages", () => {
  it("reports only the sibling dependencies, not every dependency", () => {
    const dir = makeFixture([
      {
        name: `${PACKAGE_SCOPE}/cli`,
        dependencies: { [`${PACKAGE_SCOPE}/kernel`]: "0.1.0", "some-third-party": "^1.0.0" },
      },
      { name: `${PACKAGE_SCOPE}/kernel` },
    ]);
    const packages = readWorkspacePackages(dir);
    expect(packages.map((pkg) => pkg.name)).toEqual([`${PACKAGE_SCOPE}/cli`, `${PACKAGE_SCOPE}/kernel`]);
    expect(packages[0]!.siblingDependencies).toEqual([`${PACKAGE_SCOPE}/kernel`]);
    expect(packages[1]!.siblingDependencies).toEqual([]);
  });

  it("reports no siblings for a manifest with no dependencies block", () => {
    const dir = makeFixture([{ name: `${PACKAGE_SCOPE}/kernel` }]);
    expect(readWorkspacePackages(dir)[0]!.siblingDependencies).toEqual([]);
  });
});

describe("anti-vacuity", () => {
  it("an empty package set is a finding, not a vacuous pass", () => {
    const dir = makeFixture([], { withLoader: true });
    const result = runStandaloneInstallCheck({ root: dir });
    expect(result.findings.map((finding) => finding.rule)).toEqual(["anti-vacuity"]);
    expect(result.findings[0]!.subject).toBe("packages");
    expect(result.packagesProbed).toEqual([]);
  });

  it("a missing TypeScript loader is a finding, never a skipped probe", () => {
    // These packages publish TypeScript sources, so without a loader every
    // entry-point probe would be unrunnable — reporting clean there would be a
    // sensor that verified nothing.
    const dir = makeFixture([{ name: `${PACKAGE_SCOPE}/kernel` }]);
    const result = runStandaloneInstallCheck({ root: dir });
    expect(result.findings.map((finding) => finding.rule)).toEqual(["anti-vacuity"]);
    expect(result.findings[0]!.subject).toBe("tsx");
    expect(result.siblingEdgesVerified).toBe(0);
  });
});
