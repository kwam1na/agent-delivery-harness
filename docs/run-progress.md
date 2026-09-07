# Structured run progress

Run progress is self-attested observation. It never grants permissions, approves
a candidate, or replaces the product's evidence validators.

## Writer versions

Existing runs continue using `run-event/1`. A new writer starts v2 explicitly:

```sh
npm run harness -- emit run.started --version 2 --event-id start-1 --json '{"host":"codex","workflow":{"releaseId":"example","profile":"core"}}'
```

Every subsequent v2 `emit` requires a stable `--event-id`. The CLI reads the
selected run's version; it cannot change that version. An exact retry preserves
the original observation instant and sequence. Reusing the ID for a different
payload is refused. Start a new linked run when upgrading, naming the old ID in
the v2 `run.started` payload's `predecessorRunId`; retain the original history.
New readers accept both versions. Old readers may refuse v2 and must not erase it.

## Activities and reports

The closed payload definitions live in the
[run-event contract](../packages/kernel/src/checkpoint/run-event.ts). V2 adds these observations:

| Kind | Purpose |
| --- | --- |
| `activity.observed` | Activity/attempt, owner, phase, state and candidate; optional review identity, next step, verdict and cost |
| `wait.started` / `wait.resolved` | A named wait and its owner, scope, reason, required action and resolution |
| `finding.observed` | Explicit finding disposition attributed to a report |
| `report.referenced` | Review, reduction, clarification or partial-output reference, with explicit availability |
| `artifact.referenced` | Bounded artifact metadata and digest; reference alone does not prove retained bytes |
| `finish.step.observed` | Declared remaining delivery steps and their observed states |

An attempt belongs to one logical activity and candidate. Retrying creates a new
attempt with `supersedesAttemptId`; a late result for the old attempt remains
history. A terminal attempt cannot restart. Queued attempts can fail or be
interrupted, and terminal observations with missing start events remain visible
as incomplete history. No start time is invented.

Review round identity is separate from attempt identity. V2 round events carry
`roundId`; opened events may carry a declared `bound`, `grace` designation and
`reopensRoundId`. The workflow decides round accounting. A viewer does not count
a clarification as another policy round on its own.

The shared projection retains all findings and separately selects the latest
reported disposition of each current finding. These are reported findings,
not an independent verdict. Absent structured findings remain unreported.

Freshness is computed against a caller-supplied clock and a five-minute default
window; callers may supply another nonnegative window. Recent observation does
not establish continuous liveness. Silence becomes stale or unknown. An open
run or current worktree pointer is not a heartbeat.

V2 round costs are cumulative reported snapshots per round, reporter and unit.
The latest comparable snapshot replaces an earlier one; supersession marks
coverage partial. Unreported measurements are never zero. Attempt and run totals
must not be added to their encompassing round totals.

## Automatic command observations

The candidate-facing command boundary reports `check`, `prepare`,
`review-context`, `emit-review-evidence`, `submit-evidence`, `gate`, `record` and
`verify`. On a v2 run, an invocation records a running activity against the
candidate captured before execution and a matching completed, failed or
interrupted observation when the boundary returns. Concurrent invocations have
separate IDs; a changed current-run pointer cannot move their completion to a
different run. The existing `command.completed` retains the exact exit outcome,
duration and successful digest. Preparation execution/reuse detail is separate.

The native waiver prompt supplies an actual human wait and its scoped
resolution. It does not change who may approve, and no approval is reusable
from these events. Intermediate provider or host progress is unavailable unless
explicitly reported; there is no heartbeat supervisor or transcript inspection.
An abruptly terminated process can leave a running attempt that becomes stale;
absence of completion never means success. No raw arguments or environment
values are captured.

The boundary checks the selected journal version before emission. Legacy runs
retain completion-only v1 events. Missing candidate capture leaves activity
unreported; it never invents a candidate. Failed observation writes do not change
command outcomes or gate decisions. Viewing runs does not journal the viewer.

## Storage and export

Run writes use bounded cross-process serialization around validation,
deduplication, sequence allocation and append. This requires local filesystem
semantics and one host PID namespace. Live lock owners are never expired; a dead
owner may be recovered. Contention refuses the observation after five seconds
by default without changing the underlying command's result.

`runs show <id> --json` emits `delivery-run-export/2` for v2 runs. Its progress is
a historical projection at the last recorded observation, not fresh verification.
Readers recompute the projection and reject inconsistent derived values. V1
exports remain supported. Artifact metadata in this contract does not itself
retain a file; acquisition capture and portable attachment transport use the
separate retention capability when installed.

Selected acquisition reports can be retained through [run artifact capture](run-artifacts.md).
