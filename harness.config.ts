/**
 * This repository's own harness configuration — the gate its pull requests run.
 *
 * The loop this file drives is the one docs/getting-started.md walks a consumer
 * through, performed here for real: the local gate admits a candidate, `record`
 * writes the tracked delivery record under `delivery/records/`, and
 * `.github/workflows/gate.yml` verifies that record against the pull request
 * head with the Action in `packages/action`. One obligation, deliberately: a
 * green code review, submitted as `review.green/1` evidence by this
 * repository's review provider.
 *
 * WHY THE IDENTITY TOKEN IS CONSUMER-OWNED. `deliverable-tree/v1` is defined
 * over one specific narration set. This repository's review-neutral set is that
 * set plus the directory the tracked delivery record lives in — the record must
 * be neutral to both predicates, and the only way to get there is to widen the
 * review-neutral set. A widened set is a different identity function, so it
 * carries its own token: `delivery-harness-tree/v1`. The token was chosen while
 * this config was still a skeleton, deliberately: an identity token revision
 * cascades — every record computed under the old token stops matching — and
 * committing to the token before any gate existed cost nothing, while revising
 * it now that `gate.yml` verifies records would invalidate real evidence.
 */
import { defineHarnessConfig } from "@v26labs/delivery-harness-kernel";

export default defineHarnessConfig({
  gateId: "delivery-harness.pr-admission",
  baseRef: "origin/main",
  // Git-private evidence storage, under `git rev-parse --git-path` of this
  // namespace. Per the config guidance: a name git does not own, and one the
  // tracked tree does not also use.
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

  providers: [{ id: "claude-code.ce-code-review", findingCodes: [] }],
  obligations: [
    {
      id: "review.green",
      activation: { kind: "relevant_change" },
      freshness: "exact_candidate",
      providers: ["claude-code.ce-code-review"],
      acceptedPayloadSpecs: ["review.green/1"],
      allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
      humanWaiverAllowed: true,
      minimumAttestationLevel: "self",
      // No delegation: the Action runs in verify mode on pull requests, which
      // grants nothing and needs no authorization.
      ciDelegationPolicyIds: [],
      remediation: {
        default: [
          {
            id: "run-the-review",
            kind: "manual_action",
            summary: "Run the code review and submit its evidence manifest with `delivery-harness submit-evidence`.",
          },
        ],
      },
      // Every finding code the gate can emit for this obligation, each in
      // exactly one list. The judgement-shaped codes are waivable by an
      // interactive human; the codes describing a store or record the harness
      // cannot trust are not.
      waivableCodes: [
        "review_evidence_missing",
        "stale_evidence",
        "evidence_not_green",
        "unresolved_actionable_findings",
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

  // The tracked record: the one artifact that crosses from the git-private
  // workspace into the tree. Neutral to both predicates — writing it can
  // neither change the identity it attests nor bind a candidate to its own
  // record. The digest is spliced into the filename at record time, so parallel
  // branches never conflict.
  deliveryRecordPath: "delivery/records/record.json",
  deliveryRecordVerification: { baseMovement: "stale" },
});
