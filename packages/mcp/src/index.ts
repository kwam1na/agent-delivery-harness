/**
 * Delivery harness MCP server.
 *
 * `server.ts` is the tool surface — a wrapper over the CLI's command core at
 * strict parity. `stdio.ts` is the transport that carries it: newline-delimited
 * JSON-RPC 2.0, hand-rolled, no runtime dependency.
 */

export const PACKAGE_NAME = "@agent-delivery-harness/mcp";

export {
  HANDSHAKE_PROTOCOL_VERSIONS,
  LOG_LEVELS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_CAPABILITIES,
  MCP_SERVER_INFO,
  MCP_STATELESS_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_LOG_LEVEL,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  META_STATELESS_KEYS,
  STATELESS_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_LIST_CACHE_SCOPE,
  TOOL_LIST_TTL_MS,
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
  UNSUPPORTED_PROTOCOL_VERSION,
  createSession,
  encodeResponse,
  handleRpcLine,
  handleRpcMessage,
  serveStdio,
  type JsonRpcId,
  type JsonRpcResponse,
  type McpSession,
} from "./stdio.ts";
