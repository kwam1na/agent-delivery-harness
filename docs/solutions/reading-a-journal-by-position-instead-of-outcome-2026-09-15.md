# Reading a journal by position instead of by outcome

Written out of V26-2075, where the run-journal completeness evaluator reported
an ordering defect on two deliveries that had none, and reported none on a
delivery whose "governing" gate had refused. Both mistakes have the same shape,
and it is general enough to be worth stating once.

## The shape

An evaluator reading a log has to answer "which of these is the one that
counts". Position is the cheapest answer — the first, or the last — and it is
right often enough to survive a suite:

```ts
const gateCompletion = last(completionsOf(events, "gate"));
const firstOpened = first(openings.filter(sameRound));
```

Both lines are wrong for the same reason. **A log records attempts, and an
attempt is not a decision.** The last `gate` completion is the last time the
command RAN, which is not the same as the gate the delivery STOOD ON: a tail
that finishes, then has its base move under it, re-gates and gets refused. Its
journal ends with a refusal that decided nothing, and every rule anchored on
"the last gate" is then answered about a pass that never happened. In
`run-752c1ec0d1804258` this made the governing gate a `policy` refusal at seq
107 rather than the `ok` at seq 95 the record was written from.

The first opening of a round is wrong the mirror way. A round replayed onto a
moved base is the SAME round continued, and when it is re-announced under the
same identifier the evaluator sees one key opened twice and pairs the first
opening with the first close. The pair it builds is one no later rule can
select, so the journal reports "this gate stood on no closed round" for an
ordering that was correct — and, because the same fact feeds two rules, it
reports it twice, under two identifiers, for one non-mistake. That pair of
warnings sat in this repository's runbook for two weeks as a known-cosmetic
defect nobody could clear.

## The rule

**Select by the property the rule is about, and let position break ties.**

- A completion is selected by its OUTCOME. The governing one is the last that
  admitted (`ok` for a CLI completion, `pass` for an executor-reported gate);
  only where nothing ever admitted does the last one govern, and later
  refusals are *reported beside* the governing one rather than silently
  dropped, because an operator who sees a refusal at the end of a journal needs
  to be told it changed nothing.
- A repeated identifier is selected by its LATEST occurrence, and the repetition
  itself is the finding. Pairing from the latest opening makes the journal
  readable; a violation naming the fix — reopen under a fresh id that points at
  its predecessor — is what stops it recurring. One fact, one row.
- A retry chain is ONE logical unit. Where a bound is spent per unit, count
  chains and not announcements, or a rebase-heavy delivery appears to have
  reviewed thirteen times when it reviewed nine.

## How it was caught, and what to take from that

Not by a fixture. Every hand-written journal in the suite had one gate and one
opening per round, because that is the shape an author imagines. The two
journals that falsified the evaluator were real ones, sitting unread in
`.git/managed-delivery/runs/`, and they are now committed as vectors
(`packages/kernel/src/checkpoint/vectors/run-journals.json`) with their
verdicts, so the next change to the evaluator is judged against shapes nobody
thought to invent.

**When a component reads a log the system already produces, pin real logs as
vectors before trusting synthetic ones.** The synthetic ones agree with the
author; the real ones do not.
