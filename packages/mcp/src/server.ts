/**
 * The MCP tool surface — a thin wrapper over the CLI's command core.
 *
 * STUB. The parity suite is written against these signatures first; every
 * helper throws until the implementation lands.
 */
import type { SerializedBlockers } from "@delivery-harness/kernel";
import type { ArtifactsPort, EnvSnapshot, HarnessConfig, LiveProviderResult } from "@delivery-harness/kernel";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const MCP_SERVER_INFO = { name: "delivery-harness", version: "0.0.0" } as const;

export interface ToolHostRuntime {
  readonly cwd: string;
  readonly env: EnvSnapshot;
  readonly loadConfig?: (rootDir: string) => Promise<HarnessConfig>;
  readonly artifacts?: ArtifactsPort;
  readonly liveResults?: readonly LiveProviderResult[];
}

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

export function listTools(): readonly ToolListing[] {
  throw new Error("listTools is not implemented");
}

export function callTool(_name: string, _args: unknown, _runtime: ToolHostRuntime): Promise<ToolOutcome> {
  throw new Error("callTool is not implemented");
}

export function toolResultFor(_outcome: ToolOutcome): McpToolResult {
  throw new Error("toolResultFor is not implemented");
}
