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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfirmationEchoAttempt, RenderedConfirmationChallenge } from "../binding/host-admission.ts";
import { createJournalStore } from "../checkpoint/journal-store.ts";
import { PROJECTION_DIR } from "../host/claude-code.ts";
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
  typedStageResultBytes,
} from "./disposable-repository.fixture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const FIXTURES = path.join(REPO_ROOT, "qualifications", "fixtures");

const NOW = "2026-08-30T12:00:00Z";
const LATER = "2026-08-30T12:00:30Z";
const EXPIRY = "2026-08-31T12:00:00Z";
const HOST_VERSION = "2.1.97";

/** The graded finding this unit inherits as its characterization baseline. */
const GRADED_DESCENDANT_TEARDOWN = "unverified" as const;

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

async function openSession(): Promise<Session> {
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
    attestationExpiry: EXPIRY,
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

const bindingState = async (deliveryId: string): Promise<HookBindingState> => {
  const namespaceDir = await facade.namespaceDir();
  return JSON.parse(
    readFileSync(path.join(namespaceDir, "deliveries", deliveryId, "binding", "state.json"), "utf8"),
  ) as HookBindingState;
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
    expect(decideHookInvocation(state, { tool_name: "Read", tool_input: {} }, LATER).allowed).toBe(true);
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
      path.join(namespaceDir, "deliveries", session.deliveryId, "binding", "state.json"),
      path.join(namespaceDir, "deliveries", session.deliveryId, "binding", "settings.json"),
      path.join(session.worktree, ".claude", "settings.json"),
      path.join(session.worktree, PROJECTION_DIR, "consumption.json"),
    ];
    for (const file_path of attempts) {
      expect(decideHookInvocation(state, { tool_name: "Write", tool_input: { file_path } }, LATER).allowed, file_path).toBe(
        false,
      );
    }

    // And the confirmation channel is closed to it even by name.
    expect(
      decideHookInvocation(state, { tool_name: "operator-confirmation.contract", tool_input: {} }, LATER).allowed,
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
    expect(status.resume).toBe("takeover-required");
    // The delivery checkpoint itself did not move.
    expect(status.state).toBe("planning");
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
    expect(after.state).toBe(before.state);
    expect(after.resume).toBe("takeover-required");
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
    const planted = JSON.parse(readFileSync(path.join(bindingDir, "state.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(
      path.join(bindingDir, "state.json"),
      `${JSON.stringify({ ...planted, descendantTeardown: "verified", tier: 3 })}\n`,
    );
    writeFileSync(path.join(session.worktree, "descendantTeardown"), "verified\n");

    const ended = await facade.recordTerminationProvenance({ deliveryId: session.deliveryId, fence: session.fence });
    must(ended, "recordTerminationProvenance");
    // The graded record inside the pinned generation says otherwise, and it is
    // the only thing consulted.
    expect(ended.descendantTeardown).toBe("unverified");
    expect(ended.resumeEligibility).toBe("fresh-worktree-only");

    const status = await facade.status({ deliveryId: session.deliveryId, observedAt: LATER });
    must(status, "status");
    expect(status.resume).toBe("takeover-required");
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
    expect(status.resume).toBe("same-workspace");
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
    expect(decideHookInvocation(state, { tool_name: "Read", tool_input: {} }, LATER).allowed).toBe(false);

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
    });
    must(rebound, "rebind");
    expect(rebound.fence).toBeGreaterThan(session.fence);
    expect(rebound.projectionDigest).not.toBe(staleState.expectation.projectionDigest);

    // THE STALE SESSION, as it actually is on disk. The binding state file is
    // per-delivery and the rebind overwrote it, so the superseded session's
    // hook re-reads a state file describing the FRESH invocation — a
    // consistent grant and attestation whose workspace root is the fresh
    // worktree. What stops it is the fence baked into its OWN hook command at
    // admission: it no longer matches, so every tool closes.
    const current = await bindingState(session.deliveryId);
    expect(current.expectation.invocationFence).toBe(rebound.fence);
    const supersededSession = decideHookInvocation(
      current,
      { tool_name: "Read", tool_input: {} },
      LATER,
      session.fence, // the fence THIS session was admitted under
    );
    expect(supersededSession.allowed).toBe(false);
    if (!supersededSession.allowed) expect(supersededSession.reason).toContain("superseded_session");

    // A write is refused for the same reason, so the superseded session keeps
    // no write path into the newly authorized workspace either.
    expect(
      decideHookInvocation(
        current,
        { tool_name: "Write", tool_input: { file_path: path.join(fresh, "src", "greet.mjs") } },
        LATER,
        session.fence,
      ).allowed,
    ).toBe(false);
    // The fresh session, admitted under the current fence, proceeds.
    expect(decideHookInvocation(current, { tool_name: "Read", tool_input: {} }, LATER, rebound.fence).allowed).toBe(true);
    // The stale session's own settings baked its own fence, so the two
    // sessions are distinguishable at all: the composed hook command carries it.
    expect(staleState.expectation.invocationFence).toBe(session.fence);

    // And the stale worktree's projection is not the fresh one: its per-run
    // marker still names the superseded fence.
    const staleMarker = JSON.parse(
      readFileSync(path.join(staleWorktree, PROJECTION_DIR, "consumption.json"), "utf8"),
    ) as { fence: number };
    expect(staleMarker.fence).toBe(session.fence);

    // The fresh session continues from the last trustworthy checkpoint.
    const status = await facade.status({ deliveryId: session.deliveryId, observedAt: LATER });
    must(status, "status");
    expect(status.fence).toBe(rebound.fence);
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
    const denied = decideHookInvocation(state, { tool_name: "WebFetch", tool_input: {} }, LATER);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toContain("capability_not_granted");

    // A missing binding state — the shape a failed grant application leaves —
    // denies everything.
    expect(decideHookInvocation(undefined, { tool_name: "Read", tool_input: {} }, LATER).allowed).toBe(false);
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
    const state = readFileSync(path.join(namespaceDir, "deliveries", session.deliveryId, "binding", "state.json"), "utf8");
    expect(state).not.toMatch(/token|password|secret|credential/i);
  });
});

describe("teardown with the worktree", () => {
  it("leaves no binding-written projection or discovery configuration behind", async () => {
    const session = await openSession();
    const namespaceDir = await facade.namespaceDir();
    const bindingDir = path.join(namespaceDir, "deliveries", session.deliveryId, "binding");

    expect(existsSync(path.join(session.worktree, PROJECTION_DIR))).toBe(true);
    expect(existsSync(path.join(bindingDir, "settings.json"))).toBe(true);

    const torn = await facade.tearDownWorkspaceProjection({ deliveryId: session.deliveryId });
    must(torn, "tearDownWorkspaceProjection");

    expect(existsSync(path.join(session.worktree, PROJECTION_DIR))).toBe(false);
    expect(existsSync(path.join(bindingDir, "settings.json"))).toBe(false);
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
    // It runs git and the repository's own sensor, and nothing that creates,
    // moves, or removes a worktree — the host owns workspace lifecycle.
    expect([...new Set(executables)].sort()).toEqual(["git", "node"]);
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
    expect(decideHookInvocation(state, { tool_name: "Write", tool_input: { file_path: graphPath } }, LATER).allowed).toBe(
      false,
    );
    mkdirSync(path.join(session.worktree, "src"), { recursive: true });
    expect(
      decideHookInvocation(
        state,
        { tool_name: "Write", tool_input: { file_path: path.join(session.worktree, "src", "greet.mjs") } },
        LATER,
      ).allowed,
    ).toBe(true);
  });
});
