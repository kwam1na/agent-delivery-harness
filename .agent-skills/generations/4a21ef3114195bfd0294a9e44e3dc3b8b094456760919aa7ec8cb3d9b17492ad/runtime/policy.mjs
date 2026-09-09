// scripts/recompile-policy-snapshot.ts
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileRepositoryPolicy, projectShippedPersonas, createArtifactsPort, repositoryEvidenceReader, readWorkflowRelease, resolveReviewCharters } from "./kernel.mjs";
var POLICY_PROJECTION_DIR = ".agents/policy";
var INSTALLED_ARCHIVE_DIR = ".agent-skills/current";
var DOCUMENT_FILE = "repository-policy.json";
var ADAPTERS_FILE = "adapters.json";
var SNAPSHOT_FILE = "compiled-snapshot.json";
var REPORT_FILE = "comparison-report.json";
var sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
var RecompileError = class extends Error {
};
function installedArchiveReader(archiveDir) {
  const root = path.resolve(archiveDir);
  return (entryPath) => {
    const resolved = path.resolve(root, entryPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return void 0;
    try {
      return readFileSync(resolved);
    } catch {
      return void 0;
    }
  };
}
async function readJson(filePath, role) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new RecompileError(`${role} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RecompileError(`${role} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
async function recompilePolicySnapshot(rootDir, options = {}) {
  const policyDir = path.join(rootDir, POLICY_PROJECTION_DIR);
  const snapshotPath = path.join(policyDir, SNAPSHOT_FILE);
  const recordedText = await readFile(snapshotPath, "utf8").catch((error) => {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} is unreadable, and this script re-records a snapshot rather than minting the first one: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  let recorded;
  try {
    recorded = JSON.parse(recordedText);
  } catch (error) {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let compiledWith = recorded.compiledWith;
  if (!isRecord(compiledWith) || typeof compiledWith["productTrustRevocationEpoch"] !== "number" || typeof compiledWith["repositoryAuthorityRevocationEpoch"] !== "number") {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} carries no compiledWith block declaring both revocation epochs; the epochs a policy is compiled under are provenance, not a default this script supplies`
    );
  }
  const read = repositoryEvidenceReader(rootDir, createArtifactsPort());
  if (options.product) {
    const release = await readWorkflowRelease(read);
    if (release === null) throw new RecompileError("product reconciliation requires an installed release");
    const source = compiledWith["personaSource"];
    if (isRecord(source) && source["archiveSha256"] !== void 0) {
      compiledWith = { ...compiledWith, personaSource: { ...source, archiveSha256: release["archiveSha256"] } };
    }
  }
  const documentBytes = await readFile(path.join(policyDir, DOCUMENT_FILE)).catch((error) => {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${DOCUMENT_FILE} is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  const adaptersBytes = await readFile(path.join(policyDir, ADAPTERS_FILE)).catch((error) => {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${ADAPTERS_FILE} is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  const document = await readJson(path.join(policyDir, DOCUMENT_FILE), `${POLICY_PROJECTION_DIR}/${DOCUMENT_FILE}`);
  const adapters = await readJson(path.join(policyDir, ADAPTERS_FILE), `${POLICY_PROJECTION_DIR}/${ADAPTERS_FILE}`);
  if (!Array.isArray(adapters)) {
    throw new RecompileError(`${POLICY_PROJECTION_DIR}/${ADAPTERS_FILE} is not an array of leaf adapters`);
  }
  const projected = projectShippedPersonas(installedArchiveReader(path.join(rootDir, INSTALLED_ARCHIVE_DIR)));
  if (!projected.ok) {
    throw new RecompileError(
      `the installed generation at ${INSTALLED_ARCHIVE_DIR} cannot supply its reviewer charters: ${projected.rejections.map((rejection) => `${rejection.pointer}: [${rejection.code}] ${rejection.message}`).join("; ")}`
    );
  }
  const compiled = compileRepositoryPolicy({
    document,
    adapters,
    personas: projected.personas,
    productTrustRevocationEpoch: compiledWith["productTrustRevocationEpoch"],
    repositoryAuthorityRevocationEpoch: compiledWith["repositoryAuthorityRevocationEpoch"]
  });
  if (!compiled.ok) {
    throw new RecompileError(
      `the policy compiler rejected the projection: ${compiled.rejections.map((rejection) => `${rejection.pointer}: [${rejection.code}] ${rejection.message}`).join("; ")}`
    );
  }
  const text = `${JSON.stringify(
    {
      schemaVersion: recorded.schemaVersion,
      compiledWith,
      inputDigests: { [DOCUMENT_FILE]: sha256(documentBytes), [ADAPTERS_FILE]: sha256(adaptersBytes) },
      compiled: compiled.compiled
    },
    null,
    2
  )}
`;
  if (options.product) {
    await resolveReviewCharters(async (relative) => relative === `${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE}` ? Buffer.from(text) : read(relative));
  }
  let staleReport = false;
  const report = await readJson(path.join(policyDir, REPORT_FILE), `${POLICY_PROJECTION_DIR}/${REPORT_FILE}`);
  const inputs = isRecord(report) ? report["inputs"] : void 0;
  if (!isRecord(inputs) || inputs[SNAPSHOT_FILE] !== sha256(text) || inputs["compiledDigest"] !== compiled.compiled.compiledDigest) {
    staleReport = true;
  }
  return { text, unchanged: text === recordedText, staleReport };
}
async function main(argv, rootDir) {
  const checkOnly = argv.includes("--check");
  let result;
  try {
    result = await recompilePolicySnapshot(rootDir, { product: argv.includes("--product") });
  } catch (error) {
    process.stderr.write(
      `recompile-policy-snapshot: ${error instanceof RecompileError ? error.message : String(error)}
`
    );
    process.exitCode = 1;
    return;
  }
  if (checkOnly) {
    if (result.unchanged) {
      process.stdout.write(
        `recompile-policy-snapshot: ${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} is the compile of the current policy
`
      );
      return;
    }
    process.stderr.write(
      `recompile-policy-snapshot: ${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} is not the compile of the current policy; run npm run policy:recompile
`
    );
    process.exitCode = 1;
    return;
  }
  if (result.unchanged) {
    process.stdout.write(`recompile-policy-snapshot: ${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} unchanged
`);
  } else {
    await writeFile(path.join(rootDir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), result.text, "utf8");
    process.stdout.write(`recompile-policy-snapshot: rewrote ${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE}
`);
  }
  if (result.staleReport) {
    process.stdout.write(
      `recompile-policy-snapshot: ${POLICY_PROJECTION_DIR}/${REPORT_FILE} no longer describes it; re-record its inputs and adjudications, then run npm run sensor:policy
`
    );
  }
}
function canonicalEntryPath(entryPath) {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}
var invokedDirectly = process.argv[1] !== void 0 && canonicalEntryPath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main(process.argv.slice(2), process.cwd());
}
export {
  ADAPTERS_FILE,
  DOCUMENT_FILE,
  INSTALLED_ARCHIVE_DIR,
  POLICY_PROJECTION_DIR,
  REPORT_FILE,
  RecompileError,
  SNAPSHOT_FILE,
  recompilePolicySnapshot
};
