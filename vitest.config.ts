import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Test concurrency knob.
 *
 * GitHub runners have starved vitest's worker RPC under default concurrency
 * before; `DELIVERY_HARNESS_MAX_WORKERS` is the `--maxWorkers`-style env lever
 * CI legs set. Unset means "vitest default".
 *
 * This file is deliberately outside every sensor scan root: it is the one place
 * allowed to read the environment while modules load.
 */
const rawMaxWorkers = process.env["DELIVERY_HARNESS_MAX_WORKERS"];
const maxWorkers = rawMaxWorkers === undefined || rawMaxWorkers === "" ? undefined : Number(rawMaxWorkers);

if (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || maxWorkers < 1)) {
  throw new Error(`DELIVERY_HARNESS_MAX_WORKERS must be a positive integer, received ${JSON.stringify(rawMaxWorkers)}`);
}

/**
 * Where this run's tests keep their run store.
 *
 * The suite invokes the product's CLI from the checkout root, hundreds of times
 * per run. Seven of those commands append their own `command.completed`
 * whenever a run is current for the invoking worktree — so, unpinned, a suite
 * run inside a worktree with a live delivery run wrote foreign completions into
 * that operator's journal. Pinning `DELIVERY_HARNESS_RUN_STORE` at a directory
 * of this run's own puts every store a test can resolve, from any worktree it
 * names, out of reach of every live one. A test that wants the store a
 * repository owns clears or repoints the pin for its own scope.
 *
 * Set on this process as well as handed to the workers, because a worker
 * inherits this environment and vitest's own `env` is applied on top of it;
 * either alone would leave a pool configuration that is silently unpinned.
 */
const runStore = mkdtempSync(path.join(os.tmpdir(), "delivery-harness-run-store-"));
process.env["DELIVERY_HARNESS_RUN_STORE"] = runStore;
process.once("exit", () => rmSync(runStore, { recursive: true, force: true }));

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts", "docs/**/*.test.ts"],
    env: { DELIVERY_HARNESS_RUN_STORE: runStore },
    ...(maxWorkers === undefined ? {} : { maxWorkers, minWorkers: 1 }),
  },
});
