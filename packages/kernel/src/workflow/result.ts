/**
 * The harness-side half of the released workflow contract: validation of the
 * closed `workflow-stage-result/1` envelope and evaluation of graph-declared
 * stage prerequisites, both DRIVEN BY the pinned graph.
 *
 * WHY GRAPH-DRIVEN. The released schema freezes per-stage statuses, success
 * outputs, and candidate binding as data inside `workflows/delivery-v1.json`;
 * this module reads those declarations from the parsed graph instead of
 * re-authoring them, so the workflow release and this runtime reducer stay
 * independently qualified against the same corpus (the archive's own result
 * templates, replayed by the parity sensor).
 *
 * WHAT A RESULT CANNOT DO — the released contract's authority boundary,
 * enforced here: a result cannot nominate its own trusted candidate (the
 * harness supplies the independently captured current/produced references and
 * comparison is exact), cannot claim a release or graph other than the pinned
 * one, cannot carry unknown members, and cannot substitute prose for the
 * typed envelope. Host-facing skill text guides execution; only a valid typed
 * result advances a checkpoint.
 *
 * The two candidate references arrive as OPAQUE strings, compared exactly and
 * never parsed — the released contract's own rule for versioned opaque
 * references.
 */
import type { WorkflowGraph, WorkflowStage } from "./graph.ts";
import { workflowStageOf } from "./graph.ts";

export const WORKFLOW_STAGE_RESULT_SPEC = "workflow-stage-result/1";
export const WORKFLOW_SUBJECT_REF_SPEC = "workflow-subject-ref/1";
export const WORKFLOW_CANDIDATE_REF_SPEC = "workflow-candidate-ref/1";

/** The exact verified release projection a result must bind. */
export interface WorkflowReleaseIdentity {
  readonly releaseId: string;
  readonly profile: string;
  readonly archiveSha256: string;
  readonly metadataSha256: string;
}

export interface WorkflowResultRejection {
  readonly code:
    | "result_malformed"
    | "release_mismatch"
    | "graph_mismatch"
    | "stage_mismatch"
    | "subject_mismatch"
    | "status_undeclared"
    | "output_undeclared"
    | "candidate_binding_violation"
    | "unsupported_combination"
    | "prerequisite_missing"
    | "prerequisite_unsatisfied";
  readonly pointer: string;
  readonly message: string;
}

export interface StageResultContext {
  readonly graph: WorkflowGraph;
  /** SHA-256 of the exact pinned graph bytes. */
  readonly graphSha256: string;
  readonly release: WorkflowReleaseIdentity;
  /** The stage this checkpoint admits; any other stage id rejects. */
  readonly expectedStageId: string;
  /** The harness-owned opaque subject identity; compared exactly. */
  readonly expectedSubject: string;
  /** The independently captured CURRENT checkpoint candidate, when one exists. */
  readonly currentCandidate?: string;
  /** The independently captured NEW candidate a successful `implement` must bind. */
  readonly producedCandidate?: string;
}

export interface AcceptedStageResult {
  readonly stageId: string;
  readonly status: string;
  readonly outputKind?: string;
  readonly outputEvidenceRef?: string;
  readonly preservationHandoffRef?: string;
  readonly nextStep?: string;
  readonly candidateRef?: string;
  readonly evidenceRefs: readonly string[];
  readonly limitations: readonly string[];
}

export type StageResultVerdict =
  | { readonly ok: true; readonly result: AcceptedStageResult }
  | { readonly ok: false; readonly rejections: readonly WorkflowResultRejection[] };

const RESULT_MEMBERS = new Set([
  "schemaVersion",
  "release",
  "graphSha256",
  "stageId",
  "subjectRef",
  "candidateRef",
  "status",
  "output",
  "evidenceRefs",
  "limitations",
  "nextStep",
]);

const OUTPUT_MEMBERS = new Set(["kind", "evidenceRef", "adapterRef", "trust", "preservationHandoffRef"]);

/** The released schema requires `adapterRef`/`trust` only on these handoffs. */
const ADAPTER_REF_STAGES = new Set(["publish.handoff", "feedback.handoff"]);
const TRUST_STAGES = new Set(["feedback.handoff"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function validateWorkflowStageResult(value: unknown, context: StageResultContext): StageResultVerdict {
  const rejections: WorkflowResultRejection[] = [];
  const reject = (code: WorkflowResultRejection["code"], pointer: string, message: string): void => {
    rejections.push({ code, pointer, message });
  };

  if (!isRecord(value)) {
    return {
      ok: false,
      rejections: [
        {
          code: "result_malformed",
          pointer: "",
          message: "a stage result is a typed workflow-stage-result/1 object; prose cannot advance a checkpoint",
        },
      ],
    };
  }

  for (const member of Object.keys(value)) {
    if (!RESULT_MEMBERS.has(member)) reject("result_malformed", `/${member}`, "member is not defined by the released result envelope");
  }
  for (const member of ["schemaVersion", "release", "graphSha256", "stageId", "subjectRef", "status", "evidenceRefs", "limitations"]) {
    if (value[member] === undefined) reject("result_malformed", `/${member}`, "required member is absent");
  }
  if (rejections.length > 0) return { ok: false, rejections };

  if (value["schemaVersion"] !== WORKFLOW_STAGE_RESULT_SPEC) {
    reject("result_malformed", "/schemaVersion", `expected ${WORKFLOW_STAGE_RESULT_SPEC}`);
  }

  // ── Release and graph binding ──
  const release = value["release"];
  if (!isRecord(release)) {
    reject("result_malformed", "/release", "expected the four-field verified release projection");
  } else {
    const expected: Record<string, string> = { ...context.release };
    for (const member of Object.keys(release)) {
      if (!(member in expected)) reject("result_malformed", `/release/${member}`, "member is not part of the release projection");
    }
    for (const [member, expectation] of Object.entries(expected)) {
      if (release[member] !== expectation) {
        reject("release_mismatch", `/release/${member}`, "the result binds a release other than the pinned one");
      }
    }
  }
  if (value["graphSha256"] !== context.graphSha256) {
    reject("graph_mismatch", "/graphSha256", "the result binds graph bytes other than the pinned graph");
  }

  // ── Stage and subject ──
  const stageId = value["stageId"];
  if (typeof stageId !== "string" || workflowStageOf(context.graph, stageId) === undefined) {
    reject("result_malformed", "/stageId", "the result names no stage the pinned graph declares");
    return { ok: false, rejections };
  }
  if (stageId !== context.expectedStageId) {
    reject("stage_mismatch", "/stageId", `this checkpoint admits ${context.expectedStageId}, not ${stageId}`);
    return { ok: false, rejections };
  }
  const stage = workflowStageOf(context.graph, stageId);
  if (stage === undefined) return { ok: false, rejections }; // unreachable; typed narrow

  const subjectRef = value["subjectRef"];
  if (!isRecord(subjectRef) || subjectRef["schemaVersion"] !== WORKFLOW_SUBJECT_REF_SPEC || !nonBlank(subjectRef["opaque"])) {
    reject("result_malformed", "/subjectRef", "expected a workflow-subject-ref/1 with non-blank opaque text");
  } else {
    for (const member of Object.keys(subjectRef)) {
      if (member !== "schemaVersion" && member !== "opaque") reject("result_malformed", `/subjectRef/${member}`, "unknown member");
    }
    if (subjectRef["opaque"] !== context.expectedSubject) {
      reject("subject_mismatch", "/subjectRef/opaque", "the result names a different subject; comparison is exact");
    }
  }

  // ── Status ──
  const status = value["status"];
  if (typeof status !== "string" || !["succeeded", "blocked", "failed", "indeterminate"].includes(status)) {
    reject("result_malformed", "/status", "expected succeeded, blocked, failed, or indeterminate");
    return { ok: false, rejections };
  }
  if (!stage.statuses.includes(status)) {
    reject("status_undeclared", "/status", `the ${stageId} stage does not declare the ${status} status`);
  }

  // ── Candidate binding, per the stage's released policy ──
  let candidateOpaque: string | undefined;
  const candidateRef = value["candidateRef"];
  if (candidateRef !== undefined) {
    if (!isRecord(candidateRef) || candidateRef["schemaVersion"] !== WORKFLOW_CANDIDATE_REF_SPEC || !nonBlank(candidateRef["opaque"])) {
      reject("result_malformed", "/candidateRef", "expected a workflow-candidate-ref/1 with non-blank opaque text");
    } else {
      for (const member of Object.keys(candidateRef)) {
        if (member !== "schemaVersion" && member !== "opaque") reject("result_malformed", `/candidateRef/${member}`, "unknown member");
      }
      candidateOpaque = candidateRef["opaque"] as string;
    }
  }
  const requireExact = (expected: string | undefined, description: string): void => {
    if (expected === undefined) {
      reject("candidate_binding_violation", "/candidateRef", `no ${description} exists for this checkpoint; the result cannot bind one`);
    } else if (candidateOpaque === undefined) {
      reject("candidate_binding_violation", "/candidateRef", `the ${stageId} stage binds the ${description}; the result names none`);
    } else if (candidateOpaque !== expected) {
      reject("candidate_binding_violation", "/candidateRef/opaque", `the result names a candidate other than the ${description}; a result cannot nominate its own trusted candidate`);
    }
  };
  switch (stage.candidateBinding) {
    case "forbidden": {
      if (candidateRef !== undefined) {
        reject("candidate_binding_violation", "/candidateRef", `the ${stageId} stage forbids a candidate reference`);
      }
      break;
    }
    case "required": {
      requireExact(context.currentCandidate, "current checkpoint candidate");
      break;
    }
    case "checkpoint-contextual": {
      if (context.currentCandidate !== undefined) {
        requireExact(context.currentCandidate, "current checkpoint candidate");
      } else if (candidateRef !== undefined) {
        reject("candidate_binding_violation", "/candidateRef", "no checkpoint candidate exists yet; the result must omit the reference");
      }
      break;
    }
    case "produced-on-success": {
      if (status === "succeeded") {
        requireExact(context.producedCandidate, "independently captured produced candidate");
      } else if (context.currentCandidate !== undefined) {
        requireExact(context.currentCandidate, "prior checkpoint candidate");
      } else if (candidateRef !== undefined) {
        reject("candidate_binding_violation", "/candidateRef", "no prior candidate exists; a non-success result must omit the reference");
      }
      break;
    }
    default: {
      reject("result_malformed", "/candidateRef", `the pinned graph declares an unknown candidate-binding policy ${stage.candidateBinding}`);
      break;
    }
  }

  // ── Success output vs non-success next step ──
  const output = value["output"];
  const nextStep = value["nextStep"];
  let outputKind: string | undefined;
  let outputEvidenceRef: string | undefined;
  let preservationHandoffRef: string | undefined;
  if (status === "succeeded") {
    if (nextStep !== undefined) {
      reject("unsupported_combination", "/nextStep", "a successful result carries its output, never a next step");
    }
    if (!isRecord(output)) {
      reject("result_malformed", "/output", "a successful result carries a closed output object");
    } else {
      for (const member of Object.keys(output)) {
        if (!OUTPUT_MEMBERS.has(member)) reject("result_malformed", `/output/${member}`, "member is not defined by the released output shape");
      }
      const kind = output["kind"];
      if (typeof kind !== "string" || !nonBlank(output["evidenceRef"])) {
        reject("result_malformed", "/output", "an output carries a kind and a non-blank retained evidence reference");
      } else {
        if (!stage.successOutputs.includes(kind)) {
          reject("output_undeclared", "/output/kind", `the ${stageId} stage does not declare the ${kind} success output`);
        }
        outputKind = kind;
        outputEvidenceRef = output["evidenceRef"] as string;
      }

      const adapterRef = output["adapterRef"];
      if (ADAPTER_REF_STAGES.has(stageId)) {
        if (!nonBlank(adapterRef) || (stage.evidenceAdapter.ref !== undefined && adapterRef !== stage.evidenceAdapter.ref)) {
          reject("unsupported_combination", "/output/adapterRef", `a successful ${stageId} output names the graph's declared adapter slot`);
        }
      } else if (adapterRef !== undefined) {
        reject("unsupported_combination", "/output/adapterRef", `the ${stageId} stage carries no adapter reference`);
      }

      const trust = output["trust"];
      if (TRUST_STAGES.has(stageId)) {
        if (trust !== "untrusted") {
          reject("unsupported_combination", "/output/trust", "normalized external feedback is consumed untrusted, and says so");
        }
      } else if (trust !== undefined) {
        reject("unsupported_combination", "/output/trust", `the ${stageId} stage carries no trust marker`);
      }

      const preservation = output["preservationHandoffRef"];
      if (outputKind === "learning-required") {
        if (!nonBlank(preservation)) {
          reject("unsupported_combination", "/output/preservationHandoffRef", "learning-required hands off to repository-owned preservation by reference");
        } else {
          preservationHandoffRef = preservation;
        }
      } else if (preservation !== undefined) {
        reject("unsupported_combination", "/output/preservationHandoffRef", "only learning-required carries a preservation handoff");
      }
    }
  } else {
    if (output !== undefined) {
      reject("unsupported_combination", "/output", "blocked, failed, and indeterminate are statuses, never outputs");
    }
    if (!nonBlank(nextStep)) {
      reject("result_malformed", "/nextStep", "a non-success result carries exactly one non-blank actionable next step");
    }
  }

  // ── Evidence and limitation lists ──
  const uniqueStrings = (member: "evidenceRefs" | "limitations"): readonly string[] | undefined => {
    const list = value[member];
    if (!Array.isArray(list) || !list.every(nonBlank)) {
      reject("result_malformed", `/${member}`, "expected an array of non-blank strings");
      return undefined;
    }
    if (new Set(list).size !== list.length) {
      reject("result_malformed", `/${member}`, "entries must be unique");
      return undefined;
    }
    return list as string[];
  };
  const evidenceRefs = uniqueStrings("evidenceRefs");
  const limitations = uniqueStrings("limitations");

  if (rejections.length > 0) return { ok: false, rejections };
  return {
    ok: true,
    result: {
      stageId,
      status,
      ...(outputKind === undefined ? {} : { outputKind }),
      ...(outputEvidenceRef === undefined ? {} : { outputEvidenceRef }),
      ...(preservationHandoffRef === undefined ? {} : { preservationHandoffRef }),
      ...(nonBlank(nextStep) ? { nextStep } : {}),
      ...(candidateOpaque === undefined ? {} : { candidateRef: candidateOpaque }),
      evidenceRefs: evidenceRefs ?? [],
      limitations: limitations ?? [],
    },
  };
}

// ── Prerequisite evaluation ────────────────────────────────────────────────

/** A harness-retained summary of an already-admitted stage result. */
export interface CompletedStageSummary {
  readonly status: string;
  readonly outputKind?: string;
}

export interface PrerequisiteOptions {
  /** The plan/implementation path invoked diagnosis (never, in the managed flow's V-slice). */
  readonly diagnosisInvoked?: boolean;
  /** This checkpoint acquires a repair round after recorded changes-requested evidence. */
  readonly repairLoop?: boolean;
  /**
   * Stage ids whose evidence the frozen delivery matrix realizes through
   * later product-owned checkpoints; the binding table declares them, the
   * graph sensor pins them, and evaluation skips exactly these.
   */
  readonly productRealized?: readonly string[];
}

export type PrerequisiteVerdict = { readonly ok: true } | { readonly ok: false; readonly rejections: readonly WorkflowResultRejection[] };

/**
 * Evaluates the stage's graph-declared prerequisites against the summaries
 * the harness retained from its own journal. A summary satisfies only with
 * `succeeded` status and a declared output kind; non-success summaries are
 * retained but never satisfy — the released contract's rule.
 */
export function evaluateStagePrerequisites(
  stage: WorkflowStage,
  completed: ReadonlyMap<string, CompletedStageSummary>,
  options: PrerequisiteOptions,
): PrerequisiteVerdict {
  const rejections: WorkflowResultRejection[] = [];
  for (const prerequisite of stage.prerequisites) {
    const applies =
      prerequisite.when === "always" ||
      prerequisite.when === "effective" || // omission tolerance rides allowOmitted
      (prerequisite.when === "diagnosis-invoked" && options.diagnosisInvoked === true) ||
      (prerequisite.when === "repair-loop" && options.repairLoop === true);
    // `diagnostic-subflow` guards the diagnose stage's own invocation
    // evidence; no managed checkpoint binds diagnose, so it never applies.
    if (!applies) continue;
    if ((options.productRealized ?? []).includes(prerequisite.stageId)) continue;

    const satisfies = (summary: CompletedStageSummary | undefined): boolean =>
      summary !== undefined &&
      summary.status === "succeeded" &&
      summary.outputKind !== undefined &&
      prerequisite.outputs.includes(summary.outputKind);

    if (prerequisite.stageId.startsWith("$")) {
      // A placeholder source: any retained summary carrying one of the
      // declared output kinds satisfies it.
      const anySatisfies = [...completed.values()].some((summary) => satisfies(summary));
      if (!anySatisfies) {
        rejections.push({
          code: "prerequisite_missing",
          pointer: `/prerequisites/${prerequisite.stageId}`,
          message: `no retained stage summary carries ${prerequisite.outputs.join(" or ")} for the ${prerequisite.when} prerequisite`,
        });
      }
      continue;
    }

    const summary = completed.get(prerequisite.stageId);
    if (summary === undefined) {
      if (!prerequisite.allowOmitted) {
        rejections.push({
          code: "prerequisite_missing",
          pointer: `/prerequisites/${prerequisite.stageId}`,
          message: `the ${stage.id} stage requires admitted ${prerequisite.stageId} evidence and none is retained`,
        });
      }
      continue;
    }
    if (!satisfies(summary)) {
      rejections.push({
        code: "prerequisite_unsatisfied",
        pointer: `/prerequisites/${prerequisite.stageId}`,
        message: `the retained ${prerequisite.stageId} summary (${summary.status}${summary.outputKind === undefined ? "" : `, ${summary.outputKind}`}) does not satisfy ${prerequisite.outputs.join(" or ")}`,
      });
    }
  }
  return rejections.length > 0 ? { ok: false, rejections } : { ok: true };
}
