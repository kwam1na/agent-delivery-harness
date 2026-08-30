/**
 * The local pack/install/activate path and the walking skeleton's trust check sites,
 * exercised end to end against real scratch installations — never against
 * the operator's live configuration. Every install target in this suite is
 * a fresh temp directory; the repository checkout is only ever a read-only
 * pack input.
 *
 * These tests were written RED, before `installer.ts` existed.
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../digest.ts";
import { SPINE_ID } from "../spine/grammar.ts";
import { validateJournalEntry } from "../spine/journal.ts";
import { reduceDeliveryJournal } from "../spine/reducer.ts";
import { CONFIRMATION_FIXTURE_PROFILE, type CompositionProfile } from "./manifest.ts";
import {
  checkMutationLane,
  installComposition,
  loadPinnedGeneration,
  packComposition,
  receiptPathFor,
  registrationBinding,
  resolveActiveGeneration,
  trustStorePathFor,
} from "./installer.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const FIXTURES = path.join(REPO_ROOT, "qualifications", "fixtures");
const SKILLS_ARCHIVE = path.join(FIXTURES, "agent-skills-core-v1-composition.zip");
const SKILLS_METADATA = path.join(FIXTURES, "agent-skills-core-v1-composition.metadata.json");

let scratch: string;
let packedDir: string;
let generationDigest: string;

/** Read-only roots block their own deletion; restore owner-write first. */
const restoreWritable = (dir: string): void => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* removal will surface the real failure */
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) restoreWritable(child);
  }
};

const codesOf = (result: { ok: true } | { ok: false; blockers: readonly { code: string }[] }): string[] =>
  result.ok ? [] : result.blockers.map((blocker) => blocker.code);

const pack = async (options?: { profile?: CompositionProfile; sequence?: number; skillsArchive?: string }) => {
  const outDir = await mkdtemp(path.join(scratch, "pack-"));
  return packComposition({
    sourceRoot: REPO_ROOT,
    skillsArchivePath: options?.skillsArchive ?? SKILLS_ARCHIVE,
    skillsMetadataPath: SKILLS_METADATA,
    compositionProfile: options?.profile ?? CONFIRMATION_FIXTURE_PROFILE,
    compositionSequence: options?.sequence ?? 1,
    outDir,
  });
};

const freshTarget = async (): Promise<{ installationPath: string; receiptDir: string }> => {
  const base = await mkdtemp(path.join(scratch, "target-"));
  return { installationPath: path.join(base, "installation"), receiptDir: path.join(base, "user-config") };
};

const QUALIFICATION = { disposableRepositoryIds: ["disposable-skeleton"] } as const;
const FIXTURE_INSTALL = {
  qualification: QUALIFICATION,
  assertionProvider: { sourceKind: "qualification-fixture" },
} as const;

const installFresh = async () => {
  const target = await freshTarget();
  const installed = await installComposition({ packedDir, ...target, ...FIXTURE_INSTALL });
  expect(installed.ok, JSON.stringify(installed)).toBe(true);
  if (!installed.ok) throw new Error("unreachable");
  return { ...target, installed };
};

/** Simulates the operator's maintenance-lane trust-store edit (owned by a later unit). */
const editTrustStore = (installationPath: string, edit: (state: Record<string, unknown>) => void): void => {
  const storePath = trustStorePathFor(installationPath);
  const state = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
  edit(state);
  writeFileSync(storePath, JSON.stringify(state), { mode: 0o600 });
};

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "substrate-installer-"));
  const packed = await pack();
  expect(packed.ok, JSON.stringify(packed)).toBe(true);
  if (!packed.ok) throw new Error("unreachable");
  packedDir = packed.packedDir;
  generationDigest = packed.generationDigest;
}, 120_000);

afterAll(() => {
  restoreWritable(scratch);
  rmSync(scratch, { recursive: true, force: true });
});

describe("packing", () => {
  it("is deterministic: packing the same checkout twice yields the same generation digest and manifest bytes", async () => {
    const again = await pack();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.generationDigest).toBe(generationDigest);
    expect(readFileSync(again.manifestPath, "utf8")).toBe(
      readFileSync(path.join(packedDir, "composition-manifest.json"), "utf8"),
    );
  });

  it("rejects a skills archive whose digest is not the pinned identity", async () => {
    const wrong = await pack({ skillsArchive: path.join(FIXTURES, "agent-skills-core-v1.zip") });
    expect(codesOf(wrong)).toContain("skills_archive_digest_mismatch");
  });

  it("leaves unrelated repository bytes unchanged", async () => {
    const status = () =>
      execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], {
        encoding: "utf8",
      });
    const before = status();
    const packed = await pack({ sequence: 7 });
    expect(packed.ok).toBe(true);
    expect(status()).toBe(before);
  });
});

describe("genuinely-first install", () => {
  it("installs, activates, writes the receipt, and mints the registering-installation identity", async () => {
    const { installationPath, receiptDir, installed } = await installFresh();

    expect(installed.firstInstall).toBe(true);
    expect(installed.generationDigest).toBe(generationDigest);
    expect(installed.installationId).toMatch(SPINE_ID);

    // The receipt lives in the user-configuration location, keyed to the
    // installation path, with owner-only protections.
    const receiptPath = receiptPathFor(receiptDir, installationPath);
    expect(receiptPath).toContain(sha256Hex(installationPath));
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    expect(receipt["installationPath"]).toBe(installationPath);
    expect(receipt["installationId"]).toBe(installed.installationId);
    expect(receipt["installationProfile"]).toBe(CONFIRMATION_FIXTURE_PROFILE);
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);

    // The trust store carries owner-only protections from the first
    // install, initializes epoch zero, and pins the installed manifest.
    const storePath = trustStorePathFor(installationPath);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(storePath)).mode & 0o777).toBe(0o700);
    const state = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
    expect(state["installationId"]).toBe(installed.installationId);
    expect(state["pinnedManifestDigest"]).toBe(generationDigest);
    expect(state["acceptedGenerationDigests"]).toEqual([generationDigest]);
    expect(state["revokedGenerationDigests"]).toEqual([]);
    expect(state["revocationEpoch"]).toBe(0);
    expect(state["highWaterMark"]).toBe(1);

    // Activated for new intake.
    const active = await resolveActiveGeneration(installationPath);
    expect(active.ok).toBe(true);
    if (active.ok) expect(active.generationDigest).toBe(generationDigest);

    // The generation root is read-only and addressable by digest.
    const root = installed.root;
    expect(root).toContain(generationDigest);
    expect(statSync(root).mode & 0o200).toBe(0);
    const manifestFile = path.join(root, "composition-manifest.json");
    expect(statSync(manifestFile).mode & 0o777).toBe(0o444);
    expect(() => writeFileSync(manifestFile, "tamper")).toThrow();
  });

  it("populates both registration members of delivery.registered", async () => {
    const { installationPath, receiptDir } = await installFresh();
    const binding = await registrationBinding({ installationPath, receiptDir });
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.registeringInstallationId).toMatch(SPINE_ID);
    expect(binding.activeCompositionProfile).toBe(CONFIRMATION_FIXTURE_PROFILE);

    const entry = {
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: "delivery-1",
      expectedRevision: 0,
      idempotencyKey: "key-1",
      kind: "delivery.registered",
      payload: {
        contractDigest: "c".repeat(64),
        intakeId: "intake-1",
        confirmationNonce: "nonce-1",
        activeCompositionProfile: binding.activeCompositionProfile,
        registeringInstallationId: binding.registeringInstallationId,
      },
    };
    expect(validateJournalEntry(entry)).toEqual({ ok: true });
    const reduced = reduceDeliveryJournal([entry]);
    expect(reduced.ok).toBe(true);
  });
});

describe("install rejections", () => {
  it("rejects a packed composition whose bytes do not match the manifest closure", async () => {
    const tampered = await mkdtemp(path.join(scratch, "tampered-"));
    cpSync(packedDir, tampered, { recursive: true });
    writeFileSync(path.join(tampered, "harness", "NOTICE"), "tampered bytes\n");
    const target = await freshTarget();
    const installed = await installComposition({ packedDir: tampered, ...target, ...FIXTURE_INSTALL });
    expect(codesOf(installed)).toContain("closure_digest_mismatch");
  });

  it("fails closed on a symlink — neither digest-bound nor silently dropped", async () => {
    const linked = await mkdtemp(path.join(scratch, "linked-"));
    cpSync(packedDir, linked, { recursive: true });
    symlinkSync(path.join(linked, "harness", "NOTICE"), path.join(linked, "harness", "NOTICE.link"));
    const target = await freshTarget();
    const installed = await installComposition({ packedDir: linked, ...target, ...FIXTURE_INSTALL });
    expect(codesOf(installed)).toContain("unsupported_archive_entry");
  });

  it("rejects an unlisted hidden file — the closure walk skips nothing", async () => {
    const smuggled = await mkdtemp(path.join(scratch, "smuggled-"));
    cpSync(packedDir, smuggled, { recursive: true });
    writeFileSync(path.join(smuggled, "harness", ".rider"), "unbound bytes\n");
    const target = await freshTarget();
    const installed = await installComposition({ packedDir: smuggled, ...target, ...FIXTURE_INSTALL });
    expect(codesOf(installed)).toContain("closure_digest_mismatch");
  });

  it("rejects a composition profile that does not match the installation's receipt-recorded profile", async () => {
    const { installationPath, receiptDir } = await installFresh();
    const production = await pack({ profile: "production", sequence: 2 });
    expect(production.ok).toBe(true);
    if (!production.ok) return;
    const installed = await installComposition({ packedDir: production.packedDir, installationPath, receiptDir });
    expect(codesOf(installed)).toContain("composition_profile_mismatch");
  });

  it("routes any different-generation adopt to the update lane — the install lane only reinstalls the exact pin", async () => {
    const advanced = await pack({ sequence: 5 });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const target = await freshTarget();
    const first = await installComposition({ packedDir: advanced.packedDir, ...target, ...FIXTURE_INSTALL });
    expect(first.ok).toBe(true);

    const older = await pack({ sequence: 4 });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    const sneak = await installComposition({ packedDir: older.packedDir, ...target, ...FIXTURE_INSTALL });
    expect(codesOf(sneak)).toContain("update_lane_required");
  });

  it("refuses a fixture-declaring manifest without the explicit qualification flag — install and reinstall alike", async () => {
    const fresh = await freshTarget();
    const unflaggedFresh = await installComposition({ packedDir, ...fresh });
    expect(codesOf(unflaggedFresh)).toContain("qualification_flag_required");

    const { installationPath, receiptDir } = await installFresh();
    const unflaggedReinstall = await installComposition({ packedDir, installationPath, receiptDir });
    expect(codesOf(unflaggedReinstall)).toContain("qualification_flag_required");
  });

  it("refuses the qualification flag on a production manifest — flag and active profile can never disagree", async () => {
    const production = await pack({ profile: "production", sequence: 1 });
    expect(production.ok).toBe(true);
    if (!production.ok) return;
    const target = await freshTarget();
    const flagged = await installComposition({ packedDir: production.packedDir, ...target, ...FIXTURE_INSTALL });
    expect(codesOf(flagged)).toContain("qualification_flag_refused");
  });

  it("records the disposable-repository set in the receipt and resolves it through the registration binding", async () => {
    const { installationPath, receiptDir } = await installFresh();
    const receipt = JSON.parse(readFileSync(receiptPathFor(receiptDir, installationPath), "utf8")) as Record<string, unknown>;
    expect(receipt["disposableRepositoryIds"]).toEqual(["disposable-skeleton"]);
    const binding = await registrationBinding({ installationPath, receiptDir });
    expect(binding.ok).toBe(true);
    if (binding.ok) expect(binding.disposableRepositoryIds).toEqual(["disposable-skeleton"]);
  });

  it("fails closed on a reinstall over surviving artifacts with a missing or corrupt store or receipt", async () => {
    // Missing store, surviving generation roots and receipt.
    const survivorsMissingStore = await installFresh();
    rmSync(trustStorePathFor(survivorsMissingStore.installationPath), { force: true });
    const overMissingStore = await installComposition({
      packedDir,
      installationPath: survivorsMissingStore.installationPath,
      receiptDir: survivorsMissingStore.receiptDir,
      ...FIXTURE_INSTALL,
    });
    expect(codesOf(overMissingStore)).toContain("prior_installation_artifacts");

    // Missing receipt, surviving store and generation roots.
    const survivorsMissingReceipt = await installFresh();
    rmSync(receiptPathFor(survivorsMissingReceipt.receiptDir, survivorsMissingReceipt.installationPath), {
      force: true,
    });
    const overMissingReceipt = await installComposition({
      packedDir,
      installationPath: survivorsMissingReceipt.installationPath,
      receiptDir: survivorsMissingReceipt.receiptDir,
      ...FIXTURE_INSTALL,
    });
    expect(codesOf(overMissingReceipt)).toContain("prior_installation_artifacts");

    // Corrupt store, everything else intact.
    const survivorsCorrupt = await installFresh();
    writeFileSync(trustStorePathFor(survivorsCorrupt.installationPath), "corrupt {", { mode: 0o600 });
    const overCorrupt = await installComposition({
      packedDir,
      installationPath: survivorsCorrupt.installationPath,
      receiptDir: survivorsCorrupt.receiptDir,
      ...FIXTURE_INSTALL,
    });
    expect(codesOf(overCorrupt)).toContain("prior_installation_artifacts");
  });
});

describe("pinned-root loading", () => {
  it("reloads the exact installed root by digest", async () => {
    const { installationPath } = await installFresh();
    const loaded = await loadPinnedGeneration({ installationPath, generationDigest });
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (loaded.ok) expect(loaded.manifest["compositionProfile"]).toBe(CONFIRMATION_FIXTURE_PROFILE);
  });

  it("is unaffected by active-pointer changes: the pinned root's bytes and eligibility do not follow the pointer", async () => {
    const { installationPath, installed } = await installFresh();
    const rootBytesBefore = readFileSync(path.join(installed.root, "composition-manifest.json"), "utf8");

    // Something flips the repository-global pointer out from under the pin.
    const pointerPath = path.join(installationPath, "pointers", "active.json");
    chmodSync(pointerPath, 0o600);
    writeFileSync(pointerPath, JSON.stringify({ spec: "active-pointer/1", generationDigest: "f".repeat(64) }));

    const loaded = await loadPinnedGeneration({ installationPath, generationDigest });
    expect(loaded.ok).toBe(true);
    expect(readFileSync(path.join(installed.root, "composition-manifest.json"), "utf8")).toBe(rootBytesBefore);
  });

  it("blocks on a missing pinned root", async () => {
    const { installationPath } = await installFresh();
    const missing = await loadPinnedGeneration({ installationPath, generationDigest: "d".repeat(64) });
    expect(codesOf(missing)).toContain("missing_generation");
  });

  it("blocks on an empty pinned root", async () => {
    const { installationPath } = await installFresh();
    const empty = "e".repeat(64);
    mkdirSync(path.join(installationPath, "generations", empty), { recursive: true });
    const loaded = await loadPinnedGeneration({ installationPath, generationDigest: empty });
    expect(codesOf(loaded)).toContain("missing_generation");
  });

  it("rejects a source checkout posing as an installed generation", async () => {
    const { installationPath } = await installFresh();
    const impostor = "1".repeat(64);
    const impostorRoot = path.join(installationPath, "generations", impostor);
    mkdirSync(impostorRoot, { recursive: true });
    cpSync(path.join(REPO_ROOT, "packages", "kernel", "package.json"), path.join(impostorRoot, "package.json"));
    const loaded = await loadPinnedGeneration({ installationPath, generationDigest: impostor });
    expect(codesOf(loaded)).toContain("not_an_installed_generation");
  });
});

describe("the mutation-lane trust predicate", () => {
  it("passes for the installed, pinned, unrevoked generation", async () => {
    const { installationPath } = await installFresh();
    expect(await checkMutationLane({ installationPath, generationDigest })).toEqual({ ok: true });
  });

  it("blocks a revoked generation, and the pinned-root load blocks with it", async () => {
    const { installationPath } = await installFresh();
    editTrustStore(installationPath, (state) => {
      state["revokedGenerationDigests"] = [generationDigest];
      state["revocationEpoch"] = 1;
    });
    expect(codesOf(await checkMutationLane({ installationPath, generationDigest }))).toContain("generation_revoked");
    expect(codesOf(await loadPinnedGeneration({ installationPath, generationDigest }))).toContain(
      "generation_revoked",
    );
  });

  it("blocks when the trust state is absent", async () => {
    const { installationPath } = await installFresh();
    rmSync(trustStorePathFor(installationPath), { force: true });
    expect(codesOf(await checkMutationLane({ installationPath, generationDigest }))).toContain("trust_state_absent");
  });

  it("blocks when the trust state is corrupt", async () => {
    const { installationPath } = await installFresh();
    writeFileSync(trustStorePathFor(installationPath), "{ corrupt", { mode: 0o600 });
    expect(codesOf(await checkMutationLane({ installationPath, generationDigest }))).toContain("trust_state_corrupt");
  });

  it("ignores planted repository-local trust files in both directions", async () => {
    const plantedRepo = await mkdtemp(path.join(scratch, "planted-repo-"));
    mkdirSync(path.join(plantedRepo, "trust"), { recursive: true });

    const previousCwd = process.cwd();
    try {
      // Direction one: the installation store revokes; a planted file claims
      // an empty revocation list and a rolled-back epoch.
      const revoked = await installFresh();
      editTrustStore(revoked.installationPath, (state) => {
        state["revokedGenerationDigests"] = [generationDigest];
        state["revocationEpoch"] = 3;
      });
      const planted = {
        spec: "product-trust-state/1",
        installationId: "planted",
        pinnedManifestDigest: generationDigest,
        acceptedGenerationDigests: [generationDigest],
        revokedGenerationDigests: [],
        revocationEpoch: 0,
        highWaterMark: 0,
      };
      writeFileSync(path.join(plantedRepo, "trust", "product-trust.json"), JSON.stringify(planted));
      writeFileSync(path.join(plantedRepo, "product-trust.json"), JSON.stringify(planted));
      process.chdir(plantedRepo);
      expect(
        codesOf(await checkMutationLane({ installationPath: revoked.installationPath, generationDigest })),
      ).toContain("generation_revoked");

      // Direction two: the installation store is eligible; a planted file
      // claims the generation is revoked.
      const eligible = await installFresh();
      const hostile = { ...planted, revokedGenerationDigests: [generationDigest], revocationEpoch: 9 };
      writeFileSync(path.join(plantedRepo, "trust", "product-trust.json"), JSON.stringify(hostile));
      writeFileSync(path.join(plantedRepo, "product-trust.json"), JSON.stringify(hostile));
      process.chdir(plantedRepo);
      expect(await checkMutationLane({ installationPath: eligible.installationPath, generationDigest })).toEqual({
        ok: true,
      });
    } finally {
      process.chdir(previousCwd);
    }
  });
});
