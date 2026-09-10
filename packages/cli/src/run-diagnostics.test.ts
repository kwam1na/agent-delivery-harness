import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { RUN_GATE_REPORTED_OUTCOMES, type RunEvent } from "@agent-delivery-harness/kernel";
import { EXIT_OK, EXIT_POLICY, EXIT_USAGE, runCli, type CliRuntime } from "./index.ts";
import { resolveRunSurface } from "./run-surface.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-diagnostics-"));
  roots.push(root);
  await exec("git", ["init", "-q", root]);
  return root;
}

interface Invocation { readonly code: number; readonly out: string; readonly err: string }

async function cli(root: string, args: readonly string[], overrides: Partial<CliRuntime> = {}): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime: CliRuntime = {
    cwd: root,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: text => out.push(text),
    stderr: text => err.push(text),
    ...overrides,
  };
  return { code: await runCli(args, runtime), out: out.join(""), err: err.join("") };
}

const started = { host: "codex", workflow: { releaseId: "test", profile: "core" } };

async function start(root: string, version: "1" | "2" = "1"): Promise<string> {
  const invoked = await cli(root, ["emit", "run.started", "--version", version,
    ...(version === "2" ? ["--event-id", "start"] : []), "--json", JSON.stringify(started)]);
  expect(invoked.code, invoked.err).toBe(EXIT_OK);
  const resolved = await resolveRunSurface(root);
  if (!resolved.ok) throw new Error(resolved.reason);
  const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
  if (!current.ok || current.runId === undefined) throw new Error("no current run");
  return current.runId;
}

async function journal(root: string, runId: string): Promise<readonly RunEvent[]> {
  const resolved = await resolveRunSurface(root);
  if (!resolved.ok) throw new Error(resolved.reason);
  const read = await resolved.surface.store.read(runId);
  if (!read.ok) throw new Error(JSON.stringify(read.rejections));
  return read.events;
}

describe("current-run and grammar diagnostics", () => {
  it("resolves runs show --json through the worktree's current pointer", async () => {
    const root = await repository();
    const runId = await start(root);
    const shown = await cli(root, ["runs", "show", "--json"]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(JSON.parse(shown.out)).toMatchObject({ spec: "delivery-run-export/1", runId });

    const human = await cli(root, ["runs", "show"]);
    expect(human.code, human.err).toBe(EXIT_OK);
    expect(human.out).toContain(`run ${runId}`);
  });

  it("reports that an id-free runs show has no current run instead of treating a flag as an id", async () => {
    const root = await repository();
    const shown = await cli(root, ["runs", "show", "--json"]);
    expect(shown.code).toBe(EXIT_POLICY);
    expect(shown.err).toContain("no current run");
    expect(shown.err).not.toContain("run --json");
  });

  it("prints the validator-derived member grammar and its closed vocabulary", async () => {
    const root = await repository();
    const described = await cli(root, ["runs", "grammar", "gate.reported", "--version", "2", "--json"]);
    expect(described.code, described.err).toBe(EXIT_OK);
    const grammar = JSON.parse(described.out) as {
      readonly spec: string;
      readonly version: string;
      readonly kind: string;
      readonly members: readonly { readonly name: string; readonly required: boolean; readonly values?: readonly string[] }[];
    };
    expect(grammar).toMatchObject({ spec: "run-event-payload-grammar/1", version: "run-event/2", kind: "gate.reported" });
    expect(grammar.members.find(member => member.name === "outcome")?.values).toEqual(RUN_GATE_REPORTED_OUTCOMES);
    expect(grammar.members.find(member => member.name === "ticket")?.required).toBe(false);

    const runId = await start(root, "2");
    const refused = await cli(root, ["emit", "gate.reported", "--event-id", "bad-member", "--json",
      JSON.stringify({ command: "npm test", outcome: "pass", durationMs: 1, invented: true })]);
    expect(refused.code).toBe(EXIT_POLICY);
    const accepted = /accepted members: ([^\n.]+)/.exec(refused.err)?.[1]?.split(", ").sort();
    expect(accepted).toEqual(grammar.members.map(member => member.name).sort());
    const vocabulary = await cli(root, ["emit", "gate.reported", "--event-id", "bad-vocabulary", "--json",
      JSON.stringify({ command: "npm test", outcome: "passed", durationMs: 1 })]);
    expect(vocabulary.err).toContain(`outcome accepts only: ${RUN_GATE_REPORTED_OUTCOMES.join(", ")}`);
    expect(await journal(root, runId)).toHaveLength(1);
  });

  it("renders human grammar and rejects every malformed grammar invocation before resolving a store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "run-grammar-outside-"));
    roots.push(root);
    const human = await cli(root, ["runs", "grammar", "gate.reported", "--version", "1"]);
    expect(human.code, human.err).toBe(EXIT_OK);
    expect(human.out).toContain("gate.reported (run-event/1)");
    expect(human.out).toContain(`values: ${RUN_GATE_REPORTED_OUTCOMES.join(", ")}`);

    const invalid = [
      ["runs", "grammar"],
      ["runs", "grammar", "gate.reported", "--version"],
      ["runs", "grammar", "gate.reported", "--version", "3"],
      ["runs", "grammar", "gate.reported", "--version", "1", "--version", "2"],
      ["runs", "grammar", "gate.reported", "--json", "--json"],
      ["runs", "grammar", "gate.reported", "--unknown"],
      ["runs", "grammar", "gate.reported", "-x"],
      ["runs", "grammar", "gate.reported", "second.kind"],
      ["runs", "grammar", "unknown.kind"],
      ["runs", "grammar", "activity.observed", "--version", "1"],
    ] as const;
    for (const args of invalid) {
      const result = await cli(root, args);
      expect(result.code, `${args.join(" ")}: ${result.err}`).toBe(EXIT_USAGE);
      expect(result.err).toContain("Usage: delivery-harness runs");
    }
  });

  it("keeps runs show parsing closed while allowing either position for --json", async () => {
    const root = await repository();
    const runId = await start(root);
    const leading = await cli(root, ["runs", "show", "--json", runId]);
    expect(leading.code, leading.err).toBe(EXIT_OK);
    expect(JSON.parse(leading.out).runId).toBe(runId);
    for (const args of [
      ["runs", "show", "--json", "--json"],
      ["runs", "show", "--unknown"],
      ["runs", "show", "-x"],
      ["runs", "show", runId, "second-run"],
    ] as const) {
      expect((await cli(root, args)).code, args.join(" ")).toBe(EXIT_USAGE);
    }
  });

  it("enumerates the active nested member table on unknown and missing members", async () => {
    const root = await repository();
    await start(root, "2");
    const base = { round: 1, roundId: "round-1", candidateTreeSha: "a".repeat(40), outcome: "aligned",
      findings: { P0: 0, P1: 0, P2: 0, P3: 0 } };
    const missing = await cli(root, ["emit", "review.round.closed", "--event-id", "missing-cost", "--json",
      JSON.stringify({ ...base, cost: { coverage: "unreported" } })]);
    expect(missing.err).toContain("missing_member at /payload/cost/reportedBy");
    expect(missing.err).toContain("accepted members: coverage, reportedBy");
    expect(missing.err.match(/accepted members:/g)).toHaveLength(1);

    const unknown = await cli(root, ["emit", "review.round.closed", "--event-id", "unknown-cost", "--json",
      JSON.stringify({ ...base, cost: { coverage: "unreported", reportedBy: "host", invented: true } })]);
    expect(unknown.err).toContain("unknown_member at /payload/cost/invented");
    expect(unknown.err).toContain("accepted members: coverage, reportedBy");
    expect(unknown.err.match(/accepted members:/g)).toHaveLength(1);
  });
});

describe("writer-version diagnostics", () => {
  it.each(["1", "2"] as const)("explains invalid version %s startup flags without allocating a run", async version => {
    const root = await repository();
    const refused = await cli(root, ["emit", "run.started", "--version", version,
      ...(version === "1" ? ["--event-id", "extra"] : []), "--json", JSON.stringify(started)]);
    expect(refused.code).toBe(EXIT_USAGE);
    expect(refused.out).toBe("");
    expect(refused.err).toContain(version === "2"
      ? "run.started is creating a version 2 run; every emit needs --event-id"
      : "run.started is creating a version 1 run and does not accept --event-id; drop it");
    const resolved = await resolveRunSurface(root);
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(await resolved.surface.store.current(resolved.surface.worktreeKey)).toEqual({ ok: true });
    expect(await resolved.surface.store.list()).toEqual([]);
    const runId = await start(root, version);
    expect(await journal(root, runId)).toHaveLength(1);
  });

  it("distinguishes a missing v2 event id from an extra v1 event id", async () => {
    const v2Root = await repository();
    const v2Run = await start(v2Root, "2");
    const missing = await cli(v2Root, ["emit", "ticket.read", "--json", JSON.stringify({ ticket: "V26-2002", tracker: "linear" })]);
    expect(missing.code).toBe(EXIT_USAGE);
    expect(missing.err).toContain(`run ${v2Run} is version 2; every emit needs --event-id`);

    const v1Root = await repository();
    const v1Run = await start(v1Root);
    const extra = await cli(v1Root, ["emit", "ticket.read", "--event-id", "extra", "--json",
      JSON.stringify({ ticket: "V26-2002", tracker: "linear", roundId: "wrong" })]);
    expect(extra.code).toBe(EXIT_USAGE);
    expect(extra.err).toContain(`run ${v1Run} is version 1 and does not accept --event-id`);
    for (const member of ["roundId", "bound", "grace", "reopensRoundId"]) expect(extra.err).toContain(member);
  });
});

interface ChildResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }

function bounded(child: ChildProcessWithoutNullStreams, timeoutMs = 3_000): Promise<ChildResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  onTestFinished(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("emit subprocess did not settle")); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

describe("emit stdin payload discovery", () => {
  const main = path.resolve(import.meta.dirname, "main.ts");
  const nodeArgs = ["--import", import.meta.resolve("tsx"), main];

  it("preserves delayed pipes, diagnoses closed empty stdin, and leaves explicit JSON independent of stdin", async () => {
    const root = await repository();
    const runId = await start(root);

    const delayed = spawn(process.execPath, [...nodeArgs, "emit", "ticket.read"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let delayedSettled = false;
    const delayedResult = bounded(delayed).finally(() => { delayedSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(delayedSettled, "an open pipe intentionally waits for EOF").toBe(false);
    delayed.stdin.write('{"ticket":"V26-1918",');
    delayed.stdin.end('"tracker":"linear"}');
    expect((await delayedResult).code).toBe(EXIT_OK);
    expect((await journal(root, runId)).at(-1)?.payload).toMatchObject({ ticket: "V26-1918", tracker: "linear" });

    const beforeEmpty = await journal(root, runId);
    const empty = spawn(process.execPath, [...nodeArgs, "emit", "ticket.read"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const emptyResult = bounded(empty);
    empty.stdin.end();
    const emptyObserved = await emptyResult;
    expect(emptyObserved.code).toBe(EXIT_USAGE);
    expect(emptyObserved.stdout).toBe("");
    expect(emptyObserved.stderr).toContain("omit --json only when piping JSON to stdin until EOF");
    expect(await journal(root, runId)).toEqual(beforeEmpty);

    const explicit = spawn(process.execPath, [...nodeArgs, "emit", "ticket.read", "--json",
      JSON.stringify({ ticket: "V26-1918-explicit", tracker: "linear" })], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const explicitResult = await bounded(explicit);
    expect(explicitResult.code, explicitResult.stderr).toBe(EXIT_OK);
    expect((await journal(root, runId)).at(-1)?.payload).toMatchObject({ ticket: "V26-1918-explicit", tracker: "linear" });
  }, 20_000);

  it("keeps an open pipe waiting until the caller cancels it, without appending success", async () => {
    const root = await repository();
    const runId = await start(root);
    const before = await journal(root, runId);
    const child = spawn(process.execPath, [...nodeArgs, "emit", "ticket.read"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const result = bounded(child).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(settled, "a live pipe's future input cannot be inferred").toBe(false);
    child.kill("SIGINT");
    const observed = await result;
    expect(observed.code === 130 || child.signalCode === "SIGINT").toBe(true);
    expect(await journal(root, runId)).toEqual(before);
  }, 10_000);

  it("makes an embedding adapter's interactive stdin actionable without calling its open reader", async () => {
    const root = await repository();
    await start(root);
    const fixture = path.join(root, "interactive-emit.mjs");
    const indexUrl = pathToFileURL(path.resolve(import.meta.dirname, "index.ts")).href;
    await writeFile(fixture, `import { runCli } from ${JSON.stringify(indexUrl)};\nconst code = await runCli(["emit", "ticket.read"], { cwd: process.cwd(), env: {}, stdinIsTTY: true, stdoutIsTTY: true, stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text), readStdin: () => new Promise(() => {}) });\nprocess.exitCode = code;\n`);
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const observed = await bounded(child);
    expect(observed.code).toBe(EXIT_USAGE);
    expect(observed.stdout).toBe("");
    expect(observed.stderr).toContain("stdin is interactive");
    expect(observed.stderr).toContain("use --json <payload>");
  }, 10_000);
});
