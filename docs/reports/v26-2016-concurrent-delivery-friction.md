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
| Node 23.5 triggers Vitest engine warning during install | V26-2014 | Peer host-environment log; installation succeeded here too |
| Scenario inventory changes require fresh checked product projection | V26-2015 / V26-2014 coordination | Existing V26-1536; peer observed, no duplicate issue |
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

### Enabling-fix iteration

The first private-environment pair each ran 394 tests in about 209 seconds.
Import failures disappeared, but three deterministic release/qualification
identity assertions failed in each suite. The implementation had unnecessarily
changed `docs/workflow-graph-v1.md`, which ships in the release. Reverting that
edit restored the unchanged release surface; commit `6fe796b` also replaced an
initial mock-only setup test with real isolated interpreter imports. A final
concurrent pair is running. These three failures are attributed to the
candidate edit, not counted as concurrency failures or product defects.

**Final concurrent witness:** Both candidate worktrees at `6fe796b`, each using
its own `.venv`, passed 394 tests with one skip. Durations were 230.255 and
230.472 seconds; joint wall time was 231 seconds, both exit codes zero. Logs:
`/tmp/v26-1764-final-suite-a.log` and `/tmp/v26-1764-final-suite-b.log`.
Both peer orchestrators were cleared to run full suites in private environments.
Independent review and merge of the enabling slice remain pending.

**Shared pointer proof:** `/tmp/v26-1764-shared-editable-proof.log` records one
environment's `__editable___agent_skills_corpus_0_1_0_finder.py` mapping changing
from `/Users/kwamina/agent-skills-v26-1764/agent_skills` to
`/private/tmp/agent-skills-v26-1764-peer/agent_skills` after the second editable
install. This directly demonstrates the contamination mechanism, while still
not proving it caused every historical intermittent failure. Registry validation
reported zero findings and all 22 registry mutation sensors passed. Fresh core
and linear archives were byte-identical to base builds with matching release
IDs; this enabling change does not require a product reinstallation.

**Review iteration:** Correctness aligned. Adversarial-testing round 1 filed
`V26-1764-AT-1`: the committed test exercised `create_environment`, not the
bootstrap's actual editable installation. Switching the pip executable back to
the shared interpreter, or always creating an environment without pip, survived
the narrow test. The author is adding bootstrap-level behavioral coverage;
the finding remains open until the filing lens confirms closure. This is a
candidate testing defect caught by required review, not a new friction ticket.

**Review fix:** At `eb3418c`, the replacement regression invokes actual
bootstrap twice with local editable-package and dependency-wheel fixtures under
`PIP_NO_INDEX=1`. Adversarial-testing round 2 independently reran the control and
both original mutations, reported alignment, and closed `V26-1764-AT-1` with no
new findings or deferrals. Source reports and selected logs are retained under
`/Users/kwamina/.codex/v26-2016-evidence/1764/`, beyond temporary scratch paths.

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
  development candidate in a disposable consumer. V26-2016 supplies the consolidated
  0.5.0 runtime and owns final installation, including Athena proof.
  V26-2014 owns qualification of the agreed producer/runtime pair.
- **Disposition:** Coordination dependency under observation. This entry does not
  claim a product failure or a completed release.

**Observed coordination race:** Near-simultaneous proposals and acknowledgments
assigned the consolidated producer merge first to V26-2014, then V26-2016, then
back to V26-2014. No producer merge or adopter installation occurred under
the competing assignments. A provisional qualifier had already started before
the pause arrived: its disposable Linear items V26-2030 and V26-2031 were
confirmed cancelled, and its historical evidence was retained. The final
combined candidate still requires fresh qualification.
An explicit final message to both peers settles ownership: V26-2014 integrates,
reviews and merges the combined producer source; V26-2016 supplies signal source
and the final 0.5.0 harness runtime, and owns final harness/Athena installation.
All parties freeze one producer/runtime pair before final qualification. This
is an observed weakness of message-only coordination, not evidence that the
delivery product admitted conflicting operations.

A later delayed V26-2015 proposal attempted another reversal after the two
other roots had acknowledged V26-2014 ownership. The coordinator rejected that
change and named the agreed decision `producer-owner-1`, asking for
acknowledgment only. The named decision retains V26-2014 ownership. This is
concrete message-ordering friction; no new issue was filed by any root.

## F4: Final admission must be serialized across moving bases

- **Observed:** All three orchestrators agreed to coordinate the final
  prepare/review/gate/record/verify/merge tail because repository policy treats
  unrelated base movement as stale. No stale admission has yet occurred here.
- **Impact:** Source work can proceed independently; the final binding and merge
  need an explicit handoff between orchestrators.
- **Disposition:** Expected policy behavior, to be measured during delivery.
  Record actual reopenings, retained evidence and extra sensor cost here if they
  occur; do not infer friction from the policy alone.

## F1 resolution: isolated bootstrap merged

V26-1764 merged in agent-skills PR 67 (`0ff5ee6`). The shared-interpreter
editable-pointer replacement was demonstrated directly. Two private-environment
full suites then passed concurrently (394 tests each, one skip), and the final
review repair passed all 394 tests. This does not retrospectively identify the
cause of the historical intermittent test failure. The actual bootstrap sensor
kills both wrong-interpreter and missing-pip mutations. No follow-up remains.

## F5: Hosted checks cannot start because of billing

Agent-skills PR 67's Ubuntu and Windows jobs failed to start with explicit
billing/spending-limit annotations; macOS was cancelled. Local checks and both
mandated review lenses passed, so the merge used the user's explicit local-check
fallback. V26-2016 owns this billing observation; peers link here rather than
opening duplicate tickets. This is not recorded as a hosted test pass.

## F6: Test fixture resolution and mutation isolation

The MCP wire-test fixture initially lived under the operating system temporary
directory and could not resolve `tsx`. The worker moved the fixture under its
worktree and the real subprocess suite passed. This was fixture setup friction,
not a delivery-product failure. Separately, artifact mutations were kept in a
detached worktree to avoid contaminating other workers' sensor runs; no shared
source mutation or contaminated result occurred. No tracking issue was created.

## F7: A proposed liveness probe counted zombies as surviving work

During V26-1911/1912 implementation, a second post-SIGKILL process-group probe
occasionally classified a killed, reparented zombie as incomplete cleanup. The
native sensor distinguishes absent/zombie processes from live workload. The
extra probe was removed; bounded direct-child waits remain and failures now
produce typed diagnostics with only observed PID liveness. Native POSIX controls
and targeted mutations pass. This implementation finding is resolved within
existing V26-1911/1912, owned by V26-2016; no duplicate follow-up was created.
Windows branches were modeled on macOS and are not claimed as native proof.

## F8: Full-gate coverage found a fixture omitted by focused validation

The first harness source gate ran 3,227 tests: 3,226 passed and the boundary
sensor's clean-fixture row failed because the new host/entry protected class was
not represented in that fixture. Focused entry behavior, typecheck and the live
boundary scan had passed. Repair stays within V26-1402; no new issue is needed.
This demonstrates the additional coverage supplied by the repository gate.

The executor also transcribed that gate's duration incorrectly into one manual
observation (402,000 ms). The timed process result measures 404,747 ms. A separate
journal correction preserves both the mistaken observation and the authoritative
measurement rather than rewriting history. This was an operator transcription
error; it did not affect the fail verdict or authorize admission. Subsequent gate
observations are populated directly from the retained timing JSON.
