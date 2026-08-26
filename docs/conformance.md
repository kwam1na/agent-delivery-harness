# The conformance kit

The kit is the validator's test suite, not an illustration of it: **89 golden
vectors — 8 accept, 81 reject** — vendored at
[`packages/conformance/vectors/`](../packages/conformance/vectors/), each
self-contained and each carrying the expectation a conforming
[`delivery-evidence/1`](spec/delivery-evidence-1.md) validator must produce.
This repository's kernel passes all of them, in both modes, on Node and Bun,
and any other implementation of the spec can run the same corpus.

## Layout

```
packages/conformance/vectors/
  kit.json                 # the index: ids, files, rules, expectations, counts
  context/
    repo-config.json       # the repository configuration the vectors are bound to
    environment.json       # the current-candidate observation vectors assume
  vectors/
    accept/  (8)           # e.g. a-minimal-green.json, a-idempotent-resubmission.json
    reject/  (81)          # e.g. rg-7-defer-p0.json, sub-1-raw-tree-changed.json
```

Each vector carries its manifest, its artifact bytes, any environment
overrides (e.g. the candidate the recorder would re-capture), an optional
`extra` protocol for multi-step scenarios, and its expectation.

## Expectation semantics

- An **accept** vector must produce **no rejection codes at all**.
- A **reject** vector's listed codes are a **floor, not a ceiling**: the
  validator must report every listed code, and may report more — several
  vectors violate more than one rule by construction, and SUB-5 requires
  reporting all violations in one response.
- A code outside the spec's registry
  ([Appendix D](spec/delivery-evidence-1.md#d-appendix-d--rejection-code-registry))
  is a failure of the harness itself: an unregistered code means the validator
  invented vocabulary.

## Unit mode vs integration mode

The kernel's validator is pure — it judges a manifest against a repository
configuration and a supplied candidate observation. Five vectors expect
outcomes only the **recorder's** effectful surface can reach (an allocated run
root, real artifact bytes, a record store a second submission can collide
with):

| Deferred in unit mode | Why |
|---|---|
| `a-idempotent-resubmission` | Asserts record ids are identical across two submissions. |
| `sub-4-record-conflict` | Needs a store already holding the first submission's records. |
| `sub-3-manifest-outside-run-root` | Needs a real allocated run root to be outside of. |
| `env-10-artifact-missing-file` | Needs the filesystem to be missing the file. |
| `env-11-artifact-digest-mismatch` | Needs real bytes that hash differently than declared. |

- **Unit mode** decides the other 84 and skips these five *by name* — a name
  that vanishes from the kit fails the run rather than quietly shrinking
  coverage.
- **Integration mode** performs the kit's protocol for real: allocates the run
  root, materializes every artifact byte-for-byte, places the manifest inside
  the root, and submits through the recorder. All 89 are decided, nothing is
  skipped, and the assertions widen: an accepted submission must have written
  exactly one record per claim, all stamped with the manifest digest; a
  rejected one must have written none (GEN-3). The two multi-step vectors run
  the extra protocol their `extra` member declares (submit twice; submit a
  conflicting sibling first).

The only thing integration mode stubs is candidate capture — the vectors
declare what the capture port returns, which is exactly what the kit's
`context/environment.json` exists for. Everything else is real: a real
preparation receipt in a real store, real bytes in a real run root, records
linked into place by the store's own atomic publication.

Both modes run as part of the ordinary test suite:

```
npm test -- packages/conformance
```

## Configuration is a parameter

The kit ships its own repository configuration
(`context/repo-config.json`), and the vectors are bound to it — but the runner
takes the configuration as a parameter and never imports it inside a rule. The
suite exploits that in both directions:

- By default, kit runs load the kit's config through the fixture adapter
  (`packages/conformance/fixtures/repo-config-adapter.ts`).
- The same runs are re-driven under the **kit-variant config**
  (`packages/conformance/fixtures/kit-variant-config.ts`), which pins the
  vector-bound values as whole sets and varies every other dimension — proving
  the validator's outcomes follow the spec and the vectors, not one
  configuration's incidental values. A second, full-divergence config drives
  the kernel suite the same way.

## Regeneration and the drift guard

The vectors are generated, and the generator is vendored beside them:

```
npm run kit:generate
```

regenerates the corpus into `packages/conformance/vectors/` —
**byte-identically**. A test
([`generate.test.ts`](../packages/conformance/src/generate.test.ts))
regenerates the kit into a scratch directory on every run and diffs the two
trees; any file present in only one tree, or present in both with different
bytes, fails the suite. The guard is itself falsified: the same test tampers a
vendored copy and asserts the diff names exactly the tampered files. So the
vendored corpus can never drift from the generator — an edit to either without
the other is a red test, and a deliberate kit change is made in the generator
and regenerated.

The index (`kit.json`) carries the counts — `{ total: 89, accept: 8, reject:
81 }` — and the suite asserts the directory contents against them, so a vector
cannot be added or dropped silently either.
