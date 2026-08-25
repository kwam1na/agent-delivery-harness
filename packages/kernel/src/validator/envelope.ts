/**
 * The normative `delivery-evidence/1` envelope validator (spec §8).
 *
 * WHAT THIS IS. A total function from a submitted value, a repository
 * configuration, and the candidate observation the caller made, to one verdict
 * carrying every violated rule. It is the normative implementation: the
 * published JSON Schemas beside this file describe shape, and shape is
 * necessary but not sufficient — closed grammar, cross-field re-derivation, and
 * the code registry are what conformance is defined by.
 *
 * WHAT IT REFUSES TO GUESS. Four rejection codes are conclusions about state
 * only the recorder observes — bytes under an allocated run root (ENV-10's
 * realpath clause, ENV-11) and the published record store (SUB-3, SUB-4). This
 * validator does no I/O, so it does not reach them; they are registered in
 * `codes.ts` with `emitter: "recorder"` and belong to the submission flow that
 * owns the filesystem. What it does judge from caller-supplied observation is
 * SUB-1 and SUB-2, because a candidate capture and a preparation state are
 * values, not file handles.
 *
 * REPORTING. Every rule runs. Nothing short-circuits on a first failure, which
 * is what SUB-5 requires and what makes the conformance kit's multi-code
 * vectors meaningful. Guards exist only where a later rule would otherwise read
 * a value whose shape it already knows is wrong.
 *
 * TIME. No rule reads `recordedAt`. It is informational (§5.8), GEN-5 forbids
 * any admissibility decision from depending on it, and the import-boundary
 * sensor enforces that mechanically over this directory. The member is still
 * part of the closed grammar — its absence is a rejection and its presence
 * changes the manifest digest — which is exactly the distinction GEN-5 draws.
 */
import type { HarnessConfig, ObligationPolicy } from "../config.ts";
import {
  CONFORMING_ATTESTATION_LEVEL,
  DELIVERY_EVIDENCE_1,
  REVIEW_GREEN_1,
  SUPPORTED_ENVELOPE_SPECS,
  SUPPORTED_PAYLOAD_SPECS,
  type ManifestValidation,
} from "./codes.ts";

// ── The validated shapes ───────────────────────────────────────────────────

export interface ManifestDeliverable {
  readonly digest: string;
  readonly identity: string;
}

export interface ManifestBase {
  readonly ref: string;
  readonly tipSha: string;
  readonly mergeBaseSha: string;
}

export interface ManifestCandidate {
  readonly vcs: "git";
  readonly treeSha: string;
  readonly headSha?: string;
  readonly deliverable: ManifestDeliverable;
  readonly base: ManifestBase;
  readonly workspaceId: string;
}

export interface ManifestProvider {
  readonly id: string;
  readonly version?: string;
  readonly runId: string;
  readonly finalPassId: string;
}

export interface RunHistoryEntry {
  readonly preparedTreeSha: string;
  readonly evaluatedInPassId: string;
}

export interface ManifestArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly role: string;
}

/**
 * An artifact entry that survived the shape rules, carrying the index it was
 * declared at so a payload rule can point back at the entry rather than at the
 * pool.
 */
export interface DeclaredArtifact extends ManifestArtifact {
  readonly index: number;
}

export interface ManifestAttestation {
  readonly level: string;
  readonly signatures: readonly unknown[];
}

export interface ManifestClaim {
  readonly obligation: string;
  readonly payloadSpec: string;
  readonly payload: Record<string, unknown>;
}

/** A manifest that passed §8 and §9.3 in full. */
export interface DeliveryEvidenceManifest {
  readonly spec: string;
  readonly provider: ManifestProvider;
  readonly candidate: ManifestCandidate;
  readonly repository?: string | null;
  readonly runHistory: readonly RunHistoryEntry[];
  readonly artifacts: readonly ManifestArtifact[];
  readonly attestation: ManifestAttestation;
  readonly recordedAt: string;
  readonly claims: readonly ManifestClaim[];
}

// ── The caller's observations ──────────────────────────────────────────────

export interface ManifestValidationContext {
  /** Repository gate configuration: accepted specs, identity versions, obligations, providers. */
  readonly config: HarnessConfig;
  /**
   * What candidate capture reports at submission time (SUB-1). A value, not a
   * repository: whoever captured it owns the git work, and this module compares.
   */
  readonly currentCandidate: unknown;
  /** Whether the workspace is in a prepared state at submission time (SUB-2). */
  readonly prepared: boolean;
  /**
   * Artifact file contents, keyed by the path the manifest declares. RG-4 reads
   * approval stamps from here. An entry absent from this map is an artifact the
   * caller could not produce bytes for, which no rule may treat as satisfied.
   */
  readonly artifactContents: ReadonlyMap<string, string>;
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * NOT YET IMPLEMENTED. The kit is wired first and runs red on purpose: 84
 * decidable vectors failing is the measurement the implementation is written
 * against. The rules land next.
 */
export function validateManifest(
  submitted: unknown,
  context: ManifestValidationContext,
): ManifestValidation<DeliveryEvidenceManifest> {
  void submitted;
  void context;
  void CONFORMING_ATTESTATION_LEVEL;
  void DELIVERY_EVIDENCE_1;
  void REVIEW_GREEN_1;
  void SUPPORTED_ENVELOPE_SPECS;
  void SUPPORTED_PAYLOAD_SPECS;
  throw new Error("delivery-evidence/1 validation is not implemented yet");
}
