/**
 * `check` — confirm the config loads and the evidence store is reachable.
 *
 * A preflight the operator runs before anything else. Config validity is proven
 * by the boundary having loaded it at all; this command additionally resolves the
 * git-private store (an unresolvable or unwritable one is a typed block, not a
 * crash) and reports the gate it would run. It writes nothing.
 */
import { resolveRecordStorage, BlockedError } from "@delivery-harness/kernel";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

export const checkCommand: CommandDescriptor = {
  name: "check",
  sourceId: "delivery-harness.cli.check",
  summary: "Confirm the config loads and the evidence store is reachable.",
  async run(context: CommandContext): Promise<CommandResult> {
    try {
      const storage = await resolveRecordStorage(context.rootDir, { storageNamespace: context.config.storageNamespace });
      return {
        kind: "ok",
        summary: [
          `ok: gate ${context.config.gateId}`,
          `  ${context.config.obligations.length} obligation(s), ${context.config.providers.length} provider(s)`,
          `  store ${storage.storageDir}`,
          `  delivery record path ${context.config.deliveryRecordPath} (base movement: ${context.config.deliveryRecordVerification.baseMovement})`,
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
