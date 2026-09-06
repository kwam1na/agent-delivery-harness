/**
 * The shipped review-outcome evidence writer. It transcribes concluded host
 * results without running reviewers or upgrading their self-attestation.
 *
 * Capture `delivery-harness review-context --json` before review, then pass
 * that original document to `emit-review-evidence --context <path>` with a
 * review-outcome/1 document on stdin naming its contextDigest. Reviewer names
 * come from the resolved activated charters; for example a named result is
 * `{ "id": "outcome-correctness", "result": "rejected" }`.
 *
 * The raw context and outcome remain digest-bound artifacts. Submission is
 * still the authority on whether the resulting evidence satisfies the gate.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PERSONA_MANIFEST_ENTRY,
  PERSONA_MANIFEST_SPEC,
  BlockedError,
  digestCanonical,
  evaluatePreparationReceipt,
  sha256Hex,
  type CapturedCandidate,
  type PreparationReceipt,
  type HarnessConfig,
} from "@agent-delivery-harness/kernel";
import type { CommandContext } from "./boundary.ts";

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
    resolved.push({ lensId: lens["lensId"], reviewerId, personaId, entryPath, digest });
  }
  return resolved;
}

/** The reviewer ids of `resolveActivatedCharters`, sorted, as the evidence lists them. */
export async function resolveReviewerCharters(rootDir: string): Promise<string[]> {
  return (await resolveActivatedCharters(rootDir)).map((charter) => charter.reviewerId).sort();
}

/** Exact review input, retained by the host before acquiring any outcomes. */
export const REVIEW_CONTEXT_SPEC = "review-context/1";

function manifestCandidate(captured: CapturedCandidate) {
  return {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    headSha: captured.headSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId,
  };
}

export async function buildReviewContext(
  rootDir: string,
  config: HarnessConfig,
  candidate: CapturedCandidate,
  receipt: PreparationReceipt,
) {
  const charters = await resolveActivatedCharters(rootDir);
  if (charters.length === 0) throw new OutcomeError("the compiled policy activates no review lens");
  const active = await readJsonFile(path.join(rootDir, ".agent-skills/active.json"), "the installed workflow receipt");
  const release = isRecord(active) ? active["release"] : undefined;
  if (!isRecord(release) || typeof release["releaseId"] !== "string" || !release["releaseId"] ||
      typeof release["profile"] !== "string" || !release["profile"] ||
      !["archiveSha256", "metadataSha256"].every((key) => typeof release[key] === "string" && /^[a-f0-9]{64}$/.test(release[key] as string))) {
    throw new OutcomeError("the installed workflow receipt has no exact release identity");
  }
  const binding = {
    gate: resolveGateBinding(config),
    candidate: manifestCandidate(candidate),
    preparationFingerprint: receipt.preparationFingerprint,
    configurationDigest: digestCanonical(config),
    policyDigest: sha256Hex(await readFile(path.join(rootDir, COMPILED_SNAPSHOT_FILE))),
    release,
    workflowGraphSha256: sha256Hex(await readFile(path.join(rootDir, INSTALLED_ARCHIVE_DIR, "workflows/delivery-v1.json"))),
    charters,
  };
  return { spec: REVIEW_CONTEXT_SPEC, digest: digestCanonical(binding), binding };
}

export type ReviewContextDocument = Awaited<ReturnType<typeof buildReviewContext>>;

/** Reuse only the existing deliverable identity, with base, policy and wiring fixed. */
export function validateReviewedContext(original: unknown, current: ReviewContextDocument, outcome: unknown): void {
  if (!isRecord(original) || original["spec"] !== REVIEW_CONTEXT_SPEC ||
      Object.keys(original).sort().join(",") !== "binding,digest,spec" || !isRecord(original["binding"]) ||
      original["digest"] !== digestCanonical(original["binding"])) {
    throw new OutcomeError("the original review context is missing, malformed, or has a mismatched digest");
  }
  if (!isRecord(outcome) || outcome["contextDigest"] !== original["digest"]) {
    throw new OutcomeError("the outcome does not name the original review context digest");
  }
  const binding = original["binding"];
  const candidate = binding["candidate"];
  if (!isRecord(candidate) || !["treeSha", "headSha"].every((key) =>
    typeof candidate[key] === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate[key] as string))) {
    throw new OutcomeError("the original review context names no valid candidate");
  }
  // Raw tree and head may move when only review-neutral paths changed. Keep
  // the original coordinates in the retained context, while the manifest binds
  // the current prepared candidate, exactly as submission requires.
  const comparable = {
    ...binding,
    candidate: { ...candidate, treeSha: current.binding.candidate.treeSha, headSha: current.binding.candidate.headSha },
  };
  if (digestCanonical(comparable) !== digestCanonical(current.binding)) {
    throw new OutcomeError("the reviewed context differs from the current candidate, base, policy, wiring, release, or charters; acquire review for the current context");
  }
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
  readonly runHistory?: readonly Record<string, unknown>[];
  readonly finalPassId?: string;
  readonly cost?: Readonly<Record<string, unknown>>;
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
  const named: ReviewerOutcome[] = [];
  const unnamed: ReviewerResult[] = [];
  const seen = new Set<string>();
  for (const entry of reviewers) {
    if (!isRecord(entry)) throw new OutcomeError("a reviewer outcome is not an object");
    const id = entry["id"];
    const result = entry["result"];
    // An absent id is the unnamed form, resolved below. A present one that is
    // not a usable id is still a document naming a reviewer it cannot name.
    const carriesId = id !== undefined;
    if (carriesId && (typeof id !== "string" || id === "")) {
      throw new OutcomeError("a reviewer outcome names no reviewer");
    }
    const subject = carriesId ? `reviewer ${id as string}` : "an unnamed reviewer outcome";
    if (typeof result !== "string" || !(REVIEWER_RESULTS as readonly string[]).includes(result)) {
      throw new OutcomeError(
        `${subject} reports result ${JSON.stringify(result)}, which is not one of ${REVIEWER_RESULTS.join(", ")}`,
      );
    }
    if (!carriesId) {
      unnamed.push(result as ReviewerResult);
      continue;
    }
    const reviewerId = id as string;
    if (seen.has(reviewerId)) throw new OutcomeError(`reviewer ${reviewerId} appears twice in the review outcome`);
    seen.add(reviewerId);
    named.push({ id: reviewerId, result: result as ReviewerResult });
  }

  // ── The unnamed form ───────────────────────────────────────────────────────
  //
  // The ids are this emitter's to resolve, not the caller's to restate: they
  // are charter-path basenames inside an installed archive that the compiled
  // policy selects from, and a caller who restates them is performing the same
  // resolution a second time with no way to check the answer. So an outcome
  // may carry results alone and take `charters` as its ids.
  //
  // It may not, however, DISTINGUISH its reviewers without naming them.
  // Nothing in the document says which result belongs to which lens, so the
  // assignment can only be positional — and a positional assignment that
  // matters is one where the wrong reviewer is silently stamped approved while
  // the one that failed is reported clean. Refusing every disagreeing unnamed
  // document keeps position load-bearing for nothing: the results are
  // interchangeable exactly when the order cannot matter.
  if (unnamed.length > 0) {
    if (named.length > 0) {
      throw new OutcomeError(
        `the review outcome names ${named.length} of its ${reviewers.length} reviewers and leaves the rest unnamed; a document that distinguishes its reviewers names every one of them`,
      );
    }
    if (unnamed.length !== charters.length) {
      throw new OutcomeError(
        `the review outcome carries ${unnamed.length} result(s) under no reviewer id, and the policy selects ${charters.length} reviewer(s): ${charters.join(", ")}`,
      );
    }
    const distinct = [...new Set(unnamed)];
    if (distinct.length > 1) {
      throw new OutcomeError(
        `the review outcome's unnamed results disagree (${distinct.join(", ")}), so which reviewer reported which would be decided by their order; name the reviewers instead`,
      );
    }
    for (const [index, result] of unnamed.entries()) {
      const reviewerId = charters[index]!;
      seen.add(reviewerId);
      named.push({ id: reviewerId, result });
    }
  }
  const parsed = named;

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

  const runHistory = document["runHistory"];
  const finalPassId = document["finalPassId"];
  if (runHistory !== undefined && (!Array.isArray(runHistory) || runHistory.length === 0 || !runHistory.every(isRecord) ||
      typeof finalPassId !== "string" || finalPassId === "")) {
    throw new OutcomeError("review runHistory requires a nonempty history and its actual finalPassId");
  }
  const cost = document["cost"];
  if (cost !== undefined && (!isRecord(cost) || typeof document["costCoverage"] !== "string" || !document["costCoverage"].trim())) {
    throw new OutcomeError("reported review cost requires an explicit costCoverage description");
  }
  return {
    verdict, reviewers: parsed, findings: findings as Record<string, unknown>[],
    ...(runHistory === undefined ? {} : { runHistory: runHistory as Record<string, unknown>[], finalPassId: finalPassId as string }),
    ...(cost === undefined ? {} : { cost: cost as Record<string, unknown> }),
  };
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
export async function emitReviewEvidence(context: CommandContext, original: unknown, document: unknown): Promise<EmitResult> {
  const { rootDir, config } = context;
  const wiring = await context.wire();
  const capture = await wiring.captureCandidate();
  if (!capture.ok) throw new OutcomeError(`the candidate could not be captured: ${capture.code}`);
  const captured = capture.candidate;
  const preparation = await evaluatePreparationReceipt(rootDir, { config, candidate: captured }, wiring.storageOptions);
  if (!preparation.prepared) throw new BlockedError([...preparation.blockers]);
  const current = await buildReviewContext(rootDir, config, captured, preparation.receipt);
  validateReviewedContext(original, current, document);
  const charters = current.binding.charters.map((charter) => charter.reviewerId).sort();
  const outcome = parseReviewOutcome(document, charters);
  const binding = current.binding.gate;
  const candidate = manifestCandidate(captured);

  const provider = {
    id: binding.providerId,
    version: EMITTER_VERSION,
    // One emitter run is one evaluated pass over this candidate.
    runId: `r-${randomUUID()}`,
    finalPassId: outcome.finalPassId ?? "pass-1",
  };
  const reviewed = original as ReviewContextDocument;
  const originalRunHistory = outcome.runHistory ?? [{
    preparedTreeSha: reviewed.binding.candidate.treeSha,
    evaluatedInPassId: provider.finalPassId,
  }];
  const finalEntry = originalRunHistory.at(-1)!;
  if (finalEntry["preparedTreeSha"] !== reviewed.binding.candidate.treeSha ||
      finalEntry["evaluatedInPassId"] !== provider.finalPassId) {
    throw new OutcomeError("the supplied final review pass does not name the original reviewed candidate");
  }
  // ENV-9's final tree is a preparation coordinate. A proven neutral reuse
  // projects that coordinate without claiming the reviewers saw a new raw
  // tree, adding a round, or overwriting their original history.
  const runHistory = originalRunHistory.map((entry, index) => index === originalRunHistory.length - 1
    ? { ...entry, preparedTreeSha: captured.treeSha } : entry);

  const allocation = await context.artifacts.allocateRunRoot({ providerId: provider.id, runId: provider.runId });
  if (!allocation.ok) throw new OutcomeError(`the run root was refused: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;

  const lists = reviewerLists(charters, outcome);
  await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
  const artifacts: { path: string; sha256: string; role: string }[] = [];
  for (const [name, value] of [["review-context", original], ["review-outcome", document]] as const) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path.join(runRoot, `${name}.json`), bytes, "utf8");
    artifacts.push({ path: `${name}.json`, sha256: sha256Hex(bytes), role: name });
  }
  if (digestCanonical(reviewed.binding.candidate) !== digestCanonical(candidate)) {
    const bytes = `${JSON.stringify({
      spec: "review-context-projection/1",
      basis: "unchanged-deliverable-and-review-inputs",
      originalContextDigest: reviewed.digest,
      reviewedCandidate: reviewed.binding.candidate,
      preparedCandidate: candidate,
      originalRunHistory,
      reviewRoundAdded: false,
    }, null, 2)}\n`;
    await writeFile(path.join(runRoot, "review-context-projection.json"), bytes, "utf8");
    artifacts.push({ path: "review-context-projection.json", sha256: sha256Hex(bytes), role: "review-context-projection" });
  }
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
          telemetry: { ...deriveTelemetry(outcome.findings, runHistory.length), ...(outcome.cost === undefined ? {} : { cost: outcome.cost }) },
        },
      },
    ],
  };

  const manifestPath = path.join(runRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, runRoot };
}
