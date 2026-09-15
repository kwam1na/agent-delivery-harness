# A vector table that says it is derived from a list, and is not

Three consecutive review rounds of V26-1485 found the same defect wearing
three different faces. It is worth naming, because the shape is common and
each face looked like a different bug.

## The shape

A rule is written over a **frozen list** — a vocabulary, a corpus, an
enumeration the product walks in full. The evidence for the rule is a table of
**hand-picked vectors**, one per list entry the author thought of, under a
comment saying the table is derived from the list.

It never is. A hand-written literal cannot fall behind a list it does not
read, because it does not read it. And the comment is the dangerous half: the
next reader believes coverage that is not there, and the next author widens
the list without touching the table.

## The three faces it wore here

1. **Round 6.** `SPINE_ID_SHAPED_SECRETS` listed six of the nine secret
   patterns "composed from `SECRET_PATTERNS`". It was a literal of six pairs.
   `slack-token` is spine-id spellable and was missing, so one seventh of the
   hazard was pinned by nothing and a product probe skipping exactly that
   pattern stayed green. Every vector was also all-uppercase, so the rows could
   not tell the corpus probe apart from a "credential material is mixed case"
   heuristic.
2. **Round 7.** The fix classified all nine patterns and asserted the keys
   *are* the corpus — which closed the "falls behind a new entry" half. The
   other half, the entries claiming "no identifier can spell this one", was
   certified by asking whether the pattern's regex **source text** mentioned
   whitespace. `\s*`, `[\s\S]` and a space inside a character class all satisfy
   that while requiring no whitespace at all, so widening a pattern from `\s+`
   to `\s*` — the most ordinary edit a credential pattern receives — made it
   spellable with the row green.
3. **Round 7, the smaller face.** A spelling quietly deleted from the table
   would have restored the round-6 charset-heuristic survivor, because nothing
   said which spellings the table owed.

## What actually closes it

- **Assert the table's keys ARE the list.** Not "every key is in the list" —
  the converse. Then a tenth entry turns the row red the day it lands, until
  someone classifies it.
- **Check the thing, not its description.** A property of a pattern is tested
  by running the pattern, never by reading its source. The round-7 check
  passed on `[\s\S]` — the idiom for "any character" — while claiming to have
  proved "requires whitespace".
- **Derive what the table owes.** If a shape accepts a lowercase spelling, the
  table owes one; if an entry claims a negative, it owes the witnesses that
  would refute it. Both are computable from the list itself.
- **Say what sampling proves.** Sampling cannot establish a universal. Where
  the delivery genuinely depends on one — here, that the wire rule consults the
  WHOLE corpus rather than a subset — pin that universal separately and say in
  the comment which row pins it. Overclaiming in a comment is not a smaller
  defect than under-testing; it is the same defect with a reader attached.

## The cost, recorded honestly

V26-1485 declared a review bound of 4 and extended it four times. Every
extension was recorded before its round opened and every finding was fixed
in-delivery with none deferred, but four extensions is not a healthy loop. The
loop was long for one reason: each fix introduced the next round's finding in
the same test row, because the first three fixes treated the symptom (add the
missing vector) rather than the shape (make the table incapable of falling
behind the list). The lesson is to reach for the derivation the first time the
symptom appears.

## The same shape again, three floors down (rounds 8-13)

The loop above ended at round 8, and then ran five more rounds on the same
defect wearing different clothes. Recorded here because the repetition is the
finding.

- **Round 8 (P3).** A comment claimed that skipping any single corpus pattern
  turns a row red. True for the seven spine-id spellable patterns; false for
  the two that require whitespace, because the only row exercising the wire
  rule against the corpus iterated the spellable seven. Closed by asserting
  the universal over `SECRET_PATTERNS` itself, with a whitespace-bearing value
  for the two.
- **Round 9 (P2).** The shipped simulator's `mint` claimed "every field is
  overridable so a corpus can bend exactly one". Six of ten declared overrides
  were honoured by nothing a row could tell apart from a hardcoded default,
  and `messageId` — the member the round-5 P0 turns on — could not be bent at
  all, so the conformance kit could not mint this delivery's own most
  important vector. Closed by making the declared surface a value
  (`SIMULATED_MESSAGE_OPTION_NAMES`) and bending every name on it.
- **Round 10 (P3).** That fix's remaining claim — the kit "declares every
  member of the message" — was circular: "every member" meant "every member we
  remembered to declare". A member added to the wire and hardcoded in `mint`
  typechecked clean and left the suite green. Closed by typing the record over
  the message's own members as well as the options interface.
- **Rounds 11 and 12 (P3 each).** The comment describing that type claimed
  four compile-time guards where three hold, then, corrected, claimed two.
  Each correction cost a full round because a comment in a source file is not
  review-neutral: the tree moves, and a closed round must bind the tree the
  record carries.

Four of those five findings are the same sentence pattern: **a universal
stated in prose over a set, pinned over the subset the author enumerated.**
The delivery's own remedy idiom — assert that the table's keys ARE the list —
existed in the candidate from round 6 onward and was simply not reached for
the next three times the shape appeared, in a doc comment, in an API claim,
and in a type.

Two rules worth carrying:

- **A claim about an API is an API surface.** "Every field is overridable" is
  as much a contract as the signature above it, and it owes a row for the same
  reason. The kit here was a shipped conformance kit, so its override surface
  was product, not scaffolding.
- **Prose corrections are not free.** Under a review protocol that binds a
  closed round to a tree SHA, correcting a comment costs a whole round. Write
  the comment at the precision you can defend the first time, or say less. The
  delivery paid two rounds — roughly 530,000 lens tokens — for two sentences.
