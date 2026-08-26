/**
 * Standalone-install smoke sensor.
 *
 * THE PATH PUBLISHING CREATES, AND NOTHING ELSE EXERCISES. Every other check in
 * this repository runs inside the workspace, where npm has symlinked
 * `node_modules/@agent-delivery-harness/*` at the workspace root: the typecheck,
 * the unit suite, the docs walkthrough (which wires the same link by hand, see
 * `docs/getting-started.md` §0), and `npm publish --dry-run` — which verifies
 * that a tarball can be BUILT, never that it can be INSTALLED. A package whose
 * shipped source imports a sibling it does not declare resolves fine under all
 * of them and throws `ERR_MODULE_NOT_FOUND` on the first line a consumer runs.
 *
 * So this sensor leaves the workspace. It packs every workspace package with
 * `npm pack`, installs each tarball ALONE into its own temp directory outside
 * the repository — no workspace root above it, no symlinks, no hoisting from a
 * sibling's install — and then proves the installed thing works: every sibling
 * the manifest declares is physically present in that tree, the package's entry
 * point imports, and for the CLI a real command runs end to end.
 *
 * Installing each package alone is the whole point. A single temp directory
 * carrying all five would hoist the kernel to its root and every sibling would
 * resolve through it, which is the workspace's masking property rebuilt one
 * directory over.
 *
 * NO REGISTRY. Nothing here is published yet, so a declared
 * `"@agent-delivery-harness/kernel": "0.1.0"` has nothing to resolve against.
 * Each install directory therefore pins all five names to the local tarballs
 * through `overrides`, and npm runs with `--offline`. An override rewrites the
 * resolution of a dependency that is actually declared; it never adds one. That
 * is what keeps the check honest: an undeclared sibling stays absent no matter
 * how many overrides name it.
 *
 * WHY THIS IS NOT IN THE DEFAULT SUITE. Five `npm pack` runs and five `npm
 * install` runs are seconds each, not milliseconds, so this is wired where the
 * release checks run (`.github/workflows/release.yml`, `npm run sensor:standalone`)
 * rather than into `npm run check`. The static half of the same rule — that the
 * declarations exist at all — is `dependency-closure` in `scripts/check-release.ts`,
 * which is pure and does run in the default suite. This sensor is what keeps
 * that one honest: layer (a) is only as good as its import parser, and this
 * layer asks Node.
 *
 * ANTI-VACUITY. A run that verified no sibling edge at all proves nothing about
 * the property this sensor exists for, so it is itself a finding — as is an
 * empty package set, or a missing TypeScript loader.
 */
import { execFileSync, type StdioOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Registry ─────────────────────────────────────────────────────────────────

export type StandaloneRule =
  | "pack-failed"
  | "install-failed"
  | "sibling-missing"
  | "entry-import-failed"
  | "cli-command-failed"
  | "anti-vacuity";

export interface StandaloneFinding {
  readonly rule: StandaloneRule;
  /** The package the finding belongs to, or a rule id for structural findings. */
  readonly subject: string;
  readonly message: string;
}

/** The scope every workspace package lives under. */
export const PACKAGE_SCOPE = "@agent-delivery-harness";

/**
 * The command the CLI tarball must actually run once installed standalone, and
 * the substrings its output must carry. `--help` walks the whole command
 * registry, which is what imports every command module and therefore every
 * kernel edge the CLI has — an import probe alone would only reach the barrel.
 */
export const CLI_SMOKE_ARGS: readonly string[] = ["--help"];
export const CLI_SMOKE_EXPECTED: readonly string[] = ["prepare", "gate", "record", "verify"];

/** Timeout for any single npm or node invocation this sensor spawns. */
export const STEP_TIMEOUT_MS = 300_000;

/**
 * Every spawned child is fully captured, stderr included. Node's default routes
 * a child's stderr straight to this process's, which would print a raw
 * `ERR_MODULE_NOT_FOUND` stack ahead of the finding that explains it — the
 * sensor's report has to be the report.
 */
const CAPTURED: StdioOptions = ["ignore", "pipe", "pipe"];

export interface StandaloneCheckInput {
  /** Absolute path to the repository root. */
  readonly root: string;
  /**
   * Where the temp install trees are created. Defaults to the OS temp dir,
   * which is what puts them outside the workspace.
   */
  readonly workRoot?: string;
  /** Leave the temp trees in place for inspection. */
  readonly keepWorkDir?: boolean;
  readonly log?: (line: string) => void;
}

export interface StandaloneCheckResult {
  readonly findings: readonly StandaloneFinding[];
  /** Package names installed and probed, in order. */
  readonly packagesProbed: readonly string[];
  /** How many `package -> sibling` edges were proven present in a standalone tree. */
  readonly siblingEdgesVerified: number;
}

// ── Workspace inspection ─────────────────────────────────────────────────────

export interface WorkspacePackage {
  /** Repo-relative POSIX directory, e.g. `packages/cli`. */
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  /** Sibling package names declared in `dependencies`. */
  readonly siblingDependencies: readonly string[];
}

export function readWorkspacePackages(root: string): readonly WorkspacePackage[] {
  const packagesDir = path.join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  const out: WorkspacePackage[] = [];
  for (const entry of readdirSync(packagesDir).sort()) {
    const manifestPath = path.join(packagesDir, entry, "package.json");
    if (!existsSync(manifestPath)) continue;
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const dependencies = parsed["dependencies"];
    const siblings =
      typeof dependencies === "object" && dependencies !== null
        ? Object.keys(dependencies as Record<string, unknown>)
            .filter((name) => name.startsWith(`${PACKAGE_SCOPE}/`))
            .sort()
        : [];
    out.push({
      dir: `packages/${entry}`,
      name: String(parsed["name"]),
      version: String(parsed["version"]),
      siblingDependencies: siblings,
    });
  }
  return out;
}

// ── The check ────────────────────────────────────────────────────────────────

export function runStandaloneInstallCheck(input: StandaloneCheckInput): StandaloneCheckResult {
  const root = input.root;
  const log = input.log ?? ((): void => {});
  const findings: StandaloneFinding[] = [];
  const packagesProbed: string[] = [];
  let siblingEdgesVerified = 0;

  const packages = readWorkspacePackages(root);
  if (packages.length === 0) {
    findings.push({
      rule: "anti-vacuity",
      subject: "packages",
      message: "no workspace packages found; every per-package probe would pass vacuously",
    });
    return { findings, packagesProbed, siblingEdgesVerified };
  }

  const loader = path.join(root, "node_modules", "tsx", "dist", "loader.mjs");
  if (!existsSync(loader)) {
    findings.push({
      rule: "anti-vacuity",
      subject: "tsx",
      message: `the TypeScript loader is missing at ${loader}; the packages publish TypeScript sources, so without it no entry point can be imported and every probe would be skipped rather than run`,
    });
    return { findings, packagesProbed, siblingEdgesVerified };
  }

  const workRoot = input.workRoot ?? os.tmpdir();
  mkdirSync(workRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(workRoot, "dh-standalone-"));
  log(`work dir: ${scratch}`);

  try {
    // ── Pack ─────────────────────────────────────────────────────────────────
    const tarballDir = path.join(scratch, "tarballs");
    mkdirSync(tarballDir, { recursive: true });
    const tarballs = new Map<string, string>();
    for (const pkg of packages) {
      let stdout: string;
      try {
        stdout = execFileSync("npm", ["pack", "--json", "--pack-destination", tarballDir], {
          cwd: path.join(root, pkg.dir),
          encoding: "utf8",
          timeout: STEP_TIMEOUT_MS,
          stdio: CAPTURED,
        });
      } catch (error) {
        findings.push({ rule: "pack-failed", subject: pkg.name, message: describe(error) });
        continue;
      }
      const parsed = JSON.parse(stdout) as readonly { readonly filename: string }[];
      const filename = parsed[0]?.filename;
      if (filename === undefined) {
        findings.push({ rule: "pack-failed", subject: pkg.name, message: "npm pack reported no tarball filename" });
        continue;
      }
      tarballs.set(pkg.name, path.join(tarballDir, filename));
    }
    if (findings.length > 0) return { findings, packagesProbed, siblingEdgesVerified };

    /** Every package name pinned to its local tarball, so nothing reaches a registry. */
    const overrides: Record<string, string> = {};
    for (const [name, tarball] of tarballs) overrides[name] = `file:${tarball}`;

    // ── Install and probe, one isolated tree per package ─────────────────────
    for (const pkg of packages) {
      const tarball = tarballs.get(pkg.name);
      if (tarball === undefined) continue;

      const installDir = path.join(scratch, "install", pkg.name.replace(`${PACKAGE_SCOPE}/`, ""));
      mkdirSync(installDir, { recursive: true });
      writeFileSync(
        path.join(installDir, "package.json"),
        `${JSON.stringify(
          {
            name: "standalone-install-smoke",
            version: "0.0.0",
            private: true,
            type: "module",
            dependencies: { [pkg.name]: `file:${tarball}` },
            overrides,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      try {
        execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"], {
          cwd: installDir,
          encoding: "utf8",
          timeout: STEP_TIMEOUT_MS,
          stdio: CAPTURED,
        });
      } catch (error) {
        findings.push({ rule: "install-failed", subject: pkg.name, message: `${installDir}: ${describe(error)}` });
        continue;
      }
      packagesProbed.push(pkg.name);
      log(`installed ${pkg.name} into ${installDir}`);

      // Every declared sibling is physically there — no symlink, no workspace.
      for (const sibling of pkg.siblingDependencies) {
        const siblingDir = path.join(installDir, "node_modules", sibling);
        if (existsSync(path.join(siblingDir, "package.json"))) {
          siblingEdgesVerified += 1;
          continue;
        }
        findings.push({
          rule: "sibling-missing",
          subject: pkg.name,
          message: `declares a dependency on ${sibling} but a standalone install produced no ${path.relative(installDir, siblingDir)}`,
        });
      }

      // The entry point actually imports.
      const probe = path.join(installDir, "probe.mjs");
      writeFileSync(
        probe,
        `const mod = await import(${JSON.stringify(pkg.name)});\n` +
          `if (mod.PACKAGE_NAME !== ${JSON.stringify(pkg.name)}) {\n` +
          `  throw new Error("entry point resolved but reported PACKAGE_NAME " + String(mod.PACKAGE_NAME));\n` +
          `}\n` +
          `process.stdout.write("entry-ok " + mod.PACKAGE_NAME + "\\n");\n`,
        "utf8",
      );
      try {
        const stdout = execFileSync(process.execPath, ["--import", pathToFileURL(loader).href, probe], {
          cwd: installDir,
          encoding: "utf8",
          timeout: STEP_TIMEOUT_MS,
          stdio: CAPTURED,
        });
        log(stdout.trim());
      } catch (error) {
        findings.push({
          rule: "entry-import-failed",
          subject: pkg.name,
          message: `importing the published entry point from a standalone install failed: ${describe(error)}`,
        });
        continue;
      }

      // The CLI is an operator surface, so importing it is not enough: run one.
      if (pkg.name === `${PACKAGE_SCOPE}/cli`) {
        const entry = path.join(installDir, "node_modules", pkg.name, "src", "main.ts");
        let stdout: string;
        try {
          stdout = execFileSync(process.execPath, ["--import", pathToFileURL(loader).href, entry, ...CLI_SMOKE_ARGS], {
            cwd: installDir,
            encoding: "utf8",
            timeout: STEP_TIMEOUT_MS,
            stdio: CAPTURED,
          });
        } catch (error) {
          findings.push({
            rule: "cli-command-failed",
            subject: pkg.name,
            message: `\`${CLI_SMOKE_ARGS.join(" ")}\` failed from a standalone install: ${describe(error)}`,
          });
          continue;
        }
        const missing = CLI_SMOKE_EXPECTED.filter((needle) => !stdout.includes(needle));
        if (missing.length > 0) {
          findings.push({
            rule: "cli-command-failed",
            subject: pkg.name,
            message: `\`${CLI_SMOKE_ARGS.join(" ")}\` ran but its output named none of ${missing.join(", ")}; the command registry did not load`,
          });
        } else {
          log(`cli-ok ${CLI_SMOKE_ARGS.join(" ")}`);
        }
      }
    }

    // Anti-vacuity: a run that proved no sibling edge proves nothing at all.
    if (siblingEdgesVerified === 0) {
      findings.push({
        rule: "anti-vacuity",
        subject: "sibling-edges",
        message:
          "no package declared a sibling dependency, so nothing here exercised cross-package resolution outside the workspace — the property this sensor exists to prove was never tested",
      });
    }
  } finally {
    if (input.keepWorkDir !== true) rmSync(scratch, { recursive: true, force: true });
  }

  return { findings, packagesProbed, siblingEdgesVerified };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const withOutput = error as Error & { readonly stderr?: unknown; readonly stdout?: unknown };
    const stderr = typeof withOutput.stderr === "string" ? withOutput.stderr.trim() : "";
    const stdout = typeof withOutput.stdout === "string" ? withOutput.stdout.trim() : "";
    const tail = [stderr, stdout].filter((part) => part !== "").join("\n");
    return tail === "" ? error.message : `${error.message}\n${tail}`;
  }
  return String(error);
}

export function formatStandaloneFindings(findings: readonly StandaloneFinding[]): string {
  return findings.map((finding) => `  ${finding.rule}  ${finding.subject}\n      ${finding.message}`).join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function main(): void {
  const verbose = process.env["DELIVERY_HARNESS_VERBOSE"] === "1";
  const result = runStandaloneInstallCheck({
    root: repoRootFromHere(),
    log: verbose ? (line) => process.stdout.write(`  ${line}\n`) : undefined,
  });
  const summary = `${result.packagesProbed.length} package(s) installed standalone; ${result.siblingEdgesVerified} sibling edge(s) verified`;
  if (result.findings.length === 0) {
    process.stdout.write(`check-standalone-install: clean (${summary})\n`);
    return;
  }
  process.stderr.write(`check-standalone-install: ${result.findings.length} finding(s) (${summary})\n`);
  process.stderr.write(`${formatStandaloneFindings(result.findings)}\n`);
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
