/**
 * The conformance kit, run against the kernel validator.
 *
 * This file is the unit's acceptance test. Everything else in the change exists
 * to make it pass without weakening a vector: the kit is a fixed corpus with
 * fixed expectations, and the only sanctioned way to move a number here is to
 * make the validator more correct.
 *
 * Three claims are separable and separately asserted:
 *
 *   THE CORPUS IS FULLY ACCOUNTED FOR. 89 vectors, 84 decided, 5 deferred by
 *   name with a stated reason. Nothing is skipped anonymously and nothing is
 *   missing — a deferred name that no longer matches a vector fails the run.
 *
 *   THE EXPECTATION SEMANTICS ARE THE KIT'S. The listed codes are a floor and
 *   extras are legal, an accepted submission carries no codes, and a code the
 *   registry does not know fails the harness rather than passing as an extra.
 *   These are asserted directly on synthetic outcomes, not merely exercised by
 *   whichever vectors happen to have more than one code.
 *
 *   THE OUTCOMES FOLLOW THE SPEC, NOT ONE CONFIGURATION. The same run under the
 *   kit-variant configuration — every dimension varied except the ones the
 *   vectors are bound to — produces the same result.
 *
 * And, once the recorder exists, a fourth:
 *
 *   THE WHOLE CORPUS IS DECIDED AGAINST A REAL SUBMISSION PATH. Integration
 *   mode runs all 89 — including the five unit mode defers — through run-root
 *   allocation, artifact materialization, the recorder, and the record store,
 *   under both configurations. Nothing is skipped and no expectation is
 *   relaxed: the deferred five are the reason this mode exists, and the other 84
 *   must produce exactly what they produced without a filesystem.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { RECORDER_EMITTED_CODES, manifestDigest, type HarnessConfig } from "@delivery-harness/kernel";
import { loadKitRepoConfig } from "../fixtures/repo-config-adapter.ts";
import { kitVariantConfig } from "../fixtures/kit-variant-config.ts";
import {
  RECORDER_DEPENDENT_VECTORS,
  compareOutcome,
  describeFailures,
  evaluateVector,
  loadKitEnvironment,
  loadKitIndex,
  loadKitVectors,
  runKitIntegrationMode,
  runKitUnitMode,
} from "./runner.ts";

const kitConfig = loadKitRepoConfig();
const index = loadKitIndex();
const vectors = loadKitVectors();
const environment = loadKitEnvironment();

const DEFERRED_IDS = RECORDER_DEPENDENT_VECTORS.map((vector) => vector.id);
/** Skip order follows the kit's index, not the declaration order. */
const DEFERRED_IDS_SORTED = [...DEFERRED_IDS].sort();

function vector(id: string) {
  const found = vectors.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`vector ${id} is not in the kit`);
  return found;
}

// ── The corpus ─────────────────────────────────────────────────────────────

describe("the vendored kit", () => {
  it("is the 89-vector corpus its index claims", () => {
    expect(index.counts).toEqual({ total: 89, accept: 8, reject: 81 });
    expect(vectors).toHaveLength(89);
    expect(index.spec).toBe("delivery-evidence/1");
    expect(index.payloadSpecs).toEqual(["review.green/1"]);
  });

  it("contains every vector the deferred list names", () => {
    // A skip list that outlives its vectors silently reduces coverage. The
    // runner throws on a missing name; this states the same thing as a claim.
    for (const id of DEFERRED_IDS) {
      expect(vectors.map((entry) => entry.id)).toContain(id);
    }
  });

  it("defers exactly the five vectors whose expected codes only a recorder can reach", () => {
    expect(DEFERRED_IDS).toEqual([
      "a-idempotent-resubmission",
      "sub-4-record-conflict",
      "sub-3-manifest-outside-run-root",
      "env-10-artifact-missing-file",
      "env-11-artifact-digest-mismatch",
    ]);
    for (const deferred of RECORDER_DEPENDENT_VECTORS) {
      expect(deferred.reason.length).toBeGreaterThan(0);
    }
  });

  it("defers only what the recorder's surface owns", () => {
    // The mechanical justification for the skip list, and the standard a
    // proposed sixth entry has to meet: each deferred reject vector expects a
    // code the registry marks as recorder-emitted, and the one deferred accept
    // vector expects a multi-step protocol rather than a single submission.
    // Anything else on this list would be coverage dropped rather than deferred.
    for (const { id } of RECORDER_DEPENDENT_VECTORS) {
      const deferred = vector(id);
      if (deferred.expect.result === "accepted") {
        expect(Object.keys(deferred.extra ?? {}), id).not.toHaveLength(0);
        continue;
      }
      for (const code of deferred.expect.codes ?? []) {
        expect(RECORDER_EMITTED_CODES, `${id} expects ${code}`).toContain(code);
      }
    }
  });
});

// ── The run ────────────────────────────────────────────────────────────────

describe("unit mode under the kit's own configuration", () => {
  const result = runKitUnitMode();

  it("decides 84 vectors and skips the 5 deferred ones", () => {
    expect(describeFailures(result)).toBe("");
    expect(result.passed).toHaveLength(84);
    expect([...result.skipped].sort()).toEqual(DEFERRED_IDS_SORTED);
    expect(result.outcomes).toHaveLength(89);
  });

  it("accepts every accept vector with no rejection codes at all", () => {
    const accepts = index.vectors.filter((entry) => entry.expect.result === "accepted" && !DEFERRED_IDS.includes(entry.id));
    expect(accepts).toHaveLength(7);
    for (const entry of accepts) {
      const outcome = result.outcomes.find((candidate) => candidate.id === entry.id);
      expect(outcome?.status, entry.id).toBe("passed");
      expect(outcome?.codes, entry.id).toEqual([]);
    }
  });

  it("reports every violated rule in one response, not the first", () => {
    // SUB-5, observed where the kit itself expects two codes.
    const outcome = result.outcomes.find((candidate) => candidate.id === "env-8-repository-required");
    expect(outcome?.codes).toEqual(expect.arrayContaining(["repository_required", "unsupported_attestation"]));
  });
});

// ── Integration mode ───────────────────────────────────────────────────────

describe("integration mode under the kit's own configuration", () => {
  /**
   * One run, several claims. Each `it` below names a separable property of the
   * same result rather than re-driving 89 submissions per assertion — the
   * submissions touch a real filesystem, and re-running them would buy
   * repetition rather than independence.
   */
  let result: Awaited<ReturnType<typeof runKitIntegrationMode>>;

  beforeAll(async () => {
    result = await runKitIntegrationMode();
  }, 120_000);

  it("decides all 89 vectors, skipping none", () => {
    expect(describeFailures(result)).toBe("");
    expect(result.skipped).toEqual([]);
    expect(result.passed).toHaveLength(89);
    expect(result.outcomes).toHaveLength(89);
  });

  it("decides the five vectors unit mode defers", () => {
    // The unit's whole reason for existing, stated as a claim rather than
    // inferred from a total: these five were skipped by name, and here they are
    // passing under the same expectations.
    for (const id of DEFERRED_IDS) {
      const outcome = result.outcomes.find((candidate) => candidate.id === id);
      expect(outcome?.status, id).toBe("passed");
    }
  });

  it("accepts every accept vector with no rejection codes at all", () => {
    const accepts = index.vectors.filter((entry) => entry.expect.result === "accepted");
    expect(accepts).toHaveLength(8);
    for (const entry of accepts) {
      const outcome = result.outcomes.find((candidate) => candidate.id === entry.id);
      expect(outcome?.status, entry.id).toBe("passed");
      expect(outcome?.codes, entry.id).toEqual([]);
    }
  });

  it("reaches the four recorder-emitted codes the pure validator cannot", () => {
    // Anti-vacuity for the mode itself: if integration mode were quietly
    // producing the same codes unit mode produces, every vector could still be
    // green while the recorder's surface went unexercised.
    const reached = new Set(result.outcomes.flatMap((outcome) => outcome.codes));
    for (const code of RECORDER_EMITTED_CODES) {
      expect([...reached], `no vector produced ${code}`).toContain(code);
    }
  });
});

describe("integration mode under the kit-variant configuration", () => {
  it("produces the same result with every vector-independent dimension varied", async () => {
    const result = await runKitIntegrationMode({ config: kitVariantConfig });
    expect(describeFailures(result)).toBe("");
    expect(result.passed).toHaveLength(89);
    expect(result.skipped).toEqual([]);
  }, 120_000);
});

// ── Expectation semantics ──────────────────────────────────────────────────

describe("the kit's expectation semantics", () => {
  const floor = { result: "rejected", codes: ["illegal_deferral", "telemetry_mismatch"] } as const;

  it("treats the listed codes as a floor: extra codes are legal", () => {
    expect(compareOutcome(floor, { accepted: false, codes: ["illegal_deferral", "telemetry_mismatch", "invalid_cost"] })).toEqual([]);
  });

  it("fails a rejection that is missing one of the listed codes", () => {
    const failures = compareOutcome(floor, { accepted: false, codes: ["illegal_deferral"] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("telemetry_mismatch");
  });

  it("fails a code the registry does not know, however well it matches", () => {
    const failures = compareOutcome(floor, {
      accepted: false,
      codes: ["illegal_deferral", "telemetry_mismatch", "illegal_deferral_v2"],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("not in the rejection-code registry");
  });

  it("fails an accepted submission that carries codes", () => {
    expect(compareOutcome({ result: "accepted" }, { accepted: true, codes: ["invalid_cost"] })).toHaveLength(1);
  });

  it("fails an acceptance where a rejection was expected, and the reverse", () => {
    expect(compareOutcome(floor, { accepted: true, codes: [] })).toHaveLength(1);
    const failures = compareOutcome({ result: "accepted" }, { accepted: false, codes: ["no_claims"] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("no_claims");
  });
});

// ── GEN-5 ──────────────────────────────────────────────────────────────────

describe("the informational timestamp", () => {
  it("changes the manifest digest and changes no outcome", () => {
    const accepted = vector("a-three-reviewers");
    const manifest = accepted.manifest as Record<string, unknown>;
    const mutated = { ...manifest, recordedAt: "2031-12-31T23:59:59Z" };

    expect(manifestDigest(mutated)).not.toBe(manifestDigest(manifest));

    const before = evaluateVector(accepted, kitConfig, environment);
    const after = evaluateVector({ ...accepted, manifest: mutated }, kitConfig, environment);
    expect(after).toEqual(before);
    expect(after.accepted).toBe(true);
  });

  it("changes no outcome on a rejected vector either", () => {
    const rejected = vector("rg-7-defer-p1");
    const manifest = rejected.manifest as Record<string, unknown>;
    const mutated = { ...manifest, recordedAt: "1999-01-01T00:00:00Z" };
    expect(evaluateVector({ ...rejected, manifest: mutated }, kitConfig, environment)).toEqual(
      evaluateVector(rejected, kitConfig, environment),
    );
  });
});

// ── Configuration independence ─────────────────────────────────────────────

describe("unit mode under the kit-variant configuration", () => {
  it("produces the same result with every vector-independent dimension varied", () => {
    const result = runKitUnitMode({ config: kitVariantConfig });
    expect(describeFailures(result)).toBe("");
    expect(result.passed).toHaveLength(84);
    expect([...result.skipped].sort()).toEqual(DEFERRED_IDS_SORTED);
  });
});

// ── The adapter's falsification, completed at the vector level ─────────────

describe("the kit repo-config adapter's negative space", () => {
  /**
   * The config unit proved that a default widening the configuration into the
   * kit's negative space is *detectable*. This is the other half: the same
   * widening turns a vector red, which is what makes the negative space
   * load-bearing rather than decorative.
   */
  it("goes red on a vector when a mapped dimension is pointed at a vector-bound value", () => {
    const widened = {
      ...kitConfig,
      identityVersions: [...kitConfig.identityVersions, "deliverable-tree/v0"],
    } as HarnessConfig;

    const result = runKitUnitMode({ config: widened });
    expect(result.failed.map((outcome) => outcome.id)).toEqual(["env-6-unknown-identity-version"]);
    expect(result.failed[0]?.failures.join(" ")).toContain("unsupported_identity_version");
  });

  it("stays green when the accepted payload specs are widened, because the validator refuses specs it does not implement", () => {
    // The falsification the config unit named — adding review.green/0 to the
    // accepted payload specs — turns out not to reach a vector, and the reason
    // is worth pinning: acceptance requires the spec to be both configured and
    // implemented, so widening configuration alone cannot admit a payload no
    // rule has ever read. The negative-space guard still catches the widening;
    // this records that the validator is the second lock on that door.
    const widened = {
      ...kitConfig,
      obligations: kitConfig.obligations.map((obligation) => ({
        ...obligation,
        acceptedPayloadSpecs: [...obligation.acceptedPayloadSpecs, "review.green/0"],
      })),
    } as HarnessConfig;

    expect(runKitUnitMode({ config: widened }).failed).toEqual([]);
  });

  it("is green again once the widening is removed", () => {
    // The restore half of the falsification: the config is a parameter, so no
    // widening can leak out of the test that made it.
    expect(runKitUnitMode({ config: kitConfig }).failed).toEqual([]);
  });
});
