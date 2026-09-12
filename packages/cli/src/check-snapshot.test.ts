import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createCheckSnapshot } from "./check-snapshot.ts";

const removal = vi.hoisted(() => ({ fail: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (args[0] === removal.fail) throw Object.assign(new Error("fixture removal refused"), { code: "EACCES" });
    return actual.rm(...args);
  } };
});
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scoped-snapshot-test-")); roots.push(root);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "source.txt"), "base");
  await git("add", "."); await git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
  const headSha = await git("rev-parse", "HEAD");
  await writeFile(path.join(root, "source.txt"), "prepared");
  await writeFile(path.join(root, "new.txt"), "staged new source"); await git("add", ".");
  const treeSha = await git("write-tree");
  return { root, git, candidate: { headSha, treeSha, base: { ref: "origin/main", tipSha: headSha, mergeBaseSha: headSha } } };
}
it("materializes the exact staged tree with private Git and pinned diff context, surviving authoring edit-restore", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: ["out/"], environment: {} });
  try {
    await writeFile(path.join(f.root, "source.txt"), "concurrent edit");
    expect(await readFile(path.join(snapshot.rootDir, "source.txt"), "utf8")).toBe("prepared");
    expect(await readFile(path.join(snapshot.rootDir, "new.txt"), "utf8")).toBe("staged new source");
    const diff = await exec("git", ["diff", "--name-only", snapshot.environment["DELIVERY_CHECK_BASE_REF"]!, snapshot.environment["DELIVERY_CHECK_CANDIDATE_REF"]!], { cwd: snapshot.rootDir });
    expect(diff.stdout.trim().split("\n")).toEqual(["new.txt", "source.txt"]);
    const headDiff = await exec("git", ["diff", "--name-only", snapshot.environment["DELIVERY_CHECK_BASE_REF"]!, "HEAD"], { cwd: snapshot.rootDir });
    expect(headDiff.stdout).toBe(diff.stdout);
    await writeFile(path.join(f.root, "source.txt"), "prepared");
    await expect(snapshot.verify()).resolves.toBeUndefined();
    await mkdir(path.join(snapshot.rootDir, "out")); await writeFile(path.join(snapshot.rootDir, "out/result"), "ok");
    await expect(snapshot.verify()).resolves.toBeUndefined();
    await writeFile(path.join(snapshot.rootDir, "source.txt"), "drift");
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
});
it("rejects source links escaping the private snapshot", async () => {
  const f = await fixture(); await symlink(f.root, path.join(f.root, "escape")); await f.git("add", "escape");
  f.candidate.treeSha = await f.git("write-tree");
  await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} })).rejects.toMatchObject({ code: "check_snapshot_escape" });
});
it("installs private dependencies, excludes inherited flags, and detects dependency mutation", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: { DECLARED_FLAG: "bound" },
    dependencies: { command: [process.execPath, "-e", "require('fs').mkdirSync('node_modules');require('fs').writeFileSync('node_modules/dep','private')"], timeoutMs: 5000 } });
  try {
    expect(snapshot.environment["DECLARED_FLAG"]).toBe("bound");
    expect(snapshot.environment["NODE_OPTIONS"]).toBeUndefined();
    await writeFile(path.join(snapshot.rootDir, "node_modules/dep"), "drift");
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
});
it("refuses failed dependency setup and source mutation by install", async () => {
  const f = await fixture();
  for (const script of ["process.exit(3)", "require('fs').writeFileSync('source.txt','bad')"]) {
    await expect(createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {}, dependencies: { command: [process.execPath, "-e", script], timeoutMs: 5000 } })).rejects.toMatchObject({ code: script.includes("exit") ? "check_dependency_failed" : "check_snapshot_drift" });
  }
});

it("reports cleanup failure without hiding ownership of the retained snapshot", async () => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} });
  removal.fail = snapshot.rootDir;
  try { await expect(snapshot.cleanup()).rejects.toMatchObject({ code: "check_snapshot_cleanup_failed" }); }
  finally { removal.fail = ""; await snapshot.cleanup(); }
});
it.each(["index", "HEAD", "candidate", "base"])("rejects independent %s drift with unchanged source bytes", async member => {
  const f = await fixture();
  const snapshot = await createCheckSnapshot({ rootDir: f.root, candidate: f.candidate, outputs: [], environment: {} });
  try {
    const git = async (...args: string[]) => (await exec("git", args, { cwd: snapshot.rootDir })).stdout.trim();
    const head = await git("rev-parse", "HEAD");
    if (member === "index") await git("read-tree", f.candidate.headSha);
    else await git("update-ref", member === "candidate" ? "refs/delivery/candidate" : member === "base" ? "refs/delivery/base" : "HEAD", member === "base" ? head : f.candidate.headSha);
    expect(await readFile(path.join(snapshot.rootDir, "source.txt"), "utf8")).toBe("prepared");
    expect(await readFile(path.join(snapshot.rootDir, "new.txt"), "utf8")).toBe("staged new source");
    await expect(snapshot.verify()).rejects.toMatchObject({ code: "check_snapshot_drift" });
  } finally { await snapshot.cleanup(); }
});
