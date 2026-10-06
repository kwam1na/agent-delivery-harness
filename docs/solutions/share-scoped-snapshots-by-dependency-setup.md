---
title: Share scoped snapshots by dependency setup, not by profile
date: 2026-10-05
---

# Share scoped snapshots by dependency setup, not by profile

V26-2311 came from an adopter preparation that ran a selection guard and six
lint and typecheck checks in 19 minutes against about one minute for the same
commands in a worktree. Each check paid a fresh dependency installation.

**The sharing key was the profile id, and adopters vary profiles for reasons
that do not touch dependencies.** The adopter declared many profiles that
differed only in `mutableOutputs` or `gitContext`, all with the same dependency
command and inputs. With one live snapshot at a time — the bound that keeps
hosted disk from filling — every switch between two such profiles discarded an
installed tree and built an identical one. Interleaved declaration order made
nearly every check a switch.

The fix keys the snapshot by what the installation depends on: the dependency
command, the dependency inputs and the Git context. That widens sharing without
lifting the one-live-snapshot bound. Two things had to move with it:

- **Isolation becomes per check rather than per tree.** The shared tree excludes
  the union of the sharing profiles' outputs from its baseline digest, but each
  check is verified with only its own profile's outputs excluded, after every
  other profile's output paths are removed. A check writing another profile's
  output is still drift, as it was when each profile had its own tree.
- **Order is what makes "once" true under a one-tree bound.** `prepare` runs its
  mechanical checks grouped by setup, so a setup is installed once however the
  checks were declared. Within that, checks run cheapest first by their last
  recorded duration less the setup that attempt ran — otherwise whichever check
  happened to create the tree would carry the install cost forever. The first
  declared check is the exception and always runs first: adopters put a
  selection guard there that must reject a raced selection before any selected
  check runs, and a cost order would have moved it.

`gate` still executes in the order admission requests checks, so interleaved
setups there can still reinstall; nothing in this delivery changed that.

The adopter also saw unchanged checks rerun after an unrelated commit. That was
not missing reuse: passed attempts were already reused on matching input and
profile digests. Its profiles used `gitContext: "full"`, whose profile digest
binds HEAD and the whole tree because such a check can read either. The answer
there is `gitContext: "none"` for file-only checks, not a looser digest.
