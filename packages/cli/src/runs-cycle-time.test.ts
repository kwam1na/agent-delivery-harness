/**
 * Cycle time where an operator actually reads it: the `runs list` column and
 * the `runs show` phase breakdown.
 *
 * Every run here is a REAL journal written through `emit` into a real store,
 * for the reason `runs-list.test.ts` states: a fixture handed to the projection
 * would pass whatever the projection decided to echo. A real loop cannot take
 * hours inside a test, so the one scenario that needs a long run restamps the
 * instants of a journal the CLI itself wrote and reads it back through the same
 * store — the events stay exactly the ones `emit` validated, and only the
 * clock they were written under moves.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_OK, runCli, type CliRuntime } from "./index.ts";
import { resolveRunSurface } from "./run-surface.ts";

const exec = promisify(execFile);
const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const TREE_SHA = "a".repeat(40);

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-runs-cycle-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "src.txt"), "hello\n", "utf8");
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "root");
  return dir;
}

interface Invocation {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(dir: string, argv: readonly string[], overrides: Partial<CliRuntime> = {}): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime: CliRuntime = {
    cwd: dir,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    loadConfig: async () => {
      throw new Error("runs is config-free and must never load a config");
    },
    ...overrides,
  };
  const code = await runCli(argv, runtime);
  return { code, out: out.join(""), err: err.join("") };
}

async function emit(dir: string, kind: string, payload: unknown, extra: readonly string[] = []): Promise<void> {
  const result = await cli(dir, ["emit", kind, ...extra], { readStdin: async () => JSON.stringify(payload) });
  expect(result.code, `${kind}: ${result.err}`).toBe(EXIT_OK);
}

async function surfaceOf(dir: string): Promise<{ readonly runsDir: string; readonly currentRunId: string | undefined }> {
  const resolved = await resolveRunSurface(dir);
  if (!resolved.ok) throw new Error(resolved.reason);
  const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
  return { runsDir: resolved.surface.runsDir, currentRunId: current.ok ? current.runId : undefined };
}

/** A whole delivery, journaled: two rounds with a fix between them, then a tail. */
async function journalDelivery(dir: string): Promise<string> {
  await emit(dir, "run.started", { host: "vitest", workflow: { releaseId: "test-release", profile: "linear" } });
  const { currentRunId } = await surfaceOf(dir);
  if (currentRunId === undefined) throw new Error("run.started left no current run");
  const round = (index: number, closed: boolean): readonly [string, unknown] =>
    closed
      ? [
          "review.round.closed",
          {
            round: index,
            candidateTreeSha: TREE_SHA,
            outcome: index === 1 ? "unresolved" : "aligned",
            findings: { P0: 0, P1: index === 1 ? 1 : 0, P2: 0, P3: 0 },
            cost: { unit: "usd", total: 0, reportedBy: "vitest" },
          },
        ]
      : ["review.round.opened", { round: index, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }];
  const steps: readonly (readonly [string, unknown])[] = [
    ["ticket.read", { ticket: "V26-2078", tracker: "linear" }],
    ["posture.declared", { posture: "test-first" }],
    ["lens.selected", { mandated: ["lens.outcome-correctness", "lens.adversarial-testing"], selected: [], rationale: "the shipped pair" }],
    round(1, false),
    round(1, true),
    round(2, false),
    round(2, true),
    ["gate.reported", { command: "npm run check", outcome: "pass", durationMs: 600_000 }],
    ["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: TREE_SHA }],
    ["run.ended", { result: "complete", cost: { unit: "usd", total: 0, reportedBy: "vitest" } }],
  ];
  for (const [kind, payload] of steps) await emit(dir, kind, payload, ["--run", currentRunId]);
  return currentRunId;
}

/**
 * Restamps a journal's instants in place, one per line, keeping every other
 * byte of every event exactly as `emit` wrote and validated it.
 */
async function restamp(dir: string, runId: string, instants: readonly string[]): Promise<void> {
  const { runsDir } = await surfaceOf(dir);
  const journal = path.join(runsDir, `${runId}.jsonl`);
  const lines = (await readFile(journal, "utf8")).split("\n").filter((line) => line.length > 0);
  expect(lines).toHaveLength(instants.length);
  const restamped = lines.map((line, index) => JSON.stringify({ ...(JSON.parse(line) as object), at: instants[index] }));
  await writeFile(journal, `${restamped.join("\n")}\n`, "utf8");
}

/** `2026-09-15T<hh>:<mm>:00Z`. */
const at = (hour: number, minute = 0): string =>
  `2026-09-15T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;

/** The eleven instants a whole journaled delivery takes, spread over six hours. */
const SPREAD: readonly string[] = [
  at(9), // run.started
  at(9, 5), // ticket.read
  at(9, 10), // posture.declared
  at(9, 15), // lens.selected
  at(11), // round 1 opened
  at(12), // round 1 closed
  at(13), // round 2 opened
  at(14), // round 2 closed
  at(14, 30), // gate.reported
  at(14, 45), // pr.opened
  at(15), // run.ended
];

describe("runs list carries cycle time", () => {
  it("prints a duration for every run and carries the seconds in --json", async () => {
    const dir = await initRepo();
    const runId = await journalDelivery(dir);
    await restamp(dir, runId, SPREAD);

    const listed = await cli(dir, ["runs", "list", "--json"]);
    expect(listed.code, listed.err).toBe(EXIT_OK);
    const inventory = JSON.parse(listed.out) as { runs: readonly { runId: string; durationSeconds: number | null }[] };
    expect(inventory.runs).toHaveLength(1);
    expect(inventory.runs[0]).toMatchObject({ runId, durationSeconds: 6 * 3600 });

    const human = await cli(dir, ["runs", "list"]);
    expect(human.code, human.err).toBe(EXIT_OK);
    // The duration precedes the size, which is the demotion this column is for.
    expect(human.out).toContain(`  ${runId}  complete-executor-only  ended  6h 00m  `);
    expect(human.out).toMatch(/6h 00m {2}\d+ bytes/);
  });

  it("gives an unreadable journal no duration at all rather than a zero one", async () => {
    const dir = await initRepo();
    await emit(dir, "run.started", { host: "vitest", workflow: { releaseId: "test-release", profile: "linear" } });
    const { runsDir, currentRunId } = await surfaceOf(dir);
    await writeFile(path.join(runsDir, `${currentRunId}.jsonl`), "not a journal line\n", "utf8");

    const listed = await cli(dir, ["runs", "list", "--json"]);
    const inventory = JSON.parse(listed.out) as { runs: readonly { durationSeconds: number | null }[] };
    expect(inventory.runs[0]!.durationSeconds).toBeNull();
    const human = await cli(dir, ["runs", "list"]);
    expect(human.out).toContain(`  ${currentRunId}  unreadable  `);
    expect(human.out).not.toContain("0s");
  });
});

describe("runs show carries the phase breakdown", () => {
  it("divides an ended delivery into three phases that sum to its total", async () => {
    const dir = await initRepo();
    const runId = await journalDelivery(dir);
    await restamp(dir, runId, SPREAD);

    const shown = await cli(dir, ["runs", "show", runId]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(shown.out).toContain("implementation  2h 00m");
    expect(shown.out).toContain("review          3h 00m  over 2 round(s)");
    expect(shown.out).toContain("tail            1h 00m");
    expect(shown.out).toContain("gate time       10m 00s summed over 1 journaled gate completion(s)");
    expect(shown.out).toContain("total           6h 00m");
    expect(shown.out).not.toContain("(open;");
  });

  it("carries the same phases into --json, where an archive can keep them", async () => {
    const dir = await initRepo();
    const runId = await journalDelivery(dir);
    await restamp(dir, runId, SPREAD);

    const shown = await cli(dir, ["runs", "show", runId, "--json"]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    const exported = JSON.parse(shown.out) as {
      summary: { durationSeconds: number; phases: { implementationSeconds: number; reviewSeconds: number; tailSeconds: number; rounds: number; gate: { totalMs: number; unseen: boolean } } };
    };
    expect(exported.summary.phases).toEqual({
      implementationSeconds: 2 * 3600,
      reviewSeconds: 3 * 3600,
      tailSeconds: 3600,
      rounds: 2,
      gate: { totalMs: 600_000, counted: 1, unreadable: 0, unseen: false },
    });
    const { implementationSeconds, reviewSeconds, tailSeconds } = exported.summary.phases;
    expect(implementationSeconds + reviewSeconds + tailSeconds).toBe(exported.summary.durationSeconds);
  });

  it("marks an open run's total as still accruing", async () => {
    const dir = await initRepo();
    await emit(dir, "run.started", { host: "vitest", workflow: { releaseId: "test-release", profile: "linear" } });
    const { currentRunId } = await surfaceOf(dir);

    const shown = await cli(dir, ["runs", "show", currentRunId!]);
    expect(shown.code, shown.err).toBe(EXIT_OK);
    expect(shown.out).toContain("(open; the tail is still accruing)");
    // A run with no round at all spends everything on implementation.
    expect(shown.out).toContain("review          0s  over 0 round(s)");
    expect(shown.out).toContain("unseen — no gate completion is journaled");
  });
});
