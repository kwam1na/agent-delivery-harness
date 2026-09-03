# Repository instructions

This repository is the delivery harness product **and** an adopter of the
workflow projection installed under `.agent-skills/`. The two are separate:
the skills say how work is decomposed and executed; the harness says what a
candidate must prove before it is merge-ready.

## Use the installed skills

The `linear` profile release is installed by an operator through the
`agent-skills` lifecycle and exposed as relative symlinks. Resolve every
workflow skill from those exposures; this repository keeps no local copy of
them. Rules the installed workflow already carries are not restated here — the
review round bound, the grace round, how a deferral is tracked, and how a
finding is resolved are read from the installed skills.

- Plan decomposition into tracked work: `create-linear-ticket`.
- Executing one tracked item: `execute-linear-ticket`.
- The portable entry point, execution, and review: `deliver-work`,
  `execute-work`, `review-work`.

Tracker properties for the exposed Linear adapter are declared in
`.agents/tracker-properties.json`. Read that document; never write to it.

## Resolve a review candidate

A `candidateRef` resolves here to the candidate tree the review context
records: the tree SHA `delivery-harness review-context` reports as `candidate
tree <sha>`, which is the same value `prepare` publishes and the delivery
record carries as `treeSha`. Supply that resolution alongside the reference
when a verification round spans two candidates.

This repository's two mandated lens ids are `lens.outcome-correctness` and
`lens.adversarial-testing`, as `.agents/policy/repository-policy.json` declares
them. They are the ids an operator passes to
`npm run harness -- verify --mandated-lens lens.outcome-correctness
--mandated-lens lens.adversarial-testing`, and the ids a `lens.selected` run
event names as the mandated pair.

## Emit this delivery's run events

The run-event command here is `node --import tsx packages/cli/src/main.ts emit
<kind> --json '<payload>'`, run from the worktree root after `npm install` —
the bare `tsx` specifier is the form every package script uses, and it needs
the root devDependency the fresh worktree does not have until then. It runs
candidate source, exactly as every other harness command in this repository
already does.

One run is current per worktree: `emit run.started` allocates the run and
writes the pointer under the repository's git common directory
(`managed-delivery/runs/current/<worktree key>`), every later `emit` and every
candidate-facing command's own `command.completed` resolves that pointer, and
`emit run.ended` clears it. A run outlives the worktree it ran in, so end the
run rather than deleting the worktree out from under it. What is emitted is
observability, not evidence: no admission, gate, or record decision reads it.

## Both exposures are tracked

The install writes two host exposures — `.agents/skills` and `.claude/skills` —
and `.agent-skills/active.json` records both. Both are committed, so a fresh
clone gets a working installation from git alone: the generation, the `current`
pointer, and every exposure link.

A release is installed here by one command:
`AGENT_SKILLS_CHECKOUT=/path/to/agent-skills npm run skills:install --
--release-id <id>`. It builds and verifies the release from that checkout,
drives the lifecycle `update` against this repository, re-records the compiled
policy snapshot, and then fails unless the lifecycle reports `lifecycle:
current`, no blockers, and the generation it just built active. Rollback is the
previous release id through the same command.

When the installed generation or `.agents/policy/` moves outside that command,
re-record the compiled snapshot with `npm run policy:recompile` — it recompiles
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
