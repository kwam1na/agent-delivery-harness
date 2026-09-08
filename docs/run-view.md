# Follow a delivery through the run view

Use `delivery-harness runs serve --repo <path>` to open the existing loopback
viewer. Select a run from the inventory to get a stable URL. Current waiting
ownership and work appear first, followed by current reviews, retained reports
and declared finish steps. Earlier attempts, evidence, cost and history are
available in expandable sections.

A selected/open pointer is not execution proof. The latest producer observations
supply activity status and freshness. Silence becomes stale or unknown, never
an invented failure. The default freshness window is five minutes; change it
with `--freshness-seconds <n>` (0–86400). Current unresolved findings are separate
from historical round totals and superseded attempts. Unreported fields remain
explicitly unknown. Permission observations do not grant permission.

`delivery-harness runs view <run-id>` gives the same operational labels in a
terminal. Add `--json` for the versioned `run-view/1` projection. The existing
server `/api/runs` includes that same projection under each run's `view` member.
`runs show --json` continues to provide the existing portable event export.
Surface clocks describe the time of reading; archived observations retain their
historical clock. No polling request invokes a provider, gate, or verification.
Evidence events are reported observations; current candidate applicability stays
unknown because this viewer does not establish identity or evidence admission.

Retained report links open an inert reading view with an exact-byte download.
Run, lens, attempt, candidate and digest remain in supporting details. Missing/refused/corrupt reports
show their reason and a return link. Report pages never auto-refresh. Keyboard
links have visible focus; live updates preserve the selected URL and reading position.
Current-work cards stack on narrow screens; wide historical tables scroll locally.

Use `delivery-harness runs serve --archive <file>` to view a saved portable run
archive without its repository. Repeat `--archive` to name multiple files; combine
with `--repo` for a mixed inventory. Archive files are explicitly loaded at server
start; URL routes name validated archive/run/artifact identifiers, never arbitrary
filesystem paths. Archives remain historical and do not refresh, resume a run,
create a pointer, or become approval evidence.

The server preserves loopback-only binding, exact Host validation, a restricted CSP,
no-store headers and inert report rendering. Nothing uploads automatically.
See [capture](run-artifacts.md), [portable archives](run-archives.md), and
[run progress semantics](run-progress.md) for the underlying contracts.

## Inspect a retained delivery record

When the run has no durable record locator, select one explicitly:
`delivery-harness runs view <run-id> --record <repository-relative-path> --json`
or `delivery-harness runs serve --record <repository-relative-path>`.
The server resolves this same relative path inside each explicitly selected
repository. It never accepts filesystem paths from HTTP requests or imports the
repository configuration. Reads validate repository containment and reuse the nonblocking descriptor
reader with the delivery record’s 16 MiB bound. Larger records and nonregular
files are unavailable, not truncated. Captured report attachments retain their
separate 2 MiB limit.

CLI, JSON and browser show the same retained candidate binding, claims and
self-attested provenance after record grammar and integrity checks. This is a
recorded observation, not a new admission or verification result. Current
applicability stays unknown: a run event or matching tree alone cannot establish
all current policy/configuration inputs. A record for an older candidate keeps
its original binding. Missing, malformed, digest-mismatched and refused reads
are explicit; no previous successful read is cached. Archives never consult a
live repository record.

Delivery records store no original verification timestamp, so that field is
unavailable. Retained provider manifests may carry a digest-bound `recordedAt`;
it is labeled **provider-reported recording time**, never verification time.
Filesystem modification times are not used.

Completed, failed, interrupted and superseded attempts remain in **Activity
history**, including activities outside formal review. Each retains its owner,
phase, attempt and candidate binding, last observation, freshness and reported
cost. An empty Current work section distinguishes absent observations from a run
whose observed attempts are all terminal; neither is proof of delivery completion.

**Reported cost** shows each supplied attempt measurement with its coverage and
reporter, including superseded attempts. Unreported costs stay unreported. Attempt
measurements are not added to run or review totals, which may cover the same work;
there is no inferred cumulative total across attempts or incompatible units.

## Operator reading experience

The inventory groups open and recent deliveries, with older runs behind
expandable lists. A delivery page puts waits, current work, current reviews,
reports and declared milestones first. Earlier reports, accounting, provenance
and the raw journal remain available in disclosures. These presentation choices
do not change the CLI or JSON projection, or turn reported outcomes into approval.

Live mode is the default for selected open runs. A fixed, hash-authorized script
fetches the same server-rendered page and updates existing elements in place;
there is no full-page refresh. Open disclosures, focused controls and the reading
position are retained. Updates wait during interaction or text selection. Pause
updates stops polling the server; Resume live updates resumes it. Hidden tabs
skip requests, errors retain the last page with a retry notice, and polling stops
when the selected run ends. With JavaScript disabled, Refresh remains available.
Report and archive pages do not poll.

Structured JSON reports have a reading view for results, findings and suggested
changes. Supporting evidence and the original source are expandable; downloads
retain the exact bytes. Unknown report shapes fall back to readable fields or
plain escaped text. Bounded previews always leave the full source available.
Only the fixed live-update script is authorized on run pages; report pages retain
`script-src 'none'`. Executor-written content never becomes executable markup.
