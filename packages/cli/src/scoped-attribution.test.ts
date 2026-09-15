import { expect, it } from "vitest";
import { ATTRIBUTION_RERUN_LIMIT, attributeCheckFailure, parseCheckFailure } from "./scoped-attribution.ts";

const timeout = (file: string) => ` FAIL  ${file} > does a thing\nError: Test timed out in 5000ms.\n`;
const assertion = (file: string) => ` FAIL  ${file} > does a thing\nAssertionError: expected 1 to be 2\n`;

it("reads failing files and their signal from a check log", () => {
  const parsed = parseCheckFailure(`${timeout("packages/cli/src/a.test.ts")}${assertion("packages/cli/src/b.test.ts")}`);
  expect(parsed).toEqual([
    { file: "packages/cli/src/a.test.ts", signal: "timeout" },
    { file: "packages/cli/src/b.test.ts", signal: "assertion" },
  ]);
});

it("reads a spawn failure and reports an unparsed log as no rows", () => {
  expect(parseCheckFailure(" FAIL  packages/cli/src/a.test.ts\nError: spawn ENOENT\n")).toEqual([
    { file: "packages/cli/src/a.test.ts", signal: "spawn" },
  ]);
  expect(parseCheckFailure("everything exploded")).toEqual([]);
});

it("names the same file once even when several of its tests fail", () => {
  expect(parseCheckFailure(`${timeout("a.test.ts")}${assertion("a.test.ts")}`)).toEqual([{ file: "a.test.ts", signal: "timeout" }]);
});

function ladder(overrides: Partial<Parameters<typeof attributeCheckFailure>[0]> = {}) {
  return attributeCheckFailure({
    providerId: "check.suite",
    exitCode: 1,
    log: "",
    touched: [],
    rerunCandidate: async () => ({ code: 0, log: "" }),
    rerunBase: async () => ({ code: 0, log: "" }),
    ...overrides,
  });
}

it("attributes two environmental timeouts and one pre-existing base failure", async () => {
  const attribution = await ladder({
    log: `${timeout("a.test.ts")}${timeout("b.test.ts")}${assertion("c.test.ts")}`,
    rerunCandidate: async files => files[0] === "c.test.ts" ? { code: 1, log: assertion("c.test.ts") } : { code: 0, log: "" },
    rerunBase: async () => ({ code: 1, log: assertion("c.test.ts") }),
  });
  expect(attribution.outcome).toBe("attributed");
  expect(attribution.rows).toEqual([
    { file: "a.test.ts", class: "environmental", evidence: "passed when rerun alone on the candidate" },
    { file: "b.test.ts", class: "environmental", evidence: "passed when rerun alone on the candidate" },
    { file: "c.test.ts", class: "pre-existing", evidence: "the base tree fails the same file" },
  ]);
  expect(attribution.budget).toEqual({ reruns: 4, limit: ATTRIBUTION_RERUN_LIMIT, exhausted: false });
});

it("never reclassifies a failure in a file the diff touches and names it first", async () => {
  const attribution = await ladder({
    log: `${timeout("a.test.ts")}${assertion("b.test.ts")}`,
    touched: ["b.test.ts"],
    rerunCandidate: async () => ({ code: 0, log: "" }),
  });
  expect(attribution.outcome).toBe("candidate");
  expect(attribution.rows[0]).toEqual({ file: "b.test.ts", class: "candidate", evidence: "the candidate's diff touches this file" });
  expect(attribution.rows[1]!.class).toBe("environmental");
  expect(attribution.summary).toMatch(/^candidate .*b\.test\.ts/);
});

it("classifies a persistent failure the base tree passes as candidate unless it is a bare timeout", async () => {
  const persistentAssertion = await ladder({
    log: assertion("a.test.ts"),
    rerunCandidate: async () => ({ code: 1, log: assertion("a.test.ts") }),
    rerunBase: async () => ({ code: 0, log: "" }),
  });
  expect(persistentAssertion.rows).toEqual([{ file: "a.test.ts", class: "candidate", evidence: "the failure reproduces alone and the base tree passes it" }]);
  const persistentTimeout = await ladder({
    log: timeout("a.test.ts"),
    rerunCandidate: async () => ({ code: 1, log: timeout("a.test.ts") }),
    rerunBase: async () => ({ code: 0, log: "" }),
  });
  expect(persistentTimeout.rows).toEqual([{ file: "a.test.ts", class: "environmental", evidence: "the failure carries no assertion and the diff does not touch this file" }]);
});

it("refuses to attribute a red it cannot read or a base tree it cannot reach", async () => {
  const unreadable = await ladder({ log: "everything exploded" });
  expect(unreadable.outcome).toBe("candidate");
  expect(unreadable.rows).toEqual([{ file: "(whole check)", class: "candidate", evidence: "the check log names no failing test file" }]);

  const unavailable = await ladder({
    log: assertion("a.test.ts"),
    rerunCandidate: async () => ({ code: 1, log: assertion("a.test.ts") }),
    rerunBase: async () => "unavailable",
  });
  expect(unavailable.outcome).toBe("attribution-unavailable");
  expect(unavailable.rows).toEqual([{ file: "a.test.ts", class: "candidate", evidence: "the base tree could not be prepared for comparison" }]);
});

it("bounds the reruns and never calls a budget-exhausted row attributable", async () => {
  const files = Array.from({ length: ATTRIBUTION_RERUN_LIMIT + 2 }, (_unused, index) => `f${index}.test.ts`);
  const attribution = await ladder({
    log: files.map(timeout).join(""),
    rerunCandidate: async () => ({ code: 0, log: "" }),
  });
  expect(attribution.budget).toEqual({ reruns: ATTRIBUTION_RERUN_LIMIT, limit: ATTRIBUTION_RERUN_LIMIT, exhausted: true });
  expect(attribution.outcome).toBe("candidate");
  const unattributed = attribution.rows.filter(row => row.evidence === "the rerun budget was exhausted before this file was examined");
  expect(unattributed).toHaveLength(2);
  expect(unattributed.every(row => row.class === "candidate")).toBe(true);
});

it("reports one attribution record per provider with the real exit code", async () => {
  const attribution = await ladder({ exitCode: 3, log: timeout("a.test.ts") });
  expect(attribution.version).toBe("check-attribution/1");
  expect(attribution.providerId).toBe("check.suite");
  expect(attribution.exitCode).toBe(3);
  expect(attribution.summary).toBe("attributed check.suite (exit 3): 1 environmental, 0 pre-existing, 0 candidate; 1 rerun of 6");
});
