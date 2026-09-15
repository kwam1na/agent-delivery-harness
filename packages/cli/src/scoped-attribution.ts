/**
 * Attribution of a red declared check to the candidate, the base tree, or the
 * environment.
 *
 * A full suite that exits non-zero says nothing on its own about the candidate:
 * during the 2026-09 wave every tail gate was red and every failure was a bare
 * timeout or a spawn stall, which four lanes then attributed by hand — rerun each
 * red file alone, build a tree at the recorded base, run the residuals on both
 * sides, compare. This module is that ladder, performed by the gate itself.
 *
 * The ladder is deliberately conservative in one direction only. A file the
 * candidate's own diff touches is `candidate` before any rerun happens and can
 * never be reclassified; a red the log cannot be read from, a base tree that
 * cannot be prepared, and a budget that runs out all leave their rows
 * `candidate`. Nothing here can turn an unexamined failure green.
 *
 * Execution is injected: the caller supplies `rerunCandidate` and `rerunBase`,
 * so the ladder itself is pure orchestration over their outcomes. The reruns are
 * bounded by `ATTRIBUTION_RERUN_LIMIT`, and the budget actually spent is part of
 * the reported attribution.
 */

/** Who caused a residual failure. Only `candidate` blocks a delivery. */
export type FailureClass = "candidate" | "pre-existing" | "environmental";

/** What a failing check log said about one file before any rerun. */
export type FailureSignal = "timeout" | "spawn" | "assertion" | "unknown";

export interface ParsedFailure {
  readonly file: string;
  readonly signal: FailureSignal;
}

export interface AttributedRow {
  readonly file: string;
  readonly class: FailureClass;
  /** Why this row carries this class, in the words the operator needs. */
  readonly evidence: string;
}

export interface CheckAttribution {
  readonly version: "check-attribution/1";
  readonly providerId: string;
  /** The declared check command's real exit code, never rewritten. */
  readonly exitCode: number;
  readonly outcome: "attributed" | "candidate" | "attribution-unavailable";
  readonly budget: { readonly reruns: number; readonly limit: number; readonly exhausted: boolean };
  readonly rows: readonly AttributedRow[];
  readonly summary: string;
}

export interface RerunOutcome {
  readonly code: number;
  readonly log: string;
}

export interface AttributionRequest {
  readonly providerId: string;
  readonly exitCode: number;
  readonly log: string;
  /**
   * The paths the candidate's diff touches, in the same frame as the files the
   * check log names. `unavailable` when the diff could not be read at all: the
   * guard that protects touched files cannot then run, so the ladder refuses to
   * reclassify anything rather than silently forgiving an unguarded file.
   */
  readonly touched: readonly string[] | "unavailable";
  /** Run the declared check over exactly these files on the candidate tree. */
  rerunCandidate(files: readonly string[]): Promise<RerunOutcome>;
  /** The same, on a tree prepared at the recorded base; `unavailable` when no such tree can be built. */
  rerunBase(files: readonly string[]): Promise<RerunOutcome | "unavailable">;
}

/**
 * The most reruns one attribution may spend. Each focused candidate rerun and
 * the single base comparison cost one. Beyond it, rows stay `candidate`: a
 * bounded attribution that admits what it did not examine is worth more than an
 * unbounded one that eventually says everything is fine.
 */
export const ATTRIBUTION_RERUN_LIMIT = 6;

const TEST_FILE = /[^\s:()"']+\.(?:test|spec)\.[cm]?[jt]sx?/;
const FAIL_LINE = new RegExp(String.raw`(?:^|\s)FAIL\s+(${TEST_FILE.source})`);

function signalOf(text: string): FailureSignal {
  if (/Test timed out|Hook timed out|timed out in \d+\s*ms/i.test(text)) return "timeout";
  if (/spawn\s+E[A-Z]+|Failed to spawn|SIGKILL|SIGSEGV|Channel closed|ERR_WORKER/i.test(text)) return "spawn";
  if (/AssertionError|expected .* to |Expected:|toEqual|toBe\b|Unhandled error|Error: (?!spawn)/i.test(text)) return "assertion";
  return "unknown";
}

/**
 * Read the failing test files, and the first signal each one showed, out of a
 * check command's combined output. A log this cannot read yields no rows, which
 * the ladder reports as unattributable rather than as nothing wrong.
 */
export function parseCheckFailure(log: string): readonly ParsedFailure[] {
  const lines = log.split("\n");
  const found = new Map<string, FailureSignal>();
  for (const [index, line] of lines.entries()) {
    const match = FAIL_LINE.exec(line);
    if (match === null) continue;
    const file = match[1]!;
    if (found.has(file)) continue;
    let end = index + 1;
    while (end < lines.length && FAIL_LINE.exec(lines[end]!) === null) end++;
    found.set(file, signalOf([line, ...lines.slice(index + 1, end)].join("\n")));
  }
  return [...found].map(([file, signal]) => ({ file, signal }));
}

function summarize(providerId: string, exitCode: number, outcome: CheckAttribution["outcome"], rows: readonly AttributedRow[], reruns: number, limit: number): string {
  const count = (value: FailureClass) => rows.filter(row => row.class === value).length;
  const spend = `${reruns} rerun${reruns === 1 ? "" : "s"} of ${limit}`;
  const tally = `${count("environmental")} environmental, ${count("pre-existing")} pre-existing, ${count("candidate")} candidate`;
  const first = rows.find(row => row.class === "candidate")?.file;
  if (outcome === "attributed") return `attributed ${providerId} (exit ${exitCode}): ${tally}; ${spend}`;
  if (outcome === "attribution-unavailable") return `attribution-unavailable ${providerId} (exit ${exitCode}): the base tree could not be prepared; ${tally}; ${spend}`;
  return `candidate ${providerId} (exit ${exitCode}): ${first} first; ${tally}; ${spend}`;
}

/**
 * Walk the ladder for one failed declared check and return what it proved. The
 * returned rows lead with every candidate-caused failure, so the first line an
 * operator reads is the one that is theirs to fix.
 */
export async function attributeCheckFailure(request: AttributionRequest): Promise<CheckAttribution> {
  const { providerId, exitCode, log, touched } = request;
  const limit = ATTRIBUTION_RERUN_LIMIT;
  let reruns = 0;
  const failures = parseCheckFailure(log);
  const finish = (outcome: CheckAttribution["outcome"], unordered: readonly AttributedRow[]): CheckAttribution => {
    const rows = [...unordered.filter(row => row.class === "candidate"), ...unordered.filter(row => row.class !== "candidate")];
    return { version: "check-attribution/1", providerId, exitCode, outcome, budget: { reruns, limit, exhausted: reruns >= limit }, rows,
      summary: summarize(providerId, exitCode, outcome, rows, reruns, limit) };
  };

  if (failures.length === 0) {
    return finish("candidate", [{ file: "(whole check)", class: "candidate", evidence: "the check log names no failing test file" }]);
  }

  // An empty touched list and an unreadable diff look identical to the loop
  // below, and the difference is the whole guard: with no diff, a file the
  // candidate edited is indistinguishable from one it never saw, and a rerun
  // that happens to pass would forgive it. Fail closed instead.
  if (touched === "unavailable") {
    return finish("candidate", failures.map(failure => ({ file: failure.file, class: "candidate" as const, evidence: "the candidate's diff could not be read, so no failure can be reclassified" })));
  }

  const rows: AttributedRow[] = [];
  const residual: ParsedFailure[] = [];
  for (const failure of failures) {
    if (touched.includes(failure.file)) {
      rows.push({ file: failure.file, class: "candidate", evidence: "the candidate's diff touches this file" });
      continue;
    }
    if (reruns >= limit) {
      rows.push({ file: failure.file, class: "candidate", evidence: "the rerun budget was exhausted before this file was examined" });
      continue;
    }
    reruns++;
    const alone = await request.rerunCandidate([failure.file]);
    if (alone.code === 0) rows.push({ file: failure.file, class: "environmental", evidence: "passed when rerun alone on the candidate" });
    else residual.push(failure);
  }

  if (residual.length === 0) return finish(rows.some(row => row.class === "candidate") ? "candidate" : "attributed", rows);

  if (reruns >= limit) {
    return finish("candidate", [...rows, ...residual.map(failure => ({ file: failure.file, class: "candidate" as const, evidence: "the rerun budget was exhausted before the base comparison" }))]);
  }
  reruns++;
  const base = await request.rerunBase(residual.map(failure => failure.file));
  if (base === "unavailable") {
    return finish("attribution-unavailable", [...rows, ...residual.map(failure => ({ file: failure.file, class: "candidate" as const, evidence: "the base tree could not be prepared for comparison" }))]);
  }

  const baseFailed = new Set(parseCheckFailure(base.log).map(failure => failure.file));
  for (const failure of residual) {
    // A residual the base tree passes is the candidate's, whatever the original
    // log's signal said. The signal is read once, from the crowded full run, and
    // a file that timed out there and then failed alone on a real assertion
    // still carries `timeout`; believing it would forgive exactly the hang,
    // deadlock or unawaited promise this ladder is most likely to meet. A row
    // whose reruns say "fails on the candidate, passes on the base" has been
    // examined, and the examination says candidate.
    rows.push(base.code !== 0 && baseFailed.has(failure.file)
      ? { file: failure.file, class: "pre-existing", evidence: "the base tree fails the same file" }
      : { file: failure.file, class: "candidate", evidence: `the failure reproduces alone (${failure.signal}) and the base tree passes it` });
  }
  return finish(rows.some(row => row.class === "candidate") ? "candidate" : "attributed", rows);
}
