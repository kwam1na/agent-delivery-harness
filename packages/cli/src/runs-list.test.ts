/**
 * `runs list`: the human inventory, and the bounded machine-readable one.
 *
 * Every run here is a REAL journal, written through `emit` into a real store,
 * because the property under test is that the listing reports what the store
 * holds. A fixture handed to the projection would pass whatever the projection
 * decided to echo, and would leave both the filter and the bound unfalsified.
 *
 * The human listing with no flags is PINNED BYTE-FOR-BYTE. It is the surface
 * an operator and the standalone-install smoke both read, and the flags this
 * file adds must not have moved a single character of it.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { RUN_JOURNAL_STATUSES } from "@agent-delivery-harness/kernel";
import { EXIT_OK, EXIT_USAGE, runCli, type CliRuntime } from "./index.ts";
import { READOUT_LABELS } from "./run-projection.ts";
import { RUN_INVENTORY_SPEC, RUN_LIST_STATUSES } from "./commands/runs.ts";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-runs-list-"));
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

async function emit(dir: string, argv: readonly string[], payload: unknown): Promise<Invocation> {
  return cli(dir, ["emit", ...argv], { readStdin: async () => JSON.stringify(payload) });
}

async function surfaceOf(dir: string): Promise<{ readonly runsDir: string; readonly currentRunId: string | undefined }> {
  const resolved = await resolveRunSurface(dir);
  if (!resolved.ok) throw new Error(resolved.reason);
  const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
  return { runsDir: resolved.surface.runsDir, currentRunId: current.ok ? current.runId : undefined };
}

async function runIdsOf(dir: string): Promise<readonly string[]> {
  const resolved = await resolveRunSurface(dir);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.surface.store.list();
}

/** Starts a run and returns the id the store now points at for this worktree. */
async function startRun(dir: string, extra: readonly string[] = []): Promise<string> {
  const started = await emit(dir, ["run.started", ...extra], {
    host: "vitest",
    workflow: { releaseId: "test-release", profile: "linear" },
  });
  expect(started.code, started.err).toBe(EXIT_OK);
  const { currentRunId } = await surfaceOf(dir);
  if (currentRunId === undefined) throw new Error("run.started left no current run");
  return currentRunId;
}

/**
 * Drives an already-started run to the `complete-executor-only` end state,
 * naming it with `--run` so the caller chooses WHICH run ends up in that
 * state rather than taking whichever one the pointer happens to hold.
 */
async function finishExecutorOnly(dir: string, runId: string): Promise<void> {
  const steps: readonly (readonly [string, unknown])[] = [
    ["ticket.read", { ticket: "V26-1917", tracker: "linear" }],
    ["posture.declared", { posture: "test-first" }],
    [
      "lens.selected",
      { mandated: ["lens.outcome-correctness", "lens.adversarial-testing"], selected: [], rationale: "the shipped pair" },
    ],
    ["review.round.opened", { round: 1, candidateTreeSha: TREE_SHA, lenses: ["lens.outcome-correctness"] }],
    [
      "review.round.closed",
      {
        round: 1,
        candidateTreeSha: TREE_SHA,
        outcome: "aligned",
        findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
        cost: { unit: "usd", total: 0, reportedBy: "vitest" },
      },
    ],
    ["gate.reported", { command: "npm run check", outcome: "pass", durationMs: 5 }],
    ["pr.opened", { url: "https://example.invalid/pr/1", candidateTreeSha: TREE_SHA }],
    ["run.ended", { result: "complete", cost: { unit: "usd", total: 0, reportedBy: "vitest" } }],
  ];
  for (const [kind, payload] of steps) {
    const result = await emit(dir, [kind, "--run", runId], payload);
    expect(result.code, `${kind}: ${result.err}`).toBe(EXIT_OK);
  }
}

/** The JSON the listing printed, parsed. */
async function listJson(dir: string, argv: readonly string[] = []): Promise<Record<string, unknown>> {
  const listed = await cli(dir, ["runs", "list", "--json", ...argv]);
  expect(listed.code, listed.err).toBe(EXIT_OK);
  return JSON.parse(listed.out) as Record<string, unknown>;
}

interface InventoryRow {
  readonly runId: string;
  readonly status: string;
  readonly open: boolean;
  readonly current: boolean;
  readonly bytes: number;
}

const rowsOf = (inventory: Record<string, unknown>): readonly InventoryRow[] => inventory["runs"] as InventoryRow[];
const idsOf = (inventory: Record<string, unknown>): readonly string[] => rowsOf(inventory).map((row) => row.runId);

describe("runs list --json", () => {
  it("reports an empty store as an explicit empty inventory, not as an absence", async () => {
    const dir = await initRepo();
    const { runsDir } = await surfaceOf(dir);

    const inventory = await listJson(dir);
    expect(inventory).toEqual({
      spec: RUN_INVENTORY_SPEC,
      labels: READOUT_LABELS,
      runsDir,
      current: null,
      runs: [],
      total: { count: 0, bytes: 0 },
      returned: 0,
      truncated: false,
    });
  });

  it("carries every row member for a real journal, and marks the worktree's current run", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const { runsDir } = await surfaceOf(dir);

    const inventory = await listJson(dir);
    expect(inventory["spec"]).toBe(RUN_INVENTORY_SPEC);
    expect(RUN_INVENTORY_SPEC).toBe("run-inventory/1");
    expect(inventory["labels"]).toBe(READOUT_LABELS);
    expect(inventory["runsDir"]).toBe(runsDir);
    expect(inventory["current"]).toBe(runId);
    expect(inventory["returned"]).toBe(1);
    expect(inventory["truncated"]).toBe(false);

    const [row] = rowsOf(inventory);
    expect(Object.keys(row!).sort()).toEqual(["bytes", "current", "open", "runId", "status"]);
    expect(row!.runId).toBe(runId);
    // A run with nothing but `run.started` is open and cannot be complete.
    expect(row!.status).toBe("incomplete");
    expect(row!.open).toBe(true);
    expect(row!.current).toBe(true);
    // The size is the journal's real size on disk, not a placeholder.
    expect(row!.bytes).toBeGreaterThan(0);
    expect(inventory["total"]).toEqual({ count: 1, bytes: row!.bytes });
  });

  it("reports an ended run as ended, not current, and complete-executor-only", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    await finishExecutorOnly(dir, runId);

    const [row] = rowsOf(await listJson(dir));
    expect(row!.status).toBe("complete-executor-only");
    expect(row!.open).toBe(false);
    // `run.ended` cleared the pointer, so nothing is current here.
    expect(row!.current).toBe(false);
    expect((await listJson(dir))["current"]).toBeNull();
  });

  it("lists runs in the store's ascending run-id order", async () => {
    const dir = await initRepo();
    await startRun(dir);
    await startRun(dir, ["--force"]);
    await startRun(dir, ["--force"]);

    const ids = idsOf(await listJson(dir));
    expect(ids).toHaveLength(3);
    expect([...ids]).toEqual([...ids].sort());
    // The order the documentation states is the store's own, so the listing
    // must not be re-ordering it into agreement by accident.
    expect(ids).toEqual(await runIdsOf(dir));
  });
});

describe("runs list bounds and filters", () => {
  it("bounds the listing with --limit and says the rest were cut", async () => {
    const dir = await initRepo();
    await startRun(dir);
    await startRun(dir, ["--force"]);
    await startRun(dir, ["--force"]);
    const all = await runIdsOf(dir);

    const inventory = await listJson(dir, ["--limit", "2"]);
    expect(idsOf(inventory)).toEqual(all.slice(0, 2));
    expect(inventory["returned"]).toBe(2);
    expect(inventory["truncated"]).toBe(true);
    // The bound cuts what is RETURNED, never what is counted: an agent that
    // read `total` off the returned rows could not tell it had been bounded.
    expect((inventory["total"] as { count: number }).count).toBe(3);
    // `total.bytes` is the bytes of every SELECTED run, so it is pinned against
    // the unbounded listing's own sum and not against the rows that came back.
    // A `>= sum(returned rows)` assertion would be vacuous: a total computed
    // over the returned rows satisfies it exactly.
    const returnedBytes = rowsOf(inventory).reduce((sum, row) => sum + row.bytes, 0);
    const everyRunsBytes = rowsOf(await listJson(dir)).reduce((sum, row) => sum + row.bytes, 0);
    expect(everyRunsBytes).toBeGreaterThan(returnedBytes);
    expect((inventory["total"] as { bytes: number }).bytes).toBe(everyRunsBytes);
  });

  it("is not truncated when the limit is not reached", async () => {
    const dir = await initRepo();
    await startRun(dir);
    await startRun(dir, ["--force"]);

    const exact = await listJson(dir, ["--limit", "2"]);
    expect(exact["returned"]).toBe(2);
    expect(exact["truncated"]).toBe(false);
    const generous = await listJson(dir, ["--limit", "50"]);
    expect(generous["returned"]).toBe(2);
    expect(generous["truncated"]).toBe(false);
  });

  it("selects by status, and reports a status nothing matches as an empty inventory", async () => {
    const dir = await initRepo();
    const first = await startRun(dir);
    const second = await startRun(dir, ["--force"]);
    await finishExecutorOnly(dir, second);

    const incomplete = await listJson(dir, ["--status", "incomplete"]);
    expect(idsOf(incomplete)).toEqual([first]);
    expect(incomplete["total"]).toMatchObject({ count: 1 });

    const executorOnly = await listJson(dir, ["--status", "complete-executor-only"]);
    expect(idsOf(executorOnly)).toEqual([second]);

    // `complete` is a status this store holds none of: the honest answer is an
    // empty inventory with a zero total, never the unfiltered listing.
    const none = await listJson(dir, ["--status", "complete"]);
    expect(idsOf(none)).toEqual([]);
    expect(none["total"]).toEqual({ count: 0, bytes: 0 });
    expect(none["returned"]).toBe(0);
    expect(none["truncated"]).toBe(false);
  });

  it("selects by --open and by --ended", async () => {
    const dir = await initRepo();
    const open = await startRun(dir);
    const ended = await startRun(dir, ["--force"]);
    await finishExecutorOnly(dir, ended);

    expect(idsOf(await listJson(dir, ["--open"]))).toEqual([open]);
    expect(idsOf(await listJson(dir, ["--ended"]))).toEqual([ended]);
  });

  it("applies the filter before the bound, so the bound never spends itself on excluded runs", async () => {
    const dir = await initRepo();
    const ids: string[] = [await startRun(dir)];
    for (let index = 0; index < 3; index += 1) ids.push(await startRun(dir, ["--force"]));
    const ordered = [...ids].sort();
    // The one run that ends is the LAST in the store's order, so a listing that
    // took its first row and then filtered would return nothing at all here.
    const last = ordered.at(-1)!;
    await finishExecutorOnly(dir, last);
    expect(await runIdsOf(dir)).toEqual(ordered);

    const inventory = await listJson(dir, ["--status", "complete-executor-only", "--limit", "1"]);
    expect(idsOf(inventory)).toEqual([last]);
    expect(inventory["returned"]).toBe(1);
    expect(inventory["truncated"]).toBe(false);
    expect(inventory["total"]).toMatchObject({ count: 1 });

    // Same shape on the other side: four runs are open, the bound returns one,
    // and the total still counts every run the filter selected.
    const openBounded = await listJson(dir, ["--open", "--limit", "1"]);
    expect(idsOf(openBounded)).toEqual([ordered[0]]);
    expect(openBounded["truncated"]).toBe(true);
    expect(openBounded["total"]).toMatchObject({ count: 3 });
  });

  it("offers exactly the statuses this listing can print", async () => {
    // `absent` is the completeness vocabulary's answer to "no journal bound
    // this candidate". An inventory enumerates journals that exist, so it can
    // never print that, and offering it would be a selector that selects
    // nothing whatever the store holds.
    expect([...RUN_LIST_STATUSES]).toEqual(["complete", "complete-executor-only", "incomplete", "unreadable"]);
    for (const status of RUN_LIST_STATUSES) {
      if (status === "unreadable") continue;
      expect([...RUN_JOURNAL_STATUSES]).toContain(status);
    }
    expect([...RUN_LIST_STATUSES]).not.toContain("absent");
  });

  it("reports an unreadable journal under the status the filter names", async () => {
    const dir = await initRepo();
    const runId = await startRun(dir);
    const { runsDir } = await surfaceOf(dir);
    const brokenId = `run-${"c".repeat(16)}`;
    await writeFile(path.join(runsDir, `${brokenId}.jsonl`), "not a journal line\n", "utf8");

    const unreadable = await listJson(dir, ["--status", "unreadable"]);
    expect(idsOf(unreadable)).toEqual([brokenId]);
    expect(rowsOf(unreadable)[0]!.open).toBe(false);

    // The human row for the same journal is the one this status is named after,
    // and it is PINNED BYTE-FOR-BYTE like the readable one below. A prefix
    // assertion (`  <id>  unreadable  `) is satisfied by the readable renderer
    // too, which would print `  <id>  unreadable  ended  <n> bytes` — the
    // open/ended word is exactly what an unreadable journal cannot answer.
    const inventory = await listJson(dir);
    const bytesOf = (id: string): number => rowsOf(inventory).find((row) => row.runId === id)!.bytes;
    const expectedRow = new Map([
      [brokenId, `  ${brokenId}  unreadable  ${bytesOf(brokenId)} bytes\n`],
      [runId, `  ${runId}  incomplete  open current  ${bytesOf(runId)} bytes\n`],
    ]);
    const human = await cli(dir, ["runs", "list"]);
    expect(human.code, human.err).toBe(EXIT_OK);
    expect(human.out).toBe(
      `runs in ${runsDir}\n  (${READOUT_LABELS})\n` +
        idsOf(inventory)
          .map((id) => expectedRow.get(id)!)
          .join("") +
        `total ${bytesOf(brokenId) + bytesOf(runId)} bytes across 2 run(s)\n`,
    );
  });
});

describe("runs list argument validation", () => {
  const invalid: readonly (readonly [string, readonly string[]])[] = [
    ["a zero limit", ["--limit", "0"]],
    ["a negative limit", ["--limit", "-1"]],
    ["a fractional limit", ["--limit", "1.5"]],
    ["a non-numeric limit", ["--limit", "many"]],
    ["a limit with no value", ["--limit"]],
    ["a repeated limit", ["--limit", "1", "--limit", "2"]],
    ["an unknown status", ["--status", "nearly-complete"]],
    ["the status the inventory can never print", ["--status", "absent"]],
    ["a status with no value", ["--status"]],
    ["a repeated status", ["--status", "incomplete", "--status", "complete"]],
    ["both open and ended", ["--open", "--ended"]],
    ["an unknown flag", ["--everything"]],
    ["a positional argument", ["extra"]],
  ];

  for (const [label, argv] of invalid) {
    it(`refuses ${label} without printing an inventory`, async () => {
      const dir = await initRepo();
      await startRun(dir);
      for (const args of [argv, ["--json", ...argv]]) {
        const listed = await cli(dir, ["runs", "list", ...args]);
        expect(listed.code, `${label}: ${listed.out}`).toBe(EXIT_USAGE);
        // A usage error prints NOTHING on stdout: a consumer piping this into
        // a parser must never receive a partial or unbounded inventory.
        expect(listed.out).toBe("");
        expect(listed.err).toContain("runs list");
      }
    });
  }

  it("accepts the flags in either order and in combination", async () => {
    const dir = await initRepo();
    await startRun(dir);
    for (const argv of [
      ["--json"],
      ["--limit", "1", "--json"],
      ["--json", "--status", "incomplete", "--limit", "1"],
      ["--open", "--json"],
      ["--json", "--ended"],
    ]) {
      const listed = await cli(dir, ["runs", "list", ...argv]);
      expect(listed.code, `${argv.join(" ")}: ${listed.err}`).toBe(EXIT_OK);
    }
  });
});

describe("the human runs listing", () => {
  it("prints exactly what it printed before the flags existed", async () => {
    const dir = await initRepo();
    const { runsDir } = await surfaceOf(dir);

    const empty = await cli(dir, ["runs", "list"]);
    expect(empty.code, empty.err).toBe(EXIT_OK);
    expect(empty.out).toBe(`runs in ${runsDir}\n  (${READOUT_LABELS})\ntotal 0 bytes across 0 run(s)\n`);

    const runId = await startRun(dir);
    const listed = await cli(dir, ["runs", "list"]);
    expect(listed.code, listed.err).toBe(EXIT_OK);
    const bytes = rowsOf(await listJson(dir))[0]!.bytes;
    expect(listed.out).toBe(
      `runs in ${runsDir}\n  (${READOUT_LABELS})\n` +
        `  ${runId}  incomplete  open current  ${bytes} bytes\n` +
        `total ${bytes} bytes across 1 run(s)\n`,
    );
  });

  it("says how much a bound cut, and only when it cut something", async () => {
    const dir = await initRepo();
    await startRun(dir);
    await startRun(dir, ["--force"]);
    const all = await runIdsOf(dir);

    const bounded = await cli(dir, ["runs", "list", "--limit", "1"]);
    expect(bounded.code, bounded.err).toBe(EXIT_OK);
    expect(bounded.out).toContain(all[0]!);
    expect(bounded.out).not.toContain(all[1]!);
    expect(bounded.out).toContain("showing 1 of 2 run(s) (--limit 1)");
    // The total line counts the SELECTED runs, not the shown ones: a bounded
    // listing that said "across 1 run(s)" over "showing 1 of 2" would contradict
    // itself, and only the "showing" line is checked above.
    expect(bounded.out).toContain("across 2 run(s)");

    const whole = await cli(dir, ["runs", "list", "--limit", "2"]);
    expect(whole.out).not.toContain("showing");
  });

  it("filters the human listing too, and totals only what it selected", async () => {
    const dir = await initRepo();
    const open = await startRun(dir);
    const ended = await startRun(dir, ["--force"]);
    await finishExecutorOnly(dir, ended);

    const listed = await cli(dir, ["runs", "list", "--open"]);
    expect(listed.code, listed.err).toBe(EXIT_OK);
    expect(listed.out).toContain(open);
    expect(listed.out).not.toContain(ended);
    expect(listed.out).toContain("across 1 run(s)");
  });
});
