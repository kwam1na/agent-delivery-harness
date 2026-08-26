# Delivery Evidence

**Delivery Evidence v1** — Working draft · 25 August 2026

A normative contract for the evidence an autonomous coding agent must produce
before its change is admissible for merge — what a claim of completed review is,
what binds it to an exact tree, and when it goes stale.

| | |
|---|---|
| envelope | `delivery-evidence/1` |
| payload | `review.green/1` |
| identity | `deliverable-tree/v1` |

## Contents

1. Status & scope
2. Terminology
3. Design principles
4. Data model
5. The envelope
6. Canonical form & digests
7. Attestation levels
8. Validation rules
9. Payload: `review.green/1`
10. Versioning
11. Security considerations
12. Out of scope
- A. Envelope schema
- B. Payload schema
- C. Complete example
- D. Rejection codes

---

## 1 Status & scope

This document defines `delivery-evidence/1`: the manifest format by which an
**evidence provider** (an agent framework, orchestration tool, or review
process) submits machine-verifiable evidence that one or more **obligations** —
beginning with a completed code review — were satisfied against an exact
repository **candidate**.

The specification governs *what constitutes admissible evidence of a completed
process*. It deliberately takes no position on *how* that process is conducted:
reviewer selection, models, prompts, and methodology belong to the provider. A
conforming validator judges only structure, binding, freshness, and policy
compliance.

This is a working draft. It generalizes a production contract that has gated
agent-delivered merges in a live monorepo since mid-2026; the rule set in §8 and
§9 is a restatement of that contract against the generalized shape defined here.

---

## 2 Terminology

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described
in RFC 2119.

| Term | Meaning |
|---|---|
| Obligation | A named requirement a repository's gate imposes before merge admission (e.g. `review.green`). Obligations are either **live facts** the gate computes itself, or **historical-evidence** obligations satisfied by a recorded manifest. This spec covers the latter. |
| Provider | A named system that conducts a process and attests to its result by submitting a manifest. Registered per-repository, per-obligation. |
| Run | One provider execution, identified by `runId`, producing at most one manifest. |
| Pass | One prepare-and-evaluate iteration within a run. The **final pass** is the one whose prepared tree is the candidate being submitted. |
| Candidate | The exact repository state under evaluation: a tree object plus its base coordinates, captured in a **prepared** (no unstaged, no untracked) state. |
| Deliverable identity | A versioned digest over the candidate's tree entries **excluding declared narration paths** (delivery reports, solution notes, run telemetry). Evidence freshness is judged against this identity, so post-review narration does not invalidate a review. |
| Claim | One assertion inside a manifest that a specific obligation was satisfied by this run, carrying an obligation-typed payload. |
| Recorder | The trusted local component (CLI/SDK) that validates a submitted manifest and, on acceptance, writes one evidence record per claim. |
| Evidence record | The per-obligation, content-addressed unit the gate later consults. Records are derived from manifests; manifests are submissions, records are evidence. |
| Gate | The merge-admission evaluator that resolves each obligation from records, live facts, waivers, or delegation. Gate policy is out of scope here except where it constrains manifest validity. |

---

## 3 Design principles

These principles are normative in spirit; the rules in §8 are their mechanical
form.

1. **Evidence binds to trees, never to time.** Freshness is a property of content
   identity. No validator decision may consult a timestamp (GEN-5).
2. **Fail closed.** Unknown versions, unknown fields, and unverifiable references
   are rejections, never degradations.
3. **One run, one manifest, many claims.** The submission unit is the provider
   run; the evidence unit is the obligation. The recorder splits an accepted
   manifest into per-claim records so obligations keep independent lifecycles.
4. **All claims bind to the final pass.** Evidence about an earlier pass
   describes a tree that no longer exists. A process not re-run on the final
   candidate has no claim to make.
5. **Admissibility, not methodology.** The spec never prescribes *how* to review
   — only what a completed review must be able to show.
6. **Self-consistency is checked, not trusted.** Where a manifest states a fact
   derivable from its own contents (finding counts, deferral sets), the validator
   re-derives and rejects mismatches.

---

## 4 Data model

A manifest is a single JSON document with two regions:

- **The envelope** — obligation-agnostic, owned by `delivery-evidence/1`:
  provider and run identity, the candidate binding, run history, the artifact
  pool, and attestation.
- **The claims array** — one entry per obligation, each carrying a payload typed
  and versioned by its own payload spec (e.g. `review.green/1`, §9).

On acceptance, the recorder writes one evidence record per claim. Every record
carries the shared `manifestDigest` (§6), so records from one run remain joinable
for audit while resolving independently at the gate.

```
manifest (1 run × 1 candidate × 1 attestation)
├─ claim: review.green ──▶ record (review.green, candidate, digest)
└─ claim: security.reviewed ──▶ record (security.reviewed, candidate, digest)
```

---

## 5 The envelope

### 5.1 `spec`

**`spec`** · required
The literal string `"delivery-evidence/1"`. Version strings are exact-match
tokens (§10).

### 5.2 `provider`

**`provider.id`** · required
Lowercase slug identifying the provider, e.g. `claude-code.ce-code-review`. Must
be registered in repository configuration for every obligation claimed.

**`provider.version`**
Provider software version. Informational.

**`provider.runId`** · required
Opaque run identifier. A single path component: no separators, no traversal.

**`provider.finalPassId`** · required
Identifier of the final prepare-and-evaluate pass. Cross-checked against
`runHistory` (ENV-9).

### 5.3 `candidate`

**`candidate.vcs`** · required
`"git"` in this version.

**`candidate.treeSha`** · required
The raw git tree object of the prepared candidate. The recorder requires exact
equality with the currently prepared tree at submission time (SUB-1).

**`candidate.headSha`**
The commit at capture time. Informational — evidence binds to trees, so a rebase
preserving the tree preserves the evidence.

**`candidate.deliverable.digest`** · required
The deliverable identity digest: SHA-256 over the candidate's sorted tree entries
(`mode\0objectSha\0path\0`) excluding the repository's declared narration paths,
domain-separated by the identity version string.

**`candidate.deliverable.identity`** · required
The identity algorithm version, e.g. `"deliverable-tree/v1"`. The narration-path
set is part of the algorithm; changing it is an identity rev that strands prior
evidence by design.

**`candidate.base.ref`** · required
The base ref the delivery targets, e.g. `"origin/main"`.

**`candidate.base.tipSha`** · required
The base ref's tip at capture. Base movement stales evidence.

**`candidate.base.mergeBaseSha`** · required
The merge base of candidate and base — the diff origin.

**`candidate.workspaceId`** · required
Digest identifying the workspace (worktree) where the candidate was prepared.
Scopes self-attested evidence to the machine that produced it: level-`self`
evidence is non-portable by construction.

### 5.4 `repository`

**`repository`**
Repository identifier (URL or org-assigned id), or `null`. MUST be present and
non-null when `attestation.level` is not `"self"` — signed evidence is portable
and must name its subject (ENV-8).

### 5.5 `runHistory`

An ordered, non-empty array recording every prepare-and-evaluate iteration of the
run:

```json
{ "preparedTreeSha": "<tree>", "evaluatedInPassId": "<pass>" }
```

The final entry MUST name the candidate's tree and the provider's final pass.
This is the anti-smuggling invariant: whatever landed last was prepared and
evaluated in the final pass. There are no per-claim pass identifiers — a claim
that cannot bind to the final pass does not belong in the manifest (§3, principle
4).

### 5.6 `artifacts`

The shared evidence-file pool for all claims. Each entry:

```json
{ "path": "reviewers/security.json", "sha256": "<64-hex>", "role": "reviewer-approval" }
```

**`path`** · required
Relative to the recorder-allocated run root. No absolute paths, no `..` segments;
resolved paths must remain inside the run root.

**`sha256`** · required
Digest of the file's bytes, verified at submission. Makes the bundle
tamper-evident and portable.

**`role`** · required
Open slug. Payload specs define the roles they require and the content contract
for each (e.g. §9.2).

### 5.7 `attestation`

**`attestation.level`** · required
One of `"self"`, `"provider-signed"`, `"independently-verified"`. See §7.

**`attestation.signatures`** · required
Reserved. In `delivery-evidence/1` this MUST be the empty array; a signing profile
will accompany a future minor spec once signature semantics are defined with
implementing vendors. Validators reject non-empty signatures rather than ignoring
what they cannot verify (ENV-13).

### 5.8 `recordedAt`

**`recordedAt`** · required
RFC 3339 timestamp. Informational only. No validator or gate decision may depend
on it (GEN-5).

### 5.9 `claims`

Non-empty array. Each entry:

```json
{ "obligation": "review.green", "payloadSpec": "review.green/1", "payload": { "…": true } }
```

Obligation ids MUST be unique within a manifest. The `payloadSpec` names the
payload's own versioned contract and doubles as the registry key: repository
configuration declares which payload specs it accepts per obligation. Validation
is atomic across claims (GEN-3).

---

## 6 Canonical form & digests

The canonical form of a manifest is its RFC 8785 (JCS) canonical JSON
serialization.

The manifest digest is:

```
manifestDigest = lowerhex( sha256( JCS( manifest with attestation.signatures := [] ) ) )
```

Excluding the signature array from the digested form means future signatures sign
the digest without self-reference, and a level-`self` manifest and its
later-countersigned form share one content identity. The recorder computes
`manifestDigest` on acceptance and stamps it into every evidence record derived
from the manifest.

All digests in this specification are lowercase hexadecimal SHA-256 unless a
field states otherwise. Git object ids are 40-hex (SHA-1 object format);
repositories using git's SHA-256 object format are out of scope for version 1.

---

## 7 Attestation levels

| Level | What it proves | Mechanism | Portability |
|---|---|---|---|
| `self` | Process discipline: the evidence is fresh, complete, structurally coherent, and policy-compliant. | Structural validation by the local recorder (§8–§9). The submitting orchestrator authors its own manifest. | Workspace-scoped. Not portable. |
| `provider-signed` | Provenance: the named provider actually executed this run and produced this manifest. | Provider-held key countersigns the manifest digest. Signing profile reserved (§5.7). | Portable; repository required. |
| `independently-verified` | Judgment: a party other than the deliverer examined the candidate. | Verification service or bound human approval countersigns. Profile reserved. | Portable; repository required. |

Repository gate configuration declares the minimum acceptable level per
obligation. Level `self` is the only level fully specified in version 1; it
defends against staleness, drift, and sloppiness — not against a fabricating
orchestrator (§11).

---

## 8 Validation rules

A conforming validator enforces every rule below. The JSON Schemas in Appendices
A–B are necessary but not sufficient: schema checks shape; conformance is defined
by these rules. Each rule names the rejection code it produces (registry in
Appendix D).

### 8.1 General

| Rule | Requirement | Code |
|---|---|---|
| GEN-1 | A manifest containing any member not defined by the envelope spec version — or, within a payload, by that claim's payload spec version — MUST be rejected. Lenient parsing is a smuggling channel; evolution happens by version rev, never by tolerated strangers. | `unknown_member` |
| GEN-2 | `spec` MUST exactly equal a version string the validator implements. | `unsupported_envelope_spec` |
| GEN-3 | Validation is atomic. If any rule fails for any claim, the entire submission MUST be rejected and no record written. Partial acceptance is prohibited. | (meta) |
| GEN-4 | Every field this spec defines as an identifier or digest MUST be non-empty and MUST match its declared pattern exactly. No trimming or normalization is applied before comparison. | `malformed_field` |
| GEN-5 | No validator or gate decision may consult `recordedAt` or any other time value to determine admissibility or freshness. Freshness is content identity. | (meta) |

### 8.2 Envelope

| Rule | Requirement | Code |
|---|---|---|
| ENV-1 | `provider.id` MUST match `^[a-z0-9]+([._-][a-z0-9]+)*$` and MUST be registered in repository configuration as an allowed provider for every obligation claimed. | `invalid_provider_id`, `unregistered_provider` |
| ENV-2 | `provider.runId` MUST be a single path component: 1–128 characters matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`, and MUST NOT equal `.` or `..`. | `invalid_run_id` |
| ENV-3 | `provider.finalPassId` and every `runHistory[].evaluatedInPassId` MUST be non-empty. | `invalid_pass_id` |
| ENV-4 | `candidate.vcs` MUST equal `"git"`. | `unsupported_vcs` |
| ENV-5 | `candidate.treeSha`, `candidate.headSha` (when present), `candidate.base.tipSha`, `candidate.base.mergeBaseSha`, and every `runHistory[].preparedTreeSha` MUST be 40-hex lowercase git object ids. | `invalid_object_id` |
| ENV-6 | `candidate.deliverable.identity` MUST exactly equal an identity version the validator implements; `candidate.deliverable.digest` MUST be 64-hex lowercase. An unknown identity version fails closed. | `unsupported_identity_version` |
| ENV-7 | `candidate.workspaceId` MUST be non-empty. | `malformed_field` |
| ENV-8 | When `attestation.level` ≠ `"self"`, `repository` MUST be present and non-null. | `repository_required` |
| ENV-9 | `runHistory` MUST be non-empty, and its final entry MUST satisfy `preparedTreeSha == candidate.treeSha` and `evaluatedInPassId == provider.finalPassId`. | `run_history_final_mismatch` |
| ENV-10 | `artifacts[].path` MUST be relative, MUST NOT begin with `/` or contain `..` segments, and MUST be unique within the manifest. At submission, each resolved (realpath) location MUST lie inside the recorder-allocated run root. | `artifact_path_invalid`, `artifact_path_duplicate`, `artifact_outside_run_root` |
| ENV-11 | Each `artifacts[].sha256` MUST equal the digest of the referenced file's bytes at submission. | `artifact_digest_mismatch` |
| ENV-12 | `attestation.level` MUST be one of the three defined levels. | `unsupported_attestation` |
| ENV-13 | In `delivery-evidence/1`, `attestation.signatures` MUST be the empty array. A validator MUST NOT accept a signature it cannot verify. | `unsupported_attestation` |
| ENV-14 | `claims` MUST be non-empty; `claims[].obligation` values MUST be unique; each `claims[].payloadSpec` MUST be accepted by repository configuration for that obligation. | `no_claims`, `duplicate_claim`, `obligation_not_configured`, `unsupported_payload_spec` |

### 8.3 Submission & recording

These rules bind the **recorder** — the transport is part of the trust model.

| Rule | Requirement | Code |
|---|---|---|
| SUB-1 | At submission the recorder MUST re-capture the current prepared candidate and require exact equality with `manifest.candidate` on **every** field, including the raw `treeSha`. Recording is strict on the raw tree so the recorded id is a trustworthy audit anchor; only later gate freshness comparisons are identity-based. | `candidate_mismatch` |
| SUB-2 | The recorder MUST require the candidate to be in a prepared state (no unstaged tracked changes, no untracked files) captured under the repository's preparation procedure. | `candidate_unprepared` |
| SUB-3 | The manifest MUST reside inside the run root the recorder allocated for `provider.runId`. Run roots are recorder-allocated, never provider-chosen. | `manifest_outside_run_root` |
| SUB-4 | On acceptance the recorder MUST write exactly one evidence record per claim, each stamped with `manifestDigest`. Record identity is the digest of (`workspaceId`, gate, obligation, candidate binding, `provider.id`, `runId`, `finalPassId`). Publication MUST be atomic; an existing record with identical identity and identical content is an idempotent success, and one with identical identity but different content MUST be rejected. | `record_conflict` |
| SUB-5 | A rejection MUST report every violated rule's code in one response — not first-failure only — and MUST NOT write any record. | (meta) |

---

## 9 Payload: `review.green/1`

The payload for a claim that an independent, complete code review of the final
candidate concluded green.

### 9.1 Fields

**`verdict`** · required
Literal `"green"`. A manifest is only submitted for a concluded, passing review;
there is no red manifest.

**`finalized`** · required
Literal `true`.

**`editedAfterFinalPass`** · required
Literal `false`. Together with ENV-9, asserts nothing changed after the final
reviewed pass.

**`reviewers`** · required
`{ selected[], completed[], failed[], timedOut[] }` — the structural facts of
whatever reviewer set the provider chose. The spec never constrains *which*
reviewers; only that the chosen set completed.

**`findings`** · required
Array (possibly empty) of every finding surfaced across the run, each with `id`,
`severity` (`P0`–`P3`), `scope` (`in_contract` | `adjacent` | `expansion`),
`actionable`, `blocking`, `disposition` (`resolved` | `advisory` | `pre_existing`
| `deferred` | `unresolved` | `ignored`), and optional `deferredIssueId`.

**`telemetry`** · required
`{ iterationCount, findingCounts{P0..P3}, deferredExpansionCount,
deferredIssueIds[], cost? }`. All fields except `cost` are re-derived and
cross-checked (RG-8).

### 9.2 The `reviewer-approval` artifact role

Each selected reviewer MUST be covered by exactly one artifact with role
`reviewer-approval` whose content is a JSON document:

```json
{
  "schemaVersion": 1,
  "reviewerId": "security",
  "result": "approved",
  "provider": { "id": "…", "runId": "…", "finalPassId": "…" },
  "workspaceId": "…",
  "candidate": { "…same shape and values as the envelope candidate…": true }
}
```

Approval stamps re-state the binding rather than referencing it, so each is
independently interpretable in an audit.

### 9.3 Rules

| Rule | Requirement | Code |
|---|---|---|
| RG-1 | `verdict == "green"`, `finalized == true`, `editedAfterFinalPass == false`. | `verdict_not_green`, `not_finalized`, `edited_after_final_pass` |
| RG-2 | `reviewers.selected` MUST be non-empty with unique, non-empty entries. | `reviewer_set_invalid` |
| RG-3 | `reviewers.completed` MUST be set-equal to `selected`; `failed` and `timedOut` MUST be empty. A degraded reviewer set is not green. | `reviewer_set_incomplete` |
| RG-4 | Artifacts with role `reviewer-approval` MUST exist in one-to-one correspondence with `selected`. Each MUST parse per §9.2 with `result == "approved"` and provider, workspace, and candidate values identical to the envelope's. | `approval_missing`, `approval_mismatch` |
| RG-5 | Finding `id`s MUST be non-empty and unique; `severity`, `scope`, and `disposition` MUST take defined enum values. | `finding_invalid` |
| RG-6 | No finding may have `blocking == true`, and every finding with `actionable == true` MUST have disposition `resolved`, `pre_existing`, or `deferred`. Green with unresolved or ignored actionable work is a contradiction. | `blocking_finding_present`, `actionable_unresolved` |
| RG-7 | Disposition `deferred` is legal only when all hold: `actionable == true`, `blocking == false`, `severity ∈ {P2, P3}`, `scope == "expansion"`, and `deferredIssueId` matches `^[A-Z][A-Z0-9]*-\d+$`. No P0 or P1 may ever be deferred, regardless of scope. `deferredIssueId` MUST be absent on any non-deferred finding. | `illegal_deferral` |
| RG-8 | `telemetry.findingCounts`, `deferredExpansionCount`, and `deferredIssueIds` (sorted, deduplicated) MUST equal the values re-derived from `findings`. | `telemetry_mismatch` |
| RG-9 | `telemetry.iterationCount` MUST equal the number of `runHistory` entries. | `iteration_count_mismatch` |
| RG-10 | When `telemetry.cost` is present: `unit` and `reportedBy` MUST be non-empty, `total ≥ 0`, keys of `byReviewer` MUST be a subset of `reviewers.selected`, and `sum(byReviewer) ≤ total`. Cost is provider-self-reported: below attestation level `provider-signed` a consumer MUST NOT treat it as verified, and a change of `reportedBy` in a trend is a series break, not a movement. | `invalid_cost` |

---

## 10 Versioning

- **Versions are domain-separation tokens, not ranges.** `delivery-evidence/1`,
  `review.green/1`, `deliverable-tree/v1` are exact-match strings that participate
  in digests and (future) signatures. There is no compatible-range semantics.
- **Envelope and payloads version independently.** A payload rev never forces an
  envelope rev, and vice versa.
- **Strict parsing is the evolution mechanism.** Because validators reject unknown
  members (GEN-1), any additive change is a new version string. A field a current
  validator ignores but a future one honors would be a smuggling channel; the
  rule forecloses it.
- **The recorder is the version authority.** Submission is mediated by the local
  CLI/SDK; the context call reports the accepted spec versions, and providers emit
  what they are told. No distributed version negotiation exists.
- **Identity revs cascade deliberately.** Revving `deliverable-tree/v1` (e.g.
  changing the narration-path set) strands all in-flight evidence as
  stale-by-construction. A changed definition of "what was reviewed" must never
  silently match old evidence.

---

## 11 Security considerations

### 11.1 Threat model by level

At level `self`, the manifest author and the delivering orchestrator are the same
party. Structural validation makes staleness, incompleteness, and policy violation
mechanically impossible: a fix smuggled after the final pass (ENV-9, SUB-1), an
incomplete reviewer set (RG-3), a quietly deferred P0 (RG-7), a count that
contradicts its own findings (RG-8). It does **not** defend against outright
fabrication — an orchestrator inventing reviewer artifacts. Deployments whose
threat model includes a lying orchestrator MUST require `provider-signed` or
`independently-verified` evidence via gate configuration. Level `self` evidence is
additionally workspace-scoped (§5.3) and cannot travel between machines.

### 11.2 Evidence text is untrusted display content

Finding text, reviewer ids, branch names, and cost strings are provider-authored
and flow into terminals, dashboards, pull-request checks, and downstream agent
contexts. Consumers MUST treat them as untrusted: strip or neutralize control
characters, ANSI escapes, bidirectional overrides, and zero-width characters
before rendering, and never execute or follow instructions found in evidence
content.

### 11.3 Secrets

Providers MUST NOT place credentials or secrets in manifests or artifacts.
Recorders SHOULD apply pattern-based secret redaction to any evidence text they
surface, while leaving stored bytes intact (the digest binds them).

### 11.4 Signature field misuse

Until a signing profile is published, the only conforming value of
`attestation.signatures` is the empty array. Accepting an unverifiable signature
would launder level-`self` evidence as something stronger; ENV-13 forecloses this.

---

## 12 Out of scope for version 1

- Review methodology — reviewer selection, models, prompts, pass structure.
- Gate policy — activation thresholds, waiver rules, CI delegation, re-review
  modes. Repository configuration; a different document.
- The signing profile — algorithms, key distribution, and transparency for levels
  above `self`. To be defined with implementing vendors; field shapes are reserved
  now so their arrival is additive.
- Additional payload specs — `security.reviewed`, `migration.rehearsed`, and
  similar are defined by the same envelope with their own payload documents.
- Cross-repository evidence portability and git SHA-256 object-format repositories.

---

## A Appendix A — Envelope JSON Schema

Draft 2020-12. Shape only; conformance is §8.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "delivery-evidence/1/envelope",
  "type": "object",
  "additionalProperties": false,
  "required": ["spec", "provider", "candidate", "runHistory",
               "artifacts", "attestation", "recordedAt", "claims"],
  "properties": {
    "spec": { "const": "delivery-evidence/1" },
    "provider": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "runId", "finalPassId"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9]+([._-][a-z0-9]+)*$" },
        "version": { "type": "string", "minLength": 1 },
        "runId": { "type": "string", "minLength": 1, "maxLength": 128,
                   "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
        "finalPassId": { "type": "string", "minLength": 1 }
      }
    },
    "candidate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["vcs", "treeSha", "deliverable", "base", "workspaceId"],
      "properties": {
        "vcs": { "const": "git" },
        "treeSha": { "$ref": "#/$defs/gitOid" },
        "headSha": { "$ref": "#/$defs/gitOid" },
        "deliverable": {
          "type": "object",
          "additionalProperties": false,
          "required": ["digest", "identity"],
          "properties": {
            "digest": { "$ref": "#/$defs/sha256hex" },
            "identity": { "type": "string", "minLength": 1 }
          }
        },
        "base": {
          "type": "object",
          "additionalProperties": false,
          "required": ["ref", "tipSha", "mergeBaseSha"],
          "properties": {
            "ref": { "type": "string", "minLength": 1 },
            "tipSha": { "$ref": "#/$defs/gitOid" },
            "mergeBaseSha": { "$ref": "#/$defs/gitOid" }
          }
        },
        "workspaceId": { "type": "string", "minLength": 1 }
      }
    },
    "repository": { "type": ["string", "null"], "minLength": 1 },
    "runHistory": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["preparedTreeSha", "evaluatedInPassId"],
        "properties": {
          "preparedTreeSha": { "$ref": "#/$defs/gitOid" },
          "evaluatedInPassId": { "type": "string", "minLength": 1 }
        }
      }
    },
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "sha256", "role"],
        "properties": {
          "path": { "type": "string", "minLength": 1 },
          "sha256": { "$ref": "#/$defs/sha256hex" },
          "role": { "type": "string",
                    "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" }
        }
      }
    },
    "attestation": {
      "type": "object",
      "additionalProperties": false,
      "required": ["level", "signatures"],
      "properties": {
        "level": { "enum": ["self", "provider-signed", "independently-verified"] },
        "signatures": { "type": "array", "maxItems": 0 }
      }
    },
    "recordedAt": { "type": "string", "format": "date-time" },
    "claims": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["obligation", "payloadSpec", "payload"],
        "properties": {
          "obligation": { "type": "string",
                          "pattern": "^[a-z0-9]+(\\.[a-z0-9-]+)*$" },
          "payloadSpec": { "type": "string", "minLength": 1 },
          "payload": { "type": "object" }
        }
      }
    }
  },
  "$defs": {
    "gitOid": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "sha256hex": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
  }
}
```

---

## B Appendix B — `review.green/1` JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "review.green/1/payload",
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "finalized", "editedAfterFinalPass",
               "reviewers", "findings", "telemetry"],
  "properties": {
    "verdict": { "const": "green" },
    "finalized": { "const": true },
    "editedAfterFinalPass": { "const": false },
    "reviewers": {
      "type": "object",
      "additionalProperties": false,
      "required": ["selected", "completed", "failed", "timedOut"],
      "properties": {
        "selected": { "$ref": "#/$defs/reviewerList" },
        "completed": { "$ref": "#/$defs/reviewerList" },
        "failed": { "$ref": "#/$defs/reviewerList" },
        "timedOut": { "$ref": "#/$defs/reviewerList" }
      }
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "severity", "scope", "actionable",
                     "blocking", "disposition"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "severity": { "enum": ["P0", "P1", "P2", "P3"] },
          "scope": { "enum": ["in_contract", "adjacent", "expansion"] },
          "actionable": { "type": "boolean" },
          "blocking": { "type": "boolean" },
          "disposition": { "enum": ["resolved", "advisory", "pre_existing",
                                    "deferred", "unresolved", "ignored"] },
          "deferredIssueId": { "type": "string",
                               "pattern": "^[A-Z][A-Z0-9]*-[0-9]+$" }
        }
      }
    },
    "telemetry": {
      "type": "object",
      "additionalProperties": false,
      "required": ["iterationCount", "findingCounts",
                   "deferredExpansionCount", "deferredIssueIds"],
      "properties": {
        "iterationCount": { "type": "integer", "minimum": 1 },
        "findingCounts": {
          "type": "object",
          "additionalProperties": false,
          "required": ["P0", "P1", "P2", "P3"],
          "properties": {
            "P0": { "type": "integer", "minimum": 0 },
            "P1": { "type": "integer", "minimum": 0 },
            "P2": { "type": "integer", "minimum": 0 },
            "P3": { "type": "integer", "minimum": 0 }
          }
        },
        "deferredExpansionCount": { "type": "integer", "minimum": 0 },
        "deferredIssueIds": {
          "type": "array",
          "items": { "type": "string", "pattern": "^[A-Z][A-Z0-9]*-[0-9]+$" }
        },
        "cost": {
          "type": "object",
          "additionalProperties": false,
          "required": ["unit", "total", "reportedBy"],
          "properties": {
            "unit": { "type": "string", "minLength": 1 },
            "total": { "type": "number", "minimum": 0 },
            "byReviewer": { "type": "object",
                            "additionalProperties": { "type": "number", "minimum": 0 } },
            "reportedBy": { "type": "string", "minLength": 1 }
          }
        }
      }
    }
  },
  "$defs": {
    "reviewerList": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "uniqueItems": true
    }
  }
}
```

---

## C Appendix C — Complete example

```json
{
  "spec": "delivery-evidence/1",
  "provider": {
    "id": "claude-code.ce-code-review",
    "version": "2.4.0",
    "runId": "r-01J9XQK3M8",
    "finalPassId": "pass-3"
  },
  "candidate": {
    "vcs": "git",
    "treeSha": "8fa31c29e4b7d6a15f0c3d82b9e47a6c51d90e2f",
    "headSha": "b02e974d1c8a35f6e29b70d4a8c163f5d2e98a01",
    "deliverable": {
      "digest": "d41f0a7c2e96b83d15a4c7f0e928b56d3a1c84f7e50b29d6c13a87e4f062958b",
      "identity": "deliverable-tree/v1"
    },
    "base": {
      "ref": "origin/main",
      "tipSha": "a0f9c96b3d21e85c47b06f9a2d38c51e74b09d6f",
      "mergeBaseSha": "48173d59e2c80b47a16d35f9c204e87b3a51d0c9"
    },
    "workspaceId": "w-3f9d1c85a2e70b64"
  },
  "repository": null,
  "runHistory": [
    { "preparedTreeSha": "11ab52c9d8e3f7061b4a29c5d80e6f13a7b45c92",
      "evaluatedInPassId": "pass-1" },
    { "preparedTreeSha": "56cd83f1a9b20e74d5c619a8f30b27e46d1c95a0",
      "evaluatedInPassId": "pass-2" },
    { "preparedTreeSha": "8fa31c29e4b7d6a15f0c3d82b9e47a6c51d90e2f",
      "evaluatedInPassId": "pass-3" }
  ],
  "artifacts": [
    { "path": "reviewers/correctness.json",
      "sha256": "9e2b4f70c1d58a36e94b27d0f83c15a6b49e07d2c85f13a60e97b24d8f051c3a",
      "role": "reviewer-approval" },
    { "path": "reviewers/security.json",
      "sha256": "77c1a58d29f04b36e81d57a20c94f63b15e08a7d4c92f30b68e15a7d0c493f2b",
      "role": "reviewer-approval" },
    { "path": "reviewers/tests.json",
      "sha256": "31d8e59f04a27c61b83f50d29e74a16c05b98d3e27f41a60c95b38e17d204f6c",
      "role": "reviewer-approval" }
  ],
  "attestation": { "level": "self", "signatures": [] },
  "recordedAt": "2026-08-25T02:41:00Z",
  "claims": [
    {
      "obligation": "review.green",
      "payloadSpec": "review.green/1",
      "payload": {
        "verdict": "green",
        "finalized": true,
        "editedAfterFinalPass": false,
        "reviewers": {
          "selected": ["correctness", "security", "tests"],
          "completed": ["security", "tests", "correctness"],
          "failed": [],
          "timedOut": []
        },
        "findings": [
          {
            "id": "f-001",
            "severity": "P1",
            "scope": "in_contract",
            "actionable": true,
            "blocking": false,
            "disposition": "resolved"
          },
          {
            "id": "f-002",
            "severity": "P2",
            "scope": "expansion",
            "actionable": true,
            "blocking": false,
            "disposition": "deferred",
            "deferredIssueId": "V26-1401"
          }
        ],
        "telemetry": {
          "iterationCount": 3,
          "findingCounts": { "P0": 0, "P1": 1, "P2": 1, "P3": 0 },
          "deferredExpansionCount": 1,
          "deferredIssueIds": ["V26-1401"],
          "cost": {
            "unit": "usd",
            "total": 4.20,
            "byReviewer": { "correctness": 1.80, "security": 1.60 },
            "reportedBy": "claude-code"
          }
        }
      }
    }
  ]
}
```

---

## D Appendix D — Rejection code registry

Codes are stable `snake_case` tokens. A validator reports every applicable code in
one response (SUB-5).

| Code | Rule |
|---|---|
| `unknown_member` | GEN-1 |
| `unsupported_envelope_spec` | GEN-2 |
| `malformed_field` | GEN-4, ENV-7 |
| `invalid_provider_id` / `unregistered_provider` | ENV-1 |
| `invalid_run_id` / `invalid_pass_id` | ENV-2, ENV-3 |
| `unsupported_vcs` / `invalid_object_id` | ENV-4, ENV-5 |
| `unsupported_identity_version` | ENV-6 |
| `repository_required` | ENV-8 |
| `run_history_final_mismatch` | ENV-9 |
| `artifact_path_invalid` / `artifact_path_duplicate` / `artifact_outside_run_root` | ENV-10 |
| `artifact_digest_mismatch` | ENV-11 |
| `unsupported_attestation` | ENV-12, ENV-13 |
| `no_claims` / `duplicate_claim` / `obligation_not_configured` / `unsupported_payload_spec` | ENV-14 |
| `candidate_mismatch` / `candidate_unprepared` | SUB-1, SUB-2 |
| `manifest_outside_run_root` | SUB-3 |
| `record_conflict` | SUB-4 |
| `verdict_not_green` / `not_finalized` / `edited_after_final_pass` | RG-1 |
| `reviewer_set_invalid` / `reviewer_set_incomplete` | RG-2, RG-3 |
| `approval_missing` / `approval_mismatch` | RG-4 |
| `finding_invalid` | RG-5 |
| `blocking_finding_present` / `actionable_unresolved` | RG-6 |
| `illegal_deferral` | RG-7 |
| `telemetry_mismatch` / `iteration_count_mismatch` | RG-8, RG-9 |
| `invalid_cost` | RG-10 |

---

## Vendoring note

This document is a vendored normative input, transcribed from the published
`delivery-evidence/1` working draft (25 August 2026) so that no unit of this
repository implements against a conversation artifact. Normative content — rule
ids, rejection codes, RFC 2119 keywords, patterns, schemas, and the worked
example — is reproduced verbatim. Only presentation was reconstructed where the
source extraction had flattened it:

- Tables (§2, §7, §8.1–8.3, §9.3, Appendix D) were re-formed from the flattened
  cell stream; every cell's text is the source text.
- JSON blocks were re-indented (the extraction collapsed leading whitespace);
  line breaks are as in the source, and each complete document parses as JSON.
- Inline code spans and emphasis were restored where the source's spacing marked
  them.
- In §9.2 the illustrative `"candidate"` placeholder — written in the source as a
  bare ellipsis comment inside a JSON block — is rendered as a string-keyed
  member so the block stays parseable; it is illustrative, not normative.
- In §5.9 the illustrative `"payload"` placeholder — written in the source as a
  bare ellipsis inside a JSON block — is restored using the same string-keyed
  convention as §9.2 so the elision stays visible rather than reading as an
  intentionally empty object; it is illustrative, not normative.

---

## Repo-local links (non-normative)

Navigation for readers of this repository; nothing here changes the contract
above.

- **Reference implementation:** the normative validator for §5–§9 lives in
  [`packages/kernel/src/validator/`](../../packages/kernel/src/validator/);
  the recorder implementing §8.3 in
  [`packages/kernel/src/recorder.ts`](../../packages/kernel/src/recorder.ts);
  the RFC 8785 canonicalizer and digests of §6 in
  [`packages/kernel/src/canonical.ts`](../../packages/kernel/src/canonical.ts)
  and [`packages/kernel/src/digest.ts`](../../packages/kernel/src/digest.ts).
- **Published schemas:** Appendices A–B are shipped verbatim as
  [`packages/kernel/src/validator/schemas/`](../../packages/kernel/src/validator/schemas/)
  and cross-checked against every conformance vector.
- **Conformance kit:** the 89-vector corpus this spec is tested by —
  [`packages/conformance/vectors/`](../../packages/conformance/vectors/),
  usage in [`docs/conformance.md`](../conformance.md).
- **Guides:** [`docs/getting-started.md`](../getting-started.md) (the adoption
  loop), [`docs/provider-guide.md`](../provider-guide.md) (producing a
  conforming manifest), [`docs/delivery-record.md`](../delivery-record.md)
  (the product-layer record outside this spec).
- **Errata candidates:** recorded divergences between this draft's text and
  the shipped kit/kernel reading — [`docs/spec-errata.md`](../spec-errata.md).
