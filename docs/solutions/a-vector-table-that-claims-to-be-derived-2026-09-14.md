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
