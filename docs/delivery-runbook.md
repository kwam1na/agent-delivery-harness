# Delivery runbook

How one tracked item is delivered in **this** repository, from a fresh worktree
to a merged pull request. It carries mechanics, not rules: the review bound, the
grace round, how a deferral is tracked, and how a finding is resolved are the
installed workflow's, read from the skills exposed under `.claude/skills`
(`review-work`, `execute-work`, `obtain-review`). Read
[`AGENTS.md`](../AGENTS.md) for which skill to use and
[the agent guide](agent-guide.md) for what the repository's sensors hold.

Every command below was run against this tree. Lines that could not be executed
here are marked `(unverified)`. `$REPO` is the checkout root — the directory
holding `AGENTS.md`.

## 1. The worktree

The branch name is the tracker item's own; slug the directory yourself.

```sh
git -C "$REPO" fetch origin
git -C "$REPO" worktree add "$REPO/.worktrees/v26-0000" -b <branch> origin/main
cd "$REPO/.worktrees/v26-0000"
npm install
```

`npm install` is not optional and not once-only. The bare `tsx` specifier every
package script uses resolves against the root devDependencies, which a fresh
worktree does not have; and **a rebase onto a moved `origin/main` can bring in
new devDependencies**, after which `npm run check` fails in seconds with
`TS2307: Cannot find module` errors that read like candidate defects. Re-run
`npm install` after every rebase, before the gate.

`.worktrees/` is untracked and deliberately holds past deliveries and lens
worktrees. Never delete a worktree that is not yours; leave yours in place when
you are done.

Every later command runs with the delivery worktree as the working directory.

## 2. Start the run

Run events are observability: no gate, admission, or record decision reads them.
Ask what the store supports, then start a version-2 run — every version-2 `emit`
needs a stable `--event-id`.

```sh
npm run --silent harness -- runs capabilities --json
# {"spec":"run-capabilities/1","writerVersions":["run-event/1","run-event/2"],"artifactCapture":true}

npm run --silent harness -- emit run.started --version 2 --event-id start-1 \
  --json '{"host":"claude-code","workflow":{"releaseId":"linear-product-v1","profile":"linear"}}'
# started run run-87d10e42776fc970
```

`releaseId` and `profile` come from `.agent-skills/current/release-manifest.json`.

**A run's writer version is fixed at `run.started` and cannot change.** If you
are continuing someone else's delivery, read it before emitting anything — a
version-1 run *refuses* `--event-id`, and its message ("Version 2 requires
--event-id; version 1 does not accept it") reads as the opposite advice:

```sh
npm run --silent harness -- runs show <run-id> --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).events[0].version))'
```

A version-1 journal also cannot carry `roundId`, `bound`, `grace` or
`reopensRoundId` — the frozen grammar refuses them as `unknown_member`. On such
a run, a reopened round can only be narrated in a `decision.recorded` payload.

Then, before the first review round (the completeness evaluator enforces the
order):

```sh
npm run --silent harness -- emit ticket.read --event-id ticket-1 \
  --json '{"ticket":"V26-0000","tracker":"linear"}'
npm run --silent harness -- emit posture.declared --event-id posture-1 \
  --json '{"posture":"sensor-only","ticket":"V26-0000"}'
npm run --silent harness -- emit lens.selected --event-id lens-1 \
  --json '{"mandated":["lens.outcome-correctness","lens.adversarial-testing"],"selected":["lens.outcome-correctness","lens.adversarial-testing"],"rationale":"the repository-mandated pair only: <why>"}'
```

`.agents/policy/repository-policy.json` fixes the mandated pair; the evaluator
raises `mandated-pair-mismatch` unless `mandated` names exactly those two ids.

Other kinds worth emitting: `decision.recorded {"fork","choice"}`,
`blocker.recorded {"code","summary"}`, `gate.reported {"command","outcome",
"durationMs","ticket"}` for `npm run check` (which is not a product command),
and `compounding.recorded {"outcome"[,"reference"]}`. `command.completed` is
refused for `emit` — only the CLI writes it.

## 3. Implementation

```sh
npx vitest run packages/kernel/src/foo.test.ts          # while iterating
DELIVERY_HARNESS_MAX_WORKERS=4 npm run check            # the gate
```

`npm run check` is typecheck, the import-boundary sensor, the CLI-inventory
sensor, then the suite. Time it: `gate.reported` wants `durationMs` and you
cannot recover it afterwards. Not in `check`, and yours to run when you touch
policy, packaging or the provider: `npm run sensor:policy`,
`npm run sensor:standalone`, `npm run qualify:provider`.

### Attributing a red gate under concurrent load

Several deliveries share this machine, and the suite's git-heavy fixtures sit
against a hard 5000 ms per-test default. Under load they cross it. The worker
cap helps with starvation and does nothing for a per-test bound, so **one capped
rerun is not enough to believe a red**. Work down this ladder and stop at the
first step that clears:

1. Grep the log. `Error: Test timed out in 5000ms` with no `AssertionError`
   anywhere is the load signature; an assertion failure never is.
2. Re-run the failing **files** alone — `npx vitest run <file> <file>`.
3. Attribute what still fails at the **pristine base**, in a detached worktree
   your candidate's bytes never touched:
   ```sh
   git -C "$REPO" worktree add --detach "$REPO/.worktrees/v26-0000-base" origin/main
   cd "$REPO/.worktrees/v26-0000-base" && npm install
   npx vitest run packages/cli/src/live-verification.test.ts
   ```
   The same row failing there is not yours.
4. Confirm the row passes with its bound raised: `npx vitest run <file>
   --testTimeout 60000`.

Only a failure that survives all four is a defect. A row that both drives the
CLI end to end and deliberately waits on wall-clock time needs its own explicit
timeout rather than the default.

**Never stop a suite with a machine-wide pattern.** `pkill -f vitest` and
`pkill -f "npm run check"` match every sibling delivery's identical command
line; there is no worktree scoping in `pkill`. Kill the process group you
started, or let the stale run finish and ignore its result.

### Paths

Writable in the `implement` checkpoint: `packages`, `scripts`, `docs`,
`.github`, `README.md`, `package.json`, `package-lock.json`, `harness.config.ts`.
Protected: `.agents`, `.claude`, `delivery`, `qualifications`,
`packages/conformance/vectors`.

Some files sit in a writable path and are still byte-pinned:
`packages/kernel/src/recorder.ts` (`RECORDER_SHA256` in
`scripts/qualify-agent-skills-provider.ts`) and everything under
`docs/contracts/` (the provider qualification driver and
`packages/cli/src/provider-rails.test.ts`). One byte is a failure.

**Commit every candidate edit before opening a review round**, and keep the
worktree clean — no unstaged tracked changes, no untracked files — from
`prepare` through `record`. Capture refuses otherwise with
`candidate_unprepared`. A mutating lens restores its probe with `git checkout --
<file>`, which restores to `HEAD` and would take uncommitted candidate edits
with it.

## 4. Realizing the two lenses

This repository mandates `lens.outcome-correctness` and
`lens.adversarial-testing`. Where the harness supplies no lens runner,
`obtain-review` has the host realize one by convention: one subagent per lens,
no shared context, the filled round brief from
`.agent-skills/current/skills/obtain-review/references/round-brief-template.md`
in its prompt.

| lens id | persona id | charter, verbatim into the brief |
|---|---|---|
| `lens.outcome-correctness` | `persona.outcome-correctness` | `.agent-skills/current/personas/outcome-correctness.md` |
| `lens.adversarial-testing` | `persona.testing-policy` | `.agent-skills/current/personas/testing-policy.md` |

Both charter digests are pinned in `.agents/policy/compiled-snapshot.json` as
`personaDigest`, and the evidence emitter re-checks the bytes and refuses on
drift. The reviewer ids the emitter accepts are the charter basenames:
`outcome-correctness` and `testing-policy`.

The binding tuple in the brief — release identifiers, graph digest,
`subjectRef`, `candidateRef` — comes from `review-context --json`, never from a
reviewer. A `candidateRef` resolves here to the tree SHA `review-context` prints
as `candidate tree <sha>`, which is what `prepare` publishes and the record
carries as `treeSha`.

**Give both lenses a shell.** A read-only lens without one reports no mutations
at all, and the testing charter's finding bar asks for the exact edit that would
make the product wrong.

### Lens worktrees

[The agent guide](agent-guide.md) states the rule: a lens that plants mutations
gets its own worktree, reset to the revision the round is bound to, beside the
delivery worktree and never nested under it. The command form matters, because
every other command in the loop runs from inside the delivery worktree and a
relative destination is resolved against the *current directory*, not against
`-C`. Both the `-C` and an absolute destination are required:

```sh
git -C "$REPO" worktree add --detach "$REPO/.worktrees/v26-0000-r1-at" <candidate-commit-sha>
git -C "$REPO" worktree add --detach "$REPO/.worktrees/v26-0000-r1-oc" <candidate-commit-sha>
cd "$REPO/.worktrees/v26-0000-r1-at" && npm install
```

Get this wrong and nothing complains until the next harness command reports
`candidate_unprepared` naming `.worktrees/…` as untracked. Check for it before
every harness command that captures:

```sh
ls -d "$REPO/.worktrees/v26-0000/.worktrees" 2>/dev/null && echo NESTED
```

`git worktree remove --force <nested path>` cleans it up.

### The round events

Version 2 adds `roundId` and the optional `bound`, `grace` and
`reopensRoundId`. The accepted members of `review.round.closed` are exactly
`round`, `roundId`, `candidateTreeSha`, `outcome`, `findings`, `cost`, `bound`,
`grace` and `reopensRoundId` — there is **no `lateFindings` member**, so a late
finding's count lives in the lens's report and the pull-request table, not in
the journal.

```sh
TREE=$(npm run --silent harness -- review-context | sed -n 's/.*candidate tree \([0-9a-f]*\).*/\1/p')

npm run --silent harness -- emit review.round.opened --event-id r1-open \
  --json "{\"round\":1,\"roundId\":\"round-1\",\"bound\":4,\"candidateTreeSha\":\"$TREE\",\"lenses\":[\"lens.outcome-correctness\",\"lens.adversarial-testing\"]}"

npm run --silent harness -- emit review.round.closed --event-id r1-close \
  --json "{\"round\":1,\"roundId\":\"round-1\",\"candidateTreeSha\":\"$TREE\",\"outcome\":\"aligned\",\"findings\":{\"P0\":0,\"P1\":0,\"P2\":0,\"P3\":0},\"cost\":{\"unit\":\"subagent-tokens\",\"total\":152352,\"reportedBy\":\"claude-code\",\"coverage\":\"partial\"}}"
```

`outcome` is a free label; prior runs here use `aligned` and `unresolved`. When
the host reports no cost, say so — `{"coverage":"unreported","reportedBy":
"claude-code"}` — rather than writing a zero.

A deferral's follow-up belongs in Linear project `agent delivery harness`, team
`yaegars`, related to the delivering item and naming the deferral and the lens
that filed it. `execute-work` says when that has to exist; a deferral is
discharged by filing it, not by folding the fix into the round — folding widens
the delta the next round has to span and leaves the filed item with nothing to
close.

## 5. The evidence loop, in order

`prepare` → `review-context` → *(review)* → `review:evidence` →
`submit-evidence` → `gate` → `record` → commit the record → `verify`.

```sh
npm run --silent harness -- prepare
# preparing typecheck
# prepared delivery-harness.pr-admission: tree 7c7d67d… (clean); receipt <git-common-dir>/…
#   treeSha 7c7d67d…

npm run --silent harness -- review-context
#   candidate tree 7c7d67d… (clean)
#   relevant lines N across M changed entries
#   activation active (threshold 1)

npm run --silent harness -- review-context --json > /tmp/review-context.json
```

Retain that JSON unchanged for the whole round: its `digest` is what the reduced
outcome must name. Then, with the outcome on stdin:

```sh
MANIFEST=$(npm run --silent review:evidence -- --context /tmp/review-context.json <<'JSON'
{
  "spec": "review-outcome/1",
  "contextDigest": "<the retained context's digest, exactly>",
  "verdict": "green",
  "reviewers": [{ "result": "approved" }, { "result": "approved" }],
  "findings": []
}
JSON
)
npm run --silent harness -- submit-evidence --manifest "$MANIFEST"
# accepted (manifestDigest 6e54e3f…):
#   review.green: published db87b10…
```

- Unnamed reviewers are admissible only when every result agrees; a
  disagreement must name them — `{"id":"outcome-correctness","result":
  "rejected"}` — against the policy-selected set, checked in both directions.
  `result` is one of `approved`, `rejected`, `failed`, `timed-out`; only
  `approved` stamps an approval, and `failed`/`timed-out` are refused.
- `verdict` is transcribed, not asserted: a non-green outcome yields a manifest
  the recorder rejects.
- An optional `cost` requires `costCoverage`.
- `submit-evidence` re-captures the candidate, so any edit between emission and
  submission rejects the whole manifest.

```sh
npm run --silent harness -- gate
# admitted: review.green=satisfied_evidence     (not_applicable when nothing relevant changed)

npm run --silent harness -- record
# recorded delivery/records/record--<deliverableDigest>.json

git add delivery/records && git commit -m "delivery record for V26-0000"

npm run --silent harness -- verify
```

Committing the record does not change the deliverable identity:
`harness.config.ts` lists `delivery/records/` in both `reviewNeutral` and
`recordNeutral`. But you **must** at least stage it before `verify`, which
otherwise blocks on `candidate_unprepared` for unstaged changes to tracked
files.

`verify --require-run-journal [--mandated-lens <id>]…` turns the journal row
into a blocker naming missing entries; it is a local opt-in that neither CI nor
the gate runs. Flags are `--flag value`, never `--flag=value`.

The journal ordering the completeness evaluator requires: `run.started` first
and once; `ticket.read`, `posture.declared` and `lens.selected` all before the
first `review.round.opened`; a round closes only after it opened; the governing
(last) `gate` completion after a closed round and bound to the record's tree
SHA; the `record` completion after that gate; `pr.opened` after the *first* gate
completion; `run.ended` last.

## 6. When `origin/main` moves

`deliveryRecordVerification: { baseMovement: "stale" }` in `harness.config.ts`
stales a record the moment the base moves, and `.github/workflows/gate.yml`
fails closed on a stale record. Two consequences.

**The tail is serialized.** With several deliveries in flight, everything from
`prepare` to the merge has to happen against a base nobody moves underneath you.
Take whatever lock the session is using, and inside it: fetch, rebase if needed,
`npm install`, re-run the gate, redo `prepare` → evidence → `gate` → `record` →
commit → `verify`, push, wait for the hosted checks, then confirm `origin/main`
still equals the record's `baseTipSha` **immediately before** merging.

**A replay is only free when it is genuinely identical.** `obtain-review` lets a
round be reopened rather than counted when the deliverable identity is
unchanged, and the executor has to compute and retain the comparison. Two things
about doing that here:

- Compare the **delivered lines**, not the raw diff bytes. A rebase over any
  commit that touched the same file changes blob SHAs in the `index` line, shifts
  `@@` hunk offsets, and can rewrite a context line, while every `+`/`-` line is
  identical. Taken literally on the raw diff, no such rebase could ever qualify.
  Retain both raw diffs *and* the canonicalized comparison — the path set and the
  `+`/`-` lines:
  ```sh
  git diff <base>..<head> -- . ':!delivery/records' > /tmp/old.diff
  grep -E '^[+-]' /tmp/old.diff | grep -Ev '^(\+\+\+|---)' | shasum -a 256
  ```
- Identical delivered lines do not mean the candidate still *works*. Pull
  request #114 replayed byte-identically onto a base that had deleted the very
  line its assertions bound, and three tests went red. **Run `npm run check` on
  the replayed candidate before deciding a round is a reopen.** A green replay
  reopens the round under `reopensRoundId`; a red one needs a fix, which changes
  delivered bytes, which is a new round.

## 7. Pull request and merge

```sh
git push -u origin <branch>
gh pr create --title "[V26-0000]: <imperative summary>" --body-file /tmp/pr-body.md
npm run --silent harness -- emit pr.opened --event-id pr-1 \
  --json "{\"url\":\"<pr url>\",\"candidateTreeSha\":\"$TREE\",\"ticket\":\"V26-0000\"}"
```

The body follows [`.github/pull_request_template.md`](../.github/pull_request_template.md):
a lead sentence, the `Linear:` link, `## What changed`, `## Evidence` (the gate
result, the other sensors run, the record path, `gate admitted:` and `verify`),
and `## Review` — the bound you declared, the lens ids, and a
`| Round | Lens | Outcome | Findings |` table, then how each finding was
discharged and each deferral tracked.

Hosted checks are `ci.yml` (matrix `node-22`, `node-24`, `bun-latest`) and
`gate.yml`, whose `verify-delivery-record` job runs `packages/action` against
the pull-request head.

```sh
gh pr checks <n> --watch
git -C "$REPO" fetch origin && git -C "$REPO" rev-parse origin/main   # must equal the record's baseTipSha
gh pr merge <n> --squash --delete-branch=false
```

Only once the merge is confirmed:

```sh
npm run --silent harness -- emit run.ended --event-id end-1 \
  --json '{"result":"complete","cost":{"coverage":"unreported","reportedBy":"claude-code"}}'
```

`run.ended` is terminal and clears the worktree pointer. Green hosted checks are
not the finish line — a base move landing after `run.ended` forks one delivery
across two journals with no way to record the second half.

## 8. Tracker hygiene

Team `yaegars`, project `agent delivery harness`, statuses from
`.agents/tracker-properties.json` (`In Progress`, `In Review`, `Done`) — read
that file, never write to it. Read the item before any mutation; move it to
`In Progress` when work begins; attach a comment (never a rewritten body) at
meaningful progress and when the pull request opens, carrying branch, commit,
posture, sensors and results, review outcome and rounds, deferrals and their
items; move it to `Done` after the merge is confirmed. One mutation per
invocation, and on a timeout or an ambiguous result reconcile by reading rather
than repeating it. `trackerAbsenceFallback` is `proceed-without-tracker`: a
missing tracker is recorded and the loop proceeds.

## 9. Pitfalls

- **`run_unresolvable` on `emit`** almost always means the shell's working
  directory drifted out of the delivery worktree, not a lost run: the current
  run is resolved from a pointer keyed on the worktree. Fix the directory, or
  pass `--run <id>`.
- **`runs show` needs the run id even when one is current**, and `runs show
  --json` reads `--json` as the positional id and refuses with
  `run_unresolvable`. When you are resuming a delivery, the journal at
  `$(git rev-parse --git-common-dir)/managed-delivery/runs/<run-id>.jsonl` is the
  direct answer to "what has already been emitted".
- **One run is current per worktree.** A second `run.started` is
  `run_already_current`; end the first, or `--force` (which records
  `displacedRunId`).
- **Per-command `--help`.** `npm run harness -- --help` at the top level is safe
  and lists the commands. Whether `<command> --help` is safe depends on the
  build: commands that parse no arguments used to run instead of printing usage.
  Read `packages/cli/src/commands/<command>.ts` if you are unsure what a command
  accepts.
- **A stale `REBASE_HEAD`** is left behind by a conflicted rebase concluded with
  `--continue`; git does not clean it up. Candidate capture ignores it — the
  `rebase-merge` and `rebase-apply` directories are the authoritative signals.
  On a build predating that fix, `prepare` refuses and `git update-ref -d
  REBASE_HEAD` clears it.
- **`docs/getting-started.md` fenced blocks are executed** by
  `docs/docs-examples.test.ts`, which reads that page and no other. Its `sh`
  blocks are one shell session. Its flag-token agreement is narrower than it
  reads: the CLI's side is harvested from one invocation, `submit-evidence` with
  no arguments, so adding usage text to another command is free and changing
  that message is not.
- **`docs/docs-references.test.ts` pins the set of guides it scans**, so a new
  `docs/*.md` file fails it until the enumeration is updated, and it checks
  every sentence stating a computable count *in every scanned document*. Adding
  a CLI command means re-stamping the command count everywhere it is written —
  today [`README.md`](../README.md) and [the agent guide](agent-guide.md) —
  because re-stamping one and leaving another stale is also a failure.
- **`docs/spec/delivery-evidence-1.md` is parsed as normative input**: its
  Appendix A/B fences must equal the published schemas byte-for-byte, and its
  Appendix D table becomes the rejection-code registry.
- **`README.md` and `docs/**` are review-relevant.** A documentation-only pull
  request still needs its own delivery record and review evidence. Only
  `docs/reports/`, `docs/solutions/`, `telemetry/delivery-runs/` and
  `delivery/records/` are review-neutral.
- **A committed entry under `.claude/` raises
  `record_protected_authority_path`**, with one exception: the skills exposure
  links, mode `120000`, targeting strictly inside `.agent-skills/current/skills/`.
- **Deleting one of several overlapping guards leaves the survivors unpinned.**
  When a change removes a member of a set of redundant detectors, mutation-test
  the *survivors*: the deletion is what turns previously-redundant coverage into
  a single point of failure.
- **Do not credit a red suite you have not attributed.** Several suites pin
  files by digest and go red on a comment-only edit; plant a comment-only no-op
  first and confirm it does not fail.
- **Exit codes**: `0` pass, `1` policy block, `2` usage, `130` interrupted.
