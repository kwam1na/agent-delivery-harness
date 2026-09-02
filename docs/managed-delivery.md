# The managed delivery product

The [getting-started guide](getting-started.md) walks the **gate**: a config
file, a CLI loop, a tracked delivery record, and a pull-request check. That gate
is still exactly what it was, and it is still the thing that refuses a merge.

This page describes the larger thing the gate now sits inside — the **managed
delivery product**: a facade an agent host drives a whole delivery through, a
durable journal it can be resumed from, a compiled policy that says what each
stage may do, and a host binding that enforces that policy from outside the
model's reach.

The two are not alternatives. The managed product runs the same admission
kernel, produces the same `delivery-evidence/1` evidence, and finishes at the
same tracked record the Action verifies. What it adds is everything around the
evidence: who may do what, at which stage, with what authorization, and what
happens when the host dies mid-delivery.

## What it does not do

Stated first, because the boundary is the design:

> The facade never launches a coding agent, schedules a subagent, creates or
> deletes a worktree, or advances a checkpoint from a host-activity observation.

Those are the host's acts. The product is a library and a decision surface: it
records, validates, reduces, and refuses. It does not orchestrate, and it does
not spawn a subordinate runtime. The host owns delegation and sequencing; the
product owns what counts.

The header of
[`packages/kernel/src/facade/managed-delivery.ts`](../packages/kernel/src/facade/managed-delivery.ts)
carries that sentence as a standing claim, and the surface invariants below are
what keep it from decaying into a comment nobody rechecks.

## The operator journey

```
scope ──▶ confirm contract ──▶ bind workspace ──▶ stages ──▶ review ──▶ admit ──▶ record ──▶ merge-ready
         (operator, off-channel)                                                              │
                                                                                              ▼
                                                                                    the operator merges
```

**Scope.** An intake runs under a read-only grant — `Read`, `Glob`, `Grep`, and
no writable path at all — and drafts a delivery contract. Clarifications and
drafts are retained in an intake journal that is separate from the delivery
journal, because no delivery exists yet.

**Confirm.** The drafted contract is presented for exactly one operator
confirmation. A qualified host must own the opaque, model-inaccessible producer
that presents the bound challenge before registration and receives its echo. A
static adapter normalizes that result for the kernel, which alone evaluates and
consumes it. The product has no qualified production producer today, so current
hosts remain at tier 0 and production registration fails closed.

**Deliver.** The host binds a worktree, which mints the delivery's invocation
fence, and the delivery proceeds through typed checkpoints — workflow stages,
repository sensors, review attempts and their reduction, admission, and the
tracked record. Every one of those writes a journal entry and advances a
revision.

**Merge-ready is the finish line.** The product stops there. Authority beyond it
is modelled and never exercised: the external action port
([`packages/kernel/src/finish-line/merge-ready.ts`](../packages/kernel/src/finish-line/merge-ready.ts))
ships unbound and refuses every intent, so pull-request creation, merge, and
deploy are unreachable from the product. A human merges.

**Resume is a takeover, never a reattachment.** On the graded proving host, a
graceful session end reports `paused` honestly, and picking the delivery back up
means an operator-authorized takeover into a *fresh* host-created worktree
reconstructed from the last trusted commit. The takeover confirmation binds the
superseded fence, the expected journal revision, and the target base commit, and
consumption rejects on any mismatch — so a stale session cannot race a resumed
one. Same-worktree reuse is not offered at this grade.

That single authorization is counted as a policy-required **interruption**, and
never as an operator **intervention**. The distinction is load-bearing: the
milestone gate compares intervention counts, and a design that requires an
operator to press a key must not be able to improve its own score by calling
that key an intervention, nor inflate it by the reverse.

## The facade's operation contract

The facade's boundary is a set of claims that are easy to state and easy to
erode. They are written as data rather than prose, in
[`packages/kernel/src/facade/operations.ts`](../packages/kernel/src/facade/operations.ts),
so they can be checked:

> THIS INVENTORY GRANTS NOTHING. It describes what an operation costs and where
> it is reachable.

Each of the **38** operations in `FACADE_OPERATIONS` declares four things:

| Axis | Values |
|---|---|
| Capability class | `read`, `control`, `maintenance`, `approval`, `confirmation`, `action` |
| Invocation fence | `required`, `absent-by-state` |
| Journal revision | `advances`, `observation-only`, `none` |
| Reaching surfaces | `cli`, `mcp`, `binding-channel`, `integration-event`, `facade` |

`delivery-harness managed operations` prints that inventory, so an operator can
read an operation's cost and reachability from the installed product rather than
from this page.

The surfaces are the part worth reading twice. `cli` and `mcp` are the
model-visible tool surfaces. `binding-channel` names the kernel-facing surface
where a qualified host's static adapter would submit the normalized confirmation
observation; it is not an interactive producer and does not itself prove human
origin. The opaque interaction belongs to the host before registration, outside
anything model-owned execution can invoke, observe, inherit, or interpose. No
current host supplies a qualified producer, so the two confirmation operations
remain unavailable in production; the disposable fixture exercises only their
shared decision semantics.
`integration-event` is the trusted host-runtime integration used for graceful
termination provenance. `facade` means library call by an embedding product
surface. Provider-review preparation and ingestion are facade calls, but the
inventory grants them no trust: their runtime authority is the host-retained
capability lifecycle described below.

`checkFacadeSurfaceInvariants` holds six positions over that inventory —
confirmations stay off the tool surfaces, the MCP surface stays read-only,
termination provenance stays off model-visible surfaces, no operation is
declared twice, and a fence-bearing operation cannot declare that
it moves no revision. It is a sensor over the inventory, run from the kernel's
own suite and from the MCP contract suite; it is not a runtime guard, and no
production code calls it.

## Durable state, and the reducers under it

A delivery's durable state is an append-only JSONL journal
([`packages/kernel/src/checkpoint/journal-store.ts`](../packages/kernel/src/checkpoint/journal-store.ts)),
written owner-only, extended and never rewritten. A durable entry is a
*terminated* line — JSON followed by a newline — so a torn tail from a killed
process is truncated before the next append, while a corrupt terminated line
fails the whole journal closed. Every append re-reduces the entire journal plus
the candidate entry, so a journal that cannot be reduced cannot be extended.

The reducers themselves are not in that module. They are pure functions over
frozen state tables in
[`packages/kernel/src/spine/reducer.ts`](../packages/kernel/src/spine/reducer.ts) —
no I/O, no clock, no ambient anything — over the vocabulary frozen in
[`packages/kernel/src/spine/vocabulary.ts`](../packages/kernel/src/spine/vocabulary.ts):
**20** delivery states, 7 intake states, and a separately tracked host-activity
state that never changes the delivery state.

`failed` is frozen as a terminal discriminator with no entry transition at all —
the transition check returns false for every edge into it. Host activity is
observed, not obeyed.

## The policy compiler

`compileRepositoryPolicy`
([`packages/kernel/src/policy/compile.ts`](../packages/kernel/src/policy/compile.ts))
takes three layers — the portable defaults, the owner-approved
`repository-policy-document/1`, and the executable adapter capability
descriptors — and produces one immutable `compiled-repository-policy/1`
snapshot with a digest over itself.

The per-stage envelope composes asymmetrically, and that asymmetry is the whole
safety property: a checkpoint override **replaces** the tool and writable-path
lists, which are the owner-approved document's to shape, while protections and
forbidden operations are **union-only**. Weakening a protected path or a
forbidden operation is unspellable, not merely rejected.

The admission config the gate consumes is a *projection* of this policy, not a
second source of it.

### Lenses and reviewer charters

A review lens is `{ lensId, category, personaId, personaDigest? }`. Every
compiled policy must activate at least one lens per mandatory category —
`outcome-correctness` and `testing-policy` — or compilation rejects. The review
floor is not lowered by omission.

The optional digest is what selects between two resolution arms, and the
asymmetry is deliberate:

- **No digest** — the lens references a charter **by identity alone**, and the
  compiler resolves it only against charters whose origin is the authenticated
  composition. A repository file can never intercept an identity-only reference.
- **A digest** — the lens references a **repository-owned** charter, resolved
  only against the digest-bound read-only copy of the repository's own charter
  at that exact digest.

In both arms the compiler binds the digest from the *resolved charter*, never
the digest the document claimed, and it never reads charter prose. The snapshot
is immutable, so one identity cannot resolve to different bytes across a
delivery's life — including across a pause.

### Native provider review results

Review evidence enters through one host-neutral contract, one native invocation
per reviewer. At workspace binding the operator-owned host supplies a random
root capability and retains it outside model prompts, settings, CLI, and MCP;
only its identity and digest are stored in installation-owned authority outside
the admitted model filesystem. Before each native review, the host supplies
that root proof plus a fresh invocation capability.
`prepareProviderReviewHandoff` verifies the standing fence/workspace and
sandbox/grant digest, binds the expected native session/run, one exact lens,
the trusted persona bytes, the accepted contract, exact-candidate sensor
evidence, and the review instructions into one prompt byte string, then stores
only the invocation capability identity and digest in the same authority root.
The raw secrets are never stored.

The host submits those exact prompt bytes to one native reviewer and retains
the unmodified envelope. Its adapter first verifies the submitted bytes against
the handoff, then combines the binding-owned identities with the model-authored
verdict/findings and preserves the exact raw envelope bytes/digest.
`ingestProviderReviewResult` requires the invocation proof, compares every
binding, recaptures the candidate, and fails closed on forged, partial, failed,
stale, moved, or incoherent results. A delayed callback from a superseded
workspace cannot satisfy either the new fence/workspace or the rotated root.
Two policy lenses therefore require two distinct native child sessions inside
one exact provider run and final pass; lens IDs never synthesize reviewer
independence, and mixed run/pass tuples are refused.

Claude's native envelope may contain the conclusion as bare JSON or as exactly
one `json`-labelled block surrounded by its review summary. Zero, malformed, or
multiple blocks are refused as ambiguous; the surrounding prose never becomes
evidence.

An accepted result is normalized into the existing content-addressed result
store before one `attempt.artifact.recorded` append names both its digest and
attempt. That append is the sole acceptance/replay authority: attempts and
provider results are derived from journal entries, with no `attempts/` or
`provider-results/` sidecar authority. Missing or tampered accepted bytes fail
closed without reopening the handoff or appending a replacement acceptance. A
provider-run copy may be retained only after acceptance and is
non-authoritative. The existing review-floor reducer consumes the derived
attempts, and `admit` remains the only manifest builder. Identical replay is
idempotent; a different result for the same accepted handoff is a typed,
journaled conflict.

The root and per-invocation capability bindings live under the existing
installation-owned authority root, outside common Git. The composed Claude
session is restricted and fail-closed: sandbox startup must succeed,
unsandboxed retries and excluded commands are disabled, common Git and the
authority root are denied to Bash and file tools, ambient temp writes are
denied, and the grant's exact writable roots and protected descendants are
projected into the OS sandbox. The digest-bound settings and grant identity are
part of the standing capability binding. Public workspace and handoff files
carry no capability binding that imported model code could replace.

The authenticated Claude acceptance lane is operator-owned and opt-in:

```sh
QUALIFY_CLAUDE_CODE_SESSION=1 node --import tsx scripts/qualify-claude-code-session.ts --provider-delivery
```

It packs and installs the product, prints the exact handoff and native-result
path for every reviewer invocation in each disposable repository, runs Claude
once per reviewer with `--restricted`, the exact bound prompt, and the
binding-composed settings,
then sends those untouched native envelope bytes through the shared
adapter and ingestion seam before review reduction, admission, tracked-record
verification, and the finish line. The printed work directory is retained for
inspection. This harness launches Claude with the operator's credentials; the
product does not.

**Which arm this repository uses.** Its own policy at
`.agents/policy/repository-policy.json` uses the digest-pinned repository-owned
arm, against the two charters under `delivery/personas/`. The identity-only
composition arm is exercised by tests in this repository and by no production
caller here — see the next section for exactly what that means.

### The shipped charter set

The pinned composition ships **17** reviewer charters, a declared-data manifest
naming each by identity and path, and an adjudication recording an
include-or-exclude decision for every source file considered. All of it is
archive content. This repository carries only the **resolution mechanism**:
[`packages/kernel/src/policy/shipped-personas.ts`](../packages/kernel/src/policy/shipped-personas.ts)
names one archive entry, reads the manifest through a byte-reader port, and
re-derives each charter's digest from the bytes it actually read, cross-checking
against the digest the archive's own release manifest recorded.

That split is what lets the set advance on its own: a new archive release changes
which charters exist and at what digests, and no adopter policy document changes
and no consumer logic moves. It is not a zero-byte advance — the pinned archive,
metadata, and provenance digests are re-stamped on every advance, which is
inherent to a digest-pinned composition.

**`projectShippedPersonas` has no production caller in this repository.** It is
exported from the kernel's public surface and reached only by its own suite and
by the documentation-reference sensor. That is the intended library boundary, not
an oversight and not a wiring that exists elsewhere: the one production path into
`compileRepositoryPolicy` supplies repository-owned charters. An embedding
product that wants the shipped set calls this function; nothing in this
repository does yet.

## Hosts, grades, and what a grade buys

Host capability is *graded*, not assumed, and the grading is a qualification
record — [`qualifications/host-admission-capabilities.json`](../qualifications/host-admission-capabilities.json) —
rather than a constant in the source:

| Tier | What it means |
|---|---|
| 0 | Read-only inspection only. |
| 1 | The mutation floor: deny-until-attested grant enforcement, a worktree-materialized digest-receipted projection, binding attestation, a qualified host-owned operator-confirmation producer, fence-revocation cancellation, and fresh-worktree-only resume. |
| 2 | Trusted graceful lifecycle events. |
| 3 | Graceful termination provenance with verified descendant teardown — the grade that would enable same-worktree resume. |

Today both `claude-code` and `codex-cli` are graded tier 0: neither has a
production-qualified operator-confirmation producer before registration, and
Codex also has no delivery-lane binding. Production registration and takeover
therefore remain unavailable; the disposable confirmation fixture proves only
the shared decision semantics.

The consuming code keys on the **affirmative** grade rather than on the absence
of a negative one. Reading "not ungraded" as "capable" would invent a capability
from a grading the code does not recognise; every doubt resolves to
`unverified`.

### The granted-shell posture: accept and declare

`Bash` is in the mutation-stage grant **by decision, not by default**, and the
consequence is stated rather than hidden.

The binding's write-path interceptor extracts a write path from tool input only
for the tools that carry one — `Write`, `Edit`, `MultiEdit`, `NotebookEdit`. A
shell invocation carries no such member, so its filesystem writes are
capability-gated and **not** path-gated. On a host with no OS-level sandbox
behind an admitted session, the grant's protected paths are therefore not a
boundary against the shell. This is the default posture and not a corner case:
the shipped stage grant allows `Bash`, so every ordinary stage session holds it.

Each graded host states its own position on this explicitly, as a declared
capability rather than an absent claim:

- **`claude-code` — `unsupported`.** No OS-level filesystem sandbox behind an
  admitted session; the interceptor is the only path boundary, and it does not
  reach the shell.
- **`codex-cli` — `supported`.** The workspace-write seatbelt policy denies
  writes to `.git` inside the writable workspace root, live-probed rather than
  assumed.

An absent claim and a declared limitation read identically to a sensor and very
differently to an operator, which is the point of declaring it. The operator's
position is to accept and declare: closing this gap belongs to the host's own
permission system, not to the grant envelope. Removing `Bash` was considered and
rejected — every gate loop runs its build, test, and version-control commands
through it, so the capability would return per repository, which is the same
exposure with more ceremony.

### Where a write path passes, not just where it ends

The interceptor canonicalizes both the workspace root and the reported write
path before taking a relative path between them, and it does so by following one
link hop at a time, recording **every position the walk passes through** rather
than only its endpoints.

Endpoints alone are not enough. With a symlink `src/alias -> .git`, a write to
`src/alias/config` has endpoints that never mention a protected path — the walk
has to notice that it *stood on* `.git` partway through. Two further properties
follow from doing it hop by hop: a dangling link is a refusal rather than a
crash, because the target of a link can be read even when it does not exist; and
`..` is applied *after* the link it follows, because that is what the kernel
does, so `a/link/..` cannot be collapsed to `a` lexically.

Hardlinks are outside what any path inspection can see, and git cannot store one,
so a hardlink cannot arrive as committed content. Time-of-check to time-of-use is
likewise outside the boundary: anything that swaps a link between the check and
the `open()` writes somewhere the interceptor never saw.

## The two authorization classes

Neither class can be minted by the model.

**Operator confirmation** (`operator-confirmation/1`) covers contract
confirmation and takeover authorization. It requires no cryptographic assertion;
its strength comes from a qualified host-owned producer that runs before
registration or takeover and outside model-owned execution. The producer's
static adapter emits one normalized, host-neutral observation; the kernel alone
evaluates and consumes that observation. A caller, facade surface, or
`binding-channel` label is never evidence of operator origin, and without a
qualified producer the confirmation lane fails closed.

**Sensitive-approval assertion** (`sensitive-approval-assertion/1`) is the
stronger class: one fresh host-native or OS-native interactive evaluation with a
single-use nonce, in one of three binding profiles — delivery-bound,
maintenance-lane, and security-blocked-migration. Waivers consume one of these,
and the approving origin must differ from the proposing actor.

No model-driven execution grant may carry a privileged credential — merge,
deploy, pull-request creation, or approval-request — and a compiled policy that
tries to place one in a model grant is rejected at compile time.

## Trust: `local-digest / operator-pinned`

That string is frozen wording, quoted verbatim by the manifest, by the
merge-ready result, and by every delivery record.

**What it guarantees.** Full digest closure over the installed generation: the
manifest is RFC 8785 canonical JSON, the generation digest is the SHA-256 of
those bytes, and the inventory lists every packed file with its digest in a
strict order, so a file added, removed, reordered, or drifted breaks the chain. A
generation is execution-eligible exactly when its digest is not revoked and is
either the pinned manifest digest or a previously accepted one. Revocation wins
over both. The trust store is installation-scoped, full stop — every trust read
resolves inside the installation directory and nowhere else.

**What it does not guarantee.** Provenance. There is no signature verification,
no publisher key, no detached signature. It proves that the bytes on disk are the
bytes an operator pinned and that they have not drifted since — integrity
relative to a local operator decision, not authenticity of origin. The label
claims exactly what was verified and nothing more, mirroring the honest-scope
discipline the delivery record's L0 attestation follows.

The signature predicate is future work behind one validation port, so it can
replace the local-digest predicate without touching a reducer or a check site.

## The shadow window

This repository is currently governed by its own product, in **shadow mode**.

The composed product is installed from a pinned, digest-addressed generation
packed from a chosen source commit, read-only and outside the working tree, and
it materializes a run-pinned projection into managed delivery worktrees. Its
delivery authority is `none`: `npm run check`, the `delivery-harness` gate loop,
and the hosted checks remain this repository's only delivery authority, and the
two are compared rather than one deferring to the other.

The projection is scoped, and the scope is a guarded position rather than an
expectation. The projection root may exist **only** inside a managed delivery
worktree; the repository root and every non-managed worktree must carry none. The
mechanism is model-external and byte-neutral: the binding writes its session
settings and a worktree-scoped excludes file into its own directory outside the
working tree and points the managed worktree's git configuration at them, so no
tracked byte of the repository moves.

The only agent-discovery layout this repository carries is the **installed**
one: the `linear` profile release in `.agent-skills/`, exposed by the
`agent-skills` lifecycle and separate from the managed projection root scoped
above. Both its exposures — `.agents/skills` and `.claude/skills` — are
tracked; the second is the one admitted exception to the delivery-owned
`.claude/` prefix, granted per entry on its committed mode and link target. The
projection root scoped above is a different path and is unaffected: no tracked
byte lies under it. Adding a skill by hand, or a second
vendored skills root, remains drift rather than a quiet second source of agent
instructions. Guidance for agents working in this repository lives in
[`AGENTS.md`](../AGENTS.md) — the one hand-authored root instruction file, which
points at the installed skills rather than carrying skill text — and in
[the agent guide](agent-guide.md), which is a document rather than a discovery
root.

Measurement is written by the binding and never by a session.
`recordProjectionConsumption` is a `facade`-surface operation, and the artifact it
writes sits under `.agents`, which is an additionally protected path in every
checkpoint grant — so no execution grant may author an entry. A record whose
declared source is not the binding is a finding and excludes that delivery from
the comparison set; an absent or non-affirmative record excludes it silently.
An empty measurement list therefore means *no shadow delivery has been observed
consuming a projection* — never *no producer exists*.

## Where to next

- [The agent guide](agent-guide.md) — module boundaries and sensors, for an
  agent or a person changing this repository.
- [Getting started](getting-started.md) — the gate loop itself, executable.
- [The delivery record](delivery-record.md) — what the tracked record proves.
- [Conformance](conformance.md) — the vector kit and its drift guard.
