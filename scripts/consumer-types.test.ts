import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("typechecks a strict Bundler consumer of the checkout without source-import flags", () => {
  const root = process.cwd();
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-consumer-types-"));
  try {
    mkdirSync(path.join(dir, "node_modules/@agent-delivery-harness"), { recursive: true });
    symlinkSync(path.join(root, "packages/kernel"), path.join(dir, "node_modules/@agent-delivery-harness/kernel"));
    writeFileSync(path.join(dir, "consumer.ts"), 'import { parseDeliveryRecord } from "@agent-delivery-harness/kernel";\nparseDeliveryRecord("{}");\n// @ts-expect-error preserve the public input type\nparseDeliveryRecord(42);\n');
    expect(() => execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2023", "--module", "ESNext", "--moduleResolution", "Bundler", "--types", "node", "--typeRoots", path.join(root, "node_modules/@types"), "consumer.ts"], { cwd: dir, stdio: "pipe" })).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
