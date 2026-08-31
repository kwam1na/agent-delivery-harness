/**
 * The walking skeleton's disposable-repository baseline: one contract, one
 * repository gate, one trusted acceptance sensor, and the builders that stamp
 * them into a scratch git repository. Later units inherit these fixtures as
 * their characterization baseline — the shapes here are the qualification
 * surface, not throwaway test helpers.
 *
 * The SAME bytes drive both the in-process scenario sensor and the live
 * host-task qualification drive: the tracked `harness.config.ts` this module
 * writes and the config object it returns are generated from one literal, so
 * the two legs cannot drift.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineHarnessConfig, type HarnessConfig } from "../config.ts";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";
import type { AcceptedContract } from "../spine/contract.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT_ROOT = path.resolve(HERE, "..", "..", "..", "..");

export const DISPOSABLE_CONTRACT: AcceptedContract = Object.freeze({
  spec: "scoped-delivery-contract/1",
  contractId: "contract-greeting-1",
  task: "add the contracted greeting module",
  intendedOutcome: "src/greet.mjs exports greet() returning exactly 'hello, skeleton'",
  acceptanceCriteria: [
    { criterionId: "greeting-behavior", statement: "greet() returns 'hello, skeleton'" },
  ],
  nonGoals: ["no second host", "no tracker", "no merge or deploy"],
  repository: { repositoryId: "disposable-skeleton", baseRef: "main" },
  requestedFinishLine: "merge-ready",
  requestedAuthority: [],
  unresolvedDecisions: [],
});

/** The trusted acceptance sensor, tracked at the base commit. */
export const SENSOR_MJS = `// The disposable repository's acceptance sensor: the intended outcome,
// executable. Exit 0 exactly when greet() returns the contracted greeting.
const expected = "hello, skeleton";
try {
  const { greet } = await import(new URL("src/greet.mjs", \`file://\${process.cwd()}/\`).href);
  const actual = greet();
  if (actual === expected) {
    console.log(\`sensor.acceptance passed: greet() === \${JSON.stringify(expected)}\`);
    process.exit(0);
  }
  console.error(\`sensor.acceptance failed: greet() returned \${JSON.stringify(actual)}\`);
  process.exit(1);
} catch (error) {
  console.error(\`sensor.acceptance failed: \${error instanceof Error ? error.message : String(error)}\`);
  process.exit(1);
}
`;

/**
 * The reviewer charters the disposable repository owns, tracked at the base
 * commit under the path its policy pins. Deliberately minimal: what these
 * fixtures prove is that the charter a reviewer was handed is bound into the
 * evidence, not what any particular charter says.
 */
export const PERSONA_MARKDOWN: Readonly<Record<string, string>> = Object.freeze({
  "delivery/personas/outcome-correctness.md":
    "# Outcome correctness\n\nJudge whether the candidate achieves the contracted outcome. A finding names a concrete failure against an acceptance criterion; anything else is a note.\n",
  "delivery/personas/testing-policy.md":
    "# Testing and policy\n\nJudge whether the delivered sensors falsify the contracted outcome. A finding names a scenario the suite cannot fail on; anything else is a note.\n",
});

export const GREET_RIGHT = `export function greet() {\n  return "hello, skeleton";\n}\n`;
export const GREET_WRONG = `export function greet() {\n  return "hello, world";\n}\n`;

/**
 * A host-side typed stage result, bound to the pinned release and graph the
 * way a real host task binds one — the SAME normalized envelope the released
 * result templates freeze. `candidate` is the exact tree the stage's released
 * candidate-binding policy requires (the current checkpoint candidate, or the
 * newly produced tree for a successful `implement`); omit it only where the
 * policy omits it.
 */
export function typedStageResultBytes(input: {
  readonly stageId: "plan" | "implement" | "review.acquire" | "compound";
  readonly deliveryId: string;
  readonly outputKind: string;
  readonly candidate?: string;
  readonly preservationHandoffRef?: string;
}): string {
  return JSON.stringify({
    schemaVersion: "workflow-stage-result/1",
    release: {
      releaseId: PINNED_AGENT_SKILLS.releaseId,
      profile: PINNED_AGENT_SKILLS.profile,
      archiveSha256: PINNED_AGENT_SKILLS.archiveSha256,
      metadataSha256: PINNED_AGENT_SKILLS.metadataSha256,
    },
    graphSha256: PINNED_AGENT_SKILLS.workflowGraphSha256,
    stageId: input.stageId,
    subjectRef: { schemaVersion: "workflow-subject-ref/1", opaque: input.deliveryId },
    ...(input.candidate === undefined
      ? {}
      : { candidateRef: { schemaVersion: "workflow-candidate-ref/1", opaque: input.candidate } }),
    status: "succeeded",
    output: {
      kind: input.outputKind,
      evidenceRef: "retained-output",
      ...(input.preservationHandoffRef === undefined ? {} : { preservationHandoffRef: input.preservationHandoffRef }),
    },
    evidenceRefs: ["retained-observation"],
    limitations: [],
  });
}

/**
 * The gate config, one literal, rendered twice: once as the tracked
 * `harness.config.ts` bytes (JSON is valid JS object syntax) and once as the
 * in-process object — so the live host-task leg and the in-process scenario
 * cannot drift.
 */
const CONFIG_INPUT = {
  gateId: "disposable-skeleton.pr-admission",
  baseRef: "main",
  storageNamespace: "delivery-harness/",
  acceptedEnvelopeSpecs: ["delivery-evidence/1"],
  identityVersions: ["deliverable-tree/v1"],
  computingIdentityVersion: "deliverable-tree/v1",
  reviewNeutral: [
    { prefix: "docs/reports/" },
    { prefix: "docs/solutions/" },
    { prefix: "telemetry/delivery-runs/" },
  ],
  recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
  pathClassification: {
    generated: [],
    test: [{ kind: "glob", value: "tests/**" }],
    lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
  },
  sensitivePaths: [],
  activationThreshold: 1,
  agentEnvSignals: ["CLAUDE_CODE", "CLAUDECODE"],
  ciPolicies: [
    {
      id: "github-actions",
      requiredEnv: [
        { variable: "GITHUB_ACTIONS", equals: "true" },
        { variable: "CI", equals: "true" },
      ],
    },
  ],
  ciPolicyEnvKey: "DELIVERY_HARNESS_CI_POLICY",
  preparationWiringPaths: ["harness.config.ts"],
  providers: [{ id: "claude-code.ce-code-review", findingCodes: [] }],
  obligations: [
    {
      id: "review.green",
      activation: { kind: "relevant_change" },
      freshness: "exact_candidate",
      providers: ["claude-code.ce-code-review"],
      acceptedPayloadSpecs: ["review.green/1"],
      allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
      humanWaiverAllowed: true,
      minimumAttestationLevel: "self",
      ciDelegationPolicyIds: [],
      remediation: {
        default: [
          {
            id: "run-the-review",
            kind: "manual_action",
            summary: "Complete both mandatory review lenses and submit their evidence.",
          },
        ],
      },
      waivableCodes: [
        "review_evidence_missing",
        "stale_evidence",
        "evidence_not_green",
        "unresolved_actionable_findings",
      ],
      nonWaivableCodes: [
        "ambiguous_records",
        "malformed_record",
        "unknown_provider",
        "live_provider_missing",
        "ambiguous_live_provider",
        "live_provider_failed",
        "resolution_not_allowed",
      ],
    },
  ],
  deliveryRecordPath: "telemetry/delivery-runs/record.json",
  deliveryRecordVerification: { baseMovement: "stale" },
} satisfies Parameters<typeof defineHarnessConfig>[0];

export const HARNESS_CONFIG_TS = `import { defineHarnessConfig } from "@agent-delivery-harness/kernel";

export default defineHarnessConfig(${JSON.stringify(CONFIG_INPUT, null, 2)});
`;

export function disposableHarnessConfig(): HarnessConfig {
  return defineHarnessConfig(CONFIG_INPUT);
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

export interface DisposableRepository {
  readonly repoDir: string;
  readonly baseCommit: string;
}

/**
 * Stamps the disposable repository: gate config, acceptance sensor, ignore
 * rules, and the kernel workspace link the tracked config imports — all
 * committed as the trusted pre-run base on `main`.
 */
export function buildDisposableRepository(repoDir: string): DisposableRepository {
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "--quiet", "--initial-branch", "main");
  git(repoDir, "config", "user.email", "skeleton@example.invalid");
  git(repoDir, "config", "user.name", "Walking Skeleton");
  git(repoDir, "config", "commit.gpgsign", "false");

  writeFileSync(path.join(repoDir, "package.json"), `${JSON.stringify({ name: "disposable-skeleton", private: true, type: "module" }, null, 2)}\n`);
  writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n.delivery-harness/\n");
  writeFileSync(path.join(repoDir, "harness.config.ts"), HARNESS_CONFIG_TS);
  mkdirSync(path.join(repoDir, "tools"), { recursive: true });
  writeFileSync(path.join(repoDir, "tools", "sensor.mjs"), SENSOR_MJS);
  for (const [relative, contents] of Object.entries(PERSONA_MARKDOWN)) {
    const target = path.join(repoDir, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  mkdirSync(path.join(repoDir, "src"), { recursive: true });
  writeFileSync(path.join(repoDir, "src", "README.md"), "the contracted module lands here\n");

  // The pre-v1 consumption wiring from the getting-started wallkthrough: the
  // tracked config resolves @agent-delivery-harness/kernel from this checkout.
  mkdirSync(path.join(repoDir, "node_modules", "@agent-delivery-harness"), { recursive: true });
  symlinkSync(path.join(CHECKOUT_ROOT, "packages", "kernel"), path.join(repoDir, "node_modules", "@agent-delivery-harness", "kernel"));

  git(repoDir, "add", ".");
  git(repoDir, "commit", "--quiet", "--no-gpg-sign", "-m", "disposable skeleton base");
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  return { repoDir, baseCommit };
}
