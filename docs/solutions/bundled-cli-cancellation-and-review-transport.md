# Qualify the executable boundary and retained review coordinates

API fixtures can inject an `AbortSignal` while the shipped command has no signal
handler. That leaves an apparent cancellation guarantee untested: sending SIGINT
to the real bundled process used to terminate it before its executor could retain
an interrupted attempt. Qualification now launches the provided runtime in fresh
processes and interrupts an actual check. The executable entry installs a handler
only for the invocation, passes its signal through the existing runtime boundary,
and removes it on completion. Stdin and waiver waits settle on the same signal so
intercepting Ctrl-C cannot leave those waits open. The final code is 130 and the
attempt is interrupted, with no passing evidence from the interrupted command.

Record-neutral transport is another boundary API shortcuts can conceal. A fully
verified review entry may belong to a tree preceding final telemetry staging,
even when the original acquisition needed no explicit review-neutral projection.
Journal completeness uses the verified review entry's candidate coordinate as
well as any verified projection's original reviewed coordinate. Projection
matching is against that entry, not the final transported record tree. A matching
review obligation and its reviewer charters are still required; unverified or
unrelated claims cannot supply review coordinates. This is a readout correction:
record admission and journal history are unchanged.

The retained controls are the real bundled runtime lifecycle in
`scripts/build-product-runtime.test.ts`, stdin/prompt settlement in
`packages/cli/src/main.test.ts`, and both initial same-tree and explicit-projection
review transport cases in `packages/cli/src/verify-run-journal.test.ts`. Release
qualification executes the archive's provided runtime, then tests foreign record
verification without the original private attempt store. Source test success
alone is not a claim about a distributed artifact or an activated adopter.
