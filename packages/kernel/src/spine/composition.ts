/**
 * Product composition pin and local product-trust state — the two contracts
 * that make "which bytes are we running, and are they still trusted" a
 * validated value instead of prose.
 *
 * The `agent-skills` workflow-graph/result and provider-rail schemas are
 * PINNED here by digest, exactly as the composition baseline recorded them —
 * never re-authored. A change to any pinned identity is a new composition,
 * not an edit to this file.
 *
 * The trust predicate is deliberately isolated behind ONE validation port
 * (`ProductTrustPort`): every trust check site consumes the port, so the
 * later detached-signature predicate replaces `localDigestTrustPredicate`
 * without touching reducers or check sites. V1 trust is local by design and
 * says so verbatim: the label is `local-digest / operator-pinned`, claiming
 * exactly what was verified and nothing more — mirroring the L0 attestation
 * discipline.
 */
import {
  checkClosed,
  closed,
  createSpineCollector,
  literal,
  nonNegativeInt,
  sha256,
  specLiteral,
  spineId,
  stringArray,
  text,
  type MemberRule,
  type SpineVerdict,
} from "./grammar.ts";

export const PRODUCT_COMPOSITION_PIN_SPEC = "product-composition-pin/1";
export const PRODUCT_TRUST_STATE_SPEC = "product-trust-state/1";

/** Frozen wording. The manifest and every delivery record declare it verbatim. */
export const PRODUCT_TRUST_LABEL = "local-digest / operator-pinned";

/**
 * The exact qualified `agent-skills` release the composition exposes.
 * Pinned, not re-authored: these identities are read off a built release,
 * never edited by hand. Advancing them is a new composition — which is
 * exactly what advancing the shipped reviewer charter set produces, since the
 * charters are archive content and the `workflowGraphSha256` below is
 * unchanged across that advance.
 */
export const PINNED_AGENT_SKILLS = Object.freeze({
  releaseId: "core-v1",
  profile: "core",
  archiveSha256: "bffec8f3d149f709b3607678b4e521ed333a2c65e488625b33c0ef4a99573751",
  metadataSha256: "50b1e8fba7864508e64756a4133967a730ce9c13c7f9f6de3c7fa7fa0bd4b592",
  workflowGraphSha256: "49630e23374f0375cb7d019ea024bcd5ea0c284feb8dc124b393b60f6e8d9aa7",
  provenanceLockSha256: "725e56e08f161645ab8200a6a5f987e5643976e8cee55f032ddf85c61059f164",
  protocolVersion: "delivery-provider-rails/1",
} as const);

/** A map member whose keys are open (module names) but whose values are checked. */
const versionMap: MemberRule["check"] = (value, at, collector) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    collector.emit("malformed_member", at, "expected an object of module versions");
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    collector.emit("malformed_member", at, "expected at least one module version");
    return;
  }
  for (const [name, version] of entries) {
    if (typeof version !== "string" || version.length === 0) {
      collector.emit("malformed_member", `${at}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`, "expected a non-empty version string");
    }
  }
};

const SKILLS_ARCHIVE_RULES: readonly MemberRule[] = [
  { name: "releaseId", check: spineId },
  { name: "profile", check: text },
  { name: "archiveSha256", check: sha256 },
  { name: "metadataSha256", check: sha256 },
  { name: "workflowGraphSha256", check: sha256 },
  { name: "provenanceLockSha256", check: sha256 },
  { name: "protocolVersion", check: text },
];

/** D2's supported contract-version families, one member each, closed. */
const CONTRACT_VERSION_RULES: readonly MemberRule[] = [
  { name: "policy", check: text },
  { name: "scopedWork", check: text },
  { name: "run", check: text },
  { name: "workflowResult", check: text },
  { name: "event", check: text },
  { name: "controlPlane", check: text },
];

const COMPOSITION_PIN_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(PRODUCT_COMPOSITION_PIN_SPEC) },
  { name: "productVersion", check: text },
  { name: "distributionDigest", check: sha256 },
  { name: "harnessModuleVersions", check: versionMap },
  { name: "skillsArchive", check: closed(SKILLS_ARCHIVE_RULES) },
  { name: "contractVersions", check: closed(CONTRACT_VERSION_RULES) },
  { name: "productTrustLabel", check: literal(PRODUCT_TRUST_LABEL) },
];

export function validateCompositionPin(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  checkClosed(value, "", COMPOSITION_PIN_RULES, collector);
  return collector.verdict();
}

const TRUST_STATE_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(PRODUCT_TRUST_STATE_SPEC) },
  { name: "installationId", check: spineId },
  { name: "pinnedManifestDigest", check: sha256 },
  { name: "acceptedGenerationDigests", check: stringArray({ item: sha256 }) },
  { name: "revokedGenerationDigests", check: stringArray({ item: sha256 }) },
  { name: "revocationEpoch", check: nonNegativeInt },
  { name: "highWaterMark", check: nonNegativeInt },
];

export function validateProductTrustState(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  checkClosed(value, "", TRUST_STATE_RULES, collector);
  return collector.verdict();
}

export interface ProductTrustState {
  readonly spec: typeof PRODUCT_TRUST_STATE_SPEC;
  readonly installationId: string;
  readonly pinnedManifestDigest: string;
  /**
   * Every generation this installation ever accepted under its local trust
   * policy — the only pool operator rollback and re-pinning may select from,
   * and what keeps a delivery pinned to an older accepted generation
   * execution-eligible after the active pin moves on. Membership never makes
   * revoked bytes eligible: revocation always wins.
   */
  readonly acceptedGenerationDigests: readonly string[];
  readonly revokedGenerationDigests: readonly string[];
  readonly revocationEpoch: number;
  readonly highWaterMark: number;
}

export type TrustDecision = { readonly eligible: true } | { readonly eligible: false; readonly reason: "revoked" | "not_pinned" };

/**
 * The single validation port every trust check site consumes. A conforming
 * fixture — or the eventual detached-signature predicate — replaces the
 * implementation without touching any consumer.
 */
export interface ProductTrustPort {
  evaluate(generationDigest: string, state: ProductTrustState): TrustDecision;
}

/**
 * V1's digest predicate: a generation is execution-eligible exactly when it
 * is not revoked and is either the operator-pinned manifest digest or a
 * generation this installation previously accepted (which is what keeps a
 * delivery pinned to an older accepted generation running after the active
 * pin advances). Revocation wins over both — revoked bytes remain retained
 * for audit but are never eligible, whatever else claims otherwise.
 */
export const localDigestTrustPredicate: ProductTrustPort = {
  evaluate(generationDigest, state) {
    if (state.revokedGenerationDigests.includes(generationDigest)) {
      return { eligible: false, reason: "revoked" };
    }
    if (
      generationDigest !== state.pinnedManifestDigest &&
      !state.acceptedGenerationDigests.includes(generationDigest)
    ) {
      return { eligible: false, reason: "not_pinned" };
    }
    return { eligible: true };
  },
};
