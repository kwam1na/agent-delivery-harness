import { expect, it } from "vitest";
import { sha256Hex, type RunEvent } from "@agent-delivery-harness/kernel";
import { buildRunArchive, readArchiveArtifact } from "./run-archive.ts";
import { parseRunExport, buildRunExport } from "./run-export.ts";
const text = '{"verdict":"changes-requested"}';
const metadata = {
  artifactId: "review",
  activityId: "review",
  attemptId: "attempt",
  candidateTreeSha: "a".repeat(40),
  digest: sha256Hex(text),
  sizeBytes: Buffer.byteLength(text),
  mediaType: "application/json",
  producer: "codex",
};
const event: RunEvent = {
  version: "run-event/2",
  eventId: "e1",
  seq: 1,
  runId: "run-1",
  at: "2026-09-07T12:00:00Z",
  repo: { commonDir: "/removed/repo" },
  kind: "artifact.referenced",
  actor: { role: "executor" },
  attestation: "self",
  candidateTreeSha: metadata.candidateTreeSha,
  payload: metadata,
};
it("retains exact bytes and historical projection without the source store", async () => {
  const archive = await buildRunArchive({
    runId: "run-1",
    events: [event],
    readArtifact: async () => ({
      ok: true,
      metadata,
      base64: Buffer.from(text).toString("base64"),
    }),
  });
  expect(archive.ok).toBe(true);
  if (!archive.ok) return;
  const parsed = parseRunExport(archive.text);
  expect(parsed.ok).toBe(true);
  expect(readArchiveArtifact(archive.text, "review")).toMatchObject({
    ok: true,
    base64: Buffer.from(text).toString("base64"),
  });
  if (parsed.ok)
    expect(parsed.value.progress).toEqual(
      buildRunExport({ runId: "run-1", events: [event] }).progress,
    );
  const corrupt = JSON.parse(archive.text);
  corrupt.attachments.blobs[metadata.digest] =
    Buffer.from("forged").toString("base64");
  expect(parseRunExport(JSON.stringify(corrupt)).ok).toBe(false);
});
it("labels unavailable attachments and preserves legacy exports", async () => {
  const archive = await buildRunArchive({
    runId: "run-1",
    events: [event],
    readArtifact: async () => ({
      ok: false,
      code: "missing",
      reason: "attachment unavailable",
    }),
  });
  expect(archive.ok).toBe(true);
  if (archive.ok)
    expect(readArchiveArtifact(archive.text, "review")).toMatchObject({
      ok: false,
      reason: "attachment unavailable",
    });
  const legacy = {
    ...event,
    version: "run-event/1" as const,
    kind: "blocker.recorded" as const,
    payload: { code: "example", summary: "example" },
  };
  const { eventId, candidateTreeSha, ...v1 } = legacy;
  expect(
    parseRunExport(
      JSON.stringify(buildRunExport({ runId: "run-1", events: [v1] })),
    ).ok,
  ).toBe(true);
});
it("rejects swapped bindings, extra blobs, traversal keys, missing bytes, and new versions", async () => {
  const built = await buildRunArchive({
    runId: "run-1",
    events: [event],
    readArtifact: async () => ({
      ok: true,
      metadata,
      base64: Buffer.from(text).toString("base64"),
    }),
  });
  if (!built.ok) throw Error(built.reason);
  const mutations = [
    (v: {
      spec: string;
      attachments: {
        entries: { metadata: { attemptId: string } }[];
        blobs: Record<string, string>;
      };
    }) => (v.attachments.entries[0]!.metadata.attemptId = "other"),
    (v: {
      spec: string;
      attachments: {
        entries: { metadata: { attemptId: string } }[];
        blobs: Record<string, string>;
      };
    }) => (v.attachments.blobs["../secret"] = "eA=="),
    (v: {
      spec: string;
      attachments: {
        entries: { metadata: { attemptId: string } }[];
        blobs: Record<string, string>;
      };
    }) => (v.attachments.blobs["b".repeat(64)] = "eA=="),
    (v: {
      spec: string;
      attachments: {
        entries: { metadata: { attemptId: string } }[];
        blobs: Record<string, string>;
      };
    }) => delete v.attachments.blobs[metadata.digest],
    (v: {
      spec: string;
      attachments: {
        entries: { metadata: { attemptId: string } }[];
        blobs: Record<string, string>;
      };
    }) => (v.spec = "delivery-run-export/99"),
    (v: {
      spec: string;
      attachments: {
        entries: { metadata: { attemptId: string } }[];
        blobs: Record<string, string>;
      };
    }) => v.attachments.entries.push(v.attachments.entries[0]!),
  ];
  for (const mutate of mutations) {
    const copy = JSON.parse(built.text);
    mutate(copy);
    expect(parseRunExport(JSON.stringify(copy)).ok).toBe(false);
  }
});
it("deduplicates identical bytes across distinct reports and retains empty output", async () => {
  const other = {
    ...event,
    eventId: "e2",
    seq: 2,
    payload: { ...metadata, artifactId: "clarification" },
  };
  const archive = await buildRunArchive({
    runId: "run-1",
    events: [event, other],
    readArtifact: async (id) => ({
      ok: true,
      metadata: { ...metadata, artifactId: id },
      base64: Buffer.from(text).toString("base64"),
    }),
  });
  if (!archive.ok) throw Error(archive.reason);
  expect(Object.keys(JSON.parse(archive.text).attachments.blobs)).toHaveLength(
    1,
  );
  const empty = { ...metadata, digest: sha256Hex(""), sizeBytes: 0 };
  const zero = await buildRunArchive({
    runId: "run-1",
    events: [{ ...event, payload: empty }],
    readArtifact: async () => ({ ok: true, metadata: empty, base64: "" }),
  });
  expect(zero.ok).toBe(true);
});
it("refuses per-artifact, count, aggregate, archive limits and secret-bearing bytes", async () => {
  const buildText = async (text: string) => {
    const m = {
      ...metadata,
      digest: sha256Hex(text),
      sizeBytes: Buffer.byteLength(text),
    };
    return buildRunArchive({
      runId: "run-1",
      events: [{ ...event, payload: m }],
      readArtifact: async () => ({
        ok: true,
        metadata: m,
        base64: Buffer.from(text).toString("base64"),
      }),
    });
  };
  expect((await buildText("x".repeat(2 * 1024 * 1024))).ok).toBe(true);
  expect((await buildText("x".repeat(2 * 1024 * 1024 + 1))).ok).toBe(false);
  expect((await buildText("ghp_" + "a".repeat(30))).ok).toBe(false);
  const many = Array.from({ length: 129 }, (_, i) => ({
    ...event,
    seq: i + 1,
    eventId: `e-${i}`,
    payload: { ...metadata, artifactId: `a-${i}` },
  }));
  let reads = 0;
  expect(
    (
      await buildRunArchive({
        runId: "run-1",
        events: many,
        readArtifact: async () => {
          reads++;
          return { ok: false, code: "missing", reason: "missing" };
        },
      })
    ).ok,
  ).toBe(false);
  expect(reads).toBe(0);
  const values = ["0", "1", "2"].map((c) => c.repeat(2 * 1024 * 1024));
  const refs = values.map((v, i) => ({
    ...event,
    seq: i + 1,
    eventId: `e-${i}`,
    payload: {
      ...metadata,
      artifactId: `a-${i}`,
      digest: sha256Hex(v),
      sizeBytes: Buffer.byteLength(v),
    },
  }));
  expect(
    await buildRunArchive({
      runId: "run-1",
      events: refs,
      readArtifact: async (id) => {
        const i = Number(id.slice(2));
        return {
          ok: true,
          metadata: refs[i]!.payload as typeof metadata,
          base64: Buffer.from(values[i]!).toString("base64"),
        };
      },
    }),
  ).toMatchObject({
    ok: false,
    reason: "archive exceeds 8 MiB serialized attachment limit",
  });
  expect(
    (
      await buildRunArchive({
        runId: "run-1",
        events: [event],
        refusedAppends: ["x".repeat(16 * 1024 * 1024)],
        readArtifact: async () => ({
          ok: false,
          code: "missing",
          reason: "missing",
        }),
      })
    ).ok,
  ).toBe(false);
  expect(parseRunExport(" ".repeat(16 * 1024 * 1024 + 1)).ok).toBe(false);
});
it("refuses corrupt retained storage rather than labeling it unavailable", async () => {
  expect(
    await buildRunArchive({
      runId: "run-1",
      events: [event],
      readArtifact: async () => ({
        ok: false,
        code: "corrupt",
        reason: "digest mismatch",
      }),
    }),
  ).toEqual({
    ok: false,
    reason: "retained attachment corrupt; export refused",
  });
  const refused = await buildRunArchive({
    runId: "run-1",
    events: [event],
    readArtifact: async () => ({
      ok: false,
      code: "access_refused",
      reason: "private content unavailable",
    }),
  });
  expect(refused.ok).toBe(true);
});
it("accepts exactly the full archive limit and refuses the next byte", async () => {
  const initial = await buildRunArchive({
    runId: "run-1",
    events: [],
    refusedAppends: [""],
    readArtifact: async () => ({
      ok: false,
      code: "missing",
      reason: "missing",
    }),
  });
  if (!initial.ok) throw Error(initial.reason);
  const padding = 16 * 1024 * 1024 - Buffer.byteLength(initial.text);
  const at = await buildRunArchive({
    runId: "run-1",
    events: [],
    refusedAppends: ["x".repeat(padding)],
    readArtifact: async () => ({
      ok: false,
      code: "missing",
      reason: "missing",
    }),
  });
  expect(at.ok).toBe(true);
  if (at.ok) expect(Buffer.byteLength(at.text)).toBe(16 * 1024 * 1024);
  expect(
    await buildRunArchive({
      runId: "run-1",
      events: [],
      refusedAppends: ["x".repeat(padding + 1)],
      readArtifact: async () => ({
        ok: false,
        code: "missing",
        reason: "missing",
      }),
    }),
  ).toMatchObject({
    ok: false,
    reason: "archive exceeds 16 MiB serialized limit",
  });
});
it("bounds the complete v2 archive including retained attachments and overhead", async () => {
  const bytes = "x".repeat(2 * 1024 * 1024);
  const retained = {
    ...metadata,
    digest: sha256Hex(bytes),
    sizeBytes: Buffer.byteLength(bytes),
  };
  const events = [{ ...event, payload: retained }];
  const readArtifact = async () => ({
    ok: true as const,
    metadata: retained,
    base64: Buffer.from(bytes).toString("base64"),
  });
  const initial = await buildRunArchive({
    runId: "run-1",
    events,
    refusedAppends: [""],
    readArtifact,
  });
  if (!initial.ok) throw Error(initial.reason);
  expect(
    Buffer.byteLength(JSON.stringify(JSON.parse(initial.text).attachments)),
  ).toBeLessThan(8 * 1024 * 1024);
  const limit = 16 * 1024 * 1024;
  const padding = limit - Buffer.byteLength(initial.text);
  const input = {
    runId: "run-1",
    events,
    refusedAppends: ["x".repeat(padding)],
    readArtifact,
  };
  const at = await buildRunArchive(input);
  expect(at.ok).toBe(true);
  if (!at.ok) throw Error(at.reason);
  expect(Buffer.byteLength(at.text)).toBe(limit);
  expect(readArchiveArtifact(at.text, retained.artifactId)).toMatchObject({
    ok: true,
    base64: Buffer.from(bytes).toString("base64"),
  });
  const over = { ...input, refusedAppends: ["x".repeat(padding + 1)] };
  expect(Buffer.byteLength(JSON.stringify(buildRunExport(over)))).toBeLessThan(
    limit,
  );
  const rejected = await buildRunArchive(over);
  expect(rejected.ok).toBe(false);
  if (!rejected.ok)
    expect(rejected.reason).toBe("archive exceeds 16 MiB serialized limit");
});
