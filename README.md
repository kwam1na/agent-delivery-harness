# delivery-harness

Fail-closed merge admission for AI coding agents.

A standalone, config-driven extraction of a production delivery harness that has
gated agent-delivered merges in a live monorepo since mid-2026. It defines what
counts as admissible evidence that an autonomous agent's change was reviewed and
validated against an exact repository candidate — and refuses everything else.

**Status: pre-v1.** All five packages and the documentation are in place; the
remaining v1 unit is self-hosting (this repository gating its own pull requests
with its own Action) plus release mechanics — until that lands the packages are
unpublished and consumed from a checkout. The build is tracked as Linear epic
V26-1328; the authoritative plan is
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
| [Provider guide](docs/provider-guide.md) | Taking a review context to an accepted manifest: run roots, the final-pass discipline, reviewer approvals, deferral rules, resubmission semantics. |
| [The delivery record](docs/delivery-record.md) | The `delivery-record/1` note: extra-spec status, the both-neutral-sets requirement, what L0 attestation honestly claims, the `baseMovement` policy. |
| [Conformance](docs/conformance.md) | Running the 89-vector kit (unit and integration modes), byte-identical regeneration, the drift guard. |
| [The spec](docs/spec/delivery-evidence-1.md) | `delivery-evidence/1` — the vendored normative contract. |
| [Spec errata](docs/spec-errata.md) | Three recorded divergences between the spec's text and the shipped kit/kernel reading. |

## The packages

- **`@agent-delivery-harness/kernel`** — pure validator for the
  `delivery-evidence/1` envelope and `review.green/1` payload, candidate
  capture, `deliverable-tree/v1` identity, content-addressed evidence records,
  preparation receipts, gate evaluator with six resolution kinds,
  execution-context trust asymmetry (agents can never waive), and the
  `delivery-record/1` verify core.
- **`@agent-delivery-harness/conformance`** — the 89-vector golden conformance
  kit (8 accept / 81 reject) and its table-driven generator, runnable in unit
  and integration modes.
- **`@agent-delivery-harness/cli`** — the seven-command operator surface:
  `prepare`, `review-context`, `submit-evidence`, `gate`, `record`, `verify`,
  `check`.
- **`@agent-delivery-harness/mcp`** — MCP server exposing `review-context` and
  `submit-evidence` to agent frameworks at strict CLI parity.
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
npm test           # vitest (DELIVERY_HARNESS_MAX_WORKERS caps concurrency)
npm run check      # all of the above, in order
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
blocker contract.
