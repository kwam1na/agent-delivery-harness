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
      expect(criterion.outcome, criterion.statement).toBe("held");
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
    expect(record.subagents.reason.length).toBeGreaterThan(0);
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
      if (caseName !== undefined) {
        expect(readFileSync(absolute, "utf8").includes(caseName), `${file}: ${caseName}`).toBe(true);
      }
    }
    const ordering = record.attestationOrdering;
    expect(existsSync(path.join(REPO_ROOT, ordering.sensor))).toBe(true);
    expect(readFileSync(path.join(REPO_ROOT, ordering.sensor), "utf8")).toContain(ordering.caseName);
  });

  it("states what was NOT exercised, and what it still does not know", () => {
    expect(record.notExercisedLive.length).toBeGreaterThan(0);
    expect(record.knownLimitations.length).toBeGreaterThan(0);
    for (const entry of [...record.notExercisedLive, ...record.knownLimitations] as string[]) {
      expect(entry.length).toBeGreaterThan(0);
    }
  });
});
