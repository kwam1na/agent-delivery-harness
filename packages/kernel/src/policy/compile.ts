/**
 * The policy compiler: portable defaults + the declarative repository policy
 * document + the repository's executable adapter descriptors, normalized into
 * ONE immutable digest-bound compiled snapshot before a run is accepted.
 *
 * Everything a checkpoint later consults is inside the compiled value: the
 * frozen spine snapshot (finish lines, authority, lenses, obligations, both
 * revocation epochs), one execution-grant envelope per model-driven stage,
 * the bound capability set, approval boundaries, the tracker posture, and —
 * when the repository declares one — the harness admission configuration,
 * validated by the characterized `HarnessConfig` loader. `HarnessConfig` is
 * thereby the admission PROJECTION of this policy, not the policy model.
 *
 * Every defect is a typed rejection BEFORE mutation. The digest recorded at
 * bind time governs the delivery: candidate edits to the document, adapters,
 * sensors, or compiled bytes produce a digest mismatch (`checkBoundPolicy`)
 * and are thereby proposals for a future owner-approved policy generation,
 * never inputs to the current judgement.
 */
import { validateHarnessConfig, type HarnessConfig, type HarnessConfigInput } from "../config.ts";
import { digestCanonical } from "../digest.ts";
import { EXECUTION_GRANT_SPEC } from "../spine/grant.ts";
import { POLICY_SNAPSHOT_SPEC, validatePolicySnapshot, type PolicySnapshot } from "../spine/policy.ts";
import {
  PRIVILEGED_ACTIONS,
  PRIVILEGED_CAPABILITY_KINDS,
  createPolicyCollector,
  validateAdapterSet,
  type AdapterCapability,
  type PolicyVerdict,
} from "./capabilities.ts";
import {
  PORTABLE_MODEL_DRIVEN_STAGES,
  validateRepositoryPolicyDocument,
  type CheckpointOverride,
  type RepositoryPolicyDocument,
} from "./document.ts";

export { PORTABLE_MODEL_DRIVEN_STAGES } from "./document.ts";

export const COMPILED_POLICY_SPEC = "compiled-repository-policy/1";

/** Every semantic rejection the compiler can produce, each by exactly one rule. */
export const POLICY_COMPILE_CODES = Object.freeze([
  "contradictory_authority",
  "contradictory_finish_line",
  "duplicate_obligation",
  "duplicate_review_lens",
  "duplicate_checkpoint",
  "mandatory_lens_missing",
  "capability_unavailable",
  "capability_version_mismatch",
  "capability_contract_mismatch",
  "prose_only_authority",
  "privileged_credential_in_model_grant",
  "tracker_unavailable",
  "admission_obligation_unactivated",
  "policy_tamper",
] as const);

/** The credentials no model-driven execution grant may carry. */
export const PORTABLE_PRIVILEGED_CREDENTIALS = Object.freeze([
  "credential.merge",
  "credential.deploy",
  "credential.pr-creation",
  "credential.approval-request",
] as const);

/** The review floor: one activated lens per category, in every compiled policy. */
export const MANDATORY_LENS_CATEGORIES = Object.freeze(["outcome-correctness", "testing-policy"] as const);

/**
 * The portable per-stage envelope. A checkpoint override REPLACES the tool
 * and writable-path lists — those are the owner-approved document's to shape
 * — while protections and forbidden operations are union-only (`additional*`
 * members), so weakening either of those is unspellable, not just rejected.
 */
export const PORTABLE_STAGE_GRANT = Object.freeze({
  spec: EXECUTION_GRANT_SPEC,
  profile: "checkpoint",
  allowedCapabilities: Object.freeze(["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "TodoWrite"]),
  writablePaths: Object.freeze(["src", "tests", "tools", "telemetry", "docs"]),
  protectedPaths: Object.freeze([".git", ".managed-projection", ".claude"]),
  forbiddenOperations: Object.freeze(["git.push", "merge", "deploy"]),
} as const);

export interface CompiledCheckpointGrant {
  readonly stageId: string;
  readonly grant: {
    readonly spec: typeof EXECUTION_GRANT_SPEC;
    readonly profile: "checkpoint";
    readonly allowedCapabilities: readonly string[];
    readonly writablePaths: readonly string[];
    readonly protectedPaths: readonly string[];
    readonly forbiddenOperations: readonly string[];
  };
  /** Credential availability for the stage; never a privileged credential. */
  readonly credentials: readonly string[];
}

export interface CompiledPolicy {
  readonly spec: typeof COMPILED_POLICY_SPEC;
  readonly compiledDigest: string;
  readonly policyGeneration: number;
  readonly snapshot: PolicySnapshot;
  readonly capabilities: readonly AdapterCapability[];
  readonly checkpointGrants: readonly CompiledCheckpointGrant[];
  readonly approvals: readonly { readonly action: string; readonly approval: string }[];
  readonly tracker: "available" | "absent";
  readonly trackerAbsenceFallback: string;
  readonly admission?: HarnessConfig;
}

export interface CompileRepositoryPolicyInput {
  readonly document: unknown;
  readonly adapters: readonly unknown[];
  readonly productTrustRevocationEpoch: number;
  readonly repositoryAuthorityRevocationEpoch: number;
}

export type CompileRepositoryPolicyResult =
  | { readonly ok: true; readonly compiled: CompiledPolicy }
  | { readonly ok: false; readonly rejections: readonly { readonly code: string; readonly pointer: string; readonly message: string }[] };

const union = (base: readonly string[], extra: readonly string[]): readonly string[] => [
  ...base,
  ...extra.filter((entry) => !base.includes(entry)),
];

export function compileRepositoryPolicy(input: CompileRepositoryPolicyInput): CompileRepositoryPolicyResult {
  const collector = createPolicyCollector();

  const documentVerdict = validateRepositoryPolicyDocument(input.document);
  if (!documentVerdict.ok) {
    for (const rejection of documentVerdict.rejections) {
      collector.emit(rejection.code, `/document${rejection.pointer}`, rejection.message);
    }
  }
  const adapterVerdict = validateAdapterSet(input.adapters);
  if (!adapterVerdict.ok) {
    for (const rejection of adapterVerdict.rejections) {
      collector.emit(rejection.code, `/adapters${rejection.pointer}`, rejection.message);
    }
  }
  const shape = collector.verdict();
  if (!shape.ok) return { ok: false, rejections: shape.rejections };

  const document = input.document as RepositoryPolicyDocument;
  const adapters = input.adapters as readonly AdapterCapability[];
  const byId = new Map(adapters.map((adapter) => [adapter.capabilityId, adapter]));

  // ── Authority coherence ──────────────────────────────────────────────────
  document.grantedAuthority.forEach((authority, index) => {
    if (document.forbiddenAuthority.includes(authority)) {
      collector.emit(
        "contradictory_authority",
        `/document/grantedAuthority/${index}`,
        `${authority} is granted and forbidden by the same document; a contradiction rejects rather than resolving silently`,
      );
    }
    if (!adapters.some((adapter) => adapter.kind === authority)) {
      collector.emit(
        "prose_only_authority",
        `/document/grantedAuthority/${index}`,
        `${authority} authority is declared with no executable ${authority} adapter; repository prose never satisfies a capability`,
      );
    }
  });
  document.grantedFinishLines.forEach((finishLine, index) => {
    if ((PRIVILEGED_ACTIONS as readonly string[]).includes(finishLine) && !document.grantedAuthority.includes(finishLine)) {
      collector.emit(
        "contradictory_finish_line",
        `/document/grantedFinishLines/${index}`,
        `finish line ${finishLine} requires ${finishLine} authority, which this document does not grant`,
      );
    }
  });

  // ── Duplicates and the review floor ──────────────────────────────────────
  const obligationIds = new Set<string>();
  document.obligations.forEach((obligation, index) => {
    if (obligationIds.has(obligation.obligationId)) {
      collector.emit("duplicate_obligation", `/document/obligations/${index}`, `obligation ${obligation.obligationId} is activated more than once`);
    }
    obligationIds.add(obligation.obligationId);
  });
  const lensIds = new Set<string>();
  document.reviewLenses.forEach((lens, index) => {
    if (lensIds.has(lens.lensId)) {
      collector.emit("duplicate_review_lens", `/document/reviewLenses/${index}`, `review lens ${lens.lensId} is activated more than once`);
    }
    lensIds.add(lens.lensId);
  });
  const categories = new Set(document.reviewLenses.map((lens) => lens.category));
  for (const category of MANDATORY_LENS_CATEGORIES) {
    if (!categories.has(category)) {
      collector.emit(
        "mandatory_lens_missing",
        "/document/reviewLenses",
        `no lens activates the mandatory ${category} category; the review floor is not lowered by omission`,
      );
    }
  }

  // ── Required capabilities against the adapter layer ──────────────────────
  document.requiredCapabilities.forEach((required, index) => {
    const at = `/document/requiredCapabilities/${index}`;
    const bound = byId.get(required.capabilityId);
    if (bound === undefined) {
      collector.emit(
        "capability_unavailable",
        at,
        `required capability ${required.capabilityId} has no executable adapter; the delivery is rejected before mutation`,
      );
      return;
    }
    if (bound.kind !== required.kind) {
      collector.emit(
        "capability_contract_mismatch",
        at,
        `required capability ${required.capabilityId} is declared ${required.kind}; the adapter binds it as ${bound.kind}`,
      );
    }
    if (bound.version !== required.version) {
      collector.emit(
        "capability_version_mismatch",
        at,
        `required capability ${required.capabilityId} requires version ${required.version}; the adapter provides ${bound.version}`,
      );
    }
  });

  // ── Tracker posture ──────────────────────────────────────────────────────
  const trackerBound = adapters.some((adapter) => adapter.kind === "tracker");
  if (!trackerBound && document.trackerAbsenceFallback === "block") {
    collector.emit(
      "tracker_unavailable",
      "/document/trackerAbsenceFallback",
      "the document blocks on tracker absence and no tracker capability is bound",
    );
  }

  // ── Checkpoint grant envelopes ───────────────────────────────────────────
  // The privileged credential set is not a naming convention: it is the
  // portable names PLUS every credential a privileged-kind adapter actually
  // declares, so renaming a merge token cannot smuggle it into a model-driven
  // grant.
  const privilegedCredentialIds = new Set<string>(PORTABLE_PRIVILEGED_CREDENTIALS);
  for (const adapter of adapters) {
    if ((PRIVILEGED_CAPABILITY_KINDS as readonly string[]).includes(adapter.kind) && adapter.credentialId !== undefined) {
      privilegedCredentialIds.add(adapter.credentialId);
    }
  }
  const seenStages = new Set<string>();
  (document.checkpoints ?? []).forEach((override, index) => {
    if (seenStages.has(override.stageId)) {
      collector.emit(
        "duplicate_checkpoint",
        `/document/checkpoints/${index}/stageId`,
        `stage ${override.stageId} carries more than one envelope; a duplicate rejects rather than resolving last-write-wins`,
      );
    }
    seenStages.add(override.stageId);
    override.credentials.forEach((credential, credentialIndex) => {
      if (privilegedCredentialIds.has(credential)) {
        collector.emit(
          "privileged_credential_in_model_grant",
          `/document/checkpoints/${index}/credentials/${credentialIndex}`,
          `${credential} is a privileged-action credential; it is excluded from every model-driven execution grant`,
        );
      }
    });
  });
  const overrides = new Map<string, CheckpointOverride>((document.checkpoints ?? []).map((entry) => [entry.stageId, entry]));
  const checkpointGrants: CompiledCheckpointGrant[] = PORTABLE_MODEL_DRIVEN_STAGES.map((stageId) => {
    const override = overrides.get(stageId);
    return {
      stageId,
      grant: {
        spec: EXECUTION_GRANT_SPEC,
        profile: "checkpoint",
        allowedCapabilities: override?.allowedCapabilities ?? PORTABLE_STAGE_GRANT.allowedCapabilities,
        writablePaths: override?.writablePaths ?? PORTABLE_STAGE_GRANT.writablePaths,
        protectedPaths: union(PORTABLE_STAGE_GRANT.protectedPaths, override?.additionalProtectedPaths ?? []),
        forbiddenOperations: union(PORTABLE_STAGE_GRANT.forbiddenOperations, override?.additionalForbiddenOperations ?? []),
      },
      credentials: override?.credentials ?? [],
    };
  });

  // ── The admission projection ─────────────────────────────────────────────
  let admission: HarnessConfig | undefined;
  if (document.admission !== undefined) {
    const verdict = validateHarnessConfig(document.admission as HarnessConfigInput);
    if (!verdict.ok) {
      for (const blocker of verdict.blockers) {
        collector.emit(blocker.code, "/document/admission", blocker.summary);
      }
    } else {
      admission = verdict.config;
      verdict.config.obligations.forEach((obligation, index) => {
        if (!obligationIds.has(obligation.id)) {
          collector.emit(
            "admission_obligation_unactivated",
            `/document/admission/obligations/${index}`,
            `the admission gate enforces ${obligation.id}, which the declarative policy never activates`,
          );
        }
      });
    }
  }

  const semantic = collector.verdict();
  if (!semantic.ok) return { ok: false, rejections: semantic.rejections };

  // ── The frozen spine snapshot, digest self-bound ─────────────────────────
  const snapshotBody = {
    spec: POLICY_SNAPSHOT_SPEC,
    repositoryId: document.repositoryId,
    productTrustRevocationEpoch: input.productTrustRevocationEpoch,
    repositoryAuthorityRevocationEpoch: input.repositoryAuthorityRevocationEpoch,
    grantedFinishLines: [...document.grantedFinishLines],
    grantedAuthority: [...document.grantedAuthority],
    reviewLenses: document.reviewLenses.map((lens) => ({ ...lens })),
    obligations: document.obligations.map((obligation) => ({ ...obligation })),
  };
  const snapshot = { ...snapshotBody, policyDigest: digestCanonical(snapshotBody) } as PolicySnapshot;
  const spineVerdict = validatePolicySnapshot(snapshot);
  if (!spineVerdict.ok) return { ok: false, rejections: spineVerdict.rejections };

  const compiledBody: Omit<CompiledPolicy, "compiledDigest"> = {
    spec: COMPILED_POLICY_SPEC,
    policyGeneration: document.policyGeneration,
    snapshot,
    capabilities: adapters.map((adapter) => ({ ...adapter })),
    checkpointGrants,
    approvals: document.approvals.map((approval) => ({ ...approval })),
    tracker: trackerBound ? ("available" as const) : ("absent" as const),
    trackerAbsenceFallback: document.trackerAbsenceFallback,
    ...(admission === undefined ? {} : { admission }),
  };
  const compiled: CompiledPolicy = { ...compiledBody, compiledDigest: digestCanonical(compiledBody) };
  return { ok: true, compiled };
}

/**
 * Structural self-check of a compiled policy: the outer digest must recompute
 * from the compiled body and the inner spine snapshot must still validate.
 * This catches corruption; TAMPER is caught by `checkBoundPolicy`, because a
 * digest anyone can recompute is an identity, not a signature.
 */
export function verifyCompiledPolicy(value: unknown): PolicyVerdict {
  const collector = createPolicyCollector();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    collector.emit("not_an_object", "", "expected a compiled policy object");
    return collector.verdict();
  }
  const record = value as Record<string, unknown>;
  const { compiledDigest, ...body } = record;
  let recomputed: string | undefined;
  try {
    recomputed = digestCanonical(body);
  } catch {
    recomputed = undefined; // a body that does not canonicalize cannot match
  }
  if (typeof compiledDigest !== "string" || recomputed === undefined || recomputed !== compiledDigest) {
    collector.emit("digest_mismatch", "/compiledDigest", "the compiled digest does not recompute from the compiled body");
  }
  const snapshot = record["snapshot"];
  const snapshotVerdict = validatePolicySnapshot(snapshot);
  if (!snapshotVerdict.ok) {
    for (const rejection of snapshotVerdict.rejections) collector.emit(rejection.code, `/snapshot${rejection.pointer}`, rejection.message);
  }
  return collector.verdict();
}

/**
 * The trusted pre-run copy governs: only the exact bytes whose digest was
 * bound at policy-bind time judge this delivery. Any other compiled policy —
 * however internally consistent — is a proposal for a future delivery.
 */
export function checkBoundPolicy(boundCompiledDigest: string, presented: unknown): PolicyVerdict {
  const collector = createPolicyCollector();
  const structural = verifyCompiledPolicy(presented);
  if (!structural.ok) return structural;
  const presentedDigest = (presented as Record<string, unknown>)["compiledDigest"];
  if (presentedDigest !== boundCompiledDigest) {
    collector.emit(
      "policy_tamper",
      "/compiledDigest",
      "the presented policy is not the trusted pre-run copy this delivery bound; a candidate edit is a proposal for a future delivery",
    );
  }
  return collector.verdict();
}
