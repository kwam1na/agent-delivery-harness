# Getting started

This walkthrough takes a repository from nothing to a delivery gate: you declare
the gate in a config file, run the CLI loop that turns a completed review into
admissible evidence, promote the admitted gate into a tracked **delivery
record**, verify it locally, and wire the GitHub Action that verifies it on
every pull request.

```
prepare ──▶ review-context ──▶ submit-evidence ──▶ gate ──▶ record ──▶ verify
(receipt)   (what to review)   (manifest → records) (admit)  (tracked)  (recompute)
```

Every command on this page is executed, not illustrated: the test suite
([`docs-examples.test.ts`](docs-examples.test.ts)) parses the fenced code
blocks out of this file and runs them verbatim against a fixture repository —
the `ts` blocks (each headed by a `// <relative-path>` comment) become files,
and the `sh` blocks concatenate, in order, into one `bash -eu -o pipefail`
session. If a command or flag on this page stops matching the CLI, the suite
goes red.

## Prerequisites

- Node ≥ 22 and git.
- A git repository with the change you want to deliver already committed on a
  branch, and a base ref (this walkthrough uses `origin/main`) that resolves.
- A `package.json` declaring `"type": "module"` — the config file and the
  example provider script below are ES modules, and an untyped package scope
  leaves their module format ambiguous.

## 0. Consuming the harness pre-v1

The `@agent-delivery-harness/*` packages are not published yet. Until they are, you
consume them from a checkout of this repository (with `npm ci` run inside it),
pointed at by `$DELIVERY_HARNESS_CHECKOUT`. Two things need wiring: a
`delivery-harness` command on your `PATH`, and `@agent-delivery-harness/kernel`
resolvable from your repository root (your `harness.config.ts` imports it).

```sh
# From your repository root. DELIVERY_HARNESS_CHECKOUT is a checkout of the
# delivery-harness repository with `npm ci` already run inside it.
mkdir -p .delivery-harness/bin node_modules/@agent-delivery-harness
ln -sfn "$DELIVERY_HARNESS_CHECKOUT/packages/kernel" node_modules/@agent-delivery-harness/kernel
printf '#!/bin/sh\nexec "%s/node_modules/.bin/tsx" "%s/packages/cli/src/main.ts" "$@"\n' \
  "$DELIVERY_HARNESS_CHECKOUT" "$DELIVERY_HARNESS_CHECKOUT" > .delivery-harness/bin/delivery-harness
chmod +x .delivery-harness/bin/delivery-harness
export PATH="$PWD/.delivery-harness/bin:$PATH"
export TSX="$DELIVERY_HARNESS_CHECKOUT/node_modules/.bin/tsx"
printf 'node_modules/\n.delivery-harness/\n' >> .gitignore
```

The `.gitignore` entries matter beyond tidiness: the harness refuses to capture
a candidate while untracked files are present (a tree you have not fully
committed is not a tree you can attest), and git-ignored files are the one
sanctioned exception.

## 1. Declare the gate

The whole gate — what counts as evidence, which provider may supply it, what a
human may waive, where the record lives — is one config file at the repository
root. The kernel reads nothing else: no ambient environment, no hidden
defaults for policy.

```ts
// harness.config.ts
import { defineHarnessConfig } from "@agent-delivery-harness/kernel";

export default defineHarnessConfig({
  gateId: "example.pr-admission",
  baseRef: "origin/main",

  // Evidence records live git-private, under `git rev-parse --git-path` of this
  // namespace — i.e. inside `.git/`, per worktree, never in your tracked tree.
  // Pick a name git does not own: not one of git's own directories (objects/,
  // refs/, hooks/, info/, logs/, worktrees/), and not a name your tracked tree
  // also uses, so repository content and harness state can never be confused.
  storageNamespace: "delivery-harness/",

  acceptedEnvelopeSpecs: ["delivery-evidence/1"],

  // `deliverable-tree/v1` is defined over exactly this narration set. If you
  // change the set, the config loader requires you to declare your own identity
  // token — a different exclusion set is a different identity function.
  identityVersions: ["deliverable-tree/v1"],
  computingIdentityVersion: "deliverable-tree/v1",
  reviewNeutral: [
    { prefix: "docs/reports/" },
    { prefix: "docs/solutions/" },
    { prefix: "telemetry/delivery-runs/" },
  ],
  recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],

  pathClassification: {
    generated: [{ kind: "prefix", value: "dist/" }],
    test: [{ kind: "glob", value: "**/*.test.ts" }],
    lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
  },
  sensitivePaths: [],
  activationThreshold: 1,

  agentEnvSignals: ["CLAUDE_CODE", "CLAUDECODE"],
  ciPolicies: [
    {
      id: "github-actions",
      requiredEnv: [
        { variable: "GITHUB_ACTIONS", equals: "true" },
        { variable: "CI", equals: "true" },
      ],
    },
  ],
  ciPolicyEnvKey: "DELIVERY_HARNESS_CI_POLICY",

  // Files whose bytes the preparation receipt fingerprints: change one and
  // every outstanding receipt goes stale, forcing a re-prepare.
  preparationWiringPaths: ["harness.config.ts"],

  providers: [{ id: "claude-code.ce-code-review", findingCodes: [] }],
  obligations: [
    {
      id: "review.green",
      activation: { kind: "relevant_change" },
      freshness: "exact_candidate",
      providers: ["claude-code.ce-code-review"],
      acceptedPayloadSpecs: ["review.green/1"],
      allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
      humanWaiverAllowed: true,
      minimumAttestationLevel: "self",
      ciDelegationPolicyIds: [],
      remediation: {
        default: [
          {
            id: "run-the-review",
            kind: "manual_action",
            summary: "Run the code review and submit its evidence manifest.",
          },
        ],
      },
      // Every finding code the gate can emit for this obligation must appear in
      // exactly one of these two lists — the loader rejects an unclassified or
      // doubly-classified code at load time.
      waivableCodes: [
        "review_evidence_missing",
        "stale_evidence",
        "evidence_not_green",
        "unresolved_actionable_findings",
      ],
      nonWaivableCodes: [
        "ambiguous_records",
        "malformed_record",
        "unknown_provider",
        "live_provider_missing",
        "ambiguous_live_provider",
        "live_provider_failed",
        "resolution_not_allowed",
      ],
    },
  ],

  // The tracked record's path. The loader requires it to satisfy BOTH neutral
  // predicates — see docs/delivery-record.md for why that is load-bearing.
  deliveryRecordPath: "telemetry/delivery-runs/record.json",
  deliveryRecordVerification: { baseMovement: "stale" },
});
```

Three members deserve a moment before moving on:

- **`storageNamespace`** — evidence records and preparation receipts are
  *git-private and worktree-local*: they live under `.git/`, never in your
  tracked tree, and never cross between worktrees. The tracked delivery record
  (step 6) is the only sanctioned crossing.
- **`reviewNeutral` / `recordNeutral`** — the two exclusion sets are different
  predicates with different jobs. Only `reviewNeutral` excludes paths from the
  deliverable identity digest; `recordNeutral` marks paths a recorded candidate
  is not bound to. `deliveryRecordPath` must satisfy both, so writing the
  record can neither change the identity it attests nor bind a candidate to its
  own record.
- **`waivableCodes` / `nonWaivableCodes`** — the trust asymmetry in data form.
  An interactive human may waive the waivable codes through an explicit prompt;
  a recognized agent can never waive anything, whatever the lists say.

## 2. A provider, in one file

Evidence is submitted by a **provider** — normally an agent framework or review
orchestrator (the MCP server in `@agent-delivery-harness/mcp` exposes exactly this
surface to agents). To make the walkthrough self-contained, here is the
smallest honest provider: a script that captures the candidate, allocates its
run root, writes one reviewer-approval artifact, and emits a
[`delivery-evidence/1`](spec/delivery-evidence-1.md) manifest for a green
review. Every field it writes is load-bearing; the
[provider guide](provider-guide.md) explains each one.

In a real adoption the review happens between the capture and the manifest —
this stand-in is how the contract looks, not how a review works.

```ts
// scripts/submit-review.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  captureGitCandidate,
  createArtifactsPort,
  resolveRecordStorage,
  sha256Hex,
  withDeliverableIdentity,
} from "@agent-delivery-harness/kernel";
import config from "../harness.config.ts";

const rootDir = process.cwd();
const provider = {
  id: "claude-code.ce-code-review",
  version: "1.0.0",
  runId: `r-${Date.now().toString(36)}`,
  finalPassId: "pass-1",
};

// Capture the candidate exactly the way the recorder will re-capture it at
// submission: same config, same workspace id, same identity computation.
const storage = await resolveRecordStorage(rootDir, { storageNamespace: config.storageNamespace });
const capture = await captureGitCandidate({
  rootDir,
  config,
  workspaceId: storage.workspaceId,
  computeIdentity: withDeliverableIdentity(),
});
if (!capture.ok) {
  console.error(`capture failed: ${capture.code}`);
  process.exit(1);
}
const captured = capture.candidate;
const candidate = {
  vcs: captured.vcs,
  treeSha: captured.treeSha,
  headSha: captured.headSha,
  deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
  base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
  workspaceId: captured.workspaceId,
};

// Run roots are recorder-allocated scratch space under the system temp
// directory — never provider-chosen, never inside the repository.
const artifacts = createArtifactsPort();
const allocation = await artifacts.allocateRunRoot({ providerId: provider.id, runId: provider.runId });
if (!allocation.ok) {
  console.error(`run root refused: ${allocation.reason}`);
  process.exit(1);
}
const runRoot = allocation.runRoot.path;

// One approval stamp per selected reviewer, re-stating the full binding so the
// artifact is independently interpretable in an audit.
const approval = `${JSON.stringify(
  {
    schemaVersion: 1,
    reviewerId: "correctness",
    result: "approved",
    provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId },
    workspaceId: candidate.workspaceId,
    candidate,
  },
  null,
  2,
)}\n`;
await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
await writeFile(path.join(runRoot, "reviewers/correctness.json"), approval, "utf8");

const manifest = {
  spec: "delivery-evidence/1",
  provider,
  candidate,
  repository: null,
  runHistory: [{ preparedTreeSha: captured.treeSha, evaluatedInPassId: provider.finalPassId }],
  artifacts: [{ path: "reviewers/correctness.json", sha256: sha256Hex(approval), role: "reviewer-approval" }],
  attestation: { level: "self", signatures: [] },
  recordedAt: new Date().toISOString(),
  claims: [
    {
      obligation: "review.green",
      payloadSpec: "review.green/1",
      payload: {
        verdict: "green",
        finalized: true,
        editedAfterFinalPass: false,
        reviewers: { selected: ["correctness"], completed: ["correctness"], failed: [], timedOut: [] },
        findings: [],
        telemetry: {
          iterationCount: 1,
          findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
          deferredExpansionCount: 0,
          deferredIssueIds: [],
        },
      },
    },
  ],
};
const manifestPath = path.join(runRoot, "manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(manifestPath);
```

## 3. Commit the wiring and preflight

The config and the script are part of your tree now — commit them (the harness
will not capture an uncommitted tree), then let `check` prove the config loads
and the evidence store is writable before anything depends on either.

```sh
git add .gitignore harness.config.ts scripts/submit-review.ts
git commit -m "wire the delivery harness"
delivery-harness check
```

## 4. Prepare, then see what a review must cover

`prepare` captures the candidate — the exact tree, its base coordinates, its
deliverable identity — and publishes a **preparation receipt**. The receipt is
the loop's ordering mechanism: no receipt, no review context, no admission. It
goes stale the moment the candidate moves, the base advances, or a wiring file
(here, `harness.config.ts` itself) changes.

```sh
delivery-harness prepare
delivery-harness review-context
```

`review-context` reports the reviewable change: how many relevant lines changed
against the base (generated files, tests, and lockfiles are classified out by
your config), whether the gate's activation threshold is met, and which
sensitive paths were touched.

## 5. Submit the evidence

The provider script prints its manifest path; hand it to `submit-evidence`.

```sh
MANIFEST="$("$TSX" scripts/submit-review.ts)"
delivery-harness submit-evidence --manifest "$MANIFEST"
```

The recorder validates the manifest against the full
[delivery-evidence/1 rule set](spec/delivery-evidence-1.md#8-validation-rules)
— and re-captures the candidate at submission, requiring exact equality with
the manifest's candidate on every field including the raw tree
([SUB-1](spec/delivery-evidence-1.md#83-submission--recording)). Edit anything
between the capture and the submission and the whole manifest is rejected. On
acceptance it writes one content-addressed evidence record per claim into the
git-private store; on rejection it reports **every** violated rule, not just
the first, and writes nothing.

## 6. Gate, record, verify

```sh
delivery-harness gate
delivery-harness record
git add telemetry/delivery-runs
git commit -m "delivery record for the current candidate"
delivery-harness verify
```

- `gate` resolves each obligation to one of six outcomes (satisfied by
  evidence, satisfied by a live fact, waived, delegated, not applicable,
  blocked). Freshness is judged by deliverable identity — narration-only
  changes do not stale a review — and under a TTY a fully-waivable block offers
  a human one explicit, all-or-nothing waiver prompt. Non-interactive runs
  never prompt.
- `record` re-runs the gate, refuses unless it admitted, re-captures the
  candidate adjacent to the write, and writes the tracked
  [delivery record](delivery-record.md) — the one artifact that crosses from
  the git-private workspace into your tree. Its filename is candidate-keyed
  (the deliverable digest is spliced into `deliveryRecordPath`), so parallel
  branches never conflict. Commit it; it rides in your pull request.
- `verify` recomputes the deliverable identity from the current tree, finds the
  record keyed to it, and checks it with the same pure kernel core the GitHub
  Action uses. The summary always carries the honest attestation label — L0
  evidence proves process discipline and freshness, not provenance.

Exit codes are part of the contract on every command: `0` pass, `1` policy
block (typed, rendered blockers), `2` usage error, `130` interrupted.

## 7. Wire the pull-request check

The GitHub Action re-runs the same verification on every pull request — against
the **PR head**, never GitHub's synthetic merge commit — and fails closed on
identity mismatch, base movement (staling by default), a missing or untracked
record, an uncovered obligation, or a record it cannot parse.

```yaml
on: pull_request

jobs:
  verify-delivery-record:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - uses: ./packages/action
```

Three things to know before the first PR:

- **The Action leg of this walkthrough is covered by simulated webhook events**
  ([`packages/action/fixtures/events/`](../packages/action/fixtures/events/)),
  which drive the whole failure-class table against real temporary git
  repositories — not by a live GitHub run.
- **The bootstrap rule:** the PR that *introduces* the verification workflow
  cannot be gated by it (the record path, the workflow, or both are still part
  of the change under review). That first PR is exempted by a human merging
  with the check absent or failing — deliberately never by a code path in the
  Action. Every subsequent PR is gated.
- **The producer/poller split:** the job that verifies a record must never be
  the job that produces it. The record is produced where the work happens and
  committed with the change; the Action is a read-only poller re-run by
  GitHub's `synchronize` events. See the extensive commentary in
  [`packages/action/action.yml`](../packages/action/action.yml).

In v1 the supported form is self-hosted (`uses: ./packages/action` from a
checkout of this repository); the published-action form ships with the release
mechanics.

## Where to next

- [Provider guide](provider-guide.md) — building a real provider: the manifest
  contract, field by field, with the conformance vectors as the test bed.
- [The delivery record](delivery-record.md) — what the tracked record is, what
  it proves, and the `baseMovement` policy.
- [Conformance](conformance.md) — running and regenerating the 89-vector kit.
- [The spec](spec/delivery-evidence-1.md) — the normative contract itself.
