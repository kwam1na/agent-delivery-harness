/**
 * The delivery-side half of the composition-lifecycle hardening, driven
 * through the facade against real installations and one disposable
 * repository:
 *
 *   - the qualification profile's use-time binding: a fixture installation
 *     registers and advances deliveries only in receipt-listed disposable
 *     repositories, and a candidate-written marker makes nothing eligible;
 *   - product-trust revocation fencing a pinned delivery into
 *     `security_blocked` at the next canonical site, and the recovery paths
 *     out: same-generation re-preparation after un-revocation, the
 *     generation-change migration, and the profile-matched rebinding
 *     migration — each consuming the security-blocked migration assertion
 *     WITHOUT re-fencing;
 *   - the refusals: a migration naming a revoked target generation, a
 *     rebinding whose target installation's profile differs from the
 *     delivery's recorded profile, stale and replayed assertions — with the
 *     delivery remaining `security_blocked` after each.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfirmationEchoAttempt, RenderedConfirmationChallenge } from "../binding/host-admission.ts";
import { CONFIRMATION_FIXTURE_PROFILE } from "../substrate/manifest.ts";
import { installComposition, packComposition } from "../substrate/installer.ts";
import { createQualificationFixtureAssertionSource } from "../substrate/assertion-source.ts";
import { maintainTrustState, updateComposition } from "../substrate/lifecycle.ts";
import { evaluateMigrationConsumption } from "./migration.ts";
import { createManagedDeliveryFacade, type ManagedDeliveryFacade } from "./managed-delivery.ts";
import {
  DISPOSABLE_CONTRACT,
  buildDisposableRepository,
  disposableHarnessConfig,
  fixtureProviderBindingCapability,
} from "./disposable-repository.fixture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const FIXTURES = path.join(REPO_ROOT, "qualifications", "fixtures");

const NOW = "2026-08-30T12:00:00Z";
const LATER = "2026-08-30T12:00:30Z";
const EXPIRY = "2026-08-31T12:00:00Z";
const REPOSITORY_ID = DISPOSABLE_CONTRACT.repository.repositoryId;

let scratch: string;
let packed: Record<1 | 2 | 3, { packedDir: string; generationDigest: string }>;
let repoDir: string;
let installationA: { installationPath: string; receiptDir: string };
let facadeA: ManagedDeliveryFacade;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const operatorEcho = (channelPath: string): ConfirmationEchoAttempt => {
  const pending = JSON.parse(readFileSync(channelPath, "utf8")) as { rendered: RenderedConfirmationChallenge };
  return {
    presentedChallenge: pending.rendered.challenge,
    presentedOnChannelId: pending.rendered.channelId,
    observedAt: NOW,
    viaModelVisibleSurface: false,
    interactive: true,
  };
};

const fixtureSource = (options?: Parameters<typeof createQualificationFixtureAssertionSource>[0]) =>
  createQualificationFixtureAssertionSource(options);

const installFixture = async (
  name: string,
  disposableRepositoryIds: readonly string[] = [REPOSITORY_ID],
): Promise<{ installationPath: string; receiptDir: string }> => {
  const installationPath = path.join(scratch, name, "installation");
  const receiptDir = path.join(scratch, name, "user-config");
  const installed = await installComposition({
    packedDir: packed[1].packedDir,
    installationPath,
    receiptDir,
    qualification: { disposableRepositoryIds: [...disposableRepositoryIds] },
    assertionProvider: { sourceKind: "qualification-fixture" },
  });
  expect(installed.ok, JSON.stringify(installed)).toBe(true);
  return { installationPath, receiptDir };
};

const facadeFor = (installation: { installationPath: string; receiptDir: string }): ManagedDeliveryFacade =>
  createManagedDeliveryFacade({
    repoDir,
    config: disposableHarnessConfig(),
    installation,
    hostVersion: "2.1.97",
  });

/** Contract handoff through the fixture confirmation channel. */
const registerDelivery = async (facade: ManagedDeliveryFacade, contractId: string): Promise<string> => {
  const presented = await facade.presentContract({
    contract: { ...DISPOSABLE_CONTRACT, contractId },
    expiry: EXPIRY,
  });
  expect(presented.ok, JSON.stringify(presented)).toBe(true);
  if (!presented.ok) throw new Error("unreachable");
  const confirmed = await facade.confirmContract({ intakeId: presented.intakeId, echo: operatorEcho(presented.channelPath) });
  expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
  if (!confirmed.ok) throw new Error("unreachable");
  return confirmed.deliveryId;
};

const journalEntriesOf = async (facade: ManagedDeliveryFacade, deliveryId: string) => {
  const journalPath = path.join(await facade.namespaceDir(), "deliveries", deliveryId, "journal.jsonl");
  return readFileSync(journalPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
};

const codesOf = (result: { ok: true } | { ok: false; blockers: readonly { code: string }[] }): string[] =>
  result.ok ? [] : result.blockers.map((blocker) => blocker.code);

const stateOf = async (facade: ManagedDeliveryFacade, deliveryId: string): Promise<string> => {
  const status = await facade.status({ deliveryId, observedAt: LATER });
  expect(status.ok, JSON.stringify(status)).toBe(true);
  if (!status.ok) throw new Error("unreachable");
  return status.status.delivery.state;
};

/** The whole typed status model, for the projection assertions below. */
const statusOf = async (facade: ManagedDeliveryFacade, deliveryId: string) => {
  const status = await facade.status({ deliveryId, observedAt: LATER });
  expect(status.ok, JSON.stringify(status)).toBe(true);
  if (!status.ok) throw new Error("unreachable");
  return status.status;
};

/** The current invocation fence as durable state reports it (0 before any bind). */
const currentFenceOf = async (facade: ManagedDeliveryFacade, deliveryId: string): Promise<number> => {
  const status = await facade.status({ deliveryId, observedAt: LATER });
  if (!status.ok) throw new Error(JSON.stringify(status));
  return status.status.delivery.fence;
};

let worktreeCounter = 0;
const bindFreshWorktree = async (facade: ManagedDeliveryFacade, deliveryId: string) => {
  worktreeCounter += 1;
  const worktreeDir = path.join(scratch, `worktree-${worktreeCounter}`);
  git(repoDir, "worktree", "add", "--quiet", "-b", `delivery-${worktreeCounter}`, worktreeDir, "main");
  return facade.bindWorkspace({
    deliveryId,
    worktreeDir,
    hostTaskId: `host-task-${worktreeCounter}`,
    observedAt: NOW,
    attestationExpiry: EXPIRY,
    providerReviewBindingCapability: fixtureProviderBindingCapability(deliveryId),
  });
};

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "security-lifecycle-"));
  const packOne = async (sequence: 1 | 2 | 3) => {
    const result = await packComposition({
      sourceRoot: REPO_ROOT,
      skillsArchivePath: path.join(FIXTURES, "agent-skills-core-v1-composition.zip"),
      skillsMetadataPath: path.join(FIXTURES, "agent-skills-core-v1-composition.metadata.json"),
      compositionProfile: CONFIRMATION_FIXTURE_PROFILE,
      compositionSequence: sequence,
      outDir: path.join(scratch, `pack-${sequence}`),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    return { packedDir: result.packedDir, generationDigest: result.generationDigest };
  };
  packed = { 1: await packOne(1), 2: await packOne(2), 3: await packOne(3) };

  const repo = buildDisposableRepository(path.join(scratch, "repo"));
  repoDir = repo.repoDir;
  installationA = await installFixture("installation-a");
  facadeA = facadeFor(installationA);
}, 240_000);

afterAll(async () => {
  try {
    execFileSync("chmod", ["-R", "u+rwX", scratch], { stdio: "ignore" });
  } catch {
    /* removal surfaces the real failure */
  }
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

describe("qualification use-time binding", () => {
  it("refuses to register a delivery in a repository outside the receipt-listed disposable set", async () => {
    const narrow = await installFixture("installation-narrow", ["some-other-repository"]);
    const facade = facadeFor(narrow);
    const presented = await facade.presentContract({ contract: DISPOSABLE_CONTRACT, expiry: EXPIRY });
    expect(codesOf(presented)).toContain("disposable_repository_refused");
  });

  it("ignores a candidate-written disposable marker — only the receipt's set makes a repository eligible", async () => {
    // A marker committed into the repository claims eligibility; the receipt
    // does not list this repository, so nothing changes.
    writeFileSync(path.join(repoDir, ".disposable-qualification"), `${REPOSITORY_ID}\n`);
    git(repoDir, "add", ".disposable-qualification");
    git(repoDir, "commit", "--quiet", "--no-gpg-sign", "-m", "candidate-written disposable marker");
    const narrow = await installFixture("installation-narrow-2", ["some-other-repository"]);
    const facade = facadeFor(narrow);
    const presented = await facade.presentContract({ contract: DISPOSABLE_CONTRACT, expiry: EXPIRY });
    expect(codesOf(presented)).toContain("disposable_repository_refused");
  });
});

describe("revocation fencing and same-generation recovery", () => {
  it("fences a pinned delivery at the next canonical site, and un-revocation re-enables new preparation only", { timeout: 120_000 }, async () => {
    const deliveryId = await registerDelivery(facadeA, "contract-revoke-1");

    const revoked = await maintainTrustState({
      ...installationA,
      operation: "revoke",
      generationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true);

    // The next mutation-capable operation is fenced; the delivery enters
    // security_blocked.
    const bound = await bindFreshWorktree(facadeA, deliveryId);
    expect(bound.ok).toBe(false);
    expect(await stateOf(facadeA, deliveryId)).toBe("security_blocked");

    // Leaving security_blocked while the generation stands revoked is
    // refused.
    const premature = await facadeA.recoverSecurityBlocked({ deliveryId, now: NOW });
    expect(premature.ok).toBe(false);
    expect(await stateOf(facadeA, deliveryId)).toBe("security_blocked");

    // Un-revocation restores execution eligibility for NEW preparation.
    const unrevoked = await maintainTrustState({
      ...installationA,
      operation: "unrevoke",
      generationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(unrevoked.ok, JSON.stringify(unrevoked)).toBe(true);
    const recovered = await facadeA.recoverSecurityBlocked({ deliveryId, now: NOW });
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.mode).toBe("re-preparation");
    expect(await stateOf(facadeA, deliveryId)).toBe("preparing");

    // Full re-preparation: the delivery binds a fresh workspace and drives on.
    const rebound = await bindFreshWorktree(facadeA, deliveryId);
    expect(rebound.ok, JSON.stringify(rebound)).toBe(true);
    expect(await stateOf(facadeA, deliveryId)).toBe("planning");
  });
});

describe("generation-change migration", () => {
  it("consumes the migration assertion without re-fencing and re-pins the delivery", { timeout: 120_000 }, async () => {
    const deliveryId = await registerDelivery(facadeA, "contract-migrate-1");
    const bound = await bindFreshWorktree(facadeA, deliveryId);
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    const fenceBefore = bound.ok ? bound.fence : -1;

    // The installation moves on to generation 2, then generation 1 is
    // revoked mid-delivery.
    const updated = await updateComposition({
      packedDir: packed[2].packedDir,
      ...installationA,
      qualification: { disposableRepositoryIds: [REPOSITORY_ID] },
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    const revoked = await maintainTrustState({
      ...installationA,
      operation: "revoke",
      generationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(revoked.ok).toBe(true);

    // Fenced at the next canonical site — here, an invocation-driven
    // checkpoint operation.
    const refused = await facadeA.submitStageResult({ deliveryId, stageId: "plan", resultBytes: "plan", fence: await currentFenceOf(facadeA, deliveryId) });
    expect(refused.ok).toBe(false);
    expect(await stateOf(facadeA, deliveryId)).toBe("security_blocked");

    // Re-preparation without a migration is refused: the recorded pin stands
    // revoked, and only an explicit compatible migration can change it.
    const premature = await facadeA.recoverSecurityBlocked({ deliveryId, now: NOW });
    expect(premature.ok).toBe(false);

    // The migration consumes against the assertion's bound target
    // generation, with fence absent-by-state — no re-fencing.
    const migrated = await facadeA.recoverSecurityBlocked({
      deliveryId,
      targetGenerationDigest: packed[2].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.mode).toBe("generation-change-migration");
    expect(await stateOf(facadeA, deliveryId)).toBe("preparing");

    const entries = await journalEntriesOf(facadeA, deliveryId);
    const consumption = entries.find((entry) => entry.kind === "approval.assertion.consumed");
    expect(consumption).toBeDefined();
    const assertion = consumption?.payload["assertion"] as Record<string, unknown>;
    expect(assertion["assertionClass"]).toBe("security-blocked-migration");
    expect(assertion["targetGenerationDigest"]).toBe(packed[2].generationDigest);
    expect(assertion["invocationFence"]).toBe("absent-by-state");
    expect(consumption?.payload["newRegisteringInstallationId"]).toBe("absent-by-state");
    // Consumption minted no new fence.
    const fences = entries.filter((entry) => entry.kind === "invocation.fenced");
    expect(fences.length).toBe(1);
    expect(fences[0]?.payload["fence"]).toBe(fenceBefore);
    // The delivery is re-pinned to the migrated generation.
    const pins = entries.filter((entry) => entry.kind === "generation.pinned");
    expect(pins.at(-1)?.payload["generationDigest"]).toBe(packed[2].generationDigest);

    // Revoked-era candidate-bound evidence was invalidated, not silently
    // carried: the delivery re-prepares from scratch.
    const rebound = await bindFreshWorktree(facadeA, deliveryId);
    expect(rebound.ok, JSON.stringify(rebound)).toBe(true);
    expect(await stateOf(facadeA, deliveryId)).toBe("planning");
  });

  it("refuses a migration assertion naming a revoked target generation, and the delivery remains security_blocked", { timeout: 120_000 }, async () => {
    const deliveryId = await registerDelivery(facadeA, "contract-migrate-2");
    // Recorded pin is generation 2; revoke it to fence the delivery.
    const revoke2 = await maintainTrustState({
      ...installationA,
      operation: "revoke",
      generationDigest: packed[2].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(revoke2.ok, JSON.stringify(revoke2)).toBe(true);
    const refused = await facadeA.submitStageResult({ deliveryId, stageId: "plan", resultBytes: "plan", fence: await currentFenceOf(facadeA, deliveryId) });
    expect(refused.ok).toBe(false);
    expect(await stateOf(facadeA, deliveryId)).toBe("security_blocked");

    // The installation moves to generation 3, which is then ALSO revoked: a
    // migration naming that revoked target is refused outright.
    const update3 = await updateComposition({
      packedDir: packed[3].packedDir,
      ...installationA,
      qualification: { disposableRepositoryIds: [REPOSITORY_ID] },
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(update3.ok, JSON.stringify(update3)).toBe(true);
    const revoke3 = await maintainTrustState({
      ...installationA,
      operation: "revoke",
      generationDigest: packed[3].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(revoke3.ok).toBe(true);
    const revokedTarget = await facadeA.recoverSecurityBlocked({
      deliveryId,
      targetGenerationDigest: packed[3].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(revokedTarget)).toContain("generation_revoked");
    expect(await stateOf(facadeA, deliveryId)).toBe("security_blocked");

    const unrevoke3 = await maintainTrustState({
      ...installationA,
      operation: "unrevoke",
      generationDigest: packed[3].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(unrevoke3.ok).toBe(true);

    // A stale migration assertion rejects the same way.
    const stale = await facadeA.recoverSecurityBlocked({
      deliveryId,
      targetGenerationDigest: packed[3].generationDigest,
      assertionSource: fixtureSource({ expiry: "2026-08-30T11:00:00Z" }),
      now: NOW,
    });
    expect(codesOf(stale)).toContain("assertion_stale");

    const replaying = fixtureSource({ nonce: () => "nonce-migration-replay" });
    const first = await facadeA.recoverSecurityBlocked({
      deliveryId,
      targetGenerationDigest: packed[3].generationDigest,
      assertionSource: replaying,
      now: NOW,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);

    // Fence again (revoke generation 3, the new pin), then attempt a replay
    // of the already-consumed nonce against an eligible target.
    const revoke3Again = await maintainTrustState({
      ...installationA,
      operation: "revoke",
      generationDigest: packed[3].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(revoke3Again.ok).toBe(true);
    const refenced = await bindFreshWorktree(facadeA, deliveryId);
    expect(refenced.ok).toBe(false);
    expect(await stateOf(facadeA, deliveryId)).toBe("security_blocked");
    const unrevoke2 = await maintainTrustState({
      ...installationA,
      operation: "unrevoke",
      generationDigest: packed[2].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(unrevoke2.ok).toBe(true);
    const replayed = await facadeA.recoverSecurityBlocked({
      deliveryId,
      targetGenerationDigest: packed[2].generationDigest,
      assertionSource: replaying,
      now: NOW,
    });
    expect(codesOf(replayed)).toContain("assertion_replayed");

    // Restore installation A to a healthy pin for the scenarios that follow.
    const unrevoke3Final = await maintainTrustState({
      ...installationA,
      operation: "unrevoke",
      generationDigest: packed[3].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(unrevoke3Final.ok).toBe(true);
  });
});

describe("rebinding migration", () => {
  it("rebinds only under a profile-matched migration recording the new registering installation", { timeout: 120_000 }, async () => {
    const deliveryId = await registerDelivery(facadeA, "contract-rebind-1");

    // A second installation's trust state can never serve another
    // installation's delivery without the explicit migration: the mismatch
    // fences at the next canonical site.
    const installationB = await installFixture("installation-b");
    const facadeB = facadeFor(installationB);
    const fenced = await bindFreshWorktree(facadeB, deliveryId);
    expect(fenced.ok).toBe(false);
    expect(await stateOf(facadeB, deliveryId)).toBe("security_blocked");

    // The status model is what an operator reads here, and it must say what to
    // do next: identity moved, profile did not, so the rebinding migration is
    // an authorized next action rather than something to be discovered by
    // attempting it.
    const blockedStatus = await statusOf(facadeB, deliveryId);
    expect(blockedStatus.registrationBinding.mismatch).toBe("identity");
    expect(blockedStatus.migrationPath).toBe("rebinding-migration");
    expect(blockedStatus.authorizedNextActions).toContain("recoverSecurityBlocked");
    expect(blockedStatus.productTrust.label.length).toBeGreaterThan(0);

    // The rebinding migration consumes with the target installation's
    // profile equal to the delivery's recorded profile, and records the new
    // registering-installation identity.
    const migrated = await facadeB.recoverSecurityBlocked({
      deliveryId,
      targetGenerationDigest: packed[1].generationDigest,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.mode).toBe("rebinding-migration");
    expect(await stateOf(facadeB, deliveryId)).toBe("preparing");

    const entries = await journalEntriesOf(facadeB, deliveryId);
    const consumption = entries.filter((entry) => entry.kind === "approval.assertion.consumed").at(-1);
    expect(consumption?.payload["newRegisteringInstallationId"]).toBeTypeOf("string");
    expect(consumption?.payload["newRegisteringInstallationId"]).not.toBe("absent-by-state");

    // The rebound delivery now advances under installation B…
    const rebound = await bindFreshWorktree(facadeB, deliveryId);
    expect(rebound.ok, JSON.stringify(rebound)).toBe(true);
    // …and installation A no longer serves it: the recheck resolves the
    // LATEST recorded binding.
    const refusedUnderA = await facadeA.submitStageResult({ deliveryId, stageId: "plan", resultBytes: "plan", fence: await currentFenceOf(facadeB, deliveryId) });
    expect(refusedUnderA.ok).toBe(false);
  });

  it("refuses a profile-mismatched rebinding — a fixture delivery can never be served by a production installation", { timeout: 120_000 }, async () => {
    const deliveryId = await registerDelivery(facadeA, "contract-rebind-2");

    const productionPack = await packComposition({
      sourceRoot: REPO_ROOT,
      skillsArchivePath: path.join(FIXTURES, "agent-skills-core-v1-composition.zip"),
      skillsMetadataPath: path.join(FIXTURES, "agent-skills-core-v1-composition.metadata.json"),
      compositionProfile: "production",
      compositionSequence: 1,
      outDir: path.join(scratch, "pack-production"),
    });
    expect(productionPack.ok, JSON.stringify(productionPack)).toBe(true);
    if (!productionPack.ok) return;
    const installationPath = path.join(scratch, "installation-production", "installation");
    const receiptDir = path.join(scratch, "installation-production", "user-config");
    const installed = await installComposition({
      packedDir: productionPack.packedDir,
      installationPath,
      receiptDir,
      assertionSource: fixtureSource(),
    });
    expect(installed.ok, JSON.stringify(installed)).toBe(true);

    const facadeProduction = facadeFor({ installationPath, receiptDir });
    // The mismatch fences the fixture delivery under the production
    // installation…
    const fenced = await facadeProduction.submitStageResult({ deliveryId, stageId: "plan", resultBytes: "plan", fence: await currentFenceOf(facadeProduction, deliveryId) });
    expect(fenced.ok).toBe(false);

    // The profile-mismatched delivery reports a typed blocker and NO migration
    // path: a rebinding requires the target installation's active profile to
    // equal the delivery's recorded profile, so offering the operation here
    // would only be offering a guaranteed refusal.
    const mismatchedStatus = await statusOf(facadeProduction, deliveryId);
    expect(mismatchedStatus.registrationBinding.mismatch).toBe("profile");
    expect(mismatchedStatus.migrationPath).toBe("none");
    expect(mismatchedStatus.authorizedNextActions).not.toContain("recoverSecurityBlocked");
    expect(mismatchedStatus.blockers.length).toBeGreaterThan(0);

    // …and the rebinding migration is refused on the profile mismatch; the
    // delivery remains security_blocked.
    const migrated = await facadeProduction.recoverSecurityBlocked({
      deliveryId,
      assertionSource: fixtureSource(),
      now: NOW,
    });
    expect(codesOf(migrated)).toContain("profile_mismatch");
    expect(await stateOf(facadeProduction, deliveryId)).toBe("security_blocked");
  });
});

describe("migration consumption rejects on any binding mismatch", () => {
  it("rejects wrong delivery, wrong journal revision, and wrong installation", () => {
    const assertion = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      spec: "sensitive-approval-assertion/1",
      assertionClass: "security-blocked-migration",
      origin: "installer.maintenance",
      action: "migrate-security-blocked",
      expiry: EXPIRY,
      nonce: "nonce-x",
      assertionSource: "qualification-fixture",
      productTrustRevocationEpoch: 0,
      repositoryAuthorityRevocationEpoch: "absent-by-state",
      deliveryId: "dlv-right",
      candidateTreeSha: "absent-by-state",
      policyDigest: "absent-by-state",
      invocationFence: "absent-by-state",
      targetInstallationId: "install-right",
      targetGenerationDigest: "a".repeat(64),
      targetHighWaterMark: "absent-by-state",
      expectedJournalRevision: 7,
      ...overrides,
    });
    const context = {
      deliveryId: "dlv-right",
      expectedJournalRevision: 7,
      currentInstallationId: "install-right",
      currentProfile: CONFIRMATION_FIXTURE_PROFILE,
      recordedProfile: CONFIRMATION_FIXTURE_PROFILE,
      recordedInstallationId: "install-old",
      trustState: {
        spec: "product-trust-state/1" as const,
        installationId: "install-right",
        pinnedManifestDigest: "a".repeat(64),
        acceptedGenerationDigests: ["a".repeat(64)],
        revokedGenerationDigests: [],
        revocationEpoch: 0,
        highWaterMark: 1,
      },
      consumedNonces: new Set<string>(),
      now: NOW,
    };
    expect(evaluateMigrationConsumption(assertion({}), context).ok).toBe(true);
    expect(evaluateMigrationConsumption(assertion({ deliveryId: "dlv-wrong" }), context).ok).toBe(false);
    expect(evaluateMigrationConsumption(assertion({ expectedJournalRevision: 8 }), context).ok).toBe(false);
    expect(evaluateMigrationConsumption(assertion({ targetInstallationId: "install-wrong" }), context).ok).toBe(false);
    expect(
      evaluateMigrationConsumption(assertion({}), {
        ...context,
        trustState: { ...context.trustState, revokedGenerationDigests: ["a".repeat(64)], revocationEpoch: 1 },
      }).ok,
    ).toBe(false);
    expect(
      evaluateMigrationConsumption(assertion({}), { ...context, recordedProfile: "production" }).ok,
    ).toBe(false);
  });
});
