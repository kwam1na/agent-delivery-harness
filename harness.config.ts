/**
 * This repository's own harness configuration.
 *
 * SKELETON. The gate this declares is not the gate this repository will run:
 * the obligation, its provider, and the delivery-record path are placeholders,
 * marked as such below, and are replaced when the repository starts gating its
 * own pull requests. What is real from day one is the *shape* — every invariant
 * the loader enforces is satisfied here, so the file cannot drift into an
 * unloadable state while the placeholders wait for their replacements.
 *
 * WHY THE IDENTITY TOKEN IS ALREADY FINAL. `deliverable-tree/v1` is defined over
 * one specific narration set. This repository's review-neutral set is that set
 * plus the directory the tracked delivery record lives in — the record must be
 * neutral to both predicates, and the only way to get there is to widen the
 * review-neutral set. A widened set is a different identity function, so it gets
 * its own token: `delivery-harness-tree/v1`. Choosing it now rather than later
 * is deliberate. An identity token revision cascades — every record computed
 * under the old token stops matching — and doing it before any gate exists costs
 * nothing, while doing it afterwards would invalidate real evidence.
 */
import { defineHarnessConfig } from "@delivery-harness/kernel";

export default defineHarnessConfig({
  gateId: "delivery-harness.pr-admission",
  baseRef: "origin/main",
  storageNamespace: "delivery-harness/",

  acceptedEnvelopeSpecs: ["delivery-evidence/1"],

  // A consumer-owned token, for the reason in the header comment.
  identityVersions: ["delivery-harness-tree/v1"],
  computingIdentityVersion: "delivery-harness-tree/v1",

  // Narration, plus the delivery record's own directory. Only this set excludes
  // entries from the deliverable digest.
  reviewNeutral: [
    { prefix: "docs/reports/" },
    { prefix: "docs/solutions/" },
    { prefix: "telemetry/delivery-runs/" },
    { prefix: "delivery/records/" },
  ],
  // The stricter predicate: what a recorded candidate is not bound to.
  recordNeutral: [{ prefix: "delivery/records/" }],

  pathClassification: {
    generated: [{ kind: "prefix", value: "packages/conformance/vectors/" }],
    test: [{ kind: "glob", value: "**/*.test.ts" }],
    lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
  },
  sensitivePaths: [
    { id: "gate-kernel", patterns: [{ kind: "prefix", value: "packages/kernel/src/" }] },
    { id: "sensors", patterns: [{ kind: "prefix", value: "scripts/" }] },
  ],
  activationThreshold: 1,

  agentEnvSignals: ["CLAUDE_CODE", "CLAUDECODE"],
  ciPolicies: [
    {
      id: "github-actions",
      requiredEnv: [
        { variable: "GITHUB_ACTIONS", equals: "true" },
        { variable: "CI", equals: "true" },
      ],
    },
  ],
  ciPolicyEnvKey: "DELIVERY_HARNESS_CI_POLICY",

  preparationWiringPaths: ["harness.config.ts"],

  // PLACEHOLDER: one obligation with one provider, replaced when this repository
  // starts gating its own pull requests.
  providers: [{ id: "placeholder.provider", findingCodes: ["placeholder-finding"] }],
  obligations: [
    {
      id: "placeholder.obligation",
      activation: { kind: "relevant_change" },
      freshness: "exact_candidate",
      providers: ["placeholder.provider"],
      acceptedPayloadSpecs: ["review.green/1"],
      allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
      humanWaiverAllowed: true,
      minimumAttestationLevel: "self",
      ciDelegationPolicyIds: [],
      remediation: {
        default: [
          {
            id: "replace-placeholder-obligation",
            kind: "code_change",
            summary: "Replace the placeholder obligation in harness.config.ts with this repository's real gate.",
          },
        ],
      },
      waivableCodes: [
        "review_evidence_missing",
        "stale_evidence",
        "evidence_not_green",
        "unresolved_actionable_findings",
        "placeholder-finding",
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

  // PLACEHOLDER: neutral to both predicates, which is the property that matters
  // and the one the loader checks. The final name is chosen when records start
  // being written.
  deliveryRecordPath: "delivery/records/placeholder.json",
  deliveryRecordVerification: { baseMovement: "stale" },
});
