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
import { mkdtemp, symlink } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { createWaiverPrompt, readStdinText } from "./main.ts";
import { CliInterruption } from "./index.ts";
import type { GateDecision } from "@agent-delivery-harness/kernel";

const ETX = String.fromCharCode(3);


const DECISION = { gateId: "test.gate", candidate: { treeSha: "candidate-tree" }, admitted: false, resolutions: [], diagnostics: [], blockers: [] } as unknown as GateDecision;

function streams(): { input: PassThrough; output: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, output };
}

describe("createWaiverPrompt", () => {
  it.each(["y\n", "y\nTest Operator\n"])("declines EOF before attribution is complete: %j", async (partial) => {
    const { input, output } = streams();
    const answered = createWaiverPrompt(input, output)(DECISION, ["review.green"]);
    input.end(partial);
    await expect(answered).resolves.toBe(false);
  });

  it("resolves false on stdin EOF rather than never settling", async () => {
    const { input, output } = streams();
    const prompt = createWaiverPrompt(input, output);
    const answered = prompt(DECISION, ["review.green"]);
    // Ctrl-D: the stream ends without a line ever being submitted.
    input.end();
    await expect(answered).resolves.toBe(false);
  });

  it("records attribution after an explicit yes", async () => {
    const { input, output } = streams();
    const prompt = createWaiverPrompt(input, output);
    const answered = prompt(DECISION, ["review.green"]);
    input.write("y\nTest Operator\nExplicit exception\n");
    await expect(answered).resolves.toEqual({ author: "Test Operator", reason: "Explicit exception" });
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
    input.write("y\nTest Operator\nExplicit exception\n");
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
    input.write("y\nTest Operator\nExplicit exception\n");
    input.end();
    await expect(answered).resolves.toEqual({ author: "Test Operator", reason: "Explicit exception" });
  });
});

describe("readStdinText", () => {
  /**
   * `emit` takes its payload here, so both arms of this function are on the
   * path an executor drives every time it records a run event.
   *
   * THE TTY ARM IS A HANG, NOT A WRONG ANSWER. Removing the guard leaves a
   * terminal with no pipe attached waiting forever for a line nobody is going
   * to type, which is why the TTY stream below is one that never ends: a
   * missing guard fails this row as a timeout, exactly as it would fail an
   * operator.
   */
  it("reads a TTY stdin as empty and a piped stdin to its end", async () => {
    const tty = new PassThrough() as PassThrough & { isTTY?: boolean };
    tty.isTTY = true;
    // Never ended, never written to. The only way this settles is the guard.
    await expect(readStdinText(tty)).resolves.toBe("");

    const piped = new PassThrough();
    const read = readStdinText(piped);
    // More than one chunk, so a reader that resolved on the first `data` and
    // dropped the rest is caught rather than passing on a short payload.
    piped.write('{"host":"claude-code",');
    piped.write('"workflow":{}}');
    piped.end();
    await expect(read).resolves.toBe('{"host":"claude-code","workflow":{}}');

    // A stream that errors settles with what it had, rather than leaving the
    // command waiting on a stdin that is not coming back.
    const broken = new PassThrough();
    const partial = readStdinText(broken);
    broken.write("half");
    await new Promise((resolve) => setImmediate(resolve));
    broken.destroy(new Error("pipe closed"));
    await expect(partial).resolves.toBe("half");
  });
});

describe("the executable entry guard", () => {
  const cleanups: string[] = [];
  afterAll(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
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

it.each([false, true])("process cancellation settles stdin and waiver waits (already aborted=%s)", async (alreadyAborted) => {
  const controller = new AbortController();
  if (alreadyAborted) controller.abort();
  const { input, output } = streams();
  const read = readStdinText(input, controller.signal);
  const prompt = createWaiverPrompt(input, output, controller.signal)(DECISION, ["review.green"]);
  const checks = Promise.all([
    expect(read).rejects.toBeInstanceOf(CliInterruption),
    expect(prompt).rejects.toBeInstanceOf(CliInterruption),
  ]);
  controller.abort();
  await checks;
  expect(input.listenerCount("data")).toBe(0);
});
