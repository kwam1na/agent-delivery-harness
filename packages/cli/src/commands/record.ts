/**
 * `record` — promote an admitted gate into the tracked delivery record.
 *
 * The record is the one artifact that crosses out of the git-private workspace
 * into the tracked tree. The command runs the gate, refuses unless it admitted,
 * and refuses again if the deliverable identity moved between the gate and the
 * write — a record must describe the candidate it attests, so a re-capture
 * adjacent to the write is what makes "record after an edit" a refusal rather
 * than a lie. The record object and its bytes are produced by the kernel
 * (`delivery-record.ts`, produce-only); the single write goes through the fs
 * port, and the candidate-keyed path keeps parallel branches from colliding
 * while staying exactly recomputable by the Action.
 */
import {
  buildDeliveryRecord,
  deliveryRecordBytes,
  deliveryRecordPathFor,
  discoverRecords,
  runAdmission,
  type EvidenceRecord,
} from "@delivery-harness/kernel";
import path from "node:path";
import { commandBlocker } from "../boundary.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

export const recordCommand: CommandDescriptor = {
  name: "record",
  sourceId: "delivery-harness.cli.record",
  summary: "Write the tracked delivery record for an admitted gate.",
  async run(context: CommandContext): Promise<CommandResult> {
    const wiring = await context.wire();

    // The gate is run without a prompt: `record` is not the waiver surface. If a
    // waiver is needed, the operator runs `gate` first; here a non-admitting gate
    // is simply a refusal.
    const admission = await runAdmission(
      { rootDir: context.rootDir, config: context.config, context: context.classifyContext() },
      { captureCandidate: wiring.captureCandidate, projectActivation: wiring.projectActivation, ...wiring.storageOptions },
    );
    if (!admission.admitted || admission.decision === undefined) {
      return { kind: "blocked", blockers: [...admission.blockers] };
    }
    const decision = admission.decision;

    // Refuse when the gate result no longer describes the current deliverable
    // identity: a re-capture adjacent to the write.
    const recheck = await wiring.captureCandidate();
    if (!recheck.ok) {
      return { kind: "blocked", blockers: [...recheck.blockers] };
    }
    if (recheck.candidate.deliverable.digest !== decision.candidate.deliverable.digest) {
      return {
        kind: "blocked",
        blockers: [
          commandBlocker({
            code: "record_identity_changed",
            sourceId: this.sourceId,
            summary: "The deliverable identity changed after the gate; nothing was recorded.",
            details: `gate ${decision.candidate.deliverable.digest} but current ${recheck.candidate.deliverable.digest}`,
            remediations: [
              {
                id: "reprepare-and-record",
                kind: "command",
                command: ["delivery-harness", "prepare"],
                summary: "Re-prepare the candidate and re-run the gate before recording.",
              },
            ],
          }),
        ],
      };
    }

    // Gather the evidence records backing the decision so each evidence claim can
    // be stamped with its manifest digest.
    const evidenceRecords: EvidenceRecord[] = [];
    for (const obligation of context.config.obligations) {
      const discovery = await discoverRecords(context.rootDir, {
        gateId: context.config.gateId,
        obligationId: obligation.id,
        ...wiring.storageOptions,
      });
      evidenceRecords.push(...discovery.records);
    }

    const built = buildDeliveryRecord({ config: context.config, decision, evidenceRecords });
    if (!built.ok) {
      return { kind: "blocked", blockers: [...built.blockers] };
    }

    const relativePath = deliveryRecordPathFor(context.config, decision.candidate.deliverable.digest);
    const absolutePath = path.join(context.rootDir, relativePath);
    await context.artifacts.writeTextFile(absolutePath, deliveryRecordBytes(built.record));

    return { kind: "ok", summary: `recorded ${relativePath}` };
  },
};
