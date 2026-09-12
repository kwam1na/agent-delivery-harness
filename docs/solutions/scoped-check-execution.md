# Scoped checks execute from private prepared source

V26-2065 extends the kernel's scoped check contract with the CLI executor. The
explicit `scopedExecution` configuration uses `scoped-execution/1`, a list of
mechanical provider IDs, and profiles naming dependency input files, optional
installation argv and timeout, mutable outputs, and nonsecret credential
revision IDs. Existing configurations keep the strict execution path.
Profiles default to `gitContext: "full"`: checks receive the pinned Git history
and coordinates, and their identity includes original HEAD and the full prepared
tree. Choose `gitContext: "none"` for file-only checks that should retain scoped
reuse across report commits. Those snapshots expose neither repository metadata
nor injected Git coordinates; their Git control directory remains outside the
execution tree for the executor's integrity checks. Dependency setup obeys the
same profile boundary.

Preparation captures scoped source through a temporary Git index. This includes
untracked source and working edits without changing the author's index. Declared
`scopedExecution.repairCommands` run before capture. Existing preparation commands
remain validators and source drift during them blocks the receipt. Mechanical scoped checks then succeed before the
preparation receipt is published. The same per-check identity and retained
attempt history govern subsequent gate execution.

A private Git repository receives the prepared tree and pinned history by object
transfer. Its deterministic synthetic HEAD contains staged and new source, with
the original HEAD retained separately. Explicit base/candidate refs are injected
for changed-file checks. The shared tree reader binds declared input bytes,
executable modes and symlink target chains for execution and portable verification.
The selected base ref, tip and merge base also enter that shared identity: a
changed-file command can change its result when the base moves even if declared
source bytes stay identical. Unchanged-base report edits retain scoped reuse for
file-only profiles; full Git profiles conservatively rerun.
Source and dependencies never link to the authoring
checkout. Dependencies install privately, prepared source is checked for drift,
and the installed tree is hashed and checked after execution. Compatible checks
share a snapshot; failed or changed snapshots are discarded before siblings run.
Each command has separate home and temporary directories. Only declared flags
and credentials are injected alongside controlled runtime paths and Git context.

Attempt allocation publishes a running generation before setup. Atomic terminal
publication cannot overwrite another completion; allocation order fences older
passes even when completions arrive out of order. Successful siblings remain
available after failure. Corrupt or incomplete history is a typed blocker, not
an empty cache. Gate reuse requires the existing kernel to admit the retained
check proof against the newly computed current plan.

Receipts retain source/profile observations, originating attempt, bounded redacted
logs, output bytes and measured execution time including snapshot setup. Raw
credentials and secret-derived identities are refused; outputs containing a
credential are not retained. Without a safe credential revision, every executing
invocation allocates a new attempt, including on the same candidate.

Portable verification recomputes scoped source/dependency declarations from the
selected Git tree and validates the retained observation and attempt through the
existing delivery-record path. It does not need the original private store.
Verifying a non-reusable result after staging its record requires proven strict
record-neutral equivalence; this is record transport, not future execution reuse.
For full Git profiles, historical HEAD restoration additionally requires a
linear chain of nonempty record-neutral commits (at most 64). Empty commits,
merges and source/report commits require current full-context evidence instead.
Local self-attestation remains local self-attestation. Separate hosted execution
profiles remain the adopter's policy; this change adds no cross-host trust.

The private snapshot isolates concurrent authoring, not arbitrary malicious test
code. Declared source closure and installation policy remain adopter contracts.
Qualification lives in the real Git CLI lifecycle, snapshot and attempt-store
fixtures, alongside the unchanged strict declared-check sensors. Distribution
and artifact qualification are the dependent V26-2067 delivery.

## Bind dynamic selection to the execution snapshot

Configuration loads before `scopedExecution.repairCommands` run. Loading a new
process after repair fixes that ordering, but does not by itself bind a dynamic
provider selection to the candidate captured later. An edit or base movement in
between can otherwise make a valid check list incomplete for the captured tree.

An adopter can use the existing mandatory mechanical provider seam without a
second admission engine:

1. Complete selection-affecting repair first. Resolve immutable candidate tree,
   original HEAD, base tip and merge-base Git objects. Derive provider membership
   and input closure from those objects, not subsequent working-directory reads.
2. Pass expected coordinates as declared nonsecret environment flags to a dedicated
   scoped provider with a static command.
   Its profile uses `gitContext: "full"`, no dependency setup and no outputs.
   Add an always-active obligation requiring its `checks.passed/1` evidence and
   put it first in `scopedExecution.mechanicalProviders`.
3. Inside that check, compare expected tree and HEAD to
   `DELIVERY_CHECK_ORIGIN_TREE` and `DELIVERY_CHECK_ORIGIN_HEAD`; compare the base
   tip to `git rev-parse "$DELIVERY_CHECK_BASE_REF"` in the private repository,
   and compare the merge base to `DELIVERY_CHECK_MERGE_BASE`. The planner and
   execution configuration must use the same declared base ref. Exit nonzero on
   any mismatch. Do not replace these native snapshot coordinates with live
   authoring-checkout reads or before/after filesystem observations.
4. On rejection, derive a new plan from new immutable objects and prepare again.
   Keep selection-affecting repairs outside this invocation. The guard runs
   before later mechanical providers and before preparation publishes a receipt;
   a missing or stale receipt also blocks direct gate and record calls.

The expected coordinates are declared flags, so a changed expectation changes
this guard's scoped identity without changing configuration definitions. Its full Git profile also binds native
base, HEAD and raw tree; a previous pass cannot authorize a moved snapshot.
Application checks may retain separate `gitContext: "none"` profiles and reuse
unchanged inputs independently. No tree pin is written into the source tree it
identifies: the invocation carries the derived flags. Keep provider definitions stable across
neutral transport so portable verification can use their retained observations.

`scoped-checks.test.ts` exercises an exact positive control, then candidate-only,
base-only and HEAD-only races, an independently wrong merge-base flag, plus changed guard commands, including direct gate
and record calls before another prepare. This pattern establishes selection
consistency; the adopter still owns the correctness of the dependency planner.


## Read failed and interrupted attempt observations

The public CLI API exports `readScopedCheckObservations({ rootDir, config })`.
Supply the gate ID, storage namespace and requested scoped provider definitions.
It returns `scoped-check-observations/1`: those providers in configuration order,
with their complete native attempt history in ascending generation order. Each
attempt retains its native status, identity and origin coordinates, and measured
`durationMs` only when recorded. Running attempts have no invented duration.

This read creates no storage, receipts or evidence. Missing history is empty;
corrupt selected history throws `check_attempt_corrupt`. Logs, output bytes and
unexpected stored properties are not projected. Removed or unrequested providers
are not implicitly inventoried. The read applies no new pruning or history cap.

These are observations, not an admission or current-applicability decision. An
older generation is not relabelled permanently superseded: its distinct inputs
may be relevant again. The native gate owns current selection/fencing, and native
portable verification owns recorded proof. Readout consumers can therefore show
failed gates and interrupted work honestly without parsing human command logs or
importing the private attempt store. The bundled qualification reads this API
through `cli-api.mjs` after actual partial failure and SIGINT cancellation.
