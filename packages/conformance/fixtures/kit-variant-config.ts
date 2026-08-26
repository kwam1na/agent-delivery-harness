/**
 * A second configuration the conformance kit must be just as green under.
 *
 * The kit's own repo-config and this one agree on exactly the dimensions the
 * vectors are bound to, and disagree on everything else. Running the kit under
 * both is what turns "the validator is config-driven" from a claim into a
 * measurement: a validator that had quietly hardcoded a gate id, a storage
 * namespace, or a waiver policy would pass under one config and fail under the
 * other.
 *
 * SETS, NOT MEMBERS. The kit-bound dimensions are pinned as whole sets rather
 * than as "at least these values". Four reject vectors depend on the negative
 * space — `qa.exercised` is not an obligation, `review.green/0` is not an
 * accepted payload spec, `unknown.provider` is not a registered provider,
 * `deliverable-tree/v0` is not an accepted identity version — and a config that
 * merely *contained* the right values while also containing extra ones would
 * turn those four vectors green without touching a single expectation.
 *
 * THE TWO DERIVED-FIXED DIMENSIONS. Pinning `identityVersions` to exactly
 * `{deliverable-tree/v1}` forces `computingIdentityVersion` to that token (a
 * recorder must accept the identity it computes), which in turn forces
 * `reviewNeutral` to that token's narration set (the token binds the set). So
 * two more dimensions are fixed by consequence rather than by choice, and they
 * belong in the enumerated fixed set for the same reason the declared ones do —
 * otherwise the divergence assertion would demand a divergence the invariants
 * forbid. Fixing them costs nothing here: kit runs stub candidate capture and
 * never recompute an identity from a real tree.
 *
 * Everything not in `KIT_VARIANT_FIXED_DIMENSIONS` diverges, and the test beside
 * this file asserts that divergence rather than trusting this comment.
 */
import { DELIVERABLE_TREE_V1_NARRATION_SET, defineHarnessConfig, type HarnessConfig } from "@agent-delivery-harness/kernel";

/**
 * The dimensions this config is not free to vary: those the kit's vectors bind,
 * plus the two the identity invariants derive from them.
 */
export const KIT_VARIANT_FIXED_DIMENSIONS: readonly string[] = [
  // Declared by the kit, bound by its vectors.
  "acceptedEnvelopeSpecs",
  "identityVersions",
  "providers.ids",
  "obligations.ids",
  "obligations.providers",
  "obligations.acceptedPayloadSpecs",
  "obligations.minimumAttestationLevel",
  // Derived from the pinned identity version set.
  "computingIdentityVersion",
  "reviewNeutral",
];

/** Codes the kit's two providers report, invented here — the kit declares none. */
const REVIEW_PROVIDER_CODES = ["review-blocking-finding", "review-pass-incomplete"] as const;
const SECOND_PROVIDER_CODES = ["second-opinion-dissent"] as const;

export const kitVariantConfig: HarnessConfig = defineHarnessConfig({
  // ── Fixed: the kit's vectors bind these ──
  acceptedEnvelopeSpecs: ["delivery-evidence/1"],
  identityVersions: ["deliverable-tree/v1"],
  providers: [
    { id: "claude-code.ce-code-review", findingCodes: [...REVIEW_PROVIDER_CODES] },
    { id: "example.second-provider", findingCodes: [...SECOND_PROVIDER_CODES] },
  ],

  // ── Derived-fixed: forced by the two identity invariants ──
  computingIdentityVersion: "deliverable-tree/v1",
  reviewNeutral: [...DELIVERABLE_TREE_V1_NARRATION_SET],

  // ── Divergent: everything else ──
  gateId: "variant.merge-admission",
  baseRef: "upstream/trunk",
  storageNamespace: "variant-harness/evidence/",
  recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
  pathClassification: {
    generated: [
      { kind: "prefix", value: "build/" },
      { kind: "glob", value: "**/*.generated.ts" },
    ],
    test: [{ kind: "prefix", value: "spec/" }],
    lockfile: [{ kind: "glob", value: "**/pnpm-lock.yaml" }],
  },
  sensitivePaths: [
    { id: "payments", patterns: [{ kind: "prefix", value: "services/payments/" }] },
    { id: "migrations", patterns: [{ kind: "glob", value: "**/migrations/*.sql" }] },
  ],
  activationThreshold: 3,
  agentEnvSignals: ["VARIANT_AGENT", "VARIANT_SESSION_ID"],
  ciPolicies: [
    {
      id: "variant-pipeline",
      requiredEnv: [
        { variable: "VARIANT_CI", equals: "true" },
        { variable: "VARIANT_CI_TRUSTED", equals: "yes" },
      ],
    },
  ],
  ciPolicyEnvKey: "VARIANT_CI_POLICY",
  preparationWiringPaths: ["variant.harness.config.ts", "tooling/gate/wiring.json"],
  deliveryRecordPath: "telemetry/delivery-runs/variant-record.json",
  deliveryRecordVerification: { baseMovement: "allow" },
  obligations: [
    {
      // Fixed: exactly the kit's obligation, its payload specs, its providers,
      // and its attestation level.
      id: "review.green",
      acceptedPayloadSpecs: ["review.green/1"],
      providers: ["claude-code.ce-code-review", "example.second-provider"],
      minimumAttestationLevel: "self",
      // Divergent: every policy dimension the kit does not declare.
      activation: { kind: "always" },
      freshness: "live",
      allowedResolutionKinds: ["satisfied_live_fact", "satisfied_evidence", "waived", "delegated", "not_applicable"],
      humanWaiverAllowed: true,
      ciDelegationPolicyIds: ["variant-pipeline"],
      remediation: {
        default: [
          {
            id: "run-variant-review",
            kind: "command",
            command: ["variant", "review", "--wait"],
            summary: "Run the variant pipeline's review and resubmit.",
          },
        ],
        byCode: {
          stale_evidence: [
            { id: "re-review-current-candidate", kind: "manual_action", summary: "Re-review the current candidate." },
          ],
        },
      },
      waivableCodes: [
        "review_evidence_missing",
        "stale_evidence",
        "evidence_not_green",
        "unresolved_actionable_findings",
        ...REVIEW_PROVIDER_CODES,
        ...SECOND_PROVIDER_CODES,
      ],
      nonWaivableCodes: [
        "ambiguous_records",
        "malformed_record",
        "unknown_provider",
        "live_provider_missing",
        "ambiguous_live_provider",
        "live_provider_failed",
        "resolution_not_allowed",
      ],
    },
  ],
});
