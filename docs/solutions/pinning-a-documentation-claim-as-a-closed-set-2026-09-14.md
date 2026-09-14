---
title: Pin a documentation claim as a closed set, not as a scan for a verb
date: 2026-09-14
---

# Pin a documentation claim as a closed set, not as a scan for a verb

Written on the day V26-1513 landed. It records how a sensor over prose was
built, because the first three attempts were wrong in ways that are not obvious
until review has walked out of them.

## The problem

`docs/managed-delivery.md` had said for weeks that the milestone gate compares
operator intervention counts against a frozen baseline. It does not; the sole
gating criterion is `blockedVersusProgressingShare`, and interventions gate
nothing. Correcting the sentence is easy. The ticket asked for more than that:
the claim had to be **pinned**, so the corrected page could not quietly drift
back to describing gate behaviour nothing implements.

Two of the page's claims recompute from artifacts and pin themselves — the
criterion is read out of `.agents/policy/shadow-milestone-gate-record.json`, the
baseline figures out of `qualifications/shadow-milestone-gate-verdict.json`. A
row that recomputes a value from the artifact it describes is the easy case, and
it is the right shape whenever a value exists to recompute.

The hard case is the rest: rules with no computable counterpart. "Interventions
are reported and gate nothing" is not a number. What pins a sentence like that?

## What did not work: scan the prose for a gating verb

The first version scanned every clause mentioning an intervention, failed any
that carried a verb from a `GATES` list, and excused any that also carried a word
from a `DENIES` list, so the page could still say interventions *do not* gate.

Review escaped it nine ways in a single round:

1. a gating verb outside the list — `blocks`, `bars`, `refuses`, `vetoes`;
2. inflections of verbs that were in the list — `scoring`, `regressing`;
3. a requirement in negative form — "must not be higher than the baseline's
   median" carries `not`, so the denial escape excused the exact relaxation the
   page elsewhere rejects;
4. a claim inside inline code — the scan deleted code spans wholesale, so
   `` `interventionCounts` `` was never inspected;
5. a claim split across the page's hard wrap, because a single newline was
   treated as a clause boundary and neither half carried both subject and verb;
6. a synonym for the subject — "operator involvement", "hand-off", "manual
   input";
7. ...and, once the subject filter was widened, still more of them.

Each widening buys exactly one mutation. That is the whole lesson: **in an
open-world test over free prose, the wording is the attacker's choice.** You are
enumerating the ways a sentence can mean something, and there is no end to that
list. Every round produces a green suite and a new escape.

## What worked: close the set

Invert it. Instead of asking "does any clause say a forbidden thing", hold the
exact set of clauses the page states about the subject, and assert equality.

```
expect(stepInClauses()).toEqual(PINNED_STEP_IN_CLAUSES);
```

A new claim now fails because it is **not in the set**, whatever verb, form,
inflection or synonym it chooses. Wording stops being the attacker's choice. A
claim reaches the page only by being added to the pin, and adding a row is the
moment a writer re-reads the artifact — which is the point, not a side effect.

The price is real and worth naming. An ordinary prose edit to that part of the
page fails, deliberately. Thirteen short strings are re-stamped by hand. That
cost is the forcing function; if it ever stops feeling like one, the pin has
become a fixture and should be deleted rather than maintained.

## Three things that only show up under mutation

**Normalize to reach the claim, but do not delete what you need.** The subject
filter needs the page's own text, not its markdown. Inline code must be
*unwrapped* (`` `x` `` becomes ` x `), not deleted, or an identifier carrying the
subject vanishes. Soft line wraps must be joined, or a hard-wrapped page arrives
pre-split into halves that each say nothing.

Then the trap. Markdown emphasis inside a word (`inter*vention*s`) also defeats a
word-boundary scan, and the obvious fix — strip the markers in place — was a
regression that shipped past one round of review. A marker is a word boundary.
Deleting it in place fuses `operator*interventions*` into one word, and `\b` has
nothing left to anchor on, so the fix opened its own mirror image. The repair is
to **read around the markup rather than rewrite the text**: test the subject
filter against the clause as written, against the clause with markers removed,
and against the clause with markers turned into a space. Three readings behind
`||` can only add a match, never remove one.

**Pin the sentence that states the bound.** A closed set over a list of subject
words has a residue: a claim calling the same thing by a word outside that list
is not in the set and is not pinned. Say so on the page — an undisclosed residue
is how a reader over-trusts a sensor. Then notice that the disclosure itself
carries no subject word, so the closed set cannot hold it: the one sentence
written to prevent over-trust was the one sentence nothing checked, and inverting
it to claim the pin reached further than it does left the suite green. It needs
its own presence pin.

**Do not pin a hard wrap into a presence check.** `toContain("...and\ngate
nothing.")` fails when someone re-flows the paragraph, reporting "no longer
states" about an edit that changed no meaning. A false red costs more trust than
a missing row. Compare with whitespace collapsed.

## When this shape is wrong

Do not reach for it when a value can be recomputed from an artifact — recompute
it. Do not reach for it for a whole page; this pins one subject, roughly thirty
lines. And do not reach for it over narration that nobody maintains: the corpus
this note sits in is `reviewNeutral` and deliberately unpinned, for the reason
[its index](README.md) states.

## Where the current answer lives

The mechanism is in `docs/docs-references.test.ts`, in the block
`describe("the milestone gate claims docs/managed-delivery.md makes")`, with its
rationale in comments beside the code. That file is current documentation and is
maintained; this note is not. Read it for the reasoning and check the code.
