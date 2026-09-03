/**
 * `runs serve` — the operator's bird's-eye view of the run store.
 *
 * ONE PAGE, NO SCRIPT. The page carries executor-written free text: rationales,
 * decisions, blocker summaries, a gate label an adopter chose. Every one of
 * those is attacker-controlled the moment a candidate script can run in the
 * repository, which is exactly the threat the store's own design admits it
 * cannot exclude. So the page is served with `script-src 'none'` and contains
 * no script of its own — not an inline one, not a nonce'd one, not a fetch
 * loop. Refresh is a `<meta http-equiv="refresh">`, which is the whole of the
 * polling mechanism. That leaves nothing for an escaped string to escape INTO:
 * even a rendering bug can only produce inert markup on a page where scripts
 * are refused by policy.
 *
 * WHY THE JSON ENDPOINT EXISTS ANYWAY. The plan asks for one, and it is what
 * makes the surface programmable — a test, a script, a future viewer. The page
 * does not consume it; the page is rendered server-side from the same
 * projection, so there is one renderer per surface and never a second answer.
 *
 * WHAT "LIVE" MEANS, AND WHAT IT DELIBERATELY DOES NOT. A run is live when the
 * pointer of a worktree the operator NAMED points at it and it carries no
 * `run.ended`. The server never enumerates the store's `current/` directory:
 * it computes each named path's own pointer key from the same `rev-parse` that
 * resolves that path's store, and reads that one pointer. So a run executing
 * in a worktree the operator did not name renders as open but not live — an
 * understatement by construction, which is the direction that cannot mislead.
 *
 * WHY THE GIT ENVIRONMENT IS CLEARED. Twice, for the same reason the store is
 * resolved that way everywhere else: an inherited `GIT_DIR` in the operator's
 * shell must not be able to point one `--repo` path's store at another
 * repository. Both queries — the store resolution and the toplevel the
 * config-presence note names — run in the path itself with the `GIT_`
 * namespace dropped.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  evaluateRunJournal,
  type RunEvent,
  type RunStore,
} from "@agent-delivery-harness/kernel";
import {
  READOUT_LABELS,
  detailOf,
  payloadOf,
  readoutOf,
  roundEntries,
  summarize,
  type Readout,
  type RunSummary,
} from "./run-projection.ts";
import { oneLine, oneLineOf, resolveRunSurface, resolveWorktreeRoot } from "./run-surface.ts";

/** Loopback, always. The page is the operator's, and only the operator's. */
export const RUN_SERVER_HOST = "127.0.0.1";

/** How often a page with a live run refreshes itself, in whole seconds. */
export const DEFAULT_POLL_SECONDS = 2;

/**
 * The policy header every response carries.
 *
 * `default-src 'none'` is the base, and each directive that would otherwise
 * fall back to it is restated rather than left implicit, because a reader
 * auditing this line should not have to know the fallback table. Styles are
 * inline and nothing else loads: no script, no image, no font, no frame, and
 * no form target. `frame-ancestors 'none'` is what keeps the page out of
 * someone else's frame, which the `Host` check alone would not prevent.
 */
export const RUN_SERVER_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

// ── Resolution ───────────────────────────────────────────────────────────────

/** One `--repo` path, resolved to the store it addresses and the root it names. */
interface ResolvedRepo {
  readonly root: string;
  readonly commonDir: string;
  readonly runsDir: string;
  readonly worktreeKey: string;
  /**
   * The store the surface resolved, carried rather than rebuilt: the store's
   * root is not always the repository's common directory, and a second
   * construction here would read a different store than every writer wrote to.
   */
  readonly store: RunStore;
}

/**
 * One store, and every named worktree that addresses it.
 *
 * Two worktrees of one repository share a common directory and therefore share
 * every run. Grouping is what keeps each run on the page ONCE while still
 * reading every pointer the operator named, which is what makes a run live
 * when any named worktree is executing it.
 */
interface RepoGroup {
  readonly root: string;
  readonly commonDir: string;
  readonly runsDir: string;
  readonly worktreeKeys: readonly string[];
  readonly store: RunStore;
}

export type RunServerStart =
  | { readonly ok: true; readonly server: RunServerHandle }
  | { readonly ok: false; readonly reason: string };

export interface RunServerHandle {
  readonly host: string;
  readonly port: number;
  /** `http://<host>:<port>` — what the command prints and what a client dials. */
  readonly url: string;
  close(): Promise<void>;
}

export interface RunServerInput {
  /** One or more paths, each a worktree of a repository whose runs to serve. */
  readonly repos: readonly string[];
  /** Zero, the default, asks the operating system for an ephemeral port. */
  readonly port?: number;
  readonly pollSeconds?: number;
}

async function resolveRepo(repoPath: string): Promise<ResolvedRepo | { readonly reason: string }> {
  const surface = await resolveRunSurface(repoPath);
  if (!surface.ok) return { reason: `${repoPath}: ${surface.reason}` };
  const root = await resolveWorktreeRoot(repoPath);
  if (!root.ok) return { reason: `${repoPath}: ${root.reason}` };
  return {
    root: root.root,
    commonDir: surface.surface.commonDir,
    runsDir: surface.surface.runsDir,
    worktreeKey: surface.surface.worktreeKey,
    store: surface.surface.store,
  };
}

/** Groups resolved paths by store, preserving the order the operator gave. */
function groupByStore(resolved: readonly ResolvedRepo[]): readonly RepoGroup[] {
  const groups = new Map<string, { root: string; commonDir: string; runsDir: string; worktreeKeys: string[]; store: RunStore }>();
  for (const repo of resolved) {
    const existing = groups.get(repo.commonDir);
    if (existing === undefined) {
      // The FIRST named path wins the group's root. The root is what the
      // config-presence note names and what the repository column shows, and
      // two worktrees of one repository can disagree about both; naming the
      // path the operator listed first is the answer an operator can predict.
      groups.set(repo.commonDir, {
        root: repo.root,
        commonDir: repo.commonDir,
        runsDir: repo.runsDir,
        worktreeKeys: [repo.worktreeKey],
        store: repo.store,
      });
      continue;
    }
    if (!existing.worktreeKeys.includes(repo.worktreeKey)) existing.worktreeKeys.push(repo.worktreeKey);
  }
  return [...groups.values()];
}

// ── The served state ─────────────────────────────────────────────────────────

interface ServedTimelineEntry {
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly writer: "cli" | "executor";
  readonly detail: string;
}

interface ServedRound {
  readonly round: string;
  readonly candidateTreeSha: string;
  readonly lenses: string;
  readonly outcome: string;
  readonly findings: string;
  readonly cost: string;
}

interface ServedNote {
  readonly at: string;
  readonly kind: string;
  readonly code: string;
  readonly pattern: string;
}

interface ServedRun {
  readonly runId: string;
  readonly repository: string;
  /** False when the journal refused the read discipline; every other field is then empty. */
  readonly readable: boolean;
  readonly live: boolean;
  readonly open: boolean;
  readonly ticket: string;
  readonly startedAt: string;
  readonly lastAt: string;
  readonly durationSeconds: number;
  readonly rounds: { readonly opened: number; readonly closed: number };
  readonly findings: RunSummary["findings"];
  readonly gate?: RunSummary["gate"];
  readonly record?: RunSummary["record"];
  readonly result?: RunSummary["result"];
  readonly readout: Readout;
  readonly timeline: readonly ServedTimelineEntry[];
  readonly roundDetail: readonly ServedRound[];
  readonly notes: readonly ServedNote[];
}

/**
 * The projection, wearing the names the JSON endpoint publishes. Written out
 * member by member rather than spread: the served shape is a contract a reader
 * can rely on, and a spread would let a future member of the summary appear on
 * the wire without anyone deciding it should.
 */
function servedRun(input: {
  readonly runId: string;
  readonly repository: string;
  readonly live: boolean;
  readonly summary: RunSummary;
  readonly readout: Readout;
  readonly timeline: readonly ServedTimelineEntry[];
  readonly roundDetail: readonly ServedRound[];
  readonly notes: readonly ServedNote[];
  readonly readable: boolean;
}): ServedRun {
  const { summary } = input;
  return {
    runId: input.runId,
    repository: input.repository,
    readable: input.readable,
    live: input.live,
    open: summary.open,
    ticket: summary.ticket,
    startedAt: summary.startedAt,
    lastAt: summary.lastAt,
    durationSeconds: summary.durationSeconds,
    rounds: { opened: summary.roundsOpened, closed: summary.roundsClosed },
    findings: summary.findings,
    ...(summary.gate === undefined ? {} : { gate: summary.gate }),
    ...(summary.record === undefined ? {} : { record: summary.record }),
    ...(summary.result === undefined ? {} : { result: summary.result }),
    readout: input.readout,
    timeline: input.timeline,
    roundDetail: input.roundDetail,
    notes: input.notes,
  };
}

interface ServedState {
  readonly labels: string;
  readonly pollSeconds: number;
  readonly repositories: readonly {
    readonly root: string;
    readonly commonDir: string;
    readonly runsDir: string;
    readonly worktreeKeys: readonly string[];
  }[];
  readonly runs: readonly ServedRun[];
}

/** The summary an unreadable journal gets: everything empty, nothing inferred. */
const EMPTY_SUMMARY: RunSummary = {
  ticket: "",
  open: true,
  startedAt: "",
  lastAt: "",
  durationSeconds: 0,
  roundsOpened: 0,
  roundsClosed: 0,
  findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
};

function timelineOf(events: readonly RunEvent[]): readonly ServedTimelineEntry[] {
  return events.map((event) => ({
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    writer: event.actor.role,
    detail: detailOf(event),
  }));
}

function roundsOf(events: readonly RunEvent[]): readonly ServedRound[] {
  return roundEntries(events).map((entry) => {
    const closed = entry.closed === undefined ? undefined : payloadOf(entry.closed);
    return {
      round: entry.round,
      candidateTreeSha: entry.candidateTreeSha,
      lenses: entry.opened === undefined ? "" : oneLineOf(payloadOf(entry.opened)["lenses"]),
      outcome: closed === undefined ? "open" : oneLineOf(closed["outcome"], 64),
      findings: closed === undefined ? "" : oneLineOf(closed["findings"]),
      cost: closed === undefined ? "" : oneLineOf((closed["cost"] as { total?: unknown } | undefined)?.total, 64),
    };
  });
}

function notesOf(entries: readonly unknown[]): readonly ServedNote[] {
  return entries.map((entry) => {
    const note = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    return {
      at: oneLineOf(note["at"], 32),
      kind: oneLineOf(note["kind"], 128),
      code: oneLineOf(note["code"], 64),
      pattern: oneLineOf(note["pattern"], 64),
    };
  });
}

/**
 * Reads every store once and projects it.
 *
 * A read that fails is a row, not an error. `runs list` already renders an
 * unreadable journal as a row rather than refusing the whole listing, and the
 * page has one more reason to: a poll can land in the middle of an append's
 * torn-tail repair, and a viewer that 500s on that would be unusable exactly
 * while a run is most interesting.
 */
async function readState(groups: readonly RepoGroup[], pollSeconds: number): Promise<ServedState> {
  const runs: ServedRun[] = [];
  for (const group of groups) {
    const live = new Set<string>();
    for (const worktreeKey of group.worktreeKeys) {
      const current = await group.store.current(worktreeKey);
      if (current.ok && current.runId !== undefined) live.add(current.runId);
    }
    for (const runId of await group.store.list()) {
      const read = await group.store.read(runId);
      const notes = notesOf(await group.store.readNotes(runId));
      if (!read.ok) {
        runs.push(
          servedRun({
            runId,
            repository: group.root,
            readable: false,
            live: false,
            summary: EMPTY_SUMMARY,
            readout: { status: "absent", present: [], missing: [], violations: [] },
            timeline: [],
            roundDetail: [],
            notes,
          }),
        );
        continue;
      }
      const events = read.events;
      const summary = summarize(events);
      runs.push(
        servedRun({
          runId,
          repository: group.root,
          readable: true,
          // Liveness is the pointer AND the absence of an end, never one alone:
          // a pointer left behind by a run that ended without clearing it must
          // not read as a run still in flight.
          live: summary.open && live.has(runId),
          summary,
          // No record tree sha and no mandated pair: the viewer has neither, and
          // pretending otherwise would turn an observation into a claim.
          readout: readoutOf(events, evaluateRunJournal(events), group.root),
          timeline: timelineOf(events),
          roundDetail: roundsOf(events),
          notes,
        }),
      );
    }
  }
  return {
    labels: READOUT_LABELS,
    pollSeconds,
    repositories: groups.map((group) => ({
      root: group.root,
      commonDir: group.commonDir,
      runsDir: group.runsDir,
      worktreeKeys: group.worktreeKeys,
    })),
    runs,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Every string that reaches the page goes through here, store-derived or not.
 *
 * The exemption nobody gets is the point: a path the operator typed, a run id
 * the store allocated, and a rationale an executor wrote are all escaped by
 * the same function, because "this one is ours" is how the one that was not
 * ours gets through. The five characters are the full set that can end an
 * attribute or open a tag in HTML text and attribute contexts.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Neutralized to one line, then escaped as markup: the terminal's rule, plus the browser's. */
const cell = (value: string, maximum = 240): string => escapeHtml(oneLine(value, maximum));

const STYLE = [
  "body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:1.5rem;color:#1a1a1a;background:#fbfbfa}",
  "h1{font-size:1.1rem;margin:0 0 .25rem}h2{font-size:.95rem;margin:1.5rem 0 .4rem}h3{font-size:.85rem;margin:.9rem 0 .3rem;color:#555}",
  ".labels{color:#7a6a00;background:#fffbe6;border:1px solid #e8dca0;padding:.35rem .5rem;margin:.5rem 0 1rem}",
  "table{border-collapse:collapse;width:100%;margin:.3rem 0 .6rem}",
  "th,td{border:1px solid #ddd;padding:.22rem .45rem;text-align:left;vertical-align:top;word-break:break-word}",
  "th{background:#f0f0ee;font-weight:600}",
  ".live{color:#0a6b2e;font-weight:700}.ended{color:#666}.open{color:#7a4b00}",
  ".meta{color:#666;margin:.2rem 0}",
  "@media(prefers-color-scheme:dark){body{background:#16181a;color:#e6e6e6}th{background:#24272a}th,td{border-color:#3a3f44}",
  ".labels{color:#e8d98a;background:#2a2718;border-color:#4d4526}.meta,.ended{color:#9aa0a6}h3{color:#9aa0a6}}",
].join("");

const RUNS_HEADER = ["run", "ticket", "repository", "duration", "rounds", "findings", "gate", "record", "result", "state"];

function stateCell(run: ServedRun): string {
  if (!run.readable) return `<td class="open">unreadable</td>`;
  if (run.live) return `<td class="live">live</td>`;
  return run.open ? `<td class="open">open</td>` : `<td class="ended">ended</td>`;
}

const written = (outcome: { readonly outcome: string; readonly writer: string } | undefined): string =>
  outcome === undefined ? "—" : `${cell(outcome.outcome, 64)} <span class="meta">(${cell(outcome.writer, 16)}-written)</span>`;

function runsTable(state: ServedState): string {
  const rows = state.runs.map((run) =>
    [
      "<tr>",
      `<td>${cell(run.runId, 128)}</td>`,
      `<td>${cell(run.ticket, 128) || "—"}</td>`,
      `<td>${cell(run.repository, 400)}</td>`,
      `<td>${run.durationSeconds}s</td>`,
      `<td>${run.rounds.closed}/${run.rounds.opened}</td>`,
      `<td>P0 ${run.findings.P0} · P1 ${run.findings.P1} · P2 ${run.findings.P2} · P3 ${run.findings.P3}</td>`,
      `<td>${written(run.gate)}</td>`,
      `<td>${written(run.record)}</td>`,
      `<td>${run.result === undefined ? "—" : cell(run.result, 64)}</td>`,
      stateCell(run),
      "</tr>",
    ].join(""),
  );
  return [
    "<table>",
    `<tr>${RUNS_HEADER.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`,
    rows.length === 0 ? `<tr><td colspan="${RUNS_HEADER.length}">no runs in this store</td></tr>` : rows.join(""),
    "</table>",
  ].join("");
}

function timelineTable(run: ServedRun): string {
  const rows = run.timeline.map((entry) =>
    [
      "<tr>",
      `<td>${entry.seq}</td>`,
      `<td>${cell(entry.at, 32)}</td>`,
      `<td>${cell(entry.kind, 64)}</td>`,
      `<td>${cell(entry.writer, 16)}-written</td>`,
      `<td>${cell(entry.detail, 400)}</td>`,
      "</tr>",
    ].join(""),
  );
  return [
    "<h3>timeline</h3><table><tr><th>seq</th><th>at</th><th>kind</th><th>writer</th><th>detail</th></tr>",
    rows.length === 0 ? '<tr><td colspan="5">no readable events</td></tr>' : rows.join(""),
    "</table>",
  ].join("");
}

function roundsTable(run: ServedRun): string {
  if (run.roundDetail.length === 0) return "";
  const rows = run.roundDetail.map((round) =>
    [
      "<tr>",
      `<td>${cell(round.round, 32)}</td>`,
      `<td>${cell(round.candidateTreeSha, 128) || "(none)"}</td>`,
      `<td>${cell(round.lenses)}</td>`,
      `<td>${cell(round.outcome, 64)}</td>`,
      `<td>${cell(round.findings)}</td>`,
      `<td>${cell(round.cost, 64)}</td>`,
      "</tr>",
    ].join(""),
  );
  return [
    "<h3>rounds</h3><table><tr><th>round</th><th>candidate</th><th>lenses</th><th>outcome</th><th>findings</th><th>cost</th></tr>",
    rows.join(""),
    "</table>",
  ].join("");
}

function notesTable(run: ServedRun): string {
  if (run.notes.length === 0) return "";
  const rows = run.notes.map((note) =>
    `<tr><td>${cell(note.at, 32)}</td><td>${cell(note.kind, 128)}</td><td>${cell(note.code, 64)}</td><td>${cell(note.pattern, 64)}</td></tr>`,
  );
  return [
    "<h3>refused appends</h3><table><tr><th>at</th><th>kind</th><th>code</th><th>pattern</th></tr>",
    rows.join(""),
    "</table>",
  ].join("");
}

function readoutBlock(run: ServedRun): string {
  const list = (entries: readonly string[]): string => (entries.length === 0 ? "(none)" : cell(entries.join(", "), 800));
  return [
    "<h3>completeness</h3>",
    `<p class="labels">${cell(run.readout.status, 64)} — ${escapeHtml(READOUT_LABELS)}</p>`,
    `<p class="meta">present: ${list(run.readout.present)}</p>`,
    `<p class="meta">missing: ${list(run.readout.missing)}</p>`,
    run.readout.violations.length === 0 ? "" : `<p class="meta">violations: ${list(run.readout.violations)}</p>`,
    run.readout.note === undefined ? "" : `<p class="meta">note: ${cell(run.readout.note, 500)}</p>`,
  ].join("");
}

export function renderPage(state: ServedState): string {
  // The refresh is declared ONLY while something is live. A store of finished
  // runs must cost an open browser tab nothing, and a page that kept polling
  // after `run.ended` would be claiming the run might still move.
  const anyLive = state.runs.some((run) => run.live);
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    anyLive ? `<meta http-equiv="refresh" content="${state.pollSeconds}">` : "",
    "<title>delivery runs</title>",
    `<style>${STYLE}</style></head><body>`,
    "<h1>delivery runs</h1>",
    `<p class="labels">${escapeHtml(READOUT_LABELS)}. Nothing here is read by admission, the gate, or the recorder.</p>`,
    ...state.repositories.map(
      (repository) => `<p class="meta">${cell(repository.root, 400)} — ${cell(repository.runsDir, 400)}</p>`,
    ),
    anyLive
      ? `<p class="meta">refreshing every ${state.pollSeconds}s while a run is live</p>`
      : '<p class="meta">no live run; this page does not refresh itself</p>',
    runsTable(state),
    ...state.runs.map((run) =>
      [
        `<h2>${cell(run.runId, 128)}</h2>`,
        `<p class="meta">${cell(run.repository, 400)}</p>`,
        timelineTable(run),
        roundsTable(run),
        notesTable(run),
        readoutBlock(run),
      ].join(""),
    ),
    "</body></html>",
  ].join("");
}

// ── The server ───────────────────────────────────────────────────────────────

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": RUN_SERVER_CSP,
  "Referrer-Policy": "no-referrer",
  // A viewer of a live store must never be shown a cached run, and no proxy
  // between loopback and loopback has any business holding one.
  "Cache-Control": "no-store",
};

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": contentType });
  response.end(body);
}

/**
 * Whether this request is addressed to the socket it arrived on.
 *
 * Compared by exact equality against the address and port actually bound —
 * not parsed, not normalized, not matched against a list of names that "mean"
 * loopback. A request naming anything else reached this server through
 * something that rewrote its destination (a DNS rebind from a page the
 * operator was reading, a proxy), and this page renders text an executor
 * wrote. `localhost` is refused with everything else: the server prints the
 * URL it bound, and that URL is the one that works.
 */
export function hostIsBound(header: string | undefined, host: string, port: number): boolean {
  return header === `${host}:${port}`;
}

export async function startRunServer(input: RunServerInput): Promise<RunServerStart> {
  if (input.repos.length === 0) return { ok: false, reason: "no repository path to serve" };
  const pollSeconds = input.pollSeconds ?? DEFAULT_POLL_SECONDS;

  const resolved: ResolvedRepo[] = [];
  for (const repoPath of input.repos) {
    const outcome = await resolveRepo(repoPath);
    if ("reason" in outcome) return { ok: false, reason: outcome.reason };
    resolved.push(outcome);
  }
  const groups = groupByStore(resolved);

  let bound: { readonly host: string; readonly port: number } | undefined;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      try {
        if (bound === undefined || !hostIsBound(request.headers.host, bound.host, bound.port)) {
          send(response, 403, "text/plain; charset=utf-8", "forbidden host\n");
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          send(response, 405, "text/plain; charset=utf-8", "method not allowed\n");
          return;
        }
        const route = (request.url ?? "/").split("?")[0];
        if (route === "/") {
          send(response, 200, "text/html; charset=utf-8", renderPage(await readState(groups, pollSeconds)));
          return;
        }
        if (route === "/api/runs") {
          send(response, 200, "application/json; charset=utf-8", `${JSON.stringify(await readState(groups, pollSeconds), null, 2)}\n`);
          return;
        }
        send(response, 404, "text/plain; charset=utf-8", "not found\n");
      } catch {
        // The store is on disk and the disk can say no. A viewer that leaked
        // the reason would be printing a path, and a viewer that crashed would
        // take the operator's window with it. Guarded on `headersSent` because
        // a failure after the status line cannot be answered twice.
        if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", "the run store could not be read\n");
        response.end();
      }
    })();
  });

  const listening = await new Promise<string | undefined>((resolve) => {
    server.once("error", (error: Error) => resolve(error.message));
    server.listen(input.port ?? 0, RUN_SERVER_HOST, () => resolve(undefined));
  });
  if (listening !== undefined) return { ok: false, reason: oneLine(listening, 200) };

  // THE BOUND ADDRESS IS READ BACK OFF THE SOCKET, never echoed from the
  // constant that was passed to `listen`. Reporting the constant would make
  // "this server is loopback-only" unfalsifiable: dropping the interface
  // argument would bind every interface, and the handle, the printed URL, and
  // the `Host` check would all still say `127.0.0.1`. Asking the socket is what
  // leaves the claim answerable by something other than the claim itself.
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return { ok: false, reason: "the server bound no inspectable address" };
  }
  bound = { host: address.address, port: address.port };

  return {
    ok: true,
    server: {
      host: bound.host,
      port: bound.port,
      url: `http://${bound.host}:${bound.port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    },
  };
}
