/**
 * The checkpoint module's V-slice: ONE append-only durable path over the
 * frozen journal grammar and reducers.
 *
 * The store re-authors nothing: every append re-reduces the ENTIRE journal
 * plus the candidate entry through the frozen spine reducer, so the frozen
 * rules — registration-first, revision fencing, idempotency-key replay
 * detection, monotonic fences, the transition matrix, terminal journals —
 * decide what becomes durable. An entry the reducer rejects never touches the
 * file, and durable bytes are only ever extended (`flag: "a"`), never
 * rewritten.
 *
 * Durability protections are D16's: owner-only directories and files from
 * first write. Retention, export, and deletion are the checkpoint unit's
 * hardening; the append path and its discipline stay.
 */
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SpineRejection } from "../spine/grammar.ts";
import { reduceDeliveryJournal, reduceIntakeJournal, type DeliveryJournalState, type IntakeJournalState } from "../spine/reducer.ts";

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

export type JournalAppendResult =
  | { readonly ok: true; readonly expectedRevision: number }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export type JournalStateResult =
  | { readonly ok: true; readonly state: DeliveryJournalState }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export type IntakeStateResult =
  | { readonly ok: true; readonly state: IntakeJournalState }
  | { readonly ok: false; readonly rejections: readonly SpineRejection[] };

export interface JournalStore {
  readonly journalPath: string;
  /** Every durable entry, parsed. Corrupt bytes fail closed as rejections. */
  read(): Promise<{ ok: true; entries: readonly unknown[] } | { ok: false; rejections: readonly SpineRejection[] }>;
  /** Reduce the durable delivery journal to its state. */
  state(): Promise<JournalStateResult>;
  /** Append one entry iff the frozen reducer accepts the extended journal. */
  append(entry: unknown): Promise<JournalAppendResult>;
}

async function readLines(journalPath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(journalPath, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.length > 0);
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
            message: "a durable journal line is not JSON; the journal fails closed rather than skipping it",
          },
        ],
      };
    }
  }
  return { ok: true, entries };
}

export function createJournalStore(journalPath: string): JournalStore {
  return {
    journalPath,

    async read() {
      const parsed = parseEntries(await readLines(journalPath));
      return parsed.ok ? { ok: true, entries: parsed.entries } : { ok: false, rejections: parsed.rejections };
    },

    async state() {
      const parsed = parseEntries(await readLines(journalPath));
      if (!parsed.ok) return { ok: false, rejections: parsed.rejections };
      return reduceDeliveryJournal(parsed.entries);
    },

    async append(entry) {
      const parsed = parseEntries(await readLines(journalPath));
      if (!parsed.ok) return { ok: false, rejections: parsed.rejections };
      const reduced = reduceDeliveryJournal([...parsed.entries, entry]);
      if (!reduced.ok) return reduced;

      await mkdir(path.dirname(journalPath), { recursive: true, mode: OWNER_DIR });
      await appendFile(journalPath, `${JSON.stringify(entry)}\n`, { mode: OWNER_FILE, flag: "a" });
      await chmod(journalPath, OWNER_FILE);
      return { ok: true, expectedRevision: reduced.state.expectedRevision };
    },
  };
}

/**
 * The intake journal shares the store mechanics but reduces through the
 * frozen INTAKE reducer. The walking skeleton records the direct already-
 * scoped handoff here — presentation, the operator's contract confirmation,
 * validation, acceptance — so the delivery journal's registration entry has a
 * real confirmation to reference.
 */
export interface IntakeJournalStore {
  readonly journalPath: string;
  read(): Promise<{ ok: true; entries: readonly unknown[] } | { ok: false; rejections: readonly SpineRejection[] }>;
  state(): Promise<IntakeStateResult>;
  append(entry: unknown): Promise<JournalAppendResult>;
}

export function createIntakeJournalStore(journalPath: string): IntakeJournalStore {
  return {
    journalPath,

    async read() {
      const parsed = parseEntries(await readLines(journalPath));
      return parsed.ok ? { ok: true, entries: parsed.entries } : { ok: false, rejections: parsed.rejections };
    },

    async state() {
      const parsed = parseEntries(await readLines(journalPath));
      if (!parsed.ok) return { ok: false, rejections: parsed.rejections };
      return reduceIntakeJournal(parsed.entries);
    },

    async append(entry) {
      const parsed = parseEntries(await readLines(journalPath));
      if (!parsed.ok) return { ok: false, rejections: parsed.rejections };
      const reduced = reduceIntakeJournal([...parsed.entries, entry]);
      if (!reduced.ok) return reduced;

      await mkdir(path.dirname(journalPath), { recursive: true, mode: OWNER_DIR });
      await appendFile(journalPath, `${JSON.stringify(entry)}\n`, { mode: OWNER_FILE, flag: "a" });
      await chmod(journalPath, OWNER_FILE);
      return { ok: true, expectedRevision: reduced.state.expectedRevision };
    },
  };
}
