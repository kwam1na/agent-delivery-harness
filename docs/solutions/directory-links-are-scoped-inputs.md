# Preserve directory links in scoped source identity

A conservative consumer closure can include every committed entry, including
directory symlinks installed by the workflow product. Athena's publishing
partition did exactly that: all 5,867 captured paths included 23 directory links.
Resolving those links through a reader that only recognized regular files
returned null and failed the membership-versus-bytes invariant before execution.

Do not remove the links or replace them with their physical descendants. A link
retargeting is itself a source change, and alias paths are not additional entries
in the committed inventory. For a tracked directory link, the source reader
hashes the verified target Git tree object and preserves the complete link
chain in metadata. A tree object binds descendant names, modes and object IDs,
including nested changes, without reading every descendant again. Ordinary
physical directories remain absent from the file inventory. The bounded
portable-evidence reader continues to accept regular files only.

Verify the object using its actual Git type and retain reader-local cache
isolation, rejection retry and defensive buffer copies. Path containment and
cycle checks still run before cached bytes are returned. Directory identity is
not snapshot materialization: the executor must preserve the actual symlink
and target files, not write tree-object bytes into the checkout. The regression
therefore runs native preparation, execution, recording and verification in
both Git modes, then verifies from a separate clone. Unit tests separately pin
retargeting, nested membership/content/mode changes and corrupt tree transport.
