/**
 * The delivery-record produce path and the pure verification core.
 *
 * Everything here is effect-free: records and decisions are constructed by hand,
 * so the suite is a decision table over the drift classes, the base-movement
 * policy, multi-record selection, and the produce/parse round-trip. The
 * git-bound end-to-end proof (a real record written and verified in a temp repo,
 * plus self-neutrality) lives in the CLI suite.
 */
import { describe, expect, it } from "vitest";
import { defineHarnessConfig, type HarnessConfig, type HarnessConfigInput } from "./config.ts";
import { RESOLUTION_OUTCOMES, type GateDecision, type ObligationResolution } from "./evaluator.ts";
import type { CandidateBinding } from "./candidate.types.ts";
import type { EvidenceRecord, RecordCandidateBinding } from "./records.types.ts";
import {
  DELIVERY_RECORD_VERSION,
  bindingOf,
  buildDeliveryRecord,
  deliveryRecordBytes,
  deliveryRecordPathFor,
  parseDeliveryRecord,
  selectDeliveryRecordForIdentity,
  DELIVERY_OWNED_TREE_PREFIXES,
  CLAUDE_SKILL_EXPOSURE_PREFIX,
  parseCandidateTreeListing,
  needsCommittedSymlinkTarget,
  RECEIPTED_SKILLS_ROOT,
  verifyDeliveryRecord,
  type DeliveryRecord,
} from "./delivery-record.ts";
import { PORTABLE_STAGE_GRANT } from "./policy/compile.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DIGEST = "a".repeat(64);
const TOKEN = "deliverable-tree/v1";
const V1_NEUTRAL = [
  { prefix: "docs/reports/" },
  { prefix: "docs/solutions/" },
  { prefix: "telemetry/delivery-runs/" },
] as const;

const STRUCTURAL_WAIVABLE = ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings"];
const STRUCTURAL_NONWAIVABLE = [
  "ambiguous_records",
  "malformed_record",
  "unknown_provider",
  "live_provider_missing",
  "ambiguous_live_provider",
  "live_provider_failed",
  "resolution_not_allowed",
];

function obligation(id: string): HarnessConfigInput["obligations"][number] {
  return {
    id,
    activation: { kind: "relevant_change" },
    freshness: "exact_candidate",
    providers: ["p.reviewer"],
    acceptedPayloadSpecs: ["review.green/1"],
    allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
    humanWaiverAllowed: true,
    minimumAttestationLevel: "self",
    ciDelegationPolicyIds: [],
    remediation: { default: [{ id: "fix-it", kind: "manual_action", summary: "Fix it." }] },
    waivableCodes: [...STRUCTURAL_WAIVABLE],
    nonWaivableCodes: [...STRUCTURAL_NONWAIVABLE],
  };
}

function makeConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "test.gate",
    baseRef: "origin/main",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: [TOKEN],
    computingIdentityVersion: TOKEN,
    reviewNeutral: [...V1_NEUTRAL],
    recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [],
    activationThreshold: 1,
    providers: [{ id: "p.reviewer", findingCodes: [] }],
    agentEnvSignals: ["CLAUDE_CODE"],
    ciPolicies: [],
    ciPolicyEnvKey: "DH_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [obligation("review.green")],
    deliveryRecordPath: "telemetry/delivery-runs/record.json",
    deliveryRecordVerification: { baseMovement: "stale" },
    ...overrides,
  });
}

const CANDIDATE: CandidateBinding = {
  treeSha: "t".repeat(40),
  deliverable: { digest: DIGEST, identity: TOKEN },
  base: { ref: "origin/main", tipSha: "b".repeat(40), mergeBaseSha: "m".repeat(40) },
  workspaceId: "w-source",
};

const RECORD_BINDING: RecordCandidateBinding = {
  treeSha: CANDIDATE.treeSha,
  deliverableDigest: DIGEST,
  identityToken: TOKEN,
  baseRef: "origin/main",
  baseTipSha: "b".repeat(40),
  mergeBaseSha: "m".repeat(40),
  workspaceId: "w-source",
};

function evidenceResolution(obligationId: string, recordId: string): ObligationResolution {
  return {
    gateId: "test.gate",
    obligationId,
    kind: "satisfied_evidence",
    providerId: "p.reviewer",
    recordId,
    runId: "run-1",
    finalPassId: "pass-2",
    candidateBinding: RECORD_BINDING,
  };
}

function evidenceRecord(obligationId: string, recordId: string, manifestDigest: string): EvidenceRecord {
  return {
    schemaVersion: 1,
    recordId,
    workspaceId: "w-source",
    gateId: "test.gate",
    obligationId,
    candidateBinding: RECORD_BINDING,
    resolution: { kind: "evidence", providerId: "p.reviewer", runId: "run-1", finalPassId: "pass-2", manifestDigest },
  };
}

function admittedDecision(resolutions: readonly ObligationResolution[]): GateDecision {
  return { gateId: "test.gate", candidate: CANDIDATE, admitted: true, resolutions, diagnostics: [], blockers: [] };
}

const RECOMPUTED = { deliverableDigest: DIGEST, identityToken: TOKEN };
const FRESH_BASE = { ref: "origin/main", tipSha: "b".repeat(40), mergeBaseSha: "m".repeat(40) };

function buildFreshRecord(): DeliveryRecord {
  const built = buildDeliveryRecord({
    config: makeConfig(),
    decision: admittedDecision([evidenceResolution("review.green", "rec-1")]),
    evidenceRecords: [evidenceRecord("review.green", "rec-1", "d".repeat(64))],
  });
  if (!built.ok) throw new Error("expected build to succeed");
  return built.record;
}

// ── bindingOf + path ─────────────────────────────────────────────────────────

describe("bindingOf", () => {
  it("flattens the evaluator candidate onto the record binding", () => {
    expect(bindingOf(CANDIDATE)).toEqual(RECORD_BINDING);
  });
});

describe("deliveryRecordPathFor", () => {
  it("splices the digest before the extension and stays under the configured prefix", () => {
    const config = makeConfig();
    const derived = deliveryRecordPathFor(config, DIGEST);
    expect(derived).toBe(`telemetry/delivery-runs/record--${DIGEST}.json`);
    // Neutral to both predicates, exactly like the configured path.
    expect(derived.startsWith("telemetry/delivery-runs/")).toBe(true);
    expect(derived.endsWith(".json")).toBe(true);
  });

  it("keys distinct deliverables to distinct files (merge-conflict-free)", () => {
    const config = makeConfig();
    expect(deliveryRecordPathFor(config, "a".repeat(64))).not.toBe(deliveryRecordPathFor(config, "b".repeat(64)));
  });
});

// ── build ────────────────────────────────────────────────────────────────────

describe("buildDeliveryRecord", () => {
  it("promotes an admitted decision, stamping evidence claims with their manifest digest", () => {
    const built = buildDeliveryRecord({
      config: makeConfig(),
      decision: admittedDecision([evidenceResolution("review.green", "rec-1")]),
      evidenceRecords: [evidenceRecord("review.green", "rec-1", "d".repeat(64))],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.record.version).toBe(DELIVERY_RECORD_VERSION);
    expect(built.record.gateId).toBe("test.gate");
    expect(built.record.attestation.level).toBe("self");
    expect(built.record.claims).toHaveLength(1);
    expect(built.record.claims[0]).toMatchObject({
      obligationId: "review.green",
      outcome: "satisfied_evidence",
      recordId: "rec-1",
      manifestDigest: "d".repeat(64),
    });
    expect(built.record.manifestDigest).toBe("d".repeat(64));
    expect(built.record.candidateBinding).toEqual(RECORD_BINDING);
  });

  it("refuses to build from a decision that did not admit", () => {
    const built = buildDeliveryRecord({
      config: makeConfig(),
      decision: { ...admittedDecision([]), admitted: false },
      evidenceRecords: [],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.blockers[0]?.source.kind).toBe("delivery-record");
  });

  it("refuses a decision carrying a blocked obligation", () => {
    const blocked: ObligationResolution = {
      gateId: "test.gate",
      obligationId: "review.green",
      kind: "blocked",
      blockers: [
        {
          code: "stale_evidence",
          source: { kind: "obligation", id: "review.green" },
          summary: "stale",
          remediations: [{ id: "fix", kind: "manual_action", summary: "fix" }],
        },
      ],
    };
    const built = buildDeliveryRecord({
      config: makeConfig(),
      decision: { ...admittedDecision([blocked]), admitted: false },
      evidenceRecords: [],
    });
    expect(built.ok).toBe(false);
  });
});

// ── bytes ────────────────────────────────────────────────────────────────────

describe("deliveryRecordBytes", () => {
  it("is deterministic and newline-terminated", () => {
    const record = buildFreshRecord();
    const first = deliveryRecordBytes(record);
    const second = deliveryRecordBytes(record);
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
  });

  it("round-trips through parseDeliveryRecord", () => {
    const record = buildFreshRecord();
    const parsed = parseDeliveryRecord(deliveryRecordBytes(record));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toEqual(record);
  });
});

// ── parse ────────────────────────────────────────────────────────────────────

describe("parseDeliveryRecord", () => {
  it("rejects non-JSON as a finding, never a skip", () => {
    const parsed = parseDeliveryRecord("{ not json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.blockers[0]?.source.kind).toBe("delivery-record");
  });

  it("rejects an unsupported version token", () => {
    const record = { ...buildFreshRecord(), version: "delivery-record/9" };
    const parsed = parseDeliveryRecord(`${JSON.stringify(record)}\n`);
    expect(parsed.ok).toBe(false);
  });

  it("rejects a structurally broken record", () => {
    const parsed = parseDeliveryRecord(JSON.stringify({ version: DELIVERY_RECORD_VERSION }));
    expect(parsed.ok).toBe(false);
  });

  // A committed record is operator-editable text. An outcome is not free-form
  // prose — it is the vocabulary the verifier reasons about — so a value outside
  // the resolution universe must be a malformed record rather than something the
  // verifier waves through because it merely "is a non-empty string".
  it("rejects an invented claim outcome", () => {
    const record = buildFreshRecord();
    const tampered = {
      ...record,
      claims: [{ ...record.claims[0], outcome: "rubber_stamped" }],
    };
    const parsed = parseDeliveryRecord(`${JSON.stringify(tampered)}\n`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.blockers[0]?.code).toBe("delivery_record_malformed");
  });

  it("accepts every outcome the evaluator can actually produce", () => {
    const record = buildFreshRecord();
    for (const outcome of RESOLUTION_OUTCOMES.filter((kind) => kind !== "blocked")) {
      const rewritten = { ...record, claims: [{ ...record.claims[0], outcome }] };
      const parsed = parseDeliveryRecord(`${JSON.stringify(rewritten)}\n`);
      expect(parsed.ok, `expected ${outcome} to parse`).toBe(true);
    }
  });
});

// ── verify (the drift table) ─────────────────────────────────────────────────

describe("verifyDeliveryRecord", () => {
  it("passes a fresh record", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(true);
    expect(check.blockers).toHaveLength(0);
    expect(check.attestationLabel).toContain("process discipline");
  });

  it("fails on a changed deliverable identity, naming the drift class", () => {
    const check = verifyDeliveryRecord(
      makeConfig(),
      buildFreshRecord(),
      { deliverableDigest: "c".repeat(64), identityToken: TOKEN },
      FRESH_BASE,
    );
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("deliverable_identity_changed");
  });

  it("independently rejects a candidate tree carrying a projection or discovery-configuration path", () => {
    for (const planted of [
      `${DELIVERY_OWNED_TREE_PREFIXES[0]}/workflows/delivery-v1.json`,
      `${DELIVERY_OWNED_TREE_PREFIXES[1]}/settings.json`,
    ]) {
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: ["src/index.ts", planted],
      });
      expect(check.ok, planted).toBe(false);
      expect(check.blockers.map((b) => b.code)).toContain("record_protected_authority_path");
    }
  });

  it("rejects a delivery-owned path aliased by case or committed as a bare symlink", () => {
    // Two shapes the in-run deny side already folds for: a case alias that
    // resolves to the protected path on a case-insensitive checkout, and the
    // prefix committed as a single entry (a symlink) with nothing under it.
    for (const planted of [".Claude/settings.json", ".MANAGED-PROJECTION/x.json", ".claude", ".managed-projection"]) {
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: [planted],
      });
      expect(check.ok, planted).toBe(false);
      expect(check.blockers.map((b) => b.code), planted).toContain("record_protected_authority_path");
    }
  });

  it("passes a candidate tree that merely NAMES a prefix without being inside it", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
      candidateTreePaths: ["src/managed-projection-notes.md", "docs/.claudette/readme.md", ".claudette", "a.claude/b"],
    });
    expect(check.ok, JSON.stringify(check.blockers)).toBe(true);
  });

  it("keeps its closed path set identical to the portable grant's delivery-owned protections", () => {
    // Two lists, one meaning: the grant protects them inside the run, the
    // external verifier rejects them in the committed tree. Drift between the
    // two would open exactly the gap this check exists to close.
    //
    // The membership is unchanged by the Claude skill-exposure exception below:
    // that exception admits ONE tree-verifiable shape inside `.claude/skills/`
    // and does not remove `.claude` from either list. The in-run grant still
    // protects the whole prefix, because inside a run the projection install
    // writes the exposure and the candidate never should.
    expect([...DELIVERY_OWNED_TREE_PREFIXES].sort()).toEqual(
      PORTABLE_STAGE_GRANT.protectedPaths.filter((path) => path !== ".git").slice().sort(),
    );
    // The exception's two anchors, pinned literally so a rename cannot widen it.
    expect(CLAUDE_SKILL_EXPOSURE_PREFIX).toBe(".claude/skills/");
    expect(RECEIPTED_SKILLS_ROOT).toBe(".agent-skills/current/skills/");
    expect(CLAUDE_SKILL_EXPOSURE_PREFIX.startsWith(`${DELIVERY_OWNED_TREE_PREFIXES[1]}/`)).toBe(true);
  });

  describe("the tracked Claude skill exposure", () => {
    // One narrow exception to the frozen `.claude` prefix: a committed entry
    // under `.claude/skills/` is admissible ONLY when it is a symlink (git mode
    // 120000) whose target, resolved relative to the entry's own directory,
    // lands inside `.agent-skills/current/skills/`. That is the exact shape the
    // product's own projection install writes, and it is decidable from the
    // committed tree alone — mode and blob, no filesystem read.

    it("admits a symlink resolving into the receipted generation's skills root", () => {
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: [
          "src/index.ts",
          { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/execute-work" },
          // A nested exposure resolves against its own directory, not the root.
          { path: ".claude/skills/vendor/plan-work", mode: "120000", symlinkTarget: "../../../.agent-skills/current/skills/plan-work" },
          // A target that walks back through the root it already reached still
          // lands inside it, and is the same admissible shape.
          { path: ".claude/skills/review-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/./review-work" },
        ],
      });
      expect(check.ok, JSON.stringify(check.blockers)).toBe(true);
    });

    it("rejects every other shape under .claude with the same blocker", () => {
      const rejected: readonly { readonly why: string; readonly entry: unknown }[] = [
        {
          why: "a regular file under .claude/skills/",
          entry: { path: ".claude/skills/execute-work/SKILL.md", mode: "100644" },
        },
        {
          why: "an executable regular file under .claude/skills/",
          entry: { path: ".claude/skills/run.sh", mode: "100755" },
        },
        {
          why: "a symlink resolving outside the receipted skills root",
          entry: { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/workflows/execute-work" },
        },
        {
          why: "a symlink resolving into the generation but above its skills root",
          entry: { path: ".claude/skills/current", mode: "120000", symlinkTarget: "../../.agent-skills/current" },
        },
        {
          why: "a symlink escaping the repository with ..",
          entry: { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "../../../.agent-skills/current/skills/execute-work" },
        },
        {
          why: "a symlink whose target traverses out of the skills root and back down a sibling",
          entry: { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/../../../secrets/x" },
        },
        {
          why: "a symlink to an absolute path",
          entry: { path: ".claude/skills/execute-work", mode: "120000", symlinkTarget: "/etc/agent-skills/current/skills/execute-work" },
        },
        {
          why: "a symlink to the skills root itself, naming nothing inside it",
          entry: { path: ".claude/skills/all", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/" },
        },
        {
          why: "a symlink with no target read from the tree",
          entry: { path: ".claude/skills/execute-work", mode: "120000" },
        },
        {
          why: "an entry under .claude outside skills/",
          entry: { path: ".claude/settings.json", mode: "100644" },
        },
        {
          why: "a symlink under .claude outside skills/, however it resolves",
          entry: { path: ".claude/hooks/pre", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/pre" },
        },
        {
          why: "the `.claude/skills` directory prefix committed as a single symlink",
          entry: { path: ".claude/skills", mode: "120000", symlinkTarget: "../.agent-skills/current/skills" },
        },
        {
          why: "a case alias of the exposure prefix, which is not the shape the install writes",
          entry: { path: ".Claude/Skills/execute-work", mode: "120000", symlinkTarget: "../../.agent-skills/current/skills/execute-work" },
        },
      ];
      for (const { why, entry } of rejected) {
        const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
          candidateTreePaths: ["src/index.ts", entry as never],
        });
        expect(check.ok, why).toBe(false);
        expect(check.blockers.map((blocker) => blocker.code), why).toContain("record_protected_authority_path");
      }
    });

    it("still rejects a bare path string under .claude/skills, which carries no mode to judge", () => {
      // The path form is what existing callers pass. It cannot witness a mode
      // or a target, so it can never reach the exception — fail-closed.
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: [".claude/skills/execute-work"],
      });
      expect(check.ok).toBe(false);
      expect(check.blockers.map((blocker) => blocker.code)).toContain("record_protected_authority_path");
    });

    it("reads mode, object and path out of a real ls-tree listing, and names the blobs it needs", () => {
      const listing = [
        "100644 blob 1111111111111111111111111111111111111111\tsrc/index.ts",
        "120000 blob 2222222222222222222222222222222222222222\t.claude/skills/execute-work",
        "100644 blob 3333333333333333333333333333333333333333\t.claude/settings.json",
        // A path with an embedded space and one with a tab in its content-side
        // name: NUL separation means neither is quoted, and the split is on the
        // FIRST tab, so the path is preserved verbatim.
        "120000 blob 4444444444444444444444444444444444444444\t.claude/skills/two words",
        "120000 blob 5555555555555555555555555555555555555555\tdocs/link",
      ].join("\u0000");
      const entries = parseCandidateTreeListing(listing);
      expect(entries.map((entry) => entry.path)).toEqual([
        "src/index.ts",
        ".claude/skills/execute-work",
        ".claude/settings.json",
        ".claude/skills/two words",
        "docs/link",
      ]);
      expect(entries[1]).toEqual({
        path: ".claude/skills/execute-work",
        mode: "120000",
        objectSha: "2222222222222222222222222222222222222222",
      });
      // Only the delivery-owned symlinks need a blob read: not the regular file
      // under `.claude`, whose verdict its mode already settles, and not the
      // symlink outside every delivery-owned prefix.
      expect(entries.filter(needsCommittedSymlinkTarget).map((entry) => entry.path)).toEqual([
        ".claude/skills/execute-work",
        ".claude/skills/two words",
      ]);
    });

    it("leaves entries outside the delivery-owned prefixes alone whatever their mode", () => {
      const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, FRESH_BASE, {
        candidateTreePaths: [
          { path: "node_modules-link", mode: "120000", symlinkTarget: "/anywhere/at/all" },
          { path: "docs/.claudette/readme.md", mode: "100644" },
        ],
      });
      expect(check.ok, JSON.stringify(check.blockers)).toBe(true);
    });
  });

  it("fails on an identity token the config does not accept", () => {
    const record = { ...buildFreshRecord(), candidateBinding: { ...RECORD_BINDING, identityToken: "other/v1" }, identityToken: "other/v1" };
    const check = verifyDeliveryRecord(makeConfig(), record, { deliverableDigest: DIGEST, identityToken: "other/v1" }, FRESH_BASE);
    expect(check.ok).toBe(false);
  });

  it("stales on base-tip movement under the default policy", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, { ...FRESH_BASE, tipSha: "z".repeat(40) });
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("base_tip_moved");
    expect(check.baseMovementRelaxed).toBe(false);
  });

  it("stales on merge-base movement", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, { ...FRESH_BASE, mergeBaseSha: "z".repeat(40) });
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("merge_base_moved");
  });

  it("stales on a base ref change", () => {
    const check = verifyDeliveryRecord(makeConfig(), buildFreshRecord(), RECOMPUTED, { ...FRESH_BASE, ref: "origin/release" });
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("base_ref_changed");
  });

  it("relaxes base movement under the allow policy and names the relaxation", () => {
    const config = makeConfig({ deliveryRecordVerification: { baseMovement: "allow" } });
    const check = verifyDeliveryRecord(config, buildFreshRecord(), RECOMPUTED, { ...FRESH_BASE, tipSha: "z".repeat(40) });
    expect(check.ok).toBe(true);
    expect(check.baseMovementRelaxed).toBe(true);
    expect(check.relaxedDriftClasses).toContain("base_tip_moved");
  });

  it("keeps identity mismatch fatal even under the allow policy", () => {
    const config = makeConfig({ deliveryRecordVerification: { baseMovement: "allow" } });
    const check = verifyDeliveryRecord(config, buildFreshRecord(), { deliverableDigest: "c".repeat(64), identityToken: TOKEN }, FRESH_BASE);
    expect(check.ok).toBe(false);
  });

  it("fails on a gate id mismatch", () => {
    const record = { ...buildFreshRecord(), gateId: "other.gate" };
    const check = verifyDeliveryRecord(makeConfig(), record, RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(false);
  });

  it("fails on a non-self attestation level", () => {
    const record = { ...buildFreshRecord(), attestation: { level: "provider-signed" as const } };
    const check = verifyDeliveryRecord(makeConfig(), record, RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(false);
  });

  it("fails when an obligation is uncovered by any claim", () => {
    const twoObligations = makeConfig({ obligations: [obligation("review.green"), obligation("second.check")] });
    const check = verifyDeliveryRecord(twoObligations, buildFreshRecord(), RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain("obligation_uncovered");
  });

  it("excludes workspaceId from verification (CI is a different workspace)", () => {
    const record = {
      ...buildFreshRecord(),
      workspaceId: "w-ci-checkout",
      candidateBinding: { ...RECORD_BINDING, workspaceId: "w-ci-checkout" },
    };
    const check = verifyDeliveryRecord(makeConfig(), record, RECOMPUTED, FRESH_BASE);
    expect(check.ok).toBe(true);
  });
});

// ── selection ────────────────────────────────────────────────────────────────

describe("selectDeliveryRecordForIdentity", () => {
  it("selects the one record whose binding matches the recomputed identity", () => {
    const match = buildFreshRecord();
    const foreign: DeliveryRecord = {
      ...match,
      candidateBinding: { ...RECORD_BINDING, deliverableDigest: "f".repeat(64) },
    };
    const selected = selectDeliveryRecordForIdentity(
      [
        { path: "telemetry/delivery-runs/record--foreign.json", record: foreign },
        { path: "telemetry/delivery-runs/record--match.json", record: match },
      ],
      RECOMPUTED,
    );
    expect(selected?.path).toBe("telemetry/delivery-runs/record--match.json");
  });

  it("returns nothing when only a foreign-candidate record is present", () => {
    const foreign: DeliveryRecord = {
      ...buildFreshRecord(),
      candidateBinding: { ...RECORD_BINDING, deliverableDigest: "f".repeat(64) },
    };
    const selected = selectDeliveryRecordForIdentity([{ path: "x.json", record: foreign }], RECOMPUTED);
    expect(selected).toBeUndefined();
  });
});
