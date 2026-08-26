/**
 * The transport contract: framing, negotiation, and which failures belong on
 * which channel.
 *
 * The parity suite proves the tools; this proves the envelope they arrive in.
 * The rows that matter most are the ones separating the two error channels —
 * a request this server cannot run is a JSON-RPC error, and a tool call it ran
 * and refused is a tool result — because collapsing them is how a client comes
 * to believe a policy block was a transport hiccup.
 */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  HANDSHAKE_PROTOCOL_VERSIONS,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  MCP_STATELESS_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_LOG_LEVEL,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  PARSE_ERROR,
  STATELESS_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_LIST_CACHE_SCOPE,
  TOOL_LIST_TTL_MS,
  UNSUPPORTED_PROTOCOL_VERSION,
  createSession,
  encodeResponse,
  handleRpcLine,
  handleRpcMessage,
  serveStdio,
  type JsonRpcResponse,
  type ToolHostRuntime,
} from "./index.ts";

const host: ToolHostRuntime = { cwd: process.cwd(), env: {} };

async function answer(message: unknown): Promise<JsonRpcResponse | null> {
  return handleRpcMessage(message, host, createSession());
}

function request(method: string, params?: unknown, id: string | number = 1): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

/**
 * The per-request metadata a 2026-07-28 client sends. There is no handshake to
 * establish any of it, so every request carries it or is malformed.
 */
function statelessMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: MCP_STATELESS_PROTOCOL_VERSION,
    [META_CLIENT_INFO]: { name: "test-client", version: "1.0.0" },
    [META_CLIENT_CAPABILITIES]: {},
    ...overrides,
  };
}

function statelessRequest(
  method: string,
  params: Record<string, unknown> = {},
  meta: Record<string, unknown> = statelessMeta(),
  id: string | number = 1,
): Record<string, unknown> {
  return request(method, { ...params, _meta: meta }, id);
}

describe("initialize", () => {
  it("echoes a protocol version it supports and names the server", async () => {
    const response = await answer(request("initialize", { protocolVersion: "2024-11-05" }));
    expect(response?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: MCP_SERVER_INFO,
    });
  });

  it("answers with its own version when the client asks for one it does not speak", async () => {
    const response = await answer(request("initialize", { protocolVersion: "1999-01-01" }));
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  /**
   * 2025-03-26 is the one revision that requires a server to accept JSON-RPC
   * batches, and this server refuses every array. Advertising it would be a
   * promise the transport does not keep, so it is not on the list and a client
   * asking for it is answered with a revision where the refusal is true.
   */
  it("does not advertise the revision whose batching requirement it cannot meet", async () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain("2025-03-26");
    const response = await answer(request("initialize", { protocolVersion: "2025-03-26" }));
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  /**
   * 2025-11-25 is the newest handshake-based revision, so it is what the
   * handshake settles on when the client names nothing this server speaks.
   * Nothing in that revision is mandatory for a stdio, tools-only server —
   * icons are optional metadata, tasks are experimental, and the elicitation,
   * sampling and authorization changes are for features this server does not
   * implement — so speaking it is a matter of saying so truthfully.
   */
  it("settles on the newest handshake-based revision by default", async () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain("2025-11-25");
    const response = await answer(request("initialize", { protocolVersion: "1999-01-01" }));
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
  });

  it("still echoes every older handshake-based revision it advertises", async () => {
    for (const version of ["2025-11-25", "2025-06-18", "2024-11-05"]) {
      const response = await answer(request("initialize", { protocolVersion: version }));
      expect((response?.result as { protocolVersion: string }).protocolVersion).toBe(version);
    }
  });
});

describe("the two error channels", () => {
  it("reports an unimplemented method as a JSON-RPC error", async () => {
    const response = await answer(request("resources/list"));
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(response?.result).toBeUndefined();
  });

  it("reports params that are not params as a JSON-RPC error", async () => {
    expect((await answer(request("tools/call", { name: 7 })))?.error?.code).toBe(INVALID_PARAMS);
    expect((await answer(request("tools/call", "review-context")))?.error?.code).toBe(INVALID_PARAMS);
  });

  it("reports a message that is not a JSON-RPC 2.0 request as an invalid request", async () => {
    expect((await answer({ id: 1, method: "ping" }))?.error?.code).toBe(INVALID_REQUEST);
    expect((await answer({ jsonrpc: "2.0", id: 1 }))?.error?.code).toBe(INVALID_REQUEST);
    expect((await answer("not a message"))?.error?.code).toBe(INVALID_REQUEST);
  });

  it("refuses a batch rather than half-supporting it", async () => {
    const response = await answer([request("ping"), request("ping", undefined, 2)]);
    expect(response?.error?.code).toBe(INVALID_REQUEST);
  });

  it("reports undecodable bytes as a parse error without closing the session", async () => {
    const session = createSession();
    expect((await handleRpcLine("{ not json", host, session))?.error?.code).toBe(PARSE_ERROR);
    // The session survives: the next line is answered normally.
    expect((await handleRpcLine(JSON.stringify(request("ping")), host, session))?.result).toEqual({});
  });

  /**
   * SEP-1303 (2025-11-25, minor change 5): "Clarify that input validation
   * errors should be returned as Tool Execution Errors rather than Protocol
   * Errors to enable model self-correction." The revision's tools page keeps
   * "Input validation errors" under Tool Execution Errors, reported "in tool
   * results with `isError: true`".
   *
   * This server already reports a manifest argument of the wrong type that way
   * — it is the usage class, exit 2, rendered like every other blocker — and
   * this row is what keeps the two channels from being swapped later. The
   * malformed *manifest file* is the same story one layer down: `submit-evidence`
   * rejects it through the command core, so its rejection reaches the client as
   * a tool result too, never as a JSON-RPC error.
   */
  it("reports an input validation error as a tool execution error, per SEP-1303", async () => {
    const response = await answer(request("tools/call", { name: "submit-evidence", arguments: { manifest: 42 } }));
    expect(response?.error).toBeUndefined();
    const result = response?.result as { isError: boolean; structuredContent: { outcome: string; exitCode: number } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ outcome: "usage", exitCode: 2 });
  });

  it("reports a refused tool call as a tool result, not a protocol error", async () => {
    const response = await answer(request("tools/call", { name: "no-such-tool", arguments: {} }));
    expect(response?.error).toBeUndefined();
    const result = response?.result as { isError: boolean; structuredContent: { outcome: string; exitCode: number } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ outcome: "usage", exitCode: 2 });
  });
});

describe("requests and notifications", () => {
  it("never answers a message with no id member", async () => {
    expect(await answer({ jsonrpc: "2.0", method: "ping" })).toBeNull();
    expect(await answer({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("answers a message whose id is explicitly null rather than leaving it hanging", async () => {
    const response = await answer({ jsonrpc: "2.0", id: null, method: "ping" });
    expect(response).not.toBeNull();
    expect(response?.id).toBeNull();
    expect(response?.result).toEqual({});
  });

  /**
   * The shape of the message decides whether it is answered — never the method
   * name. A client that sends `notifications/initialized` *with* an id has sent
   * a request, and a request that reaches this server and produces nothing is a
   * client waiting forever on a stream that will never carry its id.
   */
  it("answers an id-bearing notifications/initialized instead of swallowing it", async () => {
    const response = await answer(request("notifications/initialized", undefined, "n"));
    expect(response).not.toBeNull();
    expect(response?.id).toBe("n");
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  it("answers every request in a session that includes one, id for id", async () => {
    // Nine requests in, nine responses out. The id-bearing
    // `notifications/initialized` in the middle is the one that used to vanish.
    const messages = [
      request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION }, 1),
      request("notifications/initialized", undefined, 2),
      request("ping", undefined, 3),
      request("tools/list", undefined, 4),
      request("ping", undefined, 5),
      request("tools/call", { name: "no-such-tool", arguments: {} }, 6),
      request("ping", undefined, 7),
      request("resources/list", undefined, 8),
      request("ping", undefined, 9),
    ];
    const written: string[] = [];
    await serveStdio(Readable.from([`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`]), (line) => written.push(line), host);
    expect(written).toHaveLength(9);
    expect(written.map((line) => (JSON.parse(line) as JsonRpcResponse).id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("refuses a request whose id is neither a string, a number, nor null — without running it", async () => {
    let loads = 0;
    const spy: ToolHostRuntime = {
      cwd: process.cwd(),
      env: {},
      loadConfig: async () => {
        loads += 1;
        throw new Error("the config loader must not be reached by an uncorrelatable request");
      },
    };
    const call = (id: unknown): Record<string, unknown> => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "submit-evidence", arguments: { manifest: "/tmp/manifest.json" } },
    });

    const refused = await handleRpcMessage(call({ a: 1 }), spy, createSession());
    expect(refused?.error?.code).toBe(INVALID_REQUEST);
    expect(refused?.id).toBeNull();
    expect(refused?.result).toBeUndefined();
    // A tool call is side-effecting. An id this server cannot echo is a result
    // the client cannot correlate, so the call must not happen at all.
    expect(loads, "an uncorrelatable request must not reach the command core").toBe(0);

    // The control: the same call with a usable id does reach it.
    const ran = await handleRpcMessage(call(1), spy, createSession());
    expect(ran?.error).toBeUndefined();
    expect(loads).toBe(1);
  });
});

describe("the lifecycle", () => {
  /**
   * The deliberate absence of a handshake gate, witnessed so it stays a
   * decision rather than an oversight. The spec's ordering rule is a SHOULD on
   * the client; a server-side gate would refuse a pipelining client the spec
   * allows to be answered, and would invent a rejection nothing here needs.
   */
  it("answers tools/list and tools/call without waiting for the handshake", async () => {
    const listed = await answer(request("tools/list"));
    expect(listed?.result).toBeDefined();
    const called = await answer(request("tools/call", { name: "no-such-tool", arguments: {} }, 2));
    expect(called?.result).toBeDefined();
  });

  it("carries no session state nothing reads", () => {
    // `initialized` was written on every handshake and read by no decision.
    expect(createSession()).toEqual({ protocolVersion: MCP_PROTOCOL_VERSION });
  });
});

describe("the tool list", () => {
  it("advertises the two tools with their schemas", async () => {
    const response = await answer(request("tools/list"));
    const tools = (response?.result as { tools: readonly { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["review-context", "submit-evidence"]);
  });
});

describe("framing", () => {
  it("keeps a multi-line rendered result on exactly one line", async () => {
    const response = await answer(request("tools/call", { name: "submit-evidence", arguments: { manifest: 42 } }));
    const text = (response?.result as { content: readonly { text: string }[] }).content[0]?.text ?? "";
    // The rendered blocker really is multi-line — otherwise this proves nothing.
    expect(text).toContain("\n");
    const encoded = encodeResponse(response as JsonRpcResponse);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.slice(0, -1)).not.toContain("\n");
  });
});

describe("the loop", () => {
  it("answers requests in order and never answers a notification", async () => {
    const lines = [
      JSON.stringify(request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION }, "a")),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "",
      JSON.stringify(request("tools/list", undefined, "b")),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "b" } }),
      JSON.stringify(request("ping", undefined, "c")),
    ];
    const written: string[] = [];
    await serveStdio(Readable.from([`${lines.join("\n")}\n`]), (line) => written.push(line), host);

    expect(written).toHaveLength(3);
    expect(written.map((line) => (JSON.parse(line) as JsonRpcResponse).id)).toEqual(["a", "b", "c"]);
    expect(written.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n"))).toBe(true);
  });
});

/**
 * 2026-07-28 is not an increment on the handshake — it removes the handshake.
 * Version, identity and capabilities move onto every request's `_meta`; results
 * grow a `resultType`; list results grow caching hints; `server/discover`
 * becomes mandatory; `ping` is gone. These rows pin that envelope, and the ones
 * after them pin that the older envelope did not change underneath it.
 */
describe("the stateless revision", () => {
  it("advertises 2026-07-28 alongside every handshake-based revision", () => {
    expect(MCP_STATELESS_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(STATELESS_PROTOCOL_VERSIONS).toEqual(["2026-07-28"]);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2026-07-28", "2025-11-25", "2025-06-18", "2024-11-05"]);
    expect(HANDSHAKE_PROTOCOL_VERSIONS).toEqual(["2025-11-25", "2025-06-18", "2024-11-05"]);
  });

  /**
   * "Servers **MUST** implement [`server/discover`]" — versioning, Protocol
   * Version Negotiation. On stdio it is also the client's era probe: a
   * `DiscoverResult` says "modern", anything else says "legacy".
   */
  it("implements server/discover with its versions, capabilities and identity", async () => {
    const response = await answer(statelessRequest("server/discover"));
    expect(response?.error).toBeUndefined();
    expect(response?.result).toEqual({
      resultType: "complete",
      supportedVersions: STATELESS_PROTOCOL_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      ttlMs: TOOL_LIST_TTL_MS,
      cacheScope: TOOL_LIST_CACHE_SCOPE,
      _meta: { [META_SERVER_INFO]: MCP_SERVER_INFO },
    });
  });

  /**
   * The probe answer names only the revisions a client can select and *keep
   * going* with, which on this channel is the stateless one.
   *
   * `supportedVersions` is not a catalogue: "Protocol versions the server
   * supports. The client should choose one of these for subsequent requests",
   * and on stdio, "The server returns a `DiscoverResult`: the server is modern.
   * Select a mutually supported version from `supportedVersions` and continue."
   * There is no branch back to `initialize` from there — a `DiscoverResult`
   * arriving is itself the signal to stay modern. So a handshake revision named
   * here is a trap: a conforming client selects 2024-11-05, continues modern,
   * and earns a guaranteed -32022. It is the same loop-avoidance that keeps the
   * error's `supported` list narrow, and the two fields must agree.
   */
  it("names no revision in the probe answer that the stateless channel cannot then serve", async () => {
    const response = await answer(statelessRequest("server/discover"));
    const versions = (response?.result as { supportedVersions: readonly string[] }).supportedVersions;
    expect(versions).toEqual(STATELESS_PROTOCOL_VERSIONS);
    for (const version of HANDSHAKE_PROTOCOL_VERSIONS) expect(versions).not.toContain(version);

    // The field means what it says: every version it names is servable here.
    for (const version of versions) {
      const served = await answer(statelessRequest("tools/list", {}, statelessMeta({ [META_PROTOCOL_VERSION]: version })));
      expect(served?.error, `server/discover named ${version} but the stateless channel refused it`).toBeUndefined();
    }
  });

  /**
   * "If the server does not implement the requested version ... it **MUST**
   * respond with an `UnsupportedProtocolVersionError` listing the versions it
   * does support" — and the code is -32022, the renumbered slot in the
   * `-32020`..`-32099` range the specification reserved for itself.
   */
  it("rejects an unsupported per-request version with -32022 and the versions this channel serves", async () => {
    const response = await answer(statelessRequest("tools/list", {}, statelessMeta({ [META_PROTOCOL_VERSION]: "1900-01-01" })));
    expect(response?.result).toBeUndefined();
    expect(response?.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(UNSUPPORTED_PROTOCOL_VERSION).toBe(-32022);
    expect(response?.error?.data).toEqual({ supported: STATELESS_PROTOCOL_VERSIONS, requested: "1900-01-01" });
  });

  /**
   * A handshake revision named in per-request `_meta` is the same rejection.
   * 2025-11-25 has no stateless form — its version lives in an `initialize`
   * result, not in `_meta` — so serving one statelessly would be a revision
   * this server invented. The error names only what this channel can serve,
   * which is what makes the client's "select a mutually supported version from
   * the `supported` list and retry the request" terminate.
   */
  it("refuses to serve a handshake revision through the stateless channel", async () => {
    const response = await answer(statelessRequest("tools/list", {}, statelessMeta({ [META_PROTOCOL_VERSION]: "2025-11-25" })));
    expect(response?.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(response?.error?.data).toEqual({ supported: STATELESS_PROTOCOL_VERSIONS, requested: "2025-11-25" });
  });

  /**
   * "A request missing any required field is malformed; the server **MUST**
   * reject it with JSON-RPC error code `-32602` (Invalid params)."
   * `clientCapabilities` is required; `clientInfo` is not.
   */
  it("rejects a stateless request that omits the required client capabilities", async () => {
    const meta = statelessMeta();
    delete meta[META_CLIENT_CAPABILITIES];
    const response = await answer(statelessRequest("tools/list", {}, meta));
    expect(response?.result).toBeUndefined();
    expect(response?.error?.code).toBe(INVALID_PARAMS);
  });

  it("serves a stateless request that omits the optional client info", async () => {
    const meta = statelessMeta();
    delete meta[META_CLIENT_INFO];
    const response = await answer(statelessRequest("tools/list", {}, meta));
    expect(response?.error).toBeUndefined();
  });

  /**
   * "The `result` **MUST** include a `resultType` field", and `"complete"`
   * "indicates the request completed successfully and the result contains the
   * final content". This server never returns `"input_required"`: it issues no
   * server-initiated requests, so the multi round-trip pattern has nothing to
   * ask for.
   */
  it("stamps resultType complete on every stateless result", async () => {
    for (const message of [
      statelessRequest("server/discover"),
      statelessRequest("tools/list"),
      statelessRequest("tools/call", { name: "no-such-tool", arguments: {} }),
    ]) {
      const response = await answer(message);
      expect((response?.result as { resultType: string }).resultType).toBe("complete");
    }
  });

  /**
   * "Servers **SHOULD** include the following `io.modelcontextprotocol/*` field
   * in every result's `_meta` ... to identify themselves without relying on any
   * prior connection state." With the handshake gone, this is the only place a
   * client learns who answered.
   */
  it("identifies itself in every stateless result's _meta", async () => {
    for (const message of [
      statelessRequest("server/discover"),
      statelessRequest("tools/list"),
      statelessRequest("tools/call", { name: "no-such-tool", arguments: {} }),
    ]) {
      const response = await answer(message);
      expect((response?.result as { _meta: Record<string, unknown> })._meta).toEqual({ [META_SERVER_INFO]: MCP_SERVER_INFO });
    }
  });

  /**
   * "Servers MUST include caching hints on results with `resultType:
   * "complete"` returned by ... `tools/list`", and "Servers **MUST** provide a
   * `ttlMs` value that is `>= 0`". `"public"` is the honest scope: this list is
   * two fixed tools, identical for every caller, carrying no user data.
   */
  it("carries caching hints on the stateless tools/list result", async () => {
    const response = await answer(statelessRequest("tools/list"));
    const result = response?.result as { ttlMs: number; cacheScope: string; tools: readonly unknown[] };
    expect(result.ttlMs).toBe(TOOL_LIST_TTL_MS);
    expect(TOOL_LIST_TTL_MS).toBeGreaterThanOrEqual(0);
    expect(result.cacheScope).toBe("public");
    expect(TOOL_LIST_CACHE_SCOPE).toBe("public");
  });

  /** "Remove `ping`, `logging/setLevel`, and `notifications/roots/list_changed`." */
  it("does not answer ping under the revision that removed it", async () => {
    const response = await answer(statelessRequest("ping"));
    expect(response?.result).toBeUndefined();
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  /**
   * The spec gives a dual-era server two selectors, and `initialize` is the
   * second one: "An `initialize` request selects legacy semantics." So an
   * `initialize` is answered as a handshake even when it carries stateless
   * `_meta` — a client whose transport attaches per-request metadata to every
   * outgoing message must still be able to open with the handshake, or the
   * fallback the spec tells it to take does not exist for it. It is negotiated
   * down to the newest revision that actually has a handshake.
   */
  it("answers initialize as a handshake even when the request carries stateless metadata", async () => {
    const response = await answer(statelessRequest("initialize", { protocolVersion: MCP_STATELESS_PROTOCOL_VERSION }));
    expect(response?.error).toBeUndefined();
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  /**
   * A declared version that is not a string is a malformed request rather than
   * an unsupported revision. -32022 says "I do not implement that version"; a
   * number is not a version at all, and answering it that way would invite a
   * client to retry with something from a `supported` list that was never the
   * problem.
   */
  it("rejects a declared protocol version that is not a string with -32602", async () => {
    for (const bad of [5, null, {}]) {
      const response = await answer(statelessRequest("tools/list", {}, statelessMeta({ [META_PROTOCOL_VERSION]: bad })));
      expect(response?.result).toBeUndefined();
      expect(response?.error?.code).toBe(INVALID_PARAMS);
    }
  });

  /**
   * A `_meta` carrying a reserved `io.modelcontextprotocol/` key but no
   * protocol version is a malformed stateless request, not a handshake one.
   *
   * The era selector is "A request carrying modern per-request `_meta`", and
   * these keys are exactly that: no handshake revision defines any of them, so
   * their presence identifies the era on its own. Once the request is modern,
   * "A request missing any required field is malformed; the server **MUST**
   * reject it with JSON-RPC error code `-32602`" applies — and the alternative
   * is worse than an error: the client gets a legacy-shaped success with no
   * `resultType` and no `_meta`, which is this server answering a 2026-07-28
   * request in a revision the client never asked for.
   */
  it("rejects a request whose _meta is modern but declares no protocol version", async () => {
    for (const key of [META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_LOG_LEVEL]) {
      const response = await answer(request("tools/list", { _meta: { [key]: key === META_LOG_LEVEL ? "debug" : {} } }));
      expect(response?.result, `a _meta carrying ${key} must not be served as a handshake request`).toBeUndefined();
      expect(response?.error?.code).toBe(INVALID_PARAMS);
    }
  });

  /**
   * The counterweight, and the reason the rule keys on the reserved prefix
   * rather than on "`_meta` is present at all". `progressToken` is a `_meta`
   * key the handshake revisions have always defined, and the OpenTelemetry
   * keys are carved out of the prefix rule by the spec itself. A request
   * carrying only those is a handshake request and must be answered exactly as
   * it was before this server knew 2026-07-28 existed.
   */
  it("still serves a handshake request whose _meta carries only handshake-era keys", async () => {
    const bare = encodeResponse((await answer(request("tools/list"))) as JsonRpcResponse);
    for (const meta of [{ progressToken: "p-1" }, { traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01" }, {}]) {
      const response = await answer(request("tools/list", { _meta: meta }));
      expect(response?.error, `a _meta of ${JSON.stringify(meta)} must stay handshake-era`).toBeUndefined();
      // Byte-identical to the same request with no `_meta` at all.
      expect(encodeResponse(response as JsonRpcResponse)).toBe(bare);
    }
  });

  /**
   * "The server **MUST NOT** emit `notifications/message` for a request that
   * does not include this field." This server emits none at all — it declares
   * no `logging` capability, and the revision that introduced the field
   * deprecated the feature in the same breath, directing stdio servers to
   * stderr. The row proves the stronger property: one request in, one response
   * out, nothing else on the wire.
   */
  it("writes no notifications/message for a request that set no log level", async () => {
    const written: string[] = [];
    await serveStdio(Readable.from([`${JSON.stringify(statelessRequest("tools/list"))}\n`]), (line) => written.push(line), host);
    expect(written).toHaveLength(1);
    expect(written.every((line) => !line.includes("notifications/message"))).toBe(true);
  });

  it("writes no notifications/message even for a request that did set one", async () => {
    const written: string[] = [];
    const message = statelessRequest("tools/list", {}, statelessMeta({ [META_LOG_LEVEL]: "debug" }));
    await serveStdio(Readable.from([`${JSON.stringify(message)}\n`]), (line) => written.push(line), host);
    expect(written).toHaveLength(1);
    expect((JSON.parse(written[0] as string) as JsonRpcResponse).error).toBeUndefined();
  });

  /**
   * "If the `io.modelcontextprotocol/logLevel` value carried in a request's
   * `_meta` is not a recognized log level, the server **SHOULD** reject that
   * request with ... `-32602` (Invalid params)." A value this server cannot
   * name is a request it cannot claim to have understood.
   */
  it("rejects an unrecognized log level with -32602", async () => {
    const message = statelessRequest("tools/list", {}, statelessMeta({ [META_LOG_LEVEL]: "chatty" }));
    const response = await answer(message);
    expect(response?.result).toBeUndefined();
    expect(response?.error?.code).toBe(INVALID_PARAMS);
  });
});

/**
 * The handshake era, unchanged. A revision that removed the handshake cannot be
 * allowed to leak its shapes into the revisions that still have one: a client
 * negotiating 2024-11-05 must read exactly the bytes it read before this
 * revision existed.
 */
describe("dual-era coexistence", () => {
  it("keeps ping for the revisions that still have it", async () => {
    expect((await answer(request("ping")))?.result).toEqual({});
  });

  it("does not offer server/discover to a client that opened with the handshake", async () => {
    const initialized = await answer(request("initialize", { protocolVersion: "2024-11-05" }));
    expect(initialized?.error).toBeUndefined();
    const response = await answer(request("server/discover"));
    expect(response?.result).toBeUndefined();
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  /**
   * A request carrying no stateless protocol version is a handshake-era
   * request, whatever it is named — one rule, no per-method exception. Under
   * every revision this server reaches through `initialize`, `server/discover`
   * genuinely does not exist, so "method not found" is the true answer.
   *
   * The spec leaves this ambiguous: the missing-required-field rule would say
   * `-32602`, while the stdio backward-compatibility rules observe that legacy
   * servers answer an unknown pre-`initialize` request with "implementation-
   * defined errors (commonly `-32601` or `-32602`)" and require that a client's
   * fallback "**MUST NOT** be keyed to one specific error code". Both codes
   * therefore drive a dual-era client to the same `initialize` fallback, so the
   * choice is free and the uniform era rule wins it.
   */
  it("reports a server/discover with no per-request metadata as a method it does not have", async () => {
    const response = await answer(request("server/discover"));
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  /**
   * `resultType`, `_meta.serverInfo` and the caching hints are 2026-07-28
   * shapes. Emitting them to a handshake client would be this server claiming a
   * revision that client did not negotiate.
   */
  it("stamps no stateless shapes on a handshake-era result", async () => {
    const listed = (await answer(request("tools/list")))?.result as Record<string, unknown>;
    expect(listed["resultType"]).toBeUndefined();
    expect(listed["_meta"]).toBeUndefined();
    expect(listed["ttlMs"]).toBeUndefined();
    expect(listed["cacheScope"]).toBeUndefined();
    expect(Object.keys(listed)).toEqual(["tools"]);
  });

  /**
   * An `initialize` naming the stateless revision is answered with the newest
   * revision that actually has a handshake. Echoing 2026-07-28 would promise a
   * session under the revision that abolished sessions.
   */
  it("never negotiates the stateless revision through the handshake", async () => {
    const response = await answer(request("initialize", { protocolVersion: MCP_STATELESS_PROTOCOL_VERSION }));
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  /**
   * Byte-parity is the contract the MCP surface is built on, and a revision is
   * not allowed to be the thing that breaks it: the text an agent reads for the
   * same call must be the same text on every revision this server speaks. Only
   * the envelope around it differs.
   */
  it("returns byte-identical tool text on every revision it speaks", async () => {
    const call = { name: "submit-evidence", arguments: { manifest: 42 } };
    const payloadOf = (response: JsonRpcResponse | null): Record<string, unknown> => {
      const result = response?.result as Record<string, unknown>;
      return { content: result["content"], isError: result["isError"], structuredContent: result["structuredContent"] };
    };

    // Each handshake revision reached the way a client of that revision reaches
    // it: negotiate first, then call on the same session.
    const perRevision: Record<string, Record<string, unknown>> = {};
    for (const version of HANDSHAKE_PROTOCOL_VERSIONS) {
      const session = createSession();
      const negotiated = await handleRpcMessage(request("initialize", { protocolVersion: version }), host, session);
      expect((negotiated?.result as { protocolVersion: string }).protocolVersion).toBe(version);
      perRevision[version] = payloadOf(await handleRpcMessage(request("tools/call", call, 2), host, session));
    }
    for (const version of STATELESS_PROTOCOL_VERSIONS) {
      const meta = statelessMeta({ [META_PROTOCOL_VERSION]: version });
      perRevision[version] = payloadOf(await answer(statelessRequest("tools/call", call, meta)));
    }

    expect(Object.keys(perRevision).sort()).toEqual([...SUPPORTED_PROTOCOL_VERSIONS].sort());
    const [first, ...rest] = SUPPORTED_PROTOCOL_VERSIONS;
    const baseline = perRevision[first as string];
    // The rendered text really is multi-line, so this compares something.
    expect(JSON.stringify(baseline)).toContain("\\n");
    for (const version of rest) {
      expect(perRevision[version], `${version} diverged from ${first}`).toEqual(baseline);
    }
  });

  /**
   * The era is decided per request, by whether the request carries a stateless
   * protocol version — never by anything remembered from an earlier one. A
   * stateless request after a handshake is still stateless, and a handshake
   * client is still served after one.
   */
  it("decides the era per request, not per connection", async () => {
    const session = createSession();
    const handshaken = await handleRpcMessage(request("initialize", { protocolVersion: "2024-11-05" }), host, session);
    expect(handshaken?.error).toBeUndefined();

    const stateless = await handleRpcMessage(statelessRequest("tools/list", {}, statelessMeta(), 2), host, session);
    expect((stateless?.result as { resultType: string }).resultType).toBe("complete");

    const back = await handleRpcMessage(request("tools/list", undefined, 3), host, session);
    expect((back?.result as Record<string, unknown>)["resultType"]).toBeUndefined();
    expect(session.protocolVersion).toBe("2024-11-05");
  });
});
