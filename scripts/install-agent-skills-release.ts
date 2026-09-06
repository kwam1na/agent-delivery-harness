/** Consume a distributed product ZIP; the archive owns lifecycle and policy reconciliation. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export class InstallError extends Error {}
export interface InstallRequest { readonly archive: string; readonly metadata: string }
export interface ExpectedRelease { readonly releaseId: string; readonly profile: string; readonly archiveSha256: string }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseInstallArgs(argv: readonly string[]): InstallRequest {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!["--archive", "--metadata"].includes(flag) || values.has(flag) || !value || value.startsWith("--") || value.includes("\0")) {
      throw new InstallError("usage: --archive <distributed-product.zip> --metadata <release.json>; each flag is required once");
    }
    values.set(flag, path.resolve(value));
  }
  if (values.size !== 2) throw new InstallError("--archive and --metadata are required");
  return { archive: values.get("--archive")!, metadata: values.get("--metadata")! };
}
export function checkInstalledStatus(status: unknown, expected: ExpectedRelease): void {
  if (!isRecord(status)) throw new InstallError("the lifecycle status is not an object");
  if (status["lifecycle"] !== "current") {
    throw new InstallError(`the lifecycle reports ${JSON.stringify(status["lifecycle"])} rather than "current"`);
  }
  if (status["productReady"] !== true) throw new InstallError("the product runtime or policy is not ready");
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
export async function install(request: InstallRequest, rootDir: string): Promise<void> {
  const archiveStat = await stat(request.archive);
  const metadataStat = await stat(request.metadata);
  if (archiveStat.size > 8 * 1024 * 1024 || metadataStat.size > 64 * 1024) throw new InstallError("release inputs exceed bounded archive limits");
  const metadataBytes = await readFile(request.metadata);
  const metadata: unknown = JSON.parse(metadataBytes.toString("utf8"));
  if (!isRecord(metadata) || metadata["schemaVersion"] !== "agent-skills-release-metadata/1" || typeof metadata["releaseId"] !== "string" || typeof metadata["profile"] !== "string" || typeof metadata["archiveSha256"] !== "string") {
    throw new InstallError("invalid detached release metadata");
  }
  const archiveBytes = await readFile(request.archive);
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  if (digest !== metadata["archiveSha256"]) throw new InstallError("release.archive_checksum: detached checksum mismatch");
  // Execute the same verified bytes even if the supplied artifact path moves.
  const staging = await mkdtemp(path.join(os.tmpdir(), "delivery-product-install-"));
  try {
    const archive = path.join(staging, "product.zip");
    const metadataFile = path.join(staging, "product.json");
    await writeFile(archive, archiveBytes, { mode: 0o400 });
    await writeFile(metadataFile, metadataBytes, { mode: 0o400 });
    const run = promisify(execFile);
    const execute = async (arguments_: readonly string[]) => {
      try { return await run("python3", [...arguments_], { cwd: rootDir, timeout: 120_000, maxBuffer: 1024 * 1024 }); }
      catch (error) {
        const detail = isRecord(error) ? [error["stdout"], error["stderr"]].filter((value) => typeof value === "string").join("\n") : "";
        throw new InstallError(`product lifecycle failed: ${(detail || String(error)).slice(-4000)}`);
      }
    };
    const prefix = ["-B", archive, "--root", rootDir, "--product"];
    const exists = await stat(path.join(rootDir, ".agent-skills/active.json")).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    await execute([...prefix, exists ? "update" : "install", "--archive", archive, "--metadata", metadataFile, "--maintenance"]);
    const status = await execute([...prefix, "status"]);
    checkInstalledStatus(JSON.parse(status.stdout), { releaseId: metadata["releaseId"], profile: metadata["profile"], archiveSha256: digest });
    process.stdout.write(`installed ${metadata["releaseId"]}; archive ${digest}; product ready\n`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await install(parseInstallArgs(process.argv.slice(2)), process.cwd()); }
  catch (error) { process.stderr.write(`install-agent-skills-release: ${String(error)}\n`); process.exitCode = 1; }
}
