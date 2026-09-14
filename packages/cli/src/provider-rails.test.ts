import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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

/**
 * Budget for a row that drives a real provider subprocess.
 *
 * These rows used to inherit vitest's 5000 ms default, which had to cover a
 * node boot, the product's own lifecycle deadline, a termination grace and a
 * SIGKILL escalation on a runner shared with every other test file. Nothing in
 * these rows is timed BY the test — the deadline under test is the product's,
 * passed in its own option — so the row's budget is explicit and generous and
 * carries no assertion of its own.
 */
const PROCESS_ROW_TIMEOUT_MS = 60_000;

/**
 * A deadline set so far past the row's own budget that it can never be what
 * ends the attempt, for the row whose subject is the abort rather than the
 * expiry.
 */
const UNREACHED_DEADLINE_MS = 10 * 60_000;

/**
 * The one deadline here that has to beat a provider that does answer: it spans
 * a negotiation round trip on an already-live child. Generous rather than
 * tuned, because the row asserts what the expiry did and never how long it took.
 */
const WARM_EXPIRY_DEADLINE_MS = 5_000;

/**
 * The line a fixture provider appends once its handlers and its stdin reader
 * are installed. Waiting on it is what keeps a cold node boot out of the
 * lifecycle deadline the row is actually about.
 */
const READY = 'fs.appendFileSync(marker, "ready " + process.pid + "\\n")';

/** Waits on the provider's own record rather than on a duration. */
async function waitForMarker(file: string, token: string): Promise<string> {
  for (;;) {
    const recorded = await readFile(file, "utf8").catch(() => "");
    if (recorded.includes(token)) return recorded;
    await sleep(10);
  }
}

/** Opens a real provider subprocess and returns only once it is up. */
async function openReadyProviderProcess(options: {
  readonly script: string;
  readonly marker: string;
  readonly cwd: string;
}): Promise<ProviderRailSession> {
  const session = await openProviderRailProcess({
    command: [process.execPath, "-e", options.script, options.marker],
    cwd: options.cwd,
    env: process.env,
  });
  await waitForMarker(options.marker, "ready");
  return session;
}

/** The provider's own pid, as it reported it on the readiness line. */
async function providerPid(marker: string): Promise<number> {
  const reported = /ready (\d+)/u.exec(await waitForMarker(marker, "ready"));
  if (reported === null) throw new Error(`No provider pid was recorded in ${marker}.`);
  return Number(reported[1]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
      ${READY};
    `;
    const session = await openReadyProviderProcess({ script, marker, cwd: dir });
    const stalled = await providerPid(marker);
    // The child is already booted and ready, so nothing but the rail's own two
    // bounds is inside the window measured below.
    const started = Date.now();
    const result = await invokeProviderRail(
      { providerId: "review.provider", requestId: "request-one", idempotencyKey: "attempt-one", payload: {}, requiresEvidence: false },
      {
        open: async () => session,
        deadlineMs: 500,
        terminationGraceMs: 100,
      },
    );
    expect(result).toMatchObject({ kind: "blocked", status: "indeterminate" });
    expect(await readFile(marker, "utf8")).toContain("term");
    // The escalation itself, observed rather than timed. This provider ignores
    // SIGTERM and is kept alive by its own interval, so the only thing that can
    // have ended it is the SIGKILL the grace expiry escalates to, and it is
    // already reaped by the time the attempt returns.
    expect(isAlive(stalled)).toBe(false);
    // THAT THE TWO BOUNDS BIND AT ALL.
    //
    // `deadlineMs` and `terminationGraceMs` are declared in no other test file
    // in this repository, so if this row asserts only the outcome and the
    // signals, a rail that ignored both — a clamped lifecycle timer, a grace
    // read from a constant instead of the caller — still passes everything
    // above. The elapsed window is the only thing that refuses that.
    //
    // The ceiling is deliberately not tuned to 500 + 100: it is sixteen times
    // the two bounds together, so it survives a runner hosting several suites
    // at once. What it therefore does not catch is a small inflation of either
    // bound; what it does catch is a bound that has stopped being read from the
    // caller at all, which is how they actually break — a lifecycle timer
    // clamped to a floor, or a grace taken from the module default instead of
    // `terminationGraceMs`, puts this row in the tens of seconds.
    //
    // It is a wall-clock assertion that is no longer a wall-clock race: what
    // used to make this window unpredictable, a cold `node` boot inside the
    // deadline, is awaited above, before the clock starts. Only the rail's own
    // two bounds are measured here.
    expect(Date.now() - started).toBeLessThan(10_000);
    await rm(dir, { recursive: true, force: true });
  }, PROCESS_ROW_TIMEOUT_MS);

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
        if (message.kind === "request") fs.appendFileSync(marker, "request\\n");
        if (message.kind === "cancel") fs.appendFileSync(marker, "cancel\\n");
      });
      ${READY};
      setInterval(() => {}, 1000);
    `;
    const session = await openReadyProviderProcess({ script, marker, cwd: dir });
    // The abort fires on the condition the row is about — the provider having
    // actually received the request it will never answer — instead of on a
    // fixed delay that a loaded runner can reorder against the request write.
    const controller = new AbortController();
    const aborting = waitForMarker(marker, "request").then(() => {
      controller.abort();
    });
    const result = await invokeProviderRail(
      { providerId: "review.provider", requestId: "request-one", idempotencyKey: "attempt-one", payload: {}, requiresEvidence: false },
      {
        open: async () => session,
        signal: controller.signal,
        deadlineMs: UNREACHED_DEADLINE_MS,
        terminationGraceMs: 100,
      },
    );
    await aborting;
    expect(result).toMatchObject({ kind: "interrupted", status: "indeterminate" });
    expect(await readFile(marker, "utf8")).toContain("cancel");
    await rm(dir, { recursive: true, force: true });
  }, PROCESS_ROW_TIMEOUT_MS);

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
      ${READY};
      setInterval(() => {}, 1000);
    `;
    // The only row here whose deadline has to beat a provider that does answer.
    // Opening OUTSIDE the attempt is what makes that survivable: `invokeProviderRail`
    // runs `open` inside the very deadline being measured, so a session opened
    // there would spend the budget on a cold node boot before the negotiation
    // round trip it is supposed to bound had even started. The deadline is also
    // explicit and generous rather than tuned, because nothing about its value
    // is asserted: the row asserts what the expiry DID.
    const session = await openReadyProviderProcess({ script, marker, cwd: dir });
    const started = Date.now();
    const result = await invokeProviderRail(
      { providerId: "review.provider", requestId: "request-one", idempotencyKey: "attempt-one", payload: {}, requiresEvidence: false },
      {
        open: async () => session,
        deadlineMs: WARM_EXPIRY_DEADLINE_MS,
        terminationGraceMs: 100,
      },
    );
    expect(result).toMatchObject({ kind: "blocked", status: "indeterminate" });
    expect(await readFile(marker, "utf8")).toContain("cancel");
    // THAT THIS EXPIRY IS THE CALLER'S DEADLINE, for the same reason and on the
    // same terms as the stalled-negotiation row above: a rail that stopped
    // reading `deadlineMs` from the caller — a lifecycle timer clamped to a
    // floor, or a multiple of the configured value — still expires eventually
    // and still records the cancel, so every assertion above survives it.
    //
    // This row catches strictly more than the stalled-negotiation row can,
    // because its bound is ten times larger. Three times 5 000 ms leaves
    // ten seconds of slack over the ~5.1 s this window actually costs — the
    // child is already up before the clock starts, so only the negotiation
    // round trip and the rail's own expiry are inside it — while still
    // refusing a timer multiplied by four, which at a 500 ms bound would need
    // a ceiling back down at the tuned figure this delivery removed.
    expect(Date.now() - started).toBeLessThan(3 * WARM_EXPIRY_DEADLINE_MS);
    await rm(dir, { recursive: true, force: true });
  }, PROCESS_ROW_TIMEOUT_MS);

  it.skipIf(process.platform === "win32")("bounds a real provider that never reads a request write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "provider-rail-blocked-write-"));
    const marker = path.join(dir, "events.txt");
    const script = `
      const fs = require("node:fs");
      const marker = process.argv[1];
      process.on("SIGTERM", () => {});
      process.stdout.write(JSON.stringify({ kind: "negotiation", outcome: "supported", selectedVersion: "delivery-provider-rails/1", supportedVersions: ["delivery-provider-rails/1"] }) + "\\n");
      setInterval(() => {}, 1000);
      ${READY};
    `;
    const session = await openReadyProviderProcess({ script, marker, cwd: dir });
    const result = await invokeProviderRail(
      {
        providerId: "review.provider",
        requestId: "request-one",
        idempotencyKey: "attempt-one",
        payload: { blockedWrite: "x".repeat(8 * 1024 * 1024) },
        requiresEvidence: false,
      },
      {
        open: async () => session,
        deadlineMs: 500,
        terminationGraceMs: 100,
      },
    );
    expect(result).toMatchObject({ kind: "blocked", status: "indeterminate" });
    await rm(dir, { recursive: true, force: true });
  }, PROCESS_ROW_TIMEOUT_MS);
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
