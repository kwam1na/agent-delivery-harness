# delivery-harness

Fail-closed merge admission for AI coding agents.

A standalone, config-driven extraction of a production delivery harness that has
gated agent-delivered merges in a live monorepo since mid-2026. It defines what
counts as admissible evidence that an autonomous agent's change was reviewed and
validated against an exact repository candidate — and refuses everything else.

**Status: pre-v1, under active construction.** The build is tracked as Linear
epic V26-1328 with 17 units across three phases; the authoritative plan is
[docs/plans/2026-08-25-001-feat-delivery-harness-standalone-v1-plan.md](docs/plans/2026-08-25-001-feat-delivery-harness-standalone-v1-plan.md).

## What ships in v1

- **`@…/kernel`** — pure validator for the `delivery-evidence/1` envelope and
  `review.green/1` payload, candidate capture, `deliverable-tree/v1` identity,
  content-addressed evidence records, gate evaluator with six resolution kinds,
  execution-context trust asymmetry (agents can never waive).
- **`@…/conformance`** — the 89-vector golden conformance kit (8 accept /
  81 reject) and its table-driven generator, runnable in unit and integration
  modes.
- **`@…/cli`** — submission and verification surface for agent frameworks.
- **`@…/mcp`** — MCP server exposing the submission surface.
- **`@…/action`** — GitHub Action verifying a tracked delivery record on PRs.

The repo ends v1 gating its own PRs with its own harness.

## Runtimes

Node ≥ 22 (engines floor). CI matrix: Node 22, Node 24, Bun. All process
control uses `node:child_process`; Bun-only APIs are banned by static sensor.

## Working on it

```
npm ci             # install (npm workspaces, ESM throughout)
npm run typecheck  # tsc, strict
npm run sensor     # import-boundary / env / Bun / purity / time sensor
npm test           # vitest (DELIVERY_HARNESS_MAX_WORKERS caps concurrency)
npm run check      # all three, in order
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
filesystem port, and enforces the spec's GEN-5 clock ban in decision paths. Files
those rules protect do not all exist yet; each is registered with an explicit
`pending` status that the sensor checks against the filesystem, so the unit that
creates one has to promote it in the same change.
