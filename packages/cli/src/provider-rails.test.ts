import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  consumeProviderRailMessages,
  invokeProviderRail,
  openProviderRailProcess,
  type ProviderRailMessage,
  type ProviderRailSession,
} from "./provider-rails.ts";

interface ContractFixture {
  readonly attempts: Readonly<Record<string, { readonly requestId?: string; readonly cancellationAccepted?: boolean }>>;
  readonly cases: readonly {
    readonly id: string;
    readonly outbound: readonly unknown[];
    readonly interrupted?: boolean;
    readonly afterInterruption?: readonly unknown[];
    readonly expected: {
      readonly consumer: {
        readonly status: string;
        readonly acceptedCount: number;
        readonly duplicateCount: number;
        readonly rejectedCount: number;
      };
    };
  }[];
  readonly contractVersion: string;
}

const fixturePath = path.resolve(import.meta.dirname, "../fixtures/delivery-provider-rails-v1.json");
const contractRoot = path.resolve(import.meta.dirname, "../../../docs/contracts");

async function contractFixture(): Promise<ContractFixture> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as ContractFixture;
}

function scriptedSession(messages: readonly unknown[], options: { readonly crashAfter?: number } = {}): ProviderRailSession & { readonly sent: ProviderRailMessage[] } {
  const sent: ProviderRailMessage[] = [];
  let index = 0;
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
    async receive() {
      if (options.crashAfter !== undefined && index >= options.crashAfter) return null;
      const message = messages[index];
      index += 1;
      return message ?? null;
    },
    async close() {},
  };
}

describe("delivery-provider rails conformance", () => {
  it("pins the exact merged contract artifacts", async () => {
    const artifacts = [
      [path.join(contractRoot, "delivery-provider-rails-v1.md"), "ffeb3f5fe5baa4f288601e7550b06e1bff36f5160fc0ab48059ea403ed5b1c1e"],
      [path.join(contractRoot, "delivery-provider-rails.schema.json"), "7242d88fadc5087b1d63e0065565cd6e272225b2a2240c14de2fe4db305ea0e6"],
      [fixturePath, "1ceb7d7e2043d71f7dea0d95ba2dcb97d2977c56d0045a7001c44eb777dbb2bf"],
    ] as const;
    for (const [artifact, expected] of artifacts) {
      const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
      expect(digest, artifact).toBe(expected);
    }
  });

  it("matches every shared consumer vector", async () => {
    const fixture = await contractFixture();
    expect(fixture.contractVersion).toBe("delivery-provider-rails/1");

    for (const scenario of fixture.cases) {
      const attempt = fixture.attempts[scenario.id] ?? {};
      const actual = consumeProviderRailMessages(scenario.outbound, {
        ...(attempt.requestId === undefined ? {} : { requestId: attempt.requestId }),
        cancellationAccepted: attempt.cancellationAccepted === true,
        interrupted: scenario.interrupted === true,
        afterInterruption: scenario.afterInterruption ?? [],
      });
      expect(
        {
          status: actual.status,
          acceptedCount: actual.acceptedCount,
          duplicateCount: actual.duplicateCount,
          rejectedCount: actual.rejectedCount,
        },
        scenario.id,
      ).toEqual(scenario.expected.consumer);
    }
  });
});

describe("provider invocation lifecycle", () => {
  const negotiation = {
    kind: "negotiation",
    outcome: "supported",
    selectedVersion: "delivery-provider-rails/1",
    supportedVersions: ["delivery-provider-rails/1"],
  } as const;

  function terminal(outcome: "success" | "blocked" | "failed" | "cancelled" | "indeterminate", result?: Record<string, unknown>) {
    return {
      kind: "terminal",
      outcome,
      requestId: "request-one",
      sequence: 1,
      summary: `${outcome} terminal`,
      version: "delivery-provider-rails/1",
      ...(result === undefined ? {} : { result }),
    } as const;
  }

  for (const outcome of ["blocked", "failed", "cancelled", "indeterminate"] as const) {
    it(`fails closed on terminal ${outcome}`, async () => {
      const session = scriptedSession([negotiation, terminal(outcome)]);
      const result = await invokeProviderRail(
        {
          providerId: "review.provider",
          requestId: "request-one",
          idempotencyKey: "attempt-one",
          payload: {},
          requiresEvidence: false,
        },
        { open: async () => session },
      );

      expect(result.kind).toBe(outcome === "cancelled" ? "interrupted" : "blocked");
      if (result.kind === "blocked") expect(result.blockers[0]?.code).toBe(`provider_rail_${outcome}`);
    });
  }

  it("negotiates before sending a request and maps success to one existing live result", async () => {
    const session = scriptedSession([negotiation, terminal("success")]);
    const result = await invokeProviderRail(
      {
        providerId: "review.provider",
        requestId: "request-one",
        idempotencyKey: "attempt-one",
        payload: { objective: "Review this candidate" },
        requiresEvidence: false,
      },
      { open: async () => session },
    );

    expect(session.sent.map((message) => message.kind)).toEqual(["negotiate", "request"]);
    expect(result).toMatchObject({
      kind: "success",
      liveResult: { providerId: "review.provider", runId: "request-one", status: "green", findings: [] },
    });
  });

  it("fails closed when the provider rejects the contract version", async () => {
    const session = scriptedSession([
      { kind: "negotiation", outcome: "unsupported", selectedVersion: null, supportedVersions: ["delivery-provider-rails/1"] },
    ]);
    const result = await invokeProviderRail(
      { providerId: "review.provider", requestId: "request-one", idempotencyKey: "attempt-one", payload: {}, requiresEvidence: false },
      { open: async () => session },
    );
    expect(result).toMatchObject({ kind: "blocked", status: "unsupported" });
    if (result.kind === "blocked") expect(result.blockers[0]?.code).toBe("provider_rail_unsupported");
  });

  it("closes a provider crash before terminal as indeterminate", async () => {
    const session = scriptedSession([
      negotiation,
      { kind: "progress", requestId: "request-one", sequence: 1, summary: "started", version: "delivery-provider-rails/1" },
    ]);
    const result = await invokeProviderRail(
      { providerId: "review.provider", requestId: "request-one", idempotencyKey: "attempt-one", payload: {}, requiresEvidence: false },
      { open: async () => session },
    );
    expect(result).toMatchObject({ kind: "blocked", status: "indeterminate" });
    if (result.kind === "blocked") expect(result.blockers[0]?.code).toBe("provider_rail_indeterminate");
  });

  it("sends cancellation on interruption and never accepts a late success", async () => {
    const controller = new AbortController();
    const session = scriptedSession([
      negotiation,
      { kind: "progress", requestId: "request-one", sequence: 1, summary: "started", version: "delivery-provider-rails/1" },
      { kind: "terminal", outcome: "success", requestId: "request-one", sequence: 2, summary: "too late", version: "delivery-provider-rails/1" },
    ]);
    const receive = session.receive.bind(session);
    session.receive = async () => {
      const message = await receive();
      if ((message as { kind?: string } | null)?.kind === "progress") controller.abort();
      return message;
    };
    const result = await invokeProviderRail(
      { providerId: "review.provider", requestId: "request-one", idempotencyKey: "attempt-one", payload: {}, requiresEvidence: false },
      { open: async () => session, signal: controller.signal, cancellationId: "cancel-one" },
    );
    expect(session.sent.map((message) => message.kind)).toEqual(["negotiate", "request", "cancel"]);
    expect(result).toMatchObject({ kind: "interrupted", status: "indeterminate" });
  });

  it.skipIf(process.platform === "win32")("bounds stalled real-process negotiation and escalates ignored SIGTERM", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "provider-rail-stall-"));
    const marker = path.join(dir, "signals.txt");
    const script = `
      const fs = require("node:fs");
      const marker = process.argv[1];
      process.on("SIGTERM", () => fs.appendFileSync(marker, "term\\n"));
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const result = await invokeProviderRail(
      { providerId: "review.provider", requestId: "request-one", idempotencyKey: "attempt-one", payload: {}, requiresEvidence: false },
      {
        open: () => openProviderRailProcess({ command: [process.execPath, "-e", script, marker], cwd: dir, env: process.env }),
        deadlineMs: 500,
        terminationGraceMs: 100,
      },
    );
    expect(result).toMatchObject({ kind: "blocked", status: "indeterminate" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await readFile(marker, "utf8")).toContain("term");
    await rm(dir, { recursive: true, force: true });
  }, 5_000);

  it.skipIf(process.platform === "win32")("cancels an aborted real process stalled before terminal and awaits its closure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "provider-rail-abort-"));
    const marker = path.join(dir, "events.txt");
    const script = `
      const fs = require("node:fs");
      const readline = require("node:readline");
      const marker = process.argv[1];
      process.on("SIGTERM", () => fs.appendFileSync(marker, "term\\n"));
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.kind === "negotiate") process.stdout.write(JSON.stringify({ kind: "negotiation", outcome: "supported", selectedVersion: "delivery-provider-rails/1", supportedVersions: ["delivery-provider-rails/1"] }) + "\\n");
        if (message.kind === "cancel") fs.appendFileSync(marker, "cancel\\n");
      });
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const result = await invokeProviderRail(
      { providerId: "review.provider", requestId: "request-one", idempotencyKey: "attempt-one", payload: {}, requiresEvidence: false },
      {
        open: () => openProviderRailProcess({ command: [process.execPath, "-e", script, marker], cwd: dir, env: process.env }),
        signal: controller.signal,
        deadlineMs: 2_000,
        terminationGraceMs: 100,
      },
    );
    expect(result).toMatchObject({ kind: "interrupted", status: "indeterminate" });
    expect(await readFile(marker, "utf8")).toContain("cancel");
    await rm(dir, { recursive: true, force: true });
  }, 5_000);

  it.skipIf(process.platform === "win32")("expires a negotiated real process that never emits a terminal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "provider-rail-no-terminal-"));
    const marker = path.join(dir, "events.txt");
    const script = `
      const fs = require("node:fs");
      const readline = require("node:readline");
      const marker = process.argv[1];
      process.on("SIGTERM", () => {});
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.kind === "negotiate") process.stdout.write(JSON.stringify({ kind: "negotiation", outcome: "supported", selectedVersion: "delivery-provider-rails/1", supportedVersions: ["delivery-provider-rails/1"] }) + "\\n");
        if (message.kind === "cancel") fs.appendFileSync(marker, "cancel\\n");
      });
      setInterval(() => {}, 1000);
    `;
    const result = await invokeProviderRail(
      { providerId: "review.provider", requestId: "request-one", idempotencyKey: "attempt-one", payload: {}, requiresEvidence: false },
      {
        open: () => openProviderRailProcess({ command: [process.execPath, "-e", script, marker], cwd: dir, env: process.env }),
        deadlineMs: 750,
        terminationGraceMs: 100,
      },
    );
    expect(result).toMatchObject({ kind: "blocked", status: "indeterminate" });
    expect(await readFile(marker, "utf8")).toContain("cancel");
    await rm(dir, { recursive: true, force: true });
  }, 5_000);

  it.skipIf(process.platform === "win32")("bounds a real provider that never reads a request write", async () => {
    const script = `
      process.on("SIGTERM", () => {});
      process.stdout.write(JSON.stringify({ kind: "negotiation", outcome: "supported", selectedVersion: "delivery-provider-rails/1", supportedVersions: ["delivery-provider-rails/1"] }) + "\\n");
      setInterval(() => {}, 1000);
    `;
    const result = await invokeProviderRail(
      {
        providerId: "review.provider",
        requestId: "request-one",
        idempotencyKey: "attempt-one",
        payload: { blockedWrite: "x".repeat(8 * 1024 * 1024) },
        requiresEvidence: false,
      },
      {
        open: () => openProviderRailProcess({ command: [process.execPath, "-e", script], cwd: process.cwd(), env: process.env }),
        deadlineMs: 500,
        terminationGraceMs: 100,
      },
    );
    expect(result).toMatchObject({ kind: "blocked", status: "indeterminate" });
  }, 5_000);
});

describe("green-claim publication", () => {
  const negotiation = {
    kind: "negotiation",
    outcome: "supported",
    selectedVersion: "delivery-provider-rails/1",
    supportedVersions: ["delivery-provider-rails/1"],
  } as const;
  const success = {
    kind: "terminal",
    outcome: "success",
    requestId: "request-one",
    sequence: 1,
    summary: "green",
    version: "delivery-provider-rails/1",
    result: { manifestPath: "/allocated/run/manifest.json" },
  } as const;

  it("does not expose a green result when retained evidence publication fails", async () => {
    const publishManifest = vi.fn(async () => {
      throw new Error("injected crash before claim link");
    });
    const result = await invokeProviderRail(
      {
        providerId: "review.provider",
        requestId: "request-one",
        idempotencyKey: "attempt-one",
        payload: {},
        requiresEvidence: true,
      },
      { open: async () => scriptedSession([negotiation, success]), publishManifest },
    );
    expect(publishManifest).toHaveBeenCalledWith("/allocated/run/manifest.json");
    expect(result.kind).toBe("blocked");
  });

  it("publishes exactly once after terminal success and keeps the accepted records as the only green claim", async () => {
    const record = { obligationId: "review.green", recordId: "record-one" };
    const publishManifest = vi.fn(async () => ({
      status: "accepted" as const,
      manifestDigest: "a".repeat(64),
      records: [record] as never,
    }));
    const session = scriptedSession([negotiation, success, null]);
    session.close = async () => {
      throw new Error("injected teardown crash after terminal");
    };
    const result = await invokeProviderRail(
      {
        providerId: "review.provider",
        requestId: "request-one",
        idempotencyKey: "attempt-one",
        payload: {},
        requiresEvidence: true,
      },
      { open: async () => session, publishManifest },
    );
    expect(publishManifest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "success", records: [record] });
  });
});
