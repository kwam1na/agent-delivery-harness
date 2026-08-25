/**
 * The config loader's falsification table.
 *
 * Written before `config.ts` existed, and structured as the table rather than
 * as prose: one case per invariant, each mutating a single member of one shared
 * valid fixture. A loader that reported nothing would fail every row; a loader
 * that reported everything would fail the happy-path row and the negative
 * controls that sit beside the interesting cases.
 *
 * Two properties are asserted about the table itself, because a falsification
 * table nobody checks for completeness rots into decoration:
 *
 *   - every finding code the loader declares is produced by at least one row
 *     (the coverage assertion at the bottom), and
 *   - the partition rows cover all three of its failure modes — a code in the
 *     universe classified in neither list, a code classified in both, and a
 *     code classified in a list that has left the universe entirely.
 *
 * The identity-token rule is a biconditional, so it gets two rows: claiming the
 * `deliverable-tree/v1` token without its narration set, and declaring that
 * narration set under some other token. One row would leave half the rule
 * unenforced and the suite would not notice.
 */
import { describe, expect, it } from "vitest";
import { BlockedError, GATE_STRUCTURAL_FINDING_CODES, type Blocker } from "./blockers.ts";
import {
  CONFIG_FINDING_CODES,
  DEFAULT_BASE_REF,
  DEFAULT_STORAGE_NAMESPACE,
  DELIVERABLE_TREE_V1,
  DELIVERABLE_TREE_V1_NARRATION_SET,
  defineHarnessConfig,
  emittableFindingCodes,
  matchesNeutralSet,
  validateHarnessConfig,
  type HarnessConfig,
  type HarnessConfigInput,
} from "./config.ts";

/**
 * Every row below feeds `defineHarnessConfig` a value the authoring type would
 * reject — that is the point of the row — so the type is asserted at this one
 * seam rather than at each call site.
 */
const define = (input: unknown): HarnessConfig => defineHarnessConfig(input as HarnessConfigInput);

// ── The shared valid fixture ───────────────────────────────────────────────

/**
 * A structural code that is waivable, and one that is not, chosen by hand so
 * the partition rows below can move a *known* code across the boundary rather
 * than whichever code happens to sit first in the registry.
 */
const WAIVABLE_STRUCTURAL = [
  "review_evidence_missing",
  "stale_evidence",
  "evidence_not_green",
  "unresolved_actionable_findings",
] as const;

const NON_WAIVABLE_STRUCTURAL = [
  "ambiguous_records",
  "malformed_record",
  "unknown_provider",
  "live_provider_missing",
  "ambiguous_live_provider",
  "live_provider_failed",
  "resolution_not_allowed",
] as const;

const PROVIDER_CODE = "blocking-finding";

/**
 * The fixture enumerates the structural codes rather than deriving them from
 * `GATE_STRUCTURAL_FINDING_CODES`. Deriving them would make the fixture track
 * the registry silently, and the stale-entry row exists precisely to prove that
 * a registry change is *not* absorbed silently.
 */
const validInput = () => ({
  gateId: "example.pr-validation",
  baseRef: "origin/main",
  storageNamespace: "delivery-harness/",
  acceptedEnvelopeSpecs: ["delivery-evidence/1"],
  identityVersions: ["deliverable-tree/v1"],
  computingIdentityVersion: "deliverable-tree/v1",
  reviewNeutral: [
    { prefix: "docs/reports/" },
    { prefix: "docs/solutions/" },
    { prefix: "telemetry/delivery-runs/" },
  ],
  recordNeutral: [{ prefix: "docs/reports/" }],
  pathClassification: {
    generated: [{ kind: "prefix", value: "generated/" }],
    test: [{ kind: "glob", value: "**/*.test.ts" }],
    lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
  },
  sensitivePaths: [{ id: "auth", patterns: [{ kind: "prefix", value: "packages/auth/" }] }],
  activationThreshold: 25,
  providers: [{ id: "example.reviewer", findingCodes: [PROVIDER_CODE] }],
  agentEnvSignals: ["EXAMPLE_AGENT"],
  ciPolicies: [{ id: "example-ci", requiredEnv: [{ variable: "CI", equals: "true" }] }],
  ciPolicyEnvKey: "DELIVERY_HARNESS_CI_POLICY",
  preparationWiringPaths: ["harness.config.ts"],
  obligations: [
    {
      id: "review.green",
      activation: { kind: "relevant_change" },
      freshness: "exact_candidate",
      providers: ["example.reviewer"],
      acceptedPayloadSpecs: ["review.green/1"],
      allowedResolutionKinds: ["satisfied_evidence", "waived", "delegated", "not_applicable"],
      humanWaiverAllowed: true,
      minimumAttestationLevel: "self",
      ciDelegationPolicyIds: ["example-ci"],
      remediation: {
        default: [{ id: "run-review", kind: "command", command: ["npx", "review"], summary: "Run a review." }],
        byCode: {
          stale_evidence: [{ id: "re-review", kind: "manual_action", summary: "Re-run the review on the current candidate." }],
        },
      },
      waivableCodes: [...WAIVABLE_STRUCTURAL, PROVIDER_CODE],
      nonWaivableCodes: [...NON_WAIVABLE_STRUCTURAL],
    },
  ],
  deliveryRecordPath: "docs/reports/delivery-record.json",
  deliveryRecordVerification: { baseMovement: "stale" },
});

type MutableInput = ReturnType<typeof validInput>;

/**
 * Deep-clones the fixture and hands it to a mutation. The mutation sees an
 * untyped draft on purpose: most rows corrupt the fixture into a shape the
 * authoring type forbids, which is exactly the input the loader must reject.
 */
function withInput(mutate: (input: any) => void): unknown {
  const input = structuredClone(validInput());
  mutate(input);
  return input;
}

/** Codes observed anywhere in this file, for the coverage assertion at the end. */
const observedCodes = new Set<string>();

function blockersFor(input: unknown): readonly Blocker[] {
  const result = validateHarnessConfig(input);
  if (result.ok) return [];
  for (const blocker of result.blockers) observedCodes.add(blocker.code);
  return result.blockers;
}

function codesFor(input: unknown): string[] {
  return blockersFor(input).map((blocker) => blocker.code);
}

/** Asserts the named finding, and that the fixture is otherwise still sound. */
function expectOnly(input: unknown, code: string): readonly Blocker[] {
  const blockers = blockersFor(input);
  const codes = blockers.map((blocker) => blocker.code);
  expect(codes, `expected ${code}, got ${JSON.stringify(blockers, null, 2)}`).toContain(code);
  expect([...new Set(codes)], `expected only ${code}`).toEqual([code]);
  return blockers;
}

// ── Happy path ─────────────────────────────────────────────────────────────

describe("a sound config", () => {
  it("loads", () => {
    const result = validateHarnessConfig(validInput());
    expect(result.ok ? [] : result.blockers).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is returned frozen, with exactly the declared members", () => {
    const config = define(validInput());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.keys(config).sort()).toEqual(Object.keys(validInput()).sort());
  });

  it("defaults the three members that carry defaults, and nothing else", () => {
    const input = structuredClone(validInput()) as Partial<MutableInput>;
    delete input.baseRef;
    delete input.storageNamespace;
    delete input.deliveryRecordVerification;
    const config = define(input);
    expect(config.baseRef).toBe(DEFAULT_BASE_REF);
    expect(config.storageNamespace).toBe(DEFAULT_STORAGE_NAMESPACE);
    expect(config.deliveryRecordVerification).toEqual({ baseMovement: "stale" });
  });

  it("reports every other absent member rather than inventing one", () => {
    const input = structuredClone(validInput()) as Partial<MutableInput>;
    delete input.gateId;
    delete input.preparationWiringPaths;
    const codes = codesFor(input);
    expect(codes.filter((code) => code === "config_missing_member")).toHaveLength(2);
  });

  it("throws a BlockedError carrying every blocker when a config is unsound", () => {
    const broken = withInput((input) => {
      input.obligations = [];
      input.deliveryRecordPath = "src/not-neutral.json";
    });
    let thrown: unknown;
    try {
      define(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BlockedError);
    const blockers = (thrown as BlockedError).blockers;
    expect(blockers.length).toBeGreaterThanOrEqual(2);
    for (const blocker of blockers) {
      expect(blocker.source.kind).toBe("config");
      expect(blocker.remediations.length).toBeGreaterThan(0);
      observedCodes.add(blocker.code);
    }
  });
});

// ── Closed grammar ─────────────────────────────────────────────────────────

describe("the closed grammar", () => {
  it("rejects an unknown top-level member", () => {
    expectOnly(
      withInput((input) => {
        (input as Record<string, unknown>)["runRoot"] = "/tmp/harness";
      }),
      "config_unknown_member",
    );
  });

  it("rejects an unknown obligation member", () => {
    expectOnly(
      withInput((input) => {
        (input.obligations[0] as unknown as Record<string, unknown>)["autoApprove"] = true;
      }),
      "config_unknown_member",
    );
  });

  it("rejects an unknown member on a nested matcher", () => {
    expectOnly(
      withInput((input) => {
        (input.reviewNeutral[0] as Record<string, unknown>)["regex"] = "^docs/";
      }),
      "config_unknown_member",
    );
  });

  it("rejects a value outside a closed enumeration", () => {
    expectOnly(
      withInput((input) => {
        (input.obligations[0] as Record<string, unknown>)["freshness"] = "eventually";
      }),
      "config_invalid_member",
    );
  });

  it("rejects a member of the wrong type", () => {
    expectOnly(
      withInput((input) => {
        (input as Record<string, unknown>)["activationThreshold"] = "25";
      }),
      "config_invalid_member",
    );
  });

  it("rejects a malformed identifier", () => {
    expectOnly(
      withInput((input) => {
        input.providers[0]!.id = "Example Reviewer";
      }),
      "config_invalid_member",
    );
  });

  it("rejects an input that is not an object at all", () => {
    expect(codesFor(null)).toEqual(["config_invalid_member"]);
    expect(codesFor([])).toEqual(["config_invalid_member"]);
  });
});

// ── Unique ids ─────────────────────────────────────────────────────────────

describe("id uniqueness", () => {
  it("rejects duplicate obligation ids", () => {
    expectOnly(
      withInput((input) => {
        input.obligations.push(structuredClone(input.obligations[0]!));
      }),
      "config_duplicate_id",
    );
  });

  it("rejects duplicate provider ids", () => {
    expectOnly(
      withInput((input) => {
        input.providers.push({ id: "example.reviewer", findingCodes: [PROVIDER_CODE] });
      }),
      "config_duplicate_id",
    );
  });

  it("rejects duplicate CI policy ids", () => {
    expectOnly(
      withInput((input) => {
        input.ciPolicies.push({ id: "example-ci", requiredEnv: [{ variable: "OTHER", equals: "1" }] });
      }),
      "config_duplicate_id",
    );
  });

  it("rejects duplicate sensitive-path group ids", () => {
    expectOnly(
      withInput((input) => {
        input.sensitivePaths.push({ id: "auth", patterns: [{ kind: "prefix", value: "other/" }] });
      }),
      "config_duplicate_id",
    );
  });
});

// ── Dangling references ────────────────────────────────────────────────────

describe("dangling references", () => {
  it("rejects an obligation naming an unregistered provider", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.providers = ["example.reviewer", "ghost.provider"];
      }),
      "config_dangling_provider",
    );
  });

  it("rejects an obligation naming an undeclared CI policy", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.ciDelegationPolicyIds = ["ghost-ci"];
      }),
      "config_dangling_ci_policy",
    );
  });

  it("rejects an obligation that accepts no payload spec, because no claim can ever bind to it", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.acceptedPayloadSpecs = [];
      }),
      "config_dangling_payload_spec",
    );
  });
});

// ── The waiver biconditional ───────────────────────────────────────────────

describe("the waiver flag and the allowed resolution kinds", () => {
  it("rejects humanWaiverAllowed without the waived resolution kind", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.allowedResolutionKinds = ["satisfied_evidence", "delegated", "not_applicable"];
      }),
      "config_waiver_policy_mismatch",
    );
  });

  it("rejects the waived resolution kind without humanWaiverAllowed", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.humanWaiverAllowed = false;
      }),
      "config_waiver_policy_mismatch",
    );
  });
});

// ── Remediation catalogs ───────────────────────────────────────────────────

describe("remediation catalogs", () => {
  it("rejects an empty default catalog", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.remediation.default = [];
      }),
      "config_empty_remediation",
    );
  });

  it("rejects an empty per-code catalog", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.remediation.byCode = { stale_evidence: [] };
      }),
      "config_empty_remediation",
    );
  });

  it("rejects a per-code catalog keyed by a code the obligation cannot emit", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.remediation.byCode = {
          never_emitted: [{ id: "x", kind: "manual_action", summary: "Do something." }],
        };
      }),
      "config_stale_finding_code",
    );
  });
});

// ── The exact three-way partition ──────────────────────────────────────────

describe("the finding-code partition", () => {
  it("computes the emittable universe as the structural registry plus the obligation's providers", () => {
    const config = define(validInput());
    const universe = emittableFindingCodes(config, "review.green");
    expect([...universe].sort()).toEqual([...GATE_STRUCTURAL_FINDING_CODES, PROVIDER_CODE].sort());
  });

  it("rejects a code in the universe that neither list classifies", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.waivableCodes = (input.obligations[0]!.waivableCodes as string[]).filter(
          (code: string) => code !== "stale_evidence",
        );
      }),
      "config_unclassified_finding_code",
    );
  });

  it("rejects a code both lists classify", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.nonWaivableCodes = [...input.obligations[0]!.nonWaivableCodes, "stale_evidence"];
      }),
      "config_double_classified_finding_code",
    );
  });

  it("rejects a classified code that has left the universe — a stale entry after a provider is removed", () => {
    expectOnly(
      withInput((input) => {
        // The provider stays registered repo-wide; the obligation stops using
        // it, so its code is no longer emittable for this obligation.
        input.obligations[0]!.providers = [];
      }),
      "config_stale_finding_code",
    );
  });

  it("rejects a classified code that was never in any universe", () => {
    expectOnly(
      withInput((input) => {
        input.obligations[0]!.nonWaivableCodes = [...input.obligations[0]!.nonWaivableCodes, "invented-code"];
      }),
      "config_stale_finding_code",
    );
  });
});

// ── Neutral sets ───────────────────────────────────────────────────────────

describe("the two neutral sets", () => {
  it("rejects a record-neutral matcher outside the review-neutral set", () => {
    expectOnly(
      withInput((input) => {
        // The record path keeps a covered matcher, so this row falsifies the
        // subset rule alone rather than the double-neutrality rule with it.
        input.recordNeutral = [{ prefix: "docs/reports/" }, { prefix: "delivery/records/" }];
      }),
      "config_record_neutral_not_subset",
    );
  });

  it("accepts a record-neutral matcher narrower than a review-neutral one", () => {
    const result = validateHarnessConfig(
      withInput((input) => {
        input.recordNeutral = [{ prefix: "docs/reports/records/" }];
        input.deliveryRecordPath = "docs/reports/records/delivery-record.json";
      }),
    );
    expect(result.ok ? [] : result.blockers).toEqual([]);
  });

  it("rejects a delivery-record path that is review-neutral but not record-neutral", () => {
    expectOnly(
      withInput((input) => {
        // docs/solutions/ is review-neutral (so it leaves the identity alone)
        // but not record-neutral, which is the load-bearing half of the rule.
        input.deliveryRecordPath = "docs/solutions/delivery-record.json";
      }),
      "config_delivery_record_not_neutral",
    );
  });

  it("rejects a delivery-record path neutral to neither set", () => {
    expectOnly(
      withInput((input) => {
        input.deliveryRecordPath = "packages/kernel/delivery-record.json";
      }),
      "config_delivery_record_not_neutral",
    );
  });
});

// ── Identity ───────────────────────────────────────────────────────────────

describe("identity versions", () => {
  it("rejects a computing identity version the recorder does not accept", () => {
    expectOnly(
      withInput((input) => {
        // The review-neutral set moves off the v1 narration set at the same
        // time, so this row falsifies the membership rule alone: leaving the
        // narration set in place would also trip the token biconditional and
        // the row would stop naming one rule.
        input.computingIdentityVersion = "delivery-harness-tree/v1";
        input.reviewNeutral = [{ prefix: "docs/reports/" }, { prefix: "delivery/records/" }];
        input.recordNeutral = [{ prefix: "docs/reports/" }];
      }),
      "config_identity_version_not_accepted",
    );
  });

  it("rejects the deliverable-tree/v1 token under a review-neutral set that is not its narration set", () => {
    expectOnly(
      withInput((input) => {
        input.reviewNeutral = [...input.reviewNeutral, { prefix: "delivery/records/" }];
        input.recordNeutral = [{ prefix: "delivery/records/" }];
        input.deliveryRecordPath = "delivery/records/record.json";
      }),
      "config_identity_token_requires_v1_neutral_set",
    );
  });

  it("rejects the deliverable-tree/v1 narration set under some other identity token", () => {
    expectOnly(
      withInput((input) => {
        input.identityVersions = ["delivery-harness-tree/v1"];
        input.computingIdentityVersion = "delivery-harness-tree/v1";
      }),
      "config_v1_neutral_set_requires_v1_token",
    );
  });

  it("exports the narration set the v1 token is defined over", () => {
    expect([...DELIVERABLE_TREE_V1_NARRATION_SET]).toEqual([
      { prefix: "docs/reports/" },
      { prefix: "docs/solutions/" },
      { prefix: "telemetry/delivery-runs/" },
    ]);
    expect(DELIVERABLE_TREE_V1).toBe("deliverable-tree/v1");
  });
});

// ── Scope invariants ───────────────────────────────────────────────────────

describe("v1 scope", () => {
  it("rejects a gate with no obligations, because it would admit everything", () => {
    expectOnly(
      withInput((input) => {
        input.obligations = [];
      }),
      "config_no_obligations",
    );
  });

  it("rejects a minimum attestation level above self", () => {
    const blockers = expectOnly(
      withInput((input) => {
        input.obligations[0]!.minimumAttestationLevel = "provider-signed";
      }),
      "config_unsupported_attestation_level",
    );
    expect(blockers[0]!.summary.toLowerCase()).toContain("self");
  });
});

// ── Aggregation ────────────────────────────────────────────────────────────

describe("aggregation", () => {
  it("reports every violation in one result", () => {
    const codes = codesFor(
      withInput((input) => {
        input.obligations[0]!.humanWaiverAllowed = false;
        input.obligations[0]!.ciDelegationPolicyIds = ["ghost-ci"];
        input.obligations[0]!.remediation.default = [];
        input.deliveryRecordPath = "src/record.json";
        input.computingIdentityVersion = "deliverable-tree/v2";
      }),
    );
    expect(new Set(codes)).toEqual(
      new Set([
        "config_waiver_policy_mismatch",
        "config_dangling_ci_policy",
        "config_empty_remediation",
        "config_delivery_record_not_neutral",
        "config_identity_version_not_accepted",
        // The narration set is untouched while the token moves off v1, so the
        // biconditional's second direction fires here too.
        "config_v1_neutral_set_requires_v1_token",
      ]),
    );
  });

  it("reports every shape violation in one result", () => {
    const codes = codesFor(
      withInput((input) => {
        (input as Record<string, unknown>)["runRoot"] = "/tmp";
        (input as Record<string, unknown>)["activationThreshold"] = "25";
        delete (input as Partial<MutableInput>).gateId;
      }),
    );
    expect(new Set(codes)).toEqual(new Set(["config_unknown_member", "config_invalid_member", "config_missing_member"]));
  });
});

// ── The neutral matcher primitive ──────────────────────────────────────────

describe("matchesNeutralSet", () => {
  const set = [{ prefix: "docs/" }, { prefix: "telemetry/", suffix: ".json" }] as const;

  it("matches on a prefix", () => {
    expect(matchesNeutralSet(set, "docs/reports/x.md")).toBe(true);
  });

  it("respects the prefix boundary", () => {
    expect(matchesNeutralSet(set, "docs-internal/x.md")).toBe(false);
  });

  it("requires the suffix when one is declared", () => {
    expect(matchesNeutralSet(set, "telemetry/x.json")).toBe(true);
    expect(matchesNeutralSet(set, "telemetry/x.md")).toBe(false);
  });

  it("does not treat a backslash path as neutral", () => {
    expect(matchesNeutralSet(set, "docs\\reports\\x.md")).toBe(false);
  });
});

// ── Table completeness ─────────────────────────────────────────────────────

describe("the falsification table", () => {
  it("produces every finding code the loader declares", () => {
    const missing = CONFIG_FINDING_CODES.filter((code) => !observedCodes.has(code));
    expect(missing, `finding codes no row in this table produces: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares no finding code twice", () => {
    expect([...CONFIG_FINDING_CODES]).toEqual([...new Set(CONFIG_FINDING_CODES)]);
  });
});

// A compile-time check that the exported config type is what the readers see.
const _typeWitness: (config: HarnessConfig) => string = (config) => config.gateId;
void _typeWitness;
