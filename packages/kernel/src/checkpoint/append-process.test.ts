import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { appendDecided, ownerOnlyRegularFile } from "./append-only-file.ts";
import { constants } from "node:fs";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function journal() {
  const root = await mkdtemp(path.join(os.tmpdir(), "append-process-"));
  roots.push(root);
  return path.join(root, "journal.jsonl");
}
function writer(file: string, mode = "append", lock = true, timeout = 5000) {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "../../test-fixtures/append-process.ts"), file, mode, String(lock), String(timeout)]);
  children.push(child);
  let output = "";
  let error = "";
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("entered\n")) entered(); });
  child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
  const done = new Promise<{ code: number | null; output: string; error: string }>((resolve) => child.once("close", (code) => resolve({ code, output, error })));
  return { child, ready, done, release: () => child.stdin.write("release\n") };
}
async function sequences(file: string) {
  return (await readFile(file, "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { sequence: number }).sequence);
}

it("characterizes the legacy process-local queue: separate writers allocate the same sequence", async () => {
  const file = await journal();
  const first = writer(file, "hold", false);
  await first.ready;
  const second = writer(file, "append", false);
  expect((await second.done).code).toBe(0);
  first.release();
  expect((await first.done).code).toBe(0);
  expect(await sequences(file)).toEqual([1, 1]);
});

it("serializes read and sequence allocation across real independent node processes", async () => {
  const file = await journal();
  const first = writer(file, "hold");
  await first.ready;
  const rest = Array.from({ length: 5 }, () => writer(file));
  setTimeout(() => first.release(), 350);
  const results = await Promise.all([first.done, ...rest.map((child) => child.done)]);
  expect(results.map((result) => result.error)).toEqual(Array(6).fill(""));
  expect(results.map((result) => result.code)).toEqual(Array(6).fill(0));
  expect(await sequences(file)).toEqual([1, 2, 3, 4, 5, 6]);
});

it("recovers a killed owner without waiting for an age lease", async () => {
  const file = await journal();
  const first = writer(file, "hold");
  await first.ready;
  first.child.kill("SIGKILL");
  await first.done;
  const next = Array.from({ length: 5 }, () => writer(file));
  expect((await Promise.all(next.map((child) => child.done))).map((result) => result.code)).toEqual(Array(5).fill(0));
  expect(await sequences(file)).toEqual([1, 2, 3, 4, 5]);
  expect(await readdir(`${file}.append-lock`)).toEqual([]);
});

it("bounds contention and never expires a living owner", async () => {
  const file = await journal();
  const first = writer(file, "hold");
  await first.ready;
  const blocked = await writer(file, "append", true, 100).done;
  expect(blocked.code).toBe(1);
  expect(blocked.error).toContain("cross-process append lock timed out");
  expect(blocked.output).not.toContain("entered");
  first.release();
  expect((await first.done).code).toBe(0);
  expect(await sequences(file)).toEqual([1]);
});

it("refuses a symlink or accessible lock directory", async () => {
  const file = await journal();
  const outside = `${file}.outside`;
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, `${file}.append-lock`);
  const linked = await writer(file).done;
  expect(linked.code).toBe(1);
  expect(linked.error).toContain("append lock directory is not owner-only");
  expect(await readdir(outside)).toEqual([]);
  await rm(`${file}.append-lock`);
  await mkdir(`${file}.append-lock`, { mode: 0o700 });
  await chmod(`${file}.append-lock`, 0o755);
  expect((await writer(file).done).error).toContain("append lock directory is not owner-only");
});

it("refuses planted symlink, broad-mode, and oversized contender files", async () => {
  const file = await journal();
  const directory = `${file}.append-lock`;
  await mkdir(directory, { mode: 0o700 });
  const contender = path.join(directory, `${process.pid}-00000000-0000-0000-0000-000000000000.ticket`);
  const outside = `${file}.outside`;
  await writeFile(outside, "1\n", { mode: 0o600 });
  await symlink(outside, contender);
  expect((await writer(file).done).code).toBe(1);
  expect(await readFile(outside, "utf8")).toBe("1\n");
  await rm(contender);
  await writeFile(contender, "1\n", { mode: 0o644 });
  expect((await writer(file).done).error).toContain("append lock not owner-only");
  await chmod(contender, 0o600);
  await writeFile(contender, "1".repeat(64));
  expect((await writer(file).done).error).toContain("invalid append lock ticket");
});

it("treats a live choosing owner as contention and cleans only its own contender", async () => {
  const file = await journal();
  const directory = `${file}.append-lock`;
  await mkdir(directory, { mode: 0o700 });
  const name = `${process.pid}-00000000-0000-0000-0000-000000000000.ticket`;
  await writeFile(path.join(directory, name), "", { mode: 0o600 });
  expect((await writer(file, "append", true, 100).done).error).toContain("cross-process append lock timed out");
  expect(await readdir(directory)).toEqual([name]);
});

it("does not repair or append on an accepted dedup no-op", async () => {
  const file = await journal();
  await writeFile(file, '{"sequence":1}\ninterrupted', { mode: 0o600 });
  const original = await readFile(file, "utf8");
  expect(await appendDecided({ journalPath: file, crossProcess: true, decide: async () => ({ ok: true, accepted: "existing" }) })).toEqual({ ok: true, accepted: "existing" });
  expect(await readFile(file, "utf8")).toBe(original);
});

it("repairs a torn tail through the verified owner-only descriptor", async () => {
  const file = await journal();
  await writeFile(file, '{"sequence":1}\ninterrupted', { mode: 0o600 });
  await appendDecided({
    journalPath: file, crossProcess: true,
    discipline: { extraFlags: constants.O_NOFOLLOW, verify: ownerOnlyRegularFile, refuseOnError: true },
    decide: async (read) => { await read(); return { ok: true, entry: { sequence: 2 }, accepted: 2 }; },
  });
  expect(await sequences(file)).toEqual([1, 2]);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
