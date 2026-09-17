import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { candidateTreeEvidenceReader, candidateTreeSourceReader } from "./portable-inputs.ts";
import { MAX_PORTABLE_ARTIFACT_BYTES } from "./portable-evidence.ts";
import type { CandidateCommandRunner } from "./candidate.ts";

function fixture(bytes: Buffer, mode = "100644", returned = bytes) {
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const commands: string[][] = [];
  const run: CandidateCommandRunner = async args => {
    commands.push([...args]);
    if (args[1] === "ls-tree") return { exitCode: 0, stdout: `${mode} blob ${sha}\tinput\0`, stderr: "" };
    if (args[2] === "-s") return { exitCode: 0, stdout: String(bytes.length), stderr: "" };
    return { exitCode: 0, stdout: "", stdoutBase64: returned.toString("base64"), stderr: "" };
  };
  return { run, commands };
}

it("reads full binary source beyond the evidence limit while refusing oversized evidence before reading it", async () => {
  const bytes = Buffer.alloc(MAX_PORTABLE_ARTIFACT_BYTES + 1, 255); bytes[bytes.length - 1] = 128;
  const source = fixture(bytes);
  const read = await candidateTreeSourceReader("/fixture", "a".repeat(40), source.run);
  expect(bytes.equals((await read("input"))!)).toBe(true);
  expect(await read.metadata("input")).toEqual({ mode: "100644", links: [] });
  const evidence = fixture(bytes);
  await expect((await candidateTreeEvidenceReader("/fixture", "a".repeat(40), evidence.run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("oversized") }] });
  expect(evidence.commands.some(args => args[1] === "cat-file" && args[2] === "blob")).toBe(false);
  const boundary = Buffer.alloc(MAX_PORTABLE_ARTIFACT_BYTES, 0);
  expect(boundary.equals((await (await candidateTreeEvidenceReader("/fixture", "a".repeat(40), fixture(boundary).run))("input"))!)).toBe(true);
});

it.each([candidateTreeSourceReader, candidateTreeEvidenceReader])("retains exact blob integrity and containment for both readers", async reader => {
  const bytes = Buffer.from([0, 255, 128, 4]);
  await expect((await reader("/fixture", "a".repeat(40), fixture(bytes, "100644", bytes.subarray(0, 3)).run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("exact blob bytes") }] });
  await expect((await reader("/fixture", "a".repeat(40), fixture(Buffer.from("../escape"), "120000").run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("escapes") }] });
  await expect((await reader("/fixture", "a".repeat(40), fixture(bytes, "160000").run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("regular committed file") }] });
});

it.each([candidateTreeSourceReader, candidateTreeEvidenceReader])("reuses verified object bytes across paths and concurrent reads without sharing writable buffers", async reader => {
  const bytes = Buffer.from([0, 255, 128, 4]);
  const f = fixture(bytes);
  const run: CandidateCommandRunner = async args => {
    const result = await f.run(args, { cwd: "/fixture" });
    return args[1] === "ls-tree" ? { ...result, stdout: result.stdout + result.stdout.replace("\tinput\0", "\talias\0") } : result;
  };
  const read = await reader("/fixture", "a".repeat(40), run);
  const [first, alias, repeated] = await Promise.all([read("input"), read("alias"), read("input")]);
  expect(bytes.equals(first!)).toBe(true);
  expect(bytes.equals(alias!)).toBe(true);
  first![0] = 7;
  expect(bytes.equals(alias!)).toBe(true);
  expect(bytes.equals(repeated!)).toBe(true);
  expect(bytes.equals((await read("input"))!)).toBe(true);
  expect(f.commands.filter(args => args[1] === "cat-file" && args[2] === "-s")).toHaveLength(1);
  expect(f.commands.filter(args => args[1] === "cat-file" && args[2] === "blob")).toHaveLength(1);
});

it.each([candidateTreeSourceReader, candidateTreeEvidenceReader])("retries rejected reads and does not share successful verification with a new reader", async reader => {
  const bytes = Buffer.from("verified bytes");
  const good = fixture(bytes), corrupt = fixture(bytes, "100644", bytes.subarray(0, bytes.length - 1));
  let fail = true;
  const run: CandidateCommandRunner = (args, options) => (fail ? corrupt.run : good.run)(args, options);
  const read = await reader("/fixture", "a".repeat(40), run);
  await expect(read("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  fail = false;
  expect(bytes.equals((await read("input"))!)).toBe(true);
  fail = true;
  // This reader retains the already verified immutable bytes, not the mutable caller result.
  expect(bytes.equals((await read("input"))!)).toBe(true);
  await expect((await reader("/fixture", "a".repeat(40), run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  await expect((await reader("/other-root", "b".repeat(40), run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
});

it("keeps verified source and evidence caches separate for the same oversized object", async () => {
  const bytes = Buffer.alloc(MAX_PORTABLE_ARTIFACT_BYTES + 1, 137), f = fixture(bytes);
  const source = await candidateTreeSourceReader("/fixture", "a".repeat(40), f.run);
  const evidence = await candidateTreeEvidenceReader("/fixture", "a".repeat(40), f.run);
  expect(bytes.equals((await source("input"))!)).toBe(true);
  await expect(evidence("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("oversized") }] });
  expect(bytes.equals((await source("input"))!)).toBe(true);
  expect(f.commands.filter(args => args[1] === "cat-file" && args[2] === "blob")).toHaveLength(1);
});

it("returns independent symlink metadata while memoizing only verified object bytes", async () => {
  const bytes = Buffer.from("target content"), target = Buffer.from("target");
  const oid = (value: Buffer) => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
  const commands: string[][] = [];
  const run: CandidateCommandRunner = async args => {
    commands.push([...args]);
    if (args[1] === "ls-tree") return { exitCode: 0, stdout: `120000 blob ${oid(target)}\tlink\0` + `100644 blob ${oid(bytes)}\ttarget\0`, stderr: "" };
    const value = args[3] === oid(target) ? target : bytes;
    return args[2] === "-s" ? { exitCode: 0, stdout: String(value.length), stderr: "" } : { exitCode: 0, stdout: "", stdoutBase64: value.toString("base64"), stderr: "" };
  };
  const read = await candidateTreeSourceReader("/fixture", "a".repeat(40), run);
  const metadata = await read.metadata("link");
  (metadata.links as { path: string; target: string }[])[0]!.target = "../escape";
  expect(await read.metadata("link")).toEqual({ mode: "100644", links: [{ path: "link", target: "target" }] });
  expect(bytes.equals((await read("link"))!)).toBe(true);
  expect(bytes.equals((await read("target"))!)).toBe(true);
  expect(commands.filter(args => args[1] === "cat-file" && args[2] === "blob")).toHaveLength(2);
});

it.each([candidateTreeSourceReader, candidateTreeEvidenceReader])("keeps regular-file authorization per path after the same OID is verified", async reader => {
  const bytes = Buffer.from("verified bytes"), f = fixture(bytes);
  const run: CandidateCommandRunner = async (args, options) => {
    const result = await f.run(args, options);
    return args[1] === "ls-tree" ? { ...result, stdout: result.stdout + result.stdout.replace("100644 blob", "160000 commit").replace("\tinput\0", "\tgitlink\0") } : result;
  };
  const read = await reader("/fixture", "a".repeat(40), run);
  expect(bytes.equals((await read("input"))!)).toBe(true);
  expect(await read.metadata("input")).toEqual({ mode: "100644", links: [] });
  await expect(read("gitlink")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("regular committed file") }] });
  await expect(read.metadata("gitlink")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("regular committed file") }] });
  expect(bytes.equals((await read("input"))!)).toBe(true);
});

it.each([candidateTreeSourceReader, candidateTreeEvidenceReader])("checks containment and chain limits after link bytes are already verified", async reader => {
  for (const target of ["../escape", "link"]) {
    const bytes = Buffer.from(target), f = fixture(bytes);
    const run: CandidateCommandRunner = async (args, options) => {
      const result = await f.run(args, options);
      return args[1] === "ls-tree" ? { ...result, stdout: result.stdout + result.stdout.replace("100644 blob", "120000 blob").replace("\tinput\0", "\tlink\0") } : result;
    };
    const read = await reader("/fixture", "a".repeat(40), run);
    expect(bytes.equals((await read("input"))!)).toBe(true);
    await expect(read("link")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining(target === "link" ? "cyclic" : "escapes") }] });
    await expect(read.metadata("link")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
    expect(bytes.equals((await read("input"))!)).toBe(true);
  }
});
