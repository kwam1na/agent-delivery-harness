---
title: Keep live run pages readable as observations change
date: 2026-09-07
category: harness
module: run-browser
problem_type: usability
component: tooling
resolution_type: improvement
applies_when:
  - "A server-rendered operational page needs live updates while an operator reads details"
  - "A structured report needs a readable preview and an exact original source"
tags: [run-browser, live-updates, progressive-disclosure, report-retention]
---

# Keep live run pages readable as observations change

## Problem

A page-wide refresh discards disclosure and focus state. Showing every journal
field and repeating each run's chronology in the inventory makes delivery
progress difficult to follow. Pretty-printing raw review JSON does not establish
an operator-facing reading order.

## Solution

Keep the shared semantic projection unchanged and choose presentation separately:
current work, review outcomes and next actions first; supporting evidence,
provenance, accounting and earlier attempts in disclosures. Show a review once,
carrying its freshness and next step from the current-work projection.

The fixed browser enhancement patches the same server-rendered HTML. Stable keys
preserve existing disclosure nodes. It checks pause, interaction and visibility
both before the fetch and after the response. The second check matters: an
operator can pause while a request is outstanding. A focused attempt moving into
history holds the reading snapshot until focus moves, with an explicit pending
update message. A terminal response stops scheduling requests.

Authorize only the exact fixed script by CSP hash. Reports remain script-free;
executor text is escaped. Friendly-label lookup uses a Map because a valid label
such as `constructor` must remain a string rather than resolve an inherited
object property.

Report previews can be bounded, but the original-source disclosure escapes the
full source directly. Routing that source through the bounded, whitespace-
collapsing display helper would silently truncate it. Exact-byte downloads remain
a separate retention boundary.

## Evidence and prevention

`run-live.test.ts` executes the shipped script against controlled browser I/O to
prove pending-response pause/interaction/hidden-tab handling, positive resume,
terminal polling stop and error recovery. The independent review's guard-removal
and terminal-stop mutations now fail those assertions. Real in-app browser checks
cover native disclosures, keyboard focus, scroll position and narrow layouts.

`run-view-html.test.ts` crosses the 8192-character preview boundary with multiline
source and a trailing sentinel; substituting the preview helper fails. It also
renders accepted prototype-like activity labels and custom report titles. Keep
those tests distinct from exact-download and live/archive semantic parity checks.
