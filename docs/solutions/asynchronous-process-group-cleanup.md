---
title: Await process-group cleanup without re-entering the event loop
date: 2026-09-28
---

# Await process-group cleanup without re-entering the event loop

V26-2071 reproduced a hang in the distributed 0.7.2 process supervisor under
Bun 1.1.29. Thirty-four concurrent trivial commands failed to settle within
five seconds. Serial descendant-cleanup probes had passed, so they did not
cover the interaction between one child's cleanup and sibling completion events.

That Bun version rejects negative process IDs. The supervisor handled this by
calling `/bin/kill` synchronously from the child's exit callback. A smaller
`node:child_process` probe reproduced the hang when a completion callback ran
a synchronous subprocess; awaiting asynchronous work instead completed normally.
Replacing only the supervisor's synchronous fallback with asynchronous cleanup
made the installed-runtime-derived concurrency probe pass three times.

Retain one cleanup promise for each invocation. Timeout, cancellation, overflow
and normal leader exit share it. Await that promise before returning the result,
even when the child's close event arrives before the cleanup utility completes.
The fallback retains a one-second deadline, bounded output, a fixed utility and
environment, and the numeric identity of the owned process group. Windows keeps
its existing direct-child behavior.

The Bun compatibility fixture now checks concurrent successful commands before
the existing timeout, cancellation, overflow and leader-exit descendant probes.
It failed against the synchronous implementation and passed after the repair.
A separate test forces close before fallback completion and asserts that the
invocation has not resolved yet. Bun must be available to execute its compatibility
fixture; a skipped fixture is not evidence for that runtime.

This establishes the supervisor defect and repair. It does not establish that
every intermittent Athena test timeout or earlier protected-health timeout had
the same cause. Those hosted results remain separate evidence.
