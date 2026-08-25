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

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts", "docs/**/*.test.ts"],
    ...(maxWorkers === undefined ? {} : { maxWorkers, minWorkers: 1 }),
  },
});
