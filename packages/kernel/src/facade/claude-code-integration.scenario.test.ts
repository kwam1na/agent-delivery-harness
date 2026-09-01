/**
 * THE CLAUDE CODE-NATIVE DELIVERY INTEGRATION — the scenario sensors for the
 * two-layer split, layered on the walking skeleton's disposable-repository
 * fixtures.
 *
 * The two layers, and what each is allowed to do:
 *
 *   - BEFORE ADMISSION, the trusted model-external binding applies and attests
 *     the compiled grant, the host workspace, the invocation fence, and the
 *     run-pinned projection root. Nothing in the session participates.
 *   - AFTER ADMISSION, the in-session projection reads the next valid
 *     checkpoint, consumes immutable context, uses Claude Code's own
 *     orchestration, and submits normalized results. It may VERIFY its
 *     attestation; it can neither apply, expand, nor replace its grant, and it
 *     never launches `claude --print` or a subordinate runtime.
 *
 * The termination-provenance verdict this suite pins is deliberately
 * unflattering: on the graded host version a background child SURVIVES a clean
 * session end, so descendant teardown is UNVERIFIED, the host stays below Tier
 * 3, and same-workspace resume stays closed. The scenarios prove the product
 * behaves that way rather than asserting a tier it cannot demonstrate — and
 * prove the same code reaches same-workspace resume when a host is graded with
 * verified teardown, so the gate is the grade, not a hard-coded refusal.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfirmationEchoAttempt, RenderedConfirmationChallenge } from "../binding/host-admission.ts";
import { createJournalStore } from "../checkpoint/journal-store.ts";
import { PROJECTION_DIR } from "../host/projection.ts";
import { SHADOW_MILESTONE_GATE_RECORD_SPEC } from "../host/consumption-gate-record.ts";
import { createExecPort, type ExecInvocation, type ExecPort } from "../host/exec-port.ts";
import { decideHookInvocation, type HookBindingState } from "../host/hook-main.ts";
import { installComposition, packComposition } from "../substrate/installer.ts";
import { CONFIRMATION_FIXTURE_PROFILE } from "../substrate/manifest.ts";
import { createManagedDeliveryFacade, type ManagedDeliveryFacade } from "./managed-delivery.ts";
import {
  DISPOSABLE_CONTRACT,
  GREET_RIGHT,
  buildDisposableRepository,
  disposableHarnessConfig,
  fixtureProviderBindingCapability,
  typedStageResultBytes,
} from "./disposable-repository.fixture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const FIXTURES = path.join(REPO_ROOT, "qualifications", "fixtures");

const NOW = "2026-08-30T12:00:00Z";
const LATER = "2026-08-30T12:00:30Z";
const HOST_VERSION = "2.1.97";

/** An instant in the shape the binding mints and the interceptor compares. */
const instant = (atMs: number): string => `${new Date(atMs).toISOString().slice(0, 19)}Z`;

/**
 * The attestation expiry, taken from the AMBIENT clock rather than written as
 * a literal.
 *
 * Every facade call in this file takes an injected clock, so a literal expiry
 * is stable against them forever. The tests that drive the real model-external
 * interceptor cannot inject anything: that binary is spawned, and it compares
 * the expiry against the wall clock of the machine running the suite. A
 * literal therefore stops being "the future" the moment wall-clock passes it,
 * and the file turns red on a DATE rather than on a change — silently, and
 * everywhere at once.
 *
 * Deriving it states the property the tests actually mean, which is that the
 * attestation is valid at the instant the interceptor reads it. Pushing the
 * literal forward would only re-arm the same failure on a later day.
 */
const EXPIRY = instant(Date.now() + 24 * 60 * 60 * 1000);

/**
 * An expiry already past on the ambient clock, yet still ahead of the injected
 * `NOW` the binding mints under — so the attestation is minted successfully and
 * is refused only when the spawned interceptor compares it to the wall clock.
 * That is precisely the condition no clock-injected test can reach.
 */
const AMBIENT_EXPIRED = instant(Date.now() - 60 * 60 * 1000);

let scratch: string;
let installationPath: string;
let receiptDir: string;
let repoDir: string;
let facade: ManagedDeliveryFacade;
let launches: ExecInvocation[];

function recordingExecPort(): ExecPort {
  const inner = createExecPort();
  return {
    run(invocation) {
      launches.push(invocation);
      return inner.run(invocation);
    },
  };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const commitAll = (cwd: string, message: string): void => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "--no-gpg-sign", "-m", message);
};

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

function must<T extends { ok: boolean }>(value: T, label: string): asserts value is Extract<T, { ok: true }> {
  if (!value.ok) throw new Error(`${label}: ${JSON.stringify(value)}`);
}

const restoreWritable = (dir: string): void => {
  try {
    execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
  } catch {
    /* removal surfaces the real failure */
  }
};

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "claude-code-integration-"));
  launches = [];

  const packed = await packComposition({
    sourceRoot: REPO_ROOT,
    skillsArchivePath: path.join(FIXTURES, "agent-skills-core-v1-composition.zip"),
    skillsMetadataPath: path.join(FIXTURES, "agent-skills-core-v1-composition.metadata.json"),
    compositionProfile: CONFIRMATION_FIXTURE_PROFILE,
    compositionSequence: 1,
    outDir: path.join(scratch, "pack"),
  });
  if (!packed.ok) throw new Error(JSON.stringify(packed));

  installationPath = path.join(scratch, "installation");
  receiptDir = path.join(scratch, "user-config");
  const installed = await installComposition({
    packedDir: packed.packedDir,
    installationPath,
    receiptDir,
    qualification: { disposableRepositoryIds: [DISPOSABLE_CONTRACT.repository.repositoryId] },
    assertionProvider: { sourceKind: "qualification-fixture" },
  });
  if (!installed.ok) throw new Error(JSON.stringify(installed));

  repoDir = buildDisposableRepository(path.join(scratch, "repo")).repoDir;

  facade = createManagedDeliveryFacade({
    repoDir,
    config: disposableHarnessConfig(),
    installation: { installationPath, receiptDir },
    hostVersion: HOST_VERSION,
    exec: recordingExecPort(),
  });
}, 120_000);

afterAll(async () => {
  restoreWritable(scratch);
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

// ── The host side of the checkpoint path ────────────────────────────────────

interface Session {
  deliveryId: string;
  worktree: string;
  fence: number;
}

let sequence = 0;

async function openSession(attestationExpiry: string = EXPIRY): Promise<Session> {
  sequence += 1;
  const contract = { ...DISPOSABLE_CONTRACT, contractId: `contract-cc-${sequence}` };
  const presented = await facade.presentContract({ contract, expiry: EXPIRY });
  must(presented, "presentContract");
  const confirmed = await facade.confirmContract({
    intakeId: presented.intakeId,
    echo: operatorEcho(presented.channelPath),
  });
  must(confirmed, "confirmContract");
  const worktree = path.join(scratch, `wt-${sequence}`);
  git(repoDir, "worktree", "add", "--quiet", "-b", `cc-${sequence}`, worktree, "main");
  const bound = await facade.bindWorkspace({
    deliveryId: confirmed.deliveryId,
    worktreeDir: worktree,
    hostTaskId: `host-${sequence}`,
    observedAt: NOW,
    attestationExpiry,
    providerReviewBindingCapability: fixtureProviderBindingCapability(confirmed.deliveryId),
  });
  must(bound, "bindWorkspace");
  return { deliveryId: confirmed.deliveryId, worktree, fence: bound.fence };
}

const treeOf = (worktree: string): string => git(worktree, "rev-parse", "HEAD^{tree}");

async function plan(session: Session): Promise<void> {
  const planned = await facade.submitStageResult({
    deliveryId: session.deliveryId,
    stageId: "plan",
    resultBytes: typedStageResultBytes({
      stageId: "plan",
      deliveryId: session.deliveryId,
      outputKind: "bounded-plan",
      candidate: treeOf(session.worktree),
    }),
    fence: session.fence,
  });
  must(planned, "plan");
}

async function implement(session: Session): Promise<void> {
  writeFileSync(path.join(session.worktree, "src", "greet.mjs"), GREET_RIGHT);
  commitAll(session.worktree, "implement the greeting");
  const checkpointed = await facade.checkpointCandidate({
    deliveryId: session.deliveryId,
    resultBytes: typedStageResultBytes({
      stageId: "implement",
      deliveryId: session.deliveryId,
      outputKind: "delivery-candidate",
      candidate: treeOf(session.worktree),
    }),
    fence: session.fence,
  });
  must(checkpointed, "checkpointCandidate");
}

const journalEntries = async (deliveryId: string): Promise<readonly { kind: string; payload: Record<string, unknown> }[]> => {
  const namespaceDir = await facade.namespaceDir();
  const store = createJournalStore(path.join(namespaceDir, "deliveries", deliveryId, "journal.jsonl"));
  const read = await store.read();
  if (!read.ok) throw new Error("journal unreadable");
  return (read.entries as readonly Record<string, unknown>[]).map((entry) => ({
    kind: entry["kind"] as string,
    payload: (entry["payload"] ?? {}) as Record<string, unknown>,
  }));
};

/** The CURRENT invocation's fence-scoped binding state, named by the workspace. */
const bindingStatePath = async (deliveryId: string): Promise<string> => {
  const deliveryDir = path.join(await facade.namespaceDir(), "deliveries", deliveryId);
  const meta = JSON.parse(readFileSync(path.join(deliveryDir, "workspace.json"), "utf8")) as {
    fence: number;
    settingsPath: string;
  };
  return path.join(deliveryDir, "binding", `state-${meta.fence}.json`);
};

const bindingState = async (deliveryId: string): Promise<HookBindingState> =>
  JSON.parse(readFileSync(await bindingStatePath(deliveryId), "utf8")) as HookBindingState;

const settingsPathOf = async (deliveryId: string): Promise<string> => {
  const deliveryDir = path.join(await facade.namespaceDir(), "deliveries", deliveryId);
  return (JSON.parse(readFileSync(path.join(deliveryDir, "workspace.json"), "utf8")) as { settingsPath: string })
    .settingsPath;
};

// ── The scenarios ───────────────────────────────────────────────────────────

describe("the pre-admission binding layer", () => {
  it("attests host version, delivery, fence, trust epoch, grant digest, workspace, and projection before any tool is visible", async () => {
    const session = await openSession();
    const state = await bindingState(session.deliveryId);
    const attestation = state.attestation as Record<string, unknown>;

    expect(attestation["hostVersion"]).toBe(HOST_VERSION);
    expect(attestation["deliveryId"]).toBe(session.deliveryId);
    expect(attestation["invocationFence"]).toBe(session.fence);
    expect(attestation["productTrustRevocationEpoch"]).toBe(0);
    expect(attestation["grantDigest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(attestation["workspaceId"]).toMatch(/^ws-/);
    expect(attestation["projectionDigest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(attestation["discoveryConfigurationDigest"]).toMatch(/^[0-9a-f]{64}$/);

    // The in-session layer may VERIFY the attestation — the same decision the
    // interceptor takes — but the state it verifies against is binding-owned
    // and lives outside every writable path in the grant.
    expect(decideHookInvocation(state, { tool_name: "Read", tool_input: {} }, LATER, state.expectation.invocationFence).allowed).toBe(true);
    const grant = state.grant as { writablePaths: string[]; protectedPaths: string[] };
    for (const writable of grant.writablePaths) {
      expect(path.join(session.worktree, writable).startsWith(await facade.namespaceDir())).toBe(false);
    }
    expect(grant.protectedPaths).toContain(PROJECTION_DIR);
  });

  it("gives the in-session layer no way to apply, expand, or replace its own grant", async () => {
    const session = await openSession();
    const state = await bindingState(session.deliveryId);
    const namespaceDir = await facade.namespaceDir();

    // Writing the binding's own state file — the only place a grant could be
    // widened from — is a write to a protected authority path.
    const attempts = [
      await bindingStatePath(session.deliveryId),
      await settingsPathOf(session.deliveryId),
      path.join(session.worktree, ".claude", "settings.json"),
      path.join(session.worktree, PROJECTION_DIR, "consumption.json"),
    ];
    for (const file_path of attempts) {
      expect(
        decideHookInvocation(state, { tool_name: "Write", tool_input: { file_path } }, LATER, state.expectation.invocationFence)
          .allowed,
        file_path,
      ).toBe(false);
    }

    // And the confirmation channel is closed to it even by name.
    expect(
      decideHookInvocation(state, { tool_name: "operator-confirmation.contract", tool_input: {} }, LATER, state.expectation.invocationFence).allowed,
    ).toBe(false);
  });

  it("refuses a submission whose worktree carries another run's projection — the marker is read back fence-bound", async () => {
    const session = await openSession();
    await plan(session);

    // A stale session's worktree, whose projection was materialized for a
    // different delivery: the digests may be internally consistent, but the
    // per-run marker names the wrong run.
    const foreign = await openSession();
    const namespaceDir = await facade.namespaceDir();
    const workspaceMeta = path.join(namespaceDir, "deliveries", session.deliveryId, "workspace.json");
    const receiptPath = path.join(namespaceDir, "deliveries", session.deliveryId, "binding", "projection-receipt.json");
    const meta = JSON.parse(readFileSync(workspaceMeta, "utf8")) as Record<string, unknown>;
    const receipt = readFileSync(receiptPath, "utf8");
    const foreignMeta = JSON.parse(
      readFileSync(path.join(namespaceDir, "deliveries", foreign.deliveryId, "workspace.json"), "utf8"),
    ) as Record<string, unknown>;
    // Point the delivery at the foreign worktree AND carry the foreign
    // receipt, so every digest agrees and the ONLY thing left disagreeing is
    // which run injected the bytes.
    writeFileSync(
      workspaceMeta,
      `${JSON.stringify({
        ...meta,
        worktreeDir: foreignMeta["worktreeDir"],
        projectionDigest: foreignMeta["projectionDigest"],
      })}\n`,
    );
    writeFileSync(
      receiptPath,
      readFileSync(path.join(namespaceDir, "deliveries", foreign.deliveryId, "binding", "projection-receipt.json"), "utf8"),
    );

    const refused = await facade.checkpointCandidate({
      deliveryId: session.deliveryId,
      resultBytes: typedStageResultBytes({
        stageId: "implement",
        deliveryId: session.deliveryId,
        outputKind: "delivery-candidate",
        candidate: treeOf(foreign.worktree),
      }),
      fence: session.fence,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.blockers[0]?.code).toBe("consumption_marker_mismatch");
    }
    // Restore, so the delivery stays usable for its own teardown.
    writeFileSync(workspaceMeta, `${JSON.stringify(meta)}\n`);
    writeFileSync(receiptPath, receipt);
  });
});

describe("session end, before and after mutation", () => {
  it("records graceful provenance with the graded teardown status BEFORE any mutation, and keeps resume on takeover", async () => {
    const session = await openSession();
    const ended = await facade.recordTerminationProvenance({ deliveryId: session.deliveryId, fence: session.fence });
    must(ended, "recordTerminationProvenance");
    expect(ended.resumeEligibility).toBe("fresh-worktree-only");

    const entries = await journalEntries(session.deliveryId);
    const provenance = entries.filter((entry) => entry.kind === "termination.provenance.recorded");
    expect(provenance.length).toBe(1);
    expect(provenance[0]?.payload["provenance"]).toBe("graceful");
    expect(provenance[0]?.payload["descendantTeardown"]).toBe("unverified");
    expect(provenance[0]?.payload["resumeEligibility"]).toBe("fresh-worktree-only");
    // It is a durable fact, not an activity marker: the two kinds stay
    // distinct and only the activity kind is observation-only.
    expect(entries.some((entry) => entry.kind === "activity.observed")).toBe(true);

    const status = await facade.status({ deliveryId: session.deliveryId, observedAt: LATER });
    must(status, "status");
    expect(status.status.resume).toBe("takeover-required");
    // The delivery checkpoint itself did not move.
    expect(status.status.delivery.state).toBe("planning");
  });

  it("records the same honest provenance AFTER a mutation, preserving the last trusted candidate", async () => {
    const session = await openSession();
    await plan(session);
    await implement(session);
    const before = await facade.status({ deliveryId: session.deliveryId, observedAt: NOW });
    must(before, "status before");

    const ended = await facade.recordTerminationProvenance({ deliveryId: session.deliveryId, fence: session.fence });
    must(ended, "recordTerminationProvenance");

    const after = await facade.status({ deliveryId: session.deliveryId, observedAt: LATER });
    must(after, "status after");
    expect(after.status.delivery.state).toBe(before.status.delivery.state);
    expect(after.status.resume).toBe("takeover-required");
    // The candidate the mutation produced is still the delivery's candidate.
    const entries = await journalEntries(session.deliveryId);
    expect(entries.some((entry) => entry.kind === "candidate.recaptured")).toBe(true);
  });

  it("takes NO teardown claim from its caller — the grade comes from the pinned generation", async () => {
    const session = await openSession();
    const namespaceDir = await facade.namespaceDir();

    // The whole attack surface for a Tier 3 overclaim: a granted Bash call can
    // write inside the workspace, and the binding state file is the only place
    // a session could plausibly plant a teardown status. Plant every spelling
    // of it, in both files a session might reach.
    const bindingDir = path.join(namespaceDir, "deliveries", session.deliveryId, "binding");
    const statePath = await bindingStatePath(session.deliveryId);
    const planted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    writeFileSync(statePath, `${JSON.stringify({ ...planted, descendantTeardown: "verified", tier: 3 })}\n`);
    writeFileSync(path.join(session.worktree, "descendantTeardown"), "verified\n");

    const ended = await facade.recordTerminationProvenance({ deliveryId: session.deliveryId, fence: session.fence });
    must(ended, "recordTerminationProvenance");
    // The graded record inside the pinned generation says otherwise, and it is
    // the only thing consulted.
    expect(ended.descendantTeardown).toBe("unverified");
    expect(ended.resumeEligibility).toBe("fresh-worktree-only");

    const status = await facade.status({ deliveryId: session.deliveryId, observedAt: LATER });
    must(status, "status");
    expect(status.status.resume).toBe("takeover-required");
  });

  it("maps a Tier 3 provenance record onto same-workspace resume, so the gate is the grade and not a refusal", async () => {
    // The grade cannot be faked through the product's own door, so the
    // status MAPPING is proven against a journal that already carries a Tier 3
    // host's record — the shape `gradedDescendantTeardown` produces when a
    // capability record grades a host at Tier 3 (proven separately against a
    // synthetic record in the host module's own suite).
    const session = await openSession();
    const ended = await facade.sessionEnded({ deliveryId: session.deliveryId, fence: session.fence });
    must(ended, "sessionEnded");
    const namespaceDir = await facade.namespaceDir();
    const store = createJournalStore(path.join(namespaceDir, "deliveries", session.deliveryId, "journal.jsonl"));
    const read = await store.read();
    const reduced = await store.state();
    if (!read.ok || !reduced.ok) throw new Error("journal unreadable");
    const appended = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: session.deliveryId,
      expectedRevision: reduced.state.expectedRevision,
      idempotencyKey: `e${read.entries.length}-termination.provenance.recorded`,
      kind: "termination.provenance.recorded",
      payload: {
        fence: session.fence,
        hostVersion: "hypothetical-tier-3/1.0.0",
        provenance: "graceful",
        descendantTeardown: "verified",
        resumeEligibility: "same-workspace",
      },
    });
    expect(appended.ok, JSON.stringify(appended)).toBe(true);

    const status = await facade.status({ deliveryId: session.deliveryId, observedAt: LATER });
    must(status, "status");
    expect(status.status.resume).toBe("same-workspace");
  });

  it("records provenance once per invocation, so a retrying lifecycle integration cannot void a pending takeover", async () => {
    const session = await openSession();
    const first = await facade.recordTerminationProvenance({ deliveryId: session.deliveryId, fence: session.fence });
    must(first, "first provenance");
    const before = await journalEntries(session.deliveryId);

    const again = await facade.recordTerminationProvenance({ deliveryId: session.deliveryId, fence: session.fence });
    must(again, "repeat provenance");
    expect(again.resumeEligibility).toBe(first.resumeEligibility);

    const after = await journalEntries(session.deliveryId);
    // No second append, so the expected journal revision a pending takeover
    // authorization binds is untouched.
    expect(after.length).toBe(before.length);
    expect(after.filter((entry) => entry.kind === "termination.provenance.recorded").length).toBe(1);
  });

  it("does not let a superseded invocation record termination provenance for the live fence", async () => {
    const session = await openSession();
    const stale = await facade.recordTerminationProvenance({
      deliveryId: session.deliveryId,
      fence: session.fence - 1,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.blockers[0]?.code).toBe("stale_fence");
  });
});

describe("host cancellation racing a checkpoint submission", () => {
  it("revokes the fence first, so the racing submission lands nowhere and nothing claims the task stopped", async () => {
    const session = await openSession();
    await plan(session);
    writeFileSync(path.join(session.worktree, "src", "greet.mjs"), GREET_RIGHT);
    commitAll(session.worktree, "implement the greeting");

    const cancelled = await facade.requestCancellation({ deliveryId: session.deliveryId });
    must(cancelled, "requestCancellation");
    expect(cancelled.state).toBe("cancellation_requested");

    // The interceptor is deny-until-attested, so the revoked attestation
    // re-denies every subsequent tool call — including a late subagent's.
    const state = await bindingState(session.deliveryId);
    expect(decideHookInvocation(state, { tool_name: "Read", tool_input: {} }, LATER, state.expectation.invocationFence).allowed).toBe(false);

    // The submission that raced the cancellation is refused by state, not
    // accepted-then-undone.
    const raced = await facade.checkpointCandidate({
      deliveryId: session.deliveryId,
      resultBytes: typedStageResultBytes({
        stageId: "implement",
        deliveryId: session.deliveryId,
        outputKind: "delivery-candidate",
        candidate: treeOf(session.worktree),
      }),
      fence: session.fence,
    });
    expect(raced.ok).toBe(false);

    const finalized = await facade.finalizeCancellation({ deliveryId: session.deliveryId });
    must(finalized, "finalizeCancellation");
    expect(finalized.state).toBe("cancelled");

    // Quarantine, never a termination claim: no provenance record exists.
    const entries = await journalEntries(session.deliveryId);
    expect(entries.some((entry) => entry.kind === "termination.provenance.recorded")).toBe(false);
    const disposition = entries.filter((entry) => entry.kind === "workspace.disposition.recorded").at(-1);
    expect(disposition?.payload["disposition"]).toBe("quarantined");
  });
});

describe("a stale session and a fresh one", () => {
  it("cannot see a newly activated projection, while the fresh session resumes from the checkpoint", async () => {
    const session = await openSession();
    await plan(session);
    await implement(session);
    const staleState = await bindingState(session.deliveryId);
    const staleStatePath = await bindingStatePath(session.deliveryId);
    const staleSettingsPath = await settingsPathOf(session.deliveryId);
    const staleWorktree = session.worktree;

    // The operator authorizes a takeover; the fresh worktree gets its own
    // projection and its own fence.
    const ended = await facade.sessionEnded({ deliveryId: session.deliveryId, fence: session.fence });
    must(ended, "sessionEnded");
    const presented = await facade.presentTakeover({ deliveryId: session.deliveryId, expiry: EXPIRY });
    must(presented, "presentTakeover");
    const authorized = await facade.confirmTakeover({
      deliveryId: session.deliveryId,
      echo: operatorEcho(presented.channelPath),
    });
    must(authorized, "confirmTakeover");
    const fresh = path.join(scratch, `wt-${sequence}-takeover`);
    git(repoDir, "worktree", "add", "--quiet", "-b", authorized.takeoverBranchRef, fresh, authorized.targetBaseCommit);
    const rebound = await facade.bindWorkspace({
      deliveryId: session.deliveryId,
      worktreeDir: fresh,
      hostTaskId: `host-${sequence}-fresh`,
      observedAt: LATER,
      attestationExpiry: EXPIRY,
      providerReviewBindingCapability: fixtureProviderBindingCapability(session.deliveryId),
    });
    must(rebound, "rebind");
    expect(rebound.fence).toBeGreaterThan(session.fence);
    expect(rebound.projectionDigest).not.toBe(staleState.expectation.projectionDigest);

    // THE STALE SESSION, as it actually is on disk. Its admission
    // configuration is FENCE-SCOPED, so the rebind wrote new files rather than
    // overwriting the predecessor's in place — which matters because this host
    // reloads settings and hooks mid-session. The predecessor therefore keeps
    // reading its OWN state file and its OWN hook command.
    const currentStatePath = await bindingStatePath(session.deliveryId);
    const currentSettingsPath = await settingsPathOf(session.deliveryId);
    expect(currentStatePath).not.toBe(staleStatePath);
    expect(currentSettingsPath).not.toBe(staleSettingsPath);
    expect(existsSync(staleStatePath), "the predecessor's own state file survives the rebind").toBe(true);
    // Its hook command still names its own fence and its own state file, so a
    // mid-session settings reload cannot hand it the successor's.
    const staleHook = JSON.stringify(
      (JSON.parse(readFileSync(staleSettingsPath, "utf8")) as { hooks: unknown }).hooks,
    );
    expect(staleHook).toContain(`\\"${String(session.fence)}\\"`);
    expect(staleHook).toContain(staleStatePath);
    expect(staleHook).not.toContain(currentStatePath);

    // And supersession VOIDED it: a null attestation is the frozen
    // deny-until-attested case, so the predecessor's tools close on its very
    // next invocation.
    const superseded = JSON.parse(readFileSync(staleStatePath, "utf8")) as HookBindingState;
    expect(superseded.attestation).toBeNull();
    for (const invocation of [
      { tool_name: "Read", tool_input: {} },
      { tool_name: "Write", tool_input: { file_path: path.join(fresh, "src", "greet.mjs") } },
      { tool_name: "Write", tool_input: { file_path: path.join(staleWorktree, "src", "greet.mjs") } },
    ]) {
      expect(decideHookInvocation(superseded, invocation, LATER, session.fence).allowed, JSON.stringify(invocation)).toBe(
        false,
      );
    }
    // Even were it not voided, the baked fence alone closes it.
    const notVoided: HookBindingState = { ...superseded, attestation: staleState.attestation };
    const byFence = decideHookInvocation(notVoided, { tool_name: "Read", tool_input: {} }, LATER, rebound.fence);
    expect(byFence.allowed).toBe(false);
    if (!byFence.allowed) expect(byFence.reason).toContain("superseded_session");

    // The fresh session, reading its own state under its own fence, proceeds.
    const current = await bindingState(session.deliveryId);
    expect(current.expectation.invocationFence).toBe(rebound.fence);
    expect(decideHookInvocation(current, { tool_name: "Read", tool_input: {} }, LATER, rebound.fence).allowed).toBe(true);

    // And the stale worktree's projection is not the fresh one: its per-run
    // marker still names the superseded fence.
    const staleMarker = JSON.parse(
      readFileSync(path.join(staleWorktree, PROJECTION_DIR, "consumption.json"), "utf8"),
    ) as { fence: number };
    expect(staleMarker.fence).toBe(session.fence);

    // The fresh session continues from the last trustworthy checkpoint.
    const status = await facade.status({ deliveryId: session.deliveryId, observedAt: LATER });
    must(status, "status");
    expect(status.status.delivery.fence).toBe(rebound.fence);
    const sensed = await facade.runSensor({ deliveryId: session.deliveryId, fence: rebound.fence });
    must(sensed, "runSensor");
    expect(sensed.outcome).toBe("passed");
  });
});

describe("required host capability unavailable", () => {
  it("denies the invocation rather than degrading to an unattested one", async () => {
    const session = await openSession();
    const state = await bindingState(session.deliveryId);

    // The stage grant does not list this capability, so the host's own
    // permission system never allows it and the interceptor denies it too.
    const denied = decideHookInvocation(state, { tool_name: "WebFetch", tool_input: {} }, LATER, state.expectation.invocationFence);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toContain("capability_not_granted");

    // A missing binding state — the shape a failed grant application leaves —
    // denies everything.
    expect(decideHookInvocation(undefined, { tool_name: "Read", tool_input: {} }, LATER, 1).allowed).toBe(false);
  });
});

describe("the delivery journal's durable bytes", () => {
  it("carries no credential-like value from the host environment", async () => {
    const session = await openSession();
    await plan(session);
    await implement(session);

    const namespaceDir = await facade.namespaceDir();
    const journalPath = path.join(namespaceDir, "deliveries", session.deliveryId, "journal.jsonl");
    const bytes = readFileSync(journalPath, "utf8");

    // Nothing that looks like a token, key, or transcript reaches durable
    // authority: the journal records digests and identities only.
    for (const pattern of [
      /sk-[A-Za-z0-9_-]{16,}/,
      /gh[pousr]_[A-Za-z0-9]{16,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /"(ANTHROPIC|AWS|GITHUB|OPENAI)[A-Z_]*"\s*:/,
      /Bearer\s+[A-Za-z0-9._-]{16,}/,
    ]) {
      expect(bytes, `journal matched ${pattern}`).not.toMatch(pattern);
    }

    // Privileged credentials are absent from the model-driven surface too:
    // the binding state the session can read carries none.
    const state = readFileSync(await bindingStatePath(session.deliveryId), "utf8");
    expect(state).not.toMatch(/token|password|secret|credential/i);
  });
});

describe("teardown with the worktree", () => {
  it("leaves no binding-written projection or discovery configuration behind", async () => {
    const session = await openSession();
    const namespaceDir = await facade.namespaceDir();
    const bindingDir = path.join(namespaceDir, "deliveries", session.deliveryId, "binding");

    const settingsPath = await settingsPathOf(session.deliveryId);
    expect(existsSync(path.join(session.worktree, PROJECTION_DIR))).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const torn = await facade.tearDownWorkspaceProjection({ deliveryId: session.deliveryId });
    must(torn, "tearDownWorkspaceProjection");

    expect(existsSync(path.join(session.worktree, PROJECTION_DIR))).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(path.join(bindingDir, "worktree-excludes"))).toBe(false);
    expect(git(session.worktree, "status", "--porcelain")).toBe("");
    // Removing the worktree afterwards is the host's business and now leaves
    // nothing of the binding's behind.
    git(repoDir, "worktree", "remove", "--force", session.worktree);
    expect(existsSync(session.worktree)).toBe(false);
  });
});

describe("negative process instrumentation", () => {
  it("never launches Claude Code and never manages its agents or workspaces", async () => {
    const session = await openSession();
    await plan(session);
    await implement(session);
    await facade.recordTerminationProvenance({ deliveryId: session.deliveryId, fence: session.fence });

    // Everything the PRODUCT has executed across this whole suite. Matching is
    // on the executable and its arguments as TOKENS — a scratch directory that
    // happens to contain a host's name in its path is not a launch.
    const executables = launches.map((invocation) => path.basename(invocation.command));
    const argv = launches.map((invocation) => [path.basename(invocation.command), ...invocation.args]);

    for (const runtime of ["claude", "claude-code", "codex", "codex-cli", "npx", "--print"]) {
      expect(
        argv.filter((tokens) => tokens.includes(runtime)),
        `launched ${runtime}`,
      ).toEqual([]);
    }
    // It runs git and — when a stage calls for it — the repository's own
    // sensor under node, and nothing else. Asserted as a subset so the claim
    // does not depend on which stages this suite's other cases happened to
    // reach; what matters is that no third executable ever appears.
    for (const executable of new Set(executables)) {
      expect(["git", "node"], `launched ${executable}`).toContain(executable);
    }
    const commands = argv.map((tokens) => tokens.join(" "));
    for (const worktreeVerb of ["worktree add", "worktree remove", "worktree move", "worktree prune"]) {
      expect(commands.filter((command) => command.includes(worktreeVerb)), worktreeVerb).toEqual([]);
    }
    // The only common-configuration write is the worktree-config enablement.
    const commonWrites = commands.filter(
      (command) => command.startsWith("git config") && !command.includes("--worktree") && !command.includes("--get"),
    );
    expect(commonWrites.every((command) => command.includes("extensions.worktreeConfig"))).toBe(true);
  });
});

describe("the in-session projection's immutable context", () => {
  it("materializes the pinned workflow bytes read-only and refuses to let the session rewrite them", async () => {
    const session = await openSession();
    const state = await bindingState(session.deliveryId);
    const graphPath = path.join(session.worktree, PROJECTION_DIR, "workflows", "delivery-v1.json");
    expect(existsSync(graphPath)).toBe(true);

    // Immutable context: the session reads it, and every write into the
    // subtree is a protected-authority-path denial.
    expect(decideHookInvocation(state, { tool_name: "Write", tool_input: { file_path: graphPath } }, LATER, state.expectation.invocationFence).allowed).toBe(
      false,
    );
    mkdirSync(path.join(session.worktree, "src"), { recursive: true });
    expect(
      decideHookInvocation(
        state,
        { tool_name: "Write", tool_input: { file_path: path.join(session.worktree, "src", "greet.mjs") } },
        LATER,
        state.expectation.invocationFence,
      ).allowed,
    ).toBe(true);
  });
});

describe("the binding-sourced projection-consumption gate record", () => {
  it.skipIf(process.platform !== "darwin")(
    "keeps a model's public-hook self-invocation out of authority while the genuine host callback records",
    async () => {
      const session = await openSession();
      const state = await bindingState(session.deliveryId);
      const authorityObservation = state.projectionConsumptionPath;
      const receiptPath = state.projectionReceiptPath;
      expect(typeof authorityObservation).toBe("string");
      expect(typeof receiptPath).toBe("string");
      if (authorityObservation === undefined || receiptPath === undefined) return;

      // The landed admission projects common Git into Claude's OS-level deny
      // set. The observation is inside that authority root, while src is the
      // model's exact writable control root.
      const commonGitDir = git(session.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const realCommonGitDir = realpathSync(commonGitDir);
      const authorityParent = realpathSync(path.dirname(authorityObservation));
      expect(path.relative(realCommonGitDir, authorityParent)).not.toMatch(/^\.\.(?:\/|$)/u);
      const settings = JSON.parse(readFileSync(await settingsPathOf(session.deliveryId), "utf8")) as {
        sandbox: { filesystem: { allowWrite: string[]; denyWrite: string[] } };
      };
      expect(settings.sandbox.filesystem.allowWrite).toContain(path.join(session.worktree, "src"));
      expect(settings.sandbox.filesystem.denyWrite).toContain(path.resolve(commonGitDir));

      // A model does not need the genuine protected state to try this attack:
      // it can mint matching-looking state and receipt bytes under src, import
      // the public hook, and point its output at authority. Use the same forged
      // bytes first against an allowed control path so a non-writing hook or a
      // broken predicate cannot make the authority denial pass vacuously.
      const forgedStatePath = path.join(session.worktree, "src", "forged-hook-state.json");
      const forgedReceiptPath = path.join(session.worktree, "src", "forged-projection-receipt.json");
      const allowedControl = path.join(session.worktree, "src", "forged-projection-consumption.json");
      writeFileSync(forgedReceiptPath, readFileSync(receiptPath));
      const writeForgedState = (projectionConsumptionPath: string): void => {
        writeFileSync(
          forgedStatePath,
          `${JSON.stringify({ ...state, projectionReceiptPath: forgedReceiptPath, projectionConsumptionPath })}\n`,
        );
      };
      const invocation = (tool_use_id: string): Record<string, unknown> => ({
        tool_name: "Read",
        tool_input: { file_path: realpathSync(path.join(session.worktree, PROJECTION_DIR, "workflows", "delivery-v1.json")) },
        tool_use_id,
      });
      const seatbeltProfile = [
        "(version 1)",
        "(allow default)",
        `(deny file-write* (subpath ${JSON.stringify(realCommonGitDir)}))`,
      ].join("\n");
      const selfInvoke = (tool_use_id: string): void => {
        execFileSync(
          "/usr/bin/sandbox-exec",
          [
            "-p",
            seatbeltProfile,
            path.join(REPO_ROOT, "node_modules", ".bin", "tsx"),
            path.join(REPO_ROOT, "packages", "kernel", "src", "host", "hook-main.ts"),
            "post-tool-use",
            forgedStatePath,
            String(session.fence),
          ],
          { input: JSON.stringify(invocation(tool_use_id)), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
        );
      };

      writeForgedState(allowedControl);
      selfInvoke("toolu_model_control");
      expect(existsSync(allowedControl)).toBe(true);

      writeForgedState(authorityObservation);
      selfInvoke("toolu_model_authority_attack");
      expect(existsSync(authorityObservation)).toBe(false);

      // The host owns callback execution and runs it outside the model's Bash
      // sandbox. Its genuine callback over binding-owned state can therefore
      // record the exact read, after which the product only adjudicates it.
      await consumeProjection(session);
      expect(JSON.parse(readFileSync(authorityObservation, "utf8"))).toMatchObject({
        spec: "projection-consumption-observation/1",
        deliveryId: session.deliveryId,
        fence: session.fence,
      });
      const gateRecordPath = gateRecord("model-self-invocation");
      const recorded = await facade.recordProjectionConsumption({
        deliveryId: session.deliveryId,
        gateRecordPath,
        category: "code",
      });
      must(recorded, "recordProjectionConsumption (host callback)");
      expect(recorded.emitted).toBe(true);
    },
  );

  /** The consuming repository's gate-record artifact, in the shape its guard reads. */
  const gateRecord = (name: string): string => {
    const dir = path.join(scratch, `gate-record-${name}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "shadow-milestone-gate-record.json");
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          spec: SHADOW_MILESTONE_GATE_RECORD_SPEC,
          repositoryId: "athena",
          comparisonSetRequirement: { mix: { code: 1, docs: 1, operations: 1 }, total: 3 },
          deliveries: [],
        },
        null,
        2,
      )}\n`,
    );
    return file;
  };

  const entriesIn = (file: string): any[] =>
    (JSON.parse(readFileSync(file, "utf8")) as { deliveries: any[] }).deliveries;

  /**
   * The run reaching into the run-pinned projection, driven through the REAL
   * model-external interceptor: the host invokes the hook binary with the
   * invocation's own arguments, and the binding records what it saw. Nothing
   * in the session writes the observation, and no test fixture stands in for
   * it — the point of the record is that this fact was observed, not assumed.
   */
  const intercept = async (session: Session, event: "pre-tool-use" | "post-tool-use", invocation: unknown): Promise<string> => {
    const statePath = await bindingStatePath(session.deliveryId);
    return execFileSync(
      path.join(REPO_ROOT, "node_modules", ".bin", "tsx"),
      [path.join(REPO_ROOT, "packages", "kernel", "src", "host", "hook-main.ts"), event, statePath, String(session.fence)],
      { input: JSON.stringify(invocation), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  };

  const consumeProjection = async (session: Session): Promise<string> => {
    const invocation = {
      tool_name: "Read",
      tool_input: { file_path: realpathSync(path.join(session.worktree, PROJECTION_DIR, "workflows", "delivery-v1.json")) },
      tool_use_id: `toolu_${session.deliveryId}`,
    };
    const admitted = await intercept(session, "pre-tool-use", invocation);
    if (admitted.length > 0) return admitted;
    return intercept(session, "post-tool-use", invocation);
  };

  it("gives a shadow delivery an entry the guard admits, and two deliveries two distinct entries", async () => {
    const gateRecordPath = gateRecord("two-deliveries");
    const first = await openSession();
    await consumeProjection(first);
    const recorded = await facade.recordProjectionConsumption({
      deliveryId: first.deliveryId,
      gateRecordPath,
      category: "code",
    });
    must(recorded, "recordProjectionConsumption");
    expect(recorded.emitted).toBe(true);

    const second = await openSession();
    await consumeProjection(second);
    must(
      await facade.recordProjectionConsumption({
        deliveryId: second.deliveryId,
        gateRecordPath,
        category: "docs",
      }),
      "recordProjectionConsumption (second)",
    );

    const entries = entriesIn(gateRecordPath);
    expect(entries.map((entry) => entry.id)).toEqual([first.deliveryId, second.deliveryId]);
    for (const [entry, session] of [
      [entries[0], first],
      [entries[1], second],
    ] as const) {
      // Every field the consuming guard requires of an admissible record, from
      // the binding's own receipt and marker.
      expect(entry.countedInComparisonSet).toBe(true);
      expect(entry.projectionConsumption.source).toBe("binding");
      expect(entry.projectionConsumption.affirmative).toBe(true);
      expect(entry.projectionConsumption.projectionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.projectionConsumption.marker.deliveryId).toBe(session.deliveryId);
      expect(entry.projectionConsumption.marker.fence).toBe(session.fence);
      expect(typeof entry.projectionConsumption.marker.consumed).toBe("string");
      expect(entry.projectionConsumption.marker.consumed.length).toBeGreaterThan(0);
    }
    expect(entries[0].projectionConsumption.marker.deliveryId).not.toBe(
      entries[1].projectionConsumption.marker.deliveryId,
    );
  });

  it("keeps the one-shot observation slot open until an admissible name arrives", async () => {
    // THE LOCKOUT, end to end through the real interceptor: the observation
    // is recorded once per fence, so a name that could never be admitted must
    // not burn the slot. Searching a directory and then reading a file in it
    // is ordinary agent behavior, and the predicate's unit test cannot prove
    // the slot survives — only the binary's write path can.
    const gateRecordPath = gateRecord("lockout");
    const session = await openSession();

    // A grep over the skills directory: names a DIRECTORY, which the receipt
    // never lists, plus a free-text pattern naming a real receipted entry.
    await intercept(session, "pre-tool-use", {
      tool_name: "Grep",
      tool_input: {
        pattern: ".managed-projection/consumption.json",
        path: path.join(session.worktree, PROJECTION_DIR, "skills"),
      },
    });
    const afterSearch = await facade.recordProjectionConsumption({
      deliveryId: session.deliveryId,
      gateRecordPath,
      category: "code",
    });
    must(afterSearch, "recordProjectionConsumption (after the search)");
    expect(afterSearch.emitted).toBe(false);

    // The honest read that follows is still recorded, and the delivery counts.
    await consumeProjection(session);
    const afterRead = await facade.recordProjectionConsumption({
      deliveryId: session.deliveryId,
      gateRecordPath,
      category: "code",
    });
    must(afterRead, "recordProjectionConsumption (after the read)");
    expect(afterRead.emitted).toBe(true);
    const entries = entriesIn(gateRecordPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].projectionConsumption.marker.deliveryId).toBe(session.deliveryId);
  });

  it("writes no entry for a delivery whose run never reached into the projection", async () => {
    const gateRecordPath = gateRecord("untouched");
    const session = await openSession();

    // A fully bound delivery: the projection is materialized, the receipt
    // matches, the marker names this run. What has NOT happened is the run
    // reaching into the subtree — the state of a shadow delivery that
    // resolved everything from ambient discovery. The gate must not be handed
    // an affirmation of something nobody observed.
    const recorded = await facade.recordProjectionConsumption({
      deliveryId: session.deliveryId,
      gateRecordPath,
      category: "code",
    });
    must(recorded, "recordProjectionConsumption");
    expect(recorded.emitted).toBe(false);
    if (recorded.emitted) return;
    expect(recorded.reason).toBe("projection-not-consumed");
    expect(entriesIn(gateRecordPath)).toEqual([]);

    // And the same delivery, after the interceptor observes the read, records.
    await consumeProjection(session);
    const afterRead = await facade.recordProjectionConsumption({
      deliveryId: session.deliveryId,
      gateRecordPath,
      category: "code",
    });
    must(afterRead, "recordProjectionConsumption (after the read)");
    expect(afterRead.emitted).toBe(true);
    expect(entriesIn(gateRecordPath).map((entry) => entry.id)).toEqual([session.deliveryId]);
  });

  it("writes no entry for a delivery that never materialized a projection", async () => {
    const gateRecordPath = gateRecord("unbound");
    sequence += 1;
    const presented = await facade.presentContract({
      contract: { ...DISPOSABLE_CONTRACT, contractId: `contract-cc-${sequence}` },
      expiry: EXPIRY,
    });
    must(presented, "presentContract");
    const confirmed = await facade.confirmContract({
      intakeId: presented.intakeId,
      echo: operatorEcho(presented.channelPath),
    });
    must(confirmed, "confirmContract");

    // No workspace, so no projection and nothing for the binding to observe.
    // The delivery carries no affirmative record and stays out of the
    // comparison set — the writer never invents one from the call itself.
    const recorded = await facade.recordProjectionConsumption({
      deliveryId: confirmed.deliveryId,
      gateRecordPath,
      category: "code",
    });
    expect(recorded.ok).toBe(false);
    expect(entriesIn(gateRecordPath)).toEqual([]);
  });

  it("writes no entry when the projection the binding materialized is gone", async () => {
    const gateRecordPath = gateRecord("torn-down");
    const session = await openSession();
    must(await facade.tearDownWorkspaceProjection({ deliveryId: session.deliveryId }), "tearDownWorkspaceProjection");

    // The canonical recheck refuses the torn-down workspace outright — a
    // consumption record is never written past a workspace-integrity refusal.
    const recorded = await facade.recordProjectionConsumption({
      deliveryId: session.deliveryId,
      gateRecordPath,
      category: "code",
    });
    expect(recorded.ok).toBe(false);
    expect(entriesIn(gateRecordPath)).toEqual([]);
  });

  /**
   * The regression pin for an attestation that expires against the AMBIENT
   * clock.
   *
   * This class of failure is invisible to every clock-injected test by
   * construction: the facade takes its instant as an argument, so an expiry
   * written as a literal is compared against another literal and stays valid
   * forever. The interceptor is spawned, reads the wall clock, and compares
   * against that instead — so an expiry can be simultaneously valid to the
   * binding that minted it and expired to the interceptor that enforces it.
   * Nothing below may substitute a fixture for that binary.
   *
   * Both directions are pinned in one test on purpose. An interceptor that
   * always denied, and a writer that always emitted, would each satisfy one
   * half of this on its own; only the pair distinguishes the mechanism from a
   * constant.
   */
  it("denies the invocation at the spawned interceptor and records nothing once the attestation expires on the ambient clock", async () => {
    const gateRecordPath = gateRecord("ambient-expiry");

    // The affirmative half: an attestation still valid on the wall clock is
    // admitted, and the consumption becomes an entry.
    const live = await openSession();
    expect(await consumeProjection(live)).toBe("");
    const emitted = await facade.recordProjectionConsumption({
      deliveryId: live.deliveryId,
      gateRecordPath,
      category: "code",
    });
    must(emitted, "recordProjectionConsumption (ambient-valid attestation)");
    expect(emitted.emitted).toBe(true);

    // The negative half: the SAME rig, differing only in an expiry the binding
    // still mints under the injected `NOW` but the interceptor sees as past.
    const stale = await openSession(AMBIENT_EXPIRED);
    const rendered = await consumeProjection(stale);

    // An admitted invocation renders nothing, so an empty string here IS the
    // regression — asserted before the parse, which would otherwise fail as a
    // syntax error pointing at the wrong thing.
    expect(rendered).not.toBe("");

    // Admission-level, not merely denied: a superseded fence and an unattested
    // state file are refused earlier and render a different reason.
    const decision = JSON.parse(rendered) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("not_admitted");

    // What ties that denial to the EXPIRY rather than to any other admission
    // mismatch. The rendered reason cannot: every admission failure collapses
    // into the one `not_admitted` string, and the specific codes live in a
    // nested field the hook does not emit. So the expiry is named where it is
    // observable — in the attested state the interceptor just read. Together
    // with `live`, which differs from this session in that argument alone, the
    // pair is what makes the denial attributable.
    const staleBindingState = JSON.parse(
      readFileSync(await bindingStatePath(stale.deliveryId), "utf8"),
    ) as { attestation: { expiry: string } };
    expect(staleBindingState.attestation.expiry).toBe(AMBIENT_EXPIRED);

    // And the consequence the operator actually pays for: no observation, so
    // the delivery stays out of the comparison set rather than affirming.
    const unobserved = await facade.recordProjectionConsumption({
      deliveryId: stale.deliveryId,
      gateRecordPath,
      category: "code",
    });
    must(unobserved, "recordProjectionConsumption (ambient-expired attestation)");
    expect(unobserved.emitted).toBe(false);
    expect(entriesIn(gateRecordPath).map((entry) => entry.id)).toEqual([live.deliveryId]);
  });
});
