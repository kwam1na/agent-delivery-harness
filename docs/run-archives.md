# Portable run archives

Export the selected run with `delivery-harness runs export <run-id> --output <file>`.
The owner-only JSON archive preserves the journal, historical projection and
bounded captured acquisition attachments. Failed and interrupted runs can be
exported without producing a delivery record. Identical bytes share one digest
entry; report identity and candidate bindings remain distinct.

Read with `delivery-harness runs archive <file>`. Read exact report bytes and
metadata with `delivery-harness runs archive <file> --artifact <artifact-id>`;
output is JSON containing base64 bytes, never executable report markup. Reading
works outside a Git repository and does not import a journal, change a current
pointer, resume a run, run a provider, or verify a current candidate.

Archives use `delivery-run-export/2` with an explicit `attachments` member.
Metadata-only v2 exports and v1 exports remain readable; they make no promise of
retained bytes. Missing output carries an unavailable reason. Readers validate
attachment bindings, digest, exact size, canonical encoding, and the declared
artifact set. Archive projections are historical observations, not approval or
fresh verification. No source paths in an archive are followed.

Limits are 2 MiB per attachment, 128 distinct attachments, 8 MiB for serialized
attachment metadata/base64 payload, and 16 MiB for the entire archive. Encoding
overhead counts. Export refuses excess size without truncating history or
changing the local run. Secret-like output is refused under the existing
credential-shape discipline rather than silently redacted. Keep archives as
untrusted content; no automatic upload or executable rendering occurs.

See [capture and local retention](run-artifacts.md) for attachment production,
[run progress](run-progress.md) for observation semantics, and
[accepted portable evidence](portable-evidence.md) for the separate authoritative
`delivery-record/2` contract.
