/**
 * The repository half of the post-round residual: read the bytes, then decide.
 *
 * The classification itself is pure and lives beside this module
 * (`review-neutral-projection.ts`). This module does the one thing that module
 * refuses to do — reach into git — and it reaches for exactly four blobs per
 * residual path: the path as the reviewers read it, the path in the base the
 * reviewers read it over, the path as the record describes it, and the path in
 * the base the record was computed over. Those four are what separate "the
 * candidate changed this" from "the base moved under it".
 *
 * WHY A MISSING OBJECT IS A REFUSAL AND NOT AN ABSENCE. `git cat-file` answers
 * "no such path in that tree" and "that tree is not in this repository" with
 * the same non-zero exit. Read as absence, the second one turns a tree this
 * clone cannot see into a path the candidate deleted, and a deletion compares
 * equal to a deletion — a residual nobody can inspect would be admitted as
 * `rebase`. So the tree-ish is resolved once, up front, and a tree that will
 * not resolve stops the whole comparison rather than colouring one path.
 */
import { runGitCommand, type CandidateCommandRunner } from "./candidate.ts";
import type { HarnessConfig } from "./config.ts";
import type { ReviewedCandidateCoordinate } from "./delivery-record.ts";
import {
  classifyPostRoundResidual,
  type ResidualPathInput,
  type ReviewNeutralProjection,
} from "./review-neutral-projection.ts";

export type ResidualOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "unresolvable"; readonly detail: string }
  | { readonly kind: "projected"; readonly projection: ReviewNeutralProjection };

export interface ResidualRequest {
  readonly rootDir: string;
  readonly config: HarnessConfig;
  /** Every reviewed coordinate the verified record carries. */
  readonly reviewedCandidates: readonly ReviewedCandidateCoordinate[];
  /** The candidate the record is about. */
  readonly recordCandidate: ReviewedCandidateCoordinate;
  /**
   * The runner every git read here goes through, defaulted to this package's
   * own `runGitCommand`.
   *
   * WHY THIS IS AN OPTION AND NOT A CONSTANT. The managed-delivery facade
   * exists in part to hold one exec seam: every external command it runs goes
   * through `input.exec`, and the walking-skeleton scenario asserts the launch
   * inventory that seam observes is complete. That assertion is a negative one
   * over an observed set, so a module that spawns git behind the facade's back
   * does not fail it — it silently empties it. Reading four blobs per residual
   * path is exactly such a spawn, and on the widest population this ticket has
   * ever judged. So the request carries the runner the caller wants used, in
   * the shape `captureGitCandidate` and `computeCandidateDiff` already use
   * (`options.run ?? runGitCommand`), and the facade passes the same
   * `candidateRunner` it already hands the evidence kernel one line above.
   * `verify` and the Action pass nothing and are unchanged.
   */
  readonly run?: CandidateCommandRunner;
}

async function objectExists(run: CandidateCommandRunner, rootDir: string, treeish: string): Promise<boolean> {
  const probe = await run(["git", "rev-parse", "--quiet", "--verify", `${treeish}^{tree}`], { cwd: rootDir });
  return probe.exitCode === 0;
}

/** `git`'s fatal exit: what `cat-file` returns for a name it cannot resolve. */
const GIT_FATAL = 128;

/**
 * The path's bytes in one tree-ish, the absence of the path, or a read this
 * clone could not perform.
 *
 * WHY THIS IS THREE ANSWERS AND NOT TWO. The module header says a missing
 * object is a refusal and not an absence, and pre-resolving the tree-ish
 * enforced that for the tree. It did not enforce it for the blob: every
 * non-zero exit was read as "that tree does not carry this path", and a
 * deletion compares equal to a deletion, so four failed reads classify as
 * `rebase` and a residual nobody could inspect is admitted.
 *
 * WHY THE EXIT CODE IS NOT ENOUGH, AND A SECOND PROBE IS. `cat-file blob`
 * answers with 128 for BOTH halves of the header's conflation: a path the tree
 * does not carry, and a path it does carry whose object this repository does
 * not hold — a blobless or partial clone, or a submodule gitlink, whose entry
 * is a commit and not a blob at all. A run that reads 128 as absence alone is
 * the header's own threat model left open; a run that refuses every 128 turns
 * every ordinary deletion across a moved base into a refusal. So a 128 asks one
 * more question, and only a 128 does: `cat-file -e` on the same name. IT HAS
 * THREE ANSWERS, NOT TWO, and the third is the one a two-way ternary gets
 * wrong: 128 when the *name* does not resolve (an absence), 1 when it resolves
 * to an object this repository does not hold (a failure), and **0** when it
 * resolves to an object this repository does hold which is not a blob. That
 * last is a directory or a submodule gitlink, so a third probe separates them:
 * `cat-file -t` reading `tree` is an absence of file content at that path,
 * which is what this comparison means and what this module answered before the
 * second probe existed; anything else there is a failure. Absence is the first
 * and the tree; everything else, including a read the exec port's ceiling
 * killed, is a failure and refuses as `unresolvable`, which is what the other
 * three reads in this module already do.
 */
type BlobRead =
  | { readonly kind: "read"; readonly content: string | null }
  | { readonly kind: "failed"; readonly detail: string };

async function blobAt(run: CandidateCommandRunner, rootDir: string, treeish: string, repoPath: string): Promise<BlobRead> {
  const name = `${treeish}:${repoPath}`;
  const read = await run(["git", "cat-file", "blob", name], { cwd: rootDir });
  if (read.exitCode === 0) return { kind: "read", content: read.stdout };
  const failed = (why: string): BlobRead => ({
    kind: "failed",
    detail: `reading ${repoPath} at ${treeish} ${why}${read.stderr === "" ? "" : `: ${read.stderr.trim()}`}`,
  });
  if (read.exitCode !== GIT_FATAL) return failed(`exited ${read.exitCode}`);
  const resolves = await run(["git", "cat-file", "-e", name], { cwd: rootDir });
  if (resolves.exitCode === GIT_FATAL) return { kind: "read", content: null };
  if (resolves.exitCode !== 0) return failed("named an object this repository does not hold");
  // The third answer. `-e` 0 after a 128 from `blob` means the name resolves to
  // an object this repository holds which is not a blob: a directory, or a
  // submodule's commit. A directory carries no blob content at that path, which
  // is the absence this comparison means; a gitlink is a coordinate in another
  // repository and reading it as an absence is how a bumped submodule stops
  // being classified at all.
  const kind = await run(["git", "cat-file", "-t", name], { cwd: rootDir });
  return kind.exitCode === 0 && kind.stdout.trim() === "tree"
    ? { kind: "read", content: null }
    : failed(`named a ${kind.exitCode === 0 ? kind.stdout.trim() : "non-blob"} and not a file this comparison can read`);
}

/**
 * The paths that differ between two trees, or `null` when git would not say.
 *
 * WHY NOT AN EMPTY LIST. No paths is a real and ordinary answer, and it means
 * the residual is admitted — every class check runs over an empty set. A failed
 * `git diff` returning that same empty list would therefore turn "this clone
 * could not compute the difference" into "there is no difference", for two
 * trees already known to differ: a fail-open, in the surface whose whole job is
 * refusing. A partial or treeless clone reaches it — the root object resolves
 * while recursing it needs a fetch that CI forbids — which is exactly where
 * `verify` is the only enforcer left. So the failure is returned as a failure
 * and both callers refuse or report it as `unresolvable`.
 */
async function changedPaths(run: CandidateCommandRunner, rootDir: string, from: string, to: string): Promise<readonly string[] | null> {
  const listed = await run(["git", "diff", "--name-only", "-z", from, to], { cwd: rootDir });
  if (listed.exitCode !== 0) return null;
  return listed.stdout.split("\0").filter((entry) => entry !== "");
}

/**
 * Compare the record's candidate against the reviewed candidate the round was
 * bound to, and return the projection the commands report or refuse on.
 *
 * EVERY REVIEWED COORDINATE, NOT ONE OF THEM. A verified record may carry
 * several reviewed trees — its own, an evidence entry's, and each tree a
 * review-neutral projection already carried it through. With none earlier than
 * the record's own, nothing moved after the round and there is no residual to
 * judge. With several, the claim is made good against all of them rather than
 * against the one that happens to pass: each is projected onto the record tree
 * and a single refusal refuses the delivery. Choosing one would let a record
 * that names both the tree a round read and a later tree it was carried to
 * satisfy the check on the near comparison while the far one hid a change.
 *
 * The projection reported is the first refusing one — it is the one carrying
 * the hunks an operator has to read — and otherwise the widest, so the summary
 * states the largest gap the closed round is being asked to cover rather than
 * the most flattering one.
 */
export async function projectPostRoundResidual(request: ResidualRequest): Promise<ResidualOutcome> {
  // The policy is always present: an author who declared none is judged under
  // DEFAULT_POST_ROUND_NEUTRAL, which the config loader substituted.
  const earlier = distinctByTree(request.reviewedCandidates.filter((entry) => entry.treeSha !== request.recordCandidate.treeSha));
  if (earlier.length === 0) return { kind: "unchanged" };

  const projections: ReviewNeutralProjection[] = [];
  let unresolved: ResidualOutcome | undefined;
  for (const reviewed of earlier) {
    const one = await projectOne(request, reviewed);
    // A tree-ish this clone cannot resolve refuses the whole comparison: a
    // partial answer over the remaining coordinates would be a claim about
    // trees nobody read. It is remembered rather than returned, for the same
    // reason `projectOne` remembers an unreadable path: a later coordinate that
    // is not admitted is the stronger refusal, and returning here would hand
    // the record the weaker one.
    if (one.kind !== "projected") {
      unresolved ??= one;
      continue;
    }
    projections.push(one.projection);
  }
  const refused = projections.find((projection) => !projection.admitted);
  if (refused !== undefined) return { kind: "projected", projection: refused };
  if (unresolved !== undefined) return unresolved;
  if (projections.length === 0) return { kind: "unchanged" };
  const widest = projections.reduce((left, right) => (right.entries.length > left.entries.length ? right : left));
  return { kind: "projected", projection: refused ?? widest };
}

/** The reviewed coordinates with one entry per distinct tree, order preserved. */
function distinctByTree(entries: readonly ReviewedCandidateCoordinate[]): readonly ReviewedCandidateCoordinate[] {
  const seen = new Set<string>();
  return entries.filter((entry) => (seen.has(entry.treeSha) ? false : (seen.add(entry.treeSha), true)));
}

/** One reviewed coordinate against the record's, read out of git. */
async function projectOne(request: ResidualRequest, reviewed: ReviewedCandidateCoordinate): Promise<ResidualOutcome> {
  const trees: readonly [string, string][] = [
    ["the reviewed candidate tree", reviewed.treeSha],
    ["the reviewed candidate's merge base", reviewed.mergeBaseSha],
    ["the recorded candidate tree", request.recordCandidate.treeSha],
    ["the recorded candidate's merge base", request.recordCandidate.mergeBaseSha],
  ];
  const run = request.run ?? runGitCommand;
  for (const [role, treeish] of trees) {
    if (!(await objectExists(run, request.rootDir, treeish))) {
      return { kind: "unresolvable", detail: `${role} ${treeish} is not an object in this repository` };
    }
  }

  const paths = await changedPaths(run, request.rootDir, reviewed.treeSha, request.recordCandidate.treeSha);
  if (paths === null) {
    return {
      kind: "unresolvable",
      detail: `the difference between reviewed tree ${reviewed.treeSha} and recorded tree ${request.recordCandidate.treeSha} could not be listed in this repository`,
    };
  }
  const inputs: ResidualPathInput[] = [];
  let failure: string | undefined;
  for (const repoPath of paths) {
    const reads = [
      await blobAt(run, request.rootDir, reviewed.treeSha, repoPath),
      await blobAt(run, request.rootDir, reviewed.mergeBaseSha, repoPath),
      await blobAt(run, request.rootDir, request.recordCandidate.treeSha, repoPath),
      await blobAt(run, request.rootDir, request.recordCandidate.mergeBaseSha, repoPath),
    ] as const;
    // One unreadable blob refuses this comparison, for the same reason an
    // unresolvable tree-ish does: the classes this projection admits are all
    // "these bytes are equal", and bytes nobody could read are equal to
    // nothing. Refusing here is what keeps a capped or otherwise failing read
    // from being reported as a deletion.
    //
    // WHY IT DOES NOT RETURN HERE. `unresolvable` is the WEAKER refusal:
    // `decideResidual` turns it into `unprovable` only for a record claiming
    // `provenNeutral`, while a projection that is simply not admitted is
    // refused for every record at every surface. Returning on the first
    // unreadable path threw away the paths already classified beside it, so a
    // residual carrying both a bumped submodule and a source change got the
    // weaker answer for the source change too. Remember the first failure,
    // keep classifying, and let the unconditional refusal win if there is one.
    const unreadable = reads.find((read) => read.kind === "failed");
    if (unreadable !== undefined && unreadable.kind === "failed") {
      failure ??= unreadable.detail;
      continue;
    }
    const [reviewedContent, reviewedBaseContent, recordContent, recordBaseContent] = reads.map((read) =>
      read.kind === "read" ? read.content : null,
    ) as [string | null, string | null, string | null, string | null];
    inputs.push({ path: repoPath, reviewedContent, reviewedBaseContent, recordContent, recordBaseContent });
  }
  const projection = classifyPostRoundResidual(request.config.postRoundNeutral, {
    reviewedTreeSha: reviewed.treeSha,
    recordTreeSha: request.recordCandidate.treeSha,
    reviewedMergeBaseSha: reviewed.mergeBaseSha,
    recordMergeBaseSha: request.recordCandidate.mergeBaseSha,
    paths: inputs,
    // The identity function's own neutral set travels with the request. A
    // path in it is outside the deliverable digest, so it is not part of what
    // any round reviewed and cannot be the reason a round stops governing —
    // the record-neutral transport that moves a record into the tree being
    // the case that proves it.
    deliverableNeutral: request.config.reviewNeutral ?? [],
  });
  // The unconditional refusal outranks the conditional one. An unreadable path
  // beside a non-neutral one must not soften the answer to `unresolvable`.
  if (!projection.admitted) return { kind: "projected", projection };
  if (failure !== undefined) return { kind: "unresolvable", detail: failure };
  return { kind: "projected", projection };
}

/**
 * The rows a command prints for a residual outcome. An unmoved candidate prints
 * nothing: "this candidate is the one the round bound" is the ordinary case and
 * not a fact the operator has to read on every invocation.
 */
export function residualRows(outcome: ResidualOutcome, rows: (projection: ReviewNeutralProjection) => readonly string[]): readonly string[] {
  if (outcome.kind === "projected") return rows(outcome.projection);
  if (outcome.kind === "unresolvable") return [`review-neutral projection: not computed (${outcome.detail})`];
  return [];
}

/**
 * The decision three surfaces have to make identically, made once.
 *
 * WHY THIS IS NOT LEFT TO THE CALLERS. `verify`, the pull-request Action and the
 * managed-delivery facade all read a record that may claim a closed round
 * survived a move of the deliverable identity, and all three must answer the
 * same way, because the weakest of them is the one that decides what merges.
 * This delivery has now twice shipped that claim admitted at one surface and
 * refused at another — first the Action, then the facade — each time because
 * the rule was written where the caller was rather than where the rule is. So
 * the rule lives here, beside the classifier, and a caller's only remaining job
 * is to render the refusal in its own blocker vocabulary.
 *
 * WHICH REFUSAL IS GATED, AND WHICH IS NOT.
 *
 * `not-neutral` is unconditional. A residual carrying a change the policy does
 * not admit is a round that did not read what is about to merge, whatever the
 * record claims about itself, and the classification is cheap once the paths
 * are in hand.
 *
 * `unprovable` is gated on a coordinate actually claiming `provenNeutral`.
 * Refusing every record whose reviewed tree this clone cannot resolve would fail
 * correct records for a pruned object, which is the leniency that predates the
 * ticket. It is only when the record says "the identity moved and the move was
 * proven neutral" that an unreadable tree means the claim is checked nowhere at
 * all — and nowhere is not the same as fine.
 *
 * WHAT IS NOT GATED THAT USED TO BE. An earlier spelling took the
 * `provenNeutral` claim as the gate on *both* refusals, to spare the git reads.
 * It spares nothing: `projectPostRoundResidual` returns `unchanged` before
 * touching git whenever every reviewed coordinate is the record's own tree,
 * which is every record that did not move after its round. What the narrowing
 * did instead was leave the one coordinate that can differ without any
 * projection — an evidence entry under a provider whose `check.scope` narrows
 * the binding comparison away from the deliverable digest — judged by `verify`
 * and unread by the gate.
 */
export type ResidualDecision =
  | { readonly kind: "admitted" }
  | { readonly kind: "not-neutral"; readonly projection: ReviewNeutralProjection }
  | { readonly kind: "unprovable"; readonly detail: string };

export function decideResidual(
  outcome: ResidualOutcome,
  reviewedCandidates: readonly ReviewedCandidateCoordinate[],
): ResidualDecision {
  if (outcome.kind === "unresolvable") {
    return reviewedCandidates.some((entry) => entry.provenNeutral === true)
      ? { kind: "unprovable", detail: outcome.detail }
      : { kind: "admitted" };
  }
  if (outcome.kind === "projected" && !outcome.projection.admitted) {
    return { kind: "not-neutral", projection: outcome.projection };
  }
  return { kind: "admitted" };
}

/** `projectPostRoundResidual` and the decision over it, for a caller that wants no rows. */
export async function reproveResidual(request: ResidualRequest): Promise<ResidualDecision> {
  return decideResidual(await projectPostRoundResidual(request), request.reviewedCandidates);
}
