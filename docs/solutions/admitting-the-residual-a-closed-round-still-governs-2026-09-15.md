---
title: Admitting the residual a closed round still governs
date: 2026-09-15
---

# The round closed, and then the tree moved anyway

Read [what a solution note is](README.md) first. This is a dated record of one
delivery's reasoning, not current documentation. The current answer lives in
[the delivery runbook](../delivery-runbook.md).

## What kept happening

Three deliveries in the 2026-09 waves hit the same wall from three directions.

Lane F finished, understood something worth writing down, and could not write it
down. A `docs/solutions/` note is by construction a thing you only know how to
write *after* the delivery, and the delivery's review round had already closed
against a tree that did not contain it. The honest options were a second
reviewed pull request for a markdown file, or nothing. It chose nothing.

Lane A closed round 8 with both lenses saying the remaining work — one test row
and two comment-only headers — was not worth another round, applied it, rebased,
and watched `verify` report `round-not-bound-to-record`. Clearing that honestly
meant round 9: two opus subagents, two lens worktrees, and a full replay, for
two comments and a rebase.

Lane C hit it too and recovered by hand: reset to the reviewed commit,
regenerate the review context, re-emit the evidence, and let the record carry a
review-neutral projection. It worked. Nothing in the product described it, so it
was a manoeuvre one agent knew and the next one did not.

## The mistake in how we had framed it

For a long time the instinct was to widen `reviewNeutral` — the set the
deliverable digest excludes. It is the obvious lever and it is the wrong one,
for a reason worth keeping: **`reviewNeutral` is the identity function itself.**
The digest every delivery record is keyed by is computed over the tree minus
that set. Add a path to it and every record ever written stops matching the
candidate it attests. The header comment in `harness.config.ts` has said so
since the config was a skeleton, and it is right.

The unlock was noticing that "is this inside the deliverable?" and "does a
closed round still govern this?" are two different questions asked at two
different times. The first is asked once, over one tree, to compute an identity.
The second is asked later, over *two already-computed candidates*, and only by
`record` and `verify`. Nothing forces them to share a predicate — and they must
not, because the delivery runbook is a tracked document the gate genuinely
should bind, and is also a document a delivery routinely amends after its round.

So `postRoundNeutral` is a second, later predicate, and the digest is untouched.

## What a claim of neutrality is allowed to rest on

The first implementation we sketched read the diff: a hunk whose `+`/`-` lines
all look like comments is comment-only. That is a claim about the lines the
differ happened to emit. A `+` line reading `// changed` inside a template
literal satisfies it, and changes the program.

The claim the product makes instead is an equality under an erasure: strip the
comments from both whole files, and the remaining program must be byte-identical.
A changed line that is not a comment survives the erasure whatever it looks like.
Two consequences fell out of that framing and both are load-bearing:

- The erasure **refuses to answer** for a source it cannot scan to a terminal
  state. A regular expression holding `/*` leaves a scanner this small inside a
  block comment forever. Refusing there is the safe direction, and two refusals
  are not an equality — so both sides refusing is a refusal, not a match.
- Leading indentation is deliberately kept in the comparison form. Reindentation
  is not on the neutral list, and it must not ride in under a claim about
  comments.

The `rebase` class took the same turn. "The base moved" is not a property of the
delivery; it is a property of a *path*. A path the candidate delivers nothing on
in either revision — its bytes equal its own base's bytes on both sides —
differs solely because the base moved under it, and no reviewer read it as part
of this candidate. A path the candidate does deliver over is refused across a
rebase exactly as it would be without one.

## The default is the product decision, not the knob

The knob was easy. The decision that mattered was what an adopter who has
written no policy gets. They get `docs/solutions/`, comment-only hunks, and the
rebase — `DEFAULT_POST_ROUND_NEUTRAL` in `packages/kernel/src/config.ts`.

The argument: none of those three is this repository's peculiarity. The note a
delivery writes about what it just learned cannot exist before the delivery
does, a comment changes no program, and a serialized tail rebases every holder
but the first. An adopter who has not declared a policy has not decided these
should cost a further round; they have not thought about it yet, and absence
should resolve to the answer that is right rather than to the answer that is
strict.

What the default may *not* carry is a file name only this repository has.
`docs/delivery-runbook.md` is declared here and is absent from the default, and
there is a test row asserting exactly that. A declaration **replaces** the
default rather than extending it, so this repository's own block repeats
`docs/solutions/` — and opting out is the explicit
`{ paths: [], commentOnlyHunks: false, rebase: false }`, written on purpose.

## Two things the first implementation got wrong

Both were caught by rows written against the acceptance criteria rather than
against the code, and both were wrong in the direction that looks fine.

**The refusal named the comment.** `record` refused the logic change, correctly,
and then pointed at line 1 — the comment header the same commit had rewritten —
because the hunk was read off the first raw byte difference. The criterion is
not "refuse"; it is "refuse *naming the hunk*", and a refusal that names the one
line that is not the problem fails it. The comparison now runs over the same
erasure the `comment-only` class rests on, which means the erasure has to keep
each surviving line's real source line number, which in turn means one
line-aware scan rather than two passes: re-deriving positions by walking the
erased text back over the source guesses, and guesses wrong the moment a comment
contains the character it is looking for.

**A record naming several reviewed trees.** A verified record legitimately
carries more than one — its own, an evidence entry's, and each tree an earlier
review-neutral projection carried it through. The first implementation called
that a contradiction and refused. It is not: the honest reading is that the
claim must hold against *all* of them. Picking one would let a record that names
both the tree a round read and a later tree it was carried to pass on the near
comparison while the far one hid a change, and which tree got picked would be an
accident of ordering.

## The class that is not a grant

There is a fifth class, `identity-neutral`, and it answers to no switch — an
explicit opt-out does not turn it off. A path in `reviewNeutral` is excluded
from the deliverable digest, so it was never in the tree any round was bound to,
and a later predicate cannot be stricter than the identity it sits behind. The
case that forces it is the product's own: a delivery record transported into the
tree under `recordNeutral` moves the tree after the round, every time.

## The third thing the first implementation got wrong: nobody could reach it

The classifier was finished, tested, and unreachable. `record` and `verify`
only ever see candidates that `emit-review-evidence` already admitted, and that
command compared the reviewed and current **deliverable digests** for equality.
So exactly one kind of post-round change survived — a change to a path the
identity function already excludes, which moves the raw tree but not the digest —
and every other kind died one step earlier, with a sentence about the tool:

> the reviewed context differs from the current candidate, base, policy, wiring,
> release, or charters; acquire review for the current context

A comment-only hunk and a rewritten conditional got the same sentence. The
policy block had nothing to act on, `comment-only` and `neutral-path` could not
fire, and the acceptance criterion that a one-line logic change be *refused
naming the hunk* was satisfied nowhere.

The fix is to split that one equality into two questions. Strict equality is
tried first and is still the ordinary answer. Only when the **deliverable digest
alone** is what differs does the residual get computed against the repository,
path by path, and only an admitted residual relaxes the comparison — the digest,
never the identity token, the base, the policy, the wiring, the release or the
charters. What the operator reads becomes a sentence about their own edit:

> the candidate changed after the review round by changes postRoundNeutral does
> not admit: `src/admit.ts:3 return count >= 0;`

The lesson generalises past this ticket. A predicate's tests can all pass while
the predicate decides nothing, because the surface that would consult it refuses
first for a coarser reason. "Is there an input that reaches this branch through
the shipped command?" is a different question from "does this branch work", and
only the first one is about the product. It was an adversarial-testing lens that
asked it.

## The asymmetry between `record` and `verify`

They ask the same question and answer an unresolvable residual differently, and
that is not an oversight.

`record` is authoring a claim into the tracked tree, and a record cannot be
withdrawn from the branch it lands on. A residual it cannot compute — a reviewed
tree whose objects this clone does not hold — is a refusal there, and the
operator can re-prepare.

`verify` is reading a record whose own portable verification has already passed,
in a clone that may simply have pruned an old tree object. Turning that into a
refusal would fail a record that is correct. So it prints `not computed` with
the reason and continues, and reserves its block for an actual `non-neutral`
difference — which is the case the ticket was about.

**And then the asymmetry had to be narrowed, because its premise moved.** The
leniency rested on portable verification having already refused every move of
the deliverable digest. Once submission could carry a proven-neutral move, that
stopped being true: off-repository the projection artifact is checked against
bytes derived from the manifest itself, because off-repository there is nothing
else to read. So the repository proof for that case exists in exactly two
places, the command that authored it and `verify`, and a clone that cannot
recompute it is a clone in which the claim is checked nowhere. `verify` now
blocks an unresolvable residual when the record's projection is on the
`proven-neutral-post-round-residual` basis, and keeps the old leniency for the
cheap basis, where a re-read has nothing to overturn.

The general shape is worth keeping: a tolerance elsewhere in the system was
resting on a guarantee this ticket weakened, and the sentence stating the reason
was what made that visible. Comments that say *why*, not *what*, are the ones
that fail loudly when the world moves under them.

## The fourth thing we got wrong: we fixed the proving surface, not the deciding one

The sentence above — "the repository proof for that case exists in exactly two
places" — was true, and it was the defect. Neither of those two places is CI.

The merge gate is a GitHub Action, and it is deliberately a wrapper over the
kernel and not over the operator CLI: a read-only check should not drag eleven
commands and an interactive prompt behind it. The reading half of the residual
proof had been written into the CLI, because the CLI was where the first two
callers lived. The consequence composes out of two correct decisions: portable
verification admits a proven-neutral projection on bytes derived from the
manifest, because off-repository there is nothing else to read, and the Action
verifies portably. So the gate admitted a candidate whose deliverable identity
no round was bound to, on the submitting workspace's own classification, while
`harness verify` on the same record refused it. Before this ticket the Action
had refused those records outright; the delivery opened the hole in the same
motion that opened the feature.

The fix is a file move. `review-neutral-residual.ts` imported nothing from the
CLI — every symbol it used was already kernel-exported — so it moved into the
kernel, the CLI kept a one-line re-export where its three commands import from,
and the Action got the same two refusals `verify` has. No new dependency, no new
abstraction, ninety seconds of edit.

The lesson is about where the fix lands, not about this module. **When a change
relaxes an admission rule, the surfaces that must be re-hardened are the ones
that decide, and those are rarely the ones you were editing.** The three
callers in front of us were the three we could see; the fourth was the one whose
verdict is the only one that stops a merge. A useful question to ask of any
tolerance: *who is the last reader of this claim before it becomes irreversible,
and do they re-derive it or accept it?* Here the answer was "CI accepts it", and
CI is the whole point.

It also argues for a placement rule the repository can keep: **the repository
half of a check belongs beside its pure half, in the kernel** — the package both
the local gate and the merge gate wrap. Putting it in the CLI is what made "the
local gate is stricter than the gate that decides" expressible at all, and the
Action's own header already names that asymmetry as the one this design refuses.

## And then we did it again, one caller further out

The next round's answer to "who decides?" was that the list had two entries, not
one. `verifyDeliveryRecord` has six call sites, and two of them are the
managed-delivery facade: `commitRecord`, which stands a delivery up as `ready`,
and `completeFinishLine`, which turns `check.ok` into
`externalVerification: "passed"` — the literal `decideFinishLine` requires before
an authorized merge or deployment is issued. Both were as unread as the Action
had been, and the facade's own comment described its check as "the same check
the repository's pull-request Action runs", a sentence the previous round's fix
had quietly made false.

Two surfaces, two rounds, one defect: **the rule was written where the caller
was, instead of where the rule is.** Hardening the Action by giving *the Action*
the two refusals was the same mistake as writing the reading half into the CLI,
one level smaller, and it reproduced the same asymmetry in a new pair. The
enumeration that would have caught it — `grep` for every caller of the admitting
function, before choosing where to put the fix — is three seconds of work and
the only reliable step here.

So the rule is now one exported function, `decideResidual`, and the three
deciding surfaces are renderers over it: each maps its outcome into its own
blocker vocabulary and nothing else. Behavioural rows falsify the rule; a wiring
row reads the three sources and fails if any of them stops calling it. That last
row is the load-bearing one, because a surface that decides for itself again
breaks no behavioural test — it simply answers differently, which is exactly
what the delivery shipped twice.

**The generalisable form.** When a change relaxes an admission rule, write the
relaxation's counter-check as *one function in the layer every consumer already
depends on*, enumerate the consumers before you place it, and add a test that
fails when a consumer stops calling it. Placing the check in a consumer scales
by the number of consumers you happened to think of, and the ones you forget are
the ones that decide. A second symptom worth naming: the finish line accepts
`externalVerification: "passed"` as an opaque literal, so nothing at the point of
use can tell a verdict produced by a full check from one produced by a narrower
one. A vocabulary that cannot express *which* proofs stood behind a pass is a
vocabulary in which this class of gap is invisible by construction.

## What this note is evidence of

It landed in the pull request that built the mechanism, through the mechanism,
against the round that had already closed. That was the point. In this
repository the note is an `identity-neutral` residual — `docs/solutions/` is
outside the deliverable digest here — and in an adopter's repository that does
not exclude it, the same note is admitted as `neutral-path` by the default
policy, with no configuration written.

- Tracked as V26-2079, under the V26-2072 umbrella.
- The current answer, maintained: the compounding section of
  [the delivery runbook](../delivery-runbook.md).
