/**
 * The repository authority-revocation epoch — the emergency ceiling beside
 * the immutable compiled snapshot.
 *
 * The store's grammar can only NARROW: it names an epoch and two revoked
 * sets, and has no member through which authority could be granted, so
 * expansion is unspellable in the store. Expansion arrives only as a new
 * owner-approved policy generation — and even then, an accepted delivery's
 * ceiling stays the snapshot it bound: `effectiveDeliveryAuthority`
 * intersects the bound grants with every later layer, so each layer can
 * remove and none can add.
 *
 * The epoch is monotonic. A presented store below the highest epoch ever
 * observed is a rollback — a candidate rewriting the authority store
 * backward restores nothing — and a revocation applies immediately at every
 * recheck site, including after `ready`, when the final candidate commit
 * already stands.
 */
import { nonNegativeInt, specLiteral, stringArray, type MemberRule } from "../spine/grammar.ts";
import { checkClosedWithOptionals, createPolicyCollector, type PolicyVerdict } from "./capabilities.ts";
import type { PolicySnapshot } from "../spine/policy.ts";

export const AUTHORITY_REVOCATION_SPEC = "authority-revocation/1";

export interface AuthorityRevocation {
  readonly spec: typeof AUTHORITY_REVOCATION_SPEC;
  readonly epoch: number;
  readonly revokedAuthority: readonly string[];
  readonly revokedFinishLines: readonly string[];
}

const REVOCATION_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(AUTHORITY_REVOCATION_SPEC) },
  { name: "epoch", check: nonNegativeInt },
  { name: "revokedAuthority", check: stringArray() },
  { name: "revokedFinishLines", check: stringArray() },
];

export function validateAuthorityRevocation(value: unknown): PolicyVerdict {
  const collector = createPolicyCollector();
  checkClosedWithOptionals(value, "", REVOCATION_RULES, [], collector);
  return collector.verdict();
}

export type ObserveAuthorityEpochResult =
  | { readonly ok: true; readonly highestObservedEpoch: number }
  | { readonly ok: false; readonly rejections: readonly { readonly code: string; readonly pointer: string; readonly message: string }[] };

/**
 * Consumes one observation of the authority store against the highest epoch
 * ever observed. A lower epoch rejects; an equal or higher epoch advances
 * (or holds) the floor.
 */
export function observeAuthorityEpoch(highestObservedEpoch: number, presented: unknown): ObserveAuthorityEpochResult {
  const shape = validateAuthorityRevocation(presented);
  if (!shape.ok) return shape;
  const revocation = presented as AuthorityRevocation;
  if (revocation.epoch < highestObservedEpoch) {
    return {
      ok: false,
      rejections: [
        {
          code: "epoch_rollback",
          pointer: "/epoch",
          message: `the store presents epoch ${revocation.epoch} below the observed floor ${highestObservedEpoch}; the epoch is monotonic and a rollback restores nothing`,
        },
      ],
    };
  }
  return { ok: true, highestObservedEpoch: revocation.epoch };
}

/** The grants a snapshot-like layer contributes to the intersection. */
export interface AuthorityGrantView {
  readonly grantedFinishLines: readonly string[];
  readonly grantedAuthority: readonly string[];
}

export interface EffectiveDeliveryAuthorityInput {
  /** The snapshot this delivery bound — its ceiling, forever. */
  readonly bound: AuthorityGrantView;
  readonly revocation: AuthorityRevocation;
  /** The currently active policy generation, when one should also constrain. */
  readonly currentGeneration?: AuthorityGrantView;
}

/**
 * The delivery's effective authority right now: the bound snapshot minus
 * every revocation, intersected with the current generation when supplied.
 * Layers only remove — a wider current generation contributes nothing.
 */
export function effectiveDeliveryAuthority(input: EffectiveDeliveryAuthorityInput): AuthorityGrantView {
  const withinCurrent = (kind: "grantedFinishLines" | "grantedAuthority", entry: string): boolean =>
    input.currentGeneration === undefined || input.currentGeneration[kind].includes(entry);
  return {
    grantedFinishLines: input.bound.grantedFinishLines.filter(
      (entry) => !input.revocation.revokedFinishLines.includes(entry) && withinCurrent("grantedFinishLines", entry),
    ),
    grantedAuthority: input.bound.grantedAuthority.filter(
      (entry) => !input.revocation.revokedAuthority.includes(entry) && withinCurrent("grantedAuthority", entry),
    ),
  };
}

export interface CheckActionAuthorizationInput {
  readonly action: string;
  readonly bound: PolicySnapshot | AuthorityGrantView;
  readonly revocation: unknown;
  readonly highestObservedEpoch: number;
}

/**
 * The canonical recheck: is this external action authorized right now? Run at
 * every recheck site — a revocation observed here blocks immediately, even
 * when the delivery is already `ready` and the final candidate commit stands.
 */
export function checkActionAuthorization(input: CheckActionAuthorizationInput): PolicyVerdict {
  const collector = createPolicyCollector();
  const observed = observeAuthorityEpoch(input.highestObservedEpoch, input.revocation);
  if (!observed.ok) {
    for (const rejection of observed.rejections) collector.emit(rejection.code, rejection.pointer, rejection.message);
    return collector.verdict();
  }
  const revocation = input.revocation as AuthorityRevocation;
  if (revocation.revokedAuthority.includes(input.action)) {
    collector.emit(
      "authority_revoked",
      "/action",
      `${input.action} authority is revoked at epoch ${revocation.epoch}; a revocation narrows immediately, including after ready`,
    );
    return collector.verdict();
  }
  if (!input.bound.grantedAuthority.includes(input.action)) {
    collector.emit(
      "authority_not_granted",
      "/action",
      `the bound snapshot grants no ${input.action} authority; absence of a grant is denial`,
    );
  }
  return collector.verdict();
}
