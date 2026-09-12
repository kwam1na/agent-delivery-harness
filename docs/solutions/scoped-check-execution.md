# Scoped checks execute from private prepared source

V26-2065 extends the kernel's scoped check contract with the CLI executor. The
explicit `scopedExecution` configuration uses `scoped-execution/1`, a list of
mechanical provider IDs, and profiles naming dependency input files, optional
installation argv and timeout, mutable outputs, and nonsecret credential
revision IDs. Existing configurations keep the strict execution path.

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
Local self-attestation remains local self-attestation. Separate hosted execution
profiles remain the adopter's policy; this change adds no cross-host trust.

The private snapshot isolates concurrent authoring, not arbitrary malicious test
code. Declared source closure and installation policy remain adopter contracts.
Qualification lives in the real Git CLI lifecycle, snapshot and attempt-store
fixtures, alongside the unchanged strict declared-check sensors. Distribution
and artifact qualification are the dependent V26-2067 delivery.
