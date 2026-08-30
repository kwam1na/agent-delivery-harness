/**
 * Consumption of the security-blocked migration assertion — the one lane out
 * of `security_blocked` when the generation changed or the delivery is being
 * rebound to a different registering installation.
 *
 * The assertion binds the target installation and generation identities, the
 * target delivery identity, and its expected journal revision; consumption
 * REJECTS ON ANY MISMATCH. The candidate is deliberately not bound — the
 * mandatory full re-preparation recaptures it — and no invocation fence is
 * bound or minted: the migration consumes without re-fencing. Product trust
 * is evaluated against the assertion's bound target generation in place of
 * the delivery's recorded pin (which the consumption replaces), a rebinding
 * requires the target installation's active profile to equal the delivery's
 * recorded profile, and the nonce is single-use against the delivery
 * journal's durable consumption records.
 */
import {
  SECURITY_BLOCKED_MIGRATION_ACTION,
  validateSensitiveApprovalAssertion,
} from "../spine/assertion.ts";
import { localDigestTrustPredicate, type ProductTrustPort, type ProductTrustState } from "../spine/composition.ts";

export interface MigrationConsumptionContext {
  readonly deliveryId: string;
  readonly expectedJournalRevision: number;
  readonly currentInstallationId: string;
  readonly currentProfile: string;
  readonly recordedInstallationId: string;
  readonly recordedProfile: string;
  readonly trustState: ProductTrustState;
  readonly consumedNonces: ReadonlySet<string>;
  readonly now: string;
  readonly trust?: ProductTrustPort;
}

export interface MigrationRefusal {
  readonly code: string;
  readonly message: string;
}

export type MigrationConsumptionVerdict =
  | { readonly ok: true; readonly rebinding: boolean }
  | { readonly ok: false; readonly blockers: readonly MigrationRefusal[] };

export function evaluateMigrationConsumption(
  assertion: Record<string, unknown>,
  context: MigrationConsumptionContext,
): MigrationConsumptionVerdict {
  const blockers: MigrationRefusal[] = [];
  const refuse = (code: string, message: string): void => {
    blockers.push({ code, message });
  };

  const shape = validateSensitiveApprovalAssertion(assertion);
  if (!shape.ok || assertion["assertionClass"] !== "security-blocked-migration") {
    refuse("assertion_malformed", "the presented value is not a well-formed security-blocked migration assertion");
    return { ok: false, blockers };
  }
  if (assertion["action"] !== SECURITY_BLOCKED_MIGRATION_ACTION) {
    refuse("assertion_mismatch", "the assertion approves a different action");
  }
  if (assertion["deliveryId"] !== context.deliveryId) {
    refuse("assertion_mismatch", "the assertion binds a different target delivery");
  }
  if (assertion["expectedJournalRevision"] !== context.expectedJournalRevision) {
    refuse(
      "assertion_mismatch",
      `the assertion binds journal revision ${String(assertion["expectedJournalRevision"])}; the delivery journal is at ${context.expectedJournalRevision}`,
    );
  }
  if (assertion["targetInstallationId"] !== context.currentInstallationId) {
    refuse("assertion_mismatch", "the assertion binds a different target installation");
  }
  if (assertion["productTrustRevocationEpoch"] !== context.trustState.revocationEpoch) {
    refuse("assertion_stale", "the assertion was evaluated under a superseded product-trust revocation epoch");
  }
  const expiry = assertion["expiry"];
  if (typeof expiry !== "string" || expiry < context.now) {
    refuse("assertion_stale", "the assertion expired; an expired evaluation is a cached credential, treated as invalid");
  }
  const nonce = assertion["nonce"];
  if (typeof nonce === "string" && context.consumedNonces.has(nonce)) {
    refuse("assertion_replayed", `nonce ${nonce} was already consumed by this delivery journal`);
  }
  if (
    assertion["assertionSource"] === "qualification-fixture" &&
    context.currentProfile !== "confirmation-fixture"
  ) {
    refuse("assertion_source_mismatch", "a fixture-sourced assertion can never approve a migration on a production installation");
  }

  // The trust check evaluates the assertion's bound target generation in
  // place of the delivery's recorded pin, which this consumption replaces.
  const target = assertion["targetGenerationDigest"];
  const trust = context.trust ?? localDigestTrustPredicate;
  if (typeof target === "string") {
    if (context.trustState.revokedGenerationDigests.includes(target)) {
      refuse("generation_revoked", `target generation ${target} is revoked; a migration assertion naming a revoked target is refused`);
    } else if (!trust.evaluate(target, context.trustState).eligible) {
      refuse(
        "generation_not_accepted",
        `target generation ${target} was never accepted under the target installation's local trust policy`,
      );
    }
  }

  const rebinding = context.recordedInstallationId !== context.currentInstallationId;
  if (rebinding && context.recordedProfile !== context.currentProfile) {
    refuse(
      "profile_mismatch",
      `a rebinding migration requires the target installation's active profile (${context.currentProfile}) to equal the delivery's recorded profile (${context.recordedProfile})`,
    );
  }

  return blockers.length === 0 ? { ok: true, rebinding } : { ok: false, blockers };
}
