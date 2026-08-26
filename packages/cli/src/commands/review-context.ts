/**
 * `review-context` — the reviewable-change context for a prepared candidate.
 *
 * Requires a current receipt. A missing receipt blocks and names `prepare`; a
 * stale one blocks with its own distinct class. Only once the receipt is current
 * does the command report what a provider should review and submit evidence for.
 */
import { evaluatePreparationReceipt } from "@agent-delivery-harness/kernel";
import { commandBlocker } from "../boundary.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

export const reviewContextCommand: CommandDescriptor = {
  name: "review-context",
  sourceId: "delivery-harness.cli.review-context",
  summary: "Show the reviewable-change context for the prepared candidate.",
  async run(context: CommandContext): Promise<CommandResult> {
    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    if (!capture.ok) {
      return { kind: "blocked", blockers: [...capture.blockers] };
    }

    const evaluation = await evaluatePreparationReceipt(
      context.rootDir,
      { config: context.config, candidate: capture.candidate },
      wiring.storageOptions,
    );
    if (!evaluation.prepared) {
      // The kernel's receipt blockers already name the failure class; when the
      // receipt is absent, point the operator at the command that creates it.
      const blockers = [...evaluation.blockers];
      if (evaluation.failure === "missing") {
        blockers.push(
          commandBlocker({
            code: "review_context_requires_receipt",
            sourceId: "delivery-harness.cli.review-context",
            summary: "Review context is unavailable until the candidate is prepared.",
            remediations: [
              {
                id: "run-prepare",
                kind: "command",
                command: ["delivery-harness", "prepare"],
                summary: "Publish a preparation receipt for the current candidate.",
              },
            ],
          }),
        );
      }
      return { kind: "blocked", blockers };
    }

    const projection = await wiring.projectActivation(capture.candidate);
    const active = projection.relevantLineCount >= context.config.activationThreshold || projection.hasRelevantBinaryChange;
    return {
      kind: "ok",
      summary: [
        `review context for ${context.config.gateId}:`,
        `  candidate tree ${capture.candidate.treeSha} (${capture.candidate.mode})`,
        `  relevant lines ${projection.relevantLineCount} across ${projection.changedEntryCount} changed entr${projection.changedEntryCount === 1 ? "y" : "ies"}`,
        `  activation ${active ? "active" : "inactive"} (threshold ${context.config.activationThreshold})`,
        ...(projection.sensitivePathIds.length > 0 ? [`  sensitive: ${projection.sensitivePathIds.join(", ")}`] : []),
        `  submit evidence with: delivery-harness submit-evidence --manifest <path>`,
      ].join("\n"),
    };
  },
};
