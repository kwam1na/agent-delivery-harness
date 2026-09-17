# Separate source hashing from portable evidence transport

Scoped source and dependency files are read from the captured Git tree and
hashed. Their bytes are not embedded in the portable record. Reusing the
portable-evidence reader for this work incorrectly applied its 2 MiB artifact
limit to ordinary source files: preparation refused a 14 MiB generated graph
before any check ran.

The source reader shares the evidence reader's exact Git object verification,
regular-file checks, and contained symlink resolution. It does not apply an
artifact transport limit to source bytes. Native execution and foreign record
verification use this source reader for scoped input identity; workflow release
inputs still use the bounded evidence reader. Portable artifacts and serialized
records retain their existing limits.

Qualification must cross both boundaries. The supplied-runtime fixture hashes
large source and dependency files into small outputs, executes preparation and
the gate, records, and verifies in a fresh clone without the original attempt
store. Tail-byte changes must invalidate the relevant check. A source-level
reader test alone cannot prove that the executor and foreign verifier selected
the correct reader, and a small fixture cannot expose an evidence-size limit
accidentally reused for source hashing.

Pin the reverse boundary at the caller too: accept a small valid workflow
release receipt, reject the same valid receipt padded beyond 2 MiB, and accept
the restored small receipt. Invalid JSON cannot prove the size boundary, since
parsing would reject it even through the wrong reader. Both native tests and
the supplied-runtime qualifier need this control; a capped reader unit test
does not catch a caller routing metadata through the unbounded source reader.

For multi-megabyte buffers, assert exact equality with `Buffer.equals`, rather
than asking the test framework to recursively compare millions of indexed
properties. The latter spent 4.24 seconds locally and exceeded the hosted
five-second test budget; native byte comparison reduced the same three tests
to 9 ms without changing their inputs, byte-equality claim, or timeout.

## Reuse verified bytes only within a pinned reader

Overlapping scoped checks can spend more time reading the same Git objects than
running their compilers. In a pinned Athena consumer, four conservative checks
covering 4,388 files spent 348 seconds in native preparation before dependency
installation or compilation. The two package compilers themselves took about
57 and 7 seconds without Git context. Measure preparation, private setup, and
compiler execution separately before attributing a slow gate to its checks.
Reader-local reuse prepared the identical pinned tree in 99 seconds; this is an
observed wall-time comparison on a shared machine, not a throughput guarantee.

A reader already owns an immutable tree listing and a fixed size policy. It can
share a pending blob read by object ID and retain its result after exact object
hash verification. Keep that map inside the reader: a new reader must verify
again, and a bounded evidence reader must never borrow an unbounded source
reader's result. Remove rejected reads so a later attempt can verify corrected
transport. Return copies of retained buffers so callers cannot change the bytes
that subsequent checks will hash. Resolve paths and symlinks through the same
containment checks on every access.

Compare input and profile digests using the same candidate, configuration, and
runtime observation before and after this optimization. A newly installed
release legitimately changes release-bound identity; that is separate from
proving that verified-byte reuse preserves the identity algorithm. Pin actual
Git call counts as well as elapsed time, and include corruption, new-reader,
size-boundary, concurrent-read, and caller-mutation controls.
