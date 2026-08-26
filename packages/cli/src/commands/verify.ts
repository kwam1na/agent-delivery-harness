/**
 * `verify` — recompute the deliverable identity and check the tracked record.
 *
 * The command captures the current candidate, derives the candidate-keyed record
 * path from the recomputed deliverable identity (the same exact lookup the
 * Action performs from the PR head), reads and parses the record, and hands it to
 * the pure `verifyDeliveryRecord` core. A missing record names the command that
 * writes it; a failed check surfaces the named drift class. When the base-movement
 * policy is `allow`, a passing check that relaxed base drift names the relaxation.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deliveryRecordPathFor, parseDeliveryRecord, verifyDeliveryRecord } from "@agent-delivery-harness/kernel";
import { commandBlocker } from "../boundary.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

export const verifyCommand: CommandDescriptor = {
  name: "verify",
  sourceId: "delivery-harness.cli.verify",
  summary: "Verify the tracked delivery record against the current candidate.",
  async run(context: CommandContext): Promise<CommandResult> {
    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    if (!capture.ok) {
      return { kind: "blocked", blockers: [...capture.blockers] };
    }
    const identity = {
      deliverableDigest: capture.candidate.deliverable.digest,
      identityToken: capture.candidate.deliverable.identity,
    };
    const base = {
      ref: capture.candidate.base.ref,
      tipSha: capture.candidate.base.tipSha,
      mergeBaseSha: capture.candidate.base.mergeBaseSha,
    };

    const relativePath = deliveryRecordPathFor(context.config, identity.deliverableDigest);
    const absolutePath = path.join(context.rootDir, relativePath);

    let text: string;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch {
      return {
        kind: "blocked",
        blockers: [
          commandBlocker({
            code: "delivery_record_missing",
            sourceId: "delivery-harness.cli.verify",
            summary: "No delivery record describes the current candidate.",
            details: `expected ${relativePath}`,
            remediations: [
              {
                id: "run-record",
                kind: "command",
                command: ["delivery-harness", "record"],
                summary: "Record the admitted gate for this candidate.",
              },
            ],
          }),
        ],
      };
    }

    const parsed = parseDeliveryRecord(text);
    if (!parsed.ok) {
      return { kind: "blocked", blockers: [...parsed.blockers] };
    }

    const check = verifyDeliveryRecord(context.config, parsed.record, identity, base);
    if (!check.ok) {
      return { kind: "blocked", blockers: [...check.blockers] };
    }

    const relaxation = check.baseMovementRelaxed
      ? ` (base movement relaxed by policy: ${check.relaxedDriftClasses.join(", ")})`
      : "";
    return {
      kind: "ok",
      summary: `verified ${relativePath}${relaxation}; attestation: ${check.attestationLabel}`,
    };
  },
};
