/**
 * The full-divergence configuration the kernel suite is re-run under.
 *
 * Where the kit-variant config holds the vector-bound dimensions still, this one
 * holds nothing still except the three values this version's scope fixes:
 *
 *   `delivery-evidence/1`   the only envelope spec version that exists,
 *   `review.green/1`        the only payload spec with a validator,
 *   attestation `self`      the only level with a specified meaning.
 *
 * Everything else — the gate id, the identity token, both neutral sets, the
 * obligation's *name*, its providers, its activation, freshness, resolution
 * policy, waiver policy, code classification, remediation catalog, the CI
 * policies, the storage namespace, the record path and its verification policy —
 * differs from the kit's configuration. A kernel that behaves identically under
 * both is a kernel that reads its policy from the parameter it was given.
 *
 * The obligation is deliberately not called `review.green`. Nothing in the
 * config grammar ties a payload spec to the obligation that accepts it, and a
 * fixture that kept the familiar name would leave that untested — an obligation
 * named `code.reviewed` accepting `review.green/1` is exactly the shape a
 * consumer with its own vocabulary will write.
 */
import { defineHarnessConfig, type HarnessConfig } from "@agent-delivery-harness/kernel";

/**
 * The only dimensions this config shares with the kit's. Everything outside this
 * list must differ, and the test beside this file asserts it.
 */
export const SECOND_CONFIG_FIXED_DIMENSIONS: readonly string[] = [
  "acceptedEnvelopeSpecs",
  "obligations.acceptedPayloadSpecs",
  "obligations.minimumAttestationLevel",
];

const AUDIT_PROVIDER_CODES = ["audit-dissent", "audit-coverage-gap"] as const;

export const secondConfig: HarnessConfig = defineHarnessConfig({
  // ── Fixed by this version's scope ──
  acceptedEnvelopeSpecs: ["delivery-evidence/1"],

  // ── Divergent ──
  gateId: "second.promotion-gate",
  baseRef: "origin/release",
  storageNamespace: "second-gate/store/",
  identityVersions: ["second-tree/v1", "second-tree/v2"],
  computingIdentityVersion: "second-tree/v2",
  // A consumer-owned token, so the neutral set is the consumer's own — and must
  // not be the narration set the deliverable-tree/v1 token is defined over.
  reviewNeutral: [{ prefix: "notes/" }, { prefix: "audit/", suffix: ".json" }],
  recordNeutral: [{ prefix: "notes/records/" }],
  pathClassification: {
    generated: [{ kind: "glob", value: "**/__generated__/**" }],
    test: [{ kind: "glob", value: "**/*_spec.ts" }],
    lockfile: [{ kind: "glob", value: "**/Cargo.lock" }],
  },
  sensitivePaths: [{ id: "crypto", patterns: [{ kind: "prefix", value: "lib/crypto/" }] }],
  activationThreshold: 120,
  providers: [{ id: "second.auditor", findingCodes: [...AUDIT_PROVIDER_CODES] }],
  agentEnvSignals: ["SECOND_AGENT"],
  ciPolicies: [{ id: "second-runner", requiredEnv: [{ variable: "SECOND_CI", equals: "1" }] }],
  ciPolicyEnvKey: "SECOND_GATE_POLICY",
  preparationWiringPaths: ["second.config.ts"],
  deliveryRecordPath: "notes/records/promotion.json",
  deliveryRecordVerification: { baseMovement: "allow" },
  obligations: [
    {
      id: "code.reviewed",
      // Fixed by scope: the payload spec with a validator, and the only level
      // whose meaning is specified.
      acceptedPayloadSpecs: ["review.green/1"],
      minimumAttestationLevel: "self",
      // Divergent. The activation narrowing members are inert on an `always`
      // obligation but declared so the new dimensions diverge from the kit's
      // absent defaults; the empty binding is the opt-out-of-the-sensitive-
      // signal spelling, and the quantifier is the explicit spelling of "all".
      activation: {
        kind: "always",
        sensitiveGroupIds: [],
        relevantBinaryChangeActivates: true,
        relevantZeroLineChangeActivates: false,
      },
      providerPolicy: "all",
      freshness: "live",
      providers: ["second.auditor"],
      allowedResolutionKinds: ["satisfied_live_fact", "waived", "delegated"],
      humanWaiverAllowed: true,
      ciDelegationPolicyIds: ["second-runner"],
      remediation: {
        default: [{ id: "request-audit", kind: "manual_action", summary: "Request an audit of the current candidate." }],
      },
      // A different cut of the same universe: the two judgement-shaped
      // structural codes and the provider's own findings are waivable here,
      // where the kit's config waives nothing at all.
      waivableCodes: ["evidence_not_green", "unresolved_actionable_findings", ...AUDIT_PROVIDER_CODES],
      nonWaivableCodes: [
        "review_evidence_missing",
        "stale_evidence",
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
