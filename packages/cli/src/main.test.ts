/**
 * The executable entry point: the interactive prompt's settlement contract, and
 * the direct-invocation guard.
 *
 * WHY THE PROMPT IS TESTED HERE AND NOT THROUGH A PTY. What went wrong at the
 * merge gate was not a rendering bug, it was a promise that never settled: on
 * stdin EOF readline emits `close` without ever calling the question callback,
 * the await never resolves, the event loop drains, and Node exits 0 — a gate
 * that admitted nothing reporting success. That is a property of the prompt's
 * settlement, so it is pinned directly on the prompt with a real readline over
 * an in-memory stream that ends. The exit-code half is pinned separately, on the
 * boundary. Between them the wrongful pass is unconstructible: the prompt always
 * settles, and the process starts from a failing exit code that only a real
 * verdict overwrites.
 */
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { createWaiverPrompt, invokedDirectly } from "./main.ts";
import { CliInterruption } from "./index.ts";
import type { GateDecision } from "@agent-delivery-harness/kernel";

const ETX = String.fromCharCode(3);


const DECISION = { gateId: "test.gate", admitted: false, resolutions: [], diagnostics: [], blockers: [] } as unknown as GateDecision;

function streams(): { input: PassThrough; output: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, output };
}

describe("createWaiverPrompt", () => {
  it("resolves false on stdin EOF rather than never settling", async () => {
    const { input, output } = streams();
    const prompt = createWaiverPrompt(input, output);
    const answered = prompt(DECISION, ["review.green"]);
    // Ctrl-D: the stream ends without a line ever being submitted.
    input.end();
    await expect(answered).resolves.toBe(false);
  });

  it("resolves true on an explicit yes", async () => {
    const { input, output } = streams();
    const prompt = createWaiverPrompt(input, output);
    const answered = prompt(DECISION, ["review.green"]);
    input.write("y\n");
    await expect(answered).resolves.toBe(true);
  });

  it("resolves false on an empty line (the [y/N] default declines)", async () => {
    const { input, output } = streams();
    const prompt = createWaiverPrompt(input, output);
    const answered = prompt(DECISION, ["review.green"]);
    input.write("\n");
    await expect(answered).resolves.toBe(false);
  });

  it("resolves false on anything that is not a yes", async () => {
    const { input, output } = streams();
    const prompt = createWaiverPrompt(input, output);
    const answered = prompt(DECISION, ["review.green"]);
    input.write("no thanks\n");
    await expect(answered).resolves.toBe(false);
  });

  it("names every obligation one yes would cover", async () => {
    const { input, output } = streams();
    const seen: string[] = [];
    output.on("data", (chunk: Buffer) => seen.push(chunk.toString("utf8")));
    const prompt = createWaiverPrompt(input, output);
    const answered = prompt(DECISION, ["review.green", "second.check"]);
    input.write("y\n");
    await answered;
    const text = seen.join("");
    expect(text).toContain("review.green");
    expect(text).toContain("second.check");
  });

  it("rejects with CliInterruption on Ctrl-C, and close does not settle it a second time", async () => {
    // readline only raises SIGINT in terminal mode, which it selects from the
    // *output* stream's `isTTY` (in production, an interactive stderr) and
    // drives through raw-mode keypresses on the input. The fixture presents
    // both, then sends the actual ETX byte Ctrl-C produces rather than
    // synthesizing the event.
    const { input, output } = streams();
    (output as unknown as { isTTY: boolean }).isTTY = true;
    const asTty = input as unknown as { isTTY: boolean; setRawMode: () => void };
    asTty.isTTY = true;
    asTty.setRawMode = () => {};
    const prompt = createWaiverPrompt(input, output);
    const answered = prompt(DECISION, ["review.green"]);
    input.write(ETX);
    // The stream then ends, which would settle a second time were the guard
    // missing — and a resolve after a reject is silently ignored, which is
    // precisely how a mis-ordered settle hides.
    input.end();
    await expect(answered).rejects.toBeInstanceOf(CliInterruption);
  });

  it("settles exactly once when EOF follows an answer", async () => {
    const { input, output } = streams();
    const prompt = createWaiverPrompt(input, output);
    const answered = prompt(DECISION, ["review.green"]);
    input.write("y\n");
    input.end();
    await expect(answered).resolves.toBe(true);
  });
});

describe("invokedDirectly", () => {
  const cleanups: string[] = [];
  afterAll(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
  });

  it("survives a path containing a URL-significant character", async () => {
    // A `#` or `?` in a directory name truncates a naively built file:// URL,
    // so the entry never matches, `main` never runs, and the process exits 0
    // having done nothing — every command silently "passing". A real on-disk
    // fixture, so the resolved branch is the one exercised.
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-cli-entry-url-"));
    cleanups.push(dir);
    const weird = path.join(dir, "a#b");
    await mkdir(weird, { recursive: true });
    const modulePath = path.join(weird, "main.ts");
    await writeFile(modulePath, "export const x = 1;\n", "utf8");
    expect(invokedDirectly(modulePath, pathToFileURL(realpathSync(modulePath)).href)).toBe(true);
  });

  it("matches through a symlinked invocation path, under either symlink regime", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-cli-entry-"));
    cleanups.push(dir);
    const real = path.join(dir, "real");
    await mkdir(real, { recursive: true });
    const modulePath = path.join(real, "module.ts");
    await writeFile(modulePath, "export const x = 1;\n", "utf8");
    const linkedDir = path.join(dir, "linked");
    await symlink(real, linkedDir, "dir");
    const linkedModulePath = path.join(linkedDir, "module.ts");

    // Under default module resolution `import.meta.url` carries the module's
    // realpath while argv carries the caller's spelling — the symlink, for a
    // checkout reached through one (`/tmp` → `/private/tmp` on macOS).
    expect(invokedDirectly(linkedModulePath, pathToFileURL(realpathSync(modulePath)).href)).toBe(true);
    // Under `--preserve-symlinks-main` the regime flips: `import.meta.url`
    // keeps the symlink spelling. A guard that realpathed only the argv side
    // would under-match here — same silent exit 0, opposite configuration.
    const linkedHref = pathToFileURL(linkedModulePath).href;
    expect(invokedDirectly(linkedModulePath, linkedHref)).toBe(true);
    expect(invokedDirectly(modulePath, linkedHref)).toBe(true);
    // A different module never matches, and neither does a missing argv entry.
    const otherPath = path.join(real, "other.ts");
    await writeFile(otherPath, "export const y = 2;\n", "utf8");
    expect(invokedDirectly(linkedModulePath, pathToFileURL(otherPath).href)).toBe(false);
    expect(invokedDirectly(undefined, linkedHref)).toBe(false);
  });

  it("falls back to comparing the spellings when a side cannot be resolved", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-cli-entry-fallback-"));
    cleanups.push(dir);
    const real = path.join(dir, "real");
    await mkdir(real, { recursive: true });
    const linkedDir = path.join(dir, "linked");
    await symlink(real, linkedDir, "dir");

    // Neither path exists, so both realpaths throw and the comparison falls
    // back to the spellings — which match, exactly as they would have before
    // any resolution was attempted, URL-significant characters included.
    // Deleting the fallback turns this row into a thrown error, not a wrong
    // answer.
    const ghost = path.join(real, "gh#ost.ts");
    expect(invokedDirectly(ghost, pathToFileURL(ghost).href)).toBe(true);
    // A side that cannot be resolved cannot be seen through: the only
    // difference between these two spellings is the link, and with no
    // filesystem entry to resolve it, the guard honestly under-matches.
    expect(invokedDirectly(path.join(linkedDir, "gh#ost.ts"), pathToFileURL(ghost).href)).toBe(false);
    // Each side is canonicalized independently, so one unresolvable side does
    // not discard the other side's resolution — in either direction.
    const modulePath = path.join(real, "module.ts");
    await writeFile(modulePath, "export const x = 1;\n", "utf8");
    expect(invokedDirectly(path.join(linkedDir, "module.ts"), pathToFileURL(path.join(real, "missing.ts")).href)).toBe(false);
    expect(invokedDirectly(path.join(linkedDir, "missing.ts"), pathToFileURL(realpathSync(modulePath)).href)).toBe(false);
    // A module href that is not a file: URL is never this module.
    expect(invokedDirectly(modulePath, "data:text/javascript,export{}")).toBe(false);
  });

  /**
   * The guard exercised the way a caller exercises it: a spawned process,
   * launched by absolute path through a symlink. The guard's failing-exit-code
   * floor sits inside the guard itself, so an under-match is invisible to
   * every in-process test — the process just exits 0 with no output, a
   * wrongful pass at a gate binary. This spawn is the tripwire.
   */
  it("runs the CLI when launched through a symlinked path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-cli-entry-e2e-"));
    cleanups.push(dir);
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const linkedRepo = path.join(dir, "linked-repo");
    await symlink(repoRoot, linkedRepo, "dir");

    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(linkedRepo, "packages/cli/src/main.ts"), "--help"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    onTestFinished(() => {
      child.kill("SIGKILL");
    });
    child.on("error", () => {});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));

    const output = Buffer.concat(stdout).toString("utf8");
    const diagnostics = Buffer.concat(stderr).toString("utf8");
    expect(exitCode, diagnostics).toBe(0);
    // Empty output with exit 0 is the exact under-match signature this
    // tripwire exists for: the guard declined the entry and nothing ran.
    expect(output, `entry guard skipped main; stderr: ${diagnostics}`).toContain("Usage:");
  }, 30_000);
});
