import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
it("discovers writer and capture capabilities outside a repository without creating state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-capabilities-"));
  roots.push(root);
  const output: string[] = [];
  const context = { rootDir: root, env: {}, readStdin: async () => "", write: (s: string) => output.push(s) };
  expect((await runsCommand.run({ ...context, args: ["capabilities", "--json"] })).kind).toBe("ok");
  expect(JSON.parse(output.join(""))).toEqual({ spec: "run-capabilities/1", writerVersions: ["run-event/1", "run-event/2"], artifactCapture: true });
  expect(await readdir(root)).toEqual([]);
  expect((await runsCommand.run({ ...context, args: ["capabilities", "--json", "unexpected"] })).kind).toBe("usage");
});
it("captures dissent then clarification and partial output with stable references and exact JSON reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-cli-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
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
            workflow: { releaseId: "test", profile: "core" },
          }),
        ],
      })
    ).kind,
  ).toBe("ok");
  const resolved = await resolveRunSurface(root);
  if (!resolved.ok) throw Error("resolve");
  const { store, worktreeKey } = resolved.surface;
  const current = await store.current(worktreeKey);
  if (!current.ok || !current.runId) throw Error("run");
  const runId = current.runId;
  const scratch = await mkdtemp(path.join(tmpdir(), "artifact-cli-source-"));
  roots.push(scratch);
  const text = '{"verdict":"changes-requested"}';
  await writeFile(path.join(scratch, "report.json"), text);
  const artifact = {
    artifactId: "dissent",
    activityId: "review",
    attemptId: "attempt",
    candidateTreeSha: "a".repeat(40),
    digest: sha256Hex(text),
    sizeBytes: Buffer.byteLength(text),
    mediaType: "application/json",
    producer: "codex",
  };
  for (const role of ["review", "clarification", "partial-output"]) {
    const request = {
      artifact: { ...artifact, artifactId: role },
      eventId: role,
      report: {
        reportId: role,
        role,
        ...(role === "clarification" ? { originatingReportId: "review" } : {}),
      },
      sourceRoot: scratch,
      sourcePath: "report.json",
    };
    const args = ["capture", runId, "--json", JSON.stringify(request)];
    const first = await runsCommand.run({ ...context, args });
    expect(first, JSON.stringify(first)).toMatchObject({ kind: "ok" });
    const retry = await runsCommand.run({ ...context, args });
    expect(retry, JSON.stringify(retry)).toMatchObject({ kind: "ok" });
  }
  await rm(scratch, { recursive: true });
  expect(
    (
      await runsCommand.run({
        ...context,
        args: ["artifact", runId, "clarification", "--json"],
      })
    ).kind,
  ).toBe("ok");
  const value = JSON.parse(output.at(-1)!);
  expect(Buffer.from(value.base64, "base64").toString()).toBe(text);
  const read = await store.read(runId);
  expect(
    read.ok && read.events.filter((e) => e.kind === "artifact.referenced"),
  ).toHaveLength(3);
  expect(
    read.ok && read.events.filter((e) => e.kind === "report.referenced"),
  ).toHaveLength(3);
  const invalid = {
    artifact,
    eventId: "missing",
    report: { reportId: "missing", role: "partial-output" },
    sourceRoot: scratch,
    sourcePath: "missing",
  };
  expect(
    (
      await runsCommand.run({
        ...context,
        args: ["capture", runId, "--json", JSON.stringify(invalid)],
      })
    ).kind,
  ).toBe("blocked");
  const final = await store.read(runId);
  expect(final.ok && final.events.at(-1)?.payload["availability"]).toBe(
    "unavailable",
  );
});
it("reads a captured attachment from the root after removing its source worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-worktree-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  const worktree = path.join(root, "linked");
  execFileSync("git", [
    "-C",
    root,
    "worktree",
    "add",
    "--detach",
    "-q",
    worktree,
  ]);
  const output: string[] = [];
  const context = {
    rootDir: worktree,
    env: {},
    readStdin: async () => "",
    write: (s: string) => output.push(s),
  };
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
        workflow: { releaseId: "test", profile: "core" },
      }),
    ],
  });
  const resolved = await resolveRunSurface(worktree);
  if (!resolved.ok) throw Error("resolve");
  const current = await resolved.surface.store.current(
    resolved.surface.worktreeKey,
  );
  if (!current.ok || !current.runId) throw Error("run");
  const runId = current.runId;
  const text = "interrupted reviewer partial output";
  await writeFile(path.join(worktree, "partial.txt"), text);
  const request = {
    sourceRoot: worktree,
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
      mediaType: "text/plain",
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
  execFileSync("git", ["-C", root, "worktree", "remove", "--force", worktree]);
  expect(
    (
      await runsCommand.run({
        ...context,
        rootDir: root,
        args: ["artifact", runId, "partial", "--json"],
      })
    ).kind,
  ).toBe("ok");
  expect(
    Buffer.from(JSON.parse(output.at(-1)!).base64, "base64").toString(),
  ).toBe(text);
});
