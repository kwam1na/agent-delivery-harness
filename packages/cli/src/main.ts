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
import { CliInterruption, runCli, type CliRuntime } from "./index.ts";
import type { WaiverPrompt } from "@delivery-harness/kernel";

/**
 * Reads a yes/no answer after naming every obligation the waiver would cover.
 * A SIGINT during the read rejects with {@link CliInterruption} rather than
 * tearing the process down, so the boundary can report exit 130.
 */
export const readlineWaiverPrompt: WaiverPrompt = (_decision, obligationIds) =>
  new Promise<boolean>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const onInterrupt = (): void => {
      rl.close();
      reject(new CliInterruption("Waiver prompt interrupted."));
    };
    rl.on("SIGINT", onInterrupt);
    process.stderr.write(
      `Waiving covers ${obligationIds.length} obligation(s): ${obligationIds.join(", ")}.\n`,
    );
    rl.question("Waive all of them? [y/N] ", (answer) => {
      rl.close();
      resolve(/^\s*y(es)?\s*$/i.test(answer));
    });
  });

export function defaultRuntime(): CliRuntime {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    promptForWaiver: readlineWaiverPrompt,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  return runCli(argv, defaultRuntime());
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
