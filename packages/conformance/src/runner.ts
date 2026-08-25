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
 * expect codes only a recorder can reach — bytes materialized under an allocated
 * run root, and the record store a second submission collides with. Those are
 * enumerated by name in `RECORDER_DEPENDENT_VECTORS` and skipped here, loudly:
 * a name that has vanished from the kit fails the run rather than quietly
 * reducing coverage, which is the failure mode an unnamed skip list has.
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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isManifestRejectionCode, validateManifest, type HarnessConfig } from "@delivery-harness/kernel";
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
 * The vectors whose expectation is a conclusion about state the recorder owns.
 * Each was classified by reading the vector: what it overrides, what protocol it
 * declares in `extra`, and which code it expects.
 */
export const RECORDER_DEPENDENT_VECTORS: readonly DeferredVector[] = Object.freeze([
  Object.freeze({
    id: "a-idempotent-resubmission",
    reason: "extra.submitTwice — the claim is about record ids being identical across two submissions, which requires records to be written",
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
    reason: "artifact_digest_mismatch — the entry names a file the run root does not contain, which is a filesystem observation",
  }),
  Object.freeze({
    id: "env-11-artifact-digest-mismatch",
    reason: "artifact_digest_mismatch — the declared digest is compared against the bytes on disk at submission",
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
