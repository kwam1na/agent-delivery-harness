/**
 * The facade contract-inventory sensor.
 *
 * WHY IT LIVES HERE. The facade's boundary is a claim about three surfaces at
 * once — the kernel's operation inventory, the CLI's operations, and the MCP
 * tool list — and this is the only package that can see all three without
 * inverting a dependency direction. A check that could only see one of them
 * would pass while the other two drifted, which is precisely the failure it
 * exists to catch.
 *
 * WHAT IT HOLDS. Four things, each of which is a line the product would stop
 * being the product without:
 *
 *   - every operation a surface offers is one the inventory declares;
 *   - the MCP surface offers read-class operations and nothing else, so a tool
 *     call inspects the delivery rather than orchestrating it;
 *   - no operator confirmation and no termination-provenance operation is
 *     nameable from a model-visible surface; and
 *   - the product launches no subordinate agent runtime.
 *
 * The last one is a source scan rather than a behavioural test on purpose: the
 * absence of a spawn is not observable by calling anything, and the way it
 * would come back is a new call site, not a changed result.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMANDS, managedCommand } from "@agent-delivery-harness/cli";
import { FACADE_OPERATIONS, checkFacadeSurfaceInvariants, facadeOperation } from "@agent-delivery-harness/kernel";
import { MANAGED_READ_OPERATIONS, callTool, listTools } from "./server.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The CLI operation names, mapped to the facade operations they drive.
 *
 * The CLI names an operation the way an operator would type it; the inventory
 * names the facade method. Keeping the map explicit is what makes a renamed
 * command a failing row here rather than a silently unlisted operation.
 */
const CLI_OPERATION_MAP: Readonly<Record<string, string>> = Object.freeze({
  status: "status",
  next: "nextCheckpoint",
  operations: "status",
  blockers: "blockerInventory",
  "explain-blocker": "explainBlocker",
  "submit-plan": "submitStageResult",
  compound: "submitStageResult",
  checkpoint: "checkpointCandidate",
  "run-sensor": "runSensor",
  "submit-review": "submitReviewAttempt",
  "reduce-review": "reduceReview",
  admit: "admit",
  "prepare-record": "prepareTrackedRecord",
  "confirm-record": "confirmTrackedRecord",
  finish: "completeFinishLine",
  "propose-approval": "recordApprovalRequest",
  "request-cancellation": "requestCancellation",
  "finalize-cancellation": "finalizeCancellation",
  recover: "recoverSecurityBlocked",
  export: "exportDelivery",
  delete: "deleteDelivery",
});

const MAINTAIN_OPERATION_MAP: Readonly<Record<string, string>> = Object.freeze({
  update: "updateComposition",
  rollback: "rollbackComposition",
  pin: "maintainTrustState",
  revoke: "maintainTrustState",
  unrevoke: "maintainTrustState",
  "advance-high-water-mark": "maintainTrustState",
});

/** The operation names a command's usage message advertises. */
function advertisedOperations(usage: string): readonly string[] {
  const list = usage.slice(usage.indexOf(":") + 1);
  return list
    .split("|")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && /^[a-z-]+$/.test(name));
}

async function usageMessageOf(commandName: string): Promise<string> {
  const command = COMMANDS.find((candidate) => candidate.name === commandName);
  expect(command, `${commandName} must be registered`).toBeDefined();
  const result = await (command as NonNullable<typeof command>).run({
    rootDir: REPO_ROOT,
    config: {} as never,
    env: {} as never,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    args: [],
    wire: async () => ({}) as never,
    artifacts: {} as never,
    write: () => {},
  } as never);
  expect(result.kind).toBe("usage");
  return (result as { kind: "usage"; message: string }).message;
}

describe("the facade's own inventory", () => {
  it("holds every surface invariant", () => {
    expect(checkFacadeSurfaceInvariants(FACADE_OPERATIONS)).toEqual([]);
  });
});

describe("the CLI surface", () => {
  it("advertises only operations the inventory declares", async () => {
    for (const name of advertisedOperations(await usageMessageOf("managed"))) {
      const mapped = CLI_OPERATION_MAP[name];
      expect(mapped, `managed ${name} has no mapped facade operation`).toBeDefined();
      expect(facadeOperation(mapped as string), `${mapped} is not in the inventory`).toBeDefined();
    }
  });

  it("advertises only maintenance-lane operations the inventory declares", async () => {
    for (const name of advertisedOperations(await usageMessageOf("maintain"))) {
      const mapped = MAINTAIN_OPERATION_MAP[name];
      expect(mapped, `maintain ${name} has no mapped facade operation`).toBeDefined();
      expect(facadeOperation(mapped as string)?.capability).toBe("maintenance");
    }
  });

  it("names no operator confirmation at all", async () => {
    const usage = `${await usageMessageOf("managed")} ${await usageMessageOf("maintain")}`;
    for (const operation of FACADE_OPERATIONS.filter((entry) => entry.capability === "confirmation")) {
      expect(usage).not.toContain(operation.operation);
    }
    expect(usage).not.toContain("confirm-contract");
    expect(usage).not.toContain("confirm-takeover");
  });

  it("reaches every operation the inventory says the CLI serves", () => {
    const served = new Set([...Object.values(CLI_OPERATION_MAP), ...Object.values(MAINTAIN_OPERATION_MAP)]);
    for (const operation of FACADE_OPERATIONS) {
      if (!operation.surfaces.includes("cli")) continue;
      expect(served.has(operation.operation), `${operation.operation} is declared on the CLI but unreachable`).toBe(true);
    }
  });
});

describe("the MCP surface", () => {
  it("offers the managed tool alongside the evidence tools", () => {
    expect(listTools().map((tool) => tool.name)).toContain(managedCommand.name);
  });

  it("offers read-class operations and nothing else", () => {
    for (const name of MANAGED_READ_OPERATIONS) {
      const mapped = CLI_OPERATION_MAP[name];
      expect(mapped, `${name} has no mapped facade operation`).toBeDefined();
      expect(facadeOperation(mapped as string)?.capability).toBe("read");
    }
  });

  it("declares the offered operations in the tool's own input schema", () => {
    const tool = listTools().find((candidate) => candidate.name === managedCommand.name);
    const schema = tool?.inputSchema as { properties?: { operation?: { enum?: readonly string[] } } };
    expect(schema.properties?.operation?.enum).toEqual([...MANAGED_READ_OPERATIONS]);
  });

  it("offers no control, maintenance, approval, confirmation, or action operation", () => {
    const offered = new Set(MANAGED_READ_OPERATIONS.map((name) => CLI_OPERATION_MAP[name]));
    for (const operation of FACADE_OPERATIONS) {
      if (operation.capability === "read") continue;
      expect(offered.has(operation.operation), `${operation.operation} is ${operation.capability} and must not be an MCP operation`).toBe(
        false,
      );
    }
  });
});

describe("a tool call cannot reach a control operation", () => {
  const host = { cwd: REPO_ROOT, env: {} as never, loadConfig: async () => ({}) as never };

  it("refuses a managed control operation by name", async () => {
    for (const operation of ["submit-plan", "checkpoint", "run-sensor", "admit", "finish", "recover", "delete"]) {
      const outcome = await callTool("managed", { operation }, host);
      expect(outcome.outcome, `${operation} must not be callable`).toBe("usage");
      expect(outcome.blockers.blockers.map((blocker) => blocker.code)).toContain("operation_not_offered");
    }
  });

  it("refuses the maintenance lane as a tool entirely", async () => {
    const outcome = await callTool("maintain", {}, host);
    expect(outcome.outcome).toBe("usage");
    expect(outcome.blockers.blockers.map((blocker) => blocker.code)).toContain("unknown_tool");
  });

  it("names no operator confirmation as a tool or as an operation", async () => {
    for (const name of ["confirm", "confirm-contract", "confirm-takeover"]) {
      const asTool = await callTool(name, {}, host);
      expect(asTool.blockers.blockers.map((blocker) => blocker.code)).toContain("unknown_tool");
      const asOperation = await callTool("managed", { operation: name }, host);
      expect(asOperation.blockers.blockers.map((blocker) => blocker.code)).toContain("operation_not_offered");
    }
  });
});

describe("the product launches no subordinate agent runtime", () => {
  const sourceFiles = (dir: string, found: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) sourceFiles(full, found);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".fixture.ts")) found.push(full);
    }
    return found;
  };

  it("names no coding-agent runtime as a command to execute", () => {
    // The host owns how it delegates and sequences work; the product asks it
    // for the next checkpoint and never becomes a second one. A literal like
    // these appearing in an argv is how that inversion would arrive.
    //
    // Comments are stripped first, and deliberately: the seam that would host
    // such a launch documents in prose that it never does, and a scan that
    // could not tell an argv from a sentence about one would fail on the very
    // file that states the rule.
    const forbidden = [/["'`]claude["'`]\s*,/, /["'`]codex["'`]\s*,/, /--print/, /codex\s+exec/, /claude\s+-p\b/];
    const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(REPO_ROOT, "packages"))) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const pattern of forbidden) {
        if (pattern.test(source)) offenders.push(`${path.relative(REPO_ROOT, file)} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scanned a non-empty source set, so the scan cannot pass by finding nothing", () => {
    expect(sourceFiles(path.join(REPO_ROOT, "packages")).length).toBeGreaterThan(50);
  });
});
