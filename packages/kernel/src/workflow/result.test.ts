/**
 * The harness-side stage-result contract: the closed `workflow-stage-result/1`
 * envelope, validated AGAINST THE PINNED GRAPH — per-stage statuses, success
 * outputs, and candidate-binding policy come from the released graph itself,
 * never from a re-authored table — plus the prerequisite evaluation the
 * checkpoint reducer runs before persisting a typed result.
 *
 * PARITY IS THE POINT. The released archive ships its own unbound result
 * templates (`tests/fixtures/workflow-graph/result-templates.json`); the
 * parity block binds every template with runtime identities and replays it
 * through this validator, so the workflow release and the runtime reducer
 * stay independently qualified against the same corpus. A future
 * skills-archive release whose results this validator refuses — or whose
 * refusals this validator accepts — goes red here.
 *
 * Written RED before `result.ts` existed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";
import { readArchiveEntry } from "./archive.ts";
import { loadBundledWorkflowGraph, workflowStageOf, type WorkflowGraph } from "./graph.ts";
import {
  evaluateStagePrerequisites,
  validateWorkflowStageResult,
  type StageResultContext,
} from "./result.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "fixtures");
const archiveBytes = readFileSync(path.join(FIXTURES, "agent-skills-core-v1-composition.zip"));

const loaded = loadBundledWorkflowGraph(archiveBytes);
if (!loaded.ok) throw new Error("the pinned graph must load for these tests");
const graph: WorkflowGraph = loaded.graph;
const graphSha256: string = loaded.graphSha256;

const RELEASE = {
  releaseId: PINNED_AGENT_SKILLS.releaseId,
  profile: PINNED_AGENT_SKILLS.profile,
  archiveSha256: PINNED_AGENT_SKILLS.archiveSha256,
  metadataSha256: PINNED_AGENT_SKILLS.metadataSha256,
} as const;

const SUBJECT = "dlv-parity-1";
const CURRENT = "tree-current-aaaa";
const PRODUCED = "tree-produced-bbbb";

const contextFor = (stageId: string, overrides: Partial<StageResultContext> = {}): StageResultContext => ({
  graph,
  graphSha256: graphSha256,
  release: RELEASE,
  expectedStageId: stageId,
  expectedSubject: SUBJECT,
  ...overrides,
});

interface Template {
  readonly stageId: string;
  readonly status: string;
  readonly output?: Record<string, unknown>;
  readonly evidenceRefs: readonly string[];
  readonly limitations: readonly string[];
}

const templates = (
  JSON.parse(Buffer.from(readArchiveEntry(archiveBytes, "tests/fixtures/workflow-graph/result-templates.json")).toString("utf8")) as {
    results: readonly Template[];
  }
).results;

/** Binds one released template with runtime identities, per the stage's candidate-binding policy. */
function bindTemplate(template: Template): { value: Record<string, unknown>; context: StageResultContext } {
  const stage = workflowStageOf(graph, template.stageId);
  if (stage === undefined) throw new Error(`template names unknown stage ${template.stageId}`);
  const value: Record<string, unknown> = {
    schemaVersion: "workflow-stage-result/1",
    release: { ...RELEASE },
    graphSha256: graphSha256,
    stageId: template.stageId,
    subjectRef: { schemaVersion: "workflow-subject-ref/1", opaque: SUBJECT },
    status: template.status,
    ...(template.output === undefined ? {} : { output: { ...template.output } }),
    evidenceRefs: [...template.evidenceRefs],
    limitations: [...template.limitations],
  };
  const context = contextFor(template.stageId, {
    currentCandidate: CURRENT,
    ...(template.stageId === "implement" ? { producedCandidate: PRODUCED } : {}),
  });
  if (stage.candidateBinding === "forbidden") {
    // no candidateRef, and none expected
    return { value, context: contextFor(template.stageId) };
  }
  const opaque = stage.candidateBinding === "produced-on-success" && template.status === "succeeded" ? PRODUCED : CURRENT;
  value["candidateRef"] = { schemaVersion: "workflow-candidate-ref/1", opaque };
  return { value, context };
}

describe("parity with the released result templates", () => {
  for (const template of templates) {
    it(`accepts the released ${template.stageId} template once bound`, () => {
      const { value, context } = bindTemplate(template);
      const verdict = validateWorkflowStageResult(value, context);
      expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    });
  }

  it("covers every stage the graph declares — the corpus cannot silently narrow", () => {
    const covered = new Set(templates.map((template) => template.stageId));
    for (const stage of graph.stages) {
      expect(covered.has(stage.id), stage.id).toBe(true);
    }
  });
});

// A bound, valid plan success result to mutate from.
const planResult = (): Record<string, unknown> => ({
  schemaVersion: "workflow-stage-result/1",
  release: { ...RELEASE },
  graphSha256: graphSha256,
  stageId: "plan",
  subjectRef: { schemaVersion: "workflow-subject-ref/1", opaque: SUBJECT },
  status: "succeeded",
  output: { kind: "bounded-plan", evidenceRef: "retained-output" },
  evidenceRefs: ["retained-observation"],
  limitations: [],
});

const codesOf = (verdict: ReturnType<typeof validateWorkflowStageResult>): string[] =>
  verdict.ok ? [] : verdict.rejections.map((rejection) => rejection.code);

describe("the closed result envelope", () => {
  it("accepts a bound plan success with no candidate before one exists", () => {
    expect(validateWorkflowStageResult(planResult(), contextFor("plan")).ok).toBe(true);
  });

  it("rejects prose — a string is not a typed result", () => {
    expect(codesOf(validateWorkflowStageResult("bounded plan: do the thing", contextFor("plan")))).toContain("result_malformed");
  });

  it("rejects an unknown member at the envelope boundary", () => {
    expect(codesOf(validateWorkflowStageResult({ ...planResult(), approval: "granted" }, contextFor("plan")))).toContain(
      "result_malformed",
    );
  });

  it("rejects a result bound to a different release, graph, stage, or subject", () => {
    expect(
      codesOf(validateWorkflowStageResult({ ...planResult(), release: { ...RELEASE, releaseId: "core-v2" } }, contextFor("plan"))),
    ).toContain("release_mismatch");
    expect(
      codesOf(validateWorkflowStageResult({ ...planResult(), graphSha256: "a".repeat(64) }, contextFor("plan"))),
    ).toContain("graph_mismatch");
    expect(codesOf(validateWorkflowStageResult(planResult(), contextFor("compound", { currentCandidate: CURRENT })))).toContain(
      "stage_mismatch",
    );
    expect(
      codesOf(
        validateWorkflowStageResult(
          { ...planResult(), subjectRef: { schemaVersion: "workflow-subject-ref/1", opaque: "someone-else" } },
          contextFor("plan"),
        ),
      ),
    ).toContain("subject_mismatch");
  });

  it("rejects a status the stage does not declare", () => {
    // The released graph declares no `indeterminate` for plan.
    expect(
      codesOf(validateWorkflowStageResult({ ...planResult(), status: "indeterminate", nextStep: "retry", output: undefined }, contextFor("plan"))),
    ).toContain("status_undeclared");
  });

  it("rejects an output kind outside the stage's declared success outputs", () => {
    const value = { ...planResult(), output: { kind: "delivery-candidate", evidenceRef: "retained-output" } };
    expect(codesOf(validateWorkflowStageResult(value, contextFor("plan")))).toContain("output_undeclared");
  });

  it("requires exactly one of output (success) or nextStep (non-success)", () => {
    expect(codesOf(validateWorkflowStageResult({ ...planResult(), nextStep: "also" }, contextFor("plan")))).toContain(
      "unsupported_combination",
    );
    const blocked: Record<string, unknown> = { ...planResult(), status: "blocked" };
    delete blocked["output"];
    expect(codesOf(validateWorkflowStageResult(blocked, contextFor("plan")))).toContain("result_malformed");
    blocked["nextStep"] = "name the missing decision and re-plan";
    expect(validateWorkflowStageResult(blocked, contextFor("plan")).ok).toBe(true);
  });

  it("rejects duplicate or empty evidence references", () => {
    expect(
      codesOf(validateWorkflowStageResult({ ...planResult(), evidenceRefs: ["a", "a"] }, contextFor("plan"))),
    ).toContain("result_malformed");
    expect(codesOf(validateWorkflowStageResult({ ...planResult(), evidenceRefs: [" "] }, contextFor("plan")))).toContain(
      "result_malformed",
    );
  });
});

describe("candidate binding, per the released policy table", () => {
  const intakeSuccess = (): Record<string, unknown> => ({
    schemaVersion: "workflow-stage-result/1",
    release: { ...RELEASE },
    graphSha256: graphSha256,
    stageId: "intake",
    subjectRef: { schemaVersion: "workflow-subject-ref/1", opaque: SUBJECT },
    status: "succeeded",
    output: { kind: "scoped-subject", evidenceRef: "retained-output" },
    evidenceRefs: [],
    limitations: [],
  });

  it("forbidden: intake may not bind a candidate even when the harness has one", () => {
    const value = { ...intakeSuccess(), candidateRef: { schemaVersion: "workflow-candidate-ref/1", opaque: CURRENT } };
    expect(codesOf(validateWorkflowStageResult(value, contextFor("intake", { currentCandidate: CURRENT })))).toContain(
      "candidate_binding_violation",
    );
  });

  const compoundSuccess = (opaque?: string): Record<string, unknown> => ({
    schemaVersion: "workflow-stage-result/1",
    release: { ...RELEASE },
    graphSha256: graphSha256,
    stageId: "compound",
    subjectRef: { schemaVersion: "workflow-subject-ref/1", opaque: SUBJECT },
    ...(opaque === undefined ? {} : { candidateRef: { schemaVersion: "workflow-candidate-ref/1", opaque } }),
    status: "succeeded",
    output: { kind: "no-reusable-learning", evidenceRef: "retained-output" },
    evidenceRefs: [],
    limitations: [],
  });

  it("required: the exact current checkpoint candidate, or rejection", () => {
    expect(validateWorkflowStageResult(compoundSuccess(CURRENT), contextFor("compound", { currentCandidate: CURRENT })).ok).toBe(true);
    expect(codesOf(validateWorkflowStageResult(compoundSuccess(), contextFor("compound", { currentCandidate: CURRENT })))).toContain(
      "candidate_binding_violation",
    );
    expect(
      codesOf(validateWorkflowStageResult(compoundSuccess("tree-speculative"), contextFor("compound", { currentCandidate: CURRENT }))),
    ).toContain("candidate_binding_violation");
  });

  const implementResult = (status: string, opaque?: string): Record<string, unknown> => ({
    schemaVersion: "workflow-stage-result/1",
    release: { ...RELEASE },
    graphSha256: graphSha256,
    stageId: "implement",
    subjectRef: { schemaVersion: "workflow-subject-ref/1", opaque: SUBJECT },
    ...(opaque === undefined ? {} : { candidateRef: { schemaVersion: "workflow-candidate-ref/1", opaque } }),
    status,
    ...(status === "succeeded"
      ? { output: { kind: "delivery-candidate", evidenceRef: "retained-output" } }
      : { nextStep: "repair and retry" }),
    evidenceRefs: [],
    limitations: [],
  });

  it("produced-on-success: success binds the independently captured NEW candidate, never its own claim", () => {
    const context = contextFor("implement", { currentCandidate: CURRENT, producedCandidate: PRODUCED });
    expect(validateWorkflowStageResult(implementResult("succeeded", PRODUCED), context).ok).toBe(true);
    expect(codesOf(validateWorkflowStageResult(implementResult("succeeded", "tree-self-claimed"), context))).toContain(
      "candidate_binding_violation",
    );
    expect(codesOf(validateWorkflowStageResult(implementResult("succeeded"), context))).toContain("candidate_binding_violation");
  });

  it("produced-on-success: non-success retains the prior candidate, or omits before one exists", () => {
    const withPrior = contextFor("implement", { currentCandidate: CURRENT });
    expect(validateWorkflowStageResult(implementResult("failed", CURRENT), withPrior).ok).toBe(true);
    expect(codesOf(validateWorkflowStageResult(implementResult("failed", PRODUCED), withPrior))).toContain(
      "candidate_binding_violation",
    );
    const noPrior = contextFor("implement", { producedCandidate: PRODUCED });
    expect(validateWorkflowStageResult(implementResult("failed"), noPrior).ok).toBe(true);
  });

  it("checkpoint-contextual: bind the current candidate when one exists, omit otherwise", () => {
    expect(validateWorkflowStageResult(planResult(), contextFor("plan")).ok).toBe(true);
    const bound = { ...planResult(), candidateRef: { schemaVersion: "workflow-candidate-ref/1", opaque: CURRENT } };
    expect(validateWorkflowStageResult(bound, contextFor("plan", { currentCandidate: CURRENT })).ok).toBe(true);
    expect(codesOf(validateWorkflowStageResult(planResult(), contextFor("plan", { currentCandidate: CURRENT })))).toContain(
      "candidate_binding_violation",
    );
    expect(codesOf(validateWorkflowStageResult(bound, contextFor("plan")))).toContain("candidate_binding_violation");
  });
});

describe("typed handoff members", () => {
  const compoundLearning = (output: Record<string, unknown>): Record<string, unknown> => ({
    schemaVersion: "workflow-stage-result/1",
    release: { ...RELEASE },
    graphSha256: graphSha256,
    stageId: "compound",
    subjectRef: { schemaVersion: "workflow-subject-ref/1", opaque: SUBJECT },
    candidateRef: { schemaVersion: "workflow-candidate-ref/1", opaque: CURRENT },
    status: "succeeded",
    output,
    evidenceRefs: [],
    limitations: [],
  });
  const compoundContext = contextFor("compound", { currentCandidate: CURRENT });

  it("learning-required carries a preservation handoff; no-reusable-learning must not", () => {
    expect(
      validateWorkflowStageResult(
        compoundLearning({ kind: "learning-required", evidenceRef: "retained-output", preservationHandoffRef: "repository-preservation" }),
        compoundContext,
      ).ok,
    ).toBe(true);
    expect(
      codesOf(validateWorkflowStageResult(compoundLearning({ kind: "learning-required", evidenceRef: "retained-output" }), compoundContext)),
    ).toContain("unsupported_combination");
    expect(
      codesOf(
        validateWorkflowStageResult(
          compoundLearning({ kind: "no-reusable-learning", evidenceRef: "retained-output", preservationHandoffRef: "x" }),
          compoundContext,
        ),
      ),
    ).toContain("unsupported_combination");
  });

  it("adapterRef and trust ride only their released handoff stages", () => {
    expect(
      codesOf(
        validateWorkflowStageResult(
          { ...planResult(), output: { kind: "bounded-plan", evidenceRef: "retained-output", adapterRef: "review-evidence" } },
          contextFor("plan"),
        ),
      ),
    ).toContain("unsupported_combination");
    expect(
      codesOf(
        validateWorkflowStageResult(
          { ...planResult(), output: { kind: "bounded-plan", evidenceRef: "retained-output", trust: "untrusted" } },
          contextFor("plan"),
        ),
      ),
    ).toContain("unsupported_combination");
  });
});

describe("prerequisite evaluation over harness-retained summaries", () => {
  const completed = (entries: Record<string, { status: string; outputKind?: string }>) => new Map(Object.entries(entries));

  it("plan requires the scoped subject from intake", () => {
    const stage = workflowStageOf(graph, "plan");
    if (stage === undefined) throw new Error("unreachable");
    expect(evaluateStagePrerequisites(stage, completed({ intake: { status: "succeeded", outputKind: "scoped-subject" } }), {}).ok).toBe(true);
    const missing = evaluateStagePrerequisites(stage, completed({}), {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.rejections[0]?.code).toBe("prerequisite_missing");
  });

  it("implement requires a succeeded bounded plan — a blocked plan does not satisfy", () => {
    const stage = workflowStageOf(graph, "implement");
    if (stage === undefined) throw new Error("unreachable");
    expect(
      evaluateStagePrerequisites(stage, completed({ plan: { status: "succeeded", outputKind: "bounded-plan" } }), {}).ok,
    ).toBe(true);
    const blocked = evaluateStagePrerequisites(stage, completed({ plan: { status: "blocked" } }), {});
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.rejections[0]?.code).toBe("prerequisite_unsatisfied");
  });

  it("a diagnosis-invoked prerequisite bites only when diagnosis was invoked", () => {
    const stage = workflowStageOf(graph, "implement");
    if (stage === undefined) throw new Error("unreachable");
    const summaries = completed({ plan: { status: "succeeded", outputKind: "bounded-plan" } });
    expect(evaluateStagePrerequisites(stage, summaries, {}).ok).toBe(true);
    expect(evaluateStagePrerequisites(stage, summaries, { diagnosisInvoked: true }).ok).toBe(false);
  });

  it("a repair-loop round requires recorded changes-requested evidence from the repair source", () => {
    const stage = workflowStageOf(graph, "review.acquire");
    if (stage === undefined) throw new Error("unreachable");
    const base = { implement: { status: "succeeded", outputKind: "delivery-candidate" } };
    expect(evaluateStagePrerequisites(stage, completed(base), {}).ok).toBe(true);
    expect(evaluateStagePrerequisites(stage, completed(base), { repairLoop: true }).ok).toBe(false);
    expect(
      evaluateStagePrerequisites(
        stage,
        completed({ ...base, "review.reduce": { status: "succeeded", outputKind: "review-round-changes-requested" } }),
        { repairLoop: true },
      ).ok,
    ).toBe(true);
  });

  it("compound's finish-line prerequisite is skipped only when the binding declares it product-realized", () => {
    const stage = workflowStageOf(graph, "compound");
    if (stage === undefined) throw new Error("unreachable");
    expect(evaluateStagePrerequisites(stage, completed({}), {}).ok).toBe(false);
    expect(evaluateStagePrerequisites(stage, completed({}), { productRealized: ["finish.verify"] }).ok).toBe(true);
  });
});
