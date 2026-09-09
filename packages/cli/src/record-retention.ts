/** Opt-in ownership and pruning for tracked per-digest delivery records. */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  ProcessLockRefused,
  deriveDeliveryRecordPath,
  resolveRecordStorage,
  sha256Hex,
  withProcessLock,
} from "@agent-delivery-harness/kernel";

const execFileAsync = promisify(execFile);
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const LEDGER_VERSION = "delivery-record-retention/1";
const RETENTION_LEAF = "delivery-record-retention";

interface Receipt {
  readonly relativePath: string;
  readonly deliverableDigest: string;
  readonly sha256: string;
}

interface Ledger {
  readonly version: typeof LEDGER_VERSION;
  readonly scope: string;
  readonly recordBasePath: string;
  readonly owned: readonly Receipt[];
  readonly pendingPrune: readonly Receipt[];
}

export type RecordRetentionCode =
  | "retention_scope_invalid"
  | "retention_bound_invalid"
  | "retention_ledger_unsafe"
  | "retention_ledger_invalid"
  | "retention_ownership_ambiguous"
  | "retention_path_unowned"
  | "retention_owned_record_changed"
  | "retention_owned_record_unsafe"
  | "retention_history_missing"
  | "retention_write_failed"
  | "retention_cleanup_failed"
  | "retention_lock_unavailable";

export type RecordRetentionResult =
  | { readonly ok: true; readonly pruned: readonly string[]; readonly ledgerPath: string }
  | { readonly ok: false; readonly code: RecordRetentionCode; readonly detail: string };
type RecordRetentionFailure = Extract<RecordRetentionResult, { readonly ok: false }>;

export interface ApplyDeliveryRecordRetentionInput {
  readonly rootDir: string;
  readonly storageNamespace: string;
  readonly scope: string;
  readonly keepSuperseded: number;
  readonly recordBasePath: string;
  readonly current: {
    readonly relativePath: string;
    readonly deliverableDigest: string;
    readonly bytes: string;
  };
  readonly writeCurrent: () => Promise<void>;
}

const failure = (code: RecordRetentionCode, detail: string): RecordRetentionFailure => ({ ok: false, code, detail });
const scopeDigest = (scope: string): string => createHash("sha256").update(scope, "utf8").digest("hex");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receipt(value: unknown, recordBasePath: string): Receipt | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "deliverableDigest,relativePath,sha256") return undefined;
  const relativePath = value["relativePath"];
  const deliverableDigest = value["deliverableDigest"];
  const sha256 = value["sha256"];
  if (typeof relativePath !== "string" || typeof deliverableDigest !== "string" || !DIGEST.test(deliverableDigest) ||
      typeof sha256 !== "string" || !DIGEST.test(sha256) || deriveDeliveryRecordPath(recordBasePath, deliverableDigest) !== relativePath) return undefined;
  return { relativePath, deliverableDigest, sha256 };
}

function parseLedger(value: unknown, expectedName: string): Ledger | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "owned,pendingPrune,recordBasePath,scope,version" ||
      value["version"] !== LEDGER_VERSION || typeof value["scope"] !== "string" || !SCOPE.test(value["scope"]) ||
      typeof value["recordBasePath"] !== "string" || !Array.isArray(value["owned"]) || !Array.isArray(value["pendingPrune"]) ||
      `${scopeDigest(value["scope"])}.json` !== expectedName) return undefined;
  const owned = value["owned"].map((entry) => receipt(entry, value["recordBasePath"] as string));
  const pendingPrune = value["pendingPrune"].map((entry) => receipt(entry, value["recordBasePath"] as string));
  if (owned.some((entry) => entry === undefined) || pendingPrune.some((entry) => entry === undefined)) return undefined;
  const paths = [...owned, ...pendingPrune].map((entry) => entry!.relativePath);
  if (new Set(paths).size !== paths.length) return undefined;
  return {
    version: LEDGER_VERSION,
    scope: value["scope"],
    recordBasePath: value["recordBasePath"],
    owned: owned as Receipt[],
    pendingPrune: pendingPrune as Receipt[],
  };
}

async function readLedgers(storageDir: string): Promise<RecordRetentionFailure | { readonly ok: true; readonly ledgers: Map<string, Ledger> }> {
  const ledgers = new Map<string, Ledger>();
  for (const name of await readdir(storageDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  })) {
    if (!name.endsWith(".json")) continue;
    const ledgerPath = path.join(storageDir, name);
    const stats = await lstat(ledgerPath).catch(() => undefined);
    if (stats === undefined || !stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
      return failure("retention_ledger_unsafe", `${ledgerPath} is not an owner-only regular file`);
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(ledgerPath, "utf8"));
    } catch {
      return failure("retention_ledger_invalid", `${ledgerPath} is not valid JSON`);
    }
    const parsed = parseLedger(value, name);
    if (parsed === undefined) return failure("retention_ledger_invalid", `${ledgerPath} has an unsupported or inconsistent shape`);
    ledgers.set(parsed.scope, parsed);
  }
  const owners = new Map<string, string>();
  for (const ledger of ledgers.values()) {
    for (const entry of [...ledger.owned, ...ledger.pendingPrune]) {
      const prior = owners.get(entry.relativePath);
      if (prior !== undefined && prior !== ledger.scope) {
        return failure("retention_ownership_ambiguous", `${entry.relativePath} is claimed by ${prior} and ${ledger.scope}`);
      }
      owners.set(entry.relativePath, ledger.scope);
    }
  }
  return { ok: true, ledgers };
}

async function writeLedger(ledgerPath: string, ledger: Ledger): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(ledgerPath), 0o700);
  const temporary = `${ledgerPath}.tmp-${randomUUID()}`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ledger)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await rename(temporary, ledgerPath);
}

async function verifyWorkingRecord(rootDir: string, entry: Receipt): Promise<RecordRetentionResult | { readonly ok: true }> {
  const absolute = path.join(rootDir, entry.relativePath);
  const stats = await lstat(absolute).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (stats === undefined) return failure("retention_owned_record_changed", `${entry.relativePath} is missing`);
  if (!stats.isFile() || stats.isSymbolicLink()) return failure("retention_owned_record_unsafe", `${entry.relativePath} is not a regular file`);
  if (sha256Hex(await readFile(absolute)) !== entry.sha256) {
    return failure("retention_owned_record_changed", `${entry.relativePath} no longer matches its ownership receipt`);
  }
  return { ok: true };
}

async function gitCarriesExactRecord(rootDir: string, entry: Receipt): Promise<boolean> {
  try {
    const { stdout: listing } = await execFileAsync("git", ["ls-tree", "HEAD", "--", entry.relativePath], { cwd: rootDir, encoding: "utf8" });
    if (!listing.startsWith("100644 blob ") || !listing.endsWith(`\t${entry.relativePath}\n`)) return false;
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${entry.relativePath}`], { cwd: rootDir, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
    return sha256Hex(stdout) === entry.sha256;
  } catch {
    return false;
  }
}

export async function applyDeliveryRecordRetention(input: ApplyDeliveryRecordRetentionInput): Promise<RecordRetentionResult> {
  if (!SCOPE.test(input.scope)) return failure("retention_scope_invalid", "retention scope must be a plain 1-128 character key");
  if (!Number.isSafeInteger(input.keepSuperseded) || input.keepSuperseded < 0 || input.keepSuperseded > 100) {
    return failure("retention_bound_invalid", "keepSuperseded must be an integer from 0 through 100");
  }
  if (!DIGEST.test(input.current.deliverableDigest) ||
      deriveDeliveryRecordPath(input.recordBasePath, input.current.deliverableDigest) !== input.current.relativePath) {
    return failure("retention_ledger_invalid", "the current path is not the configured per-digest record path");
  }

  const storage = await resolveRecordStorage(input.rootDir, { storageNamespace: input.storageNamespace, leaf: RETENTION_LEAF });
  const ledgerPath = path.join(storage.storageDir, `${scopeDigest(input.scope)}.json`);
  // Ownership is global to this worktree store. Serializing only one scope
  // would let two scopes reserve the same absent digest path concurrently.
  const lockPath = path.join(storage.storageDir, ".ownership.lock");
  await mkdir(storage.storageDir, { recursive: true, mode: 0o700 });

  try {
    return await withProcessLock(lockPath, 5000, async () => {
      const loaded = await readLedgers(storage.storageDir);
      if (!loaded.ok) return loaded;
      const existing = loaded.ledgers.get(input.scope);
      if (existing !== undefined && existing.recordBasePath !== input.recordBasePath) {
        return failure("retention_ledger_invalid", `retention scope ${input.scope} was created for a different delivery record path`);
      }
      let ledger: Ledger = existing ?? {
        version: LEDGER_VERSION,
        scope: input.scope,
        recordBasePath: input.recordBasePath,
        owned: [],
        pendingPrune: [],
      };

      const currentSha = sha256Hex(input.current.bytes);
      const currentReceipt: Receipt = {
        relativePath: input.current.relativePath,
        deliverableDigest: input.current.deliverableDigest,
        sha256: currentSha,
      };

      // A retried delivery may return to a path whose deletion was durably
      // scheduled by an interrupted later attempt. Cancel that deletion before
      // touching any pending path; the invocation's verified current record wins.
      const returningCurrent = ledger.pendingPrune.find((entry) => entry.relativePath === currentReceipt.relativePath);
      if (returningCurrent !== undefined) {
        if (returningCurrent.sha256 !== currentReceipt.sha256 || returningCurrent.deliverableDigest !== currentReceipt.deliverableDigest) {
          return failure("retention_owned_record_changed", `${currentReceipt.relativePath} conflicts with its pending ownership receipt`);
        }
        ledger = {
          ...ledger,
          owned: [...ledger.owned, returningCurrent],
          pendingPrune: ledger.pendingPrune.filter((entry) => entry.relativePath !== currentReceipt.relativePath),
        };
        await writeLedger(ledgerPath, ledger);
      }

      // Complete an interrupted, already-proved pruning decision first.
      for (const pending of ledger.pendingPrune) {
        const absolute = path.join(input.rootDir, pending.relativePath);
        const present = await lstat(absolute).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
        if (present) {
          const verified = await verifyWorkingRecord(input.rootDir, pending);
          if (!verified.ok) return verified;
          if (!await gitCarriesExactRecord(input.rootDir, pending)) {
            return failure("retention_history_missing", `${pending.relativePath} is not preserved byte-for-byte at HEAD`);
          }
          try {
            await unlink(absolute);
          } catch (error) {
            return failure("retention_cleanup_failed", `could not remove ${pending.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (ledger.pendingPrune.length > 0) {
        ledger = { ...ledger, pendingPrune: [] };
        await writeLedger(ledgerPath, ledger);
      }

      const currentIndex = ledger.owned.findIndex((entry) => entry.relativePath === currentReceipt.relativePath);
      if (currentIndex >= 0 && (ledger.owned[currentIndex]!.sha256 !== currentSha ||
          ledger.owned[currentIndex]!.deliverableDigest !== currentReceipt.deliverableDigest)) {
        return failure("retention_owned_record_changed", `${currentReceipt.relativePath} conflicts with its ownership receipt`);
      }
      for (const other of loaded.ledgers.values()) {
        if (other.scope !== input.scope && [...other.owned, ...other.pendingPrune].some((entry) => entry.relativePath === currentReceipt.relativePath)) {
          return failure("retention_ownership_ambiguous", `${currentReceipt.relativePath} belongs to retention scope ${other.scope}`);
        }
      }
      const currentStats = await lstat(path.join(input.rootDir, currentReceipt.relativePath)).catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (currentIndex < 0 && currentStats !== undefined) {
        return failure("retention_path_unowned", `${currentReceipt.relativePath} existed before retention scope ${input.scope} owned it`);
      }

      // Validate every prior live receipt before deciding what this attempt may remove.
      for (const entry of ledger.owned) {
        if (entry.relativePath === currentReceipt.relativePath && currentStats === undefined) continue;
        const verified = await verifyWorkingRecord(input.rootDir, entry);
        if (!verified.ok) return verified;
      }
      const ordered = [
        ...ledger.owned.filter((entry) => entry.relativePath !== currentReceipt.relativePath),
        currentReceipt,
      ];
      const retainCount = input.keepSuperseded + 1;
      const pendingPrune = ordered.slice(0, Math.max(0, ordered.length - retainCount));
      for (const entry of pendingPrune) {
        if (!await gitCarriesExactRecord(input.rootDir, entry)) {
          return failure("retention_history_missing", `${entry.relativePath} is not preserved byte-for-byte at HEAD`);
        }
      }

      // Reserve only an absent output. A crash after this point can recreate it,
      // but can never reinterpret a pre-existing file as scope-owned.
      ledger = { ...ledger, owned: ordered, pendingPrune: [] };
      await writeLedger(ledgerPath, ledger);
      if (currentStats === undefined) {
        try {
          await input.writeCurrent();
        } catch (error) {
          return failure("retention_write_failed", error instanceof Error ? error.message : String(error));
        }
      }
      const verifiedCurrent = await verifyWorkingRecord(input.rootDir, currentReceipt);
      if (!verifiedCurrent.ok) return verifiedCurrent;

      if (pendingPrune.length > 0) {
        const kept = ordered.slice(pendingPrune.length);
        ledger = { ...ledger, owned: kept, pendingPrune };
        await writeLedger(ledgerPath, ledger);
        for (const entry of pendingPrune) {
          try {
            await unlink(path.join(input.rootDir, entry.relativePath));
          } catch (error) {
            return failure("retention_cleanup_failed", `could not remove ${entry.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        ledger = { ...ledger, pendingPrune: [] };
        await writeLedger(ledgerPath, ledger);
      }
      return { ok: true, pruned: pendingPrune.map((entry) => entry.relativePath), ledgerPath };
    });
  } catch (error) {
    if (error instanceof ProcessLockRefused) {
      return failure("retention_lock_unavailable", `retention scope ${input.scope} is already being updated: ${error.reason}`);
    }
    throw error;
  }
}
