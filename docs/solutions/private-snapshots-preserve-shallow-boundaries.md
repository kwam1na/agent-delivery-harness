# Preserve the source shallow boundary during private transfer

A private snapshot fetches the prepared tree, original HEAD and pinned base
into a fresh repository. A valid shallow source deliberately lacks ancestors
beyond its recorded boundary. Fetching without accepting that boundary can fail
while traversing a missing ancestor. With distinct requested commits it can
instead return zero, warn that shallow roots cannot be updated, and leave the
destination without the boundary. Exit status alone does not prove transfer.

Use `--update-shallow` on the private fetch. It accepts the source boundary in
the destination; it neither expands the author's history nor shares writable
objects or metadata. Required trees and commits must still exist. Missing
required objects continue to refuse snapshot creation.

Test both equal and distinct HEAD/base identities, exact staged bytes, pinned
refs, an unavailable ancestor beyond the boundary, and the author's unchanged
index and shallow file. Compare the destination boundary as a set: Git can
repeat the same shallow root while fetching multiple objects. Require actual
snapshot verification in both Git modes, then exercise the native delivery
lifecycle and record verification from a separate shallow clone. Commit the
source candidate before the portable record fixture so its reviewed tree is
reachable in that foreign clone; an unreferenced staged tree is not transferred
by an ordinary clone.
