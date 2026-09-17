import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { candidateTreeEvidenceReader, candidateTreeSourceReader } from "./portable-inputs.ts";
import { captureScopedCheckInputs } from "./checks.ts";
import type { CandidateCommandRunner } from "./candidate.ts";
import { runGitCommand } from "./candidate.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "directory-input-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root }).toString().trim();
  git("init", "-q");
  mkdirSync(path.join(root, "target/nested"), { recursive: true });
  mkdirSync(path.join(root, "other/nested"), { recursive: true });
  for (const dir of ["target", "other"]) {
    writeFileSync(path.join(root, dir, "nested/file"), "contents");
    writeFileSync(path.join(root, dir, "keep"), "keep");
  }
  symlinkSync("target", path.join(root, "link")); symlinkSync("link", path.join(root, "chain"));
  const tree = () => { git("add", "."); return git("write-tree"); };
  const capture = async () => {
    const sha = tree(), read = await candidateTreeSourceReader(root, sha);
    // The link alone must bind its descendants, even without a separate target scope.
    return captureScopedCheckInputs({ version: "scoped-check/1", files: ["chain"], memberships: [], tests: [], cwd: ".", profile: "test", environment: [] }, {
      listFiles: async () => ["chain"], readFile: read, readMetadata: read.metadata, command: ["check"], timeoutMs: 1000,
      runtimeDigest: "a".repeat(64), dependencyDigest: "b".repeat(64), policyDigest: "c".repeat(64), releaseDigest: "d".repeat(64), environment: {}, credentialIdentity: () => null,
    });
  };
  return { root, git, tree, capture };
}

it("captures a chained directory link as verified tree bytes with link metadata, without making directories evidence files", async () => {
  const f = fixture(), tree = f.tree(), read = await candidateTreeSourceReader(f.root, tree);
  const expected = execFileSync("git", ["cat-file", "tree", `${tree}:target`], { cwd: f.root });
  expect(await read("chain")).toEqual(expected);
  expect(await read.metadata("chain")).toEqual({ mode: "040000", links: [{ path: "chain", target: "link" }, { path: "link", target: "target" }] });
  expect(await read("target")).toBeNull();
  expect(await (await candidateTreeEvidenceReader(f.root, tree))("chain")).toBeNull();
  expect((await f.capture()).files[0]).toMatchObject({ path: "chain", sha256: expect.any(String), metadata: { mode: "040000" } });
});

it.each(["bytes", "addition", "deletion", "mode", "retarget"])("invalidates directory-link identity after nested %s changes", async change => {
  const f = fixture(), before = await f.capture(), file = path.join(f.root, "target/nested/file");
  if (change === "bytes") writeFileSync(file, "changed");
  if (change === "addition") writeFileSync(path.join(f.root, "target/nested/new"), "new");
  if (change === "deletion") rmSync(file);
  if (change === "mode") chmodSync(file, 0o755);
  if (change === "retarget") { rmSync(path.join(f.root, "link")); symlinkSync("other", path.join(f.root, "link")); }
  expect((await f.capture()).inputDigest).not.toBe(before.inputDigest);
});

it.each(["../escape", "/absolute", "chain"])("still refuses unsafe directory-link chain %s", async target => {
  const f = fixture(); rmSync(path.join(f.root, "link")); symlinkSync(target, path.join(f.root, "link"));
  const read = await candidateTreeSourceReader(f.root, f.tree());
  await expect(read("chain")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  await expect(read.metadata("chain")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
});

it("verifies tree-object bytes before caching and returns independent copies", async () => {
  const f = fixture(), tree = f.tree(); let corrupt = true, reads = 0;
  const run: CandidateCommandRunner = async (args, options) => {
    const result = await runGitCommand(args, options);
    if (args[1] === "cat-file" && args[2] === "tree") {
      reads++;
      if (corrupt) return { ...result, stdoutBase64: Buffer.from("corrupt").toString("base64") };
    }
    return result;
  };
  const read = await candidateTreeSourceReader(f.root, tree, run);
  await expect(read("chain")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  corrupt = false;
  const [first, second] = await Promise.all([read("chain"), read("link")]);
  const expected = execFileSync("git", ["cat-file", "tree", `${tree}:target`], { cwd: f.root });
  expect(first).toEqual(expected); expect(second).toEqual(expected);
  first![0] = first![0]! ^ 255;
  expect(second).toEqual(expected);
  expect(await read("chain")).toEqual(expected); expect(reads).toBe(2);
});

it("does not reuse a verified blob when an inconsistent listing requests that OID as a tree", async () => {
  const f = fixture(), tree = f.tree();
  const blob = f.git("rev-parse", `${tree}:target/nested/file`);
  const target = f.git("rev-parse", `${tree}:target`);
  const run: CandidateCommandRunner = async (args, options) => {
    const result = await runGitCommand(args, options);
    return args[1] === "ls-tree" ? { ...result, stdout: result.stdout.replace(`040000 tree ${target}\ttarget\0`, `040000 tree ${blob}\ttarget\0`) } : result;
  };
  const read = await candidateTreeSourceReader(f.root, tree, run);
  expect(await read("target/nested/file")).toEqual(Buffer.from("contents"));
  await expect(read("chain")).rejects.toMatchObject({ blockers: [{ code: "portable_tree_unreadable" }] });
  expect(await read("target/nested/file")).toEqual(Buffer.from("contents"));
});
