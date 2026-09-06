/**
 * `prepare` — capture the candidate and publish its preparation receipt.
 *
 * The receipt is the ordering mechanism: no receipt, no review context, no
 * admission. Capturing an unprepared tree (dirty or with untracked files) is a
 * typed block, not a silent skip.
 */
import {
  classifyCandidateDrift,
  computePreparationFingerprint,
  createBlocker,
  createExecPort,
  invalidatePreparationReceipt,
  publishPreparationReceipt,
} from "@agent-delivery-harness/kernel";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

export const prepareCommand: CommandDescriptor = {
  name: "prepare",
  sourceId: "delivery-harness.cli.prepare",
  summary: "Capture the candidate and publish its preparation receipt.",
  async run(context: CommandContext): Promise<CommandResult> {
    const wiring = await context.wire();
    const attemptId = await invalidatePreparationReceipt(context.rootDir, context.config, wiring.storageOptions);
    const capture = await wiring.captureCandidate();
    if (!capture.ok) {
      return { kind: "blocked", blockers: [...capture.blockers] };
    }
    const fingerprint = await computePreparationFingerprint(context.rootDir, context.config, wiring.storageOptions);
    const exec = createExecPort();
    const env = Object.fromEntries(Object.entries(context.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    for (const check of context.config.preparationCommands ?? []) {
      context.write(`preparing ${check.id}`);
      const result = await exec.run({
        command: check.command[0], args: check.command.slice(1), cwd: context.rootDir,
        env, timeoutMs: check.timeoutMs, maxBuffer: 1024 * 1024,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (result.code !== 0) {
        return {
          kind: "blocked",
          blockers: [createBlocker({
            code: "preparation_command_failed", source: { kind: "command", id: "delivery-harness.cli.prepare" },
            summary: `Preparation check ${check.id} failed; no receipt was published.`,
            details: `exit ${result.code}${result.errorCode === undefined ? "" : ` (${result.errorCode})`}\n${`${result.stdout}\n${result.stderr}`.slice(-4000)}`,
            remediations: [{ id: "repair-preparation-check", kind: "manual_action", summary: `Fix ${check.id}, then run prepare again.` }],
          })],
        };
      }
    }
    const finalCapture = await wiring.captureCandidate();
    if (!finalCapture.ok) return { kind: "blocked", blockers: [...finalCapture.blockers] };
    const after = finalCapture.candidate;
    if (classifyCandidateDrift(capture.candidate, after).length > 0 ||
        capture.candidate.headSha !== after.headSha || capture.candidate.mode !== after.mode ||
        fingerprint !== await computePreparationFingerprint(context.rootDir, context.config, wiring.storageOptions)) {
      return {
        kind: "blocked",
        blockers: [createBlocker({
          code: "preparation_candidate_changed", source: { kind: "command", id: "delivery-harness.cli.prepare" },
          summary: "The candidate, base, or preparation wiring changed while checks ran; no receipt was published.",
          remediations: [{ id: "prepare-stable-candidate", kind: "manual_action", summary: "Commit any intended changes and prepare the stable candidate again." }],
        })],
      };
    }
    const published = await publishPreparationReceipt(
      context.rootDir,
      { config: context.config, candidate: capture.candidate, attemptId },
      wiring.storageOptions,
    );
    // The labelled line exists so a reader — an operator or a review round
    // about to bind itself to this candidate — has one unambiguous token to
    // copy. It is the same value the record carries as `treeSha` and the same
    // value `review-context` reports as `candidate tree`.
    return {
      kind: "ok",
      summary: [
        `prepared ${context.config.gateId}: tree ${capture.candidate.treeSha} (${capture.candidate.mode}); receipt ${published.path}`,
        `  treeSha ${capture.candidate.treeSha}`,
      ].join("\n"),
    };
  },
};
