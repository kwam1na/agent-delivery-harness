import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDeliveryRecordRetention } from "./record-retention.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "record-retention-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch", "main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Retention Fixture");
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

const recordPath = (id: string): string => `delivery/records/record--${id.repeat(64)}.json`;
const recordBytes = (id: string): string => `${JSON.stringify({ id, evidence: [`review-${id}`] })}\n`;

async function retain(rootDir: string, scope: string, id: string, keepSuperseded = 1) {
  const relativePath = recordPath(id);
  const bytes = recordBytes(id);
  return applyDeliveryRecordRetention({
    rootDir,
    storageNamespace: "delivery-harness/",
    scope,
    keepSuperseded,
    recordBasePath: "delivery/records/record.json",
    current: { relativePath, deliverableDigest: id.repeat(64), bytes },
    writeCurrent: async () => {
      await mkdir(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
      await writeFile(path.join(rootDir, relativePath), bytes);
    },
  });
}

function commit(rootDir: string, message: string): void {
  git(rootDir, "add", "delivery/records");
  git(rootDir, "commit", "--quiet", "-m", message);
}

describe("same-delivery tracked record retention", () => {
  it("keeps the current record plus the declared superseded bound and converges on retry", async () => {
    const root = await repository();
    expect((await retain(root, "delivery-one", "a")).ok).toBe(true);
    commit(root, "record a");
    expect((await retain(root, "delivery-one", "b")).ok).toBe(true);
    commit(root, "record b");
    expect((await retain(root, "delivery-one", "c")).ok).toBe(true);

    expect(existsSync(path.join(root, recordPath("a")))).toBe(false);
    expect(existsSync(path.join(root, recordPath("b")))).toBe(true);
    expect(await readFile(path.join(root, recordPath("c")), "utf8")).toBe(recordBytes("c"));
    expect((await retain(root, "delivery-one", "c")).ok).toBe(true);
    expect(existsSync(path.join(root, recordPath("a")))).toBe(false);
  });

  it("never adopts a pre-existing path or deletes another scope's record", async () => {
    const root = await repository();
    expect((await retain(root, "delivery-other", "d", 0)).ok).toBe(true);
    commit(root, "other delivery record");
    expect((await retain(root, "delivery-one", "a", 0)).ok).toBe(true);
    commit(root, "first delivery record");
    expect((await retain(root, "delivery-one", "b", 0)).ok).toBe(true);
    expect(existsSync(path.join(root, recordPath("d")))).toBe(true);

    await writeFile(path.join(root, recordPath("e")), recordBytes("e"));
    const refused = await retain(root, "delivery-one", "e", 0);
    expect(refused).toMatchObject({ ok: false, code: "retention_path_unowned" });
    expect(await readFile(path.join(root, recordPath("e")), "utf8")).toBe(recordBytes("e"));
  });

  it("fails closed when two ownership ledgers claim the same record", async () => {
    const root = await repository();
    const first = await retain(root, "delivery-one", "a", 0);
    const second = await retain(root, "delivery-two", "d", 0);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const firstLedger = JSON.parse(await readFile(first.ledgerPath, "utf8")) as { owned: unknown[] };
    const secondLedger = JSON.parse(await readFile(second.ledgerPath, "utf8")) as { owned: unknown[] };
    secondLedger.owned = [firstLedger.owned[0]];
    await writeFile(second.ledgerPath, `${JSON.stringify(secondLedger)}\n`, { mode: 0o600 });

    const refused = await retain(root, "delivery-one", "b", 0);
    expect(refused).toMatchObject({ ok: false, code: "retention_ownership_ambiguous" });
    expect(existsSync(path.join(root, recordPath("a")))).toBe(true);
    expect(existsSync(path.join(root, recordPath("b")))).toBe(false);
  });

  it("serializes ownership across scopes so concurrent reservations have one owner", async () => {
    const root = await repository();
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const relativePath = recordPath("a");
    const bytes = recordBytes("a");
    const first = applyDeliveryRecordRetention({
      rootDir: root,
      storageNamespace: "delivery-harness/",
      scope: "delivery-one",
      keepSuperseded: 0,
      recordBasePath: "delivery/records/record.json",
      current: { relativePath, deliverableDigest: "a".repeat(64), bytes },
      writeCurrent: async () => {
        markStarted();
        await release;
        await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
        await writeFile(path.join(root, relativePath), bytes);
      },
    });
    await started;
    const second = retain(root, "delivery-two", "a", 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirst();

    const outcomes = await Promise.all([first, second]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ code: "retention_ownership_ambiguous" });
  });

  it("cancels an interrupted pending prune when that record becomes current again", async () => {
    const root = await repository();
    const first = await retain(root, "delivery-one", "a", 0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commit(root, "record a");
    const ledger = JSON.parse(await readFile(first.ledgerPath, "utf8")) as { owned: unknown[]; pendingPrune: unknown[] };
    ledger.pendingPrune = ledger.owned;
    ledger.owned = [];
    await writeFile(first.ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });

    expect((await retain(root, "delivery-one", "a", 0)).ok).toBe(true);
    expect(await readFile(path.join(root, recordPath("a")), "utf8")).toBe(recordBytes("a"));
  });

  it("fails closed on tampered or symlinked owned records before writing the next one", async () => {
    const root = await repository();
    expect((await retain(root, "delivery-one", "a", 0)).ok).toBe(true);
    commit(root, "record a");
    await writeFile(path.join(root, recordPath("a")), "tampered\n");
    expect(await retain(root, "delivery-one", "b", 0)).toMatchObject({ ok: false, code: "retention_owned_record_changed" });
    expect(existsSync(path.join(root, recordPath("b")))).toBe(false);

    await writeFile(path.join(root, recordPath("a")), recordBytes("a"));
    await rm(path.join(root, recordPath("a")));
    await symlink("record--elsewhere.json", path.join(root, recordPath("a")));
    expect(await retain(root, "delivery-one", "b", 0)).toMatchObject({ ok: false, code: "retention_owned_record_unsafe" });
    expect(existsSync(path.join(root, recordPath("b")))).toBe(false);
  });

  it("preserves an owned superseded record until its exact bytes are reachable from Git", async () => {
    const root = await repository();
    expect((await retain(root, "delivery-one", "a", 0)).ok).toBe(true);
    const refused = await retain(root, "delivery-one", "b", 0);
    expect(refused).toMatchObject({ ok: false, code: "retention_history_missing" });
    expect(existsSync(path.join(root, recordPath("a")))).toBe(true);
    expect(existsSync(path.join(root, recordPath("b")))).toBe(false);
  });
});
