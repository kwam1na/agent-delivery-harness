/**
 * Delivery harness CLI: the seven-command operator surface.
 *
 * THE COMMAND REGISTRY. `COMMANDS` is the single source of truth for which
 * commands exist. Every command module under `commands/` must appear here, and
 * `scripts/check-cli-inventory.ts` enforces that against the filesystem: a
 * command file that is not registered is a finding, and an empty registry fails
 * the sensor outright (a CLI that offers nothing is not a CLI). Registration is
 * the mechanism; the sensor is only the alarm.
 *
 * The boundary, the exit codes, the config loader, and the repo wiring all live
 * in `boundary.ts`; each command is a thin, testable unit behind it.
 */
import { checkCommand } from "./commands/check.ts";
import { gateCommand } from "./commands/gate.ts";
import { prepareCommand } from "./commands/prepare.ts";
import { recordCommand } from "./commands/record.ts";
import { reviewContextCommand } from "./commands/review-context.ts";
import { submitEvidenceCommand } from "./commands/submit-evidence.ts";
import { verifyCommand } from "./commands/verify.ts";
import { runCliBoundary, type CliRuntime, type CommandDescriptor } from "./boundary.ts";

export const PACKAGE_NAME = "@delivery-harness/cli";

/**
 * The command registry. The order here is the order `--help` lists them, and it
 * follows the loop an operator walks: prepare, review, submit, gate, record,
 * verify — with `check` last as the standalone preflight.
 */
export const COMMANDS: readonly CommandDescriptor[] = [
  prepareCommand,
  reviewContextCommand,
  submitEvidenceCommand,
  gateCommand,
  recordCommand,
  verifyCommand,
  checkCommand,
];

export {
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_POLICY,
  EXIT_USAGE,
  CliInterruption,
  runCliBoundary,
  wireRepo,
  importHarnessConfig,
  commandBlocker,
  type CliRuntime,
  type CommandContext,
  type CommandDescriptor,
  type CommandResult,
  type RepoWiring,
} from "./boundary.ts";

export { prepareCommand } from "./commands/prepare.ts";
export { reviewContextCommand } from "./commands/review-context.ts";
export { submitEvidenceCommand } from "./commands/submit-evidence.ts";
export { gateCommand } from "./commands/gate.ts";
export { recordCommand } from "./commands/record.ts";
export { verifyCommand } from "./commands/verify.ts";
export { checkCommand } from "./commands/check.ts";

/** Runs the CLI against a runtime and returns the process exit code. */
export function runCli(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  return runCliBoundary(argv, COMMANDS, runtime);
}
