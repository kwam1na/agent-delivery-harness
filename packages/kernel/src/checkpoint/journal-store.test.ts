/**
 * The checkpoint module's V-slice: ONE append-only durable path over the
 * frozen journal grammar and reducers. The store never re-authors the spine's
 * rules — every append re-reduces the whole journal plus the candidate entry,
 * so an entry the frozen reducer rejects never reaches the file, and bytes
 * already durable are never rewritten.
 *
 * Written RED before `journal-store.ts` existed.
 */
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJournalStore } from "./journal-store.ts";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "journal-store-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const registration = (deliveryId: string) => ({
  spec: "journal-entry/1",
  journal: "delivery",
  subjectId: deliveryId,
  expectedRevision: 0,
  idempotencyKey: "e0-delivery.registered",
  kind: "delivery.registered",
  payload: {
    contractDigest: "a".repeat(64),
    intakeId: "intake-1",
    confirmationNonce: "nonce-1",
    activeCompositionProfile: "confirmation-fixture",
    registeringInstallationId: "install-1",
  },
});

describe("the append-only checkpoint path", () => {
  it("accepts reducer-valid appends and reports the reduced state", async () => {
    const store = createJournalStore(path.join(scratch, "accepts", "journal.jsonl"));
    const first = await store.append(registration("dlv-1"));
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const state = await store.state();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.state.deliveryId).toBe("dlv-1");
    expect(state.state.state).toBe("accepted");
    expect(state.state.expectedRevision).toBe(1);
  });

  it("never rewrites durable bytes — an append only ever extends the file", async () => {
    const journalPath = path.join(scratch, "extends", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-2"))).ok).toBe(true);
    const before = readFileSync(journalPath, "utf8");
    const next = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: "dlv-2",
      expectedRevision: 1,
      idempotencyKey: "e1-generation.pinned",
      kind: "generation.pinned",
      payload: { generationDigest: "b".repeat(64), releaseId: "core-v1", profile: "confirmation-fixture" },
    });
    expect(next.ok, JSON.stringify(next)).toBe(true);
    const after = readFileSync(journalPath, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("refuses an entry the frozen reducer rejects, and writes nothing", async () => {
    const journalPath = path.join(scratch, "refuses", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-3"))).ok).toBe(true);
    const before = readFileSync(journalPath, "utf8");

    const staleRevision = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: "dlv-3",
      expectedRevision: 0, // journal is at 1
      idempotencyKey: "e1-transition.committed",
      kind: "transition.committed",
      payload: { from: "accepted", to: "preparing" },
    });
    expect(staleRevision.ok).toBe(false);
    if (!staleRevision.ok) {
      expect(staleRevision.rejections.map((rejection) => rejection.code)).toContain("revision_mismatch");
    }

    const invalidTransition = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: "dlv-3",
      expectedRevision: 1,
      idempotencyKey: "e1-transition.committed",
      kind: "transition.committed",
      payload: { from: "accepted", to: "reviewing" },
    });
    expect(invalidTransition.ok).toBe(false);

    const reserved = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: "dlv-3",
      expectedRevision: 1,
      idempotencyKey: "e1-termination.provenance.recorded",
      kind: "termination.provenance.recorded",
      payload: {},
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) {
      expect(reserved.rejections.map((rejection) => rejection.code)).toContain("reserved_kind");
    }

    expect(readFileSync(journalPath, "utf8")).toBe(before);
  });

  it("detects a replayed idempotency key instead of double-applying it", async () => {
    const store = createJournalStore(path.join(scratch, "replay", "journal.jsonl"));
    expect((await store.append(registration("dlv-4"))).ok).toBe(true);
    const replay = await store.append(registration("dlv-4"));
    expect(replay.ok).toBe(false);
  });

  it("keeps observation-only appends from advancing the expected revision", async () => {
    const store = createJournalStore(path.join(scratch, "observation", "journal.jsonl"));
    expect((await store.append(registration("dlv-5"))).ok).toBe(true);
    expect(
      (
        await store.append({
          spec: "journal-entry/1",
          journal: "delivery",
          subjectId: "dlv-5",
          expectedRevision: 1,
          idempotencyKey: "e1-invocation.fenced",
          kind: "invocation.fenced",
          payload: {
            fence: 1,
            hostTaskId: "task-1",
            worktreeId: "wt-1",
            candidateTreeSha: "c".repeat(40),
            candidateBranchRefValue: "d".repeat(40),
            policyDigest: "e".repeat(64),
            authorityEpoch: 0,
            observationLifetimeSeconds: 900,
          },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await store.append({
          spec: "journal-entry/1",
          journal: "delivery",
          subjectId: "dlv-5",
          expectedRevision: 2,
          idempotencyKey: "e2-activity.observed",
          kind: "activity.observed",
          payload: { activity: "active", fence: 1 },
        })
      ).ok,
    ).toBe(true);
    const state = await store.state();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.state.expectedRevision).toBe(2); // the observation did not advance it
  });

  it("creates the journal with owner-only protections", async () => {
    const journalPath = path.join(scratch, "protections", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-6"))).ok).toBe(true);
    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(journalPath)).mode & 0o777).toBe(0o700);
  });

  it("reads an empty journal as explicitly unregistered", async () => {
    const store = createJournalStore(path.join(scratch, "empty", "journal.jsonl"));
    const state = await store.state();
    expect(state.ok).toBe(false);
    if (!state.ok) {
      expect(state.rejections.map((rejection) => rejection.code)).toContain("registration_missing");
    }
  });
});
