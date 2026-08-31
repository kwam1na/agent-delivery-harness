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
import { sha256Hex } from "../digest.ts";
import type { PolicySnapshot } from "../spine/policy.ts";
import { PORTABLE_INTAKE_GRANT, PORTABLE_STAGE_GRANT, compileRepositoryPolicy } from "./compile.ts";
import { REPOSITORY_POLICY_DOCUMENT_SPEC } from "./document.ts";

export { MANDATORY_LENS_CATEGORIES } from "./compile.ts";

/**
 * The fixed policy's declared outcome authorities: the identities allowed to
 * confirm that an intended OUTCOME changed, as opposed to merely waiving a
 * criterion. A repository declaring none cannot amend an outcome mid-delivery
 * at all — absence of a grant is denial — so the disposable policy declares
 * exactly one, and no agent identity is ever in the list.
 *
 * Like the lens and sensor constants beside it, this is fixed-policy data the
 * skeleton reads directly; the layered policy document generalizes it along
 * with them.
 */
export const DISPOSABLE_OUTCOME_AUTHORITIES: readonly string[] = Object.freeze(["operator"]);

/**
 * The two lenses the fixed policy activates, one per mandatory category, each
 * naming the reviewer charter its reviewer is handed. The disposable
 * repository owns its charters, so the compiled declaration pins their digests
 * and the bytes are read from the trusted pre-run base — a candidate rewriting
 * a tracked charter changes a future owner-approved run, never this one.
 */
export const DISPOSABLE_REVIEW_LENSES = Object.freeze([
  { lensId: "lens.outcome-correctness", category: "outcome-correctness", personaId: "persona.outcome-correctness" },
  { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
] as const);

/** Where each of those charters lives in the repository tree, resolved from the base commit. */
export const DISPOSABLE_PERSONA_TRUSTED_BASE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "persona.outcome-correctness": "delivery/personas/outcome-correctness.md",
  "persona.testing-policy": "delivery/personas/testing-policy.md",
});

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
  /** The reviewer-charter bytes read from the trusted pre-run base, per identity. */
  readonly personaBytes: Readonly<Record<string, string>>;
}

/** Compiles the fixed policy for one disposable repository. Digest self-binds. */
export function compileDisposablePolicy(input: CompileDisposablePolicyInput): PolicySnapshot {
  // A charter the trusted base did not supply is absent, not empty: it stays
  // out of the resolvable set so the compiler rejects the reference rather
  // than binding the digest of nothing.
  const personas = DISPOSABLE_REVIEW_LENSES.flatMap((lens) => {
    const bytes = input.personaBytes[lens.personaId];
    return bytes === undefined ? [] : [{ personaId: lens.personaId, digest: sha256Hex(bytes), origin: "adopter" as const }];
  });
  const digestOf = (personaId: string): string | undefined =>
    personas.find((persona) => persona.personaId === personaId)?.digest;
  const result = compileRepositoryPolicy({
    document: {
      spec: REPOSITORY_POLICY_DOCUMENT_SPEC,
      repositoryId: input.repositoryId,
      policyGeneration: 1,
      grantedFinishLines: ["merge-ready"],
      grantedAuthority: [],
      forbiddenAuthority: [],
      reviewLenses: DISPOSABLE_REVIEW_LENSES.map((lens) => {
        const personaDigest = digestOf(lens.personaId);
        return { ...lens, ...(personaDigest === undefined ? {} : { personaDigest }) };
      }),
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
    personas,
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

/** The read-only grant every product-owned intake turn runs under. */
export const DISPOSABLE_INTAKE_GRANT = PORTABLE_INTAKE_GRANT;
