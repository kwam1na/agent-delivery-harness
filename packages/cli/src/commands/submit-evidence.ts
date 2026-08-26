/**
 * `submit-evidence` — validate a provider manifest and publish per-claim records.
 *
 * A thin caller over the recorder: the SUB rules, the run-root containment and
 * artifact digest checks, and the record writes all live in the kernel. The
 * command's only jobs are to find the manifest path in argv and to map the three
 * submission outcomes onto exit codes. Rejections and blocks both surface their
 * typed blockers; an acceptance reports the digest and the records it wrote.
 */
import { submitManifest } from "@delivery-harness/kernel";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

function manifestPathFrom(args: readonly string[]): string | undefined {
  const flagIndex = args.indexOf("--manifest");
  if (flagIndex !== -1) return args[flagIndex + 1];
  // A lone positional is accepted too, but never a flag mistaken for a path.
  const positional = args.find((argument) => !argument.startsWith("-"));
  return positional;
}

export const submitEvidenceCommand: CommandDescriptor = {
  name: "submit-evidence",
  sourceId: "delivery-harness.cli.submit-evidence",
  summary: "Validate a provider manifest and publish its evidence records.",
  async run(context: CommandContext): Promise<CommandResult> {
    const manifestPath = manifestPathFrom(context.args);
    if (manifestPath === undefined || manifestPath === "") {
      return { kind: "usage", message: "submit-evidence requires --manifest <path>." };
    }

    const wiring = await context.wire();
    const outcome = await submitManifest(
      { rootDir: context.rootDir, manifestPath, config: context.config },
      { captureCandidate: wiring.captureCandidate, artifacts: context.artifacts, ...wiring.storageOptions },
    );

    if (outcome.status === "accepted") {
      const lines = outcome.records.map(
        (record) => `  ${record.obligationId}: ${record.status} ${record.recordId}`,
      );
      return {
        kind: "ok",
        summary: [`accepted (manifestDigest ${outcome.manifestDigest}):`, ...lines].join("\n"),
      };
    }
    return { kind: "blocked", blockers: [...outcome.blockers] };
  },
};
