/**
 * What a candidate *is*, and every decision that can be made about one without
 * touching a repository.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `candidate.ts`. Capturing a candidate
 * means running git, and git means `node:child_process`. The gate evaluator and
 * the execution-context classifier are forbidden from importing that family at
 * all — not indirectly either — yet both need to know what a candidate looks
 * like and whether a projection activates an obligation. So the split is not
 * cosmetic: the shapes *and the decisions over them* live here, where a pure
 * consumer can reach them, and only the git work lives next door.
 *
 * That is why this file carries functions and not merely `interface`
 * declarations. Classification, projection, activation, and drift are all total
 * functions of values that have already been observed. Putting any of them in
 * `candidate.ts` would force a pure module to import a process-spawning module
 * to answer a question that involves no process at all — or, worse, to grow its
 * own second copy of the rule.
 *
 * WHAT IS DELIBERATELY NOT NORMALIZED. Repository paths arrive from git exactly
 * as git recorded them, and a backslash in one is a literal character in a file
 * name, not a separator to be rewritten. Rewriting it here would make
 * `docs\reports\x.html` classify as though it were `docs/reports/x.html`, which
 * is a different path — the config loader rejects backslashes in matchers for
 * the same reason rather than quietly translating them.
 */
import type { Blocker, NonEmptyTuple } from "./blockers.ts";
import type { HarnessConfig, ObligationActivation, PathClassification, PathMatcher, SensitivePathGroup } from "./config.ts";

// ── The candidate ──────────────────────────────────────────────────────────

/** Only git is supported; the manifest envelope pins the same constant. */
export const CANDIDATE_VCS = "git" as const;
export type CandidateVcs = typeof CANDIDATE_VCS;

/**
 * `clean` — the worktree matches HEAD and the reviewable tree is HEAD's tree.
 * `staged-index` — the author staged the change; the reviewable tree is the
 * tree the index defines. There is no third mode: an unstaged edit is not a
 * candidate, it is an unprepared workspace.
 */
export const CANDIDATE_MODES = ["clean", "staged-index"] as const;
export type CandidateMode = (typeof CANDIDATE_MODES)[number];

export interface CandidateDeliverable {
  /** The deliverable-tree digest, from the injected identity computer. */
  readonly digest: string;
  /** The token naming the function that produced `digest`. */
  readonly identity: string;
}

export interface CandidateBase {
  readonly ref: string;
  readonly tipSha: string;
  readonly mergeBaseSha: string;
}

/**
 * The fields evidence binds to. Kept as its own shape because the recorder
 * compares a re-captured candidate against a manifest's binding, and that
 * comparison must be over an enumerated field set rather than over whatever a
 * capture happens to carry.
 */
export interface CandidateBinding {
  readonly treeSha: string;
  readonly deliverable: CandidateDeliverable;
  readonly base: CandidateBase;
  readonly workspaceId: string;
}

/** One `git status` entry: the two-character code, and the path it concerns. */
export interface CandidateStatusEntry {
  readonly code: string;
  readonly path: string;
}

export interface CapturedCandidate extends CandidateBinding {
  readonly vcs: CandidateVcs;
  readonly headSha: string;
  readonly mode: CandidateMode;
  /**
   * The observed status, retained for diagnostics. In `clean` mode it is empty
   * by construction; in `staged-index` mode it describes what was staged.
   */
  readonly statusEntries: readonly CandidateStatusEntry[];
  /**
   * Always empty on a successful capture — an untracked file is an unprepared
   * workspace. The member exists so the value can say so rather than leaving a
   * reader to infer it from an absence.
   */
  readonly untrackedFiles: readonly string[];
}

// ── Capture failures ───────────────────────────────────────────────────────

/**
 * Why a capture produced no candidate. Each code names one situation, because
 * the operator's next action differs for every one of them: stage the work,
 * finish the merge, fetch the base, re-run, or look at the repository itself.
 *
 * The three `candidate_base_*` codes are the fail-closed set. A base that
 * cannot be resolved must never degrade into "nothing changed" — an empty
 * changed set is a legitimate answer (a candidate whose tip equals its base)
 * and reporting an unresolvable base as one would admit an unreviewed change
 * through the activation threshold. They are three rather than one because
 * their remedies are unrelated: fetch the ref, deepen the clone, or reconcile
 * two histories that genuinely have nothing in common.
 */
export const CANDIDATE_CAPTURE_CODES = [
  "candidate_unprepared",
  "candidate_merge_in_progress",
  "candidate_ambiguous",
  "candidate_base_missing",
  "candidate_base_shallow",
  "candidate_base_unrelated",
  "candidate_repository_unreadable",
] as const;

export type CandidateCaptureCode = (typeof CANDIDATE_CAPTURE_CODES)[number];

/**
 * Not a capture code: it is emitted after a candidate has been captured, when
 * the diff that the projection reads cannot be produced. It shares the
 * fail-closed reasoning — an unreadable diff must never present itself as a
 * diff containing nothing.
 */
export const CANDIDATE_DIFF_UNREADABLE = "candidate_diff_unreadable" as const;

export type CandidateCapture =
  | { readonly ok: true; readonly candidate: CapturedCandidate }
  | { readonly ok: false; readonly code: CandidateCaptureCode; readonly blockers: NonEmptyTuple<Blocker> };

// ── The two injection ports ────────────────────────────────────────────────

export interface DeliverableIdentityRequest {
  readonly rootDir: string;
  /** The tree the candidate is defined by — HEAD's tree, or the index's. */
  readonly treeSha: string;
  readonly config: HarnessConfig;
}

/**
 * The identity port: the deliverable digest for a tree.
 *
 * It returns the digest alone. The token that *names* the function is a config
 * member, and capture stamps it from the config it was handed, so a port and a
 * config cannot disagree about what a digest is called — there is only one
 * reader of the token.
 */
export type ComputeIdentity = (request: DeliverableIdentityRequest) => Promise<string>;

/**
 * The whole-candidate port. The recorder re-captures through this rather than
 * calling into git itself, which is what lets a conformance run drive the
 * submission path from declared candidate values with no repository at all.
 */
export type CaptureCandidate = () => Promise<CandidateCapture>;

// ── Drift ──────────────────────────────────────────────────────────────────

/**
 * How a candidate can have moved between two observations.
 *
 * The five classes are disjoint statements about *what* moved, not a severity
 * ordering, and a single comparison can report several at once — a rebase moves
 * the raw tree, the merge base, and the deliverable identity together, and
 * collapsing that into one class would lose the part that explains it.
 *
 * Deliberately not a class: a differing base *ref*, identity *token*, or `vcs`.
 * Those are configuration disagreements rather than movement in the repository,
 * and naming them as drift would tell an operator to re-prepare when the actual
 * fix is to reconcile a config with the evidence recorded under a different one.
 */
export const CANDIDATE_DRIFT_CLASSES = [
  "deliverable_identity_changed",
  "raw_tree_changed",
  "base_tip_moved",
  "merge_base_moved",
  "workspace_changed",
] as const;

export type CandidateDriftClass = (typeof CANDIDATE_DRIFT_CLASSES)[number];

/**
 * Every class in which `observed` differs from `expected`, in taxonomy order.
 * An empty result means the two bindings describe the same candidate.
 */
export function classifyCandidateDrift(expected: CandidateBinding, observed: CandidateBinding): readonly CandidateDriftClass[] {
  const classes: CandidateDriftClass[] = [];
  if (expected.deliverable.digest !== observed.deliverable.digest) classes.push("deliverable_identity_changed");
  if (expected.treeSha !== observed.treeSha) classes.push("raw_tree_changed");
  if (expected.base.tipSha !== observed.base.tipSha) classes.push("base_tip_moved");
  if (expected.base.mergeBaseSha !== observed.base.mergeBaseSha) classes.push("merge_base_moved");
  if (expected.workspaceId !== observed.workspaceId) classes.push("workspace_changed");
  return classes;
}

// ── Path classification ────────────────────────────────────────────────────

/**
 * `relevant` is the residue: a path is reviewable unless the config says what
 * else it is. That direction matters. The opposite arrangement — an explicit
 * list of reviewable paths — would make every unclassified new directory
 * invisible to the activation threshold, so forgetting to update a config would
 * quietly widen what can merge unreviewed.
 */
export const CANDIDATE_PATH_CLASSES = ["relevant", "test", "generated", "lockfile"] as const;
export type CandidatePathClass = (typeof CANDIDATE_PATH_CLASSES)[number];

/**
 * The supported glob subset, compiled once per matcher value.
 *
 *   `**` — any run of characters, path separators included
 *   `*`  — any run of characters within one path segment
 *   `?`  — exactly one character within one path segment
 *
 * A `**` immediately followed by a separator also matches *no* leading
 * directory, so a recursive test-file pattern covers a test file at the
 * repository root as well as a nested one. Everything else in the pattern is
 * literal; there are no character classes and no brace expansion, because a
 * matcher decides whether a change is reviewed, and a surprising pattern
 * feature is a silent hole in that decision.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const GLOB_CACHE = new Map<string, RegExp>();

function globMatches(pattern: string, repoPath: string): boolean {
  let compiled = GLOB_CACHE.get(pattern);
  if (compiled === undefined) {
    compiled = globToRegExp(pattern);
    GLOB_CACHE.set(pattern, compiled);
  }
  return compiled.test(repoPath);
}

/**
 * A prefix matcher covers the path it names and everything beneath it, and a
 * trailing slash is optional in the config — `packages/kernel` and
 * `packages/kernel/` name the same subtree. What it must not do is match on a
 * bare string prefix: `packages/kernel` would then cover
 * `packages/kernel-tools/`, which is a different package.
 */
export function matchesPathMatcher(matcher: PathMatcher, repoPath: string): boolean {
  if (matcher.kind === "glob") return globMatches(matcher.value, repoPath);
  const prefix = matcher.value.endsWith("/") ? matcher.value.slice(0, -1) : matcher.value;
  return repoPath === prefix || repoPath.startsWith(`${prefix}/`);
}

function matchesAny(matchers: readonly PathMatcher[], repoPath: string): boolean {
  return matchers.some((matcher) => matchesPathMatcher(matcher, repoPath));
}

/**
 * Order is policy, not convenience. A lock file inside a generated directory is
 * still a lock file, and a generated file whose name ends in `.test.ts` is
 * still generated — the more specific classification wins so that a config
 * cannot be made to contradict itself by adding a matcher elsewhere.
 */
export function classifyCandidatePath(classification: PathClassification, repoPath: string): CandidatePathClass {
  if (matchesAny(classification.lockfile, repoPath)) return "lockfile";
  if (matchesAny(classification.generated, repoPath)) return "generated";
  if (matchesAny(classification.test, repoPath)) return "test";
  return "relevant";
}

/** The ids of every sensitive group this path falls inside, in config order. */
export function sensitiveGroupsFor(groups: readonly SensitivePathGroup[], repoPath: string): readonly string[] {
  return groups.filter((group) => matchesAny(group.patterns, repoPath)).map((group) => group.id);
}

// ── The activation projection ──────────────────────────────────────────────

/**
 * One entry of the diff between the candidate's base and its tree. `additions`
 * and `deletions` are `null` exactly when git could not count lines, which is
 * what `binary` records.
 */
export interface CandidateDiffEntry {
  readonly path: string;
  /** Present when the entry is a rename or a copy. */
  readonly oldPath?: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export interface ReviewActivationProjection {
  /** Changed lines on reviewable paths. Test, generated and lock files do not count. */
  readonly relevantLineCount: number;
  readonly relevantPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly binaryPaths: readonly string[];
  readonly sensitivePathIds: readonly string[];
  readonly hasRelevantBinaryChange: boolean;
  /**
   * Whether a reviewable path changed in a way that adds and removes no lines
   * at all: a permission bit flipped to executable, a file moved with its
   * contents intact. Recorded for the same reason as a binary change — the
   * count is zero because lines are the wrong unit for this change, not because
   * nothing happened, and `chmod +x` on a script is not a change a line
   * threshold should be allowed to wave through.
   */
  readonly hasRelevantZeroLineChange: boolean;
  /**
   * How many entries the diff carried at all. Zero is the legitimate
   * empty-diff case — a candidate whose tree already matches its base — and is
   * distinguishable here from a base that could not be resolved, which never
   * produces a projection because capture blocks first.
   */
  readonly changedEntryCount: number;
}

/**
 * Both sides of a rename are considered, and the entry counts as reviewable if
 * *either* side is. Moving a reviewable file into a generated directory is a
 * reviewable change; so is the reverse. Taking only the new path would let a
 * rename launder a file out of review.
 */
function entryPaths(entry: CandidateDiffEntry): readonly string[] {
  return entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path];
}

/**
 * SENSITIVE GROUPS ARE COLLECTED BEFORE THE RELEVANCE CHECK, deliberately. A
 * path can be both sensitive and excluded — a generated client for an
 * authentication API, a test fixture holding a signing key — and in that case
 * the sensitive group still names it and the obligation still activates. The
 * exclusion says "these lines are not worth counting", which is a statement
 * about volume; a sensitive group says "changes here are reviewed regardless",
 * which is a statement about risk. Letting the first silence the second would
 * make a config's own classification into a way around its own policy.
 */
export function projectReviewActivation(entries: readonly CandidateDiffEntry[], config: HarnessConfig): ReviewActivationProjection {
  let relevantLineCount = 0;
  let hasRelevantBinaryChange = false;
  let hasRelevantZeroLineChange = false;
  const relevantPaths = new Set<string>();
  const excludedPaths = new Set<string>();
  const binaryPaths = new Set<string>();
  const sensitivePathIds = new Set<string>();

  for (const entry of entries) {
    const paths = entryPaths(entry);
    for (const repoPath of paths) {
      for (const id of sensitiveGroupsFor(config.sensitivePaths, repoPath)) sensitivePathIds.add(id);
    }

    const relevant = paths.some((repoPath) => classifyCandidatePath(config.pathClassification, repoPath) === "relevant");
    if (!relevant) {
      for (const repoPath of paths) excludedPaths.add(repoPath);
      continue;
    }
    for (const repoPath of paths) relevantPaths.add(repoPath);

    // A binary change has no line count to add, and treating it as zero would
    // make a replaced image read as no change at all.
    if (entry.binary || entry.additions === null || entry.deletions === null) {
      for (const repoPath of paths) binaryPaths.add(repoPath);
      hasRelevantBinaryChange = true;
      continue;
    }
    if (entry.additions + entry.deletions === 0) hasRelevantZeroLineChange = true;
    relevantLineCount += entry.additions + entry.deletions;
  }

  return {
    relevantLineCount,
    relevantPaths: [...relevantPaths].sort(),
    excludedPaths: [...excludedPaths].sort(),
    binaryPaths: [...binaryPaths].sort(),
    sensitivePathIds: [...sensitivePathIds].sort(),
    hasRelevantBinaryChange,
    hasRelevantZeroLineChange,
    changedEntryCount: entries.length,
  };
}

/**
 * Whether an obligation applies to the candidate this projection describes.
 *
 * An `always` obligation ignores the projection entirely. A `relevant_change`
 * obligation activates on any of four independent signals: enough reviewable
 * lines, a reviewable binary change, a reviewable change that counts no lines,
 * or a touched sensitive path. They are independent on purpose — a one-line
 * change to an authentication path is exactly the change a line threshold would
 * wave through.
 *
 * THREE OF THE SIGNALS CAN BE NARROWED PER OBLIGATION, and absence of each
 * narrowing member is the widened, fail-closed reading:
 *
 *   - `sensitiveGroupIds` binds the sensitive signal to named groups. Absent,
 *     every declared group activates every `relevant_change` obligation; an
 *     empty binding opts the obligation out of the signal entirely. The loader
 *     has already rejected an id no `sensitivePaths` group declares, so a
 *     binding here never references a group that does not exist.
 *   - `relevantBinaryChangeActivates: false` opts out of the binary signal.
 *   - `relevantZeroLineChangeActivates: false` opts out of the zero-line one.
 *     The two flags are separate because the signals are independent: a
 *     security review is indifferent to a `chmod` and alert to a replaced
 *     binary, a licence obligation the reverse.
 *
 * The line threshold has no per-obligation narrowing, and none of the members
 * narrows an `always` obligation, which ignores the projection entirely.
 */
export function isObligationActive(
  activation: ObligationActivation,
  projection: ReviewActivationProjection,
  activationThreshold: number,
): boolean {
  if (activation.kind === "always") return true;
  if (projection.relevantLineCount >= activationThreshold) return true;
  if ((activation.relevantBinaryChangeActivates ?? true) && projection.hasRelevantBinaryChange) return true;
  if ((activation.relevantZeroLineChangeActivates ?? true) && projection.hasRelevantZeroLineChange) return true;
  const binding = activation.sensitiveGroupIds;
  if (binding === undefined) return projection.sensitivePathIds.length > 0;
  return projection.sensitivePathIds.some((id) => binding.includes(id));
}
