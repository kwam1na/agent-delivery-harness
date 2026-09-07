# Retain selected acquisition reports

Run attachments preserve selected reviewer output before scratch cleanup. They
are self-attested observations, not accepted evidence or permission grants.
Capture supports only existing `run-event/2` runs. An older run remains readable;
start an explicitly linked v2 successor before using capture.

Before emitting, query `delivery-harness runs capabilities --json`. This read-only
command works outside a repository and returns `spec: "run-capabilities/1"`,
supported `writerVersions`, and `artifactCapture`. An older runtime that refuses
the command has not demonstrated capture support. Also inspect the selected run's
writer version; runtime support does not upgrade an existing v1 journal.

Use `delivery-harness runs capture <run-id> --json '<request>'` with these fields:

- `sourceRoot` and `sourcePath`: explicit scratch root and safe relative selected file.
- `eventId`: stable retry identifier (the command appends `-artifact` and `-report`).
- `artifact`: artifactId, activityId, attemptId, candidateTreeSha, digest (SHA-256),
  sizeBytes, mediaType, producer, and optional roundId/round/lensId.
- `report`: reportId and role (`review`, `reduction`, `clarification`, or
  `partial-output`), optionally originatingReportId and findingId.

Capture verifies exact bytes, persists them atomically, and only then appends
artifact/report references. Retry the same request after an interrupted append.
An artifact ID cannot be rebound to different bytes or a different attempt.
Clarifications receive new IDs and link their original report. Missing or refused
output is recorded as unavailable when the journal accepts that observation.
Capture failures return a diagnostic; they cannot satisfy evidence submission.

Read with `delivery-harness runs artifact <run-id> <artifact-id> --json` for exact
base64 bytes and metadata. The terminal view displays inert, single-line text.
Metadata-only run listings do not fetch attachment payloads. A missing, corrupt,
unsafe or cross-run reference returns an unavailable diagnostic.

Owner-only attachments live beneath the repository's git common directory at
`managed-delivery/runs/artifacts/<run-id>/`. They survive scratch cleanup,
process restarts and linked-worktree removal, but not removal of that common
directory. No automatic expiry, upload or transcript capture occurs. Identical
bytes share a digest-addressed blob within one run. Interrupted writes may leave
unreferenced blobs; retries safely reuse them.

Limits are 2 MiB per attachment, 128 distinct attachments, and 8 MiB serialized
retained metadata and base64 payload per run. Encoding overhead counts. Exceeding
a limit refuses capture without truncation. Existing credential-shape detection
refuses secret-like selected content; it does not silently redact evidence or
promise exhaustive secret detection. Treat retained content as untrusted.

Accepted `delivery-record/2` evidence continues through submit-evidence and its
existing validators. Portable run archive transport is separate from capture.

See [run progress](run-progress.md) for observation semantics and
[portable evidence](portable-evidence.md) for the separate accepted evidence contract.
