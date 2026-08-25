/**
 * Generator for the delivery-evidence/1 conformance kit.
 *
 * Emits golden vectors derived from Athena's production recorder test corpus
 * (scripts/harness-review-evidence.test.ts), restated against the
 * delivery-evidence/1 envelope. Run with: bun generate.ts <outDir>
 *
 * Every vector is self-contained: environment overrides, artifact file
 * contents (exact bytes), the manifest, and the expected outcome. Accept
 * vectors carry correct artifact digests, computed here; digest-mismatch
 * vectors carry deliberately wrong ones.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? "kit-out";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const oid = (label: string) => sha256(`oid:${label}`).slice(0, 40);
const digest64 = (label: string) => sha256(`digest:${label}`);

// ── Shared context ─────────────────────────────────────────────────────────

const PROVIDER = "claude-code.ce-code-review";
const OBLIGATION = "review.green";
const PAYLOAD_SPEC = "review.green/1";
const IDENTITY = "deliverable-tree/v1";
const WORKSPACE = "w-" + sha256("workspace-a").slice(0, 16);

const CANDIDATE = {
  vcs: "git",
  treeSha: oid("tree-final"),
  headSha: oid("head-final"),
  deliverable: { digest: digest64("deliverable-final"), identity: IDENTITY },
  base: {
    ref: "origin/main",
    tipSha: oid("base-tip"),
    mergeBaseSha: oid("merge-base"),
  },
  workspaceId: WORKSPACE,
};

const REPO_CONFIG = {
  configVersion: 1,
  gateId: "example.pr-validation",
  acceptedEnvelopeSpecs: ["delivery-evidence/1"],
  identityVersions: [IDENTITY],
  obligations: {
    [OBLIGATION]: {
      acceptedPayloadSpecs: [PAYLOAD_SPEC],
      providers: [PROVIDER, "example.second-provider"],
      minimumAttestationLevel: "self",
    },
  },
};

const ENVIRONMENT = {
  environmentVersion: 1,
  description:
    "State the validator harness must establish before running a vector. " +
    "currentCandidate is what the recorder's candidate capture returns at " +
    "submission; prepared=false simulates a missing/failed preparation. The " +
    "harness materializes each vector's artifact contents (exact bytes) " +
    "inside the run root it allocates for provider.runId, and places the " +
    "manifest at that run root unless the vector overrides manifestLocation.",
  currentCandidate: CANDIDATE,
  workspaceId: WORKSPACE,
  prepared: true,
};

// ── Builders ───────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function approval(reviewerId: string, over: Json = {}): string {
  const doc = {
    schemaVersion: 1,
    reviewerId,
    result: "approved",
    provider: { id: PROVIDER, runId: "r-conformance-01", finalPassId: "pass-2" },
    workspaceId: WORKSPACE,
    candidate: CANDIDATE,
    ...over,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

function baseArtifacts(reviewers: string[]): {
  files: Record<string, string>;
  entries: Array<{ path: string; sha256: string; role: string }>;
} {
  const files: Record<string, string> = {};
  const entries = reviewers.map((r) => {
    const p = `reviewers/${r}.json`;
    files[p] = approval(r);
    return { path: p, sha256: sha256(files[p]), role: "reviewer-approval" };
  });
  return { files, entries };
}

function baseManifest(over: {
  reviewers?: string[];
  findings?: Json[];
  telemetry?: Json;
  runHistory?: Json[];
  claims?: Json[];
  envelope?: Json;
  payload?: Json;
  artifactEntries?: Array<{ path: string; sha256: string; role: string }>;
} = {}): { manifest: Json; files: Record<string, string> } {
  const reviewers = over.reviewers ?? ["correctness", "security", "tests"];
  const { files, entries } = baseArtifacts(reviewers);
  const findings = over.findings ?? [];
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 } as Record<string, number>;
  for (const f of findings) counts[f.severity as string] += 1;
  const deferred = findings.filter((f) => f.disposition === "deferred");
  const runHistory =
    over.runHistory ??
    [
      { preparedTreeSha: oid("tree-pass-1"), evaluatedInPassId: "pass-1" },
      { preparedTreeSha: CANDIDATE.treeSha, evaluatedInPassId: "pass-2" },
    ];
  const payload = {
    verdict: "green",
    finalized: true,
    editedAfterFinalPass: false,
    reviewers: {
      selected: reviewers,
      completed: [...reviewers],
      failed: [],
      timedOut: [],
    },
    findings,
    telemetry: {
      iterationCount: runHistory.length,
      findingCounts: counts,
      deferredExpansionCount: deferred.length,
      deferredIssueIds: deferred.map((f) => f.deferredIssueId).sort(),
      ...((over.telemetry as Json) ?? {}),
    },
    ...(over.payload ?? {}),
  };
  const manifest: Json = {
    spec: "delivery-evidence/1",
    provider: {
      id: PROVIDER,
      version: "1.0.0",
      runId: "r-conformance-01",
      finalPassId: "pass-2",
    },
    candidate: CANDIDATE,
    repository: null,
    runHistory,
    artifacts: over.artifactEntries ?? entries,
    attestation: { level: "self", signatures: [] },
    recordedAt: "2026-08-25T00:00:00Z",
    claims: over.claims ?? [
      { obligation: OBLIGATION, payloadSpec: PAYLOAD_SPEC, payload },
    ],
    ...(over.envelope ?? {}),
  };
  return { manifest, files };
}

const DEFERRED_OK = {
  id: "f-def-1",
  severity: "P2",
  scope: "expansion",
  actionable: true,
  blocking: false,
  disposition: "deferred",
  deferredIssueId: "EX-1300",
};

// ── Vector table ───────────────────────────────────────────────────────────

type Vector = {
  id: string;
  title: string;
  rules: string[];
  expect:
    | { result: "accepted"; notes?: string }
    | { result: "rejected"; codes: string[] };
  provenance: string;
  environment?: Json;
  build: () => { manifest: Json; files: Record<string, string>; extra?: Json };
};

const ATHENA = "athena:scripts/harness-review-evidence.test.ts";
const SPEC = "delivery-evidence/1 (new in spec; no Athena antecedent)";
const TIGHTENED = "delivery-evidence/1 (spec-tightened; Athena accepted a looser form)";

const vectors: Vector[] = [
  // ---- accepts ----
  {
    id: "a-minimal-green",
    title: "Minimal green manifest with one reviewer",
    rules: ["GEN-2", "ENV-9", "RG-1"],
    expect: { result: "accepted" },
    provenance: `${ATHENA} "records the same final-green contract"`,
    build: () => baseManifest({ reviewers: ["correctness"] }),
  },
  {
    id: "a-three-reviewers",
    title: "Green manifest with a three-reviewer set",
    rules: ["RG-2", "RG-3", "RG-4"],
    expect: { result: "accepted" },
    provenance: `${ATHENA} fixture shape`,
    build: () => baseManifest(),
  },
  {
    id: "a-completed-order-differs",
    title: "completed lists the same reviewers in a different order",
    rules: ["RG-3"],
    expect: { result: "accepted", notes: "Set equality, not sequence equality." },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      const p = (b.manifest.claims as Json[])[0].payload as Json;
      (p.reviewers as Json).completed = ["tests", "correctness", "security"];
      return b;
    },
  },
  {
    id: "a-deferred-expansion",
    title: "Deferred P2 expansion finding with a tracker id and matching telemetry",
    rules: ["RG-7", "RG-8"],
    expect: { result: "accepted" },
    provenance: `${ATHENA} "records a deferred expansion finding"`,
    build: () => baseManifest({ findings: [DEFERRED_OK] }),
  },
  {
    id: "a-resolved-and-advisory",
    title: "Resolved P1 and advisory non-actionable finding",
    rules: ["RG-5", "RG-6"],
    expect: { result: "accepted" },
    provenance: `${ATHENA} disposition enum`,
    build: () =>
      baseManifest({
        findings: [
          { id: "f-1", severity: "P1", scope: "in_contract", actionable: true, blocking: false, disposition: "resolved" },
          { id: "f-2", severity: "P3", scope: "adjacent", actionable: false, blocking: false, disposition: "advisory" },
        ],
      }),
  },
  {
    id: "a-cost-tokens",
    title: "Self-reported token cost with per-reviewer breakdown summing below total",
    rules: ["RG-10"],
    expect: { result: "accepted" },
    provenance: `${ATHENA} "records a self-reported review cost"`,
    build: () =>
      baseManifest({
        telemetry: {
          cost: { unit: "tokens", total: 512345, reportedBy: "claude-code", byReviewer: { correctness: 190000, security: 150000 } },
        },
      }),
  },
  {
    id: "a-cost-fractional",
    title: "Fractional cost units from a platform's own metering",
    rules: ["RG-10"],
    expect: { result: "accepted" },
    provenance: `${ATHENA} "platform metering fractional units"`,
    build: () =>
      baseManifest({
        telemetry: { cost: { unit: "credits", total: 12.5, reportedBy: "some-other-runtime" } },
      }),
  },
  {
    id: "a-idempotent-resubmission",
    title: "Identical resubmission is an idempotent success with the same record ids",
    rules: ["SUB-4"],
    expect: {
      result: "accepted",
      notes: "Submit twice; both succeed and record ids are identical across submissions.",
    },
    provenance: `${ATHENA} "is idempotent for the same provider run, pass, and candidate"`,
    build: () => ({ ...baseManifest(), extra: { submitTwice: true } }),
  },

  // ---- GEN ----
  {
    id: "gen-1-unknown-envelope-member",
    title: "Unknown member at the envelope root",
    rules: ["GEN-1"],
    expect: { result: "rejected", codes: ["unknown_member"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      b.manifest.vendorExtension = { anything: true };
      return b;
    },
  },
  {
    id: "gen-1-legacy-count-field",
    title: "Legacy summary-count field from the pre-spec contract",
    rules: ["GEN-1"],
    expect: { result: "rejected", codes: ["unknown_member"] },
    provenance: `${ATHENA} unresolvedActionableCount (field removed by spec; presence is now unknown_member)`,
    build: () => {
      const b = baseManifest();
      const p = (b.manifest.claims as Json[])[0].payload as Json;
      p.unresolvedActionableCount = 0;
      return b;
    },
  },
  {
    id: "gen-2-unsupported-spec",
    title: "Unsupported envelope spec version",
    rules: ["GEN-2"],
    expect: { result: "rejected", codes: ["unsupported_envelope_spec"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      b.manifest.spec = "delivery-evidence/0";
      return b;
    },
  },

  // ---- ENV ----
  {
    id: "env-1-unregistered-provider",
    title: "Provider not registered for the claimed obligation",
    rules: ["ENV-1"],
    expect: { result: "rejected", codes: ["unregistered_provider"] },
    provenance: `${ATHENA} provider allowlist`,
    build: () => {
      const b = baseManifest();
      (b.manifest.provider as Json).id = "unknown.provider";
      return b;
    },
  },
  ...["../run-a", "nested/run-a", "nested\\run-a", ".", ".."].map(
    (runId, i): Vector => ({
      id: `env-2-run-id-${i + 1}`,
      title: `Unsafe or non-single-component run id ${JSON.stringify(runId)}`,
      rules: ["ENV-2"],
      expect: { result: "rejected", codes: ["invalid_run_id"] },
      provenance: `${ATHENA} "rejects unsafe or non-single-component run ID"`,
      build: () => {
        const b = baseManifest();
        (b.manifest.provider as Json).runId = runId;
        return b;
      },
    }),
  ),
  {
    id: "env-4-unsupported-vcs",
    title: "Non-git vcs value",
    rules: ["ENV-4"],
    expect: { result: "rejected", codes: ["unsupported_vcs"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      (b.manifest.candidate as Json) = { ...CANDIDATE, vcs: "hg" };
      return b;
    },
  },
  {
    id: "env-5-malformed-object-id",
    title: "treeSha that is not a 40-hex git object id",
    rules: ["ENV-5"],
    expect: { result: "rejected", codes: ["invalid_object_id"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      (b.manifest.candidate as Json) = { ...CANDIDATE, treeSha: "tree-a" };
      return b;
    },
  },
  {
    id: "env-6-unknown-identity-version",
    title: "Unknown deliverable identity version fails closed",
    rules: ["ENV-6"],
    expect: { result: "rejected", codes: ["unsupported_identity_version"] },
    provenance: `${ATHENA} "an unknown identity version"`,
    build: () => {
      const b = baseManifest();
      (b.manifest.candidate as Json) = {
        ...CANDIDATE,
        deliverable: { digest: CANDIDATE.deliverable.digest, identity: "deliverable-tree/v0" },
      };
      return b;
    },
  },
  {
    id: "env-6-missing-identity",
    title: "Candidate missing the deliverable identity block",
    rules: ["ENV-6", "GEN-4"],
    expect: { result: "rejected", codes: ["malformed_field"] },
    provenance: `${ATHENA} "a missing deliverable identity"`,
    build: () => {
      const b = baseManifest();
      const c = { ...CANDIDATE } as Json;
      delete c.deliverable;
      b.manifest.candidate = c;
      return b;
    },
  },
  {
    id: "env-8-repository-required",
    title: "provider-signed attestation without a repository identifier",
    rules: ["ENV-8", "ENV-13"],
    expect: { result: "rejected", codes: ["repository_required", "unsupported_attestation"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      b.manifest.attestation = { level: "provider-signed", signatures: [] };
      return b;
    },
  },
  {
    id: "env-9-final-pass-mismatch",
    title: "runHistory's final entry names an earlier pass",
    rules: ["ENV-9"],
    expect: { result: "rejected", codes: ["run_history_final_mismatch"] },
    provenance: `${ATHENA} "mutation sequence mismatched with the final pass"`,
    build: () =>
      baseManifest({
        runHistory: [{ preparedTreeSha: CANDIDATE.treeSha, evaluatedInPassId: "pass-before" }],
      }),
  },
  {
    id: "env-9-final-tree-mismatch",
    title: "runHistory's final entry names an earlier tree",
    rules: ["ENV-9"],
    expect: { result: "rejected", codes: ["run_history_final_mismatch"] },
    provenance: `${ATHENA} "mutation sequence mismatched with the final candidate"`,
    build: () =>
      baseManifest({
        runHistory: [{ preparedTreeSha: oid("tree-before"), evaluatedInPassId: "pass-2" }],
      }),
  },
  {
    id: "env-9-empty-run-history",
    title: "Empty runHistory",
    rules: ["ENV-9", "RG-9"],
    expect: { result: "rejected", codes: ["run_history_final_mismatch", "iteration_count_mismatch"] },
    provenance: TIGHTENED,
    build: () => baseManifest({ runHistory: [], telemetry: { iterationCount: 1 } }),
  },
  {
    id: "env-10-artifact-traversal",
    title: "Artifact path traversing outside the run root",
    rules: ["ENV-10"],
    expect: { result: "rejected", codes: ["artifact_path_invalid"] },
    provenance: `${ATHENA} "reviewer artifact path that traverses outside the run"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      (b.manifest.artifacts as Json[])[0].path = "../outside.json";
      b.files["../outside.json"] = approval("correctness");
      return b;
    },
  },
  {
    id: "env-10-artifact-duplicate",
    title: "Duplicate artifact path entries",
    rules: ["ENV-10"],
    expect: { result: "rejected", codes: ["artifact_path_duplicate"] },
    provenance: `${ATHENA} "rejects a duplicate artifact entry"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      const first = (b.manifest.artifacts as Json[])[0];
      (b.manifest.artifacts as Json[]).push({ ...first });
      return b;
    },
  },
  {
    id: "env-10-artifact-missing-file",
    title: "Artifact entry whose file does not exist in the run root",
    rules: ["ENV-10", "ENV-11"],
    expect: { result: "rejected", codes: ["artifact_digest_mismatch"] },
    provenance: `${ATHENA} "rejects a missing artifact entry"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      (b.manifest.artifacts as Json[]).push({
        path: "reviewers/missing.json",
        sha256: digest64("missing"),
        role: "reviewer-approval",
      });
      return b;
    },
  },
  {
    id: "env-11-artifact-digest-mismatch",
    title: "Artifact digest that does not match the file bytes",
    rules: ["ENV-11"],
    expect: { result: "rejected", codes: ["artifact_digest_mismatch"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      (b.manifest.artifacts as Json[])[0].sha256 = digest64("tampered");
      return b;
    },
  },
  {
    id: "env-12-unknown-attestation-level",
    title: "Unknown attestation level",
    rules: ["ENV-12"],
    expect: { result: "rejected", codes: ["unsupported_attestation"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      b.manifest.attestation = { level: "notarized", signatures: [] };
      return b;
    },
  },
  {
    id: "env-13-nonempty-signatures",
    title: "Non-empty signatures array before a signing profile exists",
    rules: ["ENV-13"],
    expect: { result: "rejected", codes: ["unsupported_attestation"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      b.manifest.attestation = { level: "self", signatures: [{ signer: "x" }] };
      return b;
    },
  },
  {
    id: "env-14-no-claims",
    title: "Empty claims array",
    rules: ["ENV-14"],
    expect: { result: "rejected", codes: ["no_claims"] },
    provenance: SPEC,
    build: () => baseManifest({ claims: [] }),
  },
  {
    id: "env-14-duplicate-claim",
    title: "Two claims for the same obligation",
    rules: ["ENV-14"],
    expect: { result: "rejected", codes: ["duplicate_claim"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      const claim = (b.manifest.claims as Json[])[0];
      (b.manifest.claims as Json[]).push(JSON.parse(JSON.stringify(claim)));
      return b;
    },
  },
  {
    id: "env-14-unconfigured-obligation",
    title: "Claim for an obligation the repository has not configured",
    rules: ["ENV-14"],
    expect: { result: "rejected", codes: ["obligation_not_configured"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      ((b.manifest.claims as Json[])[0] as Json).obligation = "qa.exercised";
      return b;
    },
  },
  {
    id: "env-14-unsupported-payload-spec",
    title: "Payload spec version the repository does not accept",
    rules: ["ENV-14"],
    expect: { result: "rejected", codes: ["unsupported_payload_spec"] },
    provenance: SPEC,
    build: () => {
      const b = baseManifest();
      ((b.manifest.claims as Json[])[0] as Json).payloadSpec = "review.green/0";
      return b;
    },
  },

  // ---- SUB ----
  ...(
    [
      ["deliverable-changed", "deliverable", { deliverable: { digest: digest64("deliverable-after"), identity: IDENTITY } }],
      ["raw-tree-changed", "raw tree", { treeSha: oid("tree-after") }],
      ["base-tip-moved", "base tip", { base: { ...CANDIDATE.base, tipSha: oid("base-b") } }],
      ["merge-base-moved", "merge base", { base: { ...CANDIDATE.base, mergeBaseSha: oid("merge-base-b") } }],
    ] as Array<[string, string, Json]>
  ).map(
    ([slug, label, over]): Vector => ({
      id: `sub-1-${slug}`,
      title: `Current candidate no longer matches: ${label} changed after review`,
      rules: ["SUB-1"],
      expect: { result: "rejected", codes: ["candidate_mismatch"] },
      provenance: `${ATHENA} "candidate no longer matches" / "stays strict on the raw tree"`,
      environment: { currentCandidate: { ...CANDIDATE, ...over } },
      build: () => baseManifest(),
    }),
  ),
  {
    id: "sub-2-unprepared",
    title: "Submission without a current preparation (dirty or unprepared tree)",
    rules: ["SUB-2"],
    expect: { result: "rejected", codes: ["candidate_unprepared"] },
    provenance: `${ATHENA} "refuses to hand out a review context without a current preparation receipt"`,
    environment: { prepared: false },
    build: () => baseManifest(),
  },
  {
    id: "sub-3-manifest-outside-run-root",
    title: "Manifest copied outside the recorder-allocated run root",
    rules: ["SUB-3"],
    expect: { result: "rejected", codes: ["manifest_outside_run_root"] },
    provenance: `${ATHENA} "rejects copied manifests" / "exact final-manifest location"`,
    environment: { manifestLocation: "outside-run-root" },
    build: () => baseManifest(),
  },
  {
    id: "sub-4-record-conflict",
    title: "Resubmission with identical record identity but different content",
    rules: ["SUB-4"],
    expect: { result: "rejected", codes: ["record_conflict"] },
    provenance: `${ATHENA} conflicting existing obligation record`,
    build: () => {
      const first = baseManifest();
      const second = baseManifest({
        findings: [
          { id: "f-late", severity: "P3", scope: "in_contract", actionable: true, blocking: false, disposition: "resolved" },
        ],
      });
      return {
        manifest: second.manifest,
        files: second.files,
        extra: { submitFirst: first.manifest, note: "Submit extra.submitFirst (accepted), then the vector manifest: same provider/run/pass/candidate, different content." },
      };
    },
  },

  // ---- RG ----
  {
    id: "rg-1-verdict-not-green",
    title: "Non-green verdict",
    rules: ["RG-1"],
    expect: { result: "rejected", codes: ["verdict_not_green"] },
    provenance: `${ATHENA} "rejects non-green verdict"`,
    build: () => baseManifest({ payload: { verdict: "not_green" } }),
  },
  {
    id: "rg-1-not-finalized",
    title: "Unfinalized manifest",
    rules: ["RG-1"],
    expect: { result: "rejected", codes: ["not_finalized"] },
    provenance: `${ATHENA} "rejects unfinalized manifest"`,
    build: () => baseManifest({ payload: { finalized: false } }),
  },
  {
    id: "rg-1-edited-after-final-pass",
    title: "Post-final-pass edits admitted by the provider",
    rules: ["RG-1"],
    expect: { result: "rejected", codes: ["edited_after_final_pass"] },
    provenance: `${ATHENA} "rejects post-pass edits"`,
    build: () => baseManifest({ payload: { editedAfterFinalPass: true } }),
  },
  {
    id: "rg-2-duplicate-selected",
    title: "Duplicate reviewer in selected",
    rules: ["RG-2"],
    expect: { result: "rejected", codes: ["reviewer_set_invalid"] },
    provenance: `${ATHENA} "duplicate selected reviewer"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      const p = (b.manifest.claims as Json[])[0].payload as Json;
      (p.reviewers as Json).selected = ["correctness", "correctness"];
      return b;
    },
  },
  {
    id: "rg-3-completed-missing",
    title: "Selected reviewer missing from completed",
    rules: ["RG-3"],
    expect: { result: "rejected", codes: ["reviewer_set_incomplete"] },
    provenance: `${ATHENA} "missing selected reviewer"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      const p = (b.manifest.claims as Json[])[0].payload as Json;
      (p.reviewers as Json).completed = [];
      return b;
    },
  },
  {
    id: "rg-3-completed-unrelated",
    title: "Completed reviewer never selected",
    rules: ["RG-3"],
    expect: { result: "rejected", codes: ["reviewer_set_incomplete"] },
    provenance: `${ATHENA} "unrelated completed reviewer"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      const p = (b.manifest.claims as Json[])[0].payload as Json;
      (p.reviewers as Json).completed = ["correctness", "security"];
      return b;
    },
  },
  {
    id: "rg-3-failed-reviewer",
    title: "A failed reviewer in a green manifest",
    rules: ["RG-3"],
    expect: { result: "rejected", codes: ["reviewer_set_incomplete"] },
    provenance: `${ATHENA} "rejects failed reviewers"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      const p = (b.manifest.claims as Json[])[0].payload as Json;
      (p.reviewers as Json).failed = ["correctness"];
      return b;
    },
  },
  {
    id: "rg-3-timed-out-reviewer",
    title: "A timed-out reviewer in a green manifest",
    rules: ["RG-3"],
    expect: { result: "rejected", codes: ["reviewer_set_incomplete"] },
    provenance: `${ATHENA} "rejects timed out reviewers"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      const p = (b.manifest.claims as Json[])[0].payload as Json;
      (p.reviewers as Json).timedOut = ["correctness"];
      return b;
    },
  },
  {
    id: "rg-4-approval-missing",
    title: "Selected reviewer with no reviewer-approval artifact",
    rules: ["RG-4"],
    expect: { result: "rejected", codes: ["approval_missing"] },
    provenance: `${ATHENA} "rejects copied manifests and missing reviewer artifacts"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness", "security"] });
      b.manifest.artifacts = (b.manifest.artifacts as Json[]).slice(0, 1);
      delete b.files["reviewers/security.json"];
      return b;
    },
  },
  {
    id: "rg-4-approval-extra",
    title: "More reviewer-approval artifacts than selected reviewers",
    rules: ["RG-4"],
    expect: { result: "rejected", codes: ["approval_mismatch"] },
    provenance: `${ATHENA} "exactly one reviewer artifact"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      const extra = approval("security");
      b.files["reviewers/security.json"] = extra;
      (b.manifest.artifacts as Json[]).push({
        path: "reviewers/security.json",
        sha256: sha256(extra),
        role: "reviewer-approval",
      });
      return b;
    },
  },
  ...(
    [
      ["wrong-run", { provider: { id: PROVIDER, runId: "r-other", finalPassId: "pass-2" } }],
      ["wrong-pass", { provider: { id: PROVIDER, runId: "r-conformance-01", finalPassId: "pass-1" } }],
      ["wrong-workspace", { workspaceId: "w-other" }],
      ["wrong-candidate", { candidate: { ...CANDIDATE, treeSha: oid("tree-other") } }],
      ["wrong-reviewer", { reviewerId: "security" }],
      ["not-approved", { result: "advisory" }],
      ["wrong-provider", { provider: { id: "example.second-provider", runId: "r-conformance-01", finalPassId: "pass-2" } }],
    ] as Array<[string, Json]>
  ).map(
    ([slug, over]): Vector => ({
      id: `rg-4-approval-${slug}`,
      title: `Reviewer approval stamp with ${slug.replace(/-/g, " ")}`,
      rules: ["RG-4"],
      expect: { result: "rejected", codes: ["approval_mismatch"] },
      provenance: `${ATHENA} "rejects reviewer artifact with ..."`,
      build: () => {
        const b = baseManifest({ reviewers: ["correctness"] });
        const content = approval("correctness", over);
        b.files["reviewers/correctness.json"] = content;
        (b.manifest.artifacts as Json[])[0].sha256 = sha256(content);
        return b;
      },
    }),
  ),
  {
    id: "rg-4-approval-malformed",
    title: "Reviewer approval artifact that is not JSON",
    rules: ["RG-4"],
    expect: { result: "rejected", codes: ["approval_mismatch"] },
    provenance: `${ATHENA} "rejects malformed and unrelated reviewer artifacts"`,
    build: () => {
      const b = baseManifest({ reviewers: ["correctness"] });
      b.files["reviewers/correctness.json"] = "not json\n";
      (b.manifest.artifacts as Json[])[0].sha256 = sha256("not json\n");
      return b;
    },
  },
  ...(
    [
      ["unknown-severity", { severity: "P9" }],
      ["unknown-scope", { scope: "someday" }],
      ["unknown-disposition", { disposition: "parked" }],
    ] as Array<[string, Json]>
  ).map(
    ([slug, over]): Vector => ({
      id: `rg-5-${slug}`,
      title: `Finding with ${slug.replace(/-/g, " ")}`,
      rules: ["RG-5"],
      expect: { result: "rejected", codes: ["finding_invalid"] },
      provenance: `${ATHENA} "rejects a finding with ..."`,
      build: () =>
        baseManifest({
          findings: [{ id: "f-1", severity: "P2", scope: "in_contract", actionable: true, blocking: false, disposition: "resolved", ...over }],
          telemetry: { findingCounts: { P0: 0, P1: 0, P2: 1, P3: 0 } },
        }),
    }),
  ),
  {
    id: "rg-5-duplicate-finding-id",
    title: "Two findings sharing an id",
    rules: ["RG-5"],
    expect: { result: "rejected", codes: ["finding_invalid"] },
    provenance: SPEC,
    build: () =>
      baseManifest({
        findings: [
          { id: "f-1", severity: "P3", scope: "in_contract", actionable: false, blocking: false, disposition: "advisory" },
          { id: "f-1", severity: "P3", scope: "adjacent", actionable: false, blocking: false, disposition: "advisory" },
        ],
      }),
  },
  {
    id: "rg-6-blocking-finding",
    title: "A blocking finding in a green manifest",
    rules: ["RG-6"],
    expect: { result: "rejected", codes: ["blocking_finding_present"] },
    provenance: `${ATHENA} "rejects blocking findings"`,
    build: () =>
      baseManifest({
        findings: [{ id: "f-1", severity: "P1", scope: "in_contract", actionable: true, blocking: true, disposition: "resolved" }],
      }),
  },
  ...(["unresolved", "ignored"] as const).map(
    (disposition): Vector => ({
      id: `rg-6-actionable-${disposition}`,
      title: `Actionable finding left ${disposition} despite green verdict`,
      rules: ["RG-6"],
      expect: { result: "rejected", codes: ["actionable_unresolved"] },
      provenance: `${ATHENA} "rejects an ${disposition} actionable finding despite zero summary counts"`,
      build: () =>
        baseManifest({
          findings: [{ id: "f-1", severity: "P2", scope: "in_contract", actionable: true, blocking: false, disposition }],
        }),
    }),
  ),
  ...(
    [
      ["p0", { severity: "P0" }],
      ["p1", { severity: "P1" }],
      ["in-contract", { scope: "in_contract" }],
      ["adjacent", { scope: "adjacent" }],
      ["placeholder-issue-id", { deferredIssueId: "TODO" }],
      ["lowercase-issue-id", { deferredIssueId: "ex-1300" }],
      ["missing-issue-id", { deferredIssueId: undefined }],
      ["blocking", { blocking: true }],
      ["non-actionable", { actionable: false }],
    ] as Array<[string, Json]>
  ).map(
    ([slug, over]): Vector => ({
      id: `rg-7-defer-${slug}`,
      title: `Illegal deferral: ${slug.replace(/-/g, " ")}`,
      rules: ["RG-7"],
      expect: { result: "rejected", codes: ["illegal_deferral"] },
      provenance: `${ATHENA} "refuses to defer ... machine-checked rather than trusted"`,
      build: () => {
        const f = { ...DEFERRED_OK, ...over } as Json;
        for (const [k, v] of Object.entries(over)) if (v === undefined) delete f[k];
        return baseManifest({ findings: [f] });
      },
    }),
  ),
  {
    id: "rg-7-issue-id-on-resolved",
    title: "deferredIssueId present on a non-deferred finding",
    rules: ["RG-7"],
    expect: { result: "rejected", codes: ["illegal_deferral"] },
    provenance: SPEC,
    build: () =>
      baseManifest({
        findings: [{ id: "f-1", severity: "P2", scope: "in_contract", actionable: true, blocking: false, disposition: "resolved", deferredIssueId: "EX-1" }],
        telemetry: { findingCounts: { P0: 0, P1: 0, P2: 1, P3: 0 } },
      }),
  },
  {
    id: "rg-8-counts-contradict-findings",
    title: "findingCounts claiming zero over findings with real severities",
    rules: ["RG-8"],
    expect: { result: "rejected", codes: ["telemetry_mismatch"] },
    provenance: `${ATHENA} "rejects telemetry claiming finding counts its own findings contradict"`,
    build: () =>
      baseManifest({
        findings: [DEFERRED_OK],
        telemetry: { findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 } },
      }),
  },
  {
    id: "rg-8-deferral-count-disagrees",
    title: "Deferral count disagreeing with the findings",
    rules: ["RG-8"],
    expect: { result: "rejected", codes: ["telemetry_mismatch"] },
    provenance: `${ATHENA} "deferral count that disagrees with the findings"`,
    build: () =>
      baseManifest({
        findings: [DEFERRED_OK],
        telemetry: { deferredExpansionCount: 0, deferredIssueIds: [] },
      }),
  },
  {
    id: "rg-8-deferral-ids-disagree",
    title: "Deferred issue ids disagreeing with the findings",
    rules: ["RG-8"],
    expect: { result: "rejected", codes: ["telemetry_mismatch"] },
    provenance: `${ATHENA} "issue ids that disagree with the findings"`,
    build: () =>
      baseManifest({
        findings: [DEFERRED_OK],
        telemetry: { deferredIssueIds: ["EX-9999"] },
      }),
  },
  {
    id: "rg-9-iteration-count-mismatch",
    title: "iterationCount disagreeing with runHistory length",
    rules: ["RG-9"],
    expect: { result: "rejected", codes: ["iteration_count_mismatch"] },
    provenance: TIGHTENED,
    build: () => baseManifest({ telemetry: { iterationCount: 7 } }),
  },
  ...(
    [
      ["missing-unit", { total: 100, reportedBy: "x" }, ["invalid_cost"]],
      ["empty-unit", { unit: "", total: 100, reportedBy: "x" }, ["invalid_cost"]],
      ["negative-total", { unit: "tokens", total: -1, reportedBy: "x" }, ["invalid_cost"]],
      ["null-total", { unit: "tokens", total: null, reportedBy: "x" }, ["invalid_cost"]],
      ["by-reviewer-exceeds-total", { unit: "tokens", total: 100, reportedBy: "x", byReviewer: { correctness: 80, security: 40 } }, ["invalid_cost"]],
      ["negative-by-reviewer", { unit: "tokens", total: 100, reportedBy: "x", byReviewer: { correctness: -1 } }, ["invalid_cost"]],
      ["empty-reported-by", { unit: "tokens", total: 100, reportedBy: "" }, ["invalid_cost"]],
      ["unknown-reviewer-in-breakdown", { unit: "tokens", total: 100, reportedBy: "x", byReviewer: { adversarial: 10 } }, ["invalid_cost"]],
    ] as Array<[string, Json, string[]]>
  ).map(
    ([slug, cost, codes]): Vector => ({
      id: `rg-10-cost-${slug}`,
      title: `Cost with ${slug.replace(/-/g, " ")}`,
      rules: ["RG-10"],
      expect: { result: "rejected", codes },
      provenance:
        slug === "unknown-reviewer-in-breakdown"
          ? SPEC
          : `${ATHENA} "rejects a review cost with a ..."`,
      build: () => {
        const c = { ...cost } as Json;
        if (c.total === null) c.total = null;
        return baseManifest({ reviewers: ["correctness", "security"], telemetry: { cost: c } });
      },
    }),
  ),
];

// ── Emit ───────────────────────────────────────────────────────────────────

rmSync(OUT, { recursive: true, force: true });
for (const d of ["vectors/accept", "vectors/reject", "context"])
  mkdirSync(path.join(OUT, d), { recursive: true });

const index: Json[] = [];
const seen = new Set<string>();
for (const v of vectors) {
  if (seen.has(v.id)) throw new Error(`duplicate vector id: ${v.id}`);
  seen.add(v.id);
  const built = v.build();
  const doc = {
    vectorVersion: 1,
    id: v.id,
    title: v.title,
    rules: v.rules,
    provenance: v.provenance,
    expect: v.expect,
    ...(v.environment ? { environment: v.environment } : {}),
    ...(built.extra ? { extra: built.extra } : {}),
    artifacts: built.files,
    manifest: built.manifest,
  };
  const dir = v.expect.result === "accepted" ? "accept" : "reject";
  const file = `vectors/${dir}/${v.id}.json`;
  writeFileSync(path.join(OUT, file), JSON.stringify(doc, null, 2) + "\n");
  index.push({ id: v.id, file, title: v.title, rules: v.rules, expect: v.expect });
}

writeFileSync(
  path.join(OUT, "context/repo-config.json"),
  JSON.stringify(REPO_CONFIG, null, 2) + "\n",
);
writeFileSync(
  path.join(OUT, "context/environment.json"),
  JSON.stringify(ENVIRONMENT, null, 2) + "\n",
);
writeFileSync(
  path.join(OUT, "kit.json"),
  JSON.stringify(
    {
      kit: "delivery-evidence-conformance/1",
      spec: "delivery-evidence/1",
      payloadSpecs: [PAYLOAD_SPEC],
      counts: {
        total: index.length,
        accept: index.filter((i) => (i.expect as Json).result === "accepted").length,
        reject: index.filter((i) => (i.expect as Json).result === "rejected").length,
      },
      vectors: index,
    },
    null,
    2,
  ) + "\n",
);

console.log(`wrote ${index.length} vectors to ${OUT}`);
