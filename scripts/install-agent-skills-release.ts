/**
 * Install one `agent-skills` release into this repository.
 *
 * WHY THIS IS A SCRIPT. Installing a release here is four steps that must
 * happen in one order: build the release archive from the corpus checkout,
 * drive the lifecycle `update` against this repository, re-record the policy
 * snapshot the compile of that generation's charters produces, and then ask
 * the lifecycle whether the installation actually landed. Every install so far
 * ran those four by hand, and the fourth — the one that turns a half-applied
 * install into a visible failure — is the one a hand-run sequence forgets.
 * The corpus now declares that a consumer install is delivered `sensor-only`
 * with the lifecycle status sensor as its proof; this is that sensor, wired to
 * the steps it reports on.
 *
 * WHAT IT IS NOT. It is not an approval, and it is not a release cut. The
 * archive it builds is built from a checkout the operator names, at a release
 * id the operator passes; whether that checkout is at the commit the release
 * was qualified from is the operator's to know. What the script guarantees is
 * narrower and mechanical: the bytes it installs are the bytes it built, the
 * generation it reports active is the one it just built, and nothing is
 * reported as installed while the lifecycle still reports a blocker.
 *
 * WHAT IT NEVER WRITES. Nothing in the corpus checkout. The build's outputs go
 * to a temporary directory this process owns and removes; the checkout is read
 * and its lifecycle module is executed, never modified.
 *
 * Usage:
 *
 *   AGENT_SKILLS_CHECKOUT=/path/to/agent-skills \
 *     npm run skills:install -- --release-id linear-v2
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The environment variable naming the `agent-skills` checkout to build from. */
export const CHECKOUT_ENV = "AGENT_SKILLS_CHECKOUT";

/** The profile this repository runs; `--profile` overrides it. */
export const DEFAULT_PROFILE = "linear";

/** A refusal about the invocation, the checkout, or the resulting status. */
export class InstallError extends Error {}

export interface InstallRequest {
  readonly releaseId: string;
  readonly profile: string;
}

export interface ExpectedRelease {
  readonly releaseId: string;
  readonly profile: string;
  readonly archiveSha256: string;
}

/**
 * Both values are interpolated into a command line and then compared against
 * what the lifecycle reports, so both are bounded to the shape release ids and
 * profile names actually have rather than passed through.
 */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The invocation. `--release-id` has no default: it names the archive that is
 * built and the identity the status check later compares against, so
 * defaulting it would let a stale id pass a comparison against itself.
 */
export function parseInstallArgs(argv: readonly string[]): InstallRequest {
  let releaseId: string | undefined;
  let profile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token !== "--release-id" && token !== "--profile") {
      throw new InstallError(`unexpected argument ${JSON.stringify(token)}; usage: --release-id <id> [--profile <name>]`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new InstallError(`${token} needs a value`);
    if (token === "--release-id") {
      if (releaseId !== undefined) throw new InstallError("--release-id is given once");
      releaseId = value;
    } else {
      if (profile !== undefined) throw new InstallError("--profile is given once");
      profile = value;
    }
    index += 1;
  }
  if (releaseId === undefined) throw new InstallError("--release-id <id> names the release to install; there is no default");
  if (!NAME.test(releaseId)) throw new InstallError(`--release-id ${JSON.stringify(releaseId)} is not a release id`);
  const selected = profile ?? DEFAULT_PROFILE;
  if (!NAME.test(selected)) throw new InstallError(`--profile ${JSON.stringify(selected)} is not a profile name`);
  return { releaseId, profile: selected };
}

/**
 * The corpus checkout, from the environment. There is deliberately no fallback
 * to a sibling directory: the release bytes installed here are built from this
 * tree, and a guess would build them from whatever tree happened to be there.
 */
export function resolveCheckout(env: Readonly<Record<string, string | undefined>>): string {
  const value = (env[CHECKOUT_ENV] ?? "").trim();
  if (value.length === 0) {
    throw new InstallError(`${CHECKOUT_ENV} is unset; set it to the agent-skills checkout to build the release from`);
  }
  if (!path.isAbsolute(value)) throw new InstallError(`${CHECKOUT_ENV} must be an absolute path, not ${JSON.stringify(value)}`);
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The install's proof, as the corpus's install convention states it: the
 * lifecycle reports `current`, it reports no blockers, and the generation it
 * reports active is the one just built — compared by archive digest, so an
 * update that silently did nothing cannot pass by naming the same release id.
 *
 * Every branch here is a refusal. A status document of a shape the lifecycle
 * does not emit is refused rather than read past, because the failure mode
 * this guards is an absent member reading as an absent blocker.
 */
export function checkInstalledStatus(status: unknown, expected: ExpectedRelease): void {
  if (!isRecord(status)) throw new InstallError("the lifecycle status is not an object");
  if (status["lifecycle"] !== "current") {
    throw new InstallError(`the lifecycle reports ${JSON.stringify(status["lifecycle"])} rather than "current"`);
  }
  const blockers = status["blockers"];
  if (!Array.isArray(blockers)) throw new InstallError("the lifecycle status carries no blockers list");
  if (blockers.length > 0) throw new InstallError(`the lifecycle reports blockers: ${JSON.stringify(blockers)}`);
  const active = status["active"];
  if (!isRecord(active)) throw new InstallError("the lifecycle status names no active generation");
  for (const member of ["releaseId", "profile", "archiveSha256"] as const) {
    if (active[member] !== expected[member]) {
      throw new InstallError(
        `the active generation's ${member} is ${JSON.stringify(active[member])}, not the installed release's ${JSON.stringify(expected[member])}`,
      );
    }
  }
}

// ── The install itself ───────────────────────────────────────────────────────

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** A step whose failure is the install's failure, reported with what it said. */
async function step(label: string, command: string, args: readonly string[], cwd: string): Promise<RunResult> {
  process.stdout.write(`install-agent-skills-release: ${label}\n`);
  const result = await run(command, args, cwd);
  if (result.code !== 0) {
    throw new InstallError(`${label} failed (exit ${result.code})\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function parseJson(text: string, role: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InstallError(`${role} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function install(request: InstallRequest, checkout: string, rootDir: string): Promise<void> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "agent-skills-release-"));
  try {
    const archive = path.join(workDir, `${request.profile}.zip`);
    const metadata = path.join(workDir, `${request.profile}.release.json`);

    // Built from the checkout, never taken from one: the digests this install
    // is judged by are the ones this process computed.
    const built = await step(
      `building ${request.releaseId} (${request.profile}) from ${checkout}`,
      "python3",
      ["-B", "scripts/build-release.py", "build", "--archive", archive, "--metadata", metadata, "--release-id", request.releaseId, "--profile", request.profile],
      checkout,
    );
    const receipt = parseJson(built.stdout, "the release build's output");
    if (!isRecord(receipt) || typeof receipt["archiveSha256"] !== "string") {
      throw new InstallError("the release build reported no archive digest");
    }
    const archiveSha256 = receipt["archiveSha256"];

    // The archive authenticates before it is installed, through the same
    // verifier a consumer would use, into a directory nothing else reads.
    await step(
      "verifying the built archive",
      "python3",
      ["-B", "scripts/build-release.py", "verify", "--archive", archive, "--metadata", metadata, "--extract-to", path.join(workDir, "extracted")],
      checkout,
    );

    await step(
      `updating the installation at ${rootDir}`,
      "python3",
      ["-B", "-m", "agent_skills.cli", "--root", rootDir, "update", "--archive", archive, "--metadata", metadata, "--maintenance"],
      checkout,
    );

    // The compiled policy snapshot is compiled against the installed
    // generation's reviewer charters, so a new generation is a new compile.
    // Its own script owns the write and reports when the comparison report has
    // stopped describing the result.
    const recompiled = await step(
      "re-recording the compiled policy snapshot",
      process.execPath,
      ["--import", "tsx", path.join(rootDir, "scripts", "recompile-policy-snapshot.ts")],
      rootDir,
    );
    process.stdout.write(recompiled.stdout);

    const status = await step(
      "reading the lifecycle status back",
      "python3",
      ["-B", "-m", "agent_skills.cli", "--root", rootDir, "status"],
      checkout,
    );
    checkInstalledStatus(parseJson(status.stdout, "the lifecycle status"), {
      releaseId: request.releaseId,
      profile: request.profile,
      archiveSha256,
    });
    process.stdout.write(
      `install-agent-skills-release: installed ${request.releaseId} (${request.profile}) archive ${archiveSha256}; lifecycle current, no blockers\n`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[], rootDir: string): Promise<void> {
  try {
    // The environment is read here rather than passed in from module scope:
    // an import-time `process.env` read is what the boundary sensor bans.
    await install(parseInstallArgs(argv), resolveCheckout(process.env), rootDir);
  } catch (error) {
    process.stderr.write(`install-agent-skills-release: ${error instanceof InstallError ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function canonicalEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && canonicalEntryPath(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // The root is the working directory, the way the re-recorder takes its root:
  // `npm run skills:install` runs from the repository root.
  await main(process.argv.slice(2), process.cwd());
}
