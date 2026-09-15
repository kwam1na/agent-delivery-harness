# Classifying an environmental red

Written out of V26-2073. During the 2026-09 wave the full gate never went green:
117 red rows on V26-1510, 116 on V26-1496, 23 files on V26-1485 — and every one
of them was environmental. Four lanes then spent one to two hours each doing the
same manual work, with product steps under three minutes. The measured tails were
228, 167, 71 and 57 minutes. Attribution, not implementation, was the delivery.

## The shape

A suite's exit code answers a different question from the one the gate asks. The
gate wants to know whether *this candidate* is sound; a non-zero exit says only
that *something* failed on *this machine* at *this moment*. On a shared host
those diverge constantly: a per-test bound is wall-clock, so six concurrent
deliveries make a green candidate red without touching a line of its code.

Attribution closes the gap by asking three narrower questions per failing file,
in an order where each answer is cheap and decisive:

1. **Does the candidate's diff touch this file?** If so it is the candidate's,
   and no rerun may argue otherwise. This rung is first because it is the only
   one that cannot be bought with more compute, and because a flaky-looking
   regression in a file you just edited is the failure mode a rerun ladder is
   most likely to talk itself out of.
2. **Does it pass when rerun alone?** Then the failure was contention, not code.
3. **Does the pristine base fail the same file?** Then it is not this delivery's.

What is left — reproduces alone, base passes — is a defect, whatever the
original log's signal said. The signal is read once, from the crowded run that
provoked the contention, so a file that timed out there and then failed alone on
a real assertion still carries `timeout`; forgiving it would forgive exactly the
hang, deadlock or unawaited promise this ladder is most likely to meet. The
signal survives only as evidence text on the row.

## Why it is safe to admit a red

Because every direction the ladder can fail in leaves the row `candidate`:

- a check log it cannot parse names no rows, so the whole check stays candidate;
- a base tree it cannot prepare is `attribution-unavailable`, which exits 1;
- a bounded rerun budget marks everything it did not examine candidate,
  including the base comparison it cannot afford;
- a candidate diff it cannot read disables the touched-file rung, so it
  reclassifies nothing at all.

The asymmetry is the whole design. An attribution that is wrong in the
conservative direction costs one manual rerun; wrong in the other direction it
ships a regression. So the ladder spends its budget on proving innocence and
refuses whenever it runs out.

## What the evidence has to carry

An admitted red must never look like a green one afterwards. The real exit code
and every row, with the evidence that earned its class, travel with the check's
evidence as `check-attribution.json` and reach the delivery record. A reviewer
reading the record six weeks later can see that the gate admitted a non-zero
suite, which rows it forgave, and on what grounds — and can disagree.

## The general rule

When a sensor's signal is dominated by noise, do not tune the sensor and do not
teach operators a ladder. Move the ladder into the sensor, make every uncertain
answer fail closed, and publish what it forgave.
