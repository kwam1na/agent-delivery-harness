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
import { runGitCommand } from "./candidate.ts";
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
}

async function objectExists(rootDir: string, treeish: string): Promise<boolean> {
  const probe = await runGitCommand(["git", "rev-parse", "--quiet", "--verify", `${treeish}^{tree}`], { cwd: rootDir });
  return probe.exitCode === 0;
}

/** The path's bytes in one tree-ish, or null when that tree does not carry it. */
async function blobAt(rootDir: string, treeish: string, repoPath: string): Promise<string | null> {
  const read = await runGitCommand(["git", "cat-file", "blob", `${treeish}:${repoPath}`], { cwd: rootDir });
  return read.exitCode === 0 ? read.stdout : null;
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
async function changedPaths(rootDir: string, from: string, to: string): Promise<readonly string[] | null> {
  const listed = await runGitCommand(["git", "diff", "--name-only", "-z", from, to], { cwd: rootDir });
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
  for (const reviewed of earlier) {
    const one = await projectOne(request, reviewed);
    // A tree-ish this clone cannot resolve stops the whole comparison: a
    // partial answer over the remaining coordinates would be a claim about
    // trees nobody read.
    if (one.kind !== "projected") return one;
    projections.push(one.projection);
  }
  const refused = projections.find((projection) => !projection.admitted);
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
  for (const [role, treeish] of trees) {
    if (!(await objectExists(request.rootDir, treeish))) {
      return { kind: "unresolvable", detail: `${role} ${treeish} is not an object in this repository` };
    }
  }

  const paths = await changedPaths(request.rootDir, reviewed.treeSha, request.recordCandidate.treeSha);
  if (paths === null) {
    return {
      kind: "unresolvable",
      detail: `the difference between reviewed tree ${reviewed.treeSha} and recorded tree ${request.recordCandidate.treeSha} could not be listed in this repository`,
    };
  }
  const inputs: ResidualPathInput[] = [];
  for (const repoPath of paths) {
    inputs.push({
      path: repoPath,
      reviewedContent: await blobAt(request.rootDir, reviewed.treeSha, repoPath),
      reviewedBaseContent: await blobAt(request.rootDir, reviewed.mergeBaseSha, repoPath),
      recordContent: await blobAt(request.rootDir, request.recordCandidate.treeSha, repoPath),
      recordBaseContent: await blobAt(request.rootDir, request.recordCandidate.mergeBaseSha, repoPath),
    });
  }
  return {
    kind: "projected",
    projection: classifyPostRoundResidual(request.config.postRoundNeutral, {
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
    }),
  };
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
