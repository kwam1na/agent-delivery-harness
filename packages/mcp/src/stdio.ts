/**
 * The stdio transport: newline-delimited JSON-RPC 2.0 over stdin and stdout.
 *
 * WHY HAND-ROLLED. MCP's stdio transport is one line of JSON per message, and
 * the methods a tools-only server answers are `initialize`, `tools/list`,
 * `tools/call` and `ping`. That is the whole surface, and it is written below
 * without a dependency — which matters in a repo that declined an npm
 * canonicalizer on supply-chain grounds and has carried zero runtime
 * dependencies since. The SDK would own framing this file states in a page,
 * and would own it behind a transitive tree nobody here reviews.
 *
 * THE TWO ERROR CHANNELS ARE NOT INTERCHANGEABLE. A JSON-RPC error means the
 * call could not run: unparseable bytes, a method this server does not
 * implement, params that are not even shaped like params. A *tool result* with
 * `isError` means the call ran and the harness said no — a policy block, a
 * usage failure, an unknown tool. Reporting a policy block as a protocol error
 * would strip the blockers, the remediations, and the outcome class an agent
 * acts on; reporting a protocol fault as a tool result would tell a client its
 * malformed request succeeded in reaching a tool. Each stays on its own channel.
 *
 * STDOUT IS THE WIRE. Nothing here ever prints diagnostics to stdout — a stray
 * line would be a protocol violation, not a log. Diagnostics go to stderr.
 *
 * WHICH REVISIONS ARE ADVERTISED, AND WHY THE MIDDLE ONE IS NOT. MCP added
 * JSON-RPC batching in 2025-03-26 — a server speaking that revision must accept
 * an array of messages — and removed it again in 2025-06-18. This transport
 * refuses arrays outright, so 2025-03-26 is deliberately absent from the
 * advertised list: a client asking for it is answered with a revision where
 * the refusal is the truth. 2024-11-05 predates batching entirely and carries
 * no such requirement, so it stays. Advertising a revision whose requirements
 * this file does not meet would be the one protocol lie that costs a client its
 * ability to reason about the connection at all.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  callTool,
  listTools,
  toolResultFor,
  type ToolHostRuntime,
} from "./server.ts";

// ── JSON-RPC ─────────────────────────────────────────────────────────────────

export const JSON_RPC_VERSION = "2.0";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

/**
 * Session state the protocol carries; the tools themselves are stateless.
 *
 * NO HANDSHAKE GATE, AND THEREFORE NO `initialized` FLAG. Refusing `tools/list`
 * or `tools/call` until the handshake completed was the alternative, and it was
 * declined on two grounds. The spec's ordering rule is a SHOULD addressed to
 * the *client*, so a hard server-side gate refuses a pipelining client the spec
 * allows to be answered, and it would need a rejection code the protocol does
 * not define for the case. And a flag written on every handshake but read by no
 * decision is state that can only go stale — the kind a later reader trusts
 * without noticing nothing maintains it. `protocolVersion` stays because it is
 * the negotiated result the connection is bound to and the `initialize`
 * response is built from it.
 */
export interface McpSession {
  protocolVersion: string;
}

export function createSession(): McpSession {
  return { protocolVersion: MCP_PROTOCOL_VERSION };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The three id shapes JSON-RPC 2.0 permits. Anything else is not an id. */
function isUsableId(id: unknown): id is JsonRpcId {
  return typeof id === "string" || typeof id === "number" || id === null;
}

function idOf(message: Record<string, unknown>): JsonRpcId {
  const id = message["id"];
  return isUsableId(id) ? id : null;
}

/**
 * A notification is a message with no `id` *member* — not a message whose id
 * happens to be null. The distinction matters: answering an explicit null id
 * with silence would hang a client that is waiting for a response it is
 * entitled to.
 */
function isNotification(message: Record<string, unknown>): boolean {
  return !Object.prototype.hasOwnProperty.call(message, "id");
}

function negotiate(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
}

/**
 * Answers one decoded message. Returns `null` for a notification — the one
 * shape the protocol forbids a response to.
 */
export async function handleRpcMessage(message: unknown, host: ToolHostRuntime, session: McpSession): Promise<JsonRpcResponse | null> {
  if (Array.isArray(message)) {
    // No revision this server advertises supports batching, and answering a
    // batch anyway would leave a client believing it negotiated something it
    // did not.
    return fail(null, INVALID_REQUEST, "JSON-RPC batches are not part of the protocol revisions this server speaks.");
  }
  if (!isRecord(message)) return fail(null, INVALID_REQUEST, "A JSON-RPC message must be an object.");
  if (message["jsonrpc"] !== JSON_RPC_VERSION) return fail(idOf(message), INVALID_REQUEST, 'A JSON-RPC message must declare jsonrpc "2.0".');

  // ID HYGIENE, BEFORE ANY DISPATCH. An id of an unusable shape cannot be
  // echoed, so the client could never correlate the result — and `tools/call`
  // is side-effecting. Coercing such an id to null and running the call anyway
  // would publish evidence on behalf of a request nobody can match a response
  // to. An absent id member is a notification and is not an id at all.
  if (!isNotification(message) && !isUsableId(message["id"])) {
    return fail(null, INVALID_REQUEST, "A JSON-RPC id must be a string, a number, or null.");
  }

  const method = message["method"];
  if (typeof method !== "string") return fail(idOf(message), INVALID_REQUEST, "A JSON-RPC message must name a string method.");

  const id = idOf(message);
  const params = message["params"];

  // SHAPE DECIDES, NOT THE METHOD NAME. Notifications — `initialized`,
  // cancellation, progress — are accepted and ignored: this server keeps no
  // handshake gate and starts no work a client can cancel. A message carrying
  // an id is a request whatever it is named, so an id-bearing
  // `notifications/initialized` falls through to normal dispatch and is
  // answered there. Special-casing the name above this check is what used to
  // swallow it and leave the client waiting.
  if (isNotification(message)) return null;

  if (method === "initialize") {
    session.protocolVersion = negotiate(isRecord(params) ? params["protocolVersion"] : undefined);
    return ok(id, {
      protocolVersion: session.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: MCP_SERVER_INFO,
    });
  }

  if (method === "ping") return ok(id, {});

  if (method === "tools/list") return ok(id, { tools: listTools() });

  if (method === "tools/call") {
    if (!isRecord(params)) return fail(id, INVALID_PARAMS, "tools/call requires a params object.");
    const name = params["name"];
    if (typeof name !== "string") {
      // Not "unknown tool": the request never named one, which is a malformed
      // request rather than a call this server declined.
      return fail(id, INVALID_PARAMS, "tools/call requires a string name.");
    }
    const outcome = await callTool(name, params["arguments"], host);
    return ok(id, toolResultFor(outcome));
  }

  return fail(id, METHOD_NOT_FOUND, `Method ${JSON.stringify(method)} is not implemented by this server.`);
}

/**
 * Decodes one line and answers it. Kept separate from the loop so the framing —
 * blank lines skipped, undecodable lines answered with a parse error rather
 * than closing the connection — is testable without streams.
 */
export async function handleRpcLine(line: string, host: ToolHostRuntime, session: McpSession): Promise<JsonRpcResponse | null> {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return fail(null, PARSE_ERROR, "The message could not be parsed as JSON.");
  }
  return handleRpcMessage(decoded, host, session);
}

/**
 * Serializes a response onto one line.
 *
 * The framing requires that no message contain an embedded newline. Every
 * newline this server produces is inside a rendered blocker string, and
 * `JSON.stringify` escapes those — so the invariant holds by construction
 * rather than by a scrub pass that could be forgotten.
 */
export function encodeResponse(response: JsonRpcResponse): string {
  return `${JSON.stringify(response)}\n`;
}

// ── The loop ─────────────────────────────────────────────────────────────────

/**
 * Serves until the input ends. Messages are answered in arrival order: the
 * transport is one connection with one client, and interleaving responses buys
 * nothing but a reordering bug.
 */
export async function serveStdio(input: NodeJS.ReadableStream, write: (line: string) => void, host: ToolHostRuntime): Promise<void> {
  const session = createSession();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const response = await handleRpcLine(line, host, session);
    if (response !== null) write(encodeResponse(response));
  }
}

/** Built inside a function, never at import time: the sensor's env rule. */
export function defaultToolRuntime(): ToolHostRuntime {
  return { cwd: process.cwd(), env: process.env };
}

export function entryHref(entryPath: string): string {
  return pathToFileURL(entryPath).href;
}

export function invokedDirectly(argvEntry: string | undefined, moduleHref: string): boolean {
  return argvEntry !== undefined && entryHref(argvEntry) === moduleHref;
}

export async function main(): Promise<void> {
  await serveStdio(process.stdin, (line) => process.stdout.write(line), defaultToolRuntime());
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  // Fail closed for the same reason the CLI does: a server that fell over
  // without saying so must not look like a clean shutdown.
  process.exitCode = 1;
  main()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    });
}
