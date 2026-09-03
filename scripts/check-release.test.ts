/**
 * The release-mechanics sensor, falsified rule by rule.
 *
 * One test asserts the repository itself is releasable — that is the check the
 * release workflow runs. The rest break each rule in a fixture tree and expect
 * the named finding, so a rule that stops firing is a red test rather than a
 * silently vacuous release gate.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EXPECTED_LICENSE_ID,
  LICENSE_TEXT_MARKERS,
  REQUIRED_PACK_FILES,
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

const LICENSE_STUB = `${LICENSE_TEXT_MARKERS.join("\n")}\n`;

/**
 * A canned green pack shape for fixture runs, so the rules under test fail for
 * their own reasons rather than because a fixture tree cannot be npm-packed.
 * The pack-shape rule itself is falsified below with shapes that omit each
 * required file, and proven against the real npm report by the repository test.
 */
const STUB_PACK = (): readonly string[] => ["package.json", "LICENSE", "NOTICE", "src/index.ts"];

/** The scope fixture packages live under, so their sibling edges are recognised. */
const FIXTURE_SCOPE = "@fixture";

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
    /**
     * `false` omits the field entirely; a string writes the shorthand form; the
     * default writes the object form every real manifest in this workspace uses.
     */
    readonly repository?: string | false;
    readonly dependencies?: Readonly<Record<string, string>>;
    /** Body of the package's published `src/index.ts`. */
    readonly source?: string;
    /** Extra files written under the package dir, e.g. a test the tarball excludes. */
    readonly extraFiles?: Readonly<Record<string, string>>;
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
    writeFileSync(path.join(dir, "LICENSE"), options.license ?? LICENSE_STUB, "utf8");
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
    if (pkg.repository !== false) {
      manifest["repository"] =
        pkg.repository ?? { type: "git", url: "git+https://example.invalid/fixture.git", directory: `packages/${pkg.name.replace(/^@[^/]+\//u, "")}` };
    }
    if (pkg.dependencies !== undefined) manifest["dependencies"] = pkg.dependencies;
    writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // The published source the dependency-closure rule parses. STUB_PACK reports
    // `src/index.ts`, so it has to actually exist: the rule reads the packed
    // files off disk rather than trusting the manifest's `files` globs.
    mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    writeFileSync(path.join(pkgDir, "src", "index.ts"), pkg.source ?? `export const PACKAGE_NAME = ${JSON.stringify(pkg.name)};\n`, "utf8");

    for (const [relPath, contents] of Object.entries(pkg.extraFiles ?? {})) {
      const abs = path.join(pkgDir, relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, contents, "utf8");
    }
  }
  return dir;
}

/** Every fixture run shares the injected version, pack shape, and fixture scope. */
function runFixture(dir: string, packFiles: (packageDir: string) => readonly string[] = STUB_PACK): ReturnType<typeof runReleaseChecks> {
  return runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles, packageScope: FIXTURE_SCOPE });
}

function rulesOf(findings: readonly ReleaseFinding[]): string[] {
  return findings.map((finding) => finding.rule);
}

/** The five packages this workspace ships, asserted by the first row below. */
const SHIPPED_PACKAGE_MANIFESTS = [
  "packages/action/package.json",
  "packages/cli/package.json",
  "packages/conformance/package.json",
  "packages/kernel/package.json",
  "packages/mcp/package.json",
];

describe("this repository is releasable", () => {
  it("passes every release check", () => {
    const result = runReleaseChecks({ root: repoRootFromHere() });
    expect(formatReleaseFindings(result.findings)).toBe("");
    expect(result.findings).toEqual([]);
    expect(result.packageManifests).toEqual(SHIPPED_PACKAGE_MANIFESTS);
  });

  // The sensor's text half reads the ROOT LICENSE, while npm packs each
  // package's OWN copy — so five of the six license files this workspace
  // ships are checked for presence and never for content. Six copies nothing
  // compares are five that can drift, and a tarball carrying the superseded
  // license under an FSL manifest is the exact statement the rule exists to
  // refuse. This row is what makes leaving one copy behind a red run.
  it("ships one license text and one notice, not six copies that can drift", () => {
    const root = repoRootFromHere();
    for (const required of REQUIRED_PACK_FILES) {
      const rootText = readFileSync(path.join(root, required), "utf8");
      expect(rootText).not.toBe("");
      for (const manifestRel of SHIPPED_PACKAGE_MANIFESTS) {
        const packageDir = path.dirname(manifestRel);
        expect({ file: `${packageDir}/${required}`, text: readFileSync(path.join(root, packageDir, required), "utf8") })
          .toEqual({ file: `${packageDir}/${required}`, text: rootText });
      }
    }
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

  it("flags a LICENSE that names the license but is not its text", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID, license: "Functional Source License, Version 1.1\n" });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["license-coherence", "license-coherence"]);
  });

  it("flags a manifest left behind at the superseded Apache-2.0 id", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a", license: "Apache-2.0" }, { name: "@fixture/b" }],
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

describe("dependency-closure", () => {
  const importsB = `import { thing } from "@fixture/b";\nexport const PACKAGE_NAME = "@fixture/a";\nexport { thing };\n`;

  it("flags a sibling the published source imports but the manifest does not declare", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a", source: importsB }, { name: "@fixture/b" }],
    });
    const result = runFixture(dir);
    expect(rulesOf(result.findings)).toEqual(["dependency-undeclared"]);
    expect(result.findings[0]!.file).toBe("packages/a/package.json");
    expect(result.findings[0]!.message).toContain("@fixture/b");
    expect(result.findings[0]!.message).toContain("ERR_MODULE_NOT_FOUND");
  });

  it("flags a declaration pinned to anything but the sibling's own version", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [
        { name: "@fixture/a", source: importsB, dependencies: { "@fixture/b": "^1.2.3" } },
        { name: "@fixture/b" },
      ],
    });
    const result = runFixture(dir);
    expect(rulesOf(result.findings)).toEqual(["dependency-version-drift"]);
    expect(result.findings[0]!.message).toContain('"^1.2.3"');
    expect(result.findings[0]!.message).toContain('"1.2.3"');
  });

  it("flags a declared sibling no published file imports", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a", dependencies: { "@fixture/b": "1.2.3" } }, { name: "@fixture/b" }],
    });
    const result = runFixture(dir);
    expect(rulesOf(result.findings)).toEqual(["dependency-unused"]);
    expect(result.findings[0]!.file).toBe("packages/a/package.json");
  });

  it("accepts an exact pin at the lockstep version", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [
        { name: "@fixture/a", source: importsB, dependencies: { "@fixture/b": "1.2.3" } },
        { name: "@fixture/b" },
      ],
    });
    expect(runFixture(dir).findings).toEqual([]);
  });

  it("counts a type-only import: these packages publish source, so a consumer's tsc must resolve it", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [
        { name: "@fixture/a", source: `import type { Thing } from "@fixture/b";\nexport type Alias = Thing;\n` },
        { name: "@fixture/b" },
      ],
    });
    expect(rulesOf(runFixture(dir).findings)).toEqual(["dependency-undeclared"]);
  });

  it("does not count a package naming itself in a string constant", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      // The self-naming constant every package in this workspace carries, plus a
      // comment mentioning a sibling. Neither is an import.
      packages: [
        {
          name: "@fixture/a",
          source: `// See @fixture/b for the counterpart.\nexport const PACKAGE_NAME = "@fixture/a";\nexport const OTHER = "@fixture/b";\n`,
        },
        { name: "@fixture/b" },
      ],
    });
    expect(runFixture(dir).findings).toEqual([]);
  });

  it("does not count an import from a file the tarball excludes", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [
        { name: "@fixture/a", extraFiles: { "src/a.test.ts": `import { thing } from "@fixture/b";\nconsole.log(thing);\n` } },
        { name: "@fixture/b" },
      ],
    });
    // STUB_PACK reports no test file, mirroring `!src/**/*.test.ts` in `files`.
    expect(runFixture(dir).findings).toEqual([]);
  });

  it("a tarball carrying no source is a finding, not a vacuous pass", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID, packages: [{ name: "@fixture/a" }] });
    const result = runFixture(dir, () => ["package.json", "LICENSE", "NOTICE"]);
    expect(rulesOf(result.findings)).toEqual(["anti-vacuity"]);
    expect(result.findings[0]!.file).toBe("packages/a/package.json");
  });

  it("a packed file that cannot be read is a finding, not a skip", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID, packages: [{ name: "@fixture/a" }] });
    const result = runFixture(dir, () => ["package.json", "LICENSE", "NOTICE", "src/vanished.ts"]);
    expect(rulesOf(result.findings)).toEqual(["anti-vacuity"]);
    expect(result.findings[0]!.file).toBe("packages/a/src/vanished.ts");
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

describe("provenance-repository", () => {
  it("flags a publishable package that declares no repository: --provenance would refuse it", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a", repository: false }, { name: "@fixture/b" }],
    });
    const result = runFixture(dir);
    expect(rulesOf(result.findings)).toEqual(["provenance-repository"]);
    expect(result.findings[0]!.file).toBe("packages/a/package.json");
  });

  it("flags a repository whose url is present but empty", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a", repository: "   " }, { name: "@fixture/b" }],
    });
    const result = runFixture(dir);
    expect(rulesOf(result.findings)).toEqual(["provenance-repository"]);
    expect(result.findings[0]!.file).toBe("packages/a/package.json");
  });

  // The allow side, pinned in both accepted shapes: a rule that fired on
  // everything would satisfy the two falsifications above for free.
  it("accepts the shorthand string form as well as the object form", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a", repository: "git+https://example.invalid/fixture.git" }, { name: "@fixture/b" }],
    });
    expect(runFixture(dir).findings).toEqual([]);
  });

  // A private package is never published, so it is never published with
  // provenance; only `publishability` speaks for it.
  it("says nothing about a private package, which publishability already owns", () => {
    const dir = makeFixture({
      rootLicense: EXPECTED_LICENSE_ID,
      packages: [{ name: "@fixture/a", isPrivate: true, repository: false }, { name: "@fixture/b" }],
    });
    const result = runFixture(dir);
    expect(rulesOf(result.findings)).toEqual(["publishability"]);
  });
});

describe("anti-vacuity", () => {
  it("an empty package set is a finding, not a vacuous pass", () => {
    const dir = makeFixture({ rootLicense: EXPECTED_LICENSE_ID, packages: [] });
    const result = runReleaseChecks({ root: dir, harnessVersion: "1.2.3", packFiles: STUB_PACK });
    expect(rulesOf(result.findings)).toEqual(["anti-vacuity"]);
  });
});
