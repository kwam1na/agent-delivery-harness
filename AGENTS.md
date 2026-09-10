# Repository instructions

This repository is the delivery harness product **and** an adopter of the
workflow projection installed under `.agent-skills/`. The two are separate:
the skills say how work is decomposed and executed; the harness says what a
candidate must prove before it is merge-ready.

A host delivering a tracked item here reads two further documents: [the agent
guide](docs/agent-guide.md) for the module boundaries, the sensors, and where a
review lens that plants mutations runs them, and [the delivery
runbook](docs/delivery-runbook.md) for this repository's loop from a fresh
worktree to a merged pull request. Neither is a source of workflow rules; both
carry mechanics this repository owns.

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
(`managed-delivery/runs/current/<worktree key>`). Later `emit` calls resolve
that pointer unless `--run <id>` selects a run explicitly. Supported candidate
commands pin the selected run at invocation entry so their completion cannot
move to a replacement run. `emit run.ended` clears the matching pointer. A run outlives the worktree it ran in, so end the
run rather than deleting the worktree out from under it. What is emitted is
observability, not evidence: no admission, gate, or record decision reads it.

Keep the run open until the authorized finish line is confirmed.
Under `baseMovement: "stale"`, settle base movement before ending the run:
fetch the base, compare it with the recorded candidate, and refresh stale
preparation, review, gate and record within the same open run. For an authorized
merge, confirm the merge before emitting `run.ended`. For a `merge-ready`
handoff, confirm the required checks and current base first; a later continuation
is a new attempt. `run.ended` is terminal; no append can reopen it. If more work
is needed after it, start a second version-2 run with `predecessorRunId` naming
the ended run, preserving both journals. An observed own merge completes the
merge finish line; it does not make a stale record valid for new admission.

Before version-2 reporting, query `runs capabilities --json` through the same
CLI entry point and inspect the selected run with `runs show <id> --json`.
Unsupported capabilities or a legacy run do not authorize a version upgrade.
Use the installed workflow's shared observation contract for actual candidate,
round, lens, activity and attempt identifiers; keep stable event IDs on retries.
Capture selected structured reports through `runs capture <id> --json <request>`
before removing their scratch files. See [run progress](docs/run-progress.md)
and [artifact capture](docs/run-artifacts.md) for command lifecycle, missing
signals, limits and failures. Export with `runs export <id> --output <file>` when
retention must survive loss of the repository's common directory.

## Both exposures are tracked

The install writes two host exposures — `.agents/skills` and `.claude/skills` —
and `.agent-skills/active.json` records both. Both are committed, so a fresh
clone gets a working installation from git alone: the generation, the `current`
pointer, and every exposure link.

A distributed product is installed here with
`npm run skills:install -- --archive <product.zip> --metadata <release.json>`.
The executable archive owns the existing lifecycle update, the bundled runtime,
and policy reconciliation. No producer checkout is needed. Product readiness
requires a current lifecycle, verified runtime/workflow bytes, and a current
compiled policy; a lifecycle switch alone is not product readiness. See
[artifact installation](docs/product-artifacts.md) for rollback and recovery.

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

For mutation testing, start with the narrowest sensor that reaches the changed
behavior and run the clean control and mutant against the same isolated scope.
A timeout in a full-suite run under concurrent load establishes neither
contention nor a killed mutation; rerun both control and mutant in isolation
before attributing the result.

Overlapping guards can make each other equivalent mutants when either guard
fully enforces the same claim. Evidence for one guard must disable every other
guard that would mask its removal. When that is impractical, prefer one guard
with exhaustive per-arm pins; do not add a second full enforcement layer whose
effect no single-arm mutation can expose.

## Finish version bumps at the registry

A delivery that changes the root or any workspace package version includes
publishing all five `@agent-delivery-harness/*` packages through
`.github/workflows/publish.yml` from the matching pushed version tag, unless the
user explicitly requests a narrower finish line or no publication. A merged
version-bump pull request is still in progress: observe the publish workflow to
completion, then independently query npm for each exact package version and
confirm that every package's intended dist-tag resolves to it. Stable releases
use `latest`. A prerelease requires an explicitly selected prerelease channel
and publishing mechanics that pass that channel; the current workflow uses
npm's default `latest` tag, so do not assume a prerelease tag selects a channel.
Report any publication or registry-verification blocker with the exact package,
version, and remaining release state rather than claiming completion.

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
