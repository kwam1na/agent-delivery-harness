/**
 * The pre-cutover exactly-one-discovery guard, falsified.
 *
 * Each of the guard's five positions gets a planted defect, and each rule that
 * could over-reach gets a companion row proving the neighbouring legitimate
 * case still passes — an exclusivity claim a graded host CAN deliver, an honest
 * negative consumption record, a projection in a real managed worktree, a
 * resolvable product commit, and a complete comparison set. The baseline row
 * runs against the real `.agents/policy/` through the real guard.
 *
 * Most rows inject the guard's observations so a defect can be planted without
 * a filesystem to plant it in. That is a hazard in itself: injected-away
 * detectors are asserted only by their silence, which is free when the detector
 * never runs. "The guard's own observations, with nothing injected" is the row
 * that keeps them honest — it builds a real repository carrying real drift, a
 * real out-of-scope projection, and a real ambient discovery root, and runs the
 * production code paths against it.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  AMBIENT_DISCOVERY_LAYOUT_DIGEST,
  AMBIENT_DISCOVERY_ROOTS,
  SHADOW_ACTIVATION_FILE,
  SHADOW_GATE_RECORD_FILE,
  computeAmbientDiscoveryLayoutDigest,
  repoRootFromHere,
  resolveCommitTypeFromGit,
  runShadowDiscoveryGuard,
} from "./shadow-discovery-guard.ts";
import { POLICY_PROJECTION_DIR } from "./policy-projection-check.ts";

const ROOT = repoRootFromHere();
const POLICY_DIR = path.join(ROOT, POLICY_PROJECTION_DIR);

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Plant = {
  activation?: (value: any) => void;
  gateRecord?: (value: any) => void;
  raw?: { activation?: string; gateRecord?: string };
};

async function plantPolicyDir(plant: Plant) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shadow-guard-"));
  temps.push(dir);
  const policyDir = path.join(dir, "policy");
  await mkdir(policyDir, { recursive: true });
  const activation = JSON.parse(await readFile(path.join(POLICY_DIR, SHADOW_ACTIVATION_FILE), "utf8"));
  const gateRecord = JSON.parse(await readFile(path.join(POLICY_DIR, SHADOW_GATE_RECORD_FILE), "utf8"));
  plant.activation?.(activation);
  plant.gateRecord?.(gateRecord);
  await writeFile(
    path.join(policyDir, SHADOW_ACTIVATION_FILE),
    plant.raw?.activation ?? `${JSON.stringify(activation, null, 2)}\n`,
  );
  await writeFile(
    path.join(policyDir, SHADOW_GATE_RECORD_FILE),
    plant.raw?.gateRecord ?? `${JSON.stringify(gateRecord, null, 2)}\n`,
  );
  return policyDir;
}

type GuardOptions = Parameters<typeof runShadowDiscoveryGuard>[1];

/**
 * Runs the guard with the real layout observations neutralised by default, and
 * with commit resolution injected.
 *
 * Commit resolution is injected so both branches of the rule can be driven from
 * one row each, without depending on which objects the checkout happens to
 * carry: a pinned commit absent from a shallow clone and a fabricated one look
 * identical to git. Real git is exercised alongside, by a scratch-repository
 * row and by the row that reads the pinned tree — CI checks out full history
 * for the latter — while the live resolution against the real activation is
 * what `npm run sensor:shadow` performs.
 */
async function guard(plant: Plant, options: GuardOptions = {}) {
  const policyDir = await plantPolicyDir(plant);
  return runShadowDiscoveryGuard(ROOT, {
    policyDir,
    observedLayoutDigest: AMBIENT_DISCOVERY_LAYOUT_DIGEST,
    observedLayoutWorkingTree: "",
    resolveCommitType: () => "commit",
    ...options,
  });
}

const codes = (result: Awaited<ReturnType<typeof runShadowDiscoveryGuard>>) =>
  result.findings.map((finding) => finding.code);
const observed = (result: Awaited<ReturnType<typeof runShadowDiscoveryGuard>>) =>
  result.observations.map((observation) => observation.code);

/** One affirmative, well-formed, binding-sourced delivery entry. */
const admissibleDelivery = (id: string, category: string) => ({
  id,
  category,
  countedInComparisonSet: true,
  projectionConsumption: {
    source: "binding",
    affirmative: true,
    projectionDigest: "a".repeat(64),
    marker: { deliveryId: id, fence: 1, consumed: "skills/agent-skills-core-v1.zip" },
  },
});

describe("the real shadow-window posture", () => {
  it("holds, with the comparison set honestly reported as incomplete", async () => {
    // Commit resolution injected for the clone-depth reason above; everything
    // else here is the real artifact observed through the real guard.
    const result = await runShadowDiscoveryGuard(ROOT, { resolveCommitType: () => "commit" });
    expect(result.findings).toEqual([]);
    expect(result.status).toBe("pass");
    expect(observed(result)).toContain("comparison_set_incomplete");
    expect(result.countedDeliveryIds).toEqual([]);
  });

  it("planting nothing reproduces the pass through the scratch copy", async () => {
    const result = await guard({});
    expect(result.status).toBe("pass");
  });
});

describe("posture", () => {
  it("refuses an activation that is no longer in shadow mode", async () => {
    const result = await guard({
      activation: (value) => {
        value.installationMode = "authoritative";
      },
    });
    expect(codes(result)).toContain("activation_not_shadow");
  });

  it("refuses an activation that claims delivery authority", async () => {
    const result = await guard({
      activation: (value) => {
        value.deliveryAuthority = "full";
      },
    });
    expect(codes(result)).toContain("delivery_authority_claimed");
  });
});

describe("the exclusivity downgrade", () => {
  it("refuses a blocking claim while the proving host is exclusivity-ungraded", async () => {
    const result = await guard({
      activation: (value) => {
        value.exclusivityPosition.duringShadowWindow = "blocking";
      },
    });
    expect(codes(result)).toContain("exclusivity_position_unsupported");
  });

  it("refuses a blocking claim on a grading it does not recognise", async () => {
    // Keying on the ABSENCE of the ungraded token would read this as capable
    // and admit the very claim the window may not make.
    const result = await guard({
      activation: (value) => {
        value.exclusivityPosition.duringShadowWindow = "blocking";
        value.hosts[0].exclusivityGrading = "exclusivity-probably-fine";
      },
    });
    expect(codes(result)).toContain("exclusivity_position_unsupported");
  });

  it("admits a blocking claim once the proving host is exclusivity-graded", async () => {
    // The over-reach row: the rule must not refuse every blocking claim.
    const result = await guard({
      activation: (value) => {
        value.exclusivityPosition.duringShadowWindow = "blocking";
        value.hosts[0].exclusivityGrading = "exclusivity-graded";
      },
    });
    expect(codes(result)).not.toContain("exclusivity_position_unsupported");
  });

  it("records coexistence as a non-blocking observation on an ungraded host", async () => {
    const result = await guard(
      {},
      {
        worktree: {
          dir: path.join(ROOT, ".worktrees/managed/x"),
          projectionPresent: true,
          ambientDiscoveryVisible: true,
        },
      },
    );
    expect(observed(result)).toContain("exclusivity_non_blocking");
    expect(codes(result)).not.toContain("discovery_exclusivity_violation");
    expect(result.status).toBe("pass");
  });

  it("turns the same coexistence into a finding once the proving host is graded", async () => {
    const result = await guard(
      {
        activation: (value) => {
          value.hosts[0].exclusivityGrading = "exclusivity-graded";
        },
      },
      {
        worktree: {
          dir: path.join(ROOT, ".worktrees/managed/x"),
          projectionPresent: true,
          ambientDiscoveryVisible: true,
        },
      },
    );
    expect(codes(result)).toContain("discovery_exclusivity_violation");
    expect(observed(result)).not.toContain("exclusivity_non_blocking");
  });
});

describe("the guard's own observations, with nothing injected", () => {
  it("detects drift, scope, and coexistence on a real tree it actually looks at", async () => {
    // Every other row in this file injects `worktree`, `observedLayoutDigest`,
    // or `observedLayoutWorkingTree`, and the baseline row runs against a tree
    // where all three conditions are absent — so the suite would otherwise
    // assert only these detectors' SILENCE on a tree with nothing to detect.
    // This row exercises the production code paths `npm run sensor:shadow`
    // runs: the git working-tree observation, the projection-presence probe,
    // and the ambient-discovery probe. It uses `.claude` specifically — the
    // proving host's own discovery root, and the likeliest ambient second
    // source this position exists to catch — so this row also holds that one
    // root in the constant. The rest of the set is pinned whole by "pins the
    // whole root set, not a member of it"; neither claim belongs to the digest,
    // which is the digest of the empty set and cannot notice a root being
    // removed.
    const dir = await mkdtemp(path.join(os.tmpdir(), "shadow-real-"));
    temps.push(dir);
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    const policyDir = path.join(dir, ".agents", "policy");
    await mkdir(policyDir, { recursive: true });
    for (const file of [SHADOW_ACTIVATION_FILE, SHADOW_GATE_RECORD_FILE]) {
      await writeFile(path.join(policyDir, file), await readFile(path.join(POLICY_DIR, file), "utf8"));
    }
    git("add", "-A");
    git("commit", "--quiet", "--no-gpg-sign", "-m", "base");

    await mkdir(path.join(dir, ".claude", "skills"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "skills", "SKILL.md"), "ambient\n");
    await mkdir(path.join(dir, ".managed-projection"), { recursive: true });

    const result = await runShadowDiscoveryGuard(dir, { policyDir });
    expect(codes(result)).toContain("ambient_discovery_drift");
    expect(codes(result)).toContain("projection_outside_managed_worktree");
    expect(observed(result)).toContain("exclusivity_non_blocking");
    // The scratch repository does not carry the product commit, so the fifth
    // position fires here too — recorded rather than injected away, because
    // that is the honest behaviour of an unresolvable pin.
    expect(codes(result)).toContain("product_commit_unresolvable");
  });
});

describe("the pinned product commit", () => {
  it("is a full 40-character object id in the real activation", async () => {
    // The half that holds whatever objects the checkout carries. The other
    // half — that it resolves — is what `npm run sensor:shadow` enforces, and
    // what the scratch-repository row below proves works.
    const activation = JSON.parse(await readFile(path.join(POLICY_DIR, SHADOW_ACTIVATION_FILE), "utf8"));
    expect(activation.product.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("names a generation whose tree carries the binding-side gate-record writer and the canonicalized write-path interceptor", async () => {
    // The pin is what decides whether a shadow delivery can produce an
    // admissible gate-record entry at all: a generation without the writer
    // materializes a projection and records nothing, and one without the
    // canonicalized write path denies legitimate writes in the temp-directory
    // worktree shape the shadow window uses. Both are properties of the pinned
    // TREE, so both are read out of it rather than out of the checkout.
    const activation = JSON.parse(await readFile(path.join(POLICY_DIR, SHADOW_ACTIVATION_FILE), "utf8"));
    const pin = activation.product.commit as string;
    const show = (spec: string): string | undefined => {
      try {
        return execFileSync("git", ["-C", ROOT, "show", spec], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return undefined;
      }
    };
    const writer = show(`${pin}:packages/kernel/src/host/consumption-gate-record.ts`);
    const interceptor = show(`${pin}:packages/kernel/src/host/hook-main.ts`);
    if (writer === undefined && interceptor === undefined) {
      // A shallow clone genuinely does not carry the pinned commit. Reading
      // nothing is excused only there, so the excuse itself is asserted — in a
      // full clone an unreadable pin stays a failure, and CI checks out full
      // history precisely so this row is not excused on every hosted run.
      expect(
        execFileSync("git", ["-C", ROOT, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim(),
      ).toBe("true");
      return;
    }
    const absent = "<the pinned tree carries no such file>";
    expect(writer ?? absent).toContain("emitProjectionConsumptionRecord");
    expect(interceptor ?? absent).toContain("walkPath");
  });

  it("refuses an id that does not resolve to a commit", async () => {
    const result = await guard({}, { resolveCommitType: () => undefined });
    expect(codes(result)).toContain("product_commit_unresolvable");
  });

  it("refuses an id that resolves to something other than a commit", async () => {
    const result = await guard({}, { resolveCommitType: () => "blob" });
    expect(codes(result)).toContain("product_commit_unresolvable");
  });

  it("refuses an abbreviated id", async () => {
    const result = await guard({
      activation: (value) => {
        value.product.commit = "a88ac86";
      },
    });
    expect(codes(result)).toContain("product_commit_unresolvable");
  });

  it("accepts an id that resolves to a commit", async () => {
    // The over-reach row: the rule must not refuse every pin.
    const result = await guard({});
    expect(codes(result)).not.toContain("product_commit_unresolvable");
  });

  it("resolves real commits through real git, and rejects a fabricated tail", async () => {
    // The row that would have caught the defect this rule was added for: a
    // fabricated 40-character id sharing a real abbreviated prefix.
    const dir = await mkdtemp(path.join(os.tmpdir(), "product-commit-"));
    temps.push(dir);
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await writeFile(path.join(dir, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "--quiet", "--no-gpg-sign", "-m", "one");
    const real = git("rev-parse", "HEAD").trim();
    expect(resolveCommitTypeFromGit(dir, real)).toBe("commit");
    // Same seven-character prefix, invented tail — indistinguishable by eye.
    const fabricated = `${real.slice(0, 7)}${"f".repeat(33)}`;
    expect(fabricated).not.toBe(real);
    expect(resolveCommitTypeFromGit(dir, fabricated)).toBeUndefined();
    // A tree id is a real object that is not a commit.
    const tree = git("rev-parse", "HEAD^{tree}").trim();
    expect(resolveCommitTypeFromGit(dir, tree)).toBe("tree");
  });
});

describe("ambient-discovery neutrality", () => {
  it("pins the layout this repository actually has", async () => {
    expect(computeAmbientDiscoveryLayoutDigest(ROOT)).toBe(AMBIENT_DISCOVERY_LAYOUT_DIGEST);
  });

  it("the pin is not free: a tracked ambient discovery root changes it", async () => {
    // The positive half of an emptiness claim. Without this row the pinned
    // digest would be indistinguishable from a value nobody can move.
    const dir = await mkdtemp(path.join(os.tmpdir(), "ambient-layout-"));
    temps.push(dir);
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    expect(computeAmbientDiscoveryLayoutDigest(dir)).toBe(AMBIENT_DISCOVERY_LAYOUT_DIGEST);
    await mkdir(path.join(dir, AMBIENT_DISCOVERY_ROOTS[1]!), { recursive: true });
    await writeFile(path.join(dir, AMBIENT_DISCOVERY_ROOTS[1]!, "SKILL.md"), "ambient\n");
    git("add", "-A");
    git("commit", "--quiet", "--no-gpg-sign", "-m", "ambient");
    expect(computeAmbientDiscoveryLayoutDigest(dir)).not.toBe(AMBIENT_DISCOVERY_LAYOUT_DIGEST);
  });

  it("pins the whole root set, not a member of it", async () => {
    // The digest pin cannot defend this constant: it is the digest of the EMPTY
    // set, so REMOVING a root moves nothing. Every root is a pathspec for the
    // index digest, the working-tree porcelain check, and the visibility probe
    // at once, so a dropped root silently blinds all three to exactly the
    // ambient second source this position exists to catch. Membership
    // assertions would leave the unnamed roots free, so the set is pinned
    // whole.
    //
    // `.agents` is deliberately absent: `.agents/policy` changes on its own
    // schedule, and a guard that fired on it is one an operator learns to
    // ignore. `.agents/skills` and `.agents/agents` are the discovery-bearing
    // subtrees under it.
    expect([...AMBIENT_DISCOVERY_ROOTS]).toEqual([
      ".agent-skills",
      ".agents/skills",
      ".agents/agents",
      ".claude",
      ".codex",
    ]);
    expect(AMBIENT_DISCOVERY_ROOTS).not.toContain(".agents");
  });

  it("reports index drift", async () => {
    const result = await guard({}, { observedLayoutDigest: "b".repeat(64) });
    expect(codes(result)).toContain("ambient_discovery_drift");
  });

  it("reports working-tree drift the index cannot see", async () => {
    const result = await guard({}, { observedLayoutWorkingTree: "?? .claude/skills/x/SKILL.md" });
    expect(codes(result)).toContain("ambient_discovery_drift");
  });
});

describe("projection scope", () => {
  const scoped = (dir: string) =>
    guard({}, { worktree: { dir, projectionPresent: true, ambientDiscoveryVisible: false } });

  it("accepts a projection inside a managed delivery worktree", async () => {
    const result = await scoped(path.join(ROOT, ".worktrees/managed/delivery-1"));
    expect(codes(result)).not.toContain("projection_outside_managed_worktree");
  });

  it("refuses a projection at the repository root", async () => {
    const result = await scoped(ROOT);
    expect(codes(result)).toContain("projection_outside_managed_worktree");
  });

  it("refuses a projection in a non-managed worktree", async () => {
    const result = await scoped(path.join(ROOT, ".worktrees/v26-1494"));
    expect(codes(result)).toContain("projection_outside_managed_worktree");
  });

  it("refuses a sibling path that only looks managed", async () => {
    const result = await scoped(path.join(ROOT, ".worktrees/managed-delivery-1"));
    expect(codes(result)).toContain("projection_outside_managed_worktree");
  });

  it("a degenerate managed root narrows nothing and still refuses", async () => {
    const result = await guard(
      {
        activation: (value) => {
          value.projection.managedDeliveryWorktreeRoot = "";
        },
      },
      {
        worktree: {
          dir: path.join(ROOT, ".worktrees/managed/delivery-1"),
          projectionPresent: true,
          ambientDiscoveryVisible: false,
        },
      },
    );
    expect(codes(result)).toContain("projection_outside_managed_worktree");
  });

  it("says nothing about a tree that carries no projection", async () => {
    const result = await guard(
      {},
      { worktree: { dir: ROOT, projectionPresent: false, ambientDiscoveryVisible: false } },
    );
    expect(codes(result)).not.toContain("projection_outside_managed_worktree");
  });
});

describe("binding-sourced consumption records", () => {
  const withDeliveries = (deliveries: unknown[]) =>
    guard({
      gateRecord: (value) => {
        value.deliveries = deliveries;
      },
    });

  it("counts a well-formed binding-sourced delivery", async () => {
    const result = await withDeliveries([admissibleDelivery("d-1", "code")]);
    expect(result.countedDeliveryIds).toEqual(["d-1"]);
    expect(codes(result)).toEqual([]);
  });

  it("rejects an agent-supplied claim", async () => {
    const entry = admissibleDelivery("d-1", "code");
    entry.projectionConsumption.source = "session";
    const result = await withDeliveries([entry]);
    expect(codes(result)).toContain("agent_supplied_consumption_claim");
    expect(result.countedDeliveryIds).toEqual([]);
  });

  it("excludes a delivery with no record at all", async () => {
    const result = await withDeliveries([{ id: "d-1", category: "code" }]);
    expect(codes(result)).toContain("consumption_record_missing");
  });

  it("accepts an honest negative without calling it a defect", async () => {
    const result = await withDeliveries([
      {
        id: "d-1",
        category: "code",
        countedInComparisonSet: false,
        projectionConsumption: { source: "binding", affirmative: false },
      },
    ]);
    expect(codes(result)).toEqual([]);
    expect(result.countedDeliveryIds).toEqual([]);
  });

  it("refuses a non-boolean affirmative flag", async () => {
    const entry = admissibleDelivery("d-1", "code");
    (entry.projectionConsumption as any).affirmative = "yes";
    const result = await withDeliveries([entry]);
    expect(codes(result)).toContain("consumption_record_shape");
  });

  it("refuses an affirmation without the receipted projection digest", async () => {
    const entry = admissibleDelivery("d-1", "code");
    entry.projectionConsumption.projectionDigest = "not-a-digest";
    const result = await withDeliveries([entry]);
    expect(codes(result)).toContain("consumption_record_shape");
  });

  it("refuses a marker minted for another run", async () => {
    const entry = admissibleDelivery("d-1", "code");
    entry.projectionConsumption.marker.deliveryId = "d-2";
    const result = await withDeliveries([entry]);
    expect(codes(result)).toContain("consumption_record_shape");
  });

  it("refuses a marker with no numeric invocation fence", async () => {
    const entry = admissibleDelivery("d-1", "code");
    (entry.projectionConsumption.marker as any).fence = "1";
    const result = await withDeliveries([entry]);
    expect(codes(result)).toContain("consumption_record_shape");
  });

  it("refuses a marker that names no consumed workflow source", async () => {
    const entry = admissibleDelivery("d-1", "code");
    entry.projectionConsumption.marker.consumed = "";
    const result = await withDeliveries([entry]);
    expect(codes(result)).toContain("consumption_record_shape");
  });
});

describe("the comparison set", () => {
  const withDeliveries = (deliveries: unknown[]) =>
    guard({
      gateRecord: (value) => {
        value.deliveries = deliveries;
      },
    });

  it("refuses a delivery counted without an admissible record", async () => {
    const result = await withDeliveries([
      { id: "d-1", category: "code", countedInComparisonSet: true },
    ]);
    expect(codes(result)).toContain("comparison_set_admission_defect");
  });

  it("refuses the same run counted twice", async () => {
    const entry = admissibleDelivery("d-1", "code");
    const result = await withDeliveries([entry, JSON.parse(JSON.stringify(entry))]);
    expect(codes(result)).toContain("comparison_set_admission_defect");
    expect(result.countedDeliveryIds).toEqual(["d-1"]);
  });

  it("refuses a category the baseline mix does not include", async () => {
    const result = await withDeliveries([admissibleDelivery("d-1", "vibes")]);
    expect(codes(result)).toContain("comparison_set_mix_defect");
  });

  it("refuses a category named after a prototype member", async () => {
    const result = await withDeliveries([admissibleDelivery("d-1", "constructor")]);
    expect(codes(result)).toContain("comparison_set_mix_defect");
  });

  it("refuses more deliveries in a category than the baseline mix allows", async () => {
    const result = await withDeliveries([
      admissibleDelivery("d-1", "code"),
      admissibleDelivery("d-2", "code"),
    ]);
    expect(codes(result)).toContain("comparison_set_mix_defect");
  });

  it("stops reporting the set as incomplete once it matches the baseline mix", async () => {
    const result = await withDeliveries([
      admissibleDelivery("d-1", "code"),
      admissibleDelivery("d-2", "docs"),
      admissibleDelivery("d-3", "operations"),
    ]);
    expect(observed(result)).not.toContain("comparison_set_incomplete");
    expect(result.countedDeliveryIds).toEqual(["d-1", "d-2", "d-3"]);
    expect(codes(result)).toEqual([]);
  });

  it("treats an unparseable required total as incomplete rather than scorable", async () => {
    const result = await guard({
      gateRecord: (value) => {
        value.comparisonSetRequirement.total = "three";
        value.deliveries = [admissibleDelivery("d-1", "code")];
      },
    });
    expect(observed(result)).toContain("comparison_set_incomplete");
  });
});

describe("unreadable and wrong-shaped artifacts", () => {
  it("reports a missing artifact rather than throwing", async () => {
    const policyDir = await plantPolicyDir({});
    await rm(path.join(policyDir, SHADOW_GATE_RECORD_FILE));
    const result = await runShadowDiscoveryGuard(ROOT, { policyDir });
    expect(codes(result)).toEqual(["artifact_unreadable"]);
  });

  it("reports invalid JSON rather than throwing", async () => {
    const result = await guard({ raw: { activation: "{" } });
    expect(codes(result)).toContain("artifact_unreadable");
  });

  it("reports a shape whose accessors throw rather than crashing the guard", async () => {
    // A non-string projection root makes path.join throw inside the default
    // worktree observation — the one genuinely throwing accessor in the
    // evaluator, and what the backstop exists for.
    const result = await guard(
      {
        activation: (value) => {
          value.projection.root = 5;
        },
      },
      { worktree: undefined },
    );
    expect(codes(result)).toContain("artifact_unreadable");
    expect(result.status).toBe("fail");
  });

  it("tolerates a gate record with no deliveries member without inventing a count", async () => {
    const result = await guard({ raw: { gateRecord: "[]" } });
    expect(result.countedDeliveryIds).toEqual([]);
    expect(observed(result)).toContain("comparison_set_incomplete");
    expect(codes(result)).toEqual([]);
  });
});
