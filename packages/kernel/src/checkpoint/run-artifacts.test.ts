import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "./run-store.ts";
import { captureRunArtifact, readRunArtifact } from "./run-artifacts.ts";
import { sha256Hex } from "../digest.ts";
import type { RunEventInput } from "./run-event.ts";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture(version: "run-event/1" | "run-event/2" = "run-event/2") {
  const root = await mkdtemp(path.join(tmpdir(), "run-artifact-"));
  dirs.push(root);
  const scratch = await mkdtemp(path.join(tmpdir(), "run-artifact-source-"));
  dirs.push(scratch);
  const store = createRunStore(root);
  const a = await store.allocate();
  if (!a.ok) throw Error("allocate");
  const event: RunEventInput = {
    version,
    ...(version === "run-event/2" ? { eventId: "start" } : {}),
    runId: a.runId,
    at: "2026-09-07T12:00:00Z",
    repo: { commonDir: root },
    actor: { role: "executor" },
    attestation: "self",
    kind: "blocker.recorded",
    payload: { code: "example", summary: "example" },
  };
  if (!(await store.append(a.runId, event)).ok) throw Error("append");
  const text = '{"verdict":"changes-requested"}';
  await writeFile(path.join(scratch, "report.json"), text);
  const metadata = {
    artifactId: "report-1",
    activityId: "review",
    attemptId: "attempt-1",
    candidateTreeSha: "a".repeat(40),
    digest: sha256Hex(text),
    sizeBytes: Buffer.byteLength(text),
    mediaType: "application/json",
    producer: "codex",
    roundId: "round-1",
    round: 1,
    lensId: "lens.correctness",
  };
  return { store, scratch, metadata, runId: a.runId, text };
}
it("retains exact dissent bytes after scratch removal and deduplicates retries", async () => {
  const f = await fixture();
  const input = { ...f, sourceRoot: f.scratch, sourcePath: "report.json" };
  expect((await captureRunArtifact(input)).ok).toBe(true);
  expect((await captureRunArtifact(input)).ok).toBe(true);
  await rm(f.scratch, { recursive: true });
  const got = await readRunArtifact(f.store, f.runId, "report-1");
  expect(got.ok && Buffer.from(got.base64, "base64").toString()).toBe(f.text);
  const lines = await readFile(
    path.join(f.store.runsDir, "artifacts", f.runId, "index.jsonl"),
    "utf8",
  );
  expect(lines.trim().split("\n")).toHaveLength(1);
});
it("refuses legacy writers, traversal, digest mismatch and cross-run reads", async () => {
  const old = await fixture("run-event/1");
  expect(
    (
      await captureRunArtifact({
        ...old,
        sourceRoot: old.scratch,
        sourcePath: "report.json",
      })
    ).ok,
  ).toBe(false);
  const f = await fixture();
  expect(
    (
      await captureRunArtifact({
        ...f,
        sourceRoot: f.scratch,
        sourcePath: "../escape",
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await captureRunArtifact({
        ...f,
        metadata: { ...f.metadata, digest: "b".repeat(64) },
        sourceRoot: f.scratch,
        sourcePath: "report.json",
      })
    ).ok,
  ).toBe(false);
  expect((await readRunArtifact(f.store, "../run", "report-1")).ok).toBe(false);
});
it("refuses secret bytes without retaining or echoing them", async () => {
  const f = await fixture();
  const text = "ghp_" + "x".repeat(30);
  await writeFile(path.join(f.scratch, "report.json"), text);
  const result = await captureRunArtifact({
    ...f,
    metadata: {
      ...f.metadata,
      digest: sha256Hex(text),
      sizeBytes: Buffer.byteLength(text),
    },
    sourceRoot: f.scratch,
    sourcePath: "report.json",
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(text);
});
it("refuses conflicting identity, corrupted bytes, oversize, and unsafe stored paths", async () => {
  const f = await fixture();
  const input = { ...f, sourceRoot: f.scratch, sourcePath: "report.json" };
  expect((await captureRunArtifact(input)).ok).toBe(true);
  expect(
    (
      await captureRunArtifact({
        ...input,
        metadata: { ...f.metadata, attemptId: "other" },
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await captureRunArtifact({
        ...input,
        metadata: { ...f.metadata, sizeBytes: 2 * 1024 * 1024 + 1 },
      })
    ).ok,
  ).toBe(false);
  await writeFile(
    path.join(
      f.store.runsDir,
      "artifacts",
      f.runId,
      `${f.metadata.digest}.blob`,
    ),
    "changed",
  );
  expect((await readRunArtifact(f.store, f.runId, "report-1")).ok).toBe(false);
  const other = await fixture();
  expect((await readRunArtifact(other.store, other.runId, "report-1")).ok).toBe(
    false,
  );
});
it("deduplicates byte storage across bindings and repairs an interrupted metadata append", async () => {
  const f = await fixture();
  const input = { ...f, sourceRoot: f.scratch, sourcePath: "report.json" };
  expect((await captureRunArtifact(input)).ok).toBe(true);
  const indexPath = path.join(
    f.store.runsDir,
    "artifacts",
    f.runId,
    "index.jsonl",
  );
  await writeFile(
    indexPath,
    (await readFile(indexPath, "utf8")) + '{"interrupted":',
  );
  expect(
    (
      await captureRunArtifact({
        ...input,
        metadata: { ...f.metadata, artifactId: "clarification" },
      })
    ).ok,
  ).toBe(true);
  expect((await readRunArtifact(f.store, f.runId, "clarification")).ok).toBe(
    true,
  );
  expect((await readFile(indexPath, "utf8")).trim().split("\n")).toHaveLength(
    2,
  );
});
it("enforces count and serialized base64 budgets without dropping retained history", async () => {
  const f = await fixture();
  const input = { ...f, sourceRoot: f.scratch, sourcePath: "report.json" };
  for (let i = 0; i < 128; i++)
    expect(
      (
        await captureRunArtifact({
          ...input,
          metadata: { ...f.metadata, artifactId: `a-${i}` },
        })
      ).ok,
    ).toBe(true);
  expect(
    await captureRunArtifact({
      ...input,
      metadata: { ...f.metadata, artifactId: "over" },
    }),
  ).toMatchObject({ ok: false, reason: "run exceeds 128 attachments" });
  const b = await fixture();
  for (let i = 0; i < 3; i++) {
    const text = String(i).repeat(2 * 1024 * 1024);
    await writeFile(path.join(b.scratch, "large"), text);
    const result = await captureRunArtifact({
      ...b,
      sourceRoot: b.scratch,
      sourcePath: "large",
      metadata: {
        ...b.metadata,
        artifactId: `large-${i}`,
        digest: sha256Hex(text),
        sizeBytes: Buffer.byteLength(text),
      },
    });
    expect(result.ok).toBe(i < 2);
    if (i === 2)
      expect(result).toMatchObject({
        reason: "run exceeds 8 MiB serialized attachment limit",
      });
  }
  expect((await readRunArtifact(b.store, b.runId, "large-0")).ok).toBe(true);
});
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
it("serializes independent-process ID conflicts and count limits", async () => {
  const f = await fixture();
  const sourceRoot = f.scratch;
  const sourcePath = "report.json";
  const root = path.resolve(f.store.runsDir, "../..");
  const processCapture = async (metadata: typeof f.metadata) => {
    const result = await execute(process.execPath, [
      "--import",
      "tsx",
      path.resolve("packages/kernel/test-fixtures/run-artifact-process.ts"),
      JSON.stringify({
        root,
        runId: f.runId,
        sourceRoot,
        sourcePath,
        metadata,
      }),
    ]);
    return JSON.parse(result.stdout) as { ok: boolean };
  };
  const race = await Promise.all([
    processCapture({ ...f.metadata, attemptId: "one" }),
    processCapture({ ...f.metadata, attemptId: "two" }),
  ]);
  expect(race.filter((r) => r.ok)).toHaveLength(1);
  for (let i = 0; i < 126; i++)
    expect(
      (
        await captureRunArtifact({
          ...f,
          sourceRoot,
          sourcePath,
          metadata: { ...f.metadata, artifactId: `fill-${i}` },
        })
      ).ok,
    ).toBe(true);
  const countRace = await Promise.all([
    processCapture({ ...f.metadata, artifactId: "last-one" }),
    processCapture({ ...f.metadata, artifactId: "last-two" }),
  ]);
  expect(countRace.filter((r) => r.ok)).toHaveLength(1);
}, 15000);
import { chmod, symlink } from "node:fs/promises";
it("refuses escaped source links and unsafe retained file modes", async () => {
  const f = await fixture();
  const outside = await fixture();
  await symlink(
    path.join(outside.scratch, "report.json"),
    path.join(f.scratch, "escape"),
  );
  expect(
    (
      await captureRunArtifact({
        ...f,
        sourceRoot: f.scratch,
        sourcePath: "escape",
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await captureRunArtifact({
        ...f,
        sourceRoot: f.scratch,
        sourcePath: "report.json",
      })
    ).ok,
  ).toBe(true);
  const blob = path.join(
    f.store.runsDir,
    "artifacts",
    f.runId,
    `${f.metadata.digest}.blob`,
  );
  await chmod(blob, 0o644);
  expect(
    (await readRunArtifact(f.store, f.runId, f.metadata.artifactId)).ok,
  ).toBe(false);
});
it("refuses JSON-escaped credential values without redacting the source", async () => {
  const f = await fixture();
  const text = '{"value":"\\u0067hp_' + "x".repeat(30) + '"}';
  await writeFile(path.join(f.scratch, "report.json"), text);
  expect(
    (
      await captureRunArtifact({
        ...f,
        sourceRoot: f.scratch,
        sourcePath: "report.json",
        metadata: {
          ...f.metadata,
          digest: sha256Hex(text),
          sizeBytes: Buffer.byteLength(text),
        },
      })
    ).ok,
  ).toBe(false);
  expect(await readFile(path.join(f.scratch, "report.json"), "utf8")).toBe(
    text,
  );
});

it("refuses same-length retained corruption even when the recorded size still matches", async () => {
  const f = await fixture();
  expect(
    (
      await captureRunArtifact({
        ...f,
        sourceRoot: f.scratch,
        sourcePath: "report.json",
      })
    ).ok,
  ).toBe(true);
  const intact = await readRunArtifact(f.store, f.runId, f.metadata.artifactId);
  expect(
    intact.ok && Buffer.from(intact.base64, "base64").toString("utf8"),
  ).toBe(f.text);
  const changed = f.text.replace("requested", "requestex");
  expect(changed).not.toBe(f.text);
  expect(Buffer.byteLength(changed)).toBe(f.metadata.sizeBytes);
  await writeFile(
    path.join(
      f.store.runsDir,
      "artifacts",
      f.runId,
      `${f.metadata.digest}.blob`,
    ),
    changed,
  );
  expect(
    await readRunArtifact(f.store, f.runId, f.metadata.artifactId),
  ).toMatchObject({
    ok: false,
    reason: "retained attachment digest or size mismatch",
  });
});

it("counts metadata when payload bytes alone fit the serialized attachment budget", async () => {
  const f = await fixture();
  const limit = 8 * 1024 * 1024;
  const texts = [
    "0".repeat(2 * 1024 * 1024),
    "1".repeat(2 * 1024 * 1024),
    "2".repeat(2 * 1024 * 1024 - 512),
  ];
  const attachments = texts.map((text, i) => ({
    ...f.metadata,
    artifactId: `near-limit-${i}`,
    digest: sha256Hex(text),
    sizeBytes: Buffer.byteLength(text),
  }));
  const payloads = Object.fromEntries(
    attachments.map((metadata, i) => [
      metadata.digest,
      Buffer.from(texts[i]!).toString("base64"),
    ]),
  );
  // The failure is caused by retained metadata, not already oversized encoded content.
  expect(Buffer.byteLength(JSON.stringify({ payloads }), "utf8")).toBeLessThan(
    limit,
  );
  expect(
    Buffer.byteLength(JSON.stringify({ attachments, payloads }), "utf8"),
  ).toBeGreaterThan(limit);
  for (let i = 0; i < 2; i++) {
    await writeFile(path.join(f.scratch, "large.txt"), texts[i]!);
    expect(
      (
        await captureRunArtifact({
          ...f,
          metadata: attachments[i]!,
          sourceRoot: f.scratch,
          sourcePath: "large.txt",
        })
      ).ok,
    ).toBe(true);
  }
  const indexPath = path.join(
    f.store.runsDir,
    "artifacts",
    f.runId,
    "index.jsonl",
  );
  const before = await readFile(indexPath, "utf8");
  await writeFile(path.join(f.scratch, "large.txt"), texts[2]!);
  expect(
    await captureRunArtifact({
      ...f,
      metadata: attachments[2]!,
      sourceRoot: f.scratch,
      sourcePath: "large.txt",
    }),
  ).toMatchObject({
    ok: false,
    reason: "run exceeds 8 MiB serialized attachment limit",
  });
  expect(await readFile(indexPath, "utf8")).toBe(before);
  for (let i = 0; i < 2; i++) {
    const retained = await readRunArtifact(
      f.store,
      f.runId,
      attachments[i]!.artifactId,
    );
    expect(
      retained.ok && Buffer.from(retained.base64, "base64").toString("utf8"),
    ).toBe(texts[i]);
  }
});
