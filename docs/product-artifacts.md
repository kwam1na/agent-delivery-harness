# Distributed delivery product

Use the installed commands with the [delivery loop](getting-started.md).

The product ZIP contains the portable workflows, Python lifecycle, and bundled
JavaScript CLI, kernel, and policy compiler. Python 3 and Node >=22.6.0 are the
consumer prerequisites; no npm install or producer checkout is required. The
bundled loader resolves the kernel import in `harness.config.ts`; configuration
uses Node's erasable TypeScript syntax.

Install a trusted distributed archive with its detached checksum metadata:

```sh
npm run skills:install -- --archive /artifacts/product.zip --metadata /artifacts/product.json
```

That repository wrapper checks the checksum before executing a private copy of
the supplied archive. The equivalent lifecycle entry point works in any adopter:

```sh
python3 -B /artifacts/product.zip --root /repo --product install --archive /artifacts/product.zip --metadata /artifacts/product.json --maintenance
python3 -B /repo/.agent-skills/current --root /repo harness check
python3 -B /repo/.agent-skills/current --root /repo harness prepare
python3 -B /repo/.agent-skills/current --root /repo harness review-context --json
```

`--maintenance` confirms the existing lifecycle's maintainer authority. Use the
wrapper or authenticate the artifact against trusted distribution metadata
before directly executing the ZIP. Its checksum is integrity evidence, not a
new publisher authentication mechanism.

Update uses the next distributed ZIP with the same options and `update` in
place of `install`. Rollback and recovery need only retained installed bytes:

```sh
python3 -B /repo/.agent-skills/current --root /repo --product status
python3 -B /repo/.agent-skills/current --root /repo --product rollback --maintenance
python3 -B /repo/.agent-skills/current --root /repo recovery-plan
python3 -B /repo/.agent-skills/current --root /repo --product recover --maintenance
```

There is one active generation and the existing lifecycle journal. Both host
exposures and runtime follow `.agent-skills/current`. A successful switch can
still leave `productReady: false` when recompiling adopter-owned policy fails.
The command then fails, `--product status` reports the reconciliation blocker,
and `harness` refuses execution. Fix the reported policy issue and retry
`--product recover`; rollback also recompiles with the selected retained runtime.
Product reconciliation updates an already-declared
`compiledWith.personaSource.archiveSha256` to the selected generation and checks
the proposed snapshot against current policy sources and shipped charters.
Other compiler provenance is preserved; stale comparison adjudications are
reported for the adopter to resolve.

Repository sensors can import the supported APIs from
`.agent-skills/current/runtime/kernel.mjs` and
`.agent-skills/current/runtime/cli-api.mjs`. Adjacent `kernel.d.mts` and
`cli-api.d.mts` declarations are built from the same source and travel in the
same verified generation. The kernel exports candidate and record operations;
the CLI API exports `buildRunExport` and `parseRunExport` for the product's
observational run summaries. Consumers do not need an independently installed
npm package to supply these implementations or types.

## Following an installed delivery

The same installed runtime supplies the observational commands:

```sh
python3 -B /repo/.agent-skills/current --root /repo harness runs capabilities --json
python3 -B /repo/.agent-skills/current --root /repo harness runs list
python3 -B /repo/.agent-skills/current --root /repo harness runs view <run-id> --json
python3 -B /repo/.agent-skills/current --root /repo harness runs serve --repo /repo
```

See [run progress](run-progress.md), [capture](run-artifacts.md),
[archives](run-archives.md) and [the run view](run-view.md) for the contracts.
Both host workflows check the runtime's reporting capability and the selected
run's writer version. Legacy runs keep their original version. Rollback switches
workflow and runtime together; an older runtime may refuse newer run data rather
than interpret it. Retained bytes are not an instruction to migrate the journal
or an assertion that every retained runtime can read it. Keep an archive and a
compatible reader when history must remain independently inspectable.

## Producer commands

Build only after the compatible source batch has settled. First build and verify
the selected workflow profile with `agent-skills/scripts/build-release.py`. Then:

```sh
npm run product:build-runtime -- /verified-workflows/release-manifest.json /build/runtime
python3 -B /skills-source/scripts/build-release.py build --root /skills-source --archive /build/product.zip --metadata /build/product.json --release-id <batch-release> --profile linear --runtime-directory /build/runtime
npm run sensor:product-install -- --archive /build/product.zip --metadata /build/product.json
```

The runtime descriptor binds the exact workflow-only payload digest and each
runtime file digest. The active receipt's archive digest binds the complete ZIP;
no runtime file embeds that outer digest. Core and Linear select distinct workflow
payloads. The historical managed-composition pin is a separate lane and is not
used by ordinary product readiness.

The retained `qualify:provider` interoperability record also names an immutable
historical source baseline. Its original inputs and scenarios remain checked,
and the driver refuses to stamp those identities onto current source. Current
qualification uses the newly built product artifacts and fresh workflow,
provider, live connector, and installed runtime evidence; the historical record
does not stand in for any of those checks.

The artifact sensor compares every shipped runtime file digest with a fresh
build from the current producer source, exercises actual installed prepare/context, and verifies
that absent independent review blocks the gate. It does not manufacture review
or replace final host proofs. Rebuild all affected qualification records against
the final archive, metadata, runtime descriptor, and selected profile. Old exact
release attestations cannot qualify changed bytes.

## Runtime versions and exact artifact identity

`runtimeVersion` is the runtime builder's copy of the kernel package version.
The root and every workspace package version, plus `HARNESS_VERSION`, move in
lockstep; release checks enforce this. `HARNESS_VERSION` participates in
preparation fingerprints, so advancing it invalidates preparation for the prior
runtime. It is not a manifest schema label.

For newly qualified releases, advance that shared version when observable CLI
behavior or the public API changes: a backwards-compatible correction advances
the patch version, an additive API or command advances the minor version, and
an incompatible contract change advances the major version. During the 0.x
series, incompatible changes advance the minor version and must describe the
break explicitly. These are release boundaries: several changes can accumulate
on one development version before the next qualified release. A version is a
compatibility claim to validate, never proof that two builds contain equal bytes.

`schemaVersion` names a specific serialized format such as `delivery-runtime/1`.
Change it when that format changes incompatibly; independently apply the runtime
version rule if reading or producing that format changes runtime behavior. A
schema label does not substitute for package or runtime advancement.

The archive SHA-256 identifies the exact distributed ZIP. The lifecycle's
generation/content digest identifies its verified payload. Adopters pin the
archive checksum and metadata and retain the installed generation identity;
these are how an adopter selects and audits exact behavior and API bytes.
Repackaging can change an archive digest without changing the runtime API.
Never infer interchangeability from matching `runtimeVersion` values alone.

Earlier distributed archives recorded `0.2.0` across behavior changes before
this release policy was explicit. Those historical values remain unchanged.
They denote the recorded package baseline, not identical behavior or a
retroactive compatibility guarantee. For example, two archives both reporting
`0.2.0` with different archive digests remain distinct pins. Use their actual
metadata/digests to identify them; do not rewrite historical records or payloads.

The retained `linear-contract-alignment-v1` generations illustrate this:
archive `4a21ef3114195bfd0294a9e44e3dc3b8b094456760919aa7ec8cb3d9b17492ad`
and archive `f5f05e4866c8642225a274fc698aed938641d1f25f8209f0f3531ca2498debea`
both record runtime `0.2.0`. They are different artifacts even though their
release labels and runtime versions agree. These are historical examples, not
recommended current adoption pins.

Applying this rule: suppressing journal events for `prepare --help` is observable
behavior and requires at least a patch advance at the next qualification; adding
a public API requires a minor advance; an incompatible manifest schema change
requires its own schema label change and the appropriate runtime advancement.
Documentation-only clarification does not require rebuilding an archive or
advancing a runtime version. The runtime builder and lockstep checks remain the
sources of the recorded values; exact digest verification remains mandatory.

## First policy bootstrap

A new product release supports `--product apply` for both first installation and
updates. The archive owns that choice; the repository wrapper only authenticates
and snapshots the supplied bytes before invoking it. Existing releases without
`apply` retain their documented `install` and `update` entry points.

For an adopter with policy inputs but no compiled snapshot, explicitly add
`--bootstrap-policy` to `apply`. Supply these repository-owned files first:

- `.agents/policy/repository-policy.json`: the actual authority and review policy.
- `.agents/policy/adapters.json`: explicit typed capability adapters.
- `.agents/policy/bootstrap-inputs.json`: exactly
  `productTrustRevocationEpoch` and `repositoryAuthorityRevocationEpoch`, each a
  nonnegative safe integer selected by the adopter.

For example, after authenticating the archive and supplying those inputs:

```sh
python3 -B /artifacts/product.zip --root /repo --product apply --archive /artifacts/product.zip --metadata /artifacts/product.json --maintenance --bootstrap-policy
```

The verified installed runtime compiles the existing policy against installed
review charters and records the selected archive and compiler digest. It does
not infer adapters, grant authority, or create `comparison-report.json`.
Bootstrap refuses an existing snapshot or comparison report, including partial
state; subsequent recovery uses ordinary reconciliation after inspecting the
reported state. The first snapshot is created exclusively, so an existing
snapshot cannot be overwritten by a racing bootstrap. Existing comparison
adjudications are never manufactured or rewritten by installation.

This adoption batch advances the shared runtime/package baseline to `0.3.0`
for the additive admission command and policy/bootstrap interfaces. It does not
change historical artifacts or publish packages to npm.
