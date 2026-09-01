---
title: Project a repository into the layered policy model when that repository implements the policy compiler
date: 2026-08-31
category: harness
module: delivery-harness-policy
problem_type: architecture_pattern
component: tooling
resolution_type: tooling_addition
applies_when:
  - "A repository plans to hand delivery routing to a policy compiler without changing its live authority yet"
  - "The repository being governed is also the repository that implements the compiler governing it"
  - "A migration milestone must decide which shadow runs are admissible evidence without trusting the agent that produced them"
tags: [delivery-harness, policy-projection, pre-cutover-oracle, shadow-window, self-application]
---

# Project a repository into the layered policy model when that repository implements the policy compiler

## Problem

This repository's delivery authority lives in an aggregate command graph
(`npm run check` and the scripts it chains), the `delivery-harness` gate loop,
and three GitHub workflows. Expressing that authority as a declarative policy
document plus typed executable adapters, while the existing loop is still the
only real authority, carries the two risks the Athena projection already named:
the projection quietly drifts from what the repository runs, and the "truth" the
cutover is judged against gets recharacterized after the fact.

It carries a third risk Athena does not have. **This repository implements the
policy compiler that compiles this repository's policy.** A delivery here can
change the code that judges it, and a projection that did not make the direction
of authority explicit would leave that circularity to be discovered later.

## Solution

The Athena artifacts from V26-1482 are the template and are followed member for
member: `.agents/policy/{repository-policy,adapters,pre-cutover-oracle,compiled-snapshot,comparison-report}.json`
plus `scripts/policy-projection-check.ts`, and
`.agents/policy/{shadow-activation,shadow-milestone-gate-record}.json` plus
`scripts/shadow-discovery-guard.ts`. Only the contents differ, because the
routing differs.

- **The document** grants merge-ready as the only finish line and pr-creation as
  the only authority, forbids merge and deploy, activates the one obligation the
  live gate enforces (`review.green` — deliberately one, not seven), and
  overrides the three checkpoint grants to protect `.agents`, `delivery`,
  `qualifications`, and `packages/conformance/vectors`.
- **Sixteen typed adapters**: nine sensor leaves (test suite, typecheck,
  import boundaries, CLI inventory, conformance kit, standalone install,
  provider-rail qualification, release checks, delivery-record gate), three
  mutation stages (delivery preparation, delivery-record write, conformance-kit
  regeneration), hosted-check observation, and PR creation, merge, and deploy.
  Registering merge and deploy adapters grants nothing: discovery never grants
  authority.
- **The frozen oracle** carries the delivery-loop phase order, the obligation
  activation vector, a per-candidate-class activation vector, the preparation
  and delivery-record blocker vocabularies, seventeen seeded failing candidates,
  the leaf-to-adapter mapping, and the generated-artifact ownership table. Its
  sha256 is pinned inside the sensor.

Two things about the comparison are shaped by this repository specifically.

**Activation is read out of the live workflow.** Athena's per-candidate-class
vector probes its mechanical command selector. This repository has no such
selector — `npm run check` runs the same four things always — but it does have
real changed-path activation in the `paths:` filter of the release-checks
workflow. The sensor parses that list out of the workflow file and replays ten
candidate classes through it, so editing the filter moves the live selection and
the frozen vectors apart. The activation classes are also asserted to
*partition* the sensor leaves exactly, so a sensor cannot fall out of activation
by being left unclassified.

**The compile is performed, not just recorded.** Athena had to record a
snapshot because the compiler lived in another repository. Here it does not, so
the sensor recompiles the document and adapters through
`packages/kernel/src/policy/compile.ts` and requires the recorded snapshot to be
byte-equal to a fresh compile. A compiler change that alters this repository's
compiled policy therefore becomes a visible two-place edit instead of silent
drift.

## The direction of authority under self-application

The circularity is already closed, by rules that exist for other reasons. No new
mechanism was invented for it, and the projection records that finding rather
than adding machinery:

- `checkBoundPolicy` admits only the exact compiled bytes bound at policy-bind
  time. A candidate edit to `.agents/policy/` is a proposal for a future
  owner-approved policy generation, never an input to the current judgement.
- The compiler bytes that produced those compiled bytes come from a pinned,
  digest-addressed composition generation installed read-only outside the
  working tree. The compiler that judges a delivery is never the candidate's
  copy — which is also why the shadow activation records the product commit it
  was packed from.
- The facade applies the same rule to reviewer charters and the trusted sensor,
  reading both from the base ref rather than the candidate tree.

The one place the property does *not* hold is recorded rather than repaired:
`.github/workflows/gate.yml` deliberately runs the Action from the pull
request's own checkout, so a pull request can weaken the gate that verifies it.
That workflow states the trade-off and declines the base-ref pinning mitigation
on purpose, because dogfooding the in-tree Action is its entire point. A
read-only mapping is not entitled to change it; it is adjudicated
`recorded`, non-blocking, and left for the cutover to decide.

Reviewer charters needed one deliberate choice. The document grammar requires a
`personaId` per lens, and identity-only references resolve against charters
shipped in the authenticated composition — which ships none yet. Both lenses
therefore reference repository-owned charters under `delivery/personas/` with
their bytes pinned by `personaDigest`, which is the reference form the compiler
defines for adopter-owned charters and the path convention the facade already
resolves from the trusted pre-run base. `delivery` is protected in every
checkpoint grant, so no model-driven stage can rewrite a charter it is judged
against.

## The shadow window

`scripts/shadow-discovery-guard.ts` holds the four positions Athena's does —
posture, layout neutrality, projection scope, binding-sourced consumption —
plus a fifth this repository needs, and one difference forced by the
repository. Athena pins the bytes of a
vendored discovery layout it actually has. This repository has none, so the
guard pins the digest of the **empty** layout over a declared root set
(`.agent-skills`, `.agents/skills`, `.agents/agents`, `.claude`, `.codex`).
That is a position, not an absence: introducing any tracked ambient discovery
root before the cutover's removal gate moves the digest. The suite proves the
pin can move, by building a scratch repository, hashing it empty, committing one
ambient skill, and hashing it again. `.agents/policy` is deliberately outside
the root set — the projection changes on its own schedule, and a guard that
fired on it is one an operator learns to ignore.

The fifth position is **the pinned product commit must resolve.** The
activation's self-application argument rests on one field naming the trusted
generation the installed compiler was packed from, and review caught that field
holding a fabricated 40-character id — a real abbreviated prefix with an
invented tail, produced by expanding an abbreviation by reasoning instead of
asking git. It reads as correct at a glance and made the pin unverifiable. The
guard now resolves the id rather than eyeballing it. A full commit id is
derived with `git rev-parse`, never extended from an abbreviation.

The M1 measurement record is fail-closed in two additional places. First,
`openPreM1Blockers` must exist and be an empty list before the scorer enumerates
deliveries; a populated three-delivery set cannot hide a missing or unresolved
milestone prerequisite. Second, both the frozen manual baseline and every
shadow entry measure acceptance through the **first merge-ready report after
external verification** of the final candidate. Local preparation-gate proof is
too early; eventual merge and post-report idle are too late. The per-delivery
timestamp window is part of the scored shape, and the blocked/progressing split
must fill it exactly.

Arithmetic agreement alone is insufficient: otherwise a scorer can move the
endpoint, `windowSeconds`, and `progressingSeconds` together and turn a failing
blocked share into a pass. The endpoint evidence now binds one final candidate
SHA across the external-verification receipt and the immutable first-report
record, orders acceptance before verification before report, and requires the
window endpoint to equal the whole-second floor of the report event. For managed
shadow runs, the existing `finish.line.recorded` result digest is the receipt
and the retained host transcript supplies timestamps. Because the journal has
no intrinsic wall-clock timestamp, losing that transcript makes the run
unscorable; no timestamp is inferred and no new authority is introduced.

Re-mining the retained Athena transcripts exposed why the endpoint qualification
matters. PR783 has a qualifying pre-merge report after hosted checks and retains
both interventions before it. PR784 has no post-verification report before
merge. PR782's earlier local report is followed by an operator scope amendment,
and no post-verification report of that final candidate appears before merge.
The frozen baseline therefore records those two exclusions and replaces them
with code PR674 and docs PR679, whose first CLEAN, all-checks-green reports are
uniquely pinned by transcript event timestamp and JSONL-record SHA-256.

The position carries one honest limit. CI checks out at depth 1, where a real
base commit is simply absent, and git cannot distinguish that from a fabricated
id. So the suite drives both branches through an injected resolver plus a
scratch-repository row that exercises real git — including the exact defect
shape, a fabricated tail sharing a real prefix — while live resolution against
the real activation is what the operator-invoked `npm run sensor:shadow`
performs in a full clone. This position is meaningful only because the product
repository *is* this repository; an adopter whose product is a different
repository could not resolve the id locally and would not carry it.

Exclusivity stays non-blocking, for the same reason and with the same rule: both
graded hosts are exclusivity-ungraded, so coexistence is a non-blocking
observation, and an activation claiming a blocking position the grade cannot
deliver is a finding. Both consumers key on the affirmative capable grade rather
than on the absence of the ungraded one.

Characterized against the real product: one disposable shadow install (pack,
install, materialize) run against a scratch clone in a temp directory landed the
projection only in the managed delivery worktree, invisible to git there, with
the repository root and a non-managed worktree untouched and carrying no
consumption marker. Using a clone rather than the real checkout is what kept the
characterization from writing a single byte or git-config entry into the
repository it was characterizing.

## Why This Matters

The oracle format was meant to be the reusable adopter template, and this is the
first test of that claim against a repository whose routing is nothing like
Athena's — different phases, a different activation mechanism, one obligation
instead of seven, and a self-application hazard Athena cannot have. The format
carried across unchanged; only the contents moved. Where the shape had to bend
(the compile performed live, the pinned-empty ambient layout), the reason is
recorded in the adjudications rather than absorbed.

Because the sensors are read-only and `npm run check` is untouched, the
projection can exist, compile, and stay honest for as long as the migration
takes without ever holding delivery authority.

## Prevention

- The pinned oracle digest fails the sensor on any oracle edit, so
  recharacterization cannot happen casually.
- Input digests in the compiled snapshot and comparison report fail the sensor
  when the document or adapters change without recompilation, and the live
  recompile fails it when the compiler's output moves.
- The check-aggregate ownership rule matches whole script names, so
  `npm run sensor` is not confused with `npm run sensor:cli`; the suite carries
  the over-reach row that would have caught the prefix bug.
- An incomplete comparison set is an observation rather than a silent pass, and
  an absent requirement counts as incomplete rather than as an
  already-complete empty set.
- The pinned product commit is resolved rather than eyeballed, so a full object
  id that was expanded from an abbreviation instead of derived with
  `git rev-parse` fails the guard.

## Examples

```bash
npm run sensor:policy    # read-only; exits non-zero on any comparison finding
npm run sensor:shadow    # read-only; exits non-zero on any guard finding
npx vitest run scripts/policy-projection-check.test.ts scripts/shadow-discovery-guard.test.ts
```

## Related

- `.agents/policy/comparison-report.json` — the recorded adjudications
- `harness.config.ts` — the live gate the projection is compared against
- Athena `docs/solutions/harness/layered-policy-projection-read-only-comparison-2026-08-30.md`
  — the template this follows
