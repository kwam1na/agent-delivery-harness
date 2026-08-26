/**
 * The four configurations, and the claims each of them makes.
 *
 * Loading is the easy half. The hard half is that the two synthetic configs
 * claim to *diverge* from the kit's — that is the entire value of running the
 * suites under them — and a claim like that decays silently. A fixture edited to
 * fix an unrelated failure can quietly converge on the config it was supposed to
 * differ from, and every suite stays green while the independence proof it was
 * built for stops proving anything.
 *
 * So divergence is asserted, dimension by dimension, against an enumerated fixed
 * set. Each synthetic config declares which dimensions it is not free to vary;
 * everything outside that list must differ from the kit's configuration, and the
 * dimension map itself is checked for completeness against the config's members
 * so a newly added member cannot escape the assertion by not being listed.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateHarnessConfig, type HarnessConfig } from "@agent-delivery-harness/kernel";
import harnessConfig from "../../../harness.config.ts";
import {
  KIT_DEFAULTED_DIMENSIONS,
  KIT_MAPPED_DIMENSIONS,
  KIT_NEGATIVE_SPACE,
  KIT_REPO_CONFIG_PATH,
  adaptKitRepoConfig,
  loadKitRepoConfig,
  negativeSpaceViolations,
  readKitRepoConfig,
} from "../fixtures/repo-config-adapter.ts";
import { KIT_VARIANT_FIXED_DIMENSIONS, kitVariantConfig } from "../fixtures/kit-variant-config.ts";
import { SECOND_CONFIG_FIXED_DIMENSIONS, secondConfig } from "../fixtures/second-config.ts";

const kitConfig = loadKitRepoConfig();

// ── The dimension map ──────────────────────────────────────────────────────

/** Key order is not part of a config's meaning, so it is not part of a value's. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A config flattened into the units divergence is judged in. Members whose ids
 * are themselves a fixed dimension (providers, obligations) are split into their
 * own sub-dimensions, because "the obligation set is pinned but its policy is
 * free" is exactly the shape the kit-variant config needs to express.
 */
function configDimensions(config: HarnessConfig): Record<string, string> {
  const perObligation = (read: (obligation: HarnessConfig["obligations"][number]) => unknown): string =>
    stable(config.obligations.map(read));
  return {
    gateId: stable(config.gateId),
    baseRef: stable(config.baseRef),
    storageNamespace: stable(config.storageNamespace),
    acceptedEnvelopeSpecs: stable(config.acceptedEnvelopeSpecs),
    identityVersions: stable(config.identityVersions),
    computingIdentityVersion: stable(config.computingIdentityVersion),
    reviewNeutral: stable(config.reviewNeutral),
    recordNeutral: stable(config.recordNeutral),
    pathClassification: stable(config.pathClassification),
    sensitivePaths: stable(config.sensitivePaths),
    activationThreshold: stable(config.activationThreshold),
    agentEnvSignals: stable(config.agentEnvSignals),
    ciPolicies: stable(config.ciPolicies),
    ciPolicyEnvKey: stable(config.ciPolicyEnvKey),
    preparationWiringPaths: stable(config.preparationWiringPaths),
    deliveryRecordPath: stable(config.deliveryRecordPath),
    deliveryRecordVerification: stable(config.deliveryRecordVerification),
    "providers.ids": stable(config.providers.map((provider) => provider.id)),
    "providers.findingCodes": stable(config.providers.map((provider) => provider.findingCodes)),
    "obligations.ids": perObligation((obligation) => obligation.id),
    "obligations.activation": perObligation((obligation) => obligation.activation),
    "obligations.freshness": perObligation((obligation) => obligation.freshness),
    "obligations.providers": perObligation((obligation) => obligation.providers),
    "obligations.acceptedPayloadSpecs": perObligation((obligation) => obligation.acceptedPayloadSpecs),
    "obligations.allowedResolutionKinds": perObligation((obligation) => obligation.allowedResolutionKinds),
    "obligations.humanWaiverAllowed": perObligation((obligation) => obligation.humanWaiverAllowed),
    "obligations.minimumAttestationLevel": perObligation((obligation) => obligation.minimumAttestationLevel),
    "obligations.ciDelegationPolicyIds": perObligation((obligation) => obligation.ciDelegationPolicyIds),
    "obligations.remediation": perObligation((obligation) => obligation.remediation),
    "obligations.waivableCodes": perObligation((obligation) => obligation.waivableCodes),
    "obligations.nonWaivableCodes": perObligation((obligation) => obligation.nonWaivableCodes),
  };
}

const ALL_DIMENSIONS = Object.keys(configDimensions(kitConfig));

/**
 * Asserts that `config` matches the kit's configuration on exactly `fixed` and
 * differs from it everywhere else. Both halves matter: without the first, a
 * fixture could drift off a vector-bound value; without the second, it could
 * converge into a copy.
 */
function expectDivergence(config: HarnessConfig, fixed: readonly string[], label: string): void {
  const unknown = fixed.filter((dimension) => !ALL_DIMENSIONS.includes(dimension));
  expect(unknown, `${label} names dimensions that do not exist: ${unknown.join(", ")}`).toEqual([]);

  const theirs = configDimensions(kitConfig);
  const ours = configDimensions(config);
  const converged: string[] = [];
  const drifted: string[] = [];
  for (const dimension of ALL_DIMENSIONS) {
    const same = ours[dimension] === theirs[dimension];
    if (fixed.includes(dimension)) {
      if (!same) drifted.push(dimension);
    } else if (same) {
      converged.push(dimension);
    }
  }
  expect(drifted, `${label} drifted off a fixed dimension: ${drifted.join(", ")}`).toEqual([]);
  expect(converged, `${label} converged on the kit config: ${converged.join(", ")}`).toEqual([]);
}

// ── Loading ────────────────────────────────────────────────────────────────

describe("the four configurations", () => {
  it("all load", () => {
    for (const [label, config] of [
      ["kit repo-config (via the adapter)", kitConfig],
      ["kit-variant", kitVariantConfig],
      ["second", secondConfig],
      ["this repository's own skeleton", harnessConfig],
    ] as const) {
      const result = validateHarnessConfig(config);
      expect(result.ok ? [] : result.blockers.map((blocker) => blocker.summary), label).toEqual([]);
    }
  });

  it("declare four distinct gates", () => {
    const gateIds = [kitConfig.gateId, kitVariantConfig.gateId, secondConfig.gateId, harnessConfig.gateId];
    expect(new Set(gateIds).size).toBe(4);
  });
});

// ── The adapter ────────────────────────────────────────────────────────────

describe("the kit repo-config adapter", () => {
  const declared = readKitRepoConfig();

  it("maps the fields the kit declares", () => {
    expect(kitConfig.gateId).toBe(declared.gateId);
    expect(kitConfig.acceptedEnvelopeSpecs).toEqual(declared.acceptedEnvelopeSpecs);
    expect(kitConfig.identityVersions).toEqual(declared.identityVersions);
    expect(kitConfig.obligations.map((obligation) => obligation.id)).toEqual(Object.keys(declared.obligations));
    const review = kitConfig.obligations[0]!;
    expect(review.acceptedPayloadSpecs).toEqual(declared.obligations["review.green"]!.acceptedPayloadSpecs);
    expect(review.providers).toEqual(declared.obligations["review.green"]!.providers);
    expect(review.minimumAttestationLevel).toBe(declared.obligations["review.green"]!.minimumAttestationLevel);
    expect(kitConfig.providers.map((provider) => provider.id)).toEqual(declared.obligations["review.green"]!.providers);
  });

  it("strips configVersion", () => {
    expect(declared.configVersion).toBe(1);
    expect(Object.keys(kitConfig)).not.toContain("configVersion");
    expect(JSON.stringify(kitConfig)).not.toContain("configVersion");
  });

  it("accounts for every dimension as either mapped or defaulted", () => {
    const claimed = [...KIT_MAPPED_DIMENSIONS, ...Object.keys(KIT_DEFAULTED_DIMENSIONS)].sort();
    expect(claimed).toEqual([...new Set(claimed)]);
    expect(claimed).toEqual([...ALL_DIMENSIONS].sort());
  });

  it("names exactly one default the invariants constrain, and it is the review-neutral set", () => {
    const constrained = Object.entries(KIT_DEFAULTED_DIMENSIONS)
      .filter(([, reason]) => reason === "invariant-constrained")
      .map(([dimension]) => dimension);
    expect(constrained).toEqual(["reviewNeutral"]);
    // And it is constrained: the kit declares deliverable-tree/v1, which binds
    // its narration set, so any other review-neutral set fails to load.
    const widened = validateHarnessConfig({ ...kitConfig, reviewNeutral: [...kitConfig.reviewNeutral, { prefix: "elsewhere/" }] });
    expect(widened.ok ? [] : widened.blockers.map((blocker) => blocker.code)).toContain(
      "config_identity_token_requires_v1_neutral_set",
    );
  });

  it("keeps the negative space the reject vectors depend on", () => {
    expect(negativeSpaceViolations(kitConfig)).toEqual([]);
  });

  it("would notice a default that widened the config into that negative space", () => {
    // The falsification control for the assertion above. Widening the accepted
    // payload specs to include review.green/0 is the mistake a careless default
    // makes; the check must see it. (The kit vector that then turns green is
    // asserted by the kit runner once it exists; here the widening itself is
    // what is proven detectable.)
    const widened = {
      ...kitConfig,
      obligations: kitConfig.obligations.map((obligation) => ({
        ...obligation,
        acceptedPayloadSpecs: [...obligation.acceptedPayloadSpecs, "review.green/0"],
      })),
    } as HarnessConfig;
    expect(negativeSpaceViolations(widened)).toEqual(["review.green/0"]);
  });

  it("guards tokens that are actually load-bearing in the kit", () => {
    // Anti-vacuity for the negative-space list: a token no vector mentions would
    // be a guard against nothing.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const kitRoot = path.join(here, "..", "vectors");
    const kit = JSON.parse(readFileSync(path.join(kitRoot, "kit.json"), "utf8")) as { vectors: { file: string }[] };
    const corpus = kit.vectors.map((vector) => readFileSync(path.join(kitRoot, vector.file), "utf8")).join("\n");
    for (const token of KIT_NEGATIVE_SPACE) {
      expect(corpus, `${token} is guarded but no vector uses it`).toContain(token);
    }
  });

  it("reads the vendored declaration from the kit, not from a copy", () => {
    expect(KIT_REPO_CONFIG_PATH).toBe("packages/conformance/vectors/context/repo-config.json");
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    expect(JSON.parse(readFileSync(path.join(repoRoot, KIT_REPO_CONFIG_PATH), "utf8"))).toEqual(declared);
  });

  it("is a pure mapping over the value it is handed", () => {
    expect(adaptKitRepoConfig(declared)).toEqual(kitConfig);
  });
});

// ── Anti-vacuity for the two synthetic configs ─────────────────────────────

describe("the kit-variant config", () => {
  it("pins the kit-bound dimensions and diverges across every other one", () => {
    expectDivergence(kitVariantConfig, KIT_VARIANT_FIXED_DIMENSIONS, "kit-variant config");
  });

  it("pins the kit-bound registries as whole sets, not as supersets", () => {
    expect([...kitVariantConfig.identityVersions]).toEqual(["deliverable-tree/v1"]);
    expect([...kitVariantConfig.acceptedEnvelopeSpecs]).toEqual(["delivery-evidence/1"]);
    expect(kitVariantConfig.obligations.map((obligation) => obligation.id)).toEqual(["review.green"]);
    expect(kitVariantConfig.obligations[0]!.acceptedPayloadSpecs).toEqual(["review.green/1"]);
    expect(kitVariantConfig.providers.map((provider) => provider.id)).toEqual([
      "claude-code.ce-code-review",
      "example.second-provider",
    ]);
    expect(negativeSpaceViolations(kitVariantConfig)).toEqual([]);
  });

  it("fixes the two dimensions the identity invariants derive, and no more", () => {
    // Derived-fixed, not chosen: pinning identityVersions forces the computing
    // token, which forces the neutral set. Falsifying either one shows the
    // derivation is real rather than asserted.
    const otherToken = validateHarnessConfig({ ...kitVariantConfig, computingIdentityVersion: "variant-tree/v1" });
    expect(otherToken.ok ? [] : otherToken.blockers.map((blocker) => blocker.code)).toContain(
      "config_identity_version_not_accepted",
    );
    const otherNeutralSet = validateHarnessConfig({
      ...kitVariantConfig,
      reviewNeutral: [{ prefix: "docs/reports/" }],
      recordNeutral: [{ prefix: "docs/reports/" }],
      deliveryRecordPath: "docs/reports/variant-record.json",
    });
    expect(otherNeutralSet.ok ? [] : otherNeutralSet.blockers.map((blocker) => blocker.code)).toContain(
      "config_identity_token_requires_v1_neutral_set",
    );
  });
});

describe("the second config", () => {
  it("fixes only the three values this version's scope fixes, and diverges everywhere else", () => {
    expectDivergence(secondConfig, SECOND_CONFIG_FIXED_DIMENSIONS, "second config");
  });

  it("keeps the three fixed values", () => {
    expect([...secondConfig.acceptedEnvelopeSpecs]).toEqual(["delivery-evidence/1"]);
    expect(secondConfig.obligations[0]!.acceptedPayloadSpecs).toEqual(["review.green/1"]);
    expect(secondConfig.obligations.every((obligation) => obligation.minimumAttestationLevel === "self")).toBe(true);
  });

  it("names its obligation something other than the payload spec's namespace", () => {
    // Nothing ties an obligation id to the payload specs it accepts, and a
    // fixture that reused the familiar name would leave that untested.
    expect(secondConfig.obligations.map((obligation) => obligation.id)).toEqual(["code.reviewed"]);
  });
});

// ── This repository's own configuration ────────────────────────────────────

describe("this repository's own gate", () => {
  it("satisfies the double-neutrality the delivery record depends on", () => {
    const both = validateHarnessConfig({ ...harnessConfig, deliveryRecordPath: "docs/reports/elsewhere.json" });
    // Review-neutral but not record-neutral: the case the rule exists for.
    expect(both.ok ? [] : both.blockers.map((blocker) => blocker.code)).toContain("config_delivery_record_not_neutral");
    expect(harnessConfig.deliveryRecordPath.startsWith("delivery/records/")).toBe(true);
  });

  it("uses a consumer-owned identity token, because its neutral set is not the v1 one", () => {
    expect(harnessConfig.computingIdentityVersion).toBe("delivery-harness-tree/v1");
    const claimedV1 = validateHarnessConfig({
      ...harnessConfig,
      identityVersions: ["deliverable-tree/v1"],
      computingIdentityVersion: "deliverable-tree/v1",
    });
    expect(claimedV1.ok ? [] : claimedV1.blockers.map((blocker) => blocker.code)).toContain(
      "config_identity_token_requires_v1_neutral_set",
    );
  });

  it("declares the real gate: no placeholder survives", () => {
    // The skeleton this file used to describe held the config's *shape* loadable
    // while the gate waited for its real declaration. That declaration is in
    // force now, so a placeholder anywhere in it is a regression, not a stage.
    expect(harnessConfig.obligations.map((obligation) => obligation.id)).toEqual(["review.green"]);
    expect(harnessConfig.providers.map((provider) => provider.id)).toEqual(["claude-code.ce-code-review"]);
    expect(harnessConfig.deliveryRecordPath).toBe("delivery/records/record.json");
    expect(JSON.stringify(harnessConfig)).not.toContain("placeholder");
  });

  it("keeps the evidence store out of git's own namespace, per the config guidance", () => {
    // The getting-started guidance: pick a storage namespace git does not own,
    // and one the tracked tree does not also use.
    const gitOwned = ["objects/", "refs/", "hooks/", "info/", "logs/", "worktrees/", "branches/"];
    expect(gitOwned).not.toContain(harnessConfig.storageNamespace);
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const treeName = harnessConfig.storageNamespace.replace(/\/+$/u, "");
    expect(existsSync(path.join(repoRoot, treeName))).toBe(false);
  });
});
