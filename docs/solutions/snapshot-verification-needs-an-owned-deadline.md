# Snapshot verification needs its own owned deadline

A command timeout stops bounding work when the command exits. Private source
and dependency inventories and Git identity checks still run before a scoped
attempt can pass. A successful command followed by a pending inventory read
must remain a non-passing attempt; the raw result is diagnostic evidence only.

Run inventory in an owned process with only builtin filesystem dependencies and
an explicit minimal environment. Share one deadline across both verification
inventories and Git checks. On timeout or cancellation, kill the owned process
and await its close before deleting the snapshot. An abort error or a winning
`Promise.race` does not establish that filesystem activity has stopped.

The five-minute verification budget is independent of provider command budgets.
Three sequences over an independent copy of a real Athena snapshot completed
in 36.196, 35.501 and 34.356 seconds. The copy contained 150,936 regular files
and 1.74 GB including Git/control files; full inventories took 17.203–19.057
seconds and output-excluding inventories 17.023–18.255 seconds. These are
representative-size measurements after copying, which warms filesystem caches,
not universal or cold-cache guarantees. Retain each pass's time separately;
never derive inventory time from a provider's total setup/command duration.

A deterministic liveness sensor stalls a read inside the actual child, records
its PID, triggers the deadline or cancellation, and verifies the child is gone
before cleanup. A separate terminal sensor proves that command exit zero plus
verification failure retains the typed failure and no passing outputs. Preserve
ordinary digest parity, mutation and symlink controls, and run the bundled
worker from a disposable consumer: producer-only imports and runtime-specific
`--eval` argument handling can otherwise hide distribution failures.
