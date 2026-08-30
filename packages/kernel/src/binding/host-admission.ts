/**
 * The trusted host-control binding's admission decisions, model-external by
 * construction: pure functions a binding evaluates outside the model-visible
 * tool and shell surface. Nothing here performs I/O, consults a clock, or
 * launches a process — the import-boundary sensor enforces the first two and
 * the process-instrumentation test in the sibling suite proves the third.
 *
 * The enforced property is that no tool ever executes outside the currently
 * attested grant. The mechanism is deliberately re-evaluation, not caching:
 * the per-invocation interceptor decision re-runs the whole admission check
 * against the binding's CURRENT expectation, so a fence supersession, a trust
 * revocation, or a projection re-digest changes the expectation and every
 * attestation minted before the change stops matching — stale or sibling
 * attestations open no tools, and revocation re-denies on the next invocation
 * without any callback plumbing.
 *
 * The grant and attestation shapes are the frozen contract spine's; this
 * module consumes them and never re-authors them. Expiry is compared
 * lexicographically over the spine's fixed-width UTC instant grammar against
 * a caller-supplied observation instant — no decision here reads a clock.
 *
 * Operator confirmations are excluded from every grant by construction: a
 * confirmation-class operation is denied inside any grant, even a grant whose
 * bytes claim to allow it, because the confirmation channel is served only by
 * a binding-owned facade outside the model-visible surface. The echo-challenge
 * evaluation models that channel: completing a confirmation requires echoing a
 * single-use challenge on the same open, interactive, binding-owned channel it
 * was rendered on — which is exactly what a detached descendant of an ended
 * invocation, a piped stdin, or a model-driven tool call cannot do.
 */
import {
  GRANT_PROFILES,
  grantDigest,
  validateExecutionGrant,
  validateGrantAttestation,
  type GrantProfile,
} from "../spine/grant.ts";
import { SPINE_INSTANT, isAbsentByState } from "../spine/grammar.ts";

// ── Denial vocabulary ───────────────────────────────────────────────────────

export const ADMISSION_DENIAL_CODES = Object.freeze([
  "missing_grant",
  "missing_attestation",
  "malformed_grant",
  "malformed_attestation",
  "malformed_expectation",
  "empty_grant",
  "profile_mismatch",
  "host_version_mismatch",
  "grant_digest_mismatch",
  "trust_epoch_mismatch",
  "attestation_expired",
  "fence_mismatch",
  "delivery_mismatch",
  "workspace_mismatch",
  "projection_digest_mismatch",
  "discovery_configuration_mismatch",
  "installation_mismatch",
  "active_profile_mismatch",
  "intake_draft_mismatch",
] as const);
export type AdmissionDenialCode = (typeof ADMISSION_DENIAL_CODES)[number];

export const TOOL_DENIAL_CODES = Object.freeze([
  "not_admitted",
  "confirmation_operation_excluded",
  "capability_not_granted",
  "operation_forbidden",
  "unnormalized_path",
  "protected_path",
  "write_outside_grant",
] as const);
export type ToolDenialCode = (typeof TOOL_DENIAL_CODES)[number];

export const CONFIRMATION_DENIAL_CODES = Object.freeze([
  "channel_closed",
  "wrong_channel",
  "non_interactive_refused",
  "model_visible_surface_refused",
  "challenge_mismatch",
  "challenge_consumed",
  "challenge_expired",
] as const);
export type ConfirmationDenialCode = (typeof CONFIRMATION_DENIAL_CODES)[number];

export interface AdmissionDenial {
  readonly code: AdmissionDenialCode;
  readonly message: string;
}

// ── Expectation: what the binding currently believes ────────────────────────

/**
 * The binding-owned current state an attestation must match. The caller mints
 * this from its own durable state, never from host- or candidate-writable
 * bytes; `observedAt` is the caller's observation instant in the spine's
 * fixed-width UTC grammar.
 */
export interface CheckpointAdmissionExpectation {
  readonly profile: "checkpoint";
  readonly hostVersion: string;
  readonly productTrustRevocationEpoch: number;
  readonly observedAt: string;
  readonly deliveryId: string;
  readonly invocationFence: number;
  readonly workspaceId: string;
  readonly projectionDigest: string;
  readonly discoveryConfigurationDigest: string;
  readonly registeringInstallationId: string;
  readonly activeProfile: string;
}

export interface IntakeAdmissionExpectation {
  readonly profile: "intake";
  readonly hostVersion: string;
  readonly productTrustRevocationEpoch: number;
  readonly observedAt: string;
  readonly intakeDraftId: string;
}

export type AdmissionExpectation = CheckpointAdmissionExpectation | IntakeAdmissionExpectation;

// ── Admission decision ──────────────────────────────────────────────────────

export interface AdmittedInvocation {
  readonly admitted: true;
  readonly profile: GrantProfile;
  readonly grantDigest: string;
  readonly allowedCapabilities: readonly string[];
  readonly writablePaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly forbiddenOperations: readonly string[];
  /** Only a checkpoint-profile grant with at least one capability mutates. */
  readonly mutationCapable: boolean;
}

export interface DeniedInvocation {
  readonly admitted: false;
  readonly denials: readonly AdmissionDenial[];
}

export type AdmissionDecision = AdmittedInvocation | DeniedInvocation;

const deny = (code: AdmissionDenialCode, message: string): AdmissionDenial => ({ code, message });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Attested member equals the expected value — absent-by-state never matches a real expectation. */
const bound = (attested: unknown, expected: string | number): boolean =>
  !isAbsentByState(attested) && attested === expected;

/**
 * The deny-until-attested admission check. Missing, empty, malformed, or
 * mismatched inputs all fail closed; only an attestation bound to the exact
 * current expectation — fence, delivery, workspace, grant digest, projection
 * digest, discovery-configuration digest, installation, profile, epoch — and
 * to the exact bytes of the presented grant admits anything.
 */
export function evaluateHostAdmission(
  expectation: AdmissionExpectation,
  grant: unknown,
  attestation: unknown,
): AdmissionDecision {
  const denials: AdmissionDenial[] = [];

  if (!isRecord(expectation) || !GRANT_PROFILES.includes(expectation.profile) || !SPINE_INSTANT.test(expectation.observedAt ?? "")) {
    return { admitted: false, denials: [deny("malformed_expectation", "the binding's own expectation is not well-formed; nothing can be admitted against it")] };
  }
  if (grant === undefined || grant === null) {
    return { admitted: false, denials: [deny("missing_grant", "no execution grant was presented")] };
  }
  if (attestation === undefined || attestation === null) {
    return { admitted: false, denials: [deny("missing_attestation", "no grant attestation was presented; tools stay closed until one is")] };
  }

  const grantVerdict = validateExecutionGrant(grant);
  if (!grantVerdict.ok) {
    return {
      admitted: false,
      denials: grantVerdict.rejections.map((r) => deny("malformed_grant", `${r.pointer || "/"}: ${r.message}`)),
    };
  }
  const attVerdict = validateGrantAttestation(attestation);
  if (!attVerdict.ok) {
    return {
      admitted: false,
      denials: attVerdict.rejections.map((r) => deny("malformed_attestation", `${r.pointer || "/"}: ${r.message}`)),
    };
  }

  const g = grant as Record<string, unknown>;
  const a = attestation as Record<string, unknown>;

  // The attestation binds bytes, not intent: recompute the digest of the
  // presented grant and require the attestation to name exactly it. A
  // canonicalization failure is a fail-closed malformed grant, never a pass.
  let presentedDigest: string;
  try {
    presentedDigest = grantDigest(g);
  } catch {
    return { admitted: false, denials: [deny("malformed_grant", "the presented grant cannot be canonically digested")] };
  }
  if (a["grantDigest"] !== presentedDigest) {
    denials.push(deny("grant_digest_mismatch", "the attestation does not bind the presented grant bytes"));
  }

  if (g["profile"] !== expectation.profile || a["profile"] !== expectation.profile) {
    denials.push(deny("profile_mismatch", `expected the ${expectation.profile} profile on both grant and attestation`));
  }
  if (a["hostVersion"] !== expectation.hostVersion) {
    denials.push(deny("host_version_mismatch", "the attestation was minted by a different host version"));
  }
  if (a["productTrustRevocationEpoch"] !== expectation.productTrustRevocationEpoch) {
    denials.push(deny("trust_epoch_mismatch", "the attestation's product-trust revocation epoch is not the current epoch"));
  }
  // Lexicographic order over the fixed-width UTC instant grammar is
  // chronological order; no clock is consulted.
  if (typeof a["expiry"] !== "string" || a["expiry"] <= expectation.observedAt) {
    denials.push(deny("attestation_expired", "the attestation has expired at the caller's observation instant"));
  }

  if (expectation.profile === "checkpoint") {
    if (!bound(a["deliveryId"], expectation.deliveryId)) {
      denials.push(deny("delivery_mismatch", "the attestation is bound to a different delivery"));
    }
    if (!bound(a["invocationFence"], expectation.invocationFence)) {
      denials.push(deny("fence_mismatch", "the attestation is not bound to the current invocation fence"));
    }
    if (!bound(a["workspaceId"], expectation.workspaceId)) {
      denials.push(deny("workspace_mismatch", "the attestation is bound to a different workspace"));
    }
    if (!bound(a["projectionDigest"], expectation.projectionDigest)) {
      denials.push(deny("projection_digest_mismatch", "the attestation does not bind the run-pinned projection digest"));
    }
    if (!bound(a["discoveryConfigurationDigest"], expectation.discoveryConfigurationDigest)) {
      denials.push(deny("discovery_configuration_mismatch", "the attestation does not bind the binding-written discovery configuration"));
    }
    if (!bound(a["registeringInstallationId"], expectation.registeringInstallationId)) {
      denials.push(deny("installation_mismatch", "the attestation is bound to a different registering installation"));
    }
    if (!bound(a["activeProfile"], expectation.activeProfile)) {
      denials.push(deny("active_profile_mismatch", "the attestation is bound to a different active profile"));
    }
    const capabilities = g["allowedCapabilities"];
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      denials.push(deny("empty_grant", "an empty grant yields no mutation-capable invocation token"));
    }
  } else if (!bound(a["intakeDraftId"], expectation.intakeDraftId)) {
    denials.push(deny("intake_draft_mismatch", "the attestation is bound to a different intake draft"));
  }

  if (denials.length > 0) return { admitted: false, denials };

  return {
    admitted: true,
    profile: expectation.profile,
    grantDigest: presentedDigest,
    allowedCapabilities: [...(g["allowedCapabilities"] as string[])],
    writablePaths: [...(g["writablePaths"] as string[])],
    protectedPaths: [...(g["protectedPaths"] as string[])],
    forbiddenOperations: [...(g["forbiddenOperations"] as string[])],
    mutationCapable: expectation.profile === "checkpoint",
  };
}

// ── Per-invocation interception ─────────────────────────────────────────────

/** The prefix every operator-confirmation operation lives under (D15). */
export const CONFIRMATION_OPERATION_PREFIX = "operator-confirmation.";

export interface ToolInvocationRequest {
  /** The host tool / MCP capability name being invoked. */
  readonly capability: string;
  /** Optional operation label, matched against the grant's forbidden set. */
  readonly operation?: string;
  /** Workspace-relative paths the invocation intends to write, caller-normalized. */
  readonly writes?: readonly string[];
}

export interface ToolDenial {
  readonly code: ToolDenialCode;
  readonly message: string;
  /** For `not_admitted`: why the underlying admission failed. */
  readonly admissionDenials?: readonly AdmissionDenial[];
}

export type ToolInvocationDecision = { readonly allowed: true } | { readonly allowed: false; readonly denials: readonly ToolDenial[] };

const normalizedRelative = (p: string): boolean =>
  p.length > 0 && !p.startsWith("/") && !p.split("/").some((segment) => segment === ".." || segment === "." || segment === "");

const underAny = (p: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => {
    const clean = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return p === clean || p.startsWith(`${clean}/`);
  });

/**
 * The interceptor decision for one tool invocation: re-evaluates admission
 * against the binding's CURRENT expectation, then scopes the invocation to
 * the attested grant's contents. Denial is total — a single failing write
 * path denies the whole invocation, and a confirmation-class operation is
 * denied inside any grant regardless of what the grant's bytes claim.
 */
export function evaluateToolInvocation(
  expectation: AdmissionExpectation,
  grant: unknown,
  attestation: unknown,
  request: ToolInvocationRequest,
): ToolInvocationDecision {
  const admission = evaluateHostAdmission(expectation, grant, attestation);
  if (!admission.admitted) {
    return {
      allowed: false,
      denials: [
        {
          code: "not_admitted",
          message: "no valid attestation for the current expectation; tools stay closed",
          admissionDenials: admission.denials,
        },
      ],
    };
  }

  const denials: ToolDenial[] = [];
  const { capability, operation, writes } = request;

  if (
    capability.startsWith(CONFIRMATION_OPERATION_PREFIX) ||
    (operation !== undefined && operation.startsWith(CONFIRMATION_OPERATION_PREFIX))
  ) {
    denials.push({
      code: "confirmation_operation_excluded",
      message: "operator confirmations are excluded from every grant and served only by the binding-owned facade channel",
    });
  }
  if (!admission.allowedCapabilities.includes(capability)) {
    denials.push({ code: "capability_not_granted", message: `capability "${capability}" is outside the attested grant` });
  }
  if (operation !== undefined && admission.forbiddenOperations.includes(operation)) {
    denials.push({ code: "operation_forbidden", message: `operation "${operation}" is forbidden by the attested grant` });
  }
  for (const write of writes ?? []) {
    if (!normalizedRelative(write)) {
      denials.push({ code: "unnormalized_path", message: `write path "${write}" is not a normalized workspace-relative path` });
      continue;
    }
    if (underAny(write, admission.protectedPaths)) {
      denials.push({ code: "protected_path", message: `write path "${write}" is under a protected authority path` });
      continue;
    }
    if (!underAny(write, admission.writablePaths)) {
      denials.push({ code: "write_outside_grant", message: `write path "${write}" is outside the attested writable paths` });
    }
  }

  return denials.length === 0 ? { allowed: true } : { allowed: false, denials };
}

// ── The isolated confirmation channel's echo challenge ──────────────────────

/**
 * The binding-owned channel state for one rendered confirmation challenge.
 * The channel closes when its owning invocation ends, the challenge is
 * single-use, and the rendering happens only on the binding's own interactive
 * channel — all three are what a detached descendant cannot satisfy.
 */
export interface RenderedConfirmationChallenge {
  readonly channelId: string;
  readonly channelOpen: boolean;
  readonly interactive: boolean;
  readonly challenge: string;
  readonly consumed: boolean;
  readonly expiry: string;
}

export interface ConfirmationEchoAttempt {
  readonly presentedChallenge: string;
  readonly presentedOnChannelId: string;
  readonly observedAt: string;
  /** True when the echo arrived through any model-visible surface (CLI arg, tty write, MCP tool, subprocess). */
  readonly viaModelVisibleSurface: boolean;
  /** False for piped, non-interactive, or inherited-descriptor input. */
  readonly interactive: boolean;
}

export interface ConfirmationDenial {
  readonly code: ConfirmationDenialCode;
  readonly message: string;
}

export type ConfirmationEchoDecision =
  | { readonly completed: true }
  | { readonly completed: false; readonly denials: readonly ConfirmationDenial[] };

export function evaluateConfirmationEcho(
  rendered: RenderedConfirmationChallenge,
  attempt: ConfirmationEchoAttempt,
): ConfirmationEchoDecision {
  const denials: ConfirmationDenial[] = [];

  if (attempt.viaModelVisibleSurface) {
    denials.push({
      code: "model_visible_surface_refused",
      message: "confirmation echoes are accepted only on the binding-owned channel, never through a model-visible surface",
    });
  }
  if (!rendered.channelOpen) {
    denials.push({ code: "channel_closed", message: "the owning invocation ended; a detached descendant holds no channel" });
  }
  if (!rendered.interactive || !attempt.interactive) {
    denials.push({ code: "non_interactive_refused", message: "non-interactive, piped, or inherited-descriptor input is refused" });
  }
  if (attempt.presentedOnChannelId !== rendered.channelId) {
    denials.push({ code: "wrong_channel", message: "the echo did not return on the channel the challenge was rendered on" });
  }
  if (rendered.consumed) {
    denials.push({ code: "challenge_consumed", message: "the challenge is single-use and was already consumed" });
  }
  if (!SPINE_INSTANT.test(attempt.observedAt) || rendered.expiry <= attempt.observedAt) {
    denials.push({ code: "challenge_expired", message: "the challenge expired at the caller's observation instant" });
  }
  if (attempt.presentedChallenge !== rendered.challenge) {
    denials.push({ code: "challenge_mismatch", message: "the echoed value does not match the rendered challenge" });
  }

  return denials.length === 0 ? { completed: true } : { completed: false, denials };
}

// ── Assertion-source degradation ────────────────────────────────────────────

export interface AssertionSourceAvailability {
  readonly hostNative: boolean;
  readonly osNative: boolean;
}

export interface LaneAvailability {
  /** Waiver confirmation, update, rollback, trust-state maintenance, merge/deploy approvals. */
  readonly sensitiveApprovals: "available" | "fail_closed_no_assertion_source";
  /** Contract confirmation and takeover need only the isolated facade channel. */
  readonly operatorConfirmations: "available";
  readonly mergeReadyLane: "available";
}

/**
 * Losing every assertion source disables the sensitive set and nothing else:
 * operator confirmations arrive on the installation's interactive facade
 * channel, and the merge-ready mutation lane continues.
 */
export function assertionLaneAvailability(sources: AssertionSourceAvailability): LaneAvailability {
  return {
    sensitiveApprovals: sources.hostNative || sources.osNative ? "available" : "fail_closed_no_assertion_source",
    operatorConfirmations: "available",
    mergeReadyLane: "available",
  };
}
