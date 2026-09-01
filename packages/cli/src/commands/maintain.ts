/**
 * `maintain` — the installation-scoped maintenance lane: update, rollback, and
 * trust-state maintenance.
 *
 * WHY THIS IS A SEPARATE COMMAND. `managed` addresses one delivery and its
 * checkpoints; these operations address the installation itself and touch no
 * delivery journal at all. Folding them into `managed` would have made a
 * delivery resolve before an operator could repair the installation that
 * delivery is blocked on — the wrong order for exactly the case the lane
 * exists to serve.
 *
 * WHAT DEFENDS THIS SURFACE, PRECISELY. Every operation here consumes a
 * maintenance-lane sensitive assertion bound to the target installation and
 * generation identities, evaluated by the installation's configured assertion
 * source in the model-external lane, and consumed BEFORE any byte moves. The
 * caller cannot mint that assertion and cannot answer the evaluation: the
 * operating system evaluates it and the product never sees a credential. So a
 * model that invokes one of these cannot complete it.
 *
 * WHAT IT DOES NOT DEFEND, STATED PLAINLY BECAUSE IT IS EASY TO ASSUME
 * OTHERWISE. It does not stop the prompt from being raised. Probing an
 * OS-native source checks that the platform's authentication surfaces exist,
 * and existence is independent of whether the caller holds a terminal — so on a
 * desktop platform a non-interactive session can still reach `evaluate`, which
 * raises an interactive dialog in the operator's own session. Authorization
 * holds, because nobody but the operator can answer it; what is not defended is
 * the operator's attention. Prompt fatigue is the residual risk on this surface,
 * and it is the reason to keep the lane narrow rather than to believe it closed.
 *
 * Operator confirmations are the class that must never be nameable on a shell
 * surface, and none of them appear here.
 *
 * The installation is located the same way `managed` locates it: from the
 * product namespace's pointer under the common git directory, never a
 * candidate-writable path.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compiledAdopterPolicyBindingDigest, createManagedDeliveryFacade, type CompiledAdopterPolicyBinding, type ManagedDeliveryFacade } from "@agent-delivery-harness/kernel";
import { commandBlocker } from "../boundary.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

const SOURCE_ID = "delivery-harness.cli.maintain";

/** Every operation this command answers, in the order its usage lists them. */
const MAINTAIN_OPERATIONS: readonly string[] = Object.freeze([
  "update",
  "rollback",
  "pin",
  "revoke",
  "unrevoke",
  "advance-high-water-mark",
]);

const blocked = (code: string, summary: string, remediation: string): CommandResult => ({
  kind: "blocked",
  blockers: [
    commandBlocker({
      code,
      sourceId: SOURCE_ID,
      summary,
      remediations: [{ id: `${code.replaceAll("_", "-")}-remediation`, kind: "manual_action", summary: remediation }],
    }),
  ],
});

const gitCommonDir = (cwd: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }, (error, stdout) => {
      resolve(error === null ? stdout.trim() : undefined);
    });
  });

const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

function nowInstant(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

async function resolveFacade(context: CommandContext): Promise<ManagedDeliveryFacade | CommandResult> {
  const common = await gitCommonDir(context.rootDir);
  if (common === undefined) {
    return blocked("not_a_repository", "The working directory is not a git repository.", "Run from the repository the product is installed for.");
  }
  let pointer: { installationPath: string; receiptDir: string; hostVersion: string; policyBindingDigest: string };
  try {
    pointer = JSON.parse(await readFile(path.join(common, "managed-delivery", "facade.json"), "utf8")) as typeof pointer;
  } catch {
    return blocked(
      "no_managed_installation",
      "No managed installation is registered for this repository.",
      "Install the composition and register a delivery first.",
    );
  }
  let policyBinding: CompiledAdopterPolicyBinding | undefined = context.policyBinding;
  if (policyBinding === undefined) {
    try {
      policyBinding = JSON.parse(await readFile(path.join(common, "managed-delivery", "policy-binding.json"), "utf8")) as CompiledAdopterPolicyBinding;
    } catch {
      return blocked(
        "policy_binding_missing",
        "No compiled adopter policy binding is retained for this installation.",
        "Register a delivery through an adopter binding, or pass one through the embedding runtime.",
      );
    }
  }
  if (pointer.policyBindingDigest !== compiledAdopterPolicyBindingDigest(policyBinding)) {
    return blocked(
      "policy_binding_mismatch",
      "The retained compiled adopter policy binding does not match the product namespace pointer.",
      "Restore the exact binding captured at registration; drift requires a new owner-approved delivery.",
    );
  }
  return createManagedDeliveryFacade({
    repoDir: context.rootDir,
    policyBinding,
    installation: { installationPath: pointer.installationPath, receiptDir: pointer.receiptDir },
    hostVersion: pointer.hostVersion,
  });
}

const isCommandResult = (value: ManagedDeliveryFacade | CommandResult): value is CommandResult => "kind" in value;

export const maintainCommand: CommandDescriptor = {
  name: "maintain",
  sourceId: SOURCE_ID,
  summary: "Maintain the product installation (update, rollback, trust-state pin/revoke/unrevoke/high-water-mark).",
  async run(context: CommandContext): Promise<CommandResult> {
    const [operation, ...rest] = context.args;
    if (operation === undefined) {
      return { kind: "usage", message: `maintain requires an operation: ${MAINTAIN_OPERATIONS.join(" | ")}` };
    }
    // A typo is a usage error about the call, answered before the repository
    // or the installation is consulted.
    if (!MAINTAIN_OPERATIONS.includes(operation)) {
      return { kind: "usage", message: `Unknown maintain operation: ${operation}.` };
    }
    const resolved = await resolveFacade(context);
    if (isCommandResult(resolved)) return resolved;
    const facade = resolved;
    const now = nowInstant();
    const emit = (value: unknown): void => context.write(`${JSON.stringify(value, null, 2)}\n`);

    switch (operation) {
      case "update": {
        const packedDir = flag(rest, "--packed");
        if (packedDir === undefined) {
          return { kind: "usage", message: "update requires --packed <dir> naming the verified packed generation to install." };
        }
        const outcome = await facade.updateComposition({ packedDir: path.resolve(context.rootDir, packedDir), now });
        if (!outcome.ok) return { kind: "blocked", blockers: [...outcome.blockers] };
        emit(outcome);
        return {
          kind: "ok",
          summary: outcome.noOp
            ? `already at ${outcome.generationDigest}`
            : `updated ${outcome.priorGenerationDigest} -> ${outcome.generationDigest}`,
        };
      }
      case "rollback": {
        const target = flag(rest, "--generation");
        if (target === undefined) {
          return { kind: "usage", message: "rollback requires --generation <digest> naming a previously accepted generation." };
        }
        const outcome = await facade.rollbackComposition({ targetGenerationDigest: target, now });
        if (!outcome.ok) return { kind: "blocked", blockers: [...outcome.blockers] };
        return { kind: "ok", summary: `rolled back to ${outcome.generationDigest}` };
      }
      case "pin":
      case "revoke":
      case "unrevoke": {
        const generationDigest = flag(rest, "--generation");
        if (generationDigest === undefined) {
          return { kind: "usage", message: `${operation} requires --generation <digest>.` };
        }
        const outcome = await facade.maintainTrustState({ operation, generationDigest, now });
        if (!outcome.ok) return { kind: "blocked", blockers: [...outcome.blockers] };
        emit(outcome.state);
        return { kind: "ok", summary: `${operation} recorded at revocation epoch ${outcome.state.revocationEpoch}` };
      }
      case "advance-high-water-mark": {
        const raw = flag(rest, "--to");
        const highWaterMark = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
        if (!Number.isInteger(highWaterMark)) {
          return { kind: "usage", message: "advance-high-water-mark requires --to <integer>." };
        }
        const outcome = await facade.maintainTrustState({ operation: "advance-high-water-mark", highWaterMark, now });
        if (!outcome.ok) return { kind: "blocked", blockers: [...outcome.blockers] };
        emit(outcome.state);
        return { kind: "ok", summary: `high-water mark is ${outcome.state.highWaterMark}` };
      }
      default:
        // Unreachable: checked against MAINTAIN_OPERATIONS above. Kept so a
        // name added to that list without a case here fails loudly.
        return { kind: "usage", message: `Unknown maintain operation: ${operation}.` };
    }
  },
};
