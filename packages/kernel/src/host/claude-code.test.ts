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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  gradeResumeEligibility,
  materializeProjection,
  mintGrantAttestation,
  readConsumptionMarker,
  tearDownProjection,
  verifyDiscoveryConfiguration,
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
      fence: 1,
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
      fence: 1,
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
      fence: 1,
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
      fence: 1,
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

describe("the consumption marker", () => {
  it("is injected at materialization bound to the delivery AND the fence, and reads back", async () => {
    const bench = await workbench("marker");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-marker-1",
      fence: 4,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok, JSON.stringify(materialized)).toBe(true);

    const marker = await readConsumptionMarker({ worktreeDir: bench.worktreeDir });
    expect(marker.ok, JSON.stringify(marker)).toBe(true);
    if (!marker.ok) return;
    expect(marker.deliveryId).toBe("dlv-marker-1");
    expect(marker.fence).toBe(4);
    expect(marker.consumed).toBe("skills/agent-skills-core-v1.zip");
  });

  it("changes the projection digest when the fence changes — a marker is per-run, not per-generation", async () => {
    const first = await workbench("marker-fence-a");
    const second = await workbench("marker-fence-b");
    const a = await materializeProjection({
      worktreeDir: first.worktreeDir,
      generationRoot: first.generationRoot,
      deliveryId: "dlv-marker-2",
      fence: 1,
      bindingDir: first.bindingDir,
      exec,
    });
    const b = await materializeProjection({
      worktreeDir: second.worktreeDir,
      generationRoot: second.generationRoot,
      deliveryId: "dlv-marker-2",
      fence: 2,
      bindingDir: second.bindingDir,
      exec,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.projectionDigest).not.toBe(b.projectionDigest);
  });

  it("fails closed when the marker is absent or its bytes are not the marker shape", async () => {
    const bench = await workbench("marker-absent");
    const absent = await readConsumptionMarker({ worktreeDir: bench.worktreeDir });
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.blockers.map((blocker) => blocker.code)).toContain("consumption_marker_missing");

    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-marker-3",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    const markerPath = path.join(bench.worktreeDir, PROJECTION_DIR, "consumption.json");
    chmodSync(markerPath, 0o644);
    writeFileSync(markerPath, "{}\n");
    const corrupt = await readConsumptionMarker({ worktreeDir: bench.worktreeDir });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.blockers.map((blocker) => blocker.code)).toContain("consumption_marker_corrupt");
  });
});

describe("verifyDiscoveryConfiguration", () => {
  it("matches the digest bound at application and fails closed when a byte is mutated", async () => {
    const bench = await workbench("discovery");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-discovery-1",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    const session = await composeClaudeCodeSession({
      bindingDir: bench.bindingDir,
      statePath: path.join(bench.bindingDir, "state.json"),
      hookCommand: ["node", "--import", "tsx", "hook-main.ts"],
      grant: { allowedCapabilities: ["Read"] },
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const verified = await verifyDiscoveryConfiguration({
      bindingDir: bench.bindingDir,
      expectedDigest: session.discoveryConfigurationDigest,
    });
    expect(verified.ok, JSON.stringify(verified)).toBe(true);

    // The set is BINDING-EXCLUSIVE: the host never mutates it, so any change
    // to its bytes is tampering and fails closed.
    writeFileSync(session.settingsPath, JSON.stringify({ permissions: { allow: ["Bash"] } }));
    const tampered = await verifyDiscoveryConfiguration({
      bindingDir: bench.bindingDir,
      expectedDigest: session.discoveryConfigurationDigest,
    });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) {
      expect(tampered.blockers.map((blocker) => blocker.code)).toContain("discovery_configuration_digest_mismatch");
    }
  });

  it("leaves host-writable settings outside the digest-bound set", async () => {
    const bench = await workbench("host-writes");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-discovery-2",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    const session = await composeClaudeCodeSession({
      bindingDir: bench.bindingDir,
      statePath: path.join(bench.bindingDir, "state.json"),
      hookCommand: ["node", "--import", "tsx", "hook-main.ts"],
      grant: { allowedCapabilities: ["Read"] },
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    // The host persists a permission decision the way Claude Code does: into
    // the worktree's own project scope. That scope is not loaded at admission
    // and is not in the binding-written set, so neither digest moves.
    mkdirSync(path.join(bench.worktreeDir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(bench.worktreeDir, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(rm:*)"] } }),
    );

    const discovery = await verifyDiscoveryConfiguration({
      bindingDir: bench.bindingDir,
      expectedDigest: session.discoveryConfigurationDigest,
    });
    expect(discovery.ok, JSON.stringify(discovery)).toBe(true);
    const projection = await verifyProjection({ worktreeDir: bench.worktreeDir, bindingDir: bench.bindingDir });
    expect(projection.ok).toBe(true);
  });
});

describe("tearDownProjection", () => {
  it("removes the projection subtree and the binding-written discovery configuration with the worktree", async () => {
    const bench = await workbench("teardown");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-teardown-1",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);
    const session = await composeClaudeCodeSession({
      bindingDir: bench.bindingDir,
      statePath: path.join(bench.bindingDir, "state.json"),
      hookCommand: ["node", "--import", "tsx", "hook-main.ts"],
      grant: { allowedCapabilities: ["Read"] },
    });
    expect(session.ok).toBe(true);

    const torn = await tearDownProjection({
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(torn.ok, JSON.stringify(torn)).toBe(true);

    expect(existsSync(path.join(bench.worktreeDir, PROJECTION_DIR))).toBe(false);
    expect(existsSync(path.join(bench.bindingDir, "settings.json"))).toBe(false);
    expect(existsSync(path.join(bench.bindingDir, "worktree-excludes"))).toBe(false);
    expect(existsSync(path.join(bench.bindingDir, "projection-receipt.json"))).toBe(false);
    // The worktree-scoped exclusion is gone with it, and the tree is clean:
    // nothing the binding wrote survives as untracked candidate content.
    expect(git(bench.worktreeDir, "config", "--worktree", "--default", "", "--get", "core.excludesFile")).toBe("");
    expect(git(bench.worktreeDir, "status", "--porcelain")).toBe("");

    // Teardown is idempotent — a second call on an already-torn-down worktree
    // is not an error, so worktree removal never races it into a blocker.
    const again = await tearDownProjection({ worktreeDir: bench.worktreeDir, bindingDir: bench.bindingDir, exec });
    expect(again.ok).toBe(true);
  });

  it("does not disturb a sibling worktree — the one permitted common-configuration write is non-interfering", async () => {
    const bench = await workbench("non-interference");
    const sibling = path.join(path.dirname(bench.worktreeDir), "sibling");
    git(bench.repoDir, "worktree", "add", "-b", "sibling", sibling, "main");
    const siblingBinding = path.join(path.dirname(bench.worktreeDir), "sibling-binding");
    const siblingMaterialized = await materializeProjection({
      worktreeDir: sibling,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-sibling",
      fence: 1,
      bindingDir: siblingBinding,
      exec,
    });
    expect(siblingMaterialized.ok, JSON.stringify(siblingMaterialized)).toBe(true);

    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-non-interference",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok, JSON.stringify(materialized)).toBe(true);

    // Each worktree carries its OWN excludes value: the write is worktree-
    // scoped, never the shared pattern space.
    expect(git(sibling, "config", "--worktree", "--get", "core.excludesFile")).toBe(
      path.join(siblingBinding, "worktree-excludes"),
    );
    expect(git(bench.worktreeDir, "config", "--worktree", "--get", "core.excludesFile")).toBe(
      path.join(bench.bindingDir, "worktree-excludes"),
    );

    // Tearing one down leaves the other's exclusion and clean status intact.
    const torn = await tearDownProjection({ worktreeDir: bench.worktreeDir, bindingDir: bench.bindingDir, exec });
    expect(torn.ok).toBe(true);
    expect(git(sibling, "config", "--worktree", "--get", "core.excludesFile")).toBe(
      path.join(siblingBinding, "worktree-excludes"),
    );
    expect(git(sibling, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(sibling, PROJECTION_DIR))).toBe(true);
  });
});

describe("gradeResumeEligibility", () => {
  it("is the honest derivation: unverified descendant teardown never yields same-workspace resume", () => {
    expect(gradeResumeEligibility({ descendantTeardown: "unverified" })).toBe("fresh-worktree-only");
    expect(gradeResumeEligibility({ descendantTeardown: "verified" })).toBe("same-workspace");
  });
});
