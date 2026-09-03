# The delivery record — `delivery-record/1`

The tracked delivery record is how an admitted gate becomes visible outside the
workspace that ran it: to a reviewer reading the pull request, and to the
[GitHub Action](../packages/action/action.yml) verifying it from a different
machine. This note says precisely what it is, what it proves, and — just as
deliberately — what it does not.

## Status: a product-layer artifact, outside the spec

The record is **not** part of
[`delivery-evidence/1`](spec/delivery-evidence-1.md). The spec governs
manifests and the per-claim evidence records the recorder derives from them;
those live git-private, under the config's `storageNamespace` inside `.git/`,
scoped to one worktree by construction. The delivery record is a projection of
an admitted gate *decision* over that evidence — a product-layer artifact with
its own version token, `delivery-record/1`, versioned and evolved
independently of the evidence spec. Nothing in it is gate-time evidence: the
gate evaluator reads only the git-private store, never the tracked record, so
committing a record grants nothing at the next gate run.

## Shape

The file is canonical JSON (RFC 8785, one trailing newline), so re-recording
the same candidate is byte-identical — a no-op diff, not churn:

| Member | What it carries |
|---|---|
| `version` | The literal `"delivery-record/1"`. Any other value is a malformed record. |
| `gateId` | The gate that admitted. Verification rejects a record for a different gate. |
| `identityToken` | The identity function the digest below was computed under. |
| `candidateBinding` | `treeSha`, `deliverableDigest`, `identityToken`, `baseRef`, `baseTipSha`, `mergeBaseSha`, `workspaceId` — the exact candidate the gate admitted. |
| `claims` | One entry per obligation: its resolution outcome (never `blocked`) plus the provider/run/record coordinates that resolved it. |
| `manifestDigest` | The single manifest digest backing the evidence claims, or `null` when there is not exactly one. |
| `workspaceId` | Recorded for audit — and deliberately **excluded** from verification: CI verifies from a different workspace by construction, so binding on it would fail every real PR. |
| `attestation.level` | `"self"` — the only level v1 produces or verifies. |

A claim outcome must be one of the evaluator's six resolution kinds. The
parser rejects anything else: a committed file is editable, and an invented
outcome (`rubber_stamped`) must read as a malformed record, not verify clean.

## The both-neutral-sets requirement

`config.deliveryRecordPath` must satisfy **both** neutral predicates, and the
config loader refuses to load a config where it does not. This is load-bearing
twice over:

- **Review-neutral**, so writing the record does not change the deliverable
  identity it attests. A record path outside the review-neutral set would
  deadlock the loop: the write moves the identity, the freshly written record
  instantly describes a candidate that no longer exists, and `verify` can never
  pass. (The suite proves this end to end: the self-neutrality test captures
  the identity before and after `record` and requires byte-equality, with a
  non-neutral path as the failing negative control.)
- **Record-neutral**, so no candidate binding is ever bound to the presence or
  content of a record file. A candidate must not change meaning because its own
  attestation landed next to it.

The written filename is candidate-keyed — the deliverable digest is spliced
into `deliveryRecordPath` before its extension (`record.json` →
`record--<digest>.json`) — which is what makes parallel branches
merge-conflict-free (different deliverable, different file) while keeping the
lookup exactly recomputable: `verify` locally and the Action in CI both derive
the same path from the identity they just recomputed.

## What L0 attestation honestly claims

Every verification summary — CLI and Action alike — carries the label
verbatim:

> self / workspace-scoped — process discipline and freshness, not provenance

That sentence is the contract. A verified record proves that a gate ran
against exactly this deliverable identity, that every declared obligation is
covered by an admitting outcome, and that the evidence had not gone stale when
the gate admitted. It does **not** prove *who* ran the gate, and it is not a
signature — the manifest author and the delivering orchestrator are the same
party at level `self`
([spec §11.1](spec/delivery-evidence-1.md#111-threat-model-by-level)).
Deployments whose threat model includes a fabricating orchestrator need the
signed levels, which arrive with a future signing profile, not with v1.

## The `baseMovement` policy

`config.deliveryRecordVerification.baseMovement` decides what happens when the
base moved after the record was written — `baseRef` changed, the base tip
advanced, or the merge base moved:

- **`"stale"`** (the default): base movement fails verification with the named
  drift class. The record described a delivery against a base that no longer
  exists; re-run the loop against the new base.
- **`"allow"`**: base movement passes, and the check output **names the
  relaxation and the drift classes it covered** — a relaxed pass never looks
  like a clean one.

Two properties keep the policy honest. Exactly one decision path consults it —
the pure `verifyDeliveryRecord` core that the CLI `verify` command and the
Action share; surfaces like `check` and the Action summary *display* the
setting but decide nothing by it — so the local gate can never be more
permissive than CI or vice versa. And the gate evaluator never reads it at all: a base-drift obligation
blocks identically under either policy. The policy governs *record
verification*, never *gate admission*. Deliverable-identity mismatch is never
relaxed under any policy.

## Lifecycle

1. `delivery-harness gate` admits.
2. `delivery-harness record` re-runs the gate, refuses unless it admitted,
   re-captures the candidate adjacent to the write (an identity that moved
   between gate and write is a refusal, not a stale record), and writes the
   canonical bytes through the filesystem port.
3. You commit the record; it rides in the pull request. The commit itself does
   not disturb the identity — that is the review-neutrality above.
4. `delivery-harness verify` locally, and the Action on the PR head, recompute
   the deliverable identity and check the record keyed to it: version, gate,
   attestation level, identity token, identity equality, base movement per
   policy, no blocked claim, every configured obligation covered, and no
   delivery-owned path in the candidate tree.

## A deferral with no follow-up item never reaches a record

A green review may defer expansion work rather than repair it, and the harness
requires each deferral to name the tracker item carrying the deferred work. It
enforces that at `submit-evidence` rather than at `record`: `RG-7` refuses a
`review.green/1` claim whose deferred finding names no `deferredIssueId`, or
names one that is not shaped like a tracker item identifier (`V26-1583`, not
`TODO` and not a lowercase slug). The refusal is presence and shape only —
whether the named item exists, is open, or says anything useful is never asked,
because a local fail-closed gate that consulted a tracker would be a gate a
tracker outage could open.

That placement is what makes the rule reach `record`. A refused manifest
publishes no evidence record, so a record with an untracked deferral behind it
is not something `record` has to detect: there is no accepted review evidence
for the obligation at all, and `record` refuses for want of it. The CLI suite
proves the whole path — missing reference, `TODO`, and a lowercase slug each
refused at submission, the refusal naming the offending finding by its own
index rather than the payload it sat in, no record in the store, `record`
blocked — beside the positive case, where a deferral naming a real item records
and the written record is read back. The deferral is deliberately not the
review's only finding there: every other deferral payload in this repository is
a single finding, so a rule that judged only the first one would pass them all.

`record` deliberately adds no second deferral check of its own. It could only
read a deferral the evidence record carried, and the evidence record is written
by `packages/kernel/src/recorder.ts`, whose exact bytes are pinned by
`qualifications/agent-skills-provider-interoperability.json` and re-checked on
every run by the provider-rail qualification. Carrying a follow-up reference
through to record time therefore costs a re-earned interoperability
qualification at a new harness baseline, and buys a second refusal of a
condition the first one already makes unreachable.

## Delivery-owned paths are never committed

Two path sets belong to the managed delivery, not to the candidate: the
receipted run-pinned workflow projection (`.managed-projection/`) and the
binding-written host discovery configuration (`.claude/`). Inside a run the
compiled execution grant protects them. In the committed tree they are a
protected-authority-path violation, and the verification core rejects a
candidate tree carrying one on the tree's own evidence — no product state
consulted, so a reviewer and a CI job reach the same verdict. Membership is by
path segment: `src/managed-projection-notes.md` merely names one of them.

### The one exception: a tracked Claude skill exposure

A committed entry under `.claude/skills/` is admitted when, and only when, both
of these hold in the committed tree itself:

1. its git mode is `120000` — the entry is a symlink, not a regular file; and
2. its link target, read from the committed blob, resolved relative to the
   entry's own directory and normalized, names something strictly inside
   `.agent-skills/current/skills/`.

That is the exposure the `agent-skills` generation install writes — a different
mechanism from the `.managed-projection/` subtree above, which admits nothing at
all. The skill text lives in the tracked, receipted generation, and the entry
under the host's directory is a pointer into it carrying no authority bytes of
its own. Admitting it lets every adopter track that install the same way.

Both anchors are matched literally, never case-folded, and nothing else moves:
a regular file under `.claude/skills/`, a symlink there resolving anywhere else
(outside that root, above it, through `..`, or to an absolute path), a case
alias of either anchor, the `.claude/skills` prefix committed as a single
symlink, and every entry under `.claude` outside `skills/` —
`.claude/settings.json` and `.claude/hooks/*` among them — all still raise
`record_protected_authority_path`. A verifier that can only enumerate path
names, never modes and targets, judges on the path alone and so admits nothing
either: the exception is reachable only from the tree evidence that decides it.

What the exception decides is the committed shape of the entry — its mode, and
where its own target resolves as a path. It does not follow that path through
any further committed symlink, does not require the target to exist in the
tree, and does not re-check the receipt inside the generation. It cannot:
`.agent-skills/current` is itself a tracked symlink pinning the active,
digest-named generation, so resolving through it would reject the very install
this admits.

What is admitted is therefore a pointer, and the bytes it points at are reviewed
the way every other tracked byte is — in the diff. A committed exposure is read
by a host on checkout with no install step in between, so the generation's own
receipt is not what stops a candidate writing skill text there; the change lands
under `.agent-skills/`, in the pull request, where a reviewer sees it. That is
the trade this exception makes.
