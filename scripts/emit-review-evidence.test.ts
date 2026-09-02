/**
 * The review-evidence emitter, run for real against fixture repositories.
 *
 * WHAT THIS PROVES, AND WHY IT IS SHAPED THIS WAY. The emitter is the thing
 * that decides what this repository's one obligation is told about the review
 * that ran, so the two failure modes worth pinning are the ones an
 * always-green emitter would survive:
 *
 *   - A hardcoded reviewer set. Every fixture below carries charters whose
 *     names do NOT appear under this repository's own `delivery/personas/`,
 *     and the disjointness is asserted rather than assumed — a fixture that
 *     agreed with the real directory would let a built-in list pass for
 *     resolution.
 *   - A hardcoded `verdict: "green"`. Both polarities run the real harness:
 *     a green outcome must reach an ADMITTED gate, and a non-green outcome
 *     must produce a manifest the harness REFUSES, with the gate still
 *     blocked afterwards. A green-only assertion is satisfied by an emitter
 *     that cannot express anything else.
 *
 * Nothing here re-implements the manifest contract. The judge is the shipped
 * recorder and evaluator, reached through the real CLI, from a fixture
 * repository that consumes this checkout exactly as the getting-started guide
 * tells a reader to.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { PERSONA_DIR as SENSOR_PERSONA_DIR } from "./policy-projection-check.ts";
import { CHARTER_EXTENSION, PERSONA_DIR, resolveReviewerCharters } from "./emit-review-evidence.ts";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT_ROOT = path.resolve(SCRIPTS_DIR, "..");
const EMITTER_PATH = path.join(SCRIPTS_DIR, "emit-review-evidence.ts");
const TSX_BIN = path.join(CHECKOUT_ROOT, "node_modules", ".bin", "tsx");
const CLI_MAIN = path.join(CHECKOUT_ROOT, "packages", "cli", "src", "main.ts");

// ── Process helpers ──────────────────────────────────────────────────────────

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command to completion, optionally feeding it stdin. */
function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input, "utf8");
    else child.stdin.end();
  });
}

// ── The manifest, as this suite reads it ─────────────────────────────────────

interface ManifestPayload {
  readonly verdict: string;
  readonly reviewers: {
    readonly selected: string[];
    readonly completed: string[];
    readonly failed: string[];
    readonly timedOut: string[];
  };
  readonly findings: readonly unknown[];
  readonly telemetry: {
    readonly iterationCount: number;
    readonly findingCounts: Record<string, number>;
    readonly deferredExpansionCount: number;
    readonly deferredIssueIds: readonly string[];
  };
}

interface Manifest {
  readonly provider: { readonly id: string };
  readonly runHistory: readonly unknown[];
  readonly artifacts: readonly { readonly path: string; readonly sha256: string; readonly role: string }[];
  readonly claims: readonly { readonly obligation: string; readonly payload: ManifestPayload }[];
}

async function readManifest(manifestPath: string): Promise<Manifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
}

const cleanups: string[] = [];
afterAll(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

// ── The fixture repository ───────────────────────────────────────────────────

/**
 * Charter ids the fixtures review under. They are deliberately unrelated to
 * this repository's own charters; `the fixture charters are not this
 * repository's` keeps them that way.
 */
const FIXTURE_CHARTERS = ["alpha-lens", "beta-lens", "zeta-lens"] as const;

/** The fixture's own gate: its own provider id, so a hardcoded one cannot pass. */
const FIXTURE_PROVIDER_ID = "fixture.review-provider";

const FIXTURE_CONFIG = `import { defineHarnessConfig } from "@agent-delivery-harness/kernel";

export default defineHarnessConfig({
  gateId: "fixture.pr-admission",
  baseRef: "origin/main",
  storageNamespace: "delivery-harness/",
  acceptedEnvelopeSpecs: ["delivery-evidence/1"],
  identityVersions: ["deliverable-tree/v1"],
  computingIdentityVersion: "deliverable-tree/v1",
  reviewNeutral: [{ prefix: "docs/reports/" }, { prefix: "docs/solutions/" }, { prefix: "telemetry/delivery-runs/" }],
  recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
  pathClassification: {
    generated: [{ kind: "prefix", value: "dist/" }],
    test: [{ kind: "glob", value: "**/*.test.ts" }],
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
  providers: [{ id: ${JSON.stringify(FIXTURE_PROVIDER_ID)}, findingCodes: [] }],
  obligations: [
    {
      id: "review.green",
      activation: { kind: "relevant_change" },
      freshness: "exact_candidate",
      providers: [${JSON.stringify(FIXTURE_PROVIDER_ID)}],
      acceptedPayloadSpecs: ["review.green/1"],
      allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
      humanWaiverAllowed: true,
      minimumAttestationLevel: "self",
      ciDelegationPolicyIds: [],
      remediation: {
        default: [
          { id: "run-the-review", kind: "manual_action", summary: "Run the code review and submit its evidence manifest." },
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
  deliveryRecordPath: "telemetry/delivery-runs/record.json",
  deliveryRecordVerification: { baseMovement: "stale" },
});
`;

function fixtureEnv(home: string): NodeJS.ProcessEnv {
  // Scrubbed: no agent signal, no CI signal, and a HOME of its own so a
  // developer's global git config cannot reach the fixture.
  return { PATH: process.env["PATH"], HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
}

async function git(cwd: string, env: NodeJS.ProcessEnv, ...args: readonly string[]): Promise<void> {
  const result = await runCommand("git", args, { cwd, env });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

interface Fixture {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * A repository that consumes this checkout the way the getting-started guide
 * says to, carrying the emitter's real bytes and a charter set of its own.
 */
async function createFixture(charters: readonly string[] = FIXTURE_CHARTERS): Promise<Fixture> {
  const home = await scratchDir("dh-emit-home-");
  const env = fixtureEnv(home);
  const dir = await scratchDir("dh-emit-repo-");

  await git(dir, env, "init", "--quiet", "--initial-branch", "main");
  await git(dir, env, "config", "user.email", "fixture@example.invalid");
  await git(dir, env, "config", "user.name", "Emitter Fixture");
  await git(dir, env, "config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "emitter-fixture", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await git(dir, env, "add", ".gitignore", "package.json");
  await git(dir, env, "commit", "--quiet", "--no-gpg-sign", "-m", "base");
  await git(dir, env, "branch", "origin/main");

  // The kernel the fixture's config and the emitter import by package name.
  await mkdir(path.join(dir, "node_modules", "@agent-delivery-harness"), { recursive: true });
  await symlink(
    path.join(CHECKOUT_ROOT, "packages", "kernel"),
    path.join(dir, "node_modules", "@agent-delivery-harness", "kernel"),
  );

  await writeFile(path.join(dir, "harness.config.ts"), FIXTURE_CONFIG, "utf8");
  await mkdir(path.join(dir, PERSONA_DIR), { recursive: true });
  for (const charter of charters) {
    await writeFile(
      path.join(dir, PERSONA_DIR, `${charter}${CHARTER_EXTENSION}`),
      `# ${charter} charter\n\nThe fixture's ${charter} lens.\n`,
      "utf8",
    );
  }
  // The emitter's real bytes, not a restatement of them.
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "scripts", "emit-review-evidence.ts"), readFileSync(EMITTER_PATH, "utf8"), "utf8");

  await git(dir, env, "add", "harness.config.ts", PERSONA_DIR, "scripts");
  await git(dir, env, "commit", "--quiet", "--no-gpg-sign", "-m", "the change to deliver");
  return { dir, env };
}

function emit(fixture: Fixture, outcome: unknown): Promise<RunResult> {
  return runCommand(TSX_BIN, ["scripts/emit-review-evidence.ts"], {
    cwd: fixture.dir,
    env: fixture.env,
    input: `${JSON.stringify(outcome)}\n`,
  });
}

function harness(fixture: Fixture, ...args: readonly string[]): Promise<RunResult> {
  return runCommand(TSX_BIN, [CLI_MAIN, ...args], { cwd: fixture.dir, env: fixture.env });
}

const approvedBy = (charters: readonly string[]): { id: string; result: string }[] =>
  charters.map((id) => ({ id, result: "approved" }));

/** A deferred scope-expansion finding — the one disposition RG-7 lets green carry. */
const deferral = (id: string, deferredIssueId: string): Record<string, unknown> => ({
  id,
  severity: "P2",
  scope: "expansion",
  actionable: true,
  blocking: false,
  disposition: "deferred",
  deferredIssueId,
});

const greenOutcome = {
  spec: "review-outcome/1",
  verdict: "green",
  reviewers: approvedBy(FIXTURE_CHARTERS),
  findings: [],
};

// ── The suite ────────────────────────────────────────────────────────────────

describe("the charter set the emitter reviews under", () => {
  it("is the charter directory the policy sensor already names", () => {
    expect(PERSONA_DIR).toBe(SENSOR_PERSONA_DIR);
  });

  it("is read from the directory, so a renamed charter moves with it", async () => {
    const dir = await scratchDir("dh-emit-charters-");
    await mkdir(path.join(dir, PERSONA_DIR), { recursive: true });
    for (const name of ["zulu-lens.md", "alpha-lens.md", "README.txt", "notes.json"]) {
      await writeFile(path.join(dir, PERSONA_DIR, name), "charter\n", "utf8");
    }
    // Sorted, `.md` only — and never a built-in list.
    expect(await resolveReviewerCharters(dir)).toEqual(["alpha-lens", "zulu-lens"]);
  });

  it("matches this repository's own charter directory when read from it", async () => {
    const listed = (await readdir(path.join(CHECKOUT_ROOT, PERSONA_DIR)))
      .filter((entry) => entry.endsWith(CHARTER_EXTENSION))
      .map((entry) => entry.slice(0, -CHARTER_EXTENSION.length))
      .sort();
    expect(listed.length, "this repository ships charters to resolve").toBeGreaterThan(0);
    expect(await resolveReviewerCharters(CHECKOUT_ROOT)).toEqual(listed);
  });

  it("is not this repository's set in the fixtures, so a hardcoded set cannot pass", async () => {
    const own = new Set(await resolveReviewerCharters(CHECKOUT_ROOT));
    for (const charter of FIXTURE_CHARTERS) expect(own.has(charter)).toBe(false);
  });
});

describe("emitting a manifest", () => {
  it(
    "names every charter the tree carries, with one approval artifact each",
    { timeout: 120_000 },
    async () => {
      const fixture = await createFixture();
      await harness(fixture, "prepare");

      const emitted = await emit(fixture, greenOutcome);
      expect(emitted.code, `emit failed: ${emitted.stderr}`).toBe(0);

      const manifestPath = emitted.stdout.trim();
      const manifest = await readManifest(manifestPath);
      const claim = manifest.claims[0]!;
      const reviewers = claim.payload.reviewers;

      expect(reviewers.selected).toEqual([...FIXTURE_CHARTERS]);
      expect(reviewers.completed).toEqual([...FIXTURE_CHARTERS]);
      expect(reviewers.failed).toEqual([]);
      expect(reviewers.timedOut).toEqual([]);

      // One reviewer-approval per charter, inside the allocated run root.
      const approvals = manifest.artifacts.filter((artifact) => artifact.role === "reviewer-approval");
      expect(approvals.map((artifact) => artifact.path).sort()).toEqual(
        FIXTURE_CHARTERS.map((charter) => `reviewers/${charter}.json`).sort(),
      );
      const runRoot = path.dirname(manifestPath);
      for (const charter of FIXTURE_CHARTERS) {
        const stamp = JSON.parse(await readFile(path.join(runRoot, "reviewers", `${charter}.json`), "utf8")) as {
          reviewerId: string;
          result: string;
        };
        expect(stamp.reviewerId).toBe(charter);
        expect(stamp.result).toBe("approved");
      }

      // The provider triple is the gate's, resolved from the config it serves.
      expect(manifest.provider.id).toBe(FIXTURE_PROVIDER_ID);
      expect(claim.obligation).toBe("review.green");

      // The zero point of the telemetry derivation. It is asserted here and a
      // non-zero point is asserted (and submitted) below, because a constant
      // agrees with whichever single sample a suite happens to carry.
      expect(claim.payload.telemetry).toEqual({
        iterationCount: 1,
        findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
        deferredExpansionCount: 0,
        deferredIssueIds: [],
      });
    },
  );

  it("refuses an outcome that leaves a charter unrepresented", { timeout: 120_000 }, async () => {
    const fixture = await createFixture();
    const result = await emit(fixture, {
      spec: "review-outcome/1",
      verdict: "green",
      reviewers: approvedBy(FIXTURE_CHARTERS.slice(0, 2)),
      findings: [],
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("zeta-lens");
    expect(result.stdout.trim()).toBe("");
  });

  it("refuses an outcome naming a reviewer no charter defines", { timeout: 120_000 }, async () => {
    const fixture = await createFixture();
    const result = await emit(fixture, {
      spec: "review-outcome/1",
      verdict: "green",
      reviewers: [...approvedBy(FIXTURE_CHARTERS), { id: "invented-lens", result: "approved" }],
      findings: [],
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("invented-lens");
    expect(result.stdout.trim()).toBe("");
  });
});

describe("the review outcome the emitter is given", () => {
  it(
    "reaches an admitted gate when the review was green, with telemetry derived from its findings",
    { timeout: 300_000 },
    async () => {
      const fixture = await createFixture();
      const prepared = await harness(fixture, "prepare");
      expect(prepared.code, `prepare failed: ${prepared.stderr}`).toBe(0);

      const emitted = await emit(fixture, {
        spec: "review-outcome/1",
        verdict: "green",
        reviewers: approvedBy(FIXTURE_CHARTERS),
        // Deliberately more than one of everything the derivation does: two
        // severities beyond the deferred ones, three deferrals naming two
        // distinct ids, emitted out of order and with one repeated. A tally
        // that assigns instead of increments, an id list that neither sorts
        // nor deduplicates, and a constant lifted from a single sample each
        // disagree with what RG-8 re-derives from these six rows.
        findings: [
          deferral("f-1", "V26-1541"),
          deferral("f-2", "V26-1467"),
          deferral("f-3", "V26-1541"),
          { id: "f-4", severity: "P2", scope: "adjacent", actionable: true, blocking: false, disposition: "resolved" },
          { id: "f-5", severity: "P3", scope: "adjacent", actionable: true, blocking: false, disposition: "pre_existing" },
          { id: "f-6", severity: "P1", scope: "in_contract", actionable: false, blocking: false, disposition: "advisory" },
        ],
      });
      expect(emitted.code, `emit failed: ${emitted.stderr}`).toBe(0);
      const manifestPath = emitted.stdout.trim();
      const manifest = await readManifest(manifestPath);
      const telemetry = manifest.claims[0]!.payload.telemetry;
      // Derived, not stated: RG-8 re-derives these and RG-9 ties the iteration
      // count to the run history, so a constant here cannot survive submission.
      expect(telemetry.findingCounts).toEqual({ P0: 0, P1: 1, P2: 4, P3: 1 });
      expect(telemetry.deferredExpansionCount).toBe(3);
      expect(telemetry.deferredIssueIds).toEqual(["V26-1467", "V26-1541"]);
      expect(telemetry.iterationCount).toBe(manifest.runHistory.length);

      const submitted = await harness(fixture, "submit-evidence", "--manifest", manifestPath);
      expect(submitted.code, `submit-evidence rejected: ${submitted.stdout}${submitted.stderr}`).toBe(0);

      const gated = await harness(fixture, "gate");
      expect(gated.code, `gate blocked: ${gated.stdout}${gated.stderr}`).toBe(0);
    },
  );

  it(
    "produces a manifest the harness refuses when the review was not green",
    { timeout: 300_000 },
    async () => {
      const fixture = await createFixture();
      const prepared = await harness(fixture, "prepare");
      expect(prepared.code, `prepare failed: ${prepared.stderr}`).toBe(0);

      const emitted = await emit(fixture, {
        spec: "review-outcome/1",
        verdict: "red",
        reviewers: [
          { id: "alpha-lens", result: "approved" },
          { id: "beta-lens", result: "rejected" },
          { id: "zeta-lens", result: "approved" },
        ],
        findings: [
          {
            id: "f-1",
            severity: "P1",
            scope: "in_contract",
            actionable: true,
            blocking: true,
            disposition: "unresolved",
          },
        ],
      });
      // The emitter still emits: refusal is the harness's judgement, not the
      // provider's, and a provider that declined to emit would hide the review.
      expect(emitted.code, `emit failed: ${emitted.stderr}`).toBe(0);
      const manifestPath = emitted.stdout.trim();
      const manifest = await readManifest(manifestPath);
      expect(manifest.claims[0]!.payload.verdict).toBe("red");
      // The reviewer that did not approve leaves no approval stamp behind.
      expect(manifest.artifacts.map((artifact) => artifact.path)).not.toContain("reviewers/beta-lens.json");

      const submitted = await harness(fixture, "submit-evidence", "--manifest", manifestPath);
      expect(submitted.code, "the recorder refuses a manifest for a review that was not green").toBe(1);
      expect(`${submitted.stdout}${submitted.stderr}`).toContain("verdict_not_green");

      // And nothing was recorded, so the gate is still blocked.
      const gated = await harness(fixture, "gate");
      expect(gated.code, "the gate does not admit on a refused manifest").toBe(1);
    },
  );

  it(
    "carries a reviewer that did not finish as one, even when the outcome says green",
    { timeout: 300_000 },
    async () => {
      // The greenwashing case, and the one an always-green emitter passes for.
      // A lens that crashed or ran out of time has not reviewed anything; RG-3
      // exists to refuse exactly that, and it can only refuse what the manifest
      // reports. An emitter that folded these two results into `completed` —
      // or worse, stamped approvals for them — would reach an ADMITTED gate on
      // a review two thirds of which never happened.
      const fixture = await createFixture();
      const prepared = await harness(fixture, "prepare");
      expect(prepared.code, `prepare failed: ${prepared.stderr}`).toBe(0);

      const emitted = await emit(fixture, {
        spec: "review-outcome/1",
        verdict: "green",
        reviewers: [
          { id: "alpha-lens", result: "approved" },
          { id: "beta-lens", result: "failed" },
          { id: "zeta-lens", result: "timed-out" },
        ],
        findings: [],
      });
      expect(emitted.code, `emit failed: ${emitted.stderr}`).toBe(0);
      const manifestPath = emitted.stdout.trim();
      const manifest = await readManifest(manifestPath);
      const reviewers = manifest.claims[0]!.payload.reviewers;

      expect(reviewers.selected).toEqual([...FIXTURE_CHARTERS]);
      expect(reviewers.completed).toEqual(["alpha-lens"]);
      expect(reviewers.failed).toEqual(["beta-lens"]);
      expect(reviewers.timedOut).toEqual(["zeta-lens"]);
      // Only the reviewer that approved leaves a stamp.
      expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual(["reviewers/alpha-lens.json"]);

      const submitted = await harness(fixture, "submit-evidence", "--manifest", manifestPath);
      expect(submitted.code, "the recorder refuses a degraded reviewer set").toBe(1);
      expect(`${submitted.stdout}${submitted.stderr}`).toContain("reviewer_set_incomplete");

      const gated = await harness(fixture, "gate");
      expect(gated.code, "the gate does not admit on a review two lenses did not finish").toBe(1);
    },
  );
});
