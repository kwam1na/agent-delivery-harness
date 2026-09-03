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
import {
  CLI_PACKAGE_NAME,
  CLI_SMOKE_CASES,
  EXPECTED_SCRATCH_JOURNALS,
  EXPECTED_SCRATCH_NOTE_LINES,
  PACKAGE_SCOPE,
  cliProbeVacuityFinding,
  gitNamespaceCleared,
  readScratchRunStore,
  readWorkspacePackages,
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

  // The order is load-bearing twice over: `runs list` asserts an empty store,
  // and the refused `emit` resolves the pointer `run.started` wrote.
  it("reads the empty store before allocating, and refuses after", () => {
    const labels = CLI_SMOKE_CASES.map((smoke) => smoke.args.join(" "));
    const list = labels.findIndex((label) => label === "runs list");
    const started = labels.findIndex((label) => label.startsWith("emit run.started"));
    const refused = labels.findIndex((label) => label.startsWith("emit sensor.unknown-kind"));
    expect(list).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(list);
    expect(refused).toBeGreaterThan(started);
  });

  it("carries the payload inline, because the probe runs with stdin ignored", () => {
    for (const smoke of CLI_SMOKE_CASES) {
      if (smoke.args[0] !== "emit") continue;
      expect(smoke.args).toContain("--json");
    }
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
