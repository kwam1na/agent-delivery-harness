# V26-1487 — the M4 gate rerun, as it actually ran

The ticket's acceptance criterion is that "the new composition passes the full
M4 gate rerun before activation anywhere". This page records that rerun: every
leg of the M4 gate, what it actually did on this host, and — for each leg that
did not run — the exact reason, named rather than summarised. It is narration:
`harness.config.ts` lists `docs/reports/` under `reviewNeutral`, so nothing
here is part of the reviewed candidate.

**Nothing in this delivery activates anything.** This repository binds no
tracker adapter, so its compiled tracker posture is `absent` both before and
after the change (confirmed by `npm run sensor:policy`, below, which compares
the layered projection against the frozen pre-cutover oracle and stays green).
The rerun is recorded so that the activation decision, whenever it is taken,
is taken against a truthful account of what has and has not been proven.

## Candidate

- branch `kwamina0x00/v26-1487-bundle-and-qualify-the-first-tracker-integration`
- base `origin/main` at `96fccb9`
- the reviewed change is 7 files under `packages/kernel/src/`: the typed
  `TRACKER_POSTURES` closed list and `trackerPostureOf`, the widened
  `tracker_unavailable` rule, the `trackerPosture` member on the managed status
  projection, their tests, and the `index.ts` exports.

## Host conditions during the rerun (2026-09-13/14)

This matters for reading every red row below, so it is stated before them
rather than after.

The machine was swap-thrashing throughout: `sysctl vm.swapusage` reported
**9,106 MB of 10,240 MB swap in use**, with roughly 75 node processes alive
across seven concurrent delivery lanes. Under that condition **process
creation, not computation, is the bottleneck**, and it is slow by three orders
of magnitude. Measured directly, from inside a vitest fork in this worktree,
using the same `execFile` helper the suites use:

| exec | duration inside a vitest fork | the same four execs from a plain node script |
| --- | --- | --- |
| `git init --quiet` | 9,945 ms | 23 ms |
| `git config user.email` | 35,081 ms | 16 ms |
| `git commit --allow-empty` | 49,536 ms | 26 ms |
| `resolveRecordStorage` | 8,625 ms | — |
| total for one test body | **103,189 ms** | 82 ms |

That probe is the whole explanation for the red rows. It was run as a
throwaway test file, read once, and deleted; the worktree is clean.

**The host then recovered, and the missing prerequisite appeared.** Two
conditions changed while this delivery was in review, and both are load-bearing
for the rows below, so the table above is kept as the record of what was
measured and the outcomes are restated against the recovered host. First, the
swap pressure cleared: `npm run sensor:standalone` went from 652 s red to 15 s
green on the same tree. Second, **Python 3.13.15 is now installed on this host**
under `/opt/homebrew/opt/python@3.13/libexec/bin`, which is not on the default
`PATH` and supplies the `python` name the substrate preflight looks for. With
that directory prepended, the legs this page previously recorded as "not
runnable here" run. Rows that changed say so explicitly.

## The legs, with their actual outcomes

| Leg | Command | Outcome | What it means |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | **green** (46 s degraded, 7 s recovered) | — |
| Import boundaries | `npm run sensor` | **green** (17 s / 2 s, 319 files) | — |
| CLI inventory | `npm run sensor:cli` | **green** (17 s / 1 s, 15 commands) | — |
| Policy projection | `npm run sensor:policy` | **green** (16 s / <1 s) | The layered policy projection still matches the live delivery authority and the frozen pre-cutover oracle. This is the leg that proves the widened union did not move this repository's compiled posture. |
| Scoped suites | `npx vitest run <file>`, 18 files | **green** | Every test file the diff touches, plus every test file importing `policy/compile.ts`, `policy/fixtures.ts`, `facade/status.ts`, `facade/managed-delivery.ts` or `index.ts`. 533 s while the host was degraded, 30 s after it recovered. |
| Facade scenario suites | `npx vitest run packages/kernel/src/facade/*.scenario.test.ts` | **green**, once `python` resolves to 3.13 | All six suites pass when run one file per invocation with the homebrew Python 3.13 directory on `PATH`: `walking-skeleton` 7, `checkpoint-recovery` 15, `claude-code-integration` 25, `evidence-admission` 23, `security-lifecycle` 8, `workflow-intake` 7. **This is the row that matters for this delivery**: the assertion added here to `walking-skeleton.scenario.test.ts` — the only row anywhere that reads the tracker posture off a real facade rather than off a composed status fixture — has now actually executed and passed. Both review rounds were conducted while it could not, and the adversarial lens's mutation M11 (the facade substituting a constant) therefore survived every suite it could run; that mutation is now covered by a row that runs. Under the default `PATH`, where `python` is absent and `/usr/bin/python3` is 3.9.6, all six still abort in `beforeAll` with `preflight_failed`. |
| Full suite | `DELIVERY_HARNESS_MAX_WORKERS=4 npm run check` | **red** (1,469,000 ms in the merge tail; 5,306 s in the earlier degraded run) | The tail run on the rebased candidate `4660c2d`: 48 failed / 2,779 passed / 85 skipped of 2,912; 21 of 136 files. Every one of those 21 files was rerun alone with a 120 s timeout: **16 go green alone** (including all six facade scenario suites and both files that had only failed to start a worker at all). The five that still fail alone fail on **subprocess settlement**, and `packages/cli/src/cli.test.ts` was rerun on the untouched base `712d95c` in a separate worktree: **the base fails 8 cases, this candidate fails 7, and the candidate's set is a strict subset of the base's**. No failure anywhere is an assertion about this change, and no failing file is one this change touches. |
| Standalone install | `npm run sensor:standalone` | **red** (652 s) while degraded, **green** (15 s) once the host recovered | While the host was thrashing: `spawnSync …/node ETIMEDOUT` on the sixth CLI smoke case, with the anti-vacuity rule then correctly refusing the other five ("only 5 of 6 CLI smoke case(s) ran to completion"). Rerun unchanged on the same tree after the host recovered: clean, 5 packages, 5 sibling edges, 6 CLI smoke cases, in 15 s instead of 652 s. That 43x is the measurement of the degradation, and it is why the red row above is read as the host rather than the code. |
| Composition closure and install/update/rollback | `npm run qualify:product` | **green** (94 s), with Python 3.13 on `PATH` | Previously red at the first finding — `composition-failed install`: `preflight_failed`, "python: no Python runtime was found; Python >=3.11 is a preflighted prerequisite" — with the remaining 12 findings all anti-vacuity refusals cascading from it. With `python` resolving to 3.13.15 the qualifier reports **zero findings**: 7 negative probes satisfied (`receipt-listed-repository-refusal`, `closure-detects-missing-staged-hook-entry`, `bind-refuses-generation-missing-staged-hook-entry`, `qualification-flag-required`, `qualification-flag-refused-on-production`, `revoked-generation-fences-live-work`, `revoked-rollback-target-rejected`) and 4 lifecycle steps proven (`update-1`, `update-2`, `resume-through-pinned-generation`, `rollback-to-retained-generation`). The earlier red was a host prerequisite gap and is now shown to have been exactly that. |
| Provider-rail qualification | `npm run qualify:provider -- <out>` | **red** (50 s) | `qualification failed: immutable input provider-rails.ts differs`. The qualifier pins `packages/cli/src/provider-rails.ts` by digest; the tracked file was last changed by **#115 (V26-1848)**, long before this branch, and this delivery does not touch it. The pin is therefore stale against `origin/main` itself and this leg fails identically on the base. It is not this candidate's finding. |
| Release install | `npm run sensor:product-install` | **not rerun** | It requires `--archive` / `--metadata` and performs an agent-skills release install. Cutting or installing an agent-skills release is off limits for this delivery — `.agent-skills/` belongs to another in-flight delivery (V26-2067) — so this leg was not run rather than run and reported. |
| Qualification paths with a tracker **configured** | — | **not runnable here** | Requires a repository that actually binds a tracker adapter with a credential. This repository binds none, and `qualifications/` is off limits to this delivery, so the configured-tracker path cannot be exercised from here. What *is* proven here is the compile-time half: a bound credential-less tracker descriptor compiles to `degraded`, the same descriptor with `credentialId` compiles to `available`, and no tracker at all compiles to `absent` (`packages/kernel/src/policy/compile.test.ts`). |
| Athena shadow / update / rollback parity | — | **not runnable here** | Athena is a separate repository and a separate deployment. Nothing in this checkout can run or observe it. |

## What an activation decision may and may not rest on

- **May**: the typed posture itself. Its three entry conditions, the 3x2 grid
  against `TRACKER_ABSENCE_FALLBACKS`, the distinct refusal messages, and the
  carriage through `status()` — now including one row on a **real facade**,
  executed — are each pinned by a named test, and the policy projection sensor
  is green.
- **May**: composition closure and install/update/rollback. `qualify:product`
  is green on this candidate with zero findings. This leg moved from "not
  provable here" to proven while the delivery was in flight, because the
  missing prerequisite was installed; it is recorded as proven, with the
  condition (Python >=3.11 on `PATH`) named.
- **May not**: the provider rail, the configured-tracker qualification path,
  and Athena parity. Three of the M4 gate's legs still did not produce a pass
  here — one because the qualifier's digest pin is stale against `origin/main`
  itself, two because they are out of this delivery's reach. **Activation
  anywhere still requires those three legs to be rerun by whoever takes the
  activation decision**, and the provider-rail pin refreshed by whoever owns
  it. This page is the record that they have not been.
- **A note on what changed under this delivery's feet.** Two legs on this page
  were red for host reasons and are now green, and the page was amended rather
  than rewritten so that both states stay visible. An activation decision that
  reads only a summary would not see that the facade row proving the posture
  reaches callers went unexecuted through both review rounds; it is stated here
  because that is the kind of fact a later reader needs and cannot recover.

## The two spellings of "available"

Recorded here because it will otherwise be read as an inconsistency. The
compiler's `TRACKER_POSTURES` and the released neutral capability contract
(`.agent-skills/current/skills/deliver-work/references/capability-contract.md`,
`absent` / `available` / `configured` / `blocked`) both use the word
`available`, with opposite polarity: the contract's means "exists but is not
configured for use", the compiler's means "bound and able to operate". They are
different subjects — a capability at call time versus the bound adapter set at
compile time — neither is derived from the other, and the released contract is
digest-pinned and installed, so it is not renamed from here. The compiled
posture's doc comment says the same thing at the definition site.
