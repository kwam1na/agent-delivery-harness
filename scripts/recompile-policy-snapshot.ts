/**
 * Recompile `.agents/policy/compiled-snapshot.json` from the policy documents
 * it is compiled from.
 *
 * WHY THIS IS A SCRIPT. The snapshot is a recorded compile: the declarative
 * policy document and the typed leaf adapters, run through the compiler in
 * `packages/kernel/src/policy/`, against the reviewer charters the installed
 * generation ships. `policy-projection-check.ts` performs that compile live
 * and reports `compile_drift` or `snapshot_input_stale` when the recorded
 * bytes no longer describe it — but a sensor reports; it does not repair. Every
 * delivery that moved the policy or the installation therefore wrote its own
 * one-off re-recorder and deleted it, which left the step that produces an
 * authority artifact unversioned and unreviewed. This is that step, landed.
 *
 * WHAT IT IS NOT. It is not an approval. `.agents/` is a protected authority
 * tree, and a compiled snapshot this script writes is a proposal a repository
 * owner accepts by reviewing the diff — the same standing the hand-written
 * re-recorders had. Nor is it the comparison report: `comparison-report.json`
 * records adjudications a person made, and this script only says when the
 * report has stopped describing the snapshot.
 *
 * WHAT IT CARRIES FORWARD. `schemaVersion` and the whole `compiledWith` block
 * are read from the snapshot being replaced and written back unchanged, and
 * the revocation epochs the compile runs under are read from that block rather
 * than defaulted here. `compiledWith` is the provenance of the compiler bytes
 * the recorded policy was produced by; re-stamping it is an operator decision
 * about which compiler this repository is judged under, not a side effect of
 * re-recording an unchanged policy. That is also what makes an unchanged
 * policy regenerate byte-identically. Product lifecycle reconciliation adds
 * one explicit exception: `--product` updates an already-declared personaSource
 * archive digest to the selected generation, then validates the proposed
 * snapshot against its current policy sources and shipped charters. Other
 * compiler provenance and comparison adjudications remain unchanged.
 *
 * Usage:
 *
 *   npm run policy:recompile           # rewrite the snapshot in place
 *   npm run policy:recompile -- --check  # report drift, write nothing
 */
import { lstat, readFile, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileRepositoryPolicy, projectShippedPersonas, createArtifactsPort, repositoryEvidenceReader, readWorkflowRelease, resolveReviewCharters } from "@agent-delivery-harness/kernel";

/** The policy projection this repository records, and the installation it is compiled against. */
export const POLICY_PROJECTION_DIR = ".agents/policy";
export const INSTALLED_ARCHIVE_DIR = ".agent-skills/current";

export const DOCUMENT_FILE = "repository-policy.json";
export const ADAPTERS_FILE = "adapters.json";
export const SNAPSHOT_FILE = "compiled-snapshot.json";
export const REPORT_FILE = "comparison-report.json";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** A refusal about the inputs, raised before anything is written. */
export class RecompileError extends Error {}

/**
 * An `ArchiveEntryReader` over the extracted generation, resolved and held
 * inside it — the entry paths come from a document inside the archive, so an
 * escaping path reads as absent rather than as a file outside the install.
 */
function installedArchiveReader(archiveDir: string) {
  const root = path.resolve(archiveDir);
  return (entryPath: string): Uint8Array | undefined => {
    const resolved = path.resolve(root, entryPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return undefined;
    try {
      return readFileSync(resolved);
    } catch {
      return undefined;
    }
  };
}

/** Recorded provenance; product reconciliation may update its declared persona archive. */
interface CompiledWith {
  readonly productTrustRevocationEpoch: number;
  readonly repositoryAuthorityRevocationEpoch: number;
  readonly [key: string]: unknown;
}

interface RecordedSnapshot {
  readonly schemaVersion: unknown;
  readonly compiledWith: CompiledWith;
}

export interface RecompileResult {
  /** The snapshot document's serialized bytes, exactly as they belong on disk. */
  readonly text: string;
  /** Whether those bytes are the ones already recorded. */
  readonly unchanged: boolean;
  /** Set when the comparison report no longer describes the recompiled snapshot. */
  readonly staleReport: boolean;
}

async function readJson(filePath: string, role: string): Promise<unknown> {
  let text: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Compile the recorded policy and return the snapshot bytes it produces.
 *
 * Nothing is written here, so the same call serves the write and the
 * `--check` report, and a test can assert byte-identity without touching the
 * authority tree.
 */
export async function recompilePolicySnapshot(rootDir: string, options: { readonly product?: boolean; readonly bootstrap?: boolean } = {}): Promise<RecompileResult> {
  const policyDir = path.join(rootDir, POLICY_PROJECTION_DIR);
  const snapshotPath = path.join(policyDir, SNAPSHOT_FILE);
  let initial: RecordedSnapshot | undefined;
  if (options.bootstrap) {
    if (!options.product) throw new RecompileError("bootstrap requires --product and a verified installed runtime");
    for (const name of [SNAPSHOT_FILE, REPORT_FILE]) {
      const present = await lstat(path.join(policyDir, name)).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
      if (present) throw new RecompileError(`bootstrap requires absent ${name}; existing or partial authority state is never replaced`);
    }
    const inputs = await readJson(path.join(policyDir, "bootstrap-inputs.json"), "explicit bootstrap-inputs.json");
    const epochs = ["productTrustRevocationEpoch", "repositoryAuthorityRevocationEpoch"] as const;
    if (!isRecord(inputs) || Object.keys(inputs).length !== epochs.length || epochs.some((key) => !Number.isSafeInteger(inputs[key]) || (inputs[key] as number) < 0)) {
      throw new RecompileError("bootstrap-inputs.json must declare exactly both nonnegative safe-integer revocation epochs");
    }
    const read = repositoryEvidenceReader(rootDir, createArtifactsPort());
    const release = await readWorkflowRelease(read);
    if (release === null) throw new RecompileError("bootstrap requires an installed release");
    const runtime = await readJson(path.join(rootDir, INSTALLED_ARCHIVE_DIR, "runtime/runtime.json"), "installed runtime descriptor");
    if (!isRecord(runtime) || runtime["schemaVersion"] !== "delivery-runtime/1") throw new RecompileError("bootstrap requires a verified product runtime descriptor");
    const compilerBytes = await readFile(path.join(rootDir, INSTALLED_ARCHIVE_DIR, "runtime/kernel.mjs"));
    const compilerEntry = Array.isArray(runtime["files"]) ? runtime["files"].find((entry: unknown) => isRecord(entry) && entry["path"] === "kernel.mjs") : undefined;
    if (!isRecord(compilerEntry) || compilerEntry["sha256"] !== sha256(compilerBytes)) throw new RecompileError("bootstrap compiler bytes do not match the installed runtime descriptor");
    initial = { schemaVersion: "delivery-harness-compiled-policy-snapshot/1", compiledWith: {
      productTrustRevocationEpoch: inputs["productTrustRevocationEpoch"] as number,
      repositoryAuthorityRevocationEpoch: inputs["repositoryAuthorityRevocationEpoch"] as number,
      module: "runtime/kernel.mjs", compilerSha256: sha256(compilerBytes), runtimeVersion: runtime["runtimeVersion"],
      bootstrapInputsSha256: sha256(await readFile(path.join(policyDir, "bootstrap-inputs.json"))),
      personaSource: { archiveSha256: release["archiveSha256"] },
    } };
  }
  const recordedText = initial ? "" : await readFile(snapshotPath, "utf8").catch((error: unknown) => {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} is unreadable, and this script re-records a snapshot rather than minting the first one: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  let recorded: RecordedSnapshot;
  try {
    recorded = initial ?? JSON.parse(recordedText) as RecordedSnapshot;
  } catch (error) {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let compiledWith = recorded.compiledWith;
  if (
    !isRecord(compiledWith) ||
    typeof compiledWith["productTrustRevocationEpoch"] !== "number" ||
    typeof compiledWith["repositoryAuthorityRevocationEpoch"] !== "number"
  ) {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} carries no compiledWith block declaring both revocation epochs; the epochs a policy is compiled under are provenance, not a default this script supplies`,
    );
  }

  const read = repositoryEvidenceReader(rootDir, createArtifactsPort());
  if (options.product) {
    const release = await readWorkflowRelease(read);
    if (release === null) throw new RecompileError("product reconciliation requires an installed release");
    const source = compiledWith["personaSource"];
    if (isRecord(source) && source["archiveSha256"] !== undefined) {
      compiledWith = { ...compiledWith, personaSource: { ...source, archiveSha256: release["archiveSha256"] } };
    }
  }

  const documentBytes = await readFile(path.join(policyDir, DOCUMENT_FILE)).catch((error: unknown) => {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${DOCUMENT_FILE} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const adaptersBytes = await readFile(path.join(policyDir, ADAPTERS_FILE)).catch((error: unknown) => {
    throw new RecompileError(
      `${POLICY_PROJECTION_DIR}/${ADAPTERS_FILE} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const document = await readJson(path.join(policyDir, DOCUMENT_FILE), `${POLICY_PROJECTION_DIR}/${DOCUMENT_FILE}`);
  const adapters = await readJson(path.join(policyDir, ADAPTERS_FILE), `${POLICY_PROJECTION_DIR}/${ADAPTERS_FILE}`);
  // The adapter layer is a list; the compiler reads each entry's shape itself
  // and rejects what it cannot bind, so only the outer shape is checked here.
  if (!Array.isArray(adapters)) {
    throw new RecompileError(`${POLICY_PROJECTION_DIR}/${ADAPTERS_FILE} is not an array of leaf adapters`);
  }

  // The charter set is the installed generation's, projected through the same
  // function the projection sensor hands the compiler. A repository file
  // cannot intercept an identity reference, which is why the lenses use one.
  const projected = projectShippedPersonas(installedArchiveReader(path.join(rootDir, INSTALLED_ARCHIVE_DIR)));
  if (!projected.ok) {
    throw new RecompileError(
      `the installed generation at ${INSTALLED_ARCHIVE_DIR} cannot supply its reviewer charters: ${projected.rejections
        .map((rejection) => `${rejection.pointer}: [${rejection.code}] ${rejection.message}`)
        .join("; ")}`,
    );
  }

  const compiled = compileRepositoryPolicy({
    document,
    adapters,
    personas: projected.personas,
    productTrustRevocationEpoch: compiledWith["productTrustRevocationEpoch"],
    repositoryAuthorityRevocationEpoch: compiledWith["repositoryAuthorityRevocationEpoch"],
  });
  if (!compiled.ok) {
    throw new RecompileError(
      `the policy compiler rejected the projection: ${compiled.rejections
        .map((rejection) => `${rejection.pointer}: [${rejection.code}] ${rejection.message}`)
        .join("; ")}`,
    );
  }

  const text = `${JSON.stringify(
    {
      schemaVersion: recorded.schemaVersion,
      compiledWith,
      inputDigests: { [DOCUMENT_FILE]: sha256(documentBytes), [ADAPTERS_FILE]: sha256(adaptersBytes) },
      compiled: compiled.compiled,
    },
    null,
    2,
  )}\n`;

  if (options.product) {
    // Validate the proposed snapshot through the same product reader that
    // evidence/portable verification uses, before publishing any repair.
    await resolveReviewCharters(async (relative) => relative === `${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE}` ? Buffer.from(text) : read(relative));
  }

  // The comparison report pins the snapshot's own bytes and compiled digest,
  // so a snapshot that moved leaves the report describing the previous one.
  // Re-recording it is not this script's to do — its adjudications are a
  // person's — but saying so is, because the projection sensor's
  // `report_input_stale` finding is otherwise the first anyone hears of it.
  let staleReport = false;
  const reportAbsent = await lstat(path.join(policyDir, REPORT_FILE)).then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return true; throw error; });
  // A first compile has no human comparison adjudication. Product recovery
  // preserves that absence; existing reports are still parsed and checked.
  if (reportAbsent) {
    return { text, unchanged: text === recordedText, staleReport: options.bootstrap !== true };
  }
  let report: unknown;
  try {
    report = await readJson(path.join(policyDir, REPORT_FILE), `${POLICY_PROJECTION_DIR}/${REPORT_FILE}`);
  } catch (error) {
    if (!(error instanceof RecompileError)) throw error;
    return { text, unchanged: text === recordedText, staleReport: true };
  }
  const inputs = isRecord(report) ? report["inputs"] : undefined;
  if (
    !isRecord(inputs) ||
    inputs[SNAPSHOT_FILE] !== sha256(text) ||
    inputs["compiledDigest"] !== compiled.compiled.compiledDigest
  ) {
    staleReport = true;
  }

  return { text, unchanged: text === recordedText, staleReport };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(argv: readonly string[], rootDir: string): Promise<void> {
  const checkOnly = argv.includes("--check");
  let result: RecompileResult;
  try {
    if (argv.some((arg) => !["--check", "--product", "--bootstrap"].includes(arg))) throw new RecompileError("usage: [--check] [--product [--bootstrap]]");
    result = await recompilePolicySnapshot(rootDir, { product: argv.includes("--product"), bootstrap: argv.includes("--bootstrap") });
  } catch (error) {
    process.stderr.write(
      `recompile-policy-snapshot: ${error instanceof RecompileError ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    if (result.unchanged) {
      process.stdout.write(
        `recompile-policy-snapshot: ${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} is the compile of the current policy\n`,
      );
      reportStaleness(result);
      return;
    }
    process.stderr.write(
      `recompile-policy-snapshot: ${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} is not the compile of the current policy; run npm run policy:recompile\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (result.unchanged) {
    process.stdout.write(`recompile-policy-snapshot: ${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE} unchanged\n`);
  } else {
    await writeFile(path.join(rootDir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), result.text, { encoding: "utf8", flag: argv.includes("--bootstrap") ? "wx" : "w" });
    process.stdout.write(`recompile-policy-snapshot: rewrote ${POLICY_PROJECTION_DIR}/${SNAPSHOT_FILE}\n`);
  }
  if (result.staleReport) {
    reportStaleness(result);
  }
}

function reportStaleness(result: RecompileResult): void {
  if (!result.staleReport) return;
  process.stdout.write(
    `recompile-policy-snapshot: ${POLICY_PROJECTION_DIR}/${REPORT_FILE} no longer describes it; re-record its inputs and adjudications, then run npm run sensor:policy\n`,
  );
}

function canonicalEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  canonicalEntryPath(process.argv[1]) === canonicalEntryPath(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  // The root is the working directory, not this file's parent, so the whole
  // command — argv, both branches, and the one write — can be driven against a
  // fixture. `npm run policy:recompile` runs from the package root, which is
  // the repository root, so the documented invocation is unchanged.
  await main(process.argv.slice(2), process.cwd());
}
