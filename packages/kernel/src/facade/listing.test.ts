/**
 * The installation-scoped listing mode of the status surface.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT A SCENARIO. The listing reads durable
 * state that already exists: one registration marker, one reduced journal, the
 * bound workspace's declared lifetime, and the binding's freshness heartbeat.
 * Driving a delivery through the whole skeleton to produce those bytes would
 * pin the skeleton, not the listing, and would make the two cases this mode
 * exists for — an installation with NOTHING registered, and one with SEVERAL
 * deliveries — the two hardest cases to reach. So the journals here are built
 * through the real append path (`createJournalStore`, the frozen reducer
 * judging every entry), and the listing is asked about them.
 *
 * EVERY ROW ASSERTS WHAT THE LISTING CONTAINS. An assertion that something is
 * absent passes for free when the mechanism is missing entirely, so an absence
 * row here always stands beside the presence it is distinguished from: the
 * cross-installation row asserts the OTHER installation's delivery is missing
 * AND this one's is present, and the aged row asserts `unknown` beside a fresh
 * delivery reading `active` from the same call.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createJournalStore } from "../checkpoint/journal-store.ts";
import { JOURNAL_ENTRY_SPEC } from "../spine/journal.ts";
import { compiledAdopterPolicyBindingDigest, createManagedDeliveryFacade, type ManagedDeliveryFacade } from "./managed-delivery.ts";
import { disposablePolicyBinding } from "./disposable-repository.fixture.ts";
import { DEFAULT_OBSERVATION_LIFETIME_SECONDS } from "./liveness.ts";

const DIGEST = "a".repeat(64);
/**
 * The binding digest every installation here is built from. The fixtures write
 * it into BOTH durable records — the registration marker and the journal —
 * because that is the precondition `status` enforces before it will report on a
 * delivery at all: a fixture carrying any other digest is a delivery the
 * product refuses, and a suite built on those would pin the listing against
 * deliveries no operator can ever ask `status` about.
 */
const BINDING_DIGEST = compiledAdopterPolicyBindingDigest(disposablePolicyBinding());
const DIGEST2 = "c".repeat(64);
const OID = "b".repeat(40);

const scratchRoots: string[] = [];

/** A scratch git repository and the facade bound to it. Nothing is shared between two of them. */
function installation(): { readonly repoDir: string; readonly namespace: string; readonly facade: ManagedDeliveryFacade } {
  const repoDir = mkdtempSync(path.join(tmpdir(), "listing-"));
  scratchRoots.push(repoDir);
  execFileSync("git", ["init", "--quiet", repoDir]);
  const facade = createManagedDeliveryFacade({
    repoDir,
    policyBinding: disposablePolicyBinding(),
    installation: { installationPath: path.join(repoDir, "installation"), receiptDir: path.join(repoDir, "receipts") },
    hostVersion: "listing-test",
  });
  return { repoDir, namespace: path.join(repoDir, ".git", "managed-delivery"), facade };
}

const entry = (deliveryId: string, revision: number, kind: string, payload: Record<string, unknown>) => ({
  spec: JOURNAL_ENTRY_SPEC,
  journal: "delivery" as const,
  subjectId: deliveryId,
  expectedRevision: revision,
  idempotencyKey: `key-${revision}-${kind}`,
  kind,
  payload,
});

/**
 * The entries every delivery below opens with: registered, policy bound,
 * generation pinned, into `preparing`, workspace bound, and fenced at fence 1
 * declaring `lifetimeSeconds`. Revision stands at 6 afterwards.
 */
const opening = (deliveryId: string, lifetimeSeconds: number) => [
  entry(deliveryId, 0, "delivery.registered", {
    contractDigest: DIGEST,
    intakeId: "intake-1",
    confirmationNonce: "nonce-1",
    activeCompositionProfile: "core",
    registeringInstallationId: "install-1",
  }),
  entry(deliveryId, 1, "policy.snapshot.bound", {
    policyDigest: DIGEST,
    repositoryAuthorityEpoch: 4,
    policyBindingDigest: BINDING_DIGEST,
  }),
  entry(deliveryId, 2, "generation.pinned", { generationDigest: DIGEST2, releaseId: "core-v1", profile: "core" }),
  entry(deliveryId, 3, "transition.committed", { from: "accepted", to: "preparing" }),
  entry(deliveryId, 4, "workspace.bound", {
    workspaceId: "workspace-1",
    repositoryId: "repo-1",
    baseRef: "refs/heads/main",
    baseTipSha: OID,
    branchRef: `refs/heads/${deliveryId}`,
    branchRefValue: OID,
    worktreeId: "worktree-1",
    baselineClassification: "clean",
  }),
  entry(deliveryId, 5, "invocation.fenced", {
    fence: 1,
    hostTaskId: "task-1",
    worktreeId: "worktree-1",
    candidateTreeSha: OID,
    candidateBranchRefValue: OID,
    policyDigest: DIGEST,
    authorityEpoch: 4,
    observationLifetimeSeconds: lifetimeSeconds,
  }),
];

interface RegisterInput {
  readonly deliveryId: string;
  readonly entries: readonly ReturnType<typeof entry>[];
  /** Written only when given; absent means no workspace is bound. */
  readonly workspace?: { readonly observationLifetimeSeconds: number };
  /** The binding's freshness heartbeat, written only when given. */
  readonly observation?: { readonly fence: number; readonly observedAt: string };
  /** Overrides the registration marker's binding digest, to build drift. */
  readonly markerBindingDigest?: string;
}

/**
 * Stamps one delivery into an installation's namespace through the real
 * append path: every entry below is judged by the frozen reducer, so a journal
 * this helper writes is one the product could have written.
 *
 * `delivery.json` is the registration marker the listing reads to tell a
 * registered delivery from a stray directory; its contents are the facade's
 * business and nothing in the listing reads them.
 */
async function register(namespace: string, input: RegisterInput): Promise<void> {
  const dir = path.join(namespace, "deliveries", input.deliveryId);
  mkdirSync(path.join(dir, "binding"), { recursive: true });
  writeFileSync(
    path.join(dir, "delivery.json"),
    `${JSON.stringify({ intakeId: "intake-1", policyBindingDigest: input.markerBindingDigest ?? BINDING_DIGEST })}\n`,
  );
  const store = createJournalStore(path.join(dir, "journal.jsonl"));
  for (const candidate of input.entries) {
    const appended = await store.append(candidate);
    expect(appended.ok, `${input.deliveryId} ${candidate.kind}: ${JSON.stringify(appended)}`).toBe(true);
  }
  if (input.workspace !== undefined) {
    writeFileSync(
      path.join(dir, "workspace.json"),
      `${JSON.stringify({ worktreeDir: path.join(namespace, "wt"), workspaceId: "workspace-1", fence: 1, ...input.workspace })}\n`,
    );
  }
  if (input.observation !== undefined) {
    writeFileSync(path.join(dir, "binding", "observation.json"), `${JSON.stringify(input.observation)}\n`);
  }
}

afterAll(() => {
  // Only directories this file itself created, by the paths it recorded.
  for (const root of scratchRoots) execFileSync("rm", ["-rf", root]);
});

describe("the installation-scoped listing", () => {
  it("lists empty for an installation that has registered nothing", async () => {
    const { facade } = installation();
    const listing = await facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(listing.ok, JSON.stringify(listing)).toBe(true);
    if (!listing.ok) return;
    // Quiet is an ANSWER, not a refusal: the one surface that reports
    // installation-wide quiet must be available when the installation is quiet.
    expect(listing.deliveries).toEqual([]);
    expect(listing.unreadable).toEqual([]);
  });

  it("lists an active delivery and a terminal one, each with its own state", async () => {
    const { namespace, facade } = installation();
    await register(namespace, {
      deliveryId: "delivery-live",
      entries: [
        ...opening("delivery-live", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
        entry("delivery-live", 6, "activity.observed", { activity: "active", fence: 1 }),
        entry("delivery-live", 6, "transition.committed", { from: "preparing", to: "planning" }),
      ],
      workspace: { observationLifetimeSeconds: DEFAULT_OBSERVATION_LIFETIME_SECONDS },
      observation: { fence: 1, observedAt: "2026-09-14T11:59:00Z" },
    });
    await register(namespace, {
      deliveryId: "delivery-gone",
      entries: [
        ...opening("delivery-gone", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
        entry("delivery-gone", 6, "transition.committed", { from: "preparing", to: "cancellation_requested" }),
        entry("delivery-gone", 7, "workspace.disposition.recorded", { workspaceId: "workspace-1", disposition: "quarantined" }),
        entry("delivery-gone", 8, "transition.committed", { from: "cancellation_requested", to: "cancelled" }),
      ],
      // A heartbeat file is left on disk but NO workspace is bound. The stamp
      // must not be reported: a heartbeat belonging to a workspace that is gone
      // is not this delivery's freshness. Without this the `workspace ===
      // undefined` gate would be satisfied by an absent file rather than by the
      // gate itself.
      observation: { fence: 1, observedAt: "2026-09-14T11:59:00Z" },
    });

    // The inventory declares this operation `read`, `absent-by-state`, `none`.
    // A mutation that changes a RETURNED value is caught by every other row
    // here; a write that changes nothing returned is caught only by this one.
    // THE WHOLE NAMESPACE, not one delivery. `delivery-live` is the only
    // fixture that takes every happy branch of the loop, so a write that fires
    // on a branch it does not take — a "self-healing" heartbeat stamped for a
    // delivery that has none, say — would be invisible to a row that watched
    // only that directory. This root holds `delivery-gone` too (no workspace,
    // a stale stamp on disk) and the root itself.
    const deliveriesRoot = path.join(namespace, "deliveries");
    // CONTENTS, not names. A file list catches a file the read invents, but
    // the write that would actually matter is an OVERWRITE of a file already
    // there — `binding/observation.json` above all, the heartbeat this read
    // grades from and the one `status` grades from too. A listing that stamped
    // it would fabricate liveness for every delivery on every read, and a
    // name-only comparison would not notice.
    const snapshot = (dir: string): string[] =>
      readdirSync(dir, { recursive: true })
        .map(String)
        .sort()
        .map((relative) => {
          const full = path.join(dir, relative);
          return `${relative}:${statSync(full).isDirectory() ? "" : readFileSync(full, "utf8")}`;
        });
    const before = snapshot(deliveriesRoot);

    const listing = await facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(listing.ok, JSON.stringify(listing)).toBe(true);
    if (!listing.ok) return;
    expect(listing.deliveries.map((listed) => listed.deliveryId)).toEqual(["delivery-gone", "delivery-live"]);

    // Not one byte, and not one file: no journal revision, no fabricated
    // heartbeat, nothing stamped on the way past.
    expect(snapshot(deliveriesRoot)).toEqual(before);

    const live = listing.deliveries.find((listed) => listed.deliveryId === "delivery-live");
    expect(live?.state).toBe("planning");
    expect(live?.lastActivity.activity).toBe("active");
    expect(live?.lastActivity.observedAt).toBe("2026-09-14T11:59:00Z");
    expect(live?.pendingDecision).toBeUndefined();

    // Exactly four members, and it stays four: this row is what fails when the
    // listing starts growing, one plausible member at a time, into a second
    // status model that can disagree with the first.
    expect(Object.keys(live as object).sort()).toEqual(["deliveryId", "lastActivity", "pendingDecision", "state"]);

    // THE OTHER MODE OF THE SAME SURFACE, on the same delivery, in the same
    // test: the listing is only "a mode of status" if the two agree. This is
    // also what makes the fixtures honest — a delivery `status` refuses is one
    // this row could not make this assertion about at all.
    const perDelivery = await facade.status({ deliveryId: "delivery-live", observedAt: "2026-09-14T12:00:00Z" });
    expect(perDelivery.ok, JSON.stringify(perDelivery)).toBe(true);
    if (!perDelivery.ok) return;
    expect(perDelivery.status.delivery.state).toBe(live?.state);
    expect(perDelivery.status.hostActivity).toBe(live?.lastActivity.activity);

    const gone = listing.deliveries.find((listed) => listed.deliveryId === "delivery-gone");
    expect(gone?.state).toBe("cancelled");
    // No workspace was ever written for it, so there is no heartbeat to
    // report — which is a different thing from a heartbeat that is old.
    expect(gone?.lastActivity.observedAt).toBeUndefined();
    expect(gone?.lastActivity.activity).toBe("unknown");
  });

  it("reads an observation aged past its declared lifetime as unknown, beside a fresh one reading active", async () => {
    const { namespace, facade } = installation();
    const lifetimeSeconds = 30;
    for (const [deliveryId, activity, observedAt] of [
      ["delivery-fresh", "active", "2026-09-14T11:59:45Z"],
      ["delivery-aged", "active", "2026-09-14T11:50:00Z"],
      // Stale by exactly the same margin as the aged one, and reported as
      // `paused` rather than `unknown`: a host that ended cleanly SAID so, and
      // aging a clean end into "we don't know" would lose the one liveness
      // answer an operator can act on without investigating.
      ["delivery-paused", "paused", "2026-09-14T11:50:00Z"],
    ] as const) {
      await register(namespace, {
        deliveryId,
        entries: [
          ...opening(deliveryId, lifetimeSeconds),
          entry(deliveryId, 6, "activity.observed", { activity, fence: 1 }),
        ],
        workspace: { observationLifetimeSeconds: lifetimeSeconds },
        observation: { fence: 1, observedAt },
      });
    }

    const listing = await facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(listing.ok, JSON.stringify(listing)).toBe(true);
    if (!listing.ok) return;
    const byId = new Map(listing.deliveries.map((listed) => [listed.deliveryId, listed]));
    // Both journals say `active` and both are graded on THIS read. The only
    // difference between them is the age of the heartbeat, which is the
    // lazily-resolved aging rule the per-delivery status model applies.
    expect(byId.get("delivery-fresh")?.lastActivity.activity).toBe("active");
    expect(byId.get("delivery-aged")?.lastActivity.activity).toBe("unknown");
    // The stamp is still reported for the aged one: an operator is told HOW
    // stale, not merely that the answer is unknown.
    expect(byId.get("delivery-aged")?.lastActivity.observedAt).toBe("2026-09-14T11:50:00Z");
    expect(byId.get("delivery-aged")?.state).toBe("preparing");
    // The third grade the surface can report, beside the other two from the
    // same call: aging applies to `active` alone.
    expect(byId.get("delivery-paused")?.lastActivity.activity).toBe("paused");
    expect(byId.get("delivery-paused")?.lastActivity.observedAt).toBe("2026-09-14T11:50:00Z");
  });

  it("reports no stamp for a heartbeat written under a superseded fence, beside a fresh one that reports its own", async () => {
    const { namespace, facade } = installation();
    const refenced = (deliveryId: string) =>
      entry(deliveryId, 6, "invocation.fenced", {
        fence: 2,
        hostTaskId: "task-2",
        worktreeId: "worktree-1",
        candidateTreeSha: OID,
        candidateBranchRefValue: OID,
        policyDigest: DIGEST,
        authorityEpoch: 4,
        observationLifetimeSeconds: DEFAULT_OBSERVATION_LIFETIME_SECONDS,
      });
    // Its journal says `active` and its heartbeat is SECONDS old — but both
    // belong to fence 1, and the delivery now stands at fence 2. Nothing has
    // reported under the fence that is current.
    await register(namespace, {
      deliveryId: "delivery-refenced",
      entries: [
        ...opening("delivery-refenced", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
        entry("delivery-refenced", 6, "activity.observed", { activity: "active", fence: 1 }),
        refenced("delivery-refenced"),
      ],
      workspace: { observationLifetimeSeconds: DEFAULT_OBSERVATION_LIFETIME_SECONDS },
      observation: { fence: 1, observedAt: "2026-09-14T11:59:55Z" },
    });
    // Re-fenced AND heard from since: its heartbeat stands for the fence that
    // is current, so the stamp is evidence and IS reported. Without this the
    // comparison would be pinned on its deny side alone, and a listing that
    // withheld the stamp from every re-fenced delivery would pass.
    await register(namespace, {
      deliveryId: "delivery-rebound",
      entries: [
        ...opening("delivery-rebound", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
        refenced("delivery-rebound"),
        entry("delivery-rebound", 7, "activity.observed", { activity: "active", fence: 2 }),
      ],
      workspace: { observationLifetimeSeconds: DEFAULT_OBSERVATION_LIFETIME_SECONDS },
      observation: { fence: 2, observedAt: "2026-09-14T11:59:50Z" },
    });
    await register(namespace, {
      deliveryId: "delivery-current",
      entries: [
        ...opening("delivery-current", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
        entry("delivery-current", 6, "activity.observed", { activity: "active", fence: 1 }),
      ],
      workspace: { observationLifetimeSeconds: DEFAULT_OBSERVATION_LIFETIME_SECONDS },
      observation: { fence: 1, observedAt: "2026-09-14T11:59:55Z" },
    });

    const listing = await facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(listing.ok, JSON.stringify(listing)).toBe(true);
    if (!listing.ok) return;
    const byId = new Map(listing.deliveries.map((listed) => [listed.deliveryId, listed]));
    // The grade the shared rule already returns: a superseded fence is not
    // evidence of anything.
    expect(byId.get("delivery-refenced")?.lastActivity.activity).toBe("unknown");
    // And the stamp is withheld with it, so the surface never pairs "unknown"
    // with a reassuringly recent time. Without the fence comparison in the
    // listing this reads "2026-09-14T11:59:55Z".
    expect(byId.get("delivery-refenced")?.lastActivity.observedAt).toBeUndefined();
    // Beside an identical delivery that was NOT re-fenced: the difference is
    // the fence and nothing else, so a listing that simply dropped every stamp
    // would fail here.
    expect(byId.get("delivery-current")?.lastActivity.activity).toBe("active");
    expect(byId.get("delivery-current")?.lastActivity.observedAt).toBe("2026-09-14T11:59:55Z");
    // And the allow side at a fence ABOVE one: the rule is "the stamp the
    // current fence was graded from", not "fence 1".
    expect(byId.get("delivery-rebound")?.lastActivity.activity).toBe("active");
    expect(byId.get("delivery-rebound")?.lastActivity.observedAt).toBe("2026-09-14T11:59:50Z");
  });

  it("names the pending decision a delivery is waiting on", async () => {
    const { namespace, facade } = installation();
    await register(namespace, {
      deliveryId: "delivery-waiting",
      entries: [
        ...opening("delivery-waiting", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
        entry("delivery-waiting", 6, "transition.committed", { from: "preparing", to: "planning" }),
        entry("delivery-waiting", 7, "transition.committed", { from: "planning", to: "implementing" }),
        entry("delivery-waiting", 8, "transition.committed", { from: "implementing", to: "validating" }),
        entry("delivery-waiting", 9, "transition.committed", { from: "validating", to: "reviewing" }),
        entry("delivery-waiting", 10, "approval.request.recorded", {
          requestKind: "waiver",
          criterionId: "greeting-behavior",
          actorId: "operator-1",
          reason: "criterion discharged by upstream fix; waiver proposed",
        }),
      ],
    });

    // The same journal, plus the typed voiding blocker a candidate change
    // appends. The proposal is answered — an operator sent here would be sent
    // to a delivery waiting on nothing.
    await register(namespace, {
      deliveryId: "delivery-decided",
      entries: [
        ...opening("delivery-decided", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
        entry("delivery-decided", 6, "transition.committed", { from: "preparing", to: "planning" }),
        entry("delivery-decided", 7, "transition.committed", { from: "planning", to: "implementing" }),
        entry("delivery-decided", 8, "transition.committed", { from: "implementing", to: "validating" }),
        entry("delivery-decided", 9, "transition.committed", { from: "validating", to: "reviewing" }),
        entry("delivery-decided", 10, "approval.request.recorded", {
          requestKind: "waiver",
          criterionId: "greeting-behavior",
          actorId: "operator-1",
          reason: "criterion discharged by upstream fix; waiver proposed",
        }),
        entry("delivery-decided", 11, "blocker.recorded", {
          code: "approval.proposal-voided",
          summary: "the candidate changed since the criterion was proposed; the stale proposal is void",
        }),
      ],
    });

    const listing = await facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(listing.ok, JSON.stringify(listing)).toBe(true);
    if (!listing.ok) return;
    const waiting = listing.deliveries.find((listed) => listed.deliveryId === "delivery-waiting");
    expect(waiting?.state).toBe("reviewing");
    // The proposal itself, not a boolean: an operator deciding which delivery
    // to attend to needs to know WHAT is pending and against which criterion.
    expect(waiting?.pendingDecision).toEqual({
      requestKind: "waiver",
      criterionId: "greeting-behavior",
      actorId: "operator-1",
      candidateTreeSha: OID,
    });
    // Pinned beside it, from the same call: the ledger's answer, not merely
    // "a proposal was once recorded".
    const decided = listing.deliveries.find((listed) => listed.deliveryId === "delivery-decided");
    expect(decided?.state).toBe("reviewing");
    expect(decided?.pendingDecision).toBeUndefined();
  });

  it("names no delivery from another installation", async () => {
    const here = installation();
    const elsewhere = installation();
    await register(here.namespace, {
      deliveryId: "delivery-here",
      entries: opening("delivery-here", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
    });
    await register(elsewhere.namespace, {
      deliveryId: "delivery-elsewhere",
      entries: opening("delivery-elsewhere", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
    });

    const listing = await here.facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(listing.ok, JSON.stringify(listing)).toBe(true);
    if (!listing.ok) return;
    // Presence and absence in the same assertion: a listing that returned
    // nothing at all would satisfy the absence half for free.
    expect(listing.deliveries.map((listed) => listed.deliveryId)).toEqual(["delivery-here"]);

    // And the other installation sees only its own, so the separation is a
    // property of each namespace rather than of one lucky read.
    const other = await elsewhere.facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.deliveries.map((listed) => listed.deliveryId)).toEqual(["delivery-elsewhere"]);
  });

  it("names a delivery whose durable binding records disagree, rather than reporting a state `status` refuses to report", async () => {
    const { namespace, facade } = installation();
    await register(namespace, {
      deliveryId: "delivery-bound",
      entries: opening("delivery-bound", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
    });
    // Registered under a binding this facade is not holding. `status` refuses
    // this delivery outright; the listing must not answer for it either.
    await register(namespace, {
      deliveryId: "delivery-drifted",
      entries: opening("delivery-drifted", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
      markerBindingDigest: "d".repeat(64),
    });

    // The case that actually happens: a delivery registered before the adopter
    // policy changed. Its two durable records AGREE with each other and both
    // disagree with the facade — so a comparison that only checked the two
    // records against each other would list it with full state while `status`
    // refuses it.
    const foreign = "e".repeat(64);
    await register(namespace, {
      deliveryId: "delivery-stale-policy",
      entries: opening("delivery-stale-policy", DEFAULT_OBSERVATION_LIFETIME_SECONDS).map((candidate) =>
        candidate.kind === "policy.snapshot.bound"
          ? { ...candidate, payload: { ...candidate.payload, policyBindingDigest: foreign } }
          : candidate,
      ),
      markerBindingDigest: foreign,
    });

    const stale = await facade.status({ deliveryId: "delivery-stale-policy", observedAt: "2026-09-14T12:00:00Z" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.blockers.map((blocker) => blocker.code)).toEqual(["policy_binding_mismatch"]);

    const drifted = await facade.status({ deliveryId: "delivery-drifted", observedAt: "2026-09-14T12:00:00Z" });
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.blockers.map((blocker) => blocker.code)).toEqual(["policy_binding_mismatch"]);

    const listing = await facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(listing.ok, JSON.stringify(listing)).toBe(true);
    if (!listing.ok) return;
    // Beside one that DOES bind, from the same call: the separation is the
    // binding comparison, not an empty listing.
    expect(listing.deliveries.map((listed) => listed.deliveryId)).toEqual(["delivery-bound"]);
    expect([...listing.unreadable].sort()).toEqual(["delivery-drifted", "delivery-stale-policy"]);
  });

  it("refuses when the deliveries directory exists and cannot be read, rather than reporting quiet", async () => {
    const { namespace, facade } = installation();
    await register(namespace, {
      deliveryId: "delivery-real",
      entries: opening("delivery-real", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
    });
    const deliveries = path.join(namespace, "deliveries");
    chmodSync(deliveries, 0o000);
    try {
      const listing = await facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
      // "Nothing is running" is a POSITIVE claim. An empty listing here would
      // make it out of a directory the process cannot open — and unlike a
      // delivery it cannot read, there is not even an id left to reconcile by.
      expect(listing.ok, JSON.stringify(listing)).toBe(false);
      if (listing.ok) return;
      expect(listing.blockers.map((blocker) => blocker.code)).toEqual(["delivery_namespace_unreadable"]);
    } finally {
      chmodSync(deliveries, 0o700);
    }
  });

  it("refuses when the deliveries path is not a directory at all", async () => {
    const { namespace, facade } = installation();
    mkdirSync(namespace, { recursive: true });
    // `ENOTDIR`, not `ENOENT`: the path EXISTS and cannot be enumerated. An
    // installation that has registered nothing is the absent case and the only
    // one an empty listing may answer for.
    writeFileSync(path.join(namespace, "deliveries"), "not a directory\n");

    const listing = await facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(listing.ok, JSON.stringify(listing)).toBe(false);
    if (listing.ok) return;
    expect(listing.blockers.map((blocker) => blocker.code)).toEqual(["delivery_namespace_unreadable"]);
  });

  it("names a directory it cannot read rather than listing it with an invented state or dropping it silently", async () => {
    const { namespace, facade } = installation();
    await register(namespace, {
      deliveryId: "delivery-real",
      entries: opening("delivery-real", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
    });
    // No registration record but a PERFECTLY READABLE journal: the crash
    // window between registration's two writes. Only the marker branch can
    // catch this one — with a journal that reduces, the branch below would
    // list it with a state it was never registered to have.
    await register(namespace, {
      deliveryId: "delivery-stray",
      entries: opening("delivery-stray", DEFAULT_OBSERVATION_LIFETIME_SECONDS),
    });
    rmSync(path.join(namespace, "deliveries", "delivery-stray", "delivery.json"));
    // A stray FILE is not a delivery whose state could not be read — it is not
    // a delivery id, and naming it would send an operator to ask `status`
    // about a name no delivery ever had.
    writeFileSync(path.join(namespace, "deliveries", ".DS_Store"), "");
    // Registered, but its journal does not reduce. This is the branch that is
    // otherwise unreachable from any fixture, and the one whose silent drop
    // would contradict the CLI's own count of registered deliveries.
    const brokenDir = path.join(namespace, "deliveries", "delivery-broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "delivery.json"), `${JSON.stringify({ intakeId: "intake-1", policyBindingDigest: DIGEST })}\n`);
    writeFileSync(path.join(brokenDir, "journal.jsonl"), "not a journal entry\n");

    const listing = await facade.listDeliveries({ observedAt: "2026-09-14T12:00:00Z" });
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    // Neither appears as a delivery: a listing entry carries a state, and
    // neither of these has one.
    expect(listing.deliveries.map((listed) => listed.deliveryId)).toEqual(["delivery-real"]);
    // But both are NAMED. An id an operator can pass to `managed status` is
    // what turns "the counts disagree" into a refusal that says why.
    expect([...listing.unreadable].sort()).toEqual(["delivery-broken", "delivery-stray"]);
  });
});
