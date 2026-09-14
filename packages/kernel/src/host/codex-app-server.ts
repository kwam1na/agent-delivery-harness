/**
 * THE CODEX APP-SERVER DELIVERY BINDING.
 *
 * A host BINDING, not a second orchestrator. Codex owns the app-server
 * transport, threads, turns, workspaces, subagents, the approvals UI,
 * interruption and cancellation; this module composes data and hands it over.
 * Nothing here launches Codex, opens a thread, creates a worktree, or holds a
 * credential, and there is no fallback to the Responses API, an SDK, MCP, or a
 * direct API call — this file makes no network call at all.
 *
 * WHAT WAS ACTUALLY CHARACTERIZED, and against which version. The installed
 * host this binding was characterized against is codex-cli
 * `CODEX_CHARACTERIZED_HOST_VERSION`, probed model-free through its own
 * `app-server generate-json-schema` surface and a read-only inventory of the
 * installed binary — no thread, no turn, no model. It established four things
 * this file is built on:
 *
 *   - `thread/start` carries a free-form `config` applied as a distinct
 *     per-session configuration layer, so the admission below never touches
 *     shared user, project, or managed configuration;
 *   - named permission profiles exist, with the filesystem tokens this file's
 *     profile is spelled in; the app-server schema's `SandboxWorkspaceWrite`
 *     carries EXACTLY `writable_roots`, `network_access`,
 *     `exclude_tmpdir_env_var` and `exclude_slash_tmp` — no deny member — and
 *     the config-layer profile struct carries a `filesystem` block whose
 *     `deny_read` member was observed in the installed binary's inventory.
 *     `filesystem.read` and `filesystem.deny_write` were NOT observed in
 *     either surface; see the WRITE BOUNDARY note on the composed config
 *     below and `knownLimitations` in the qualification record;
 *   - the `pre_tool_use` hook runs with execution mode `sync`, which is what
 *     makes it an interceptor rather than a notification; and
 *   - the PreToolUse decision wire is DENY-ONLY (see
 *     `./codex-app-server-hook.ts`).
 *
 * `CODEX_PINNED_HOST_VERSION` is the version the tracked item pins and is NOT
 * the version characterized here. No claim in this file, and none in
 * `qualifications/codex-app-server-integration.json`, is made about it: a
 * version that was never observed is recorded as uncharacterized rather than
 * assumed to behave like the one that was.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { compareUtf16CodeUnits } from "../canonical.ts";
import { digestCanonical, sha256Hex } from "../digest.ts";
import type {
  ComposeHostSessionInput,
  ComposeHostSessionResult,
  ManagedHostBinding,
} from "./managed-host-binding.ts";

/**
 * The key into the graded capability record for this binding — the RECORD'S
 * OWN spelling, `codex-cli`, not a name invented here. The grade lookup matches
 * on host id and exact host version, so a binding that introduced a second
 * spelling of the same host would silently miss its own grading forever: today
 * that reads as `unverified`, which is coincidentally the honest answer, and
 * tomorrow it would read as `unverified` even after the host was graded higher.
 * One host, one key.
 */
export const CODEX_APP_SERVER_HOST_ID = "codex-cli";

/** The version the tracked item pins. Not installed here; never claimed. */
export const CODEX_PINNED_HOST_VERSION = "0.151";

/** The installed version the binding was actually characterized against. */
export const CODEX_CHARACTERIZED_HOST_VERSION = "0.147.0";

/** The host's own spelling of the synchronous pre-invocation hook event. */
export const CODEX_HOOK_EVENT = "pre_tool_use";

/**
 * `sync` is the whole point. An `async` hook is a notification the turn does
 * not wait for, which would make the interceptor advisory — a deny-until-
 * attested boundary that the tool call outruns. Composition writes `sync` and
 * verification below refuses anything else.
 */
export const CODEX_HOOK_EXECUTION_MODE = "sync";

export const CODEX_THREAD_CONFIG_FILE = (fence: number): string => `codex-thread-${fence}.json`;

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

/**
 * The per-fence profile name. Per-fence rather than per-delivery for the same
 * reason the Claude binding's settings file is per-fence: a takeover rebind
 * must not overwrite a superseded-but-still-running session's admission in
 * place. The workspace digest keeps two concurrent deliveries from colliding
 * on one name without putting a delivery identifier into a host-visible
 * string.
 */
export const codexPermissionProfileId = (workspaceRoot: string, fence: number): string =>
  `managed-delivery-${sha256Hex(path.resolve(workspaceRoot)).slice(0, 12)}-${fence}`;

/**
 * The tool classes the synchronous local hook can actually adjudicate: a
 * capability whose invocation the hook sees, with operands it can read. A
 * hosted, app/MCP-served, dynamic, or otherwise unclassified tool is NOT one
 * of them — its call may be adjudicated somewhere this hook does not run — so
 * composition disables those surfaces and the hook denies anything that
 * arrives from them anyway. Both halves are required: disabling alone would
 * leave the boundary resting on configuration the binding cannot re-verify per
 * invocation. The second half runs through `CODEX_HOOK_SUBCOMMAND` below,
 * which is the subcommand composition actually bakes into the hook command.
 */
export const CODEX_UNENFORCEABLE_TOOL_SOURCES = Object.freeze(["mcp", "app", "hosted", "dynamic", "plugin"] as const);
export type CodexUnenforceableToolSource = (typeof CODEX_UNENFORCEABLE_TOOL_SOURCES)[number];

/**
 * The surfaces composition switches off that have NO member in
 * `CODEX_UNENFORCEABLE_TOOL_SOURCES` — spelled from the composed config's own
 * feature keys. Without these, an escalation into `tool_registry`,
 * `multi_agent_v2` or `web_search` is not refused, and the operator can re-open
 * by approval exactly what the composition closed by configuration. Kept
 * separate from the list above so the hook's tool-NAME predicate is unaffected:
 * these are feature switches, not tool sources.
 */
export const CODEX_DISABLED_FEATURE_KEYS = Object.freeze(["tool_registry", "multi_agent_v2", "web_search"] as const);
export type CodexDisabledFeatureKey = (typeof CODEX_DISABLED_FEATURE_KEYS)[number];

/**
 * THE TOOL VOCABULARY IS THE HOST'S, AND IT IS TRANSLATED ONCE, HERE.
 *
 * The shared decision procedure in `./hook-main.ts` reads a tool name two
 * ways: as the capability, matched by exact string equality against the
 * grant's `allowedCapabilities`; and as the key into its write-path member
 * table. Both of those are spelled in the KERNEL's vocabulary. Codex's tools
 * are spelled in Codex's. Handing one to the other unchanged has two failure
 * modes and no success mode: either every real Codex tool is denied as an
 * ungranted capability, or a granted Codex name reaches the decision, matches
 * no write-path member, and is adjudicated as writing nothing — which is
 * exactly the "absent operands read as `writes nothing`" failure the hook's
 * pre-check exists to prevent.
 *
 * So this is a CLOSED map from the tool names actually observed in the
 * installed host's inventory onto the neutral capability and where that tool
 * names the paths it writes. A name not in the map is denied: an unmapped tool
 * is a tool whose operands this binding cannot read.
 *
 * `writes` is load-bearing. For a `paths` tool the hook must be able to
 * enumerate the paths; if it cannot, it denies rather than proceeding with an
 * empty write set. For a `none` tool there is nothing to enumerate and the
 * sandbox's own `writable_roots` is the containment.
 */
export interface CodexHostTool {
  /** The host's own tool name, as observed in the installed binary. */
  readonly hostName: string;
  /** The neutral capability the grant is spelled in. */
  readonly capability: string;
  readonly writes: "none" | "paths";
  /** The `tool_input` members that name written paths, for a `paths` tool. */
  readonly writePathMembers: readonly string[];
}

export const CODEX_HOST_TOOLS: readonly CodexHostTool[] = Object.freeze([
  // The patch tool. `fileChanges` is a map keyed by path in the host's own
  // apply-patch approval schema; `file_path` and `path` are accepted beside it
  // because the pre-invocation hook's input shape was NOT characterized and a
  // deny-on-unreadable-operands tool must still read the spellings it can.
  Object.freeze({
    hostName: "apply_patch",
    capability: "Write",
    writes: "paths",
    writePathMembers: Object.freeze(["fileChanges", "file_path", "path"]),
  }),
  Object.freeze({ hostName: "shell", capability: "Bash", writes: "none", writePathMembers: Object.freeze([]) }),
  Object.freeze({ hostName: "exec_command", capability: "Bash", writes: "none", writePathMembers: Object.freeze([]) }),
  Object.freeze({ hostName: "unified_exec", capability: "Bash", writes: "none", writePathMembers: Object.freeze([]) }),
  Object.freeze({ hostName: "write_stdin", capability: "Bash", writes: "none", writePathMembers: Object.freeze([]) }),
  Object.freeze({ hostName: "view_image", capability: "Read", writes: "none", writePathMembers: Object.freeze([]) }),
  // Touches no filesystem and runs no command: admitted at the read tier.
  Object.freeze({ hostName: "update_plan", capability: "Read", writes: "none", writePathMembers: Object.freeze([]) }),
] as const);

export const codexHostTool = (hostName: string): CodexHostTool | undefined =>
  CODEX_HOST_TOOLS.find((entry) => entry.hostName === hostName);

/**
 * The host tools this grant actually reaches — the host's OWN names, not the
 * kernel's. Composing `enabled_tools` from `allowedCapabilities` verbatim would
 * name tools the characterized host does not have, which enables nothing and
 * hides the vocabulary mismatch behind a plausible-looking list.
 */
export const codexEnabledToolsFor = (allowedCapabilities: readonly string[]): readonly string[] =>
  CODEX_HOST_TOOLS.filter((entry) => allowedCapabilities.includes(entry.capability))
    .map((entry) => entry.hostName)
    .sort(compareUtf16CodeUnits);

/**
 * The escalation kind split into whole words across every spelling the host's
 * approvals surface uses — `snake_case`, `kebab-case`, `camelCase` and the
 * acronym form `MCPServerAdd`, which the plain camel rule alone cannot split
 * because `MCP` is an initialism and is normally written uppercase.
 *
 * Whole words rather than substrings, because the source names are short and
 * ordinary: a bare substring test reads "approve" as the "app" surface and
 * refuses every one-shot approval, which does not tighten the boundary — it
 * deletes the host-native approval lane the binding deliberately keeps.
 */
export const codexEscalationTokens = (kind: string): readonly string[] =>
  kind
    // `MCPServer` → `MCP Server`: an acronym run followed by a capitalised word.
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());

/**
 * True when the kind names one of the surfaces this binding disabled. Matched
 * by stem so the host's own plural spelling — the composed config's key for
 * that surface is `features.apps` — is not a hole, and the feature keys are
 * matched against the underscore-joined token run so a multi-word key such as
 * `multi_agent_v2` is seen however it was spelled.
 */
export const codexNamesDisabledSurface = (kind: string): boolean => {
  const tokens = codexEscalationTokens(kind);
  const joined = tokens.join("_");
  return (
    tokens.some((token) =>
      (CODEX_UNENFORCEABLE_TOOL_SOURCES as readonly string[]).some(
        (source) => token === source || token === `${source}s`,
      ),
    ) || CODEX_DISABLED_FEATURE_KEYS.some((key) => joined.includes(key))
  );
};

/**
 * Subagent posture. Exact profile, hook, and fence inheritance into a Codex
 * subagent was NOT proved by the characterization — the probed surface reports
 * `subagentStart`/`subagentStop` events but says nothing about whether the
 * per-thread permission profile and the synchronous hook are carried into a
 * child. The rule for an unproved inheritance is monotone removal, never
 * compensation: the binding does not supervise, launch, or wrap agents.
 */
export const codexSubagentPosture = (): { readonly capability: "removed"; readonly reason: string } => ({
  capability: "removed",
  reason:
    "exact permission-profile, hook, and fence inheritance into a Codex subagent is unproved; the capability is removed rather than supervised",
});

export interface CodexPermissionProfile {
  readonly id: string;
  readonly sandboxMode: "workspace-write";
  /**
   * The composed read allow-list — the workspace and nothing wider. Emitted as
   * the UNCHARACTERIZED `filesystem.read` key, so it is defence in depth and
   * NOT the read boundary: what the characterization actually records on the
   * read side is `filesystem.deny_read`, which is why that is the member
   * `verifyAppliedCodexThreadConfiguration` compares and this one is not. See
   * the WRITE BOUNDARY note below and the record's `knownLimitations`.
   */
  readonly readRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly denyWriteRoots: readonly string[];
  readonly denyReadRoots: readonly string[];
  readonly networkAccess: false;
  readonly excludeTmpdirEnvVar: true;
  readonly excludeSlashTmp: true;
}

/**
 * Both spellings of a root, for the same reason the Claude binding emits both:
 * `path.resolve` answers where a path is written while the OS boundary matches
 * where it RESOLVES, and on macOS `$TMPDIR` and `/tmp` are symlinks into
 * `/private`. A deny emitted only under the unresolved spelling names a path
 * the kernel never checks — present, and denying nothing. Canonicalize the
 * nearest ancestor that resolves and re-join the tail, so a root that does not
 * exist yet is still covered.
 */
const spellings = (target: string): readonly string[] => {
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

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort(compareUtf16CodeUnits);

/**
 * The per-fence named permission profile: workspace read by default, write
 * reopened ONLY for the grant's writable paths, every protected path and the
 * shared Git and installation authority left non-writable, ambient `$TMPDIR`
 * and `/tmp` denied, and no command network.
 */
export function codexPermissionProfileOf(input: {
  readonly workspaceRoot: string;
  readonly commonGitDir: string;
  readonly authorityDir: string;
  readonly fence: number;
  readonly grant: { readonly writablePaths: readonly string[]; readonly protectedPaths: readonly string[] };
}): CodexPermissionProfile {
  const workspaceRoots = unique([...spellings(input.workspaceRoot)]);
  const underWorkspace = (relatives: readonly string[]): string[] =>
    unique(workspaceRoots.flatMap((root) => relatives.map((relative) => path.resolve(root, relative))));

  const protectedRoots = underWorkspace(input.grant.protectedPaths);
  const authorityRoots = unique([input.commonGitDir, input.authorityDir].flatMap(spellings));

  return {
    id: codexPermissionProfileId(input.workspaceRoot, input.fence),
    sandboxMode: "workspace-write",
    readRoots: workspaceRoots,
    writableRoots: underWorkspace(input.grant.writablePaths),
    // The workspace root itself is denied so that only the more specific
    // granted descendants stay writable; the protected and authority roots are
    // denied explicitly on top, and ambient temp under both spellings.
    denyWriteRoots: unique([
      ...workspaceRoots,
      ...protectedRoots,
      ...authorityRoots,
      ...spellings(tmpdir()),
      ...spellings("/tmp"),
    ]),
    denyReadRoots: authorityRoots,
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

/**
 * The in-memory `thread/start` request the operator issues. It is DATA: the
 * product writes this document and stops. `ephemeral` and the per-thread
 * `config` together are what keep the admission out of shared configuration.
 */
export interface CodexThreadStartRequest {
  readonly method: "thread/start";
  readonly params: {
    readonly cwd: string;
    readonly ephemeral: true;
    readonly sandbox: "workspace-write";
    readonly approvalPolicy: "on-request";
    readonly config: Record<string, unknown>;
  };
}

export interface ComposeCodexAppServerThreadResult {
  readonly ok: true;
  readonly threadConfigPath: string;
  readonly request: CodexThreadStartRequest;
  readonly profile: CodexPermissionProfile;
  readonly discoveryConfigurationDigest: string;
}

/**
 * The host's own subcommand for this wire. NOT `pre-tool-use`: that branch
 * renders the Claude decision document and performs no unadjudicable-surface
 * refusal, so composing it would leave the boundary resting entirely on
 * configuration — which is exactly what the module header says is insufficient
 * on its own.
 */
export const CODEX_HOOK_SUBCOMMAND = "codex-pre-tool-use";

const hookCommandOf = (input: ComposeHostSessionInput): string =>
  [...input.hookCommand, CODEX_HOOK_SUBCOMMAND, input.statePath, String(input.fence)]
    .map((part) => JSON.stringify(part))
    .join(" ");

/**
 * Composes the fence-scoped Codex admission: the named permission profile, the
 * synchronous `pre_tool_use` command hook carrying this session's own fence,
 * and the disabling of every tool surface the local hook cannot adjudicate.
 *
 * Writes exactly one file — the thread-start request — and digests exactly the
 * bytes it wrote. The digest is the value the attestation binds, so a host that
 * applied anything else fails `verifyAppliedCodexThreadConfiguration` below and
 * no attestation is minted.
 */
export async function composeCodexAppServerThread(
  input: ComposeHostSessionInput,
): Promise<ComposeCodexAppServerThreadResult> {
  const profile = codexPermissionProfileOf({
    workspaceRoot: input.workspaceRoot,
    commonGitDir: input.commonGitDir,
    authorityDir: input.authorityDir,
    fence: input.fence,
    grant: input.grant,
  });

  /**
   * THE WRITE BOUNDARY IS `writable_roots`, NOT A DENY LIST.
   *
   * `SandboxWorkspaceWrite` in the host's own published schema carries exactly
   * four members and none of them is a deny; `workspace-write` opens write to
   * the listed roots and nothing else, so the positive list IS the boundary and
   * it is fully characterized. The `filesystem` block below is defence in depth
   * on top of that, and it is only PARTLY characterized: `deny_read` was
   * observed in the installed binary's config-layer profile struct, while
   * `read` and `deny_write` were observed in neither the schema nor the
   * inventory. They are emitted because a host that honours them narrows the
   * boundary further and a host that ignores them is left with exactly the
   * characterized `writable_roots` boundary — but no claim in this file or in
   * the qualification record rests on them, and the record says so under
   * `knownLimitations`. An uncharacterized key carrying the boundary would be
   * the defect; an uncharacterized key carrying redundancy is disclosed.
   */
  const config: Record<string, unknown> = {
    permission_profile: profile.id,
    permissions: {
      [profile.id]: {
        sandbox_mode: profile.sandboxMode,
        sandbox_workspace_write: {
          writable_roots: profile.writableRoots,
          network_access: profile.networkAccess,
          exclude_tmpdir_env_var: profile.excludeTmpdirEnvVar,
          exclude_slash_tmp: profile.excludeSlashTmp,
        },
        filesystem: {
          read: profile.readRoots,
          deny_read: profile.denyReadRoots,
          deny_write: profile.denyWriteRoots,
        },
      },
    },
    hooks: {
      [CODEX_HOOK_EVENT]: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: hookCommandOf(input),
              execution_mode: CODEX_HOOK_EXECUTION_MODE,
            },
          ],
        },
      ],
    },
    // Only the grant's capabilities are enabled, and every surface whose calls
    // the synchronous local hook cannot adjudicate is switched off.
    tools: {
      enabled_tools: codexEnabledToolsFor(input.grant.allowedCapabilities),
      web_search: false,
    },
    mcp_servers: {},
    features: {
      apps: false,
      tool_registry: false,
      multi_agent_v2: false,
    },
  };

  const request: CodexThreadStartRequest = {
    method: "thread/start",
    params: {
      cwd: path.resolve(input.workspaceRoot),
      ephemeral: true,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      config,
    },
  };

  const threadConfigPath = path.join(input.bindingDir, CODEX_THREAD_CONFIG_FILE(input.fence));
  const bytes = `${JSON.stringify(request, null, 2)}\n`;
  await mkdir(input.bindingDir, { recursive: true, mode: OWNER_DIR });
  await writeFile(threadConfigPath, bytes, { mode: OWNER_FILE });
  await chmod(threadConfigPath, OWNER_FILE);

  return {
    ok: true,
    threadConfigPath,
    request,
    profile,
    discoveryConfigurationDigest: digestCanonical({ threadStartRequest: request }),
  };
}

// ── Verifying what the host actually applied ────────────────────────────────

export const CODEX_APPLIED_MISMATCH_CODES = Object.freeze([
  "permission_profile_mismatch",
  "sandbox_mode_mismatch",
  "writable_roots_mismatch",
  "deny_write_roots_mismatch",
  "deny_read_roots_mismatch",
  "network_access_enabled",
  "ambient_temp_not_excluded",
  "hook_missing",
  "hook_command_mismatch",
  "hook_not_synchronous",
  "unenforceable_tool_surface_enabled",
  "disabled_feature_enabled",
  "configuration_digest_mismatch",
] as const);
export type CodexAppliedMismatchCode = (typeof CODEX_APPLIED_MISMATCH_CODES)[number];

/**
 * What the host reports it applied. Every member is optional because an absent
 * member is exactly the case that must fail: a host that reports nothing has
 * verified nothing, and the deny direction is the safe one.
 */
export interface CodexAppliedThreadConfiguration {
  readonly permissionProfileId?: unknown;
  readonly sandboxMode?: unknown;
  readonly writableRoots?: unknown;
  /**
   * The deny sets the composed `filesystem` block carries. Verified for the
   * same reason every other member is: a host that reports the writable roots
   * faithfully and silently drops every deny has applied a wider boundary than
   * the one the attestation is about to bind, and the digest comparison below
   * cannot catch it — that digest is over bytes this binding canonicalized, and
   * no characterization says the host reproduces it.
   */
  readonly deniedWriteRoots?: unknown;
  readonly deniedReadRoots?: unknown;
  readonly networkAccess?: unknown;
  readonly excludeTmpdirEnvVar?: unknown;
  readonly excludeSlashTmp?: unknown;
  readonly hookEvent?: unknown;
  readonly hookCommand?: unknown;
  readonly hookExecutionMode?: unknown;
  readonly enabledUnenforceableToolSources?: unknown;
  /**
   * Which of `CODEX_DISABLED_FEATURE_KEYS` the host reports it has ENABLED.
   * The composition switches every one of them off, and the local hook cannot
   * adjudicate any of them, so the only faithful answer is the empty list —
   * the same posture `enabledUnenforceableToolSources` carries, for the same
   * reason. Without this member a host could re-enable `tool_registry` and
   * the gate would verify: the composed bytes say one thing and the applied
   * configuration was never asked.
   */
  readonly enabledFeatureKeys?: unknown;
  readonly configurationDigest?: unknown;
}

export interface CodexAppliedMismatch {
  readonly code: CodexAppliedMismatchCode;
  readonly message: string;
}

export type VerifyAppliedCodexThreadConfiguration =
  | { readonly verified: true }
  | { readonly verified: false; readonly mismatches: readonly CodexAppliedMismatch[] };

const sameStrings = (applied: unknown, expected: readonly string[]): boolean =>
  Array.isArray(applied) &&
  applied.length === expected.length &&
  applied.every((entry) => typeof entry === "string") &&
  unique(applied as string[]).join("\0") === unique(expected).join("\0");

/**
 * The gate in front of the attestation. NOTHING may be minted and no
 * tool-bearing turn may start until this returns verified: an attestation is
 * a claim about what the host is enforcing, and a claim made before the host
 * said what it applied is a claim about nothing.
 *
 * Every check fails closed on an absent or wrong-typed member, and the whole
 * set is reported rather than the first failure, so a caller sees everything
 * that diverged in one pass.
 */
export function verifyAppliedCodexThreadConfiguration(
  expected: ComposeCodexAppServerThreadResult,
  applied: CodexAppliedThreadConfiguration,
): VerifyAppliedCodexThreadConfiguration {
  const mismatches: CodexAppliedMismatch[] = [];
  const expectedHookCommand = (
    (expected.request.params.config["hooks"] as Record<string, readonly { hooks: readonly { command: string }[] }[]>)[
      CODEX_HOOK_EVENT
    ] as readonly { hooks: readonly { command: string }[] }[]
  )[0]?.hooks[0]?.command;

  if (applied.permissionProfileId !== expected.profile.id) {
    mismatches.push({
      code: "permission_profile_mismatch",
      message: "the host did not apply this fence's named permission profile",
    });
  }
  if (applied.sandboxMode !== expected.profile.sandboxMode) {
    mismatches.push({ code: "sandbox_mode_mismatch", message: "the applied sandbox mode is not the composed one" });
  }
  if (!sameStrings(applied.writableRoots, expected.profile.writableRoots)) {
    mismatches.push({
      code: "writable_roots_mismatch",
      message: "the applied writable roots are not exactly the grant's writable paths",
    });
  }
  if (!sameStrings(applied.deniedWriteRoots, expected.profile.denyWriteRoots)) {
    mismatches.push({
      code: "deny_write_roots_mismatch",
      message: "the applied write denies are not the composed ones; a dropped deny is a widened boundary",
    });
  }
  if (!sameStrings(applied.deniedReadRoots, expected.profile.denyReadRoots)) {
    mismatches.push({
      code: "deny_read_roots_mismatch",
      message: "the applied read denies are not the composed ones; the authority roots must stay unreadable",
    });
  }
  if (applied.networkAccess !== false) {
    mismatches.push({ code: "network_access_enabled", message: "the applied profile permits command network access" });
  }
  if (applied.excludeTmpdirEnvVar !== true || applied.excludeSlashTmp !== true) {
    mismatches.push({
      code: "ambient_temp_not_excluded",
      message: "the applied profile does not exclude ambient $TMPDIR and /tmp",
    });
  }
  if (applied.hookEvent !== CODEX_HOOK_EVENT) {
    mismatches.push({ code: "hook_missing", message: `the host applied no ${CODEX_HOOK_EVENT} hook` });
  }
  if (typeof applied.hookCommand !== "string" || applied.hookCommand !== expectedHookCommand) {
    mismatches.push({
      code: "hook_command_mismatch",
      message: "the applied hook command is not the fence-bound interceptor this session composed",
    });
  }
  if (applied.hookExecutionMode !== CODEX_HOOK_EXECUTION_MODE) {
    mismatches.push({
      code: "hook_not_synchronous",
      message: "the applied hook does not run synchronously, so it intercepts nothing",
    });
  }
  if (!Array.isArray(applied.enabledUnenforceableToolSources) || applied.enabledUnenforceableToolSources.length > 0) {
    mismatches.push({
      code: "unenforceable_tool_surface_enabled",
      message: "a hosted, app/MCP, dynamic, or plugin tool surface the local hook cannot adjudicate is enabled",
    });
  }
  if (!Array.isArray(applied.enabledFeatureKeys) || applied.enabledFeatureKeys.length > 0) {
    mismatches.push({
      code: "disabled_feature_enabled",
      message:
        "a feature this composition switched off — the tool registry, multi-agent, or web search — is enabled in the applied configuration",
    });
  }
  if (applied.configurationDigest !== expected.discoveryConfigurationDigest) {
    mismatches.push({
      code: "configuration_digest_mismatch",
      message: "the host's applied configuration does not digest to the bytes this binding composed",
    });
  }

  return mismatches.length === 0 ? { verified: true } : { verified: false, mismatches };
}

// ── Escalation refusals ─────────────────────────────────────────────────────

export const CODEX_ESCALATION_REFUSAL_CODES = Object.freeze([
  "session_wide_permission_widening_refused",
  "exec_policy_amendment_refused",
  "extra_writable_root_refused",
  "unenforceable_tool_source_refused",
] as const);
export type CodexEscalationRefusalCode = (typeof CODEX_ESCALATION_REFUSAL_CODES)[number];

export interface CodexEscalationRequest {
  /** The host's own escalation kind, as the approvals surface reports it. */
  readonly kind: string;
  /** True for a one-shot approval bound to this single invocation. */
  readonly oneShot: boolean;
  readonly writableRoots?: readonly string[];
}

/**
 * Ordinary approvals stay host-native and one-shot; escalation does not.
 * `acceptForSession`, an exec-policy amendment, and any extra writable root
 * are refused here rather than forwarded, because each of them would move the
 * boundary the attestation already bound — and an attestation that binds a
 * boundary the session can widen binds nothing.
 */
export function evaluateCodexEscalation(
  request: CodexEscalationRequest,
  profile: CodexPermissionProfile,
): { readonly refused: false } | { readonly refused: true; readonly code: CodexEscalationRefusalCode; readonly message: string } {
  const kind = request.kind.toLowerCase();
  if (!request.oneShot || kind.includes("forsession") || kind.includes("for_session") || kind.includes("session")) {
    return {
      refused: true,
      code: "session_wide_permission_widening_refused",
      message: "session-wide permission widening is refused; approvals stay one-shot",
    };
  }
  if (kind.includes("execpolicy") || kind.includes("exec_policy") || kind.includes("exec-policy")) {
    return {
      refused: true,
      code: "exec_policy_amendment_refused",
      message: "exec-policy amendments are refused; the admitted boundary is the attested one",
    };
  }
  for (const root of request.writableRoots ?? []) {
    if (!profile.writableRoots.includes(path.resolve(root))) {
      return {
        refused: true,
        code: "extra_writable_root_refused",
        message: `writable root ${JSON.stringify(root)} is outside the attested profile`,
      };
    }
  }
  if (codexNamesDisabledSurface(request.kind)) {
    return {
      refused: true,
      code: "unenforceable_tool_source_refused",
      message: "a tool surface the synchronous local hook cannot adjudicate cannot be escalated into",
    };
  }
  return { refused: false };
}

// ── The seam instance ───────────────────────────────────────────────────────

/**
 * The Codex binding as the facade's neutral seam sees it. Composing returns
 * the thread-start request the OPERATOR issues; the product issues nothing.
 */
export const codexAppServerBinding: ManagedHostBinding = {
  hostId: CODEX_APP_SERVER_HOST_ID,
  async composeSession(input: ComposeHostSessionInput): Promise<ComposeHostSessionResult> {
    const composed = await composeCodexAppServerThread(input);
    return {
      ok: true,
      admissionConfigurationPath: composed.threadConfigPath,
      // Data, not a launch: the app-server method to issue and the file
      // holding its exact params.
      hostAdmissionArguments: ["thread/start", composed.threadConfigPath],
      discoveryConfigurationDigest: composed.discoveryConfigurationDigest,
    };
  },
  /**
   * The digest is over the composed thread-start request exactly as it was
   * written, so a byte changed under the binding's feet stops matching what
   * the attestation bound. Unreadable or unparseable bytes answer `undefined`,
   * which the recheck reads as a mismatch.
   */
  async recomputeDiscoveryConfigurationDigest(input: {
    readonly admissionConfigurationPath: string;
    readonly bindingDir: string;
  }): Promise<string | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(input.admissionConfigurationPath, "utf8"));
      return digestCanonical({ threadStartRequest: parsed });
    } catch {
      return undefined;
    }
  },
  admissionConfigurationPath(bindingDir: string, fence: number): string {
    return path.join(bindingDir, CODEX_THREAD_CONFIG_FILE(fence));
  },
};
