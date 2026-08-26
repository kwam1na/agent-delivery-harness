/**
 * The deliverable identity: what a reviewer actually approved.
 *
 * THE PROBLEM THIS SOLVES. Review evidence authorizes a *deliverable*, not a
 * raw git tree. The tree sha is the strictest possible identity, but it also
 * treats delivery narration — a landed-change report, a solution note, the
 * telemetry record of the run that just happened, all of which are written
 * *after* the implementation they describe — as if a reviewer had been asked
 * about them. Under a raw-tree identity, writing the report about a review
 * invalidates that review. The gate then demands a fresh review of the
 * documentation of the review, and the process cannot close. So the identity is
 * the tree with a declared set of narration paths removed: a content digest
 * over everything a reviewer was really looking at.
 *
 * WHY THE TOKEN IS PART OF THE HASH. `deliverable-tree/v1` is not decoration.
 * The digest is a function of two things — the identity token and the neutral
 * set — and the token is written into the hash before any entry is, so a digest
 * computed under one set can never collide with a digest computed under
 * another. The config loader closes the other half of the argument: it refuses
 * to let `deliverable-tree/v1` name any neutral set but that token's narration
 * set, and refuses to let that narration set be claimed under another name. One
 * token, one function, in both directions.
 *
 * BYTE COMPATIBILITY IS A HARD REQUIREMENT, NOT AN AMBITION. Athena computes
 * `deliverable-tree/v1` today and has review evidence bound to digests its
 * implementation produced. A digest here that differed by one byte under the
 * same token would silently invalidate every one of those bindings while
 * looking perfectly healthy. The goldens in
 * `packages/conformance/fixtures/identity-goldens/` are therefore expectations
 * *captured from Athena* before this module was written, not expectations
 * derived from it.
 *
 * WHY THE `-z` STREAM IS PARSED AS A STREAM. `git ls-tree -z` is NUL-delimited
 * precisely because a path may contain a newline, a trailing space, or a quote.
 * Splitting on anything but NUL, or trimming a record, lets two different trees
 * produce one identity. Nothing here trims and nothing here splits on a line.
 *
 * WHY NOTHING REWRITES A BACKSLASH. Tree paths are POSIX-separated and are
 * never quoted under `-z`, so a backslash in one is a literal character in a
 * file name. `docs\reports\x.html` is a legal path, distinct from
 * `docs/reports/x.html`; folding the first onto the second would drop a real
 * reviewed file out of the deliverable entirely. The config loader rejects
 * backslashes in matchers for the same reason rather than translating them.
 *
 * ORDER IS CODE-UNIT ORDER. The digest is a stream, so a different sort is
 * different bytes. `localeCompare` varies with the host's ICU build and would
 * make one tree digest two ways on two machines; UTF-8 byte order disagrees
 * with UTF-16 code-unit order on astral paths. The comparator is the
 * ECMAScript relational operator, spelled out in `canonical.ts` and shared with
 * the canonicalizer, because it is the one Athena computed and therefore the
 * one the token means.
 *
 * ONE THING ATHENA DOES THAT THIS DOES NOT. Its implementation strips a leading
 * `./` from every path before matching and before hashing. A recursive
 * `--full-tree` listing cannot produce such a path — git rejects a `.` path
 * component outright — so the rule is unreachable from the only input either
 * implementation is given, and the digests are identical on every listing git
 * can emit. It is left out because a second, private path normalization here
 * would be one the config's matchers do not share, and two normalizations that
 * can disagree about what a path is are worse than none.
 *
 * THE TWO NEUTRAL PREDICATES ARE NOT ONE PREDICATE. `reviewNeutral` is the only
 * set that removes entries from this digest. `recordNeutral` is a strictly
 * narrower, independent question — which paths may be written after a
 * merge-grade gate without invalidating its own proof — and it never reaches
 * the hash. Both are read here so the difference is visible in one place, and
 * the suite proves the digest is unmoved by any change to the second.
 */
import { createHash } from "node:crypto";

import { BlockedError, createBlocker, type Blocker, type NonEmptyTuple, type Remediation } from "./blockers.ts";
import { runGitCommand, type CandidateCommandRunner } from "./candidate.ts";
import type { ComputeIdentity, DeliverableIdentityRequest } from "./candidate.types.ts";
import { compareUtf16CodeUnits } from "./canonical.ts";
import { matchesNeutralSet, type HarnessConfig, type NeutralMatcher } from "./config.ts";

// ── Contract constants ─────────────────────────────────────────────────────

/**
 * The domain separator the digest opens with. It is a constant of the function
 * rather than of any one token: `identity\0<token>\0` says both what kind of
 * thing this hash is and which version of it, so a digest can never be confused
 * with some other sha256 over the same entries.
 */
export const IDENTITY_DOMAIN = "identity";

const NUL = "\u0000";

/**
 * This module's own failure vocabulary. Neither code is a gate finding — the
 * gate's structural codes describe evidence, and these describe a repository
 * that could not be read at all — so neither belongs in the config's
 * waivable/non-waivable partition, exactly as the record store's codes do not.
 */
export const IDENTITY_FINDING_CODES = ["deliverable_tree_unreadable", "deliverable_tree_unparsable"] as const;
export type IdentityFindingCode = (typeof IDENTITY_FINDING_CODES)[number];

// ── Shapes ─────────────────────────────────────────────────────────────────

/**
 * One record of a recursive tree listing, reduced to the three fields the
 * digest reads.
 *
 * The type column git prints between the mode and the object is deliberately
 * absent: it is derivable from the mode and carries no information the identity
 * needs, and hashing both would make a listing format change into an identity
 * change.
 */
export interface DeliverableTreeEntry {
  readonly mode: string;
  readonly objectSha: string;
  readonly path: string;
}

/**
 * The pair the digest is a function of.
 *
 * These travel together rather than as a config because that is the honest
 * signature: change either one and the digest changes. A `HarnessConfig`
 * parameter would suggest the other twenty members mattered, and would make the
 * token/neutral-set relationship impossible to state — or to test — on its own.
 * The config's biconditional invariant is what stops one token from ever naming
 * two different pairs; this signature is what makes that invariant meaningful.
 */
export interface DeliverableIdentityDefinition {
  readonly identityToken: string;
  readonly reviewNeutral: readonly NeutralMatcher[];
}

export interface DeliverableIdentityOptions {
  /** Injected only by tests that need a git invocation to fail on demand. */
  readonly run?: CandidateCommandRunner;
}

/** The two members of a config that decide what a digest is. */
export function identityDefinitionOf(config: HarnessConfig): DeliverableIdentityDefinition {
  return { identityToken: config.computingIdentityVersion, reviewNeutral: config.reviewNeutral };
}

// ── The two predicates ─────────────────────────────────────────────────────

/**
 * Whether a path is outside the reviewed deliverable — narration written after
 * the work, which a reviewer was never asked about.
 *
 * This is the only predicate that removes an entry from the digest below.
 */
export function isReviewNeutralPath(config: HarnessConfig, repoPath: string): boolean {
  return matchesNeutralSet(config.reviewNeutral, repoPath);
}

/**
 * Whether a path may be written *after* a merge-grade gate without invalidating
 * the proof that gate produced.
 *
 * Deliberately narrower than review neutrality, and deliberately separate from
 * it. A report still needs its own validation even though a reviewer never
 * approved it; the delivery record describes the gate that has just finished
 * and is checked by the verification it belongs to. Collapsing the two would
 * either let a report through a gate it should face, or make the record's own
 * write invalidate the record. Nothing in this file's digest reads it.
 */
export function isRecordNeutralPath(config: HarnessConfig, repoPath: string): boolean {
  return matchesNeutralSet(config.recordNeutral, repoPath);
}

// ── Blockers ───────────────────────────────────────────────────────────────

const RE_CAPTURE: Remediation = {
  id: "recapture-the-candidate",
  kind: "retry",
  summary: "Capture the candidate again; the tree its identity is computed over is no longer readable.",
};

function identityBlocker(config: HarnessConfig, code: IdentityFindingCode, summary: string, details: string): Blocker {
  return createBlocker({
    code,
    source: { kind: "candidate", id: config.gateId },
    summary,
    ...(details.trim() === "" ? {} : { details }),
    remediations: [RE_CAPTURE] as NonEmptyTuple<Remediation>,
  });
}

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * `<mode> SP <type> SP <object> TAB <path>`. The three leading fields cannot
 * contain whitespace, and everything after the first tab is the path — every
 * byte of it, tabs and newlines included.
 */
const TREE_RECORD = /^(\S+) (\S+) (\S+)\t([\s\S]+)$/;

/**
 * A malformed record blocks rather than being skipped.
 *
 * Dropping one would produce a digest that is confidently wrong: a shorter
 * deliverable that hashes cleanly and matches nothing, with no signal that
 * anything was lost. A tree listing this module cannot read is a repository
 * question, and the honest answer is to say so.
 */
export function parseTreeEntries(output: string, config: HarnessConfig): DeliverableTreeEntry[] {
  const entries: DeliverableTreeEntry[] = [];
  for (const record of output.split(NUL)) {
    // The stream terminates every record, so the tail after the last NUL is
    // empty rather than a record. An empty listing is an empty deliverable.
    if (record.length === 0) continue;
    const match = TREE_RECORD.exec(record);
    if (match === null) {
      throw new BlockedError(
        [
          identityBlocker(
            config,
            "deliverable_tree_unparsable",
            "a tree listing record could not be read",
            `git ls-tree produced an unparsable record: ${JSON.stringify(record)}`,
          ),
        ],
        "The candidate's tree listing could not be read.",
      );
    }
    entries.push({ mode: match[1] as string, objectSha: match[3] as string, path: match[4] as string });
  }
  return entries;
}

// ── The digest ─────────────────────────────────────────────────────────────

/**
 * The deliverable digest for a set of tree entries.
 *
 * Every field is NUL-separated and every record is NUL-terminated, so no
 * concatenation of a mode, an object and a path can be re-read as a different
 * triple — a path ending where another begins cannot forge a record.
 */
export function digestDeliverableEntries(
  entries: readonly DeliverableTreeEntry[],
  definition: DeliverableIdentityDefinition,
): string {
  const hash = createHash("sha256");
  hash.update(`${IDENTITY_DOMAIN}${NUL}${definition.identityToken}${NUL}`);

  const deliverable = entries
    .filter((entry) => !matchesNeutralSet(definition.reviewNeutral, entry.path))
    .sort((left, right) => compareUtf16CodeUnits(left.path, right.path));

  for (const entry of deliverable) {
    hash.update(`${entry.mode}${NUL}${entry.objectSha}${NUL}${entry.path}${NUL}`);
  }
  return hash.digest("hex");
}

// ── The computation ────────────────────────────────────────────────────────

/**
 * `--full-tree` so the answer does not depend on the directory the command was
 * run from, and `-r` so it is a flat list of blobs and gitlinks rather than a
 * walk this module would have to repeat.
 *
 * The listing is decoded as UTF-8, which is what Athena's implementation did.
 * A path whose bytes are not valid UTF-8 therefore digests the same lossy way
 * in both — a fidelity property, not a correctness one, and the reason it is
 * written down here rather than quietly improved.
 */
export async function computeDeliverableIdentity(
  request: DeliverableIdentityRequest,
  options: DeliverableIdentityOptions = {},
): Promise<string> {
  const run = options.run ?? runGitCommand;
  const command = ["git", "ls-tree", "-r", "-z", "--full-tree", request.treeSha];
  const result = await run(command, { cwd: request.rootDir });
  if (result.exitCode !== 0) {
    throw new BlockedError(
      [
        identityBlocker(
          request.config,
          "deliverable_tree_unreadable",
          "the candidate's tree could not be listed",
          result.stderr.trim() || result.stdout.trim() || `${command.join(" ")} failed`,
        ),
      ],
      "The candidate's tree could not be listed.",
    );
  }
  return digestDeliverableEntries(parseTreeEntries(result.stdout, request.config), identityDefinitionOf(request.config));
}

/**
 * The identity port candidate capture injects.
 *
 * It returns the digest alone. The token that names it is a config member, and
 * capture stamps it from the config it was handed, so a port and a config
 * cannot disagree about what a digest is called.
 */
export function withDeliverableIdentity(options: DeliverableIdentityOptions = {}): ComputeIdentity {
  return (request) => computeDeliverableIdentity(request, options);
}
