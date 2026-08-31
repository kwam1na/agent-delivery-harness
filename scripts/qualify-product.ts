/**
 * THE PRODUCT QUALIFICATION LANE — release-level evidence that the composed
 * product delivers work in clean disposable repositories, driven from PACKED
 * ARTIFACTS ONLY.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SCENARIO SENSORS. The facade scenario
 * suites already drive a disposable repository end to end, and they are the
 * right place for the hostile matrix: they are fast, they run on every leg,
 * and they can reach state a released artifact deliberately hides. But every
 * one of them imports the product out of `packages/` — the candidate's own
 * source. That is the correct dependency for a unit sensor and the wrong one
 * for a release gate, because it proves nothing about the thing an adopter
 * installs. A module that is unreachable through the package `exports` map, a
 * file the manifest's `files` list drops, a path computed from a checkout
 * layout that does not survive packing: all of those pass the scenario suites
 * and fail the first adopter.
 *
 * So this lane never imports the product. It reaches it twice, both times
 * through an artifact:
 *
 *   1. THE PUBLISHABLE TARBALLS. Every workspace package is `npm pack`ed and
 *      installed into one isolated tree outside the repository. That tree is
 *      where the INSTALLER comes from — the operator-facing lifecycle an
 *      adopter runs before any delivery exists.
 *   2. THE INSTALLED GENERATION ROOT. The installer packs and installs a
 *      composition generation, and the PRODUCT that drives the deliveries is
 *      loaded from inside that read-only, digest-addressed root. Nothing under
 *      `<sourceRoot>/packages` is imported at any point, and the lane binds
 *      the bytes it loaded to the manifest rather than trusting a path it
 *      built itself: the manifest must hash to the addressed generation, the
 *      kernel entry must be one of its inventory members, and that file's
 *      bytes must re-hash to the inventory digest. That is a check on the
 *      entry this lane executes, not a full closure sweep of the root.
 *
 * TWO REPOSITORIES, TWO POLICIES, ONE RELEASE. The headline release claim is
 * that a second repository changes policy without forking workflows or harness
 * semantics. A lane that drove one repository twice would satisfy every
 * assertion below and prove none of it, so the two repositories are built from
 * DIFFERENT gate configurations — different gate id, identity version, neutral
 * path sets, path classification, delivery-record location, and contracted
 * outcome — and the lane then requires that the generation digest and the
 * workflow graph digest they resolved are the SAME. Different policy, same
 * product.
 *
 * ANTI-VACUITY IS A RULE HERE, NOT A HABIT. Every lane that can be satisfied
 * by absence carries a matching finding for the absent case: a run that drove
 * no repository, proved no negative probe, or observed an empty process
 * inventory is itself a finding rather than a pass. The enumerating mechanisms
 * are checked too — an assertion over "every disposable repository" is
 * worthless when the set is empty, so the set's size is pinned.
 *
 * WHAT THIS LANE DOES NOT LAUNCH. No agent runtime. The product may never
 * start `claude --print`, `codex exec`, or any subordinate runtime, and the
 * `no-agent-process` lane inventories every process the product ran through
 * its exec port to say so from evidence rather than from intent. This driver
 * launches no agent runtime either; the live host legs are a separate lane
 * (`scripts/qualify-claude-code-session.ts`) an operator runs.
 *
 * WHERE IT RUNS. Packing five tarballs, installing them, packing five
 * composition generations, and driving two full deliveries is tens of seconds,
 * not milliseconds — the same reason `sensor:standalone` is not in the default
 * suite. `npm run qualify:product` runs it; `scripts/qualify-product.test.ts`
 * falsifies its rules cheaply on every leg.
 */
import { execFileSync, type StdioOptions } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Findings ─────────────────────────────────────────────────────────────────

export type QualificationRule =
  | "pack-failed"
  | "install-failed"
  | "product-provenance"
  | "composition-failed"
  | "delivery-failed"
  | "policy-independence"
  | "no-agent-process"
  | "negative-probe"
  | "lifecycle"
  | "packed-surface"
  | "anti-vacuity";

export interface QualificationFinding {
  readonly rule: QualificationRule;
  /** The lane the finding belongs to — a repository id, a probe id, or a rule id. */
  readonly subject: string;
  readonly message: string;
}

/** What the run observed, for the qualification record to quote. */
export interface QualificationObservations {
  readonly generationDigest: string;
  readonly installationId: string;
  readonly workflowGraphSha256: string;
  /** Repository ids driven to merge-ready, in order. */
  readonly repositoriesDelivered: readonly string[];
  /**
   * Distinct GATE CONFIGURATION digests across those repositories.
   *
   * Deliberately not called a compiled-policy digest. The product's compiled
   * repository policy for a disposable repository is a fixed document
   * parameterized by repository id and reviewer-charter digests, so two
   * disposable repositories compile near-identical policy whatever their
   * owners do. What an adopter actually controls at this layer — and what
   * "a second repository changes policy" means here — is the tracked gate
   * configuration: identity token, neutral trees, path classification,
   * record location, obligations. That is what this counts.
   */
  readonly distinctGateConfigDigests: number;
  /**
   * Every executable the product invoked through its injected exec port,
   * deduplicated across the run.
   */
  readonly productProcessInventory: readonly string[];
  /** The same, per repository — so one lane's observations cannot stand in for the other's. */
  readonly perRepositoryProcessInventory: Readonly<Record<string, readonly string[]>>;
  /** Negative probes that produced their expected refusal, in order. */
  readonly negativeProbesSatisfied: readonly string[];
  /** Lifecycle transitions proven, in order. */
  readonly lifecycleStepsProven: readonly string[];
}

export interface QualificationResult {
  readonly findings: readonly QualificationFinding[];
  readonly observations: QualificationObservations;
}

// ── Registry: the negative probes and lifecycle steps this lane must prove ───

/**
 * The refusals a release gate cannot be allowed to pass without. Each is a
 * DENY that a mechanism denying everything would also satisfy, so each is
 * paired in the suite with the matching allow — the deny alone is not the
 * evidence.
 */
export const REQUIRED_NEGATIVE_PROBES: readonly string[] = Object.freeze([
  "receipt-listed-repository-refusal",
  "qualification-flag-required",
  "qualification-flag-refused-on-production",
  "revoked-generation-fences-live-work",
  "revoked-rollback-target-rejected",
  "closure-detects-missing-staged-hook-entry",
  "bind-refuses-generation-missing-staged-hook-entry",
]);

/** The composition-lifecycle transitions the release claim rests on. */
export const REQUIRED_LIFECYCLE_STEPS: readonly string[] = Object.freeze([
  "update-1",
  "update-2",
  "resume-through-pinned-generation",
  "rollback-to-retained-generation",
]);

/** Timeout for any single child this lane spawns. */
export const STEP_TIMEOUT_MS = 600_000;

// ── The decisions, extracted ─────────────────────────────────────────────────
//
// The expensive half of this lane runs three composition packs and two full
// deliveries, which is the wrong place to falsify a rule. Every judgement the
// lane makes is therefore a pure function over what was observed, so
// `qualify-product.test.ts` can drive each one to BOTH verdicts in
// milliseconds. A rule that is only ever exercised on the passing side is a
// rule nobody has checked, and the deny side alone is satisfied by a predicate
// that denies everything — so the suite pins both.

/** Executables that would mean the product started a coding-agent runtime. */
export const FORBIDDEN_PRODUCT_EXECUTABLES: readonly string[] = Object.freeze(["claude", "codex", "cursor", "aider"]);

/** Git subcommands that would mean the product owns the workspace lifecycle. */
export const FORBIDDEN_WORKSPACE_OPERATIONS: readonly string[] = Object.freeze(["worktree", "clone", "init"]);

/**
 * The product may run git and node. It may not run a coding-agent runtime, and
 * it may not perform a workspace lifecycle operation — the host creates and
 * removes worktrees, and a product that did so would own a lifecycle the whole
 * orchestration boundary says it does not.
 */
export function forbiddenProcessFinding(
  subject: string,
  command: string,
  args: readonly unknown[],
): QualificationFinding | undefined {
  const executable = path.basename(command);
  if (FORBIDDEN_PRODUCT_EXECUTABLES.includes(executable)) {
    return {
      rule: "no-agent-process",
      subject,
      message: `the product launched ${command}; it must never start a coding-agent runtime`,
    };
  }
  if (executable === "git" && FORBIDDEN_WORKSPACE_OPERATIONS.includes(String(args[0]))) {
    return {
      rule: "no-agent-process",
      subject,
      message: `the product ran \`git ${String(args[0])}\`; workspace lifecycle belongs to the host, not the product`,
    };
  }
  return undefined;
}

/**
 * WHETHER A NEGATIVE PROBE ACTUALLY REFUSED.
 *
 * This is the only thing standing between "the probe ran" and "the probe
 * refused", so it is a pure function rather than a closure inside the lane. A
 * detector that stopped noticing success would let every required probe report
 * satisfied against a mechanism that ALLOWED the forbidden thing, while the
 * anti-vacuity rule saw a full satisfied list and reported nothing.
 *
 * Refusing for the wrong reason is not this probe's evidence either: a
 * refusal carrying some other blocker code is a finding, not a pass.
 */
export function refusalOutcome(
  probe: string,
  result: unknown,
  expectedCode: string,
): { readonly satisfied: true } | { readonly satisfied: false; readonly finding: QualificationFinding } {
  if ((result as { ok?: unknown } | undefined)?.ok === true) {
    return {
      satisfied: false,
      finding: { rule: "negative-probe", subject: probe, message: `expected a refusal, got success: ${JSON.stringify(result)}` },
    };
  }
  const codes = blockerCodes(result);
  if (!codes.includes(expectedCode)) {
    return {
      satisfied: false,
      finding: {
        rule: "negative-probe",
        subject: probe,
        message: `refused, but with ${codes.join(", ") || "no"} code rather than ${expectedCode}; a refusal for the wrong reason is not this probe's evidence`,
      },
    };
  }
  return { satisfied: true };
}

// ── The packed surface: what an installed copy can reach, and what it names ──
//
// These two rules exist because every OTHER sensor in this repository reaches
// the product by importing it out of `packages/`. That import sees the whole
// source tree, so it cannot distinguish a module the package publishes from a
// module the package merely contains, nor a path that exists in a checkout
// from a path a composition stages. Both distinctions are invisible from
// source by construction, and both are exactly what an adopter hits first.

/**
 * The names an installed copy must be able to reach through the package's
 * single `exports` entry.
 *
 * Deliberately narrow. Every name here is a published commitment, so this set
 * carries what an adopter cannot do without and nothing kept for symmetry:
 * `verifyGenerationClosure` is the audit of an installation the adopter did
 * NOT pack — the one question a consumer of a digest-addressed generation root
 * has that the primitives around it cannot answer, since re-deriving closure
 * by hand means re-implementing the rule the installer already owns.
 */
export const REQUIRED_PUBLISHED_NAMES: readonly string[] = Object.freeze(["verifyGenerationClosure"]);

/**
 * Where the composition must stage the model-external hook entry, spelled
 * INDEPENDENTLY of the product rather than imported from it.
 *
 * This lane may not import the product, so the alternative would be to read
 * the path back out of the emitted command — which would make the check
 * circular: whatever the facade emitted would be, by definition, what the lane
 * expected. Declaring it here means a product that relocates the entry has to
 * come past this file.
 */
export const GENERATION_HOOK_ENTRY = "harness/packages/kernel/src/host/hook-main.ts";

/**
 * WHAT THE PACKAGE ACTUALLY PUBLISHES, DECIDED.
 *
 * THE ABSENCE-ASSERTION TRAP, HEAD ON. "every required name is reachable" is
 * satisfied for free by an empty required set, and equally by an enumeration
 * that resolved nothing — a failed resolve returning `{}` would make this rule
 * silent about a package that publishes literally nothing. Both enumerating
 * mechanisms are therefore pinned, in the two places that can actually
 * falsify them: the resolved set is a finding here, above the membership loop,
 * and the required set — a frozen constant no call site can empty — is pinned
 * by a test over the constant itself. A finding for the constant would be a
 * branch with no reachable input, which is the shape this comment exists to
 * refuse.
 */
export function publishedSurfaceFindings(exportedNames: readonly string[]): readonly QualificationFinding[] {
  const findings: QualificationFinding[] = [];
  if (exportedNames.length === 0) {
    findings.push({
      rule: "packed-surface",
      subject: "published-exports",
      message:
        "resolving the package through its `exports` map yielded no exported name at all; a membership check over an empty surface says nothing about what an adopter can reach",
    });
  }
  for (const name of REQUIRED_PUBLISHED_NAMES) {
    if (exportedNames.includes(name)) continue;
    findings.push({
      rule: "packed-surface",
      subject: name,
      message: `${name} is not reachable through the package's \`exports\` entry, so an adopter installing the published package cannot invoke it; the module exists in the source tree, which is why every source-importing suite sees it`,
    });
  }
  return findings;
}

export interface HookCommandInput {
  /** The runtime-and-entry vector the facade emitted, before the host's own arguments. */
  readonly command: readonly string[];
  /** The installed, digest-addressed generation root the command has to resolve against. */
  readonly generationRoot: string;
  /** Generation-relative paths the composition manifest actually stages. */
  readonly stagedRelativePaths: readonly string[];
  /** The Node executable the lane is running on — the only runtime an installed generation has. */
  readonly nodeExecutable: string;
}

/**
 * WHETHER THE EMITTED HOOK COMMAND NAMES SOMETHING THAT IS THERE.
 *
 * TWO HALVES, BOTH REQUIRED, NEITHER SUFFICIENT. A rule that only read the
 * command string would pass a command naming a perfectly plausible path that
 * the composition never staged — which is the defect this exists for. A rule
 * that only checked the staged inventory would pass a generation staging the
 * entry while the command pointed somewhere else entirely. So the command's
 * own members are resolved AGAINST the inventory: the launcher must be the
 * Node executable (a composition stages no `node_modules`, so a dependency
 * binary is a path that cannot exist), and every path member must be inside
 * the generation root AND a member of the manifest's staged set.
 *
 * The enumerating mechanisms are pinned too: an empty command names nothing
 * and an empty staged set is not an installed generation, and either one would
 * leave the loop below quantifying over nothing.
 */
export function hookCommandFindings(input: HookCommandInput): readonly QualificationFinding[] {
  const findings: QualificationFinding[] = [];
  if (input.command.length === 0) {
    findings.push({
      rule: "packed-surface",
      subject: "hook-command",
      message: "the facade emitted an empty hook command; a command that names nothing satisfies every path assertion below for free",
    });
    return findings;
  }
  if (input.stagedRelativePaths.length === 0) {
    findings.push({
      rule: "packed-surface",
      subject: "staged-inventory",
      message: "the installed generation stages no files at all, so 'the command names a staged path' is a claim about an empty set",
    });
  }
  const staged = new Set(input.stagedRelativePaths);

  // THE LAUNCHER. Named separately from the path members because it fails
  // differently: `node_modules/.bin/tsx` is both the wrong runtime AND an
  // unstaged path, and a fix that staged it would still be wrong — this
  // repository ships zero runtime dependencies.
  if (input.command[0] !== input.nodeExecutable) {
    findings.push({
      rule: "packed-surface",
      subject: "hook-runtime",
      message: `the hook command launches ${input.command[0]} rather than the running Node executable ${input.nodeExecutable}; an installed generation stages no node_modules, so a runtime resolved from a checkout layout names a binary the adopter does not have`,
    });
  }

  const pathMembers = input.command.slice(1).filter((member) => path.isAbsolute(member));
  if (pathMembers.length === 0) {
    findings.push({
      rule: "packed-surface",
      subject: "hook-entry",
      message: "the hook command names no absolute path, so it identifies no entry for the containment and staging checks below to resolve",
    });
  }
  for (const member of pathMembers) {
    if (!isInside(member, input.generationRoot)) {
      findings.push({
        rule: "packed-surface",
        subject: "hook-entry",
        message: `the hook command names ${member}, which is outside the installed generation root ${input.generationRoot}; an installed session would run a path belonging to some other tree`,
      });
      continue;
    }
    const relative = path.relative(input.generationRoot, member).split(path.sep).join("/");
    if (staged.has(relative)) continue;
    findings.push({
      rule: "packed-surface",
      subject: "hook-entry",
      message: `the hook command names ${relative}, which the composition manifest does not stage; the command resolves in a source checkout and names nothing in an installed generation`,
    });
  }
  return findings;
}

export interface PolicyIndependenceInput {
  readonly delivered: readonly string[];
  readonly distinctGateConfigDigests: number;
  readonly declared: number;
}

/**
 * The release claim, decided. Every declared repository reached merge-ready
 * AND each compiled to its own policy. Two repositories that happened to
 * compile identically would satisfy every other assertion in this lane while
 * proving nothing about policy independence, which is the failure this exists
 * to catch.
 */
export function policyIndependenceFindings(input: PolicyIndependenceInput): readonly QualificationFinding[] {
  if (input.delivered.length !== input.declared) return [];
  if (input.distinctGateConfigDigests === input.declared) return [];
  return [
    {
      rule: "policy-independence",
      subject: "compiled-policy",
      message: `${input.delivered.length} repositories were driven but only ${input.distinctGateConfigDigests} distinct gate configurations were observed; the second repository did not actually change its policy, so "different policy, same product" is unproven`,
    },
  ];
}

/**
 * THE OBSERVATION-LEVEL VERDICT: both judgements the lane makes about a
 * finished run, composed in one place.
 *
 * Composing them here rather than at the call site is what makes the
 * composition itself falsifiable. The lane's single exit calls this, and the
 * suite drives the lane on a degenerate input to prove the exit calls it — but
 * that input can only ever witness the vacuity half, because a run that
 * delivered nothing has no policy comparison to make. Dropping either rule
 * from THIS function is a one-line mutation the suite catches directly.
 */
export function decideObservations(
  observed: QualificationObservations,
  declaredSpecs: number,
): readonly QualificationFinding[] {
  return [
    ...policyIndependenceFindings({
      delivered: observed.repositoriesDelivered,
      distinctGateConfigDigests: observed.distinctGateConfigDigests,
      declared: declaredSpecs,
    }),
    ...antiVacuityFindings({
      declaredSpecs,
      delivered: observed.repositoriesDelivered,
      negativeProbesSatisfied: observed.negativeProbesSatisfied,
      lifecycleStepsProven: observed.lifecycleStepsProven,
      perRepositoryProcessInventory: observed.perRepositoryProcessInventory,
    }),
  ];
}

export interface AntiVacuityInput {
  readonly declaredSpecs: number;
  readonly delivered: readonly string[];
  readonly negativeProbesSatisfied: readonly string[];
  readonly lifecycleStepsProven: readonly string[];
  /** Per repository, so one lane's observations cannot cover for the other's. */
  readonly perRepositoryProcessInventory: Readonly<Record<string, readonly string[]>>;
}

/**
 * Every way this lane could report green while having proven nothing. The
 * enumerating mechanisms are checked alongside the members: a claim about
 * "every disposable repository" is free when the set is empty, so the SIZE of
 * the declared set is pinned rather than only its contents.
 */
export function antiVacuityFindings(input: AntiVacuityInput): readonly QualificationFinding[] {
  const findings: QualificationFinding[] = [];
  if (input.delivered.length === 0) {
    findings.push({
      rule: "anti-vacuity",
      subject: "repositories",
      message: "no disposable repository reached merge-ready, so every per-repository assertion passed over an empty set",
    });
  }
  if (input.declaredSpecs < 2) {
    findings.push({
      rule: "anti-vacuity",
      subject: "repository-set",
      message: `the lane declares ${input.declaredSpecs} disposable repository specification(s); the release claim is about a SECOND repository, so fewer than two makes the policy-independence lane vacuous`,
    });
  }
  for (const probe of REQUIRED_NEGATIVE_PROBES) {
    if (input.negativeProbesSatisfied.includes(probe)) continue;
    findings.push({
      rule: "anti-vacuity",
      subject: probe,
      message: `the required negative probe ${probe} did not run to its expected refusal; an unrun probe is not a passing one`,
    });
  }
  for (const step of REQUIRED_LIFECYCLE_STEPS) {
    if (input.lifecycleStepsProven.includes(step)) continue;
    findings.push({
      rule: "anti-vacuity",
      subject: step,
      message: `the required lifecycle step ${step} was not proven; the update and rollback claims rest on it`,
    });
  }
  // PER LANE, not across the run. A single shared counter is the
  // absence-assertion trap in miniature: if one lane stopped routing through
  // the injected port, the other lane's processes would keep the total
  // non-zero and the general claim "both lanes were instrumented" would pass
  // over an empty observation.
  for (const repositoryId of input.delivered) {
    if ((input.perRepositoryProcessInventory[repositoryId] ?? []).length > 0) continue;
    findings.push({
      rule: "anti-vacuity",
      subject: `process-inventory/${repositoryId}`,
      message: `${repositoryId} reached merge-ready but its process inventory is empty; an inventory that observed nothing cannot support the claim that this lane launched no agent runtime`,
    });
  }
  return findings;
}

/** Every spawned child is fully captured, so the lane's report is the report. */
const CAPTURED: StdioOptions = ["ignore", "pipe", "pipe"];

const NOW = "2026-08-31T12:00:00Z";
const LATER = "2026-08-31T12:00:30Z";
const HOST_VERSION = "2.1.97";

/**
 * The attestation expiry, taken from the AMBIENT clock rather than written as
 * a literal.
 *
 * This lane drives the real model-external interceptor, which is spawned and
 * compares the expiry against the wall clock rather than against the injected
 * `NOW` above. A literal expiry therefore ages into a lane that fails on a
 * DATE rather than on a change; pushing it forward only re-arms that on a
 * later day. Deriving it states what the lane means — the attestation is valid
 * at the instant the interceptor reads it.
 */
const EXPIRY = `${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19)}Z`;

// ── The two disposable repositories ──────────────────────────────────────────

/**
 * A disposable repository's whole definition: the policy that governs it, the
 * contract it accepts, and the bytes that satisfy that contract. The two
 * members below differ in every field a repository owner controls, which is
 * what makes the "same product, different policy" claim falsifiable — two
 * entries that happened to be equal would satisfy every assertion in this file
 * and prove nothing, so `policy-independence` pins that they are not.
 */
export interface DisposableSpec {
  readonly repositoryId: string;
  readonly gateId: string;
  /**
   * The identity token this repository computes under. `deliverable-tree/v1`
   * pins its own narration set, so a repository that wants a different neutral
   * tree must declare a consumer-owned token — which is precisely the shape of
   * "a second repository changes policy", and is why the two specs differ here
   * rather than only in their path spellings.
   */
  readonly identityVersion: string;
  readonly reviewNeutralPrefixes: readonly string[];
  readonly deliveryRecordDir: string;
  readonly sourceRelativePath: string;
  readonly exportName: string;
  readonly contractedValue: string;
  readonly contractId: string;
  readonly criterionId: string;
  readonly testGlob: string;
  /**
   * Which intake lane the handover uses. Both end at the SAME single operator
   * confirmation on the binding-owned channel — the difference is whether a
   * product-owned scoping turn ran first. Driving one repository through each
   * is what makes "outcome-only iterative scoping, from packed artifacts" a
   * proven claim rather than a fixture-leg one.
   */
  readonly intakeMode: "already-scoped" | "outcome-only";
}

export const DISPOSABLE_SPECS: readonly DisposableSpec[] = Object.freeze([
  Object.freeze({
    repositoryId: "disposable-alpha",
    gateId: "alpha.pr-admission",
    // The shipped identity token, with exactly the narration set it pins.
    identityVersion: "deliverable-tree/v1",
    reviewNeutralPrefixes: ["docs/reports/", "docs/solutions/", "telemetry/delivery-runs/"],
    deliveryRecordDir: "telemetry/delivery-runs/",
    sourceRelativePath: "src/greet.mjs",
    exportName: "greet",
    contractedValue: "hello, alpha",
    contractId: "contract-alpha-greeting",
    criterionId: "greeting-behavior",
    testGlob: "tests/**",
    intakeMode: "already-scoped",
  }),
  Object.freeze({
    repositoryId: "disposable-beta",
    gateId: "beta.merge-admission",
    // A consumer-owned identity token, a different neutral tree, a different
    // source layout, a different contracted outcome, and a different test
    // classification: nothing about beta's policy is alpha's.
    identityVersion: "beta-tree/v1",
    reviewNeutralPrefixes: ["docs/notes/", "audit/runs/"],
    deliveryRecordDir: "audit/runs/",
    sourceRelativePath: "lib/label.mjs",
    exportName: "label",
    contractedValue: "beta-label",
    contractId: "contract-beta-label",
    criterionId: "label-behavior",
    testGlob: "spec/**",
    intakeMode: "outcome-only",
  }),
]);

/** The acceptance sensor, generated per repository from its own contract. */
function sensorSource(spec: DisposableSpec): string {
  return `// The disposable repository's acceptance sensor: the intended outcome,
// executable. Exit 0 exactly when ${spec.exportName}() returns the contracted value.
const expected = ${JSON.stringify(spec.contractedValue)};
try {
  const mod = await import(new URL(${JSON.stringify(spec.sourceRelativePath)}, \`file://\${process.cwd()}/\`).href);
  const actual = mod.${spec.exportName}();
  if (actual === expected) {
    console.log(\`sensor.acceptance passed: \${JSON.stringify(actual)}\`);
    process.exit(0);
  }
  console.error(\`sensor.acceptance failed: got \${JSON.stringify(actual)}\`);
  process.exit(1);
} catch (error) {
  console.error(\`sensor.acceptance failed: \${error instanceof Error ? error.message : String(error)}\`);
  process.exit(1);
}
`;
}

/**
 * The reviewer charters the repository owns, read by the facade from the
 * TRUSTED PRE-RUN BASE. Deliberately minimal: what the lane proves is that the
 * charter a reviewer was handed is bound into the evidence, not what any
 * particular charter says.
 */
const PERSONA_MARKDOWN: Readonly<Record<string, string>> = Object.freeze({
  "delivery/personas/outcome-correctness.md":
    "# Outcome correctness\n\nJudge whether the candidate achieves the contracted outcome.\n",
  "delivery/personas/testing-policy.md":
    "# Testing and policy\n\nJudge whether the delivered sensors falsify the contracted outcome.\n",
});

/** The gate configuration, one literal per repository, rendered twice. */
function gateConfigInput(spec: DisposableSpec): Record<string, unknown> {
  return {
    gateId: spec.gateId,
    baseRef: "main",
    storageNamespace: "delivery-harness/",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: [spec.identityVersion],
    computingIdentityVersion: spec.identityVersion,
    reviewNeutral: spec.reviewNeutralPrefixes.map((prefix) => ({ prefix })),
    recordNeutral: [{ prefix: spec.deliveryRecordDir }],
    pathClassification: {
      generated: [],
      test: [{ kind: "glob", value: spec.testGlob }],
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
        waivableCodes: ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings"],
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
    deliveryRecordPath: `${spec.deliveryRecordDir}record.json`,
    deliveryRecordVerification: { baseMovement: "stale" },
  };
}

/** The accepted contract the repository's owner hands over. */
function acceptedContract(spec: DisposableSpec): Record<string, unknown> {
  return {
    spec: "scoped-delivery-contract/1",
    contractId: spec.contractId,
    task: `add the contracted ${spec.exportName} module`,
    intendedOutcome: `${spec.sourceRelativePath} exports ${spec.exportName}() returning exactly ${JSON.stringify(spec.contractedValue)}`,
    acceptanceCriteria: [
      { criterionId: spec.criterionId, statement: `${spec.exportName}() returns ${JSON.stringify(spec.contractedValue)}` },
    ],
    nonGoals: ["no tracker", "no merge or deploy"],
    repository: { repositoryId: spec.repositoryId, baseRef: "main" },
    requestedFinishLine: "merge-ready",
    requestedAuthority: [],
    unresolvedDecisions: [],
  };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const commitAll = (cwd: string, message: string): void => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "--no-gpg-sign", "-m", message);
};

const treeOf = (worktree: string): string => git(worktree, "rev-parse", "HEAD^{tree}");

/**
 * Stamps one disposable repository at its trusted pre-run base: the gate
 * config, its own acceptance sensor, its reviewer charters, and the kernel
 * link the tracked config imports — which points at the INSTALLED tree, never
 * at a source checkout.
 */
export function buildDisposableRepository(repoDir: string, spec: DisposableSpec, kernelDir: string): { readonly repoDir: string; readonly baseCommit: string } {
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "--quiet", "--initial-branch", "main");
  git(repoDir, "config", "user.email", "qualification@example.invalid");
  git(repoDir, "config", "user.name", "Product Qualification");
  git(repoDir, "config", "commit.gpgsign", "false");

  writeFileSync(
    path.join(repoDir, "package.json"),
    `${JSON.stringify({ name: spec.repositoryId, private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n.delivery-harness/\n");
  writeFileSync(
    path.join(repoDir, "harness.config.ts"),
    `import { defineHarnessConfig } from "@agent-delivery-harness/kernel";\n\nexport default defineHarnessConfig(${JSON.stringify(gateConfigInput(spec), null, 2)});\n`,
  );
  mkdirSync(path.join(repoDir, "tools"), { recursive: true });
  writeFileSync(path.join(repoDir, "tools", "sensor.mjs"), sensorSource(spec));
  for (const [relative, contents] of Object.entries(PERSONA_MARKDOWN)) {
    const target = path.join(repoDir, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const sourceDir = path.dirname(path.join(repoDir, ...spec.sourceRelativePath.split("/")));
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "README.md"), "the contracted module lands here\n");

  // The consumption wiring an adopter has: the tracked config resolves the
  // kernel from an INSTALLED tree. A symlink into `packages/` here would make
  // the whole lane a source-checkout run wearing a disposable repository's
  // clothes, which is the exact substitution this unit forbids.
  mkdirSync(path.join(repoDir, "node_modules", "@agent-delivery-harness"), { recursive: true });
  symlinkSync(kernelDir, path.join(repoDir, "node_modules", "@agent-delivery-harness", "kernel"));

  git(repoDir, "add", ".");
  git(repoDir, "commit", "--quiet", "--no-gpg-sign", "-m", `${spec.repositoryId} base`);
  return { repoDir, baseCommit: git(repoDir, "rev-parse", "HEAD") };
}

// ── The lane ─────────────────────────────────────────────────────────────────

export interface QualificationInput {
  /** The checkout the composition is packed FROM. Read-only input. */
  readonly sourceRoot: string;
  readonly workRoot?: string;
  readonly log?: (line: string) => void;
}

/** Generation roots are installed read-only; removal needs the bit back first. */
function restoreWritable(dir: string): void {
  try {
    execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
  } catch {
    /* removal surfaces the real failure */
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const withOutput = error as Error & { readonly stderr?: unknown; readonly stdout?: unknown };
    const stderr = typeof withOutput.stderr === "string" ? withOutput.stderr.trim() : "";
    const stdout = typeof withOutput.stdout === "string" ? withOutput.stdout.trim() : "";
    const tail = [stderr, stdout].filter((part) => part !== "").join("\n");
    return tail === "" ? error.message : `${error.message}\n${tail}`;
  }
  return String(error);
}

const blockerCodes = (result: unknown): string[] => {
  const blockers = (result as { blockers?: readonly { code?: string }[] } | undefined)?.blockers ?? [];
  return blockers.map((blocker) => String(blocker.code));
};

export async function runProductQualification(input: QualificationInput): Promise<QualificationResult> {
  const log = input.log ?? ((): void => {});
  const findings: QualificationFinding[] = [];
  const repositoriesDelivered: string[] = [];
  const negativeProbesSatisfied: string[] = [];
  const lifecycleStepsProven: string[] = [];
  const gateConfigDigests = new Set<string>();
  const perRepositoryProcessInventory: Record<string, Set<string>> = {};
  let generationDigest = "";
  let installationId = "";
  let workflowGraphSha256 = "";

  const workRoot = input.workRoot ?? os.tmpdir();
  mkdirSync(workRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(workRoot, "dh-product-qualification-"));
  log(`work dir: ${scratch}`);

  const observations = (): QualificationObservations => ({
    generationDigest,
    installationId,
    workflowGraphSha256,
    repositoriesDelivered,
    distinctGateConfigDigests: gateConfigDigests.size,
    productProcessInventory: [
      ...new Set(Object.values(perRepositoryProcessInventory).flatMap((set) => [...set])),
    ].sort(),
    perRepositoryProcessInventory: Object.fromEntries(
      Object.entries(perRepositoryProcessInventory).map(([id, set]) => [id, [...set].sort()]),
    ),
    negativeProbesSatisfied,
    lifecycleStepsProven,
  });

  /**
   * THE ONLY WAY OUT OF THIS FUNCTION.
   *
   * The observation-level judgements — did every declared repository deliver
   * under its own policy, and did the run actually prove anything — are
   * applied HERE rather than as a step near the end. A step can be deleted,
   * and a lane that lost it would report `clean` on a run that drove zero
   * repositories and proved zero probes: exactly the vacuous pass those rules
   * exist to prevent. Composing them at the single exit means every path,
   * including every early return, is decided.
   */
  const finish = (): QualificationResult => {
    const observed = observations();
    return { findings: [...findings, ...decideObservations(observed, DISPOSABLE_SPECS.length)], observations: observed };
  };

  try {
    // ── 1. The publishable tarballs, installed outside the workspace ─────────
    const installTree = await installPackedPackages(input.sourceRoot, scratch, findings, log);
    if (installTree === undefined) return finish();

    // The INSTALLER comes from the tarball tree — the operator-facing surface.
    //
    // Resolved through the package's own `exports` map rather than by joining
    // a path into its `src/`, because those are different surfaces and only
    // one of them is published. Reaching into `src/` would load a module the
    // package may not export at all, and the lane would then be qualifying a
    // layout instead of a package.
    const installerModule = createRequire(path.join(installTree, "resolve-from-here.cjs")).resolve(
      "@agent-delivery-harness/kernel",
    );
    const installer = (await import(pathToFileURL(installerModule).href)) as Record<string, any>;
    findings.push(...publishedSurfaceFindings(Object.keys(installer)));

    // ── 2. Pack and install a composition generation ─────────────────────────
    const fixtures = path.join(input.sourceRoot, "qualifications", "fixtures");
    const pack = async (sequence: number, profile: "production" | "confirmation-fixture", label: string): Promise<any> =>
      installer["packComposition"]({
        sourceRoot: input.sourceRoot,
        skillsArchivePath: path.join(fixtures, "agent-skills-core-v1-composition.zip"),
        skillsMetadataPath: path.join(fixtures, "agent-skills-core-v1-composition.metadata.json"),
        compositionProfile: profile,
        compositionSequence: sequence,
        outDir: path.join(scratch, `pack-${label}`),
      });
    const packOne = async (sequence: number): Promise<any> => pack(sequence, "confirmation-fixture", String(sequence));

    const packed = await packOne(1);
    if (packed.ok !== true) {
      findings.push({ rule: "composition-failed", subject: "pack", message: JSON.stringify(packed) });
      return finish();
    }
    generationDigest = packed.generationDigest;

    const installationPath = path.join(scratch, "installation");
    const receiptDir = path.join(scratch, "user-config");
    const installed = await installer["installComposition"]({
      packedDir: packed.packedDir,
      installationPath,
      receiptDir,
      // The operator-supplied qualification flag naming BOTH disposable
      // repositories. Use-time binding: the receipt, not the repository, is
      // what makes a repository eligible.
      qualification: { disposableRepositoryIds: DISPOSABLE_SPECS.map((spec) => spec.repositoryId) },
      assertionProvider: { sourceKind: "qualification-fixture" },
    });
    if (installed.ok !== true) {
      findings.push({ rule: "composition-failed", subject: "install", message: JSON.stringify(installed) });
      return finish();
    }
    installationId = installed.installationId;
    log(`installed generation ${generationDigest} as ${installationId}`);

    // ── 3. The PRODUCT, loaded from the installed generation root ────────────
    const generationRoot: string = installed.root;
    const productModule = path.join(generationRoot, "harness", "packages", "kernel", "src", "index.ts");
    if (!existsSync(productModule)) {
      findings.push({
        rule: "product-provenance",
        subject: "generation-root",
        message: `the installed generation carries no kernel entry at ${productModule}; the lane cannot drive a delivery from a packed artifact`,
      });
      return finish();
    }
    const product = (await import(pathToFileURL(productModule).href)) as Record<string, any>;
    workflowGraphSha256 = String(product["PINNED_AGENT_SKILLS"]?.workflowGraphSha256 ?? "");

    // ── What makes "packed artifacts only" a claim rather than a comment ─────
    //
    // NOT by asserting the module path is inside the generation root: that
    // path is one this file just built out of `generationRoot`, so the
    // assertion has no failing input and would be a finding id spent on
    // nothing. What DOES carry the claim is binding the loaded BYTES to the
    // manifest — the manifest hashes to the addressed generation, the entry
    // this lane imported is one of its inventory members, and that file's
    // bytes re-hash to the inventory's recorded digest. A generation root
    // edited after installation fails that; a tautology would not.
    //
    // ── THE CLOSURE AUDIT, RUN FROM THE INSTALLED PACKAGE ────────────────────
    //
    // `installer` here is the module the tarball tree's `exports` map resolves
    // to, so this call is the adopter's call: it proves the verifier is
    // INVOCABLE from an installed copy, not merely present in a checkout. A
    // named export that resolves to `undefined` is the shape this catches —
    // the name check above sees a key, and only a call sees a function.
    const closure = installer["verifyGenerationClosure"];
    if (typeof closure !== "function") {
      findings.push({
        rule: "packed-surface",
        subject: "verifyGenerationClosure",
        message: "the name resolved through `exports` is not callable, so an installed copy cannot audit its own generation",
      });
    } else {
      const verified = await closure(generationRoot, generationDigest);
      if (verified?.ok !== true) {
        findings.push({
          rule: "packed-surface",
          subject: "verifyGenerationClosure",
          message: `the published closure verifier refused the generation it was just handed: ${JSON.stringify(verified)}`,
        });
      } else {
        log(`published closure verifier accepted generation ${verified.generationDigest}`);
      }
    }

    // The membership binding below is kept alongside it: closure says the root
    // is internally consistent, and this says the ENTRY THIS LANE IMPORTED is
    // one of its bound members — a different claim, and the one that makes
    // "packed artifacts only" about the bytes that ran.
    const manifestPath = path.join(generationRoot, installer["COMPOSITION_MANIFEST_FILE"]);
    const manifestBytes = readFileSync(manifestPath, "utf8");
    if (installer["generationDigestOf"](manifestBytes) !== generationDigest) {
      findings.push({
        rule: "product-provenance",
        subject: "manifest",
        message: `the installed manifest at ${manifestPath} does not hash to the addressed generation ${generationDigest}`,
      });
    }
    const manifest = JSON.parse(manifestBytes) as { readonly inventory?: readonly { readonly path: string; readonly sha256: string }[] };
    const entryPath = path.relative(generationRoot, productModule).split(path.sep).join("/");
    const inventoryEntry = (manifest.inventory ?? []).find((item) => item.path === entryPath);
    if (inventoryEntry === undefined) {
      findings.push({
        rule: "product-provenance",
        subject: "kernel",
        message: `${entryPath} is not an inventory entry of generation ${generationDigest}, so the bytes this lane drove are not bound by the composition manifest`,
      });
    } else if (installer["sha256Hex"](readFileSync(productModule)) !== inventoryEntry.sha256) {
      findings.push({
        rule: "product-provenance",
        subject: "kernel",
        message: `${entryPath} does not hash to the manifest's ${inventoryEntry.sha256}; the generation root was edited after installation`,
      });
    }

    /** What the composition actually staged — the set every emitted path is resolved against. */
    const stagedRelativePaths: readonly string[] = (manifest.inventory ?? []).map((item) => item.path);

    // ── 4. Drive both disposable repositories to merge-ready ─────────────────
    const installedKernelDir = path.join(installTree, "node_modules", "@agent-delivery-harness", "kernel");
    for (const spec of DISPOSABLE_SPECS) {
      const outcome = await driveRepository({
        spec,
        scratch,
        product,
        installationPath,
        receiptDir,
        kernelDir: installedKernelDir,
        generationRoot,
        stagedRelativePaths,
        findings,
        processInventory: (perRepositoryProcessInventory[spec.repositoryId] ??= new Set<string>()),
        log,
      });
      if (outcome === undefined) continue;
      repositoriesDelivered.push(spec.repositoryId);
      gateConfigDigests.add(outcome.gateConfigDigest);
    }

    // ── 5. Negative probes ───────────────────────────────────────────────────
    await runNegativeProbes({
      scratch,
      sourceRoot: input.sourceRoot,
      installer,
      product,
      pack,
      packedDir: packed.packedDir,
      installationPath,
      receiptDir,
      kernelDir: installedKernelDir,
      generationRoot,
      generationDigest,
      findings,
      satisfied: negativeProbesSatisfied,
      log,
    });

    // ── 6. Composition lifecycle: two updates, resume, rollback ──────────────
    await runLifecycle({
      installer,
      packOne,
      installationPath,
      receiptDir,
      priorDigest: generationDigest,
      findings,
      proven: lifecycleStepsProven,
      log,
    });

  } finally {
    restoreWritable(scratch);
    rmSync(scratch, { recursive: true, force: true });
  }

  return finish();
}

/** Path containment that cannot be satisfied by a shared prefix. */
export function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// ── Step 1: pack and install the publishable tarballs ────────────────────────

async function installPackedPackages(
  sourceRoot: string,
  scratch: string,
  findings: QualificationFinding[],
  log: (line: string) => void,
): Promise<string | undefined> {
  const packageScope = "@agent-delivery-harness";
  const leaves = ["kernel", "cli", "conformance", "mcp", "action"];
  const tarballDir = path.join(scratch, "tarballs");
  mkdirSync(tarballDir, { recursive: true });

  const tarballs: Record<string, string> = {};
  for (const leaf of leaves) {
    try {
      const stdout = execFileSync("npm", ["pack", "--json", "--pack-destination", tarballDir], {
        cwd: path.join(sourceRoot, "packages", leaf),
        encoding: "utf8",
        timeout: STEP_TIMEOUT_MS,
        stdio: CAPTURED,
      });
      const filename = (JSON.parse(stdout) as readonly { readonly filename: string }[])[0]?.filename;
      if (filename === undefined) {
        findings.push({ rule: "pack-failed", subject: leaf, message: "npm pack reported no tarball filename" });
        continue;
      }
      tarballs[`${packageScope}/${leaf}`] = `file:${path.join(tarballDir, filename)}`;
    } catch (error) {
      findings.push({ rule: "pack-failed", subject: leaf, message: describe(error) });
    }
  }
  if (findings.length > 0) return undefined;

  const installDir = path.join(scratch, "product-install");
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    path.join(installDir, "package.json"),
    `${JSON.stringify(
      { name: "product-qualification-install", version: "0.0.0", private: true, type: "module", dependencies: tarballs, overrides: tarballs },
      null,
      2,
    )}\n`,
  );
  try {
    execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"], {
      cwd: installDir,
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
      stdio: CAPTURED,
    });
  } catch (error) {
    findings.push({ rule: "install-failed", subject: "product-install", message: `${installDir}: ${describe(error)}` });
    return undefined;
  }
  log(`installed the packed product into ${installDir}`);
  return installDir;
}

// ── Step 4: one repository, handoff to merge-ready ───────────────────────────

/**
 * The host's own arguments, appended to the facade's runtime-and-entry vector
 * when the session settings are composed: subcommand, state path, fence.
 */
const HOST_APPENDED_HOOK_ARGS = 3;

/** One spelling of a path, or the member unchanged when it names nothing on disk. */
const realpathOrSelf = (member: string): string => {
  try {
    return realpathSync(member);
  } catch {
    return member;
  }
};

/** The JSON-quoted members of a composed hook command line, back as a vector. */
export function parseHookCommandLine(line: string): readonly string[] {
  return (line.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((token) => JSON.parse(token) as string);
}

interface EmittedHookInput {
  readonly settingsPath: string;
  readonly generationRoot: string;
  readonly stagedRelativePaths: readonly string[];
  readonly subject: string;
  readonly findings: QualificationFinding[];
  readonly log: (line: string) => void;
}

/**
 * THE EMITTED HOOK COMMAND, CHECKED AND THEN RUN.
 *
 * Checking is not enough on its own and running is not enough on its own. A
 * command can name a staged path and still fail to start, and a command can
 * start under a runtime this lane happens to have while naming a path no
 * installed generation carries. So the vector is decided by the pure rule
 * first, and then EXECUTED against the installed generation with a state path
 * that does not exist — deny-until-attested, so the interceptor's own refusal
 * on stdout is proof the staged entry ran rather than proof of a decision.
 */
function checkEmittedHookCommand(input: EmittedHookInput): void {
  const settings = JSON.parse(readFileSync(input.settingsPath, "utf8")) as {
    hooks?: { PreToolUse?: { hooks?: { command?: string }[] }[] };
  };
  const line = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (line === undefined) {
    input.findings.push({
      rule: "packed-surface",
      subject: input.subject,
      message: `the composed session settings at ${input.settingsPath} carry no PreToolUse hook command, so there is no emitted command to resolve`,
    });
    return;
  }
  const parsed = parseHookCommandLine(line);
  const command = parsed.slice(0, Math.max(0, parsed.length - HOST_APPENDED_HOOK_ARGS));
  input.findings.push(
    ...hookCommandFindings({
      // Both sides resolved through the real filesystem before they are
      // compared. A containment rule fed one spelling of a directory and a
      // symlinked spelling of the same directory reports a defect that is not
      // there — and on this platform's temp root, that is the DEFAULT
      // spelling, so an unresolved comparison would be red for a reason that
      // has nothing to do with the packed surface.
      command: command.map(realpathOrSelf),
      generationRoot: realpathOrSelf(input.generationRoot),
      stagedRelativePaths: input.stagedRelativePaths,
      nodeExecutable: realpathOrSelf(process.execPath),
    }).map((finding) => ({ ...finding, subject: `${input.subject}/${finding.subject}` })),
  );
  if (command.length === 0) return;

  const absentState = path.join(path.dirname(input.settingsPath), "no-such-binding-state.json");
  let stdout: string;
  try {
    stdout = execFileSync(command[0]!, [...command.slice(1), "pre-tool-use", absentState, "1"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: {} }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: STEP_TIMEOUT_MS,
    });
  } catch (error) {
    input.findings.push({
      rule: "packed-surface",
      subject: `${input.subject}/hook-execution`,
      message: `the emitted hook command did not run against the installed generation: ${String((error as { stderr?: unknown })?.stderr ?? error)}`,
    });
    return;
  }
  if (!stdout.includes(`"permissionDecision":"deny"`)) {
    input.findings.push({
      rule: "packed-surface",
      subject: `${input.subject}/hook-execution`,
      message: `the emitted hook command ran but produced no deny decision for an unattested session: ${JSON.stringify(stdout)}`,
    });
    return;
  }
  input.log(`${input.subject}: the emitted hook command ran from the installed generation and denied`);
}

interface DriveInput {
  readonly spec: DisposableSpec;
  readonly scratch: string;
  readonly product: Record<string, any>;
  readonly installationPath: string;
  readonly receiptDir: string;
  readonly kernelDir: string;
  /** The installed generation root the bound session's hook command must resolve against. */
  readonly generationRoot: string;
  /** Generation-relative paths the composition manifest stages, for that resolution. */
  readonly stagedRelativePaths: readonly string[];
  readonly findings: QualificationFinding[];
  readonly processInventory: Set<string>;
  readonly log: (line: string) => void;
}

/**
 * The outcome-only lane: a work request carrying no contract, one clarification
 * exchange, the drafted contract retained, and that draft presented for the ONE
 * operator confirmation. The scoping turn runs under the READ-ONLY intake grant
 * the facade mints — never a mutation-capable one — and the confirmation that
 * ends it is the same channel the already-scoped lane uses.
 */
async function openOutcomeOnlyIntake(
  facade: any,
  spec: DisposableSpec,
  contract: Record<string, unknown>,
): Promise<any> {
  const opened = await facade.openIntake({
    workRequest: `the repository needs a ${spec.exportName} module; the exact wording of what it returns is not settled yet`,
    observedAt: NOW,
    attestationExpiry: EXPIRY,
  });
  if (opened.ok !== true) return opened;
  const clarified = await facade.recordClarification({
    intakeId: opened.intakeId,
    question: `what exactly should ${spec.exportName}() return?`,
    answer: `exactly ${JSON.stringify(spec.contractedValue)}`,
  });
  if (clarified.ok !== true) return clarified;
  const drafted = await facade.recordDraft({ intakeId: opened.intakeId, draft: contract });
  if (drafted.ok !== true) return drafted;
  const presented = await facade.presentDraft({ intakeId: opened.intakeId, expiry: EXPIRY });
  if (presented.ok !== true) return presented;
  return { ...presented, intakeId: opened.intakeId };
}

async function driveRepository(input: DriveInput): Promise<{ readonly gateConfigDigest: string } | undefined> {
  const { spec, product, findings, log } = input;
  const repoDir = path.join(input.scratch, `repo-${spec.repositoryId}`);
  const repo = buildDisposableRepository(repoDir, spec, input.kernelDir);

  // Every process the PRODUCT launches rides this port and is inventoried.
  const inner = product["createExecPort"]();
  const exec = {
    run(invocation: { readonly command: string; readonly args?: readonly string[] }) {
      input.processInventory.add(path.basename(invocation.command));
      const forbidden = forbiddenProcessFinding(spec.repositoryId, invocation.command, invocation.args ?? []);
      if (forbidden !== undefined) findings.push(forbidden);
      return inner.run(invocation);
    },
  };

  const configModule = await import(pathToFileURL(path.join(repoDir, "harness.config.ts")).href);
  const facade = product["createManagedDeliveryFacade"]({
    repoDir,
    config: configModule.default,
    installation: { installationPath: input.installationPath, receiptDir: input.receiptDir },
    hostVersion: HOST_VERSION,
    exec,
  });

  const fail = (stage: string, result: unknown): undefined => {
    findings.push({
      rule: "delivery-failed",
      subject: spec.repositoryId,
      message: `${stage}: ${JSON.stringify(result)}`,
    });
    return undefined;
  };

  const operatorEcho = (channelPath: string): Record<string, unknown> => {
    const pending = JSON.parse(readFileSync(channelPath, "utf8")) as { rendered: { challenge: unknown; channelId: unknown } };
    return {
      presentedChallenge: pending.rendered.challenge,
      presentedOnChannelId: pending.rendered.channelId,
      observedAt: NOW,
      viaModelVisibleSurface: false,
      interactive: true,
    };
  };

  // ── Intake, in whichever lane this repository declares ──
  //
  // Both lanes converge on the SAME single operator confirmation on the
  // binding-owned channel. The outcome-only lane runs a product-owned scoping
  // turn first — a work request with no contract, one clarification exchange,
  // a retained draft, and the draft presented for that one confirmation — so
  // the release claim about iterative scoping is proven from packed artifacts
  // rather than deferred to a source-imported fixture.
  const contract = acceptedContract(spec);
  const presented =
    spec.intakeMode === "already-scoped"
      ? await facade.presentContract({ contract, expiry: EXPIRY })
      : await openOutcomeOnlyIntake(facade, spec, contract);
  if (presented.ok !== true) return fail(`intake(${spec.intakeMode})`, presented);

  // A model-minted confirmation is refused even with the right challenge
  // bytes. This is the ALLOW side's control: the confirmation below proves the
  // channel is not simply refusing everything.
  const minted = await facade.confirmContract({
    intakeId: presented.intakeId,
    echo: { ...operatorEcho(presented.channelPath), viaModelVisibleSurface: true },
  });
  if (minted.ok === true) {
    findings.push({
      rule: "negative-probe",
      subject: `${spec.repositoryId}/model-minted-confirmation`,
      message: "a confirmation arriving through a model-visible surface was accepted",
    });
  }

  const confirmed = await facade.confirmContract({ intakeId: presented.intakeId, echo: operatorEcho(presented.channelPath) });
  if (confirmed.ok !== true) return fail("confirmContract", confirmed);
  const deliveryId: string = confirmed.deliveryId;
  log(`${spec.repositoryId}: registered ${deliveryId}`);

  // ── The HOST creates the worktree; the product only binds it ──
  const worktree = path.join(input.scratch, `worktree-${spec.repositoryId}`);
  git(repoDir, "worktree", "add", "--quiet", "-b", "delivery", worktree, "main");
  const bound = await facade.bindWorkspace({
    deliveryId,
    worktreeDir: worktree,
    hostTaskId: `host-task-${spec.repositoryId}`,
    observedAt: NOW,
    attestationExpiry: EXPIRY,
  });
  if (bound.ok !== true) return fail("bindWorkspace", bound);
  const fence: number = bound.fence;

  // ── The session's model-external hook command, as an installed generation
  //    would actually run it ──
  //
  // Read back off the composed settings file rather than from the facade's
  // return value: the settings file is what the host reads, so a command that
  // is correct in memory and wrong on disk is still wrong. The host appends
  // its own three arguments, so the RUNTIME-AND-ENTRY prefix is what the
  // staging rule resolves.
  checkEmittedHookCommand({
    settingsPath: bound.settingsPath,
    generationRoot: input.generationRoot,
    stagedRelativePaths: input.stagedRelativePaths,
    subject: spec.repositoryId,
    findings: input.findings,
    log: input.log,
  });

  const stageBytes = (stageId: string, outputKind: string, candidate?: string): string =>
    JSON.stringify({
      schemaVersion: "workflow-stage-result/1",
      release: {
        releaseId: product["PINNED_AGENT_SKILLS"].releaseId,
        profile: product["PINNED_AGENT_SKILLS"].profile,
        archiveSha256: product["PINNED_AGENT_SKILLS"].archiveSha256,
        metadataSha256: product["PINNED_AGENT_SKILLS"].metadataSha256,
      },
      graphSha256: product["PINNED_AGENT_SKILLS"].workflowGraphSha256,
      stageId,
      subjectRef: { schemaVersion: "workflow-subject-ref/1", opaque: deliveryId },
      ...(candidate === undefined ? {} : { candidateRef: { schemaVersion: "workflow-candidate-ref/1", opaque: candidate } }),
      status: "succeeded",
      output: { kind: outputKind, evidenceRef: "retained-output" },
      evidenceRefs: ["retained-observation"],
      limitations: [],
    });

  // ── Plan ──
  const planned = await facade.submitStageResult({
    deliveryId,
    stageId: "plan",
    resultBytes: stageBytes("plan", "bounded-plan", treeOf(worktree)),
    fence,
  });
  if (planned.ok !== true) return fail("submitStageResult(plan)", planned);

  // ── Implement: the contracted module ──
  const sourcePath = path.join(worktree, ...spec.sourceRelativePath.split("/"));
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, `export function ${spec.exportName}() {\n  return ${JSON.stringify(spec.contractedValue)};\n}\n`);
  commitAll(worktree, `implement ${spec.exportName}`);
  const checkpointed = await facade.checkpointCandidate({
    deliveryId,
    resultBytes: stageBytes("implement", "delivery-candidate", treeOf(worktree)),
    fence,
  });
  if (checkpointed.ok !== true) return fail("checkpointCandidate", checkpointed);

  // ── The repository's own trusted sensor ──
  const sensor = await facade.runSensor({ deliveryId, fence });
  if (sensor.ok !== true) return fail("runSensor", sensor);
  if (sensor.outcome !== "passed") {
    return fail("runSensor", { outcome: sensor.outcome, note: "the repository's acceptance sensor did not pass its own contracted outcome" });
  }

  // ── Two mandatory lenses, independently constructed contexts ──
  await facade.submitReviewAttempt({
    deliveryId,
    attemptId: `${spec.repositoryId}-outcome`,
    lensId: "lens.outcome-correctness",
    verdict: "approved",
    contextBytes: `outcome lens context for ${spec.repositoryId}: contract, diff, sensor evidence`,
    artifactBytes: `approved: ${spec.exportName}() achieves the contracted outcome`,
    fence,
  });
  await facade.submitReviewAttempt({
    deliveryId,
    attemptId: `${spec.repositoryId}-testing`,
    lensId: "lens.testing-policy",
    verdict: "approved",
    contextBytes: `testing lens context for ${spec.repositoryId}: coverage bound to the exact candidate`,
    artifactBytes: "approved: the acceptance sensor falsifies the contracted outcome",
    fence,
  });
  const reduced = await facade.reduceReview({ deliveryId, fence });
  if (reduced.ok !== true) return fail("reduceReview", reduced);

  // ── Compound, admit, record, merge-ready ──
  const compounded = await facade.submitStageResult({
    deliveryId,
    stageId: "compound",
    resultBytes: stageBytes("compound", "no-reusable-learning", treeOf(worktree)),
    fence,
  });
  if (compounded.ok !== true) return fail("submitStageResult(compound)", compounded);

  const admitted = await facade.admit({ deliveryId, recordedAtInstant: LATER, env: { CLAUDECODE: "1" }, fence });
  if (admitted.ok !== true) return fail("admit", admitted);

  const prepared = await facade.prepareTrackedRecord({ deliveryId, env: { CLAUDECODE: "1" }, fence });
  if (prepared.ok !== true) return fail("prepareTrackedRecord", prepared);
  commitAll(worktree, "tracked delivery record");
  const recorded = await facade.confirmTrackedRecord({ deliveryId, fence });
  if (recorded.ok !== true) return fail("confirmTrackedRecord", recorded);

  const finished = await facade.completeFinishLine({ deliveryId, fence });
  if (finished.ok !== true) return fail("completeFinishLine", finished);
  if (finished.state !== "completed") return fail("completeFinishLine", finished);

  // ── What the completed delivery must report ──
  const status = await facade.status({ deliveryId, observedAt: LATER });
  if (status.ok !== true) return fail("status", status);
  if (status.status.operatorInterventions !== 0) {
    findings.push({
      rule: "delivery-failed",
      subject: spec.repositoryId,
      message: `the delivery required ${status.status.operatorInterventions} operator intervention(s) while the host could proceed`,
    });
  }
  if ((status.status.completedObligations ?? []).length === 0) {
    findings.push({
      rule: "delivery-failed",
      subject: spec.repositoryId,
      message: "the completed delivery reports no discharged obligations, so admission passed over an empty set",
    });
  }
  // The delivery record landed in THIS repository's neutral tree, which is the
  // policy-owned location — proving the record path came from policy and not
  // from a product-wide constant.
  if (!prepared.relativePath.startsWith(spec.deliveryRecordDir)) {
    findings.push({
      rule: "policy-independence",
      subject: spec.repositoryId,
      message: `the tracked record landed at ${prepared.relativePath}, outside this repository's policy-declared neutral tree ${spec.deliveryRecordDir}`,
    });
  }

  log(`${spec.repositoryId}: merge-ready`);
  // The repository's OWN tracked gate configuration, digested by the product's
  // canonicalizer. Two repositories whose owners configured the same gate would
  // collapse this set, which is what the policy-independence lane checks.
  return { gateConfigDigest: String(product["digestCanonical"](configModule.default)) };
}

// ── Step 6: negative probes ──────────────────────────────────────────────────

interface NegativeInput {
  readonly scratch: string;
  readonly sourceRoot: string;
  readonly installer: Record<string, any>;
  readonly product: Record<string, any>;
  /** Packs a composition at the given sequence and profile into its own directory. */
  readonly pack: (sequence: number, profile: "production" | "confirmation-fixture", label: string) => Promise<any>;
  readonly packedDir: string;
  readonly installationPath: string;
  readonly receiptDir: string;
  readonly kernelDir: string;
  readonly generationRoot: string;
  readonly generationDigest: string;
  readonly findings: QualificationFinding[];
  readonly satisfied: string[];
  readonly log: (line: string) => void;
}

/**
 * THE LOUD FAILURE, PROVEN LOUD. An installation whose generation root has
 * lost the staged hook entry refuses to bind a workspace instead of composing
 * a session around a command that names nothing.
 *
 * The ALLOW side is inside the probe rather than assumed from elsewhere: the
 * SAME installation registers the delivery successfully while the entry is
 * still there, so the refusal cannot be explained by an installation that
 * refuses everything.
 */
async function probeBindRefusesMissingHookEntry(
  input: NegativeInput,
  expectRefusal: (probe: string, result: unknown, expectedCode: string) => boolean,
): Promise<void> {
  const probe = "bind-refuses-generation-missing-staged-hook-entry";
  const fail = (message: string): void => {
    input.findings.push({ rule: "packed-surface", subject: probe, message });
  };

  const packed = await input.pack(1, "confirmation-fixture", "missing-hook-entry");
  if (packed.ok !== true) return fail(`the probe could not pack its own composition: ${JSON.stringify(packed)}`);

  const installationPath = path.join(input.scratch, "installation-missing-hook-entry");
  const receiptDir = path.join(input.scratch, "user-config-missing-hook-entry");
  const spec: DisposableSpec = {
    ...DISPOSABLE_SPECS[0]!,
    repositoryId: "disposable-missing-hook-entry",
    contractId: "contract-missing-hook-entry",
  };
  const installed = await input.installer["installComposition"]({
    packedDir: packed.packedDir,
    installationPath,
    receiptDir,
    qualification: { disposableRepositoryIds: [spec.repositoryId] },
    assertionProvider: { sourceKind: "qualification-fixture" },
  });
  if (installed.ok !== true) return fail(`the probe could not install its own generation: ${JSON.stringify(installed)}`);

  const repoDir = path.join(input.scratch, "repo-missing-hook-entry");
  buildDisposableRepository(repoDir, spec, input.kernelDir);
  const config = await import(pathToFileURL(path.join(repoDir, "harness.config.ts")).href);
  const facade = input.product["createManagedDeliveryFacade"]({
    repoDir,
    config: config.default,
    installation: { installationPath, receiptDir },
    hostVersion: HOST_VERSION,
  });

  // THE CONTROL, taken while the generation is still intact.
  const presented = await facade.presentContract({ contract: acceptedContract(spec), expiry: EXPIRY });
  if (presented.ok !== true) return fail(`the control half failed at presentation: ${JSON.stringify(presented)}`);
  const pending = JSON.parse(readFileSync(presented.channelPath, "utf8")) as { rendered: { challenge: unknown; channelId: unknown } };
  const confirmed = await facade.confirmContract({
    intakeId: presented.intakeId,
    echo: {
      presentedChallenge: pending.rendered.challenge,
      presentedOnChannelId: pending.rendered.channelId,
      observedAt: NOW,
      viaModelVisibleSurface: false,
      interactive: true,
    },
  });
  if (confirmed.ok !== true) {
    return fail(`the control half failed: the delivery could not register against an intact generation: ${JSON.stringify(confirmed)}`);
  }

  const stagedEntry = path.join(installed.root, ...GENERATION_HOOK_ENTRY.split("/"));
  if (!existsSync(stagedEntry)) return fail(`the installed generation stages no ${GENERATION_HOOK_ENTRY} for this probe to remove`);
  chmodSync(path.dirname(stagedEntry), 0o700);
  rmSync(stagedEntry, { force: true });

  const worktree = path.join(input.scratch, "worktree-missing-hook-entry");
  git(repoDir, "worktree", "add", "--quiet", "-b", "delivery", worktree, "main");
  expectRefusal(
    probe,
    await facade.bindWorkspace({
      deliveryId: confirmed.deliveryId,
      worktreeDir: worktree,
      hostTaskId: "host-task-missing-hook-entry",
      observedAt: NOW,
      attestationExpiry: EXPIRY,
    }),
    "trust_ineligible",
  );
}

async function runNegativeProbes(input: NegativeInput): Promise<void> {
  const { installer, findings, satisfied, log } = input;

  const expectRefusal = (probe: string, result: unknown, expectedCode: string): boolean => {
    const outcome = refusalOutcome(probe, result, expectedCode);
    if (!outcome.satisfied) {
      findings.push(outcome.finding);
      return false;
    }
    satisfied.push(probe);
    log(`negative probe satisfied: ${probe}`);
    return true;
  };

  // ── A fixture install refuses a repository the receipt does not list ──
  //
  // The ALLOW side is not assumed here: both listed repositories reached
  // merge-ready through this same installation above, so this refusal cannot
  // be explained by an installation that refuses every repository.
  const strangerSpec: DisposableSpec = { ...DISPOSABLE_SPECS[0]!, repositoryId: "disposable-unlisted", contractId: "contract-unlisted" };
  const strangerDir = path.join(input.scratch, "repo-unlisted");
  buildDisposableRepository(strangerDir, strangerSpec, input.kernelDir);
  const strangerConfig = await import(pathToFileURL(path.join(strangerDir, "harness.config.ts")).href);
  const strangerFacade = input.product["createManagedDeliveryFacade"]({
    repoDir: strangerDir,
    config: strangerConfig.default,
    installation: { installationPath: input.installationPath, receiptDir: input.receiptDir },
    hostVersion: HOST_VERSION,
  });
  expectRefusal(
    "receipt-listed-repository-refusal",
    await strangerFacade.presentContract({ contract: acceptedContract(strangerSpec), expiry: EXPIRY }),
    "disposable_repository_refused",
  );

  // ── A generation missing the staged hook entry is REFUSED, not silently
  //    wired to a command that names nothing ──
  //
  // The ALLOW side is the two deliveries above: both bound a session against
  // this same generation and both ran the emitted command, so this refusal
  // cannot be explained by a verifier that refuses every root. The copy is
  // mutilated rather than the installation, because the installed generation
  // is the thing the deliveries are still using.
  const publishedClosure = installer["verifyGenerationClosure"];
  const mutilated = path.join(input.scratch, "generation-missing-hook-entry");
  cpSync(input.generationRoot, mutilated, { recursive: true });
  const stagedHookEntry = path.join(mutilated, ...GENERATION_HOOK_ENTRY.split("/"));
  if (typeof publishedClosure !== "function") {
    // The refusal this probe requires is only available to an adopter if the
    // package publishes the verifier. An unreachable verifier does not make
    // this probe pass quietly; it makes it a finding.
    findings.push({
      rule: "packed-surface",
      subject: "closure-detects-missing-staged-hook-entry",
      message:
        "the installed package publishes no callable closure verifier, so nothing an adopter can reach refuses a generation missing the staged hook entry",
    });
  } else if (!existsSync(stagedHookEntry)) {
    findings.push({
      rule: "packed-surface",
      subject: "closure-detects-missing-staged-hook-entry",
      message: `the composition does not stage ${GENERATION_HOOK_ENTRY}, so the probe cannot remove it; the emitted hook command has nothing to resolve against`,
    });
  } else {
    // The generation root is installed read-only, and the copy inherits that.
    // Only the copy is relaxed, and only enough to remove one file.
    chmodSync(path.dirname(stagedHookEntry), 0o700);
    rmSync(stagedHookEntry, { force: true });
    expectRefusal(
      "closure-detects-missing-staged-hook-entry",
      await publishedClosure(mutilated, input.generationDigest),
      "closure_digest_mismatch",
    );
  }

  // ── Binding a workspace REFUSES a generation missing the staged entry ──
  //
  // The half above says a broken generation is DETECTABLE by an adopter. This
  // one says the PRODUCT refuses to proceed on one: the interceptor is the
  // deny-until-attested boundary, and a session composed around a command that
  // names nothing would be admitted with no admission recheck at all. That
  // failure would be silent, so it is proven to be loud.
  //
  // The refusal it requires is the PINNED-GENERATION TRUST CHECK, not a
  // dedicated hook-entry code: every guarded operation reloads the delivery's
  // pinned generation and re-verifies its digest closure, and a root missing
  // one staged file fails that before any command is composed. The expected code is pinned rather than
  // "any refusal" for the usual reason — a refusal for some other reason is
  // not this probe's evidence.
  //
  // Its own installation, corrupted AFTER install: install-time closure
  // verification would refuse a mutilated PACKED directory long before any
  // facade saw it, so a probe that mutilated the pack would re-prove the
  // installer's rule rather than this one.
  await probeBindRefusesMissingHookEntry(input, expectRefusal);

  // ── A fixture manifest cannot activate without the operator's flag ──
  expectRefusal(
    "qualification-flag-required",
    await installer["installComposition"]({
      packedDir: input.packedDir,
      installationPath: path.join(input.scratch, "installation-unflagged"),
      receiptDir: path.join(input.scratch, "user-config-unflagged"),
      assertionProvider: { sourceKind: "qualification-fixture" },
    }),
    "qualification_flag_required",
  );

  // ── The other temporal direction: the flag is refused on a production
  // manifest, so a flagged installation can never serve a real repository and
  // a production one can never activate the fixture halves. One direction
  // alone would leave the profile a one-way door.
  const productionPacked = await input.pack(1, "production", "production");
  if (productionPacked.ok !== true) {
    findings.push({ rule: "negative-probe", subject: "qualification-flag-refused-on-production", message: JSON.stringify(productionPacked) });
  } else {
    expectRefusal(
      "qualification-flag-refused-on-production",
      await installer["installComposition"]({
        packedDir: productionPacked.packedDir,
        installationPath: path.join(input.scratch, "installation-production"),
        receiptDir: path.join(input.scratch, "user-config-production"),
        qualification: { disposableRepositoryIds: ["disposable-alpha"] },
        assertionProvider: { sourceKind: "qualification-fixture" },
      }),
      "qualification_flag_refused",
    );
  }

  // ── Revocation: an isolated installation, so the lane above is undisturbed ──
  const revokePacked = await input.pack(1, "confirmation-fixture", "revoke");
  if (revokePacked.ok !== true) {
    findings.push({ rule: "negative-probe", subject: "revoked-generation-fences-live-work", message: JSON.stringify(revokePacked) });
    return;
  }
  const revokeInstallation = path.join(input.scratch, "installation-revoke");
  const revokeReceipts = path.join(input.scratch, "user-config-revoke");
  const revokeSpec: DisposableSpec = { ...DISPOSABLE_SPECS[0]!, repositoryId: "disposable-revocation", contractId: "contract-revocation" };
  const revokeInstalled = await installer["installComposition"]({
    packedDir: revokePacked.packedDir,
    installationPath: revokeInstallation,
    receiptDir: revokeReceipts,
    qualification: { disposableRepositoryIds: [revokeSpec.repositoryId] },
    assertionProvider: { sourceKind: "qualification-fixture" },
  });
  if (revokeInstalled.ok !== true) {
    findings.push({ rule: "negative-probe", subject: "revoked-generation-fences-live-work", message: JSON.stringify(revokeInstalled) });
    return;
  }

  const revokeRepoDir = path.join(input.scratch, "repo-revocation");
  buildDisposableRepository(revokeRepoDir, revokeSpec, input.kernelDir);
  const revokeConfig = await import(pathToFileURL(path.join(revokeRepoDir, "harness.config.ts")).href);
  const revokeFacade = input.product["createManagedDeliveryFacade"]({
    repoDir: revokeRepoDir,
    config: revokeConfig.default,
    installation: { installationPath: revokeInstallation, receiptDir: revokeReceipts },
    hostVersion: HOST_VERSION,
  });

  // Register a delivery against the generation, THEN revoke it. The ALLOW side
  // is this registration succeeding: a mechanism that refused registration
  // outright would satisfy the fencing assertion below for the wrong reason.
  const revokePresented = await revokeFacade.presentContract({ contract: acceptedContract(revokeSpec), expiry: EXPIRY });
  if (revokePresented.ok !== true) {
    findings.push({
      rule: "negative-probe",
      subject: "revoked-generation-fences-live-work",
      message: `the control half failed: a listed repository could not register before revocation: ${JSON.stringify(revokePresented)}`,
    });
    return;
  }
  const pending = JSON.parse(readFileSync(revokePresented.channelPath, "utf8")) as { rendered: { challenge: unknown; channelId: unknown } };
  const revokeConfirmed = await revokeFacade.confirmContract({
    intakeId: revokePresented.intakeId,
    echo: {
      presentedChallenge: pending.rendered.challenge,
      presentedOnChannelId: pending.rendered.channelId,
      observedAt: NOW,
      viaModelVisibleSurface: false,
      interactive: true,
    },
  });
  if (revokeConfirmed.ok !== true) {
    findings.push({ rule: "negative-probe", subject: "revoked-generation-fences-live-work", message: JSON.stringify(revokeConfirmed) });
    return;
  }

  const revocationLane = {
    installationPath: revokeInstallation,
    receiptDir: revokeReceipts,
    assertionSource: installer["createQualificationFixtureAssertionSource"](),
    now: NOW,
  };
  const revoked = await installer["maintainTrustState"]({ ...revocationLane, operation: "revoke", generationDigest: revokeInstalled.generationDigest });
  if (revoked.ok !== true) {
    findings.push({ rule: "negative-probe", subject: "revoked-generation-fences-live-work", message: JSON.stringify(revoked) });
    return;
  }

  // The next mutation-capable operation is fenced and the delivery enters
  // security_blocked. A refusal alone is not enough — the STATE is the claim.
  const worktree = path.join(input.scratch, "worktree-revocation");
  git(revokeRepoDir, "worktree", "add", "--quiet", "-b", "delivery", worktree, "main");
  const fencedBind = await revokeFacade.bindWorkspace({
    deliveryId: revokeConfirmed.deliveryId,
    worktreeDir: worktree,
    hostTaskId: "host-task-revocation",
    observedAt: NOW,
    attestationExpiry: EXPIRY,
  });
  if (fencedBind.ok === true) {
    findings.push({
      rule: "negative-probe",
      subject: "revoked-generation-fences-live-work",
      message: "binding a workspace succeeded against a revoked generation; revocation must fence live work at the next canonical site",
    });
  } else {
    const fencedStatus = await revokeFacade.status({ deliveryId: revokeConfirmed.deliveryId, observedAt: LATER });
    const state = fencedStatus.ok === true ? fencedStatus.status.delivery.state : "<unreadable>";
    if (state !== "security_blocked") {
      findings.push({
        rule: "negative-probe",
        subject: "revoked-generation-fences-live-work",
        message: `the operation was refused but the delivery is ${state}, not security_blocked; a refusal without the fenced state leaves the delivery resumable`,
      });
    } else {
      satisfied.push("revoked-generation-fences-live-work");
      log("negative probe satisfied: revoked-generation-fences-live-work");
    }
  }

  // ── A revoked generation is audit-retained but is not a rollback target ──
  expectRefusal(
    "revoked-rollback-target-rejected",
    await installer["rollbackComposition"]({ ...revocationLane, targetGenerationDigest: revokeInstalled.generationDigest }),
    "generation_revoked",
  );
}

// ── Step 7: composition lifecycle ────────────────────────────────────────────

interface LifecycleInput {
  readonly installer: Record<string, any>;
  readonly packOne: (sequence: number) => Promise<any>;
  readonly installationPath: string;
  readonly receiptDir: string;
  readonly priorDigest: string;
  readonly findings: QualificationFinding[];
  readonly proven: string[];
  readonly log: (line: string) => void;
}

async function runLifecycle(input: LifecycleInput): Promise<void> {
  const { installer, findings, proven, log } = input;
  const source = installer["createQualificationFixtureAssertionSource"]();
  const lane = { installationPath: input.installationPath, receiptDir: input.receiptDir, assertionSource: source, now: NOW };

  const digests: string[] = [input.priorDigest];
  for (const sequence of [2, 3]) {
    const packed = await input.packOne(sequence);
    if (packed.ok !== true) {
      findings.push({ rule: "lifecycle", subject: `update-${sequence - 1}`, message: JSON.stringify(packed) });
      return;
    }
    const updated = await installer["updateComposition"]({
      ...lane,
      packedDir: packed.packedDir,
      qualification: { disposableRepositoryIds: DISPOSABLE_SPECS.map((spec) => spec.repositoryId) },
    });
    if (updated.ok !== true) {
      findings.push({ rule: "lifecycle", subject: `update-${sequence - 1}`, message: JSON.stringify(updated) });
      return;
    }
    digests.push(updated.generationDigest);
    proven.push(`update-${sequence - 1}`);
    log(`update ${sequence - 1}: ${updated.priorGenerationDigest} -> ${updated.generationDigest}`);
  }

  // Every superseded generation is RETAINED, which is what makes resuming a
  // paused delivery through its own pinned generation possible at all.
  const inspected = await installer["inspectInstallation"]({ installationPath: input.installationPath, receiptDir: input.receiptDir });
  if (inspected.ok !== true) {
    findings.push({ rule: "lifecycle", subject: "inspect", message: JSON.stringify(inspected) });
    return;
  }
  const retained: string[] = (inspected.generations as readonly { readonly digest: string }[]).map((entry) => entry.digest);
  // Distinctness first. `includes` over three identical digests would report
  // nothing missing, and the rollback below would then target the currently
  // active generation — "rollback to a retained generation" satisfied by a
  // rollback to self.
  if (new Set(digests).size !== digests.length) {
    findings.push({
      rule: "lifecycle",
      subject: "resume-through-pinned-generation",
      message: `the three generations are not distinct (${digests.join(", ")}); nothing here would notice a superseded generation being dropped`,
    });
    return;
  }
  const missing = digests.filter((digest) => !retained.includes(digest));
  if (missing.length > 0) {
    findings.push({
      rule: "lifecycle",
      subject: "resume-through-pinned-generation",
      message: `two contract-changing updates dropped generation(s) ${missing.join(", ")}; a delivery pinned to one could not resume`,
    });
  } else {
    // The pinned generation still loads, which is the resume path's precondition.
    const pinned = await installer["loadPinnedGeneration"]({ installationPath: input.installationPath, generationDigest: digests[0]! });
    if (pinned.ok !== true) {
      findings.push({ rule: "lifecycle", subject: "resume-through-pinned-generation", message: JSON.stringify(pinned) });
    } else {
      proven.push("resume-through-pinned-generation");
    }
  }

  // ── Offline rollback to a retained, non-revoked generation ──
  const rolled = await installer["rollbackComposition"]({ ...lane, targetGenerationDigest: digests[1] ?? digests[0]! });
  if (rolled.ok !== true) {
    findings.push({ rule: "lifecycle", subject: "rollback-to-retained-generation", message: JSON.stringify(rolled) });
  } else {
    proven.push("rollback-to-retained-generation");
    log(`rolled back to ${rolled.generationDigest}`);
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function formatQualificationFindings(findings: readonly QualificationFinding[]): string {
  return findings.map((finding) => `  ${finding.rule}  ${finding.subject}\n      ${finding.message}`).join("\n");
}

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function main(): Promise<void> {
  const verbose = process.env["DELIVERY_HARNESS_VERBOSE"] === "1";
  const result = await runProductQualification({
    sourceRoot: repoRootFromHere(),
    log: verbose ? (line) => process.stdout.write(`  ${line}\n`) : undefined,
  });
  const summary = `${result.observations.repositoriesDelivered.length} repositor(ies) to merge-ready; ${result.observations.negativeProbesSatisfied.length} negative probe(s); ${result.observations.lifecycleStepsProven.length} lifecycle step(s)`;
  if (result.findings.length === 0) {
    process.stdout.write(`qualify-product: clean (${summary})\n`);
    process.stdout.write(`${JSON.stringify(result.observations, null, 2)}\n`);
    return;
  }
  process.stderr.write(`qualify-product: ${result.findings.length} finding(s) (${summary})\n`);
  process.stderr.write(`${formatQualificationFindings(result.findings)}\n`);
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
