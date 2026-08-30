/**
 * The BUNDLED `workflow-graph/1` document from the exact pinned
 * `agent-skills` release — loaded, digest-verified against the frozen pin,
 * parsed into its FULL released shape, and mapped onto the skeleton's
 * model-driven checkpoints. The graph is pinned, never re-authored: this
 * module rejects bytes that do not hash to the frozen `workflowGraphSha256`,
 * and the checkpoint bindings may name only stages the graph itself declares.
 *
 * Parsing is strict and closed: every stage member the released schema
 * declares is required, unknown members reject, and the parsed value carries
 * the whole semantic matrix — prerequisites, statuses, success outputs,
 * candidate binding, evidence-adapter slots, and edges — so the checkpoint
 * adapter's result validation and prerequisite evaluation are DRIVEN BY the
 * released graph rather than re-authoring its semantics in code.
 *
 * The checkpoint mapping stays deliberately narrow. Only the delivery states
 * whose next checkpoint is a model-driven WORKFLOW stage carry a binding;
 * sensor runs in `validating` are repository operation results
 * (`operation.result.recorded`), not workflow stages, and the product-owned
 * checkpoints (admission, recording, finish line) have no stage either.
 */
import { sha256Hex } from "../digest.ts";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";
import type { DeliveryState } from "../spine/vocabulary.ts";
import { readArchiveEntry } from "./archive.ts";

/** Where the bundled graph lives inside the pinned release archive. */
export const WORKFLOW_GRAPH_ENTRY = "workflows/delivery-v1.json";

export interface WorkflowPrerequisite {
  readonly stageId: string;
  readonly when: string;
  readonly outputs: readonly string[];
  readonly allowOmitted: boolean;
}

export interface WorkflowEdge {
  readonly to: string;
  readonly when: string;
}

export interface WorkflowEvidenceAdapter {
  readonly requirement: string;
  readonly ref?: string;
}

export interface WorkflowStage {
  readonly id: string;
  readonly semanticKind: string;
  readonly prerequisites: readonly WorkflowPrerequisite[];
  readonly mutationClass: string;
  readonly requiredness: string;
  readonly candidateBinding: string;
  readonly requiredInputs: readonly string[];
  readonly optionalInputs: readonly string[];
  readonly successOutputs: readonly string[];
  readonly statuses: readonly string[];
  readonly evidenceAdapter: WorkflowEvidenceAdapter;
  readonly edges: readonly WorkflowEdge[];
}

export interface WorkflowGraph {
  readonly schemaVersion: string;
  readonly graphId: string;
  readonly stages: readonly WorkflowStage[];
}

export interface WorkflowBlocker {
  readonly code: "workflow_graph_digest_mismatch" | "workflow_graph_malformed";
  readonly message: string;
}

export type LoadWorkflowGraphResult =
  | { readonly ok: true; readonly graph: WorkflowGraph; readonly graphSha256: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly blockers: readonly WorkflowBlocker[] };

/**
 * Loads the bundled graph from the pinned release archive's bytes. The
 * `readEntry` seam exists so a test can prove the digest check bites; the
 * default is the real archive reader.
 */
export function loadBundledWorkflowGraph(
  archiveBytes: Uint8Array,
  options: { readonly readEntry?: (archive: Uint8Array, entry: string) => Uint8Array } = {},
): LoadWorkflowGraphResult {
  const readEntry = options.readEntry ?? readArchiveEntry;
  let bytes: Uint8Array;
  try {
    bytes = readEntry(archiveBytes, WORKFLOW_GRAPH_ENTRY);
  } catch (error) {
    return {
      ok: false,
      blockers: [
        {
          code: "workflow_graph_malformed",
          message: `the bundled workflow graph could not be read: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  const digest = sha256Hex(bytes);
  if (digest !== PINNED_AGENT_SKILLS.workflowGraphSha256) {
    return {
      ok: false,
      blockers: [
        {
          code: "workflow_graph_digest_mismatch",
          message: `the bundled graph hashes to ${digest}, not the pinned ${PINNED_AGENT_SKILLS.workflowGraphSha256}; the pin governs`,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { ok: false, blockers: [{ code: "workflow_graph_malformed", message: "the bundled graph is not JSON" }] };
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  const stages = record?.["stages"];
  if (record?.["schemaVersion"] !== "workflow-graph/1" || typeof record["graphId"] !== "string" || !Array.isArray(stages)) {
    return {
      ok: false,
      blockers: [{ code: "workflow_graph_malformed", message: "the bundled graph is outside the workflow-graph/1 shape" }],
    };
  }
  const parsedStages: WorkflowStage[] = [];
  for (const stage of stages) {
    const parsedStage = parseStage(stage);
    if (parsedStage === undefined) {
      return {
        ok: false,
        blockers: [{ code: "workflow_graph_malformed", message: "a bundled graph stage is outside its declared shape" }],
      };
    }
    parsedStages.push(parsedStage);
  }
  return {
    ok: true,
    graph: { schemaVersion: "workflow-graph/1", graphId: record["graphId"], stages: parsedStages },
    graphSha256: digest,
    bytes,
  };
}

const STAGE_MEMBERS = new Set([
  "id",
  "semanticKind",
  "prerequisites",
  "mutationClass",
  "requiredness",
  "candidateBinding",
  "requiredInputs",
  "optionalInputs",
  "successOutputs",
  "statuses",
  "evidenceAdapter",
  "edges",
]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const stringArrayOf = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;

/** One stage, parsed strictly against the released shape; `undefined` on any surprise. */
function parseStage(value: unknown): WorkflowStage | undefined {
  const entry = asRecord(value);
  if (entry === undefined) return undefined;
  for (const member of Object.keys(entry)) {
    if (!STAGE_MEMBERS.has(member)) return undefined; // an unknown stage member fails closed
  }
  if (
    typeof entry["id"] !== "string" ||
    typeof entry["semanticKind"] !== "string" ||
    typeof entry["mutationClass"] !== "string" ||
    typeof entry["requiredness"] !== "string" ||
    typeof entry["candidateBinding"] !== "string"
  ) {
    return undefined;
  }
  const requiredInputs = stringArrayOf(entry["requiredInputs"]);
  const optionalInputs = stringArrayOf(entry["optionalInputs"]);
  const successOutputs = stringArrayOf(entry["successOutputs"]);
  const statuses = stringArrayOf(entry["statuses"]);
  if (requiredInputs === undefined || optionalInputs === undefined || successOutputs === undefined || statuses === undefined) {
    return undefined;
  }

  const adapterRecord = asRecord(entry["evidenceAdapter"]);
  if (adapterRecord === undefined || typeof adapterRecord["requirement"] !== "string") return undefined;
  const adapterRef = adapterRecord["ref"];
  if (adapterRef !== undefined && typeof adapterRef !== "string") return undefined;
  const evidenceAdapter: WorkflowEvidenceAdapter = {
    requirement: adapterRecord["requirement"],
    ...(adapterRef === undefined ? {} : { ref: adapterRef }),
  };

  if (!Array.isArray(entry["prerequisites"]) || !Array.isArray(entry["edges"])) return undefined;
  const prerequisites: WorkflowPrerequisite[] = [];
  for (const raw of entry["prerequisites"]) {
    const prerequisite = asRecord(raw);
    const outputs = stringArrayOf(prerequisite?.["outputs"]);
    if (
      prerequisite === undefined ||
      typeof prerequisite["stageId"] !== "string" ||
      typeof prerequisite["when"] !== "string" ||
      outputs === undefined ||
      typeof prerequisite["allowOmitted"] !== "boolean"
    ) {
      return undefined;
    }
    prerequisites.push({
      stageId: prerequisite["stageId"],
      when: prerequisite["when"],
      outputs,
      allowOmitted: prerequisite["allowOmitted"],
    });
  }
  const edges: WorkflowEdge[] = [];
  for (const raw of entry["edges"]) {
    const edge = asRecord(raw);
    if (edge === undefined || typeof edge["to"] !== "string" || typeof edge["when"] !== "string") return undefined;
    edges.push({ to: edge["to"], when: edge["when"] });
  }

  return {
    id: entry["id"],
    semanticKind: entry["semanticKind"],
    prerequisites,
    mutationClass: entry["mutationClass"],
    requiredness: entry["requiredness"],
    candidateBinding: entry["candidateBinding"],
    requiredInputs,
    optionalInputs,
    successOutputs,
    statuses,
    evidenceAdapter,
    edges,
  };
}

/** The graph's declared stage with the given id, when it declares one. */
export function workflowStageOf(graph: WorkflowGraph, stageId: string): WorkflowStage | undefined {
  return graph.stages.find((stage) => stage.id === stageId);
}

export interface WorkflowCheckpointBinding {
  /** The delivery state whose next model-driven checkpoint this is. */
  readonly deliveryState: DeliveryState;
  /** A stage id the bundled graph declares. */
  readonly stageId: string;
  /**
   * Graph-declared `always` prerequisites of this stage that the frozen
   * delivery matrix realizes through LATER product-owned checkpoints rather
   * than through an earlier stage result. Prerequisite evaluation skips
   * exactly these; the graph sensor pins each name to a prerequisite the
   * graph actually declares, so a released graph change surfaces here.
   */
  readonly productRealizedPrerequisites: readonly string[];
}

/**
 * The model-driven checkpoints of the walking skeleton, bound to the bundled
 * graph's own stage names. `remediating` deliberately re-enters `implement` —
 * the graph's produce-or-revise-candidate stage — and `reviewing` binds the
 * lens-evidence acquisition stage.
 *
 * `compound` declares `finish.verify` as a prerequisite, but the frozen
 * delivery matrix orders compounding BEFORE admission/recording/finish-line
 * (`compounding -> admitting -> recording -> ready -> completed`), and the
 * finish-line evidence is enforced by those product-owned checkpoints — a
 * delivery cannot complete without it. The binding records that realization
 * explicitly instead of inventing a stage result the runtime never saw.
 */
export const WORKFLOW_CHECKPOINT_BINDINGS: readonly WorkflowCheckpointBinding[] = Object.freeze([
  { deliveryState: "planning", stageId: "plan", productRealizedPrerequisites: [] },
  { deliveryState: "implementing", stageId: "implement", productRealizedPrerequisites: [] },
  { deliveryState: "remediating", stageId: "implement", productRealizedPrerequisites: [] },
  { deliveryState: "reviewing", stageId: "review.acquire", productRealizedPrerequisites: [] },
  { deliveryState: "compounding", stageId: "compound", productRealizedPrerequisites: ["finish.verify"] },
] as const);

export function workflowStageBindingFor(state: DeliveryState): WorkflowCheckpointBinding | undefined {
  return WORKFLOW_CHECKPOINT_BINDINGS.find((binding) => binding.deliveryState === state);
}
