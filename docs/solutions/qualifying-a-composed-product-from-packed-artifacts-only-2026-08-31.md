---
title: Qualify a composed product from packed artifacts only, in disposable repositories
date: 2026-08-31
category: harness
module: delivery-harness-qualification
problem_type: architecture_pattern
component: tooling
resolution_type: tooling_addition
applies_when:
  - "A release gate must prove the thing adopters install, not the thing the repository builds from"
  - "One product release has to serve two repositories with different policies"
  - "A qualification record risks claiming more coverage than its sensors establish"
tags: [delivery-harness, qualification, packed-artifacts, disposable-repository, anti-vacuity]
---

# Qualify a composed product from packed artifacts only, in disposable repositories

## Problem

The facade scenario suites already drive a disposable repository from an
accepted contract to merge-ready, with the hostile matrix the plan names. They
are the right sensors and they run on every CI leg. But every one of them
imports the product out of `packages/` — the candidate's own source.

That is the correct dependency for a unit sensor and the wrong one for a
release gate, because it proves nothing about the thing an adopter installs. A
module unreachable through the package `exports` map, a file the manifest's
`files` list drops, a path computed from a checkout layout that does not
survive packing: each passes every scenario suite and fails the first adopter.

The release claim that has no in-process form at all is the one about a
**second** repository: one product release, two repositories, two different
policies, no forked workflows.

## Solution

`scripts/qualify-product.ts` never imports the product. It reaches it twice,
both times through an artifact.

1. **The publishable tarballs.** All five workspace packages are `npm pack`ed
   and installed into one isolated tree outside the repository. That tree
   supplies the *installer* — the operator-facing lifecycle an adopter runs
   before any delivery exists.
2. **The installed generation root.** The installer packs and installs a
   composition generation, and the *product* that drives the deliveries is
   imported from inside that read-only, digest-addressed root.

Two disposable repositories are then built from genuinely different gate
configurations — different gate id, identity token, review-neutral set,
record-neutral set, delivery-record location, source layout, test
classification, contracted outcome, and intake lane — and each is driven through
the frozen checkpoint path to merge-ready by one installed generation. One hands
over an already-scoped contract; the other hands over an outcome-only work
request and is scoped by a product-owned turn first.

The lane also carries the refusals the release cannot pass without: the
receipt-listed-repository refusal, both temporal directions of the
qualification-flag rule, revocation fencing a live delivery into
`security_blocked`, and a revoked generation refused as a rollback target. Then
two contract-changing updates, the original pinned generation still loading,
and an offline rollback to a retained one.

## Making "packed artifacts only" a claim rather than a comment

The module path the driver imports is one the driver constructed, so asserting
it is inside the generation root proves nothing. What proves something is
binding the loaded *bytes* to the manifest: the installed
`composition-manifest.json` must hash to the addressed generation digest, the
kernel entry must be one of its inventory members, and that file's bytes must
re-hash to the inventory's recorded sha256.

Doing that surfaced the first real packed-surface finding. The installer's own
closure verifier is **not reachable through the package's single `exports`
entry**, and reaching around the exports map for it would have been exactly the
source-shaped dependency the lane exists to avoid. So the closure is re-derived
from the three published primitives instead — which is what an adopter auditing
an installation actually has. Recorded, not repaired.

The second finding is the same shape. The facade computes its model-external
hook command from a path relative to the kernel module, which resolves inside a
checkout and does not resolve inside a generation root: the packed composition
stages the harness packages and three root files and no `node_modules`, so the
`tsx` binary that command names is absent. The packed leg never launches a host
session, so both deliveries complete regardless — but a live host lane driven
from a packed install would need that path resolved first.

## The rules are pure so they can be falsified cheaply

Five npm packs, five composition packs and two full deliveries is the wrong
place to check whether a rule works. Every judgement the lane makes is
therefore a pure function over what was observed, and
`scripts/qualify-product.test.ts` drives each one to **both** verdicts in about
a second.

Both directions, every time. A deny-only assertion is satisfied by a mechanism
that denies everything: `forbiddenProcessFinding` reporting `claude` proves
nothing unless it also reports nothing for `git rev-parse`. The suite carries
that control, and it is the assertion that catches the always-report mutation.

**A pure function nobody calls decides nothing.** The rules being falsified is
not the same as the rules being *reached*: detaching them from the lane would
leave a run that drove zero repositories reporting `clean`. So they are applied
at the lane's single exit rather than as a step near the end, every early
return goes through that exit, and the suite drives the lane for real on an
input that cannot get past its first step and requires the vacuity findings
back. Review found this by deleting the call sites and watching everything stay
green; the exit test was written from that mutation.

**Name the lane, not the run.** The instrumentation control was originally one
counter shared by both repositories — which is the absence-assertion trap in
miniature. If one lane stopped routing through the injected port, the other
lane's processes kept the total non-zero and the general claim "both lanes were
instrumented" passed over an empty observation. The inventory is now per
repository and the finding names the lane.

The declared sets are pinned too, not just iterated. The lane's central claim
quantifies over "every disposable repository" and "every required negative
probe", and a general claim above an empty set passes for free — so the sets'
size and mutual difference are asserted, which is what catches two repository
specifications quietly converging into one repository driven twice.

## Two things the record had to stop claiming

Review caught both, and neither was repaired by strengthening the mechanism —
they were repaired by narrowing the claim to what the mechanism shows.

**"Distinct compiled policies" was neither.** The number the lane counts is the
digest of each repository's tracked gate configuration, and the product's
compiled repository policy for a disposable repository is a *fixed* document
parameterized only by repository id and charter digests. Two disposable
repositories therefore compile near-identical policy whatever their owners do.
What an adopter actually controls at this layer — and what "a second repository
changes policy" means here — is the gate configuration, so that is what the
field is now called and what the record now says.

**"The fixture leg proves what the packed leg cannot reach" was false.**
Iterative scoping is an ordinary exported facade surface on the same module the
packed leg already loads; the packed leg had simply chosen the already-scoped
entry. Rather than keep the excuse, the second repository now hands over an
outcome-only work request and is scoped through `openIntake` →
`recordClarification` → `recordDraft` → `presentDraft`, converging on the same
single operator confirmation. The fixture leg's own statement now says its
contents are there by scope, not by unreachability.

## Why This Matters

`sensor:standalone` proves each tarball can be installed and imported. This
proves the thing you get by installing them *delivers*. The gap between those
two is where every packaging defect lives, and both findings above were sitting
in it.

## Prevention

- The record's observed sets are asserted equal to the driver's declared
  required sets, so adding a required probe without re-running the lane leaves
  a red suite rather than a record describing a weaker gate.
- Every sensor the record names is resolved on disk.
- The `notProvenHere` and `knownLimitations` sections are required to be
  non-empty: an emptied list reads as broader coverage while proving strictly
  less.
- The claimed process inventory must be non-empty *and* exclude every forbidden
  runtime — an empty inventory would satisfy "no agent runtime" vacuously.

## Examples

```bash
npm run qualify:product                          # the full packed lane; also a release-workflow step
npx vitest run scripts/qualify-product.test.ts   # the rules, falsified both ways
npx vitest run scripts/check-product-qualification.test.ts
```

## Related

- `qualifications/product-qualification.json` — the record and its honest limits
- `scripts/check-standalone-install.ts` — the leg that proves a tarball installs
- `qualifications/walking-skeleton-m0.json` — the two-leg record format this follows
