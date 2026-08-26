/**
 * The stdio transport: newline-delimited JSON-RPC 2.0 over stdin and stdout.
 *
 * WHY HAND-ROLLED. MCP's stdio transport is one line of JSON per message, and
 * the methods a tools-only server answers are `initialize`, `server/discover`,
 * `tools/list`, `tools/call` and `ping`. That is the whole surface, and it is
 * written below without a dependency — which matters in a repo that declined an
 * npm canonicalizer on supply-chain grounds and has carried zero runtime
 * dependencies since. The SDK would own framing this file states in a page,
 * and would own it behind a transitive tree nobody here reviews.
 *
 * TWO ERAS, ONE PROCESS. MCP 2026-07-28 removed the `initialize` handshake:
 * every request declares its own protocol version and client capabilities in
 * `_meta`, results carry a `resultType`, list results carry caching hints,
 * `server/discover` is mandatory, and `ping` is gone. The three revisions
 * before it still negotiate through `initialize` and still have `ping`. This
 * server serves both, and the spec says how: "A dual-era server selects its
 * behavior from how the client opens ... A request carrying modern per-request
 * `_meta` is served statelessly according to this revision. An `initialize`
 * request selects legacy semantics." The branch is per request and reads
 * nothing remembered, because the newer revision forbids inferring context from
 * an earlier request on the same connection. Nothing from the newer revision
 * appears in an older revision's result: a client that negotiated 2024-11-05
 * reads the bytes it read before 2026-07-28 existed.
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
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  HANDSHAKE_PROTOCOL_VERSIONS,
  LOG_LEVELS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_CAPABILITIES,
  MCP_SERVER_INFO,
  META_CLIENT_CAPABILITIES,
  META_LOG_LEVEL,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  META_STATELESS_KEYS,
  STATELESS_PROTOCOL_VERSIONS,
  TOOL_LIST_CACHE_SCOPE,
  TOOL_LIST_TTL_MS,
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

/**
 * `UnsupportedProtocolVersionError`, at the code 2026-07-28 renumbered it to.
 *
 * It is -32022, not the -32004 the draft used. That revision partitioned the
 * JSON-RPC implementation-defined range: `-32000` to `-32019` is grandfathered
 * and "new implementations **SHOULD NOT** use codes from this sub-range at
 * all", while `-32020` to `-32099` is "reserved for the MCP specification" and
 * implementations "**MUST NOT** emit any code from this sub-range that is not
 * defined by this specification". This is the only code from that range this
 * server emits, and it is emitted with the specified meaning.
 */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
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

/**
 * The handshake's version selection, drawn only from the revisions that *have*
 * a handshake.
 *
 * A client naming 2026-07-28 in `initialize` is answered with 2025-11-25 rather
 * than its own request. Echoing it would be this server promising a session
 * under the revision that abolished sessions — the client would then omit the
 * per-request `_meta` that revision requires and this server would read every
 * subsequent request as handshake-era. That is the one place backward
 * compatibility costs something: a stateless-capable client that opens with
 * `initialize` is served an older revision instead. The spec's own remedy is
 * the probe, and `server/discover` is implemented for exactly that.
 */
function negotiate(requested: unknown): string {
  return typeof requested === "string" && HANDSHAKE_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
}

// ── The stateless revision ───────────────────────────────────────────────────

/**
 * Whether a request carries stateless per-request metadata.
 *
 * The era selector is the spec's: "A dual-era server selects its behavior from
 * how the client opens ... A request carrying modern per-request `_meta` is
 * served statelessly according to this revision. An `initialize` request
 * selects legacy semantics." The test is the presence of any of the four
 * per-request protocol fields that revision defines, not of the protocol
 * version alone — a request that carries `clientCapabilities` and forgot the
 * version is still unmistakably a stateless request, and it must be told so
 * with a -32602 rather than handed a legacy-shaped success for a revision it
 * never asked for. It is deliberately *not* a test on the
 * `io.modelcontextprotocol/` prefix, which a handshake-era task-augmented
 * request may also carry; see `META_STATELESS_KEYS`. Whatever is or is not
 * there, the answer comes from this request only: "Servers **MUST NOT** rely on
 * prior requests over the same connection to establish context".
 */
function isStatelessRequest(params: unknown): boolean {
  if (!isRecord(params)) return false;
  const meta = params["_meta"];
  if (!isRecord(meta)) return false;
  return META_STATELESS_KEYS.some((key) => Object.prototype.hasOwnProperty.call(meta, key));
}

function metaOf(params: unknown): Record<string, unknown> {
  const meta = isRecord(params) ? params["_meta"] : undefined;
  return isRecord(meta) ? meta : {};
}

/** Every stateless result carries the server's identity and its type. */
function statelessResult(fields: Record<string, unknown>): Record<string, unknown> {
  return { resultType: "complete", ...fields, _meta: { [META_SERVER_INFO]: MCP_SERVER_INFO } };
}

/** The two hints a `CacheableResult` must carry. */
const CACHE_HINTS = { ttlMs: TOOL_LIST_TTL_MS, cacheScope: TOOL_LIST_CACHE_SCOPE } as const;

/**
 * Answers one request that declared a protocol version in `_meta`.
 *
 * WHAT IS NOT HERE. `ping`, `logging/setLevel` and
 * `notifications/roots/list_changed` were removed by this revision, and
 * `initialize` with it — none of them is dispatched below, so each falls to
 * "method not found", which is the truth under 2026-07-28. `ping` remains
 * answerable through the handshake path, where the revisions that define it
 * still live.
 *
 * WHAT THIS SERVER STILL DOES NOT EMIT. No `notifications/message`, on any
 * revision. The revision that moved log level onto `_meta` deprecated the
 * Logging feature in the same release — "New implementations **SHOULD NOT**
 * adopt it; existing implementations **SHOULD** migrate to logging to `stderr`
 * for stdio transports" — and this server already logs to stderr. So the
 * requirement that a server "**MUST NOT** emit `notifications/message` for a
 * request that does not include this field" holds by construction rather than
 * by a check, and a request that *does* set the field is answered with its
 * response and nothing else. An unrecognized level is still rejected: the
 * logging page asks for `-32602` there, and a value this server cannot name is
 * not a request it can claim to have understood.
 *
 * WHAT IS DELIBERATELY ABSENT. No `resultType: "input_required"`. That belongs
 * to the multi round-trip pattern, which replaces server-initiated requests —
 * and this server initiates none: it has no sampling, no elicitation, no roots,
 * and no waiver prompt an agent could be asked to answer. Likewise no
 * `subscriptions/listen` (nothing here changes while the process runs) and no
 * tasks extension (advertising an extension is a promise, and there is no
 * durable request behind it).
 */
async function handleStateless(
  method: string,
  id: JsonRpcId,
  params: unknown,
  requested: unknown,
  host: ToolHostRuntime,
): Promise<JsonRpcResponse> {
  // A version that is absent, or present but not a string, is a malformed
  // request rather than an unsupported revision: -32022 means "this version is
  // one I do not implement", and a missing member names no version at all. Both
  // fall under the same rule as any other required field — "A request missing
  // any required field is malformed; the server MUST reject it with JSON-RPC
  // error code -32602".
  if (typeof requested !== "string") {
    return fail(id, INVALID_PARAMS, `A stateless request must carry ${META_PROTOCOL_VERSION} in _meta as a protocol version string.`);
  }

  if (!STATELESS_PROTOCOL_VERSIONS.includes(requested)) {
    // "the server ... MUST respond with an UnsupportedProtocolVersionError
    // listing the versions it does support". `supported` names what *this*
    // channel can serve, not everything this server speaks: the client's rule
    // is to "select a mutually supported version from the `supported` list and
    // retry the request", and a handshake revision offered here would send it
    // round the same loop, since those revisions have no per-request form. The
    // full list — both eras — is what `server/discover` is for.
    return fail(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
      supported: STATELESS_PROTOCOL_VERSIONS,
      requested,
    });
  }

  const meta = metaOf(params);

  // "A request missing any required field is malformed; the server MUST reject
  // it with JSON-RPC error code -32602 (Invalid params)." Capabilities are
  // required; client info is not, and its absence is not a fault.
  if (!isRecord(meta[META_CLIENT_CAPABILITIES])) {
    return fail(id, INVALID_PARAMS, `A request under ${requested} must carry ${META_CLIENT_CAPABILITIES} in _meta.`);
  }

  const logLevel = meta[META_LOG_LEVEL];
  if (logLevel !== undefined && (typeof logLevel !== "string" || !LOG_LEVELS.includes(logLevel))) {
    return fail(id, INVALID_PARAMS, `${META_LOG_LEVEL} must be one of: ${LOG_LEVELS.join(", ")}.`);
  }

  if (method === "server/discover") {
    return ok(
      id,
      statelessResult({
        supportedVersions: STATELESS_PROTOCOL_VERSIONS,
        capabilities: MCP_SERVER_CAPABILITIES,
        ...CACHE_HINTS,
      }),
    );
  }

  if (method === "tools/list") return ok(id, statelessResult({ tools: listTools(), ...CACHE_HINTS }));

  if (method === "tools/call") {
    if (!isRecord(params)) return fail(id, INVALID_PARAMS, "tools/call requires a params object.");
    const name = params["name"];
    if (typeof name !== "string") return fail(id, INVALID_PARAMS, "tools/call requires a string name.");
    const outcome = await callTool(name, params["arguments"], host);
    return ok(id, statelessResult({ ...toolResultFor(outcome) }));
  }

  return fail(id, METHOD_NOT_FOUND, `Method ${JSON.stringify(method)} is not implemented by this server under ${requested}.`);
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

  // THE ERA BRANCH, AND THE ONE METHOD THAT DECIDES IT BY NAME. The spec gives
  // a dual-era server two selectors, not one: "A request carrying modern
  // per-request `_meta` is served statelessly according to this revision. An
  // `initialize` request selects legacy semantics." So `initialize` is answered
  // as a handshake first, whatever `_meta` it happens to carry — a client whose
  // transport attaches per-request metadata to everything it sends must still
  // be able to open with the handshake, or the fallback path the spec tells it
  // to take does not exist. Every other method takes the era from the request:
  // a declared protocol version means stateless, its absence means handshake.
  // Either way the decision is made per request and from the request alone — a
  // client may interleave both on one connection, and this server must not
  // infer the era from anything it remembers.
  if (method === "initialize") {
    session.protocolVersion = negotiate(isRecord(params) ? params["protocolVersion"] : undefined);
    return ok(id, {
      protocolVersion: session.protocolVersion,
      capabilities: MCP_SERVER_CAPABILITIES,
      serverInfo: MCP_SERVER_INFO,
    });
  }

  if (isStatelessRequest(params)) return handleStateless(method, id, params, metaOf(params)[META_PROTOCOL_VERSION], host);

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

/** The spelling the filesystem can vouch for: the realpath where it can answer, the spelling itself where it cannot. */
function canonicalEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

/**
 * Whether this module is the entry the process was started with.
 *
 * argv and `import.meta.url` may spell the same file differently: argv is the
 * caller's spelling, and Node builds the module URL from the realpath by
 * default but from the caller's spelling under `--preserve-symlinks-main`. So
 * each side is canonicalized independently and the canonical forms compared:
 * a symlinked spelling matches its realpath whenever the link can be read
 * (`/tmp` → `/private/tmp` on macOS, a client config's stored path, a pnpm
 * workspace link), and equal spellings still match when neither side resolves.
 *
 * What is NOT claimed: a symlink the filesystem cannot resolve cannot be seen
 * through, and the failing-exit-code floor below sits inside this guard, so an
 * under-match exits 0 in silence — the server exiting without ever serving,
 * a dead transport where the client expected one. The floor cannot be hoisted
 * above the guard: that would stamp a failing exit code on every process that
 * merely *imports* this module. And a non-`file:` module href (a bundled or
 * single-executable build) never matches — such a build must invoke `main`
 * explicitly.
 */
export function invokedDirectly(argvEntry: string | undefined, moduleHref: string): boolean {
  if (argvEntry === undefined) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleHref);
  } catch {
    return false;
  }
  return canonicalEntryPath(argvEntry) === canonicalEntryPath(modulePath);
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
