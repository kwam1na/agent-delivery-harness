/**
 * The binding's gate-record writer: the step that turns an observed
 * projection consumption into a durable entry in the shadow milestone's
 * gate-record artifact.
 *
 * The positions here are the ones the consuming guard depends on: an entry
 * appears only when the BINDING's own receipt and marker say this run consumed
 * this run's projection; a claim the binding did not observe — including a
 * marker a session planted in its own worktree — produces nothing; and two
 * runs produce two entries rather than one overwritten one.
 *
 * Written RED before `consumption-gate-record.ts` existed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializeProjection } from "./claude-code.ts";
import { PROJECTION_DIR } from "./projection.ts";
import {
  SHADOW_MILESTONE_GATE_RECORD_SPEC,
  emitProjectionConsumptionRecord,
  type EmitProjectionConsumptionInput,
} from "./consumption-gate-record.ts";
import {
  PROJECTION_CONSUMPTION_OBSERVATION_SPEC,
  projectionConsumptionObservationFile,
} from "../projection-consumption-observation.ts";
import { createExecPort } from "./exec-port.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "fixtures");
const SKILLS_ARCHIVE = path.join(FIXTURES, "agent-skills-core-v1-composition.zip");

let scratch: string;
const exec = createExecPort();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

interface Workbench {
  readonly worktreeDir: string;
  readonly bindingDir: string;
  readonly generationRoot: string;
}

/** A disposable repo + linked worktree + a stand-in generation root carrying the pinned archive. */
async function workbench(name: string): Promise<Workbench> {
  const base = await mkdtemp(path.join(scratch, `${name}-`));
  const repoDir = path.join(base, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "--initial-branch", "main");
  git(repoDir, "config", "user.email", "skeleton@example.invalid");
  git(repoDir, "config", "user.name", "Skeleton");
  writeFileSync(path.join(repoDir, "README.md"), "disposable\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "base");
  const worktreeDir = path.join(base, "worktree");
  git(repoDir, "worktree", "add", "-b", "delivery", worktreeDir, "main");

  const generationRoot = path.join(base, "generation");
  mkdirSync(path.join(generationRoot, "skills"), { recursive: true });
  writeFileSync(path.join(generationRoot, "skills", "agent-skills-core-v1.zip"), readFileSync(SKILLS_ARCHIVE));

  return { worktreeDir, bindingDir: path.join(base, "binding"), generationRoot };
}

/** The consuming repository's gate-record artifact, in the shape the guard reads. */
async function gateRecordFile(
  name: string,
  deliveries: unknown[] = [],
  repositoryId = "athena",
): Promise<string> {
  const dir = await mkdtemp(path.join(scratch, `${name}-policy-`));
  const file = path.join(dir, "shadow-milestone-gate-record.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        spec: SHADOW_MILESTONE_GATE_RECORD_SPEC,
        repositoryId,
        status: "awaiting-shadow-deliveries",
        comparisonSetRequirement: { mix: { code: 1, docs: 1, operations: 1 }, total: 3 },
        deliveries,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

/**
 * What the model-external interceptor writes when the run first reaches into
 * the projection subtree. The hook's own suite covers the detection; this
 * stands in for the invocation that triggered it.
 */
function observeConsumption(bench: Workbench, deliveryId: string, fence: number, entry = "workflows/delivery-v1.json"): void {
  mkdirSync(bench.bindingDir, { recursive: true });
  const receipt = JSON.parse(readFileSync(path.join(bench.bindingDir, "projection-receipt.json"), "utf8")) as {
    projectionDigest: string;
  };
  writeFileSync(
    path.join(bench.bindingDir, projectionConsumptionObservationFile(fence)),
    `${JSON.stringify({
      spec: PROJECTION_CONSUMPTION_OBSERVATION_SPEC,
      deliveryId,
      fence,
      entry,
      canonicalProjectionPath: realpathSync(path.join(bench.worktreeDir, PROJECTION_DIR, "workflows", "delivery-v1.json")),
      projectionDigest: receipt.projectionDigest,
      hostInvocationId: "toolu_observed_read",
      observedAt: "2026-08-30T12:00:00Z",
    })}\n`,
  );
}

const deliveriesIn = (file: string): any[] =>
  (JSON.parse(readFileSync(file, "utf8")) as { deliveries: any[] }).deliveries;

/** The low-level writer receives its expected repository from the binding. */
const emit = (
  input: Omit<EmitProjectionConsumptionInput, "expectedRepositoryId" | "repositoryRoot"> & {
    readonly expectedRepositoryId?: string;
    readonly repositoryRoot?: string;
  },
) =>
  emitProjectionConsumptionRecord({
    ...input,
    repositoryRoot: input.repositoryRoot ?? path.dirname(input.gateRecordPath),
    expectedRepositoryId: input.expectedRepositoryId ?? "athena",
  });

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "consumption-gate-record-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

describe("emitProjectionConsumptionRecord", () => {
  it("records an entry whose consumption claim is sourced from the binding's receipt and marker", async () => {
    const bench = await workbench("observed");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-1",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok, JSON.stringify(materialized)).toBe(true);
    if (!materialized.ok) return;
    observeConsumption(bench, "dlv-shadow-1", 1);

    const gateRecordPath = await gateRecordFile("observed");
    const emitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-1",
      fence: 1,
      category: "code",
    });
    expect(emitted.ok, JSON.stringify(emitted)).toBe(true);
    if (!emitted.ok || !emitted.emitted) throw new Error(`no entry emitted: ${JSON.stringify(emitted)}`);

    const deliveries = deliveriesIn(gateRecordPath);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual({
      id: "dlv-shadow-1",
      category: "code",
      countedInComparisonSet: true,
      projectionConsumption: {
        source: "binding",
        affirmative: true,
        // The digest the binding receipted at materialization, not a caller's.
        projectionDigest: materialized.projectionDigest,
        marker: {
          deliveryId: "dlv-shadow-1",
          fence: 1,
          consumed: "skills/agent-skills-core-v1.zip",
        },
      },
    });
    expect(emitted.record.projectionDigest).toBe(materialized.projectionDigest);
  });

  it("writes no entry for a consumption the binding did not observe", async () => {
    const bench = await workbench("unobserved");
    const gateRecordPath = await gateRecordFile("unobserved");

    // No materialization ran here: nothing but a claim exists.
    const emitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-claimed",
      fence: 1,
      category: "code",
    });
    expect(emitted.ok, JSON.stringify(emitted)).toBe(true);
    if (!emitted.ok || emitted.emitted) throw new Error(`unexpected emission: ${JSON.stringify(emitted)}`);
    expect(emitted.reason).toBe("projection-unverified");
    expect(deliveriesIn(gateRecordPath)).toEqual([]);
  });

  it("writes no entry for a marker a session planted without the binding's receipt", async () => {
    const bench = await workbench("planted");
    const gateRecordPath = await gateRecordFile("planted");

    // The worktree is session-writable, so a session can write the marker's
    // bytes. What it cannot write is the binding's own materialization
    // receipt, which lives in the product namespace — so the observation the
    // writer requires is missing and the claim produces nothing.
    mkdirSync(path.join(bench.worktreeDir, PROJECTION_DIR), { recursive: true });
    writeFileSync(
      path.join(bench.worktreeDir, PROJECTION_DIR, "consumption.json"),
      `${JSON.stringify({ deliveryId: "dlv-shadow-planted", fence: 1, consumed: "skills/agent-skills-core-v1.zip" })}\n`,
    );

    const emitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-planted",
      fence: 1,
      category: "code",
    });
    expect(emitted.ok, JSON.stringify(emitted)).toBe(true);
    if (!emitted.ok || emitted.emitted) throw new Error(`unexpected emission: ${JSON.stringify(emitted)}`);
    expect(emitted.reason).toBe("projection-unverified");
    expect(deliveriesIn(gateRecordPath)).toEqual([]);
  });

  it("writes no entry when the marker names another run", async () => {
    const bench = await workbench("other-run");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-2",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    observeConsumption(bench, "dlv-shadow-2", 1);
    const gateRecordPath = await gateRecordFile("other-run");

    const wrongFence = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-2",
      fence: 2,
      category: "code",
    });
    if (!wrongFence.ok || wrongFence.emitted) throw new Error(JSON.stringify(wrongFence));
    expect(wrongFence.reason).toBe("marker-names-another-run");

    const wrongDelivery = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-other",
      fence: 1,
      category: "code",
    });
    if (!wrongDelivery.ok || wrongDelivery.emitted) throw new Error(JSON.stringify(wrongDelivery));
    expect(wrongDelivery.reason).toBe("marker-names-another-run");
    expect(deliveriesIn(gateRecordPath)).toEqual([]);
  });

  it("gives two deliveries two distinct entries, and one delivery one entry however often it is emitted", async () => {
    const gateRecordPath = await gateRecordFile("two-runs");
    for (const [name, deliveryId, category] of [
      ["run-a", "dlv-shadow-a", "code"],
      ["run-b", "dlv-shadow-b", "docs"],
    ] as const) {
      const bench = await workbench(name);
      const materialized = await materializeProjection({
        worktreeDir: bench.worktreeDir,
        generationRoot: bench.generationRoot,
        deliveryId,
        fence: 1,
        bindingDir: bench.bindingDir,
        exec,
      });
      expect(materialized.ok).toBe(true);
      observeConsumption(bench, deliveryId, 1);
      for (const _attempt of [0, 1]) {
        const emitted = await emit({
          gateRecordPath,
          worktreeDir: bench.worktreeDir,
          bindingDir: bench.bindingDir,
          deliveryId,
          fence: 1,
          category,
        });
        expect(emitted.ok && emitted.emitted, JSON.stringify(emitted)).toBe(true);
      }
    }

    const deliveries = deliveriesIn(gateRecordPath);
    // Two runs, two entries — a re-emission updates its own entry rather than
    // adding a second one the guard would read as one run counted twice.
    expect(deliveries.map((entry) => entry.id)).toEqual(["dlv-shadow-a", "dlv-shadow-b"]);
    expect(deliveries.map((entry) => entry.category)).toEqual(["code", "docs"]);
    expect(new Set(deliveries.map((entry) => entry.projectionConsumption.marker.deliveryId)).size).toBe(2);
  });

  it("preserves the artifact's other content and the gate's own measurements", async () => {
    const gateRecordPath = await gateRecordFile("preserve", [
      { id: "dlv-shadow-prior", category: "operations", operatorInterventions: 4 },
    ]);
    const bench = await workbench("preserve");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-prior",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    observeConsumption(bench, "dlv-shadow-prior", 1);

    const emitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-prior",
      fence: 1,
      category: "operations",
    });
    expect(emitted.ok && emitted.emitted, JSON.stringify(emitted)).toBe(true);

    const document = JSON.parse(readFileSync(gateRecordPath, "utf8")) as Record<string, any>;
    expect(document["repositoryId"]).toBe("athena");
    expect(document["comparisonSetRequirement"]).toEqual({ mix: { code: 1, docs: 1, operations: 1 }, total: 3 });
    expect(document["deliveries"]).toHaveLength(1);
    // The gate's own measurement survives; the writer owns only the record.
    // An entry carrying no explicit exclusion is admitted by the record.
    expect(document["deliveries"][0]["operatorInterventions"]).toBe(4);
    expect(document["deliveries"][0]["countedInComparisonSet"]).toBe(true);
  });

  it("writes no entry when the binding never observed the run reaching into the projection", async () => {
    const bench = await workbench("never-consumed");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-unconsumed",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    const gateRecordPath = await gateRecordFile("never-consumed");

    // Everything materialization produces is present and intact — the receipt
    // matches the worktree bytes and the marker names this run — and that is
    // exactly the state a delivery is in when it resolved every skill from
    // ambient discovery and never opened the run-pinned subtree. Affirming
    // consumption here would put a false claim at the centre of the gate.
    const emitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-unconsumed",
      fence: 1,
      category: "code",
    });
    if (!emitted.ok || emitted.emitted) throw new Error(`unexpected emission: ${JSON.stringify(emitted)}`);
    expect(emitted.reason).toBe("projection-not-consumed");
    expect(deliveriesIn(gateRecordPath)).toEqual([]);
  });

  it("writes no entry for an observation belonging to another run", async () => {
    const bench = await workbench("other-observation");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-obs",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    const gateRecordPath = await gateRecordFile("other-observation");

    // An observation filed under this fence but naming a different delivery
    // proves nothing about this one.
    observeConsumption(bench, "dlv-shadow-somebody-else", 1);
    const emitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-obs",
      fence: 1,
      category: "code",
    });
    if (!emitted.ok || emitted.emitted) throw new Error(`unexpected emission: ${JSON.stringify(emitted)}`);
    expect(emitted.reason).toBe("projection-not-consumed");
    expect(deliveriesIn(gateRecordPath)).toEqual([]);
  });

  it("writes no entry for an observation naming a path the receipt does not list", async () => {
    const bench = await workbench("uncontained");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-uncontained",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    const gateRecordPath = await gateRecordFile("uncontained");

    // The interceptor reports what an invocation NAMED, without judging
    // whether those bytes exist — a session can put any string in its
    // arguments. Containment against the materialization receipt is where an
    // invented path stops: the binding never materialized it, so nothing
    // could have been read from it.
    for (const entry of ["skills/invented.md", "../escape.md", "workflows"]) {
      observeConsumption(bench, "dlv-shadow-uncontained", 1, entry);
      const emitted = await emit({
        gateRecordPath,
        worktreeDir: bench.worktreeDir,
        bindingDir: bench.bindingDir,
        deliveryId: "dlv-shadow-uncontained",
        fence: 1,
        category: "code",
      });
      if (!emitted.ok || emitted.emitted) throw new Error(`unexpected emission for ${entry}: ${JSON.stringify(emitted)}`);
      expect(emitted.reason).toBe("projection-not-consumed");
      expect(deliveriesIn(gateRecordPath)).toEqual([]);
    }

    // Only the canonical workflow source may qualify. A receipt contains
    // several files, but reading a marker or a skill is not evidence that the
    // workflow source was read.
    observeConsumption(bench, "dlv-shadow-uncontained", 1, "workflows/delivery-v1.json");
    const admitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-uncontained",
      fence: 1,
      category: "code",
    });
    expect(admitted.ok && admitted.emitted, JSON.stringify(admitted)).toBe(true);
  });

  it("leaves the gate artifact byte-identical for planted path-only or mismatched event evidence", async () => {
    const bench = await workbench("event-mismatch");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-event-mismatch",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    const gateRecordPath = await gateRecordFile("event-mismatch");
    const before = readFileSync(gateRecordPath, "utf8");

    // A path string alone is enumerable by the session and has none of the
    // model-external event fields the writer requires.
    writeFileSync(
      path.join(bench.bindingDir, projectionConsumptionObservationFile(1)),
      `${JSON.stringify({
        deliveryId: "dlv-shadow-event-mismatch",
        fence: 1,
        entry: "workflows/delivery-v1.json",
      })}\n`,
    );
    const planted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-event-mismatch",
      fence: 1,
      category: "code",
    });
    expect(planted.ok && !planted.emitted, JSON.stringify(planted)).toBe(true);
    expect(readFileSync(gateRecordPath, "utf8")).toBe(before);

    // The retired provider-specific envelope is not a second accepted
    // spelling of the neutral contract, even when every run binding matches.
    const receipt = JSON.parse(readFileSync(path.join(bench.bindingDir, "projection-receipt.json"), "utf8")) as {
      projectionDigest: string;
    };
    writeFileSync(
      path.join(bench.bindingDir, projectionConsumptionObservationFile(1)),
      `${JSON.stringify({
        source: "claude-code-post-tool-use-read/1",
        deliveryId: "dlv-shadow-event-mismatch",
        fence: 1,
        entry: "workflows/delivery-v1.json",
        canonicalProjectionPath: realpathSync(
          path.join(bench.worktreeDir, PROJECTION_DIR, "workflows", "delivery-v1.json"),
        ),
        projectionDigest: receipt.projectionDigest,
        hostInvocationId: "toolu_legacy_shape",
        observedAt: "2026-08-30T12:00:00Z",
      })}\n`,
    );
    const providerSpecific = await emitProjectionConsumptionRecord({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-event-mismatch",
      fence: 1,
      category: "code",
    });
    expect(providerSpecific.ok && !providerSpecific.emitted, JSON.stringify(providerSpecific)).toBe(true);
    expect(readFileSync(gateRecordPath, "utf8")).toBe(before);

    // Even a neutral observation is refused if its digest is not the
    // receipt-reverified projection digest for this exact run.
    observeConsumption(bench, "dlv-shadow-event-mismatch", 1);
    const observationPath = path.join(bench.bindingDir, projectionConsumptionObservationFile(1));
    const mismatch = JSON.parse(readFileSync(observationPath, "utf8")) as Record<string, unknown>;
    writeFileSync(observationPath, `${JSON.stringify({ ...mismatch, projectionDigest: "0".repeat(64) })}\n`);
    const mismatched = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-event-mismatch",
      fence: 1,
      category: "code",
    });
    expect(mismatched.ok && !mismatched.emitted, JSON.stringify(mismatched)).toBe(true);
    expect(readFileSync(gateRecordPath, "utf8")).toBe(before);
  });

  it("loses no entry when two deliveries are emitted concurrently against one artifact", async () => {
    const gateRecordPath = await gateRecordFile("concurrent");
    const benches = [];
    for (const [name, deliveryId] of [
      ["conc-a", "dlv-conc-a"],
      ["conc-b", "dlv-conc-b"],
    ] as const) {
      const bench = await workbench(name);
      const materialized = await materializeProjection({
        worktreeDir: bench.worktreeDir,
        generationRoot: bench.generationRoot,
        deliveryId,
        fence: 1,
        bindingDir: bench.bindingDir,
        exec,
      });
      expect(materialized.ok).toBe(true);
      observeConsumption(bench, deliveryId, 1);
      benches.push({ bench, deliveryId });
    }

    // Three shadow deliveries share ONE artifact, so concurrent emission is
    // the intended usage. An unlocked read-modify-write loses one entry
    // silently, with both callers reporting success.
    const results = await Promise.all(
      benches.map(({ bench, deliveryId }) =>
        emit({
          gateRecordPath,
          worktreeDir: bench.worktreeDir,
          bindingDir: bench.bindingDir,
          deliveryId,
          fence: 1,
          category: "code",
        }),
      ),
    );
    // Every caller that reported success must be represented on disk; a
    // caller refused the lock reports a blocker rather than a silent loss.
    const written = results.filter((result) => result.ok && result.emitted).length;
    const refused = results.filter((result) => !result.ok).length;
    // Progress as well as safety: a lock that refused BOTH callers would
    // satisfy the accounting below while making the writer useless.
    expect(written).toBeGreaterThanOrEqual(1);
    expect(written + refused).toBe(2);
    expect(deliveriesIn(gateRecordPath)).toHaveLength(written);
    for (const result of results) {
      if (!result.ok) expect(result.blockers.map((blocker) => blocker.code)).toEqual(["gate_record_locked"]);
    }
  });

  it("leaves an exclusion the gate wrote in place", async () => {
    const gateRecordPath = await gateRecordFile("excluded", [
      { id: "dlv-shadow-excluded", category: "code", countedInComparisonSet: false, operatorInterventions: 2 },
    ]);
    const bench = await workbench("excluded");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-excluded",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    observeConsumption(bench, "dlv-shadow-excluded", 1);

    const emitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-excluded",
      fence: 1,
      category: "code",
    });
    expect(emitted.ok && emitted.emitted, JSON.stringify(emitted)).toBe(true);

    // The gate excludes a delivery whose measurement it invalidated. The
    // record is refreshed; the exclusion is not silently reversed.
    const entries = deliveriesIn(gateRecordPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].countedInComparisonSet).toBe(false);
    expect(entries[0].projectionConsumption.source).toBe("binding");
    expect(entries[0].operatorInterventions).toBe(2);
  });

  it("records into any consumer's gate record, not just the first consumer's", async () => {
    // Each consumer names the spec after itself while the record contract
    // inside is identical. Pinning one consumer's full string made the product
    // able to record for exactly one repository — and refused THIS
    // repository's own shadow artifact, which is the case that caught it.
    const bench = await workbench("other-consumer");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-harness",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    observeConsumption(bench, "dlv-shadow-harness", 1);

    const dir = await mkdtemp(path.join(scratch, "other-consumer-policy-"));
    const gateRecordPath = path.join(dir, "shadow-milestone-gate-record.json");
    writeFileSync(
      gateRecordPath,
      `${JSON.stringify(
        {
          spec: "delivery-harness-shadow-milestone-gate-record/1",
          repositoryId: "agent-delivery-harness",
          deliveries: [],
        },
        null,
        2,
      )}\n`,
    );
    const emitted = await emit({
      gateRecordPath,
      expectedRepositoryId: "agent-delivery-harness",
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-harness",
      fence: 1,
      category: "code",
    });
    expect(emitted.ok && emitted.emitted, JSON.stringify(emitted)).toBe(true);
    expect(deliveriesIn(gateRecordPath).map((entry) => entry.id)).toEqual(["dlv-shadow-harness"]);
  });

  it("refuses a cross-repository target without changing either repository's record", async () => {
    const bench = await workbench("cross-repository-target");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-harness-cross-repository",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    observeConsumption(bench, "dlv-harness-cross-repository", 1);

    const harnessRecord = await gateRecordFile(
      "cross-repository-source",
      [],
      "agent-delivery-harness",
    );
    const athenaRecord = await gateRecordFile("cross-repository-target", [], "athena");
    const sourceBefore = readFileSync(harnessRecord, "utf8");
    const targetBefore = readFileSync(athenaRecord, "utf8");

    const emitted = await emit({
      gateRecordPath: athenaRecord,
      expectedRepositoryId: "agent-delivery-harness",
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-harness-cross-repository",
      fence: 1,
      category: "code",
    });

    expect(emitted.ok).toBe(false);
    if (emitted.ok) return;
    expect(emitted.blockers.map((blocker) => blocker.code)).toEqual([
      "gate_record_repository_mismatch",
    ]);
    expect(readFileSync(harnessRecord, "utf8")).toBe(sourceBefore);
    expect(readFileSync(athenaRecord, "utf8")).toBe(targetBefore);
  });

  it("refuses a gate record of another version, and anything that is not one", async () => {
    // The suffix carries the version, so a /2 artifact is refused rather than
    // written into with /1 semantics — and the bare suffix with no consumer
    // prefix is not a consumer's artifact either.
    const bench = await workbench("version-guard");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-version",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    observeConsumption(bench, "dlv-shadow-version", 1);

    for (const spec of ["athena-shadow-milestone-gate-record/2", "shadow-milestone-gate-record/1", "notes/1"]) {
      const dir = await mkdtemp(path.join(scratch, "version-guard-policy-"));
      const gateRecordPath = path.join(dir, "shadow-milestone-gate-record.json");
      writeFileSync(gateRecordPath, `${JSON.stringify({ spec, deliveries: [] }, null, 2)}\n`);
      const emitted = await emit({
        gateRecordPath,
        worktreeDir: bench.worktreeDir,
        bindingDir: bench.bindingDir,
        deliveryId: "dlv-shadow-version",
        fence: 1,
        category: "code",
      });
      expect(emitted.ok, `spec ${spec} was accepted`).toBe(false);
      if (emitted.ok) continue;
      expect(emitted.blockers.map((blocker) => blocker.code)).toEqual(["gate_record_unrecognized"]);
    }
  });

  it("refuses an artifact that is not the milestone gate record", async () => {
    const bench = await workbench("wrong-artifact");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-3",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    observeConsumption(bench, "dlv-shadow-3", 1);

    const dir = await mkdtemp(path.join(scratch, "wrong-artifact-policy-"));
    const gateRecordPath = path.join(dir, "shadow-milestone-gate-record.json");
    writeFileSync(gateRecordPath, `${JSON.stringify({ spec: "something-else/1", deliveries: [] }, null, 2)}\n`);

    const emitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-3",
      fence: 1,
      category: "code",
    });
    expect(emitted.ok).toBe(false);
    if (emitted.ok) return;
    expect(emitted.blockers.map((blocker) => blocker.code)).toEqual(["gate_record_unrecognized"]);
    expect(deliveriesIn(gateRecordPath)).toEqual([]);
  });

  it("refuses a missing gate record rather than creating one", async () => {
    const bench = await workbench("missing-artifact");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-shadow-4",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    observeConsumption(bench, "dlv-shadow-4", 1);

    const dir = await mkdtemp(path.join(scratch, "missing-artifact-policy-"));
    const gateRecordPath = path.join(dir, "shadow-milestone-gate-record.json");
    const emitted = await emit({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-4",
      fence: 1,
      category: "code",
    });
    expect(emitted.ok).toBe(false);
    if (emitted.ok) return;
    expect(emitted.blockers.map((blocker) => blocker.code)).toEqual(["gate_record_unreadable"]);
  });
});
