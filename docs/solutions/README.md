---
title: What a solution note is
date: 2026-09-13
---

# Solution notes are dated records, not current documentation

**Read this before you read a note.** Every file in this directory is a
historical snapshot: what was true, what was decided, and why, on the date in
its front matter. A note is written when a delivery lands and is not maintained
afterwards. A later delivery falsifying one of its claims is expected, not a
defect, and the note is not edited when that happens.

So: **never treat a sentence in this directory as a statement about the tree you
are looking at.** Read it for the reasoning, the shape of the problem, and the
decision. Check every concrete claim — a path, a command, a config value, a
count — against the tree before you act on it.

## Where the current answer lives instead

| Question | The current answer |
| --- | --- |
| What does the repository require of a delivery? | [`AGENTS.md`](../../AGENTS.md) |
| How is one item delivered here? | [the delivery runbook](../delivery-runbook.md) |
| What do the modules and sensors hold? | [the agent guide](../agent-guide.md) |
| What does the managed product do? | [the managed-delivery guide](../managed-delivery.md) |
| What is policy? | the documents under `.agents/policy/`, and the artifacts they name |

Those are current documentation and are maintained. Several of them are pinned
to the tree by sensors in [`docs/docs-references.test.ts`](../docs-references.test.ts)
— links, computable counts, and, since V26-1513, the managed-delivery guide's
milestone-gate claims. This directory carries no such pin, deliberately.

## How a correction is recorded

Not in the note. A delivery that falsifies an earlier note:

1. fixes the **current** documentation and the artifact the claim was about,
   because that is what the next reader acts on; and
2. writes its own note, dated its own day, if it taught the system something
   reusable.

The older note keeps its date and its original text. Two notes disagreeing is
the corpus working as intended: the reader compares dates. The one edit this
posture permits to a landed note is metadata that makes its date legible — the
three 2026-09-12 notes were given the front matter the rest of the corpus
already carried, and no claim in any note was changed by that delivery.

## Why this rather than a maintenance obligation

V26-1504 surveyed the corpus before choosing, because the cost of the
alternative depends entirely on how fast notes rot. Of the nine notes standing
at `96fccb9`, **two** carried claims that later deliveries had already
falsified, and between them they carried **eleven** such claims:

- `harness-self-policy-projection-and-shadow-window-2026-08-31.md` — nine,
  including the `fetch-depth: 0` change that raised V26-1504, a workflow count
  that a fourth workflow moved, a `scripts/shadow-discovery-guard.ts` and a
  milestone scorer that V26-1534 retired, an `npm run sensor:shadow` script that
  no longer exists, and charters that moved out of `delivery/personas/`.
- `qualifying-a-composed-product-from-packed-artifacts-only-2026-08-31.md` —
  two product defects it records in the present tense as open, both since
  repaired and both recorded closed in
  [`qualifications/product-qualification.json`](../../qualifications/product-qualification.json).

Eleven falsifications in under two weeks, from deliveries that had no reason to
read these files at all. That is the number that decides it. Keeping the corpus
current would mean every delivery re-reading nine notes for claims its diff
happens to touch, and "remember to check the notes" is not a mechanism. The only
real mechanism would be a sensor, and a sensor over narration is exactly what
`harness.config.ts` declines to ask for: `docs/solutions/` is
`reviewNeutral`, so these files are not even review-relevant. A corpus nobody
reviews cannot carry a maintenance obligation anybody keeps.

The stale sentences therefore stay exactly as written, including the CI-depth
sentence that raised V26-1504. They are correct as of their date, which is all
they ever claimed to be.

This is one posture with one boundary, not a split: a document is current
documentation and pinned where a sensor names it, or it is a dated record and
unmaintained. `docs/solutions/` is entirely the second. Nothing here is
sometimes one and sometimes the other.

## The notes

| Date | Note |
| --- | --- |
| 2026-09-12 | [Qualify the executable boundary and retained review coordinates](bundled-cli-cancellation-and-review-transport.md) |
| 2026-09-12 | [Scoped check proof and final delivery binding](scoped-check-evidence.md) |
| 2026-09-12 | [Scoped checks execute from private prepared source](scoped-check-execution.md) |
| 2026-09-07 | [Keep live run pages readable as observations change](keeping-live-run-pages-readable-2026-09-07.md) |
| 2026-08-31 | [An attestation expiry that ages into a red suite](an-attestation-expiry-that-ages-into-a-red-suite-2026-08-31.md) |
| 2026-08-31 | [Close two product defects that only the packed surface can see](closing-two-packed-surface-product-defects-2026-08-31.md) |
| 2026-08-31 | [Project a repository into the layered policy model when that repository implements the policy compiler](harness-self-policy-projection-and-shadow-window-2026-08-31.md) |
| 2026-08-31 | [Qualify a composed product from packed artifacts only, in disposable repositories](qualifying-a-composed-product-from-packed-artifacts-only-2026-08-31.md) |
| 2026-08-31 | [Ship a default reviewer persona set as archive content](shipping-a-default-reviewer-persona-set-across-two-repositories-2026-08-31.md) |

This table is itself a dated record. A note added after 2026-09-13 may not be in
it; the directory listing is authoritative.
