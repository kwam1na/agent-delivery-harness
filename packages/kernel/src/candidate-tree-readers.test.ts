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
  expect(await read("input")).toEqual(bytes);
  expect(await read.metadata("input")).toEqual({ mode: "100644", links: [] });
  const evidence = fixture(bytes);
  await expect((await candidateTreeEvidenceReader("/fixture", "a".repeat(40), evidence.run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("oversized") }] });
  expect(evidence.commands.some(args => args[1] === "cat-file" && args[2] === "blob")).toBe(false);
  const boundary = Buffer.alloc(MAX_PORTABLE_ARTIFACT_BYTES, 0);
  expect(await (await candidateTreeEvidenceReader("/fixture", "a".repeat(40), fixture(boundary).run))("input")).toEqual(boundary);
});

it.each([candidateTreeSourceReader, candidateTreeEvidenceReader])("retains exact blob integrity and containment for both readers", async reader => {
  const bytes = Buffer.from([0, 255, 128, 4]);
  await expect((await reader("/fixture", "a".repeat(40), fixture(bytes, "100644", bytes.subarray(0, 3)).run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("exact blob bytes") }] });
  await expect((await reader("/fixture", "a".repeat(40), fixture(Buffer.from("../escape"), "120000").run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("escapes") }] });
  await expect((await reader("/fixture", "a".repeat(40), fixture(bytes, "160000").run))("input")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable", summary: expect.stringContaining("regular committed file") }] });
});
