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
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CODEX_APPLIED_MISMATCH_CODES,
  CODEX_APP_SERVER_HOST_ID,
  CODEX_CHARACTERIZED_HOST_VERSION,
  CODEX_DISABLED_FEATURE_KEYS,
  CODEX_ESCALATION_REFUSAL_CODES,
  CODEX_HOOK_EVENT,
  CODEX_HOOK_EXECUTION_MODE,
  CODEX_HOOK_SUBCOMMAND,
  CODEX_HOST_TOOLS,
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
  type CodexPermissionProfile,
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

/**
 * Every spelling of a path that exists on this machine — derived here
 * INDEPENDENTLY of the product's own helper, so a mutation that collapses the
 * product's two-spelling walk to a single `path.resolve` is observed rather
 * than mirrored.
 */
const authoritySpellings = (target: string): readonly string[] => {
  const resolved = path.resolve(target);
  let ancestor = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      const canonical = path.join(realpathSync(ancestor), ...tail);
      return canonical === resolved ? [resolved] : [resolved, canonical];
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return [resolved];
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
};

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
    // CONTAINMENT, not basename. A basename test admits any path in the
    // filesystem whose last segment happens to be `src` — including `/src`.
    // EVERY SPELLING OF THE ONE PATH, and nothing else. On macOS the temp
    // workspace is reachable as both `/var/...` and `/private/var/...`; the
    // binding opens both because the host may resolve either, and a test
    // naming one of them would read a dropped spelling as agreement.
    expect([...writableRoots].sort()).toEqual(
      [...authoritySpellings(path.resolve(input.workspaceRoot, "src"))].sort(),
    );
    // CONTAINMENT, not basename. A basename test admits any path in the
    // filesystem whose last segment happens to be `src` — including `/src`.
    const workspaceSpellings = authoritySpellings(input.workspaceRoot);
    for (const root of writableRoots) {
      expect(
        workspaceSpellings.some((spelling) => root.startsWith(`${spelling}${path.sep}`)),
        root,
      ).toBe(true);
    }
    // The workspace root itself stays non-writable, so only the granted
    // descendants are reachable.
    expect(composed.profile.denyWriteRoots).toContain(path.resolve(input.workspaceRoot));
    // Read is the workspace and nothing wider, and carries no duplicate.
    expect(composed.profile.readRoots).toContain(path.resolve(input.workspaceRoot));
    expect(composed.profile.readRoots.length).toBe(new Set(composed.profile.readRoots).size);
  });

  it("denies the protected paths, the shared Git authority, and the installation authority", async () => {
    const { input, composed } = await compose("denied");
    for (const protectedPath of input.grant.protectedPaths) {
      expect(composed.profile.denyWriteRoots).toContain(path.resolve(input.workspaceRoot, protectedPath));
    }
    // BOTH spellings for each authority root, not just the resolved one. The
    // unresolved spelling is the one the module's own comment says "names a
    // path the kernel never checks", so a deny that carries only one spelling
    // denies nothing on a machine where the two differ.
    for (const root of [input.commonGitDir, input.authorityDir]) {
      for (const spelling of authoritySpellings(root)) {
        expect(composed.profile.denyWriteRoots, `write ${spelling}`).toContain(spelling);
        // Reading the authority is denied too: the capability state is not the
        // model's to inspect.
        expect(composed.profile.denyReadRoots, `read ${spelling}`).toContain(spelling);
      }
    }
  });

  it("denies ambient temp under BOTH spellings, so the deny names the path the kernel checks", async () => {
    const { composed } = await compose("temp");
    for (const spelling of ["/tmp", "/private/tmp"]) {
      expect(composed.profile.denyWriteRoots.some((root) => root === spelling)).toBe(true);
    }
    // Ambient `$TMPDIR` is a SECOND contributor, and on macOS it is a per-user
    // path under `/var/folders` rather than `/tmp` — so the `/tmp` rows above
    // say nothing about it and it could be deleted outright unobserved.
    for (const spelling of authoritySpellings(tmpdir())) {
      expect(composed.profile.denyWriteRoots, `TMPDIR ${spelling}`).toContain(spelling);
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
    // And two concurrent deliveries in two WORKSPACES at the same fence get
    // two names. That is the collision the workspace digest exists to prevent,
    // and varying only the fence cannot observe it.
    const elsewhere = codexPermissionProfileOf({
      ...base,
      workspaceRoot: `${input.workspaceRoot}-other`,
      fence: 1,
    });
    expect(elsewhere.id).not.toBe(first.id);
  });

  it("keeps the deny posture at the TYPE level, not merely at the value level", async () => {
    const { composed } = await compose("literal-types");
    // These five are literal types doing policy work: they are what make a
    // future `networkAccess: true` a compile error rather than a review
    // question. Widening any of them to `boolean`/`string` leaves every value
    // assertion in this file green, so the falsification has to be the
    // compiler's — under the widening mutation these directives become unused
    // and `npm run typecheck` fails.
    // @ts-expect-error network access is not a widenable member of this profile
    const widened: CodexPermissionProfile = { ...composed.profile, networkAccess: true };
    // @ts-expect-error ambient /tmp exclusion is not widenable
    const slashTmp: CodexPermissionProfile = { ...composed.profile, excludeSlashTmp: false };
    // @ts-expect-error ambient $TMPDIR exclusion is not widenable
    const tmpdirEnv: CodexPermissionProfile = { ...composed.profile, excludeTmpdirEnvVar: false };
    // @ts-expect-error the sandbox mode is not a free string
    const sandbox: CodexPermissionProfile = { ...composed.profile, sandboxMode: "danger-full-access" };
    // @ts-expect-error the thread-start request is ephemeral by type
    const ephemeral: ComposeCodexAppServerThreadResult["request"]["params"] = { ...composed.request.params, ephemeral: false };
    expect([widened, slashTmp, tmpdirEnv, sandbox, ephemeral].length).toBe(5);
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

  it("emits the permissions block the host actually reads, under the host's own key spellings", async () => {
    const { input, composed } = await compose("permissions");
    // THE DOCUMENT THE HOST READS. Every other assertion in this file reads
    // `composed.profile` — the in-memory object — and the applied-configuration
    // verifier compares the host's report against that same object, so both
    // sides of the central claim can agree with each other while these bytes
    // go unobserved. `toEqual` on the sub-objects rather than member reads is
    // what makes a corrupted KEY SPELLING fail: a host reading
    // `exclude_slash_tmp` finds nothing when the binding wrote
    // `excludeSlashTmp`, and applies its own default.
    expect(config(composed)["permission_profile"]).toBe(composed.profile.id);
    const permissions = config(composed)["permissions"][composed.profile.id];
    expect(permissions.sandbox_mode).toBe("workspace-write");
    expect(permissions.sandbox_workspace_write).toEqual({
      writable_roots: composed.profile.writableRoots,
      network_access: false,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    });
    // Exactly the four members the host's published `SandboxWorkspaceWrite`
    // carries, and no fifth: a deny smuggled in here would be a deny under a
    // key the schema does not have.
    expect(Object.keys(permissions.sandbox_workspace_write).sort()).toEqual([
      "exclude_slash_tmp",
      "exclude_tmpdir_env_var",
      "network_access",
      "writable_roots",
    ]);
    expect(permissions.filesystem).toEqual({
      read: composed.profile.readRoots,
      deny_read: composed.profile.denyReadRoots,
      deny_write: composed.profile.denyWriteRoots,
    });
    // The emitted writable set is the grant's, not the workspace.
    expect([...permissions.sandbox_workspace_write.writable_roots].sort()).toEqual(
      [...authoritySpellings(path.resolve(input.workspaceRoot, "src"))].sort(),
    );
    expect(permissions.filesystem.deny_write).toContain(path.resolve(input.workspaceRoot));
  });

  it("wires a SYNCHRONOUS pre_tool_use hook carrying this session's own fence", async () => {
    const { input, composed } = await compose("hook");
    const entry = config(composed)["hooks"][CODEX_HOOK_EVENT][0].hooks[0];
    expect(entry.type).toBe("command");
    expect(entry.execution_mode).toBe(CODEX_HOOK_EXECUTION_MODE);
    expect(entry.execution_mode).toBe("sync");
    expect(entry.command).toContain(JSON.stringify(input.statePath));
    expect(entry.command).toContain(JSON.stringify(String(FENCE)));
    expect(entry.command).toContain(JSON.stringify(CODEX_HOOK_SUBCOMMAND));
  });

  it("pins the host-facing hook spellings as literals, not as self-referential constants", () => {
    // Every other assertion about the hook reads these constants on BOTH
    // sides, so renaming `pre_tool_use` to anything at all keeps this file
    // green while the host silently stops calling us: the host matches the
    // event by ITS name, not by ours. These three rows are the only place the
    // wire spellings are stated independently.
    expect(CODEX_HOOK_EVENT).toBe("pre_tool_use");
    expect(CODEX_HOOK_EXECUTION_MODE).toBe("sync");
    expect(CODEX_HOOK_SUBCOMMAND).toBe("codex-pre-tool-use");
  });

  it("enables only the grant's capabilities and switches off every unadjudicable surface", async () => {
    const { composed } = await compose("tools");
    // THE HOST'S OWN TOOL NAMES, not our capability names. `enabled_tools` is
    // read by Codex, which has never heard of "Read" or "Write"; a list in our
    // vocabulary enables NOTHING and is silently ignored, which reads as a
    // tight allow-list while actually leaving the host's default set in place.
    expect(config(composed)["tools"].enabled_tools).toEqual(["apply_patch", "update_plan", "view_image"]);
    expect(config(composed)["tools"].enabled_tools).not.toContain("shell");
    for (const enabled of config(composed)["tools"].enabled_tools as string[]) {
      const tool = CODEX_HOST_TOOLS.find((entry) => entry.hostName === enabled);
      expect(tool, enabled).toBeDefined();
      expect(["Read", "Write"], enabled).toContain(tool!.capability);
    }
    for (const key of CODEX_DISABLED_FEATURE_KEYS) {
      expect(config(composed)["features"][key] ?? config(composed)["tools"][key], key).toBe(false);
    }
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

  it("compares the writable set by MEMBERSHIP, not by size, and ignores mere ordering", async () => {
    const { composed } = await compose("writable-set");
    const faithful = faithfullyAppliedCodexConfiguration(composed);
    // SAME CARDINALITY, DIFFERENT ROOT. The only writable-roots divergence
    // asserted elsewhere in this file APPENDS a root, so a comparison that
    // checked lengths — or checked only that ours are a subset of theirs —
    // would be green there while a host that swapped `src` for `/etc` sailed
    // through.
    const swapped = verifyAppliedCodexThreadConfiguration(composed, {
      ...faithful,
      writableRoots: (faithful.writableRoots as string[]).map(() => "/etc"),
    });
    expect(swapped.verified).toBe(false);
    if (!swapped.verified) {
      expect(swapped.mismatches.map((mismatch) => mismatch.code)).toContain("writable_roots_mismatch");
    }
    // ORDER IS NOT A DIVERGENCE. A host that applies the same roots in another
    // order applied the same configuration, and failing it here would teach a
    // later delivery to sort the host's answer into agreement.
    expect(
      verifyAppliedCodexThreadConfiguration(composed, {
        ...faithful,
        deniedWriteRoots: [...(faithful.deniedWriteRoots as string[])].reverse(),
      }).verified,
    ).toBe(true);
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
    // ONE SPELLING IS NOT THE CLAIM. The refusal is supposed to hold however
    // the host spells the request kind, and a tokenizer that only splits on
    // `-` passes a hyphenated probe while letting `enableMcpTool` straight
    // through. The CODE is asserted too: a refusal under the wrong code is a
    // refusal the escalation ledger cannot account for.
    for (const source of CODEX_UNENFORCEABLE_TOOL_SOURCES) {
      const Source = `${source[0]!.toUpperCase()}${source.slice(1)}`;
      const spellings = [
        `${source}-tool-approve`,
        `${source}_tool_approve`,
        `enable${Source}Tool`,
        `${source}Tool.approve`,
        `${source}s-approve`,
      ];
      for (const kind of spellings) {
        expect(evaluateCodexEscalation({ kind, oneShot: true }, profile), kind).toMatchObject({
          refused: true,
          code: "unenforceable_tool_source_refused",
        });
      }
    }
    // The features this binding switches off are the same surface seen from
    // the other side: re-enabling one by escalation is the same widening.
    for (const key of CODEX_DISABLED_FEATURE_KEYS) {
      expect(evaluateCodexEscalation({ kind: `enable_${key}`, oneShot: true }, profile), key).toMatchObject({
        refused: true,
        code: "unenforceable_tool_source_refused",
      });
    }
  });

  it("does not read an ordinary approval as an unadjudicable surface merely for containing a tool word", async () => {
    const { composed } = await compose("escalation-negative");
    // The bound on the rule above. Without this row, `refused: true` for every
    // kind — a mutation that ignores the kind entirely — passes every
    // assertion in this describe block.
    expect(evaluateCodexEscalation({ kind: "toolApprove", oneShot: true }, composed.profile)).toEqual({
      refused: false,
    });
    expect(evaluateCodexEscalation({ kind: "apply_patch_approve", oneShot: true }, composed.profile)).toEqual({
      refused: false,
    });
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
