/**
 * `gate` — evaluate the delivery gate and, under a TTY, offer a scoped waiver.
 *
 * The command classifies the execution context from this invocation's env and
 * TTY, then runs the admission adapter. The waiver prompt is the one piece of
 * interactive I/O the CLI owns: it is handed to admission only when the boundary
 * saw a real TTY (the boundary already gated `context.promptForWaiver` on that),
 * so a non-interactive run can never be prompted — it blocks. Admission itself
 * only ever offers a waiver to a `human` context, all-or-nothing over waivable
 * findings; the CLI adds no waiver logic of its own.
 */
import { runAdmission } from "@agent-delivery-harness/kernel";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

export const gateCommand: CommandDescriptor = {
  name: "gate",
  sourceId: "delivery-harness.cli.gate",
  summary: "Evaluate the delivery gate for the current candidate.",
  async run(context: CommandContext): Promise<CommandResult> {
    const wiring = await context.wire();
    const result = await runAdmission(
      {
        rootDir: context.rootDir,
        config: context.config,
        context: context.classifyContext(),
        ...(context.liveResults === undefined ? {} : { liveResults: context.liveResults }),
      },
      {
        captureCandidate: wiring.captureCandidate,
        projectActivation: wiring.projectActivation,
        ...(context.promptForWaiver === undefined ? {} : { promptForWaiver: context.promptForWaiver }),
        ...wiring.storageOptions,
      },
    );

    if (result.admitted) {
      const waiverNote =
        result.waiver === "accepted"
          ? ` (waived: ${result.waivedObligationIds.join(", ")})`
          : "";
      const kinds = (result.decision?.resolutions ?? []).map((resolution) => `${resolution.obligationId}=${resolution.kind}`);
      return { kind: "ok", summary: `admitted${waiverNote}: ${kinds.join(", ")}` };
    }
    return { kind: "blocked", blockers: [...result.blockers] };
  },
};
