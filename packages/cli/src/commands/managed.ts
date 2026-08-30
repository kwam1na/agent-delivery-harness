/**
 * `managed` — the host-facing slice of the managed-delivery facade: the
 * typed status/resume surface and the checkpoint operations an active host
 * task drives (`status`, `next`, stage results, the trusted sensor, review
 * attempts, admission, the tracked record, the finish line, and
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
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  createManagedDeliveryFacade,
  type ManagedDeliveryFacade,
} from "@agent-delivery-harness/kernel";
import { commandBlocker } from "../boundary.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

const SOURCE_ID = "delivery-harness.cli.managed";

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
}

async function resolveManaged(context: CommandContext): Promise<ResolvedManaged | CommandResult> {
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
    // terminal journal stays durable but is not the CLI's subject.
    try {
      const journal = await readFile(path.join(namespace, "deliveries", candidate, "journal.jsonl"), "utf8");
      if (!journal.includes('"to":"completed"') && !journal.includes('"to":"cancelled"')) active.push(candidate);
    } catch {
      active.push(candidate);
    }
  }
  const deliveryId = active[0] ?? deliveries[deliveries.length - 1];
  if (deliveryId === undefined || active.length > 1) {
    return blocked(
      "delivery_unresolved",
      active.length > 1 ? "Several deliveries are in flight; the skeleton drives one." : "No registered delivery exists.",
      "Register exactly one delivery for this repository.",
    );
  }
  const facade = createManagedDeliveryFacade({
    repoDir: context.rootDir,
    config: context.config,
    installation: { installationPath: pointer.installationPath, receiptDir: pointer.receiptDir },
    hostVersion: pointer.hostVersion,
  });
  return { facade, deliveryId };
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
          "managed requires an operation: status | next | submit-plan | checkpoint | run-sensor | submit-review | reduce-review | compound | admit | prepare-record | confirm-record | finish | explain-blocker",
      };
    }
    const resolved = await resolveManaged(context);
    if (isCommandResult(resolved)) return resolved;
    const { facade, deliveryId } = resolved;
    const emit = (value: unknown): void => context.write(`${JSON.stringify(value, null, 2)}\n`);

    const summaryArg = (): string => flag(rest, "--summary") ?? rest.filter((argument) => !argument.startsWith("-")).join(" ");

    switch (operation) {
      case "status": {
        const status = await facade.status({ deliveryId, observedAt: nowInstant() });
        if (!status.ok) return { kind: "blocked", blockers: [...status.blockers] };
        emit({ deliveryId, ...status });
        return { kind: "ok", summary: `state ${status.state}; next ${status.nextCheckpoint.kind}` };
      }
      case "next": {
        const next = await facade.nextCheckpoint({ deliveryId });
        if (!next.ok) return { kind: "blocked", blockers: [...next.blockers] };
        emit(next.checkpoint);
        return { kind: "ok", summary: `next checkpoint: ${next.checkpoint.kind}` };
      }
      case "submit-plan": {
        const submitted = await facade.submitStageResult({ deliveryId, stageId: "plan", resultBytes: summaryArg() });
        if (!submitted.ok) return { kind: "blocked", blockers: [...submitted.blockers] };
        return { kind: "ok", summary: `plan accepted; delivery is ${submitted.state}` };
      }
      case "checkpoint": {
        const checkpointed = await facade.checkpointCandidate({ deliveryId, resultBytes: summaryArg() });
        if (!checkpointed.ok) return { kind: "blocked", blockers: [...checkpointed.blockers] };
        return { kind: "ok", summary: `candidate ${checkpointed.treeSha} checkpointed; delivery is ${checkpointed.state}` };
      }
      case "run-sensor": {
        const sensed = await facade.runSensor({ deliveryId });
        if (!sensed.ok) return { kind: "blocked", blockers: [...sensed.blockers] };
        return { kind: "ok", summary: `sensor ${sensed.outcome}; delivery is ${sensed.state}` };
      }
      case "submit-review": {
        const attemptId = flag(rest, "--attempt");
        const lensId = flag(rest, "--lens");
        const verdict = flag(rest, "--verdict");
        const contextFile = flag(rest, "--context-file");
        const artifactFile = flag(rest, "--artifact-file");
        if (
          attemptId === undefined ||
          lensId === undefined ||
          (verdict !== "approved" && verdict !== "findings") ||
          contextFile === undefined ||
          artifactFile === undefined
        ) {
          return {
            kind: "usage",
            message: "submit-review requires --attempt <id> --lens <id> --verdict <approved|findings> --context-file <path> --artifact-file <path>.",
          };
        }
        let contextBytes: string;
        let artifactBytes: string;
        try {
          contextBytes = await readFile(path.resolve(context.rootDir, contextFile), "utf8");
          artifactBytes = await readFile(path.resolve(context.rootDir, artifactFile), "utf8");
        } catch (error) {
          return { kind: "usage", message: `submit-review could not read its files: ${error instanceof Error ? error.message : String(error)}` };
        }
        const submitted = await facade.submitReviewAttempt({ deliveryId, attemptId, lensId, verdict, contextBytes, artifactBytes });
        if (!submitted.ok) return { kind: "blocked", blockers: [...submitted.blockers] };
        return { kind: "ok", summary: `attempt ${attemptId} recorded for ${lensId}` };
      }
      case "reduce-review": {
        const reduced = await facade.reduceReview({ deliveryId });
        if (!reduced.ok) return { kind: "blocked", blockers: [...reduced.blockers] };
        return { kind: "ok", summary: `review reduced; delivery is ${reduced.state}` };
      }
      case "compound": {
        const compounded = await facade.submitStageResult({ deliveryId, stageId: "compound", resultBytes: summaryArg() });
        if (!compounded.ok) return { kind: "blocked", blockers: [...compounded.blockers] };
        return { kind: "ok", summary: `compound recorded; delivery is ${compounded.state}` };
      }
      case "admit": {
        const admitted = await facade.admit({ deliveryId, recordedAtInstant: nowInstant(), env: context.env });
        if (!admitted.ok) return { kind: "blocked", blockers: [...admitted.blockers] };
        return { kind: "ok", summary: `admitted; delivery is ${admitted.state}` };
      }
      case "prepare-record": {
        const prepared = await facade.prepareTrackedRecord({ deliveryId, env: context.env });
        if (!prepared.ok) return { kind: "blocked", blockers: [...prepared.blockers] };
        return { kind: "ok", summary: `tracked record written at ${prepared.relativePath}; commit it through native git tooling` };
      }
      case "confirm-record": {
        const confirmed = await facade.confirmTrackedRecord({ deliveryId });
        if (!confirmed.ok) return { kind: "blocked", blockers: [...confirmed.blockers] };
        return { kind: "ok", summary: `tracked record verified; delivery is ${confirmed.state}` };
      }
      case "finish": {
        const finished = await facade.completeFinishLine({ deliveryId });
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
        return { kind: "usage", message: `Unknown managed operation: ${operation}.` };
    }
  },
};
