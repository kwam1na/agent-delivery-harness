import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRunStore } from "./run-store.ts";
import type { RunEventInput } from "./run-event.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function writer(root: string, runId: string, event: RunEventInput) {
  const child = fork(path.join(import.meta.dirname, "../../test-fixtures/run-store-process.ts"),
    [root, runId, JSON.stringify(event)], { execArgv: ["--import", "tsx"], silent: true });
  children.push(child);
  let error = "";
  child.stderr?.on("data", (chunk: Buffer) => { error += chunk.toString(); });
  const signal = (value: string) => new Promise<void>((resolve) => {
    child.on("message", (message) => { if (message === value) resolve(); });
  });
  const ready = signal("ready");
  const snapshot = signal("snapshot");
  let result: { ok: boolean; rejections?: { code: string }[] } | undefined;
  child.on("message", (message) => {
    if (typeof message === "object" && message !== null && "result" in message) result = message.result as typeof result;
  });
  const done = new Promise<typeof result>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 && result ? resolve(result) : reject(new Error(`writer exited ${code}: ${error}`)));
  });
  return { ready, snapshot, done, send: (message: string) => child.send(message) };
}

it.each(["unique", "exact retry", "conflicting id"] as const)("serializes actual RunStore %s writes from independent processes", async (mode) => {
  const root = await mkdtemp(path.join(tmpdir(), "run-store-process-"));
  roots.push(root);
  const store = createRunStore(root);
  const allocation = await store.allocate();
  if (!allocation.ok) throw new Error("allocation failed");
  const { runId } = allocation;
  const firstEvent: RunEventInput = {
    version: "run-event/2", runId, eventId: "event-1", at: "2026-09-07T12:00:00Z",
    repo: { commonDir: root }, actor: { role: "executor" }, attestation: "self",
    kind: "blocker.recorded", payload: { code: "pending", summary: "first" },
  };
  const secondEvent = mode === "exact retry" ? firstEvent : {
    ...firstEvent, eventId: mode === "unique" ? "event-2" : "event-1", payload: { code: "pending", summary: "second" },
  };
  const first = writer(root, runId, firstEvent);
  const second = writer(root, runId, secondEvent);
  await Promise.all([first.ready, second.ready]);
  first.send("start");
  await first.snapshot;
  second.send("start");
  // With serialization the second reader cannot enter yet. Without it, both
  // processes hold the same journal snapshot; release both and expose the race.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([second.snapshot, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
  clearTimeout(timer);
  first.send("release");
  second.send("release");
  const results = await Promise.all([first.done, second.done]);
  expect(results.map((result) => result?.ok)).toEqual(mode === "conflicting id" ? [true, false] : [true, true]);
  const read = await store.read(runId);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error(JSON.stringify(read.rejections));
  expect(read.events.map((event) => event.seq)).toEqual(mode === "unique" ? [1, 2] : [1]);
  expect(read.events.map((event) => event.eventId)).toEqual(mode === "unique" ? ["event-1", "event-2"] : ["event-1"]);
  expect(read.events[0]?.payload["summary"]).toBe("first");
}, 20000);
