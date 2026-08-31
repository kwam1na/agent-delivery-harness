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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECTION_DIR, materializeProjection } from "./claude-code.ts";
import {
  SHADOW_MILESTONE_GATE_RECORD_SPEC,
  emitProjectionConsumptionRecord,
} from "./consumption-gate-record.ts";
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
async function gateRecordFile(name: string, deliveries: unknown[] = []): Promise<string> {
  const dir = await mkdtemp(path.join(scratch, `${name}-policy-`));
  const file = path.join(dir, "shadow-milestone-gate-record.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        spec: SHADOW_MILESTONE_GATE_RECORD_SPEC,
        repositoryId: "athena",
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

const deliveriesIn = (file: string): any[] =>
  (JSON.parse(readFileSync(file, "utf8")) as { deliveries: any[] }).deliveries;

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

    const gateRecordPath = await gateRecordFile("observed");
    const emitted = await emitProjectionConsumptionRecord({
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
    const emitted = await emitProjectionConsumptionRecord({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-claimed",
      fence: 1,
      category: "code",
    });
    expect(emitted.ok, JSON.stringify(emitted)).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.emitted).toBe(false);
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

    const emitted = await emitProjectionConsumptionRecord({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-planted",
      fence: 1,
      category: "code",
    });
    expect(emitted.ok, JSON.stringify(emitted)).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.emitted).toBe(false);
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
    const gateRecordPath = await gateRecordFile("other-run");

    const wrongFence = await emitProjectionConsumptionRecord({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-2",
      fence: 2,
      category: "code",
    });
    expect(wrongFence.ok && wrongFence.emitted).toBe(false);

    const wrongDelivery = await emitProjectionConsumptionRecord({
      gateRecordPath,
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      deliveryId: "dlv-shadow-other",
      fence: 1,
      category: "code",
    });
    expect(wrongDelivery.ok && wrongDelivery.emitted).toBe(false);
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
      for (const _attempt of [0, 1]) {
        const emitted = await emitProjectionConsumptionRecord({
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
      { id: "dlv-shadow-prior", category: "operations", countedInComparisonSet: false, operatorInterventions: 4 },
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

    const emitted = await emitProjectionConsumptionRecord({
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
    expect(document["deliveries"][0]["operatorInterventions"]).toBe(4);
    expect(document["deliveries"][0]["countedInComparisonSet"]).toBe(true);
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

    const dir = await mkdtemp(path.join(scratch, "wrong-artifact-policy-"));
    const gateRecordPath = path.join(dir, "shadow-milestone-gate-record.json");
    writeFileSync(gateRecordPath, `${JSON.stringify({ spec: "something-else/1", deliveries: [] }, null, 2)}\n`);

    const emitted = await emitProjectionConsumptionRecord({
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

    const dir = await mkdtemp(path.join(scratch, "missing-artifact-policy-"));
    const gateRecordPath = path.join(dir, "shadow-milestone-gate-record.json");
    const emitted = await emitProjectionConsumptionRecord({
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
