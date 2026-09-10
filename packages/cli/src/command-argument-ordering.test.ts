import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "./boundary.ts";
import { gateCommand } from "./commands/gate.ts";
import { recordCommand } from "./commands/record.ts";
import { submitEvidenceCommand } from "./commands/submit-evidence.ts";

/** Invalid argv must be answered before any repository or admission capability. */
function argumentOnlyContext(args: readonly string[]) {
  const accessed = vi.fn((key: PropertyKey): never => {
    throw new Error(`Invalid arguments reached ${String(key)}`);
  });
  const context = new Proxy({ args }, {
    get(target, key) {
      if (key === "args") return target.args;
      return accessed(key);
    },
  }) as CommandContext;
  return { context, accessed };
}

describe("argument refusal precedes side effects", () => {
  it.each([gateCommand, recordCommand, submitEvidenceCommand])("$name refuses an unknown flag before wiring", async (command) => {
    const args = command === submitEvidenceCommand ? ["--manifest", "real.json", "--bogus-flag"] : ["--bogus-flag"];
    const { context, accessed } = argumentOnlyContext(args);
    const result = await command.run(context);
    expect(result.kind).toBe("usage");
    expect(accessed).not.toHaveBeenCalled();
  });

  it.each([
    ["alpha.json", "beta.json"],
    ["alpha.json", "--manifest", "beta.json"],
    ["--manifest", "alpha.json", "beta.json"],
    ["--manifest", "alpha.json", "--manifest", "beta.json"],
  ])("refuses ambiguous manifest arguments %j", async (...args) => {
    const { context, accessed } = argumentOnlyContext(args);
    const result = await submitEvidenceCommand.run(context);
    expect(result.kind).toBe("usage");
    if (result.kind !== "usage") throw new Error("Expected usage refusal");
    expect(result.message).toContain("alpha.json");
    expect(result.message).toContain("beta.json");
    expect(accessed).not.toHaveBeenCalled();
  });
});
