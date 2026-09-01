/**
 * `managed` — the host-facing slice of the managed-delivery facade: the
 * typed status/resume surface and the checkpoint operations an active host
 * task drives (`status`, `next`, stage results, the trusted sensor, review
 * reduction, admission, the tracked record, the finish line, and
 * `explain-blocker`).
 *
 * WHAT IS DELIBERATELY NOT HERE. The operator confirmations — contract
 * confirmation and takeover authorization — are served only by the facade
 * module's binding-owned channel, outside the model-visible tool and shell
 * surface; this command exposes no `confirm` operation at all, so a session
 * cannot even name one here. Worktree creation stays with the host, and the
 * command launches no agent process.
 *
 * The facade is resolved from the product namespace's pointer (written at
 * delivery registration, under the common git directory — never a
 * candidate-writable path), and the walking skeleton carries one delivery per
 * repository: zero or several registered deliveries is a typed refusal.
 */
import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  FACADE_OPERATIONS,
  createManagedDeliveryFacade,
  type CompiledAdopterPolicyBinding,
  type ManagedDeliveryFacade,
} from "@agent-delivery-harness/kernel";
import { commandBlocker } from "../boundary.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

const SOURCE_ID = "delivery-harness.cli.managed";

/** Every operation this command answers, in the order its usage lists them. */
const MANAGED_OPERATIONS: readonly string[] = Object.freeze([
  "status",
  "next",
  "operations",
  "blockers",
  "explain-blocker",
  "submit-plan",
  "checkpoint",
  "run-sensor",
  "reduce-review",
  "compound",
  "admit",
  "prepare-record",
  "confirm-record",
  "finish",
  "propose-approval",
  "request-cancellation",
  "finalize-cancellation",
  "recover",
  "export",
  "delete",
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

function nowInstant(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

interface ResolvedManaged {
  readonly facade: ManagedDeliveryFacade;
  readonly deliveryId: string;
  /**
   * The invoking task's fence, derived from the worktree this command runs
   * in — never a caller-supplied flag. Fresh-worktree-only resume makes
   * worktree and fence one-to-one, so a command invoked from the currently
   * bound worktree carries the current fence, and a command invoked from a
   * superseded or foreign worktree carries none: the fence-carrying
   * operations then fail closed instead of recording a stale task's output.
   */
  readonly fence: number | undefined;
}

/**
 * Resolves the delivery this invocation addresses.
 *
 * `requested` exists for the retention operations alone. The skeleton's rule —
 * one delivery in flight per repository — is right for every checkpoint
 * operation, but it makes the retention lane unusable the moment a repository
 * has finished more than one delivery: `active[0] ?? deliveries.at(-1)` then
 * addresses only the newest, and every earlier terminal delivery's durable
 * detail becomes unreachable from the CLI even though the facade can export and
 * delete it. Naming one explicitly is the whole remedy, and it is deliberately
 * NOT offered to the checkpoint operations: those bind an invocation fence
 * derived from the worktree, and a delivery named by flag would not be the one
 * that worktree is bound to.
 */
async function resolveManaged(context: CommandContext, requested?: string): Promise<ResolvedManaged | CommandResult> {
  const common = await gitCommonDir(context.rootDir);
  if (common === undefined) {
    return blocked("not_a_repository", "The working directory is not a git repository.", "Run from the delivery worktree.");
  }
  const namespace = path.join(common, "managed-delivery");
  let pointer: { installationPath: string; receiptDir: string; hostVersion: string };
  try {
    pointer = JSON.parse(await readFile(path.join(namespace, "facade.json"), "utf8")) as typeof pointer;
  } catch {
    return blocked(
      "no_managed_delivery",
      "No managed delivery is registered for this repository.",
      "Register a delivery through the facade's contract handoff first.",
    );
  }
  let deliveries: string[];
  try {
    deliveries = (await readdir(path.join(namespace, "deliveries"))).sort();
  } catch {
    deliveries = [];
  }
  const active: string[] = [];
  for (const candidate of deliveries) {
    // The walking skeleton addresses the one delivery still in flight; a
    // terminal journal stays durable but is not the CLI's subject. Terminal
    // means a committed transition into a terminal state — never a substring
    // of some model-authored payload.
    try {
      const journal = await readFile(path.join(namespace, "deliveries", candidate, "journal.jsonl"), "utf8");
      const terminal = journal
        .split("\n")
        .filter((line) => line.length > 0)
        .some((line) => {
          try {
            const entry = JSON.parse(line) as { kind?: string; payload?: { to?: string } };
            return (
              entry.kind === "transition.committed" &&
              ["completed", "cancelled", "failed"].includes(entry.payload?.to ?? "")
            );
          } catch {
            return false;
          }
        });
      if (!terminal) active.push(candidate);
    } catch {
      active.push(candidate);
    }
  }
  let deliveryId: string | undefined;
  if (requested !== undefined) {
    if (!deliveries.includes(requested)) {
      return blocked(
        "delivery_unresolved",
        `No delivery ${requested} is registered for this repository.`,
        "Name a delivery this repository registered; `managed status` reports the current one.",
      );
    }
    deliveryId = requested;
  } else {
    deliveryId = active[0] ?? deliveries[deliveries.length - 1];
    if (deliveryId === undefined || active.length > 1) {
      return blocked(
        "delivery_unresolved",
        active.length > 1 ? "Several deliveries are in flight; the skeleton drives one." : "No registered delivery exists.",
        "Register exactly one delivery for this repository, or name one with --delivery for export and delete.",
      );
    }
  }
  let policyBinding: CompiledAdopterPolicyBinding | undefined = context.policyBinding;
  if (policyBinding === undefined) {
    try {
      policyBinding = JSON.parse(await readFile(path.join(namespace, "policy-binding.json"), "utf8")) as CompiledAdopterPolicyBinding;
    } catch {
      return blocked(
        "policy_binding_missing",
        "No compiled adopter policy binding is retained for this delivery.",
        "Register the delivery through an adopter binding, or pass one through the embedding runtime.",
      );
    }
  }
  const facade = createManagedDeliveryFacade({
    repoDir: context.rootDir,
    policyBinding,
    installation: { installationPath: pointer.installationPath, receiptDir: pointer.receiptDir },
    hostVersion: pointer.hostVersion,
  });

  let fence: number | undefined;
  try {
    const workspace = JSON.parse(
      await readFile(path.join(namespace, "deliveries", deliveryId, "workspace.json"), "utf8"),
    ) as { worktreeDir?: string; fence?: number };
    if (typeof workspace.worktreeDir === "string" && typeof workspace.fence === "number") {
      const [boundReal, hereReal] = await Promise.all([realpath(workspace.worktreeDir), realpath(context.rootDir)]);
      if (boundReal === hereReal) fence = workspace.fence;
    }
  } catch {
    fence = undefined; // no bound workspace yet; fence-carrying operations fail closed
  }
  return { facade, deliveryId, fence };
}

const isCommandResult = (value: ResolvedManaged | CommandResult): value is CommandResult => "kind" in value;

export const managedCommand: CommandDescriptor = {
  name: "managed",
  sourceId: SOURCE_ID,
  summary: "Drive the managed delivery's next checkpoint (status, stages, sensor, review, admission, record, finish).",
  async run(context: CommandContext): Promise<CommandResult> {
    const [operation, ...rest] = context.args;
    if (operation === undefined) {
      return {
        kind: "usage",
        message:
          `managed requires an operation: ${MANAGED_OPERATIONS.join(" | ")}`,
      };
    }
    // An unknown operation is a usage error about the CALL, and it is answered
    // before anything about the repository is consulted: a typo answered with
    // "this is not a repository" sends a reader to fix the wrong thing.
    if (!MANAGED_OPERATIONS.includes(operation)) {
      return { kind: "usage", message: `Unknown managed operation: ${operation}.` };
    }

    // The inspectable contract: every operation, what it costs, whether it
    // binds the fence, and which surfaces reach it. It describes the product,
    // not a delivery, so it answers before any delivery has to resolve —
    // otherwise the one operation that explains the surface would be
    // unavailable exactly when a reader most needs it.
    if (operation === "operations") {
      context.write(`${JSON.stringify(FACADE_OPERATIONS, null, 2)}\n`);
      return { kind: "ok", summary: `${FACADE_OPERATIONS.length} facade operations` };
    }

    // Only the retention operations may name a delivery; everything else binds
    // the fence of the worktree it runs in.
    const RETENTION_OPERATIONS = ["export", "delete"];
    // Every flag on this surface is space-separated, and this one is refused in
    // the GNU `--flag=value` form rather than parsed: accepting it here alone
    // would make the convention inconsistent, and letting it through unread is
    // the silent-retarget hazard below by another spelling — `indexOf` never
    // matches `--delivery=id`, so it would fall back to the implicitly resolved
    // delivery and point a destructive operation somewhere the operator did not
    // name.
    if (rest.some((argument) => argument.startsWith("--delivery="))) {
      return { kind: "usage", message: "--delivery takes its value as a separate argument: --delivery <id>." };
    }
    const namesDelivery = rest.includes("--delivery");
    if (namesDelivery && !RETENTION_OPERATIONS.includes(operation)) {
      return { kind: "usage", message: `--delivery is accepted only by: ${RETENTION_OPERATIONS.join(", ")}.` };
    }
    const requestedDelivery = RETENTION_OPERATIONS.includes(operation) ? flag(rest, "--delivery") : undefined;
    // A trailing `--delivery` with no value reads as absent, and absent falls
    // back to the implicitly resolved delivery. On `delete` that is a typo
    // silently retargeting a destructive operation at a different delivery, so
    // the flag's presence without a value is a refusal rather than a default.
    if (namesDelivery && requestedDelivery === undefined) {
      return { kind: "usage", message: "--delivery requires a delivery id." };
    }

    const resolved = await resolveManaged(context, requestedDelivery);
    if (isCommandResult(resolved)) return resolved;
    const { facade, deliveryId, fence } = resolved;
    const requireFence = (): number | CommandResult =>
      fence ??
      blocked(
        "workspace_superseded",
        "This worktree is not the delivery's currently bound workspace, so it carries no invocation fence.",
        "Drive checkpoints from the bound worktree; a superseded task's outputs are permanently rejected.",
      );
    const emit = (value: unknown): void => context.write(`${JSON.stringify(value, null, 2)}\n`);

    /**
     * The typed stage-result document a checkpoint submits. Prose cannot
     * advance the reducer, so these operations read a
     * `workflow-stage-result/1` file rather than accepting free text.
     */
    const resultFileArg = async (operation: string): Promise<string | CommandResult> => {
      const file = flag(rest, "--result-file");
      if (file === undefined) {
        return {
          kind: "usage",
          message: `${operation} requires --result-file <path> containing a typed workflow-stage-result/1 document; prose cannot advance a checkpoint.`,
        };
      }
      try {
        return await readFile(path.resolve(context.rootDir, file), "utf8");
      } catch (error) {
        return { kind: "usage", message: `${operation} could not read ${file}: ${error instanceof Error ? error.message : String(error)}` };
      }
    };

    switch (operation) {
      case "status": {
        const status = await facade.status({ deliveryId, observedAt: nowInstant() });
        if (!status.ok) return { kind: "blocked", blockers: [...status.blockers] };
        emit(status.status);
        return {
          kind: "ok",
          summary: `state ${status.status.delivery.state}; host ${status.status.hostActivity}; next ${status.status.nextCheckpoint.kind}`,
        };
      }
      case "blockers": {
        const inventory = await facade.blockerInventory({ deliveryId });
        if (!inventory.ok) return { kind: "blocked", blockers: [...inventory.blockers] };
        emit(inventory.entries);
        return { kind: "ok", summary: `${inventory.entries.length} blocker(s) journaled` };
      }
      case "propose-approval": {
        const requestKind = flag(rest, "--kind");
        const criterionId = flag(rest, "--criterion");
        const actorId = flag(rest, "--actor");
        const reason = flag(rest, "--reason");
        if ((requestKind !== "waiver" && requestKind !== "amendment") || criterionId === undefined || actorId === undefined || reason === undefined) {
          return {
            kind: "usage",
            message: "propose-approval requires --kind <waiver|amendment> --criterion <id> --actor <id> --reason <text>.",
          };
        }
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        // Proposing is all this does. The approval half is the sensitive lane's
        // and needs a fresh assertion the proposer cannot mint.
        const proposed = await facade.recordApprovalRequest({
          deliveryId,
          requestKind,
          criterionId,
          actorId,
          reason,
          fence: invokingFence,
        });
        if (!proposed.ok) return { kind: "blocked", blockers: [...proposed.blockers] };
        return { kind: "ok", summary: `${requestKind} proposed for ${criterionId}; delivery is ${proposed.state}` };
      }
      case "request-cancellation": {
        const requested = await facade.requestCancellation({ deliveryId });
        if (!requested.ok) return { kind: "blocked", blockers: [...requested.blockers] };
        return { kind: "ok", summary: `cancellation requested; delivery is ${requested.state}` };
      }
      case "finalize-cancellation": {
        const finalized = await facade.finalizeCancellation({ deliveryId });
        if (!finalized.ok) return { kind: "blocked", blockers: [...finalized.blockers] };
        return { kind: "ok", summary: `prior workspace quarantined; delivery is ${finalized.state}` };
      }
      case "export": {
        const exported = await facade.exportDelivery({ deliveryId });
        if (!exported.ok) return { kind: "blocked", blockers: [...exported.blockers] };
        emit({ exportPath: exported.exportPath, artifactDigest: exported.artifactDigest });
        return { kind: "ok", summary: `exported to ${exported.exportPath}` };
      }
      case "delete": {
        const deleted = await facade.deleteDelivery({ deliveryId });
        if (!deleted.ok) return { kind: "blocked", blockers: [...deleted.blockers] };
        emit({ preservedAuditRecords: deleted.preservedAuditRecords });
        return { kind: "ok", summary: `deleted; ${deleted.preservedAuditRecords.length} audit record(s) preserved` };
      }
      case "recover": {
        const target = flag(rest, "--generation");
        const recovered = await facade.recoverSecurityBlocked({
          deliveryId,
          now: nowInstant(),
          ...(target === undefined ? {} : { targetGenerationDigest: target }),
        });
        if (!recovered.ok) return { kind: "blocked", blockers: [...recovered.blockers] };
        return { kind: "ok", summary: `${recovered.mode}; delivery is ${recovered.state}` };
      }
      case "next": {
        const next = await facade.nextCheckpoint({ deliveryId });
        if (!next.ok) return { kind: "blocked", blockers: [...next.blockers] };
        emit(next.checkpoint);
        return { kind: "ok", summary: `next checkpoint: ${next.checkpoint.kind}` };
      }
      case "submit-plan": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const resultBytes = await resultFileArg("submit-plan");
        if (typeof resultBytes !== "string") return resultBytes;
        const submitted = await facade.submitStageResult({ deliveryId, stageId: "plan", resultBytes, fence: invokingFence });
        if (!submitted.ok) return { kind: "blocked", blockers: [...submitted.blockers] };
        return { kind: "ok", summary: `plan accepted; delivery is ${submitted.state}` };
      }
      case "checkpoint": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const resultBytes = await resultFileArg("checkpoint");
        if (typeof resultBytes !== "string") return resultBytes;
        const checkpointed = await facade.checkpointCandidate({ deliveryId, resultBytes, fence: invokingFence });
        if (!checkpointed.ok) return { kind: "blocked", blockers: [...checkpointed.blockers] };
        return { kind: "ok", summary: `candidate ${checkpointed.treeSha} checkpointed; delivery is ${checkpointed.state}` };
      }
      case "run-sensor": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const sensed = await facade.runSensor({ deliveryId, fence: invokingFence });
        if (!sensed.ok) return { kind: "blocked", blockers: [...sensed.blockers] };
        return { kind: "ok", summary: `sensor ${sensed.outcome}; delivery is ${sensed.state}` };
      }
      case "reduce-review": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const reduced = await facade.reduceReview({ deliveryId, fence: invokingFence });
        if (!reduced.ok) return { kind: "blocked", blockers: [...reduced.blockers] };
        return { kind: "ok", summary: `review reduced; delivery is ${reduced.state}` };
      }
      case "compound": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const resultBytes = await resultFileArg("compound");
        if (typeof resultBytes !== "string") return resultBytes;
        const compounded = await facade.submitStageResult({ deliveryId, stageId: "compound", resultBytes, fence: invokingFence });
        if (!compounded.ok) return { kind: "blocked", blockers: [...compounded.blockers] };
        return { kind: "ok", summary: `compound recorded; delivery is ${compounded.state}` };
      }
      case "admit": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const admitted = await facade.admit({ deliveryId, recordedAtInstant: nowInstant(), env: context.env, fence: invokingFence });
        if (!admitted.ok) return { kind: "blocked", blockers: [...admitted.blockers] };
        return { kind: "ok", summary: `admitted; delivery is ${admitted.state}` };
      }
      case "prepare-record": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const prepared = await facade.prepareTrackedRecord({ deliveryId, env: context.env, fence: invokingFence });
        if (!prepared.ok) return { kind: "blocked", blockers: [...prepared.blockers] };
        return { kind: "ok", summary: `tracked record written at ${prepared.relativePath}; commit it through native git tooling` };
      }
      case "confirm-record": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const confirmed = await facade.confirmTrackedRecord({ deliveryId, fence: invokingFence });
        if (!confirmed.ok) return { kind: "blocked", blockers: [...confirmed.blockers] };
        return { kind: "ok", summary: `tracked record verified; delivery is ${confirmed.state}` };
      }
      case "finish": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const finished = await facade.completeFinishLine({ deliveryId, fence: invokingFence });
        if (!finished.ok) return { kind: "blocked", blockers: [...finished.blockers] };
        return { kind: "ok", summary: `merge-ready; delivery is ${finished.state} (result ${finished.resultDigest})` };
      }
      case "explain-blocker": {
        const explained = await facade.explainBlocker({ deliveryId });
        if (!explained.ok) return { kind: "blocked", blockers: [...explained.blockers] };
        emit(explained.blocker ?? { blocker: null });
        return { kind: "ok", summary: explained.blocker === undefined ? "no blocker recorded" : `blocker ${explained.blocker.code}` };
      }
      default:
        // Unreachable: the operation was checked against MANAGED_OPERATIONS
        // before the delivery resolved. Kept so adding a name to that list
        // without a case here fails loudly rather than silently doing nothing.
        return { kind: "usage", message: `Unknown managed operation: ${operation}.` };
    }
  },
};
