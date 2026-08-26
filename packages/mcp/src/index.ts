/**
 * Delivery harness MCP server.
 *
 * `server.ts` is the tool surface — a wrapper over the CLI's command core at
 * strict parity. `stdio.ts` is the transport that carries it: newline-delimited
 * JSON-RPC 2.0, hand-rolled, no runtime dependency.
 */

export const PACKAGE_NAME = "@delivery-harness/mcp";

export {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  callTool,
  listTools,
  toolResultFor,
  type McpToolResult,
  type ToolHostRuntime,
  type ToolListing,
  type ToolOutcome,
} from "./server.ts";

export {
  INVALID_PARAMS,
  INVALID_REQUEST,
  JSON_RPC_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  createSession,
  encodeResponse,
  handleRpcLine,
  handleRpcMessage,
  serveStdio,
  type JsonRpcId,
  type JsonRpcResponse,
  type McpSession,
} from "./stdio.ts";
