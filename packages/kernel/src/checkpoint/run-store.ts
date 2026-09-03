/**
 * The RUN store: one append-only `<run-id>.jsonl` per delivery run, a
 * per-worktree pointer saying which run is current, and a bounded note per run
 * for the appends that were refused.
 *
 * OBSERVABILITY, NEVER EVIDENCE. Nothing authoritative reads this store. That
 * is not a nicety — it is the reason the location is admissible at all. The
 * store sits under the git COMMON directory so a run outlives the worktree it
 * ran in, which means anything the owner executes in ANY worktree of the
 * repository, candidate scripts included, can read it, append to it, and seal
 * a live run. No gate, admission, or record decision may ever depend on it.
 *
 * WHAT IS DEFENDED, AND WHAT IS NOT. Every journal, note, and pointer is
 * opened with `O_NOFOLLOW` and checked by `fstat` ON THE OPENED DESCRIPTOR —
 * regular file, owner-only mode, owned by this user — rather than by a
 * separate lookup a racing writer could invalidate. Pointers are created
 * exclusively. Run ids are charset-checked before any path is formed, and the
 * charset excludes `.`, so `.`, `..`, a `.jsonl` suffix, and the notes
 * subdirectory are all unreachable by id. Directory COMPONENTS are not
 * defended: node has no `openat`. The residual window against owner-executed
 * code is unclosable, and it is bounded by the paragraph above.
 *
 * NO CLOCK. `at` is the writing process's own instant, handed in by the
 * caller; the store reads no clock (GEN-5), which is why it lives in this
 * sensor-registered directory.
 */
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { SpineRejectionCode } from "../spine/grammar.ts";
import {
  JournalAccessRefused,
  OWNER_DIR,
  OWNER_FILE,
  appendDecided,
  ownerOnlyRegularFile,
  parseJournalLines,
  readRawJournal,
  serializedOnPath,
  type JournalOpenDiscipline,
} from "./append-only-file.ts";
import { applySecretDiscipline } from "./redaction.ts";
import {
  RUN_FREE_TEXT_MEMBERS,
  RUN_STORE_ID,
  isRunInstant,
  reduceToProviderId,
  validateRunEvent,
  validateRunEventInput,
  type RunEvent,
  type RunEventInput,
} from "./run-event.ts";
import { MANAGED_DELIVERY_NAMESPACE, RUN_STORE_DIRECTORY } from "./run-namespace.ts";

/**
 * The run family's own rejection vocabulary: the spine's codes, plus the two
 * this store owns. The spine's frozen code list is NOT widened — a family that
 * could add to it would be a contract revision.
 */
export type RunStoreRejectionCode = SpineRejectionCode | "access_refused" | "unresolvable_run";

export interface RunStoreRejection {
  readonly code: RunStoreRejectionCode;
  readonly pointer: string;
  readonly message: string;
}

export type RunAppendResult =
  | { readonly ok: true; readonly event: RunEvent }
  | { readonly ok: false; readonly rejections: readonly RunStoreRejection[] };

export type RunReadResult =
  | { readonly ok: true; readonly events: readonly RunEvent[] }
  | { readonly ok: false; readonly rejections: readonly RunStoreRejection[] };

export type RunAllocateResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly rejections: readonly RunStoreRejection[] };

export type RunDiscardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejections: readonly RunStoreRejection[] };

export type RunCurrentResult =
  | { readonly ok: true; readonly runId: string | undefined }
  | { readonly ok: false; readonly rejections: readonly RunStoreRejection[] };

export type RunSetCurrentResult =
  | { readonly ok: true; readonly displaced?: string }
  | { readonly ok: false; readonly rejections: readonly RunStoreRejection[] };

export interface RunMatch {
  readonly runId: string;
  /** The other runs whose journals bind the same candidate, most recent first. */
  readonly alsoMatching: readonly string[];
}

export interface RunStore {
  /** `<common-dir>/managed-delivery/runs`. */
  readonly runsDir: string;
  allocate(): Promise<RunAllocateResult>;
  /**
   * Takes back a journal `allocate` created for a run that never began.
   *
   * THE ALLOCATOR'S INVERSE, AND ONLY THAT. `allocate` creates the journal
   * before the two things that can still refuse a start — the `run.started`
   * append and the exclusive pointer write — so a refusal after allocation
   * leaves a journal nothing points at and nothing will ever append to, which
   * `list` then shows beside genuine runs and a retry produces one more of.
   *
   * A journal carrying anything but its own `run.started` is a run with
   * history, and history in an append-only store is not the allocator's to
   * delete: both a second event and a lone event that is not a start are
   * refused. That is the whole guard. A pointer check beside it would make
   * neither clause provable on its own.
   */
  discard(runId: string): Promise<RunDiscardResult>;
  append(runId: string, event: RunEventInput): Promise<RunAppendResult>;
  /**
   * Records one bounded line for an append a CALLER refused before it reached
   * `append` — today, exactly `emit`'s refusal of `command.completed`, which is
   * writer-policy rather than a contract violation the validator could catch.
   * The line is written by the same bounded writer a refused `append` uses, so
   * there is one note format and one place that decides what a note may carry.
   */
  noteRefusal(runId: string, event: RunEventInput, rejection: RunStoreRejection): Promise<void>;
  read(runId: string): Promise<RunReadResult>;
  readNotes(runId: string): Promise<readonly unknown[]>;
  list(): Promise<readonly string[]>;
  current(worktreeKey: string): Promise<RunCurrentResult>;
  setCurrent(worktreeKey: string, runId: string, options?: { readonly force?: boolean }): Promise<RunSetCurrentResult>;
  clearCurrent(worktreeKey: string, runId: string): Promise<boolean>;
  findByCandidateTreeSha(treeSha: string): Promise<RunMatch | undefined>;
}

const JOURNAL_SUFFIX = ".jsonl";
const NOTES_DIRECTORY = "notes";
const CURRENT_DIRECTORY = "current";

/** A pointer names one run id; nothing longer than that is worth reading. */
const MAX_POINTER_BYTES = 256;

/** Worktree keys are sha256 hex; anything else never names a pointer file. */
const WORKTREE_KEY = /^[0-9a-f]{64}$/;

const NOFOLLOW: JournalOpenDiscipline = {
  extraFlags: fsConstants.O_NOFOLLOW,
  verify: ownerOnlyRegularFile,
  refuseOnError: true,
};

const reject = (code: RunStoreRejectionCode, pointer: string, message: string): readonly RunStoreRejection[] => [
  { code, pointer, message },
];

const refusalOf = (error: unknown, pointer: string): readonly RunStoreRejection[] | undefined =>
  error instanceof JournalAccessRefused
    ? reject("access_refused", pointer, `the store refuses this path: ${error.reason}`)
    : undefined;

function isLegalRunId(runId: unknown): runId is string {
  return typeof runId === "string" && runId.length <= 128 && RUN_STORE_ID.test(runId);
}

export function createRunStore(commonDir: string): RunStore {
  const runsDir = path.join(commonDir, MANAGED_DELIVERY_NAMESPACE, RUN_STORE_DIRECTORY);
  const notesDir = path.join(runsDir, NOTES_DIRECTORY);
  const currentDir = path.join(runsDir, CURRENT_DIRECTORY);

  /**
   * Forms a path only for an id the charset admits, and only inside `runs/`.
   * Both checks run before any syscall, so a hostile id never reaches the
   * filesystem at all.
   */
  const journalPathFor = (runId: string): string | undefined => {
    if (!isLegalRunId(runId)) return undefined;
    const resolved = path.join(runsDir, `${runId}${JOURNAL_SUFFIX}`);
    return path.dirname(resolved) === runsDir ? resolved : undefined;
  };

  const notePathFor = (runId: string): string | undefined => {
    if (!isLegalRunId(runId)) return undefined;
    const resolved = path.join(notesDir, `${runId}${JOURNAL_SUFFIX}`);
    return path.dirname(resolved) === notesDir ? resolved : undefined;
  };

  const pointerPathFor = (worktreeKey: string): string | undefined => {
    if (!WORKTREE_KEY.test(worktreeKey)) return undefined;
    const resolved = path.join(currentDir, worktreeKey);
    return path.dirname(resolved) === currentDir ? resolved : undefined;
  };

  /** Present, and passing the discipline. Throws `JournalAccessRefused` otherwise. */
  const journalExists = async (journalPath: string): Promise<boolean> => {
    let handle;
    try {
      handle = await open(journalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new JournalAccessRefused(journalPath, (error as NodeJS.ErrnoException).code ?? "unreadable");
    }
    try {
      const refusal = ownerOnlyRegularFile(await handle.stat());
      if (refusal !== undefined) throw new JournalAccessRefused(journalPath, refusal);
      return true;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  /**
   * One bounded line naming what was refused and why. Never the payload, never
   * an error string. A note write that is itself refused is dropped with no
   * retry: the append's rejection is what the caller needs, and a store
   * failure may never change a command's outcome.
   */
  const note = async (runId: string, event: RunEventInput, rejection: RunStoreRejection, pattern?: string): Promise<void> => {
    const notePath = notePathFor(runId);
    if (notePath === undefined) return;
    const kindLike = typeof (event as { kind?: unknown }).kind === "string" ? (event as { kind: string }).kind : "";
    const line = {
      kind: reduceToProviderId(kindLike),
      code: rejection.code,
      ...(pattern === undefined ? {} : { pattern }),
      ...(isRunInstant((event as { at?: unknown }).at) ? { at: (event as { at: string }).at } : {}),
    };
    try {
      await mkdir(notesDir, { recursive: true, mode: OWNER_DIR });
      const handle = await open(
        notePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
        OWNER_FILE,
      );
      try {
        if (ownerOnlyRegularFile(await handle.stat()) !== undefined) return;
        await handle.writeFile(`${JSON.stringify(line)}\n`, "utf8");
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch {
      // Dropped, deliberately and silently.
    }
  };

  const readJournalFile = async (journalPath: string): Promise<RunReadResult> => {
    let raw;
    try {
      raw = await readRawJournal(journalPath, NOFOLLOW);
    } catch (error) {
      return { ok: false, rejections: refusalOf(error, "") ?? reject("access_refused", "", "the journal could not be read") };
    }
    const parsed = parseJournalLines(raw.lines);
    if (!parsed.ok) {
      return {
        ok: false,
        rejections: reject(
          "not_an_object",
          `/${parsed.unparsableLineIndex}`,
          "a terminated journal line is not JSON; the journal fails closed rather than skipping it",
        ),
      };
    }
    const events: RunEvent[] = [];
    for (const [index, entry] of parsed.entries.entries()) {
      const verdict = validateRunEvent(entry);
      if (!verdict.ok) {
        return {
          ok: false,
          rejections: verdict.rejections.map((rejection) => ({ ...rejection, pointer: `/${index}${rejection.pointer}` })),
        };
      }
      events.push(entry as RunEvent);
    }
    return { ok: true, events };
  };

  return {
    runsDir,

    async allocate() {
      await mkdir(runsDir, { recursive: true, mode: OWNER_DIR });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const runId = `run-${randomBytes(8).toString("hex")}`;
        const journalPath = journalPathFor(runId);
        if (journalPath === undefined) continue;
        try {
          const handle = await open(
            journalPath,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
            OWNER_FILE,
          );
          await handle.close();
          return { ok: true, runId };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          return { ok: false, rejections: reject("access_refused", "", `the run journal could not be created: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`) };
        }
      }
      return { ok: false, rejections: reject("access_refused", "", "no unused run id was available after eight attempts") };
    },

    async discard(runId) {
      const journalPath = journalPathFor(runId);
      if (journalPath === undefined) {
        return { ok: false, rejections: reject("malformed_member", "/runId", "the run id is not admissible to this store") };
      }
      const read = await this.read(runId);
      if (!read.ok) return { ok: false, rejections: read.rejections };
      const [first, ...rest] = read.events;
      if (rest.length > 0) {
        return {
          ok: false,
          rejections: reject("invalid_transition", "/seq", "this run carries history beyond its start; a journal with history is never discarded"),
        };
      }
      if (first !== undefined && first.kind !== "run.started") {
        return {
          ok: false,
          rejections: reject("invalid_transition", "/kind", `this journal's one event is ${first.kind}, not the start it was allocated for; it is never discarded`),
        };
      }
      try {
        await unlink(journalPath);
      } catch (error) {
        return {
          ok: false,
          rejections: reject("access_refused", "", `the run journal could not be removed: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`),
        };
      }
      // The notes entry goes with the journal. A note is a line IN a run's
      // record, so one left behind would be `readNotes` answering for an id
      // `list` has never heard of — the same thing the store refuses to create
      // for an unresolvable run.
      const notePath = notePathFor(runId);
      if (notePath !== undefined) await unlink(notePath).catch(() => undefined);
      return { ok: true };
    },

    async append(runId, event) {
      const journalPath = journalPathFor(runId);
      if (journalPath === undefined) {
        return { ok: false, rejections: reject("malformed_member", "/runId", "the run id is not admissible to this store") };
      }

      let pattern: string | undefined;
      let outcome;
      try {
        outcome = await appendDecided<RunEvent, readonly RunStoreRejection[]>({
          journalPath,
          discipline: NOFOLLOW,
          async decide(read) {
            // Secret discipline runs FIRST, before shape validation, so a live
            // credential is reported as a credential rather than as whatever
            // shape rule it happened to break on the way past.
            const disciplined = applySecretDiscipline(event, RUN_FREE_TEXT_MEMBERS);
            if (!disciplined.ok) {
              pattern = disciplined.matches[0]?.id;
              return {
                ok: false,
                rejected: disciplined.matches.map((match) => ({
                  code: "secret_rejected" as const,
                  pointer: match.pointer,
                  message: `a ${match.id}-shaped secret has no place in this member; the append is refused before any byte is durable`,
                })),
              };
            }

            if (!(await journalExists(journalPath))) {
              return {
                ok: false,
                rejected: reject("unresolvable_run", "/runId", "no journal exists for this run; only allocate() creates one"),
              };
            }

            const parsed = await read();
            if (!parsed.ok) {
              return {
                ok: false,
                rejected: reject(
                  "not_an_object",
                  `/${parsed.unparsableLineIndex}`,
                  "a terminated journal line is not JSON; the journal fails closed rather than skipping it",
                ),
              };
            }

            const kinds = parsed.entries.map((entry) => (entry as { kind?: unknown }).kind);
            const candidate = disciplined.entry as Record<string, unknown>;
            const kind = candidate["kind"];
            const role = (candidate["actor"] as { role?: unknown } | undefined)?.role;

            if (kinds.includes("run.ended")) {
              return { ok: false, rejected: reject("journal_terminal", "/kind", "this run has ended; nothing may be appended after run.ended") };
            }
            if (kind === "run.started" && kinds.includes("run.started")) {
              return { ok: false, rejected: reject("invalid_transition", "/kind", "this run has already started; a run starts exactly once") };
            }
            if (role === "cli" && kind !== "command.completed") {
              return {
                ok: false,
                rejected: reject(
                  "unsupported_combination",
                  "/actor/role",
                  "only command.completed may be written by the CLI; every other kind is the executor's",
                ),
              };
            }
            if (candidate["runId"] !== runId) {
              return { ok: false, rejected: reject("subject_mismatch", "/runId", "the event names a different run than the journal it is being appended to") };
            }

            // THE INPUT IS VALIDATED FIRST, through the store's own entry
            // point, which admits no `seq`. That ordering is what makes the
            // assignment below safe: the assignment is keyed on `runId`, so a
            // `seq` appearing later in the input would overwrite the count the
            // store just took, and the after-the-fact validation cannot tell
            // the two apart — both are positive integers.
            const admitted = validateRunEventInput(candidate);
            if (!admitted.ok) return { ok: false, rejected: admitted.rejections };

            // `seq` is the store's to assign, and only here: it is the
            // journal's own count, taken inside the critical section.
            const durable: Record<string, unknown> = {};
            for (const [name, value] of Object.entries(candidate)) {
              durable[name] = value;
              if (name === "runId") durable["seq"] = parsed.entries.length + 1;
            }
            const verdict = validateRunEvent(durable);
            if (!verdict.ok) return { ok: false, rejected: verdict.rejections };

            return { ok: true, entry: durable, accepted: durable as unknown as RunEvent };
          },
        });
      } catch (error) {
        const refusal = refusalOf(error, "");
        if (refusal === undefined) throw error;
        await note(runId, event, refusal[0] as RunStoreRejection);
        return { ok: false, rejections: refusal };
      }

      if (outcome.ok) return { ok: true, event: outcome.accepted };
      const first = outcome.rejected[0];
      // Every rejection is noted but one. A note is a line IN a run's record,
      // and `unresolvable_run` is the store saying there is no such run: a
      // note for it would create that run's notes entry for an id `list` has
      // never heard of, so a typo would leave a permanent record of a run that
      // never existed.
      if (first !== undefined && first.code !== "unresolvable_run") await note(runId, event, first, pattern);
      return { ok: false, rejections: outcome.rejected };
    },

    async noteRefusal(runId, event, rejection) {
      await note(runId, event, rejection);
    },

    async read(runId) {
      const journalPath = journalPathFor(runId);
      if (journalPath === undefined) {
        return { ok: false, rejections: reject("malformed_member", "/runId", "the run id is not admissible to this store") };
      }
      try {
        if (!(await journalExists(journalPath))) {
          return { ok: false, rejections: reject("unresolvable_run", "/runId", "no journal exists for this run") };
        }
      } catch (error) {
        const refusal = refusalOf(error, "");
        if (refusal === undefined) throw error;
        return { ok: false, rejections: refusal };
      }
      return readJournalFile(journalPath);
    },

    async readNotes(runId) {
      const notePath = notePathFor(runId);
      if (notePath === undefined) return [];
      try {
        const raw = await readRawJournal(notePath, NOFOLLOW);
        const parsed = parseJournalLines(raw.lines);
        return parsed.ok ? parsed.entries : [];
      } catch {
        return [];
      }
    },

    async list() {
      let entries: string[];
      try {
        entries = await readdir(runsDir);
      } catch {
        return [];
      }
      return entries
        .filter((entry) => entry.endsWith(JOURNAL_SUFFIX))
        .map((entry) => entry.slice(0, -JOURNAL_SUFFIX.length))
        .filter((runId) => isLegalRunId(runId))
        .sort();
    },

    async current(worktreeKey) {
      const pointerPath = pointerPathFor(worktreeKey);
      if (pointerPath === undefined) {
        return { ok: false, rejections: reject("malformed_member", "/worktreeKey", "the worktree key is not a sha256 digest") };
      }
      let handle;
      try {
        handle = await open(pointerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, runId: undefined };
        return { ok: false, rejections: reject("access_refused", "", `the pointer refuses to be read: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`) };
      }
      try {
        const refusal = ownerOnlyRegularFile(await handle.stat());
        if (refusal !== undefined) return { ok: false, rejections: reject("access_refused", "", `the pointer refuses to be read: ${refusal}`) };
        // Size-bounded: a pointer names one run id, so nothing beyond that
        // bound is ever read, let alone parsed.
        const buffer = Buffer.alloc(MAX_POINTER_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_POINTER_BYTES) return { ok: true, runId: undefined };
        const named = buffer.subarray(0, bytesRead).toString("utf8").trim();
        if (!isLegalRunId(named)) return { ok: true, runId: undefined };
        const journalPath = journalPathFor(named);
        if (journalPath === undefined) return { ok: true, runId: undefined };
        try {
          return (await journalExists(journalPath)) ? { ok: true, runId: named } : { ok: true, runId: undefined };
        } catch {
          // An orphaned or undisciplined journal is no current run; the
          // pointer itself was fine, so this is not the pointer's refusal.
          return { ok: true, runId: undefined };
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    },

    async setCurrent(worktreeKey, runId, options) {
      const pointerPath = pointerPathFor(worktreeKey);
      if (pointerPath === undefined) {
        return { ok: false, rejections: reject("malformed_member", "/worktreeKey", "the worktree key is not a sha256 digest") };
      }
      if (!isLegalRunId(runId)) {
        return { ok: false, rejections: reject("malformed_member", "/runId", "the run id is not admissible to this store") };
      }
      return serializedOnPath(pointerPath, async () => {
        await mkdir(currentDir, { recursive: true, mode: OWNER_DIR });
        const write = async (): Promise<RunSetCurrentResult | undefined> => {
          try {
            const handle = await open(
              pointerPath,
              fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
              OWNER_FILE,
            );
            try {
              await handle.writeFile(runId, "utf8");
            } finally {
              await handle.close().catch(() => undefined);
            }
            return { ok: true };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
            return {
              ok: false,
              rejections: reject("invalid_transition", "", `the pointer could not be created: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`),
            };
          }
        };

        const created = await write();
        if (created !== undefined) return created;
        if (options?.force !== true) {
          return {
            ok: false,
            rejections: reject("invalid_transition", "", "a run is already current for this worktree; --force displaces it"),
          };
        }
        const displaced = await this.current(worktreeKey);
        await unlink(pointerPath).catch(() => undefined);
        const forced = await write();
        if (forced === undefined) {
          return { ok: false, rejections: reject("invalid_transition", "", "the pointer could not be displaced") };
        }
        if (!forced.ok) return forced;
        const previous = displaced.ok ? displaced.runId : undefined;
        return previous === undefined ? { ok: true } : { ok: true, displaced: previous };
      });
    },

    async clearCurrent(worktreeKey, runId) {
      const pointerPath = pointerPathFor(worktreeKey);
      if (pointerPath === undefined) return false;
      return serializedOnPath(pointerPath, async () => {
        const named = await this.current(worktreeKey);
        if (!named.ok || named.runId !== runId) return false;
        await unlink(pointerPath).catch(() => undefined);
        return true;
      });
    },

    async findByCandidateTreeSha(treeSha) {
      interface Ranked {
        readonly runId: string;
        readonly startedAt: string | undefined;
      }
      const matches: Ranked[] = [];
      for (const runId of await this.list()) {
        const read = await this.read(runId);
        if (!read.ok) continue;
        if (!read.events.some((entry) => entry.candidateTreeSha === treeSha)) continue;
        const started = read.events.find((entry) => entry.kind === "run.started");
        matches.push({ runId, startedAt: isRunInstant(started?.at) ? started.at : undefined });
      }
      // Most recently started first. A journal with no usable `run.started`
      // sorts after every journal that has one — it can never displace a run
      // whose start is known. Ties at any rank break on the lexicographically
      // GREATEST run id, so a same-second tie is deterministic, if not
      // temporal: `at` is second-granularity.
      matches.sort((left, right) => {
        if (left.startedAt !== right.startedAt) {
          if (left.startedAt === undefined) return 1;
          if (right.startedAt === undefined) return -1;
          return left.startedAt < right.startedAt ? 1 : -1;
        }
        return left.runId < right.runId ? 1 : -1;
      });
      const [selected, ...rest] = matches;
      return selected === undefined ? undefined : { runId: selected.runId, alsoMatching: rest.map((entry) => entry.runId) };
    },
  };
}
