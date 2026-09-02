/**
 * The policy-snapshot re-recorder, run against this repository's own policy
 * and against fixtures that move each of its inputs.
 *
 * WHAT THIS PROVES. The script rewrites an artifact inside a protected
 * authority tree, so the property that makes it safe to run is that an
 * unchanged policy produces the recorded bytes exactly — anything else turns
 * "re-record the snapshot" into an unreviewable diff. That is the first row.
 *
 * The rest are the anti-vacuity half, because "reproduces the recorded file"
 * is satisfied for free by a script that copies it. Each remaining row moves
 * one input the snapshot is compiled from — the policy document, the epochs
 * the compile runs under, the installed charter set — and requires the output
 * to move with it.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { PERSONA_MANIFEST_ENTRY } from "@agent-delivery-harness/kernel";

import {
  ADAPTERS_FILE,
  DOCUMENT_FILE,
  INSTALLED_ARCHIVE_DIR,
  POLICY_PROJECTION_DIR,
  RecompileError,
  REPORT_FILE,
  SNAPSHOT_FILE,
  recompilePolicySnapshot,
} from "./recompile-policy-snapshot.ts";
import {
  INSTALLED_ARCHIVE_DIR as SENSOR_ARCHIVE_DIR,
  POLICY_PROJECTION_DIR as SENSOR_POLICY_DIR,
} from "./policy-projection-check.ts";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");

const cleanups: string[] = [];
afterAll(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

interface Snapshot {
  readonly compiledWith: Record<string, unknown>;
  readonly inputDigests: Record<string, string>;
  readonly compiled: {
    readonly compiledDigest: string;
    readonly snapshot: {
      readonly productTrustRevocationEpoch: number;
      readonly repositoryAuthorityRevocationEpoch: number;
      readonly reviewLenses: { readonly lensId: string }[];
    };
  };
}

/** The release manifest that binds each shipped charter's bytes. */
const RELEASE_MANIFEST_ENTRY = "release-manifest.json";

/**
 * A copy of this repository's real policy inputs, mutable in place. Only the
 * charter directory and the release manifest binding its bytes are copied:
 * they are the whole of what the compile reads out of the installation, and
 * the generation itself carries a Python distribution this suite has no
 * business duplicating.
 */
async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "recompile-policy-"));
  cleanups.push(dir);
  await cp(path.join(REPO_ROOT, POLICY_PROJECTION_DIR), path.join(dir, POLICY_PROJECTION_DIR), { recursive: true });
  for (const entry of [path.dirname(PERSONA_MANIFEST_ENTRY), RELEASE_MANIFEST_ENTRY]) {
    await cp(
      path.join(REPO_ROOT, INSTALLED_ARCHIVE_DIR, entry),
      path.join(dir, INSTALLED_ARCHIVE_DIR, entry),
      { recursive: true, dereference: true },
    );
  }
  return dir;
}

const readPolicyJson = async <T>(dir: string, file: string): Promise<T> =>
  JSON.parse(await readFile(path.join(dir, POLICY_PROJECTION_DIR, file), "utf8")) as T;

const writePolicyJson = (dir: string, file: string, value: unknown): Promise<void> =>
  writeFile(path.join(dir, POLICY_PROJECTION_DIR, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");

describe("re-recording the compiled policy snapshot", () => {
  it("reads the policy and the installation from where the projection sensor reads them", () => {
    // One projection, one installation. Two roots would let the recorded
    // snapshot be compiled from documents the sensor never compares against.
    expect(POLICY_PROJECTION_DIR).toBe(SENSOR_POLICY_DIR);
    expect(INSTALLED_ARCHIVE_DIR).toBe(SENSOR_ARCHIVE_DIR);
  });

  it("regenerates this repository's recorded snapshot byte-identically", async () => {
    const result = await recompilePolicySnapshot(REPO_ROOT);
    const recorded = await readFile(path.join(REPO_ROOT, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8");
    expect(result.text).toBe(recorded);
    expect(result.unchanged).toBe(true);
    // The recorded snapshot is the current policy's compile, so the report
    // that pins its bytes still describes it.
    expect(result.staleReport).toBe(false);
  });

  it("compiles the policy document it is given rather than reproducing the recorded compile", async () => {
    // Activating one more lens is the change this script exists to re-record,
    // and the charter it names is resolved out of the installed generation
    // rather than supplied here — so a copier, or a compile against some other
    // charter set, both fail this row.
    const dir = await fixture();
    const document = await readPolicyJson<{ reviewLenses: unknown[] }>(dir, DOCUMENT_FILE);
    const activated = document.reviewLenses.length;
    expect(activated, "the policy activates lenses to add to").toBeGreaterThan(0);
    document.reviewLenses = [
      ...document.reviewLenses,
      { lensId: "lens.security", category: "additional", personaId: "persona.security" },
    ];
    await writePolicyJson(dir, DOCUMENT_FILE, document);

    const result = await recompilePolicySnapshot(dir);
    expect(result.unchanged).toBe(false);
    const snapshot = JSON.parse(result.text) as Snapshot;
    expect(snapshot.compiled.snapshot.reviewLenses).toHaveLength(activated + 1);
    expect(snapshot.compiled.snapshot.reviewLenses.map((lens) => lens.lensId)).toContain("lens.security");
    // The digests describe the bytes actually read, not the ones recorded.
    const recorded = await readPolicyJson<Snapshot>(dir, SNAPSHOT_FILE);
    expect(snapshot.inputDigests[DOCUMENT_FILE]).not.toBe(recorded.inputDigests[DOCUMENT_FILE]);
    expect(snapshot.inputDigests[ADAPTERS_FILE]).toBe(recorded.inputDigests[ADAPTERS_FILE]);
    expect(snapshot.compiled.compiledDigest).not.toBe(recorded.compiled.compiledDigest);
    // And the report that pinned the previous snapshot is reported as stale
    // rather than left for the projection sensor to discover.
    expect(result.staleReport).toBe(true);
  });

  it("carries the recorded provenance forward and compiles under the epochs it declares", async () => {
    const dir = await fixture();
    const recorded = await readPolicyJson<Snapshot>(dir, SNAPSHOT_FILE);
    await writePolicyJson(dir, SNAPSHOT_FILE, {
      ...recorded,
      compiledWith: { ...recorded.compiledWith, productTrustRevocationEpoch: 3 },
    });

    const snapshot = JSON.parse((await recompilePolicySnapshot(dir)).text) as Snapshot;
    // Provenance is a statement about which compiler produced the record, so
    // it is preserved rather than re-stamped from this run.
    expect(snapshot.compiledWith).toEqual({ ...recorded.compiledWith, productTrustRevocationEpoch: 3 });
    // And it is an input, not decoration: the epoch it declares is the epoch
    // the policy is compiled under.
    expect(snapshot.compiled.snapshot.productTrustRevocationEpoch).toBe(3);
    expect(snapshot.compiled.snapshot.repositoryAuthorityRevocationEpoch).toBe(
      recorded.compiledWith["repositoryAuthorityRevocationEpoch"],
    );
  });

  it("refuses a snapshot whose provenance declares no epochs, rather than defaulting them", async () => {
    const dir = await fixture();
    const recorded = await readPolicyJson<Snapshot>(dir, SNAPSHOT_FILE);
    const { productTrustRevocationEpoch: _dropped, ...withoutEpoch } = recorded.compiledWith;
    await writePolicyJson(dir, SNAPSHOT_FILE, { ...recorded, compiledWith: withoutEpoch });

    await expect(recompilePolicySnapshot(dir)).rejects.toThrow(RecompileError);
  });

  it("refuses when the installation cannot supply the charters the lenses reference", async () => {
    // The lenses reference their charters by identity, resolvable only against
    // the installed generation. A missing installation is a compile under no
    // charter at all, which is a refusal rather than a snapshot.
    const dir = await fixture();
    await rm(path.join(dir, INSTALLED_ARCHIVE_DIR), { recursive: true, force: true });
    await expect(recompilePolicySnapshot(dir)).rejects.toThrow(RecompileError);
  });

  it("refuses when the snapshot it re-records is not there", async () => {
    const dir = await fixture();
    await rm(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE));
    await expect(recompilePolicySnapshot(dir)).rejects.toThrow(RecompileError);
  });

  it("names the comparison report it does not re-record", async () => {
    // The report's adjudications are a person's, so the script reports the
    // staleness instead of writing over it. The constant is checked against
    // the file that actually exists.
    const recorded = await readFile(path.join(REPO_ROOT, POLICY_PROJECTION_DIR, REPORT_FILE), "utf8");
    expect(JSON.parse(recorded)).toHaveProperty("inputs");
  });
});
