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
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  PARSE_ERROR,
  SUPPORTED_PROTOCOL_VERSIONS,
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
