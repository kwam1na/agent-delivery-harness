/**
 * What `emit`, `runs`, and the boundary wrap share: how the run store is
 * found, how an event envelope is built, and how a store-derived string is
 * made safe to print.
 *
 * THE ONE STORE OVERRIDE. `DELIVERY_HARNESS_RUN_STORE` names an absolute
 * directory to resolve the store under instead of the repository's git common
 * directory, read HERE — at resolution time, on every CLI path that reaches a
 * run store — so no path can be honouring it while another is not. It exists
 * because a process that is not a delivery can invoke this CLI from a worktree
 * that has a delivery run current: the repository's own test suite does,
 * hundreds of times per `npm run check`, and every wrapped invocation appended
 * a `command.completed` to whatever run the executor had open there. Such a
 * process pins the override at a directory of its own and is thereby unable to
 * reach any live store. An invocation with the override unset writes where it
 * always did; an invocation under test with it unset is a defect in the test,
 * not a behaviour of the product, so nothing here tries to detect a test
 * runner.
 *
 * WHAT THE OVERRIDE DOES NOT COLLAPSE. Each repository keeps its own store
 * under the named directory, at a subdirectory digested from its common
 * directory, so the two rules the surface documents survive being overridden:
 * two paths in different repositories are two stores, and two worktrees of one
 * repository are one store. `repo.commonDir` on every event still names the
 * repository, never the override — the event says where the run happened, not
 * where its journal was filed.
 *
 * WHY THE STORE IS RESOLVED HERE AND NOT WIRED. The record store is wired from
 * the config, because a delivery record belongs to a configured gate. A run
 * belongs to the *repository* — it outlives the worktree it ran in and it
 * exists in repositories that have no harness config at all. So the run store
 * is resolved from git and nothing else, through the kernel's namespace
 * resolver, with a direct runner and the `GIT_` namespace cleared: an
 * inherited `GIT_DIR` must never relocate the store into someone else's
 * repository.
 *
 * WHY EVERY PRINTED STRING GOES THROUGH `oneLine`. A journal carries
 * executor-written free text — rationales, decisions, blocker summaries. It is
 * rendered to a terminal in a row-per-event table, so an escape sequence could
 * repaint the screen and an embedded newline could forge a row that looks
 * exactly like a CLI-written completion. Neutralizing strips the sequences;
 * collapsing the whitespace is what removes the second attack, and it has to
 * happen on every single-line field, not just the ones that look risky.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import {
  createBlocker,
  createRunStore,
  sha256Hex,
  evaluateRunJournal,
  explainRunJournal,
  gitNamespaceClearedEnvironment,
  neutralizeForDisplay,
  resolveRunStoreLocation,
  runGitDirect,
  type Blocker,
  type RunEventInput,
  type RunEventKind,
  type RunJournalRoundBinding,
  type RunJournalRow,
  type RunStore,
} from "@agent-delivery-harness/kernel";

/** The config-free commands' own source id family. */
export const RUN_SURFACE_SOURCE = "delivery-harness.cli.run-surface";

export interface RunSurface {
  readonly store: RunStore;
  /** The repository's OWN git common directory, which is what an event names. */
  readonly commonDir: string;
  /** The store's `runs` directory, under the override when one is named. */
  readonly runsDir: string;
  /** The invoking worktree's pointer key — the identity of "the current run" here. */
  readonly worktreeKey: string;
}

export type RunSurfaceResolution =
  | { readonly ok: true; readonly surface: RunSurface }
  | { readonly ok: false; readonly reason: string };

/** The environment variable that relocates the run store. See this file's header. */
export const RUN_STORE_OVERRIDE = "DELIVERY_HARNESS_RUN_STORE";

/**
 * The directory the store is rooted at for a repository whose common directory
 * is `commonDir`.
 *
 * Blank is unset, following this repository's other environment levers. A
 * value that is set but not absolute FAILS CLOSED — the resolution is refused
 * rather than falling back to the repository's own store, because a caller
 * that mis-spells its override is exactly the caller that must not reach a
 * live store by accident.
 */
function storeRootFor(
  commonDir: string,
  override: string | undefined,
): { readonly ok: true; readonly root: string } | { readonly ok: false; readonly reason: string } {
  const named = override?.trim() ?? "";
  if (named.length === 0) return { ok: true, root: commonDir };
  if (!path.isAbsolute(named)) {
    return { ok: false, reason: `${RUN_STORE_OVERRIDE} must name an absolute directory` };
  }
  return { ok: true, root: path.join(named, sha256Hex(commonDir)) };
}

/**
 * Resolves the run store for the invoking worktree. Never throws: a config-free
 * command turns a failure into a typed blocker, and the boundary wrap turns it
 * into silence.
 *
 * The override is read here, on this one path, because this is the one path
 * every CLI reach for a run store goes through: `emit`, `runs`, `runs serve`,
 * the boundary wrap's automatic completion, and `verify`'s journal row.
 */
export async function resolveRunSurface(cwd: string): Promise<RunSurfaceResolution> {
  const location = await resolveRunStoreLocation({
    cwd,
    run: runGitDirect,
    env: gitNamespaceClearedEnvironment(),
  });
  if (!location.ok) return { ok: false, reason: location.reason };
  const rooted = storeRootFor(location.commonDir, process.env[RUN_STORE_OVERRIDE]);
  if (!rooted.ok) return { ok: false, reason: rooted.reason };
  const store = createRunStore(rooted.root);
  return {
    ok: true,
    surface: {
      store,
      commonDir: location.commonDir,
      runsDir: store.runsDir,
      worktreeKey: location.worktreeKey,
    },
  };
}

/**
 * The worktree ROOT of a path, for the one thing the run surface needs it for:
 * the config-presence note names a root, and BOTH surfaces resolve it here.
 * `runs serve` renders a root the operator named rather than the one it was
 * invoked in; `runs show` renders the root of the worktree it was invoked in
 * rather than the directory, which may be any depth below it. One question
 * about one repository has to have one answer whichever surface asks it.
 *
 * `--show-toplevel` is a plumbing query that reads no index and runs no hook,
 * alias, or pager, and it runs here with the `GIT_` namespace cleared for the
 * same reason the store resolution does: a `GIT_DIR` inherited from the
 * operator's shell must not decide which repository a `--repo` path names.
 */
export async function resolveWorktreeRoot(
  cwd: string,
): Promise<{ readonly ok: true; readonly root: string } | { readonly ok: false; readonly reason: string }> {
  const outcome = await runGitDirect({
    cwd,
    args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    env: gitNamespaceClearedEnvironment(),
  });
  const root = outcome.stdout.trim();
  if (outcome.code !== 0 || root.length === 0) return { ok: false, reason: `not a git worktree: ${cwd}` };
  return { ok: true, root };
}

/**
 * The writing process's own instant, at the contract's second granularity.
 * `at` is never settable through an argument surface: whoever writes the event
 * is whoever is holding the clock.
 */
export function runInstant(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/** The two envelope members a payload may own; both are copied, never invented. */
const MIRRORED = ["ticket", "candidateTreeSha"] as const;

/**
 * Builds the envelope around a payload. The mirrored members are copied
 * verbatim — including a value the validator will reject — because the store
 * requires the envelope and the payload to agree exactly, and a "helpful"
 * coercion here would turn a malformed payload into a disagreement instead.
 */
export function buildRunEvent(input: {
  readonly runId: string;
  readonly commonDir: string;
  readonly kind: string;
  readonly role: "cli" | "executor";
  readonly payload: unknown;
  readonly version?: "run-event/1" | "run-event/2";
  readonly eventId?: string;
}): RunEventInput {
  const payload = typeof input.payload === "object" && input.payload !== null ? (input.payload as Record<string, unknown>) : undefined;
  const mirrored: Record<string, unknown> = {};
  if (payload !== undefined) {
    for (const member of MIRRORED) {
      if (Object.prototype.hasOwnProperty.call(payload, member) && payload[member] !== undefined) {
        mirrored[member] = payload[member];
      }
    }
  }
  return {
    version: input.version ?? "run-event/1",
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    runId: input.runId,
    at: runInstant(),
    repo: { commonDir: input.commonDir },
    kind: input.kind as RunEventKind,
    actor: { role: input.role },
    ...mirrored,
    attestation: "self",
    payload: (input.payload ?? null) as Readonly<Record<string, unknown>>,
  } as RunEventInput;
}

/**
 * One row's worth of a string: neutralized, then whitespace-collapsed so no
 * free-text member can end a row and start one of its own, then bounded.
 */
export function oneLine(value: string, maximum = 240): string {
  const collapsed = neutralizeForDisplay(value).replace(/\s+/g, " ").trim();
  return collapsed.length <= maximum ? collapsed : `${collapsed.slice(0, Math.max(maximum - 1, 0))}…`;
}

/** The same treatment for anything that is not already a string. */
export function oneLineOf(value: unknown, maximum = 240): string {
  if (typeof value === "string") return oneLine(value, maximum);
  if (value === undefined) return "";
  return oneLine(JSON.stringify(value) ?? String(value), maximum);
}

/**
 * The labels the row carries wherever it is printed. `bound to the record` is
 * the one that differs from the viewer's: `verify` always has a record's tree
 * sha, so its round constraints were judged against THIS candidate rather than
 * against any paired round.
 */
export const RUN_JOURNAL_ROW_LABELS = "self-attested; observability, not evidence; bound to the record";

/** Nothing was found, so nothing was evaluated. The one shape `absent` takes. */
const ABSENT: RunJournalRow = { status: "absent", missing: [], attestation: "self" };

/**
 * The self-attested completeness row for the candidate a delivery record binds.
 *
 * FOUND BY THE RECORD'S TREE SHA, NOT BY THE POINTER. The run whose journal
 * describes this candidate has usually ended by the time anyone verifies it,
 * and `run.ended` clears the worktree pointer — so "the current run" is exactly
 * the wrong question. The store scans instead, which is affordable because it
 * is unpruned by design and small, and which is what lets a journal outlive the
 * worktree its run happened in.
 *
 * EVERY FAILURE IS `absent`. No store, no match, a journal that refuses the
 * read discipline, a journal that vanished between the scan and the read: the
 * row says nothing was found rather than inventing a verdict. A reader that
 * treats `absent` as a failure does so behind its own opt-in — this function
 * never decides that.
 */
export async function resolveRunJournalRow(input: {
  readonly cwd: string;
  readonly treeSha: string;
  readonly reviewedCandidateTreeShas?: readonly string[];
  readonly mandatedLensIds?: readonly string[];
}): Promise<RunJournalRow> {
  const resolved = await resolveRunSurface(input.cwd);
  if (!resolved.ok) return ABSENT;
  const acceptedTrees = [...new Set([input.treeSha, ...(input.reviewedCandidateTreeShas ?? [])])];
  const matches = await Promise.all(acceptedTrees.map((treeSha) => resolved.surface.store.findByCandidateTreeSha(treeSha)));
  const match = matches.find((entry) => entry !== undefined);
  if (match === undefined) return ABSENT;
  const read = await resolved.surface.store.read(match.runId);
  if (!read.ok) return ABSENT;
  const evaluation = evaluateRunJournal(read.events, input.treeSha, input.mandatedLensIds, acceptedTrees.slice(1));
  // The same arguments, so the explanations describe exactly these violations.
  const diagnostics = explainRunJournal(read.events, input.treeSha, input.mandatedLensIds, acceptedTrees.slice(1));
  const alsoMatching = [...new Set(matches.flatMap((entry) => entry === undefined ? [] : [entry.runId, ...entry.alsoMatching]))]
    .filter((runId) => runId !== match.runId);
  return {
    runId: match.runId,
    ...(alsoMatching.length === 0 ? {} : { alsoMatching }),
    status: evaluation.status,
    missing: evaluation.missing,
    ...(evaluation.violations.length === 0 ? {} : { violations: evaluation.violations, explanations: diagnostics.explanations }),
    ...(acceptedTrees.length === 1 ? {} : { recordTreeSha: input.treeSha, reviewedCandidateTreeShas: acceptedTrees.slice(1) }),
    ...(diagnostics.roundBinding === undefined ? {} : { roundBinding: diagnostics.roundBinding }),
    attestation: "self",
  };
}

/**
 * The instants a delivery record stamps: the journal's own first and last.
 *
 * `endedAt` is the last instant the journal had REACHED when it was read, not
 * the run's ending — `record` runs long before `run.ended`, and a record that
 * waited for the run to end would never be written. So the pair is the span the
 * delivery had spent by the time it recorded, which is the figure the record is
 * for; `runs show` is where the run's own ending is read.
 */
export interface RunSpanRow {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

/**
 * The span of the journal that describes this candidate, or nothing.
 *
 * FOUND BY TREE SHA FIRST, for the reason `resolveRunJournalRow` is: a journal
 * bound to this candidate is one that provably describes it, and by verify time
 * the run has usually ended and cleared the worktree pointer. The pointer is a
 * FALLBACK and only where the caller says so, because the two callers need
 * different things from a miss. `record` is stamping: it runs mid-run, before
 * anything need have journaled this exact tree, and the worktree's current run
 * is the run it is recording from — a best-effort stamp is better than none.
 * `verify` is refusing: a refusal must rest on a journal that binds the
 * candidate the record binds, never on whichever run happens to be current in
 * the checkout someone verified from, so it asks without the fallback and
 * reports the miss as unchecked.
 *
 * MORE THAN ONE RUN CAN BIND ONE CANDIDATE, and the store says so: a delivery
 * that recorded in run A and is verified from a later run B in the same
 * worktree has two journals naming that tree, and `findByCandidateTreeSha`
 * returns the most recently started one with the rest in `alsoMatching`.
 * Refusing on whichever sorted first would block an honest record whose span
 * run A reports exactly. So a caller that already knows the span it is checking
 * passes `preferStartedAt`, and the matching run whose journal starts there is
 * the one returned; only where NO matching run starts there does the
 * top-ranked run stand, which is the case a refusal may rest on.
 *
 * Every failure is nothing found: no store, no match, an unreadable journal, an
 * empty one. Nothing here decides what a miss means.
 */
export async function resolveRunSpan(input: {
  readonly cwd: string;
  readonly treeSha: string;
  readonly allowCurrentRun?: boolean;
  readonly preferStartedAt?: string;
}): Promise<RunSpanRow | undefined> {
  const resolved = await resolveRunSurface(input.cwd);
  if (!resolved.ok) return undefined;
  const matched = await resolved.surface.store.findByCandidateTreeSha(input.treeSha);
  const runIds: string[] = matched === undefined ? [] : [matched.runId, ...matched.alsoMatching];
  if (runIds.length === 0 && input.allowCurrentRun === true) {
    const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
    if (current.ok && current.runId !== undefined) runIds.push(current.runId);
  }
  let fallback: RunSpanRow | undefined;
  for (const runId of runIds) {
    const read = await resolved.surface.store.read(runId);
    if (!read.ok) continue;
    const startedAt = read.events[0]?.at;
    const endedAt = read.events[read.events.length - 1]?.at;
    if (startedAt === undefined || endedAt === undefined) continue;
    const row: RunSpanRow = { runId, startedAt, endedAt };
    if (input.preferStartedAt === undefined || startedAt === input.preferStartedAt) return row;
    fallback ??= row;
  }
  return fallback;
}

/**
 * What the round binding means to someone deciding whether to act on the row.
 *
 * The `reviewed-tree` sentence is the one this ticket's readout exists for: it
 * names WHERE the acceptance came from — the record's own verified evidence —
 * and says in the same breath that the two trees differ, because the row prints
 * both and an operator who reads "accepted" as "equal" would then wonder why.
 */
const ROUND_BINDING_ROWS: Readonly<Record<RunJournalRoundBinding, string>> = {
  "record-tree": "the governing closed round binds the record's own candidate tree",
  "reviewed-tree":
    "the governing closed round binds a reviewed candidate above, accepted from this record's verified review-neutral projection; the two trees differ and neither is claimed to equal the other",
  unbound: "no closed round binds the record's candidate tree or any reviewed candidate it accepts",
};

/**
 * The one true sentence about authority, printed wherever a violation is.
 *
 * An operator reading a list of violated constraints under a line that says
 * `verified` is being asked a question the row cannot answer by itself: does
 * this stop anything? It does not. The journal is appended to by anything the
 * owner can execute, so no admission, gate, or record decision reads it — and
 * the only thing that can be blocked by it is this command, behind the local
 * opt-in the operator typed themselves.
 */
export const RUN_JOURNAL_ADMISSION_ROW =
  "none of the above blocks admission: the record's own evidence decides that, and no gate, admission, or record decision reads a journal. Only --require-run-journal blocks, and only this verify invocation.";

/**
 * The row, rendered for a terminal. Every store-derived string goes through
 * `oneLine` for the same reason the viewer's rows do: a run id or a constraint
 * name printed raw is a string from a file anyone who can execute here may
 * write, and this one is printed under a line an operator reads as a verdict.
 */
export function runJournalRows(row: RunJournalRow): readonly string[] {
  const rows = [`  run journal: ${oneLine(row.status, 64)}  (${RUN_JOURNAL_ROW_LABELS})`];
  if (row.runId !== undefined) rows.push(`    run: ${oneLine(row.runId, 128)}`);
  if (row.alsoMatching !== undefined && row.alsoMatching.length > 0) {
    rows.push(`    also matching: ${row.alsoMatching.map((id) => oneLine(id, 128)).join(", ")}`);
  }
  if (row.recordTreeSha !== undefined && row.reviewedCandidateTreeShas !== undefined) {
    rows.push(`    record candidate: ${oneLine(row.recordTreeSha, 64)}`);
    rows.push(`    reviewed candidate: ${row.reviewedCandidateTreeShas.map((tree) => oneLine(tree, 64)).join(", ")} (verified review-neutral projection)`);
  }
  if (row.roundBinding !== undefined) rows.push(`    round binding: ${ROUND_BINDING_ROWS[row.roundBinding]}`);
  rows.push(`    missing: ${row.missing.length === 0 ? "(none)" : row.missing.map((entry) => oneLine(entry, 64)).join(", ")}`);
  if (row.violations !== undefined && row.violations.length > 0) {
    rows.push(`    violations: ${row.violations.map((entry) => oneLine(entry, 64)).join(", ")}`);
    // One indented line per violation, in the order they were raised, each
    // saying why it exists and — where it is only another warning restated —
    // which warning that is. Product-authored text, bounded like every other
    // store-derived row for the same reason.
    for (const explanation of row.explanations ?? []) {
      const consequence = explanation.consequenceOf === undefined ? "" : `; a consequence of ${oneLine(explanation.consequenceOf, 64)}, not a separate mistake`;
      rows.push(`      ${oneLine(explanation.violation, 64)}: ${oneLine(explanation.because, 400)}${consequence}`);
    }
    rows.push(`    admission: ${RUN_JOURNAL_ADMISSION_ROW}`);
  }
  return rows;
}

/** The typed refusal a config-free command returns when it has nothing to work with. */
export function runSurfaceBlocker(input: {
  readonly code: string;
  readonly summary: string;
  readonly details?: string;
  readonly remediation: { readonly id: string; readonly summary: string };
}): Blocker {
  return createBlocker({
    code: input.code,
    source: { kind: "command", id: RUN_SURFACE_SOURCE },
    summary: input.summary,
    ...(input.details === undefined ? {} : { details: input.details }),
    remediations: [{ id: input.remediation.id, kind: "manual_action", summary: input.remediation.summary }],
  });
}

/**
 * Whether a `harness.config.ts` sits at this worktree root. `lstat` only: the
 * module is never imported, never read, never parsed. The note this answers is
 * presentational, and the file it looks for is candidate-committed, so its
 * absence is suppressible by anyone who can write the tree — it bounds
 * accident, not tampering.
 */
export function harnessConfigPresentAt(rootDir: string): boolean {
  try {
    return lstatSync(path.join(rootDir, "harness.config.ts")).isFile();
  } catch {
    return false;
  }
}
