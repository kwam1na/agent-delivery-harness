/**
 * The `managed` and `maintain` operator surfaces, at the level a terminal
 * reaches them: which operations they advertise, which they refuse, and what
 * they answer before any delivery or installation exists.
 *
 * These rows deliberately drive no delivery. The delivery paths are proved by
 * the facade's own scenario suites against real repositories; what is only
 * provable here is the surface itself — that the inspectable contract answers
 * without a registered delivery, that an unknown operation is a usage refusal
 * rather than a guess, and that the maintenance lane fails closed when no
 * installation resolves.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FACADE_OPERATIONS, type FacadeOperation } from "@agent-delivery-harness/kernel";
import { maintainCommand } from "./maintain.ts";
import { managedCommand } from "./managed.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

let scratch: string;

beforeAll(async () => {
  // A directory that is deliberately not a git repository and holds no
  // installation: the fail-closed case both commands must answer.
  scratch = await mkdtemp(path.join(tmpdir(), "facade-surface-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

interface Run {
  readonly result: CommandResult;
  readonly written: string;
}

const run = async (command: CommandDescriptor, args: readonly string[], rootDir = scratch): Promise<Run> => {
  let written = "";
  const context = {
    rootDir,
    config: {} as never,
    env: {} as never,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    args,
    wire: async () => ({}) as never,
    artifacts: {} as never,
    write: (text: string) => {
      written += text;
    },
    classifyContext: () => ({}) as never,
  } as unknown as CommandContext;
  return { result: await command.run(context), written };
};

const usageOf = (result: CommandResult): string => {
  expect(result.kind).toBe("usage");
  return (result as { kind: "usage"; message: string }).message;
};

const codesOf = (result: CommandResult): readonly string[] =>
  result.kind === "blocked" ? result.blockers.map((blocker) => blocker.code) : [];

describe("managed", () => {
  it("names its operations when invoked with none", async () => {
    const message = usageOf((await run(managedCommand, [])).result);
    for (const operation of ["status", "next", "operations", "explain-blocker", "finish", "export", "delete"]) {
      expect(message).toContain(operation);
    }
  });

  it("refuses an unknown operation rather than guessing at one", async () => {
    expect(usageOf((await run(managedCommand, ["not-an-operation"])).result)).toContain("Unknown managed operation");
  });

  it("names no operator confirmation among its operations", async () => {
    const message = usageOf((await run(managedCommand, [])).result);
    expect(message).not.toContain("confirm-contract");
    expect(message).not.toContain("confirm-takeover");
    // `confirm-record` verifies a committed tracked record; it is not an
    // operator confirmation, and the distinction is the point of this row.
    expect(message).toContain("confirm-record");
  });

  it("answers the inspectable contract with no delivery registered at all", async () => {
    // The operation that explains the surface must not itself require the
    // surface to be in a working state.
    const { result, written } = await run(managedCommand, ["operations"]);
    expect(result.kind).toBe("ok");
    const parsed = JSON.parse(written) as FacadeOperation[];
    expect(parsed.length).toBe(FACADE_OPERATIONS.length);
    for (const operation of parsed) {
      expect(operation.capability.length).toBeGreaterThan(0);
      expect(["required", "absent-by-state"]).toContain(operation.fence);
    }
  });

  it("reports the inventory's own boundary in what it publishes", async () => {
    const { written } = await run(managedCommand, ["operations"]);
    const parsed = JSON.parse(written) as FacadeOperation[];
    const confirmation = parsed.filter((operation) => operation.capability === "confirmation");
    expect(confirmation.length).toBeGreaterThan(0);
    for (const operation of confirmation) expect(operation.surfaces).toEqual(["binding-channel"]);
    const provenance = parsed.find((operation) => operation.operation === "recordTerminationProvenance");
    expect(provenance?.surfaces).toEqual(["integration-event"]);
  });

  it("fails closed outside a repository", async () => {
    expect(codesOf((await run(managedCommand, ["status"], path.join(scratch, "nowhere"))).result)).toContain("not_a_repository");
  });

  it("accepts --delivery only for the retention operations", async () => {
    // A checkpoint operation derives its fence from the worktree it runs in, so
    // a delivery named by flag would not be the one that worktree is bound to.
    for (const operation of ["status", "checkpoint", "admit", "finish", "request-cancellation"]) {
      const message = usageOf((await run(managedCommand, [operation, "--delivery", "delivery-x"])).result);
      expect(message, `${operation} must reject --delivery`).toContain("--delivery is accepted only by");
    }
    // Retention operations take it, and get past argument handling to the
    // repository check rather than a usage refusal.
    for (const operation of ["export", "delete"]) {
      const result = (await run(managedCommand, [operation, "--delivery", "delivery-x"])).result;
      expect(result.kind, `${operation} must accept --delivery`).not.toBe("usage");
    }
  });

  it("refuses the --delivery=<id> form instead of silently retargeting", async () => {
    // `indexOf` never matches the joined form, so an unrefused `--delivery=id`
    // would fall back to the implicitly resolved delivery — the same
    // destructive-retarget hazard as the valueless form below.
    for (const operation of ["export", "delete"]) {
      for (const argument of ["--delivery=other-id", "--delivery="]) {
        const message = usageOf((await run(managedCommand, [operation, argument])).result);
        expect(message, `${operation} ${argument} must be refused`).toContain("--delivery takes its value as a separate argument");
      }
    }
  });

  it("refuses --delivery with no value instead of silently retargeting", async () => {
    // A trailing flag reads as absent, and absent falls back to the implicitly
    // resolved delivery — on `delete` that is a typo quietly pointing a
    // destructive operation at a different delivery.
    for (const operation of ["export", "delete"]) {
      const message = usageOf((await run(managedCommand, [operation, "--delivery"])).result);
      expect(message, `${operation} must refuse a valueless --delivery`).toContain("--delivery requires a delivery id");
    }
  });
});

describe("maintain", () => {
  it("names its operations when invoked with none", async () => {
    const message = usageOf((await run(maintainCommand, [])).result);
    for (const operation of ["update", "rollback", "pin", "revoke", "unrevoke", "advance-high-water-mark"]) {
      expect(message).toContain(operation);
    }
  });

  it("names no operator confirmation and no delivery checkpoint", async () => {
    const message = usageOf((await run(maintainCommand, [])).result);
    for (const absent of ["confirm", "checkpoint", "submit", "admit", "finish"]) {
      expect(message).not.toContain(absent);
    }
  });

  it("fails closed outside a repository", async () => {
    expect(codesOf((await run(maintainCommand, ["update", "--packed", "somewhere"])).result)).toContain("not_a_repository");
  });

  it("fails closed in a repository with no managed installation", async () => {
    // This repository is a real git repository and has no product installed,
    // which is the case an operator hits before the first install.
    expect(codesOf((await run(maintainCommand, ["update", "--packed", "somewhere"], REPO_ROOT)).result)).toContain(
      "no_managed_installation",
    );
  });

  it("refuses an unknown operation", async () => {
    expect(usageOf((await run(maintainCommand, ["escalate"])).result)).toContain("Unknown maintain operation");
  });
});
