/**
 * The workflow module's V-slice: the BUNDLED `workflow-graph/1` document from
 * the exact pinned `agent-skills` release — loaded, digest-verified against
 * the frozen pin, and mapped onto the skeleton's model-driven checkpoints.
 * The graph is pinned, never re-authored: this module rejects bytes that do
 * not hash to the frozen `workflowGraphSha256`, and the checkpoint bindings
 * may name only stages the graph itself declares.
 *
 * The mapping is deliberately narrow. Only the delivery states whose next
 * checkpoint is a model-driven WORKFLOW stage carry a binding; sensor runs in
 * `validating` are repository operation results (`operation.result.recorded`),
 * not workflow stages, and the product-owned checkpoints (admission,
 * recording, finish line) have no stage either. Broad stage semantics,
 * retries, and evidence adapters are the workflow unit's hardening — the
 * binding table's shape stays.
 */
import { sha256Hex } from "../digest.ts";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";
import type { DeliveryState } from "../spine/vocabulary.ts";
import { readArchiveEntry } from "./archive.ts";

/** Where the bundled graph lives inside the pinned release archive. */
export const WORKFLOW_GRAPH_ENTRY = "workflows/delivery-v1.json";

export interface WorkflowStage {
  readonly id: string;
  readonly semanticKind: string;
  readonly mutationClass: string;
  readonly requiredness: string;
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
    const entry = typeof stage === "object" && stage !== null ? (stage as Record<string, unknown>) : undefined;
    if (
      entry === undefined ||
      typeof entry["id"] !== "string" ||
      typeof entry["semanticKind"] !== "string" ||
      typeof entry["mutationClass"] !== "string" ||
      typeof entry["requiredness"] !== "string"
    ) {
      return {
        ok: false,
        blockers: [{ code: "workflow_graph_malformed", message: "a bundled graph stage is outside its declared shape" }],
      };
    }
    parsedStages.push({
      id: entry["id"],
      semanticKind: entry["semanticKind"],
      mutationClass: entry["mutationClass"],
      requiredness: entry["requiredness"],
    });
  }
  return {
    ok: true,
    graph: { schemaVersion: "workflow-graph/1", graphId: record["graphId"], stages: parsedStages },
    graphSha256: digest,
    bytes,
  };
}

export interface WorkflowCheckpointBinding {
  /** The delivery state whose next model-driven checkpoint this is. */
  readonly deliveryState: DeliveryState;
  /** A stage id the bundled graph declares. */
  readonly stageId: string;
}

/**
 * The model-driven checkpoints of the walking skeleton, bound to the bundled
 * graph's own stage names. `remediating` deliberately re-enters `implement` —
 * the graph's produce-or-revise-candidate stage — and `reviewing` binds the
 * lens-evidence acquisition stage.
 */
export const WORKFLOW_CHECKPOINT_BINDINGS: readonly WorkflowCheckpointBinding[] = Object.freeze([
  { deliveryState: "planning", stageId: "plan" },
  { deliveryState: "implementing", stageId: "implement" },
  { deliveryState: "remediating", stageId: "implement" },
  { deliveryState: "reviewing", stageId: "review.acquire" },
  { deliveryState: "compounding", stageId: "compound" },
] as const);

export function workflowStageBindingFor(state: DeliveryState): WorkflowCheckpointBinding | undefined {
  return WORKFLOW_CHECKPOINT_BINDINGS.find((binding) => binding.deliveryState === state);
}
