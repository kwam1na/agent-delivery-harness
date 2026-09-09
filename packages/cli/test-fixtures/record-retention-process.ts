import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyDeliveryRecordRetention } from "../src/record-retention.ts";

const [rootDir, scope, id, keepSupersededText] = process.argv.slice(2);
if (rootDir === undefined || scope === undefined || id === undefined || keepSupersededText === undefined) {
  throw new Error("missing record-retention process fixture argument");
}

const relativePath = `delivery/records/record--${id.repeat(64)}.json`;
const bytes = `${JSON.stringify({ id, evidence: [`review-${id}`] })}\n`;
const result = await applyDeliveryRecordRetention({
  rootDir,
  storageNamespace: "delivery-harness/",
  scope,
  keepSuperseded: Number(keepSupersededText),
  recordBasePath: "delivery/records/record.json",
  current: { relativePath, deliverableDigest: id.repeat(64), bytes },
  writeCurrent: async () => {
    process.stdout.write("entered\n");
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
    process.stdin.pause();
    await mkdir(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
    await writeFile(path.join(rootDir, relativePath), bytes);
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) process.exitCode = 1;
