/**
 * `prepare` — capture the candidate and publish its preparation receipt.
 *
 * The receipt is the ordering mechanism: no receipt, no review context, no
 * admission. Capturing an unprepared tree (dirty or with untracked files) is a
 * typed block, not a silent skip.
 */
import { publishPreparationReceipt } from "@agent-delivery-harness/kernel";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

export const prepareCommand: CommandDescriptor = {
  name: "prepare",
  sourceId: "delivery-harness.cli.prepare",
  summary: "Capture the candidate and publish its preparation receipt.",
  async run(context: CommandContext): Promise<CommandResult> {
    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    if (!capture.ok) {
      return { kind: "blocked", blockers: [...capture.blockers] };
    }
    const published = await publishPreparationReceipt(
      context.rootDir,
      { config: context.config, candidate: capture.candidate },
      wiring.storageOptions,
    );
    return {
      kind: "ok",
      summary: `prepared ${context.config.gateId}: tree ${capture.candidate.treeSha} (${capture.candidate.mode}); receipt ${published.path}`,
    };
  },
};
