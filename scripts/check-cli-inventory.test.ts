/**
 * The CLI-inventory sensor, falsified rule by rule.
 *
 * Each falsification builds a throwaway CLI tree in a temp dir, points the sensor
 * at it, and asserts the finding it must raise — then a control tree asserts the
 * same sensor stays clean. The real repository's own registry is checked last, so
 * a regression in the shipped CLI turns this suite red too.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  repoRootFromHere,
  runCliInventorySensor,
  type CliInventoryFinding,
} from "./check-cli-inventory.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scaffold(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), "cli-inventory-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
  return root;
}

const FIXTURE = { cliSrc: "src", commandsDir: "src/commands", registryFile: "src/index.ts", registryConst: "COMMANDS" };

function run(root: string): readonly CliInventoryFinding[] {
  return runCliInventorySensor({ root, ...FIXTURE }).findings;
}

const PREPARE = `export const prepareCommand = { name: "prepare" };\n`;
const GATE = `export const gateCommand = { name: "gate" };\n`;

describe("runCliInventorySensor", () => {
  it("is clean when every command is registered", () => {
    const root = scaffold({
      "src/commands/prepare.ts": PREPARE,
      "src/commands/gate.ts": GATE,
      "src/index.ts": `import { prepareCommand } from "./commands/prepare.ts";\nimport { gateCommand } from "./commands/gate.ts";\nexport const COMMANDS = [prepareCommand, gateCommand];\n`,
    });
    expect(run(root)).toEqual([]);
  });

  it("flags a command module that is not registered", () => {
    const root = scaffold({
      "src/commands/prepare.ts": PREPARE,
      "src/commands/orphan.ts": `export const orphanCommand = { name: "orphan" };\n`,
      "src/index.ts": `import { prepareCommand } from "./commands/prepare.ts";\nexport const COMMANDS = [prepareCommand];\n`,
    });
    const findings = run(root);
    expect(findings.some((f) => f.rule === "unregistered-command" && f.file.endsWith("orphan.ts"))).toBe(true);
  });

  it("flags an empty registry (anti-vacuity)", () => {
    const root = scaffold({
      "src/commands/prepare.ts": PREPARE,
      "src/index.ts": `import { prepareCommand } from "./commands/prepare.ts";\nexport const COMMANDS = [];\n`,
    });
    const findings = run(root);
    expect(findings.some((f) => f.rule === "empty-registry")).toBe(true);
  });

  it("flags a dangling registration whose import does not resolve", () => {
    const root = scaffold({
      "src/commands/prepare.ts": PREPARE,
      "src/index.ts": `import { prepareCommand } from "./commands/prepare.ts";\nimport { ghostCommand } from "./commands/ghost.ts";\nexport const COMMANDS = [prepareCommand, ghostCommand];\n`,
    });
    const findings = run(root);
    expect(findings.some((f) => f.rule === "dangling-registration")).toBe(true);
  });

  it("flags a missing commands directory (anti-vacuity)", () => {
    const root = scaffold({
      "src/index.ts": `export const COMMANDS = [];\n`,
    });
    const findings = run(root);
    expect(findings.some((f) => f.rule === "anti-vacuity")).toBe(true);
  });

  it("flags a registry that is not a readable array literal", () => {
    const root = scaffold({
      "src/commands/prepare.ts": PREPARE,
      "src/index.ts": `import { prepareCommand } from "./commands/prepare.ts";\nexport const COMMANDS = buildRegistry(prepareCommand);\n`,
    });
    const findings = run(root);
    expect(findings.some((f) => f.rule === "registry-unreadable")).toBe(true);
  });

  it("passes on the repository's own CLI registry (all seven commands)", () => {
    const result = runCliInventorySensor({ root: repoRootFromHere() });
    expect(result.findings).toEqual([]);
    expect(result.commandFiles).toHaveLength(7);
    expect(result.registeredFiles).toHaveLength(7);
  });
});
