# Delivery Evidence Conformance Kit

Golden vectors for validators of the **delivery-evidence/1** specification
(envelope) and the **review.green/1** payload. A validator implementation that
produces the expected outcome for every vector conforms to the machine-checkable
core of the spec.

The corpus is derived from a production recorder's test suite
(`athena:scripts/harness-review-evidence.test.ts`, ~1,000 lines) that has gated
agent-delivered merges since mid-2026, restated against the generalized
envelope. Provenance is recorded per vector.

## Layout

```
kit.json                    index: every vector with id, file, rules, expectation
context/repo-config.json    the repository gate configuration vectors assume
context/environment.json    the submission-time state the harness must establish
vectors/accept/*.json       manifests a conforming validator MUST accept
vectors/reject/*.json       manifests a conforming validator MUST reject
generate.ts                 regenerates everything above (bun generate.ts <outDir>)
```

## Vector format

Each vector is self-contained:

```jsonc
{
  "vectorVersion": 1,
  "id": "rg-7-defer-p0",
  "title": "Illegal deferral: p0",
  "rules": ["RG-7"],                    // spec rule ids this vector exercises
  "provenance": "athena:… | new in spec | spec-tightened",
  "expect": { "result": "rejected", "codes": ["illegal_deferral"] },
  "environment": { … },                 // optional overrides of context/environment.json
  "extra": { … },                       // optional protocol notes (multi-step vectors)
  "artifacts": { "reviewers/correctness.json": "<exact file bytes>" },
  "manifest": { … }                     // the delivery-evidence/1 manifest to submit
}
```

## Running a vector

For each vector, the harness under test:

1. Loads `context/repo-config.json` as the repository's gate configuration.
2. Establishes the submission environment from `context/environment.json`,
   merged with the vector's `environment` overrides:
   - `currentCandidate` is what the recorder's candidate capture returns at
     submission time.
   - `prepared: false` means preparation is absent/failed (the capture reports
     an unprepared state).
   - `manifestLocation: "outside-run-root"` means the harness places the
     manifest file somewhere other than the allocated run root.
3. Allocates a run root for `manifest.provider.runId` and materializes each
   entry of `artifacts` at its path (exact bytes) relative to that root. An
   artifact path that is itself invalid (e.g. `../outside.json`) is part of the
   vector's point; materialize it where the path indicates, or skip
   materialization if the validator rejects on path shape before file access.
4. Submits the manifest through the recorder.
5. Compares the outcome to `expect`.

### Multi-step vectors

- `a-idempotent-resubmission` (`extra.submitTwice`): submit the same manifest
  twice. Both submissions succeed and the record ids are identical.
- `sub-4-record-conflict` (`extra.submitFirst`): submit `extra.submitFirst`
  (accepted), then the vector's `manifest`. Same record identity, different
  content — the second submission is rejected with `record_conflict`.

## Expectation semantics

- `result: "accepted"` — the submission MUST be accepted and one evidence
  record written per claim. No rejection codes.
- `result: "rejected"` — the submission MUST be rejected, no record written,
  and the response MUST include **every** code listed in `expect.codes`.
  Additional codes are permitted: several vectors violate more than one rule by
  construction (SUB-5 requires reporting all violations), and the kit does not
  over-specify cascade behavior. The listed codes are the floor, not the
  ceiling.

## Provenance markers

- `athena:…` — restates a case from the production test corpus.
- `new in spec; no Athena antecedent` — covers spec surface the production
  contract did not have (claims array, artifact digests, attestation levels,
  strict unknown-member parsing, repository requirement).
- `spec-tightened; Athena accepted a looser form` — the spec is deliberately
  stricter here; the production recorder accepted this shape. Two cases:
  - `env-9-empty-run-history` — Athena accepted an empty mutation sequence;
    the spec requires a non-empty `runHistory` whose final entry names the
    candidate tree and final pass.
  - `rg-9-iteration-count-mismatch` — Athena accepted an explicit
    `iterationCount` that disagreed with the mutation sequence; the spec
    requires `iterationCount == runHistory.length`.

## Known divergences from the production contract

Beyond the two tightenings above, the spec-shaped manifest differs from the
production manifest in ways the kit reflects:

1. **Claims array.** Production bound one manifest to one obligation; the
   envelope carries `claims[]` and the recorder writes one record per claim.
2. **Artifact digests.** Production validated artifacts at record time but did
   not hash them into the manifest; the envelope requires per-artifact
   `sha256` (`env-11-artifact-digest-mismatch` is new surface).
3. **Strict parsing.** Production tolerated some unknown members; the spec
   rejects any (`gen-1-*`). Production's summary-count fields
   (`unresolvedActionableCount`, `blockingCount`) were removed as pure
   derivations — their presence now trips `unknown_member`
   (`gen-1-legacy-count-field`).
4. **40-hex object ids.** Production fixtures used symbolic ids
   (`"tree-a"`); the spec requires real git object-id shapes, so all kit ids
   are deterministic hex derived in `generate.ts`.
5. **Approval stamp shape.** Production stamps carried flat
   `providerId`/`runId` fields; the spec nests them under `provider` and
   renames `worktreeId` to `workspaceId` (§9.2).

## Coverage

89 vectors: 8 accept, 81 reject. Every rule in spec §8 (GEN, ENV, SUB) and §9.3
(RG) is exercised by at least one vector except: GEN-3 and SUB-5 (meta rules
about validator behavior, observable through the multi-code vectors), GEN-5
(prohibition on time-based decisions — not observable from a single
submission), and ENV-3/ENV-7 (subsumed by schema-shape vectors). The signing
profile, additional payload specs, and gate-policy behavior (freshness at gate
time, waivers, delegation) are out of the kit's scope, as they are out of the
spec's.

## Regenerating

```
bun generate.ts <outDir>
```

The generator is table-driven — one entry per vector, mirroring the structure
of the source test corpus. Accept-vector artifact digests are computed from the
emitted bytes, so edits to artifact content stay internally consistent
automatically.

---

## Vendored layout in this repo

This README is the kit's own, carried verbatim. Two paths differ from the layout
above because the kit is vendored into an npm workspace:

| Kit path | Path here |
|---|---|
| kit root (`kit.json`, `context/`, `vectors/`) | `packages/conformance/vectors/` |
| `generate.ts` | `packages/conformance/src/generate.ts` |

Regenerate with `npm run kit:generate` (the generator is also runnable directly
under either runtime: `node --import tsx packages/conformance/src/generate.ts <outDir>`
or `bun packages/conformance/src/generate.ts <outDir>`). The vendored tree is
guarded against drift by `packages/conformance/src/generate.test.ts`, which
regenerates into a temp directory and requires byte-identical output — so the
vectors are never hand-edited, only regenerated.
