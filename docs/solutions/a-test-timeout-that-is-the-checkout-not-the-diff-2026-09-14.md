---
title: A test timeout that is the checkout, not the diff
date: 2026-09-14
category: harness
module: delivery-harness-cli
problem_type: measurement_error
component: testing
resolution_type: diagnosis_correction
applies_when:
  - "Several deliveries share one machine and a row that spawns subprocesses times out"
  - "A budget is about to be sized from a duration measured under concurrent load"
  - "A reviewer reports a row saturating a ceiling the delivery just raised"
tags: [delivery-harness, wall-clock, process-starvation, characterization, load-signature]
---

# A test timeout that is the checkout, not the diff

## Problem

V26-1495 replaces bare wall-clock budgets in three load-sensitive test files.
Partway through it, `packages/cli/src/run-surface.test.ts` — a fourth file the
delivery had extended itself to — stopped finishing at all. One row run alone
consumed the delivery's new 120 000 ms ceiling and was killed by it:

```
npx vitest run packages/cli/src/run-surface.test.ts \
  -t "writes a three-event journal across both writers and reads it back"
-> 1 failed | 84 skipped, Test timed out in 120000ms
```

A cold `node --import tsx packages/cli/src/main.ts --help` on the same machine
at the same moment took 4.9 s and the load average was 2.97, so this read as a
genuine hang: something that stops, which no ceiling can fix. The executor
recorded exactly that conclusion in its handoff — "raising the ceiling converts
76 fast failures into 76 two-minute hangs" — and the review lens independently
measured 11 rows timing out on the new ceiling with passing rows landing within
3 % of it, and filed a P1 saying the ceiling sat beside the work rather than
above it.

Both conclusions were wrong, and they were wrong in the same way.

## Diagnosis

The measurement was never crossed against its own control. Running the single
row four ways — the file's bytes against the checkout it runs in, with a
detached worktree at the pristine base as the second checkout — separates them
completely:

| file bytes | checkout | result |
|---|---|---|
| base | pristine base | 1 passed, 297 ms of test time |
| candidate | pristine base | 1 passed, 383 ms of test time |
| base | the delivery checkout | `Test timed out in 60000ms` |
| candidate | the delivery checkout | `Test timed out in 120000ms` |

The discriminator is the **checkout**, not the diff. The delivery checkout had
four sibling lanes' full gates and one orphaned `vitest` of its own running
beside it; the base checkout, minutes earlier and minutes later, did not. What
the row does is `git init`, three `git commit`s, and repeated CLI invocations —
so the scarce resource is **process spawn**, and under seven concurrent lanes
`npm exec vitest` was measured taking 37 s to reach `vitest` itself.

Load average does not capture this. The base checkout passed the row at load
6.66 while the delivery checkout timed out at load 2.22. A review lens on the
same delivery later measured the same asymmetry from the other end: opening one
warm provider child took 54 870 ms while the window that child's row actually
asserts cost 10 ms above the product's own timers.

## Resolution

Two things follow, and both were taken.

**Never size a budget from a duration measured under concurrent load.** No
trustworthy sizing measurement for those two files was obtainable while the
wave ran, so they were reverted to base rather than shipped with a ceiling
nothing had established. The delivery went back to exactly the three files its
ticket names.

**Keep the load term outside the window you assert.** Four rows in
`packages/cli/src/provider-rails.test.ts`, the one delivered file that opens
provider subprocesses, open one. The two of those rows that assert an elapsed
bound open it *before* starting the clock —
`await openReadyProviderProcess(...)` at lines 285 and 394, then
`const started = Date.now()` at 289 and 395 — so the spawn that load inflates
is not inside either measured window at all. Those two rows' residual overhead
above the product's own timers measured 10–528 ms across every run in three
review rounds, on a machine where spawning took tens of seconds. That is what makes an elapsed-time assertion survivable here at all,
and it is why the ticket's "wait on the actual condition" preference and an
explicit elapsed ceiling are not in tension: wait on the condition, then assert
the bound.

## The rule

`docs/delivery-runbook.md` already says to attribute a red at the pristine base
before believing it. Say the same thing one step earlier: **a duration is not a
measurement until it has been taken in two checkouts.** A row that times out in
one and passes in the other on the same machine within the same minute is
process starvation, whatever the load average says, and neither the number it
produced nor a ceiling sized from that number means anything.

The cheap control is a detached worktree at the base — `git worktree add
--detach "$REPO/.worktrees/<id>-base" origin/main` — which the runbook already
asks for and which costs one `npm install`. Cross the file's bytes with the
checkout: four runs settle what dozens of reruns in one checkout cannot.
