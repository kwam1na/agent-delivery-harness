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
