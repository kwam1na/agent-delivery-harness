/**
 * The conformance kit's `context/repo-config.json`, adapted into a harness
 * config.
 *
 * The kit declares the repository policy a validator needs to judge its
 * vectors, and nothing else: a gate id, the envelope specs and identity
 * versions it accepts, and one obligation with its payload specs, providers and
 * minimum attestation level. A harness config is a much wider surface, so the
 * adapter does three separable things, and the test beside it checks each one:
 *
 *   MAPS the fields the kit declares. These are the dimensions the vectors are
 *   bound to — a vector that expects `unregistered_provider` is expecting it
 *   against *this* provider list — so they are carried across verbatim.
 *
 *   STRIPS `configVersion`. It versions the kit's own file format and has no
 *   counterpart in a harness config; carrying it would fail the closed grammar.
 *
 *   DEFAULTS every remaining dimension. Each default is either vector-
 *   independent (no vector's expectation can turn on it) or forced by a config
 *   invariant. There is exactly one of the latter, and it is named below.
 *
 * THE ONE CONSTRAINED DEFAULT. The kit declares `deliverable-tree/v1` as its
 * identity version, and the config invariants bind that token to its narration
 * set in both directions. So `reviewNeutral` is not free here: it must be the
 * `deliverable-tree/v1` narration set or the config will not load. This is
 * harmless for kit runs, which stub candidate capture with each vector's own
 * values and never recompute an identity from a real tree — but it is a
 * constraint rather than a free choice, and pretending otherwise would hide the
 * one place the adapter's hands are tied.
 *
 * NEGATIVE SPACE. Four tokens must stay *absent* from this config, because four
 * reject vectors expect a rejection that only happens while they are absent:
 * the obligation `qa.exercised`, the payload spec `review.green/0`, the provider
 * `unknown.provider`, and the identity version `deliverable-tree/v0`. A default
 * that quietly widened the config to include one of them would turn a reject
 * vector green without changing a single expectation. `negativeSpaceViolations`
 * exists so that widening is caught rather than discovered.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DELIVERABLE_TREE_V1_NARRATION_SET,
  defineHarnessConfig,
  type HarnessConfig,
  type HarnessConfigInput,
} from "@agent-delivery-harness/kernel";

/** The kit's own file format, as declared in `context/repo-config.json`. */
export interface KitRepoConfig {
  readonly configVersion: number;
  readonly gateId: string;
  readonly acceptedEnvelopeSpecs: readonly string[];
  readonly identityVersions: readonly string[];
  readonly obligations: Readonly<
    Record<
      string,
      {
        readonly acceptedPayloadSpecs: readonly string[];
        readonly providers: readonly string[];
        readonly minimumAttestationLevel: string;
      }
    >
  >;
}

/** Dimensions carried across from the kit's declaration. */
export const KIT_MAPPED_DIMENSIONS: readonly string[] = [
  "gateId",
  "acceptedEnvelopeSpecs",
  "identityVersions",
  // Derived from the declaration: the kit names exactly one identity version,
  // and a recorder must accept the identity it computes.
  "computingIdentityVersion",
  "providers.ids",
  "obligations.ids",
  "obligations.providers",
  "obligations.acceptedPayloadSpecs",
  "obligations.minimumAttestationLevel",
];

/**
 * Dimensions the kit does not declare, each with the reason its default is safe.
 * `invariant-constrained` means the value is not a free choice; every other
 * entry is a dimension no vector expectation can turn on.
 */
export const KIT_DEFAULTED_DIMENSIONS: Readonly<Record<string, "vector-independent" | "invariant-constrained">> = {
  baseRef: "vector-independent",
  storageNamespace: "vector-independent",
  reviewNeutral: "invariant-constrained",
  recordNeutral: "vector-independent",
  pathClassification: "vector-independent",
  sensitivePaths: "vector-independent",
  activationThreshold: "vector-independent",
  agentEnvSignals: "vector-independent",
  ciPolicies: "vector-independent",
  ciPolicyEnvKey: "vector-independent",
  preparationWiringPaths: "vector-independent",
  deliveryRecordPath: "vector-independent",
  deliveryRecordVerification: "vector-independent",
  "providers.findingCodes": "vector-independent",
  "obligations.activation.kind": "vector-independent",
  "obligations.activation.sensitiveGroupIds": "vector-independent",
  "obligations.activation.relevantBinaryChangeActivates": "vector-independent",
  "obligations.activation.relevantZeroLineChangeActivates": "vector-independent",
  "obligations.freshness": "vector-independent",
  "obligations.providerPolicy": "vector-independent",
  "obligations.allowedResolutionKinds": "vector-independent",
  "obligations.humanWaiverAllowed": "vector-independent",
  "obligations.ciDelegationPolicyIds": "vector-independent",
  "obligations.remediation": "vector-independent",
  "obligations.waivableCodes": "vector-independent",
  "obligations.nonWaivableCodes": "vector-independent",
};

/** Tokens whose absence four reject vectors depend on. */
export const KIT_NEGATIVE_SPACE: readonly string[] = [
  "qa.exercised",
  "review.green/0",
  "unknown.provider",
  "deliverable-tree/v0",
];

/**
 * The gate's structural finding codes, restated so the adapter's classification
 * is a decision this file makes rather than a set it inherits. A structural code
 * added to the contract shows up here as an unclassified-code finding at load
 * time, which is the intended way to learn about it.
 */
const STRUCTURAL_CODES: readonly string[] = [
  "review_evidence_missing",
  "stale_evidence",
  "evidence_not_green",
  "unresolved_actionable_findings",
  "ambiguous_records",
  "malformed_record",
  "unknown_provider",
  "live_provider_missing",
  "ambiguous_live_provider",
  "live_provider_failed",
  "resolution_not_allowed",
];

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Maps a parsed kit repo-config into a harness config. Pure: the caller supplies
 * the parsed value, so the mapping is testable against a synthetic declaration
 * without touching the vendored kit.
 */
export function adaptKitRepoConfig(raw: unknown): HarnessConfig {
  const declared = requireRecord(raw, "kit repo-config");
  const obligations = requireRecord(declared["obligations"], "kit repo-config obligations");

  const identityVersions = declared["identityVersions"] as readonly string[];
  const providerIds = [
    ...new Set(
      Object.values(obligations).flatMap((obligation) => (requireRecord(obligation, "kit obligation")["providers"] as readonly string[]) ?? []),
    ),
  ];

  const input: HarnessConfigInput = {
    // ── Mapped ──
    gateId: declared["gateId"] as string,
    acceptedEnvelopeSpecs: declared["acceptedEnvelopeSpecs"] as readonly string[],
    identityVersions,
    // The kit declares one identity version; a recorder must accept the identity
    // it computes, so the sole declared version is the computing one.
    computingIdentityVersion: identityVersions[0] as string,
    // The kit registers providers per obligation and declares no finding codes
    // for them, so the registry is their union with an empty code surface. That
    // leaves the emittable universe equal to the structural registry, which is
    // what the classification below partitions.
    providers: providerIds.map((id) => ({ id, findingCodes: [] })),
    obligations: Object.entries(obligations).map(([id, declaredObligation]) => {
      const obligation = requireRecord(declaredObligation, `kit obligation ${id}`);
      return {
        id,
        acceptedPayloadSpecs: obligation["acceptedPayloadSpecs"] as readonly string[],
        providers: obligation["providers"] as readonly string[],
        minimumAttestationLevel: obligation["minimumAttestationLevel"] as "self",
        // ── Defaulted, per obligation ──
        activation: { kind: "relevant_change" },
        freshness: "exact_candidate",
        allowedResolutionKinds: ["satisfied_evidence", "not_applicable"],
        humanWaiverAllowed: false,
        ciDelegationPolicyIds: [],
        remediation: {
          default: [
            {
              id: "submit-evidence",
              kind: "manual_action",
              summary: `Submit a manifest claiming ${id} for the current candidate.`,
            },
          ],
        },
        waivableCodes: [],
        nonWaivableCodes: STRUCTURAL_CODES,
      };
    }),
    // ── Defaulted ──
    baseRef: "origin/main",
    storageNamespace: "delivery-harness/",
    reviewNeutral: [...DELIVERABLE_TREE_V1_NARRATION_SET],
    recordNeutral: [{ prefix: "docs/reports/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [],
    activationThreshold: 1,
    agentEnvSignals: [],
    ciPolicies: [],
    ciPolicyEnvKey: "DELIVERY_HARNESS_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    deliveryRecordPath: "docs/reports/delivery-record.json",
    deliveryRecordVerification: { baseMovement: "stale" },
  };

  return defineHarnessConfig(input);
}

/** Repo-relative path of the vendored declaration this adapter reads. */
export const KIT_REPO_CONFIG_PATH = "packages/conformance/vectors/context/repo-config.json";

export function readKitRepoConfig(): KitRepoConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, "..", "vectors", "context", "repo-config.json");
  return JSON.parse(readFileSync(file, "utf8")) as KitRepoConfig;
}

/** The kit's own configuration, loaded and validated. */
export function loadKitRepoConfig(): HarnessConfig {
  return adaptKitRepoConfig(readKitRepoConfig());
}

/**
 * Which negative-space tokens a config has let in. Empty is the only correct
 * answer for a config the kit is evaluated under.
 */
export function negativeSpaceViolations(config: HarnessConfig): readonly string[] {
  const declared = JSON.stringify(config);
  return KIT_NEGATIVE_SPACE.filter((token) => declared.includes(token));
}
