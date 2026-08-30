/**
 * The workflow module's V-slice: the BUNDLED graph, never a re-authored one.
 *
 * These tests bind the module to the exact pinned `agent-skills` release: the
 * graph bytes extracted from the vendored composition archive must hash to the
 * frozen `workflowGraphSha256`, tampered bytes must reject, and the skeleton's
 * checkpoint bindings must name only stages the bundled graph actually
 * declares — the graph governs the names; the mapping may not invent one.
 *
 * Written RED before `archive.ts` / `graph.ts` existed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../digest.ts";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";
import { listArchiveEntries, readArchiveEntry } from "./archive.ts";
import {
  WORKFLOW_CHECKPOINT_BINDINGS,
  WORKFLOW_GRAPH_ENTRY,
  loadBundledWorkflowGraph,
  workflowStageBindingFor,
} from "./graph.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "fixtures");
const archiveBytes = readFileSync(path.join(FIXTURES, "agent-skills-core-v1-composition.zip"));

describe("the bundled archive reader", () => {
  it("lists the pinned release's entries, including the workflow graph", () => {
    const entries = listArchiveEntries(archiveBytes);
    expect(entries).toContain(WORKFLOW_GRAPH_ENTRY);
    expect(entries).toContain("skills/execute-work/SKILL.md");
  });

  it("extracts entry bytes that hash to the frozen workflow-graph pin", () => {
    const bytes = readArchiveEntry(archiveBytes, WORKFLOW_GRAPH_ENTRY);
    expect(sha256Hex(bytes)).toBe(PINNED_AGENT_SKILLS.workflowGraphSha256);
  });

  it("fails closed on a missing entry", () => {
    expect(() => readArchiveEntry(archiveBytes, "workflows/not-a-real-entry.json")).toThrow(/not-a-real-entry/);
  });

  it("fails closed on bytes that are not an archive", () => {
    expect(() => listArchiveEntries(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe("loadBundledWorkflowGraph", () => {
  it("loads the pinned graph and reports its digest and stages", () => {
    const loaded = loadBundledWorkflowGraph(archiveBytes);
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.graphSha256).toBe(PINNED_AGENT_SKILLS.workflowGraphSha256);
    expect(loaded.graph.schemaVersion).toBe("workflow-graph/1");
    expect(loaded.graph.stages.map((stage) => stage.id)).toContain("plan");
    expect(loaded.graph.stages.map((stage) => stage.id)).toContain("implement");
  });

  it("rejects tampered graph bytes — the pin governs, not the archive's claim", () => {
    // Rebuild an archive-shaped input by tampering one byte of the graph
    // inside a copy of the archive: simplest honest tamper is at the consumer
    // seam — hand the loader an archive whose graph entry bytes differ.
    const bytes = readArchiveEntry(archiveBytes, WORKFLOW_GRAPH_ENTRY);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0xff;
    const loaded = loadBundledWorkflowGraph(archiveBytes, {
      readEntry: (archive, entry) => (entry === WORKFLOW_GRAPH_ENTRY ? tampered : readArchiveEntry(archive, entry)),
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.blockers.map((blocker) => blocker.code)).toContain("workflow_graph_digest_mismatch");
  });
});

describe("the skeleton's checkpoint bindings", () => {
  it("binds only stages the bundled graph declares", () => {
    const loaded = loadBundledWorkflowGraph(archiveBytes);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const declared = new Set(loaded.graph.stages.map((stage) => stage.id));
    for (const binding of WORKFLOW_CHECKPOINT_BINDINGS) {
      expect(declared.has(binding.stageId), binding.stageId).toBe(true);
    }
  });

  it("declares product-realized prerequisites only where the graph declares a prerequisite", () => {
    // The deferral is pinned to the released graph: every product-realized
    // name must be an `always` prerequisite the bound stage actually
    // declares, so a released graph change (a new or renamed prerequisite)
    // surfaces here and forces an explicit adapter decision.
    const loaded = loadBundledWorkflowGraph(archiveBytes);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    for (const binding of WORKFLOW_CHECKPOINT_BINDINGS) {
      const stage = loaded.graph.stages.find((candidate) => candidate.id === binding.stageId);
      expect(stage, binding.stageId).toBeDefined();
      const declared = new Set(
        (stage?.prerequisites ?? []).filter((prerequisite) => prerequisite.when === "always").map((prerequisite) => prerequisite.stageId),
      );
      for (const name of binding.productRealizedPrerequisites) {
        expect(declared.has(name), `${binding.stageId} defers ${name}`).toBe(true);
      }
    }
    // And the one deferral in the table is exactly the compound stage's
    // finish-line prerequisite — the frozen delivery matrix realizes it
    // through the product-owned checkpoints after compounding.
    expect(WORKFLOW_CHECKPOINT_BINDINGS.flatMap((binding) => [...binding.productRealizedPrerequisites])).toEqual(["finish.verify"]);
  });

  it("maps the model-driven delivery states onto the graph", () => {
    expect(workflowStageBindingFor("planning")?.stageId).toBe("plan");
    expect(workflowStageBindingFor("implementing")?.stageId).toBe("implement");
    expect(workflowStageBindingFor("remediating")?.stageId).toBe("implement");
    expect(workflowStageBindingFor("reviewing")?.stageId).toBe("review.acquire");
    expect(workflowStageBindingFor("compounding")?.stageId).toBe("compound");
    // Sensor runs are repository operation results, not workflow stages.
    expect(workflowStageBindingFor("validating")).toBeUndefined();
  });
});
