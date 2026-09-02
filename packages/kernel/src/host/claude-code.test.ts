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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  discoveryConfigurationDigestOf,
  gradeResumeEligibility,
  gradedDescendantTeardown,
  materializeProjection,
  mintGrantAttestation,
  readConsumptionMarker,
  tearDownProjection,
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
      fence: 1,
      workspaceRoot: bench.worktreeDir,
      commonGitDir: path.join(bench.repoDir, ".git"),
      authorityDir: path.join(path.dirname(bench.worktreeDir), "provider-review-authority"),
      grant: {
        allowedCapabilities: ["Bash", "Read", "Write"],
        writablePaths: ["src"],
        protectedPaths: ["src/protected", ".git"],
      },
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
    const sandbox = settings["sandbox"] as {
      enabled: boolean;
      failIfUnavailable: boolean;
      allowUnsandboxedCommands: boolean;
      excludedCommands: string[];
      filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
    };
    expect(sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
    });
    // The bench workspace is temp-hosted, so the granted root is emitted under
    // both the written and the resolved spelling; the temporary-directory
    // posture suite below owns that rule and its outside-the-temp-directory
    // counterpart.
    expect(sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining([path.join(bench.worktreeDir, "src")]));
    expect(sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([
      path.join(bench.worktreeDir, "src", "protected"),
      path.join(bench.repoDir, ".git"),
      path.join(path.dirname(bench.worktreeDir), "provider-review-authority"),
    ]));
    expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([
      path.join(bench.repoDir, ".git"),
      path.join(path.dirname(bench.worktreeDir), "provider-review-authority"),
    ]));
    expect(session.cliArgs).toContain("--restricted");
    const hooks = settings["hooks"] as Record<string, unknown>;
    expect(Object.keys(hooks)).toContain("PreToolUse");
    expect(Object.keys(hooks)).toContain("PostToolUse");
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

describe("the binding-written discovery configuration", () => {
  it("matches the digest bound at application and moves when a byte is mutated", async () => {
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
      fence: 1,
      workspaceRoot: bench.worktreeDir,
      commonGitDir: path.join(bench.repoDir, ".git"),
      authorityDir: bench.bindingDir,
      grant: { allowedCapabilities: ["Read"], writablePaths: ["src"], protectedPaths: [".git", PROJECTION_DIR] },
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    // One definition, used at application and at every canonical recheck.
    expect(await discoveryConfigurationDigestOf({ settingsPath: session.settingsPath, bindingDir: bench.bindingDir })).toBe(session.discoveryConfigurationDigest);

    // The set is BINDING-EXCLUSIVE: the host never mutates it, so any change
    // to its bytes moves the digest and the recheck fails closed on it.
    writeFileSync(session.settingsPath, JSON.stringify({ permissions: { allow: ["Bash"] } }));
    expect(await discoveryConfigurationDigestOf({ settingsPath: session.settingsPath, bindingDir: bench.bindingDir })).not.toBe(session.discoveryConfigurationDigest);

    // An unreadable member yields no digest at all, which can never equal an
    // expected one — the recheck fails closed rather than skipping.
    await rm(path.join(bench.bindingDir, "worktree-excludes"), { force: true });
    expect(await discoveryConfigurationDigestOf({ settingsPath: session.settingsPath, bindingDir: bench.bindingDir })).toBeUndefined();
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
      fence: 1,
      workspaceRoot: bench.worktreeDir,
      commonGitDir: path.join(bench.repoDir, ".git"),
      authorityDir: bench.bindingDir,
      grant: { allowedCapabilities: ["Read"], writablePaths: ["src"], protectedPaths: [".git", PROJECTION_DIR] },
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

    expect(await discoveryConfigurationDigestOf({ settingsPath: session.settingsPath, bindingDir: bench.bindingDir })).toBe(session.discoveryConfigurationDigest);
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
      fence: 1,
      workspaceRoot: bench.worktreeDir,
      commonGitDir: path.join(bench.repoDir, ".git"),
      authorityDir: bench.bindingDir,
      grant: { allowedCapabilities: ["Read"], writablePaths: ["src"], protectedPaths: [".git", PROJECTION_DIR] },
    });
    expect(session.ok).toBe(true);

    const torn = await tearDownProjection({
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      settingsPath: path.join(bench.bindingDir, "settings-1.json"),
      exec,
    });
    expect(torn.ok, JSON.stringify(torn)).toBe(true);

    expect(existsSync(path.join(bench.worktreeDir, PROJECTION_DIR))).toBe(false);
    expect(existsSync(path.join(bench.bindingDir, "settings-1.json"))).toBe(false);
    expect(existsSync(path.join(bench.bindingDir, "worktree-excludes"))).toBe(false);
    expect(existsSync(path.join(bench.bindingDir, "projection-receipt.json"))).toBe(false);
    // The worktree-scoped exclusion is gone with it, and the tree is clean:
    // nothing the binding wrote survives as untracked candidate content.
    expect(git(bench.worktreeDir, "config", "--worktree", "--default", "", "--get", "core.excludesFile")).toBe("");
    expect(git(bench.worktreeDir, "status", "--porcelain")).toBe("");

    // Teardown is idempotent — a second call on an already-torn-down worktree
    // is not an error, so worktree removal never races it into a blocker.
    const again = await tearDownProjection({ worktreeDir: bench.worktreeDir, bindingDir: bench.bindingDir, settingsPath: path.join(bench.bindingDir, "settings-1.json"), exec });
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
    const torn = await tearDownProjection({ worktreeDir: bench.worktreeDir, bindingDir: bench.bindingDir, settingsPath: path.join(bench.bindingDir, "settings-1.json"), exec });
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

describe("gradedDescendantTeardown", () => {
  const REAL_RECORD = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "host-admission-capabilities.json");

  const generationWith = async (record: unknown): Promise<string> => {
    const root = await mkdtemp(path.join(scratch, "graded-"));
    mkdirSync(path.join(root, "qualifications"), { recursive: true });
    writeFileSync(path.join(root, "qualifications", "host-admission-capabilities.json"), JSON.stringify(record));
    return root;
  };

  it("reads UNVERIFIED for the real graded host — the record, not a caller, decides", async () => {
    const root = await mkdtemp(path.join(scratch, "graded-real-"));
    mkdirSync(path.join(root, "qualifications"), { recursive: true });
    writeFileSync(path.join(root, "qualifications", "host-admission-capabilities.json"), readFileSync(REAL_RECORD));
    expect(
      await gradedDescendantTeardown({ generationRoot: root, hostId: "claude-code", hostVersion: "2.1.97" }),
    ).toBe("unverified");
  });

  it("resolves the SHIPPED record's own key, so the Tier 3 lane cannot be silently dead", async () => {
    // A wrong host id or an unexpected version format would look exactly like
    // an honest Tier 2 grade — both return `unverified`. Taking the REAL record
    // and flipping only the ladder position pins the key to what ships.
    const upgraded = JSON.parse(readFileSync(REAL_RECORD, "utf8")) as {
      hosts: { hostId: string; grade: { tier: number }; capabilities: Record<string, { status: string }> }[];
    };
    const graded = upgraded.hosts.find((host) => host.hostId === "claude-code");
    expect(graded, "the shipped record grades claude-code").toBeDefined();
    if (graded === undefined) return;
    graded.grade.tier = 3;
    (graded.capabilities["terminationProvenanceWithDescendantTeardown"] as { status: string }).status = "supported";
    expect(
      await gradedDescendantTeardown({
        generationRoot: await generationWith(upgraded),
        hostId: "claude-code",
        hostVersion: "2.1.97",
      }),
    ).toBe("verified");
  });

  it("reads VERIFIED only when the ladder grade AND the capability entry both reach Tier 3", async () => {
    const tier3 = {
      hosts: [
        {
          hostId: "claude-code",
          hostVersion: "9.9.9",
          grade: { tier: 3 },
          capabilities: { terminationProvenanceWithDescendantTeardown: { status: "supported" } },
        },
      ],
    };
    expect(
      await gradedDescendantTeardown({
        generationRoot: await generationWith(tier3),
        hostId: "claude-code",
        hostVersion: "9.9.9",
      }),
    ).toBe("verified");

    // Either half short of Tier 3 keeps same-workspace resume closed.
    for (const halfGraded of [
      { ...tier3, hosts: [{ ...tier3.hosts[0], grade: { tier: 2 } }] },
      {
        ...tier3,
        hosts: [
          { ...tier3.hosts[0], capabilities: { terminationProvenanceWithDescendantTeardown: { status: "unsupported" } } },
        ],
      },
    ]) {
      expect(
        await gradedDescendantTeardown({
          generationRoot: await generationWith(halfGraded),
          hostId: "claude-code",
          hostVersion: "9.9.9",
        }),
      ).toBe("unverified");
    }
  });

  it("resolves every doubt to UNVERIFIED — a missing, malformed, or ungraded record closes same-workspace resume", async () => {
    const cases: (string | Promise<string>)[] = [
      path.join(scratch, "no-such-generation"),
      generationWith({ hosts: "not an array" }),
      generationWith({}),
      generationWith({ hosts: [{ hostId: "claude-code", hostVersion: "9.9.9", grade: { tier: 3 } }] }),
    ];
    for (const candidate of cases) {
      const generationRoot = await candidate;
      expect(
        await gradedDescendantTeardown({ generationRoot, hostId: "claude-code", hostVersion: "9.9.9" }),
        generationRoot,
      ).toBe("unverified");
    }
    // A record that does not grade THIS version is not a grade for it.
    const root = await generationWith({
      hosts: [
        {
          hostId: "claude-code",
          hostVersion: "9.9.9",
          grade: { tier: 3 },
          capabilities: { terminationProvenanceWithDescendantTeardown: { status: "supported" } },
        },
      ],
    });
    expect(await gradedDescendantTeardown({ generationRoot: root, hostId: "claude-code", hostVersion: "2.1.97" })).toBe(
      "unverified",
    );
    expect(await gradedDescendantTeardown({ generationRoot: root, hostId: "codex-cli", hostVersion: "9.9.9" })).toBe(
      "unverified",
    );
  });

  it("fails closed on a corrupt record rather than throwing", async () => {
    const root = await mkdtemp(path.join(scratch, "graded-corrupt-"));
    mkdirSync(path.join(root, "qualifications"), { recursive: true });
    writeFileSync(path.join(root, "qualifications", "host-admission-capabilities.json"), "{ not json");
    expect(await gradedDescendantTeardown({ generationRoot: root, hostId: "claude-code", hostVersion: "2.1.97" })).toBe(
      "unverified",
    );
  });
});

describe("tearDownProjection, against the host's own workspace lifecycle", () => {
  it("preserves an operator excludes value it did not write", async () => {
    const bench = await workbench("teardown-operator-excludes");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-teardown-2",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);

    // An operator repoints the exclusion after materialization. Teardown must
    // not delete a value it did not write — the apply side refuses to clobber
    // one, and the teardown side must be symmetric.
    git(bench.worktreeDir, "config", "--worktree", "core.excludesFile", "/tmp/operator-owned-excludes");
    const torn = await tearDownProjection({ worktreeDir: bench.worktreeDir, bindingDir: bench.bindingDir, settingsPath: path.join(bench.bindingDir, "settings-1.json"), exec });
    expect(torn.ok, JSON.stringify(torn)).toBe(true);
    expect(git(bench.worktreeDir, "config", "--worktree", "--get", "core.excludesFile")).toBe(
      "/tmp/operator-owned-excludes",
    );
  });

  it("does not delete a repository-level excludes value that --worktree falls back to", async () => {
    const bench = await workbench("teardown-local-fallback");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-teardown-4",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);

    // `git config --worktree` falls back to the LOCAL scope when worktree
    // configuration is off, and a session can turn it off. Teardown must not
    // then delete the repository's own value.
    git(bench.worktreeDir, "config", "--local", "core.excludesFile", "/tmp/repository-owned-excludes");
    git(bench.worktreeDir, "config", "--unset", "extensions.worktreeConfig");

    const torn = await tearDownProjection({
      worktreeDir: bench.worktreeDir,
      bindingDir: bench.bindingDir,
      settingsPath: path.join(bench.bindingDir, "settings-1.json"),
      exec,
    });
    expect(torn.ok, JSON.stringify(torn)).toBe(true);
    expect(git(bench.worktreeDir, "config", "--local", "--get", "core.excludesFile")).toBe(
      "/tmp/repository-owned-excludes",
    );
  });

  it("succeeds when the host already removed the worktree — teardown never races workspace removal into a blocker", async () => {
    const bench = await workbench("teardown-worktree-gone");
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: "dlv-teardown-3",
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok).toBe(true);

    // The host owns workspace lifecycle and may remove the worktree first.
    git(bench.repoDir, "worktree", "remove", "--force", bench.worktreeDir);
    expect(existsSync(bench.worktreeDir)).toBe(false);

    const torn = await tearDownProjection({ worktreeDir: bench.worktreeDir, bindingDir: bench.bindingDir, settingsPath: path.join(bench.bindingDir, "settings-1.json"), exec });
    expect(torn.ok, JSON.stringify(torn)).toBe(true);
    expect(existsSync(path.join(bench.bindingDir, "settings-1.json"))).toBe(false);
    expect(existsSync(path.join(bench.bindingDir, "worktree-excludes"))).toBe(false);
  });
});

/**
 * THE TEMPORARY-DIRECTORY POSTURE, IN BOTH DIRECTIONS.
 *
 * Written RED. The workspace-scoping control the Tier 1 mutation floor rests
 * on does not extend to the system temporary directory: seatbelt grants that
 * directory as a writable root independently of the workspace, so a delivery
 * workspace materialized under it is scoped by NOTHING the host contributes.
 * What scopes it is the ambient-temp denial this binding composes itself —
 * which makes the exact spelling of that denial load-bearing rather than
 * cosmetic.
 *
 * On macOS the temporary directory reached through `$TMPDIR` and `/tmp` is a
 * symlink into `/private`, and the OS boundary matches on the resolved path.
 * A denial emitted only as `/var/folders/…` or `/tmp` therefore names a path
 * the kernel never checks, while an assertion that merely looks for "a tmpdir
 * entry" passes. That is the shape of the original false negative: a control
 * that reads as present and denies nothing.
 */
describe("composeClaudeCodeSession under the temporary directory", () => {
  const canonicalOf = (target: string): string => {
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };

  /**
   * Composition reads the excludes file the projection wrote, so every case
   * runs against a materialized binding directory. The workspace root is the
   * variable under test and is supplied separately: composition resolves and
   * denies paths, it does not read the workspace.
   */
  const materializedBindingDir = async (label: string): Promise<string> => {
    const bench = await workbench(`temp-posture-${label}`);
    const materialized = await materializeProjection({
      worktreeDir: bench.worktreeDir,
      generationRoot: bench.generationRoot,
      deliveryId: `dlv-temp-posture-${label}`,
      fence: 1,
      bindingDir: bench.bindingDir,
      exec,
    });
    expect(materialized.ok, JSON.stringify(materialized)).toBe(true);
    return bench.bindingDir;
  };

  const composeFor = async (input: { readonly bindingDir: string; readonly workspaceRoot: string }) => {
    const session = await composeClaudeCodeSession({
      bindingDir: input.bindingDir,
      statePath: path.join(input.bindingDir, "state.json"),
      hookCommand: ["node", "--import", "tsx", "hook-main.ts"],
      fence: 1,
      workspaceRoot: input.workspaceRoot,
      commonGitDir: path.join(input.workspaceRoot, ".git"),
      authorityDir: path.join(path.dirname(input.workspaceRoot), "provider-review-authority"),
      grant: {
        allowedCapabilities: ["Bash", "Read", "Write"],
        writablePaths: ["src"],
        protectedPaths: ["src/protected"],
      },
    });
    expect(session.ok, JSON.stringify(session)).toBe(true);
    if (!session.ok) throw new Error("composition failed");
    const settings = JSON.parse(readFileSync(session.settingsPath, "utf8")) as {
      permissions: { deny: string[] };
      sandbox: { filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] } };
    };
    // The host permission matcher is composed from the same roots as the OS
    // rules and is a second boundary, so it is surfaced here rather than left
    // as the half nothing observes.
    return { ...settings.sandbox.filesystem, permissionDeny: settings.permissions.deny };
  };

  it("denies the ambient temporary roots in the spelling the OS boundary actually matches", async () => {
    const bindingDir = await materializedBindingDir("deny");
    const workspaceRoot = path.dirname(bindingDir) + "/worktree";
    const filesystem = await composeFor({ bindingDir, workspaceRoot });

    // The false negative, pinned. Both the configured `$TMPDIR` and `/tmp`
    // must be denied under their resolved spelling too; a sibling scratch
    // directory reached by its real path is the write the original probe saw
    // succeed.
    for (const ambient of [tmpdir(), "/tmp"]) {
      expect(filesystem.denyWrite).toContain(path.resolve(ambient));
      expect(filesystem.denyWrite).toContain(canonicalOf(ambient));
    }

    // The workspace is itself temp-hosted here — the normal shape in this
    // system — so every root derived from it must carry the same treatment.
    // The spelling set is COMPUTED rather than counted: on a platform whose
    // temporary directory is a real directory the two spellings coincide and
    // there is exactly one, and a row that pinned the number would go red
    // against a correct product on the Linux leg of the matrix.
    const roots = [...new Set([path.resolve(workspaceRoot), canonicalOf(workspaceRoot)])];

    // Bounded from ABOVE as well as below: the granted root under each
    // spelling and nothing else, or the composed denial either swallows the
    // delivery's own writes or hands over the whole worktree.
    expect(new Set(filesystem.allowWrite)).toEqual(new Set(roots.map((root) => path.join(root, "src"))));

    // Protection is not weakened to buy that. The broad workspace denial is
    // what removes the host default and leaves the granted roots as the only
    // writable descendants, and the protected descendant is the narrow deny
    // above them; under one spelling each names a path the boundary never
    // checks.
    for (const root of roots) {
      expect(filesystem.denyWrite).toContain(root);
      expect(filesystem.denyWrite).toContain(path.join(root, "src", "protected"));
    }

    // `denyRead` carries ONLY the authority roots — no ambient-temp umbrella
    // sits above it — so leaving that side uncanonicalized would read-deny the
    // shared Git and installation authority under a path the OS boundary never
    // matches, and nothing else here would notice.
    for (const root of roots) {
      expect(filesystem.denyRead).toContain(path.join(root, ".git"));
      expect(filesystem.permissionDeny).toContain(`Read(${path.join(root, ".git")}/**)`);
      expect(filesystem.permissionDeny).toContain(`Edit(${path.join(root, ".git")}/**)`);
    }

    // The authority root does NOT exist when a first bind composes its
    // session — the installation writes that tree afterwards — so this is the
    // fallback path, and it must canonicalize through the nearest ancestor
    // that does resolve rather than settle for the written spelling.
    const authority = path.join(path.dirname(workspaceRoot), "provider-review-authority");
    expect(existsSync(authority)).toBe(false);
    for (const root of [...new Set([path.resolve(authority), path.join(canonicalOf(path.dirname(authority)), path.basename(authority))])]) {
      expect(filesystem.denyRead).toContain(root);
      expect(filesystem.permissionDeny).toContain(`Read(${root}/**)`);
    }
  });

  it("leaves a workspace outside the temporary directory exactly as it was", async () => {
    // The repository root is a real, unsymlinked path: resolved and canonical
    // spellings agree. A mechanism that widened every workspace would satisfy
    // the assertions above just as well as a correct one, so this direction is
    // what tells them apart.
    const outside = path.resolve(HERE, "..", "..", "..", "..");
    expect(canonicalOf(outside)).toBe(path.resolve(outside));
    const filesystem = await composeFor({ bindingDir: await materializedBindingDir("outside"), workspaceRoot: outside });

    expect(filesystem.allowWrite).toEqual([path.join(outside, "src")]);
    expect(filesystem.denyWrite).toContain(path.join(outside, "src", "protected"));
    expect(filesystem.denyWrite.filter((entry) => entry === path.join(outside, "src", "protected"))).toHaveLength(1);
    expect(filesystem.denyRead).toContain(path.join(outside, ".git"));
  });
});
