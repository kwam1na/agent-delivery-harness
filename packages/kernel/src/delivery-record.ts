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
  throw new Error("not implemented: bindingOf");
}

/**
 * Builds the tracked record from an *admitted* gate decision. Refuses (returns
 * blockers) when the decision did not admit or carries a blocked obligation —
 * a record is a statement that the gate passed, and there is nothing truthful
 * to write otherwise.
 */
export function buildDeliveryRecord(input: BuildDeliveryRecordInput): BuildDeliveryRecordResult {
  throw new Error("not implemented: buildDeliveryRecord");
}

/**
 * The canonical bytes of a record: RFC 8785 JCS plus a trailing newline. Two
 * `record` runs over one candidate produce byte-identical files, which is what
 * makes a re-record a no-op rather than a spurious diff.
 */
export function deliveryRecordBytes(record: DeliveryRecord): string {
  throw new Error("not implemented: deliveryRecordBytes");
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
  throw new Error("not implemented: deliveryRecordPathFor");
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
export function parseDeliveryRecord(text: string): ParseDeliveryRecordResult {
  throw new Error("not implemented: parseDeliveryRecord");
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
  throw new Error("not implemented: selectDeliveryRecordForIdentity");
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
  throw new Error("not implemented: verifyDeliveryRecord");
}
