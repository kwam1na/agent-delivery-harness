---
title: Close two product defects that only the packed surface can see
date: 2026-08-31
category: harness
module: delivery-harness-qualification
problem_type: defect
component: tooling
resolution_type: bug_fix
applies_when:
  - "A module the package ships is not reachable through the package's exports entry"
  - "A command emitted at runtime names a path computed from a checkout layout"
  - "A sensor could pass by checking one half of a two-part fact"
tags: [delivery-harness, packed-artifacts, exports, hooks, anti-vacuity]
---

# Close two product defects that only the packed surface can see

## Problem

The product qualification lane reaches the product only through packed
artifacts, and the first time it ran it found two defects that every other
sensor in this repository is blind to by construction. Both were recorded
rather than repaired, because both sat outside that change.

1. **The installer's closure verifier was unreachable through the package's
   single `exports` entry.** `verifyGenerationClosure` exists in the source
   tree and is used internally, and the package's one published entry did not
   re-export it. An adopter installing the published package could not invoke
   the verification the installer exists to offer.

2. **The facade's model-external hook command named a `tsx` path the packed
   composition does not stage.** The command was computed from a checkout
   layout above the kernel module — `<checkout>/node_modules/.bin/tsx` — and a
   composition stages the harness packages, three root files, and no
   `node_modules`. In an installed generation the command named nothing.

Neither is visible from a source import. That is the general shape worth
keeping: **a suite that imports from source cannot qualify a packaged
product, however thorough it is.** The gap is not a coverage gap that more
scenarios would close; it is a gap between two artifacts, and only a sensor
that crosses it can see anything there.

## Solution

### The verifier, published rather than exposed

`packages/kernel/src/index.ts` re-exports `verifyGenerationClosure`. The
`exports` map is untouched: it already publishes the entry, and the verifier
was simply not reaching it. Widening a published surface is a commitment, and
the commitment the verifier needed was one re-export, not a new subpath.

The lane now resolves the installer **through** that map — `createRequire(…)
.resolve("@agent-delivery-harness/kernel")` rather than joining a path into
the package's `src/` — and then calls the verifier against the generation the
installer just installed. A name check would not have established that: an
exported name can resolve to `undefined`, and only a call sees a function.

### The hook command, named the way the composition stages it

The facade resolves the entry against the **generation root** and runs it on
the running Node executable, with no dependency binary in the vector at all.
Node strips the types itself, which is what `erasableSyntaxOnly` in
`tsconfig.base.json` already guaranteed was possible. Adding a runtime
dependency to make the old command work would have been the obvious wrong
turn: this repository ships zero of them, and the emitted command has to hold
to that too.

The flag is also why the floor moved from Node 22 to 22.6. Node rejects
`--experimental-strip-types` outright before 22.6, so on a runtime the old
floor admitted the interceptor would never start: empty stdout, and an exit
code the host does not read as blocking. A deny-until-attested boundary that
does not start fails open.

Moving it in `engines` alone would have been theatre. `engines` is advisory —
npm warns and installs anyway — and the floor this product actually enforces is
the activation preflight, which blocks before the active generation switches.
So `MINIMUM_NODE` in `packages/kernel/src/substrate/preflight.ts` carries a
minor now, not just a major, and the six manifests and the prose floors were
brought along with it. The general shape: when a declared prerequisite and an
enforced one disagree, the enforced one is the product's real answer, and
raising only the declaration leaves the failure exactly where it was.

Executing the emitted command — rather than only reading it — surfaced a third
defect that reading could not. The entry decides it was invoked directly by
comparing its argument vector against its own module URL, and Node resolves
that URL through symlinks. An installation reached through a symlinked path,
which is the default spelling of the temp root on some platforms, produced a
command that passed every staging assertion, started a process, and ran
nothing: no interceptor, no refusal, and a session that looked admitted. The
facade now emits the resolved spelling, and the lane requires the
interceptor's own deny on stdout rather than a clean exit.

## The rule that could have passed while the defect stood

The hazard here is specific and worth naming, because a plausible sensor for
either defect passes while the other half is broken:

- a rule that reads only the **command string** passes a command naming a
  perfectly plausible path the composition never staged;
- a rule that checks only the **staged inventory** passes a generation staging
  the entry while the command points somewhere else.

So the rule resolves the command's own members against the manifest's staged
set — launcher, containment, and staging membership together — and each half
is pinned by its own test. Weakening the membership check to "the inventory is
non-empty" reddens both *fails a command that points elsewhere even though the
entry IS staged* and *fails the correct command when the generation stages the
entry nowhere*; weakening it to "the command names the entry" reddens the
second alone. That asymmetry is why both are kept: the command-string-only
sensor is invisible to the first test, so a suite carrying only that test
would pass it.

The enumerating mechanisms are pinned too, each where it can actually be
falsified. An `exports` resolution that yielded no name, an empty command, and
a generation staging nothing are findings in their own right, above the
membership loops. The required-name set is not: it is a frozen constant no
call site can empty, so a finding for it would be a branch with no reachable
input — the same unfalsifiable shape this note complains about elsewhere. It
is pinned by a test over the constant instead.

## The negative, proven twice

An installed generation missing the staged entry must fail loudly rather than
silently emit an unusable command, and that is two different claims:

- **detectable** — the now-published closure verifier refuses a copy of the
  generation with the entry removed, with `closure_digest_mismatch`; and
- **refused** — a separate installation, corrupted *after* install, refuses to
  bind a workspace at all. The refusal is the delivery's pinned-generation
  trust check: every guarded operation reloads that generation and re-verifies
  its digest closure, so a missing staged file is caught before any command is
  composed.

Both carry their control. The two deliveries bound sessions against the intact
generation, and the corrupted installation registered its delivery
successfully while the entry was still there — so neither refusal is a
mechanism that refuses everything.

Worth recording: the facade's own hook-entry refusal is **unexercised**, and
the comment on it says so. The pinned-generation trust check reaches every
case it would, leaving it a totality fallback for a race after that
verification — a branch nothing here can falsify. It is listed among the
record's known limitations for the same reason: a guard described as
load-bearing when nothing can redden it is exactly the true-sounding sentence
this repository exists to keep out.

## What this does not establish

The packed leg proves the emitted command runs the staged interceptor and
denies an unattested session. No host process reads the composed settings file
and invokes the command through its own hook machinery, so what is established
is that the command an installed generation emits is executable and refuses —
not that this host's hook plumbing invokes it as written.
