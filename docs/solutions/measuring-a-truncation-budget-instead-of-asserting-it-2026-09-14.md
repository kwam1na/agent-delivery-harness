---
title: Measure a truncation budget instead of asserting it
date: 2026-09-14
category: harness
module: cli-verify
problem_type: correctness
component: tooling
resolution_type: improvement
applies_when:
  - "A rendered message is assembled from parts and then cut at a fixed character cap"
  - "A comment or note states how much of that message survives the cut"
tags: [truncation, blockers, comments-as-evidence, characterization]
---

# Measure a truncation budget instead of asserting it

## Problem

`renderBlockers` caps a blocker's `details` at 600 characters. `runJournalBlocker`
in `packages/cli/src/commands/verify.ts` composes that detail from a status, a
violations list, a `missing:` list, an admission sentence, and one bounded reason
per warning. Which segment falls off the end is a function of three things at
once: the order of the segments, the `oneLine` bound applied to each reason, and
the length of the run id the store happens to mint.

Across three consecutive review rounds on V26-2059, the same defect class was
raised each time: the comment above the template stated a budget figure — how
long the rendered detail is, which bound is binding, where the cut lands — that
had been reasoned about rather than measured. Each figure was wrong in a
different way, and each was wrong invisibly, because the thing it described was
prose, not an assertion. A round-2 reordering silently made `missing:` the
casualty of the cap while the blocker's own remediation still told the operator
to emit the events that list names.

## Solution

Two rules, both cheap.

1. **A number in a comment about rendered output is a measurement or it is not
   written.** Drive the real code path (not a shortened stand-in for one of its
   inputs) at each bound you want to talk about, print the resulting length, and
   write down what you measured together with its slack — including the point
   above which the value saturates because a longer bound stops binding.
2. **Anything the comment claims is load-bearing gets an assertion.** The
   surviving segments are pinned by `toContain` on the rendered stderr, and the
   run id's length is pinned directly (`expect(runId).toHaveLength(20)`), so the
   one-character margin the layout depends on fails a test rather than a reading
   when the store's id width changes.

A comment that says "this is why the order is what it is" is worth keeping. A
comment that says "this renders in N characters" is a test that was written in
the wrong file.
