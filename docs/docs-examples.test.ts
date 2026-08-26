/**
 * The executable-docs sensor: the getting-started guide, run for real.
 *
 * WHAT THIS EXECUTES, AND WHERE IT COMES FROM. Every command below is parsed
 * out of `docs/getting-started.md` — the fenced code blocks ARE the test input.
 * Nothing from the guide is duplicated here: if the guide names a flag the CLI
 * no longer has, or a command that no longer exists, this suite goes red,
 * because what it runs is the guide's own bytes. That is the contract that
 * keeps the walkthrough honest — prose cannot drift from the tool while the
 * prose is the thing being executed.
 *
 * THE EXTRACTION CONVENTION (stated in the guide as well):
 *
 *   - A ```ts block whose first line is `// <relative-path>` is a file the
 *     guide tells the reader to create. It is written to that path in the
 *     fixture repository, byte-for-byte, before anything runs.
 *   - Every ```sh block is part of the walkthrough's one shell session. The
 *     blocks are concatenated in document order and executed as a single
 *     `bash -eu -o pipefail` script from the fixture repository root, so an
 *     `export` in an early block is visible to a later one and the first
 *     non-zero exit anywhere fails the run.
 *   - Blocks in any other language (```json, ```yaml, ```text, …) are
 *     illustrations, never executed.
 *
 * THE FIXTURE REPOSITORY stands in for the reader's project exactly as the
 * guide's opening frames it: a git repository whose base branch is named by
 * `origin/main`, with the change to be delivered already committed. The guide's
 * pre-v1 setup block consumes this checkout through `$DELIVERY_HARNESS_CHECKOUT`,
 * which is the one environment variable this suite provides.
 *
 * The subprocess environment is scrubbed: an isolated `HOME` (so a developer's
 * global git config — signing, hooks, aliases — cannot leak into the fixture)
 * and no agent/CI signals, so the walkthrough classifies the same everywhere.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ATTESTATION_LABEL } from "@agent-delivery-harness/kernel";

const run = promisify(execFile);

const DOCS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT_ROOT = path.resolve(DOCS_DIR, "..");
const GUIDE_PATH = path.join(DOCS_DIR, "getting-started.md");

// ── Fence extraction ─────────────────────────────────────────────────────────

interface FencedBlock {
  readonly language: string;
  readonly body: string;
}

/** Every triple-backtick fence in the document, in order. */
export function extractFencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const fence = /^```([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
  for (let match = fence.exec(markdown); match !== null; match = fence.exec(markdown)) {
    blocks.push({ language: match[1] ?? "", body: match[2] ?? "" });
  }
  return blocks;
}

/** The `// <relative-path>` header of a file block, if it carries one. */
export function fileBlockPath(block: FencedBlock): string | undefined {
  if (block.language !== "ts") return undefined;
  const firstLine = block.body.split("\n", 1)[0] ?? "";
  const match = /^\/\/ (\S+)$/.exec(firstLine.trim());
  return match?.[1];
}

// ── The fixture repository ───────────────────────────────────────────────────

const cleanups: string[] = [];
afterAll(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function git(cwd: string, env: NodeJS.ProcessEnv, ...args: readonly string[]): Promise<void> {
  await run("git", [...args], { cwd, env });
}

/**
 * The reader's project, as the guide's opening assumes it: a repository whose
 * base is the local ref `origin/main`, with the change to deliver committed on
 * top of it.
 */
async function initFixtureRepo(env: NodeJS.ProcessEnv): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-docs-"));
  cleanups.push(dir);
  await git(dir, env, "init", "--quiet", "--initial-branch", "main");
  await git(dir, env, "config", "user.email", "reader@example.invalid");
  await git(dir, env, "config", "user.name", "Getting Started Reader");
  await git(dir, env, "config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "README.md"), "# example project\n", "utf8");
  // The guide's stated prerequisite: a Node project in ES-module mode, so the
  // config and provider script below parse the same way everywhere.
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "example-project", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await git(dir, env, "add", "README.md", "package.json");
  await git(dir, env, "commit", "--quiet", "--no-gpg-sign", "-m", "base");
  await git(dir, env, "branch", "origin/main");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src/greeting.ts"), 'export const greeting = "hello";\n', "utf8");
  await git(dir, env, "add", "src/greeting.ts");
  await git(dir, env, "commit", "--quiet", "--no-gpg-sign", "-m", "the change to deliver");
  return dir;
}

// ── The suite ────────────────────────────────────────────────────────────────

let guide: string;
let blocks: FencedBlock[];

beforeAll(() => {
  guide = readFileSync(GUIDE_PATH, "utf8");
  blocks = extractFencedBlocks(guide);
});

describe("the getting-started walkthrough", () => {
  it("carries the full CLI loop and the files the reader is told to create", () => {
    const shell = blocks.filter((block) => block.language === "sh");
    expect(shell.length, "the guide has executable sh blocks").toBeGreaterThan(0);

    // Anti-vacuity: the walkthrough must actually cover the loop. Command
    // *names* only — flags and arguments are proven by execution, never by
    // duplication here.
    const script = shell.map((block) => block.body).join("\n");
    for (const command of ["check", "prepare", "review-context", "submit-evidence", "gate", "record", "verify"]) {
      expect(script, `the walkthrough runs \`${command}\``).toContain(`delivery-harness ${command}`);
    }

    const files = blocks.map(fileBlockPath).filter((name): name is string => name !== undefined);
    expect(files, "the guide's file blocks include the harness config").toContain("harness.config.ts");
    expect(files.length, "every ts block is a named file the reader creates").toBe(
      blocks.filter((block) => block.language === "ts").length,
    );
  });

  it("executes verbatim against a fixture repository through a passing verify", { timeout: 300_000 }, async () => {
    const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "dh-docs-home-"));
    cleanups.push(isolatedHome);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"],
      HOME: isolatedHome,
      GIT_CONFIG_NOSYSTEM: "1",
      DELIVERY_HARNESS_CHECKOUT: CHECKOUT_ROOT,
    };

    const repo = await initFixtureRepo(env);

    // The files the guide tells the reader to create, byte-for-byte.
    for (const block of blocks) {
      const relative = fileBlockPath(block);
      if (relative === undefined) continue;
      const target = path.join(repo, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, block.body, "utf8");
    }

    // The walkthrough's one shell session, in document order.
    const script = blocks
      .filter((block) => block.language === "sh")
      .map((block) => block.body)
      .join("\n");
    const scriptPath = path.join(isolatedHome, "walkthrough.sh");
    await writeFile(scriptPath, script, "utf8");

    const result = await run("bash", ["-eu", "-o", "pipefail", scriptPath], {
      cwd: repo,
      env,
      timeout: 240_000,
    }).catch((error: Error & { stdout?: string; stderr?: string; code?: number }) => error);

    const stdout = "stdout" in result && typeof result.stdout === "string" ? result.stdout : "";
    const stderr = "stderr" in result && typeof result.stderr === "string" ? result.stderr : "";
    expect(
      result instanceof Error ? undefined : "ok",
      `the walkthrough must run to completion\n── stdout ──\n${stdout}\n── stderr ──\n${stderr}`,
    ).toBe("ok");

    // The loop ended in a passing local verify of the tracked record, reported
    // with the honest attestation label.
    expect(stdout).toContain("verified ");
    expect(stdout).toContain(ATTESTATION_LABEL);

    // FLAG COUPLING, WITHOUT DUPLICATION. The CLI accepts a lone positional
    // where a flag is optional, and every command other than `submit-evidence`
    // ignores its argv entirely — so merely executing the walkthrough survives
    // a renamed flag on either side and an invented flag on the guide's part.
    // The authority on what the flags are called is the CLI's own usage error:
    // run `submit-evidence` with no arguments through the shim the walkthrough
    // installed and collect the flags its message names. Compare as EXACT token
    // sets, in BOTH directions — every usage-named flag must appear as a token
    // on one of the guide's `delivery-harness` lines, and every flag token the
    // guide passes to `delivery-harness` must be one the CLI named (for the six
    // argument-less commands that means their guide lines carry no flags at
    // all). Substring containment would let `--manifest` hide inside
    // `--manifest-file` and `--man` inside `--manifest`; token equality does
    // not. Both sides are harvested under ONE shared grammar by whitespace
    // tokenization — an unanchored regex over the usage text would truncate a
    // `--manifest2` rename back to `--manifest` and silently match the stale
    // guide. And the guide is tokenized after joining bash continuation lines
    // the way bash joins them, so a flag on a `\`-continued line is still that
    // command's flag. All data is derived at runtime from the guide and the
    // CLI's own output — nothing is duplicated here.
    const shim = path.join(repo, ".delivery-harness/bin/delivery-harness");
    const usage = await run(shim, ["submit-evidence"], { cwd: repo, env, timeout: 60_000 }).catch(
      (error: Error & { stdout?: string; stderr?: string; code?: number }) => error,
    );
    const usageExit = usage instanceof Error ? usage.code : 0;
    expect(usageExit, "submit-evidence with no arguments is a usage error (exit 2)").toBe(2);
    const usageText = "stderr" in usage && typeof usage.stderr === "string" ? usage.stderr : "";

    // The one flag grammar, shared by both harvests: `--`, a letter, then
    // letters/digits/hyphens. Anchored — a token either is a flag or is not.
    const FLAG_TOKEN = /^--[a-z][A-Za-z0-9-]*$/;
    const flagTokensIn = (text: string): string[] =>
      text
        .trim()
        .split(/\s+/)
        .filter((token) => FLAG_TOKEN.test(token));

    const guideFlagTokens = new Set<string>();
    for (const line of script.replace(/\\\n/g, " ").split("\n")) {
      const tokens = line.trim().split(/\s+/);
      const command = tokens.indexOf("delivery-harness");
      if (command === -1) continue;
      for (const token of flagTokensIn(tokens.slice(command + 1).join(" "))) {
        guideFlagTokens.add(token);
      }
    }
    const usageFlagTokens = new Set(flagTokensIn(usageText));
    expect(usageFlagTokens.size, `the usage message names its flags: ${JSON.stringify(usageText)}`).toBeGreaterThan(0);
    for (const flag of usageFlagTokens) {
      expect([...guideFlagTokens], `the guide passes the CLI's ${flag} flag on a delivery-harness line`).toContain(flag);
    }
    for (const flag of guideFlagTokens) {
      expect([...usageFlagTokens], `the guide's ${flag} flag is one the CLI actually names`).toContain(flag);
    }
  });
});
