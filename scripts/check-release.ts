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
 *   license-coherence — the `LICENSE` file exists at the root, is the Apache
 *       License 2.0, and every manifest's `license` field (root and packages)
 *       says `Apache-2.0`. A tarball whose manifest disagrees with the license
 *       text it ships under is a legal statement nobody made. And the PACK
 *       SHAPE is checked, not assumed: what `npm pack --dry-run --json`
 *       reports for each package must include `LICENSE` and `NOTICE`, because
 *       npm auto-includes a license only from the PACKAGE directory — a root
 *       LICENSE alone produces five license-less tarballs while every static
 *       check reports clean, which is exactly the gap this rule closes.
 *   publishability — no workspace package is marked `private` (npm refuses to
 *       pack one, so the dry-run leg could never go green), while the root
 *       manifest MUST stay private: it is the workspace shell, and a root that
 *       lost the flag is one `npm publish` away from shipping the whole
 *       repository as a package nobody declared.
 *
 * Anti-vacuity: a workspace that yields zero packages passes every per-package
 * check vacuously, so an empty package set is itself a finding.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HARNESS_VERSION } from "@delivery-harness/kernel";

// ── Registry ─────────────────────────────────────────────────────────────────

export type ReleaseRule =
  | "version-consistency"
  | "harness-version-lockstep"
  | "license-coherence"
  | "publishability"
  | "manifest-unreadable"
  | "anti-vacuity";

export interface ReleaseFinding {
  readonly rule: ReleaseRule;
  /** Repo-relative POSIX path, or a rule id for structural findings. */
  readonly file: string;
  readonly message: string;
}

/** The license this repository is released under. */
export const EXPECTED_LICENSE_ID = "Apache-2.0";

/**
 * Phrases the LICENSE file must carry to be the verbatim Apache License 2.0
 * text rather than a stub that merely names it.
 */
export const LICENSE_TEXT_MARKERS: readonly string[] = [
  "Apache License",
  "Version 2.0, January 2004",
  "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
];

/**
 * Files every published tarball must carry. Apache-2.0 §4 requires
 * redistributions to carry the license, and NOTICE rides with it (§4(d)).
 */
export const REQUIRED_PACK_FILES: readonly string[] = ["LICENSE", "NOTICE"];

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
  return {
    path: relativePath,
    name: typeof record["name"] === "string" ? (record["name"] as string) : relativePath,
    version: typeof record["version"] === "string" ? (record["version"] as string) : undefined,
    license: typeof record["license"] === "string" ? (record["license"] as string) : undefined,
    isPrivate: record["private"] === true,
  };
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
          message: `LICENSE does not carry the Apache License 2.0 marker ${JSON.stringify(marker)}`,
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
  const packFiles = input.packFiles ?? npmPackFiles;
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

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main();
