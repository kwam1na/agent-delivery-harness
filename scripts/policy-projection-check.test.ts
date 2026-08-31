/**
 * The read-only policy-projection comparison, falsified.
 *
 * Every rule gets a planted defect that the real repository does not have, and
 * — where a rule could over-reach — a companion row proving it does NOT fire on
 * the neighbouring legitimate case. The baseline row runs against the real
 * `.agents/policy/` through the real sensor, because a fixture only ever
 * asserts what it was built to contain.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { COMMANDS } from "@agent-delivery-harness/cli";
import { DELIVERY_RECORD_DRIFT_CLASSES, PREPARATION_FAILURE_CLASSES } from "@agent-delivery-harness/kernel";

import {
  PERSONA_DIR,
  PERSONA_FILES,
  POLICY_PROJECTION_DIR,
  PRE_CUTOVER_ORACLE_DIGEST,
  parseReleaseSurfaceFilters,
  pathFilterMatches,
  repoRootFromHere,
  runPolicyProjectionCheck,
  selectActivatedSensors,
} from "./policy-projection-check.ts";

const ROOT = repoRootFromHere();
const POLICY_DIR = path.join(ROOT, POLICY_PROJECTION_DIR);
const PERSONA_SOURCE = path.join(ROOT, PERSONA_DIR);

const FILES = [
  "repository-policy.json",
  "adapters.json",
  "pre-cutover-oracle.json",
  "compiled-snapshot.json",
  "comparison-report.json",
] as const;

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Mutation = {
  /** Mutate the parsed artifacts in place. */
  edit?: (artifacts: Record<string, any>) => void;
  /** Overwrite one artifact with raw bytes (for shape and JSON defects). */
  raw?: Partial<Record<(typeof FILES)[number], string>>;
  /** Overwrite one reviewer charter's bytes. */
  personas?: Partial<Record<string, string>>;
  /** Charters to omit from the scratch persona directory. */
  omitPersonas?: readonly string[];
};

/** A scratch copy of the real projection with one defect planted in it. */
async function plant(mutation: Mutation) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "policy-projection-"));
  temps.push(dir);
  const policyDir = path.join(dir, "policy");
  const personaDir = path.join(dir, "personas");
  await rm(policyDir, { recursive: true, force: true });
  const artifacts: Record<string, any> = {};
  const original: Record<string, string> = {};
  const before: Record<string, string> = {};
  for (const file of FILES) {
    original[file] = await readFile(path.join(POLICY_DIR, file), "utf8");
    artifacts[file] = JSON.parse(original[file]!);
    before[file] = JSON.stringify(artifacts[file]);
  }
  mutation.edit?.(artifacts);
  await mkdir(policyDir, { recursive: true });
  await mkdir(personaDir, { recursive: true });
  for (const file of FILES) {
    const raw = mutation.raw?.[file];
    // Untouched artifacts are copied byte for byte. Re-serializing them would
    // move their digests and produce staleness findings of the harness's own
    // making, which would drown the planted one.
    const changed = JSON.stringify(artifacts[file]) !== before[file];
    await writeFile(
      path.join(policyDir, file),
      raw ?? (changed ? `${JSON.stringify(artifacts[file], null, 2)}\n` : original[file]!),
    );
  }
  for (const [personaId, fileName] of Object.entries(PERSONA_FILES)) {
    if (mutation.omitPersonas?.includes(personaId)) continue;
    const override = mutation.personas?.[personaId];
    await writeFile(
      path.join(personaDir, fileName),
      override ?? (await readFile(path.join(PERSONA_SOURCE, fileName), "utf8")),
    );
  }
  return { policyDir, personaDir };
}

async function check(mutation: Mutation) {
  const { policyDir, personaDir } = await plant(mutation);
  return runPolicyProjectionCheck(ROOT, { policyDir, personaDir });
}

const codes = (result: Awaited<ReturnType<typeof runPolicyProjectionCheck>>) =>
  result.findings.map((finding) => finding.code);

describe("the real projection", () => {
  it("passes against the repository's own delivery authority", async () => {
    const result = await runPolicyProjectionCheck(ROOT);
    expect(result.findings).toEqual([]);
    expect(result.status).toBe("pass");
  });

  it("planting nothing still reproduces the pass through the scratch copy", async () => {
    // Anti-vacuity for every planted row below: if the copy itself failed, a
    // planted finding would prove nothing about the plant.
    const result = await check({});
    expect(result.status).toBe("pass");
  });

  it("pins the oracle bytes that are actually on disk", async () => {
    const bytes = await readFile(path.join(POLICY_DIR, "pre-cutover-oracle.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(PRE_CUTOVER_ORACLE_DIGEST);
  });
});

describe("recorded artifacts stay bound to their inputs", () => {
  it("reports a digest mismatch when the immutable oracle is edited", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].capturedAt = "2027-01-01";
      },
    });
    expect(codes(result)).toContain("oracle_digest_mismatch");
  });

  it("reports a stale snapshot when the document changes without recompiling", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].policyGeneration = 2;
      },
    });
    expect(codes(result)).toContain("snapshot_input_stale");
  });

  it("reports a stale report when the recorded snapshot is hand-edited", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["compiled-snapshot.json"].compiledWith.commit = "hand-edited";
      },
    });
    expect(codes(result)).toContain("report_input_stale");
  });

  it("reports compile drift when the recorded compile no longer matches a fresh one", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["compiled-snapshot.json"].compiled.snapshot.repositoryId = "somebody-else";
      },
    });
    expect(codes(result)).toContain("compile_drift");
  });
});

describe("the planted compile rejections the comparison report claims", () => {
  const rejectionOf = async (mutation: Mutation) => {
    const result = await check(mutation);
    return result.findings
      .filter((finding) => finding.code === "compile_rejected")
      .map((finding) => finding.message);
  };
  const contains = (messages: string[], code: string) =>
    messages.some((message) => message.includes(`[${code}]`));

  it("duplicate-obligation reaches duplicate_obligation", async () => {
    const messages = await rejectionOf({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].obligations.push({ obligationId: "review.green" });
      },
    });
    expect(contains(messages, "duplicate_obligation")).toBe(true);
  });

  it("merge granted and forbidden reaches contradictory_authority", async () => {
    const messages = await rejectionOf({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].grantedAuthority.push("merge");
      },
    });
    expect(contains(messages, "contradictory_authority")).toBe(true);
  });

  it("a merge finish line without merge authority reaches contradictory_finish_line", async () => {
    const messages = await rejectionOf({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].grantedFinishLines.push("merge");
        artifacts["repository-policy.json"].forbiddenAuthority = ["deploy"];
      },
    });
    expect(contains(messages, "contradictory_finish_line")).toBe(true);
  });

  it("a required capability with no adapter reaches capability_unavailable", async () => {
    const messages = await rejectionOf({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].requiredCapabilities.push({
          capabilityId: "sensor.imaginary",
          kind: "sensor",
          version: "1",
        });
      },
    });
    expect(contains(messages, "capability_unavailable")).toBe(true);
  });

  it("a privileged credential in a model grant reaches privileged_credential_in_model_grant", async () => {
    const messages = await rejectionOf({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].checkpoints[1].credentials = ["credential.merge"];
      },
    });
    expect(contains(messages, "privileged_credential_in_model_grant")).toBe(true);
  });

  it("an unknown document member reaches unknown_member", async () => {
    const messages = await rejectionOf({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].notAMember = true;
      },
    });
    expect(contains(messages, "unknown_member")).toBe(true);
  });

  it("a duplicated adapter reaches duplicate_capability", async () => {
    const messages = await rejectionOf({
      edit: (artifacts) => {
        artifacts["adapters.json"].push(artifacts["adapters.json"][0]);
      },
    });
    expect(contains(messages, "duplicate_capability")).toBe(true);
  });

  it("a charter whose bytes are not in the tree reaches persona_unresolvable", async () => {
    const messages = await rejectionOf({
      personas: { "persona.testing-policy": "a different charter\n" },
    });
    expect(contains(messages, "persona_unresolvable")).toBe(true);
  });

  it("dropping the testing-policy lens reaches mandatory_lens_missing", async () => {
    const messages = await rejectionOf({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].reviewLenses = [
          artifacts["repository-policy.json"].reviewLenses[0],
        ];
      },
    });
    expect(contains(messages, "mandatory_lens_missing")).toBe(true);
  });

  it("authority with no executable adapter reaches prose_only_authority", async () => {
    const messages = await rejectionOf({
      edit: (artifacts) => {
        artifacts["adapters.json"] = artifacts["adapters.json"].filter(
          (adapter: any) => adapter.kind !== "pr-creation",
        );
        artifacts["repository-policy.json"].requiredCapabilities = artifacts[
          "repository-policy.json"
        ].requiredCapabilities.filter((entry: any) => entry.kind !== "pr-creation");
      },
    });
    expect(contains(messages, "prose_only_authority")).toBe(true);
  });

  it("every rejection class the comparison report claims is exercised above", async () => {
    const report = JSON.parse(
      await readFile(path.join(POLICY_DIR, "comparison-report.json"), "utf8"),
    );
    expect(Object.keys(report.results.plantedCompileRejections).sort()).toEqual(
      [
        "authority-without-an-adapter",
        "charter-digest-not-in-the-tree",
        "duplicate-adapter",
        "duplicate-obligation",
        "merge-finish-line-without-authority",
        "merge-granted-and-forbidden",
        "privileged-credential-in-model-grant",
        "required-capability-without-adapter",
        "testing-policy-lens-dropped",
        "unknown-document-member",
      ].sort(),
    );
  });

  it("a missing charter file is a typed finding, not a crash", async () => {
    const result = await check({ omitPersonas: ["persona.outcome-correctness"] });
    expect(codes(result)).toContain("artifact_unreadable");
    expect(codes(result)).toContain("compile_rejected");
  });
});

describe("phase parity against the live CLI registry", () => {
  it("the oracle's command set is exactly what the CLI registers today", async () => {
    const oracle = JSON.parse(await readFile(path.join(POLICY_DIR, "pre-cutover-oracle.json"), "utf8"));
    const fromOracle = [
      ...oracle.phaseVector.orderedPhases.map((entry: any) =>
        entry.command.replace(/^delivery-harness /, ""),
      ),
      ...oracle.phaseVector.standaloneCommands,
    ].sort();
    expect(fromOracle).toEqual(COMMANDS.map((command) => command.name).sort());
  });

  it("reports drift when a frozen phase names a command the CLI does not register", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].phaseVector.orderedPhases[0].command =
          "delivery-harness incant";
      },
    });
    expect(codes(result)).toContain("phase_drift");
  });

  it("reports drift when the check aggregate stops chaining a frozen constituent", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].phaseVector.checkSuiteConstituents = ["typecheck"];
      },
    });
    expect(codes(result)).toContain("phase_drift");
  });
});

describe("obligation and blocker vocabulary parity", () => {
  it("reports drift when the frozen activation kind is wrong", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].activationVector.obligations["review.green"].activation =
          "always";
      },
    });
    expect(codes(result)).toContain("obligation_drift");
  });

  it("reports drift when a waivable finding code is moved to the non-waivable list", async () => {
    const result = await check({
      edit: (artifacts) => {
        const frozen = artifacts["pre-cutover-oracle.json"].activationVector.obligations["review.green"];
        frozen.waivableCodes = frozen.waivableCodes.filter((code: string) => code !== "stale_evidence");
        frozen.nonWaivableCodes.push("stale_evidence");
      },
    });
    expect(codes(result)).toContain("obligation_drift");
  });

  it("reports drift when the document stops activating a live gate obligation", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].obligations = [{ obligationId: "outcome.verification" }];
      },
    });
    expect(codes(result)).toContain("obligation_drift");
  });

  it("freezes the live preparation and delivery-record vocabularies, not a copy of them", async () => {
    const oracle = JSON.parse(await readFile(path.join(POLICY_DIR, "pre-cutover-oracle.json"), "utf8"));
    expect(oracle.blockerVector.preparationFailureClasses).toEqual([...PREPARATION_FAILURE_CLASSES]);
    expect(oracle.blockerVector.deliveryRecordDriftClasses).toEqual([...DELIVERY_RECORD_DRIFT_CLASSES]);
  });

  it("reports drift when a frozen blocker vocabulary diverges from the live constant", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].blockerVector.preparationFailureClasses = ["missing"];
      },
    });
    expect(codes(result)).toContain("blocker_vocabulary_drift");
  });
});

describe("authority stays where the projection puts it", () => {
  it("reports drift when the document grants merge", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].grantedAuthority = ["pr-creation", "merge"];
        artifacts["repository-policy.json"].forbiddenAuthority = ["deploy"];
      },
    });
    expect(codes(result)).toContain("authority_drift");
  });

  it("reports a mapping defect when merge becomes a required capability", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].requiredCapabilities.push({
          capabilityId: "operation.merge",
          kind: "merge",
          version: "1",
        });
      },
    });
    expect(codes(result)).toContain("leaf_mapping_defect");
  });
});

describe("each leaf maps exactly once and no aggregate is a leaf", () => {
  it("reports a defect when two leaves map the same capability", async () => {
    const result = await check({
      edit: (artifacts) => {
        const leaves = artifacts["pre-cutover-oracle.json"].leafMappings;
        leaves.push({ ...leaves[0], leaf: "test-suite-again" });
      },
    });
    expect(codes(result)).toContain("leaf_mapping_defect");
  });

  it("reports a defect when an adapter is mapped by no leaf", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].leafMappings = artifacts[
          "pre-cutover-oracle.json"
        ].leafMappings.filter((mapping: any) => mapping.capabilityId !== "sensor.typecheck");
      },
    });
    expect(codes(result)).toContain("leaf_mapping_defect");
  });

  it("reports the aggregate when a leaf binds npm run check as its authority", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].leafMappings[0].authority = ["npm run check"];
      },
    });
    expect(codes(result)).toContain("aggregate_registered_as_leaf");
  });

  // Both aggregates, not just the first: "the release workflow is never a leaf"
  // is a claim of this delivery and needs its own falsification.
  it.each(["check", "release-checks-workflow"])(
    "reports the aggregate when the %s exclusion is dropped from the oracle",
    async (entrypoint) => {
      const result = await check({
        edit: (artifacts) => {
          artifacts["pre-cutover-oracle.json"].aggregateExclusions = artifacts[
            "pre-cutover-oracle.json"
          ].aggregateExclusions.filter((entry: any) => entry.entrypoint !== entrypoint);
        },
      });
      expect(codes(result)).toContain("aggregate_registered_as_leaf");
    },
  );

  it("reports a check constituent that no leaf claims", async () => {
    // The other half of exactly-one ownership. Without this row the rule could
    // be weakened from `!== 1` to `> 1` — catching only double-claims — and the
    // suite would stay green while a constituent of the aggregate owned by
    // nothing at all went unreported.
    const result = await check({
      edit: (artifacts) => {
        const leaf = artifacts["pre-cutover-oracle.json"].leafMappings.find(
          (mapping: any) => mapping.capabilityId === "sensor.test-suite",
        );
        leaf.authority = ["vitest, invoked some other way"];
      },
    });
    expect(codes(result)).toContain("aggregate_registered_as_leaf");
  });

  it("does not confuse npm run sensor with npm run sensor:cli", async () => {
    // The over-reach row: a prefix match would hand `npm run sensor` to the
    // import-boundary, CLI-inventory, and standalone-install leaves at once,
    // and the real projection would fail. It passes, and the leaves that
    // legitimately name the longer scripts survive the ownership check.
    const oracle = JSON.parse(await readFile(path.join(POLICY_DIR, "pre-cutover-oracle.json"), "utf8"));
    const authorityOf = (capabilityId: string) =>
      oracle.leafMappings.find((mapping: any) => mapping.capabilityId === capabilityId).authority;
    expect(authorityOf("sensor.import-boundaries").join(" ")).toContain("npm run sensor ");
    expect(authorityOf("sensor.cli-inventory").join(" ")).toContain("npm run sensor:cli");
    expect(authorityOf("sensor.standalone-install").join(" ")).toContain("npm run sensor:standalone");
    const result = await runPolicyProjectionCheck(ROOT);
    expect(codes(result)).not.toContain("aggregate_registered_as_leaf");
  });
});

describe("activation against the live release-surface path filters", () => {
  it("reads a non-empty filter set out of the real workflow", async () => {
    const filters = parseReleaseSurfaceFilters(
      await readFile(path.join(ROOT, ".github/workflows/release.yml"), "utf8"),
    );
    expect(filters.length).toBeGreaterThan(5);
    expect(filters).toContain("packages/*/src/**");
    expect(filters).toContain("scripts/check-release.ts");
  });

  it("matches the wildcard forms the workflow uses and no more", () => {
    expect(pathFilterMatches("packages/*/src/**", "packages/kernel/src/policy/compile.ts")).toBe(true);
    expect(pathFilterMatches("packages/*/src/**", "packages/kernel/README.md")).toBe(false);
    expect(pathFilterMatches("packages/*/package.json", "packages/cli/package.json")).toBe(true);
    expect(pathFilterMatches("packages/*/package.json", "packages/cli/src/package.json")).toBe(false);
    // The bare root entries must not swallow the per-package copies, which is
    // exactly why the workflow lists both forms.
    expect(pathFilterMatches("NOTICE", "packages/kernel/NOTICE")).toBe(false);
    expect(pathFilterMatches("packages/*/NOTICE", "packages/kernel/NOTICE")).toBe(true);
  });

  it("selects strictly more sensors for a release surface than for a docs change", async () => {
    const filters = parseReleaseSurfaceFilters(
      await readFile(path.join(ROOT, ".github/workflows/release.yml"), "utf8"),
    );
    const classes = {
      alwaysActive: ["sensor.a", "sensor.b"],
      releaseSurfaceActivated: ["sensor.release"],
      operatorInvoked: ["sensor.manual"],
    };
    const docs = selectActivatedSensors({
      changedPaths: ["docs/getting-started.md"],
      releaseFilters: filters,
      classes,
    });
    const release = selectActivatedSensors({
      changedPaths: ["packages/kernel/src/policy/compile.ts"],
      releaseFilters: filters,
      classes,
    });
    expect(docs).toEqual(["sensor.a", "sensor.b"]);
    expect(release).toEqual(["sensor.a", "sensor.b", "sensor.release"]);
    // The operator-invoked class is never selected by a path, on either side.
    expect(release).not.toContain("sensor.manual");
  });

  it("reports drift when a frozen selection vector no longer matches the live filters", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].activationVector.activationSelection[
          "docs-only-change"
        ].push("sensor.release-checks");
      },
    });
    expect(codes(result)).toContain("activation_drift");
  });

  it("reports drift when a sensor leaf is left unclassified", async () => {
    const result = await check({
      edit: (artifacts) => {
        const classes = artifacts["pre-cutover-oracle.json"].activationVector.sensorActivationClasses;
        classes.operatorInvoked = [];
      },
    });
    expect(codes(result)).toContain("activation_drift");
  });

  it("reports drift when a sensor leaf is classified twice", async () => {
    const result = await check({
      edit: (artifacts) => {
        const classes = artifacts["pre-cutover-oracle.json"].activationVector.sensorActivationClasses;
        classes.alwaysActive.push("sensor.release-checks");
      },
    });
    expect(codes(result)).toContain("activation_drift");
  });

  it("reports drift when a probe carries no frozen selection", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].activationVector.activationProbes["new-class"] = [
          "docs/x.md",
        ];
      },
    });
    expect(codes(result)).toContain("activation_drift");
  });

  it("reports drift when the workflow yields no readable path filters", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].activationVector.releaseSurfacePathFilterSource =
          ".github/workflows/ci.yml";
      },
    });
    expect(codes(result)).toContain("activation_drift");
  });
});

describe("generated artifacts and protected authority trees", () => {
  it("reports drift when a checkpoint stops protecting an authority tree", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["repository-policy.json"].checkpoints[1].additionalProtectedPaths = artifacts[
          "repository-policy.json"
        ].checkpoints[1].additionalProtectedPaths.filter((entry: string) => entry !== "delivery");
      },
    });
    expect(codes(result)).toContain("generated_ownership_drift");
  });

  it("reports drift when a compiled grant stops protecting an authority tree", async () => {
    const result = await check({
      edit: (artifacts) => {
        const grant = artifacts["compiled-snapshot.json"].compiled.checkpointGrants[0].grant;
        grant.protectedPaths = grant.protectedPaths.filter((entry: string) => entry !== ".agents");
      },
    });
    expect(codes(result)).toContain("generated_ownership_drift");
  });

  it("reports drift when the oracle's generated set diverges from the live gate's", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["pre-cutover-oracle.json"].generatedArtifactOwnership.groups[0].paths = [
          "packages/conformance",
        ];
      },
    });
    expect(codes(result)).toContain("generated_ownership_drift");
  });
});

describe("adjudications", () => {
  it("reports an emptied adjudication record", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["comparison-report.json"].adjudications = [];
      },
    });
    expect(codes(result)).toContain("adjudication_incomplete");
  });

  it("reports a blocking adjudication", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["comparison-report.json"].adjudications[0].blocking = true;
      },
    });
    expect(codes(result)).toContain("adjudication_incomplete");
  });

  it("reports an unrecognised disposition", async () => {
    const result = await check({
      edit: (artifacts) => {
        artifacts["comparison-report.json"].adjudications[0].disposition = "fine-probably";
      },
    });
    expect(codes(result)).toContain("adjudication_incomplete");
  });

  it("reports a duplicated adjudication id", async () => {
    const result = await check({
      edit: (artifacts) => {
        const adjudications = artifacts["comparison-report.json"].adjudications;
        adjudications.push({ ...adjudications[0] });
      },
    });
    expect(codes(result)).toContain("adjudication_incomplete");
  });
});

describe("unreadable and wrong-shaped artifacts", () => {
  it("reports a missing artifact rather than throwing", async () => {
    const { policyDir, personaDir } = await plant({});
    await rm(path.join(policyDir, "adapters.json"));
    const result = await runPolicyProjectionCheck(ROOT, { policyDir, personaDir });
    expect(codes(result)).toEqual(["artifact_unreadable"]);
  });

  it("reports invalid JSON rather than throwing", async () => {
    const result = await check({ raw: { "comparison-report.json": "{" } });
    expect(codes(result)).toContain("artifact_unreadable");
  });

  it("reports valid JSON of the wrong shape rather than throwing", async () => {
    const result = await check({ raw: { "pre-cutover-oracle.json": '{"schemaVersion":"nope"}' } });
    expect(result.status).toBe("fail");
    expect(codes(result)).toContain("artifact_unreadable");
  });
});
