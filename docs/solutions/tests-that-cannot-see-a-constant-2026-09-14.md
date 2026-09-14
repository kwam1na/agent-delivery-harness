# Tests that cannot see a constant

Written out of V26-1486, where seven review rounds found the same defect seven
times wearing different clothes. The unit under review was fine by round 4. The
*evidence* was not, and the reason it was not is general enough to be worth
stating once rather than rediscovering.

## The shape

A function builds a record out of its inputs — here, `planExternalAction`
binding an authorized merge or deployment into an intent carrying eighteen
members. The obvious test asserts the members:

```ts
expect(result.intent.candidate).toBe(TREE);
expect(result.intent.baseTipSha).toBe(BASE);
expect(result.intent.invocationFence).toBe(9);
```

Every one of those passes. They also pass if the function ignores its input and
returns a constant, because **the fixture supplied the same literal the
assertion expects**, and nothing in the test distinguishes "carried through"
from "hard-coded". Plant `candidate: TREE` as a literal in the product and the
suite stays green.

Two variants of the same blindness showed up:

1. **One-sided equality probes.** A test that checks two approvals compare equal
   and one pair compares unequal pins nothing if both unequal probes sit on the
   *same side* of the comparison. Mutate `<` to `>` and the suite does not
   notice. Round 5 found eleven such sites; round 6 found the two the
   enumeration had missed, which is the tell that enumerating sites is the wrong
   response.
2. **Constant-substitutable members.** Round 7 named eight intent members whose
   fixture value was shared with some other fixture, so substituting one for the
   other survived. The replay found a ninth — `evidence` — that the enumeration
   had missed for exactly the same reason.

## The rule that actually closes it

Not "assert more members". Two rules, applied to the whole object:

- **Assert the whole record at once, with `toStrictEqual`, against literals.**
  Member-at-a-time assertions can only catch the members someone thought of.
  `toStrictEqual` over the returned object catches the member nobody thought of,
  including one that appeared with value `undefined` — which `toEqual` accepts
  and which the kernel's own `checkClosed` would reject as `unknown_member`.
- **Give every member a value distinct from every other member's, and from
  every other fixture's.** Diversify the fixture until no two slots can be
  swapped without a visible difference: a second delivery id, a different tree
  and base, its own fence, its own epochs. A shared `"a".repeat(64)` in two
  slots is a hole with a test wrapped around it.

For comparison functions, probe **both directions** across the boundary, and
check the operand you moved is not pinned at a vocabulary extreme — a probe
using `"f".repeat(64)` for a hex digest cannot sort above anything, so the other
operand has to move down instead. That one cost a round.

## How to know it worked

Plant the mutant. Not "review the test" — plant it. Change the member to a
constant, run the file, and require a red. Both lenses on this ticket re-planted
independently rather than accepting the kill claims, and that is what caught
the two survivors in round 5.

One operational note, learned the expensive way: restoring a planted mutant with
`git checkout -- <path>` in a worktree that also holds uncommitted delivery
edits destroys those edits. Commit before planting, or snapshot the file outside
the worktree and restore with `cp`.
