/**
 * The pure half of the installation-scoped product trust store.
 *
 * The store itself is one file inside the installation namespace, owned by
 * the product installation and covered by owner-only protections; the
 * installer half (`installer.ts`) does the reading and writing. This module
 * makes the three decisions that must be exhaustively testable without a
 * filesystem:
 *
 *   - PARSING that fails closed: bytes that are not JSON, or a document
 *     outside the frozen `product-trust-state/1` grammar, are `corrupt` —
 *     never partially adopted, never re-initialized.
 *   - THE FIRST-INSTALL DISCRIMINATOR. Epoch zero exists only on a genuinely
 *     first installation: no trust store, no install receipt, and none of the
 *     other installation artifacts (generation roots, update journal,
 *     active/rollback pointers). A missing, deleted, or unreadable store or
 *     receipt alongside ANY of those fails closed rather than initializing —
 *     deleting trust state must never manufacture a fresh epoch.
 *   - NO-DOWNGRADE against the persisted high-water mark: an older
 *     composition sequence can never silently replace the active generation.
 */
import { validateProductTrustState, type ProductTrustState } from "../spine/composition.ts";

/** Presence of one artifact class, as observed by the installer. */
export type ArtifactPresence = "absent" | "corrupt" | "valid";

/** The other artifacts whose survival implies a prior trust store. */
export const OTHER_INSTALLATION_ARTIFACTS = Object.freeze([
  "generation-root",
  "update-journal",
  "active-pointer",
  "rollback-pointer",
] as const);
export type OtherInstallationArtifact = (typeof OTHER_INSTALLATION_ARTIFACTS)[number];

export interface InstallationPresence {
  readonly trustStore: ArtifactPresence;
  readonly receipt: ArtifactPresence;
  readonly otherArtifacts: readonly OtherInstallationArtifact[];
}

export type ParseTrustStateResult =
  | { readonly ok: true; readonly state: ProductTrustState }
  | { readonly ok: false; readonly code: "trust_state_corrupt"; readonly message: string };

export function parseTrustState(textContent: string): ParseTrustStateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textContent);
  } catch {
    return { ok: false, code: "trust_state_corrupt", message: "the trust store's bytes are not JSON" };
  }
  const verdict = validateProductTrustState(parsed);
  if (!verdict.ok) {
    const detail = verdict.rejections.map((rejection) => `${rejection.pointer || "/"}: ${rejection.message}`).join("; ");
    return {
      ok: false,
      code: "trust_state_corrupt",
      message: `the trust store is outside the product-trust-state/1 grammar (${detail})`,
    };
  }
  return { ok: true, state: parsed as unknown as ProductTrustState };
}

export type InstallDiscrimination =
  | { readonly kind: "first_install" }
  | { readonly kind: "adopt" }
  | { readonly kind: "fail_closed"; readonly code: "prior_installation_artifacts"; readonly message: string };

/**
 * The discriminator. Adoption requires BOTH the store
 * and the receipt, valid; a genuinely first install requires ABSOLUTELY
 * nothing; everything in between fails closed.
 */
export function discriminateInstall(presence: InstallationPresence): InstallDiscrimination {
  if (presence.trustStore === "valid" && presence.receipt === "valid") return { kind: "adopt" };
  if (presence.trustStore === "absent" && presence.receipt === "absent" && presence.otherArtifacts.length === 0) {
    return { kind: "first_install" };
  }
  const observed = [
    `trust store ${presence.trustStore}`,
    `install receipt ${presence.receipt}`,
    ...(presence.otherArtifacts.length > 0 ? [`surviving artifacts: ${presence.otherArtifacts.join(", ")}`] : []),
  ].join("; ");
  return {
    kind: "fail_closed",
    code: "prior_installation_artifacts",
    message: `installation artifacts imply a prior trust store, so epoch zero is not re-initialized (${observed})`,
  };
}

export type NoDowngradeDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "downgrade_rejected"; readonly message: string };

export function checkNoDowngrade(compositionSequence: number, highWaterMark: number): NoDowngradeDecision {
  if (compositionSequence >= highWaterMark) return { ok: true };
  return {
    ok: false,
    code: "downgrade_rejected",
    message: `composition sequence ${compositionSequence} is below the persisted high-water mark ${highWaterMark}; an older archive can never silently replace the active generation`,
  };
}
