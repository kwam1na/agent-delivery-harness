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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const SCRIPT_PATH = path.join(SCRIPTS_DIR, "recompile-policy-snapshot.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

it("bootstrap refuses existing authority artifacts instead of replacing them", async () => {
  const dir = await fixture();
  const before = await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8");
  const result = await run(dir, "--product", "--bootstrap");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("bootstrap requires absent");
  expect(await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8")).toBe(before);
});

/**
 * The script as a command, run against a fixture root. The script file stays
 * in this checkout so `@agent-delivery-harness/kernel` resolves the way it
 * does in a real run; only the working directory — which is what the command
 * takes as its root — is the fixture's.
 */
function run(cwd: string, ...args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [SCRIPT_PATH, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

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
  it("bootstraps explicit inputs without a comparison approval and refuses partial states", async () => {
    const dir = await fixture();
    await cp(path.join(REPO_ROOT, ".agent-skills/active.json"), path.join(dir, ".agent-skills/active.json"));
    await cp(path.join(REPO_ROOT, INSTALLED_ARCHIVE_DIR, "runtime"), path.join(dir, INSTALLED_ARCHIVE_DIR, "runtime"), { recursive: true });
    await rm(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE));
    // A remaining comparison report is partial authority state, not permission.
    await expect(recompilePolicySnapshot(dir, { product: true, bootstrap: true })).rejects.toThrow("bootstrap requires absent comparison-report.json");
    await rm(path.join(dir, POLICY_PROJECTION_DIR, REPORT_FILE));
    await expect(recompilePolicySnapshot(dir, { product: true, bootstrap: true })).rejects.toThrow("explicit bootstrap-inputs.json");
    await writePolicyJson(dir, "bootstrap-inputs.json", { productTrustRevocationEpoch: 2, repositoryAuthorityRevocationEpoch: 3 });
    const result = await recompilePolicySnapshot(dir, { product: true, bootstrap: true });
    const snapshot = JSON.parse(result.text) as Snapshot;
    expect(snapshot.compiled.snapshot.productTrustRevocationEpoch).toBe(2);
    expect(snapshot.compiled.snapshot.repositoryAuthorityRevocationEpoch).toBe(3);
    const installedRuntime = JSON.parse(await readFile(path.join(dir, INSTALLED_ARCHIVE_DIR, "runtime/runtime.json"), "utf8")) as { runtimeVersion: string };
    const activeRelease = JSON.parse(await readFile(path.join(dir, ".agent-skills/active.json"), "utf8")) as { release: { archiveSha256: string } };
    expect(snapshot.compiledWith).toEqual({
      productTrustRevocationEpoch: 2,
      repositoryAuthorityRevocationEpoch: 3,
      module: "runtime/kernel.mjs",
      compilerSha256: createHash("sha256").update(await readFile(path.join(dir, INSTALLED_ARCHIVE_DIR, "runtime/kernel.mjs"))).digest("hex"),
      runtimeVersion: installedRuntime.runtimeVersion,
      bootstrapInputsSha256: createHash("sha256").update(await readFile(path.join(dir, POLICY_PROJECTION_DIR, "bootstrap-inputs.json"))).digest("hex"),
      personaSource: { archiveSha256: activeRelease.release.archiveSha256 },
    });
    expect(result.staleReport).toBe(false);
    expect((await run(dir, "--product", "--bootstrap")).code).toBe(0);
    await expect(readFile(path.join(dir, POLICY_PROJECTION_DIR, REPORT_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await run(dir, "--product", "--check")).code).toBe(0);
    expect((await run(dir, "--product", "--bootstrap")).code).toBe(1);
  });

  it.each([
    {},
    { productTrustRevocationEpoch: 2, repositoryAuthorityRevocationEpoch: 3, grant: true },
    ...["productTrustRevocationEpoch", "repositoryAuthorityRevocationEpoch"].flatMap((field) =>
      [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "3", null, undefined].map((invalid) => ({
        productTrustRevocationEpoch: 2,
        repositoryAuthorityRevocationEpoch: 3,
        [field]: invalid,
      }))),
  ])("refuses invalid explicit bootstrap provenance %j", async (inputs) => {
    const dir = await fixture();
    await rm(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE));
    await rm(path.join(dir, POLICY_PROJECTION_DIR, REPORT_FILE));
    await writePolicyJson(dir, "bootstrap-inputs.json", inputs);
    await expect(recompilePolicySnapshot(dir, { product: true, bootstrap: true })).rejects.toThrow("exactly both nonnegative");
    await expect(readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("product reconciliation follows the selected archive while preserving other provenance", async () => {
    const dir = await fixture();
    await cp(path.join(REPO_ROOT, ".agent-skills/active.json"), path.join(dir, ".agent-skills/active.json"));
    const active = JSON.parse(await readFile(path.join(dir, ".agent-skills/active.json"), "utf8")) as { release: { archiveSha256: string } };
    const recorded = JSON.parse(await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8")) as Snapshot;
    const provenance = { ...recorded.compiledWith, personaSource: { archiveSha256: "0".repeat(64), origin: "distributed release" } };
    await writePolicyJson(dir, SNAPSHOT_FILE, { ...recorded, compiledWith: provenance });
    const legacy = JSON.parse((await recompilePolicySnapshot(dir)).text) as Snapshot;
    expect(legacy.compiledWith).toEqual(provenance);
    const product = JSON.parse((await recompilePolicySnapshot(dir, { product: true })).text) as Snapshot;
    expect(product.compiledWith).toEqual({ ...provenance, personaSource: { ...provenance.personaSource, archiveSha256: active.release.archiveSha256 } });
    // Planning the repair must not silently change the adopter's snapshot.
    expect((JSON.parse(await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8")) as Snapshot).compiledWith).toEqual(provenance);
    const check = await run(dir, "--product", "--check");
    expect(check.code).not.toBe(0);
    expect((await run(dir, "--product")).code).toBe(0);
    expect((await run(dir, "--product", "--check")).code).toBe(0);
  });

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

  it("rewrites the snapshot when the policy has moved, as the command", { timeout: 120_000 }, async () => {
    // The exported function returns bytes and writes nothing, so the one side
    // effect this script has — and the branch AGENTS.md tells the delivery loop
    // to run — is only proven by driving the command itself.
    const dir = await fixture();
    const before = await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8");
    const document = await readPolicyJson<{ reviewLenses: unknown[] }>(dir, DOCUMENT_FILE);
    document.reviewLenses = [
      ...document.reviewLenses,
      { lensId: "lens.security", category: "additional", personaId: "persona.security" },
    ];
    await writePolicyJson(dir, DOCUMENT_FILE, document);

    const result = await run(dir);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("rewrote");
    const after = await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8");
    expect(after).not.toBe(before);
    expect(after).toBe((await recompilePolicySnapshot(dir)).text);
    // And it says the comparison report has stopped describing the snapshot,
    // rather than leaving the projection sensor to be the first to say so.
    expect(result.stdout).toContain(REPORT_FILE);
  });

  it("writes nothing under --check, and reports the drift", { timeout: 120_000 }, async () => {
    // `--check` is documented as the report-only mode. A mode that writes into
    // a protected authority tree while reporting is worse than no mode at all.
    const dir = await fixture();
    const before = await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8");

    const clean = await run(dir, "--check");
    expect(clean.code, clean.stderr).toBe(0);

    const document = await readPolicyJson<{ reviewLenses: unknown[] }>(dir, DOCUMENT_FILE);
    document.reviewLenses = [
      ...document.reviewLenses,
      { lensId: "lens.security", category: "additional", personaId: "persona.security" },
    ];
    await writePolicyJson(dir, DOCUMENT_FILE, document);

    const drifted = await run(dir, "--check");
    expect(drifted.code, "a snapshot that is not the current policy's compile is a failure").not.toBe(0);
    expect(await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8")).toBe(before);
  });

  it("refuses as a command, without writing, when an input is unusable", { timeout: 120_000 }, async () => {
    const dir = await fixture();
    const before = await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8");
    await rm(path.join(dir, INSTALLED_ARCHIVE_DIR), { recursive: true, force: true });

    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("recompile-policy-snapshot:");
    expect(await readFile(path.join(dir, POLICY_PROJECTION_DIR, SNAPSHOT_FILE), "utf8")).toBe(before);
  });

  it("names the comparison report it does not re-record", async () => {
    // The report's adjudications are a person's, so the script reports the
    // staleness instead of writing over it. The constant is checked against
    // the file that actually exists.
    const recorded = await readFile(path.join(REPO_ROOT, POLICY_PROJECTION_DIR, REPORT_FILE), "utf8");
    expect(JSON.parse(recorded)).toHaveProperty("inputs");
  });
});
