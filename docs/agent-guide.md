# Agent guide

Guidance for an agent — or a person — changing this repository: where the module
boundaries are, which sensor owns which rule, and which claims are checked
rather than merely written down.

**This file is a document, not a discovery root.** The repository's discovery
layout is installed rather than hand-authored: an operator runs the
`agent-skills` lifecycle, which lands the `linear` profile release in
`.agent-skills/` and exposes it under `.agents/skills` and `.claude/skills`,
both tracked (see [`AGENTS.md`](../AGENTS.md) for the narrow rule that admits
the second). Only that lifecycle writes it, so a hand-added
skill or a second vendored skills root is still drift. Read this page for what
this repository owns; read `AGENTS.md` for which installed skill to use. Do not
turn this page into a second source of agent instructions.

## The shape of the repository

```
.agent-skills/       the installed workflow-skill release, exposed under .agents/skills and .claude/skills
packages/kernel      the whole decision surface — pure where it matters
packages/cli         the nine-command operator surface
packages/mcp         a read-only MCP projection of the CLI
packages/conformance the 89-vector golden kit and its generator
packages/action      the GitHub Action that verifies the tracked record
scripts/             the static sensors and the qualification drivers
docs/                the guides, the vendored spec, the vendored plan
delivery/            tracked delivery records, and this repo's own charters
qualifications/      graded host capability records and pinned fixtures
.agents/policy/      this repository's own compiled policy — protected
```

## Kernel module boundaries

The kernel is one package with hard internal boundaries. Crossing one is a
design change, not a refactor.

| Module | What it owns |
|---|---|
| `spine/` | The frozen contract: closed grammars, the state vocabulary, the journal envelope, and the pure reducers. No I/O, no clock, no ambient anything. Adding a kind, a state, or a journal is a contract revision. |
| `policy/` | The three-layer policy compiler, the capability and authority models, and the archive-charter resolution mechanism. Pure over ports. |
| `facade/` | The managed-delivery facade, its operation inventory, and the one typed status model. Records and refuses; never orchestrates. |
| `checkpoint/` | The durable path: the append-only journal store, canonical recheck, secret discipline, and retention. Delegates all reduction to `spine/`. |
| `host/` | Host bindings and the write-path interceptor — the model-external enforcement edge. |
| `binding/` | Host-admission decisions as pure functions. No I/O, no clock, no process launch. |
| `finish-line/` | The merge-ready reducer and its deliberately unbound external action port. |
| `evidence/` | The review floor, the waiver doctrine, and the blocker audit surface. |
| `substrate/` | Pack, install, activate; the installation-scoped trust store, release lifecycle, and preflights. |
| `workflow/` | The released workflow contract, consumed and digest-verified — not re-authored here. |
| `validator/`, `evaluator.ts`, `context.ts` | The `delivery-evidence/1` validator and gate evaluator. Held to true purity by sensor. |

Two boundaries are worth stating as prohibitions, because they are the ones a
plausible change breaks:

- **The reducers live in `spine/`, not in `checkpoint/`.** `checkpoint/` is the
  durable-bytes module. If you find yourself deciding a state transition there,
  the logic belongs one module over.
- **The admission config is a projection of the compiled policy, not a second
  source of it.** Adding a rule to the config that the policy does not compile
  creates two authorities with one name.

## Rules the repository will not let you break

Every rule below is enforced by a sensor and falsified by a test.

Mind the difference between the two. `npm run check` is `typecheck`, then the
import-boundary sensor, then the CLI-inventory sensor, then the whole vitest
suite — so it runs the first two sensor *scripts* below and every row's *test*.
The policy-projection and standalone-install scripts are not in
`check`; their tests are, but a test proves the rules are falsifiable while the
script is what reports against this working tree. Run those two yourself
(`npm run sensor:policy`, `sensor:standalone`) before pushing a
change that touches policy or packaging.

| Sensor | What it holds |
|---|---|
| `scripts/check-import-boundaries.ts` | Six rules: the kernel imports nothing from `cli`/`mcp`/`action` or from `harness.config`; no import-time `process.env`; no `Bun.*`; true purity for the validator, evaluator, and context modules; the filesystem port for the recorder, admission, and delivery-record modules; and the spec's clock ban in decision paths. |
| `scripts/check-cli-inventory.ts` | Every module under `packages/cli/src/commands/` is registered, and every registration has a module. Empty registries and missing directories are findings, not passes. |
| `scripts/check-release.ts` | One version across the root manifest and every workspace package, the kernel's version fingerprint in lockstep, license coherence checked against the real `npm pack` file list, and the publishability split. |
| `scripts/policy-projection-check.ts` | This repository's own policy projection, its typed leaf adapters, the compiled snapshot, and a digest-pinned pre-cutover oracle, against the routing the repository actually performs. |
| `docs/docs-examples.test.ts` | Executes the getting-started guide verbatim. Its `sh` blocks are one shell session; its `ts` blocks become files. Flag tokens must match the CLI's usage text in **both** directions. |
| `docs/docs-references.test.ts` | Every relative link in the README and the top-level guides resolves, and every sentence stating one of the counts it registers — in every document it scans — carries the value the tree computes. A computable number it has no pattern for is unguarded; adding a pattern is how you close that. |

### Sensors that bite on a documentation-only change

Editing prose is cheap; editing these is not.

- **`docs/getting-started.md` fenced blocks are executed.** Prose outside fences
  is free. A changed command, flag, or block order runs for real and fails for
  real.
- **`docs/contracts/` is byte-pinned by SHA-256** in the CLI's rails suite and in
  the provider qualification driver. One byte is a failure.
- **`docs/spec/delivery-evidence-1.md` is parsed as normative input.** Its
  Appendix A/B JSON fences must equal the published schemas byte-for-byte, and
  its Appendix D table is parsed into the rejection-code registry. Reformatting
  the table is a code change.
- **The gate itself.** `README.md` and `docs/**` are review-relevant — only
  `docs/reports/`, `docs/solutions/`, `telemetry/delivery-runs/`, and
  `delivery/records/` are review-neutral. A docs-only pull request still changes
  the deliverable identity and still needs its own delivery record and review
  evidence.

## Writing a claim that is worth having

This repository's failure mode is not a broken build; it is a true-sounding
sentence nobody can falsify. Three habits keep it out.

**A document that asserts a property the code does not have is a defect, not a
wording problem.** Verify the property against the tree before writing it, and
prefer a narrower true statement to a broader plausible one. If something holds
only of a test surface and not of a production path, say which — hedging a false
claim into a vague one is how it survives review.

**A claim over a set passes for free when the set is empty.** "Every documented
path exists" checks nothing if the link scanner stopped matching. Pin the
enumeration from both ends: a floor on what it must find, the exact membership it
must have read, and one specific member it must have found.

**Do not credit a red suite you have not attributed.** Several suites here pin
files by byte digest, so they go red on a comment-only edit. That is an integrity
pin, not behavioural coverage. Before crediting a test with catching a change,
plant a comment-only no-op and confirm it does *not* fail.

Mutate at the granularity of the thing you claim to enforce. A sensor made of six
rules needs six plants — one per rule — because a sibling rule will happily catch
the plant written for its neighbour and leave the intended one deletable.

## Conventions

- **ESM throughout, Node ≥ 22.6.** All process control goes through
  `node:child_process`; `Bun.*` APIs are banned by static sensor.
- **Zero runtime dependencies.** The published packages depend on nothing at
  runtime, and the ZIP reader, canonical JSON, and digest helpers are in-tree
  because of it.
- **Normative inputs are vendored, not referenced.** The spec and the conformance
  kit live in this tree and are regenerated byte-identically.
- **Describe the thing, not the plan.** Comments and documents name the behaviour
  and the reason; they do not carry plan-structure labels. Ticket identifiers
  belong in commit messages and pull-request bodies.
- **`.agents/` is protected in every checkpoint grant.** Nothing a session runs
  may write there, and that is what makes the measurement artifacts under it
  trustworthy.

## Where to next

- [The managed delivery product](managed-delivery.md) — the facade, the policy
  compiler, the host ladder, and the trust posture.
- [Getting started](getting-started.md) — the gate loop, executable.
- [Conformance](conformance.md) — running and regenerating the kit.
