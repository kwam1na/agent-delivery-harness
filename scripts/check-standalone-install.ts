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
 * point imports, and for the CLI four real commands run end to end — the
 * operator surface and the config-free run surface.
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
import { execFileSync, spawnSync, type StdioOptions } from "node:child_process";
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
  | "run-store-unexpected"
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
 * What the CLI tarball must actually DO once installed standalone: an ordered
 * list of cases, each an argument vector, the exit code the installed entry has
 * to return, and the substrings its output has to carry.
 *
 * The entry-point probe already REACHES every module carrying a kernel edge —
 * the barrel imports all eleven command modules and `boundary.ts` to build
 * `COMMANDS`, so resolution is covered before this step runs. What these cases
 * add is EXECUTION, on the two surfaces where "it imports" is the weakest claim
 * this sensor could make:
 *
 *   `--help` walks and renders the registry, so a package that resolves but
 *   cannot run is still a finding. The CLI is an operator surface.
 *
 *   `runs list`, `emit run.started`, and one `emit` of a kind the run-event
 *   vocabulary does not define exercise the RUN SURFACE: the config-free half
 *   of the CLI, dispatched before `harness.config.ts` is loaded, which is the
 *   only half a repository with no harness config can run at all. Between them
 *   they resolve the store from git, read an empty store, allocate a journal,
 *   write the worktree pointer, resolve that pointer back, and refuse an event
 *   with a diagnostic naming the kind. None of that is reachable from `--help`,
 *   and every step of it crosses the kernel edge the tarball declares.
 *
 * ORDER IS PART OF THE CASE. `runs list` asserts an EMPTY store, so it runs
 * before the case that allocates a journal; the refused `emit` resolves the
 * pointer the `run.started` case just wrote, so it runs after it.
 *
 * The three run-surface cases run from a `git init`-ed scratch worktree root,
 * never this repository: the store lives under the invoking repository's git
 * common directory, so a case that resolved here would write into the
 * developer's own store. `emit` carries its payload inline with `--json`
 * because this sensor spawns every child with stdin ignored, and that is what
 * `emit` reads when `--json` is absent.
 */
export interface CliSmokeCase {
  /** The argument vector, after the installed `src/main.ts`. */
  readonly args: readonly string[];
  /** The exit code the installed entry must return: 0 ok, 1 policy, 2 usage. */
  readonly exitCode: number;
  /** Substrings the case's combined stdout and stderr must carry. */
  readonly expected: readonly string[];
}

/**
 * A kind the run-event vocabulary does not define, spelled so the store's own
 * id reduction leaves it unchanged: the diagnostic and the durable note then
 * say the same thing, and the case can assert on either.
 */
const UNKNOWN_KIND = "sensor.unknown-kind";

export const CLI_SMOKE_CASES: readonly CliSmokeCase[] = [
  { args: ["--help"], exitCode: 0, expected: ["prepare", "gate", "record", "verify"] },
  { args: ["runs", "list"], exitCode: 0, expected: ["runs in ", "total 0 bytes across 0 run(s)"] },
  {
    args: [
      "emit",
      "run.started",
      "--json",
      JSON.stringify({
        host: "standalone-install-sensor",
        workflow: { releaseId: "standalone-install-sensor", profile: "sensor" },
      }),
    ],
    exitCode: 0,
    expected: ["started run run-"],
  },
  {
    args: ["emit", UNKNOWN_KIND, "--json", "{}"],
    exitCode: 1,
    expected: [`The run event was refused: ${UNKNOWN_KIND}`, "unknown_kind at /kind"],
  },
];

/**
 * Where the run surface writes, relative to the scratch repository's git
 * common directory, and what the cases above must leave there.
 *
 * A run store belongs to the REPOSITORY, not to the worktree, so these are the
 * one durable trace the cases leave — and the only place a silent regression
 * would show: `emit` could exit zero having written nothing, and the refused
 * case could exit one because the store was never reachable at all. One
 * `run.started` allocates exactly one journal; the refused append writes
 * exactly one bounded note line and no second journal.
 *
 * These two directories are all this sensor asserts over. The pointer
 * directory beside them is the store's own business.
 */
const SCRATCH_RUNS_DIR = ["managed-delivery", "runs"] as const;
export const EXPECTED_SCRATCH_JOURNALS = 1;
export const EXPECTED_SCRATCH_NOTE_LINES = 1;

export interface ScratchRunStore {
  /** Journals directly under `managed-delivery/runs/`. */
  readonly journals: number;
  /** Note lines across every file under `managed-delivery/runs/notes/`. */
  readonly noteLines: number;
}

/**
 * Reads the scratch repository's run store. Throws where either directory is
 * absent or unreadable, which is itself the finding: the cases claimed to write
 * there.
 */
export function readScratchRunStore(repoDir: string): ScratchRunStore {
  const runsDir = path.join(repoDir, ".git", ...SCRATCH_RUNS_DIR);
  const journals = readdirSync(runsDir).filter((entry) => entry.endsWith(".jsonl")).length;
  const notesDir = path.join(runsDir, "notes");
  const noteLines = readdirSync(notesDir)
    .flatMap((entry) => readFileSync(path.join(notesDir, entry), "utf8").split("\n"))
    .filter((line) => line.trim() !== "").length;
  return { journals, noteLines };
}

/**
 * A child environment with the whole `GIT_` namespace dropped. An inherited
 * `GIT_DIR` or `GIT_COMMON_DIR` would relocate both the scratch `git init` and
 * the store the run-surface cases resolve into whatever repository the
 * developer was standing in — the sensor would then write its journal and its
 * note into a real store and assert over someone else's. Dropped wholesale
 * rather than by curated list, for the same reason the product drops it that
 * way: missing one leaves a store that looks perfectly healthy and belongs to
 * the wrong repository.
 */
export function gitNamespaceCleared(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cleared: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("GIT_") || value === undefined) continue;
    cleared[name] = value;
  }
  return cleared;
}

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

      // The CLI is an operator surface, so importing it is not enough: run it.
      if (pkg.name === `${PACKAGE_SCOPE}/cli`) {
        const entry = path.join(installDir, "node_modules", pkg.name, "src", "main.ts");
        const childEnv = gitNamespaceCleared();

        // A repository of its own, because the run surface has to have one: the
        // store is the invoking repository's, and there is no repository above
        // a temp directory.
        const repoDir = path.join(scratch, "repo");
        mkdirSync(repoDir, { recursive: true });
        try {
          execFileSync("git", ["init", "--quiet"], {
            cwd: repoDir,
            env: childEnv,
            encoding: "utf8",
            timeout: STEP_TIMEOUT_MS,
            stdio: CAPTURED,
          });
        } catch (error) {
          findings.push({
            rule: "anti-vacuity",
            subject: "scratch-repository",
            message: `the scratch repository could not be initialized, so every run-surface case would resolve no store and report a blocker instead of exercising one: ${describe(error)}`,
          });
          continue;
        }

        for (const smoke of CLI_SMOKE_CASES) {
          const label = smoke.args.join(" ");
          const ran = spawnSync(process.execPath, ["--import", pathToFileURL(loader).href, entry, ...smoke.args], {
            cwd: repoDir,
            env: childEnv,
            encoding: "utf8",
            timeout: STEP_TIMEOUT_MS,
            stdio: CAPTURED,
          });
          if (ran.error !== undefined || ran.status === null) {
            findings.push({
              rule: "cli-command-failed",
              subject: pkg.name,
              message: `\`${label}\` did not run to completion from a standalone install: ${
                ran.error === undefined ? `terminated by ${ran.signal ?? "an unknown signal"}` : describe(ran.error)
              }`,
            });
            continue;
          }
          // Both streams: an ok result prints to stdout and a blocked one to
          // stderr, and two of these cases are asserting on a refusal.
          const output = `${ran.stdout}${ran.stderr}`;
          if (ran.status !== smoke.exitCode) {
            findings.push({
              rule: "cli-command-failed",
              subject: pkg.name,
              message: `\`${label}\` exited ${ran.status} from a standalone install, not ${smoke.exitCode}: ${excerpt(output)}`,
            });
            continue;
          }
          const missing = smoke.expected.filter((needle) => !output.includes(needle));
          if (missing.length > 0) {
            findings.push({
              rule: "cli-command-failed",
              subject: pkg.name,
              message: `\`${label}\` exited ${ran.status} as expected but its output named none of ${missing.join(", ")}: ${excerpt(output)}`,
            });
            continue;
          }
          log(`cli-ok ${label}`);
        }

        // What the run-surface cases left behind, read before the `finally`
        // below removes the tree it lives in. An `emit` that exited zero having
        // written nothing would pass every case above and fail here.
        let store: ScratchRunStore | undefined;
        try {
          store = readScratchRunStore(repoDir);
        } catch (error) {
          findings.push({
            rule: "run-store-unexpected",
            subject: pkg.name,
            message: `the run-surface cases ran but their run store could not be read under managed-delivery/runs/ of the scratch repository: ${describe(error)}`,
          });
        }
        if (store !== undefined && (store.journals !== EXPECTED_SCRATCH_JOURNALS || store.noteLines !== EXPECTED_SCRATCH_NOTE_LINES)) {
          findings.push({
            rule: "run-store-unexpected",
            subject: pkg.name,
            message: `the run-surface cases left ${store.journals} journal(s) and ${store.noteLines} note line(s) under managed-delivery/runs/ of the scratch repository; one run.started and one refused append leave exactly ${EXPECTED_SCRATCH_JOURNALS} and ${EXPECTED_SCRATCH_NOTE_LINES}`,
          });
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
    rmSync(scratch, { recursive: true, force: true });
  }

  return { findings, packagesProbed, siblingEdgesVerified };
}

/** As much of a captured stream as a finding can carry without becoming the report. */
function excerpt(output: string, maximum = 400): string {
  const collapsed = output.replace(/\s+/gu, " ").trim();
  return collapsed.length <= maximum ? collapsed : `${collapsed.slice(0, maximum - 1)}…`;
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
