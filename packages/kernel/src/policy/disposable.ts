/**
 * The policy module's V-slice: ONE fixed disposable policy and ONE fixed
 * stage grant, compiled into the frozen spine shapes. This is deliberately
 * not a policy compiler — layered repository declarations, adapter loading,
 * and the capability taxonomy arrive with the policy unit — but it IS the
 * final module boundary that unit hardens: callers consume a compiled
 * `policy-snapshot/1` and an `execution-grant/1`, never ad-hoc values.
 *
 * The compiled snapshot activates BOTH mandatory review lenses and a non-empty
 * obligation set, so `reviewing` and `admitting` can never be passed by
 * absence; it grants exactly the merge-ready finish line and no external
 * authority — absence of a grant is denial, and nothing model-written can
 * widen it.
 */
import { digestCanonical } from "../digest.ts";
import type { PolicySnapshot } from "../spine/policy.ts";

/** The two mandatory lens categories — the review floor is not lowered. */
export const MANDATORY_LENS_CATEGORIES = Object.freeze(["outcome-correctness", "testing-policy"] as const);

/** The two lenses the fixed policy activates, one per mandatory category. */
export const DISPOSABLE_REVIEW_LENSES = Object.freeze([
  { lensId: "lens.outcome-correctness", category: "outcome-correctness" },
  { lensId: "lens.testing-policy", category: "testing-policy" },
] as const);

/**
 * The one trusted sensor: the disposable repository's acceptance sensor. Its
 * executable bytes are copied from the TRUSTED PRE-RUN BASE at policy-bind
 * time and executed only from that copy — a candidate rewriting the tracked
 * file changes a future owner-approved run, never the current judgement.
 */
export const DISPOSABLE_SENSOR_CAPABILITY = Object.freeze({
  descriptor: Object.freeze({
    spec: "capability-descriptor/1",
    capabilityId: "sensor.acceptance",
    kind: "sensor",
    version: "1",
    resultSpec: "sensor-result/1",
  }),
  /** Where the sensor lives in the repository tree, resolved from the base commit. */
  trustedBasePath: "tools/sensor.mjs",
} as const);

export interface CompileDisposablePolicyInput {
  readonly repositoryId: string;
  readonly productTrustRevocationEpoch: number;
  readonly repositoryAuthorityRevocationEpoch: number;
}

/** Compiles the fixed policy for one disposable repository. Digest self-binds. */
export function compileDisposablePolicy(input: CompileDisposablePolicyInput): PolicySnapshot {
  const body = {
    spec: "policy-snapshot/1",
    repositoryId: input.repositoryId,
    productTrustRevocationEpoch: input.productTrustRevocationEpoch,
    repositoryAuthorityRevocationEpoch: input.repositoryAuthorityRevocationEpoch,
    grantedFinishLines: ["merge-ready"],
    grantedAuthority: [],
    reviewLenses: DISPOSABLE_REVIEW_LENSES.map((lens) => ({ ...lens })),
    obligations: [{ obligationId: "outcome.verification" }, { obligationId: "review.green" }],
  } as const;
  return { ...body, policyDigest: digestCanonical(body) } as PolicySnapshot;
}

/**
 * The ONE fixed stage grant every model-driven checkpoint of the skeleton
 * runs under: the host's native tool families, writable paths scoped to the
 * disposable repository's source layout, and the delivery authority paths
 * protected. Per-checkpoint grant envelopes are the policy unit's hardening;
 * the walking skeleton deliberately carries one envelope.
 */
export const DISPOSABLE_STAGE_GRANT = Object.freeze({
  spec: "execution-grant/1",
  profile: "checkpoint",
  allowedCapabilities: Object.freeze([
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Task",
    "TodoWrite",
  ]),
  writablePaths: Object.freeze(["src", "tests", "tools", "telemetry", "docs"]),
  protectedPaths: Object.freeze([".git", ".managed-projection", ".claude"]),
  forbiddenOperations: Object.freeze(["git.push", "merge", "deploy"]),
} as const);
