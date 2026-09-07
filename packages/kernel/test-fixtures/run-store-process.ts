import { open } from "node:fs/promises";
import path from "node:path";
import { createRunStore } from "../src/checkpoint/run-store.ts";
import type { RunEventInput } from "../src/checkpoint/run-event.ts";

const [commonDir, runId, serialized] = process.argv.slice(2);
if (!commonDir || !runId || !serialized) throw new Error("missing writer arguments");
const store = createRunStore(commonDir);
const journal = await open(path.join(store.runsDir, `${runId}.jsonl`), "r");
const identity = await journal.stat();
// Pause after the real journal read, inside RunStore's critical section. This
// controls scheduling only: every validation, dedup and append is product code.
const prototype = Object.getPrototypeOf(journal) as typeof journal;
const readFile = prototype.readFile;
let held = false;
const messages: string[] = [];
let wake: (() => void) | undefined;
process.on("message", (message: string) => { messages.push(message); wake?.(); });
async function receive(wanted: string) {
  while (!messages.includes(wanted)) await new Promise<void>((resolve) => { wake = resolve; });
  messages.splice(messages.indexOf(wanted), 1);
}
prototype.readFile = async function (...args: Parameters<typeof readFile>) {
  const contents = await readFile.apply(this, args);
  const stats = await this.stat();
  if (!held && stats.dev === identity.dev && stats.ino === identity.ino) {
    held = true;
    process.send?.("snapshot");
    await receive("release");
  }
  return contents;
} as typeof readFile;
await journal.close();
process.send?.("ready");
await receive("start");
try {
  const result = await store.append(runId, JSON.parse(serialized) as RunEventInput);
  process.send?.({ result });
} finally {
  prototype.readFile = readFile;
  process.disconnect();
}
