# Concurrent delivery field notes

Delivery: [V26-2015](https://linear.app/v26-labs/issue/V26-2015), alongside
[V26-2014](https://linear.app/v26-labs/issue/V26-2014) and
[V26-2016](https://linear.app/v26-labs/issue/V26-2016). First recorded
2026-09-10 at 08:55 UTC; earlier observations below were retained during this run.
Finish line: merged changes and ticket closeout. These observations describe
the host and product as exercised; they do not authorize admission or establish
that an inferred cause is a product defect.

| ID | Observed friction and effect | Evidence and attribution | Response, owner, and status |
| --- | --- | --- | --- |
| F1 | Separate producer worktrees did not isolate Python editable-install state. V26-2015 held its full suite and qualification while a sibling investigated. | V26-2016 reported two concurrent baseline suites with the same 7 failures and 4 errors across 335 tests. Its diagnosis identifies shared interpreter `.pth`/finder metadata overwritten by `pip install -e` and isolated children unable to resolve user-site `jsonschema`. This is sibling-reported evidence; V26-2015 independently verified private-environment import resolution. | Existing [V26-1764](https://linear.app/v26-labs/issue/V26-1764) owns the fix and concurrent full-suite proof. V26-2015 created a private `.venv`, installed test dependencies only there, and verified isolated imports. Full validation is pending lane clearance; no duplicate defect filed. |
| F2 | A host turn interruption left both publishing and licensing workers interrupted. Sending ordinary messages did not restart their execution, so the orchestrator initially waited for inactive workers. | Native `list_agents` returned `interrupted` for both workers. Explicit `followup_task` restarted each; both then reported their retained red-test evidence and remaining work. No candidate loss was observed. | Mitigated in this run by reconciling native worker state and explicitly resuming. Host coordination limitation; no harness defect inferred. Retain as an observation on V26-2015 rather than inventing a repair to a runtime this repository does not own. |
| F3 | Three deliveries with observable runtime changes would independently bump versions or rebuild qualification artifacts without coordination. | V26-2014 proposed 0.4.1 while V26-2016 had already selected 0.5.0 for an additive API. Cross-task messages identified the conflict before a duplicate bump. | V26-2016 owns the shared 0.5.0 release boundary after compatible source merges. V26-2014/2015 retain their bounded source changes. Merge order and exact qualification remain pending; coordination is advisory messaging, not a product-enforced lease. |
| F4 | Saving continuation context during implementation refused the dirty candidate. | `save-context --json` returned `candidate_unprepared` and remediation to stage intended changes. The run itself remained open and prior events were retained. | Existing [V26-1845](https://linear.app/v26-labs/issue/V26-1845) retains corroborating evidence from V26-2014 and V26-2015; no duplicate ticket. Expected fail-closed behavior, but it prevents this checkpoint at that dirty stage. V26-2015 retains scratch evidence and will save the context after candidate preparation. No checkpoint success is claimed for the refused call. |
| F5 | Shared `origin/main` movement can invalidate prepared review and records, so parallel implementation still needs a serialized merge tail. | Repository policy uses `baseMovement: stale`; the delivery runbook requires fetch/base confirmation and renewed evidence when stale. At first recording this is a coordination cost, not an observed stale-candidate failure. | V26-2014/2015 will request the prepare-through-merge lane when ready; V26-2016 intends to finish the shared release boundary last. Record actual base movement and any repeated work below when observed. |

## Evidence retention

The active harness run is `run-722c310aa8fba9fb`. The task retains bounded
commands, red/green sensor logs, and producer archive comparisons under its
`v26-2015-evidence` scratch directory. Native task and worker messages are the
source for coordination observations. Tracker evidence links this document;
later outcomes must be appended rather than retrospectively calling pending
proofs successful.

## Subsequent observations and dispositions

2026-09-10 08:57 UTC: confirmed shared ownership with both sibling orchestrators. V26-1764 owns F1; V26-1845 retains F4. No new friction ticket was created. Each task retains its own evidence log and coordinates before introducing any new actionable item. Delivery completion remains pending.

- F4 follow-through: after implementation was committed, `save-context` succeeded. Plain `resume` returned the saved contract and correctly refused evidence reuse with `preparation_missing`. An attempted `resume --json` was a usage refusal; the command emits structured output without that flag. This demonstrates the clean-stage workaround, not dirty-stage recovery. Corroborating result recorded on V26-1845.
- F1 enabling witness: V26-2016 reported two private-environment full suites passing concurrently, 394 tests each with one skip, approximately 230 seconds each. V26-2015 then started its own full suite through its private environment; its outcome remains pending.
- F5 lane agreement: V26-2014 granted V26-2015 the first harness prepare-through-merge lane; V26-2016 confirmed it is not entering that lane yet. No stale preparation has occurred here.

- Producer artifact integration: the full producer suite found the exact-current-product projection mismatch caused by the added inventory rows, plus an old cross-profile payload equality assertion. The current-product sensor remains intact; the equality assertion will explicitly compare profile-filtered inventories. Existing V26-1536 owns this work. All three producer source batches will be qualified together, avoiding repeated live Linear artifact qualification.
- Crossed owner messages: V26-2014 and V26-2016 simultaneously accepted different proposed owners for the consolidated producer merge. V26-2015 sent a single explicit final mapping to both: V26-2016 owns integration/review/merge and the final runtime qualification; V26-2014 lends qualifier execution. Awaiting both acknowledgements. This is observed advisory-message coordination friction, not evidence of a product admission defect.
- Harness preflight found an old preparation test constructing duplicate paths through the newly stricter loader. The test now exercises fingerprint set semantics directly while loader rejection remains separately covered. Targeted preparation/config suites pass 159 tests. This is bounded test adaptation in V26-1346, not an unrelated concurrency failure.

- Ownership disposition: additional delayed messages crossed the first mapping. V26-2015 withdrew its proposal and acknowledged the mapping already accepted by both peers: `producer-owner-1`, V26-2014 owns producer integration/review/merge, V26-2016 supplies signals and final runtime, V26-2015 supplies its source. The coordinator requested acknowledgements of this decision ID rather than another proposal. No producer write depended on an unresolved owner.
- Producer handoff: commits `caa8e7e` and `5a6e97c` cover V26-1536, V26-1644 and V26-1645; V26-2014 received their acceptance context and evidence for the consolidated review. Fresh offline core qualification passed 12 scenarios/102 assertions, provider qualification 11 scenarios/76 assertions. The full 397-test run had two failures and one skip; the profile-comparison failure is fixed, while exact-product qualification remains pending in the consolidated delivery.
