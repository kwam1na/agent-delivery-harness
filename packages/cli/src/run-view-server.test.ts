import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { sha256Hex } from "@agent-delivery-harness/kernel";
import { emitCommand } from "./commands/emit.ts";
import { runsCommand } from "./commands/runs.ts";
import { resolveRunSurface } from "./run-surface.ts";
import { startRunServer, type RunServerHandle } from "./run-server.ts";
import type { RunView } from "./run-view.ts";
import { buildRunArchive } from "./run-archive.ts";
import { readRunArtifact } from "@agent-delivery-harness/kernel";
const roots: string[] = [];
const servers: RunServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});
it("shares operational values across CLI JSON and HTML and serves inert stable report links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-view-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  const output: string[] = [];
  const context = {
    rootDir: root,
    env: {},
    write: (s: string) => output.push(s),
    readStdin: async () => "",
  };
  const emit = async (kind: string, payload: unknown, eventId: string) => {
    const result = await emitCommand.run({
      ...context,
      args: [
        kind,
        "--version",
        "2",
        "--event-id",
        eventId,
        "--json",
        JSON.stringify(payload),
      ],
    });
    expect(result.kind).toBe("ok");
  };
  await emit(
    "run.started",
    { host: "codex", workflow: { releaseId: "fixture", profile: "core" } },
    "start",
  );
  const resolved = await resolveRunSurface(root);
  if (!resolved.ok) throw Error("surface");
  const { store, worktreeKey } = resolved.surface;
  const current = await store.current(worktreeKey);
  if (!current.ok || !current.runId) throw Error("run");
  const runId = current.runId;
  const binding = {
    activityId: "review",
    attemptId: "attempt",
    candidateTreeSha: "a".repeat(40),
  };
  await emit(
    "activity.observed",
    {
      ...binding,
      owner: "Reviewer Alice",
      phase: "review",
      state: "running",
      nextStep: "Read dissent report",
    },
    "activity",
  );
  await emit(
    "wait.started",
    {
      ...binding,
      waitId: "service",
      owner: "Actions",
      waitingOn: "external",
      reason: "Billing unavailable",
      nextAction: "Use local checks",
      scope: "this delivery",
    },
    "wait",
  );
  const text = "<script>window.compromised=true</script>";
  await writeFile(path.join(root, "report.txt"), text);
  const metadata = {
    ...binding,
    artifactId: "dissent",
    digest: sha256Hex(text),
    sizeBytes: Buffer.byteLength(text),
    mediaType: "text/html",
    producer: "codex",
  };
  expect(
    (
      await runsCommand.run({
        ...context,
        args: [
          "capture",
          runId,
          "--json",
          JSON.stringify({
            artifact: metadata,
            report: { reportId: "dissent", role: "review" },
            sourceRoot: root,
            sourcePath: "report.txt",
            eventId: "report",
          }),
        ],
      })
    ).kind,
  ).toBe("ok");
  const started = await startRunServer({
    repos: [root],
    recordPath: "record.json",
  });
  if (!started.ok) throw Error(started.reason);
  servers.push(started.server);
  const base = started.server.url;
  const json = (await (await fetch(`${base}/api/runs`)).json()) as {
    runs: { view: RunView; href: string }[];
  };
  const run = json.runs[0]!;
  expect(run.view.spec).toBe("run-view/1");
  expect(
    (
      await runsCommand.run({
        ...context,
        args: ["view", runId, "--json", "--record", "record.json"],
      })
    ).kind,
  ).toBe("ok");
  const cli = JSON.parse(output.at(-1)!);
  const withoutTime = (v: RunView) => ({
    ...v,
    asOf: "",
    sections: v.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => ({
        ...i,
        fields: i.fields.filter((f) => f.label !== "Elapsed since start"),
      })),
    })),
  });
  expect(withoutTime(cli)).toEqual(withoutTime(run.view));
  const page = await (await fetch(base + run.href)).text();
  expect(page).toContain("Retained delivery record");
  expect(page).toContain("Unavailable — missing");
  expect(page).toContain("Reviewer Alice");
  expect(page).toContain("Use local checks");
  expect(page).toContain("No — external");
  expect(page).toContain('id="waiting"');
  expect(page).toContain("focus-visible");
  expect(page).toContain("@media(max-width:600px)");
  expect(page.indexOf("Waiting and required action")).toBeLessThan(
    page.indexOf("Finding history"),
  );
  const artifactUrl = base + run.href + "/artifacts/dissent";
  const response = await fetch(artifactUrl);
  const detail = await response.text();
  expect(detail).toContain("&lt;script&gt;");
  expect(detail).not.toContain("<script>");
  expect(detail).not.toContain('http-equiv="refresh"');
  expect(detail).toContain(binding.candidateTreeSha);
  expect(response.headers.get("content-security-policy")).toContain(
    "script-src 'none'",
  );
  const download = await fetch(artifactUrl + "/download");
  expect(await download.text()).toBe(text);
  expect(download.headers.get("content-type")).toBe("application/octet-stream");
  const before = await store.read(runId);
  await rm(
    path.join(store.runsDir, "artifacts", runId, `${metadata.digest}.blob`),
  );
  const missing = await (await fetch(artifactUrl)).text();
  expect(missing).toContain("Return to run");
  expect(missing).toContain(binding.candidateTreeSha);
  expect(await store.read(runId)).toEqual(before);
  expect((await fetch(base + run.href + "/artifacts/%2e%2e")).status).toBe(404);
  const journal = await store.read(runId);
  if (!journal.ok) throw Error("read");
  const archive = await buildRunArchive({
    runId,
    events: journal.events,
    readArtifact: (id) => readRunArtifact(store, runId, id),
  });
  if (!archive.ok) throw Error(archive.reason);
  const archiveFile = path.join(root, "saved-run.json");
  await writeFile(archiveFile, archive.text);
  expect(
    (
      await runsCommand.run({
        ...context,
        signal: AbortSignal.abort(),
        args: ["serve", "--archive", archiveFile],
      })
    ).kind,
  ).toBe("ok");
  const archived = await startRunServer({
    repos: [],
    archives: [{ label: "Saved review", text: archive.text }],
  });
  if (!archived.ok) throw Error(archived.reason);
  servers.push(archived.server);
  const historical = (await (
    await fetch(archived.server.url + "/api/runs")
  ).json()) as { runs: { view: RunView; href: string }[] };
  expect(historical.runs[0]!.view.historical).toBe(true);
  const archivePage = await (
    await fetch(archived.server.url + historical.runs[0]!.href)
  ).text();
  expect(archivePage).toContain("Historical archive");
  expect(archivePage).not.toContain('http-equiv="refresh"');
});

it("keeps completed nonreview activity and partial attempt cost in CLI, JSON and HTML without journal writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-terminal-history-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  const output: string[] = [];
  const context = { rootDir: root, env: {}, write: (s: string) => output.push(s), readStdin: async () => "" };
  const emit = async (kind: string, payload: unknown, eventId: string) => {
    expect((await emitCommand.run({ ...context, args: [kind, "--version", "2", "--event-id", eventId, "--json", JSON.stringify(payload)] })).kind).toBe("ok");
  };
  await emit("run.started", { host: "codex", workflow: { releaseId: "fixture", profile: "core" } }, "start");
  const resolved = await resolveRunSurface(root);
  if (!resolved.ok) throw Error("surface");
  const { store, worktreeKey } = resolved.surface;
  const current = await store.current(worktreeKey);
  if (!current.ok || !current.runId) throw Error("run");
  const runId = current.runId;
  const first = { activityId: "native-claude", attemptId: "native-claude-1", candidateTreeSha: "a".repeat(40), owner: "claude-code", phase: "qualification" };
  const second = { ...first, attemptId: "native-claude-2", supersedesAttemptId: first.attemptId };
  await emit("activity.observed", { ...first, state: "running" }, "first-start");
  await emit("activity.observed", { ...first, state: "interrupted", cost: { coverage: "partial", total: 0.5786060000000001, unit: "USD", reportedBy: "claude-code" } }, "first-stop");
  await emit("activity.observed", { ...second, state: "running" }, "second-start");
  await emit("activity.observed", { ...second, state: "completed" }, "second-stop");
  const before = await store.read(runId);
  const started = await startRunServer({ repos: [root] });
  if (!started.ok) throw Error(started.reason);
  servers.push(started.server);
  const { runs } = await (await fetch(started.server.url + "/api/runs")).json() as { runs: { view: RunView; href: string }[] };
  const run = runs[0]!;
  expect((await runsCommand.run({ ...context, args: ["view", runId, "--json"] })).kind).toBe("ok");
  const cli = JSON.parse(output.at(-1)!) as RunView;
  expect(cli.sections).toEqual(run.view.sections);
  expect(cli.sections.find(s => s.id === "work")!.items).toEqual([]);
  expect(cli.sections.find(s => s.id === "reviews")!.items).toEqual([]);
  expect(cli.sections.find(s => s.id === "activity-history")!.items).toHaveLength(2);
  const cost = cli.sections.find(s => s.id === "cost")!.items;
  expect(cost).toHaveLength(3);
  expect(cost[1]!.fields).toContainEqual({ label: "Measurement", value: "unreported" });
  const terminalStart = output.length;
  expect((await runsCommand.run({ ...context, args: ["view", runId] })).kind).toBe("ok");
  const terminal = output.slice(terminalStart).join("\n");
  const page = await (await fetch(started.server.url + run.href)).text();
  for (const text of [terminal, page]) {
    for (const fact of ["Activity history", "native-claude-1", "native-claude-2", "qualification", "interrupted (reported)", "completed (reported)", "Superseded attempt", "0.5786060000000001 USD (partial coverage)", "No active work in the latest observations", first.candidateTreeSha]) expect(text).toContain(fact);
    expect(text).not.toContain("No activity observations");
  }
  expect(page.indexOf('id="work"')).toBeLessThan(page.indexOf('id="activity-history"'));
  expect(await store.read(runId)).toEqual(before);
});
