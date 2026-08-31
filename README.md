# agent-delivery-harness

Fail-closed merge admission for AI coding agents.

A standalone, config-driven extraction of a production delivery harness that has
gated agent-delivered merges in a live monorepo since mid-2026. It defines what
counts as admissible evidence that an autonomous agent's change was reviewed and
validated against an exact repository candidate — and refuses everything else.

**The gate is now the finish line of a larger product.** Around the admission
kernel there is a managed delivery product: a facade an agent host drives a whole
delivery through, an append-only journal it can be resumed from, a compiled
policy that says what each stage may do, host bindings that enforce that policy
from outside the model's reach, and an installation lifecycle with a
digest-pinned trust posture. It runs the same kernel, produces the same evidence,
and stops at the same tracked record — **merge-ready is where it stops, and a
human merges.** It never launches a coding agent, schedules a subagent, creates a
worktree, or spawns a subordinate runtime; those are the host's acts. See
**[docs/managed-delivery.md](docs/managed-delivery.md)**.

**This repository gates its own pull requests with its own harness, and every
pull request carries a delivery record the Action verifies against the head
commit.** The gate is [`harness.config.ts`](harness.config.ts) at the root and
[`.github/workflows/gate.yml`](.github/workflows/gate.yml); the records it
verifies are tracked in [`delivery/records/`](delivery/records). The pull
request that introduced the workflow was bootstrap-exempt — it merged with that
check red, because no record verified by a gate still under review can exist,
and the exemption is granted by an administrator rather than by any code path in
the Action. Every pull request merged since then has carried its own delivery
record, bound to its own candidate; the records accumulate in
`delivery/records/` rather than replacing one another.

**Three names, one thing.** The repository is `agent-delivery-harness`; the
packages carry the `@agent-delivery-harness/*` npm scope; the command you type
(and the git-private storage namespace it writes under) is the shorter
`delivery-harness`. Nothing is being renamed — the three are the same project at
three different granularities.

**Publication state.** The packages are **not on npm yet**. Release checks —
including `npm publish --dry-run` per package — run in CI, but nothing has been
published, so today you adopt the harness from a checkout of this repository
(see [step 0 of the getting-started guide](docs/getting-started.md#0-consuming-the-harness-pre-v1)).
The published-action form of the GitHub Action ships with release mechanics; the
supported form today is self-hosted, `uses: ./packages/action`.

How it was built, unit by unit, is recorded in the vendored plan at
[docs/plans/2026-08-25-001-feat-delivery-harness-standalone-v1-plan.md](docs/plans/2026-08-25-001-feat-delivery-harness-standalone-v1-plan.md).

## Adopting it

Start with **[docs/getting-started.md](docs/getting-started.md)** — the full
loop, from writing a `harness.config.ts` through the CLI submission commands to
the tracked delivery record and the GitHub Action check. Every command on that
page is executed verbatim by the test suite
([docs/docs-examples.test.ts](docs/docs-examples.test.ts)), so the walkthrough
cannot drift from the tool.

| Document | What it covers |
|---|---|
| [Getting started](docs/getting-started.md) | Config → CLI loop → delivery record → local verify → the PR check. |
| [The managed delivery product](docs/managed-delivery.md) | The facade and its operation contract, the durable journal and its reducers, the policy compiler and reviewer lenses, the graded host ladder and the granted-shell posture, the two authorization classes, the trust label, and the shadow window. |
| [Agent guide](docs/agent-guide.md) | Module boundaries, which sensor owns which rule, and what bites on a documentation-only change. |
| [Provider guide](docs/provider-guide.md) | Taking a review context to an accepted manifest: run roots, the final-pass discipline, reviewer approvals, deferral rules, resubmission semantics. |
| [Provider rails contract](docs/contracts/delivery-provider-rails-v1.md) | The vendored neutral negotiation, lifecycle, cancellation, and terminal-state contract used by opt-in command providers. |
| [The delivery record](docs/delivery-record.md) | The `delivery-record/1` note: extra-spec status, the both-neutral-sets requirement, what L0 attestation honestly claims, the `baseMovement` policy. |
| [Conformance](docs/conformance.md) | Running the 89-vector kit (unit and integration modes), byte-identical regeneration, the drift guard. |
| [The spec](docs/spec/delivery-evidence-1.md) | `delivery-evidence/1` — the vendored normative contract. |
| [Spec errata](docs/spec-errata.md) | Three recorded divergences between the spec's text and the shipped kit/kernel reading. |

## The packages

- **`@agent-delivery-harness/kernel`** — the whole decision surface, in one
  package with hard internal boundaries. The admission half: pure validator for
  the `delivery-evidence/1` envelope and `review.green/1` payload, candidate
  capture, `deliverable-tree/v1` identity, content-addressed evidence records,
  preparation receipts, gate evaluator with six resolution kinds,
  execution-context trust asymmetry (agents can never waive), and the
  `delivery-record/1` verify core. The managed half: the frozen contract spine
  (closed grammars, 20 delivery states, and pure reducers with no I/O or clock),
  the three-layer policy compiler and its reviewer lenses, the managed-delivery
  facade and its 37-operation inventory, the append-only checkpoint journal,
  host bindings and the model-external write-path interceptor, the merge-ready
  reducer with its deliberately unbound action port, and the installation
  substrate carrying the `local-digest / operator-pinned` trust label.
- **`@agent-delivery-harness/conformance`** — the 89-vector golden conformance
  kit (8 accept / 81 reject) and its table-driven generator, runnable in unit
  and integration modes.
- **`@agent-delivery-harness/cli`** — the nine-command operator surface and
  opt-in `delivery-provider-rails/1` stdio adapter:
  `prepare`, `review-context`, `submit-evidence`, `gate`, `record`, `verify`,
  `check`, `managed` (the managed-delivery facade's host-facing checkpoint and
  status surface), and `maintain` (the installation-scoped maintenance lane:
  update, rollback, and trust-state pin/revoke/unrevoke/high-water-mark).
  `managed operations` prints the facade's own operation contract — each
  operation's capability class, invocation-fence rule, expected journal
  revision, and the surfaces that may reach it.
- **`@agent-delivery-harness/mcp`** — MCP server exposing `review-context`,
  `submit-evidence`, and the read-only `managed` projection to agent frameworks
  over stdio, at strict CLI parity across the four protocol revisions it speaks
  (`2026-07-28`, `2025-11-25`, `2025-06-18`, `2024-11-05`). The tool surface is
  read-only by construction: it inspects a delivery, and the host it is running
  inside keeps ownership of how work is delegated and sequenced.
- **`@agent-delivery-harness/action`** — GitHub Action verifying the tracked
  delivery record on pull requests, against the PR head, never the synthetic
  merge commit.

## Runtimes

Node ≥ 22 (engines floor). CI matrix: Node 22, Node 24, Bun. All process
control uses `node:child_process`; Bun-only APIs are banned by static sensor.

## Working on it

```
npm ci             # install (npm workspaces, ESM throughout)
npm run typecheck  # tsc, strict
npm run sensor     # import-boundary / env / Bun / purity / time sensor
npm run sensor:cli # CLI-inventory sensor
npm test           # vitest (DELIVERY_HARNESS_MAX_WORKERS caps concurrency)
npm run check      # typecheck, then those three, in order
```

Three further sensors are **not** part of `npm run check` and are run on their
own. Each has a test under `npm test` that falsifies its rules, but the script
itself — which is what reports against this working tree — only runs when you
invoke it:

```
npm run sensor:policy     # this repo's own policy projection vs its routing
npm run sensor:shadow     # the shadow-window discovery and consumption guard
npm run sensor:standalone # standalone-install sensor
npm run qualify:provider  # exact installed-provider interoperability replay
```

Normative inputs are vendored, not referenced: the spec lives at
[`docs/spec/delivery-evidence-1.md`](docs/spec/delivery-evidence-1.md) and the
89-vector conformance kit at
[`packages/conformance/vectors/`](packages/conformance/vectors), regenerated
byte-identically by `npm run kit:generate` and guarded against drift by a test.

`scripts/check-import-boundaries.ts` is the static sensor: it keeps the kernel
free of surface-package imports and of `harness.config`, bans import-time
`process.env` reads and `Bun.*` APIs, holds the validator/evaluator/context
modules to true purity and the recorder/admission/delivery-record modules to the
filesystem port, and enforces the spec's GEN-5 clock ban in decision paths.
`scripts/check-cli-inventory.ts` keeps every CLI command registered with the
blocker contract. `scripts/check-release.ts` is the release-mechanics sensor:
one version across the root manifest and every workspace package, the kernel's
`HARNESS_VERSION` fingerprint constant in lockstep with that version, license
coherence — the root `LICENSE` carries the Apache License 2.0 text rather than a
stub that names it, and every manifest's `license` field agrees, checked against
the actual
`npm pack --dry-run` file list so each tarball really carries `LICENSE` and
`NOTICE` — and the publishability split: no workspace package private, the root
manifest private. Every rule is falsified by a test, and
[`.github/workflows/release.yml`](.github/workflows/release.yml) re-runs the
sensor alongside a per-package `npm publish --dry-run`.

The documentation has sensors of its own.
[`docs/docs-examples.test.ts`](docs/docs-examples.test.ts) executes the
getting-started walkthrough verbatim, and requires the flag tokens on that page
and in the CLI's usage text to match in both directions.
[`docs/docs-references.test.ts`](docs/docs-references.test.ts) resolves every
relative link in this README and the top-level guides, and checks the computable
counts those documents state — the facade's operation inventory, the delivery
and intake state vocabularies, the CLI command count, and the conformance kit's
vector count and accept/reject split. Each of those counts is checked by
agreement rather than by presence: every sentence stating it, in every document
the sensor scans, must carry the value the tree computes. Stating it in a new
guide is covered the moment the guide exists, and re-stamping one mention while
leaving another stale is a failure rather than a pass. The reviewer charter set
the pinned composition ships is checked the same way, resolved through the real
archive. The frozen trust label is not a count and is checked differently — the
documents must quote it verbatim. Both the link enumeration and the count
patterns are guarded against matching nothing, because a claim over a set that
turned out empty would otherwise pass silently.

## This repository's own standing

This repository is governed by its own product, in **shadow mode**: the composed
product is installed read-only from a digest-pinned generation and projects into
managed delivery worktrees, while `npm run check`, the `delivery-harness` gate
loop, and the hosted checks remain the only delivery authority. The two are
compared, not merged.

It carries **no ambient agent-discovery layout** — no `.claude`, no `.codex`, no
vendored skills root — and
[`scripts/shadow-discovery-guard.ts`](scripts/shadow-discovery-guard.ts) pins the
digest of that emptiness, so introducing one is drift rather than configuration.
Guidance for agents working here lives in
[docs/agent-guide.md](docs/agent-guide.md), which is a document rather than a
discovery root.

## License

Apache-2.0. [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) sit at the repository
root, and the release sensor above verifies that both files are present in every
package tarball rather than assuming npm will include them.
