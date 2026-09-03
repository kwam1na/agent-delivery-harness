# Repository instructions

This repository is the delivery harness product **and** an adopter of the
workflow projection installed under `.agent-skills/`. The two are separate:
the skills say how work is decomposed and executed; the harness says what a
candidate must prove before it is merge-ready.

## Use the installed skills

The `linear` profile release is installed by an operator through the
`agent-skills` lifecycle and exposed as relative symlinks. Resolve every
workflow skill from those exposures; this repository keeps no local copy of
them.

- Plan decomposition into tracked work: `create-linear-ticket`.
- Executing one tracked item: `execute-linear-ticket`.
- The portable entry point, execution, and review: `deliver-work`,
  `execute-work`, `review-work`.

Tracker properties for the exposed Linear adapter are declared in
`.agents/tracker-properties.json`. Read that document; never write to it.

## Bound the review loop

The installed workflow's default bound applies here unchanged: a delivery
obtains **at most four review rounds in total**, counted across every review
loop it opens rather than per loop, declared before the first round and never
re-declared. At the bound with open P0 or P1 findings the delivery stops as
`partial` with the typed blocker `review.loop-bound-reached`, naming what is
open, and the operator decides.

Where every lens is aligned at the bound and a required change would alter the
candidate, the delivery obtains one **grace verification round** for that
change — at most once per delivery, declared as the grace round when it is
obtained, and, as the shipped workflow states it, the one round excepted from
the count — under the same lens set and carry-forward rules as any other
verification round. Only if that round does not align, or a further candidate
change is required after it, does the delivery stop as `partial` with
`review.loop-bound-reached` naming what is open. The grace round is not
available with dissent open or where the latest round was blocked by a failed
acquisition; those forms are terminal at the bound as above.

A round's `candidateRef` is opaque and is never parsed. In this repository it
resolves to the candidate tree the review context records: the tree SHA
`delivery-harness review-context` reports as `candidate tree <sha>`, which is
the same value `prepare` publishes and the delivery record carries as
`treeSha`. Supply that resolution alongside the reference when a verification
round spans two candidates.

## Both exposures are tracked

The install writes two host exposures — `.agents/skills` and `.claude/skills` —
and `.agent-skills/active.json` records both. Both are committed, so a fresh
clone gets a working installation from git alone: the generation, the `current`
pointer, and every exposure link.

When the installed generation or `.agents/policy/` moves, re-record the
compiled snapshot with `npm run policy:recompile` — it recompiles
`.agents/policy/compiled-snapshot.json` from the policy documents and the
installed charters, preserves the recorded `compiledWith` provenance, and is a
no-op on an unchanged policy. It does not re-record `comparison-report.json`;
it says when that report has stopped describing the snapshot.

`.claude/` is otherwise a delivery-owned path, where a committed entry raises
`record_protected_authority_path`. The skills exposure is the one admitted
exception, and it is admitted on the entry's own committed bytes: mode
`120000`, with a link target resolving strictly inside
`.agent-skills/current/skills/`. So keep these links relative and pointing
there — a regular file under `.claude/skills`, or a link escaping that root, is
rejected by `delivery-harness verify` and by the pull-request check.

## Run this repository's gate

`npm run check` is the repository's gate — typecheck, the import-boundary and
CLI-inventory sensors, then the test suite. It must be green before a candidate
is offered.

## Run the product's own delivery loop

Every candidate carries a tracked delivery record produced by this repository's
own CLI. `check` is the standalone preflight; the loop itself is `prepare`,
`review-context`, `submit-evidence`, `gate`, `record`, `verify`, in that order.
The commands and their contract are documented in [the README](README.md) and
[docs/getting-started.md](docs/getting-started.md); the record format is in
[docs/delivery-record.md](docs/delivery-record.md). Run that CLI against this
repository through its own launcher — `npm run harness -- <command>`, so
`npm run harness -- check` is `delivery-harness check` here — rather than
wiring a `delivery-harness` shim per delivery.

## Tracker absence

`.agents/policy/repository-policy.json` keeps `trackerAbsenceFallback` at
`proceed-without-tracker`. A missing tracker never blocks the delivery loop
here; it is recorded and the loop proceeds.
