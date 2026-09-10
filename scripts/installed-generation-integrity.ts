import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import path from "node:path";

export type InstalledGenerationIntegrityFinding = {
  readonly code:
    | "installed_generation_receipt_unreadable"
    | "installed_generation_pointer_drift"
    | "installed_generation_file_drift";
  readonly message: string;
};

type ActiveReceipt = {
  readonly release: { readonly archiveSha256: string };
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseActiveReceipt(value: unknown): ActiveReceipt | undefined {
  if (!isRecord(value) || !isRecord(value["release"]) || !Array.isArray(value["files"])) return undefined;
  if (typeof value["release"]["archiveSha256"] !== "string") return undefined;
  if (
    !value["files"].every(
      (entry) => isRecord(entry) && typeof entry["path"] === "string" && typeof entry["sha256"] === "string",
    )
  ) return undefined;
  return value as ActiveReceipt;
}

/** Recompute the active receipt against the generation selected by `current`. */
export async function checkInstalledGenerationIntegrity(
  rootDir: string,
): Promise<InstalledGenerationIntegrityFinding[]> {
  const findings: InstalledGenerationIntegrityFinding[] = [];
  const installRoot = path.join(rootDir, ".agent-skills");
  const activePath = path.join(installRoot, "active.json");
  const currentPath = path.join(installRoot, "current");
  let receipt: ActiveReceipt;
  let currentTarget: string;
  try {
    const parsed = JSON.parse(await readFile(activePath, "utf8")) as unknown;
    const validated = parseActiveReceipt(parsed);
    if (validated === undefined) throw new Error("expected release.archiveSha256 and a path/sha256 files array");
    receipt = validated;
    currentTarget = await readlink(currentPath);
  } catch (error) {
    return [{
      code: "installed_generation_receipt_unreadable",
      message: `.agent-skills/active.json or .agent-skills/current is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }

  const generationDir = path.resolve(installRoot, currentTarget);
  if (path.basename(generationDir) !== receipt.release.archiveSha256) {
    findings.push({
      code: "installed_generation_pointer_drift",
      message: `.agent-skills/current selects ${path.basename(generationDir)} but active.json release.archiveSha256 is ${receipt.release.archiveSha256}`,
    });
  }

  for (const entry of receipt.files) {
    const filePath = path.resolve(generationDir, entry.path);
    if (filePath !== generationDir && !filePath.startsWith(`${generationDir}${path.sep}`)) {
      findings.push({
        code: "installed_generation_file_drift",
        message: `${entry.path} escapes the installed generation selected by .agent-skills/current`,
      });
      continue;
    }
    let actual: string;
    try {
      actual = sha256(await readFile(filePath));
    } catch (error) {
      findings.push({
        code: "installed_generation_file_drift",
        message: `${entry.path} is missing or unreadable in the installed generation: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (actual !== entry.sha256) {
      findings.push({
        code: "installed_generation_file_drift",
        message: `${entry.path} has sha256 ${actual}, not the ${entry.sha256} recorded by .agent-skills/active.json`,
      });
    }
  }
  return findings;
}
