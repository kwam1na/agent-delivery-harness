/**
 * CHARACTERIZATION OF THE RELEASED WORKFLOW CONTRACT — pinned BEFORE any
 * gap-closing, so every adapter decision below is made against bytes that
 * cannot drift silently.
 *
 * The `agent-skills` release vendored in the composition archive already
 * ships the machine-readable workflow contract this repository adopts:
 *
 *   - `workflows/delivery-v1.json` — the canonical `workflow-graph/1` graph,
 *     already pinned by `PINNED_AGENT_SKILLS.workflowGraphSha256`;
 *   - `schemas/workflow-graph.schema.json` and
 *     `schemas/workflow-stage-result.schema.json` — the released contract's
 *     own frozen schemas;
 *   - `tests/fixtures/workflow-graph/result-templates.json` — the release's
 *     deliberately unbound per-stage result templates, which the parity
 *     sensor binds and replays through the harness-side validator.
 *
 * These tests freeze (1) the exact bytes of those artifacts by digest and
 * (2) the semantic matrix the checkpoint adapter relies on — per-stage
 * statuses, success outputs, candidate binding, and prerequisites — read
 * from the released graph itself. A future skills-archive release that
 * changes any of this goes red HERE first, which is exactly the standing
 * qualification the compounding note asks these fixtures to become.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../digest.ts";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";
import { readArchiveEntry } from "./archive.ts";
import { WORKFLOW_GRAPH_ENTRY, loadBundledWorkflowGraph } from "./graph.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "fixtures");
const archiveBytes = readFileSync(path.join(FIXTURES, "agent-skills-core-v1-composition.zip"));

/** The released contract artifacts beyond the graph, frozen by digest. */
const RELEASED_CONTRACT_ARTIFACTS = Object.freeze({
  "schemas/workflow-graph.schema.json": "0e1c284307c35bb8fa181ae76ecd2abc7528d811a2be31d9a9bd85f78e2ad2c3",
  "schemas/workflow-stage-result.schema.json": "a1fe3d0bc131878c6620c15c359dafb115f31f027025a31fa3730bf3ce1fc91d",
  "tests/fixtures/workflow-graph/result-templates.json": "b4ad8b069b1edaef7f47bef547b498b438980073b37bd3aacc39a5ec89bc00ae",
} as const);

const readJsonEntry = (entry: string): unknown =>
  JSON.parse(Buffer.from(readArchiveEntry(archiveBytes, entry)).toString("utf8"));

describe("the released reviewer charter set, pinned", () => {
  it("carries the charter manifest and its adjudication, and lists every charter at the digest the release recorded", () => {
    const manifest = readJsonEntry("personas/manifest.json") as {
      schemaVersion: string;
      sourceAdjudication: string;
      personas: readonly { personaId: string; path: string }[];
    };
    expect(manifest.schemaVersion).toBe("reviewer-persona-manifest/1");
    expect(manifest.sourceAdjudication).toBe("personas/source-adjudication.json");

    const listed = new Map(
      (readJsonEntry("release-manifest.json") as { files: { path: string; sha256: string }[] }).files.map((file) => [
        file.path,
        file.sha256,
      ]),
    );
    for (const persona of manifest.personas) {
      expect(sha256Hex(readArchiveEntry(archiveBytes, persona.path)), persona.personaId).toBe(listed.get(persona.path));
    }
    // Named members, so a release that shipped an empty set would go red here
    // rather than passing the sweep above for free.
    const ids = manifest.personas.map((persona) => persona.personaId);
    expect(ids).toContain("persona.outcome-correctness");
    expect(ids).toContain("persona.testing-policy");
    expect(ids.length).toBe(17);
  });

  it("records an include or exclude decision for every source file the set was drawn from", () => {
    const adjudication = readJsonEntry("personas/source-adjudication.json") as {
      schemaVersion: string;
      source: { observedFileCount: number };
      adjudications: readonly { sourceFile: string; disposition: string }[];
    };
    expect(adjudication.schemaVersion).toBe("reviewer-persona-source-adjudication/1");
    expect(adjudication.adjudications.length).toBe(adjudication.source.observedFileCount);
    expect(adjudication.adjudications.length).toBe(51);
    const dispositions = new Set(adjudication.adjudications.map((row) => row.disposition));
    expect([...dispositions].sort()).toEqual(["adapted", "excluded", "merged"]);
  });
});

describe("the released workflow contract, pinned", () => {
  it("carries the graph, both schemas, and the result templates at their frozen digests", () => {
    expect(sha256Hex(readArchiveEntry(archiveBytes, WORKFLOW_GRAPH_ENTRY))).toBe(PINNED_AGENT_SKILLS.workflowGraphSha256);
    for (const [entry, digest] of Object.entries(RELEASED_CONTRACT_ARTIFACTS)) {
      expect(sha256Hex(readArchiveEntry(archiveBytes, entry)), entry).toBe(digest);
    }
  });

  it("declares exactly the frozen stage set, in graph order", () => {
    const loaded = loadBundledWorkflowGraph(archiveBytes);
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.graph.graphId).toBe("portable-delivery/1");
    expect(loaded.graph.stages.map((stage) => stage.id)).toEqual([
      "intake",
      "diagnose",
      "plan",
      "implement",
      "review.acquire",
      "review.reduce",
      "publish.handoff",
      "feedback.handoff",
      "finish.verify",
      "compound",
    ]);
  });

  it("declares the per-stage semantics the checkpoint adapter consumes, verbatim", () => {
    const loaded = loadBundledWorkflowGraph(archiveBytes);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const byId = new Map(loaded.graph.stages.map((stage) => [stage.id, stage]));

    // The columns the adapter's result validation and prerequisite
    // evaluation are driven by. One row per stage; a released change to any
    // cell is a contract revision and must land here deliberately.
    const matrix: Record<
      string,
      { statuses: string[]; outputs: string[]; binding: string; prerequisites: [string, string, string[]][] }
    > = {
      intake: { statuses: ["succeeded", "blocked", "failed"], outputs: ["scoped-subject"], binding: "forbidden", prerequisites: [] },
      diagnose: {
        statuses: ["succeeded", "blocked", "failed", "indeterminate"],
        outputs: ["confirmed"],
        binding: "checkpoint-contextual",
        prerequisites: [
          ["intake", "always", ["scoped-subject"]],
          ["$invoking-stage", "diagnostic-subflow", []],
        ],
      },
      plan: {
        statuses: ["succeeded", "blocked", "failed"],
        outputs: ["bounded-plan"],
        binding: "checkpoint-contextual",
        prerequisites: [
          ["intake", "always", ["scoped-subject"]],
          ["diagnose", "diagnosis-invoked", ["confirmed"]],
        ],
      },
      implement: {
        statuses: ["succeeded", "blocked", "failed", "indeterminate"],
        outputs: ["delivery-candidate"],
        binding: "produced-on-success",
        prerequisites: [
          ["plan", "always", ["bounded-plan"]],
          ["diagnose", "diagnosis-invoked", ["confirmed"]],
        ],
      },
      "review.acquire": {
        statuses: ["succeeded", "blocked", "failed", "indeterminate"],
        outputs: ["review-acquisition-envelope"],
        binding: "required",
        prerequisites: [
          ["implement", "always", ["delivery-candidate"]],
          ["$repair-source", "repair-loop", ["review-round-changes-requested", "feedback-available"]],
        ],
      },
      "review.reduce": {
        statuses: ["succeeded", "blocked", "failed"],
        outputs: ["review-round-aligned", "review-round-changes-requested"],
        binding: "required",
        prerequisites: [["review.acquire", "always", ["review-acquisition-envelope"]]],
      },
      "publish.handoff": {
        statuses: ["succeeded", "blocked", "failed", "indeterminate"],
        outputs: ["published"],
        binding: "required",
        prerequisites: [["review.reduce", "always", ["review-round-aligned"]]],
      },
      "feedback.handoff": {
        statuses: ["succeeded", "blocked", "failed", "indeterminate"],
        outputs: ["feedback-available", "feedback-empty"],
        binding: "required",
        prerequisites: [["publish.handoff", "always", ["published"]]],
      },
      "finish.verify": {
        statuses: ["succeeded", "blocked", "failed", "indeterminate"],
        outputs: ["finish-evidence-satisfied"],
        binding: "required",
        prerequisites: [
          ["review.reduce", "always", ["review-round-aligned"]],
          ["publish.handoff", "effective", ["published"]],
          ["feedback.handoff", "effective", ["feedback-available", "feedback-empty"]],
        ],
      },
      compound: {
        statuses: ["succeeded", "blocked", "failed"],
        outputs: ["learning-required", "no-reusable-learning"],
        binding: "required",
        prerequisites: [["finish.verify", "always", ["finish-evidence-satisfied"]]],
      },
    };

    for (const [id, expected] of Object.entries(matrix)) {
      const stage = byId.get(id);
      expect(stage, id).toBeDefined();
      if (stage === undefined) continue;
      expect([...stage.statuses], `${id} statuses`).toEqual(expected.statuses);
      expect([...stage.successOutputs], `${id} outputs`).toEqual(expected.outputs);
      expect(stage.candidateBinding, `${id} binding`).toBe(expected.binding);
      expect(
        stage.prerequisites.map((prerequisite) => [prerequisite.stageId, prerequisite.when, [...prerequisite.outputs]]),
        `${id} prerequisites`,
      ).toEqual(expected.prerequisites);
    }
  });

  it("keeps the released stage-result schema and the graph naming the same closed vocabularies", () => {
    const loaded = loadBundledWorkflowGraph(archiveBytes);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const schema = readJsonEntry("schemas/workflow-stage-result.schema.json") as {
      properties: { stageId: { enum: string[] }; status: { enum: string[] }; output: { properties: { kind: { enum: string[] } } } };
    };
    expect(schema.properties.stageId.enum).toEqual(loaded.graph.stages.map((stage) => stage.id));
    expect(schema.properties.status.enum).toEqual(["succeeded", "blocked", "failed", "indeterminate"]);
    const declaredOutputs = [...new Set(loaded.graph.stages.flatMap((stage) => [...stage.successOutputs]))];
    expect(schema.properties.output.properties.kind.enum).toEqual(declaredOutputs);
  });
});
