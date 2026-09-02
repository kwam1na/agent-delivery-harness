/**
 * This repository's review-evidence provider.
 *
 * The gate declared in `harness.config.ts` carries one obligation — a green
 * code review, submitted as `review.green/1` evidence — and until this script
 * existed nothing in the tree emitted that evidence. Every delivery re-derived
 * an ad-hoc emitter and kept it outside the worktree (an untracked file refuses
 * the capture), which left the one artifact that decides what the gate is told
 * about a review unreviewed, unversioned, and gone with the session.
 *
 * WHAT IT IS NOT. It is not a reviewer, and it does not judge. It transcribes a
 * concluded review outcome — read from standard input, so running it needs no
 * file outside the tree — into a `delivery-evidence/1` manifest bound to the
 * candidate the recorder will re-capture, and prints the manifest path. A
 * non-green outcome produces a non-green manifest, which the recorder refuses
 * (RG-1); the refusal is the harness's judgement, and a provider that declined
 * to emit would hide the review instead of reporting it.
 *
 * WHAT IT RESOLVES RATHER THAN ASSERTS, because each of these is a way an
 * emitter can quietly stop describing this repository:
 *
 *   - The reviewer set is the compiled policy's own activated lenses, and each
 *     lens's charter is read from the installed generation the release
 *     shipped it in, its bytes checked against the digest the compiled
 *     snapshot resolved. Activating a lens moves the reviewer set with it; a
 *     charter the installation does not carry, or whose bytes have drifted
 *     from the compiled policy's, refuses the emission rather than reviewing
 *     under a charter nobody approved. An outcome that leaves a lens
 *     unrepresented — or names a reviewer no activated lens defines — is
 *     refused rather than emitted.
 *   - The obligation and provider are read from the loaded config: the one
 *     obligation accepting `review.green/1`, and the one provider it names.
 *   - Every telemetry number is derived from the findings the outcome carries,
 *     the way RG-8 re-derives them, so a constant cannot survive submission.
 *
 * Usage (`--silent` keeps npm's banner out of the captured path):
 *
 *   MANIFEST="$(npm run --silent review:evidence <<'JSON'
 *   { "spec": "review-outcome/1", "verdict": "green",
 *     "reviewers": [{ "id": "outcome-correctness", "result": "approved" }],
 *     "findings": [] }
 *   JSON
 *   )"
 *   delivery-harness submit-evidence --manifest "$MANIFEST"
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PERSONA_MANIFEST_ENTRY,
  PERSONA_MANIFEST_SPEC,
  captureGitCandidate,
  createArtifactsPort,
  resolveRecordStorage,
  sha256Hex,
  withDeliverableIdentity,
  type HarnessConfig,
} from "@agent-delivery-harness/kernel";

// ── The charters the compiled policy activates ───────────────────────────────

/**
 * The compiled policy this repository is judged under, and the installed
 * generation whose archive carries the charters its lenses reference by
 * identity. One activated lens is one reviewer, and the basename of the
 * charter path the archive's manifest declares is the reviewer id the evidence
 * carries — the same two documents `policy-projection-check.ts` compiles the
 * projection from.
 */
export const COMPILED_SNAPSHOT_FILE = ".agents/policy/compiled-snapshot.json";
export const INSTALLED_ARCHIVE_DIR = ".agent-skills/current";

export const CHARTER_EXTENSION = ".md";

/** The payload spec this provider emits evidence for. */
export const REVIEW_PAYLOAD_SPEC = "review.green/1";

/** The envelope spec the manifest declares. */
export const ENVELOPE_SPEC = "delivery-evidence/1";

/** The outcome document this emitter reads. */
export const OUTCOME_SPEC = "review-outcome/1";

/** This emitter's own version, carried in the manifest's provider triple. */
export const EMITTER_VERSION = "1.0.0";

/** Read one JSON document, or refuse with the role it plays rather than a raw path. */
async function readJsonFile(filePath: string, role: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new OutcomeError(`${role} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OutcomeError(`${role} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One activated lens, resolved to the charter bytes the installation carries. */
export interface ResolvedCharter {
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
export async function resolveActivatedCharters(rootDir: string): Promise<ResolvedCharter[]> {
  const snapshotPath = path.join(rootDir, COMPILED_SNAPSHOT_FILE);
  const snapshot = await readJsonFile(snapshotPath, `the compiled policy snapshot at ${COMPILED_SNAPSHOT_FILE}`);
  const compiled = isRecord(snapshot) ? snapshot["compiled"] : undefined;
  const inner = isRecord(compiled) ? compiled["snapshot"] : undefined;
  const lenses = isRecord(inner) ? inner["reviewLenses"] : undefined;
  if (!Array.isArray(lenses)) {
    throw new OutcomeError(`${COMPILED_SNAPSHOT_FILE} records no compiled review lenses to review under`);
  }

  const manifestPath = path.join(rootDir, INSTALLED_ARCHIVE_DIR, PERSONA_MANIFEST_ENTRY);
  const manifest = await readJsonFile(
    manifestPath,
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

  const archiveRoot = path.resolve(path.join(rootDir, INSTALLED_ARCHIVE_DIR));
  const resolved: ResolvedCharter[] = [];
  const seen = new Set<string>();
  for (const lens of lenses) {
    if (!isRecord(lens) || typeof lens["personaId"] !== "string" || typeof lens["personaDigest"] !== "string") {
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
    const charterPath = path.resolve(archiveRoot, entryPath);
    if (!charterPath.startsWith(`${archiveRoot}${path.sep}`)) {
      throw new OutcomeError(`charter ${personaId} is declared at ${entryPath}, which leaves ${INSTALLED_ARCHIVE_DIR}`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(charterPath);
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
    const base = path.basename(entryPath);
    const reviewerId = base.endsWith(CHARTER_EXTENSION) ? base.slice(0, -CHARTER_EXTENSION.length) : base;
    if (seen.has(reviewerId)) {
      throw new OutcomeError(`two activated lenses resolve to reviewer ${reviewerId}; a reviewer reviews once`);
    }
    seen.add(reviewerId);
    resolved.push({ reviewerId, personaId, entryPath, digest });
  }
  return resolved;
}

/** The reviewer ids of `resolveActivatedCharters`, sorted, as the evidence lists them. */
export async function resolveReviewerCharters(rootDir: string): Promise<string[]> {
  return (await resolveActivatedCharters(rootDir)).map((charter) => charter.reviewerId).sort();
}

// ── The review outcome ───────────────────────────────────────────────────────

/** What one reviewer did. `approved` is the only result that stamps an approval. */
export const REVIEWER_RESULTS = ["approved", "rejected", "failed", "timed-out"] as const;
export type ReviewerResult = (typeof REVIEWER_RESULTS)[number];

export interface ReviewerOutcome {
  readonly id: string;
  readonly result: ReviewerResult;
}

export interface ReviewOutcome {
  readonly verdict: string;
  readonly reviewers: readonly ReviewerOutcome[];
  /** Findings, as the `review.green/1` payload defines them. Passed through. */
  readonly findings: readonly Record<string, unknown>[];
}

/** A refusal this emitter makes about its own inputs, before any manifest exists. */
export class OutcomeError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read the outcome document, and hold it to the charter set. Nothing here
 * re-implements the `review.green/1` rules: findings travel through untouched
 * so the recorder — not this script — remains the judge of what green means.
 */
export function parseReviewOutcome(document: unknown, charters: readonly string[]): ReviewOutcome {
  if (!isRecord(document)) throw new OutcomeError("the review outcome is not a JSON object");
  if (document["spec"] !== OUTCOME_SPEC) {
    throw new OutcomeError(`the review outcome declares spec ${JSON.stringify(document["spec"])}, not ${OUTCOME_SPEC}`);
  }
  const verdict = document["verdict"];
  if (typeof verdict !== "string" || verdict === "") {
    throw new OutcomeError("the review outcome states no verdict");
  }
  const findings = document["findings"];
  if (!Array.isArray(findings) || !findings.every(isRecord)) {
    throw new OutcomeError("the review outcome's findings are not an array of objects");
  }

  const reviewers = document["reviewers"];
  if (!Array.isArray(reviewers)) throw new OutcomeError("the review outcome's reviewers are not an array");
  const parsed: ReviewerOutcome[] = [];
  const seen = new Set<string>();
  for (const entry of reviewers) {
    if (!isRecord(entry)) throw new OutcomeError("a reviewer outcome is not an object");
    const id = entry["id"];
    const result = entry["result"];
    if (typeof id !== "string" || id === "") throw new OutcomeError("a reviewer outcome names no reviewer");
    if (typeof result !== "string" || !(REVIEWER_RESULTS as readonly string[]).includes(result)) {
      throw new OutcomeError(
        `reviewer ${id} reports result ${JSON.stringify(result)}, which is not one of ${REVIEWER_RESULTS.join(", ")}`,
      );
    }
    if (seen.has(id)) throw new OutcomeError(`reviewer ${id} appears twice in the review outcome`);
    seen.add(id);
    parsed.push({ id, result: result as ReviewerResult });
  }

  // The charter set is the authority in both directions: a charter with no
  // outcome is a lens that did not review, and an outcome with no charter is a
  // reviewer this repository does not have.
  const charterSet = new Set(charters);
  const missing = charters.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new OutcomeError(
      `the review outcome leaves ${missing.length} charter(s) unrepresented: ${missing.join(", ")}`,
    );
  }
  const unknown = parsed.map((entry) => entry.id).filter((id) => !charterSet.has(id));
  if (unknown.length > 0) {
    throw new OutcomeError(
      `the review outcome names ${unknown.length} reviewer(s) no activated review lens defines: ${unknown.join(", ")}`,
    );
  }

  return { verdict, reviewers: parsed, findings: findings as Record<string, unknown>[] };
}

// ── The gate this provider serves ────────────────────────────────────────────

export interface GateBinding {
  readonly obligationId: string;
  readonly providerId: string;
}

/**
 * The obligation this manifest answers, and the provider it answers as, taken
 * from the config rather than from a constant — a provider id that has drifted
 * from the gate it serves is rejected as `unknown_provider` at evaluation, long
 * after the review it describes has been paid for.
 */
export function resolveGateBinding(config: HarnessConfig): GateBinding {
  const obligations = config.obligations.filter((obligation) =>
    obligation.acceptedPayloadSpecs.includes(REVIEW_PAYLOAD_SPEC),
  );
  if (obligations.length !== 1) {
    throw new OutcomeError(
      `the gate declares ${obligations.length} obligations accepting ${REVIEW_PAYLOAD_SPEC}; this provider serves exactly one`,
    );
  }
  const obligation = obligations[0]!;
  if (obligation.providers.length !== 1) {
    throw new OutcomeError(
      `obligation ${obligation.id} names ${obligation.providers.length} providers; this provider serves exactly one`,
    );
  }
  return { obligationId: obligation.id, providerId: obligation.providers[0]! };
}

// ── The manifest ─────────────────────────────────────────────────────────────

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

/**
 * Telemetry, derived from the findings exactly the way RG-8 re-derives it:
 * counts per severity, deferrals, and the sorted unique tracker ids they name.
 */
export function deriveTelemetry(
  findings: readonly Record<string, unknown>[],
  iterationCount: number,
): Record<string, unknown> {
  const findingCounts: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    const severity = finding["severity"];
    if (typeof severity === "string" && (SEVERITIES as readonly string[]).includes(severity)) {
      findingCounts[severity] = (findingCounts[severity] ?? 0) + 1;
    }
  }
  const deferred = findings.filter((finding) => finding["disposition"] === "deferred");
  const deferredIssueIds = [
    ...new Set(
      deferred
        .map((finding) => finding["deferredIssueId"])
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ].sort();
  return {
    iterationCount,
    findingCounts,
    deferredExpansionCount: deferred.length,
    deferredIssueIds,
  };
}

/** The reviewer lists RG-2/RG-3 read, from what each reviewer actually did. */
export function reviewerLists(
  charters: readonly string[],
  outcome: ReviewOutcome,
): { selected: string[]; completed: string[]; failed: string[]; timedOut: string[]; approved: string[] } {
  const byId = new Map(outcome.reviewers.map((reviewer) => [reviewer.id, reviewer.result]));
  const withResult = (...results: readonly ReviewerResult[]): string[] =>
    charters.filter((id) => results.includes(byId.get(id)!));
  return {
    selected: [...charters],
    completed: withResult("approved", "rejected"),
    failed: withResult("failed"),
    timedOut: withResult("timed-out"),
    approved: withResult("approved"),
  };
}

export interface EmitResult {
  readonly manifestPath: string;
  readonly runRoot: string;
}

/**
 * Capture the candidate, allocate the run root, stamp one approval per
 * approving reviewer, and write the manifest. The capture is deliberately the
 * same call the recorder makes at submission (same config, same workspace id,
 * same identity computation): anything else describes a tree the recorder will
 * refuse to recognise.
 */
export async function emitReviewEvidence(rootDir: string, document: unknown): Promise<EmitResult> {
  const configPath = path.join(rootDir, "harness.config.ts");
  const module = (await import(pathToFileURL(configPath).href)) as { default?: HarnessConfig };
  const config = module.default;
  if (config === undefined) throw new OutcomeError(`${configPath} has no default export`);

  const charters = await resolveReviewerCharters(rootDir);
  if (charters.length === 0) {
    throw new OutcomeError(
      `the compiled policy at ${COMPILED_SNAPSHOT_FILE} activates no review lens; a review with no reviewers is not a review`,
    );
  }
  const outcome = parseReviewOutcome(document, charters);
  const binding = resolveGateBinding(config);

  const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({
    rootDir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
  });
  if (!capture.ok) throw new OutcomeError(`the candidate could not be captured: ${capture.code}`);
  const captured = capture.candidate;
  const candidate = {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    headSha: captured.headSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId,
  };

  const provider = {
    id: binding.providerId,
    version: EMITTER_VERSION,
    // One emitter run is one evaluated pass over this candidate.
    runId: `r-${Date.now().toString(36)}`,
    finalPassId: "pass-1",
  };

  const artifactsPort = createArtifactsPort();
  const allocation = await artifactsPort.allocateRunRoot({ providerId: provider.id, runId: provider.runId });
  if (!allocation.ok) throw new OutcomeError(`the run root was refused: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;

  const lists = reviewerLists(charters, outcome);
  await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
  const artifacts: { path: string; sha256: string; role: string }[] = [];
  for (const reviewerId of lists.approved) {
    // §9.2: the stamp re-states the whole binding, so each approval is
    // independently interpretable in an audit.
    const stamp = `${JSON.stringify(
      {
        schemaVersion: 1,
        reviewerId,
        result: "approved",
        provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId },
        workspaceId: candidate.workspaceId,
        candidate,
      },
      null,
      2,
    )}\n`;
    const relativePath = `reviewers/${reviewerId}.json`;
    await writeFile(path.join(runRoot, relativePath), stamp, "utf8");
    artifacts.push({ path: relativePath, sha256: sha256Hex(stamp), role: "reviewer-approval" });
  }

  const runHistory = [{ preparedTreeSha: captured.treeSha, evaluatedInPassId: provider.finalPassId }];
  const manifest = {
    spec: ENVELOPE_SPEC,
    provider,
    candidate,
    repository: null,
    runHistory,
    artifacts,
    attestation: { level: "self", signatures: [] },
    recordedAt: new Date().toISOString(),
    claims: [
      {
        obligation: binding.obligationId,
        payloadSpec: REVIEW_PAYLOAD_SPEC,
        payload: {
          verdict: outcome.verdict,
          finalized: true,
          editedAfterFinalPass: false,
          reviewers: {
            selected: lists.selected,
            completed: lists.completed,
            failed: lists.failed,
            timedOut: lists.timedOut,
          },
          findings: outcome.findings,
          telemetry: deriveTelemetry(outcome.findings, runHistory.length),
        },
      },
    ],
  };

  const manifestPath = path.join(runRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, runRoot };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  stream.setEncoding("utf8");
  for await (const chunk of stream) chunks.push(chunk as string);
  return chunks.join("");
}

async function main(): Promise<void> {
  const raw = await readAll(process.stdin);
  if (raw.trim() === "") {
    process.stderr.write(
      `emit-review-evidence: the ${OUTCOME_SPEC} review outcome is read from standard input, and none was given\n`,
    );
    process.exitCode = 2;
    return;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(
      `emit-review-evidence: the review outcome is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  try {
    const result = await emitReviewEvidence(process.cwd(), document);
    process.stdout.write(`${result.manifestPath}\n`);
  } catch (error) {
    process.stderr.write(`emit-review-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof OutcomeError ? 2 : 1;
  }
}

/** The spelling the filesystem can vouch for, so a symlinked temp root still matches. */
function canonicalEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  canonicalEntryPath(path.resolve(process.argv[1])) === canonicalEntryPath(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
