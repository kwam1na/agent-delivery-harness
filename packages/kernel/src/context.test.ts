/**
 * Execution-context classification, written before `context.ts` existed.
 *
 * The classifier decides what the caller is entitled to, so the properties
 * worth pinning are the asymmetries rather than the happy path:
 *
 *   1. THE LADDER IS ORDERED, AND THE ORDER IS ASSERTED FROM BOTH SIDES.
 *      Repo-authorized CI outranks a recognized agent, which outranks an
 *      interactive human, which outranks nothing at all. Each rung is driven
 *      from a cross-product of the four environmental signals, so a rung that
 *      stops outranking the one below it is red.
 *   2. A PARTIAL CI MATCH IS NOT A DOWNGRADE. Every way of half-matching a
 *      declared policy — naming it without corroboration, corroborating it
 *      without naming it, naming one that does not exist — lands on
 *      `unauthorized_automation`, never on the anonymous `unknown` an
 *      unrecognized shell gets. The falsification beside that table implements
 *      the downgrade and shows the two are distinguishable.
 *   3. A PTY NEVER PROMOTES AN AGENT. An agent with both streams attached to a
 *      terminal is still an agent; the waiver path is closed to it, and a
 *      terminal is not evidence of a person.
 *   4. THE CI CONTEXT CARRIES THE MATCHED POLICY'S VALUES. Two configs whose
 *      policies differ in id and corroborating environment produce two
 *      different contexts from the same classifier, so nothing here can be
 *      satisfied by a literal baked into the module.
 *
 * No I/O: every scenario is a value handed to a pure function, and the
 * environment is a snapshot parameter rather than an ambient read.
 */
import { describe, expect, it } from "vitest";
import { defineHarnessConfig, type HarnessConfig, type HarnessConfigInput } from "./config.ts";
import { GATE_STRUCTURAL_FINDING_CODES } from "./blockers.ts";
import {
  EXECUTION_CONTEXT_KINDS,
  UNKNOWN_CONTEXT_REASONS,
  classifyExecutionContext,
  isEnvSignalPresent,
  type EnvSnapshot,
  type ExecutionContext,
} from "./context.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

const PROVIDER_CODES = ["review-incomplete"] as const;

function partitionedCodes(): { waivableCodes: string[]; nonWaivableCodes: string[] } {
  const nonWaivable = ["ambiguous_records", "malformed_record", "unknown_provider", "resolution_not_allowed"];
  const universe = [...GATE_STRUCTURAL_FINDING_CODES, ...PROVIDER_CODES];
  return {
    waivableCodes: universe.filter((code) => !nonWaivable.includes(code)),
    nonWaivableCodes: universe.filter((code) => nonWaivable.includes(code)),
  };
}

function testConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "test.gate",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: ["test-tree/v1"],
    computingIdentityVersion: "test-tree/v1",
    reviewNeutral: [{ prefix: "docs/narration/" }, { prefix: "delivery/records/" }],
    recordNeutral: [{ prefix: "delivery/records/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [{ id: "auth", patterns: [{ kind: "prefix", value: "src/auth/" }] }],
    activationThreshold: 10,
    providers: [{ id: "review.provider", findingCodes: [...PROVIDER_CODES] }],
    agentEnvSignals: ["TEST_AGENT", "OTHER_AGENT"],
    ciPolicies: [
      {
        id: "pr-tests",
        requiredEnv: [
          { variable: "TEST_CI", equals: "true" },
          { variable: "TEST_WORKFLOW", equals: "PR Tests" },
        ],
      },
    ],
    ciPolicyEnvKey: "TEST_HARNESS_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [
      {
        id: "review.green",
        activation: { kind: "relevant_change" },
        freshness: "exact_candidate",
        providers: ["review.provider"],
        acceptedPayloadSpecs: ["review.green/1"],
        allowedResolutionKinds: ["satisfied_evidence", "waived", "delegated", "not_applicable"],
        humanWaiverAllowed: true,
        minimumAttestationLevel: "self",
        ciDelegationPolicyIds: ["pr-tests"],
        remediation: {
          default: [{ id: "run-the-review", kind: "manual_action", summary: "Complete a final green review." }],
        },
        ...partitionedCodes(),
      },
    ],
    deliveryRecordPath: "delivery/records/record.json",
    ...overrides,
  });
}

/** The environment of an authorized CI run under the fixture policy. */
const AUTHORIZED_CI: EnvSnapshot = {
  TEST_HARNESS_CI_POLICY: "pr-tests",
  TEST_CI: "true",
  TEST_WORKFLOW: "PR Tests",
};

function classify(env: EnvSnapshot, tty = false, config: HarnessConfig = testConfig()): ExecutionContext {
  return classifyExecutionContext({ config, env, stdinIsTTY: tty, stdoutIsTTY: tty });
}

// ── Presence ───────────────────────────────────────────────────────────────

describe("environment signal presence", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["anything", true],
    [" ", true],
    ["", false],
    ["0", false],
    ["false", false],
    [undefined, false],
  ])("reads %o as present=%s", (value, expected) => {
    expect(isEnvSignalPresent(value)).toBe(expected);
  });
});

// ── The ladder ─────────────────────────────────────────────────────────────

describe("the trust ladder", () => {
  it("classifies an authorized CI run as ci", () => {
    expect(classify(AUTHORIZED_CI)).toEqual({
      kind: "ci",
      policyId: "pr-tests",
      requiredEnv: [
        { variable: "TEST_CI", equals: "true" },
        { variable: "TEST_WORKFLOW", equals: "PR Tests" },
      ],
    });
  });

  it("returns the matched policy's values rather than literals", () => {
    const other = testConfig({
      ciPolicyEnvKey: "OTHER_KEY",
      ciPolicies: [{ id: "nightly", requiredEnv: [{ variable: "NIGHTLY", equals: "yes" }] }],
      obligations: [
        {
          ...testConfig().obligations[0]!,
          ciDelegationPolicyIds: ["nightly"],
        },
      ],
    });
    expect(classify({ OTHER_KEY: "nightly", NIGHTLY: "yes" }, false, other)).toEqual({
      kind: "ci",
      policyId: "nightly",
      requiredEnv: [{ variable: "NIGHTLY", equals: "yes" }],
    });
  });

  it("classifies a recognized agent signal as agent", () => {
    expect(classify({ TEST_AGENT: "1" })).toEqual({ kind: "agent", signal: "TEST_AGENT" });
  });

  it("names the first declared signal when several are present", () => {
    expect(classify({ OTHER_AGENT: "1", TEST_AGENT: "1" })).toEqual({ kind: "agent", signal: "TEST_AGENT" });
  });

  it("ignores a declared signal whose value denies it", () => {
    expect(classify({ TEST_AGENT: "false" })).toEqual({ kind: "unknown", reason: "noninteractive_unrecognized" });
  });

  it("classifies two attached terminals as an interactive human", () => {
    expect(classify({}, true)).toEqual({ kind: "human", interactive: true });
  });

  it("does not accept one attached stream as interactive", () => {
    expect(classifyExecutionContext({ config: testConfig(), env: {}, stdinIsTTY: true, stdoutIsTTY: false })).toEqual({
      kind: "unknown",
      reason: "noninteractive_unrecognized",
    });
  });

  it("classifies an unrecognized non-interactive shell as unknown", () => {
    expect(classify({})).toEqual({ kind: "unknown", reason: "noninteractive_unrecognized" });
  });

  /**
   * The cross-product. Each row states the four environmental signals and the
   * rung they must land on; the rungs above always win, which is the whole
   * content of "asymmetry".
   */
  it.each([
    { name: "ci + agent + tty", env: { ...AUTHORIZED_CI, TEST_AGENT: "1" }, tty: true, expected: "ci" },
    { name: "ci + agent", env: { ...AUTHORIZED_CI, TEST_AGENT: "1" }, tty: false, expected: "ci" },
    { name: "ci + tty", env: AUTHORIZED_CI, tty: true, expected: "ci" },
    { name: "agent + tty", env: { TEST_AGENT: "1" }, tty: true, expected: "agent" },
    { name: "agent", env: { TEST_AGENT: "1" }, tty: false, expected: "agent" },
    { name: "tty", env: {}, tty: true, expected: "human" },
    { name: "nothing", env: {}, tty: false, expected: "unknown" },
  ])("$name → $expected", ({ env, tty, expected }) => {
    expect(classify(env, tty).kind).toBe(expected);
  });

  it("covers every declared context kind", () => {
    const reached = new Set(
      [
        classify(AUTHORIZED_CI),
        classify({ TEST_AGENT: "1" }),
        classify({}, true),
        classify({}),
      ].map((context) => context.kind),
    );
    expect([...EXECUTION_CONTEXT_KINDS].filter((kind) => !reached.has(kind))).toEqual([]);
  });
});

// ── The partial-match asymmetry ────────────────────────────────────────────

describe("a partial CI match", () => {
  it.each([
    { name: "named but not corroborated at all", env: { TEST_HARNESS_CI_POLICY: "pr-tests" } },
    {
      name: "named and only half corroborated",
      env: { TEST_HARNESS_CI_POLICY: "pr-tests", TEST_CI: "true" },
    },
    {
      name: "named with one corroborating value wrong",
      env: { TEST_HARNESS_CI_POLICY: "pr-tests", TEST_CI: "true", TEST_WORKFLOW: "Nightly" },
    },
    { name: "corroborated but never named", env: { TEST_CI: "true", TEST_WORKFLOW: "PR Tests" } },
    { name: "half corroborated and never named", env: { TEST_CI: "true" } },
    {
      name: "naming a policy the config does not declare",
      env: { TEST_HARNESS_CI_POLICY: "some-other-policy", TEST_CI: "true", TEST_WORKFLOW: "PR Tests" },
    },
  ])("$name → unauthorized_automation", ({ env }) => {
    expect(classify(env)).toEqual({ kind: "unknown", reason: "unauthorized_automation" });
  });

  it("is never downgraded by a terminal or an agent signal", () => {
    const partial = { TEST_HARNESS_CI_POLICY: "pr-tests", TEST_CI: "true" };
    expect(classify(partial, true)).toEqual({ kind: "unknown", reason: "unauthorized_automation" });
    expect(classify({ ...partial, TEST_AGENT: "1" }, true)).toEqual({
      kind: "unknown",
      reason: "unauthorized_automation",
    });
  });

  it("is distinguishable from an anonymous unknown", () => {
    const partial = classify({ TEST_HARNESS_CI_POLICY: "pr-tests" });
    const anonymous = classify({});
    expect(partial.kind).toBe(anonymous.kind);
    expect(partial).not.toEqual(anonymous);
    expect([...UNKNOWN_CONTEXT_REASONS]).toEqual(["unauthorized_automation", "noninteractive_unrecognized"]);
  });

  /**
   * FALSIFICATION. A classifier that treats an uncorroborated claim as "no
   * claim" is exactly the downgrade this rule forbids, and it is the reading a
   * later edit would most plausibly reach for. Implemented here so the table
   * above is shown to discriminate rather than merely to pass.
   */
  it("FALSIFICATION: downgrading an uncorroborated claim would admit a terminal-less automation as a human", () => {
    const downgrading = (env: EnvSnapshot, tty: boolean): ExecutionContext => {
      const corroborated = testConfig().ciPolicies.find((policy) =>
        policy.requiredEnv.every((requirement) => env[requirement.variable] === requirement.equals),
      );
      if (corroborated !== undefined && env["TEST_HARNESS_CI_POLICY"] === corroborated.id) {
        return { kind: "ci", policyId: corroborated.id, requiredEnv: corroborated.requiredEnv };
      }
      if (tty) return { kind: "human", interactive: true };
      return { kind: "unknown", reason: "noninteractive_unrecognized" };
    };
    const partial = { TEST_HARNESS_CI_POLICY: "pr-tests", TEST_CI: "true" };
    expect(downgrading(partial, true)).toEqual({ kind: "human", interactive: true });
    expect(classify(partial, true)).toEqual({ kind: "unknown", reason: "unauthorized_automation" });
  });
});

// ── Config-driven, not literal ─────────────────────────────────────────────

describe("everything the classifier reads is config", () => {
  it("honors a renamed policy env key", () => {
    const renamed = testConfig({ ciPolicyEnvKey: "RENAMED_KEY" });
    expect(classify({ ...AUTHORIZED_CI }, false, renamed)).toEqual({
      kind: "unknown",
      reason: "unauthorized_automation",
    });
    expect(
      classify({ RENAMED_KEY: "pr-tests", TEST_CI: "true", TEST_WORKFLOW: "PR Tests" }, false, renamed).kind,
    ).toBe("ci");
  });

  it("honors renamed agent signals", () => {
    const renamed = testConfig({ agentEnvSignals: ["RENAMED_AGENT"] });
    expect(classify({ TEST_AGENT: "1" }, false, renamed).kind).toBe("unknown");
    expect(classify({ RENAMED_AGENT: "1" }, false, renamed)).toEqual({ kind: "agent", signal: "RENAMED_AGENT" });
  });

  it("recognizes no automation at all when the config declares no CI policy", () => {
    const noPolicies = testConfig({
      ciPolicies: [],
      obligations: [{ ...testConfig().obligations[0]!, ciDelegationPolicyIds: [] }],
    });
    expect(classify({ TEST_CI: "true", TEST_WORKFLOW: "PR Tests" }, true, noPolicies)).toEqual({
      kind: "human",
      interactive: true,
    });
    expect(classify({ TEST_HARNESS_CI_POLICY: "pr-tests" }, true, noPolicies)).toEqual({
      kind: "unknown",
      reason: "unauthorized_automation",
    });
  });
});

// ── Corroboration must be possible, not merely satisfied ───────────────────

describe("a policy that declares no corroborating environment", () => {
  const bare = (): HarnessConfig =>
    testConfig({
      ciPolicies: [{ id: "bare", requiredEnv: [] }],
      obligations: [{ ...testConfig().obligations[0]!, ciDelegationPolicyIds: ["bare"] }],
    });

  /**
   * "Every requirement holds" is vacuously true of no requirements, so a policy
   * with an empty `requiredEnv` would be corroborated by naming it and nothing
   * else — a full CI context, and with it a delegated obligation, conferred by
   * one environment variable anybody can export. Authorization needs something
   * to check, so a policy that offers nothing to check cannot grant it.
   */
  it("is not authorized by being named", () => {
    expect(classify({ TEST_HARNESS_CI_POLICY: "bare" }, false, bare())).toEqual({
      kind: "unknown",
      reason: "unauthorized_automation",
    });
  });

  it("is not authorized by being named from a terminal either", () => {
    expect(classify({ TEST_HARNESS_CI_POLICY: "bare" }, true, bare())).toEqual({
      kind: "unknown",
      reason: "unauthorized_automation",
    });
  });

  /**
   * The other half of the coherence: an empty requirement list raises no claim
   * on its own, so an unrelated shell is still an ordinary shell.
   */
  it("raises no automation claim of its own", () => {
    expect(classify({}, true, bare())).toEqual({ kind: "human", interactive: true });
    expect(classify({ TEST_AGENT: "1" }, false, bare())).toEqual({ kind: "agent", signal: "TEST_AGENT" });
  });

  it("does not disturb a policy whose corroboration is real and complete", () => {
    expect(classify(AUTHORIZED_CI).kind).toBe("ci");
  });
});

// ── Signals come from the environment, not from the prototype ──────────────

describe("environment lookups that are not environment values", () => {
  /**
   * A snapshot is an ordinary object, so `env["__proto__"]`, `env["toString"]`
   * and friends answer with something inherited rather than with `undefined`.
   * Each of those names is a legal environment-variable identifier, so a config
   * may declare one, and an inherited value that is not a string would
   * otherwise read as a present signal and confer the agent rung on an
   * environment that declares nothing at all.
   */
  it("does not read an inherited member as a present signal", () => {
    const inherited = testConfig({ agentEnvSignals: ["__proto__", "constructor", "toString"] });
    expect(classify({}, true, inherited)).toEqual({ kind: "human", interactive: true });
    expect(classify({}, false, inherited)).toEqual({ kind: "unknown", reason: "noninteractive_unrecognized" });
  });

  it.each([
    ["an object", {}],
    ["a function", (): void => {}],
    ["a number", 1],
    ["null", null],
  ])("reads %s as absent", (_name, value) => {
    expect(isEnvSignalPresent(value as unknown as string | undefined)).toBe(false);
  });

  it("still reads a declared string signal as present", () => {
    const inherited = testConfig({ agentEnvSignals: ["__proto__", "TEST_AGENT"] });
    expect(classify({ TEST_AGENT: "1" }, false, inherited)).toEqual({ kind: "agent", signal: "TEST_AGENT" });
  });
});
