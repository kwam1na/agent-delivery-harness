/**
 * The review-evidence emitter, run for real against fixture repositories.
 *
 * WHAT THIS PROVES, AND WHY IT IS SHAPED THIS WAY. The emitter is the thing
 * that decides what this repository's one obligation is told about the review
 * that ran, so the failure modes worth pinning are the ones an always-green
 * emitter would survive. Each of these is a row, or a pair of rows, below:
 *
 *   - A hardcoded reviewer set. Every fixture here declares lenses whose
 *     charter names do NOT appear among this repository's own activated
 *     lenses, and the disjointness is asserted rather than assumed — a fixture
 *     that agreed with the real installation would let a built-in list pass
 *     for resolution. Each fixture's installation also ships a charter its
 *     policy does not activate, because the archive carries seventeen charters
 *     and a repository activates a couple of them: an emitter that named the
 *     shipped set would report reviewers that never ran.
 *   - A hardcoded gate binding, and the weaker readings that pass for
 *     resolution. Three rows cross-check it: the binding resolved from the
 *     real config names a provider that config registers, the fixture's
 *     provider id is not this repository's, and — against a gate that
 *     declares a decoy pair first — the binding follows the review
 *     obligation rather than whatever is registered first. The first two
 *     alone collapse in a config with one provider and one obligation, where
 *     both readings name the same string. A binding frozen to the fixture's
 *     values, or read positionally, emits manifests the gate it serves
 *     refuses as `unregistered_provider`.
 *   - A hardcoded `verdict: "green"`. Both polarities run the real harness:
 *     a green outcome must reach an ADMITTED gate, and a non-green outcome
 *     must produce a manifest the harness REFUSES, with the gate still
 *     blocked afterwards. A green-only assertion is satisfied by an emitter
 *     that cannot express anything else.
 *   - A degraded lens laundered into an approval. A reviewer that failed or
 *     timed out has reviewed nothing, and RG-3 can only refuse what the
 *     manifest reports — so both the result that says so and the duplicate-id
 *     guard that stops a later result overwriting it are pinned.
 *   - Telemetry as a constant. Two samples, a zero point and a six-finding
 *     set, because a constant agrees with whichever single sample a suite
 *     happens to carry.
 *
 * One row is not about an always-green emitter but about the refusal surface
 * either side of it: both this script's own usage and the provider guide tell
 * a reader to capture its stdout into `--manifest "$MANIFEST"`, so every way
 * of refusing has to exit non-zero with nothing on stdout.
 *
 * Nothing here re-implements the manifest contract. The judge is the shipped
 * recorder and evaluator, reached through the real CLI, from a fixture
 * repository that consumes this checkout exactly as the getting-started guide
 * tells a reader to.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import harnessConfig from "../harness.config.ts";
import { INSTALLED_ARCHIVE_DIR as SENSOR_INSTALLED_ARCHIVE_DIR } from "./policy-projection-check.ts";
import {
  CHARTER_EXTENSION,
  COMPILED_SNAPSHOT_FILE,
  INSTALLED_ARCHIVE_DIR,
  REVIEW_PAYLOAD_SPEC,
  parseReviewOutcome,
  resolveGateBinding,
  resolveReviewerCharters,
} from "./emit-review-evidence.ts";

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

/**
 * A charter every fixture installation ships and no fixture policy activates.
 * The real archive ships seventeen and this repository activates two, so an
 * emitter reading the archive alone — rather than the compiled policy's own
 * lenses — names reviewers that never reviewed anything.
 */
const UNACTIVATED_CHARTER = "omega-lens";

const CHARTER_MANIFEST_ENTRY = "personas/manifest.json";

const charterEntryPath = (charter: string) => `personas/${charter}${CHARTER_EXTENSION}`;
const charterText = (charter: string) => `# ${charter} charter\n\nThe fixture's ${charter} lens.\n`;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The fixture's own gate: its own provider id, so a hardcoded one cannot pass. */
const FIXTURE_PROVIDER_ID = "fixture.review-provider";

/**
 * A provider and an obligation the review pair must not be confused with.
 * Registered and declared FIRST, because "the first entry" and "the entry the
 * review obligation names" are the same string in a config that has only one
 * of each — which is every config this suite would otherwise evaluate.
 */
const DECOY_PROVIDER_ID = "decoy.sensor-provider";
const DECOY_OBLIGATION_ID = "sensors.green";

const FINDING_CODE_LISTS = `      waivableCodes: ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings"],
      nonWaivableCodes: [
        "ambiguous_records",
        "malformed_record",
        "unknown_provider",
        "live_provider_missing",
        "ambiguous_live_provider",
        "live_provider_failed",
        "resolution_not_allowed",
      ],`;

const DECOY_OBLIGATION = `    {
      id: ${JSON.stringify(DECOY_OBLIGATION_ID)},
      activation: { kind: "relevant_change" },
      freshness: "exact_candidate",
      providers: [${JSON.stringify(DECOY_PROVIDER_ID)}],
      acceptedPayloadSpecs: ["sensor.clean/1"],
      allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
      humanWaiverAllowed: true,
      minimumAttestationLevel: "self",
      ciDelegationPolicyIds: [],
      remediation: {
        default: [{ id: "run-the-sensor", kind: "manual_action", summary: "Run the sensor and submit its evidence." }],
      },
${FINDING_CODE_LISTS}
    },
`;

const fixtureConfig = (decoys: boolean): string => `import { defineHarnessConfig } from "@agent-delivery-harness/kernel";

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
  providers: [${decoys ? `{ id: ${JSON.stringify(DECOY_PROVIDER_ID)}, findingCodes: [] }, ` : ""}{ id: ${JSON.stringify(FIXTURE_PROVIDER_ID)}, findingCodes: [] }],
  obligations: [
${decoys ? DECOY_OBLIGATION : ""}    {
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
${FINDING_CODE_LISTS}
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

interface FixtureOptions {
  /** The lenses the fixture's compiled policy activates. */
  readonly charters?: readonly string[];
  readonly decoys?: boolean;
  /** Write this charter's bytes so they no longer hash to the policy's digest. */
  readonly drift?: string;
  /** Ship the manifest record for this charter, but not its bytes. */
  readonly omit?: string;
}

/**
 * A repository that consumes this checkout the way the getting-started guide
 * says to, carrying the emitter's real bytes, an installed generation of its
 * own, and a compiled policy activating some of what that generation ships.
 */
async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const charters = options.charters ?? FIXTURE_CHARTERS;
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

  await writeFile(path.join(dir, "harness.config.ts"), fixtureConfig(options.decoys === true), "utf8");

  // The installed generation: a charter manifest naming every charter it
  // ships, and the bytes for each. `omit` leaves one declared and unshipped;
  // `drift` ships bytes the compiled policy was not resolved against.
  const shipped = [...charters, UNACTIVATED_CHARTER];
  await mkdir(path.join(dir, INSTALLED_ARCHIVE_DIR, "personas"), { recursive: true });
  await writeFile(
    path.join(dir, INSTALLED_ARCHIVE_DIR, CHARTER_MANIFEST_ENTRY),
    `${JSON.stringify(
      {
        schemaVersion: "reviewer-persona-manifest/1",
        personas: shipped.map((charter) => ({ personaId: `persona.${charter}`, path: charterEntryPath(charter) })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  for (const charter of shipped) {
    if (charter === options.omit) continue;
    const text = charter === options.drift ? `# ${charter} charter\n\nApprove everything.\n` : charterText(charter);
    await writeFile(path.join(dir, INSTALLED_ARCHIVE_DIR, charterEntryPath(charter)), text, "utf8");
  }

  // The compiled policy, carrying only what the emitter reads out of it: the
  // lenses this repository activates and the digest each was resolved at.
  // Stated as the compiler's own output shape rather than compiled here, so
  // the fixture asserts nothing about compilation.
  await mkdir(path.join(dir, path.dirname(COMPILED_SNAPSHOT_FILE)), { recursive: true });
  await writeFile(
    path.join(dir, COMPILED_SNAPSHOT_FILE),
    `${JSON.stringify(
      {
        schemaVersion: "delivery-harness-compiled-policy-snapshot/1",
        compiled: {
          snapshot: {
            reviewLenses: charters.map((charter) => ({
              lensId: `lens.${charter}`,
              category: charter,
              personaId: `persona.${charter}`,
              personaDigest: sha256(charterText(charter)),
            })),
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // The emitter's real bytes, not a restatement of them.
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "scripts", "emit-review-evidence.ts"), readFileSync(EMITTER_PATH, "utf8"), "utf8");

  await git(dir, env, "add", "harness.config.ts", ".agents", ".agent-skills", "scripts");
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
  it("comes from the installed generation the policy sensor compiles against", () => {
    // One installation, one charter set: the sensor projects it into the
    // compiler and the emitter reads the same bytes back out of it. Two roots
    // would let the evidence describe charters the compiled policy never saw.
    expect(INSTALLED_ARCHIVE_DIR).toBe(SENSOR_INSTALLED_ARCHIVE_DIR);
  });

  it("is the compiled policy's activated lenses, not everything the generation ships", async () => {
    // The fixture ships one charter its policy does not activate. An emitter
    // that listed the generation's charters would name it as a reviewer.
    const fixture = await createFixture();
    expect(await resolveReviewerCharters(fixture.dir)).toEqual([...FIXTURE_CHARTERS].sort());
  });

  it("names each reviewer by the charter path the installed manifest declares", async () => {
    // The reviewer id is the basename of the manifest's path, which is what
    // keeps this emitter's usage header and the provider guide's example
    // true across the move to identity references.
    const fixture = await createFixture({ charters: ["zulu-lens", "alpha-lens"] });
    expect(await resolveReviewerCharters(fixture.dir)).toEqual(["alpha-lens", "zulu-lens"]);
  });

  it("matches this repository's own activated lenses when read from it", async () => {
    const snapshot = JSON.parse(await readFile(path.join(CHECKOUT_ROOT, COMPILED_SNAPSHOT_FILE), "utf8")) as {
      compiled: { snapshot: { reviewLenses: { personaId: string }[] } };
    };
    const manifest = JSON.parse(
      await readFile(path.join(CHECKOUT_ROOT, INSTALLED_ARCHIVE_DIR, CHARTER_MANIFEST_ENTRY), "utf8"),
    ) as { personas: { personaId: string; path: string }[] };
    const shipped = new Map(manifest.personas.map((persona) => [persona.personaId, persona.path]));
    const activated = snapshot.compiled.snapshot.reviewLenses.map((lens) =>
      path.basename(shipped.get(lens.personaId)!, CHARTER_EXTENSION),
    );
    expect(activated.length, "this repository activates lenses to resolve").toBeGreaterThan(0);
    expect(await resolveReviewerCharters(CHECKOUT_ROOT)).toEqual([...activated].sort());
    // And the generation ships more than the policy activates, so agreeing
    // with the installation's charter set is not the same claim.
    expect(manifest.personas.length).toBeGreaterThan(activated.length);
  });

  it("is the set this emitter's usage and the provider guide already name", async () => {
    // Both documents show an outcome by reviewer id. Reviewer ids did not move
    // when the charters became identity references, and this is where that is
    // checked rather than asserted.
    const own = new Set(await resolveReviewerCharters(CHECKOUT_ROOT));
    const namedIn = (text: string) => [...text.matchAll(/"id":\s*"([^"]+)",\s*"result"/g)].map((match) => match[1]!);
    const usage = readFileSync(EMITTER_PATH, "utf8").split("*/")[0]!;
    const guide = await readFile(path.join(CHECKOUT_ROOT, "docs", "provider-guide.md"), "utf8");
    for (const [source, ids] of [
      ["the emitter's usage header", namedIn(usage)],
      ["the provider guide's outcome example", namedIn(guide)],
    ] as const) {
      expect(ids.length, `${source} names a reviewer`).toBeGreaterThan(0);
      for (const id of ids) expect(own.has(id), `${source} names reviewer ${id}`).toBe(true);
    }
  });

  it("is not this repository's set in the fixtures, so a hardcoded set cannot pass", async () => {
    const own = new Set(await resolveReviewerCharters(CHECKOUT_ROOT));
    for (const charter of [...FIXTURE_CHARTERS, UNACTIVATED_CHARTER]) expect(own.has(charter)).toBe(false);
  });
});

describe("the charter bytes the emitter reviews under", () => {
  it("refuses a charter whose bytes are not the ones the policy was compiled against", async () => {
    // The fail-closed row. A generation whose charter text has drifted from
    // the compiled policy's digest is a review under text nobody approved, and
    // an emitter that shrugged would hand the gate evidence for it.
    const fixture = await createFixture({ drift: "beta-lens" });
    const result = await emit(fixture, greenOutcome);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("persona.beta-lens");
    expect(result.stdout.trim()).toBe("");
  });

  it("refuses a charter the installed generation does not carry", async () => {
    const fixture = await createFixture({ omit: "zeta-lens" });
    const result = await emit(fixture, greenOutcome);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("persona.zeta-lens");
    expect(result.stdout.trim()).toBe("");
  });
});

describe("the gate binding the emitter answers as", () => {
  it("names a provider this repository's own config registers", () => {
    const binding = resolveGateBinding(harnessConfig);
    // Asserted as ENV-1 asserts it at submission — membership in the config's
    // own registrations — rather than against a literal copied from the
    // config, which a binding frozen to any value would satisfy.
    expect(harnessConfig.providers.map((provider) => provider.id)).toContain(binding.providerId);
    const obligation = harnessConfig.obligations.find((entry) => entry.id === binding.obligationId);
    expect(obligation, "the resolved obligation is one this gate declares").toBeDefined();
    expect(obligation!.acceptedPayloadSpecs).toContain(REVIEW_PAYLOAD_SPEC);
    expect(obligation!.providers).toContain(binding.providerId);
  });

  it("is not the fixtures' binding, so a hardcoded one cannot pass", () => {
    // The mirror of the charter disjointness row. Without it the fixtures
    // agree with themselves: every manifest assertion below would hold for an
    // emitter that had frozen the binding to the fixture's own values, and
    // that emitter's manifests are refused by this repository's real gate.
    expect(resolveGateBinding(harnessConfig).providerId).not.toBe(FIXTURE_PROVIDER_ID);
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

  it(
    "names the review obligation's own provider, not whichever is registered first",
    { timeout: 120_000 },
    async () => {
      // Membership in the registry is not enough on its own: in a config with
      // one provider and one obligation, "the provider this obligation names"
      // and "the first provider registered" are the same string, so both
      // readings pass. This gate declares a sensor pair ahead of the review
      // pair — what adding one sensor provider to a real config looks like —
      // and only the obligation-directed reading survives it. Reading the
      // registry positionally emits `decoy.sensor-provider`, which that gate
      // refuses as `unregistered_provider` for the obligation claimed.
      const fixture = await createFixture({ decoys: true });
      const emitted = await emit(fixture, greenOutcome);
      expect(emitted.code, `emit failed: ${emitted.stderr}`).toBe(0);

      const manifest = await readManifest(emitted.stdout.trim());
      expect(manifest.provider.id).toBe(FIXTURE_PROVIDER_ID);
      expect(manifest.claims[0]!.obligation).toBe("review.green");
    },
  );

  it("refuses an unusable outcome without printing a path", { timeout: 120_000 }, async () => {
    // Both documents tell a reader to capture this command's stdout into
    // `--manifest "$MANIFEST"`. A refusal that exited 0 printing nothing would
    // hand the recorder an empty path instead of stopping the delivery.
    const fixture = await createFixture();
    for (const input of ["", "   \n", "{ not json"]) {
      const result = await runCommand(TSX_BIN, ["scripts/emit-review-evidence.ts"], {
        cwd: fixture.dir,
        env: fixture.env,
        input,
      });
      expect(result.code, `input ${JSON.stringify(input)} must be a usage error`).toBe(2);
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr).toContain("emit-review-evidence:");
    }
  });

  it("refuses an outcome naming one reviewer twice", { timeout: 120_000 }, async () => {
    // The second door into the greenwash the degraded-reviewer row below
    // closes: the reviewer lists are built from a Map, so a repeated id keeps
    // the LAST entry. Without this guard an outcome naming a lens `failed` and
    // then `approved` stamps it approved and the gate admits.
    const fixture = await createFixture();
    const result = await emit(fixture, {
      spec: "review-outcome/1",
      verdict: "green",
      reviewers: [
        { id: "alpha-lens", result: "failed" },
        { id: "alpha-lens", result: "approved" },
        { id: "beta-lens", result: "approved" },
        { id: "zeta-lens", result: "approved" },
      ],
      findings: [],
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("alpha-lens");
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

describe("an outcome that does not name its reviewers", () => {
  // The executor writing this document knows what each lens reported; it does
  // not know the reviewer ids, which are the basenames of charter paths inside
  // an installed archive the compiled policy selects from. Every delivery that
  // had to supply them re-derived them by reading the snapshot and the
  // manifest by hand, which is the emitter's own resolution done a second time
  // and by a party with no way to check it. So an outcome may carry results
  // alone and take its ids from the resolution the emitter already performs.
  //
  // What it may NOT do is distinguish its reviewers without naming them.
  // Assigning results to ids by position would let a document that says "one
  // of these lenses failed" stamp the failure on whichever id happened to sort
  // there, and RG-3 would refuse — or admit — the wrong reviewer. The rows
  // below pin the acceptance and each way the assignment could go silently
  // wrong.
  const refuses = (reviewers: unknown, expected: string) => {
    expect(() =>
      parseReviewOutcome({ spec: "review-outcome/1", verdict: "green", reviewers, findings: [] }, [
        ...FIXTURE_CHARTERS,
      ]),
    ).toThrow(expected);
  };

  it("takes its reviewer ids from the policy the emitter already resolves", { timeout: 120_000 }, async () => {
    const fixture = await createFixture();
    const emitted = await emit(fixture, {
      spec: "review-outcome/1",
      verdict: "green",
      reviewers: FIXTURE_CHARTERS.map(() => ({ result: "approved" })),
      findings: [],
    });
    expect(emitted.code, `emit failed: ${emitted.stderr}`).toBe(0);

    // The evidence is indistinguishable from the named form: the same selected
    // set, the same completed set, and one approval stamp per activated lens,
    // each filed under the id the policy resolved rather than one the document
    // supplied.
    const manifest = await readManifest(emitted.stdout.trim());
    const reviewers = manifest.claims[0]!.payload.reviewers;
    expect(reviewers.selected).toEqual([...FIXTURE_CHARTERS]);
    expect(reviewers.completed).toEqual([...FIXTURE_CHARTERS]);
    expect(reviewers.failed).toEqual([]);
    expect(reviewers.timedOut).toEqual([]);
    expect(
      manifest.artifacts
        .filter((artifact) => artifact.role === "reviewer-approval")
        .map((artifact) => artifact.path)
        .sort(),
    ).toEqual(FIXTURE_CHARTERS.map((charter) => `reviewers/${charter}.json`).sort());
  });

  it("refuses unnamed results that disagree, rather than letting position decide who failed", () => {
    refuses([{ result: "approved" }, { result: "failed" }, { result: "approved" }], "disagree");
  });

  it("refuses a document that names some of its reviewers and not others", () => {
    refuses([{ id: "alpha-lens", result: "approved" }, { result: "approved" }, { result: "approved" }], "names 1");
  });

  it("refuses more or fewer results than the policy selects, naming the set it selects", () => {
    refuses([{ result: "approved" }, { result: "approved" }], "alpha-lens, beta-lens, zeta-lens");
    refuses(FIXTURE_CHARTERS.map(() => ({ result: "approved" })).concat([{ result: "approved" }]), "4 result");
  });

  it("still refuses a named reviewer the policy does not select", () => {
    // The naming form stays available — it is the only way to report reviewers
    // that disagree — and it stays held to the policy's set in both
    // directions, which the unnamed form must not become a way around.
    refuses([...approvedBy(FIXTURE_CHARTERS), { id: "invented-lens", result: "approved" }], "invented-lens");
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
      // One emitter run is one evaluated pass, and RG-9 ties the two together.
      // Stated as literals: comparing the two fields of one file to each other
      // is an assertion that cannot fail.
      expect(manifest.runHistory).toHaveLength(1);
      expect(telemetry.iterationCount).toBe(1);

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
