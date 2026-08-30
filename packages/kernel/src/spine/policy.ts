/**
 * The minimal normalized policy snapshot the walking skeleton consumes.
 *
 * It carries BOTH revocation epochs — the product-trust epoch and the
 * repository authority epoch — because the snapshot is immutable while the
 * epochs are the emergency ceiling checked at every canonical recheck site.
 * The snapshot names its own digest, and the digest must recompute from the
 * snapshot's other members: a snapshot whose identity does not match its
 * content is not a policy, it is a claim about one.
 *
 * Vacuous satisfaction is excluded at compilation: a policy activating zero
 * review lenses rejects here, so `reviewing` can never be passed by absence.
 */
import { digestCanonical } from "../digest.ts";
import {
  checkClosed,
  closedArray,
  createSpineCollector,
  nonNegativeInt,
  oneOf,
  sha256,
  specLiteral,
  spineId,
  stringArray,
  type MemberRule,
  type SpineVerdict,
} from "./grammar.ts";
import { FINISH_LINES } from "./contract.ts";

export const POLICY_SNAPSHOT_SPEC = "policy-snapshot/1";

export const REVIEW_LENS_CATEGORIES = Object.freeze(["outcome-correctness", "testing-policy", "additional"] as const);

const LENS_RULES: readonly MemberRule[] = [
  { name: "lensId", check: spineId },
  { name: "category", check: oneOf(REVIEW_LENS_CATEGORIES) },
];

const OBLIGATION_RULES: readonly MemberRule[] = [{ name: "obligationId", check: spineId }];

const SNAPSHOT_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(POLICY_SNAPSHOT_SPEC) },
  { name: "policyDigest", check: sha256 },
  { name: "repositoryId", check: spineId },
  { name: "productTrustRevocationEpoch", check: nonNegativeInt },
  { name: "repositoryAuthorityRevocationEpoch", check: nonNegativeInt },
  { name: "grantedFinishLines", check: stringArray({ minItems: 1, item: oneOf(FINISH_LINES) }) },
  { name: "grantedAuthority", check: stringArray() },
  { name: "reviewLenses", check: closedArray(LENS_RULES) },
  { name: "obligations", check: closedArray(OBLIGATION_RULES) },
];

export interface PolicySnapshot {
  readonly spec: typeof POLICY_SNAPSHOT_SPEC;
  readonly policyDigest: string;
  readonly repositoryId: string;
  readonly productTrustRevocationEpoch: number;
  readonly repositoryAuthorityRevocationEpoch: number;
  readonly grantedFinishLines: readonly (typeof FINISH_LINES)[number][];
  readonly grantedAuthority: readonly string[];
  readonly reviewLenses: readonly { readonly lensId: string; readonly category: (typeof REVIEW_LENS_CATEGORIES)[number] }[];
  readonly obligations: readonly { readonly obligationId: string }[];
}

export function validatePolicySnapshot(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  const record = checkClosed(value, "", SNAPSHOT_RULES, collector);
  if (record !== undefined) {
    const lenses = record["reviewLenses"];
    if (Array.isArray(lenses) && lenses.length === 0) {
      collector.emit(
        "vacuous_policy",
        "/reviewLenses",
        "a policy activating zero review lenses is rejected at compilation; reviewing cannot be passed by absence",
      );
    }
    const declaredDigest = record["policyDigest"];
    if (typeof declaredDigest === "string") {
      const { policyDigest: _declared, ...body } = record;
      let computed: string | undefined;
      try {
        computed = digestCanonical(body);
      } catch {
        computed = undefined;
      }
      if (computed !== undefined && computed !== declaredDigest) {
        collector.emit(
          "digest_mismatch",
          "/policyDigest",
          "the declared policy digest does not recompute from the snapshot's own members",
        );
      }
    }
  }
  return collector.verdict();
}
