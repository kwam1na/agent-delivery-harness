# Resume an ordinary delivery

`save-context` and `resume` retain a bounded contract in the existing run journal. They do not register a managed delivery, execute work, grant authority, or replay actions. The native host owns execution and reconciliation.

Follow the normal [delivery loop](getting-started.md) before and after recovery.

Start a run with `emit run.started`, then save the contract before beginning a stage, while the candidate is capturable (clean or fully staged):

```sh
delivery-harness save-context --json '{"contract":{"objective":"Ship the change","acceptanceCriteria":["Required checks pass"],"finishLine":"merge-ready"},"stage":"work"}'
```

The command reads the installed workflow release from `.agent-skills/active.json` and records its archive identity, the runtime version, candidate/base identity, and current configuration binding. A failed candidate capture or invalid installation blocks the save. The contract is bounded to an objective, 1–32 acceptance criteria, and a finish line. Do not put credentials, transcripts, or shell commands in it. Saving again appends a new observation; it never changes a receipt or overwrites prior actions.

`save-context` writes at the selected run's own writer version, which it reads from the run's first journal event, so a `run-event/2` run accepts the save and a legacy `run-event/1` run keeps writing v1. It never upgrades a run. On a v2 run the event ID is derived from the observation itself — `context-saved-<sha256 of the canonical kind and payload>` — so it is the stable retry key that version requires: an interrupted save repeated with the same contract, stage and candidate is the same event, retaining its first instant and sequence rather than appending a second, while any changed observation is a different ID and a new entry. Nothing has to be passed on the command line for this.

A refused save is a typed blocker and nothing else: no event is appended, no prior entry is rewritten, and the command never reports success. The blocker carries the store's own rejection code, JSON pointer, and message — for example `malformed_member at /payload/contract/acceptanceCriteria` — so the offending member is named. Those three come from the store, never from the refused payload, so the diagnostic names the field without echoing its value.

Before an authorized external operation, record a unique intent with enough reference information for the host to discover its outcome:

```sh
delivery-harness emit action.intent --json '{"actionId":"merge-pr-42","operation":"merge","reference":"https://github.com/example/repo/pull/42"}'
```

Invoke the authorized operation using host tools. Then record its **observed** outcome (`succeeded`, `failed`, `not-performed`, or `unknown`) and a reconciliation reference:

```sh
delivery-harness emit action.observed --json '{"actionId":"merge-pr-42","outcome":"succeeded","reference":"https://github.com/example/repo/commit/abc"}'
```

If a response is lost, inspect the actual remote state before recording the result or retrying. An intent without an observation stays unknown. Duplicate intent IDs, orphan observations, or contradictory terminal outcomes require manual reconciliation. A new authorized attempt uses a new action ID. An observed success is historical context, never fresh permission to perform an operation.

After interruption:

```sh
delivery-harness resume
delivery-harness resume --run run-existing-id
```

The JSON readout includes the saved context, action references, binding drift, actual preparation and admission sensor results, and `reuseAllowed`. It never prompts for waivers or invokes providers. Exit 1 means evidence or reconciliation is incomplete, even though the saved contract is printed for recovery. Dirty work remains recoverable from that context but cannot reuse a prepared candidate until the existing checks accept it. A missing or corrupt journal/context is a typed blocker.

Review-neutral raw-tree changes are reported; existing freshness sensors decide whether they allow reuse. Changed source, base, policy, release, or workspace requires appropriate revalidation. Even a successful readout is a point-in-time check: run the normal gate again before a consequential action. An explicit `--run` reads that run; it does not replace the invoking worktree's current-run pointer. Use explicit `emit ... --run <id>` for subsequent observations when necessary.

## Cost coverage

Legacy `{ "unit": "tokens", "total": 120, "reportedBy": "host" }` remains valid. Hosts with incomplete counters can add `"coverage":"partial"`. A host without a counter reports `{ "coverage":"unreported", "reportedBy":"codex" }` in `review.round.closed` and `run.ended`. An unreported cost cannot carry a unit or numeric total. The terminal and browser show this coverage explicitly; zero is reserved for an actual measured zero.

The recovery events and saved contract are self-attested observations. Admission continues to read the product's preparation receipts and evidence store, never the run journal.

## Export a run

`delivery-harness runs show <run-id> --json` emits `delivery-run-export/1` from
the existing validated journal. It retains the actual events and refused append
notes, the product's summary and completeness readout, and review cost totals
grouped by reporting host and unit. Adopters can retain this output for their
scorecards without implementing a separate accounting ledger. The export is
read-only observability, unbound to a delivery record; it grants no admission.

Missing counters remain unreported. Any unreported entry, partial counter, or
unclosed review makes available review totals partial. A numeric overflow has
a null total and partial coverage; original measurements remain in the events.
Run-wide cost stays separate because it may already include the review cost.
No currencies or units are converted. Consumers render free text as untrusted
data, and keep the export's observability labels visible.

Repository sensors can import `parseRunExport` from the CLI API to validate a
retained export. It validates the original events and recomputes summaries,
costs, and completeness with the same projection used by the command. Changed
totals or malformed events fail with `run_export_invalid`. Successful parsing
only proves an internally consistent observation; it does not authenticate the
executor, authorize an operation, or replace delivery-record verification.
