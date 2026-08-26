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
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createWaiverPrompt, entryHref, invokedDirectly } from "./main.ts";
import { CliInterruption } from "./index.ts";
import type { GateDecision } from "@delivery-harness/kernel";

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
  it("recognizes the entry path", () => {
    expect(invokedDirectly("/repo/packages/cli/src/main.ts", entryHref("/repo/packages/cli/src/main.ts"))).toBe(true);
  });

  it("survives a path containing a URL-significant character", () => {
    // A `#` or `?` in a directory name truncates a naively built file:// URL, so
    // the entry never matches, `main` never runs, and the process exits 0 having
    // done nothing — every command silently "passing".
    const hashPath = "/repo/a#b/packages/cli/src/main.ts";
    expect(invokedDirectly(hashPath, entryHref(hashPath))).toBe(true);
    const queryPath = "/repo/a?b/packages/cli/src/main.ts";
    expect(invokedDirectly(queryPath, entryHref(queryPath))).toBe(true);
  });

  it("does not match a different module", () => {
    expect(invokedDirectly("/repo/other.ts", entryHref("/repo/packages/cli/src/main.ts"))).toBe(false);
  });

  it("is false when there is no argv entry", () => {
    expect(invokedDirectly(undefined, entryHref("/repo/packages/cli/src/main.ts"))).toBe(false);
  });
});
