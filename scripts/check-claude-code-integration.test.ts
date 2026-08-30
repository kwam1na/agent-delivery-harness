/**
 * Holds the Claude Code integration record honest against the tree.
 *
 * The LIVE legs are qualification evidence from real authenticated host runs
 * and cannot be re-executed here — spawning a host inside `npm run check` is
 * exactly what the delivery forbids. What CAN be checked mechanically is:
 *
 *   - every live probe carries falsifiable provenance and is conclusive;
 *   - the TIER VERDICT follows from the evidence rather than being asserted:
 *     an unverified descendant teardown forces fresh-worktree-only resume, a
 *     closed same-workspace path, and a tier below 3 — and the frozen payload
 *     grammar independently refuses the contrary record;
 *   - the host version matches the graded admission-capability record, so the
 *     two records cannot drift onto different hosts;
 *   - every fixture leg names a sensor file that exists and actually contains
 *     the case it claims;
 *   - the record's own honesty about what was NOT exercised is non-empty.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESUME_ELIGIBILITIES, SPINE_INSTANT, TERMINATION_PROVENANCE_KINDS, classifyEventKind } from "@agent-delivery-harness/kernel";
import { OPT_IN_VARIABLE } from "./qualify-claude-code-session.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const readJson = (relative: string): any => JSON.parse(readFileSync(path.join(REPO_ROOT, relative), "utf8"));

const record = readJson("qualifications/claude-code-integration.json");
const admissionRecord = readJson("qualifications/host-admission-capabilities.json");

describe("the Claude Code integration record", () => {
  it("names the exact host version the admission capability record graded", () => {
    expect(record.schemaVersion).toBe("claude-code-integration/1");
    const graded = (admissionRecord.hosts as any[]).find((host) => host.hostId === "claude-code");
    expect(graded, "the admission record grades claude-code").toBeDefined();
    expect(record.host.hostId).toBe("claude-code");
    expect(record.host.hostVersion).toBe(graded.hostVersion);
    expect(record.host.tier).toBe(graded.grade.tier);
  });

  it("carries only conclusive live probes, each with falsifiable provenance", () => {
    expect(record.liveProbes.length).toBeGreaterThan(0);
    for (const probe of record.liveProbes as any[]) {
      expect(probe.conclusive, probe.id).toBe(true);
      expect(probe.verification.kind, probe.id).toBe("live-probe");
      expect(typeof probe.verification.surface, probe.id).toBe("string");
      expect(probe.verification.surface.length, probe.id).toBeGreaterThan(0);
      expect(typeof probe.verification.method, probe.id).toBe("string");
      expect(probe.verification.method.length, probe.id).toBeGreaterThan(0);
      expect(probe.verification.observedAt, probe.id).toMatch(SPINE_INSTANT);
    }
  });

  it("pairs the denial probe with its control, so the denial is attributable", () => {
    const ids = (record.liveProbes as any[]).map((probe) => probe.id);
    expect(ids).toContain("deny-before-attestation");
    expect(ids).toContain("allow-after-attestation");
  });
});

describe("the termination-provenance verdict", () => {
  const provenance = record.terminationProvenance;

  it("expresses graceful provenance only, exactly as the frozen vocabulary does", () => {
    expect(provenance.expressibleForms).toEqual([...TERMINATION_PROVENANCE_KINDS]);
    expect(provenance.crashProvenance).toContain("structurally unavailable");
  });

  it("records the event kind as defined out of reservation in the delivery journal", () => {
    expect(provenance.journal).toBe("delivery");
    expect(classifyEventKind("delivery", provenance.eventKind)).toEqual({ status: "active", observationOnly: false });
  });

  it("DERIVES the tier from the teardown evidence instead of asserting it", () => {
    const probe = (record.liveProbes as any[]).find((entry) => entry.id === "descendant-teardown");
    expect(probe, "the record carries a descendant-teardown probe").toBeDefined();

    // The record's teardown status must be what the probe actually observed.
    const observedSurvival = probe.answer.startsWith("yes");
    expect(provenance.descendantTeardown).toBe(observedSurvival ? "unverified" : "verified");

    // And the consequences must follow from it, with no room to overclaim.
    expect([...RESUME_ELIGIBILITIES]).toContain(provenance.resumeEligibility);
    if (provenance.descendantTeardown === "unverified") {
      expect(provenance.resumeEligibility).toBe("fresh-worktree-only");
      expect(provenance.sameWorkspaceResume).toBe("closed");
      expect(record.host.tier).toBeLessThan(3);
    } else {
      // The symmetric arm, so a Tier 3 claim cannot be hand-asserted by
      // editing this record's own free text: a `verified` status must be
      // backed by the graded admission record's ladder position, which the
      // host-version cross-check above pins.
      expect(record.host.tier).toBeGreaterThanOrEqual(3);
      const graded = (admissionRecord.hosts as any[]).find((host) => host.hostId === record.host.hostId);
      expect(graded.capabilities.terminationProvenanceWithDescendantTeardown.status).toBe("supported");
    }
  });

  it("names the trusted lifecycle integration as its only entrypoint, and the CLI keeps it out of reach", () => {
    expect(provenance.entrypoint).toContain("trusted host-runtime lifecycle integration");
    expect(provenance.entrypoint).toContain("No model-callable tool");

    // The session-facing command surface cannot even name the operation, so a
    // model-driven task has no shell path to mint its own provenance.
    const managed = readFileSync(path.join(REPO_ROOT, "packages", "cli", "src", "commands", "managed.ts"), "utf8");
    expect(managed).not.toContain("recordTerminationProvenance");
    expect(managed).not.toContain("termination.provenance");
  });
});

describe("the record's legs", () => {
  it("names a real sensor file and a real case for every fixture leg", () => {
    expect(record.fixtureLegs.length).toBeGreaterThan(0);
    for (const leg of record.fixtureLegs as any[]) {
      const sensorPath = path.join(REPO_ROOT, leg.sensor);
      expect(existsSync(sensorPath), leg.sensor).toBe(true);
      const source = readFileSync(sensorPath, "utf8");
      expect(source.includes(leg.caseName), `${leg.sensor} contains "${leg.caseName}"`).toBe(true);
    }
  });

  it("keeps the live lane opt-in and out of the ordinary sensor run", () => {
    expect(record.liveLane.optIn).toContain(OPT_IN_VARIABLE);
    expect(existsSync(path.join(REPO_ROOT, record.liveLane.script))).toBe(true);
    const packageJson = readJson("package.json");
    for (const [name, script] of Object.entries(packageJson.scripts as Record<string, string>)) {
      if (name === "check" || script.includes("npm run check")) {
        expect(script, `${name} must not drive the live lane`).not.toContain("qualify-claude-code-session");
      }
    }
    expect(packageJson.scripts.check).not.toContain("qualify");
  });

  it("states what was not exercised live, and what the integration does not defend", () => {
    expect(Array.isArray(record.notExercisedLive)).toBe(true);
    expect(record.notExercisedLive.length).toBeGreaterThan(0);
    // The record must name its own limits rather than implying completeness.
    expect(Array.isArray(record.knownLimitations)).toBe(true);
    expect(record.knownLimitations.length).toBeGreaterThan(0);
  });

  it("meets every acceptance criterion with a named leg and evidence", () => {
    expect(record.acceptanceCriteria.length).toBe(3);
    for (const criterion of record.acceptanceCriteria as any[]) {
      expect(criterion.outcome, criterion.statement).toBe("met");
      expect(["live", "fixture", "live+fixture"], criterion.statement).toContain(criterion.leg);
      expect(criterion.evidence.length, criterion.statement).toBeGreaterThan(0);
    }
  });
});
