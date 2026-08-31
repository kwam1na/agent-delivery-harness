/**
 * The parity table: the MCP tool surface against the CLI, row by row.
 *
 * THE SUITE IS THE DELIVERABLE'S PROOF. The MCP server claims to be a thin
 * wrapper over the same command core the CLI runs, at strict parity. A claim
 * like that is only worth what its falsification is worth, so every row here
 * drives *one repository state* down both paths and compares what came back:
 * the exit code, the rendered text byte for byte, and the blocker codes. A
 * behaviour the MCP surface grew on its own — a different verdict, a softened
 * rejection, a summary the CLI never printed — shows up as a failing row.
 *
 * Nothing is stubbed: the rows run real `git` repositories, the real evidence
 * store, and the real recorder, because the parity that matters is parity over
 * the outcomes an operator and an agent actually get.
 *
 * WHERE THE TABLE COMPARES CLASS RATHER THAN BYTES. Three usage rows describe
 * arguments the CLI's argv cannot express at all — a non-string manifest, an
 * unknown argument member, an unknown tool name. There is no CLI text to be
 * byte-identical to, so those rows assert the exit-2 usage class and that the
 * MCP text is itself a rendered blocker. Every row whose arguments *are*
 * expressible in argv is compared byte for byte.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureGitCandidate,
  createArtifactsPort,
  defineHarnessConfig,
  resolveRecordStorage,
  sha256Hex,
  submitManifest,
  withDeliverableIdentity,
  type ArtifactsPort,
  type CapturedCandidate,
  type HarnessConfig,
  type HarnessConfigInput,
} from "@agent-delivery-harness/kernel";
import { EXIT_OK, EXIT_POLICY, EXIT_USAGE, runCli, type CliRuntime } from "@agent-delivery-harness/cli";
import { callTool, listTools, toolResultFor, type ToolHostRuntime, type ToolOutcome } from "./server.ts";

const run = promisify(execFile);
const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Config and repo fixtures ─────────────────────────────────────────────────

const PROVIDER = { id: "claude-code.ce-code-review", version: "1.0.0", runId: "r-mcp-01", finalPassId: "pass-2" };
const STRUCTURAL_WAIVABLE = ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings"];
const STRUCTURAL_NONWAIVABLE = [
  "ambiguous_records",
  "malformed_record",
  "unknown_provider",
  "live_provider_missing",
  "ambiguous_live_provider",
  "live_provider_failed",
  "resolution_not_allowed",
];

function makeConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "test.gate",
    baseRef: "origin/main",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: ["deliverable-tree/v1"],
    computingIdentityVersion: "deliverable-tree/v1",
    reviewNeutral: [{ prefix: "docs/reports/" }, { prefix: "docs/solutions/" }, { prefix: "telemetry/delivery-runs/" }],
    recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [],
    activationThreshold: 1,
    providers: [{ id: PROVIDER.id, findingCodes: [] }],
    agentEnvSignals: ["CLAUDE_CODE"],
    ciPolicies: [],
    ciPolicyEnvKey: "DH_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [
      {
        id: "review.green",
        activation: { kind: "relevant_change" },
        freshness: "exact_candidate",
        providers: [PROVIDER.id],
        acceptedPayloadSpecs: ["review.green/1"],
        allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
        humanWaiverAllowed: true,
        minimumAttestationLevel: "self",
        ciDelegationPolicyIds: [],
        remediation: { default: [{ id: "submit-evidence", kind: "manual_action", summary: "Submit review evidence." }] },
        waivableCodes: [...STRUCTURAL_WAIVABLE],
        nonWaivableCodes: [...STRUCTURAL_NONWAIVABLE],
      },
    ],
    deliveryRecordPath: "telemetry/delivery-runs/record.json",
    deliveryRecordVerification: { baseMovement: "stale" },
    ...overrides,
  });
}

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-mcp-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "harness.config.ts"), "export default {};\n", "utf8");
  await git(dir, "add", "harness.config.ts");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "root");
  await git(dir, "branch", "origin/main");
  writeFileSync(path.join(dir, "src.txt"), "hello world\n", "utf8");
  await git(dir, "add", "src.txt");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "work");
  return dir;
}

async function makeArtifacts(): Promise<ArtifactsPort> {
  const base = await mkdtemp(path.join(os.tmpdir(), "dh-mcp-runs-"));
  cleanups.push(base);
  return createArtifactsPort({ runRootBase: base });
}

function greenPayload(): Record<string, unknown> {
  return {
    verdict: "green",
    finalized: true,
    editedAfterFinalPass: false,
    reviewers: { selected: ["correctness"], completed: ["correctness"], failed: [], timedOut: [] },
    findings: [],
    telemetry: { iterationCount: 2, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, deferredExpansionCount: 0, deferredIssueIds: [] },
  };
}

type Mutation = (manifest: Record<string, unknown>) => Record<string, unknown>;

/**
 * Builds a submission bound to the repository's currently captured candidate,
 * then hands the assembled manifest to `mutate` — which is how each reject row
 * gets exactly one representative violation of its code family.
 */
async function buildSubmission(
  dir: string,
  config: HarnessConfig,
  artifacts: ArtifactsPort,
  mutate: Mutation = (manifest) => manifest,
): Promise<string> {
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  const capture = await captureGitCandidate({
    rootDir: dir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
  });
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  const captured: CapturedCandidate = capture.candidate;
  const candidate = {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    headSha: captured.headSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId,
  };

  const allocation = await artifacts.allocateRunRoot({ providerId: PROVIDER.id, runId: PROVIDER.runId });
  if (!allocation.ok) throw new Error(`run root: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;

  const approval = `${JSON.stringify(
    {
      schemaVersion: 1,
      reviewerId: "correctness",
      result: "approved",
      provider: { id: PROVIDER.id, runId: PROVIDER.runId, finalPassId: PROVIDER.finalPassId },
      workspaceId: candidate.workspaceId,
      candidate,
    },
    null,
    2,
  )}\n`;
  await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
  await writeFile(path.join(runRoot, "reviewers/correctness.json"), approval, "utf8");

  const manifest: Record<string, unknown> = {
    spec: "delivery-evidence/1",
    provider: PROVIDER,
    candidate,
    repository: null,
    runHistory: [
      { preparedTreeSha: "1".repeat(40), evaluatedInPassId: "pass-1" },
      { preparedTreeSha: captured.treeSha, evaluatedInPassId: PROVIDER.finalPassId },
    ],
    artifacts: [{ path: "reviewers/correctness.json", sha256: sha256Hex(approval), role: "reviewer-approval" }],
    attestation: { level: "self", signatures: [] },
    recordedAt: "2026-08-25T00:00:00Z",
    claims: [{ obligation: "review.green", payloadSpec: "review.green/1", payload: greenPayload() }],
  };
  const manifestPath = path.join(runRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(mutate(manifest), null, 2)}\n`, "utf8");
  return manifestPath;
}

// ── The two paths ────────────────────────────────────────────────────────────

interface PathResult {
  readonly exitCode: number;
  readonly text: string;
  readonly codes: readonly string[];
}

/** The `[code]` lines are the CLI's structured surface; this reads them back. */
function renderedCodes(text: string): readonly string[] {
  return [...text.matchAll(/^\[([a-z0-9_-]+)\]/gm)].map((match) => match[1] as string);
}

async function throughCli(dir: string, config: HarnessConfig, artifacts: ArtifactsPort, argv: readonly string[]): Promise<PathResult> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime: CliRuntime = {
    cwd: dir,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    loadConfig: async () => config,
    artifacts,
  };
  const exitCode = await runCli(argv, runtime);
  const text = `${out.join("")}${err.join("")}`.trimEnd();
  return { exitCode, text, codes: renderedCodes(text) };
}

async function throughMcp(
  dir: string,
  config: HarnessConfig,
  artifacts: ArtifactsPort,
  tool: string,
  args: unknown,
): Promise<{ readonly result: PathResult; readonly outcome: ToolOutcome }> {
  const runtime: ToolHostRuntime = { cwd: dir, env: {}, loadConfig: async () => config, artifacts };
  const outcome = await callTool(tool, args, runtime);
  return {
    outcome,
    result: {
      exitCode: outcome.exitCode,
      text: outcome.text,
      codes: outcome.blockers.blockers.map((blocker) => blocker.code),
    },
  };
}

/** Restores "nothing has been submitted yet" without disturbing the receipt. */
async function resetRecords(dir: string, config: HarnessConfig): Promise<void> {
  const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
  await rm(storage.storageDir, { recursive: true, force: true });
}

interface ParityExpectation {
  /** The outcome class both paths must reach. */
  readonly outcome: ToolOutcome["outcome"];
  /** Blocker codes the row exists to witness. Both paths must carry them. */
  readonly witnesses?: readonly string[];
}

/**
 * Drives one repository state down both paths and compares everything that
 * crosses either surface. The records leaf is reset before each run, so the
 * second path sees exactly the state the first one did — otherwise an accepted
 * submission would be graded against a store the CLI already populated.
 */
async function assertParity(
  dir: string,
  config: HarnessConfig,
  artifacts: ArtifactsPort,
  argv: readonly string[],
  tool: string,
  args: unknown,
  expectation: ParityExpectation,
): Promise<ToolOutcome> {
  await resetRecords(dir, config);
  const cli = await throughCli(dir, config, artifacts, argv);
  await resetRecords(dir, config);
  const { result: mcp, outcome } = await throughMcp(dir, config, artifacts, tool, args);

  expect(mcp.exitCode, "exit code parity").toBe(cli.exitCode);
  expect(mcp.text, "rendered text parity").toBe(cli.text);
  expect(mcp.codes, "blocker code parity").toEqual(cli.codes);

  const expectedExit =
    expectation.outcome === "ok" ? EXIT_OK : expectation.outcome === "usage" ? EXIT_USAGE : EXIT_POLICY;
  expect(outcome.outcome).toBe(expectation.outcome);
  expect(outcome.exitCode).toBe(expectedExit);
  for (const code of expectation.witnesses ?? []) {
    expect(mcp.codes, `expected the row to witness ${code}`).toContain(code);
  }
  return outcome;
}

// ── The parity table ─────────────────────────────────────────────────────────

describe("parity table: the same repository state through both paths", () => {
  it(
    "accept vector, one reject per code family, and review context agree on both paths",
    { timeout: 180000 },
    async () => {
      const dir = await initRepo();
      const config = makeConfig();
      const artifacts = await makeArtifacts();

      // review-context before the receipt exists: the row that proves a block
      // raised by the command itself crosses identically.
      await assertParity(dir, config, artifacts, ["review-context"], "review-context", {}, { outcome: "blocked" });

      // A submission before anything is prepared: the receipt gate, not a
      // manifest rule, and it has to cross identically too.
      const unpreparedManifest = await buildSubmission(dir, config, artifacts);
      await assertParity(
        dir,
        config,
        artifacts,
        ["submit-evidence", "--manifest", unpreparedManifest],
        "submit-evidence",
        { manifest: unpreparedManifest },
        { outcome: "blocked", witnesses: ["preparation_missing"] },
      );

      expect(await runCli(["prepare"], cliRuntime(dir, config, artifacts))).toBe(EXIT_OK);

      // review-context on a prepared candidate: the accept side of the command.
      await assertParity(dir, config, artifacts, ["review-context"], "review-context", {}, { outcome: "ok" });

      // SUB family: a working tree with uncommitted work has no candidate to
      // compare against, and SUB-2 refuses the submission (candidate_unprepared).
      const subManifest = await buildSubmission(dir, config, artifacts);
      writeFileSync(path.join(dir, "src.txt"), "uncommitted\n", "utf8");
      await assertParity(
        dir,
        config,
        artifacts,
        ["submit-evidence", "--manifest", subManifest],
        "submit-evidence",
        { manifest: subManifest },
        { outcome: "blocked", witnesses: ["candidate_unprepared"] },
      );
      // Back to the prepared tree the remaining rows are bound to.
      writeFileSync(path.join(dir, "src.txt"), "hello world\n", "utf8");

      // GEN family: a member this version's grammar does not define (GEN-1).
      const genManifest = await buildSubmission(dir, config, artifacts, (manifest) => ({ ...manifest, surprise: true }));
      await assertParity(
        dir,
        config,
        artifacts,
        ["submit-evidence", "--manifest", genManifest],
        "submit-evidence",
        { manifest: genManifest },
        { outcome: "blocked", witnesses: ["unknown_member"] },
      );

      // ENV family: an attestation level delivery-evidence/1 does not implement.
      const envManifest = await buildSubmission(dir, config, artifacts, (manifest) => ({
        ...manifest,
        attestation: { level: "org", signatures: [] },
      }));
      await assertParity(
        dir,
        config,
        artifacts,
        ["submit-evidence", "--manifest", envManifest],
        "submit-evidence",
        { manifest: envManifest },
        { outcome: "blocked", witnesses: ["unsupported_attestation"] },
      );

      // RG family: a payload whose verdict is not green (RG-1).
      const rgManifest = await buildSubmission(dir, config, artifacts, (manifest) => ({
        ...manifest,
        claims: [{ obligation: "review.green", payloadSpec: "review.green/1", payload: { ...greenPayload(), verdict: "red" } }],
      }));
      await assertParity(
        dir,
        config,
        artifacts,
        ["submit-evidence", "--manifest", rgManifest],
        "submit-evidence",
        { manifest: rgManifest },
        { outcome: "blocked", witnesses: ["verdict_not_green"] },
      );

      // The accept vector, last: it is the only row that publishes records, and
      // the reset between the two runs is what keeps the second one honest.
      const acceptManifest = await buildSubmission(dir, config, artifacts);
      const accepted = await assertParity(
        dir,
        config,
        artifacts,
        ["submit-evidence", "--manifest", acceptManifest],
        "submit-evidence",
        { manifest: acceptManifest },
        { outcome: "ok" },
      );
      expect(accepted.text).toContain("accepted (manifestDigest ");
      expect(accepted.blockers.blockers).toHaveLength(0);
    },
  );

  it("candidate mismatch rejects identically on both paths", { timeout: 120000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();

    expect(await runCli(["prepare"], cliRuntime(dir, config, artifacts))).toBe(EXIT_OK);
    const manifestPath = await buildSubmission(dir, config, artifacts);
    // The tree moves after the manifest was bound to it, and the new candidate
    // is prepared in turn — so the receipt is current and SUB-1 is what the
    // submission runs into: evidence for a candidate that no longer exists.
    writeFileSync(path.join(dir, "src.txt"), "edited\n", "utf8");
    await git(dir, "add", "src.txt");
    await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "edit");
    expect(await runCli(["prepare"], cliRuntime(dir, config, artifacts))).toBe(EXIT_OK);

    await assertParity(
      dir,
      config,
      artifacts,
      ["submit-evidence", "--manifest", manifestPath],
      "submit-evidence",
      { manifest: manifestPath },
      { outcome: "blocked", witnesses: ["candidate_mismatch"] },
    );
  });
});

function cliRuntime(dir: string, config: HarnessConfig, artifacts: ArtifactsPort): CliRuntime {
  return {
    cwd: dir,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: () => {},
    stderr: () => {},
    loadConfig: async () => config,
    artifacts,
  };
}

// ── The usage class ──────────────────────────────────────────────────────────

describe("malformed and unknown tool arguments are the CLI's exit-2 class", () => {
  it("a missing manifest argument reproduces the CLI usage error byte for byte", { timeout: 60000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-mcp-usage-"));
    cleanups.push(dir);
    const config = makeConfig();
    const artifacts = await makeArtifacts();

    const cli = await throughCli(dir, config, artifacts, ["submit-evidence"]);
    const { outcome } = await throughMcp(dir, config, artifacts, "submit-evidence", {});
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(outcome.outcome).toBe("usage");
    expect(outcome.text).toBe(cli.text);
  });

  it.each([
    ["a non-string manifest", "submit-evidence", { manifest: 42 } as unknown],
    ["an unknown argument member", "submit-evidence", { manifestPath: "/tmp/x.json" } as unknown],
    ["arguments that are not an object", "review-context", "manifest" as unknown],
    ["an unknown tool", "delete-everything", {} as unknown],
  ])("%s is a rendered usage error at the CLI's exit-2 class", { timeout: 60000 }, async (_label, tool, args) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-mcp-usage-"));
    cleanups.push(dir);
    const config = makeConfig();
    const artifacts = await makeArtifacts();

    // The class the CLI reaches for an invocation it cannot parse.
    const cli = await throughCli(dir, config, artifacts, ["not-a-command"]);
    expect(cli.exitCode).toBe(EXIT_USAGE);

    const { outcome } = await throughMcp(dir, config, artifacts, tool, args);
    expect(outcome.exitCode).toBe(cli.exitCode);
    expect(outcome.outcome).toBe("usage");
    // Rendered, not raw: a usage error the CLI cannot express in argv still
    // leaves through the one renderer, remediation and all.
    expect(outcome.text).toContain("Remediation:");
    expect(outcome.blockers.blockers.length).toBeGreaterThan(0);
  });

  it("refuses a real CLI command that is not an exposed tool", { timeout: 60000 }, async () => {
    // The MCP surface is a deliberate subset — `review-context`,
    // `submit-evidence`, and the read-only `managed` projection, and nothing
    // else. Refusing `record` by name is what keeps the subset a subset: the
    // tool registry, not the CLI registry, is what a tool call may reach.
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-mcp-subset-"));
    cleanups.push(dir);
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const { outcome } = await throughMcp(dir, config, artifacts, "record", {});
    expect(outcome.outcome).toBe("usage");
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(listTools().map((tool) => tool.name)).toEqual(["review-context", "submit-evidence", "managed"]);
  });
});

// ── Neutralization, with its falsification ───────────────────────────────────

const ESC = "";
const HOSTILE_MEMBER = `evil${ESC}[31m‮gnihtemos​x`;

describe("hostile text arrives neutralized in tool results", () => {
  it("neutralizes ANSI, bidi and zero-width text on both faces of the renderer", { timeout: 120000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    expect(await runCli(["prepare"], cliRuntime(dir, config, artifacts))).toBe(EXIT_OK);

    // The vector: a manifest member the grammar does not define, whose *name*
    // is provider-authored text. GEN-1 names it in the rejection pointer, so
    // the hostile bytes reach the blocker's details from outside the harness.
    const manifestPath = await buildSubmission(dir, config, artifacts, (manifest) => ({
      ...manifest,
      [HOSTILE_MEMBER]: true,
    }));

    // FALSIFICATION CONTROL. The same submission, straight from the kernel with
    // no renderer in front of it, still carries every hostile byte. If this
    // control ever comes back clean the assertions below prove nothing, because
    // the vector would no longer be reaching the surface under test.
    const raw = await submitManifest(
      { rootDir: dir, manifestPath, config },
      {
        captureCandidate: async () => {
          const storage = await resolveRecordStorage(dir, { storageNamespace: config.storageNamespace });
          return captureGitCandidate({ rootDir: dir, config, workspaceId: storage.workspaceId, computeIdentity: withDeliverableIdentity() });
        },
        artifacts,
        storageNamespace: config.storageNamespace,
      },
    );
    expect(raw.status).toBe("rejected");
    const rawText = JSON.stringify(raw.status === "rejected" ? raw.blockers : []);
    // `JSON.stringify` escapes the C0 escape and leaves the two invisibles as
    // themselves; both forms are the hostile bytes still present.
    expect(rawText, "the ANSI escape must still reach the unrendered blocker").toContain("\\u001b[31m");
    expect(rawText, "the bidi override must still reach the unrendered blocker").toContain("‮");
    expect(rawText, "the zero-width space must still reach the unrendered blocker").toContain("​");

    await resetRecords(dir, config);
    const { outcome } = await throughMcp(dir, config, artifacts, "submit-evidence", { manifest: manifestPath });
    expect(outcome.outcome).toBe("blocked");
    expect(outcome.blockers.blockers.length).toBeGreaterThan(0);

    // Both faces: the text an agent reads and the structured content it parses.
    const result = toolResultFor(outcome);
    for (const [face, text] of [
      ["text content", result.content.map((entry) => entry.text).join("\n")],
      ["structured content", JSON.stringify(result.structuredContent)],
    ] as const) {
      expect(text, `${face} must not carry ANSI`).not.toContain(ESC);
      expect(text, `${face} must not carry ANSI (escaped)`).not.toContain("\\u001b");
      expect(text, `${face} must not carry bidi overrides`).not.toContain("‮");
      expect(text, `${face} must not carry bidi overrides (escaped)`).not.toContain("\\u202e");
      expect(text, `${face} must not carry zero-width characters`).not.toContain("​");
      expect(text, `${face} must not carry zero-width characters (escaped)`).not.toContain("\\u200b");
    }
    // The surrounding diagnostic survives: neutralization is not censorship.
    expect(result.content.map((entry) => entry.text).join("\n")).toContain("unknown_member");
  });

  it("neutralizes hostile text arriving through a tool argument", { timeout: 60000 }, async () => {
    const dir = await initRepo();
    const config = makeConfig();
    const artifacts = await makeArtifacts();
    const hostilePath = path.join(dir, `absent${ESC}[31m‮noisnetxe​.json`);

    const { outcome } = await throughMcp(dir, config, artifacts, "submit-evidence", { manifest: hostilePath });
    expect(outcome.outcome).toBe("blocked");
    const rendered = `${outcome.text}\n${JSON.stringify(outcome.blockers)}`;
    expect(rendered).not.toContain(ESC);
    expect(rendered).not.toContain("\\u001b");
    expect(rendered).not.toContain("‮");
    expect(rendered).not.toContain("\\u202e");
    expect(rendered).not.toContain("​");
    expect(rendered).not.toContain("\\u200b");
  });
});

// ── The advertised surface ───────────────────────────────────────────────────

describe("the tool listing", () => {
  it("advertises exactly the three commands, named as the CLI names them", () => {
    const tools = listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["review-context", "submit-evidence", "managed"]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema["type"]).toBe("object");
      expect(tool.inputSchema["additionalProperties"]).toBe(false);
    }
  });
});
