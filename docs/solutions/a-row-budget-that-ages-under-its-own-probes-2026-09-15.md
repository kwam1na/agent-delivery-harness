---
title: A row budget that ages under its own probes
date: 2026-09-15
category: harness
module: delivery-harness-scripts
problem_type: measurement_error
component: testing
resolution_type: budget_and_attribution
applies_when:
  - "A row that spawns many subprocesses times out on a base nobody touched"
  - "A qualification grows a probe and the row driving it keeps its old bound"
  - "A refusal message names a product command but the host is what failed"
tags: [delivery-harness, wall-clock, process-starvation, characterization, attribution]
---

# A row budget that ages under its own probes

## Problem

`scripts/build-product-runtime.test.ts` failed on untouched `origin/main` at
`0edb8d5`, `9834e33` and `1a64ab4`. Two lanes of the 2026-09-13 wave met it in
their tail gates, each as `1 failed / 2 passed` with `Error: gate expected exit
0` after about 135 s, and neither could touch the file because it belonged to a
delivery that still read In Progress. Run alone on a quiet-ish checkout the same
file fails differently:

```
npx vitest run scripts/build-product-runtime.test.ts
-> Tests 1 failed | 2 passed (3), Duration 193.62s
   × qualifies scoped execution through the actual bundled runtime 180003ms
   Error: Test timed out in 180000ms.
```

Two different messages, one row. Neither is an assertion.

## Diagnosis

The row calls `runScopedRuntimeQualification`, which drives the bundled runtime
through three disposable repositories. Instrumented outside vitest, the split is
unambiguous:

| stage | cost |
|---|---|
| `buildProductRuntime` (esbuild ×4 + rollup-dts ×2) | 1 425 ms, then 1 061 ms warm |
| `runScopedRuntimeQualification` | 206 871 ms across **45** bundled-CLI executions |

So the setup the row was suspected of — rebuilding the runtime — is 0.7 % of it,
and the row's declared 180 000 ms bound sits *below* the work it drives. The
bound was written when the qualification proved fewer probes; V26-2067 added
`selection-snapshot-guard` and `attempt-observations` and the executions that
prove them, and nothing connected the new probes to the old number.

The per-execution cost is the second half. Five consecutive
`cli.mjs --help` runs on this host inside one minute:

```
125 ms, 1516 ms, 8560 ms, 151 ms, 120 ms
```

Same command, same bytes, same minute, two orders of magnitude apart. That is
the process-starvation signature
[the 2026-09-14 note](a-test-timeout-that-is-the-checkout-not-the-diff-2026-09-14.md)
describes, and it is why the same row produces `gate expected exit 0` under a
wave — a check command crosses its own `timeoutMs` waiting to *start*, and the
qualification reports the command it expected rather than the wait — and a bare
`Test timed out` when run alone. The failure is load-shaped in magnitude and
structural in cause: 45 spawns against a distribution with an 8.5 s tail, under
a bound that never counted them.

## Resolution

Three things, all inside the one file the ticket owns.

**The ceiling is not sized from a duration.** 206.9 s was measured with a
delivery wave running beside it, and the 2026-09-14 note is explicit that such a
number is not a measurement. It is recorded as an observation and not used as a
divisor. The row's ceiling is 900 000 ms because that is far above anything the
row has cost either way and still short enough that a genuine hang fails inside
one delivery. No row here asserts how long it took.

**The probe count is pinned to the budget.** The row now asserts
`result.commands.length <= 45`, the count observed when the ceiling was written.
A probe added to `qualify-product.ts` trips a named assertion in the file that
has to pay for it, instead of silently spending someone else's tail gate. This
is the regression row: it fails for the exact reason the original bound went
stale.

**A refusal says which side failed.** `attributeScopedQualificationFailure`
reports `environment` when a bare `node -e 0` start was stalled while the row
ran, `candidate` otherwise, and `candidate` when nothing was sampled: it names
the environment only when the environment measurably stalled, and never
launders a real defect. Its three rows pin the allow side, the deny side, and
the unsampled case.

The first version of that function got this wrong in a way worth keeping. It
sampled on the way *out* of the catch, and on its first real failure — a check
crossing the qualification's own 30 000 ms command timeout under the storm — it
reported `candidate`, because by the time it asked, the host had recovered and
the median start was 67 ms. A stall is transient and it is the outlier that
records it. So the sampler now runs *alongside* the qualification and the
verdict reads its maximum, not a median taken afterwards. An attribution
measured after the thing it attributes is not a measurement of it.

The build is also hoisted to one `beforeAll` with a copy per row, which is the
cheap half of the ticket and worth about three seconds — recorded here mostly so
the next reader does not re-derive it as the cause.

## The rule

**A bound on a row that drives a fixed number of subprocesses is a claim about
that number, so pin the number.** A duration ages silently; a count does not. If
a row's cost is `n` spawns and `n` lives in another file, assert `n` where the
bound is written, and the day someone adds the forty-sixth spawn they are told
by the file that has to survive it rather than by a tail gate two lanes away.

And when such a row refuses, make the refusal name the host or the candidate.
Three separate deliveries read `gate expected exit 0` as a product defect,
because that is what it looks like.
