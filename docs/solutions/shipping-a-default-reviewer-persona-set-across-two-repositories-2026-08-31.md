---
title: Ship a default reviewer persona set as archive content, with the consuming repository carrying only the resolution mechanism
date: 2026-08-31
category: harness
module: delivery-harness-policy
problem_type: architecture_pattern
component: tooling
resolution_type: tooling_addition
applies_when:
  - "A product must ship default content that adopters reference by identity without pinning its bytes"
  - "A delivery spans two repositories and the consuming one pins the producing one by digest"
  - "A rule set expressed as a list of patterns is the mechanism behind a set-wide neutrality or safety claim"
tags: [delivery-harness, agent-skills, reviewer-personas, digest-closure, cross-repository, absence-assertions]
---

# Ship a default reviewer persona set as archive content

## Problem

The product needed a default set of reviewer charters that a repository policy
could reference from a lens declaration. Three constraints pulled against each
other.

The policy document must stay prose-free, so a lens references a charter by
identity and never carries its text. Advancing the shipped set must never edit
an adopter's policy, so the adopter cannot pin charter bytes either. And the
charters must be digest-bound before a reviewer sees them, so "referenced by
identity" cannot mean "resolved by name at runtime from wherever."

The obvious implementation — a charter list in the consuming repository — fails
the second constraint. It puts the shipped set behind a release of the consumer,
which is the same coupling that referencing by identity exists to avoid.

## Solution

Split content from mechanism across the two repositories that already exist.

**The producing repository owns the content.** The charters, a declared-data
manifest naming each one by identity and path, and an adjudication recording an
include-or-exclude decision for every source file considered all ship inside the
authenticated archive. The archive's existing release manifest lists every
packed path with its digest, so charter bytes are digest-closed by the same
mechanism that closes every other shipped byte. Provenance rides the existing
lock file, which means the license and manifest-closure sensors cover charters
without a second rail being invented for them.

**The consuming repository owns only resolution.** Its module names one archive
entry, reads the manifest through a byte-reader port, and re-derives each
charter's digest from the bytes it actually read, cross-checking against the
digest the archive recorded. It contains no charter identities at all — a test
asserts that, by reading the module's own source and requiring that no shipped
identity appears in it.

Advancing the set is then an archive release. The consumer re-stamps three
digest constants and no logic moves.

## Notes for the next person

**Advance-alone does not mean zero bytes change in the consumer.** The pinned
archive, metadata, and provenance digests must be re-stamped on every advance;
that is inherent to a digest-pinned composition, not per-item coupling. What it
does mean is that no adopter policy document changes and no consumer logic
moves. State it that way; the stronger claim is false and easy to make by
accident.

**A rule set is a mechanism, and set-wide claims over it pass for free.** The
neutrality claim here is enforced by a list of patterns. A sensor that plants one
violating string proves only that *some* arm fires — it does not pin the arm it
was written for, because a sibling arm may catch the same plant. Four of six arms
were deletable with the whole suite green until each got a plant that trips it
alone. The same holds one level down: dropping a single alternative from inside
one pattern also survived. Mutate at the granularity of the thing you claim to
enforce, not the granularity of the function.

**A self-declared count is not a census.** The adjudication declares how many
source files it covers. A sensor can catch the count drifting *upward* from the
row set, and that is worth having. It cannot catch a deliberate author who drops
a row, decrements the count, recanonicalises, and restamps the digest — closing
that would need an independent census of the upstream corpus, which neither
repository vendors. Scope the claim to the direction you actually closed.

**Do not trust a red suite you have not attributed.** The producing repository's
full `unittest discover` run goes red on *any* edit to the validator, including a
comment-only one, because several suites pin that file by byte digest. Those are
integrity pins, not behavioural coverage, and crediting them with catching a rule
deletion is how an unfalsified rule survives review. Use the registry driver plus
the corpus validator as the mutation signal.

## Operational gotchas

**The archive's test suite needs `jsonschema==4.23.0`.** Without it, three
modules fail to import and the run reports "252 tests, 6 failures, 3 errors" — a
red suite that is not one. Install the test extra into a virtual environment
first; the system interpreter is externally managed and will refuse.

**The pinned provenance digest is over the packed copy, not the repo file.** The
release build canonicalizes the lock file while packing, so hashing the file as
it sits in the repository produces a value that does not match the pin and looks
like drift. Hash the entry inside the built archive.

**The gate can stale between `record` and CI on an active base.** The delivery
record binds the base tip at capture time, and this repository's base-movement
policy is `stale`. Two unrelated deliveries landed on the default branch during
one recording here, and the pull-request check blocked on a record that was
correct when written. That is the gate behaving as designed, not a defect in the
candidate. The mitigation is ordering and promptness: merge the producing
repository first so the consumer's pin never points at unmerged content, then
land the consumer while the base is quiet, and re-run the loop rather than
arguing the stale record forward.

**A rebase over a quiet base is provable, not arguable.** Because `git diff`
embeds the pre- and post-image blob hashes of every touched file, a diff against
merge-base that is byte-identical before and after a rebase proves the delivered
content is unchanged at blob level. That is what lets a review verdict be
re-bound to the new commit — but it still has to be re-established as evidence,
because evidence binds to a commit, not to an argument about one.
