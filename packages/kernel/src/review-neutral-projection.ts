/**
 * The post-round residual: what a candidate may change after its review round
 * closed without asking the reviewers for another one.
 *
 * WHY THIS EXISTS. A round binds reviewers to one raw tree. Everything a
 * delivery does afterwards — landing the solution note the delivery itself
 * taught, restamping a comment header a finding asked for, rebasing onto a
 * base that moved while the round ran — moves that tree, and a tree that moved
 * is a candidate no round is bound to. The honest recoveries were both bad: a
 * further round for changes both lenses had already called not worth spending,
 * or a hand-rolled reset-and-re-emit that no policy described. So the product
 * says which residual differences are review-neutral, proves the claim against
 * the two trees themselves, and refuses everything else naming the hunk.
 *
 * WHAT IS NOT DECIDED HERE. This module never widens the deliverable identity.
 * `reviewNeutral` is the identity function's own narration set and revising it
 * invalidates every record ever computed under the token; `postRoundNeutral` is
 * a separate, later predicate over *two already-computed candidates*, read only
 * by `record` and `verify`. A path can therefore be post-round neutral while
 * still being inside the deliverable digest — which is the whole point for
 * `docs/delivery-runbook.md`, a tracked document the gate does bind.
 *
 * WHY CONTENT, NOT HUNK TEXT. A claim of the form "these changed lines are only
 * comments" read off diff text is a claim about the lines the differ happened
 * to emit, and a `+` line that reads like a comment inside a template literal
 * satisfies it. The claim this module makes instead is an equality between two
 * whole files under an erasure: strip the comments from both and the remaining
 * program must be byte-identical. A changed line that is not a comment survives
 * the erasure and the equality fails, whatever the line looks like. The erasure
 * refuses to answer at all — see {@link stripComments} — for a source it could
 * not scan to a terminal state, so an unterminated construct is never read as
 * evidence of sameness. It refuses for any bare `/` too, for the same reason:
 * `/` is the one character whose meaning a scanner this small cannot settle,
 * and a regular expression is allowed to contain `//`. Division refuses with
 * it, and that breadth is the point — a rule about where a regex may begin is a
 * rule about the grammar, and every gap in it is a fail-open.
 */
import { matchesNeutralSet, type NeutralMatcher, type PostRoundNeutralPolicy } from "./config.ts";

export const REVIEW_NEUTRAL_PROJECTION_SPEC = "review-neutral-projection/1";

/**
 * Why one residual path is admitted, or why it is not. Every member is a
 * product-defined name: nothing here is derived from repository text.
 */
export const RESIDUAL_CLASSES = ["identity-neutral", "rebase", "neutral-path", "comment-only", "non-neutral"] as const;
export type ResidualClass = (typeof RESIDUAL_CLASSES)[number];

/** One path whose bytes differ between the reviewed tree and the record tree. */
export interface ResidualPathInput {
  readonly path: string;
  /** The path's bytes in the reviewed candidate, or null when it is absent there. */
  readonly reviewedContent: string | null;
  /** The path's bytes in the reviewed candidate's merge base. */
  readonly reviewedBaseContent: string | null;
  /** The path's bytes in the recorded candidate. */
  readonly recordContent: string | null;
  /** The path's bytes in the recorded candidate's merge base. */
  readonly recordBaseContent: string | null;
}

export interface ResidualEntry {
  readonly path: string;
  readonly residualClass: ResidualClass;
  /**
   * For a refusal: the first surviving difference, as `<path>:<line> <text>`.
   * Absent on every admitted class — an admitted path has no hunk to name.
   */
  readonly hunk?: string;
}

export interface ReviewNeutralProjection {
  readonly spec: typeof REVIEW_NEUTRAL_PROJECTION_SPEC;
  readonly reviewedTreeSha: string;
  readonly recordTreeSha: string;
  /** True when the two candidates were computed over different merge bases. */
  readonly baseMoved: boolean;
  /** Every residual path, in the order supplied, with its decided class. */
  readonly entries: readonly ResidualEntry[];
  /** True when no entry is `non-neutral`. */
  readonly admitted: boolean;
}

export interface ClassifyResidualInput {
  readonly reviewedTreeSha: string;
  readonly recordTreeSha: string;
  readonly reviewedMergeBaseSha: string;
  readonly recordMergeBaseSha: string;
  readonly paths: readonly ResidualPathInput[];
  /**
   * The identity function's own neutral set — `config.reviewNeutral`. A path in
   * it is outside the deliverable digest, so it was never part of the subject
   * any round reviewed, and it is admitted as `identity-neutral` regardless of
   * `postRoundNeutral`. This is not a second grant: it is the statement that a
   * later predicate cannot be stricter than the identity it sits behind. The
   * caller supplies it; an omitted set admits nothing extra.
   */
  readonly deliverableNeutral?: readonly NeutralMatcher[];
}

/**
 * File extensions whose comments this module knows how to erase. Membership is
 * the gate on the `comment-only` class: a file the scanner does not understand
 * is never admitted on a claim about its comments, and falls through to the
 * path policy or to refusal.
 */
export const COMMENT_ERASABLE_EXTENSIONS: readonly string[] = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);

type ScanState = "code" | "line-comment" | "block-comment" | "single" | "double" | "template";

/**
 * Erase comments from a TypeScript/JavaScript source, or refuse.
 *
 * Returns `null` when the scan does not finish in `code` — an unterminated
 * block comment or string literal — and also when it meets any `/` that does
 * not open a comment.
 *
 * WHY A SLASH IS A REFUSAL AND NOT A GUESS. `/` is the one character whose
 * meaning this scanner cannot settle: `a / b` divides, `/ab/` is a literal, and
 * telling them apart needs the grammar, not the previous token. Guessing wrong
 * is not symmetric. Read as division, a regex body becomes code — and
 * `/^https?:\/\//`, the ordinary URL test, then hands the scanner a `//` that
 * erases the rest of the source line from BOTH programs, so a logic change to
 * the right of it compares equal and ships as `comment-only`. Read as a regex,
 * a division swallows everything up to the next `/`, which hides just as much.
 * Both are fail-open, so neither is taken.
 *
 * WHY THE TEST IS POSITIONAL AND NOT CONTEXTUAL. The first attempt refused only
 * where a regex *may* begin, judged from the previous non-whitespace character:
 * a punctuator set. That is a rule about the grammar written without the
 * grammar, and its gaps are fail-open in exactly the original way. `return`,
 * `typeof`, `case`, `in`, `of`, `new`, `await`, `yield`, `throw` are all
 * value-shaped words that are not values, so `return /^https?:\/\//.test(x)`
 * was called division, the scan continued inside the regex body, the literal's
 * own `\//` opened a line comment, and the rest of the line vanished from both
 * programs — the defect the refusal was added to close, reachable through the
 * more idiomatic spelling of the same line. Keywords are a whitelist, and a
 * whitelist's misses are silent.
 *
 * So the test is on the character, not its neighbourhood: any `/` not followed
 * by `/` or `*` refuses. Those two are the comment openers, and a regular
 * expression's opening `/` can be followed by neither, so every literal is
 * caught at its first character, before its body can be scanned. A division
 * refuses too. That is the cost, and it is paid in the safe direction — a
 * comment restamp in a file that divides is refused and asks for a round,
 * rather than an unreviewed change passing for one.
 *
 * Refusing is safe in the way that matters: both sides of a comparison refusing
 * is a refusal, not an equality.
 *
 * Template literals are copied through verbatim, substitutions included. A
 * comment inside `${…}` therefore survives the erasure and reads as a
 * difference — the conservative answer, and the one that keeps a changed
 * expression from hiding behind a comment-shaped neighbour.
 */
export function stripComments(source: string): string | null {
  return scan(source)?.text ?? null;
}

/** One surviving program line, and the source line it came from. */
export interface CanonicalLine {
  readonly text: string;
  /** One-based line number in the ORIGINAL source, for naming a hunk. */
  readonly line: number;
}

/**
 * The comparison form, line by line: comment-erased, trailing whitespace
 * removed, blank lines dropped, each surviving line still carrying the source
 * line it came from.
 *
 * Leading indentation is deliberately preserved, so a reindentation is a
 * difference — reindenting is not on the neutral list and must not ride in
 * under a claim about comments.
 *
 * The retained line numbers are not decoration. A refusal that names the first
 * RAW difference names whatever changed first, which beside a rewritten comment
 * header is the comment itself — pointing the reader at the one hunk that is
 * not the problem. Naming the first difference between these lines instead
 * names the change that survived the erasure, at its real line in the file.
 */
export function canonicalLines(source: string): readonly CanonicalLine[] | null {
  const scanned = scan(source);
  if (scanned === null) return null;
  const out: CanonicalLine[] = [];
  scanned.lines.forEach((raw, index) => {
    const text = raw.replace(/[ \t]+$/, "");
    if (text.trim() !== "") out.push({ text, line: index + 1 });
  });
  return out;
}

/** The comparison form as one string. Equality here is the `comment-only` claim. */
export function canonicalProgram(source: string): string | null {
  const lines = canonicalLines(source);
  return lines === null ? null : lines.map((entry) => entry.text).join("\n");
}

/**
 * The single scan both forms are read out of.
 *
 * `text` is the erased source as one string; `lines` is the same emission
 * distributed over the source's OWN lines, one entry per input line, so a hunk
 * can be named at the line it really occupies. They are produced together
 * rather than by re-deriving one from the other: a block comment's newlines are
 * absent from `text`, so walking `text` back onto the source guesses, and it
 * guesses wrong whenever a comment contains the character it is looking for.
 */
function scan(source: string): { text: string; lines: readonly string[] } | null {
  let state: ScanState = "code";
  let out = "";
  const lines: string[] = [""];
  let templateDepth = 0;

  /** Emit one character into both forms. A newline only ends a line. */
  const emit = (char: string): void => {
    out += char;
    if (char !== "\n") lines[lines.length - 1] += char;
  };
  /** Consume one source character: only this advances the line count. */
  const consume = (char: string): void => {
    if (char === "\n") lines.push("");
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line-comment"; index += 1; continue; }
      if (char === "/" && next === "*") { state = "block-comment"; index += 1; continue; }
      // ANY OTHER `/` REFUSES THE WHOLE FILE. See the note on `scan`: this is
      // the one character whose meaning cannot be read without parsing, and
      // both guesses are fail-open. The test is positional — a regular
      // expression's opening `/` is never followed by `/` or `*`, because those
      // are the two comment openers — so every regex literal is caught at its
      // first character, before its body can be scanned. A division refuses
      // too, and that is the cost, paid in the safe direction.
      if (char === "/") return null;
      if (char === "'") { state = "single"; emit(char); continue; }
      if (char === '"') { state = "double"; emit(char); continue; }
      if (char === "`") { state = "template"; templateDepth = 0; emit(char); continue; }
      emit(char);
      consume(char);
      continue;
    }
    if (state === "line-comment") {
      // The newline itself belongs to the code: dropping it would join two
      // statements that a comment merely sat between.
      if (char === "\n") { state = "code"; emit(char); }
      consume(char);
      continue;
    }
    if (state === "block-comment") {
      consume(char);
      if (char === "*" && next === "/") { state = "code"; index += 1; }
      continue;
    }
    // Inside a literal: copy verbatim, honour the escape, and end on the
    // matching quote. A newline inside a single- or double-quoted literal is
    // not legal source, and the scanner does not have to police that: an
    // unterminated literal simply never returns to `code` and the whole scan
    // refuses.
    emit(char);
    consume(char);
    if (char === "\\") {
      const escaped = source[index + 1];
      if (escaped !== undefined) { emit(escaped); consume(escaped); index += 1; }
      continue;
    }
    if (state === "single" && char === "'") { state = "code"; continue; }
    if (state === "double" && char === '"') { state = "code"; continue; }
    if (state === "template") {
      if (char === "$" && next === "{") { emit(next); consume(next); index += 1; templateDepth += 1; continue; }
      if (char === "}" && templateDepth > 0) { templateDepth -= 1; continue; }
      if (char === "`" && templateDepth === 0) { state = "code"; continue; }
    }
  }
  return state === "code" ? { text: out, lines } : null;
}

function extensionOf(repoPath: string): string {
  const base = repoPath.slice(repoPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}

const MAX_HUNK_TEXT = 120;

function nameHunk(repoPath: string, line: number, text: string): string {
  const trimmed = text.trim();
  return `${repoPath}:${line} ${trimmed.length > MAX_HUNK_TEXT ? `${trimmed.slice(0, MAX_HUNK_TEXT)}…` : trimmed}`;
}

/**
 * The first line at which two texts differ, one-based, with that line's text.
 *
 * For a source the erasure understands, the comparison runs over the surviving
 * program rather than the raw bytes, so the hunk named is the change that
 * actually survives — not the comment that happened to change on an earlier
 * line beside it.
 */
function firstDifference(repoPath: string, before: string | null, after: string | null, erasable: boolean): string {
  if (before === null) return `${repoPath}:1 added by the residual`;
  if (after === null) return `${repoPath}:1 removed by the residual`;
  if (erasable) {
    const beforeProgram = canonicalLines(before);
    const afterProgram = canonicalLines(after);
    if (beforeProgram !== null && afterProgram !== null) {
      const span = Math.max(beforeProgram.length, afterProgram.length);
      for (let index = 0; index < span; index += 1) {
        const left = beforeProgram[index];
        const right = afterProgram[index];
        if (left?.text === right?.text) continue;
        const named = right ?? left;
        if (named !== undefined) return nameHunk(repoPath, named.line, named.text);
      }
    }
  }
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const limit = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    return nameHunk(repoPath, index + 1, afterLines[index] ?? beforeLines[index] ?? "");
  }
  // Unreachable for inputs this module classifies — a residual path differs by
  // construction — but a named fallback beats an assertion that cannot fire.
  return `${repoPath}:1 differs`;
}

/**
 * Decide one residual path.
 *
 * The order is the policy's own, and it is not arbitrary. `rebase` is asked
 * first because it is the only class that does not look at the delivery at all:
 * a path the candidate delivers nothing on, in either revision, differs solely
 * because the base under it moved, and no reviewer ever read it as part of this
 * candidate. Path neutrality comes next because it is a statement of owner
 * policy that outranks any content heuristic. The comment erasure is asked
 * last, and only for a source the scanner understands.
 */
function classifyPath(policy: PostRoundNeutralPolicy, input: ResidualPathInput, baseMoved: boolean,
    deliverableNeutral: readonly NeutralMatcher[]): ResidualEntry {
  const { path: repoPath } = input;
  // Asked before anything else and gated by no switch: a path outside the
  // deliverable digest was never in the subject a round reviewed, so there is
  // no reviewer expectation for it to violate.
  if (matchesNeutralSet(deliverableNeutral, repoPath)) {
    return { path: repoPath, residualClass: "identity-neutral" };
  }
  if (policy.rebase && baseMoved &&
      input.reviewedContent === input.reviewedBaseContent && input.recordContent === input.recordBaseContent) {
    return { path: repoPath, residualClass: "rebase" };
  }
  if (matchesNeutralSet(policy.paths as readonly NeutralMatcher[], repoPath)) {
    return { path: repoPath, residualClass: "neutral-path" };
  }
  const erasable = COMMENT_ERASABLE_EXTENSIONS.includes(extensionOf(repoPath));
  if (policy.commentOnlyHunks && erasable && input.reviewedContent !== null && input.recordContent !== null) {
    const before = canonicalProgram(input.reviewedContent);
    const after = canonicalProgram(input.recordContent);
    if (before !== null && after !== null && before === after) {
      return { path: repoPath, residualClass: "comment-only" };
    }
  }
  return {
    path: repoPath,
    residualClass: "non-neutral",
    hunk: firstDifference(repoPath, input.reviewedContent, input.recordContent, erasable),
  };
}

/**
 * Classify every residual path between a reviewed candidate and the candidate a
 * record is about.
 *
 * The policy is never absent: a config that declares none is loaded under
 * `DEFAULT_POST_ROUND_NEUTRAL`, so an adopter who has written nothing still
 * gets the solution note, the comment restamp and the rebase for free. Opting
 * out is the explicit empty policy, which admits nothing and is written on
 * purpose rather than reached by omission.
 */
export function classifyPostRoundResidual(policy: PostRoundNeutralPolicy, input: ClassifyResidualInput): ReviewNeutralProjection {
  const baseMoved = input.reviewedMergeBaseSha !== input.recordMergeBaseSha;
  const deliverableNeutral = input.deliverableNeutral ?? [];
  const entries = input.paths.map((entry) => classifyPath(policy, entry, baseMoved, deliverableNeutral));
  return {
    spec: REVIEW_NEUTRAL_PROJECTION_SPEC,
    reviewedTreeSha: input.reviewedTreeSha,
    recordTreeSha: input.recordTreeSha,
    baseMoved,
    entries,
    admitted: entries.every((entry) => entry.residualClass !== "non-neutral"),
  };
}

/** One human line per projection, for the `record` and `verify` summaries. */
export function projectionSummaryRows(projection: ReviewNeutralProjection): readonly string[] {
  if (projection.reviewedTreeSha === projection.recordTreeSha) return [];
  const counts = new Map<ResidualClass, number>();
  for (const entry of projection.entries) counts.set(entry.residualClass, (counts.get(entry.residualClass) ?? 0) + 1);
  const breakdown = RESIDUAL_CLASSES.filter((name) => counts.has(name)).map((name) => `${name} ${counts.get(name)}`);
  return [
    `review-neutral projection: reviewed ${projection.reviewedTreeSha} → recorded ${projection.recordTreeSha}` +
      `${projection.baseMoved ? " (base moved)" : ""}; ${breakdown.length === 0 ? "no residual paths" : breakdown.join(", ")}`,
    ...projection.entries
      .filter((entry) => entry.residualClass !== "non-neutral")
      .map((entry) => `  neutral ${entry.residualClass}: ${entry.path}`),
  ];
}

/** The refusal detail: every hunk that is not neutral, named. */
export function nonNeutralHunks(projection: ReviewNeutralProjection): readonly string[] {
  return projection.entries.flatMap((entry) => (entry.residualClass === "non-neutral" ? [entry.hunk ?? entry.path] : []));
}
