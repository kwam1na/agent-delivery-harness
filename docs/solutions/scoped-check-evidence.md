# Scoped check proof and final delivery binding

V26-2064 separates a check's input identity from the current selection and final
candidate. An unrelated report or sibling check must not invalidate application
proof. A current candidate, base, release, or newly selected obligation must
still be accounted for before admission.

The kernel exposes `ScopedCheckDefinition` (`scoped-check/1`),
`captureScopedCheckInputs`, `ScopedCheckPlan` (`scoped-plan/1`),
`ScopedCheckAttempt` (`scoped-attempt/1`), and `selectScopedCheckAttempt`.
`CheckBindingOptions.scopedPlan`, `SubmissionOptions.scopedPlan`, and
`AdmissionOptions.scopedPlan` connect the opt-in contract to existing evidence
submission and admission. Portable verification consumes current check bindings;
the final record retains the full current candidate/base and context.

Input capture ports must read one pinned snapshot: bytes and inventory must
agree. Explicit files may be absent; explicit tests must exist. Directory
memberships capture additions and deletions. Argv, logical cwd, tests, flags,
credential presence, declared profile, runtime, dependencies, relevant policy,
and release all contribute. Credential identity is an external nonsecret
account/revision identifier; an unavailable safe identity disables cross-candidate
reuse. Never provide a credential or its hash as that identifier. Undeclared
environment is excluded from capture and must be excluded by the executor.

The plan's selection digest is the canonical digest of all scoped providers'
`{id, check}` declarations sorted by id. Its check keys must exactly match that
set, and its candidate must match the freshly captured candidate including base.
The executor recomputes the plan after every base movement. It allocates durable
monotonic generations before starting a check and supplies the complete observed
attempt history. Completion order never overrules generation order. The latest
running, failed, or interrupted identical-input attempt prevents old-pass reuse;
a successful later generation can supersede it. Conflicting generations are an
error, not a tie to break by timestamps.

The kernel does not persist attempts or materialize execution snapshots.
V26-2065 owns those operations and the required pre-execution capability check;
V26-2067 owns distributed release qualification. Kernel support alone does not
activate the capability in the CLI or in Athena. A caller without a current
scoped plan receives `scoped_check_plan_required`. Legacy declarations continue
using strict whole-candidate semantics; independent review has no scoped
freshness exception.

Conformance evidence lives in `packages/kernel/src/checks.test.ts`,
`checks.scoped-integration.test.ts`, and the scoped freshness table in
`evaluator.test.ts`. The Git fixture executes an actual check, submits retained
terminal evidence, replans after a report edit, builds and verifies a portable
record, then exercises changed input, failed-attempt, missing-proof, added-sibling,
tampered-artifact, release, profile, and final-candidate refusal controls.
