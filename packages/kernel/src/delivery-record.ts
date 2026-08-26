/**
 * The tracked delivery record — `delivery-record/1` — and the pure verification
 * core the CLI `verify` command and the GitHub Action both call.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. The delivery record is a product-layer
 * projection that lives *outside* the delivery-evidence/1 spec. The git-private
 * evidence store (records.ts) is the gate's evidence; this is the one sanctioned
 * artifact that crosses out of the workspace into the tracked tree, so that a
 * reviewer — and a CI job in a different workspace — can see that a gate was
 * satisfied without re-running it. At L0 it proves process discipline and
 * freshness, not provenance.
 *
 * PRODUCE-ONLY (sensor rule d2). This module BUILDS the record object and its
 * canonical bytes; it never writes them. The CLI `record` command performs the
 * one write, through the artifacts fs port, so the only place in the kernel that
 * opens a file for the submission/record path stays the artifacts port.
 *
 * NO CLOCK (sensor rule e). Nothing here reads a clock or a `recordedAt`: the
 * record's identity is the candidate it attests, never the moment it was
 * written, and its freshness is judged against a recomputed deliverable
 * identity, never against elapsed time.
 *
 * WHY THE RECORD IS NEUTRAL TO ITS OWN PATH. `config.deliveryRecordPath` is
 * required by the config loader to satisfy *both* neutral predicates. Because it
 * is review-neutral, writing it does not change the deliverable identity the
 * record attests — the record cannot invalidate itself. Because it is
 * record-neutral, it is not part of any candidate binding — a candidate is never
 * bound to the presence of its own record. The self-neutrality proof in the test
 * suite is exactly this property, exercised end to end.
 */
import {
  BASE_MOVEMENT_POLICIES,
  V1_ATTESTATION_LEVEL,
  type AttestationLevel,
  type BaseMovementPolicy,
  type HarnessConfig,
} from "./config.ts";
import {
  createBlocker,
  type Blocker,
  type BlockerSource,
  type NonEmptyTuple,
  type Remediation,
} from "./blockers.ts";
import { canonicalize } from "./canonical.ts";
import type { CandidateBinding } from "./candidate.types.ts";
import type { EvidenceRecord, RecordCandidateBinding } from "./records.types.ts";
import type { GateDecision, ResolutionOutcome } from "./evaluator.ts";

// ── Constants ────────────────────────────────────────────────────────────────

/** The product-layer version token. Not a delivery-evidence/1 spec value. */
export const DELIVERY_RECORD_VERSION = "delivery-record/1";

/**
 * The honest attestation label. L0 is workspace-scoped process discipline and
 * freshness — never provenance. Surfaced verbatim by every verification summary.
 */
export const ATTESTATION_LABEL =
  "self / workspace-scoped — process discipline and freshness, not provenance";

/**
 * The drift classes a verification can name. `deliverable_identity_changed` is
 * the identity mismatch; the three base classes are the base-movement drift the
 * policy either stales on or names as relaxed.
 */
export const DELIVERY_RECORD_DRIFT_CLASSES = [
  "deliverable_identity_changed",
  "base_ref_changed",
  "base_tip_moved",
  "merge_base_moved",
] as const;

export type DeliveryRecordDriftClass = (typeof DELIVERY_RECORD_DRIFT_CLASSES)[number];

const DELIVERY_RECORD_SOURCE: BlockerSource = { kind: "delivery-record", id: "delivery-harness.delivery-record" };

const RERECORD: Remediation = {
  id: "re-run-the-loop",
  kind: "manual_action",
  summary: "Re-prepare, re-run the gate, and re-record for the current candidate.",
};

function drBlocker(code: string, summary: string, details?: string, remediation: Remediation = RERECORD): Blocker {
  return createBlocker({
    code,
    source: DELIVERY_RECORD_SOURCE,
    summary,
    ...(details === undefined ? {} : { details }),
    remediations: [remediation],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ── The record shape ─────────────────────────────────────────────────────────

/**
 * One obligation's outcome as promoted into the tracked record. Never `blocked`
 * — a blocked obligation means the gate did not admit and no record is written.
 */
export interface DeliveryRecordClaim {
  readonly obligationId: string;
  readonly outcome: ResolutionOutcome;
  readonly providerId?: string;
  readonly recordId?: string;
  readonly runId?: string;
  readonly finalPassId?: string;
  readonly manifestDigest?: string;
  readonly scope?: string;
  readonly ciPolicyId?: string;
}

export interface DeliveryRecordAttestation {
  readonly level: AttestationLevel;
}

/**
 * The tracked `delivery-record/1` artifact. `workspaceId` is recorded for audit
 * but is deliberately *excluded* from verification: CI verifies from a different
 * workspace by construction, so binding on it would fail every real PR.
 */
export interface DeliveryRecord {
  readonly version: typeof DELIVERY_RECORD_VERSION;
  readonly gateId: string;
  readonly identityToken: string;
  readonly candidateBinding: RecordCandidateBinding;
  readonly claims: readonly DeliveryRecordClaim[];
  readonly manifestDigest: string | null;
  readonly workspaceId: string;
  readonly attestation: DeliveryRecordAttestation;
}

// ── Build (produce-only) ─────────────────────────────────────────────────────

export interface BuildDeliveryRecordInput {
  readonly config: HarnessConfig;
  readonly decision: GateDecision;
  /** The evidence records backing the decision, used to stamp manifest digests. */
  readonly evidenceRecords: readonly EvidenceRecord[];
}

export type BuildDeliveryRecordResult =
  | { readonly ok: true; readonly record: DeliveryRecord }
  | { readonly ok: false; readonly blockers: NonEmptyTuple<Blocker> };

/** Maps the evaluator's candidate shape onto the record's flat binding. */
export function bindingOf(candidate: CandidateBinding): RecordCandidateBinding {
  return {
    treeSha: candidate.treeSha,
    deliverableDigest: candidate.deliverable.digest,
    identityToken: candidate.deliverable.identity,
    baseRef: candidate.base.ref,
    baseTipSha: candidate.base.tipSha,
    mergeBaseSha: candidate.base.mergeBaseSha,
    workspaceId: candidate.workspaceId,
  };
}

function claimOf(
  resolution: GateDecision["resolutions"][number],
  manifestDigestByRecordId: ReadonlyMap<string, string>,
): DeliveryRecordClaim {
  switch (resolution.kind) {
    case "satisfied_evidence": {
      const manifestDigest = manifestDigestByRecordId.get(resolution.recordId);
      return {
        obligationId: resolution.obligationId,
        outcome: resolution.kind,
        providerId: resolution.providerId,
        recordId: resolution.recordId,
        runId: resolution.runId,
        finalPassId: resolution.finalPassId,
        ...(manifestDigest === undefined ? {} : { manifestDigest }),
      };
    }
    case "satisfied_live_fact":
      return { obligationId: resolution.obligationId, outcome: resolution.kind, providerId: resolution.providerId, runId: resolution.runId };
    case "waived":
      return { obligationId: resolution.obligationId, outcome: resolution.kind, recordId: resolution.waiverRecordId, scope: resolution.scope };
    case "delegated":
      return { obligationId: resolution.obligationId, outcome: resolution.kind, ciPolicyId: resolution.ciPolicyId };
    case "not_applicable":
      return { obligationId: resolution.obligationId, outcome: resolution.kind };
    case "blocked":
      // Unreachable: the caller refuses a decision carrying a blocked obligation.
      return { obligationId: resolution.obligationId, outcome: resolution.kind };
  }
}

/**
 * Builds the tracked record from an *admitted* gate decision. Refuses (returns
 * blockers) when the decision did not admit or carries a blocked obligation —
 * a record is a statement that the gate passed, and there is nothing truthful
 * to write otherwise.
 */
export function buildDeliveryRecord(input: BuildDeliveryRecordInput): BuildDeliveryRecordResult {
  const { config, decision, evidenceRecords } = input;
  if (!decision.admitted) {
    return {
      ok: false,
      blockers: [drBlocker("record_gate_not_admitted", "The gate did not admit; there is nothing to record.")],
    };
  }
  const blocked = decision.resolutions.find((resolution) => resolution.kind === "blocked");
  if (blocked !== undefined) {
    return {
      ok: false,
      blockers: [
        drBlocker(
          "record_blocked_obligation",
          "The gate result carries a blocked obligation; a record would misrepresent it.",
          `obligation ${blocked.obligationId} is blocked`,
        ),
      ],
    };
  }

  const manifestDigestByRecordId = new Map<string, string>();
  for (const record of evidenceRecords) {
    if (record.resolution.kind === "evidence") {
      manifestDigestByRecordId.set(record.recordId, record.resolution.manifestDigest);
    }
  }

  const claims = decision.resolutions.map((resolution) => claimOf(resolution, manifestDigestByRecordId));
  const distinctManifestDigests = [...new Set(claims.flatMap((claim) => (claim.manifestDigest === undefined ? [] : [claim.manifestDigest])))];

  const record: DeliveryRecord = {
    version: DELIVERY_RECORD_VERSION,
    gateId: config.gateId,
    identityToken: config.computingIdentityVersion,
    candidateBinding: bindingOf(decision.candidate),
    claims,
    manifestDigest: distinctManifestDigests.length === 1 ? (distinctManifestDigests[0] as string) : null,
    workspaceId: decision.candidate.workspaceId,
    attestation: { level: V1_ATTESTATION_LEVEL },
  };
  return { ok: true, record };
}

/**
 * The canonical bytes of a record: RFC 8785 JCS plus a trailing newline. Two
 * `record` runs over one candidate produce byte-identical files, which is what
 * makes a re-record a no-op rather than a spurious diff.
 */
export function deliveryRecordBytes(record: DeliveryRecord): string {
  return `${canonicalize(record)}\n`;
}

/**
 * The candidate-keyed path for a record, derived from `config.deliveryRecordPath`
 * by splicing the deliverable digest before its extension. Keying on the digest
 * is what makes the name both merge-conflict-free across parallel branches (a
 * different deliverable is a different file) and exactly recomputable by the
 * Action from the PR head (the digest is a pure function of the tree under the
 * config's identity token). The splice preserves the configured path's prefix
 * and suffix, so the derived path satisfies exactly the neutral matchers the
 * loader already checked the configured path against.
 */
export function deliveryRecordPathFor(config: HarnessConfig, deliverableDigest: string): string {
  const configured = config.deliveryRecordPath;
  const lastSlash = configured.lastIndexOf("/");
  const lastDot = configured.lastIndexOf(".");
  const hasExtension = lastDot > lastSlash;
  const stem = hasExtension ? configured.slice(0, lastDot) : configured;
  const extension = hasExtension ? configured.slice(lastDot) : "";
  return `${stem}--${deliverableDigest}${extension}`;
}

// ── Parse + select ───────────────────────────────────────────────────────────

export type ParseDeliveryRecordResult =
  | { readonly ok: true; readonly record: DeliveryRecord }
  | { readonly ok: false; readonly blockers: NonEmptyTuple<Blocker> };

/**
 * Parses a tracked record's bytes into a well-formed `DeliveryRecord`, or a
 * typed finding. A malformed record is a finding, never a skip: a verifier that
 * silently ignored a record it could not read would pass a PR whose evidence it
 * never actually inspected.
 */
const BINDING_FIELDS: readonly (keyof RecordCandidateBinding)[] = [
  "treeSha",
  "deliverableDigest",
  "identityToken",
  "baseRef",
  "baseTipSha",
  "mergeBaseSha",
  "workspaceId",
];

function malformed(detail: string): { readonly ok: false; readonly blockers: NonEmptyTuple<Blocker> } {
  return { ok: false, blockers: [drBlocker("delivery_record_malformed", "The delivery record could not be read.", detail)] };
}

export function parseDeliveryRecord(text: string): ParseDeliveryRecordResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return malformed(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) return malformed("the record is not a JSON object");
  if (parsed["version"] !== DELIVERY_RECORD_VERSION) {
    return malformed(`unsupported version token ${JSON.stringify(parsed["version"])}; expected ${DELIVERY_RECORD_VERSION}`);
  }
  if (!isNonEmptyString(parsed["gateId"])) return malformed("missing gateId");
  if (!isNonEmptyString(parsed["identityToken"])) return malformed("missing identityToken");
  if (!isNonEmptyString(parsed["workspaceId"])) return malformed("missing workspaceId");

  const binding = parsed["candidateBinding"];
  if (!isRecord(binding)) return malformed("missing candidateBinding");
  for (const field of BINDING_FIELDS) {
    if (!isNonEmptyString(binding[field])) return malformed(`candidateBinding is missing ${field}`);
  }

  const claims = parsed["claims"];
  if (!Array.isArray(claims)) return malformed("claims must be an array");
  for (const claim of claims) {
    if (!isRecord(claim) || !isNonEmptyString(claim["obligationId"]) || !isNonEmptyString(claim["outcome"])) {
      return malformed("a claim is missing its obligation id or outcome");
    }
  }

  const attestation = parsed["attestation"];
  if (!isRecord(attestation) || !isNonEmptyString(attestation["level"])) return malformed("missing attestation.level");

  const manifestDigest = parsed["manifestDigest"];
  if (manifestDigest !== null && typeof manifestDigest !== "string") return malformed("manifestDigest must be a string or null");

  return { ok: true, record: parsed as unknown as DeliveryRecord };
}

export interface DeliveryRecordFile {
  readonly path: string;
  readonly record: DeliveryRecord;
}

export interface RecomputedIdentity {
  readonly deliverableDigest: string;
  readonly identityToken: string;
}

/**
 * Selects the record bound to a recomputed identity from a set of discovered
 * records. A record bound to any other candidate — a foreign record — can never
 * win; two records with only one matching head resolves to that one.
 */
export function selectDeliveryRecordForIdentity(
  records: readonly DeliveryRecordFile[],
  identity: RecomputedIdentity,
): DeliveryRecordFile | undefined {
  const matches = records
    .filter(
      (entry) =>
        entry.record.candidateBinding.deliverableDigest === identity.deliverableDigest &&
        entry.record.candidateBinding.identityToken === identity.identityToken,
    )
    // Deterministic when more than one file keys to the same identity.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return matches[0];
}

// ── Verify (pure core) ───────────────────────────────────────────────────────

/** The base state the record's base coordinates are compared against. */
export interface VerificationBase {
  readonly ref: string;
  readonly tipSha: string;
  readonly mergeBaseSha: string;
}

export interface DeliveryRecordCheck {
  readonly ok: boolean;
  readonly blockers: readonly Blocker[];
  readonly baseMovement: BaseMovementPolicy;
  /** True when base drift occurred but the `allow` policy let it pass. */
  readonly baseMovementRelaxed: boolean;
  /** Base drift classes the `allow` policy relaxed — named in the summary. */
  readonly relaxedDriftClasses: readonly DeliveryRecordDriftClass[];
  readonly attestationLabel: string;
  readonly claims: readonly DeliveryRecordClaim[];
}

/**
 * The pure verification core shared by the CLI `verify` command and the Action.
 *
 * Reads `config.deliveryRecordVerification.baseMovement` — the ONLY reader of
 * that policy in the whole kernel, so the local gate is never more permissive
 * than CI. `recomputedIdentity` is the deliverable identity the caller recomputed
 * from the PR head (never the synthetic merge commit); `base` is the current base
 * state. `workspaceId` is never consulted.
 */
export function verifyDeliveryRecord(
  config: HarnessConfig,
  record: DeliveryRecord,
  recomputedIdentity: RecomputedIdentity,
  base: VerificationBase,
): DeliveryRecordCheck {
  const policy = config.deliveryRecordVerification.baseMovement;
  const blockers: Blocker[] = [];
  const relaxedDriftClasses: DeliveryRecordDriftClass[] = [];
  const binding = record.candidateBinding;

  if (record.version !== DELIVERY_RECORD_VERSION) {
    blockers.push(drBlocker("record_version_unsupported", `The record's version ${JSON.stringify(record.version)} is not ${DELIVERY_RECORD_VERSION}.`));
  }
  if (record.gateId !== config.gateId) {
    blockers.push(
      drBlocker("record_gate_mismatch", `The record is for gate ${JSON.stringify(record.gateId)}, not ${JSON.stringify(config.gateId)}.`),
    );
  }
  if (record.attestation.level !== V1_ATTESTATION_LEVEL) {
    blockers.push(
      drBlocker(
        "record_attestation_unsupported",
        `The record declares attestation level ${JSON.stringify(record.attestation.level)}; v1 verifies only ${JSON.stringify(V1_ATTESTATION_LEVEL)}.`,
      ),
    );
  }
  if (!config.identityVersions.includes(binding.identityToken)) {
    blockers.push(
      drBlocker("record_identity_token_unknown", `The record's identity token ${JSON.stringify(binding.identityToken)} is not accepted by this config.`),
    );
  }

  // Deliverable identity: the record must describe the tree at the PR head. This
  // is the mismatch a foreign record fails on, and it is never relaxed.
  if (binding.deliverableDigest !== recomputedIdentity.deliverableDigest || binding.identityToken !== recomputedIdentity.identityToken) {
    blockers.push(
      drBlocker(
        "deliverable_identity_changed",
        "The record's deliverable identity does not match the recomputed identity of the head.",
        `record ${binding.deliverableDigest} (${binding.identityToken}) but head ${recomputedIdentity.deliverableDigest} (${recomputedIdentity.identityToken})`,
      ),
    );
  }

  // Base movement: staled by default, relaxed and named under the `allow` policy.
  const baseDrift: DeliveryRecordDriftClass[] = [];
  if (binding.baseRef !== base.ref) baseDrift.push("base_ref_changed");
  if (binding.baseTipSha !== base.tipSha) baseDrift.push("base_tip_moved");
  if (binding.mergeBaseSha !== base.mergeBaseSha) baseDrift.push("merge_base_moved");
  for (const driftClass of baseDrift) {
    if (policy === "allow") {
      relaxedDriftClasses.push(driftClass);
    } else {
      blockers.push(drBlocker(driftClass, `The base moved (${driftClass}); the record is stale under the "stale" base-movement policy.`));
    }
  }

  // A claim can only carry an admitting outcome; a blocked one is a malformed
  // record, not a pass.
  for (const claim of record.claims) {
    if (claim.outcome === "blocked") {
      blockers.push(drBlocker("record_claim_blocked", `Claim for ${claim.obligationId} carries a blocked outcome; a record must not.`));
    }
  }

  // Coverage: every declared obligation must be accounted for by a claim.
  const claimed = new Set(record.claims.map((claim) => claim.obligationId));
  for (const obligation of config.obligations) {
    if (!claimed.has(obligation.id)) {
      blockers.push(
        drBlocker("obligation_uncovered", `Obligation ${JSON.stringify(obligation.id)} has no claim in the record.`),
      );
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    baseMovement: policy,
    baseMovementRelaxed: relaxedDriftClasses.length > 0,
    relaxedDriftClasses,
    attestationLabel: ATTESTATION_LABEL,
    claims: record.claims,
  };
}
