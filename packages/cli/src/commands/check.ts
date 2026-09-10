/**
 * `check` — confirm the config loads and the evidence store is usable.
 *
 * A preflight the operator runs before anything else. Config validity is proven
 * by the boundary having loaded it at all; this command additionally resolves the
 * git-private store *and proves it can be written to*, because a store that
 * resolves but cannot be written is exactly the failure the operator wants to
 * learn about here rather than halfway through a submission. The probe is
 * written through the fs port and removed again, so the check leaves nothing
 * behind. An unresolvable or unwritable store is a typed block, never a crash.
 */
import path from "node:path";
import { deliveryRecordPathFor, resolveRecordStorage, BlockedError } from "@agent-delivery-harness/kernel";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";
import { oneLine } from "../run-surface.ts";

/** Named so an interrupted run leaves something obviously disposable. */
const PROBE_FILE = ".delivery-harness-write-probe";

export const checkCommand: CommandDescriptor = {
  name: "check",
  sourceId: "delivery-harness.cli.check",
  summary: "Confirm the config loads and the evidence store is usable.",
  usage: "Usage: delivery-harness check\nTakes no arguments.",
  async run(context: CommandContext): Promise<CommandResult> {
    const unexpected = context.args[0];
    if (unexpected !== undefined) {
      return { kind: "usage", message: `check takes no arguments, and ${oneLine(unexpected, 64)} is one.\n${checkCommand.usage}` };
    }
    try {
      const storage = await resolveRecordStorage(context.rootDir, { storageNamespace: context.config.storageNamespace });
      const probe = path.join(storage.storageDir, PROBE_FILE);
      await context.artifacts.writeTextFile(probe, "probe\n", { mode: 0o600 });
      await context.artifacts.removeFile(probe);
      const recordPath = deliveryRecordPathFor(context.config, "<deliverableDigest>");
      const baseMovement = context.config.deliveryRecordVerification.baseMovement === "stale"
        ? "base movement stale: verification refuses base-ref, base-tip, or merge-base drift; admit again against the current base"
        : "base movement allow: verification may accept base drift and names every relaxed drift class";
      return {
        kind: "ok",
        summary: [
          `ok: gate ${context.config.gateId}`,
          `  ${context.config.obligations.length} obligation(s), ${context.config.providers.length} provider(s)`,
          `  store ${storage.storageDir} (writable)`,
          `  delivery record path ${recordPath}`,
          `  ${baseMovement}`,
        ].join("\n"),
      };
    } catch (error) {
      if (error instanceof BlockedError) {
        return { kind: "blocked", blockers: [...error.blockers] };
      }
      throw error;
    }
  },
};
