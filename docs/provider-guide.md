# Provider guide

A **provider** is the system that conducts a review and attests to its result:
an agent framework, an orchestration tool, a review pipeline. This guide is the
path from a review context to an *accepted* manifest — every rule below is the
implemented behavior of this repository's kernel, exercised by the
[89-vector conformance kit](conformance.md), with the normative text in the
[spec](spec/delivery-evidence-1.md).

## The two surfaces

Both expose the same two operations with the same semantics — the MCP server is
a strict-parity wrapper over the CLI's command core, not a second
implementation:

- **CLI**: `delivery-harness review-context`, then
  `delivery-harness submit-evidence --manifest <path>`.
- **MCP** (`@agent-delivery-harness/mcp`, stdio): tools named `review-context` and
  `submit-evidence` (the latter takes `manifest`, the path to the manifest
  file). Rejections arrive as structured, typed blockers; malformed tool
  arguments are the same usage-error class the CLI reports as exit 2.

An MCP session never sees a waiver prompt. Waivers belong to interactive
humans; a provider's job is to make evidence, not to excuse its absence.

## The lifecycle

```
operator: prepare            (publishes the preparation receipt)
provider: review-context     (what to review; requires a current receipt)
provider: …conduct the review, iterating passes…
provider: write artifacts + manifest into the allocated run root
provider: submit-evidence    (validate, re-capture, publish records)
```

Ordering is mechanical, not conventional: without a current preparation
receipt there is no review context and no submission — and the receipt goes
stale when the candidate moves, the base advances, or a declared wiring file
changes. A provider that hits a stale receipt asks for re-preparation; there is
no bypass.

### 1. Read the review context

`review-context` reports the candidate binding (tree, deliverable identity,
base coordinates), the relevant-change projection (what counts toward
activation after the config classifies out generated files, tests, and
lockfiles), and any sensitive-path matches. Everything your manifest must bind
to is in this context; do not capture your own view of the repository out of
band.

### 2. Run the review — the final-pass discipline

A **run** (one `runId`) may contain many prepare-and-evaluate **passes**. The
contract cares about one thing
([§5.5](spec/delivery-evidence-1.md#55-runhistory), ENV-9): the final
`runHistory` entry must name exactly the candidate's tree and your
`finalPassId`. Evidence about an earlier pass describes a tree that no longer
exists — if anything changed after your last evaluated pass, run another pass.
`telemetry.iterationCount` must equal the number of `runHistory` entries
(RG-9); the validator re-derives it and rejects a mismatch.

### 3. Write artifacts into the run root you were allocated

Run roots are **recorder-allocated, never provider-chosen** (SUB-3): a
directory keyed by `provider.id` and `runId` under the harness's namespace in
the system temp directory, obtained from the kernel's artifacts port
(`createArtifactsPort().allocateRunRoot({ providerId, runId })` — the
getting-started guide's [example provider](getting-started.md#2-a-provider-in-one-file)
shows the call). Both ids are path components and are grammar-checked before
any path join: `runId` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`, 1–128
characters (ENV-2).

Every artifact you declare must sit inside that run root — relative paths
only, no `..` segments, resolved (realpath) locations contained within the
root (ENV-10) — with a `sha256` equal to the file's bytes at submission time
(ENV-11). The manifest file itself must also reside inside the run root
(SUB-3).

**Reviewer approvals** are the one artifact role `review.green/1` requires:
exactly one artifact with role `reviewer-approval` per selected reviewer, whose
content is the JSON stamp of
[§9.2](spec/delivery-evidence-1.md#92-the-reviewer-approval-artifact-role) —
`result: "approved"` with provider, workspace, and candidate values identical
to the envelope's (RG-4). The stamp re-states the binding rather than
referencing it, so each approval is independently interpretable in an audit.
The ten `rg-4-*` conformance vectors enumerate exactly what mismatches look
like.

### 4. Assemble the manifest

The envelope is [§5](spec/delivery-evidence-1.md#5-the-envelope) of the spec;
the payload is [§9](spec/delivery-evidence-1.md#9-payload-reviewgreen1). The
rules a provider most often trips over, as this kernel enforces them:

- **Strict membership** (GEN-1): any member the spec version does not define —
  envelope or payload — rejects the whole manifest with `unknown_member`.
  There is no tolerated extra field; evolution happens by version rev.
- **The candidate must be the recorder's candidate** (SUB-1): at submission
  the recorder re-captures and compares on the enumerated field set — `vcs`,
  `treeSha`, `headSha`, `deliverable.digest`, `deliverable.identity`,
  `base.ref`, `base.tipSha`, `base.mergeBaseSha`, `workspaceId`. Equality is
  exact, including the **raw tree**: identity-based leniency exists only at
  gate time, never at recording time. `headSha` is optional in the envelope,
  but if you declare it, a head that moved under an identical tree is a
  rejection — re-prepare rather than patching the manifest.
- **Prepared state only** (SUB-2): unstaged changes or untracked files at
  submission reject with `candidate_unprepared`.
- **Attestation**: `level: "self"`, `signatures: []`. This kernel rejects
  *any* other level — including the two the spec defines for the future — and
  any non-empty signatures array, both as `unsupported_attestation`
  ([errata note E2](spec-errata.md#e2-env-12-rejects-the-two-defined-non-self-levels)).
- **A green payload means green** (RG-1, RG-6): `verdict: "green"`,
  `finalized: true`, `editedAfterFinalPass: false`; no finding may be
  `blocking`, and every `actionable` finding must be `resolved`,
  `pre_existing`, or `deferred`. Green with unresolved or ignored actionable
  work is a contradiction the validator rejects.
- **The reviewer set must have finished** (RG-2, RG-3): `selected` non-empty
  and unique; `completed` set-equal to `selected` (order is free — the
  `a-completed-order-differs` vector pins that); `failed` and `timedOut`
  empty. A degraded reviewer set is not green.
- **Telemetry is re-derived, not trusted** (RG-8): `findingCounts`,
  `deferredExpansionCount`, and `deferredIssueIds` (sorted, deduplicated) must
  equal what the validator recomputes from `findings`. Do not maintain these
  by hand; derive them from the same data you emit as findings.

### The deferral rules (RG-7)

Deferring a finding is legal only when **all** of these hold:

| Condition | Meaning |
|---|---|
| `actionable: true` | Only actionable work can be deferred. |
| `blocking: false` | A blocking finding can never be deferred. |
| `severity` ∈ {`P2`, `P3`} | **No P0 or P1 may ever be deferred, regardless of scope.** |
| `scope: "expansion"` | Only scope-expansion work defers; in-contract and adjacent findings must be resolved. |
| `deferredIssueId` matches `^[A-Z][A-Z0-9]*-\d+$` | A real tracker reference — `V26-1401`, not `TODO` or a lowercase slug. |

And the converse: `deferredIssueId` must be **absent** on any finding whose
disposition is not `deferred` — an issue id on a resolved finding is
`illegal_deferral` too. The ten `rg-7-*` and three `rg-6-*` reject vectors
walk every edge of this table; run your provider against them before running
it against a real repository.

### 5. Submit, and read rejections the way they are written

Validation is **atomic** (GEN-3) and **complete** (SUB-5): if any rule fails
for any claim, the entire submission is rejected, no record is written, and the
response carries *every* violated rule's code — not the first one. Fix the full
list, not the top line. The stable code registry is
[Appendix D](spec/delivery-evidence-1.md#d-appendix-d--rejection-code-registry);
every code arrives as a typed blocker with a remediation, rendered identically
on the CLI and MCP surfaces.

On acceptance the recorder writes one content-addressed evidence record per
claim into the git-private store, each stamped with the canonical
`manifestDigest` (SUB-4), and reports the record ids.

## Resubmission: the multi-step contract

Two conformance vectors pin what happens when a provider submits twice, and
they are the behavior to build retry logic against:

- **Byte-identical resubmission is idempotent success**
  (`a-idempotent-resubmission`): same manifest, same run root, submitted
  twice — both submissions are accepted and the record ids are identical.
  Retries after a crash or timeout are safe *if you re-submit the same bytes*.
- **Same identity, different content is a conflict** (`sub-4-record-conflict`):
  a record's identity is the digest of (`workspaceId`, gate, obligation,
  candidate binding, `provider.id`, `runId`, `finalPassId`). Submit a
  *different* manifest under that same tuple and the recorder rejects with
  `record_conflict` — an identity that already attested one content can never
  quietly attest another.

The practical rule for providers: a (runId, finalPassId) pair names one
immutable submission. If anything about the run's content changes — another
pass, a different finding set, corrected telemetry — that is a new pass id (and
usually a new `runHistory` entry), not an edit to the old manifest.

## After acceptance: how your evidence ages

The gate judges freshness by **deliverable identity**, not by the raw tree and
never by time: narration-only changes (paths in the config's `reviewNeutral`
set) do not stale your review, while any change to the deliverable does. Base
movement stales evidence. There is nothing a provider can do to refresh stale
evidence except review the new candidate — which is the point.
