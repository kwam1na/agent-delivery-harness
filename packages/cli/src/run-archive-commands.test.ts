import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { sha256Hex } from "@agent-delivery-harness/kernel";
import { emitCommand } from "./commands/emit.ts";
import { runsCommand } from "./commands/runs.ts";
import { resolveRunSurface } from "./run-surface.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});
it("exports actual captured output and reads it after deleting the entire original repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "archive-source-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  const destination = await mkdtemp(path.join(tmpdir(), "archive-copy-"));
  roots.push(destination);
  const output: string[] = [];
  const context = {
    rootDir: root,
    env: {},
    readStdin: async () => "",
    write: (s: string) => output.push(s),
  };
  expect(
    (
      await emitCommand.run({
        ...context,
        args: [
          "run.started",
          "--version",
          "2",
          "--event-id",
          "start",
          "--json",
          JSON.stringify({
            host: "codex",
            workflow: { releaseId: "fixture", profile: "core" },
          }),
        ],
      })
    ).kind,
  ).toBe("ok");
  const surface = await resolveRunSurface(root);
  if (!surface.ok) throw Error("surface");
  const current = await surface.surface.store.current(
    surface.surface.worktreeKey,
  );
  if (!current.ok || !current.runId) throw Error("current");
  const runId = current.runId;
  const text = "<script>globalThis.untrusted = true</script>";
  await writeFile(path.join(root, "partial.txt"), text);
  const request = {
    sourceRoot: root,
    sourcePath: "partial.txt",
    eventId: "partial",
    report: { reportId: "partial", role: "partial-output" },
    artifact: {
      artifactId: "partial",
      activityId: "review",
      attemptId: "attempt",
      candidateTreeSha: "a".repeat(40),
      digest: sha256Hex(text),
      sizeBytes: Buffer.byteLength(text),
      mediaType: "text/html",
      producer: "codex",
    },
  };
  expect(
    (
      await runsCommand.run({
        ...context,
        args: ["capture", runId, "--json", JSON.stringify(request)],
      })
    ).kind,
  ).toBe("ok");
  const before = await surface.surface.store.read(runId);
  expect(
    (
      await runsCommand.run({
        ...context,
        args: [
          "export",
          runId,
          "--output",
          path.join(surface.surface.runsDir, `${runId}.jsonl`),
        ],
      })
    ).kind,
  ).toBe("blocked");
  expect(await surface.surface.store.read(runId)).toEqual(before);
  const gitHead = path.join(surface.surface.commonDir, "HEAD");
  const originalHead = await readFile(gitHead, "utf8");
  expect((await runsCommand.run({
    ...context,
    args: ["export", runId, "--output", gitHead],
  })).kind).toBe("blocked");
  expect(await readFile(gitHead, "utf8")).toBe(originalHead);
  const file = path.join(destination, "archive.json");
  expect(
    (
      await runsCommand.run({
        ...context,
        args: ["export", runId, "--output", file],
      })
    ).kind,
  ).toBe("ok");
  expect(await surface.surface.store.read(runId)).toEqual(before);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await rm(root, { recursive: true });
  expect(
    (
      await runsCommand.run({
        ...context,
        rootDir: destination,
        args: ["archive", file, "--artifact", "partial"],
      })
    ).kind,
  ).toBe("ok");
  const result = JSON.parse(output.at(-1)!);
  expect(result.historical).toBe(true);
  expect(Buffer.from(result.base64, "base64").toString()).toBe(text);
  expect(
    (
      await runsCommand.run({
        ...context,
        rootDir: destination,
        args: ["archive", file],
      })
    ).kind,
  ).toBe("ok");
  expect(JSON.parse(output.at(-1)!).authority).toBe("observation");
  const bytes = await readFile(file, "utf8");
  const damaged = JSON.parse(bytes);
  damaged.attachments.blobs[request.artifact.digest] = "eA==";
  await writeFile(file, JSON.stringify(damaged));
  expect(
    (
      await runsCommand.run({
        ...context,
        rootDir: destination,
        args: ["archive", file],
      })
    ).kind,
  ).toBe("blocked");
  await expect(stat(path.join(destination, ".git"))).rejects.toThrow();
});

it.skipIf(process.platform === "win32")("refuses a named pipe without waiting for a writer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "archive-fifo-"));
  roots.push(root);
  const fifo = path.join(root, "archive.json");
  execFileSync("mkfifo", [fifo]);
  const result = spawnSync(process.execPath, [
    "--import", "tsx", path.join(import.meta.dirname, "main.ts"),
    "runs", "archive", fifo,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("run_archive_unavailable");
}, 10000);
