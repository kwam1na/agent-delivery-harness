/**
 * HOLDS THE PRODUCT QUALIFICATION RECORD HONEST AGAINST THE TREE.
 *
 * `qualifications/product-qualification.json` records a run of
 * `npm run qualify:product` — five npm packs, five composition packs, two full
 * deliveries. That run cannot be re-executed here, and re-executing it would
 * not be the point: what a record can drift from is the TREE, and that is what
 * this suite pins.
 *
 * THE DRIFT THIS CATCHES. The record's observed sets are the driver's declared
 * required sets. When someone adds a required negative probe or a lifecycle
 * step to `scripts/qualify-product.ts` and does not re-run the lane, the record
 * silently describes a weaker gate than the one the repository now demands.
 * Equality against the driver's own constants is what makes that a red suite
 * rather than a quiet downgrade.
 *
 * THE ABSENCE-ASSERTION TRAP. A record can claim coverage by naming sensors
 * that do not exist, or by listing an empty set under a confident heading. So
 * every named sensor path is resolved on disk, every enumerated set is required
 * to be non-empty, and the honest-limits sections are required to carry
 * content — a `notProvenHere` that emptied out would mean the record had
 * quietly grown to claim everything.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_SPECS,
  FORBIDDEN_PRODUCT_EXECUTABLES,
  REQUIRED_LIFECYCLE_STEPS,
  REQUIRED_NEGATIVE_PROBES,
} from "./qualify-product.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ProductQualificationRecord {
  schemaVersion: string;
  gateVerdict: { decision: string; criteria: { id: string; statement: string; outcome: string; leg: string; evidence: string }[] };
  packedLeg: {
    driver: string;
    observed: {
      generationDigest: string;
      workflowGraphSha256: string;
      compositionProfile: string;
      repositoriesDelivered: string[];
      repositoryPolicies: { repositoryId: string; gateId: string; identityVersion: string; deliveryRecordDir: string; intakeMode: string }[];
      distinctGateConfigDigests: number;
      productProcessInventory: string[];
      negativeProbesSatisfied: string[];
      lifecycleStepsProven: string[];
      findings: number;
    };
  };
  packedSurfaceFindings: { observation: string; disposition: string }[];
  fixtureLeg: { sensors: { property: string; sensor: string }[] };
  notProvenHere: string[];
  knownLimitations: string[];
}

const record = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "qualifications", "product-qualification.json"), "utf8"),
) as ProductQualificationRecord;

const LEGS = ["packed", "fixture"];

describe("the product qualification record", () => {
  it("carries a decidable gate verdict in which every criterion is met and names its leg", () => {
    expect(record.schemaVersion).toBe("product-qualification/1");
    expect(["proceed", "stop"]).toContain(record.gateVerdict.decision);
    expect(record.gateVerdict.decision).toBe("proceed");
    expect(record.gateVerdict.criteria.length).toBeGreaterThan(0);
    const ids = record.gateVerdict.criteria.map((criterion) => criterion.id);
    expect(new Set(ids).size, "criterion ids are unique").toBe(ids.length);
    for (const criterion of record.gateVerdict.criteria) {
      expect(criterion.outcome, criterion.id).toBe("met");
      expect(LEGS, criterion.id).toContain(criterion.leg);
      // A criterion with no evidence is a heading, not a claim.
      expect(criterion.evidence.length, criterion.id).toBeGreaterThan(40);
    }
  });

  it("names a packed-leg driver that exists and is the one the npm script runs", () => {
    expect(existsSync(path.join(REPO_ROOT, record.packedLeg.driver))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["qualify:product"], "the record's driver must be reachable as a named command").toContain(
      record.packedLeg.driver,
    );
  });

  it("records observations that match the gate the driver currently demands", () => {
    const observed = record.packedLeg.observed;
    // The drift guard. Adding a required probe or lifecycle step to the driver
    // without re-running the lane leaves the record describing a weaker gate.
    expect([...observed.negativeProbesSatisfied].sort()).toEqual([...REQUIRED_NEGATIVE_PROBES].sort());
    expect([...observed.lifecycleStepsProven].sort()).toEqual([...REQUIRED_LIFECYCLE_STEPS].sort());
    expect([...observed.repositoriesDelivered].sort()).toEqual([...DISPOSABLE_SPECS.map((spec) => spec.repositoryId)].sort());
    // Every declared repository delivered under its own gate configuration.
    expect(observed.distinctGateConfigDigests).toBe(DISPOSABLE_SPECS.length);
    expect(observed.findings).toBe(0);
  });

  it("records the POLICY each repository ran under, not only its name", () => {
    // Ids alone are the weakest possible pin: changing a repository's gate id,
    // identity token, record location, or intake lane would leave the record
    // describing a run of a policy that no longer exists, with every name still
    // matching. So the distinguishing facts are recorded and compared.
    const recorded = record.packedLeg.observed.repositoryPolicies;
    expect(recorded.length).toBe(DISPOSABLE_SPECS.length);
    for (const spec of DISPOSABLE_SPECS) {
      const entry = recorded.find((item) => item.repositoryId === spec.repositoryId);
      expect(entry, spec.repositoryId).toBeDefined();
      expect(entry?.gateId, spec.repositoryId).toBe(spec.gateId);
      expect(entry?.identityVersion, spec.repositoryId).toBe(spec.identityVersion);
      expect(entry?.deliveryRecordDir, spec.repositoryId).toBe(spec.deliveryRecordDir);
      expect(entry?.intakeMode, spec.repositoryId).toBe(spec.intakeMode);
    }
  });

  it("records a digest-shaped generation and the workflow graph the shipped composition pins", () => {
    expect(record.packedLeg.observed.generationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.packedLeg.observed.compositionProfile).toBe("confirmation-fixture");
    // The graph digest is not free text: it is the one the installed product
    // carries, so a record quoting a different one is describing another
    // release.
    const composition = readFileSync(path.join(REPO_ROOT, "packages", "kernel", "src", "spine", "composition.ts"), "utf8");
    expect(composition).toContain(record.packedLeg.observed.workflowGraphSha256);
  });

  it("claims a process inventory that actually excludes every runtime the lane forbids", () => {
    const inventory = record.packedLeg.observed.productProcessInventory;
    // An empty inventory would satisfy "no agent runtime" vacuously — the
    // product ran nothing, so it launched no agent. The claim is only worth
    // something because the product DID run processes and none was an agent.
    expect(inventory.length).toBeGreaterThan(0);
    // Imported, never re-spelled: adding a runtime to the driver's forbidden
    // list must be able to invalidate a record that predates it.
    for (const forbidden of FORBIDDEN_PRODUCT_EXECUTABLES) {
      expect(inventory, forbidden).not.toContain(forbidden);
    }
  });

  it("names fixture sensors that all exist on disk", () => {
    expect(record.fixtureLeg.sensors.length).toBeGreaterThan(0);
    for (const entry of record.fixtureLeg.sensors) {
      expect(existsSync(path.join(REPO_ROOT, entry.sensor)), entry.sensor).toBe(true);
      expect(entry.property.length, entry.sensor).toBeGreaterThan(20);
    }
  });

  it("keeps its honest limits populated rather than quietly claiming everything", () => {
    // These sections are the record's only defence against overstatement. An
    // emptied list reads as broader coverage while proving strictly less, so
    // emptying one is a change this suite refuses.
    expect(record.notProvenHere.length).toBeGreaterThan(0);
    expect(record.knownLimitations.length).toBeGreaterThan(0);
    // The two the release claim most obviously invites a reader to assume.
    const notProven = record.notProvenHere.join("\n");
    expect(notProven, "a Codex lane is not established by this record").toMatch(/Codex/);
    expect(notProven, "a live authenticated host lane is not established by this record").toMatch(/LIVE|live/);
  });

  it("gives every recorded packed-surface finding a disposition", () => {
    for (const finding of record.packedSurfaceFindings) {
      expect(["recorded", "corrected", "deferred", "accepted-projection"], finding.observation).toContain(finding.disposition);
      expect(finding.observation.length).toBeGreaterThan(20);
    }
  });
});
