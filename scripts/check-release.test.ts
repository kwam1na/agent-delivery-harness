/**
 * The release-mechanics sensor, falsified rule by rule.
 *
 * One test asserts the repository itself is releasable — that is the check the
 * release workflow runs. The rest break each rule in a fixture tree and expect
 * the named finding, so a rule that stops firing is a red test rather than a
 * silently vacuous release gate.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EXPECTED_LICENSE_ID,
  LICENSE_TEXT_MARKERS,
  formatReleaseFindings,
  repoRootFromHere,
  runReleaseChecks,
  type ReleaseFinding,
} from "./check-release.ts";

const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const APACHE_LICENSE_STUB = `${LICENSE_TEXT_MARKERS.join("\n")}\n`;

/**
 * A canned green pack shape for fixture runs, so the rules under test fail for
 * their own reasons rather than because a fixture tree cannot be npm-packed.
 * The pack-shape rule itself is falsified below with shapes that omit each
 * required file, and proven against the real npm report by the repository test.
 */
const STUB_PACK = (): readonly string[] => ["package.json", "LICENSE", "NOTICE", "src/index.ts"];

interface FixtureOptions {
  readonly rootVersion?: string;
  readonly rootLicense?: string | undefined;
  readonly rootPrivate?: boolean;
  readonly license?: string | false;
  readonly packages?: readonly {
    readonly name: string;
    readonly version?: string;
    readonly license?: string | undefined;
    readonly isPrivate?: boolean;
  }[];
}

function makeFixture(options: FixtureOptions = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-release-"));
  cleanups.push(dir);
  const rootManifest: Record<string, unknown> = {
    name: "fixture-root",
    version: options.rootVersion ?? "1.2.3",
    workspaces: ["packages/*"],
  };
  if (options.rootLicense !== undefined) rootManifest["license"] = options.rootLicense;
  if (options.rootPrivate !== false) rootManifest["private"] = true;
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`, "utf8");

  if (options.license !== false) {
    writeFileSync(path.join(dir, "LICENSE"), options.license ?? APACHE_LICENSE_STUB, "utf8");
  }

  const packages = options.packages ?? [
    { name: "@fixture/a" },
    { name: "@fixture/b" },
  ];
  for (const pkg of packages) {
    const pkgDir = path.join(dir, "packages", pkg.name.replace(/^@[^/]+\//u, ""));
    mkdirSync(pkgDir, { recursive: true });
    const manifest: Record<string, unknown> = { name: pkg.name, version: pkg.version ?? "1.2.3" };
    manifest["license"] = pkg.license === undefined ? EXPECTED_LICENSE_ID : pkg.license;
    if (pkg.isPrivate === true) manifest["private"] = true;
    writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return dir;
}

function rulesOf(findings: readonly ReleaseFinding[]): string[] {
  return findings.map((finding) => finding.rule);
}

describe("this repository is releasable", () => {
  it("passes every release check", () => {
    const result = runReleaseChecks({ root: repoRootFromHere() });
    expect(formatReleaseFindings(result.findings)).toBe("");
    expect(result.findings).toEqual([]);
    // The five packages this workspace ships.
    expect(result.packageManifests).toEqual([
      "packages/action/package.json",
      "packages/cli/package.json",
      "packages/conformance/package.json",
      "packages/kernel/package.json",
      "packages/mcp/package.json",
    ]);
  });
});

describe("a coherent fixture", () => {
  it("passes, so every falsification below fails for its own reason", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(result.findings).toEqual([]);
  });
});

describe("version-consistency", () => {
  it("flags a package whose version disagrees with the root", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a" }, { name: "@fixture/b", version: "9.9.9" }],
    });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["version-consistency"]);
    expect(result.findings[0]!.file).toBe("packages/b/package.json");
  });
});

describe("harness-version-lockstep", () => {
  it("flags a fingerprint constant left behind by a version bump", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.2", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["harness-version-lockstep"]);
    expect(result.findings[0]!.file).toBe("packages/kernel/src/preparation.ts");
  });
});

describe("license-coherence", () => {
  it("flags a missing LICENSE file", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID, license: false });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["license-coherence"]);
    expect(result.findings[0]!.file).toBe("LICENSE");
  });

  it("flags a LICENSE that names Apache but is not the license text", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID, license: "Apache License\n" });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["license-coherence", "license-coherence"]);
  });

  it("flags a manifest whose license field disagrees with the LICENSE file", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a", license: "MIT" }, { name: "@fixture/b" }],
    });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["license-coherence"]);
    expect(result.findings[0]!.file).toBe("packages/a/package.json");
  });

  it("flags a tarball that would ship without the LICENSE", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID });
    const result = runReleaseChecks({
      root: dir,
      harnessVersion: "1.2.3",
      packFiles: (packageDir) =>
        packageDir.endsWith(`${path.sep}a`) ? ["package.json", "NOTICE", "src/index.ts"] : STUB_PACK(),
    });
    expect(rulesOf(result.findings)).toEqual(["license-coherence"]);
    expect(result.findings[0]!.file).toBe("packages/a/package.json");
    expect(result.findings[0]!.message).toContain("LICENSE");
  });

  it("flags a tarball that would ship without the NOTICE", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID });
    const result = runReleaseChecks({
      root: dir,
      harnessVersion: "1.2.3",
      packFiles: (packageDir) =>
        packageDir.endsWith(`${path.sep}b`) ? ["package.json", "LICENSE", "src/index.ts"] : STUB_PACK(),
    });
    expect(rulesOf(result.findings)).toEqual(["license-coherence"]);
    expect(result.findings[0]!.file).toBe("packages/b/package.json");
    expect(result.findings[0]!.message).toContain("NOTICE");
  });

  it("treats an unpackable package as a finding, never as a skip", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID, packages: [{ name: "@fixture/a" }] });
    const result = runReleaseChecks({
      root: dir,
      harnessVersion: "1.2.3",
      packFiles: () => {
        throw new Error("pack exploded");
      },
    });
    expect(rulesOf(result.findings)).toEqual(["license-coherence"]);
    expect(result.findings[0]!.message).toContain("pack exploded");
  });

  it("flags a manifest that declares no license at all", () => {
    const dir = makeFixture({ packages: [{ name: "@fixture/a" }] });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["license-coherence"]);
    expect(result.findings[0]!.file).toBe("package.json");
  });
});

describe("publishability", () => {
  it("flags a private workspace package: the dry-run leg could never pack it", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a", isPrivate: true }, { name: "@fixture/b" }],
    });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["publishability"]);
    expect(result.findings[0]!.file).toBe("packages/a/package.json");
  });

  it("flags a root manifest that lost its private flag", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID, rootPrivate: false });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["publishability"]);
    expect(result.findings[0]!.file).toBe("package.json");
  });
});

describe("anti-vacuity", () => {
  it("an empty package set is a finding, not a vacuous pass", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID, packages: [] });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["anti-vacuity"]);
  });
});
