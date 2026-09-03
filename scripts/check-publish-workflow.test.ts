/**
 * The publish workflow, falsified.
 *
 * `.github/workflows/publish.yml` is the one artifact in this repository that
 * turns a pushed tag into five packages on a public registry, and it runs
 * exactly once per release — after the pull request has merged, on a ref no
 * pull-request check ever sees. Every guarantee it states is therefore stated
 * in a place no sensor reaches: weaken its version guard, drop a `--provenance`
 * flag, or paste a registry credential into it, and `npm run check` stays green
 * to the last commit before the release that gets it wrong.
 *
 * This suite is that missing sensor. Two halves:
 *
 *   THE GUARD, EXECUTED. The version-equality guard is not restated here — it
 *   is EXTRACTED from the workflow's own heredoc and run, so a suite that
 *   passed while the shipped guard was weakened is not possible. Both sides are
 *   pinned: the guard must accept a workspace that agrees with the tag and must
 *   refuse one where a single PACKAGE manifest disagrees. The deny side alone
 *   would be satisfied by a guard that refuses everything; the allow side alone
 *   by a guard that refuses nothing; the per-package case specifically, because
 *   a guard that read only the root manifest passes both a root-only test and
 *   the workflow's own refusal probe.
 *
 *   THE POLICY CLAIMS, PINNED. "No stored token or secret of any kind",
 *   "`npm publish --provenance --access public`", "`id-token: write`", and
 *   "dependency order" are prose in a YAML file until something reads them
 *   back. Each is one row here, so the edit that falsifies it is a red run
 *   rather than a discovery made by a consumer installing a package with no
 *   provenance attached.
 *
 * WHY THE EXTRACTION IS TEXTUAL. This workspace ships zero third-party runtime
 * dependencies and carries no YAML parser, which is why
 * `scripts/policy-projection-check.ts` reads `release.yml`'s path filters with a
 * line matcher too. The extraction below asserts its own markers before using
 * them: if the heredoc, the step, or the job moves, this suite fails loudly
 * rather than checking an empty string.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = ".github/workflows/publish.yml";
const workflow = readFileSync(path.join(repoRoot, WORKFLOW_PATH), "utf8");
const workflowLines = workflow.split("\n");

/** The five packages, in the order the workflow must publish them. */
const DEPENDENCY_ORDER = ["kernel", "conformance", "cli", "action", "mcp"] as const;

/**
 * The `run:` steps that actually publish — not the header prose, which names
 * `npm publish --dry-run` when it explains what `release.yml` does instead.
 */
const publishRunLines = (): readonly string[] => workflowLines.filter((line) => /^\s*run: npm publish\b/u.test(line));

const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ── The guard, lifted out of the workflow it actually runs ───────────────────

/**
 * The body of the `<<'NODE' … NODE` heredoc, dedented the way the YAML block
 * scalar dedents it before the runner's shell sees it. The `cat >` line's own
 * indentation is the block's indentation, so stripping that much from each body
 * line reproduces the file the runner writes, byte for byte.
 */
function extractGuardSource(): string {
  const start = workflowLines.findIndex((line) => line.includes("<<'NODE'"));
  expect(start, `${WORKFLOW_PATH} no longer writes the guard through a <<'NODE' heredoc`).toBeGreaterThan(-1);
  const indent = workflowLines[start]!.length - workflowLines[start]!.trimStart().length;
  const body: string[] = [];
  for (const line of workflowLines.slice(start + 1)) {
    if (line.slice(indent) === "NODE") {
      expect(body.length, "the extracted guard is empty").toBeGreaterThan(0);
      return `${body.join("\n")}\n`;
    }
    body.push(line.slice(indent));
  }
  throw new Error(`${WORKFLOW_PATH}: the NODE heredoc is never terminated`);
}

const guardSource = extractGuardSource();

/** The guard, written where node can run it, once for the whole suite. */
const guardPath = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-publish-guard-"));
  cleanups.push(dir);
  const file = path.join(dir, "version-equality.mjs");
  writeFileSync(file, guardSource, "utf8");
  return file;
})();

interface GuardResult {
  readonly status: number;
  readonly output: string;
}

/** Runs the extracted guard against `dir`, asking it for `expected`. */
function runGuard(dir: string, expected: string): GuardResult {
  try {
    const stdout = execFileSync(process.execPath, [guardPath, expected], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** A workspace shaped like this one: a root manifest and N package manifests. */
function makeWorkspace(rootVersion: string, packageVersions: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-publish-ws-"));
  cleanups.push(dir);
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "fixture-root", version: rootVersion }, null, 2)}\n`, "utf8");
  mkdirSync(path.join(dir, "packages"), { recursive: true });
  for (const [name, version] of Object.entries(packageVersions)) {
    const pkgDir = path.join(dir, "packages", name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify({ name: `@fixture/${name}`, version }, null, 2)}\n`, "utf8");
  }
  return dir;
}

const AGREEING = () => makeWorkspace("0.2.0", { kernel: "0.2.0", cli: "0.2.0", mcp: "0.2.0" });

describe("the version-equality guard the publish workflow runs", () => {
  it("accepts a workspace whose every manifest declares the tag's version", () => {
    const result = runGuard(AGREEING(), "0.2.0");
    expect(result.status).toBe(0);
    expect(result.output).toContain("all declare 0.2.0");
  });

  // The mutation this row exists for: delete the per-package loop from the
  // guard so it reads the root manifest alone. That guard still accepts the
  // tag, still refuses the workflow's `-refusal-probe` string, and still lets
  // the run publish a tree the tag disagrees with.
  it("refuses when a single package manifest disagrees, and names it", () => {
    const dir = makeWorkspace("0.2.0", { kernel: "0.2.0", cli: "0.2.0", mcp: "0.1.0" });
    const result = runGuard(dir, "0.2.0");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("packages/mcp/package.json declares 0.1.0");
  });

  it("refuses when the root manifest disagrees", () => {
    const dir = makeWorkspace("0.1.0", { kernel: "0.2.0", cli: "0.2.0", mcp: "0.2.0" });
    const result = runGuard(dir, "0.2.0");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("package.json declares 0.1.0");
  });

  // A workspace with no packages would satisfy "every package agrees" for free,
  // which is the shape the whole guard exists to refuse.
  it("refuses a workspace with no packages rather than passing vacuously", () => {
    const dir = makeWorkspace("0.2.0", {});
    const result = runGuard(dir, "0.2.0");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("no workspace packages found");
  });
});

describe("the step that runs the guard", () => {
  it("asks the guard for the tag's version and then requires it to refuse one no manifest declares", () => {
    // Both invocations, in the shipped step: the accept path against the tag,
    // and the probe whose non-refusal is itself a failure. A step that dropped
    // the probe would run a guard nobody has seen refuse anything.
    expect(workflow).toContain('tag_version="${TAG_NAME#v}"');
    expect(workflow).toContain('node "${RUNNER_TEMP}/version-equality.mjs" "${tag_version}"');
    expect(workflow).toContain('if node "${RUNNER_TEMP}/version-equality.mjs" "${tag_version}-refusal-probe"');
    expect(workflow).toContain("the guard is broken");
  });

  it("runs the repository gate before any package is published", () => {
    const gateAt = workflowLines.findIndex((line) => /^\s*run: npm run check\s*$/u.test(line));
    const firstPublishAt = workflowLines.findIndex((line) => /^\s*run: npm publish\b/u.test(line));
    expect(gateAt, "no `run: npm run check` step").toBeGreaterThan(-1);
    expect(firstPublishAt, "no publish step").toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(firstPublishAt);
  });
});

describe("the publish workflow's stated policy", () => {
  // Acceptance criterion 4 of V26-1551, and the one criterion of the four that
  // is not post-merge. Trusted publishing means the credential does not exist;
  // a credential reference appearing here is the edit that quietly turns this
  // back into a token publish.
  it("references no credential of any kind", () => {
    // `id-token: write` is a GitHub permission, not a credential, and is the
    // one place the substring may appear.
    const credentialReferences = workflowLines.filter(
      (line) => /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/u.test(line),
    );
    expect(credentialReferences).toEqual([]);
  });

  it("publishes every package with provenance and public access", () => {
    const publishLines = publishRunLines();
    expect(publishLines).toHaveLength(DEPENDENCY_ORDER.length);
    for (const line of publishLines) {
      expect(line, line.trim()).toContain("--provenance");
      expect(line, line.trim()).toContain("--access public");
    }
  });

  it("grants the job id-token: write, which is what authenticates the publish", () => {
    expect(workflow).toContain("id-token: write");
  });

  // kernel depends on nothing; conformance, cli and action depend on kernel;
  // mcp depends on cli and kernel. Published out of this order, a package names
  // a sibling version the registry does not yet carry.
  it("publishes the five packages in dependency order", () => {
    const published = publishRunLines()
      .map((line) => {
        const match = line.match(/@agent-delivery-harness\/([a-z]+)/u);
        expect(match, `no package name in: ${line.trim()}`).not.toBeNull();
        return match![1]!;
      });
    expect(published).toEqual([...DEPENDENCY_ORDER]);
  });

  it("runs only on a version tag, never on a branch push or a pull request", () => {
    const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(on).toContain("tags:");
    expect(on).not.toContain("branches:");
    expect(on).not.toContain("pull_request:");
  });
});
