/**
 * The cross-platform install/update/rollback lifecycle over the composition
 * substrate: activation preflights, journaled update recovery, retained
 * generations with garbage collection of unreferenced ones, maintenance-lane
 * trust-state operations under the sensitive-approval assertion, and the
 * installer repair that restores a lost assertion source.
 *
 * Every installation target is a fresh temp directory; the operator's live
 * configuration is never touched. These tests were written RED, before
 * `lifecycle.ts` existed.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmodSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductTrustState } from "../spine/composition.ts";
import { CONFIRMATION_FIXTURE_PROFILE } from "./manifest.ts";
import {
  installComposition,
  loadPinnedGeneration,
  packComposition,
  receiptPathFor,
  resolveActiveGeneration,
  trustStorePathFor,
  type InstallCompositionInput,
} from "./installer.ts";
import {
  assertionProviderConfigPathFor,
  createQualificationFixtureAssertionSource,
  type AssertionSourcePort,
} from "./assertion-source.ts";
import {
  garbageCollectGenerations,
  inspectInstallation,
  maintainTrustState,
  recoverInterruptedMaintenance,
  repairInstallation,
  rollbackComposition,
  updateComposition,
} from "./lifecycle.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const FIXTURES = path.join(REPO_ROOT, "qualifications", "fixtures");
const SKILLS_ARCHIVE = path.join(FIXTURES, "agent-skills-core-v1-composition.zip");
const SKILLS_METADATA = path.join(FIXTURES, "agent-skills-core-v1-composition.metadata.json");

const NOW = "2026-08-30T12:00:00Z";
const QUALIFICATION = { disposableRepositoryIds: ["disposable-skeleton"] };

let scratch: string;
/** Three packed compositions of ascending sequence: one per generation. */
let packed: Record<1 | 2 | 3, { packedDir: string; generationDigest: string }>;

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
    if (entry.isDirectory()) restoreWritable(path.join(dir, entry.name));
  }
};

const codesOf = (result: { ok: true } | { ok: false; blockers: readonly { code: string }[] }): string[] =>
  result.ok ? [] : result.blockers.map((blocker) => blocker.code);

const fixtureSource = (options?: Parameters<typeof createQualificationFixtureAssertionSource>[0]): AssertionSourcePort =>
  createQualificationFixtureAssertionSource(options);

interface Target {
  readonly installationPath: string;
  readonly receiptDir: string;
}

const freshTarget = async (): Promise<Target> => {
  const base = await mkdtemp(path.join(scratch, "target-"));
  return { installationPath: path.join(base, "installation"), receiptDir: path.join(base, "user-config") };
};

const installGen1 = async (extra?: Partial<InstallCompositionInput>): Promise<Target> => {
  const target = await freshTarget();
  const installed = await installComposition({
    packedDir: packed[1].packedDir,
    ...target,
    qualification: QUALIFICATION,
    assertionProvider: { sourceKind: "qualification-fixture" },
    ...extra,
  });
  expect(installed.ok, JSON.stringify(installed)).toBe(true);
  return target;
};

const updateTo = (target: Target, generation: 2 | 3, extra?: Record<string, unknown>) =>
  updateComposition({
    packedDir: packed[generation].packedDir,
    ...target,
    qualification: QUALIFICATION,
    assertionSource: fixtureSource(),
    now: NOW,
    ...extra,
  });

const trustStateOf = (target: Target): ProductTrustState =>
  JSON.parse(readFileSync(trustStorePathFor(target.installationPath), "utf8")) as ProductTrustState;

const journalEntriesOf = (target: Target): Record<string, unknown>[] =>
  readFileSync(path.join(target.installationPath, "journal", "maintenance.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const maintenanceActions = (target: Target): { action: string; phase: string }[] =>
  journalEntriesOf(target).map((entry) => {
    const payload = entry["payload"] as Record<string, unknown>;
    return { action: payload["action"] as string, phase: payload["phase"] as string };
  });

const activeOf = async (target: Target): Promise<string | undefined> => {
  const active = await resolveActiveGeneration(target.installationPath);
  return active.ok ? active.generationDigest : undefined;
};

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "substrate-lifecycle-"));
  const packOne = async (sequence: 1 | 2 | 3) => {
    const outDir = await mkdtemp(path.join(scratch, `pack${sequence}-`));
    const result = await packComposition({
      sourceRoot: REPO_ROOT,
      skillsArchivePath: SKILLS_ARCHIVE,
      skillsMetadataPath: SKILLS_METADATA,
      compositionProfile: CONFIRMATION_FIXTURE_PROFILE,
      compositionSequence: sequence,
      outDir,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    return { packedDir: result.packedDir, generationDigest: result.generationDigest };
  };
  packed = { 1: await packOne(1), 2: await packOne(2), 3: await packOne(3) };
}, 240_000);

afterAll(() => {
  restoreWritable(scratch);
  rmSync(scratch, { recursive: true, force: true });
});

describe("activation preflights", () => {
  it("refuses an unsupported Node runtime before any mutation", async () => {
    const target = await installGen1();
    const before = trustStateOf(target);
    const result = await updateTo(target, 2, { preflight: { nodeVersion: "v20.11.0" } });
    expect(codesOf(result)).toContain("preflight_failed");
    expect(trustStateOf(target)).toEqual(before);
    expect(await activeOf(target)).toBe(packed[1].generationDigest);
  });

  it("refuses a missing or unsupported Python runtime before any mutation", async () => {
    const target = await installGen1();
    expect(codesOf(await updateTo(target, 2, { preflight: { pythonVersion: undefined } }))).toContain("preflight_failed");
    expect(codesOf(await updateTo(target, 2, { preflight: { pythonVersion: "3.9.2" } }))).toContain("preflight_failed");
  });

  it("refuses an unsupported platform", async () => {
    const target = await installGen1();
    expect(codesOf(await updateTo(target, 2, { preflight: { platform: "sunos" } }))).toContain("preflight_failed");
  });

  it("fails install preflight on a platform without any interactive authentication context", async () => {
    const target = await freshTarget();
    const unavailable: AssertionSourcePort = {
      probe: async () => ({ available: false, detail: "no interactive authentication context on this platform" }),
      evaluate: async () => ({ ok: false, reason: "unavailable" }),
    };
    const installed = await installComposition({
      packedDir: packed[1].packedDir,
      ...target,
      qualification: QUALIFICATION,
      assertionProvider: { sourceKind: "qualification-fixture" },
      assertionSource: unavailable,
    });
    expect(codesOf(installed)).toContain("preflight_failed");
    expect(existsSync(trustStorePathFor(target.installationPath))).toBe(false);
  });
});

describe("update", () => {
  it("validates the complete composition before mutation and retains the prior generation", async () => {
    const target = await installGen1();
    const result = await updateTo(target, 2);
    expect(result.ok, JSON.stringify(result)).toBe(true);

    // Activation moved; the prior generation is retained for
    // source-independent rollback and stays execution-eligible for
    // deliveries pinned to it.
    expect(await activeOf(target)).toBe(packed[2].generationDigest);
    const state = trustStateOf(target);
    expect(state.pinnedManifestDigest).toBe(packed[2].generationDigest);
    expect(state.highWaterMark).toBe(2);
    expect(state.acceptedGenerationDigests).toContain(packed[1].generationDigest);
    expect(state.acceptedGenerationDigests).toContain(packed[2].generationDigest);
    const priorLoad = await loadPinnedGeneration({
      installationPath: target.installationPath,
      generationDigest: packed[1].generationDigest,
    });
    expect(priorLoad.ok, JSON.stringify(priorLoad)).toBe(true);

    // The rollback pointer names the prior generation.
    const rollback = JSON.parse(
      readFileSync(path.join(target.installationPath, "pointers", "rollback.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(rollback["generationDigest"]).toBe(packed[1].generationDigest);

    // The journal carries the phased action under its consumed assertion.
    const actions = maintenanceActions(target);
    expect(actions).toContainEqual({ action: "update", phase: "started" });
    expect(actions).toContainEqual({ action: "update", phase: "completed" });
    const started = journalEntriesOf(target).find((entry) => {
      const payload = entry["payload"] as Record<string, unknown>;
      return payload["action"] === "update" && payload["phase"] === "started";
    });
    const assertion = (started?.["payload"] as Record<string, unknown>)["assertion"] as Record<string, unknown>;
    expect(assertion["assertionClass"]).toBe("maintenance-lane");
    expect(assertion["targetGenerationDigest"]).toBe(packed[2].generationDigest);
  });

  it("rejects a tampered packed composition before mutation", async () => {
    const target = await installGen1();
    const tamperedDir = await mkdtemp(path.join(scratch, "tampered-update-"));
    const { cpSync } = await import("node:fs");
    cpSync(packed[2].packedDir, tamperedDir, { recursive: true });
    writeFileSync(path.join(tamperedDir, "harness", "NOTICE"), "tampered\n");
    const result = await updateComposition({
      packedDir: tamperedDir,
      ...target,
      qualification: QUALIFICATION,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(result)).toContain("closure_digest_mismatch");
    expect(await activeOf(target)).toBe(packed[1].generationDigest);
  });

  it("rejects a forbidden downgrade below the persisted high-water mark", async () => {
    const target = await installGen1();
    expect((await updateTo(target, 3)).ok).toBe(true);
    const downgrade = await updateComposition({
      packedDir: packed[2].packedDir,
      ...target,
      qualification: QUALIFICATION,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(downgrade)).toContain("downgrade_rejected");
    expect(await activeOf(target)).toBe(packed[3].generationDigest);
  });

  it("refuses an unflagged update over a qualification installation", async () => {
    const target = await installGen1();
    const result = await updateComposition({
      packedDir: packed[2].packedDir,
      ...target,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(result)).toContain("qualification_flag_required");
  });

  it("refuses a revoked target generation", async () => {
    const target = await installGen1();
    const revoked = await maintainTrustState({
      ...target,
      operation: "revoke",
      generationDigest: packed[2].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true);
    expect(codesOf(await updateTo(target, 2))).toContain("generation_revoked");
  });
});

describe("stale and replayed maintenance approvals", () => {
  it("rejects a refused evaluation with no mutation", async () => {
    const target = await installGen1();
    const result = await updateTo(target, 2, { assertionSource: fixtureSource({ decide: () => "refuse" }) });
    expect(codesOf(result)).toContain("assertion_refused");
    expect(await activeOf(target)).toBe(packed[1].generationDigest);
  });

  it("rejects a stale evaluation — an expired assertion is a cached credential, treated as invalid", async () => {
    const target = await installGen1();
    const result = await updateTo(target, 2, {
      assertionSource: fixtureSource({ expiry: "2026-08-30T11:00:00Z" }),
    });
    expect(codesOf(result)).toContain("assertion_stale");
  });

  it("rejects a replayed nonce — one fresh interactive evaluation per single-use nonce", async () => {
    const target = await installGen1();
    const replaying = fixtureSource({ nonce: () => "nonce-replayed" });
    expect((await updateTo(target, 2, { assertionSource: replaying })).ok).toBe(true);
    const replay = await rollbackComposition({
      ...target,
      targetGenerationDigest: packed[1].generationDigest,
      assertionSource: replaying,
      now: NOW,
    });
    expect(codesOf(replay)).toContain("assertion_replayed");
  });
});

describe("journaled update recovery", () => {
  const phases = ["started", "root-materialized", "trust-state-written", "rollback-pointer-written"] as const;

  for (const failAfter of phases) {
    it(`recovers an update interrupted after ${failAfter}`, async () => {
      const target = await installGen1();
      await expect(
        updateTo(target, 2, {
          hooks: {
            onPhase: (phase: string) => {
              if (phase === failAfter) throw new Error(`injected fault after ${failAfter}`);
            },
          },
        }),
      ).rejects.toThrow("injected fault");

      // Until recovery runs, the interrupted journal blocks further
      // maintenance.
      const blockedRollback = await rollbackComposition({
        ...target,
        targetGenerationDigest: packed[1].generationDigest,
        assertionSource: fixtureSource(),
        now: NOW,
      });
      expect(codesOf(blockedRollback)).toContain("maintenance_in_progress");

      const recovered = await recoverInterruptedMaintenance({ installationPath: target.installationPath });
      expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
      if (recovered.ok) expect(recovered.recovered).toBe(true);
      expect(maintenanceActions(target)).toContainEqual({ action: "update", phase: "recovered" });

      // Whatever direction recovery took, the installation is consistent:
      // the active pointer and the trust pin agree, and the active
      // generation loads.
      const state = trustStateOf(target);
      const active = await activeOf(target);
      expect(active).toBe(state.pinnedManifestDigest);
      const load = await loadPinnedGeneration({
        installationPath: target.installationPath,
        generationDigest: state.pinnedManifestDigest,
      });
      expect(load.ok, JSON.stringify(load)).toBe(true);

      // A crash before the trust write rolls back to the prior generation; a
      // crash after it rolls forward to the target.
      const expected =
        failAfter === "started" || failAfter === "root-materialized"
          ? packed[1].generationDigest
          : packed[2].generationDigest;
      expect(active).toBe(expected);

      // The lane reopens: a retried update reaches the target generation —
      // a real update after a rolled-back recovery, a no-op after a
      // rolled-forward one.
      const retried = await updateTo(target, 2);
      expect(retried.ok, JSON.stringify(retried)).toBe(true);
      if (retried.ok) expect(retried.noOp).toBe(active === packed[2].generationDigest);
      expect(await activeOf(target)).toBe(packed[2].generationDigest);
    });
  }

  it("is not masked by an installer repair run while the interruption stands", async () => {
    const target = await installGen1();
    await expect(
      updateTo(target, 2, {
        hooks: {
          onPhase: (phase: string) => {
            if (phase === "trust-state-written") throw new Error("injected fault after trust-state-written");
          },
        },
      }),
    ).rejects.toThrow("injected fault");

    // The documented source-loss path: the assertion source is lost while
    // the interruption stands, and the operator performs the repair.
    rmSync(assertionProviderConfigPathFor(target.installationPath));
    const repaired = await repairInstallation({
      ...target,
      interactive: true,
      source: { sourceKind: "qualification-fixture", port: fixtureSource() },
    });
    expect(repaired.ok, JSON.stringify(repaired)).toBe(true);

    // The repair's journal record must NOT erase the unrecovered
    // interruption: the lane stays blocked until recovery reconciles it.
    const blocked = await rollbackComposition({
      ...target,
      targetGenerationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(blocked)).toContain("maintenance_in_progress");
    const recovered = await recoverInterruptedMaintenance({ installationPath: target.installationPath });
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
    if (recovered.ok) expect(recovered.recovered).toBe(true);
    expect(await activeOf(target)).toBe(trustStateOf(target).pinnedManifestDigest);
  });

  it("reports nothing to recover on a healthy installation", async () => {
    const target = await installGen1();
    const recovered = await recoverInterruptedMaintenance({ installationPath: target.installationPath });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.recovered).toBe(false);
  });
});

describe("rollback", () => {
  it("rolls the pointer back to a retained, previously accepted, non-revoked generation without advancing the mark", async () => {
    const target = await installGen1();
    expect((await updateTo(target, 2)).ok).toBe(true);
    expect((await updateTo(target, 3)).ok).toBe(true);
    const result = await rollbackComposition({
      ...target,
      targetGenerationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await activeOf(target)).toBe(packed[1].generationDigest);
    const state = trustStateOf(target);
    expect(state.pinnedManifestDigest).toBe(packed[1].generationDigest);
    // Rollback neither advances nor violates the high-water mark.
    expect(state.highWaterMark).toBe(3);
    expect(maintenanceActions(target)).toContainEqual({ action: "rollback", phase: "completed" });

    // The mark still forbids activating any OTHER below-mark archive through
    // the update lane; the explicit rollback was the sanctioned path.
    const sneak = await updateComposition({
      packedDir: packed[2].packedDir,
      ...target,
      qualification: QUALIFICATION,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(sneak)).toContain("downgrade_rejected");
  });

  it("rejects a rollback target that was never accepted", async () => {
    const target = await installGen1();
    const result = await rollbackComposition({
      ...target,
      targetGenerationDigest: "f".repeat(64),
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(result)).toContain("rollback_target_not_accepted");
  });

  it("rejects a formerly valid but now-revoked rollback target", async () => {
    const target = await installGen1();
    expect((await updateTo(target, 2)).ok).toBe(true);
    expect(
      (
        await maintainTrustState({
          ...target,
          operation: "revoke",
          generationDigest: packed[1].generationDigest,
          assertionSource: fixtureSource(),
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    const result = await rollbackComposition({
      ...target,
      targetGenerationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(result)).toContain("generation_revoked");
  });
});

describe("trust-state maintenance operations", () => {
  it("revokes and un-revokes with a monotonically advancing revocation epoch", async () => {
    const target = await installGen1();
    expect((await updateTo(target, 2)).ok).toBe(true);

    const revoked = await maintainTrustState({
      ...target,
      operation: "revoke",
      generationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(revoked.ok).toBe(true);
    let state = trustStateOf(target);
    expect(state.revokedGenerationDigests).toContain(packed[1].generationDigest);
    expect(state.revocationEpoch).toBe(1);

    // Revoked bytes remain retained for audit but are never execution-eligible.
    expect(existsSync(path.join(target.installationPath, "generations", packed[1].generationDigest))).toBe(true);
    const load = await loadPinnedGeneration({
      installationPath: target.installationPath,
      generationDigest: packed[1].generationDigest,
    });
    expect(codesOf(load)).toContain("generation_revoked");

    // Un-revocation restores eligibility for new preparation and advances the
    // epoch again — the epoch counts changes, it never rewinds.
    const unrevoked = await maintainTrustState({
      ...target,
      operation: "unrevoke",
      generationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(unrevoked.ok).toBe(true);
    state = trustStateOf(target);
    expect(state.revokedGenerationDigests).not.toContain(packed[1].generationDigest);
    expect(state.revocationEpoch).toBe(2);
    expect(
      (
        await loadPinnedGeneration({
          installationPath: target.installationPath,
          generationDigest: packed[1].generationDigest,
        })
      ).ok,
    ).toBe(true);
  });

  it("re-pins to an accepted generation and refuses an unaccepted one", async () => {
    const target = await installGen1();
    expect((await updateTo(target, 2)).ok).toBe(true);
    const pinned = await maintainTrustState({
      ...target,
      operation: "pin",
      generationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(pinned.ok).toBe(true);
    expect(trustStateOf(target).pinnedManifestDigest).toBe(packed[1].generationDigest);
    const unaccepted = await maintainTrustState({
      ...target,
      operation: "pin",
      generationDigest: "e".repeat(64),
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(unaccepted)).toContain("rollback_target_not_accepted");
  });

  it("refuses to pin an accepted generation whose bytes were collected — the pin lands only on retained roots", async () => {
    const target = await installGen1();
    expect((await updateTo(target, 2)).ok).toBe(true);
    expect((await updateTo(target, 3)).ok).toBe(true);
    const collected = await garbageCollectGenerations({
      installationPath: target.installationPath,
      referencedGenerationDigests: [],
    });
    expect(collected.ok).toBe(true);
    if (collected.ok) expect(collected.removed).toEqual([packed[1].generationDigest]);
    const pinned = await maintainTrustState({
      ...target,
      operation: "pin",
      generationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(pinned)).toContain("missing_generation");
  });

  it("advances the high-water mark forward only; an epoch or mark rollback rejects", async () => {
    const target = await installGen1();
    const advanced = await maintainTrustState({
      ...target,
      operation: "advance-high-water-mark",
      highWaterMark: 9,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(advanced.ok, JSON.stringify(advanced)).toBe(true);
    expect(trustStateOf(target).highWaterMark).toBe(9);
    const rollback = await maintainTrustState({
      ...target,
      operation: "advance-high-water-mark",
      highWaterMark: 3,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(rollback)).toContain("epoch_rollback_rejected");
    expect(trustStateOf(target).highWaterMark).toBe(9);
  });
});

describe("referenced-generation retention and garbage collection", () => {
  it("retains the active pointer, rollback pointer, referenced, and revoked generations; removes only unreferenced ones", async () => {
    const target = await installGen1();
    expect((await updateTo(target, 2)).ok).toBe(true);
    expect((await updateTo(target, 3)).ok).toBe(true);
    const rootOf = (generation: 1 | 2 | 3) =>
      path.join(target.installationPath, "generations", packed[generation].generationDigest);

    // Two updates while an older delivery is blocked: the older delivery's
    // pinned generation is referenced and must be retained through both.
    const retainAll = await garbageCollectGenerations({
      installationPath: target.installationPath,
      referencedGenerationDigests: [packed[1].generationDigest],
    });
    expect(retainAll.ok).toBe(true);
    if (retainAll.ok) expect(retainAll.removed).toEqual([]);
    expect(existsSync(rootOf(1))).toBe(true);
    expect(existsSync(rootOf(2))).toBe(true); // rollback pointer
    expect(existsSync(rootOf(3))).toBe(true); // active pointer
    expect(
      (
        await loadPinnedGeneration({
          installationPath: target.installationPath,
          generationDigest: packed[1].generationDigest,
        })
      ).ok,
    ).toBe(true);

    // Unreferenced now — removable.
    const collected = await garbageCollectGenerations({
      installationPath: target.installationPath,
      referencedGenerationDigests: [],
    });
    expect(collected.ok).toBe(true);
    if (collected.ok) expect(collected.removed).toEqual([packed[1].generationDigest]);
    expect(existsSync(rootOf(1))).toBe(false);
    expect(maintenanceActions(target)).toContainEqual({ action: "garbage-collection", phase: "completed" });
  });

  it("never removes a revoked generation — revoked bytes are retained for audit", async () => {
    const target = await installGen1();
    expect((await updateTo(target, 2)).ok).toBe(true);
    expect((await updateTo(target, 3)).ok).toBe(true);
    expect(
      (
        await maintainTrustState({
          ...target,
          operation: "revoke",
          generationDigest: packed[1].generationDigest,
          assertionSource: fixtureSource(),
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    const collected = await garbageCollectGenerations({
      installationPath: target.installationPath,
      referencedGenerationDigests: [],
    });
    expect(collected.ok).toBe(true);
    if (collected.ok) expect(collected.removed).toEqual([]);
    expect(existsSync(path.join(target.installationPath, "generations", packed[1].generationDigest))).toBe(true);
  });
});

describe("assertion-source loss and installer repair", () => {
  it("fails every sensitive operation closed after source loss until an operator-performed repair restores it", async () => {
    const target = await installGen1();

    // Loss of the source: the provider configuration is gone.
    rmSync(assertionProviderConfigPathFor(target.installationPath));
    const failedUpdate = await updateTo(target, 2);
    expect(codesOf(failedUpdate)).toContain("assertion_source_unavailable");
    const failedRevoke = await maintainTrustState({
      ...target,
      operation: "revoke",
      generationDigest: packed[2].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(failedRevoke)).toContain("assertion_source_unavailable");

    // Non-interactive repair refused; the repair is the operator's own act.
    const nonInteractive = await repairInstallation({
      ...target,
      interactive: false,
      source: { sourceKind: "qualification-fixture", port: fixtureSource() },
    });
    expect(codesOf(nonInteractive)).toContain("non_interactive_refused");

    // The repair adopts and never edits the existing trust store and receipt.
    const storeBefore = readFileSync(trustStorePathFor(target.installationPath), "utf8");
    const receiptBefore = readFileSync(receiptPathFor(target.receiptDir, target.installationPath), "utf8");
    const repaired = await repairInstallation({
      ...target,
      interactive: true,
      source: { sourceKind: "qualification-fixture", port: fixtureSource() },
    });
    expect(repaired.ok, JSON.stringify(repaired)).toBe(true);
    expect(readFileSync(trustStorePathFor(target.installationPath), "utf8")).toBe(storeBefore);
    expect(readFileSync(receiptPathFor(target.receiptDir, target.installationPath), "utf8")).toBe(receiptBefore);
    expect(maintenanceActions(target)).toContainEqual({ action: "installer-repair", phase: "completed" });

    // The sensitive set is re-enabled.
    expect((await updateTo(target, 2)).ok).toBe(true);
  });

  it("refuses a repair while a working assertion source exists", async () => {
    const target = await installGen1();
    const result = await repairInstallation({
      ...target,
      interactive: true,
      source: { sourceKind: "qualification-fixture", port: fixtureSource() },
    });
    expect(codesOf(result)).toContain("repair_not_needed");
  });
});

describe("read-only installation inspection", () => {
  it("exposes internal identities without making them selectable", async () => {
    const target = await installGen1();
    expect((await updateTo(target, 2)).ok).toBe(true);
    const inspected = await inspectInstallation(target);
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.profile).toBe(CONFIRMATION_FIXTURE_PROFILE);
    expect(inspected.activeGenerationDigest).toBe(packed[2].generationDigest);
    expect(inspected.rollbackGenerationDigest).toBe(packed[1].generationDigest);
    expect(inspected.highWaterMark).toBe(2);
    expect(inspected.revocationEpoch).toBe(0);
    expect(inspected.assertionSourceKind).toBe("qualification-fixture");
    const digests = inspected.generations.map((generation) => generation.digest).sort();
    expect(digests).toEqual([packed[1].generationDigest, packed[2].generationDigest].sort());
  });
});
