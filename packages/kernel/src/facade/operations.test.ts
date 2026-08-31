import { describe, expect, it } from "vitest";
import {
  FACADE_CAPABILITY_CLASSES,
  FACADE_OPERATIONS,
  FACADE_SURFACES,
  checkFacadeSurfaceInvariants,
  facadeOperation,
  operationsOnSurface,
} from "./operations.ts";

describe("the facade operation inventory", () => {
  it("maps every operation to a capability class, a fence rule, and a journal-revision rule", () => {
    expect(FACADE_OPERATIONS.length).toBeGreaterThan(0);
    for (const entry of FACADE_OPERATIONS) {
      expect(FACADE_CAPABILITY_CLASSES).toContain(entry.capability);
      expect(["required", "absent-by-state"]).toContain(entry.fence);
      expect(["advances", "observation-only", "none"]).toContain(entry.journalRevision);
      for (const surface of entry.surfaces) expect(FACADE_SURFACES).toContain(surface);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it("names every operation exactly once", () => {
    const names = FACADE_OPERATIONS.map((entry) => entry.operation);
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers every capability class, so no class is declared vacuously", () => {
    for (const capability of FACADE_CAPABILITY_CLASSES) {
      expect(FACADE_OPERATIONS.some((entry) => entry.capability === capability)).toBe(true);
    }
  });

  it("resolves an operation by name and refuses an unknown one", () => {
    expect(facadeOperation("status")?.capability).toBe("read");
    expect(facadeOperation("no-such-operation")).toBeUndefined();
  });

  it("holds the surface invariants the facade boundary exists to keep", () => {
    expect(checkFacadeSurfaceInvariants(FACADE_OPERATIONS)).toEqual([]);
  });
});

describe("the surface boundary", () => {
  it("serves every operator confirmation only on the binding-owned channel", () => {
    const confirmations = FACADE_OPERATIONS.filter((entry) => entry.capability === "confirmation");
    expect(confirmations.length).toBeGreaterThan(0);
    for (const entry of confirmations) {
      expect(entry.surfaces).toEqual(["binding-channel"]);
    }
  });

  it("admits termination provenance only through the trusted integration event", () => {
    const provenance = facadeOperation("recordTerminationProvenance");
    expect(provenance?.surfaces).toEqual(["integration-event"]);
  });

  it("keeps the MCP surface read-only, so it inspects rather than orchestrates", () => {
    const exposed = operationsOnSurface("mcp");
    expect(exposed.length).toBeGreaterThan(0);
    for (const entry of exposed) expect(entry.capability).toBe("read");
  });

  it("gives the CLI every read operation the MCP surface exposes", () => {
    const cli = new Set(operationsOnSurface("cli").map((entry) => entry.operation));
    for (const entry of operationsOnSurface("mcp")) expect(cli.has(entry.operation)).toBe(true);
  });

  it("requires the invocation fence of exactly the operations a bound task drives", () => {
    for (const entry of FACADE_OPERATIONS) {
      if (entry.fence !== "required") continue;
      expect(entry.journalRevision).not.toBe("none");
    }
  });
});

describe("the invariant checker", () => {
  const base = FACADE_OPERATIONS[0] as (typeof FACADE_OPERATIONS)[number];

  it("reports a confirmation reachable from a model-visible surface", () => {
    const findings = checkFacadeSurfaceInvariants([
      { ...base, operation: "confirmSomething", capability: "confirmation", surfaces: ["cli"] },
    ]);
    expect(findings.map((finding) => finding.rule)).toContain("confirmation-off-channel");
  });

  it("reports a non-read operation offered as an MCP tool", () => {
    const findings = checkFacadeSurfaceInvariants([
      { ...base, operation: "driveSomething", capability: "control", surfaces: ["mcp"] },
    ]);
    expect(findings.map((finding) => finding.rule)).toContain("mcp-not-read-only");
  });

  it("reports termination provenance offered anywhere a model can call it", () => {
    const findings = checkFacadeSurfaceInvariants([
      { ...base, operation: "recordTerminationProvenance", capability: "control", surfaces: ["cli"] },
    ]);
    expect(findings.map((finding) => finding.rule)).toContain("termination-provenance-callable");
  });

  it("reports a duplicated operation name", () => {
    const findings = checkFacadeSurfaceInvariants([base, base]);
    expect(findings.map((finding) => finding.rule)).toContain("duplicate-operation");
  });

  it("reports a fenced operation that cannot advance the journal", () => {
    const findings = checkFacadeSurfaceInvariants([
      { ...base, operation: "fencedButInert", capability: "control", fence: "required", journalRevision: "none", surfaces: [] },
    ]);
    expect(findings.map((finding) => finding.rule)).toContain("fence-without-revision");
  });
});
