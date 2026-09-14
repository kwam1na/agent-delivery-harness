/**
 * THE CODEX APP-SERVER BINDING'S V-SLICE.
 *
 * What the characterization established is pinned here so a later edit cannot
 * quietly relax it: the per-fence named permission profile carries exactly the
 * grant's writable set and nothing wider, ambient `$TMPDIR` and `/tmp` are
 * denied under both spellings, command network access is off, the
 * `pre_tool_use` hook is SYNCHRONOUS and carries this session's own fence, and
 * every tool surface the synchronous local hook cannot adjudicate is switched
 * off.
 *
 * The applied-configuration check is the gate in front of the attestation, so
 * its deny direction is exercised member by member: each single divergence
 * from what was composed must be reported, because a host that applied
 * something else is enforcing something else.
 *
 * Nothing here launches Codex, opens a thread, or makes a network call.
 *
 * Written RED before `codex-app-server.ts` existed.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CODEX_APPLIED_MISMATCH_CODES,
  CODEX_APP_SERVER_HOST_ID,
  CODEX_CHARACTERIZED_HOST_VERSION,
  CODEX_ESCALATION_REFUSAL_CODES,
  CODEX_HOOK_EVENT,
  CODEX_HOOK_EXECUTION_MODE,
  CODEX_PINNED_HOST_VERSION,
  CODEX_THREAD_CONFIG_FILE,
  CODEX_UNENFORCEABLE_TOOL_SOURCES,
  codexAppServerBinding,
  codexPermissionProfileOf,
  codexSubagentPosture,
  composeCodexAppServerThread,
  evaluateCodexEscalation,
  verifyAppliedCodexThreadConfiguration,
  type CodexAppliedThreadConfiguration,
  type ComposeCodexAppServerThreadResult,
} from "./codex-app-server.ts";
import { faithfullyAppliedCodexConfiguration } from "./codex-app-server-conformance.ts";
import type { ComposeHostSessionInput } from "./managed-host-binding.ts";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "codex-binding-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

const FENCE = 9;

async function composeInput(name: string): Promise<ComposeHostSessionInput> {
  const base = await mkdtemp(path.join(scratch, `${name}-`));
  return {
    bindingDir: path.join(base, "binding"),
    statePath: path.join(base, "binding", `state-${FENCE}.json`),
    hookCommand: ["node", "--experimental-strip-types", path.join(base, "codex-hook-main.ts")],
    fence: FENCE,
    workspaceRoot: path.join(base, "worktree"),
    commonGitDir: path.join(base, "repo", ".git"),
    authorityDir: path.join(base, "authority"),
    grant: {
      allowedCapabilities: ["Read", "Write"],
      writablePaths: ["src"],
      protectedPaths: [".git", ".managed-projection"],
    },
  };
}

const compose = async (name: string): Promise<{
  readonly input: ComposeHostSessionInput;
  readonly composed: ComposeCodexAppServerThreadResult;
}> => {
  const input = await composeInput(name);
  return { input, composed: await composeCodexAppServerThread(input) };
};

const config = (composed: ComposeCodexAppServerThreadResult): Record<string, any> =>
  composed.request.params.config as Record<string, any>;

describe("what the binding claims about host versions", () => {
  it("separates the version characterized from the version pinned, and claims nothing about the latter", () => {
    expect(CODEX_CHARACTERIZED_HOST_VERSION).toBe("0.147.0");
    expect(CODEX_PINNED_HOST_VERSION).toBe("0.151");
    expect(CODEX_CHARACTERIZED_HOST_VERSION).not.toBe(CODEX_PINNED_HOST_VERSION);
    // The graded capability record's own key for this host, so the grade
    // lookup cannot miss a grading through a second spelling.
    expect(CODEX_APP_SERVER_HOST_ID).toBe("codex-cli");
  });

  it("removes the subagent capability rather than compensating for unproved inheritance", () => {
    expect(codexSubagentPosture().capability).toBe("removed");
    expect(codexSubagentPosture().reason.length).toBeGreaterThan(0);
  });
});

describe("the per-fence permission profile", () => {
  it("opens write for exactly the grant's writable paths and nothing wider", async () => {
    const { input, composed } = await compose("profile");
    const writableRoots = composed.profile.writableRoots;
    expect(writableRoots.length).toBeGreaterThan(0);
    for (const root of writableRoots) expect(path.basename(root)).toBe("src");
    // The workspace root itself stays non-writable, so only the granted
    // descendants are reachable.
    expect(composed.profile.denyWriteRoots).toContain(path.resolve(input.workspaceRoot));
  });

  it("denies the protected paths, the shared Git authority, and the installation authority", async () => {
    const { input, composed } = await compose("denied");
    for (const protectedPath of input.grant.protectedPaths) {
      expect(composed.profile.denyWriteRoots).toContain(path.resolve(input.workspaceRoot, protectedPath));
    }
    expect(composed.profile.denyWriteRoots).toContain(path.resolve(input.commonGitDir));
    expect(composed.profile.denyWriteRoots).toContain(path.resolve(input.authorityDir));
    // Reading the authority is denied too: the capability state is not the
    // model's to inspect.
    expect(composed.profile.denyReadRoots).toContain(path.resolve(input.commonGitDir));
    expect(composed.profile.denyReadRoots).toContain(path.resolve(input.authorityDir));
  });

  it("denies ambient temp under BOTH spellings, so the deny names the path the kernel checks", async () => {
    const { composed } = await compose("temp");
    for (const spelling of ["/tmp", "/private/tmp"]) {
      expect(composed.profile.denyWriteRoots.some((root) => root === spelling)).toBe(true);
    }
    expect(composed.profile.excludeTmpdirEnvVar).toBe(true);
    expect(composed.profile.excludeSlashTmp).toBe(true);
    expect(composed.profile.networkAccess).toBe(false);
  });

  it("gives two concurrent fences two profile names, so a rebind cannot overwrite a running admission", async () => {
    const input = await composeInput("fences");
    const base = { ...input, grant: input.grant };
    const first = codexPermissionProfileOf({ ...base, fence: 1 });
    const second = codexPermissionProfileOf({ ...base, fence: 2 });
    expect(first.id).not.toBe(second.id);
    // Nothing host-visible carries a delivery identifier.
    expect(first.id).toMatch(/^managed-delivery-[0-9a-f]{12}-1$/);
  });
});

describe("the composed thread-start request", () => {
  it("is ephemeral and per-session, so shared configuration is never mutated", async () => {
    const { input, composed } = await compose("request");
    expect(composed.request.method).toBe("thread/start");
    expect(composed.request.params.ephemeral).toBe(true);
    expect(composed.request.params.cwd).toBe(path.resolve(input.workspaceRoot));
    expect(composed.request.params.sandbox).toBe("workspace-write");
  });

  it("wires a SYNCHRONOUS pre_tool_use hook carrying this session's own fence", async () => {
    const { input, composed } = await compose("hook");
    const entry = config(composed)["hooks"][CODEX_HOOK_EVENT][0].hooks[0];
    expect(entry.type).toBe("command");
    expect(entry.execution_mode).toBe(CODEX_HOOK_EXECUTION_MODE);
    expect(entry.execution_mode).toBe("sync");
    expect(entry.command).toContain(JSON.stringify(input.statePath));
    expect(entry.command).toContain(JSON.stringify(String(FENCE)));
    expect(entry.command).toContain(JSON.stringify("pre-tool-use"));
  });

  it("enables only the grant's capabilities and switches off every unadjudicable surface", async () => {
    const { composed } = await compose("tools");
    expect(config(composed)["tools"].enabled_tools).toEqual(["Read", "Write"]);
    expect(config(composed)["tools"].web_search).toBe(false);
    expect(config(composed)["mcp_servers"]).toEqual({});
    expect(config(composed)["features"]).toEqual({ apps: false, tool_registry: false, multi_agent_v2: false });
  });

  it("writes exactly one owner-only file, at the fence-scoped path the seam names", async () => {
    const { input, composed } = await compose("bytes");
    expect(composed.threadConfigPath).toBe(path.join(input.bindingDir, CODEX_THREAD_CONFIG_FILE(FENCE)));
    expect(composed.threadConfigPath).toBe(
      codexAppServerBinding.admissionConfigurationPath(input.bindingDir, FENCE),
    );
    expect(statSync(composed.threadConfigPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(composed.threadConfigPath, "utf8"))).toEqual(
      JSON.parse(JSON.stringify(composed.request)),
    );
  });

  it("hands the operator data, never a launch", async () => {
    const input = await composeInput("data");
    const result = await codexAppServerBinding.composeSession(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hostAdmissionArguments).toEqual(["thread/start", result.admissionConfigurationPath]);
  });
});

describe("verifying what the host reported it applied", () => {
  it("verifies a faithful application", async () => {
    const { composed } = await compose("faithful");
    expect(verifyAppliedCodexThreadConfiguration(composed, faithfullyAppliedCodexConfiguration(composed))).toEqual({
      verified: true,
    });
  });

  it("reports every divergence in one pass rather than only the first", async () => {
    const { composed } = await compose("all-mismatches");
    const result = verifyAppliedCodexThreadConfiguration(composed, {});
    expect(result.verified).toBe(false);
    if (result.verified) return;
    expect([...result.mismatches.map((mismatch) => mismatch.code)].sort()).toEqual(
      [...CODEX_APPLIED_MISMATCH_CODES].sort(),
    );
    for (const mismatch of result.mismatches) expect(mismatch.message.length).toBeGreaterThan(0);
  });

  it("denies each single divergence with its own code", async () => {
    const { composed } = await compose("single-mismatch");
    const faithful = faithfullyAppliedCodexConfiguration(composed);
    const cases: readonly (readonly [string, CodexAppliedThreadConfiguration])[] = [
      ["permission_profile_mismatch", { ...faithful, permissionProfileId: "someone-elses-profile" }],
      ["sandbox_mode_mismatch", { ...faithful, sandboxMode: "danger-full-access" }],
      ["writable_roots_mismatch", { ...faithful, writableRoots: [...faithful.writableRoots as string[], "/etc"] }],
      ["network_access_enabled", { ...faithful, networkAccess: true }],
      ["ambient_temp_not_excluded", { ...faithful, excludeSlashTmp: false }],
      ["ambient_temp_not_excluded", { ...faithful, excludeTmpdirEnvVar: false }],
      ["hook_missing", { ...faithful, hookEvent: "post_tool_use" }],
      ["hook_command_mismatch", { ...faithful, hookCommand: "true" }],
      ["hook_not_synchronous", { ...faithful, hookExecutionMode: "async" }],
      ["unenforceable_tool_surface_enabled", { ...faithful, enabledUnenforceableToolSources: ["mcp"] }],
      ["configuration_digest_mismatch", { ...faithful, configurationDigest: "c".repeat(64) }],
    ];
    for (const [code, applied] of cases) {
      const result = verifyAppliedCodexThreadConfiguration(composed, applied);
      expect(result.verified, code).toBe(false);
      if (result.verified) continue;
      expect(result.mismatches.map((mismatch) => mismatch.code), code).toContain(code);
    }
  });

  it("refuses an applied configuration that reports nothing, rather than reading silence as agreement", async () => {
    const { composed } = await compose("silent");
    for (const applied of [{}, { permissionProfileId: undefined }, { writableRoots: "src" }]) {
      expect(verifyAppliedCodexThreadConfiguration(composed, applied as CodexAppliedThreadConfiguration).verified).toBe(
        false,
      );
    }
  });

  it("does not accept one session's faithful application as another's", async () => {
    const first = await compose("session-a");
    const second = await compose("session-b");
    const result = verifyAppliedCodexThreadConfiguration(first.composed, faithfullyAppliedCodexConfiguration(second.composed));
    expect(result.verified).toBe(false);
  });
});

describe("escalation", () => {
  it("names its refusal codes as a closed set", () => {
    expect([...CODEX_ESCALATION_REFUSAL_CODES]).toEqual([
      "session_wide_permission_widening_refused",
      "exec_policy_amendment_refused",
      "extra_writable_root_refused",
      "unenforceable_tool_source_refused",
    ]);
  });

  it("refuses session-wide widening, exec-policy amendment, an extra writable root, and an unadjudicable surface", async () => {
    const { composed } = await compose("escalation");
    const profile = composed.profile;
    expect(evaluateCodexEscalation({ kind: "acceptForSession", oneShot: false }, profile)).toMatchObject({
      refused: true,
      code: "session_wide_permission_widening_refused",
    });
    expect(evaluateCodexEscalation({ kind: "approve", oneShot: false }, profile)).toMatchObject({
      refused: true,
      code: "session_wide_permission_widening_refused",
    });
    expect(evaluateCodexEscalation({ kind: "exec_policy_amend", oneShot: true }, profile)).toMatchObject({
      refused: true,
      code: "exec_policy_amendment_refused",
    });
    expect(
      evaluateCodexEscalation({ kind: "approve", oneShot: true, writableRoots: ["/etc"] }, profile),
    ).toMatchObject({ refused: true, code: "extra_writable_root_refused" });
    for (const source of CODEX_UNENFORCEABLE_TOOL_SOURCES) {
      expect(evaluateCodexEscalation({ kind: `${source}-tool-approve`, oneShot: true }, profile), source).toMatchObject({
        refused: true,
      });
    }
  });

  it("leaves an ordinary one-shot approval inside the attested profile host-native", async () => {
    const { composed } = await compose("one-shot");
    expect(
      evaluateCodexEscalation(
        { kind: "approve", oneShot: true, writableRoots: [composed.profile.writableRoots[0]!] },
        composed.profile,
      ),
    ).toEqual({ refused: false });
  });
});
