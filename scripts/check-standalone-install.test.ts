/**
 * The standalone-install sensor's readable half.
 *
 * The sensor's whole point is the part that cannot be unit-tested: five real
 * `npm pack` runs and five real `npm install` runs into temp trees outside the
 * workspace. That leg is wired where the release checks run
 * (`npm run sensor:standalone`), not into this suite, because it takes seconds
 * rather than milliseconds.
 *
 * What IS falsified here is everything the slow leg depends on being right: the
 * manifest reader that decides which sibling edges get asserted, the two
 * anti-vacuity guards that stop a run which packed nothing, or which could not
 * load TypeScript at all, from reporting a clean sensor, the case list the CLI
 * probe walks, the environment it hands its children, and the run-store reader
 * that decides whether the run-surface cases actually wrote anything. Every one
 * of those is reachable without a subprocess, so all but one of these tests
 * spawn nothing. The exception is the last row, which drives the runner itself
 * over a one-package fixture: the CLI probe's guard is a decision the fast
 * suite can falsify, but the two lines that turn that decision into a reported
 * finding live inside the loop, and nothing else in `npm run check` reaches
 * them. One trivial `npm pack` and `npm install --offline` is what that row
 * costs, and it is the only thing that fails when the wiring is deleted.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliSmokeCase } from "./check-standalone-install.ts";
import {
  ALLOCATED_RUN_ID_NEEDLE,
  CLI_PACKAGE_NAME,
  CLI_SMOKE_CASES,
  EXPECTED_SCRATCH_JOURNALS,
  EXPECTED_SCRATCH_NOTE_LINES,
  PACKAGE_SCOPE,
  allocatedRunIdFrom,
  caseLabel,
  cliProbeVacuityFinding,
  gitNamespaceCleared,
  holdsRunStore,
  missingExpectations,
  readScratchRunStore,
  readWorkspacePackages,
  relocatedGitEnvironment,
  runStandaloneInstallCheck,
} from "./check-standalone-install.ts";

const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface FixturePackage {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

function makeFixture(packages: readonly FixturePackage[], options: { readonly withLoader?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-standalone-test-"));
  cleanups.push(dir);
  mkdirSync(path.join(dir, "packages"), { recursive: true });
  for (const pkg of packages) {
    const pkgDir = path.join(dir, "packages", pkg.name.replace(/^@[^/]+\//u, ""));
    mkdirSync(pkgDir, { recursive: true });
    const manifest: Record<string, unknown> = { name: pkg.name, version: "0.1.0" };
    if (pkg.dependencies !== undefined) manifest["dependencies"] = pkg.dependencies;
    writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  if (options.withLoader === true) {
    const loaderDir = path.join(dir, "node_modules", "tsx", "dist");
    mkdirSync(loaderDir, { recursive: true });
    writeFileSync(path.join(loaderDir, "loader.mjs"), "", "utf8");
  }
  return dir;
}

describe("readWorkspacePackages", () => {
  it("reports only the sibling dependencies, not every dependency", () => {
    const dir = makeFixture([
      {
        name: `${PACKAGE_SCOPE}/cli`,
        dependencies: { [`${PACKAGE_SCOPE}/kernel`]: "0.1.0", "some-third-party": "^1.0.0" },
      },
      { name: `${PACKAGE_SCOPE}/kernel` },
    ]);
    const packages = readWorkspacePackages(dir);
    expect(packages.map((pkg) => pkg.name)).toEqual([`${PACKAGE_SCOPE}/cli`, `${PACKAGE_SCOPE}/kernel`]);
    expect(packages[0]!.siblingDependencies).toEqual([`${PACKAGE_SCOPE}/kernel`]);
    expect(packages[1]!.siblingDependencies).toEqual([]);
  });

  it("reports no siblings for a manifest with no dependencies block", () => {
    const dir = makeFixture([{ name: `${PACKAGE_SCOPE}/kernel` }]);
    expect(readWorkspacePackages(dir)[0]!.siblingDependencies).toEqual([]);
  });
});

describe("anti-vacuity", () => {
  it("an empty package set is a finding, not a vacuous pass", () => {
    const dir = makeFixture([], { withLoader: true });
    const result = runStandaloneInstallCheck({ root: dir });
    expect(result.findings.map((finding) => finding.rule)).toEqual(["anti-vacuity"]);
    expect(result.findings[0]!.subject).toBe("packages");
    expect(result.packagesProbed).toEqual([]);
    expect(result.cliCasesCompleted).toBe(0);
  });

  it("a missing TypeScript loader is a finding, never a skipped probe", () => {
    // These packages publish TypeScript sources, so without a loader every
    // entry-point probe would be unrunnable — reporting clean there would be a
    // sensor that verified nothing.
    const dir = makeFixture([{ name: `${PACKAGE_SCOPE}/kernel` }]);
    const result = runStandaloneInstallCheck({ root: dir });
    expect(result.findings.map((finding) => finding.rule)).toEqual(["anti-vacuity"]);
    expect(result.findings[0]!.subject).toBe("tsx");
    expect(result.siblingEdgesVerified).toBe(0);
    expect(result.cliCasesCompleted).toBe(0);
  });
});

describe("CLI_SMOKE_CASES", () => {
  // A case list that emptied itself, or a case with nothing to match, is a CLI
  // probe that runs and proves nothing — the same vacuity the guards above
  // exist to refuse, one level down.
  it("every case carries arguments and something to match", () => {
    expect(CLI_SMOKE_CASES.length).toBeGreaterThan(0);
    for (const smoke of CLI_SMOKE_CASES) {
      expect(smoke.args.length).toBeGreaterThan(0);
      expect(smoke.expected.length).toBeGreaterThan(0);
      expect(smoke.expected.every((needle) => needle.trim() !== "")).toBe(true);
    }
  });

  // The order is load-bearing three times over: the first `runs list` asserts
  // an empty store, the second asserts the run the allocation reported, and the
  // refused `emit` resolves the pointer `run.started` wrote.
  it("reads the empty store before allocating, lists it non-empty after, and refuses after that", () => {
    const labels = CLI_SMOKE_CASES.map(caseLabel);
    const empty = labels.findIndex((label) => label.startsWith("runs list") && label.includes("empty"));
    const started = labels.findIndex((label) => label.startsWith("emit run.started") && !label.includes("GIT_"));
    const listed = labels.findIndex((label) => label.startsWith("runs list") && label.includes("non-empty"));
    const refused = labels.findIndex((label) => label.startsWith("emit sensor.unknown-kind"));
    expect(empty).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(empty);
    expect(listed).toBeGreaterThan(started);
    expect(refused).toBeGreaterThan(started);
  });

  // AT-D2. A `store.list()` that unconditionally returned `[]` passes an
  // assertion taken on an empty store, so the listing path is asserted again
  // after the allocation — and against the id the allocation itself reported,
  // which is the one thing a stubbed listing cannot produce.
  it("asserts the listing non-empty, naming the run the allocation reported", () => {
    const listing = CLI_SMOKE_CASES.filter(
      (smoke) => smoke.args.join(" ") === "runs list" && smoke.expectsAllocatedRunId === true,
    );
    expect(listing).toHaveLength(1);
    expect(listing[0]!.expected).toContain("across 1 run(s)");
    expect(CLI_SMOKE_CASES.indexOf(listing[0]!)).toBeGreaterThan(
      CLI_SMOKE_CASES.findIndex((smoke) => smoke.args[1] === "run.started"),
    );
  });

  // AT-D3. Every other case is spawned with the `GIT_` namespace already
  // cleared, so none of them can witness the installed CLI clearing it. Exactly
  // one case leaves the namespace pointed somewhere else, and it asserts the
  // scratch repository's own current run — an id the decoy store has never
  // heard of.
  it("runs exactly one case under a relocated GIT_ namespace, and it names the scratch run", () => {
    const relocated = CLI_SMOKE_CASES.filter((smoke) => smoke.underRelocatedGit === true);
    expect(relocated).toHaveLength(1);
    expect(relocated[0]!.exitCode).toBe(1);
    expect(relocated[0]!.expectsAllocatedRunId).toBe(true);
    expect(caseLabel(relocated[0]!)).toContain("GIT_");
  });

  // Two cases share the argument vector `runs list`, so the vector alone can no
  // longer name the case a finding is about.
  it("labels every case distinguishably", () => {
    const labels = CLI_SMOKE_CASES.map(caseLabel);
    expect(new Set(labels).size).toBe(CLI_SMOKE_CASES.length);
    expect(labels.every((label) => label.trim() !== "")).toBe(true);
  });

  it("carries the payload inline, because the probe runs with stdin ignored", () => {
    for (const smoke of CLI_SMOKE_CASES) {
      if (smoke.args[0] !== "emit") continue;
      expect(smoke.args).toContain("--json");
    }
  });
});

describe("allocatedRunIdFrom", () => {
  it("reads the id out of what `emit run.started` printed", () => {
    expect(allocatedRunIdFrom("started run run-0123456789abcdef\n")).toBe("run-0123456789abcdef");
  });

  it("is undefined for output that reported no allocation", () => {
    expect(allocatedRunIdFrom("total 0 bytes across 0 run(s)\n")).toBeUndefined();
  });

  // The refusal the relocated case asserts also carries a run id, in prose the
  // allocation never prints. Matching it would let a case that allocated
  // nothing still claim an id.
  it("does not read an id out of a refusal that merely mentions one", () => {
    expect(allocatedRunIdFrom("run run-0123456789abcdef is current; --force displaces it")).toBeUndefined();
  });
});

describe("missingExpectations", () => {
  const listing: CliSmokeCase = { args: ["runs", "list"], exitCode: 0, expected: ["across 1 run(s)"] };

  it("reports a static needle the output did not carry", () => {
    expect(missingExpectations(listing, "across 0 run(s)", "run-0123456789abcdef")).toEqual(["across 1 run(s)"]);
  });

  it("reports the allocated id as missing when the output does not name it", () => {
    const smoke = { ...listing, expectsAllocatedRunId: true } as const;
    expect(missingExpectations(smoke, "across 1 run(s)", "run-0123456789abcdef")).toEqual(["run-0123456789abcdef"]);
  });

  it("is satisfied when the output carries both the static needles and the id", () => {
    const smoke = { ...listing, expectsAllocatedRunId: true } as const;
    expect(missingExpectations(smoke, "across 1 run(s)  run-0123456789abcdef", "run-0123456789abcdef")).toEqual([]);
  });

  // A run that allocated nothing must fail this case by name rather than pass
  // it vacuously for want of anything to look for.
  it("names the absent allocation when no id was ever reported", () => {
    const smoke = { ...listing, expectsAllocatedRunId: true } as const;
    expect(missingExpectations(smoke, "across 1 run(s)", undefined)).toEqual([ALLOCATED_RUN_ID_NEEDLE]);
  });

  it("looks for no id at all where the case did not ask for one", () => {
    expect(missingExpectations(listing, "across 1 run(s)", undefined)).toEqual([]);
  });
});

describe("relocatedGitEnvironment", () => {
  it("points both GIT_DIR and GIT_COMMON_DIR at the decoy and keeps the rest", () => {
    const env = relocatedGitEnvironment({ PATH: "/usr/bin" }, "/decoy/.git");
    expect(env).toEqual({ PATH: "/usr/bin", GIT_DIR: "/decoy/.git", GIT_COMMON_DIR: "/decoy/.git" });
  });
});

describe("holdsRunStore", () => {
  it("is false for a repository nothing wrote a run store into", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-standalone-decoy-"));
    cleanups.push(dir);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    expect(holdsRunStore(dir)).toBe(false);
  });

  // What the relocated case fails on if the installed CLI stops clearing the
  // namespace: the store follows GIT_DIR and lands in the decoy.
  it("is true once a run store exists under the repository's git directory", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-standalone-decoy-"));
    cleanups.push(dir);
    mkdirSync(path.join(dir, ".git", "managed-delivery", "runs"), { recursive: true });
    expect(holdsRunStore(dir)).toBe(true);
  });
});

describe("gitNamespaceCleared", () => {
  it("drops the whole GIT_ namespace and keeps everything else", () => {
    const cleared = gitNamespaceCleared({
      GIT_DIR: "/somewhere/else/.git",
      GIT_COMMON_DIR: "/somewhere/else/.git",
      GIT_INDEX_FILE: "/somewhere/else/.git/index",
      PATH: "/usr/bin",
      HOME: "/home/someone",
    });
    expect(Object.keys(cleared).sort()).toEqual(["HOME", "PATH"]);
  });

  it("drops an unset variable rather than carrying an undefined value", () => {
    expect(gitNamespaceCleared({ PATH: "/usr/bin", UNSET: undefined })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("readScratchRunStore", () => {
  function makeStore(journals: readonly string[], notes: Readonly<Record<string, string>>): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-standalone-store-"));
    cleanups.push(dir);
    const runsDir = path.join(dir, ".git", "managed-delivery", "runs");
    mkdirSync(path.join(runsDir, "notes"), { recursive: true });
    // The pointer directory the store keeps beside them; this reader ignores it.
    mkdirSync(path.join(runsDir, "current"), { recursive: true });
    for (const journal of journals) writeFileSync(path.join(runsDir, journal), "", "utf8");
    for (const [name, body] of Object.entries(notes)) writeFileSync(path.join(runsDir, "notes", name), body, "utf8");
    return dir;
  }

  it("counts journals and note lines, and neither directories nor blank lines", () => {
    const dir = makeStore(["run-aaaa.jsonl", "run-bbbb.jsonl"], { "run-aaaa.jsonl": '{"kind":"x"}\n\n' });
    expect(readScratchRunStore(dir)).toEqual({ journals: 2, noteLines: 1 });
  });

  it("reports what one run.started and one refused append leave", () => {
    const dir = makeStore(["run-aaaa.jsonl"], { "run-aaaa.jsonl": '{"kind":"sensor.unknown-kind","code":"unknown_kind"}\n' });
    expect(readScratchRunStore(dir)).toEqual({
      journals: EXPECTED_SCRATCH_JOURNALS,
      noteLines: EXPECTED_SCRATCH_NOTE_LINES,
    });
  });

  it("throws where the store was never written, rather than reporting an empty one", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-standalone-store-"));
    cleanups.push(dir);
    expect(() => readScratchRunStore(dir)).toThrow();
  });
});

describe("cliProbeVacuityFinding", () => {
  // The guard the sibling-edge one leaves uncovered. Every CLI case lives
  // behind a name check, so renaming the package — or failing to install it —
  // skips all of them silently while the other packages still verify edges.
  it("is a finding when the CLI package was never probed at all", () => {
    const finding = cliProbeVacuityFinding({ packageProbed: false, casesCompleted: 0 });
    expect(finding?.rule).toBe("anti-vacuity");
    expect(finding?.subject).toBe("cli-cases");
    expect(finding?.message).toContain(CLI_PACKAGE_NAME);
  });

  it("is a finding when the package was probed but a case did not run", () => {
    const finding = cliProbeVacuityFinding({ packageProbed: true, casesCompleted: CLI_SMOKE_CASES.length - 1 });
    expect(finding?.rule).toBe("anti-vacuity");
    expect(finding?.subject).toBe("cli-cases");
    expect(finding?.message).toContain(String(CLI_SMOKE_CASES.length));
  });

  it("is a finding when the package was probed and no case ran", () => {
    expect(cliProbeVacuityFinding({ packageProbed: true, casesCompleted: 0 })?.rule).toBe("anti-vacuity");
  });

  it("is silent only when every case ran to completion", () => {
    expect(cliProbeVacuityFinding({ packageProbed: true, casesCompleted: CLI_SMOKE_CASES.length })).toBeUndefined();
  });

  // The runner increments at most once per `CLI_SMOKE_CASES` iteration, so a
  // count above the list is unreachable and the guard says nothing about it.
  // Pinned so a later reader does not mistake that silence for a judgement.
  it("is silent for a count above the case list, which the runner cannot produce", () => {
    expect(cliProbeVacuityFinding({ packageProbed: true, casesCompleted: CLI_SMOKE_CASES.length + 1 })).toBeUndefined();
  });

  it("names the package the smoke cases actually run", () => {
    expect(CLI_PACKAGE_NAME).toBe(`${PACKAGE_SCOPE}/cli`);
  });
});

describe("the CLI probe's guard, through the runner", () => {
  // The rows above falsify the guard's decision; this one falsifies the wiring
  // that reports it. Those two lines are reachable from no other check: the
  // pure rows never enter the loop, and `sensor:standalone` is not in `npm run
  // check` — it runs in the release workflow, on a healthy tree, where the
  // guard's only live branch is the silent one. Delete the push at the end of
  // the run and, without this row, every check stays green while a renamed CLI
  // package restores the vacuous `clean` report this file exists to refuse.
  //
  // A workspace whose only package is not the CLI is the shortest fixture that
  // reaches the guard: it packs and installs one trivial package for real,
  // which is why this row carries its own timeout rather than the suite's.
  it(
    "reports the finding, and the count it was decided from, when no installed package is the CLI",
    () => {
      const dir = makeFixture([{ name: `${PACKAGE_SCOPE}/kernel` }], { withLoader: true });
      const result = runStandaloneInstallCheck({ root: dir });
      expect(result.packagesProbed).toEqual([`${PACKAGE_SCOPE}/kernel`]);
      // The guard's own verdict, reported verbatim rather than re-described:
      // the runner decides nothing here, it routes.
      expect(result.findings.filter((finding) => finding.subject === "cli-cases")).toEqual([
        cliProbeVacuityFinding({ packageProbed: false, casesCompleted: 0 }),
      ]);
      // The count the summary line reports, so a return member pinned to a
      // constant cannot claim four cases ran when none did.
      expect(result.cliCasesCompleted).toBe(0);
    },
    60_000,
  );
});
