# Spec errata — `delivery-evidence/1` working draft (25 August 2026)

Three places where the vendored spec's text
([`docs/spec/delivery-evidence-1.md`](spec/delivery-evidence-1.md)) and the
shipped behavior of this repository's kernel and conformance kit do not say
exactly the same thing. Each entry records what the spec says, what the
implementation does, and why the implementation's reading is the one shipped.
The spec's normative text is vendored and has **not** been edited; these are
candidates for the next spec revision, recorded honestly rather than resolved
here.

## E1. Appendix B `uniqueItems` is stricter than RG-2

**What the spec says.** The normative reviewer rules constrain uniqueness only
for `reviewers.selected`: RG-2 requires `selected` to be "non-empty with
unique, non-empty entries", and RG-3 requires `completed` to be *set-equal* to
`selected` and `failed`/`timedOut` to be empty — none of which forbids a
duplicated entry inside `completed`. Appendix B, however, defines one shared
`reviewerList` schema with `uniqueItems: true` and applies it to **all four**
lists.

**What the kernel and kit do.** The validator implements the rule tables
literally: uniqueness is enforced on `selected` only; a payload with
`selected: ["a"]`, `completed: ["a", "a"]` violates no rule in §9.3 and is
accepted by the validator — while failing Appendix B's schema. The published
schemas ([`packages/kernel/src/validator/schemas/`](../packages/kernel/src/validator/schemas/))
reproduce Appendix B verbatim, so the discrepancy is preserved, not papered
over. No kit vector exercises a duplicated `completed` entry, so the kit is
silent on the case.

**Why this reading shipped.** §8 declares the division of authority in so many
words: "The JSON Schemas in Appendices A–B are necessary but not sufficient:
schema checks shape; conformance is defined by these rules." Where the two
disagree, the rules win — that is the spec's own instruction. The residual
tension is that a rules-conformant payload failing the schema contradicts
"necessary", which is exactly why this is an erratum: either RG-2/RG-3 should
constrain the other lists, or Appendix B's `uniqueItems` should apply to
`selected` alone. That choice belongs to a spec revision, not to this
implementation.

## E2. ENV-12 rejects the two defined non-`self` levels

**What the spec says.** ENV-12: "`attestation.level` MUST be one of the three
defined levels" — read literally, `provider-signed` and
`independently-verified` *are* defined levels and satisfy ENV-12. ENV-8 even
legislates for them (a non-`self` manifest must name its repository),
implying such a manifest can otherwise be valid.

**What the kernel and kit do.** The kernel rejects **any** level other than
`self` with `unsupported_attestation`, defined levels included. The kit pins
this reading: the `env-8-repository-required` vector submits a
`provider-signed` manifest with an empty signatures array and expects the code
floor `["repository_required", "unsupported_attestation"]` — a defined level
drawing the code ENV-12's text reserves for undefined ones.

**Why this reading shipped.** §7 states that `self` "is the only level fully
specified in version 1"; the signing profile that would give the other two
levels their semantics does not exist yet. A validator that accepted
`provider-signed` structurally would be accepting a claim it cannot check —
precisely the laundering §11.4 forecloses for the signatures array (ENV-13
already maps a non-empty signatures array to `unsupported_attestation` for
this reason). The shipped rule extends that logic from the signature bytes to
the level token itself: below a published signing profile, a non-`self` level
is an unverifiable assertion and fails closed. A spec revision should say so
in ENV-12's own text rather than leaving it implied by §7's scope note and
pinned only by the kit.

## E3. ENV-6's two requirements are coded across two registry rows

**What the spec says.** ENV-6 carries two requirements in one rule:
`candidate.deliverable.identity` must exactly equal an implemented identity
version, **and** `candidate.deliverable.digest` must be 64-hex lowercase. Both
the §8.2 table and Appendix D attribute a single code to ENV-6:
`unsupported_identity_version`.

**What the kernel and kit do.** The version-token half emits
`unsupported_identity_version` (tagged ENV-6). The digest half — and a missing
or malformed `deliverable` block generally — emits `malformed_field` under
GEN-4, the generic identifier/digest grammar rule. The kit agrees:
`env-6-unknown-identity-version` expects `unsupported_identity_version`, while
`env-6-missing-identity` expects `malformed_field`.

**Why this reading shipped.** GEN-4 already governs every field "this spec
defines as an identifier or digest" uniformly; the deliverable digest is such
a field, and giving its shape violation a second, ENV-6-specific code would
make one grammar failure report under two vocabularies depending on which rule
table a reader started from. The shipped split reserves ENV-6's own code for
the half only ENV-6 expresses — the fail-closed version-token match — and
leaves field grammar to the rule that owns field grammar. A spec revision
should either add `malformed_field` to ENV-6's code column (as Appendix D
already does for ENV-7) or move the digest-shape sentence into GEN-4's orbit
explicitly.
