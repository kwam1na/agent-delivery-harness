# Portable delivery evidence

See the [declared checks guide](declared-checks.md) for configuring checks.

`delivery-harness record` writes `delivery-record/2`. The record retains the accepted evidence manifest, the exact bytes of every declared artifact, and the policy, preparation wiring, installed release and resolved reviewer inputs that governed acceptance. Capture happens during submission, while the provider run directory still exists.

Commit the record at the path the command reports. `delivery-harness verify` and the GitHub Action reconstruct the current inputs from the selected candidate tree and use the same manifest validators and gate evaluator. Neither needs the original provider directory or the author's private evidence store. CI reads the pull request head, including repository-contained generation symlinks, rather than the synthetic merge checkout.

The transport remains **self-attested**. Its digest detects accidental or inconsistent rewriting; it is not a signature or proof of independent review. Original reviewer context, raw outcomes, approval artifacts, findings, filed deferrals, reported cost and raw round history remain inspectable. An omitted host cost stays omitted.

## Review context and neutral edits

Review-neutral report, solution and telemetry changes may preserve the existing deliverable identity. A record retains the original accepted candidate binding. A review-context projection identifies the original reviewed tree and the later prepared tree separately, preserves the original history, and adds no review round. Source comments and generated changes remain subject to the repository's existing identity rules.

Every activated review lens must be represented. Adopters may add repository-owned charters in `harness.config.ts`:

```ts
additionalReviewLenses: [
  {
    lensId: "lens.repository-standards",
    reviewerId: "repository-standards",
    charterPath: ".agents/agents/repository-standards.md",
  },
],
```

These extend the installed activated set. Lens and reviewer collisions, missing or empty charters, and paths escaping the repository are refused. Charter paths become preparation inputs automatically. Review context identifies each charter's repository or composition origin, path and exact digest.

Declared compiled-policy input hashes must match their source bytes. Where a snapshot declares `compiledWith.personaSource.archiveSha256`, it must match the installed release. Older snapshots without that field retain their original provenance; separate exact hashes of policy and release do not invent a compilation relationship. The lifecycle's policy recompile and readiness check remain necessary.

## Checks and exceptions

Declared checks retain their original terminal result and bounded output snapshots through the existing provider envelope. Verification recomputes check definitions, policy, validation identity, release and preparation wiring from the target tree. Ignored check outputs can be read from the retained snapshots, so the CI checkout need not recreate temporary build outputs.

An attributed durable human exception retains its author, reason, policy, approved candidate and finding scope. Verification compares it against the current findings produced by the existing gate. CI and agents do not become human, grant an exception, or replay invocation-only approvals. A live result cannot be inferred from a summary. The verifier accepts only fresh caller-observed live results; the recorded run id remains historical context.

## Migration and limits

Historical `delivery-record/1` files remain readable for history and record discovery. A selected version 1 record cannot satisfy verification; acquire and submit current evidence, then record with this version. Older private evidence without retained bytes also requires resubmission while the original artifacts are available.

Each artifact is limited to 2 MiB, a manifest to 128 artifacts, each retained evidence payload to 8 MiB, and a delivery record to 16 MiB. Base64 must be canonical, and the exact retained set must match the manifest. Missing, empty, corrupt or oversized required evidence fails verification. Evidence remains untrusted input; artifact text is never executed.
