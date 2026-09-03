/**
 * Release-mechanics sensor.
 *
 * The release workflow's static half: everything about publishability that can
 * be decided from the tree alone, before `npm publish --dry-run` (which the
 * workflow runs per package) touches a tarball. Four independently falsifiable
 * rules:
 *
 *   version-consistency — one version across the root manifest and every
 *       workspace package. A release is cut for the workspace as a whole; two
 *       packages disagreeing on what version that is means one of them is about
 *       to publish something it is not.
 *   harness-version-lockstep — the kernel's `HARNESS_VERSION` fingerprint
 *       constant equals the manifest version. The constant is a preparation-
 *       receipt fingerprint input: publishing a version whose fingerprint still
 *       names the previous one would let a receipt survive the upgrade that is
 *       supposed to invalidate it. `packages/kernel/src/preparation.ts` states
 *       the lockstep rule; this check is what makes forgetting it a red run.
 *   license-coherence — the `LICENSE` file exists at the root, is the
 *       Functional Source License 1.1, and every manifest's `license` field
 *       (root and packages) says `FSL-1.1-ALv2`. A tarball whose
 *       manifest disagrees with the license
 *       text it ships under is a legal statement nobody made. And the PACK
 *       SHAPE is checked, not assumed: what `npm pack --dry-run --json`
 *       reports for each package must include `LICENSE` and `NOTICE`, because
 *       npm auto-includes a license only from the PACKAGE directory — a root
 *       LICENSE alone produces five license-less tarballs while every static
 *       check reports clean, which is exactly the gap this rule closes.
 *   dependency-closure — every sibling package a package's PUBLISHED files
 *       import is declared in that package's `dependencies`, pinned to the
 *       lockstep version. Inside the workspace npm symlinks the siblings, so an
 *       undeclared edge resolves for the typecheck, the unit suite, the docs
 *       walkthrough, and `npm publish --dry-run` alike — dry-run verifies that a
 *       tarball can be BUILT, never that it can be INSTALLED. Published, the
 *       same edge is `ERR_MODULE_NOT_FOUND` on the consumer's first line. The
 *       import set is read from the PACK SHAPE, for the same reason the license
 *       rule is: test files are excluded from the tarballs, so a test-only
 *       import is not a runtime dependency and must not be declared as one.
 *       Three distinct findings — `dependency-undeclared` (imported, not
 *       declared), `dependency-version-drift` (declared at a version that is not
 *       the sibling's own), `dependency-unused` (declared, never imported from
 *       the published files).
 *   publishability — no workspace package is marked `private` (npm refuses to
 *       pack one, so the dry-run leg could never go green), while the root
 *       manifest MUST stay private: it is the workspace shell, and a root that
 *       lost the flag is one `npm publish` away from shipping the whole
 *       repository as a package nobody declared.
 *   provenance-repository — every publishable package declares a `repository`
 *       with a non-empty `url`. npm REFUSES `--provenance` for a package whose
 *       manifest names no repository, and `.github/workflows/publish.yml`
 *       publishes all five with that flag, one step at a time in dependency
 *       order. So a dropped `repository` field is not a documentation lapse: it
 *       is a release that publishes the packages before it and then stops,
 *       stranding the rest at a version npm will never accept again. Nothing
 *       else in the tree reads the field, which is exactly why it needs a rule.
 *
 * Anti-vacuity: a workspace that yields zero packages passes every per-package
 * check vacuously, so an empty package set is itself a finding.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { HARNESS_VERSION } from "@agent-delivery-harness/kernel";

// ── Registry ─────────────────────────────────────────────────────────────────

export type ReleaseRule =
  | "version-consistency"
  | "harness-version-lockstep"
  | "license-coherence"
  | "dependency-undeclared"
  | "dependency-version-drift"
  | "dependency-unused"
  | "publishability"
  | "provenance-repository"
  | "manifest-unreadable"
  | "anti-vacuity";

export interface ReleaseFinding {
  readonly rule: ReleaseRule;
  /** Repo-relative POSIX path, or a rule id for structural findings. */
  readonly file: string;
  readonly message: string;
}

/** The license this repository is released under. */
export const EXPECTED_LICENSE_ID = "FSL-1.1-ALv2";

/**
 * Phrases the LICENSE file must carry to be the verbatim Functional Source
 * License 1.1 text rather than a stub that merely names it. The first names
 * the license, the other two are the two clauses that make it what it is —
 * the competing-use restriction and the Apache-2.0 conversion — so a LICENSE
 * that keeps the title while losing either one is a finding rather than a pass.
 *
 * The conversion marker quotes the grant itself rather than its `Grant of
 * Future License` heading, which the steward's MIT-future template carries
 * word for word: a heading pins the section, not what the section converts to,
 * and `FSL-1.1-MIT` swapped in under an `FSL-1.1-ALv2` manifest is
 * exactly the mismatch this rule exists to refuse.
 */
export const LICENSE_TEXT_MARKERS: readonly string[] = [
  "Functional Source License, Version 1.1",
  "A Permitted Purpose is any purpose other than a Competing Use",
  "the Apache License, Version 2.0 that is effective on the second anniversary",
];

/**
 * Files every published tarball must carry. The FSL's Redistribution clause
 * requires copies to carry these Terms and Conditions and to leave the
 * copyright notices in place, so LICENSE and NOTICE ride with every tarball.
 */
export const REQUIRED_PACK_FILES: readonly string[] = ["LICENSE", "NOTICE"];

/** The npm scope every workspace package publishes under. */
export const PACKAGE_SCOPE = "@agent-delivery-harness";

export interface ReleaseCheckInput {
  /** Absolute path to the repository root. */
  readonly root: string;
  /**
   * The kernel's fingerprint constant. Injected so fixture trees can pin their
   * own; defaults to the real one.
   */
  readonly harnessVersion?: string;
  /**
   * Reports the file list npm would pack for the package at `packageDir`.
   * Injected so fixture trees can be checked without spawning npm; defaults to
   * the real `npm pack --dry-run --json`.
   */
  readonly packFiles?: (packageDir: string) => readonly string[];
  /**
   * The npm scope whose packages count as siblings for the dependency-closure
   * rule. Injected so fixture trees can use a scope of their own; defaults to
   * this workspace's.
   */
  readonly packageScope?: string;
}

/** The real pack shape, straight from npm — never inferred from `files` globs. */
export function npmPackFiles(packageDir: string): readonly string[] {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageDir, encoding: "utf8" });
  const parsed = JSON.parse(stdout) as readonly { readonly files: readonly { readonly path: string }[] }[];
  return (parsed[0]?.files ?? []).map((file) => file.path);
}

export interface ReleaseCheckResult {
  readonly findings: readonly ReleaseFinding[];
  /** Repo-relative paths of the workspace package manifests checked. */
  readonly packageManifests: readonly string[];
}

// ── The checks ───────────────────────────────────────────────────────────────

interface Manifest {
  readonly path: string;
  readonly name: string;
  readonly version: string | undefined;
  readonly license: string | undefined;
  readonly isPrivate: boolean;
  /** Declared runtime dependencies, as written. */
  readonly dependencies: Readonly<Record<string, string>>;
  /**
   * `repository.url`, or the shorthand string form, when the manifest declares
   * one that is a non-empty string. Absent for every other shape.
   */
  readonly repositoryUrl: string | undefined;
}

function readManifest(root: string, relativePath: string, findings: ReleaseFinding[]): Manifest | undefined {
  const absolute = path.join(root, relativePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    findings.push({
      rule: "manifest-unreadable",
      file: relativePath,
      message: `cannot read or parse: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    findings.push({ rule: "manifest-unreadable", file: relativePath, message: "manifest is not a JSON object" });
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const rawDependencies = record["dependencies"];
  const dependencies: Record<string, string> = {};
  if (typeof rawDependencies === "object" && rawDependencies !== null) {
    for (const [name, range] of Object.entries(rawDependencies as Record<string, unknown>)) {
      if (typeof range === "string") dependencies[name] = range;
    }
  }
  const rawRepository = record["repository"];
  const repositoryUrl =
    typeof rawRepository === "string"
      ? rawRepository
      : typeof rawRepository === "object" && rawRepository !== null &&
          typeof (rawRepository as Record<string, unknown>)["url"] === "string"
        ? ((rawRepository as Record<string, unknown>)["url"] as string)
        : undefined;
  return {
    path: relativePath,
    name: typeof record["name"] === "string" ? (record["name"] as string) : relativePath,
    version: typeof record["version"] === "string" ? (record["version"] as string) : undefined,
    license: typeof record["license"] === "string" ? (record["license"] as string) : undefined,
    isPrivate: record["private"] === true,
    dependencies,
    repositoryUrl: repositoryUrl !== undefined && repositoryUrl.trim() !== "" ? repositoryUrl : undefined,
  };
}

// ── dependency-closure ───────────────────────────────────────────────────────

/**
 * Sibling package names imported by `source`, parsed with the TypeScript
 * compiler API rather than matched out of the text — a scope name in a comment
 * or in a `PACKAGE_NAME` string constant is not an import, and every package in
 * this workspace contains exactly such a constant naming itself.
 *
 * TYPE-ONLY IMPORTS COUNT, deliberately. These packages publish TypeScript
 * source (`exports` points at `./src/index.ts`), so a consumer's own `tsc` has
 * to resolve every specifier the shipped source names — a `import type { … }
 * from "@agent-delivery-harness/kernel"` that npm never installed is a hard
 * build failure for that consumer, not a lint. `dependencies` is where a
 * package states what must be present for it to be usable, and under
 * source-publishing that includes the type edges. (Today every sibling edge in
 * this workspace is a mixed value+type import, so the distinction changes no
 * finding; the rule is written this way so a future type-only edge stays
 * declared rather than silently dropping out.)
 */
export function siblingImportsOf(source: string, fileName: string, scope: string = PACKAGE_SCOPE): readonly string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS);
  const found = new Set<string>();

  const record = (specifier: string): void => {
    if (!specifier.startsWith(`${scope}/`)) return;
    // A subpath import (`@scope/pkg/sub`) still depends on `@scope/pkg`.
    const segments = specifier.split("/");
    const scopeSegment = segments[0];
    const nameSegment = segments[1];
    if (scopeSegment === undefined || nameSegment === undefined) return;
    found.add(`${scopeSegment}/${nameSegment}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const ref = node.moduleReference.expression;
      if (ts.isStringLiteral(ref)) record(ref.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const first = node.arguments[0];
      if ((isDynamicImport || isRequire) && first !== undefined && ts.isStringLiteralLike(first)) record(first.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  return [...found].sort();
}

function checkDependencyClosure(
  root: string,
  manifestRel: string,
  manifest: Manifest,
  packed: readonly string[],
  versionOf: ReadonlyMap<string, string | undefined>,
  scope: string,
  findings: ReleaseFinding[],
): void {
  const packageDir = path.join(root, path.dirname(manifestRel));

  const sources = packed.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
  if (sources.length === 0) {
    findings.push({
      rule: "anti-vacuity",
      file: manifestRel,
      message: "the packed tarball carries no TypeScript source, so the dependency-closure rule would pass over it vacuously",
    });
    return;
  }

  const imported = new Map<string, string>();
  for (const relFile of sources) {
    const absolute = path.join(packageDir, relFile);
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch (error) {
      findings.push({
        rule: "anti-vacuity",
        file: `${path.dirname(manifestRel)}/${relFile}`,
        message: `npm would pack this file but it could not be read, so its imports went unchecked: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const sibling of siblingImportsOf(text, absolute, scope)) {
      if (sibling === manifest.name) continue; // a package is not its own dependency
      if (!imported.has(sibling)) imported.set(sibling, relFile);
    }
  }

  for (const [sibling, whereFirstSeen] of [...imported].sort()) {
    const declared = manifest.dependencies[sibling];
    const expected = versionOf.get(sibling);
    if (declared === undefined) {
      findings.push({
        rule: "dependency-undeclared",
        file: manifestRel,
        message: `published file ${whereFirstSeen} imports ${sibling}, which is not in \`dependencies\`; inside the workspace npm symlinks it, but \`npm install ${manifest.name}\` would fetch this tarball alone and the import would throw ERR_MODULE_NOT_FOUND${expected === undefined ? "" : ` — declare it as ${JSON.stringify(expected)}`}`,
      });
      continue;
    }
    if (expected !== undefined && declared !== expected) {
      findings.push({
        rule: "dependency-version-drift",
        file: manifestRel,
        message: `declares ${sibling} at ${JSON.stringify(declared)} but that package is at ${JSON.stringify(expected)}; the workspace releases in lockstep, so the pin must be the exact sibling version`,
      });
    }
  }

  for (const declared of Object.keys(manifest.dependencies).sort()) {
    if (!declared.startsWith(`${scope}/`)) continue;
    if (imported.has(declared)) continue;
    findings.push({
      rule: "dependency-unused",
      file: manifestRel,
      message: `declares ${declared} but no published file imports it; a dependency nobody needs is one every consumer installs for nothing, and it hides the edge that was really dropped`,
    });
  }
}

export function runReleaseChecks(input: ReleaseCheckInput): ReleaseCheckResult {
  const root = input.root;
  const harnessVersion = input.harnessVersion ?? HARNESS_VERSION;
  const findings: ReleaseFinding[] = [];

  const rootManifest = readManifest(root, "package.json", findings);

  const packagesDir = path.join(root, "packages");
  const packageManifests: string[] = [];
  if (existsSync(packagesDir) && statSync(packagesDir).isDirectory()) {
    for (const entry of readdirSync(packagesDir).sort()) {
      const manifestRel = path.posix.join("packages", entry, "package.json");
      if (existsSync(path.join(root, manifestRel))) packageManifests.push(manifestRel);
    }
  }
  if (packageManifests.length === 0) {
    findings.push({
      rule: "anti-vacuity",
      file: "packages",
      message: "no workspace package manifests found; every per-package check would pass vacuously",
    });
  }
  const packages = packageManifests
    .map((manifestRel) => readManifest(root, manifestRel, findings))
    .filter((manifest): manifest is Manifest => manifest !== undefined);

  // version-consistency + harness-version-lockstep
  if (rootManifest !== undefined) {
    const rootVersion = rootManifest.version;
    if (rootVersion === undefined) {
      findings.push({ rule: "version-consistency", file: rootManifest.path, message: "root manifest declares no version" });
    } else {
      for (const pkg of packages) {
        if (pkg.version !== rootVersion) {
          findings.push({
            rule: "version-consistency",
            file: pkg.path,
            message: `version ${JSON.stringify(pkg.version)} does not match the root's ${JSON.stringify(rootVersion)}`,
          });
        }
      }
      if (harnessVersion !== rootVersion) {
        findings.push({
          rule: "harness-version-lockstep",
          file: "packages/kernel/src/preparation.ts",
          message: `HARNESS_VERSION ${JSON.stringify(harnessVersion)} does not match the manifest version ${JSON.stringify(rootVersion)}; the release must bump both in lockstep`,
        });
      }
    }
  }

  // license-coherence
  const licensePath = path.join(root, "LICENSE");
  if (!existsSync(licensePath)) {
    findings.push({ rule: "license-coherence", file: "LICENSE", message: "LICENSE file is missing at the repository root" });
  } else {
    const text = readFileSync(licensePath, "utf8");
    for (const marker of LICENSE_TEXT_MARKERS) {
      if (!text.includes(marker)) {
        findings.push({
          rule: "license-coherence",
          file: "LICENSE",
          message: `LICENSE does not carry the ${EXPECTED_LICENSE_ID} marker ${JSON.stringify(marker)}`,
        });
      }
    }
  }
  for (const manifest of [rootManifest, ...packages]) {
    if (manifest === undefined) continue;
    if (manifest.license !== EXPECTED_LICENSE_ID) {
      findings.push({
        rule: "license-coherence",
        file: manifest.path,
        message: `license field is ${JSON.stringify(manifest.license)}, not ${JSON.stringify(EXPECTED_LICENSE_ID)}`,
      });
    }
  }

  // license-coherence, pack-shape half: the tarball npm would actually build
  // must carry the license it is distributed under. npm auto-includes a
  // LICENSE/NOTICE only from the package's own directory, so this is checked
  // against the reported pack shape, never assumed from the root.
  //
  // The same pack shape answers the dependency-closure rule below: what a
  // package SHIPS is what its declarations have to cover, and `files` excludes
  // the tests — so a sibling imported only from a `*.test.ts` is correctly not a
  // runtime dependency.
  const packFiles = input.packFiles ?? npmPackFiles;
  const versionOf = new Map<string, string | undefined>(packages.map((pkg) => [pkg.name, pkg.version]));
  const packagesByPath = new Map(packages.map((pkg) => [pkg.path, pkg]));
  for (const manifestRel of packageManifests) {
    const packageDir = path.join(root, path.dirname(manifestRel));
    let packed: readonly string[];
    try {
      packed = packFiles(packageDir);
    } catch (error) {
      findings.push({
        rule: "license-coherence",
        file: manifestRel,
        message: `could not determine the pack shape: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const required of REQUIRED_PACK_FILES) {
      if (!packed.includes(required)) {
        findings.push({
          rule: "license-coherence",
          file: manifestRel,
          message: `the packed tarball would not carry ${required}; the published artifact must ship the license it is distributed under`,
        });
      }
    }

    const manifest = packagesByPath.get(manifestRel);
    if (manifest !== undefined) {
      checkDependencyClosure(root, manifestRel, manifest, packed, versionOf, input.packageScope ?? PACKAGE_SCOPE, findings);
    }
  }

  // publishability
  if (rootManifest !== undefined && !rootManifest.isPrivate) {
    findings.push({
      rule: "publishability",
      file: rootManifest.path,
      message: "the root manifest must stay private: it is the workspace shell, not a publishable package",
    });
  }
  for (const pkg of packages) {
    if (pkg.isPrivate) {
      findings.push({
        rule: "publishability",
        file: pkg.path,
        message: `${pkg.name} is marked private; npm cannot pack it, so the publish dry-run can never go green`,
      });
    }
  }

  // provenance-repository
  for (const pkg of packages) {
    // A private package is never published, so it is never published with
    // provenance either; `publishability` above is the rule that owns it.
    if (pkg.isPrivate) continue;
    if (pkg.repositoryUrl === undefined) {
      findings.push({
        rule: "provenance-repository",
        file: pkg.path,
        message: `${pkg.name} declares no \`repository\` with a non-empty \`url\`; \`npm publish --provenance\` refuses such a package, and the publish workflow runs one package per step, so the packages before it in dependency order would already be on the registry at a version that can never be republished`,
      });
    }
  }

  return { findings, packageManifests };
}

export function formatReleaseFindings(findings: readonly ReleaseFinding[]): string {
  return findings.map((finding) => `  ${finding.rule}  ${finding.file}\n      ${finding.message}`).join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function main(): void {
  const result = runReleaseChecks({ root: repoRootFromHere() });
  if (result.findings.length === 0) {
    process.stdout.write(`check-release: clean (${result.packageManifests.length} packages)\n`);
    return;
  }
  process.stderr.write(`check-release: ${result.findings.length} finding(s) (${result.packageManifests.length} packages)\n`);
  process.stderr.write(`${formatReleaseFindings(result.findings)}\n`);
  process.exitCode = 1;
}

/** The spelling the filesystem can vouch for: the realpath where it can answer, the spelling itself where it cannot. */
function canonicalEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

// argv and `import.meta.url` may spell this file differently: argv carries the
// caller's spelling while Node builds the module URL from the realpath (or,
// under `--preserve-symlinks-main`, from the caller's spelling). A sensor that
// under-matches here no-ops and exits 0 — a green sensor run that scanned
// nothing — so each side is canonicalized independently and compared as paths.
const invokedDirectly =
  process.argv[1] !== undefined &&
  canonicalEntryPath(path.resolve(process.argv[1])) === canonicalEntryPath(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
