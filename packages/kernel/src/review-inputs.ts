/** Reviewer input resolution shared by emission and portable verification. */
import path from "node:path";
import { sha256Hex } from "./digest.ts";
import { PERSONA_MANIFEST_ENTRY, PERSONA_MANIFEST_SPEC } from "./policy/shipped-personas.ts";
import { verifyCompiledPolicy, type CompiledPolicy } from "./policy/compile.ts";
export const COMPILED_SNAPSHOT_FILE = ".agents/policy/compiled-snapshot.json";
export const INSTALLED_ARCHIVE_DIR = ".agent-skills/current";
export const CHARTER_EXTENSION = ".md";
export class ReviewInputError extends Error {}
const OutcomeError = ReviewInputError;
export type ReviewInputReader = (relativePath: string) => Promise<Uint8Array | null>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
async function readJsonFile(read: ReviewInputReader, filePath: string, role: string): Promise<unknown> {
  try {
    const bytes = await read(filePath);
    if (bytes === null) throw new Error("missing file");
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new OutcomeError(`${role} is unreadable or not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reads the optional compiled owner policy without turning absence into a grant. */
export async function readCompiledRepositoryPolicy(read: ReviewInputReader): Promise<CompiledPolicy | null> {
  const bytes = await read(COMPILED_SNAPSHOT_FILE);
  if (bytes === null) return null;
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new ReviewInputError(`the compiled policy snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const compiled = isRecord(wrapper) ? wrapper["compiled"] : undefined;
  // A legacy snapshot carries no hosted-check declaration. It remains the
  // strict posture and needs no widening projection from this reader; several
  // older consumers also retain only the review-lens subset needed by their
  // evidence path. Validate the complete compiled policy only when it actually
  // asks to carry a hosted-check exception surface.
  if (!isRecord(compiled) || compiled["hostedChecks"] === undefined) return null;
  const verdict = verifyCompiledPolicy(compiled);
  if (!verdict.ok) {
    throw new ReviewInputError(`the compiled policy snapshot is invalid: ${verdict.rejections.map((entry) => `${entry.pointer} [${entry.code}] ${entry.message}`).join("; ")}`);
  }
  return compiled as unknown as CompiledPolicy;
}

/** One activated lens, resolved to the charter bytes the installation carries. */
export interface ResolvedCharter {
  readonly origin: "composition" | "repository";
  readonly sourcePath: string;
  readonly lensId: string;
  /** The reviewer id the evidence carries: the charter path's basename. */
  readonly reviewerId: string;
  readonly personaId: string;
  /** The archive-relative path the charter's bytes were read from. */
  readonly entryPath: string;
  /** The digest of those bytes, equal to the one the compiled policy resolved. */
  readonly digest: string;
}

/**
 * The reviewers a review in `rootDir` must cover: the compiled policy's
 * activated review lenses, each resolved to the charter the installed
 * generation ships for it.
 *
 * Two resolutions rather than a list held here, because a list held here is
 * exactly how an activated lens goes unrepresented in the evidence while
 * everything stays green. The compiled snapshot decides WHICH lenses reviewed —
 * the whole shipped set is seventeen charters and this repository activates two
 * of them, so the archive alone would name fifteen reviewers that never ran.
 * The archive decides WHAT each lens was told, and the snapshot's digest is
 * checked against the bytes actually read, so a charter the installation does
 * not carry, or one whose bytes have drifted from the policy the repository is
 * judged under, refuses the emission instead of quietly reviewing under
 * something else.
 */
export async function resolveReviewCharters(read: ReviewInputReader, config?: { readonly additionalReviewLenses?: readonly { readonly lensId: string; readonly reviewerId: string; readonly charterPath: string }[] }): Promise<ResolvedCharter[]> {
  const snapshotPath = COMPILED_SNAPSHOT_FILE;
  const snapshot = await readJsonFile(read, snapshotPath, `the compiled policy snapshot at ${COMPILED_SNAPSHOT_FILE}`);
  if (isRecord(snapshot) && snapshot["inputDigests"] !== undefined) {
    if (!isRecord(snapshot["inputDigests"])) throw new OutcomeError("the compiled policy input digests are malformed");
    for (const [file, digest] of Object.entries(snapshot["inputDigests"])) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || !/^[a-f0-9]{64}$/.test(String(digest))) throw new OutcomeError("the compiled policy declares an invalid input digest");
      const bytes = await read(path.posix.join(path.posix.dirname(COMPILED_SNAPSHOT_FILE), file));
      if (bytes === null || sha256Hex(bytes) !== digest) throw new OutcomeError("the compiled policy snapshot is stale against its declared input bytes; recompile policy");
    }
  }
  const compiledWith = isRecord(snapshot) ? snapshot["compiledWith"] : undefined;
  const personaSource = isRecord(compiledWith) ? compiledWith["personaSource"] : undefined;
  if (isRecord(personaSource) && personaSource["archiveSha256"] !== undefined) {
    const release = await readWorkflowRelease(read);
    if (release === null || personaSource["archiveSha256"] !== release["archiveSha256"]) throw new OutcomeError("the compiled policy persona source differs from the active workflow generation; recompile policy");
  }
  const compiled = isRecord(snapshot) ? snapshot["compiled"] : undefined;
  const inner = isRecord(compiled) ? compiled["snapshot"] : undefined;
  const lenses = isRecord(inner) ? inner["reviewLenses"] : undefined;
  if (!Array.isArray(lenses)) {
    throw new OutcomeError(`${COMPILED_SNAPSHOT_FILE} records no compiled review lenses to review under`);
  }

  const manifestPath = path.posix.join(INSTALLED_ARCHIVE_DIR, PERSONA_MANIFEST_ENTRY);
  const manifest = await readJsonFile(
    read, manifestPath,
    `the charter manifest at ${INSTALLED_ARCHIVE_DIR}/${PERSONA_MANIFEST_ENTRY}`,
  );
  if (!isRecord(manifest) || manifest["schemaVersion"] !== PERSONA_MANIFEST_SPEC || !Array.isArray(manifest["personas"])) {
    throw new OutcomeError(
      `${INSTALLED_ARCHIVE_DIR}/${PERSONA_MANIFEST_ENTRY} is not a ${PERSONA_MANIFEST_SPEC} document declaring a charter list`,
    );
  }
  const charterPaths = new Map<string, string>();
  for (const entry of manifest["personas"]) {
    if (isRecord(entry) && typeof entry["personaId"] === "string" && typeof entry["path"] === "string") {
      charterPaths.set(entry["personaId"], entry["path"]);
    }
  }

  const archiveRoot = path.posix.resolve("/", INSTALLED_ARCHIVE_DIR);
  const resolved: ResolvedCharter[] = [];
  const seen = new Set<string>();
  for (const lens of lenses) {
    if (!isRecord(lens) || typeof lens["lensId"] !== "string" || typeof lens["personaId"] !== "string" || typeof lens["personaDigest"] !== "string") {
      throw new OutcomeError("a compiled review lens names no reviewer charter and digest");
    }
    const personaId = lens["personaId"];
    const digest = lens["personaDigest"];
    const entryPath = charterPaths.get(personaId);
    if (entryPath === undefined) {
      throw new OutcomeError(
        `the compiled policy activates a lens referencing charter ${personaId}, which the installed generation's manifest does not declare`,
      );
    }
    // The path comes from a document inside the installation, so it is held
    // inside it before it is opened.
    const charterPath = path.posix.resolve(archiveRoot, entryPath);
    if (!charterPath.startsWith(`${archiveRoot}/`)) {
      throw new OutcomeError(`charter ${personaId} is declared at ${entryPath}, which leaves ${INSTALLED_ARCHIVE_DIR}`);
    }
    let bytes: Uint8Array;
    try {
      const contents = await read(path.posix.join(INSTALLED_ARCHIVE_DIR, entryPath));
      if (contents === null) throw new Error("missing charter");
      bytes = contents;
    } catch (error) {
      throw new OutcomeError(
        `charter ${personaId} is declared at ${entryPath}, and the installed generation carries no such file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const actual = sha256Hex(bytes);
    if (actual !== digest) {
      throw new OutcomeError(
        `charter ${personaId} at ${entryPath} hashes to ${actual}, and the compiled policy was resolved against ${digest}`,
      );
    }
    const base = path.posix.basename(entryPath);
    const reviewerId = base.endsWith(CHARTER_EXTENSION) ? base.slice(0, -CHARTER_EXTENSION.length) : base;
    if (seen.has(reviewerId)) {
      throw new OutcomeError(`two activated lenses resolve to reviewer ${reviewerId}; a reviewer reviews once`);
    }
    seen.add(reviewerId);
    resolved.push({ origin: "composition", sourcePath: path.posix.join(INSTALLED_ARCHIVE_DIR, entryPath), lensId: lens["lensId"], reviewerId, personaId, entryPath, digest });
  }
  const lensIds = new Set(resolved.map((charter) => charter.lensId));
  for (const extra of config?.additionalReviewLenses ?? []) {
    if (lensIds.has(extra.lensId) || seen.has(extra.reviewerId)) throw new OutcomeError("an additional review lens collides with an activated lens or reviewer");
    const normalized = path.posix.normalize(extra.charterPath);
    if (normalized !== extra.charterPath || normalized.startsWith("/") || normalized === "." || normalized === ".." || normalized.endsWith("/") || normalized.startsWith("../") || normalized.includes("\\") || normalized.includes("\0")) {
      throw new OutcomeError("an additional review charter must name a repository-relative file");
    }
    const bytes = await read(extra.charterPath);
    if (bytes === null || Buffer.from(bytes).toString("utf8").trim().length === 0) throw new OutcomeError("an additional review charter is missing or empty");
    lensIds.add(extra.lensId);
    seen.add(extra.reviewerId);
    resolved.push({ origin: "repository", sourcePath: extra.charterPath, lensId: extra.lensId, reviewerId: extra.reviewerId,
      personaId: extra.lensId, entryPath: extra.charterPath, digest: sha256Hex(bytes) });
  }
  return resolved;
}

/** One release identity for review, checks and portable verification. Absence is explicit. */
export async function readWorkflowRelease(read: ReviewInputReader): Promise<Readonly<Record<string, unknown>> | null> {
  const active = await read(".agent-skills/active.json");
  if (active === null) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(active).toString("utf8")); } catch { throw new ReviewInputError("the installed workflow receipt is not valid JSON"); }
  const release = isRecord(value) ? value["release"] : undefined;
  if (!isRecord(release) || !["releaseId", "profile"].every((key) => typeof release[key] === "string" && release[key] !== "") ||
      !["archiveSha256", "metadataSha256"].every((key) => typeof release[key] === "string" && /^[0-9a-f]{64}$/.test(release[key] as string))) {
    throw new ReviewInputError("the installed workflow receipt has no exact release identity");
  }
  return release;
}
