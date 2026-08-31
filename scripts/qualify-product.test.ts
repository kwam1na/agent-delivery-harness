/**
 * THE PRODUCT QUALIFICATION LANE'S RULES, FALSIFIED — IN BOTH DIRECTIONS.
 *
 * `scripts/qualify-product.ts` packs five tarballs, installs them, packs four
 * composition generations and drives two full deliveries. That is the right
 * shape for a release gate and the wrong shape for checking whether a rule
 * works, so every judgement the lane makes is a pure function and this suite
 * drives each one to BOTH verdicts.
 *
 * WHY BOTH DIRECTIONS, EVERY TIME. A deny-only assertion is satisfied by a
 * mechanism that denies everything. `forbiddenProcessFinding` returning a
 * finding for `claude` proves nothing unless it also returns nothing for
 * `git rev-parse` — otherwise a rule reading "always report a finding" passes
 * the suite and fails the product. The same reasoning applies to every rule
 * below, which is why no `it` here checks only the failing side.
 *
 * WHY THE DECLARED SETS ARE PINNED. The lane's central claim quantifies over
 * "every disposable repository" and "every required negative probe". A general
 * claim above an empty set passes for free, so the sets' MEMBERSHIP and SIZE
 * are asserted here rather than only their contents being iterated there — the
 * enumerating mechanism is the thing that can go missing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DISPOSABLE_SPECS,
  FORBIDDEN_PRODUCT_EXECUTABLES,
  FORBIDDEN_WORKSPACE_OPERATIONS,
  REQUIRED_LIFECYCLE_STEPS,
  REQUIRED_NEGATIVE_PROBES,
  antiVacuityFindings,
  buildDisposableRepository,
  decideObservations,
  forbiddenProcessFinding,
  isInside,
  policyIndependenceFindings,
  refusalOutcome,
  runProductQualification,
} from "./qualify-product.ts";

const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

/** Every rule's passing shape, so each falsification below is a one-field edit. */
const CLEAN = {
  declaredSpecs: DISPOSABLE_SPECS.length,
  delivered: DISPOSABLE_SPECS.map((spec) => spec.repositoryId),
  negativeProbesSatisfied: [...REQUIRED_NEGATIVE_PROBES],
  lifecycleStepsProven: [...REQUIRED_LIFECYCLE_STEPS],
  perRepositoryProcessInventory: Object.fromEntries(
    DISPOSABLE_SPECS.map((spec) => [spec.repositoryId, ["git", "node"]]),
  ),
};

describe("the no-agent-process rule", () => {
  it("reports the agent runtimes it forbids", () => {
    for (const executable of FORBIDDEN_PRODUCT_EXECUTABLES) {
      const finding = forbiddenProcessFinding("repo", `/usr/local/bin/${executable}`, ["-p", "do the work"]);
      expect(finding?.rule, executable).toBe("no-agent-process");
      expect(finding?.message, executable).toContain(executable);
    }
  });

  it("reports the workspace lifecycle operations it forbids", () => {
    for (const operation of FORBIDDEN_WORKSPACE_OPERATIONS) {
      const finding = forbiddenProcessFinding("repo", "/usr/bin/git", [operation, "add", "somewhere"]);
      expect(finding?.rule, operation).toBe("no-agent-process");
    }
  });

  // THE CONTROL. Without this, a rule that reported every invocation would
  // pass every assertion above and make the whole lane permanently red for the
  // wrong reason — which is indistinguishable from coverage until someone
  // looks.
  it("reports nothing for the processes the product is SUPPOSED to run", () => {
    expect(forbiddenProcessFinding("repo", "/usr/bin/git", ["rev-parse", "HEAD"])).toBeUndefined();
    expect(forbiddenProcessFinding("repo", "/usr/bin/git", ["status", "--porcelain"])).toBeUndefined();
    expect(forbiddenProcessFinding("repo", "/usr/bin/git", ["show", "main:tools/sensor.mjs"])).toBeUndefined();
    expect(forbiddenProcessFinding("repo", "/usr/local/bin/node", ["tools/sensor.mjs"])).toBeUndefined();
  });

  it("matches on the executable, not on a substring of the path", () => {
    // A repository checked out under a directory called `codex` is not a
    // launched agent runtime, and a tool called `claude-helper` is not
    // `claude`. Basename equality, never inclusion.
    expect(forbiddenProcessFinding("repo", "/home/me/codex/bin/git", ["rev-parse", "HEAD"])).toBeUndefined();
    expect(forbiddenProcessFinding("repo", "/usr/bin/claude-helper", [])).toBeUndefined();
    expect(forbiddenProcessFinding("repo", "/usr/bin/claude", [])?.rule).toBe("no-agent-process");
  });
});

describe("the negative-probe refusal rule", () => {
  const CODE = "disposable_repository_refused";

  it("counts a refusal carrying the expected code", () => {
    expect(refusalOutcome("p", { ok: false, blockers: [{ code: CODE }] }, CODE)).toEqual({ satisfied: true });
  });

  // THE CONTROL THAT MATTERS MOST HERE. This function is the only thing
  // between "the probe ran" and "the probe refused": a detector that stopped
  // noticing success would let every required probe report satisfied against a
  // mechanism that ALLOWED the forbidden thing, while the anti-vacuity rule saw
  // a full satisfied list and reported nothing.
  it("fails when the forbidden thing was ALLOWED", () => {
    const outcome = refusalOutcome("p", { ok: true, deliveryId: "dlv-1" }, CODE);
    expect(outcome.satisfied).toBe(false);
    expect(outcome.satisfied === false && outcome.finding.message).toContain("got success");
  });

  it("fails a refusal that carries some other reason", () => {
    const outcome = refusalOutcome("p", { ok: false, blockers: [{ code: "trust_state_absent" }] }, CODE);
    expect(outcome.satisfied).toBe(false);
    expect(outcome.satisfied === false && outcome.finding.message).toContain("wrong reason");
  });

  it("fails a refusal that names no reason at all", () => {
    const outcome = refusalOutcome("p", { ok: false }, CODE);
    expect(outcome.satisfied).toBe(false);
  });
});

describe("the policy-independence rule", () => {
  it("passes when every declared repository delivered under its own policy", () => {
    expect(policyIndependenceFindings({ delivered: ["a", "b"], distinctGateConfigDigests: 2, declared: 2 })).toEqual([]);
  });

  it("fails when two repositories delivered under ONE gate configuration", () => {
    const findings = policyIndependenceFindings({ delivered: ["a", "b"], distinctGateConfigDigests: 1, declared: 2 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("policy-independence");
    expect(findings[0]?.message).toContain("did not actually change its policy");
  });

  it("stays silent when a repository did not deliver at all", () => {
    // That failure belongs to `delivery-failed` and to anti-vacuity. Reporting
    // it here too would attribute a delivery failure to policy and send a
    // reader to the wrong place.
    expect(policyIndependenceFindings({ delivered: ["a"], distinctGateConfigDigests: 1, declared: 2 })).toEqual([]);
  });
});

describe("the anti-vacuity rules", () => {
  it("reports nothing on a run that actually proved everything", () => {
    expect(antiVacuityFindings(CLEAN)).toEqual([]);
  });

  it("fails a run that drove no repository", () => {
    const findings = antiVacuityFindings({ ...CLEAN, delivered: [] });
    expect(findings.map((finding) => finding.subject)).toContain("repositories");
  });

  it("fails a lane that declares fewer than two disposable repositories", () => {
    const findings = antiVacuityFindings({ ...CLEAN, declaredSpecs: 1 });
    expect(findings.map((finding) => finding.subject)).toContain("repository-set");
  });

  it("fails a run missing ANY required negative probe, naming the one that is missing", () => {
    for (const probe of REQUIRED_NEGATIVE_PROBES) {
      const findings = antiVacuityFindings({
        ...CLEAN,
        negativeProbesSatisfied: REQUIRED_NEGATIVE_PROBES.filter((entry) => entry !== probe),
      });
      expect(findings.map((finding) => finding.subject), probe).toContain(probe);
    }
  });

  it("fails a run missing ANY required lifecycle step, naming the one that is missing", () => {
    for (const step of REQUIRED_LIFECYCLE_STEPS) {
      const findings = antiVacuityFindings({
        ...CLEAN,
        lifecycleStepsProven: REQUIRED_LIFECYCLE_STEPS.filter((entry) => entry !== step),
      });
      expect(findings.map((finding) => finding.subject), step).toContain(step);
    }
  });

  it("fails a completed delivery whose process inventory observed nothing, NAMING that lane", () => {
    for (const spec of DISPOSABLE_SPECS) {
      const findings = antiVacuityFindings({
        ...CLEAN,
        perRepositoryProcessInventory: { ...CLEAN.perRepositoryProcessInventory, [spec.repositoryId]: [] },
      });
      expect(findings.map((finding) => finding.subject), spec.repositoryId).toContain(
        `process-inventory/${spec.repositoryId}`,
      );
    }
  });

  it("does not let one lane's inventory cover for the other's", () => {
    // The absence-assertion trap in miniature: a single shared counter would
    // stay non-zero here and report nothing, while one lane observed nothing
    // at all and the record still claimed both lanes were instrumented.
    const [alpha, beta] = DISPOSABLE_SPECS as readonly [(typeof DISPOSABLE_SPECS)[number], (typeof DISPOSABLE_SPECS)[number]];
    const findings = antiVacuityFindings({
      ...CLEAN,
      perRepositoryProcessInventory: { [alpha.repositoryId]: ["git", "node"], [beta.repositoryId]: [] },
    });
    expect(findings.map((finding) => finding.subject)).toEqual([`process-inventory/${beta.repositoryId}`]);
  });

  it("does not report an empty inventory for a repository that never delivered", () => {
    // Nothing ran for it, so an empty inventory is the truth rather than a
    // defect; the empty-repositories finding is the one that should fire.
    const findings = antiVacuityFindings({ ...CLEAN, delivered: [], perRepositoryProcessInventory: {} });
    expect(findings.map((finding) => finding.subject)).toContain("repositories");
    expect(findings.map((finding) => finding.subject).join(",")).not.toContain("process-inventory");
  });
});

describe("the required sets the lane quantifies over", () => {
  it("declares at least two disposable repositories, so the release claim has a second one", () => {
    expect(DISPOSABLE_SPECS.length).toBeGreaterThanOrEqual(2);
    expect(new Set(DISPOSABLE_SPECS.map((spec) => spec.repositoryId)).size).toBe(DISPOSABLE_SPECS.length);
  });

  it("gives the two repositories genuinely different policies, not different spellings", () => {
    const [alpha, beta] = DISPOSABLE_SPECS as readonly [(typeof DISPOSABLE_SPECS)[number], (typeof DISPOSABLE_SPECS)[number]];
    // If these ever converge, the lane's central claim quietly becomes "one
    // repository was driven twice" while every assertion still passes.
    expect(alpha.gateId).not.toBe(beta.gateId);
    expect(alpha.identityVersion).not.toBe(beta.identityVersion);
    expect(alpha.deliveryRecordDir).not.toBe(beta.deliveryRecordDir);
    expect(alpha.sourceRelativePath).not.toBe(beta.sourceRelativePath);
    expect(alpha.contractedValue).not.toBe(beta.contractedValue);
    expect([...alpha.reviewNeutralPrefixes].sort()).not.toEqual([...beta.reviewNeutralPrefixes].sort());
    expect(alpha.testGlob).not.toBe(beta.testGlob);
  });

  it("declares two intake lanes, so the scoping half of the release claim is driven too", () => {
    // One repository hands over an already-scoped contract; the other runs the
    // product-owned scoping turn first. If both declared the same lane, the
    // iterative-intake claim would rest on no packed evidence at all.
    const modes = new Set(DISPOSABLE_SPECS.map((spec) => spec.intakeMode));
    expect(modes.has("already-scoped")).toBe(true);
    expect(modes.has("outcome-only")).toBe(true);
  });

  it("names a non-empty required probe and lifecycle set", () => {
    expect(REQUIRED_NEGATIVE_PROBES.length).toBeGreaterThan(0);
    expect(REQUIRED_LIFECYCLE_STEPS.length).toBeGreaterThan(0);
    expect(new Set(REQUIRED_NEGATIVE_PROBES).size).toBe(REQUIRED_NEGATIVE_PROBES.length);
    expect(new Set(REQUIRED_LIFECYCLE_STEPS).size).toBe(REQUIRED_LIFECYCLE_STEPS.length);
  });

  it("requires both temporal directions of the qualification-profile rule", () => {
    // One direction alone leaves the profile a one-way door: a flagged
    // installation that could later serve a real repository is the defect the
    // plan's re-review found, and a lane that probed only the other direction
    // would not have caught it.
    expect(REQUIRED_NEGATIVE_PROBES).toContain("qualification-flag-required");
    expect(REQUIRED_NEGATIVE_PROBES).toContain("qualification-flag-refused-on-production");
  });
});

describe("path containment", () => {
  it("accepts a real descendant and rejects a sibling sharing its prefix", () => {
    expect(isInside("/tmp/root/a/b.ts", "/tmp/root")).toBe(true);
    // The bug this exists for: `/tmp/root-2` starts with `/tmp/root`.
    expect(isInside("/tmp/root-2/a.ts", "/tmp/root")).toBe(false);
    expect(isInside("/tmp/other/a.ts", "/tmp/root")).toBe(false);
    // A root is not inside itself; "the product loaded from the root" is not a
    // module path.
    expect(isInside("/tmp/root", "/tmp/root")).toBe(false);
  });
});

describe("the disposable repository builder", () => {
  it("stamps each repository at a trusted base carrying its OWN policy and sensor", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "qualify-product-builder-"));
    scratches.push(scratch);
    // The kernel link target is irrelevant to what this checks, so a directory
    // that merely exists keeps the test at filesystem speed.
    const kernelDir = path.join(scratch, "kernel-stand-in");
    execFileSync("mkdir", ["-p", kernelDir]);

    for (const spec of DISPOSABLE_SPECS) {
      const repoDir = path.join(scratch, spec.repositoryId);
      const built = buildDisposableRepository(repoDir, spec, kernelDir);
      expect(built.baseCommit, spec.repositoryId).toMatch(/^[0-9a-f]{40}$/);

      const config = readFileSync(path.join(repoDir, "harness.config.ts"), "utf8");
      expect(config, spec.repositoryId).toContain(spec.gateId);
      expect(config, spec.repositoryId).toContain(spec.identityVersion);
      // The sensor is the repository's own contracted outcome, executable —
      // one shared sensor across both repositories would make the second
      // delivery a copy of the first.
      const sensor = readFileSync(path.join(repoDir, "tools", "sensor.mjs"), "utf8");
      expect(sensor, spec.repositoryId).toContain(spec.contractedValue);
      expect(sensor, spec.repositoryId).toContain(spec.exportName);
      // The charters the compiled lens declaration pins.
      expect(existsSync(path.join(repoDir, "delivery", "personas", "outcome-correctness.md"))).toBe(true);
      expect(existsSync(path.join(repoDir, "delivery", "personas", "testing-policy.md"))).toBe(true);
      // The tracked base carries no candidate yet: the contracted module is
      // what the delivery has to produce.
      expect(existsSync(path.join(repoDir, ...spec.sourceRelativePath.split("/")))).toBe(false);
    }
  });

  it("wires the kernel to an INSTALLED tree, never to the source checkout", () => {
    // The substitution this lane exists to prevent: a disposable repository
    // whose tracked config resolves the kernel out of `packages/` is a
    // source-checkout run wearing a disposable repository's clothes.
    const scratch = mkdtempSync(path.join(tmpdir(), "qualify-product-link-"));
    scratches.push(scratch);
    const kernelDir = path.join(scratch, "installed", "kernel");
    execFileSync("mkdir", ["-p", kernelDir]);
    const repoDir = path.join(scratch, "repo");
    buildDisposableRepository(repoDir, DISPOSABLE_SPECS[0]!, kernelDir);

    const link = path.join(repoDir, "node_modules", "@agent-delivery-harness", "kernel");
    expect(existsSync(link)).toBe(true);
    expect(execFileSync("readlink", [link], { encoding: "utf8" }).trim()).toBe(kernelDir);
  });
});

describe("the composed observation verdict", () => {
  /** A finished run that proved everything, as the lane would report it. */
  const OBSERVED = {
    generationDigest: "a".repeat(64),
    installationId: "install-0",
    workflowGraphSha256: "b".repeat(64),
    repositoriesDelivered: CLEAN.delivered,
    distinctGateConfigDigests: DISPOSABLE_SPECS.length,
    productProcessInventory: ["git", "node"],
    perRepositoryProcessInventory: CLEAN.perRepositoryProcessInventory,
    negativeProbesSatisfied: CLEAN.negativeProbesSatisfied,
    lifecycleStepsProven: CLEAN.lifecycleStepsProven,
  };

  it("reports nothing on a run that proved everything", () => {
    expect(decideObservations(OBSERVED, DISPOSABLE_SPECS.length)).toEqual([]);
  });

  // BOTH halves must be reachable HERE, because the wiring test below drives a
  // run that delivered nothing — and a run that delivered nothing has no policy
  // comparison to make, so it can only ever witness the vacuity half. Dropping
  // the policy rule from the composition is caught by this case and by nothing
  // else.
  it("carries the policy-independence verdict, which a delivered-nothing run cannot witness", () => {
    const findings = decideObservations({ ...OBSERVED, distinctGateConfigDigests: 1 }, DISPOSABLE_SPECS.length);
    expect(findings.map((finding) => finding.rule)).toContain("policy-independence");
  });

  it("carries the anti-vacuity verdict too", () => {
    const findings = decideObservations({ ...OBSERVED, repositoriesDelivered: [] }, DISPOSABLE_SPECS.length);
    expect(findings.map((finding) => finding.subject)).toContain("repositories");
  });
});

describe("the lane's own wiring", () => {
  // FINDING THIS SUITE EXISTS FOR. Every rule above is a pure function, and a
  // pure function nobody calls decides nothing. If the observation-level
  // judgements were ever detached from the lane's exit, a run that drove zero
  // repositories and proved zero probes would report `clean` — the exact
  // vacuous pass those rules exist to prevent. So the lane is driven here for
  // real, on an input that cannot get past its first step, and required to
  // come back with those findings rather than an empty list.
  it("applies the observation rules on every exit, including the earliest failure", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "qualify-product-wiring-"));
    scratches.push(scratch);
    // A source root with no packages: `npm pack` cannot run, so the lane fails
    // at its first step and returns long before any decision "step".
    const result = await runProductQualification({ sourceRoot: scratch, workRoot: scratch });

    const subjects = result.findings.map((finding) => finding.subject);
    expect(subjects).toContain("repositories");
    for (const probe of REQUIRED_NEGATIVE_PROBES) expect(subjects, probe).toContain(probe);
    for (const step of REQUIRED_LIFECYCLE_STEPS) expect(subjects, step).toContain(step);
    expect(result.observations.repositoriesDelivered).toEqual([]);
  }, 120_000);
});
