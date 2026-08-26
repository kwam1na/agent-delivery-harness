/**
 * The conformance kit harness.
 *
 * The kit is the validator's test suite, not an illustration of it: 89 golden
 * vectors, each self-contained, each with an expectation a conforming validator
 * must produce. This module runs them and reports what happened. It decides
 * nothing about the spec — every judgement belongs to the kernel validator, and
 * a vector that fails here is a validator defect or a kit disagreement, never
 * something to soften.
 *
 * UNIT MODE. The validator is pure: it judges a manifest against a repository
 * configuration and the candidate observation the caller supplies. Five vectors
 * expect outcomes that belong to the recorder's surface — the run root it
 * allocates, the record store a second submission collides with, and the
 * artifact bytes it verifies through its fs port. That is a scope boundary, not
 * a limit of what a manifest expresses, and integration mode is where those five
 * are covered. In unit mode they are enumerated by name in
 * `RECORDER_DEPENDENT_VECTORS` and skipped, loudly: a name that has vanished
 * from the kit fails the run rather than quietly reducing coverage, which is the
 * failure mode an unnamed skip list has.
 *
 * INTEGRATION MODE. The kit README's "Running a vector" protocol, performed for
 * real: a run root is allocated for `provider.runId`, every artifact is
 * materialized at its path with the vector's exact bytes, the manifest is placed
 * inside that root, and the whole thing is submitted through the recorder. All
 * 89 vectors are decided — nothing is skipped — and the assertions are wider
 * than unit mode's, because there is now state to check. An accepted submission
 * must have written exactly one record per claim, all stamped with the manifest
 * digest; a rejected one must have written none at all (GEN-3). The two
 * multi-step vectors get the extra protocol their `extra` member declares.
 *
 * WHAT INTEGRATION MODE STUBS, AND WHAT IT DOES NOT. Candidate capture is a
 * port, and the vectors declare what it returns — that is the one substitution,
 * and it is the one the kit's `environment.currentCandidate` exists to make.
 * Everything else is the real thing: a real preparation receipt published into a
 * real store, real bytes in a real run root, real records linked into place by
 * the record store's own atomic publication.
 *
 * CONFIGURATION IS A PARAMETER. The kit ships its own repository configuration
 * and the vectors are bound to it, so it is the default — but it arrives through
 * `options.config`, never through an import inside a rule. That is what lets the
 * same run be re-driven under the kit-variant configuration to show the
 * validator's outcomes follow the spec and the vectors rather than one config's
 * incidental values.
 *
 * EXPECTATION SEMANTICS (kit README). An accept vector must produce no codes at
 * all. A reject vector must produce **every** code it lists — the listed codes
 * are a floor, not a ceiling, because several vectors violate more than one rule
 * by construction and SUB-5 requires reporting all violations. A code the
 * registry does not know is a failure of this harness, not a tolerated extra:
 * an unregistered code means the validator invented vocabulary.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createArtifactsPort,
  isManifestRejectionCode,
  publishPreparationReceipt,
  submitManifest,
  validateManifest,
  type CandidateCapture,
  type CapturedCandidate,
  type HarnessConfig,
  type SubmissionOutcome,
} from "@delivery-harness/kernel";
import { loadKitRepoConfig } from "../fixtures/repo-config-adapter.ts";

// ── The kit's own shapes ───────────────────────────────────────────────────

export interface KitExpectation {
  readonly result: "accepted" | "rejected";
  readonly codes?: readonly string[];
  readonly notes?: string;
}

export interface KitVector {
  readonly vectorVersion: number;
  readonly id: string;
  readonly title: string;
  readonly rules: readonly string[];
  readonly provenance: string;
  readonly expect: KitExpectation;
  readonly environment?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly manifest: unknown;
}

export interface KitIndexEntry {
  readonly id: string;
  readonly file: string;
  readonly title: string;
  readonly rules: readonly string[];
  readonly expect: KitExpectation;
}

export interface KitIndex {
  readonly kit: string;
  readonly spec: string;
  readonly payloadSpecs: readonly string[];
  readonly counts: { readonly total: number; readonly accept: number; readonly reject: number };
  readonly vectors: readonly KitIndexEntry[];
}

export interface KitEnvironment {
  readonly currentCandidate: unknown;
  readonly workspaceId: string;
  readonly prepared: boolean;
}

/** Environment members a vector may override. Anything else is a kit change this harness has not been taught. */
const ENVIRONMENT_OVERRIDES: readonly string[] = ["currentCandidate", "prepared", "manifestLocation"];

/** Overrides that describe recorder-owned state; legal only on a deferred vector. */
const RECORDER_ONLY_OVERRIDES: readonly string[] = ["manifestLocation"];

// ── The deferred five ──────────────────────────────────────────────────────

export interface DeferredVector {
  readonly id: string;
  /** What the vector needs that a pure validator does not have. */
  readonly reason: string;
}

/**
 * The vectors whose expectation lands on the recorder's surface. Each was
 * classified by reading the vector: what it overrides, what protocol it declares
 * in `extra`, and which code it expects. All five are covered in integration
 * mode, where the recorder allocates a run root, materializes the bytes, and
 * publishes records.
 */
export const RECORDER_DEPENDENT_VECTORS: readonly DeferredVector[] = Object.freeze([
  Object.freeze({
    id: "a-idempotent-resubmission",
    reason: "extra.submitTwice — the claim is about record ids being identical across two submissions, so it is a claim about records the recorder writes",
  }),
  Object.freeze({
    id: "sub-4-record-conflict",
    reason: "extra.submitFirst — record_conflict is a collision with an already-published record",
  }),
  Object.freeze({
    id: "sub-3-manifest-outside-run-root",
    reason: "environment.manifestLocation — manifest_outside_run_root needs a real recorder-allocated run root to be outside of",
  }),
  Object.freeze({
    id: "env-10-artifact-missing-file",
    reason: "artifact_digest_mismatch — the vector's point is an entry naming a file the run root does not contain, and ENV-11 is verified by the recorder's fs port against the files it materialized, not against a caller-assembled map of strings",
  }),
  Object.freeze({
    id: "env-11-artifact-digest-mismatch",
    reason: "artifact_digest_mismatch — the same boundary: ENV-11 compares each declared digest against the file's bytes at submission, which is the recorder's fs port doing a filesystem operation",
  }),
]);

const DEFERRED_IDS: ReadonlySet<string> = new Set(RECORDER_DEPENDENT_VECTORS.map((vector) => vector.id));

// ── Loading ────────────────────────────────────────────────────────────────

/** The vendored kit root, resolved from this module rather than from a cwd. */
export function kitRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vectors");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadKitIndex(root: string = kitRoot()): KitIndex {
  return readJson(path.join(root, "kit.json")) as KitIndex;
}

export function loadKitEnvironment(root: string = kitRoot()): KitEnvironment {
  return readJson(path.join(root, "context", "environment.json")) as KitEnvironment;
}

export function loadKitVectors(root: string = kitRoot()): readonly KitVector[] {
  return loadKitIndex(root).vectors.map((entry) => readJson(path.join(root, entry.file)) as KitVector);
}

// ── Outcomes ───────────────────────────────────────────────────────────────

export type KitOutcomeStatus = "passed" | "failed" | "skipped";

export interface KitOutcome {
  readonly id: string;
  readonly status: KitOutcomeStatus;
  /** Codes the validator produced, in emission order. Empty for an accepted submission. */
  readonly codes: readonly string[];
  /** Why the vector failed. Empty when it passed or was skipped. */
  readonly failures: readonly string[];
  /** Present on a skipped vector: why it is deferred. */
  readonly reason?: string;
}

export interface KitRunResult {
  readonly outcomes: readonly KitOutcome[];
  readonly passed: readonly string[];
  readonly failed: readonly KitOutcome[];
  readonly skipped: readonly string[];
}

export interface ValidatorOutcome {
  readonly accepted: boolean;
  readonly codes: readonly string[];
}

/**
 * The kit's expectation semantics, as a function, so the semantics themselves
 * can be tested against synthetic outcomes rather than only observed through
 * whichever vectors happen to exercise them.
 */
export function compareOutcome(expect: KitExpectation, actual: ValidatorOutcome): readonly string[] {
  const failures: string[] = [];

  for (const code of actual.codes) {
    if (!isManifestRejectionCode(code)) {
      failures.push(`validator emitted "${code}", which is not in the rejection-code registry`);
    }
  }

  if (expect.result === "accepted") {
    if (!actual.accepted) {
      failures.push(`expected acceptance, got rejection with [${actual.codes.join(", ")}]`);
    } else if (actual.codes.length > 0) {
      // An acceptance carrying codes is a contradiction in the validator, not a
      // lenient pass: the kit says an accepted submission has no codes at all.
      failures.push(`an accepted submission must carry no rejection codes, got [${actual.codes.join(", ")}]`);
    }
    return failures;
  }

  if (actual.accepted) {
    failures.push(`expected rejection with [${(expect.codes ?? []).join(", ")}], got acceptance`);
    return failures;
  }

  // The listed codes are the floor, not the ceiling.
  for (const code of expect.codes ?? []) {
    if (!actual.codes.includes(code)) {
      failures.push(`expected code "${code}" is missing; got [${actual.codes.join(", ")}]`);
    }
  }
  return failures;
}

// ── Running ────────────────────────────────────────────────────────────────

export interface KitRunOptions {
  /** Repository configuration the vectors are judged under. Defaults to the kit's own, via the adapter. */
  readonly config?: HarnessConfig;
  /** Kit root override, for tests that drive a synthetic corpus. */
  readonly root?: string;
}

/** Runs one vector through the validator and reports what the validator produced. */
export function evaluateVector(vector: KitVector, config: HarnessConfig, environment: KitEnvironment): ValidatorOutcome {
  const overrides = vector.environment ?? {};
  for (const key of Object.keys(overrides)) {
    if (!ENVIRONMENT_OVERRIDES.includes(key)) {
      throw new Error(`vector ${vector.id} overrides unknown environment member "${key}"`);
    }
    if (RECORDER_ONLY_OVERRIDES.includes(key) && !DEFERRED_IDS.has(vector.id)) {
      throw new Error(`vector ${vector.id} overrides recorder-owned environment member "${key}" but is not deferred`);
    }
  }

  const currentCandidate = Object.prototype.hasOwnProperty.call(overrides, "currentCandidate")
    ? overrides["currentCandidate"]
    : environment.currentCandidate;
  const prepared = Object.prototype.hasOwnProperty.call(overrides, "prepared") ? overrides["prepared"] === true : environment.prepared;

  const result = validateManifest(vector.manifest, {
    config,
    currentCandidate,
    prepared,
    artifactContents: new Map(Object.entries(vector.artifacts ?? {})),
  });

  return result.ok ? { accepted: true, codes: [] } : { accepted: false, codes: result.rejections.map((rejection) => rejection.code) };
}

export function runKitUnitMode(options: KitRunOptions = {}): KitRunResult {
  const root = options.root ?? kitRoot();
  const config = options.config ?? loadKitRepoConfig();
  const environment = loadKitEnvironment(root);
  const vectors = loadKitVectors(root);

  const present = new Set(vectors.map((vector) => vector.id));
  for (const deferred of RECORDER_DEPENDENT_VECTORS) {
    if (!present.has(deferred.id)) {
      throw new Error(`deferred vector "${deferred.id}" is not in the kit; a skip list may never outlive the vector it names`);
    }
  }

  const outcomes: KitOutcome[] = [];
  for (const vector of vectors) {
    const deferred = RECORDER_DEPENDENT_VECTORS.find((entry) => entry.id === vector.id);
    if (deferred !== undefined) {
      outcomes.push({ id: vector.id, status: "skipped", codes: [], failures: [], reason: deferred.reason });
      continue;
    }
    // A validator that throws is a failed vector, not a failed run: one
    // vector's crash must not cost the report on the other 83.
    let actual: ValidatorOutcome;
    let failures: readonly string[];
    try {
      actual = evaluateVector(vector, config, environment);
      failures = compareOutcome(vector.expect, actual);
    } catch (error) {
      actual = { accepted: false, codes: [] };
      failures = [`validator threw: ${error instanceof Error ? error.message : String(error)}`];
    }
    outcomes.push({
      id: vector.id,
      status: failures.length === 0 ? "passed" : "failed",
      codes: actual.codes,
      failures,
    });
  }

  return {
    outcomes,
    passed: outcomes.filter((outcome) => outcome.status === "passed").map((outcome) => outcome.id),
    failed: outcomes.filter((outcome) => outcome.status === "failed"),
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.id),
  };
}

/** One line per failing vector, for a test failure message that names what broke. */
export function describeFailures(result: KitRunResult): string {
  return result.failed.map((outcome) => `${outcome.id}: ${outcome.failures.join("; ")}`).join("\n");
}

// ── Integration mode ───────────────────────────────────────────────────────

/**
 * The submission environment one vector runs in.
 *
 * Every vector gets its own, and that is not merely hygiene: run roots are
 * keyed by provider and run id, and the whole corpus shares one run id, so a
 * single shared base directory would have 89 vectors overwriting each other's
 * artifacts. The base is an injected port parameter for exactly this reason.
 */
interface VectorWorkspace {
  /** The repository root: where wiring files live and where stores are resolved from. */
  readonly rootDir: string;
  /** The injected evidence/receipt storage root, so no git repository is needed. */
  readonly storageRoot: string;
  /** The base run roots are allocated under. */
  readonly runRootBase: string;
  /** Where a manifest goes when it must not be inside the run root. */
  readonly outsideDir: string;
}

async function createWorkspace(base: string, config: HarnessConfig): Promise<VectorWorkspace> {
  const rootDir = path.join(base, "workspace");
  const workspace: VectorWorkspace = {
    rootDir,
    storageRoot: path.join(base, "store"),
    runRootBase: path.join(base, "runs"),
    outsideDir: path.join(base, "outside"),
  };
  await mkdir(workspace.rootDir, { recursive: true });
  await mkdir(workspace.storageRoot, { recursive: true });
  await mkdir(workspace.runRootBase, { recursive: true });
  await mkdir(workspace.outsideDir, { recursive: true });

  // The declared wiring files must exist before a receipt can be published: a
  // wiring path that is not a readable file is a typed blocker, never a hashed
  // absence. Their contents are irrelevant to every vector — what matters is
  // that the fingerprint has something real to be over.
  for (const repoPath of config.preparationWiringPaths) {
    const target = path.resolve(workspace.rootDir, repoPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `// conformance wiring fixture: ${repoPath}\n`, "utf8");
  }
  return workspace;
}

/**
 * The vector's declared `currentCandidate`, in the shape a capture returns.
 *
 * `mode` and the two observation lists are not vector data: the kit describes a
 * candidate's *coordinates*, and a prepared workspace is clean by construction.
 * A vector missing a coordinate is a kit change this harness has not been
 * taught, so it throws rather than substituting a default that would quietly
 * change what SUB-1 compares.
 */
export function capturedFromKitCandidate(value: unknown, vectorId: string): CapturedCandidate {
  const read = (holder: unknown, name: string): unknown =>
    typeof holder === "object" && holder !== null && !Array.isArray(holder) ? (holder as Record<string, unknown>)[name] : undefined;
  const readString = (holder: unknown, name: string, at: string): string => {
    const member = read(holder, name);
    if (typeof member !== "string") {
      throw new Error(`vector ${vectorId}: currentCandidate.${at} is not a string; the kit's environment shape has changed`);
    }
    return member;
  };

  const deliverable = read(value, "deliverable");
  const base = read(value, "base");
  return {
    vcs: readString(value, "vcs", "vcs") as CapturedCandidate["vcs"],
    treeSha: readString(value, "treeSha", "treeSha"),
    headSha: readString(value, "headSha", "headSha"),
    deliverable: {
      digest: readString(deliverable, "digest", "deliverable.digest"),
      identity: readString(deliverable, "identity", "deliverable.identity"),
    },
    base: {
      ref: readString(base, "ref", "base.ref"),
      tipSha: readString(base, "tipSha", "base.tipSha"),
      mergeBaseSha: readString(base, "mergeBaseSha", "base.mergeBaseSha"),
    },
    workspaceId: readString(value, "workspaceId", "workspaceId"),
    mode: "clean",
    statusEntries: [],
    untrackedFiles: [],
  };
}

/**
 * The unprepared capture. `prepared: false` in the kit means the capture reports
 * an unprepared state — not that a caller passed a flag — so this is what the
 * port returns, and SUB-2's rejection follows from it rather than from a switch.
 */
const UNPREPARED_CAPTURE: CandidateCapture = {
  ok: false,
  code: "candidate_unprepared",
  blockers: [
    {
      code: "candidate_unprepared",
      source: { kind: "candidate", id: "conformance" },
      summary: "The workspace is not in a prepared state.",
      remediations: [{ id: "prepare-the-candidate", kind: "manual_action", summary: "Stage or commit the work and prepare again." }],
    },
  ],
};

/** How many record files the store holds, across every gate and obligation. */
async function countRecords(storageRoot: string): Promise<number> {
  try {
    const entries = await readdir(path.join(storageRoot, "records"));
    // Publisher temporaries are dot-prefixed and are not records.
    return entries.filter((entry) => !entry.startsWith(".")).length;
  } catch {
    return 0;
  }
}

interface SubmissionAttempt {
  readonly outcome: SubmissionOutcome;
  /** Records in the store before this submission ran. */
  readonly recordsBefore: number;
  readonly recordsAfter: number;
}

/** The kit's outcome view of a submission. A blocked submission has no codes to compare. */
function outcomeOf(outcome: SubmissionOutcome): ValidatorOutcome | null {
  if (outcome.status === "accepted") return { accepted: true, codes: [] };
  if (outcome.status === "rejected") return { accepted: false, codes: outcome.rejections.map((rejection) => rejection.code) };
  return null;
}

function blockedCodes(outcome: SubmissionOutcome): readonly string[] {
  return outcome.status === "blocked" ? outcome.blockers.map((blocker) => blocker.code) : [];
}

/**
 * Runs one vector's submission protocol and reports what happened at each step.
 *
 * The materialization rules are the kit README's. An artifact path that is
 * itself invalid is part of the vector's point, so it is *not* materialized —
 * writing `../outside.json` would put a file outside the run root to prove that
 * a path outside the run root is rejected, which proves nothing and litters the
 * temp directory. The validator rejects those on shape before any file access.
 */
async function submitVector(
  vector: KitVector,
  config: HarnessConfig,
  environment: KitEnvironment,
  base: string,
): Promise<readonly SubmissionAttempt[]> {
  const workspace = await createWorkspace(base, config);
  const artifacts = createArtifactsPort({ runRootBase: workspace.runRootBase });

  const overrides = vector.environment ?? {};
  const currentCandidate = Object.prototype.hasOwnProperty.call(overrides, "currentCandidate")
    ? overrides["currentCandidate"]
    : environment.currentCandidate;
  const prepared = Object.prototype.hasOwnProperty.call(overrides, "prepared") ? overrides["prepared"] === true : environment.prepared;
  const outsideRunRoot = overrides["manifestLocation"] === "outside-run-root";

  const captured = capturedFromKitCandidate(currentCandidate, vector.id);
  const capture: CandidateCapture = prepared ? { ok: true, candidate: captured } : UNPREPARED_CAPTURE;

  // A real receipt for the candidate the capture reports. Without one the
  // recorder blocks before it judges anything, which is the ordering U16
  // installed; publishing it here is what a prepare step does in production.
  if (prepared) {
    await publishPreparationReceipt(workspace.rootDir, { config, candidate: captured }, { storageRoot: workspace.storageRoot });
  }

  const provider = (vector.manifest as { provider?: { id?: unknown; runId?: unknown } }).provider ?? {};
  const allocation =
    typeof provider.id === "string" && typeof provider.runId === "string"
      ? await artifacts.allocateRunRoot({ providerId: provider.id, runId: provider.runId })
      : ({ ok: false } as const);

  // A run id the port refuses is a run root that does not exist. The manifest
  // still has to live somewhere, and outside is the truthful place for it.
  const runRootPath = allocation.ok ? allocation.runRoot.path : workspace.outsideDir;

  for (const [declaredPath, contents] of Object.entries(vector.artifacts ?? {})) {
    const segments = declaredPath.split(/[/\\]/);
    if (declaredPath.startsWith("/") || segments.includes("..") || segments.includes("")) continue;
    const target = path.join(runRootPath, declaredPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }

  const manifestPath = path.join(outsideRunRoot ? workspace.outsideDir : runRootPath, "manifest.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });

  const submissions: unknown[] = [];
  const extra = vector.extra ?? {};
  if (Object.prototype.hasOwnProperty.call(extra, "submitFirst")) submissions.push(extra["submitFirst"]);
  submissions.push(vector.manifest);
  if (extra["submitTwice"] === true) submissions.push(vector.manifest);

  const attempts: SubmissionAttempt[] = [];
  for (const manifest of submissions) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const recordsBefore = await countRecords(workspace.storageRoot);
    const outcome = await submitManifest(
      { rootDir: workspace.rootDir, manifestPath, config },
      { captureCandidate: async () => capture, artifacts, storageRoot: workspace.storageRoot },
    );
    attempts.push({ outcome, recordsBefore, recordsAfter: await countRecords(workspace.storageRoot) });
  }
  return attempts;
}

/**
 * The assertions integration mode adds to the kit's expectation semantics.
 *
 * Unit mode can only compare codes. Here the submission left a store behind, so
 * the claims the spec makes about that store are checkable: SUB-4's one record
 * per claim, each stamped with the shared manifest digest, and GEN-3's promise
 * that a rejected submission wrote nothing at all.
 */
function verifyEffects(vector: KitVector, attempt: SubmissionAttempt): readonly string[] {
  const failures: string[] = [];
  const { outcome, recordsBefore, recordsAfter } = attempt;

  if (outcome.status === "accepted") {
    const claims = (vector.manifest as { claims?: readonly { obligation?: unknown }[] }).claims ?? [];
    const obligations = claims.map((claim) => claim.obligation);
    const written = outcome.records.map((record) => record.obligationId);
    if (written.length !== obligations.length || obligations.some((id) => !written.includes(id as string))) {
      failures.push(`expected one record per claim [${obligations.join(", ")}], got [${written.join(", ")}]`);
    }
    for (const record of outcome.records) {
      if (record.record.resolution.kind !== "evidence" || record.record.resolution.manifestDigest !== outcome.manifestDigest) {
        failures.push(`record for ${record.obligationId} is not stamped with the submission's manifest digest`);
      }
    }
    if (recordsAfter < recordsBefore) failures.push("an accepted submission removed records from the store");
    return failures;
  }

  if (outcome.status === "rejected" && recordsAfter !== recordsBefore) {
    // GEN-3 and SUB-5 both say it: a rejection writes nothing.
    failures.push(`a rejected submission changed the store from ${recordsBefore} to ${recordsAfter} records`);
  }
  return failures;
}

/** The extra protocol the two multi-step vectors declare, checked across attempts. */
function verifyMultiStep(vector: KitVector, attempts: readonly SubmissionAttempt[]): readonly string[] {
  const failures: string[] = [];
  const extra = vector.extra ?? {};

  if (extra["submitTwice"] === true) {
    const [first, second] = attempts;
    if (first === undefined || second === undefined) return ["submitTwice expects two submissions"];
    if (first.outcome.status !== "accepted" || second.outcome.status !== "accepted") {
      return [`both submissions must succeed; got ${first.outcome.status} then ${second.outcome.status}`];
    }
    const firstIds = first.outcome.records.map((record) => record.recordId).sort();
    const secondIds = second.outcome.records.map((record) => record.recordId).sort();
    if (firstIds.join(",") !== secondIds.join(",")) {
      failures.push(`record ids differ across identical submissions: [${firstIds.join(", ")}] then [${secondIds.join(", ")}]`);
    }
    if (second.outcome.records.some((record) => record.status !== "idempotent")) {
      failures.push("the second identical submission published a new record instead of finding its own");
    }
    if (second.recordsAfter !== second.recordsBefore) {
      failures.push("an idempotent resubmission changed how many records the store holds");
    }
  }

  if (Object.prototype.hasOwnProperty.call(extra, "submitFirst")) {
    const [first] = attempts;
    if (first === undefined) return ["submitFirst expects a preceding submission"];
    if (first.outcome.status !== "accepted") {
      failures.push(`extra.submitFirst must be accepted before the vector's manifest; it was ${first.outcome.status}`);
    }
  }

  return failures;
}

export interface KitIntegrationOptions extends KitRunOptions {
  /** Where per-vector workspaces are created. Defaults to a fresh temp directory. */
  readonly workDir?: string;
  /** Keeps the workspaces after the run, for inspecting a failure. */
  readonly keepWorkspaces?: boolean;
}

/**
 * Runs the whole kit through the recorder. Nothing is skipped: the five vectors
 * unit mode defers are exactly the ones this mode exists to decide.
 */
export async function runKitIntegrationMode(options: KitIntegrationOptions = {}): Promise<KitRunResult> {
  const root = options.root ?? kitRoot();
  const config = options.config ?? loadKitRepoConfig();
  const environment = loadKitEnvironment(root);
  const vectors = loadKitVectors(root);

  const base = options.workDir ?? (await mkdtemp(path.join(tmpdir(), "delivery-harness-kit-")));
  const outcomes: KitOutcome[] = [];

  try {
    for (const [index, vector] of vectors.entries()) {
      // Padded so the directory listing sorts the way the kit index reads.
      const workspaceBase = path.join(base, `${String(index).padStart(3, "0")}-${vector.id}`);
      let actual: ValidatorOutcome;
      let failures: readonly string[];
      try {
        const attempts = await submitVector(vector, config, environment, workspaceBase);
        const final = attempts.at(-1);
        if (final === undefined) throw new Error("no submission was attempted");
        const observed = outcomeOf(final.outcome);
        if (observed === null) {
          // A blocked submission is not a rejection with different words: it
          // means the recorder could not judge the manifest at all, and no
          // vector expects that. Reporting it as a failure with its blocker
          // codes is what keeps it from being read as a lenient pass.
          actual = { accepted: false, codes: [] };
          failures = [`submission was blocked by [${blockedCodes(final.outcome).join(", ")}] rather than judged`];
        } else {
          actual = observed;
          failures = [
            ...compareOutcome(vector.expect, observed),
            ...verifyEffects(vector, final),
            ...verifyMultiStep(vector, attempts),
          ];
        }
      } catch (error) {
        actual = { accepted: false, codes: [] };
        failures = [`submission threw: ${error instanceof Error ? error.message : String(error)}`];
      }
      outcomes.push({
        id: vector.id,
        status: failures.length === 0 ? "passed" : "failed",
        codes: actual.codes,
        failures,
      });
    }
  } finally {
    if (options.workDir === undefined && options.keepWorkspaces !== true) {
      await rm(base, { recursive: true, force: true });
    }
  }

  return {
    outcomes,
    passed: outcomes.filter((outcome) => outcome.status === "passed").map((outcome) => outcome.id),
    failed: outcomes.filter((outcome) => outcome.status === "failed"),
    skipped: [],
  };
}
