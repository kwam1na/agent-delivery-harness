# Concurrent delivery dogfood: V26-2014

Observed during the September 10, 2026 delivery of V26-2014 alongside V26-2015
and V26-2016. This report records friction, ownership, and outcomes; observations
are not delivery evidence or permission to bypass admission.

| Observation | Evidence and impact | Owner / tracking | Workaround or resolution |
|---|---|---|---|
| Shared Python editable installs cross worktree boundaries | The V26-2016 orchestrator reported two concurrent producer suites with identical 335-test failures (7 failures, 4 errors). Editable-install metadata in shared site-packages names whichever worktree installed last; isolated qualification children also miss user-site dependencies. V26-2014's producer agent was using that shared environment. | Existing V26-1764, owned by V26-2016; peer-reported diagnosis, not an independently reproduced V26-2014 result. | Use a private virtual environment per producer worktree. V26-2014 private environment installation completed in about 3 seconds; 33 targeted tests passed in 15.515 seconds, registry validation and 22 registry mutation sensors passed. The private environment stayed out of Git. Full concurrent-suite proof remains with the owner. |
| Saving a work-stage checkpoint requires a capturable candidate | V26-2014 invoked `save-context` with its contract and `stage: work` while implementation files were unstaged. It refused with `candidate_unprepared`, listing unstaged/untracked changes. The saved-workflow instruction says to save at meaningful stage boundaries, but concurrent shared-tree workers naturally have incomplete edits. | Existing ordinary recovery work V26-1845; reported for contract clarification. | Keep source/evidence and the same open run; save once the intended batch is staged/capturable. No false saved-context success was recorded. |
| Shared generated outputs need explicit ownership across orchestrators | V26-2014 proposed a patch runtime bump; V26-2016 already owned an additive API requiring 0.5.0. Independent installations would churn policy/generation bytes and stale each other's candidates. | V26-2014/V26-2015/V26-2016 coordination; V26-1402 owns version advancement. | Agreed V26-2014/2015 merge compatible source first; V26-2016 owns final 0.5.0 release/installation. V26-2014 separately qualifies its candidate artifacts. |
| Parallel source edits can make intermediate typechecks fail | Docs worker's intermediate typecheck reached another worker's new integrity test before its implementation module existed. This was an in-progress shared-tree state, not a failed final candidate. | V26-2014 orchestration log; no separate defect inferred. | Ownership boundaries and narrow tests during implementation; freeze the whole candidate before the full gate and review. |
| Cross-task direct subagent messaging was unavailable | V26-2016 reported that its app message to the docs subagent was disallowed. Root-to-root messages worked and relayed the proposed shared CLI-doc parser API. | V26-2016 canonical log owner; host limitation observed by peer, no product issue. | Route shared-file/API decisions through orchestrators, retaining the owning task and exact files. |

The delivery uses sibling isolated worktrees for mutation probes. Mutants are
never planted in the shared delivery worktree; this avoids phantom failures in
other workers' controls and keeps the eventual candidate capturable.


Friction deduplication is coordinated root-to-root before issue creation. The
canonical owners are V26-1764/V26-2016 for Python isolation, V26-1845/V26-2014
for the work-stage checkpoint observation, V26-2016 for the host messaging and
release-sequencing logs, and V26-2015 for interrupted-subagent discovery. No new
friction issue has been created by this delivery.

Older ticket descriptions also named superseded implementation details: the
record command now parses retention options rather than checking its first
argument directly, and provider qualification now preserves a historical
experiment separately from current distributed-product qualification. Workers
read current source/tests and adapted their proofs rather than reinstating the
old mechanics. These are intake costs, not new product defects.


The fresh harness `npm install` also emitted `EBADENGINE`: the host Node was
23.5.0, while Vitest 4.1.11 declares Node 20, 22, or 24+. Installation succeeded
and targeted tests ran successfully. The apparent `node@22` Homebrew path also
reported 23.5.0, so it was not claimed as Node 22 validation. This is retained as
host-environment evidence, with no product ticket or false hosted-matrix claim.
