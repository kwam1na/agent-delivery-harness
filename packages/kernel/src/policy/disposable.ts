/**
 * The walking skeleton's fixed policy, now DERIVED: one disposable-repository
 * policy document and one sensor adapter, run through the real compiler in
 * `compile.ts`. The module's ports are unchanged — callers still consume a
 * compiled `policy-snapshot/1` and an `execution-grant/1`, never ad-hoc
 * values — and the compiled snapshot is member-for-member what the original
 * fixed slice produced, so every digest bound before this hardening still
 * recomputes.
 *
 * The compiled snapshot activates BOTH mandatory review lenses and a non-empty
 * obligation set, so `reviewing` and `admitting` can never be passed by
 * absence; it grants exactly the merge-ready finish line and no external
 * authority — absence of a grant is denial, and nothing model-written can
 * widen it.
 */
import type { PolicySnapshot } from "../spine/policy.ts";
import { PORTABLE_STAGE_GRANT, compileRepositoryPolicy } from "./compile.ts";
import { REPOSITORY_POLICY_DOCUMENT_SPEC } from "./document.ts";

export { MANDATORY_LENS_CATEGORIES } from "./compile.ts";

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
  const result = compileRepositoryPolicy({
    document: {
      spec: REPOSITORY_POLICY_DOCUMENT_SPEC,
      repositoryId: input.repositoryId,
      policyGeneration: 1,
      grantedFinishLines: ["merge-ready"],
      grantedAuthority: [],
      forbiddenAuthority: [],
      reviewLenses: DISPOSABLE_REVIEW_LENSES.map((lens) => ({ ...lens })),
      obligations: [{ obligationId: "outcome.verification" }, { obligationId: "review.green" }],
      requiredCapabilities: [
        {
          capabilityId: DISPOSABLE_SENSOR_CAPABILITY.descriptor.capabilityId,
          kind: "sensor",
          version: DISPOSABLE_SENSOR_CAPABILITY.descriptor.version,
        },
      ],
      approvals: [],
      trackerAbsenceFallback: "proceed-without-tracker",
    },
    adapters: [
      {
        spec: "adapter-capability/1",
        capabilityId: DISPOSABLE_SENSOR_CAPABILITY.descriptor.capabilityId,
        kind: "sensor",
        version: DISPOSABLE_SENSOR_CAPABILITY.descriptor.version,
        resultSpec: DISPOSABLE_SENSOR_CAPABILITY.descriptor.resultSpec,
      },
    ],
    productTrustRevocationEpoch: input.productTrustRevocationEpoch,
    repositoryAuthorityRevocationEpoch: input.repositoryAuthorityRevocationEpoch,
  });
  if (!result.ok) {
    // The inputs above are fixed; a rejection here is a defect, not a state.
    throw new Error(`the disposable policy no longer compiles: ${JSON.stringify(result.rejections)}`);
  }
  return result.compiled.snapshot;
}

/**
 * The ONE fixed stage grant every model-driven checkpoint of the skeleton
 * runs under — the compiler's portable default envelope, unchanged: host
 * tool families, writable paths scoped to the disposable repository's source
 * layout, and the delivery authority paths protected.
 */
export const DISPOSABLE_STAGE_GRANT = PORTABLE_STAGE_GRANT;
