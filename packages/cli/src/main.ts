/**
 * The executable entry point: builds a {@link CliRuntime} from the ambient
 * process and runs the CLI.
 *
 * This is the one CLI module that reads `process`, `stdin`/`stdout` TTY flags,
 * and installs a SIGINT handler — all inside functions, never at import time.
 * The interactive waiver prompt lives here because it is the boundary's I/O: it
 * prints every obligation one "yes" would cover, reads a single line, and turns
 * a Ctrl-C into the typed {@link CliInterruption} the boundary maps to exit 130.
 */
import { createInterface } from "node:readline";
import { CliInterruption, EXIT_POLICY, runCli, type CliRuntime } from "./index.ts";
import { invokedDirectly, type WaiverPrompt } from "@agent-delivery-harness/kernel";

/**
 * Reads a yes/no answer after naming every obligation the waiver would cover.
 * A SIGINT during the read rejects with {@link CliInterruption} rather than
 * tearing the process down, so the boundary can report exit 130.
 */
/**
 * EVERY PATH OUT OF THIS PROMPT SETTLES.
 *
 * A readline question has three exits, not one. The callback fires on a
 * submitted line; `SIGINT` fires on Ctrl-C; and `close` fires on Ctrl-D — stdin
 * reaching EOF with no line ever submitted. Waiting only on the callback leaves
 * the EOF path hanging forever: the returned promise never settles, the awaiting
 * gate never returns, the event loop drains with nothing left to do, and Node
 * exits 0. A gate that admitted nothing then reports success, which is the worst
 * failure this program has — a wrongful pass at the merge gate.
 *
 * So `close` resolves, and it resolves *false*: the prompt is `[y/N]`, its
 * default is decline, and a caller who never said yes has not said yes. The
 * settle guard makes the three exits mutually exclusive, because `close` also
 * fires immediately after the other two — without it, an interrupted prompt
 * would reject and then resolve, and a settled promise silently ignoring its
 * second settlement is exactly how this class of bug hides.
 */
export function createWaiverPrompt(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): WaiverPrompt {
  return (decision, obligationIds) =>
    new Promise<Awaited<ReturnType<WaiverPrompt>>>((resolve, reject) => {
      const rl = createInterface({ input, output });
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };

      rl.on("SIGINT", () => {
        settle(() => {
          rl.close();
          reject(new CliInterruption("Waiver prompt interrupted."));
        });
      });
      // Ctrl-D, a closed pipe, or any other end of input.
      rl.on("close", () => {
        settle(() => resolve(false));
      });

      output.write(`Waiving covers ${obligationIds.length} obligation(s): ${obligationIds.join(", ")}.\n`);
      output.write(`Candidate: ${decision.candidate.treeSha}. Approval covers only these findings under the current policy; live obligations require new approval each invocation.\n`);
      for (const resolution of decision.resolutions) {
        if (resolution.kind === "blocked" && obligationIds.includes(resolution.obligationId)) {
          for (const blocker of resolution.blockers) output.write(`${resolution.obligationId}: [${blocker.code}] ${blocker.summary}\n`);
        }
      }
      const finish = (value: Awaited<ReturnType<WaiverPrompt>>) => settle(() => {
        rl.close();
        resolve(value);
      });
      rl.question("Waive all of them? [y/N] ", (answer) => {
        if (!/^\s*y(es)?\s*$/i.test(answer)) return finish(false);
        rl.question("Author: ", (author) => {
          if (!author.trim() || author.length > 256) return finish(false);
          rl.question("Reason: ", (reason) => {
            if (!reason.trim() || reason.length > 4096) return finish(false);
            finish({ author: author.trim(), reason: reason.trim() });
          });
        });
      });
    });
}

export const readlineWaiverPrompt: WaiverPrompt = (decision, obligationIds) =>
  createWaiverPrompt(process.stdin, process.stderr)(decision, obligationIds);

/**
 * Reads the whole of stdin as UTF-8.
 *
 * `emit` takes its payload here, and the one thing that must never happen is a
 * hang: a terminal with no pipe attached would otherwise leave the command
 * waiting forever for a line nobody is going to type. A TTY stdin therefore
 * reads as empty, and the store refuses the empty payload with a diagnostic,
 * which is a far better answer than silence.
 */
export function readStdinText(input: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> {
  if (input.isTTY === true) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      text += chunk;
    });
    input.once("error", () => resolve(text));
    input.once("end", () => resolve(text));
  });
}

export function defaultRuntime(): CliRuntime {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    promptForWaiver: readlineWaiverPrompt,
    readStdin: () => readStdinText(process.stdin),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  return runCli(argv, defaultRuntime());
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  // FAIL CLOSED BEFORE ANYTHING RUNS.
  //
  // The exit code starts at a failure and is overwritten only by a real verdict.
  // Node's default is 0, so *any* way of leaving without settling — a promise
  // that never resolves, an event loop that drains early, a path nobody has
  // thought of yet — reports success from a gate that decided nothing. Setting
  // it first inverts that default: the only way to exit 0 is for the boundary to
  // have returned 0.
  process.exitCode = EXIT_POLICY;
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = EXIT_POLICY;
    });
}
