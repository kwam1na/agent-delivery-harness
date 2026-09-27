# Bind recovery acknowledgement to the action history

An orphan successful action observation made ordinary resume permanently
inconsistent. External inspection proved the push had completed, but a late
intent or repeated observation could neither repair the journal nor honestly
reconstruct the missing past. The failing real-CLI regression in
`packages/cli/src/ordinary-resume.test.ts` demonstrates this boundary.

The supported recovery is an explicit host-attested acknowledgement, bound to
the complete action history and exact current reference. Validate that binding
under the store's append lock and preserve the original prefix byte-for-byte.
Use the same reducer for recovery display and append validation. A later
conflict needs another inspection; replaying the old acknowledgement's event ID
must not clear it. Unrelated observations should not invalidate an action.

The store suite exercises wrong reference/run, stale history, competing appends,
transport retries, later conflicts and tampered history. The CLI suite proves
that clearing the action inconsistency does not satisfy candidate admission.
External verification is still the host's responsibility, never an inference
from a digest or a successful append.

Closed event grammars impose a runtime compatibility floor after first emission.
Qualify downgrade refusal and restoration of the same journal on re-upgrade;
never present lifecycle rollback as proof that an older reader understands the
new observation. Policy rollback on a compatible runtime is a separate operation.
