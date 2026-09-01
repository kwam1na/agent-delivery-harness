/**
 * Holds the walking-skeleton milestone record honest against the tree.
 *
 * The record's LIVE legs are qualification evidence from real host runs and
 * cannot be re-executed here; what CAN be checked mechanically is checked:
 * the record parses, the gate verdict is decidable, the intervention counter
 * claim is the zero the milestone demands, the fixture leg names a sensor
 * that exists and actually exercises what the record claims, and the frozen
 * out-of-scope list matches the plan's.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

interface M0Record {
  schemaVersion: string;
  gateVerdict: { decision: string; criteria: { statement: string; outcome: string; leg: string }[] };
  hosts: { hostId: string; hostVersion: string; tier: number }[];
  delivery: { finalState: string; finalFence: number; compositionProfile: string; journalSha256: string };
  counters: { operatorInterventions: number; policyRequiredInterruptions: number };
  legs: {
    live: { phases: { phase: string }[]; notExercisedLive: string[] };
    fixture: { sensor: string; scenarios: { id: string; statement: string }[] };
  };
  outsideTheSkeleton: string[];
}

const record = JSON.parse(readFileSync(path.join(REPO_ROOT, "qualifications", "walking-skeleton-m0.json"), "utf8")) as M0Record;

describe("the walking-skeleton milestone record", () => {
  it("stops on the one unmet production-confirmation criterion", () => {
    expect(record.schemaVersion).toBe("walking-skeleton-m0/1");
    expect(["proceed", "stop"]).toContain(record.gateVerdict.decision);
    expect(record.gateVerdict.decision).toBe("stop");
    expect(record.gateVerdict.criteria.length).toBeGreaterThan(0);
    const unmet = record.gateVerdict.criteria.filter((criterion) => criterion.outcome === "unmet");
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.statement).toMatch(/production lane.*qualified.*operator-confirmation producer/iu);
    for (const criterion of record.gateVerdict.criteria) {
      expect(["met", "unmet"], criterion.statement).toContain(criterion.outcome);
      expect(["live", "fixture"], criterion.statement).toContain(criterion.leg);
    }
  });

  it("claims the milestone's counters exactly: zero interventions, the two policy-required confirmations", () => {
    expect(record.counters.operatorInterventions).toBe(0);
    expect(record.counters.policyRequiredInterruptions).toBe(2);
  });

  it("binds the proof to the graded host at its recorded tier and the fixture profile", () => {
    const host = record.hosts[0];
    expect(host?.hostId).toBe("claude-code");
    expect(host?.tier).toBe(0);
    // The graded capability record is the authority the tier must match.
    const graded = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "qualifications", "host-admission-capabilities.json"), "utf8"),
    ) as { hosts: { hostId: string; hostVersion: string; grade: { tier: number } }[] };
    const claude = graded.hosts.find((entry) => entry.hostId === "claude-code");
    expect(host?.hostVersion).toBe(claude?.hostVersion);
    expect(host?.tier).toBe(claude?.grade.tier);
    expect(record.delivery.compositionProfile).toBe("confirmation-fixture");
    expect(record.delivery.finalState).toBe("completed");
    expect(record.delivery.finalFence).toBe(2);
    expect(record.delivery.journalSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names a fixture sensor that exists and exercises what the record claims", () => {
    const sensorPath = path.join(REPO_ROOT, record.legs.fixture.sensor);
    expect(existsSync(sensorPath), record.legs.fixture.sensor).toBe(true);
    const source = readFileSync(sensorPath, "utf8");
    // Each recorded fixture scenario must be recognizably present in the
    // sensor — a record that outruns its sensor is overstatement.
    const markers: Record<string, string> = {
      "unattended-progression": "operatorInterventions).toBe(0)",
      "planted-implementation-failure": "planted defect",
      "candidate-rewrites-sensor": "rewrites its own sensor",
      "planted-reviewer-failure": "PLANTED FINDING",
      "same-context-reinvocation": "SAME context",
      "interruption-resume": "takeover-required",
      "model-minted-confirmation": "viaModelVisibleSurface: true",
      "exact-candidate-mutation": "tampered",
      "typed-blocker-visibility": "explainBlocker",
      "intervention-counter": "operatorInterventions",
      "no-product-agent-process": "claude|codex",
    };
    for (const scenario of record.legs.fixture.scenarios) {
      const marker = markers[scenario.id];
      expect(marker, `unrecorded scenario id ${scenario.id}`).toBeDefined();
      expect(source, scenario.id).toContain(marker as string);
    }
    expect(record.legs.fixture.scenarios.map((scenario) => scenario.id).sort()).toEqual(Object.keys(markers).sort());
  });

  it("states honestly what did not run live, and keeps the skeleton's exclusions verbatim", () => {
    expect(record.legs.live.notExercisedLive.length).toBeGreaterThan(0);
    expect(record.outsideTheSkeleton).toEqual([
      "update/rollback",
      "second host",
      "trackers",
      "control plane",
      "Athena",
      "merge",
      "deploy",
    ]);
  });
});
