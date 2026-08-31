---
title: An attestation expiry that ages into a red suite
date: 2026-08-31
category: harness
module: delivery-harness-kernel
problem_type: latent_defect
component: testing
resolution_type: test_correction
applies_when:
  - "A suite mixes tests that inject a clock with tests that spawn a binary reading the wall clock"
  - "A test turns red on a date rather than on a change"
  - "A fixture stands in for the very component whose behavior is under test"
tags: [delivery-harness, attestation, ambient-clock, time-bomb, fixture-versus-real-surface]
---

# An attestation expiry that ages into a red suite

## Problem

`main` went red in the mechanism the M1 shadow gate depends on. Three tests in
`packages/kernel/src/facade/claude-code-integration.scenario.test.ts` failed on
`expect(recorded.emitted).toBe(true)`: `recordProjectionConsumption` returned
`emitted: false`, which means a shadow session produces no gate-record entry at
all.

Two explanations fit the evidence and implied completely different fixes. The
first was a latent defect in the grant-interceptor rework. The second was a
pre-existing defect newly exposed, because the last green commit and the first
red one differ by a **docs-only** diff — a README, three docs pages, a delivery
record, and one new test file. A docs-only diff cannot logically break a
product mechanism, which pointed at test ordering or parallelism.

Both were wrong.

## Diagnosis

The file hard-coded its attestation expiry:

```ts
const EXPIRY = "2026-08-31T12:00:00Z";
```

Every facade call in that file takes an **injected** clock, so that literal was
compared against another literal and stayed valid indefinitely. But the three
failing tests deliberately do not use a fixture for the interceptor — they
spawn the **real** model-external hook binary, and it reads the **ambient**
wall clock.

So the expiry was simultaneously valid to the binding that minted it and
expired to the interceptor that enforced it. Wall-clock crossed the literal
between the green commit and the red one. The interceptor began denying with
`not_admitted` / `attestation_expired`, no consumption observation was written,
and the writer honestly reported `emitted: false`.

The suite turned red on a **date**, not on a change. The docs-only diff was
coincidence, and no ordering or parallelism effect was involved. Three
observations that had made the failure confusing all resolve:

- **The unit passed while the integration failed.**
  `consumption-gate-record.test.ts` writes the interceptor's observation file
  *itself*, as a fixture. It never spawns the hook, never runs admission, and
  never reads any clock — so the expired-attestation condition is unreachable
  inside it by construction.
- **A characterization rig observed the entry emitted at the same red commit.**
  It drove the real product with its own freshly minted attestation rather than
  this file's aged literal. Different attestation, not a contradiction.
- **A full-suite failure had been seen once and had not reproduced.** Before
  the crossing instant the tests passed; after it they failed every time.

## Solution

Derive both ambient-clock expiries from the clock the interceptor actually
reads, so each states the property the test means — *the attestation is valid
at the instant the interceptor reads it* — instead of a literal instant.

```ts
const EXPIRY = instant(Date.now() + 24 * 60 * 60 * 1000);
```

Pushing the literal forward would only re-arm the same failure on a later day.
The packed qualification lane in `scripts/qualify-product.ts` carried the same
pattern one day behind and is fixed the same way.

The injected clocks (`NOW`, `LATER`) stay literal on purpose. They are
deterministic by construction and are what makes the rest of the file
reproducible; only the values compared against wall-clock need deriving.

## The regression pin

One test drives the spawned interceptor with an expiry the binding still mints
under the injected `NOW` but the interceptor sees as already past — the
condition no clock-injected test can reach.

It pins **both** directions in one test, because an interceptor that always
denied and a writer that always emitted would each satisfy one half alone. It
also asserts the denial is *named*, so a denial for a superseded fence or an
ungranted capability cannot pass for this defect.

Mutation testing bounds it. Restoring the literal expiry fails the three
original tests and the pin. Removing the `attestation_expired` denial fails
**the pin and nothing else** in that file, which is what shows it pins this
mechanism rather than something incidental. A comment-only control fails
nothing.

## What generalizes

A fixture that stands in for the component whose behavior is under test cannot
falsify a claim about that component. Here the fixture supplied the
interceptor's *output*, so every property of the interceptor's *decision* —
including which clock it consults — was invisible to it. This is the same
fixture-versus-real-surface gap that let this mechanism ship inert once
already, caught then only by a live host probe.

The narrower lesson: a literal instant in a test is safe only while every
comparison against it is also injected. The moment one real binary enters the
path, the literal becomes a scheduled failure, and it will not look like a
scheduled failure — it will look like whatever change happened to land nearest
the crossing instant.
