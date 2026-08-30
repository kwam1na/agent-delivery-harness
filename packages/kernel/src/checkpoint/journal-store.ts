/**
 * The checkpoint module's durable path: ONE append-only discipline over the
 * frozen journal grammar and reducers, shared by the delivery, intake, and
 * maintenance journals.
 *
 * The store re-authors nothing: every append re-reduces the ENTIRE journal
 * plus the candidate entry through the frozen spine reducer, so the frozen
 * rules — registration-first, revision fencing, idempotency-key replay
 * detection, monotonic fences, the transition matrix, terminal journals —
 * decide what becomes durable. An entry the reducer rejects never touches the
 * file, and durable bytes are only ever extended (`flag: "a"`), never
 * rewritten.
 *
 * ATOMIC CHECKPOINTS. A durable entry is a TERMINATED line: JSON followed by
 * a newline. An interrupted append leaves an unterminated tail whose caller
 * never saw success — it is not a checkpoint, so reads reduce the terminated
 * prefix and the next append truncates the torn tail before extending. A
 * corrupt TERMINATED line is tampering, not interruption, and fails the whole
 * journal closed. In-process appends to one path are serialized so a racing
 * writer is rejected by revision discipline instead of corrupting the file.
 *
 * SECRET DISCIPLINE. Before any byte becomes durable, secret-like values are
 * redacted inside the spine's bounded free-text members and rejected anywhere
 * else (`redaction.ts`) — the append-only journal is the audit surface, and
 * an audit surface never carries a live credential.
 *
 * Durability protections are the plan's owner-only discipline: directories
 * and files carry owner-only modes from first write.
 */
import { appendFile, chmod, mkdir, readFile, truncate } from "node:fs/promises";
import path from "node:path";
import type { SpineRejection } from "../spine/grammar.ts";
import {
  reduceDeliveryJournal,
  reduceIntakeJournal,
  reduceMaintenanceJournal,
  type DeliveryJournalState,
  type IntakeJournalState,
  type MaintenanceJournalState,
} from "../spine/reducer.ts";
import { applySecretDiscipline } from "./redaction.ts";

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

export type JournalAppendResult =
  | { readonly ok: true; readonly expectedRevision: number }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export type JournalReadResult =
  | { readonly ok: true; readonly entries: readonly unknown[]; readonly interruptedTail?: true }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export type JournalStateResult =
  | { readonly ok: true; readonly state: DeliveryJournalState }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export type IntakeStateResult =
  | { readonly ok: true; readonly state: IntakeJournalState }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export type MaintenanceStateResult =
  | { readonly ok: true; readonly state: MaintenanceJournalState }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

interface RawJournal {
  readonly lines: readonly string[];
  /** Byte length of the terminated prefix; equals the file size when clean. */
  readonly terminatedByteLength: number;
  readonly interruptedTail: boolean;
}

async function readRaw(journalPath: string): Promise<RawJournal> {
  let text: string;
  try {
    text = await readFile(journalPath, "utf8");
  } catch {
    return { lines: [], terminatedByteLength: 0, interruptedTail: false };
  }
  const lastNewline = text.lastIndexOf("\n");
  const terminated = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
  const interruptedTail = text.length > terminated.length;
  return {
    lines: terminated.split("\n").filter((line) => line.length > 0),
    terminatedByteLength: Buffer.byteLength(terminated, "utf8"),
    interruptedTail,
  };
}

function parseEntries(lines: readonly string[]): { ok: true; entries: unknown[] } | { ok: false; rejections: SpineRejection[] } {
  const entries: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      return {
        ok: false,
        rejections: [
          {
            code: "not_an_object",
            pointer: `/${index}`,
            message: "a terminated journal line is not JSON; the journal fails closed rather than skipping it",
          },
        ],
      };
    }
  }
  return { ok: true, entries };
}

/**
 * In-process appends to one journal path run strictly one after another, so a
 * racing writer observes the loser's outcome through revision discipline —
 * never a torn or interleaved file.
 */
const appendQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
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

type Reduce<State> = (entries: readonly unknown[]) => { ok: true; state: State } | { ok: false; rejections: readonly SpineRejection[] };

interface Store<State> {
  readonly journalPath: string;
  read(): Promise<JournalReadResult>;
  state(): Promise<{ ok: true; state: State } | { ok: false; rejections: readonly SpineRejection[] }>;
  append(entry: unknown): Promise<JournalAppendResult>;
}

function revisionOf(state: unknown): number {
  return (state as { expectedRevision: number }).expectedRevision;
}

function createStore<State>(journalPath: string, reduce: Reduce<State>): Store<State> {
  return {
    journalPath,

    async read() {
      const raw = await readRaw(journalPath);
      const parsed = parseEntries(raw.lines);
      if (!parsed.ok) return { ok: false, rejections: parsed.rejections };
      return raw.interruptedTail
        ? { ok: true, entries: parsed.entries, interruptedTail: true }
        : { ok: true, entries: parsed.entries };
    },

    async state() {
      const raw = await readRaw(journalPath);
      const parsed = parseEntries(raw.lines);
      if (!parsed.ok) return { ok: false, rejections: parsed.rejections };
      return reduce(parsed.entries);
    },

    append(entry) {
      return serialized(journalPath, async () => {
        const disciplined = applySecretDiscipline(entry);
        if (!disciplined.ok) {
          return {
            ok: false,
            rejections: disciplined.matches.map((match) => ({
              code: "secret_rejected" as const,
              pointer: match.pointer,
              message: `a ${match.id}-shaped secret has no place in this member; the append is refused before any byte is durable`,
            })),
          };
        }

        const raw = await readRaw(journalPath);
        const parsed = parseEntries(raw.lines);
        if (!parsed.ok) return { ok: false, rejections: parsed.rejections };
        const reduced = reduce([...parsed.entries, disciplined.entry]);
        if (!reduced.ok) return reduced;

        await mkdir(path.dirname(journalPath), { recursive: true, mode: OWNER_DIR });
        if (raw.interruptedTail) {
          // The torn tail never committed — its writer never saw success — so
          // truncating it removes no durable entry; accepted bytes are intact.
          await truncate(journalPath, raw.terminatedByteLength);
        }
        await appendFile(journalPath, `${JSON.stringify(disciplined.entry)}\n`, { mode: OWNER_FILE, flag: "a" });
        await chmod(journalPath, OWNER_FILE);
        return { ok: true, expectedRevision: revisionOf(reduced.state) };
      });
    },
  };
}

export interface JournalStore extends Store<DeliveryJournalState> {}

export function createJournalStore(journalPath: string): JournalStore {
  return createStore(journalPath, reduceDeliveryJournal);
}

/**
 * The intake journal shares the store mechanics but reduces through the
 * frozen INTAKE reducer, so the delivery journal's registration entry has a
 * real confirmation chain to reference.
 */
export interface IntakeJournalStore extends Store<IntakeJournalState> {}

export function createIntakeJournalStore(journalPath: string): IntakeJournalStore {
  return createStore(journalPath, reduceIntakeJournal);
}

/**
 * The installation-scoped maintenance journal: retention/export/deletion
 * records live here precisely so they survive their target delivery's
 * removal.
 */
export interface MaintenanceJournalStore extends Store<MaintenanceJournalState> {}

export function createMaintenanceJournalStore(journalPath: string): MaintenanceJournalStore {
  return createStore(journalPath, reduceMaintenanceJournal);
}
