# Adoption and distribution delivery

Finish line: merged changes for V26-2009 and its eight children. The owner
explicitly authorized using passing local sensors when hosted CI is unavailable
because of billing. That instruction does not waive malformed evidence or local
sensor failures. No deployment or root-checkout alignment was requested.

## Acceptance map

| Work item | Delivered surface | Proof |
| --- | --- | --- |
| V26-1852 | Kernel declaration export, build on install/pack, strict consumer support | Strict Bundler consumer typecheck and standalone tarball sensor |
| V26-1853 | Pinned remote Action, consumer config kernel loader | Literal composite in a foreign installation: valid record passes, changed head fails |
| V26-1854 | Product-owned install/update selection and thin checksum wrapper | Archive-native lifecycle tests and disposable consumer qualification |
| V26-1855 | Qualified bootstrap profile and delivery wiring checklist | Bootstrap qualification and fresh installed exposure |
| V26-1872 | Scoped attributed expiring hosted-check policy in records and verification | Policy, record, CLI and Action positive/refusal cases |
| V26-1874 | Composite admit and accurate check record location | CLI tests plus bundled-runtime consumer admission |
| V26-1909 | Runtime, schema, archive identity and release advancement contract | Source reconciliation, release mechanics and 0.3.0 lockstep |
| V26-1956 | Explicit first-policy bootstrap without invented approval | First compile, partial-state refusal, provenance inputs and archive consumer |

The follow-up request makes the runbook host agnostic: `.agents/skills` is the
default for Codex and other hosts; Claude Code uses `.claude/skills`. Referenced
skill files use that same exposure, and journal examples name the actual host.

## Execution and qualification

Behavior changes used failing tests before implementation. Runtime contract and
runbook prose used sensor-only validation. New consumer tests preserve type
errors as well as successes, stale-record refusal, absent/invalid bootstrap
inputs, and refusal to replace existing authority artifacts.

The historical `qualify:provider` driver refuses its fixed provider-rails hash.
`origin/main` already carries that same differing source hash; this batch leaves
provider-rails unchanged and does not rewrite the historical qualification.
Current standalone and product-consumer proofs cover the changed distribution
surfaces. This is not a claim that the historical provider qualification passed.

## Review and finish

The candidate uses the repository's two required independent lenses,
`lens.outcome-correctness` and `lens.adversarial-testing`, with a four-round
bound. The tracked delivery record carries accepted review evidence; the pull
requests and tracker closeout carry final sensor results and merge identities.
No deferred work is accepted for this delivery.

The companion skills delivery qualifies new `bootstrap-product-v1`,
`core-adoption-v1`, and `linear-adoption-v1` product archives with runtime
`0.3.0`. Their metadata records exact archive digests. Historical release
identities and qualification bytes remain unchanged.

## Learning

Consumer resolution must be tested outside the producer workspace: its symlinks
hide both declaration leakage and Action config-import failures. The standalone
sensor and foreign Action regression preserve that lesson in executable form.
First-policy compilation must distinguish explicit inputs from an approval;
bootstrap regressions retain that boundary without fabricating comparison data.
