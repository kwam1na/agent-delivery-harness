/**
 * The composite action itself: can it actually run where it is deployed?
 *
 * `main.test.ts` proves what the verification decides. This file proves the
 * step around it can reach that code at all — the failure class a unit test can
 * never see, because a unit test imports the module through the monorepo's own
 * workspace symlink and therefore never asks the question a runner asks.
 *
 * NOTHING HERE IS PARAPHRASED. The script under test is extracted from
 * `action.yml` and executed by bash, so a change to the action that breaks the
 * deployment breaks these tests. The npm install is exercised through a shim on
 * `PATH` rather than a real install: the assertion is about *which command runs
 * in which directory*, and a network fetch would add minutes and a flake without
 * adding evidence.
 */
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { ATTESTATION_LABEL } from "@delivery-harness/kernel";

const run = promisify(execFile);
const ACTION_PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACTION_YML = path.join(ACTION_PACKAGE, "action.yml");

const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * The verify step's `run:` body, dedented.
 *
 * A block scalar is one of the few YAML shapes that can be lifted without a
 * parser and without ambiguity: everything more indented than the `run:` key
 * belongs to it, and the first line's indentation is the block's own margin.
 */
function extractRunScript(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s*run:\s*\|\s*$/.test(line));
  expect(start).toBeGreaterThan(-1);
  const keyIndent = (lines[start] as string).search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const margin = Math.min(...body.filter((line) => line.trim() !== "").map((line) => line.search(/\S/)));
  return `${body.map((line) => line.slice(margin)).join("\n")}\n`;
}

/** The documented workflow example, lifted out of the header comment's fence. */
function extractWorkflowExample(text: string): string {
  const lines = text.split("\n");
  const open = lines.findIndex((line) => line.trimEnd() === "# ```yaml");
  const close = lines.findIndex((line, index) => index > open && line.trimEnd() === "# ```");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return lines
    .slice(open + 1, close)
    .map((line) => (line.startsWith("# ") ? line.slice(2) : line.replace(/^#$/, "")))
    .join("\n");
}

/**
 * A block-mapping scan sufficient for a workflow step list: enough to say what
 * the steps are and in what order, which is the whole claim under test.
 */
interface WorkflowStep {
  readonly uses: string | null;
  readonly run: boolean;
  readonly name: string | null;
}

function parseSteps(yamlText: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let current: { uses: string | null; run: boolean; name: string | null } | null = null;
  for (const raw of yamlText.split("\n")) {
    if (raw.includes("\t")) throw new Error(`a tab in YAML indentation is never valid: ${JSON.stringify(raw)}`);
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("- ")) {
      if (current !== null) steps.push(current);
      current = { uses: null, run: false, name: null };
    }
    if (current === null) continue;
    const member = line.replace(/^-\s*/, "");
    const uses = /^uses:\s*(\S+)/.exec(member);
    if (uses !== null) current = { ...current, uses: uses[1] as string };
    if (/^run:/.test(member)) current = { ...current, run: true };
    const name = /^name:\s*(.+)$/.exec(member);
    if (name !== null) current = { ...current, name: (name[1] as string).trim() };
  }
  if (current !== null) steps.push(current);
  return steps;
}

// ── The npm shim ─────────────────────────────────────────────────────────────

/**
 * A stand-in for npm that records how it was called and, optionally, produces
 * the one artifact a real `npm ci` would produce here: the workspace link the
 * action's imports resolve through.
 */
async function npmShim(options: { readonly logPath: string; readonly installs: boolean }): Promise<string> {
  const binDir = await scratch("dh-bin-");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$PWD $*" >> ${JSON.stringify(options.logPath)}`,
    ...(options.installs
      ? [
          'mkdir -p "$PWD/node_modules/@delivery-harness"',
          'ln -sfn "$PWD/packages/kernel" "$PWD/node_modules/@delivery-harness/kernel"',
        ]
      : ["exit 3"]),
    "exit 0",
  ].join("\n");
  const shimPath = path.join(binDir, "npm");
  await writeFile(shimPath, `${script}\n`, "utf8");
  await chmod(shimPath, 0o755);
  return binDir;
}

interface CompositeRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runComposite(options: {
  readonly script: string;
  readonly actionPath: string;
  readonly workspace: string;
  readonly binDir?: string;
  readonly env?: Record<string, string>;
}): Promise<CompositeRun> {
  const scriptDir = await scratch("dh-script-");
  const scriptPath = path.join(scriptDir, "step.sh");
  await writeFile(scriptPath, options.script, "utf8");
  try {
    const { stdout, stderr } = await run("bash", [scriptPath], {
      cwd: options.workspace,
      env: {
        PATH: `${options.binDir === undefined ? "" : `${options.binDir}:`}${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "",
        DELIVERY_HARNESS_ACTION_PATH: options.actionPath,
        DELIVERY_HARNESS_CI_POLICY_ID: "",
        DELIVERY_HARNESS_WORKING_DIRECTORY: "",
        GITHUB_WORKSPACE: options.workspace,
        GITHUB_EVENT_NAME: "push",
        ...(options.env ?? {}),
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** A workspace root shaped like this repository, holding the action and the kernel. */
async function harnessRoot(options: { readonly installed: boolean }): Promise<string> {
  const root = await scratch("dh-root-");
  await mkdir(path.join(root, "packages"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "consumer", private: true, type: "module", workspaces: ["packages/*"] }, null, 2)}\n`,
    "utf8",
  );
  await cp(ACTION_PACKAGE, path.join(root, "packages", "action"), { recursive: true });
  await cp(path.join(ACTION_PACKAGE, "..", "kernel"), path.join(root, "packages", "kernel"), { recursive: true });
  if (options.installed) {
    await mkdir(path.join(root, "node_modules", "@delivery-harness"), { recursive: true });
    await symlink(path.join(root, "packages", "kernel"), path.join(root, "node_modules", "@delivery-harness", "kernel"));
  }
  return root;
}

const TIMEOUT = { timeout: 120000 } as const;

// ── Deployability ────────────────────────────────────────────────────────────

describe("the composite step can reach the verification code", () => {
  it("reaches a rendered verdict once the harness workspace is installed", TIMEOUT, async () => {
    const script = extractRunScript(await readFile(ACTION_YML, "utf8"));
    const root = await harnessRoot({ installed: true });
    const logPath = path.join(await scratch("dh-log-"), "npm.log");
    const binDir = await npmShim({ logPath, installs: false });

    const result = await runComposite({
      script,
      actionPath: path.join(root, "packages", "action"),
      workspace: root,
      binDir,
    });

    // A verdict, not a module-resolution stack.
    expect(result.stdout).toContain("Delivery record verification");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
    expect(result.code).toBe(1); // the event is a push: blocked, which is a verdict
    // An already-installed workspace is not reinstalled.
    expect(existsSync(logPath)).toBe(false);
  });

  it("installs the harness workspace, in the action's own root, when it is absent", TIMEOUT, async () => {
    const script = extractRunScript(await readFile(ACTION_YML, "utf8"));
    const root = await harnessRoot({ installed: false });
    const logPath = path.join(await scratch("dh-log-"), "npm.log");
    const binDir = await npmShim({ logPath, installs: true });

    const result = await runComposite({
      script,
      actionPath: path.join(root, "packages", "action"),
      workspace: root,
      binDir,
    });

    const log = await readFile(logPath, "utf8");
    // The command, and the directory it ran in: the action's workspace root,
    // never the verified repository's working directory.
    expect(log).toContain("ci --ignore-scripts");
    expect(log.split(" ")[0]).toBe(root);
    expect(result.stdout).toContain("Delivery record verification");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("refuses in the harness's own voice when no workspace root stands above the action", TIMEOUT, async () => {
    const script = extractRunScript(await readFile(ACTION_YML, "utf8"));
    // The published-action shape: the action directory, alone, with nothing
    // above it that npm could install.
    const standalone = await scratch("dh-standalone-");
    await cp(ACTION_PACKAGE, path.join(standalone, "action"), { recursive: true });
    const summaryPath = path.join(standalone, "summary.md");

    const result = await runComposite({
      script,
      actionPath: path.join(standalone, "action"),
      workspace: standalone,
      env: { GITHUB_STEP_SUMMARY: summaryPath },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("delivery-harness");
    expect(result.stderr).toContain("uses: ./packages/action");
    // The point of the whole item: an operator gets an explanation rather than a
    // module-resolution stack. The message may *name* the node error codes — it
    // is explaining them — but node must never have been the one to speak.
    expect(result.stderr).not.toContain("node:internal/modules");
    expect(result.stderr).not.toContain("Error [ERR_MODULE_NOT_FOUND]");
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("delivery-harness");
    // Every block published under this heading carries the honest attestation
    // label. This one is written by shell rather than by the renderer — the
    // kernel is exactly what could not be loaded — so the literal in the script
    // is pinned against the kernel's own constant here, where they can be
    // compared. A heading without the label is a summary shape that quietly
    // claims more than the others.
    expect(summary).toContain(ATTESTATION_LABEL);
  });
});

// ── Structure ────────────────────────────────────────────────────────────────

describe("the composite's own step list", () => {
  it("checks out, then installs, then runs the verification", TIMEOUT, async () => {
    const text = await readFile(ACTION_YML, "utf8");
    const runsAt = text.indexOf("\nruns:");
    const steps = parseSteps(text.slice(runsAt));
    const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout") === true);
    const verify = steps.findIndex((step) => step.run);
    expect(checkout).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(checkout);
    expect(extractRunScript(text)).toContain("npm ci --ignore-scripts");
  });
});

describe("the documented workflow example", () => {
  it("is a workflow that could actually run: checkout precedes the action", TIMEOUT, async () => {
    const example = extractWorkflowExample(await readFile(ACTION_YML, "utf8"));
    const steps = parseSteps(example);
    const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout") === true);
    const action = steps.findIndex((step) => step.uses?.includes("packages/action") === true);
    expect(checkout).toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(-1);
    // GitHub cannot resolve a local action reference before the repository is
    // on disk, so a snippet with the order reversed is documentation of a
    // workflow that fails on its first step.
    expect(checkout).toBeLessThan(action);
  });

  it("keeps the verification job read-only", TIMEOUT, async () => {
    const example = extractWorkflowExample(await readFile(ACTION_YML, "utf8"));
    expect(example).toContain("contents: read");
    expect(example).not.toContain("contents: write");
    expect(example).not.toContain("pull_request_target");
    expect(example).not.toContain("continue-on-error");
  });
});
