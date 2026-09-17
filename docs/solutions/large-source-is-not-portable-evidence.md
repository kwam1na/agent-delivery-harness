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
