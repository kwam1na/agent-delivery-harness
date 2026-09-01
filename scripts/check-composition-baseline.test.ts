/**
 * THE COMPOSITION BASELINE, EXECUTABLE. Before the managed-product composition
 * changes anything, `qualifications/composition-baseline.json` freezes the
 * current qualified module identities, behaviors, and ownership boundaries
 * across the three repositories the product will compose — this harness, the
 * agent-skills workflow corpus, and the Athena reference adopter — and
 * `qualifications/manual-choreography-baseline.json` freezes the quantitative
 * manual-choreography measurement the later shadow comparison must beat.
 *
 * This suite is the executable half of that statement:
 *
 *   - Every assertion carries exactly one classification from the closed
 *     vocabulary (retained / changed-by-this-plan / excluded), so later units
 *     inherit an explicit compatibility seed rather than an implicit one.
 *   - Assertions verifiable inside this repository are verified for real:
 *     package identities, the CLI surface, the conformance kit's rejection
 *     authority, the exact vendored skills interoperability pin, and the
 *     tracked delivery records. Existing conformance evidence is
 *     cross-referenced, never copied.
 *   - Assertions about the other two repositories are recorded observations:
 *     they must carry provenance (repository, commit, source, observedAt) so
 *     they remain falsifiable, but this suite does not pretend to re-execute
 *     another repository's sensors.
 *   - The manual-choreography artifact must be internally honest: the frozen
 *     rubric text hashes to its recorded digest, the delivery mix meets its
 *     floor, and every wall-clock split adds up.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@agent-delivery-harness/kernel";
import { COMMANDS } from "../packages/cli/src/index.ts";
import harnessConfig from "../harness.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (relative: string): any =>
  JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));

const baseline = readJson("qualifications/composition-baseline.json");
const choreography = readJson("qualifications/manual-choreography-baseline.json");
const interop = readJson("qualifications/agent-skills-provider-interoperability.json");
const kit = readJson("packages/conformance/vectors/kit.json");

const CLASSIFICATIONS = ["retained", "changed-by-this-plan", "excluded"] as const;
const VERIFICATION_KINDS = ["executable", "recorded-observation"] as const;

const assertions: any[] = baseline.assertions;
const byId = new Map<string, any>(assertions.map((a) => [a.id, a]));

describe("composition baseline document", () => {
  it("declares its version and a non-empty classified assertion set", () => {
    expect(baseline.schemaVersion).toBe("composition-baseline/1");
    expect(Array.isArray(assertions)).toBe(true);
    expect(assertions.length).toBeGreaterThan(0);
    expect(byId.size).toBe(assertions.length); // ids are unique
    for (const assertion of assertions) {
      expect(assertion.id, "assertion id").toMatch(/^[a-z0-9-]+$/);
      expect(typeof assertion.statement).toBe("string");
      expect(assertion.statement.length).toBeGreaterThan(0);
      expect(CLASSIFICATIONS).toContain(assertion.classification);
      expect(VERIFICATION_KINDS).toContain(assertion.verification.kind);
    }
  });

  it("uses every classification at least once — the marking is not vacuous", () => {
    for (const classification of CLASSIFICATIONS) {
      expect(
        assertions.some((a) => a.classification === classification),
        `no assertion is classified ${classification}`,
      ).toBe(true);
    }
  });

  it("gives every recorded observation falsifiable provenance", () => {
    for (const assertion of assertions) {
      if (assertion.verification.kind !== "recorded-observation") continue;
      const { provenance } = assertion.verification;
      expect(provenance, `${assertion.id} provenance`).toBeDefined();
      expect(["agent-delivery-harness", "agent-skills", "athena"]).toContain(provenance.repository);
      expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof provenance.source).toBe("string");
      expect(provenance.source.length).toBeGreaterThan(0);
      expect(provenance.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("covers each representative scenario with assertions that exist", () => {
    const scenarios: any[] = baseline.scenarios;
    expect(scenarios.length).toBeGreaterThanOrEqual(5);
    for (const scenario of scenarios) {
      expect(typeof scenario.statement).toBe("string");
      expect(scenario.assertionIds.length).toBeGreaterThan(0);
      for (const id of scenario.assertionIds) {
        expect(byId.has(id), `scenario ${scenario.id} references unknown assertion ${id}`).toBe(true);
      }
    }
  });
});

describe("locally executable assertions", () => {
  it("harness package identities match the workspace, with no third-party runtime dependency", () => {
    const recorded = baseline.repositories.agentDeliveryHarness.packages;
    const actual: Record<string, string> = {};
    const entries = readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true });
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const manifest = readJson(`packages/${entry.name}/package.json`);
      actual[manifest.name] = manifest.version;
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        expect(dependency, `${manifest.name} runtime dependency`).toMatch(/^@agent-delivery-harness\//u);
      }
    }
    expect(actual).toEqual(recorded);
  });

  it("the CLI surface is exactly the recorded evidence loop", () => {
    const names = COMMANDS.map((command) => command.name).sort();
    expect(names).toEqual([...baseline.repositories.agentDeliveryHarness.cliCommands].sort());
  });

  it("ordinary harness execution cannot own a managed delivery run", () => {
    // No command registers scoped work, persists checkpoints, resumes a
    // delivery, consumes approvals, or actions a finish line.
    const names = new Set(COMMANDS.map((command) => command.name));
    for (const absent of baseline.repositories.agentDeliveryHarness.absentDeliveryRunCommands) {
      expect(names.has(absent), `CLI already owns '${absent}'`).toBe(false);
    }
    // And the ordinary gate does not construct the skills provider bridge: the
    // configured provider has no rail command; the exact bridge lives only in
    // the interoperability qualification script.
    for (const provider of harnessConfig.providers) {
      expect(
        (provider as { command?: unknown }).command,
        `provider ${provider.id} wires a rail command into ordinary execution`,
      ).toBeUndefined();
    }
  });

  it("the conformance kit remains the recorded rejection authority", () => {
    const recorded = baseline.repositories.agentDeliveryHarness.conformanceKit;
    expect(kit.spec).toBe(recorded.spec);
    expect(kit.counts).toEqual(recorded.counts);
    const vectorsById = new Map<string, any>(kit.vectors.map((vector: any) => [vector.id, vector]));
    for (const id of recorded.rejectionEvidenceVectors) {
      const vector = vectorsById.get(id);
      expect(vector, `kit vector ${id} vanished`).toBeDefined();
      expect(vector.expect.result).toBe("rejected");
    }
  });

  it("the exact skills interoperability pin is bound to the vendored bytes", () => {
    const recorded = baseline.repositories.agentDeliveryHarness.skillsInteroperabilityPin;
    const pinned = interop.baselines.agentSkills;
    expect(pinned.archiveSha256).toBe(recorded.archiveSha256);
    expect(pinned.commitSha).toBe(recorded.skillsCommit);
    expect(pinned.releaseId).toBe(recorded.releaseId);
    expect(interop.protocol.version).toBe(recorded.protocolVersion);
    const archive = readFileSync(path.join(repoRoot, "qualifications/fixtures/agent-skills-core-v1.zip"));
    expect(sha256Hex(archive)).toBe(pinned.archiveSha256);
  });

  it("every tracked delivery record carries the self-attested gate identity", () => {
    const recordsDir = path.join(repoRoot, "delivery/records");
    const records = readdirSync(recordsDir).filter((name) => name.endsWith(".json"));
    expect(records.length).toBeGreaterThan(0);
    for (const name of records) {
      const record = readJson(`delivery/records/${name}`);
      expect(record.version).toBe("delivery-record/1");
      expect(record.gateId).toBe(harnessConfig.gateId);
      expect(record.identityToken).toBe(baseline.contractTokens.trackedRecordIdentityToken);
      expect(record.attestation.level).toBe("self");
    }
  });

  it("the workflow checkpoint contract is the pinned graph, not a re-authored one", () => {
    const checkpoints = baseline.workflowCheckpoints;
    expect(checkpoints.contract).toBe("workflow-graph/1");
    expect(checkpoints.graphSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(checkpoints.stages).toHaveLength(10);
    expect(new Set(checkpoints.stages).size).toBe(10);
  });

  it("the independent lifecycle burden is three divergent exact release identities", () => {
    const burden = baseline.independentLifecycleBurden;
    // Each identity equals the one recorded where that repository's evidence
    // lives, so the burden block cannot drift from the per-repository facts.
    expect(burden.harnessInteroperabilityArchiveSha256).toBe(interop.baselines.agentSkills.archiveSha256);
    expect(burden.harnessInteroperabilityArchiveSha256).toBe(
      baseline.repositories.agentDeliveryHarness.skillsInteroperabilityPin.archiveSha256,
    );
    expect(burden.athenaActiveGenerationSha256).toBe(baseline.repositories.athena.activeGenerationSha256);
    expect(burden.skillsCurrentQualificationArchiveSha256).toBe(
      baseline.repositories.agentSkills.coreQualification.archiveSha256,
    );
    const digests = [
      burden.harnessInteroperabilityArchiveSha256,
      burden.athenaActiveGenerationSha256,
      burden.skillsCurrentQualificationArchiveSha256,
    ];
    expect(new Set(digests).size, "the three repositories currently agree — re-capture the burden").toBe(3);
    const burdenAssertion = byId.get(burden.assertionId);
    expect(burdenAssertion?.classification).toBe("changed-by-this-plan");
  });
});

describe("manual-choreography baseline", () => {
  it("freezes the scoring rubric verbatim, by digest, with its re-record triggers", () => {
    expect(choreography.schemaVersion).toBe("manual-choreography-baseline/1");
    const rubric = choreography.operatorInterventionRubric;
    expect(rubric.text.length).toBeGreaterThan(0);
    expect(sha256Hex(rubric.text)).toBe(rubric.sha256);
    expect(rubric.source.planSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(choreography.provingHost).toBe("claude-code");
    const triggers = choreography.reRecordTriggers.join(" ");
    expect(triggers).toMatch(/proving host/u);
    expect(triggers).toMatch(/rubric/u);
    expect(triggers).toMatch(/external-verification/u);
  });

  it("freezes at least three deliveries matching the declared mix", () => {
    const deliveries: any[] = choreography.deliveries;
    expect(deliveries.length).toBeGreaterThanOrEqual(3);
    const counted: Record<string, number> = {};
    for (const delivery of deliveries) {
      counted[delivery.category] = (counted[delivery.category] ?? 0) + 1;
    }
    const { total, ...perCategory } = choreography.mix;
    expect(counted).toEqual(perCategory);
    expect(total).toBe(deliveries.length);
    for (const required of ["code", "docs", "operations"]) {
      expect(counted[required] ?? 0, `missing a ${required} delivery`).toBeGreaterThanOrEqual(1);
    }
    for (const delivery of deliveries) {
      expect(delivery.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(delivery.evidence.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(delivery.evidence.host).toBe(choreography.provingHost);
    }
  });

  it("scores every delivery consistently: counts match events and the wall-clock adds up", () => {
    for (const delivery of choreography.deliveries) {
      const started = Date.parse(delivery.window.acceptedAt);
      const ended = Date.parse(delivery.window.firstMergeReadyReportAfterExternalVerificationAt);
      const verification = Date.parse(delivery.window.externalVerification.completedAt);
      expect(ended).toBeGreaterThan(started);
      expect(verification).toBeGreaterThanOrEqual(started);
      expect(delivery.window.windowSeconds).toBe(Math.round((ended - started) / 1000));
      const endpointEvent = Date.parse(delivery.window.endpointEvidence.transcriptEventTimestamp);
      expect(endpointEvent).toBeGreaterThanOrEqual(verification);
      expect(Math.floor(endpointEvent / 1000) * 1000).toBe(ended);
      expect(endpointEvent - ended).toBeLessThan(1000);
      expect(delivery.window.finalCandidateSha).toMatch(/^[0-9a-f]{40}$/);
      expect(delivery.window.externalVerification.candidateSha).toBe(delivery.window.finalCandidateSha);
      expect(delivery.window.endpointEvidence.candidateSha).toBe(delivery.window.finalCandidateSha);
      expect(delivery.window.externalVerification.receipt.source).toBe("github-actions-job");
      expect(delivery.window.externalVerification.receipt.reference).toMatch(/^https:\/\/github\.com\/kwam1na\/athena\/actions\/runs\//u);
      expect(delivery.window.externalVerification.receipt.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(delivery.window.endpointEvidence.source).toBe("claude-code-session-jsonl");
      expect(delivery.window.endpointEvidence.jsonlRecordSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(delivery.window.endpointEvidence.summary).toMatch(/(hosted|external)/iu);
      expect(delivery.score.interventionCount).toBe(delivery.score.interventions.length);
      expect(delivery.score.policyRequiredInterruptionCount).toBe(
        delivery.score.policyRequiredInterruptions.length,
      );
      for (const event of delivery.score.interventions) {
        const at = Date.parse(event.at);
        expect(Number.isFinite(at), `${delivery.id} intervention timestamp`).toBe(true);
        expect(at).toBeGreaterThanOrEqual(started);
        expect(at).toBeLessThanOrEqual(ended);
      }
      const blockedFromEvents = delivery.score.interventions.reduce(
        (total: number, event: any) => total + event.blockedSecondsBefore,
        0,
      );
      expect(delivery.score.blockedSeconds).toBe(blockedFromEvents);
      expect(delivery.score.blockedSeconds + delivery.score.progressingSeconds).toBe(
        delivery.window.windowSeconds,
      );
      const share = delivery.score.blockedSeconds / delivery.window.windowSeconds;
      expect(Math.abs(delivery.score.blockedShare - share)).toBeLessThan(0.001);
    }
  });

  it("pins the locally recaptured external-verification receipts", () => {
    expect(
      choreography.deliveries.map((delivery: any) => ({
        pullRequest: delivery.pullRequest,
        finalCandidateSha: delivery.window.finalCandidateSha,
        mergeCommit: delivery.mergeCommit,
        verificationCompletedAt: delivery.window.externalVerification.completedAt,
        receiptDigest: delivery.window.externalVerification.receipt.digest,
        reportRecordSha256: delivery.window.endpointEvidence.jsonlRecordSha256,
      })),
    ).toEqual([
      {
        pullRequest: 783,
        finalCandidateSha: "4fb2f8b26fd705c73e07cf8e800117753b5e6e30",
        mergeCommit: "7e7c047ca2a1faf3831f8e3b5626a7f881113ee2",
        verificationCompletedAt: "2026-08-22T10:25:16Z",
        receiptDigest: "9a9f7dad9a6b7cd69e178a24dafb72d586e60d1b6817477e27b7f3c214971464",
        reportRecordSha256: "8d14aee4ff65f04141293229dd1b30c0d1a315e1405d9dd7e5413fb5544746f8",
      },
      {
        pullRequest: 674,
        finalCandidateSha: "eebfa9fd67da2a918b32472710aee1b285af40d4",
        mergeCommit: "39c8fc76df33ad39fb29e3cfd46c5960c0cf1d0d",
        verificationCompletedAt: "2026-07-18T02:21:13Z",
        receiptDigest: "5fb8701be3be73ebc49461b536901a00a2d601aeef3de4bf3b58d6aa0bff1642",
        reportRecordSha256: "8d34eebbe36e64ab82c2f4907ad6676e3b749ec5069170f376c3a864875d2bb8",
      },
      {
        pullRequest: 679,
        finalCandidateSha: "8771ee5438a7f43960a95ade9cf133a450c46b4c",
        mergeCommit: "6351d79a17548641ee4d0b479755085cba96d246",
        verificationCompletedAt: "2026-07-19T01:21:54Z",
        receiptDigest: "bb5b88a62cd14ba5e4f267b8dc321aa3bd901d77f9aaaf6e894ef40332d08b8f",
        reportRecordSha256: "0b3a2e27ce35d3db87cfeb76857e4a7f4c1278d1e79b65be8b99244ff52efb8b",
      },
    ]);
  });

  it("records why the superseded PR784 and PR782 rows could not supply an honest endpoint", () => {
    expect(choreography.recaptureExclusions.map((row: any) => row.pullRequest)).toEqual([784, 782]);
    for (const exclusion of choreography.recaptureExclusions) {
      expect(exclusion.reason).toMatch(/external|hosted/u);
      expect(exclusion.reason).toMatch(/no (report|qualifying endpoint)/iu);
    }
  });

  it("names its measurement limits instead of overstating them", () => {
    // Transcript-derived counts cannot see silently granted permission
    // prompts; the artifact must say so rather than imply completeness.
    expect(choreography.method.limitations.join(" ")).toMatch(/permission/u);
  });
});
