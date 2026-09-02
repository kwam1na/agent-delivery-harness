<!--
The shape every delivery in this repository has converged on. Keep the
headings; replace the italic prompts. Delete a section only when it truly does
not apply, and say why rather than leaving it empty.
-->

*One or two sentences: what this lands, and why.*

Linear: [V26-XXXX](https://linear.app/v26-labs/issue/V26-XXXX)

## What changed

*One bolded lead-in per change, then what it does. Describe the change, not the
plan that produced it — plan-unit labels do not belong here.*

**Something.** *What it now does, and what it stops.*

## Evidence

`npm run check` green *(N files, N tests)*. *Any other sensor this candidate
touched — `sensor:policy`, `sensor:standalone`, `qualify:provider`,
`review:evidence` — with its result, and any that was not run.*

Delivery record `delivery/records/record--<sha256>.json`, gate
`admitted: review.green=satisfied_evidence`, `verify` green.

## Review

Bound: *N* rounds, declared before round 1 and not re-declared. Lenses:
*the lens ids, held unchanged for the delivery*. Outcome: *aligned at round N /
`partial` with `review.loop-bound-reached`*.

| Round | Lens | Outcome | Findings |
|---|---|---|---|
| 1 | *lens id* | *aligned / changes-requested* | *ids and severities, or none* |

Dispositions: *for every finding, how it was discharged — closed by its filing
lens in a named round, withdrawn with that lens's reason, or deferred with its
tracked follow-up item. Findings still open are named here and in the blocker.*

Deferrals: *each deferral's id, the lens that filed it, and its tracked
follow-up item — or `none`.*

Not merged.
