/**
 * Vendored-kit drift guard.
 *
 * The 89 vectors in `packages/conformance/vectors` are a normative input: the
 * validator is implemented against them, so they must never be hand-edited.
 * Regenerating into a temp directory has to reproduce the vendored tree
 * byte-for-byte — otherwise the generator and the vectors have parted ways and
 * one of them is lying.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const generator = path.join(repoRoot, "packages", "conformance", "src", "generate.ts");
const vendored = path.join(repoRoot, "packages", "conformance", "vectors");

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function regenerate(): string {
  const out = mkdtempSync(path.join(os.tmpdir(), "dh-kit-"));
  tempRoots.push(out);
  const result = spawnSync("node", ["--import", "tsx", generator, out], { cwd: repoRoot, encoding: "utf8" });
  expect(result.error, String(result.error)).toBeUndefined();
  expect(result.status, `${result.stdout ?? ""}\n${result.stderr ?? ""}`).toBe(0);
  return out;
}

/** Files present in exactly one tree, or present in both with different bytes. */
function diffTrees(left: string, right: string): string[] {
  const leftFiles = listFiles(left);
  const rightFiles = listFiles(right);
  const all = [...new Set([...leftFiles, ...rightFiles])].sort();
  const differences: string[] = [];
  for (const rel of all) {
    if (!leftFiles.includes(rel) || !rightFiles.includes(rel)) {
      differences.push(rel);
      continue;
    }
    if (!readFileSync(path.join(left, rel)).equals(readFileSync(path.join(right, rel)))) differences.push(rel);
  }
  return differences;
}

describe("the vendored conformance kit", () => {
  it("is exactly what the vendored generator produces", () => {
    expect(diffTrees(vendored, regenerate())).toEqual([]);
  });

  it("goes red when a vendored file is hand-edited or dropped", () => {
    // Falsification: the guard is only worth having if tampering fails it.
    const tampered = regenerate();
    const target = path.join(tampered, "vectors", "accept", "a-minimal-green.json");
    writeFileSync(target, readFileSync(target, "utf8").replace('"verdict": "green"', '"verdict": "amber"'));
    rmSync(path.join(tampered, "vectors", "reject", "rg-7-defer-p0.json"));

    expect(diffTrees(vendored, tampered)).toEqual(["vectors/accept/a-minimal-green.json", "vectors/reject/rg-7-defer-p0.json"]);
  });

  it("carries the 89 vectors the spec's conformance kit declares", () => {
    const index = JSON.parse(readFileSync(path.join(vendored, "kit.json"), "utf8")) as {
      kit: string;
      spec: string;
      counts: { total: number; accept: number; reject: number };
      vectors: { id: string; file: string }[];
    };

    expect(index.kit).toBe("delivery-evidence-conformance/1");
    expect(index.spec).toBe("delivery-evidence/1");
    expect(index.counts).toEqual({ total: 89, accept: 8, reject: 81 });
    expect(index.vectors).toHaveLength(89);

    expect(listFiles(path.join(vendored, "vectors", "accept"))).toHaveLength(8);
    expect(listFiles(path.join(vendored, "vectors", "reject"))).toHaveLength(81);
    expect(listFiles(path.join(vendored, "context"))).toEqual(["environment.json", "repo-config.json"]);

    // Every index entry points at a file that is actually vendored.
    const onDisk = new Set(listFiles(vendored));
    for (const vector of index.vectors) expect(onDisk.has(vector.file), vector.file).toBe(true);
    expect(new Set(index.vectors.map((v) => v.id)).size).toBe(89);
  });
});
