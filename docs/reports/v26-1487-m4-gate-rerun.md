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

## The legs, with their actual outcomes

| Leg | Command | Outcome | What it means |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | **green** (46 s) | — |
| Import boundaries | `npm run sensor` | **green** (17 s, 319 files) | — |
| CLI inventory | `npm run sensor:cli` | **green** (17 s, 15 commands) | — |
| Policy projection | `npm run sensor:policy` | **green** (16 s) | The layered policy projection still matches the live delivery authority and the frozen pre-cutover oracle. This is the leg that proves the widened union did not move this repository's compiled posture. |
| Full suite | `DELIVERY_HARNESS_MAX_WORKERS=4 npm run check` | **red** (5,306 s) | 602 failed / 2,287 passed / 92 skipped of 2,981; 50 of 120 files. **Every** failure is a vitest timeout at its boundary to the millisecond (5,000–5,009 ms, 10,00x ms, 30,00x ms, 60,003 ms, 300,010 ms). No assertion failed anywhere, and no failing file is one this change touches. See "Host conditions" — the failing suites are exactly the ones that spawn `git` or the CLI. Confirmed by re-running `packages/kernel/src/admission.test.ts` file-scoped and alone: still red at 5 s per case, and one case passes in **109 s** when given a 120 s budget. |
| Standalone install | `npm run sensor:standalone` | **red** (652 s) | `spawnSync …/node ETIMEDOUT` on the sixth CLI smoke case, and the anti-vacuity rule then correctly refuses the other five: "only 5 of 6 CLI smoke case(s) ran to completion". The same sensor was green on this identical tree before the host degraded. Same cause as the row above. |
| Composition closure and install/update/rollback | `npm run qualify:product` | **red** (178 s) | The first finding is `composition-failed install`: `preflight_failed` — "python: no Python runtime was found; Python >=3.11 is a preflighted prerequisite". This host has `/usr/bin/python3` at **3.9.6** and no `python` on `PATH`. No disposable repository therefore reached merge-ready, and the remaining 12 findings are all anti-vacuity refusals cascading from that: 6 negative probes and 4 lifecycle steps "did not run to [their] expected refusal; an unrun probe is not a passing one". **This is a host prerequisite gap, not a product defect** — and the refusal to score unrun probes as passes is the qualifier behaving correctly. |
| Provider-rail qualification | `npm run qualify:provider -- <out>` | **red** (50 s) | `qualification failed: immutable input provider-rails.ts differs`. The qualifier pins `packages/cli/src/provider-rails.ts` by digest; the tracked file was last changed by **#115 (V26-1848)**, long before this branch, and this delivery does not touch it. The pin is therefore stale against `origin/main` itself and this leg fails identically on the base. It is not this candidate's finding. |
| Release install | `npm run sensor:product-install` | **not rerun** | It requires `--archive` / `--metadata` and performs an agent-skills release install. Cutting or installing an agent-skills release is off limits for this delivery — `.agent-skills/` belongs to another in-flight delivery (V26-2067) — so this leg was not run rather than run and reported. |
| Qualification paths with a tracker **configured** | — | **not runnable here** | Requires a repository that actually binds a tracker adapter with a credential. This repository binds none, and `qualifications/` is off limits to this delivery, so the configured-tracker path cannot be exercised from here. What *is* proven here is the compile-time half: a bound credential-less tracker descriptor compiles to `degraded`, the same descriptor with `credentialId` compiles to `available`, and no tracker at all compiles to `absent` (`packages/kernel/src/policy/compile.test.ts`). |
| Athena shadow / update / rollback parity | — | **not runnable here** | Athena is a separate repository and a separate deployment. Nothing in this checkout can run or observe it. |

## What an activation decision may and may not rest on

- **May**: the typed posture itself. Its three entry conditions, the 3×2 grid
  against `TRACKER_ABSENCE_FALLBACKS`, the distinct refusal messages, and the
  verbatim carriage through `status()` are each pinned by a named test, and the
  policy projection sensor is green.
- **May not**: composition closure, install/update/rollback, the provider rail,
  the configured-tracker qualification path, and Athena parity. Five of the M4
  gate's legs did not produce a pass here — two because this host lacks a
  prerequisite or is degraded, three because they are out of this delivery's
  reach. **Activation anywhere still requires those five legs to be rerun, on a
  host with Python ≥3.11 and without the exec-latency degradation, by whoever
  takes the activation decision.** This page is the record that they have not
  been.

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
