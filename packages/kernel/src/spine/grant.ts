/**
 * Host execution grants and their attestations, in the two frozen profiles:
 *
 *   - `checkpoint`: the compiled policy's per-checkpoint envelope — allowed
 *     capabilities, writable and protected paths, forbidden operations. Its
 *     attestation binds host version, delivery, invocation fence, product-
 *     trust revocation epoch, grant digest, workspace, the projection digest,
 *     the discovery-configuration digest, and the delivery-scoped
 *     registering-installation identity and active profile.
 *   - `intake`: the read-only grant product-owned intake turns run under. It
 *     has no writable paths at all, and its attestation records every
 *     delivery-scoped identity EXPLICITLY absent-by-state — present in the
 *     record, bound to the marker — never omitted and never populated,
 *     because pre-delivery there is no fence, workspace, projection,
 *     registering installation, or active profile to bind.
 *
 * The attestation binds the grant by canonical digest, so it attests bytes,
 * not intent.
 */
import { digestCanonical } from "../digest.ts";
import {
  ABSENT_BY_STATE,
  checkClosed,
  createSpineCollector,
  instant,
  isAbsentByState,
  nonNegativeInt,
  oneOf,
  orAbsentByState,
  positiveInt,
  sha256,
  specLiteral,
  spineId,
  spinePointer,
  stringArray,
  text,
  type MemberRule,
  type SpineCollector,
  type SpineVerdict,
} from "./grammar.ts";

export const EXECUTION_GRANT_SPEC = "execution-grant/1";
export const GRANT_ATTESTATION_SPEC = "grant-attestation/1";

export const GRANT_PROFILES = Object.freeze(["checkpoint", "intake"] as const);
export type GrantProfile = (typeof GRANT_PROFILES)[number];

const GRANT_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(EXECUTION_GRANT_SPEC) },
  { name: "profile", check: oneOf(GRANT_PROFILES) },
  { name: "allowedCapabilities", check: stringArray() },
  { name: "writablePaths", check: stringArray() },
  { name: "protectedPaths", check: stringArray() },
  { name: "forbiddenOperations", check: stringArray() },
];

export function validateExecutionGrant(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  const record = checkClosed(value, "", GRANT_RULES, collector);
  if (record !== undefined && record["profile"] === "intake") {
    const writable = record["writablePaths"];
    if (Array.isArray(writable) && writable.length > 0) {
      collector.emit(
        "unsupported_combination",
        "/writablePaths",
        "the intake grant is read-only; an intake profile with writable paths is not a supported combination",
      );
    }
  }
  return collector.verdict();
}

/** The digest an attestation binds: SHA-256 over the grant's RFC 8785 bytes. */
export function grantDigest(grant: unknown): string {
  return digestCanonical(grant);
}

/** The members that exist only once a delivery, fence, and workspace exist. */
const DELIVERY_SCOPED_MEMBERS = Object.freeze([
  "deliveryId",
  "invocationFence",
  "workspaceId",
  "projectionDigest",
  "discoveryConfigurationDigest",
  "registeringInstallationId",
  "activeProfile",
] as const);

const ATTESTATION_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(GRANT_ATTESTATION_SPEC) },
  { name: "profile", check: oneOf(GRANT_PROFILES) },
  { name: "hostVersion", check: text },
  { name: "grantDigest", check: sha256 },
  { name: "productTrustRevocationEpoch", check: nonNegativeInt },
  { name: "expiry", check: instant },
  { name: "intakeDraftId", check: orAbsentByState(spineId) },
  { name: "deliveryId", check: orAbsentByState(spineId) },
  { name: "invocationFence", check: orAbsentByState(positiveInt) },
  { name: "workspaceId", check: orAbsentByState(spineId) },
  { name: "projectionDigest", check: orAbsentByState(sha256) },
  { name: "discoveryConfigurationDigest", check: orAbsentByState(sha256) },
  { name: "registeringInstallationId", check: orAbsentByState(spineId) },
  { name: "activeProfile", check: orAbsentByState(text) },
];

const requireReal = (record: Record<string, unknown>, name: string, collector: SpineCollector): void => {
  if (isAbsentByState(record[name])) {
    collector.emit(
      "unsupported_combination",
      spinePointer("", name),
      `this profile binds ${name} for real; ${JSON.stringify(ABSENT_BY_STATE)} is not a supported combination here`,
    );
  }
};

const requireAbsent = (record: Record<string, unknown>, name: string, collector: SpineCollector): void => {
  if (record[name] !== undefined && !isAbsentByState(record[name])) {
    collector.emit(
      "unsupported_combination",
      spinePointer("", name),
      `this profile records ${name} explicitly ${JSON.stringify(ABSENT_BY_STATE)}; a populated value is not a supported combination`,
    );
  }
};

export function validateGrantAttestation(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  const record = checkClosed(value, "", ATTESTATION_RULES, collector);
  if (record !== undefined) {
    if (record["profile"] === "checkpoint") {
      requireAbsent(record, "intakeDraftId", collector);
      for (const member of DELIVERY_SCOPED_MEMBERS) requireReal(record, member, collector);
    }
    if (record["profile"] === "intake") {
      requireReal(record, "intakeDraftId", collector);
      for (const member of DELIVERY_SCOPED_MEMBERS) requireAbsent(record, member, collector);
    }
  }
  return collector.verdict();
}
