# Concurrent delivery friction: V26-2016

This running log records the V26-2016 delivery alongside V26-2014 and V26-2015.
Observations are not admission evidence. Each entry distinguishes an observed
failure from an inference and records its disposition before closeout.

## Shared ownership and deduplication

Before opening a friction issue, the three orchestrators exchange the failure
and intended outcome, check existing tickets, and agree one canonical owner.
Each epic may retain its own observations, but links to that same ticket.

| Finding | Canonical owner | Canonical tracking |
| --- | --- | --- |
| Producer interpreter/dependency isolation | V26-2016 | V26-1764 |
| Direct reply to sibling subagent rejected | V26-2016 | F2 here; host feedback, no issue |
| Interrupted subagents require explicit discovery/resume | V26-2015 | `docs/reports/v26-2015-concurrent-delivery-friction.md` |
| `save-context` refuses a dirty implementation candidate | V26-2014 | V26-1845; independently observed by V26-2015 too |
| Shared release/install and final merge sequence | V26-2016 | F3/F4 here; no defect established |

Peer confirmation and any later canonical issue links are recorded here before
new tracking is created. No new friction issue has been created by V26-2016.

Peer logs: `docs/reports/v26-2014-concurrent-dogfood.md` and
`docs/reports/v26-2015-concurrent-delivery-friction.md` in their respective
delivery branches, to become available on merge. The dirty-checkpoint finding
was attached to existing V26-1845 before this delivery learned about it; that
existing issue remains canonical, not a new duplicate here.

## F1: Producer test environments cross worktree boundaries

- **Observed:** Two fresh producer worktrees at `b206327` ran full suites
  concurrently with the shared Python interpreter. Each ran 335 tests in about
  143 seconds and failed with 7 failures and 4 errors. Isolated qualification
  subprocesses could not import the user-site schema dependency.
- **Investigation:** The producer's editable installation uses one site-packages
  pointer per interpreter. Installing sibling worktrees into that interpreter
  replaces the pointer. This is a separate mechanism from the directly observed
  missing dependency; the actual cross-worktree import regression is being
  verified before claiming it caused the historical intermittent failure.
- **Impact:** All three orchestrators held broader producer validation while the
  enabling investigation ran. V26-2016 held dependent implementation as required
  by the epic's explicit ordering.
- **Workaround under validation:** Private `.venv` per worktree, including the
  editable source and test dependencies. Both isolated full suites must pass
  concurrently before the enabling slice is accepted.
- **Tracking:** V26-1764, existing child of V26-2016. In progress; no new deferral.
- **Evidence:** `/tmp/v26-1764-suite-a.log`, `/tmp/v26-1764-suite-b.log` and the
  corresponding private-suite logs; preserve a bounded evidence report before
  scratch cleanup.

## F2: Cross-task messages cannot reply directly to another task's subagent

- **Observed:** A V26-2014 subagent sent a helper-API coordination message with
  source task `01a08a79-7cdc-77e3-b133-0e6fa81c062e`. Replying with the app's
  `send_message_to_thread` returned `direct app-server input is not allowed for
  multi-agent v2 sub-agents`.
- **Impact:** A direct-looking source identifier was not a usable reply target.
- **Workaround:** Route coordination through the owning V26-2014 orchestrator,
  task `01a08a77-5ec9-7a42-ac9a-25350d9d61fb`.
- **Disposition:** Host-tool boundary, not a reproduced delivery-product defect.
  Retain here as dogfood feedback; no product workaround or tracking ticket yet.

## F3: Independent epics converge on one release and installed generation

- **Observed:** V26-2014's CLI/tree fixes, V26-2015's config refusals, and
  V26-2016's new kernel export all require a release boundary. The first release
  proposal was a 0.4.1 patch; V26-1402 explicitly requires a minor version.
- **Impact:** Independent version bumps and installations would overlap despite
  mostly disjoint source edits. No conflicting installation has been performed.
- **Decision:** V26-2014 and V26-2015 merge source first; V26-2014 qualifies its
  development candidate in a disposable consumer. V26-2016 owns the consolidated
  0.5.0 runtime, final qualification and installation, including Athena proof.
- **Disposition:** Coordination dependency under observation. This entry does not
  claim a product failure or a completed release.

## F4: Final admission must be serialized across moving bases

- **Observed:** All three orchestrators agreed to coordinate the final
  prepare/review/gate/record/verify/merge tail because repository policy treats
  unrelated base movement as stale. No stale admission has yet occurred here.
- **Impact:** Source work can proceed independently; the final binding and merge
  need an explicit handoff between orchestrators.
- **Disposition:** Expected policy behavior, to be measured during delivery.
  Record actual reopenings, retained evidence and extra sensor cost here if they
  occur; do not infer friction from the policy alone.
