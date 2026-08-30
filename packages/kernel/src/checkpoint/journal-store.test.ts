/**
 * The checkpoint module's V-slice: ONE append-only durable path over the
 * frozen journal grammar and reducers. The store never re-authors the spine's
 * rules — every append re-reduces the whole journal plus the candidate entry,
 * so an entry the frozen reducer rejects never reaches the file, and bytes
 * already durable are never rewritten.
 *
 * Written RED before `journal-store.ts` existed.
 */
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJournalStore, createMaintenanceJournalStore } from "./journal-store.ts";

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
      idempotencyKey: "e1-contract.amended",
      kind: "contract.amended",
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

describe("interrupted checkpoint commits — append/crash fault injection", () => {
  const pin = (deliveryId: string, revision: number) => ({
    spec: "journal-entry/1",
    journal: "delivery",
    subjectId: deliveryId,
    expectedRevision: revision,
    idempotencyKey: `e${revision}-generation.pinned`,
    kind: "generation.pinned",
    payload: { generationDigest: "b".repeat(64), releaseId: "core-v1", profile: "confirmation-fixture" },
  });

  it("treats a torn final line as an uncommitted checkpoint: state reads clean, the next append repairs", async () => {
    const journalPath = path.join(scratch, "torn", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-t1"))).ok).toBe(true);
    // The crash: a partial line with no terminating newline. The caller never
    // saw this append succeed, so it was never a durable checkpoint.
    appendFileSync(journalPath, '{"spec":"journal-entry/1","journal":"del');
    const state = await store.state();
    expect(state.ok, JSON.stringify(state)).toBe(true);
    if (!state.ok) return;
    expect(state.state.expectedRevision).toBe(1);
    const repaired = await store.append(pin("dlv-t1", 1));
    expect(repaired.ok, JSON.stringify(repaired)).toBe(true);
    const bytes = readFileSync(journalPath, "utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    for (const line of bytes.split("\n").filter((entry) => entry.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const after = await store.state();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.state.expectedRevision).toBe(2);
  });

  it("drops a torn tail even when its prefix happens to parse — durability is the terminated line, not luck", async () => {
    const journalPath = path.join(scratch, "torn-parseable", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-t2"))).ok).toBe(true);
    appendFileSync(journalPath, JSON.stringify(pin("dlv-t2", 1))); // no newline
    const state = await store.state();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.state.expectedRevision).toBe(1); // the unterminated entry never committed
  });

  it("fails closed on a corrupt TERMINATED line — that is tampering, not an interrupted append", async () => {
    const journalPath = path.join(scratch, "corrupt", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-t3"))).ok).toBe(true);
    appendFileSync(journalPath, "not json at all\n");
    const state = await store.state();
    expect(state.ok).toBe(false);
    const blockedAppend = await store.append(pin("dlv-t3", 1));
    expect(blockedAppend.ok).toBe(false);
  });

  it("fails closed on a foreign journal line of a reserved control-plane kind", async () => {
    const journalPath = path.join(scratch, "foreign", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-t4"))).ok).toBe(true);
    appendFileSync(
      journalPath,
      `${JSON.stringify({
        spec: "journal-entry/1",
        journal: "delivery",
        subjectId: "dlv-t4",
        expectedRevision: 1,
        idempotencyKey: "e1-control.plane.mirror.recorded",
        kind: "control.plane.mirror.recorded",
        payload: { remoteClaim: "delivery is completed" },
      })}\n`,
    );
    const state = await store.state();
    expect(state.ok).toBe(false);
    if (!state.ok) {
      expect(state.rejections.map((rejection) => rejection.code)).toContain("reserved_kind");
    }
  });

  it("serializes racing appends — at most one of two same-revision writers becomes durable", async () => {
    const journalPath = path.join(scratch, "race", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-t5"))).ok).toBe(true);
    const [first, second] = await Promise.all([
      store.append(pin("dlv-t5", 1)),
      store.append({ ...pin("dlv-t5", 1), idempotencyKey: "e1-generation.pinned-b" }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const state = await store.state();
    expect(state.ok, JSON.stringify(state)).toBe(true);
    if (!state.ok) return;
    expect(state.state.expectedRevision).toBe(2);
  });
});

describe("secret rejection and redaction before append", () => {
  it("redacts a secret-like value inside a bounded free-text member instead of making it durable", async () => {
    const journalPath = path.join(scratch, "redacts", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-s1"))).ok).toBe(true);
    const appended = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: "dlv-s1",
      expectedRevision: 1,
      idempotencyKey: "e1-blocker.recorded",
      kind: "blocker.recorded",
      payload: {
        code: "sensor.failure",
        summary: "sensor output leaked AKIAABCDEFGHIJKLMNOP and token ghp_0123456789abcdefghijklmnopqrstuvwxyz12",
      },
    });
    expect(appended.ok, JSON.stringify(appended)).toBe(true);
    const bytes = readFileSync(journalPath, "utf8");
    expect(bytes).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(bytes).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz12");
    expect(bytes).toContain("[redacted:");
  });

  it("rejects a secret-like value outside the free-text members — nothing is written", async () => {
    const journalPath = path.join(scratch, "rejects-secret", "journal.jsonl");
    const store = createJournalStore(journalPath);
    expect((await store.append(registration("dlv-s2"))).ok).toBe(true);
    const before = readFileSync(journalPath, "utf8");
    const appended = await store.append({
      spec: "journal-entry/1",
      journal: "delivery",
      subjectId: "dlv-s2",
      expectedRevision: 1,
      idempotencyKey: "e1-workspace.bound",
      kind: "workspace.bound",
      payload: {
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        baseRef: "refs/heads/main",
        baseTipSha: "b".repeat(40),
        // Assembled at runtime so forge-side push protection never mistakes
        // the synthetic corpus fixture for a live credential.
        branchRef: `refs/heads/${["xoxb", "123456789012", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("-")}`,
        branchRefValue: "b".repeat(40),
        worktreeId: "wt-1",
        baselineClassification: "clean",
      },
    });
    expect(appended.ok).toBe(false);
    if (!appended.ok) {
      expect(appended.rejections.map((rejection) => rejection.code)).toContain("secret_rejected");
    }
    expect(readFileSync(journalPath, "utf8")).toBe(before);
  });
});

describe("the maintenance journal store", () => {
  it("appends retention actions under the same discipline and owner-only protections", async () => {
    const journalPath = path.join(scratch, "maintenance", "maintenance.jsonl");
    const store = createMaintenanceJournalStore(journalPath);
    const record = (revision: number, action: "export" | "delete") => ({
      spec: "journal-entry/1",
      journal: "maintenance",
      subjectId: "install-1",
      expectedRevision: revision,
      idempotencyKey: `m${revision}-${action}`,
      kind: "retention.action.recorded",
      payload: {
        action,
        subjectDeliveryId: "dlv-gone",
        artifactDigest: "f".repeat(64),
        preservedAuditRecords: action === "delete" ? ["audit/dlv-gone.json"] : [],
      },
    });
    expect((await store.append(record(0, "export"))).ok).toBe(true);
    expect((await store.append(record(1, "delete"))).ok).toBe(true);
    expect((await store.append(record(1, "delete"))).ok).toBe(false); // revision + key replay
    const state = await store.state();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.state.expectedRevision).toBe(2);
    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
  });
});
