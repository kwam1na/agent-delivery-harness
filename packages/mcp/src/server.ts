/**
 * The MCP tool surface: `review-context` and `submit-evidence`, at strict
 * parity with the CLI.
 *
 * THIS IS A WRAPPER, NOT A SECOND IMPLEMENTATION. Every tool call is turned
 * into the argv the CLI would have been invoked with and handed to
 * `runCliBoundary` — the same boundary, the same command modules, the same
 * config loader, the same exit-code classification, the same renderer. The text
 * an agent reads is literally the bytes the CLI wrote, captured rather than
 * printed. Parity is therefore a property of the construction, and the parity
 * table beside this file is what keeps it one.
 *
 * WHY NO MCP SDK. The stdio transport is newline-delimited JSON-RPC 2.0 and the
 * three methods this server answers are small and fully specified, so the SDK
 * would buy framing this package can write in a page — at the cost of the first
 * runtime dependency in a repo that refused one on its canonicalizer for
 * supply-chain reasons. The protocol layer lives in `stdio.ts`; this module is
 * transport-free so the parity suite drives the same code an agent reaches.
 *
 * A DELIBERATE SUBSET. Two of the CLI's seven commands are exposed. The rest
 * are not tools, and a call naming one is an unknown tool: what a tool call may
 * reach is the registry below, never the CLI's. Exposing less than the CLI is
 * within the contract; behaving differently about what is exposed is not.
 *
 * WHAT AN AGENT NEVER GETS. No TTY, therefore no waiver prompt — an MCP session
 * has no human at the other end to answer one, and a prompt nobody can answer
 * is either a hang or a forged consent. Both TTY flags are hard `false` here.
 */
import {
  CliInterruption,
  EXIT_OK,
  EXIT_USAGE,
  commandBlocker,
  importHarnessConfig,
  reviewContextCommand,
  runCliBoundary,
  submitEvidenceCommand,
  type CliRuntime,
  type CommandDescriptor,
} from "@v26labs/delivery-harness-cli";
import {
  BlockedError,
  createInternalErrorBlocker,
  renderBlockers,
  serializeBlockers,
  type ArtifactsPort,
  type Blocker,
  type EnvSnapshot,
  type HarnessConfig,
  type LiveProviderResult,
  type SerializedBlockers,
} from "@v26labs/delivery-harness-kernel";

// ── Protocol identity ────────────────────────────────────────────────────────

/**
 * The MCP revision this server implements, and the older revision it will still
 * speak if a client asks for one. Newest first: `initialize` echoes the
 * client's version when it is on this list and answers with the newest
 * otherwise, which is the negotiation the spec asks for.
 *
 * 2025-03-26 is missing on purpose. It is the one revision that requires a
 * server to accept JSON-RPC batches, and the transport refuses every array; a
 * client asking for it is answered with 2025-06-18, where that refusal is
 * true. 2024-11-05 predates batching and carries no such requirement.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([MCP_PROTOCOL_VERSION, "2024-11-05"]);

/** Version tracks the package; the release mechanics keep the two in step. */
export const MCP_SERVER_INFO = { name: "delivery-harness", version: "0.0.0" } as const;

const MCP_SOURCE_ID = "delivery-harness.mcp";

// ── What a tool call may reach ───────────────────────────────────────────────

/** Everything the host provides. No streams: this module never prints. */
export interface ToolHostRuntime {
  readonly cwd: string;
  readonly env: EnvSnapshot;
  readonly loadConfig?: (rootDir: string) => Promise<HarnessConfig>;
  readonly artifacts?: ArtifactsPort;
  readonly liveResults?: readonly LiveProviderResult[];
}

/**
 * One tool call, classified the way the CLI classifies an invocation.
 *
 * `exitCode` is carried verbatim rather than translated, because the CLI's
 * three classes are the contract: 0 passed, 2 could not be parsed, anything
 * else is a policy failure. `outcome` is that same classification named, so an
 * agent reading structured content does not have to know shell conventions.
 */
export interface ToolOutcome {
  readonly outcome: "ok" | "blocked" | "usage";
  readonly exitCode: number;
  readonly text: string;
  readonly blockers: SerializedBlockers;
}

export interface ToolListing {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError: boolean;
  readonly structuredContent: {
    readonly outcome: ToolOutcome["outcome"];
    readonly exitCode: number;
    readonly blockers: SerializedBlockers;
  };
}

/** Either the argv the boundary runs, or the typed usage failure to report. */
type ArgumentTranslation = { readonly ok: true; readonly argv: readonly string[] } | { readonly ok: false; readonly blocker: Blocker };

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly command: CommandDescriptor;
  translate(args: Record<string, unknown>): ArgumentTranslation;
}

// ── Argument translation ─────────────────────────────────────────────────────

function usageBlocker(code: string, summary: string, details: string, remediationSummary: string): Blocker {
  return commandBlocker({
    code,
    sourceId: MCP_SOURCE_ID,
    summary,
    details,
    remediations: [{ id: "correct-the-tool-call", kind: "manual_action", summary: remediationSummary }],
  });
}

const TOOL_NAMES_SENTENCE = (): string => TOOLS.map((tool) => tool.name).join(", ");

/**
 * Rejects members the tool does not define, for the same reason the manifest
 * validator rejects them: a tolerated stranger is how a caller comes to believe
 * it configured something. Unlike a manifest, the offending name is caller
 * text — it reaches an agent's screen through the renderer, never raw.
 */
function rejectUnknownMembers(tool: ToolDefinition, args: Record<string, unknown>, defined: readonly string[]): Blocker | null {
  const unknown = Object.keys(args).filter((name) => !defined.includes(name));
  if (unknown.length === 0) return null;
  return usageBlocker(
    "unknown_tool_argument",
    `The ${tool.name} tool does not define every argument this call supplied.`,
    `Undefined argument(s): ${unknown.join(", ")}. Defined: ${defined.length === 0 ? "(none)" : defined.join(", ")}.`,
    `Call ${tool.name} with only the arguments its input schema declares.`,
  );
}

/**
 * The tools, named exactly as the CLI names its commands.
 *
 * That is the naming decision this unit settles: one vocabulary for an operator
 * reading a terminal and an agent reading a tool list, so guidance that names
 * `submit-evidence` is executable on both surfaces without translation.
 */
const TOOLS: readonly ToolDefinition[] = [
  {
    name: reviewContextCommand.name,
    description:
      "Show the reviewable-change context for the prepared candidate: its tree, the relevant-line count, whether the gate's obligations activate, and how to submit evidence. Requires a current preparation receipt.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    command: reviewContextCommand,
    translate(args) {
      const unknown = rejectUnknownMembers(this, args, []);
      if (unknown !== null) return { ok: false, blocker: unknown };
      return { ok: true, argv: [reviewContextCommand.name] };
    },
  },
  {
    name: submitEvidenceCommand.name,
    description:
      "Validate a provider evidence manifest against delivery-evidence/1 and publish its per-claim records. Rejections carry the violated rule's code; nothing is published unless the whole submission is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        manifest: { type: "string", description: "Path to the manifest.json to submit, inside its allocated run root." },
      },
      required: ["manifest"],
      additionalProperties: false,
    },
    command: submitEvidenceCommand,
    translate(args) {
      const unknown = rejectUnknownMembers(this, args, ["manifest"]);
      if (unknown !== null) return { ok: false, blocker: unknown };
      const manifest = args["manifest"];
      // Absent is deliberately *not* rejected here. The schema says the member
      // is required, and the command says so too — in its own words, with its
      // own exit-2 class. Delegating keeps one sentence for both surfaces
      // instead of two that drift.
      if (manifest === undefined) return { ok: true, argv: [submitEvidenceCommand.name] };
      if (typeof manifest !== "string") {
        return {
          ok: false,
          blocker: usageBlocker(
            "invalid_tool_argument",
            "The submit-evidence tool's manifest argument must be a filesystem path.",
            `manifest was ${manifest === null ? "null" : typeof manifest}, not a string.`,
            "Call submit-evidence with manifest set to the path of the manifest.json to submit.",
          ),
        };
      }
      return { ok: true, argv: [submitEvidenceCommand.name, "--manifest", manifest] };
    },
  },
];

// ── The advertised surface ───────────────────────────────────────────────────

export function listTools(): readonly ToolListing[] {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

// ── Running one call through the command core ────────────────────────────────

const EMPTY_BLOCKERS: readonly Blocker[] = Object.freeze([]);

function classify(exitCode: number): ToolOutcome["outcome"] {
  if (exitCode === EXIT_OK) return "ok";
  if (exitCode === EXIT_USAGE) return "usage";
  return "blocked";
}

function outcomeFor(exitCode: number, text: string, blockers: readonly Blocker[]): ToolOutcome {
  return { outcome: classify(exitCode), exitCode, text, blockers: serializeBlockers(blockers) };
}

/** A usage failure this module raised itself, rendered like every other one. */
function usageOutcome(blocker: Blocker): ToolOutcome {
  return outcomeFor(EXIT_USAGE, renderBlockers([blocker]), [blocker]);
}

/**
 * The structured half of a failure the boundary is about to render as text.
 *
 * The boundary reports failures on a stream; it does not hand back the typed
 * blockers behind them, and an agent context window needs the structured form.
 * Rather than re-deciding anything, this observes the same values on their way
 * past: a `BlockedError` carries its blockers, and an unexpected throw is
 * described with the very constructor the boundary uses, so the code and
 * summary an agent parses are the ones an operator would have read.
 */
function blockersFromThrow(error: unknown, descriptor: CommandDescriptor): readonly Blocker[] {
  if (error instanceof CliInterruption) return EMPTY_BLOCKERS;
  if (error instanceof BlockedError) return error.blockers;
  return [
    createInternalErrorBlocker({
      source: { kind: "command", id: descriptor.sourceId },
      error,
      reproduce: ["delivery-harness", descriptor.name],
    }),
  ];
}

async function throughCommandCore(tool: ToolDefinition, argv: readonly string[], host: ToolHostRuntime): Promise<ToolOutcome> {
  const out: string[] = [];
  const err: string[] = [];
  let observed: readonly Blocker[] = EMPTY_BLOCKERS;

  // The command, wrapped only to observe. It runs the real `run`, returns the
  // real result, and rethrows the real error: the boundary sees exactly what it
  // would have seen with the unwrapped descriptor.
  const observedCommand: CommandDescriptor = {
    ...tool.command,
    async run(context) {
      try {
        const result = await tool.command.run(context);
        if (result.kind === "blocked") observed = result.blockers;
        return result;
      } catch (error) {
        observed = blockersFromThrow(error, tool.command);
        throw error;
      }
    },
  };

  const loadConfig = host.loadConfig ?? importHarnessConfig;
  const runtime: CliRuntime = {
    cwd: host.cwd,
    env: host.env,
    // No TTY on either side: stdin and stdout are the transport, and a waiver
    // prompt would have nobody to answer it.
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    loadConfig: async (rootDir) => {
      try {
        return await loadConfig(rootDir);
      } catch (error) {
        // A config that will not load blocks before the command runs, so the
        // wrapper above never sees it.
        observed = blockersFromThrow(error, tool.command);
        throw error;
      }
    },
    ...(host.artifacts === undefined ? {} : { artifacts: host.artifacts }),
    ...(host.liveResults === undefined ? {} : { liveResults: host.liveResults }),
  };

  const exitCode = await runCliBoundary(argv, [observedCommand], runtime);
  return outcomeFor(exitCode, `${out.join("")}${err.join("")}`.trimEnd(), observed);
}

/**
 * Runs one tool call to a classified outcome. Total, like the boundary it wraps:
 * an unknown tool, unusable arguments, a policy block and an internal error all
 * come back as an outcome rather than a throw.
 */
export async function callTool(name: string, args: unknown, host: ToolHostRuntime): Promise<ToolOutcome> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return usageOutcome(
      usageBlocker(
        "unknown_tool",
        "This server does not offer the tool this call named.",
        `Requested tool: ${name}. Offered: ${TOOL_NAMES_SENTENCE()}.`,
        `Call one of the tools this server advertises: ${TOOL_NAMES_SENTENCE()}.`,
      ),
    );
  }

  // Absent arguments are an empty object (the spec's own default); anything
  // else that is not an object is a usage failure rather than a coerced guess.
  const supplied = args === undefined || args === null ? {} : args;
  if (typeof supplied !== "object" || Array.isArray(supplied)) {
    return usageOutcome(
      usageBlocker(
        "invalid_tool_arguments",
        `The ${tool.name} tool's arguments must be an object.`,
        `Arguments were ${Array.isArray(supplied) ? "an array" : typeof supplied}.`,
        `Call ${tool.name} with an arguments object matching its input schema.`,
      ),
    );
  }

  const translation = tool.translate(supplied as Record<string, unknown>);
  if (!translation.ok) return usageOutcome(translation.blocker);
  return throughCommandCore(tool, translation.argv, host);
}

// ── The MCP shape ────────────────────────────────────────────────────────────

/**
 * Shapes an outcome as an MCP tool result.
 *
 * One text block, and it is the renderer's output — an agent's context window
 * is a rendering surface, so the bytes that reach it are the neutralized ones,
 * not a raw provider string re-serialized on the way out. `structuredContent`
 * is the renderer's other face (`serializeBlockers`), which neutralizes the
 * same way. No `outputSchema` is declared: declaring one obliges a server to
 * repeat the structured content as JSON text for older clients, and a second
 * copy of every blocker in an agent's context buys nothing this text block does
 * not already say.
 *
 * `isError` is true for both failure classes. A tool result is how MCP reports
 * a call that ran and failed, and a policy block is exactly that — the protocol
 * error channel is for calls that could not run at all.
 */
export function toolResultFor(outcome: ToolOutcome): McpToolResult {
  return {
    content: [{ type: "text", text: outcome.text }],
    isError: outcome.outcome !== "ok",
    structuredContent: { outcome: outcome.outcome, exitCode: outcome.exitCode, blockers: outcome.blockers },
  };
}
