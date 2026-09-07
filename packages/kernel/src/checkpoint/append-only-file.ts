/**
 * The ONE serialized read-decide-append body, shared by every append-only
 * journal this kernel keeps.
 *
 * WHY IT IS SHARED. The spine journal store and the run store both need the
 * same four things in the same order inside the same critical section: read
 * the terminated prefix, decide what (if anything) becomes durable, repair a
 * torn tail, extend the file under owner-only modes. Only the DECISION differs
 * — the spine passes its frozen reducer, the run store passes its per-run
 * rules — so the decision is the parameter and everything else is here. A
 * second copy of this body is a second place for a torn tail to be mishandled.
 *
 * ATOMIC CHECKPOINTS. A durable entry is a TERMINATED line: JSON followed by a
 * newline. An interrupted append leaves an unterminated tail whose caller
 * never saw success — it is not a checkpoint, so reads reduce the terminated
 * prefix and the next append truncates the torn tail before extending.
 *
 * OPEN DISCIPLINE COMES FROM THE CALLER. The spine store keeps the plain
 * append flag it has always used. The run store's files live under a directory
 * anything the owner executes can reach, so it passes `O_NOFOLLOW` and an
 * `fstat` check on the opened descriptor — ownership, mode, and regular-file —
 * rather than a separate lookup that a racing writer could invalidate.
 * Directory components are not defended: node has no `openat`.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const OWNER_DIR = 0o700;
export const OWNER_FILE = 0o600;

/**
 * Thrown when an opened descriptor fails the caller's discipline — a symlink
 * at the final component, a non-regular file, a file another user could read
 * or write. Never returned as "no file": a refusal is not an absence.
 */
export class JournalAccessRefused extends Error {
  readonly journalPath: string;
  readonly reason: string;

  constructor(journalPath: string, reason: string) {
    super(`${journalPath}: ${reason}`);
    this.name = "JournalAccessRefused";
    this.journalPath = journalPath;
    this.reason = reason;
  }
}

export interface JournalOpenDiscipline {
  /** Extra flags OR-ed into every open of this journal. */
  readonly extraFlags?: number;
  /**
   * Checked on the opened descriptor before any byte is read or written.
   * Returning a string refuses the access and names why.
   */
  readonly verify?: (stats: Stats) => string | undefined;
  /**
   * When true, an open or read error other than a missing file REFUSES rather
   * than reading as an empty journal. The spine store's historical behaviour
   * is the default: any failure reads as empty.
   */
  readonly refuseOnError?: boolean;
}

export interface RawJournal {
  readonly lines: readonly string[];
  /** Byte length of the terminated prefix; equals the file size when clean. */
  readonly terminatedByteLength: number;
  readonly interruptedTail: boolean;
}

const EMPTY_RAW: RawJournal = { lines: [], terminatedByteLength: 0, interruptedTail: false };

function splitTerminated(text: string): RawJournal {
  const lastNewline = text.lastIndexOf("\n");
  const terminated = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
  return {
    lines: terminated.split("\n").filter((line) => line.length > 0),
    terminatedByteLength: Buffer.byteLength(terminated, "utf8"),
    interruptedTail: text.length > terminated.length,
  };
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/**
 * Reads the journal's terminated prefix. A missing file is an empty journal.
 * Every other failure is empty too unless the caller's discipline refuses.
 */
export async function readRawJournal(journalPath: string, discipline: JournalOpenDiscipline = {}): Promise<RawJournal> {
  const flags = fsConstants.O_RDONLY | (discipline.extraFlags ?? 0);
  let handle;
  try {
    handle = await open(journalPath, flags);
  } catch (error) {
    if (isMissing(error)) return EMPTY_RAW;
    if (discipline.refuseOnError === true) throw new JournalAccessRefused(journalPath, describe(error));
    return EMPTY_RAW;
  }
  try {
    const refusal = discipline.verify?.(await handle.stat());
    if (refusal !== undefined) throw new JournalAccessRefused(journalPath, refusal);
    return splitTerminated(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof JournalAccessRefused) throw error;
    if (discipline.refuseOnError === true) throw new JournalAccessRefused(journalPath, describe(error));
    return EMPTY_RAW;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code ?? (error instanceof Error ? error.message : String(error));
}

export type ParsedJournal =
  | { readonly ok: true; readonly entries: readonly unknown[] }
  | { readonly ok: false; readonly unparsableLineIndex: number };

/**
 * A corrupt TERMINATED line is tampering, not interruption: the whole journal
 * fails closed rather than skipping the line. Each store spells that failure
 * in its own rejection vocabulary, so this reports only WHICH line.
 */
export function parseJournalLines(lines: readonly string[]): ParsedJournal {
  const entries: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      return { ok: false, unparsableLineIndex: index };
    }
  }
  return { ok: true, entries };
}

/**
 * In-process appends to one journal path run strictly one after another, so a
 * racing writer observes the loser's outcome through the decision function —
 * never a torn or interleaved file.
 */
const appendQueues = new Map<string, Promise<unknown>>();

export function serializedOnPath<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  appendQueues.set(
    key,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

/** What the decision function may see: the terminated prefix, parsed. */
export type JournalEntriesReader = () => Promise<ParsedJournal>;

export type JournalDecision<Accepted, Rejected> =
  | { readonly ok: true; readonly entry?: unknown; readonly accepted: Accepted }
  | { readonly ok: false; readonly rejected: Rejected };

export interface AppendDecidedOptions<Accepted, Rejected> {
  readonly journalPath: string;
  readonly discipline?: JournalOpenDiscipline;
  /** Serialize independent processes too; opt-in preserves the spine contract. */
  readonly crossProcess?: boolean;
  /** Acquisition only; a live owner's critical section is never expired. Default 5000ms. */
  readonly crossProcessTimeoutMs?: number;
  /**
   * The one slot that differs between stores. It is handed a reader rather
   * than the entries themselves so a decision that refuses before reading —
   * secret discipline, say — still touches no journal, exactly as it did when
   * each store owned this body.
   */
  readonly decide: (read: JournalEntriesReader) => Promise<JournalDecision<Accepted, Rejected>>;
}

/**
 * Runs one decision inside the path's critical section and, when it accepts,
 * extends the file by exactly one terminated line under owner-only modes.
 */
export function appendDecided<Accepted, Rejected>(
  options: AppendDecidedOptions<Accepted, Rejected>,
): Promise<{ ok: true; accepted: Accepted } | { ok: false; rejected: Rejected }> {
  const { journalPath, discipline } = options;
  const operation = async () => {
    let raw: RawJournal | undefined;
    const read: JournalEntriesReader = async () => {
      raw = await readRawJournal(journalPath, discipline);
      return parseJournalLines(raw.lines);
    };

    const decision = await options.decide(read);
    if (!decision.ok) return { ok: false as const, rejected: decision.rejected };
    if (decision.entry === undefined) return { ok: true as const, accepted: decision.accepted };

    await mkdir(path.dirname(journalPath), { recursive: true, mode: OWNER_DIR });
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (discipline?.extraFlags ?? 0);
    const handle = await open(journalPath, flags, OWNER_FILE);
    try {
      const refusal = discipline?.verify?.(await handle.stat());
      if (refusal !== undefined) throw new JournalAccessRefused(journalPath, refusal);
      // Repair through the verified descriptor, never a second path lookup.
      if (raw?.interruptedTail === true) await handle.truncate(raw.terminatedByteLength);
      await handle.writeFile(`${JSON.stringify(decision.entry)}\n`, "utf8");
      await handle.chmod(OWNER_FILE);
    } finally {
      await handle.close().catch(() => undefined);
    }
    return { ok: true as const, accepted: decision.accepted };
  };
  return serializedOnPath(path.resolve(journalPath), () => options.crossProcess === true
    ? withProcessAppendLock(journalPath, options.crossProcessTimeoutMs ?? 5000, operation)
    : operation());
}

/**
 * Lamport's bakery protocol over local filesystem entries. Each contender
 * creates its own unique choosing marker, atomically publishes a ticket, then
 * waits for every earlier ticket. No shared lock file is stolen or unlinked:
 * stale-owner reclamation of such a file races with another reclaimer and can
 * admit two owners. Here only a positively dead PID can be disregarded. PID
 * reuse is conservative (it can cause a timeout, never concurrent ownership).
 *
 * A live but paused owner never loses its ticket. The timeout bounds acquisition,
 * not ownership. Atomic local-filesystem rename/readdir semantics and one host
 * PID namespace are required; this is not a distributed/network-filesystem lock.
 */
async function withProcessAppendLock<T>(journalPath: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  const refuse = (reason: string) => new JournalAccessRefused(journalPath, reason);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw refuse("invalid cross-process append lock timeout");
  const deadline = performance.now() + timeoutMs;
  const checkDeadline = () => {
    if (performance.now() >= deadline) throw refuse("cross-process append lock timed out");
  };
  const directory = `${journalPath}.append-lock`;
  const id = `${process.pid}-${randomUUID()}`;
  const marker = path.join(directory, `${id}.ticket`);
  const pending = path.join(directory, `${id}.pending`);
  const flags = fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  const members = async () => {
    checkDeadline();
    return (await readdir(directory)).filter((name) => /^\d+-[a-f0-9-]{36}\.ticket$/.test(name));
  };
  const ticket = async (name: string): Promise<number | undefined> => {
    checkDeadline();
    const pid = Number(name.slice(0, name.indexOf("-")));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw refuse("invalid append lock owner");
    if (!alive(pid)) {
      // Names are never reused. Removing this dead process's immutable name
      // cannot remove a successor's ticket, even with several reclaimers.
      await unlink(path.join(directory, name)).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      await unlink(path.join(directory, name.replace(/\.ticket$/, ".pending"))).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      return undefined;
    }
    let handle;
    try { handle = await open(path.join(directory, name), fsConstants.O_RDONLY | flags); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    try {
      const stats = await handle.stat();
      const refusal = ownerOnlyRegularFile(stats);
      if (refusal !== undefined) throw refuse(`append lock ${refusal}`);
      if (stats.size > 32) throw refuse("invalid append lock ticket");
      const contents = await handle.readFile("utf8");
      if (contents === "") return 0; // choosing, including a paused creator
      if (!/^[1-9][0-9]*\n$/.test(contents)) throw refuse("invalid append lock ticket");
      const value = Number(contents.trim());
      if (!Number.isSafeInteger(value)) throw refuse("invalid append lock ticket");
      return value;
    } finally { await handle.close(); }
  };
  let registered = false;
  let acquired = false;
  try {
    await mkdir(directory, { recursive: true, mode: OWNER_DIR });
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || (directoryStats.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && directoryStats.uid !== process.getuid())) throw refuse("append lock directory is not owner-only");
    const choosing = await open(marker, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | flags, OWNER_FILE);
    registered = true;
    await choosing.close();
    let maximum = 0;
    for (const name of await members()) maximum = Math.max(maximum, await ticket(name) ?? 0);
    const ownTicket = maximum + 1;
    if (!Number.isSafeInteger(ownTicket)) throw refuse("append lock ticket exhausted");
    const publication = await open(pending, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | flags, OWNER_FILE);
    try { await publication.writeFile(`${ownTicket}\n`, "utf8"); }
    finally { await publication.close(); }
    await rename(pending, marker);
    for (const name of await members()) {
      if (name === `${id}.ticket`) continue;
      for (;;) {
        const other = await ticket(name);
        if (other === undefined || (other > 0 && (other > ownTicket || (other === ownTicket && name > `${id}.ticket`)))) break;
        await delay(Math.min(10, Math.max(1, deadline - performance.now())));
      }
    }
    checkDeadline();
    acquired = true;
    return await operation();
  } catch (error) {
    if (acquired || error instanceof JournalAccessRefused) throw error;
    throw refuse(describe(error));
  } finally {
    if (registered) {
      await unlink(marker).catch(() => undefined);
      await unlink(pending).catch(() => undefined);
    }
  }
}

/**
 * The owner-only, regular-file discipline the run store applies to every file
 * it opens. Ownership is checked against the running user because the store's
 * whole protection is that only the owner can reach it.
 */
export function ownerOnlyRegularFile(stats: Stats): string | undefined {
  if (!stats.isFile()) return "not a regular file";
  if ((stats.mode & 0o077) !== 0) return "not owner-only";
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) return "not owned by this user";
  return undefined;
}
