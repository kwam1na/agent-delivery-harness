/**
 * Holds the Codex app-server integration record honest against the tree.
 *
 * The failure this guards against is not a wrong fact, it is a record that
 * quietly outgrows its evidence: a "live" claim with no live lane, a tier that
 * does not follow from the grading it cites, a version claim about a host
 * nobody ran, an acceptance criterion whose sensor does not exist or does not
 * contain the case it names.
 *
 * So every claim below is checked against something outside the record: the
 * graded capability record, the binding's own constants, and the sensor files
 * themselves.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_HOST_ID,
  CODEX_CHARACTERIZED_HOST_VERSION,
  CODEX_HOOK_EVENT,
  CODEX_HOOK_EXECUTION_MODE,
  CODEX_PINNED_HOST_VERSION,
  SPINE_INSTANT,
  codexSubagentPosture,
} from "@agent-delivery-harness/kernel";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const readJson = (relative: string): any => JSON.parse(readFileSync(path.join(REPO_ROOT, relative), "utf8"));

const record = readJson("qualifications/codex-app-server-integration.json");
const admissionRecord = readJson("qualifications/host-admission-capabilities.json");

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A named case must be a LIVE declaration, not merely a string present in the
 * file. A substring test is satisfied by a header comment, a commented-out
 * block, an `it.todo`, or — the case that actually matters — a `describe.skip`
 * around the very case the record cites as its evidence. Switching a named
 * case off would then leave the criterion reading `held` with a sensor that no
 * longer runs, which is exactly the failure this file's header names.
 */
const SILENCED = /\b(?:it|test|describe|suite)\.(?:only|skip|todo|fails|skipIf|concurrent\.skip)\s*\(/;

/**
 * Nothing in a cited evidence file may be switched off or made exclusive.
 *
 * Matching the cited NAME is not enough, because the two ways a cited case
 * actually stops running never mention it: a `describe.skip` whose own name
 * differs silences every `it` inside it, and a single `it.only` anywhere in
 * the file silences every case that is not it. Either leaves the criterion
 * reading `held` with a citation this sensor certified as live.
 *
 * This is deliberately a FILE-level rule rather than a scope-aware one: a
 * cited file is evidence, and evidence that carries a disabled or exclusive
 * declaration anywhere is evidence whose coverage nobody can read off the
 * citation.
 */
function expectNothingSilenced(absolute: string, source: string, what: string): void {
  expect(SILENCED.test(source), `${absolute}: a disabled or exclusive declaration can silence ${what}`).toBe(false);
}

function expectLiveCase(absolute: string, caseName: string): void {
  const source = readFileSync(absolute, "utf8");
  const name = escapeForRegExp(caseName);
  const declared = new RegExp(String.raw`\b(?:it|test|describe)\(\s*["'\`]${name}`);
  const disabled = new RegExp(String.raw`\b(?:it|test|describe)\.(?:skip|todo|fails|skipIf)\(\s*["'\`]${name}`);
  expect(declared.test(source), `${absolute}: no live case declares ${JSON.stringify(caseName)}`).toBe(true);
  expect(disabled.test(source), `${absolute}: ${JSON.stringify(caseName)} is declared but disabled`).toBe(false);
  expectNothingSilenced(absolute, source, JSON.stringify(caseName));
}

/** The same rule for a criterion that cites a whole file rather than a case. */
function expectLiveFile(absolute: string): void {
  expectNothingSilenced(absolute, readFileSync(absolute, "utf8"), `the cited file`);
}

describe("the Codex app-server integration record", () => {
  it("keys the host exactly as the graded capability record does, at the version actually characterized", () => {
    expect(record.schemaVersion).toBe("codex-app-server-integration/1");
    expect(record.recordedAt).toMatch(SPINE_INSTANT);
    expect(record.host.hostId).toBe(CODEX_APP_SERVER_HOST_ID);
    const graded = (admissionRecord.hosts as any[]).find(
      (host) => host.hostId === record.host.hostId && host.hostVersion === record.host.hostVersionCharacterized,
    );
    expect(graded, "the admission record grades this exact host and version").toBeDefined();
    expect(record.host.tier).toBe(graded.grade.tier);
    expect(record.host.hostVersionCharacterized).toBe(CODEX_CHARACTERIZED_HOST_VERSION);
  });

  it("separates the version characterized from the version pinned, and claims nothing about the latter", () => {
    expect(record.host.hostVersionPinnedByTheTrackedItem).toBe(CODEX_PINNED_HOST_VERSION);
    expect(record.host.hostVersionPinnedByTheTrackedItem).not.toBe(record.host.hostVersionCharacterized);
    expect(record.host.versionClaim.length).toBeGreaterThan(0);
    // The pinned version may be NAMED, but no acceptance criterion, finding, or
    // limitation may rest on it.
    const load = JSON.stringify([record.acceptanceCriteria, record.characterization.findings]);
    expect(load.includes(CODEX_PINNED_HOST_VERSION)).toBe(false);
    expect(record.notExercisedLive.some((entry: string) => entry.includes(CODEX_PINNED_HOST_VERSION))).toBe(true);
  });

  it("carries no live lane, and says so rather than leaving it implied", () => {
    expect(record.liveLane.status).toBe("absent");
    expect(record.liveLane.reason.length).toBeGreaterThan(0);
    expect(record.modelFreeLane.status).toBe("present");
    expect(record.deliveryLaneBinding.status).toBe("composed-only");
    // A record with no live lane may not claim a live probe.
    expect(record.liveProbes).toBeUndefined();
    for (const criterion of record.acceptanceCriteria as any[]) {
      expect(criterion.leg, criterion.statement).toBe("model-free");
      // The OUTCOME vocabulary is open in both directions on purpose. Pinning
      // it to "held" makes an honest `not-held` fail this sensor, which leaves
      // a later delivery two ways to go green — falsify the outcome, or delete
      // the criterion — and both are the "record that quietly outgrows its
      // evidence" this file exists to prevent.
      expect(["held", "not-held"], criterion.statement).toContain(criterion.outcome);
    }
  });

  it("derives its resume position from the graded teardown rather than declaring one", () => {
    expect(record.terminationProvenance.descendantTeardown).toBe("unverified");
    expect(record.terminationProvenance.resumeEligibility).toBe("fresh-worktree-only");
    expect(record.terminationProvenance.sameWorkspaceResume).toBe("closed");
    // Tier 0 and an unverified teardown are the same evidence seen twice; a
    // record that separated them would be claiming something.
    expect(record.host.tier).toBe(0);
  });

  it("removes the subagent capability with the binding's own reason, not a softer one", () => {
    expect(record.subagents.capability).toBe(codexSubagentPosture().capability);
    expect(record.subagents.capability).toBe("removed");
    // The BINDING'S OWN reason, verbatim — not merely a non-empty string. A
    // test that promises "not a softer one" in its name and checks only that a
    // string exists reads as covered while covering nothing: a later edit
    // softening this to a compensation claim would keep it green.
    expect(record.subagents.reason).toContain(codexSubagentPosture().reason);
  });

  it("names the host primitives by the spellings the binding actually composes", () => {
    const findings = JSON.stringify(record.characterization.findings);
    expect(findings).toContain(CODEX_HOOK_EVENT);
    expect(findings).toContain(CODEX_HOOK_EXECUTION_MODE);
    expect(record.characterization.observedAt).toMatch(SPINE_INSTANT);
    expect(record.characterization.observedAt <= record.recordedAt).toBe(true);
    expect(record.characterization.limits.length).toBeGreaterThan(0);
  });

  it("names sensors that exist and actually contain the cases they claim", () => {
    expect(record.modelFreeLane.sensors.length).toBeGreaterThan(0);
    for (const sensor of record.modelFreeLane.sensors as string[]) {
      expect(existsSync(path.join(REPO_ROOT, sensor)), sensor).toBe(true);
    }
    const evidenceOf = (text: string): { readonly file: string; readonly caseName?: string } => {
      const [file = "", caseName] = text.split(" — ");
      return { file: file.trim(), caseName: caseName?.trim().replace(/^'|'$/g, "") };
    };
    for (const criterion of record.acceptanceCriteria as any[]) {
      const { file, caseName } = evidenceOf(criterion.evidence);
      const absolute = path.join(REPO_ROOT, file);
      expect(existsSync(absolute), file).toBe(true);
      if (caseName === undefined) expectLiveFile(absolute);
      else expectLiveCase(absolute, caseName);
    }
    const ordering = record.attestationOrdering;
    expect(existsSync(path.join(REPO_ROOT, ordering.sensor))).toBe(true);
    expectLiveCase(path.join(REPO_ROOT, ordering.sensor), ordering.caseName);
  });

  it("carries a non-empty claim in every field that states one", () => {
    // Every field below asserts something about the binding, the host, or the
    // characterization. None of them was defended by any other case in this
    // file, so all nine could be emptied with the sensor green — a record that
    // says nothing while reading as a record.
    const claims: Readonly<Record<string, unknown>> = {
      description: record.description,
      platform: record.platform,
      "host.admissionSurface": record.host.admissionSurface,
      "host.gradeSource": record.host.gradeSource,
      "characterization.method": record.characterization.method,
      "modelFreeLane.launchesNothing": record.modelFreeLane.launchesNothing,
      "liveLane.whatALiveLaneWouldAdd": record.liveLane.whatALiveLaneWouldAdd,
      "deliveryLaneBinding.meaning": record.deliveryLaneBinding.meaning,
      "attestationOrdering.property": record.attestationOrdering.property,
    };
    for (const [field, claim] of Object.entries(claims)) {
      expect(typeof claim, field).toBe("string");
      expect((claim as string).length, field).toBeGreaterThan(0);
    }
    // Two of them are tied to the tree rather than to themselves, so a claim
    // that drifts away from what the binding composes fails here.
    expect(record.host.admissionSurface).toContain(CODEX_HOOK_EVENT);
    expect(record.host.gradeSource).toContain("qualifications/host-admission-capabilities.json");
  });

  it("states what was NOT exercised, and what it still does not know", () => {
    expect(record.notExercisedLive.length).toBeGreaterThan(0);
    expect(record.knownLimitations.length).toBeGreaterThan(0);
    for (const entry of [...record.notExercisedLive, ...record.knownLimitations] as string[]) {
      expect(entry.length).toBeGreaterThan(0);
    }
  });
});
