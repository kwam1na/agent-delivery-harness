/**
 * The host module's V-slice: the Claude Code in-session projection and
 * admission composition, consuming the graded capability record's findings as
 * characterization baselines — the projection is materialized into the
 * host-created worktree and digest-receipted (no host API for root selection),
 * candidate-writable setting scopes are excluded at admission
 * (`--setting-sources` without project/local), and the worktree-scoped
 * exclusion never touches the shared `info/exclude` pattern space.
 *
 * Written RED before `claude-code.ts` existed.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateHostAdmission } from "../binding/host-admission.ts";
import { sha256Hex } from "../digest.ts";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";
import { readArchiveEntry } from "../workflow/archive.ts";
import { WORKFLOW_GRAPH_ENTRY } from "../workflow/graph.ts";
import { createExecPort } from "./exec-port.ts";
import {
  PROJECTION_DIR,
  composeClaudeCodeSession,
  materializeProjection,
  mintGrantAttestation,
  verifyProjection,
} from "./claude-code.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "fixtures");
const SKILLS_ARCHIVE = path.join(FIXTURES, "agent-skills-core-v1-composition.zip");

let scratch: string;
const exec = createExecPort();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

interface Workbench {
  readonly repoDir: string;
  readonly worktreeDir: string;
  readonly bindingDir: string;
  readonly generationRoot: string;
}

/** A disposable repo + linked worktree + a stand-in generation root carrying the pinned archive. */
async function workbench(name: string): Promise<Workbench> {
  const base = await mkdtemp(path.join(scratch, `${name}-`));
  const repoDir = path.join(base, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "--initial-branch", "main");
  git(repoDir, "config", "user.email", "skeleton@example.invalid");
  git(repoDir, "config", "user.name", "Skeleton");
  writeFileSync(path.join(repoDir, "README.md"), "disposable\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "base");
  const worktreeDir = path.join(base, "worktree");
  git(repoDir, "worktree", "add", "-b", "delivery", worktreeDir, "main");

  const generationRoot = path.join(base, "generation");
  mkdirSync(path.join(generationRoot, "skills"), { recursive: true });
  writeFileSync(path.join(generationRoot, "skills", "agent-skills-core-v1.zip"), readFileSync(SKILLS_ARCHIVE));

  const bindingDir = path.join(base, "binding");
  return { repoDir, worktreeDir, bindingDir, generationRoot };
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "host-binding-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

describe("materializeProjection", () => {
  it("materializes a digest-receipted read-only projection the worktree does not track", async () => {
    const bench = await workbench("materialize");
    const result = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-host-1",
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // The bundled graph rides in verbatim: the projected bytes hash to the pin.
    const projectedGraph = await readFile(path.join(bench.worktreeDir, PROJECTION_DIR, WORKFLOW_GRAPH_ENTRY));
    expect(sha256Hex(projectedGraph)).toBe(PINNED_AGENT_SKILLS.workflowGraphSha256);
    const archiveGraph = readArchiveEntry(readFileSync(SKILLS_ARCHIVE), WORKFLOW_GRAPH_ENTRY);
    expect(sha256Hex(archiveGraph)).toBe(sha256Hex(projectedGraph));

    // The exclusion is worktree-scoped: git sees a clean tree, and the shared
    // info/exclude pattern space is untouched.
    expect(git(bench.worktreeDir, "status", "--porcelain")).toBe("");
    const commonInfoExclude = path.join(bench.repoDir, ".git", "info", "exclude");
    const infoExclude = (() => {
      try {
        return readFileSync(commonInfoExclude, "utf8");
      } catch {
        return "";
      }
    })();
    expect(infoExclude).not.toContain(PROJECTION_DIR);

    // Verification recomputes the digest from the worktree bytes.
    const verified = await verifyProjection({ worktreeDir: bench.worktreeDir, bindingDir: bench.bindingDir });
    expect(verified.ok).toBe(true);
  });

  it("fails verification closed when a projected byte is tampered", async () => {
    const bench = await workbench("tamper");
    const result = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-host-2",
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(result.ok).toBe(true);
    const target = path.join(bench.worktreeDir, PROJECTION_DIR, WORKFLOW_GRAPH_ENTRY);
    chmodSync(target, 0o644);
    writeFileSync(target, "{}");
    const verified = await verifyProjection({ worktreeDir: bench.worktreeDir, bindingDir: bench.bindingDir });
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.blockers.map((blocker) => blocker.code)).toContain("projection_digest_mismatch");
    }
  });

  it("fails closed on a pre-existing worktree excludes file instead of clobbering it", async () => {
    const bench = await workbench("preexisting");
    git(bench.repoDir, "config", "extensions.worktreeConfig", "true");
    git(bench.worktreeDir, "config", "--worktree", "core.excludesFile", "/tmp/operator-owned-excludes");
    const result = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-host-3",
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.map((blocker) => blocker.code)).toContain("preexisting_worktree_excludes");
    }
  });
});

describe("composeClaudeCodeSession", () => {
  it("excludes candidate-writable setting scopes and wires the model-external hooks", async () => {
    const bench = await workbench("compose");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-host-4",
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);

    const session = await composeClaudeCodeSession({
      bindingDir: bench.bindingDir,
      statePath: path.join(bench.bindingDir, "state.json"),
      hookCommand: ["node", "--import", "tsx", "hook-main.ts"],
      grant: { allowedCapabilities: ["Bash", "Read", "Write"] },
    });
    expect(session.ok, JSON.stringify(session)).toBe(true);
    if (!session.ok) return;

    // The graded record's required admission flags: candidate-writable scopes
    // (project/local) are excluded, which neutralizes a planted settings
    // file. The composed selection excludes every ambient scope, so the
    // binding's own settings file is the session's only settings source.
    const sources = session.cliArgs[session.cliArgs.indexOf("--setting-sources") + 1];
    expect(sources).toBe("");
    expect(sources).not.toContain("project");
    expect(sources).not.toContain("local");

    const settings = JSON.parse(readFileSync(session.settingsPath, "utf8")) as Record<string, unknown>;
    // The host's own permission system enforces the grant's capability set.
    expect((settings["permissions"] as { allow: string[] }).allow).toEqual(["Bash", "Read", "Write"]);
    const hooks = settings["hooks"] as Record<string, unknown>;
    expect(Object.keys(hooks)).toContain("PreToolUse");
    expect(Object.keys(hooks)).toContain("SessionEnd");
    expect(JSON.stringify(hooks)).toContain("hook-main.ts");

    // The discovery-configuration digest binds the binding-written bytes.
    expect(session.discoveryConfigurationDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mintGrantAttestation", () => {
  it("mints an attestation the model-external admission check admits, bound to the exact expectation", () => {
    const grant = {
      spec: "execution-grant/1",
      profile: "checkpoint",
      allowedCapabilities: ["Bash"],
      writablePaths: ["src"],
      protectedPaths: [".git"],
      forbiddenOperations: [],
    };
    const expectation = {
      profile: "checkpoint",
      hostVersion: "2.1.97",
      productTrustRevocationEpoch: 0,
      observedAt: "2026-08-30T12:00:00Z",
      deliveryId: "dlv-host-5",
      invocationFence: 1,
      workspaceId: "ws-1",
      projectionDigest: "a".repeat(64),
      discoveryConfigurationDigest: "b".repeat(64),
      registeringInstallationId: "install-1",
      activeProfile: "confirmation-fixture",
    } as const;
    const attestation = mintGrantAttestation({ grant, expectation, expiry: "2026-08-30T12:15:00Z" });
    expect(evaluateHostAdmission(expectation, grant, attestation).admitted).toBe(true);
    // And a superseded fence stops matching — stale attestations open no tools.
    expect(evaluateHostAdmission({ ...expectation, invocationFence: 2 }, grant, attestation).admitted).toBe(false);
  });
});
