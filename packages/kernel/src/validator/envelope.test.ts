/**
 * Envelope rules the conformance kit does not pin, and the differentials that
 * prove the ones it does pin are load-bearing.
 *
 * The kit is the acceptance suite; this file is the unit suite. It carries three
 * kinds of check the corpus cannot:
 *
 *   DIFFERENTIALS. A vector proves a manifest is rejected. It does not prove
 *   *which clause* rejected it, and a validator can pass a vector for the wrong
 *   reason. Where two manifests differ in exactly one member and only one is
 *   accepted, the clause under test is the only explanation. This is how the
 *   attestation rule is pinned: `self` with no signatures is accepted, and each
 *   single deviation from it is rejected on its own.
 *
 *   THE RESULT CONTRACT. Every rejection carries a registered code, a rule that
 *   registry maps that code to, and a pointer into the submission — checked
 *   over every rejection this file produces, not asserted once by hand.
 *
 *   THE SHAPE OF A TOTAL FUNCTION. Values no vector contains — a manifest that
 *   is not an object, an array where an object belongs — must produce a verdict
 *   rather than an exception.
 */
import { describe, expect, it } from "vitest";
import { defineHarnessConfig, type HarnessConfig, type HarnessConfigInput } from "../config.ts";
import { MANIFEST_REJECTION_REGISTRY, isManifestRejectionCode, type ManifestRejection } from "./codes.ts";
import { validateManifest, type ManifestValidationContext } from "./envelope.ts";

// ── A repository configuration, independent of the kit's ───────────────────

const CONFIG_INPUT: HarnessConfigInput = {
  gateId: "unit.gate",
  acceptedEnvelopeSpecs: ["delivery-evidence/1"],
  identityVersions: ["deliverable-tree/v1"],
  computingIdentityVersion: "deliverable-tree/v1",
  reviewNeutral: [{ prefix: "docs/reports/" }, { prefix: "docs/solutions/" }, { prefix: "telemetry/delivery-runs/" }],
  recordNeutral: [{ prefix: "docs/reports/" }],
  pathClassification: {
    generated: [{ kind: "prefix", value: "generated/" }],
    test: [{ kind: "glob", value: "**/*.test.ts" }],
    lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
  },
  sensitivePaths: [],
  activationThreshold: 1,
  providers: [{ id: "unit.provider", findingCodes: [] }],
  agentEnvSignals: [],
  ciPolicies: [],
  ciPolicyEnvKey: "UNIT_CI_POLICY",
  preparationWiringPaths: ["harness.config.ts"],
  obligations: [
    {
      id: "review.green",
      activation: { kind: "always" },
      freshness: "exact_candidate",
      providers: ["unit.provider"],
      acceptedPayloadSpecs: ["review.green/1"],
      allowedResolutionKinds: ["satisfied_evidence"],
      humanWaiverAllowed: false,
      minimumAttestationLevel: "self",
      ciDelegationPolicyIds: [],
      remediation: { default: [{ id: "submit", kind: "manual_action", summary: "Submit evidence." }] },
      waivableCodes: [],
      nonWaivableCodes: [
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
      ],
    },
  ],
  deliveryRecordPath: "docs/reports/delivery-record.json",
};

const config: HarnessConfig = defineHarnessConfig(CONFIG_INPUT);

// ── A manifest that passes, and one knob per rule ──────────────────────────

const TREE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TIP = "3".repeat(40);
const MERGE_BASE = "4".repeat(40);
const EARLIER_TREE = "5".repeat(40);
const DIGEST = "a".repeat(64);
const ARTIFACT_DIGEST = "b".repeat(64);

const CANDIDATE = {
  vcs: "git",
  treeSha: TREE,
  headSha: HEAD,
  deliverable: { digest: DIGEST, identity: "deliverable-tree/v1" },
  base: { ref: "origin/main", tipSha: TIP, mergeBaseSha: MERGE_BASE },
  workspaceId: "w-unit",
};

const APPROVAL = JSON.stringify({
  schemaVersion: 1,
  reviewerId: "solo",
  result: "approved",
  provider: { id: "unit.provider", runId: "r-1", finalPassId: "pass-2" },
  workspaceId: "w-unit",
  candidate: CANDIDATE,
});

function manifest(): Record<string, unknown> {
  return structuredClone({
    spec: "delivery-evidence/1",
    provider: { id: "unit.provider", version: "1.0.0", runId: "r-1", finalPassId: "pass-2" },
    candidate: CANDIDATE,
    repository: null,
    runHistory: [
      { preparedTreeSha: EARLIER_TREE, evaluatedInPassId: "pass-1" },
      { preparedTreeSha: TREE, evaluatedInPassId: "pass-2" },
    ],
    artifacts: [{ path: "reviewers/solo.json", sha256: ARTIFACT_DIGEST, role: "reviewer-approval" }],
    attestation: { level: "self", signatures: [] },
    recordedAt: "2026-08-25T00:00:00Z",
    claims: [
      {
        obligation: "review.green",
        payloadSpec: "review.green/1",
        payload: {
          verdict: "green",
          finalized: true,
          editedAfterFinalPass: false,
          reviewers: { selected: ["solo"], completed: ["solo"], failed: [], timedOut: [] },
          findings: [],
          telemetry: { iterationCount: 2, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, deferredExpansionCount: 0, deferredIssueIds: [] },
        },
      },
    ],
  });
}

function context(overrides: Partial<ManifestValidationContext> = {}): ManifestValidationContext {
  return {
    config,
    currentCandidate: structuredClone(CANDIDATE),
    prepared: true,
    artifactContents: new Map([["reviewers/solo.json", APPROVAL]]),
    ...overrides,
  };
}

function codesFor(submitted: unknown, overrides: Partial<ManifestValidationContext> = {}): readonly string[] {
  const result = validateManifest(submitted, context(overrides));
  return result.ok ? [] : result.rejections.map((rejection) => rejection.code);
}

function rejectionsFor(submitted: unknown, overrides: Partial<ManifestValidationContext> = {}): readonly ManifestRejection[] {
  const result = validateManifest(submitted, context(overrides));
  return result.ok ? [] : result.rejections;
}

// ── The baseline ───────────────────────────────────────────────────────────

describe("a conforming manifest", () => {
  it("is accepted, and the validated value is handed back", () => {
    const submitted = manifest();
    const result = validateManifest(submitted, context());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.provider.runId).toBe("r-1");
  });
});

// ── The result contract ────────────────────────────────────────────────────

describe("every rejection", () => {
  it("carries a registered code, a rule that code is registered against, and a pointer", () => {
    const broken = manifest();
    broken["spec"] = "delivery-evidence/0";
    (broken["provider"] as Record<string, unknown>)["runId"] = "../escape";
    delete (broken["candidate"] as Record<string, unknown>)["deliverable"];
    broken["stowaway"] = true;

    const rejections = rejectionsFor(broken);
    expect(rejections.length).toBeGreaterThan(3);
    for (const rejection of rejections) {
      expect(isManifestRejectionCode(rejection.code)).toBe(true);
      expect(MANIFEST_REJECTION_REGISTRY[rejection.code].rules).toContain(rejection.rule);
      expect(rejection.pointer.startsWith("/") || rejection.pointer === "").toBe(true);
      expect(rejection.message.length).toBeGreaterThan(0);
    }
  });

  it("is reported together with every other one, not just the first", () => {
    // An envelope rule and a payload rule violated at once produce both codes:
    // the two halves of the validator do not short-circuit each other.
    const broken = manifest();
    (broken["attestation"] as Record<string, unknown>)["signatures"] = [{ signer: "x" }];
    const payload = (broken["claims"] as Record<string, unknown>[])[0]?.["payload"] as Record<string, unknown>;
    payload["verdict"] = "not_green";

    expect(codesFor(broken)).toEqual(expect.arrayContaining(["unsupported_attestation", "verdict_not_green"]));
  });
});

// ── Totality ───────────────────────────────────────────────────────────────

describe("values no vector contains", () => {
  it("produce a verdict rather than an exception", () => {
    for (const submitted of [null, undefined, 7, "manifest", [], [{ spec: "delivery-evidence/1" }]]) {
      const result = validateManifest(submitted, context());
      expect(result.ok).toBe(false);
    }
  });

  it("include an envelope member of the wrong shape", () => {
    const broken = manifest();
    broken["runHistory"] = { preparedTreeSha: TREE };
    broken["artifacts"] = "none";
    broken["claims"] = {};
    expect(codesFor(broken)).toEqual(expect.arrayContaining(["malformed_field"]));
  });
});

// ── Attestation, pinned by differential ────────────────────────────────────

describe("attestation", () => {
  it("accepts level self with no signatures", () => {
    expect(codesFor(manifest())).toEqual([]);
  });

  it("rejects a defined level above self even with an empty signature array", () => {
    // The falsification target: a validator that only checked signatures would
    // accept this, and level-self evidence would be laundered as signed.
    const submitted = manifest();
    submitted["attestation"] = { level: "provider-signed", signatures: [] };
    expect(codesFor(submitted)).toEqual(expect.arrayContaining(["unsupported_attestation", "repository_required"]));
  });

  it("rejects a defined level above self even when the repository is named", () => {
    const submitted = manifest();
    submitted["attestation"] = { level: "independently-verified", signatures: [] };
    submitted["repository"] = "https://example.invalid/repo";
    const codes = codesFor(submitted);
    expect(codes).toContain("unsupported_attestation");
    expect(codes).not.toContain("repository_required");
  });

  it("rejects a signature it cannot verify at level self", () => {
    const submitted = manifest();
    submitted["attestation"] = { level: "self", signatures: [{ signer: "x" }] };
    expect(codesFor(submitted)).toEqual(["unsupported_attestation"]);
  });

  it("does not require a repository at level self", () => {
    const submitted = manifest();
    submitted["repository"] = null;
    expect(codesFor(submitted)).toEqual([]);
  });
});

// ── Closed grammar ─────────────────────────────────────────────────────────

describe("the closed grammar", () => {
  it("rejects an unknown member wherever it appears", () => {
    for (const plant of [
      (m: Record<string, unknown>) => {
        m["vendorExtension"] = 1;
      },
      (m: Record<string, unknown>) => {
        (m["provider"] as Record<string, unknown>)["team"] = "x";
      },
      (m: Record<string, unknown>) => {
        (m["candidate"] as Record<string, unknown>)["branch"] = "x";
      },
      (m: Record<string, unknown>) => {
        ((m["runHistory"] as Record<string, unknown>[])[0] as Record<string, unknown>)["startedAt"] = "x";
      },
      (m: Record<string, unknown>) => {
        ((m["artifacts"] as Record<string, unknown>[])[0] as Record<string, unknown>)["mediaType"] = "x";
      },
      (m: Record<string, unknown>) => {
        ((m["claims"] as Record<string, unknown>[])[0] as Record<string, unknown>)["passId"] = "x";
      },
    ]) {
      const submitted = manifest();
      plant(submitted);
      expect(codesFor(submitted)).toContain("unknown_member");
    }
  });

  it("rejects a manifest missing a required member", () => {
    const submitted = manifest();
    delete submitted["recordedAt"];
    expect(codesFor(submitted)).toContain("malformed_field");
  });
});

// ── Binding rules the kit exercises only through one shape ─────────────────

describe("the candidate binding", () => {
  it("is compared on every field, including an informational head that moved", () => {
    const moved = { ...structuredClone(CANDIDATE), headSha: "9".repeat(40) };
    expect(codesFor(manifest(), { currentCandidate: moved })).toEqual(["candidate_mismatch"]);
  });

  it("rejects an unprepared workspace whatever else is true", () => {
    expect(codesFor(manifest(), { prepared: false })).toEqual(["candidate_unprepared"]);
  });
});

describe("the run history", () => {
  it("accepts a single-pass run whose only entry is the candidate", () => {
    const submitted = manifest();
    submitted["runHistory"] = [{ preparedTreeSha: TREE, evaluatedInPassId: "pass-2" }];
    const payload = (submitted["claims"] as Record<string, unknown>[])[0]?.["payload"] as Record<string, unknown>;
    (payload["telemetry"] as Record<string, unknown>)["iterationCount"] = 1;
    expect(codesFor(submitted)).toEqual([]);
  });

  it("rejects a final entry that names an earlier tree, an earlier pass, or nothing at all", () => {
    const earlierTree = manifest();
    earlierTree["runHistory"] = [{ preparedTreeSha: EARLIER_TREE, evaluatedInPassId: "pass-2" }];
    const earlierPass = manifest();
    earlierPass["runHistory"] = [{ preparedTreeSha: TREE, evaluatedInPassId: "pass-1" }];
    const empty = manifest();
    empty["runHistory"] = [];

    for (const submitted of [earlierTree, earlierPass, empty]) {
      expect(codesFor(submitted)).toContain("run_history_final_mismatch");
    }
  });
});

describe("the artifact pool", () => {
  it("rejects absolute, traversing, and backslash-traversing paths alike", () => {
    for (const declared of ["/etc/passwd", "../outside.json", "reviewers/../../outside.json", "..\\outside.json", "C:\\outside.json"]) {
      const submitted = manifest();
      (submitted["artifacts"] as Record<string, unknown>[])[0]!["path"] = declared;
      expect(codesFor(submitted), declared).toContain("artifact_path_invalid");
    }
  });

  it("accepts a nested path that stays inside the run root", () => {
    const submitted = manifest();
    (submitted["artifacts"] as Record<string, unknown>[])[0]!["path"] = "reviewers/nested/solo.json";
    expect(codesFor(submitted, { artifactContents: new Map([["reviewers/nested/solo.json", APPROVAL]]) })).toEqual([]);
  });
});

describe("claims", () => {
  it("rejects a payload spec the validator does not implement even when configuration accepts it", () => {
    // Fail closed: accepting a payload no rule has ever read would admit
    // unvalidated evidence on the strength of a configuration edit alone.
    const widened = defineHarnessConfig({
      ...CONFIG_INPUT,
      obligations: CONFIG_INPUT.obligations.map((obligation) => ({
        ...obligation,
        acceptedPayloadSpecs: [...obligation.acceptedPayloadSpecs, "review.green/2"],
      })),
    });
    const submitted = manifest();
    (submitted["claims"] as Record<string, unknown>[])[0]!["payloadSpec"] = "review.green/2";
    expect(codesFor(submitted, { config: widened })).toContain("unsupported_payload_spec");
  });

  it("does not judge provider registration for an obligation the repository has not configured", () => {
    const submitted = manifest();
    (submitted["claims"] as Record<string, unknown>[])[0]!["obligation"] = "qa.exercised";
    const codes = codesFor(submitted);
    expect(codes).toContain("obligation_not_configured");
    expect(codes).not.toContain("unregistered_provider");
  });
});
