/**
 * The GitHub Action: fail-closed verification of the tracked delivery record.
 *
 * A THIN WRAPPER, DELIBERATELY. Everything this file decides about a record is
 * decided by `verifyDeliveryRecord` in the kernel — the same function the CLI
 * `verify` command calls, reading the same `deliveryRecordVerification` policy.
 * No verification logic lives here. What lives here is the part that is specific
 * to running inside a pull request: which commit to recompute the deliverable
 * identity from, how to find the record in the tracked tree, how to decide
 * whether the run may claim delegated authority, and how to render the answer as
 * a check summary. If a rule about records ever needs to change, it changes in
 * the kernel and both surfaces move together; a rule that only CI enforced would
 * make the local gate more permissive than the merge gate, which is the one
 * asymmetry this design refuses.
 *
 * WHY THE PULL REQUEST HEAD, AND NEVER THE SYNTHETIC MERGE COMMIT.
 *
 * On a `pull_request` event GitHub checks out — and points `GITHUB_SHA` at — a
 * commit it fabricates by merging the head into the current base tip. That
 * commit is not the head. Three consequences, each of them fatal to a record
 * check:
 *
 *   1. Its tree contains base changes the author never delivered, so its
 *      deliverable identity is not the identity any local gate ever saw. A
 *      record that verified against it would be attesting a tree nobody
 *      reviewed and nobody will ever merge under that hash.
 *   2. It is regenerated whenever the base moves. The verified artifact would
 *      change under a PR that did not change, which makes the check's answer a
 *      function of other people's merges.
 *   3. It would silently *launder* base movement. The whole point of the
 *      `baseMovement` policy is that a moved base stales a record unless the
 *      consumer says otherwise; verifying a tree that already has the new base
 *      folded in would make every record look fresh.
 *
 * So the head sha is read out of the event payload and the identity is
 * recomputed from *that commit's tree* through git, not from the working tree.
 * That is stronger than trusting the checkout: even a workflow that checked out
 * the merge ref by mistake cannot make this pass, because the working tree is
 * never consulted for identity. `GITHUB_SHA` is recorded in the summary as the
 * commit that was *not* verified, and is resolved nowhere.
 *
 * NO CLOCK (sensor rule e). Nothing here reads a clock. A record's freshness is
 * its identity's agreement with the head, never elapsed time, and an Action that
 * consulted a clock would be able to expire evidence the kernel considers valid.
 *
 * FAIL CLOSED, ALWAYS. Every path that cannot reach a verdict — an event that is
 * not a pull request, a payload without a head, a config that will not load, a
 * head commit the checkout does not have, an unresolvable base, a record that
 * will not parse — produces typed blockers and a non-zero exit. There is no
 * skip: a check that reports success because it could not run is worse than no
 * check, because it looks like one.
 */
import { access, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ATTESTATION_LABEL,
  BlockedError,
  DELIVERY_RECORD_DRIFT_CLASSES,
  RESOLUTION_OUTCOMES,
  classifyExecutionContext,
  computeDeliverableIdentity,
  createBlocker,
  createInternalErrorBlocker,
  deliveryRecordPathFor,
  parseDeliveryRecord,
  renderBlockers,
  runGitCommand,
  selectDeliveryRecordForIdentity,
  validateHarnessConfig,
  verifyDeliveryRecord,
  type Blocker,
  type BlockerSource,
  type CandidateCommandRunner,
  type DeliveryRecordCheck,
  type DeliveryRecordClaim,
  type DeliveryRecordFile,
  type EnvSnapshot,
  type HarnessConfig,
  type NonEmptyTuple,
  type Remediation,
} from "@delivery-harness/kernel";

// ── Exit codes ───────────────────────────────────────────────────────────────

/** The check passed. */
export const ACTION_EXIT_OK = 0;
/** The check produced blockers, or could not be run. Both are failures. */
export const ACTION_EXIT_POLICY = 1;

// ── Modes ────────────────────────────────────────────────────────────────────

/**
 * What the run claims to be.
 *
 * `verify` is unprivileged: it recomputes an identity, reads a tracked file, and
 * reports. It grants nothing, so it needs no authorization and the execution
 * ladder is not consulted for it.
 *
 * `delegated-authority` is a claim, made by passing the `ci-policy-id` input,
 * that this job is the repository-authorized automation a declared CI policy
 * names. The claim is checked through `classifyExecutionContext` against the
 * consumer's own policies, and it is checked *exactly*: a near miss is
 * `unauthorized_automation`, never a quiet downgrade back to `verify`. That
 * asymmetry is the whole reason the mode exists — an automation with a
 * half-configured environment must not acquire whatever rights it lands next to.
 */
export const ACTION_MODES = ["verify", "delegated-authority"] as const;
export type ActionMode = (typeof ACTION_MODES)[number];

/**
 * The env var `action.yml` maps the `ci-policy-id` input onto.
 *
 * An explicit name rather than GitHub's `INPUT_*` mangling, and deliberately not
 * the consumer's own `ciPolicyEnvKey`: this is plumbing for one input, while
 * `ciPolicyEnvKey` is the vendor-neutral member a *policy* is declared under.
 * The two meet in one place — the value read here is overlaid onto the config's
 * key before classification — so the classifier still sees only config-named
 * variables and the Action contributes no literal to the policy grammar.
 */
export const CI_POLICY_INPUT_ENV = "DELIVERY_HARNESS_CI_POLICY_ID";

// ── The runtime seam ─────────────────────────────────────────────────────────

/**
 * Everything the Action may reach, handed in rather than reached for.
 *
 * This is what lets the whole failure-class table be driven from simulated event
 * payloads with no Actions runner: a test supplies an env snapshot, an event
 * file, and a repository, and calls `runAction` as a function. `git` is a port
 * rather than a fake — the tests point it at real repositories, because a
 * simulated git would let the head-vs-merge-ref proof pass against a fiction.
 */
export interface ActionRuntime {
  readonly env: EnvSnapshot;
  /** The checked-out repository root. Used as git's cwd, never as the identity source. */
  readonly workspace: string;
  readonly git: CandidateCommandRunner;
  readonly readFile: (absolutePath: string) => Promise<string>;
  readonly loadConfig: (rootDir: string) => Promise<HarnessConfig>;
  /** Emits the check summary. In a runner this appends to `$GITHUB_STEP_SUMMARY`. */
  readonly writeSummary: (markdown: string) => Promise<void>;
  readonly log: (line: string) => void;
  /** Optional: step outputs. Absent in tests, which read the returned result instead. */
  readonly writeOutputs?: (outputs: Readonly<Record<string, string>>) => Promise<void>;
  /** Optional: whether a path exists in the workspace. Defaults to a real stat. */
  readonly pathExists?: (absolutePath: string) => Promise<boolean>;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly mode: ActionMode;
  /** The markdown handed to `writeSummary`, returned so tests read what CI reads. */
  readonly summary: string;
  readonly blockers: readonly Blocker[];
  /** The commit whose tree was verified. */
  readonly headSha: string | null;
  /** `GITHUB_SHA` — recorded for the record, resolved nowhere. */
  readonly mergeRefSha: string | null;
  readonly recordPath: string | null;
  readonly deliverableDigest: string | null;
}

// ── Blockers ─────────────────────────────────────────────────────────────────

/** `git ls-tree -z` separates records with NUL, so a path containing a newline stays one record. */
const NUL = "\u0000";

const ACTION_SOURCE: BlockerSource = { kind: "command", id: "delivery-harness.action" };

const RECORD_AND_COMMIT: Remediation = {
  id: "record-and-commit",
  kind: "command",
  command: ["delivery-harness", "record"],
  summary: "Run the gate locally, record the admitted result, then commit the record file with the change it describes.",
};

const RE_RUN_THE_LOOP: Remediation = {
  id: "re-run-the-loop",
  kind: "manual_action",
  summary: "Re-prepare, re-run the gate, and re-record for the pull request head as it now stands.",
};

function actionBlocker(input: {
  readonly code: string;
  readonly summary: string;
  readonly details?: string;
  readonly remediations: NonEmptyTuple<Remediation>;
}): Blocker {
  return createBlocker({
    code: input.code,
    source: ACTION_SOURCE,
    summary: input.summary,
    ...(input.details === undefined ? {} : { details: input.details }),
    remediations: input.remediations,
  });
}

/**
 * The drift class the Action names when no tracked record binds to the head.
 *
 * Bound to the kernel's own vocabulary rather than spelled independently: this
 * declaration fails to compile if the kernel ever renames the class, which is
 * the only way a wrapper can promise it is speaking the same language as the
 * core it wraps.
 */
const IDENTITY_DRIFT_CLASS: (typeof DELIVERY_RECORD_DRIFT_CLASSES)[number] = "deliverable_identity_changed";

// ── Printable vocabulary ─────────────────────────────────────────────────────

/**
 * WHY THE SUMMARY PRINTS ALLOWLISTED VALUES RATHER THAN RECORD TEXT.
 *
 * A delivery record is committed by the pull request author, so every string in
 * it is untrusted. Untrusted text has exactly one sanctioned route to an
 * operator: the blocker renderer, which neutralizes per §11.2 and is the shared
 * rail all three surfaces use. The claims table is not a blocker, so instead of
 * inventing a second neutralization chain — two chains drift, and the weaker one
 * is always the one that matters — this file prints only values that satisfy a
 * closed grammar or appear in the consumer's own config. A control character, an
 * ANSI escape, a bidi override and a table-breaking pipe are all outside every
 * grammar below, so none of them can reach the summary at all.
 */
const ID_GRAMMAR = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TOKEN_GRAMMAR = /^[A-Za-z0-9._/-]{1,80}$/;
const SHA_GRAMMAR = /^[0-9a-f]{7,64}$/;
const DIGEST_GRAMMAR = /^[0-9a-f]{64}$/;

const UNPRINTABLE = "[unprintable]";

function printable(value: unknown, grammar: RegExp, maximumLength = 120): string {
  if (typeof value !== "string" || value.length > maximumLength || !grammar.test(value)) return UNPRINTABLE;
  return value;
}

// ── Git helpers ──────────────────────────────────────────────────────────────

interface GitPort {
  (args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

function gitPortFor(runtime: ActionRuntime): GitPort {
  return (args) => runtime.git(["git", ...args], { cwd: runtime.workspace });
}

// ── The event ────────────────────────────────────────────────────────────────

/** The pull-request event names this Action accepts, and the one it refuses by name. */
const VERIFIABLE_EVENT = "pull_request";
const REFUSED_EVENT = "pull_request_target";

interface PullRequestEvent {
  readonly headSha: string;
  readonly headRef: string | null;
  readonly number: number | null;
}

type EventResolution = { readonly ok: true; readonly event: PullRequestEvent } | { readonly ok: false; readonly blockers: NonEmptyTuple<Blocker> };

function readMember(container: unknown, key: string): unknown {
  if (container === null || typeof container !== "object" || Array.isArray(container)) return undefined;
  return (container as Record<string, unknown>)[key];
}

async function resolvePullRequestEvent(runtime: ActionRuntime): Promise<EventResolution> {
  const eventName = runtime.env["GITHUB_EVENT_NAME"];

  // `pull_request_target` is refused by name rather than tolerated. It runs with
  // the base repository's privileges while describing a head the base has not
  // reviewed; a verification job with write-capable credentials looking at
  // untrusted code is the shape of the supply-chain incident this whole harness
  // exists to make harder. The consumer wants `pull_request`, which is exactly
  // as capable for a read-only check.
  if (eventName === REFUSED_EVENT) {
    return {
      ok: false,
      blockers: [
        actionBlocker({
          code: "unsupported_event",
          summary: `The ${REFUSED_EVENT} event is refused: it runs with base-repository privileges against an unreviewed head.`,
          details: `Trigger this check on ${VERIFIABLE_EVENT}, which is read-only and sufficient for record verification.`,
          remediations: [
            {
              id: "trigger-on-pull-request",
              kind: "code_change",
              summary: `Trigger the verification workflow on ${VERIFIABLE_EVENT} with \`permissions: contents: read\`.`,
            },
          ],
        }),
      ],
    };
  }

  if (eventName !== VERIFIABLE_EVENT) {
    return {
      ok: false,
      blockers: [
        actionBlocker({
          code: "unsupported_event",
          summary: "This check verifies a pull request head; the delivery was not a pull request event.",
          details: `GITHUB_EVENT_NAME was ${JSON.stringify(eventName ?? null)}; expected ${JSON.stringify(VERIFIABLE_EVENT)}.`,
          remediations: [
            { id: "trigger-on-pull-request", kind: "code_change", summary: `Trigger the verification workflow on ${VERIFIABLE_EVENT}.` },
          ],
        }),
      ],
    };
  }

  const eventPath = runtime.env["GITHUB_EVENT_PATH"];
  const unreadable = (detail: string): EventResolution => ({
    ok: false,
    blockers: [
      actionBlocker({
        code: "event_payload_unreadable",
        summary: "The pull request event payload could not be read.",
        details: detail,
        remediations: [
          {
            id: "inspect-workflow-trigger",
            kind: "manual_action",
            summary: "Inspect the workflow trigger: the runner did not provide a readable pull_request payload.",
          },
        ],
      }),
    ],
  });

  if (typeof eventPath !== "string" || eventPath === "") return unreadable("GITHUB_EVENT_PATH is unset.");

  let payload: unknown;
  try {
    payload = JSON.parse(await runtime.readFile(eventPath));
  } catch (error) {
    return unreadable(`${eventPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const pullRequest = readMember(payload, "pull_request");
  const headSha = readMember(readMember(pullRequest, "head"), "sha");
  if (typeof headSha !== "string" || !SHA_GRAMMAR.test(headSha)) {
    return unreadable(`the payload carries no usable pull_request.head.sha (${JSON.stringify(headSha ?? null)})`);
  }
  const headRef = readMember(readMember(pullRequest, "head"), "ref");
  const number = readMember(pullRequest, "number");
  return {
    ok: true,
    event: {
      headSha,
      headRef: typeof headRef === "string" ? headRef : null,
      number: typeof number === "number" && Number.isSafeInteger(number) ? number : null,
    },
  };
}

// ── Delegated authority ──────────────────────────────────────────────────────

interface ModeResolution {
  readonly mode: ActionMode;
  readonly policyId: string | null;
  readonly blockers: readonly Blocker[];
}

function resolveMode(runtime: ActionRuntime, config: HarnessConfig): ModeResolution {
  const declared = runtime.env[CI_POLICY_INPUT_ENV];
  // Absent input, absent claim. Verify mode grants nothing, so there is nothing
  // to authorize and the ladder is not consulted. A run that wants delegated
  // authority has to ask for it.
  if (typeof declared !== "string" || declared.trim() === "") {
    return { mode: "verify", policyId: null, blockers: [] };
  }
  const policyId = declared.trim();

  // The classifier reads a given snapshot, so the input is overlaid onto the
  // *config's* policy key: the classifier never learns this Action's plumbing
  // name, and the consumer's corroboration surface is the only thing that can
  // grant the rung. Streams are non-interactive by construction on a runner.
  const context = classifyExecutionContext({
    config,
    env: { ...runtime.env, [config.ciPolicyEnvKey]: policyId },
    stdinIsTTY: false,
    stdoutIsTTY: false,
  });

  if (context.kind === "ci" && context.policyId === policyId) {
    return { mode: "delegated-authority", policyId, blockers: [] };
  }

  const corroboration = config.ciPolicies
    .find((policy) => policy.id === policyId)
    ?.requiredEnv.map((requirement) => `${requirement.variable}=${JSON.stringify(requirement.equals)}`)
    .join(", ");
  return {
    mode: "verify",
    policyId: null,
    blockers: [
      actionBlocker({
        code: "unauthorized_automation",
        // Stated as a refusal rather than as a downgrade, because a downgrade is
        // the failure mode: a job whose environment half-matches a declared
        // policy must not keep running with whatever rights it lands next to.
        summary: `This run claims the delegated-authority policy ${JSON.stringify(printable(policyId, ID_GRAMMAR))} but the environment does not corroborate it.`,
        details:
          corroboration === undefined
            ? `No CI policy with that id is declared in this repository's configuration.`
            : `The declared policy requires ${corroboration}; the run's environment does not match it completely.`,
        remediations: [
          {
            id: "repair-the-delegation-environment",
            kind: "manual_action",
            summary: "Repair the job's environment so it matches one declared CI policy completely, or drop the ci-policy-id input and run in verify mode.",
          },
        ],
      }),
    ],
  };
}

// ── Record discovery ─────────────────────────────────────────────────────────

/**
 * The prefix and suffix a delivery record's *derived* filename has under this
 * config, discovered by splicing two digests that differ in every position.
 *
 * Derived from `deliveryRecordPathFor` rather than re-deriving the splice: the
 * naming rule lives in the kernel, and a second implementation of it here would
 * be free to drift into a lookup that silently finds nothing. Two probes that
 * agree nowhere pin the splice window exactly — everything the two derived paths
 * share is config, everything they do not is digest.
 */
function recordNameShape(config: HarnessConfig): { readonly prefix: string; readonly suffix: string } {
  const low = deliveryRecordPathFor(config, "0".repeat(64));
  const high = deliveryRecordPathFor(config, "f".repeat(64));
  let prefixLength = 0;
  while (prefixLength < low.length && low[prefixLength] === high[prefixLength]) prefixLength += 1;
  let suffixLength = 0;
  while (
    suffixLength < low.length - prefixLength &&
    low[low.length - 1 - suffixLength] === high[high.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }
  return { prefix: low.slice(0, prefixLength), suffix: suffixLength === 0 ? "" : low.slice(low.length - suffixLength) };
}

function isRecordPath(candidatePath: string, shape: { readonly prefix: string; readonly suffix: string }): boolean {
  if (candidatePath.length !== shape.prefix.length + 64 + shape.suffix.length) return false;
  if (!candidatePath.startsWith(shape.prefix) || !candidatePath.endsWith(shape.suffix)) return false;
  return DIGEST_GRAMMAR.test(candidatePath.slice(shape.prefix.length, shape.prefix.length + 64));
}

interface DiscoveredRecords {
  readonly files: readonly DeliveryRecordFile[];
  /** Parse failures. Findings, never skips — see below. */
  readonly blockers: readonly Blocker[];
  readonly trackedCount: number;
}

/**
 * Reads every record-shaped path out of the head commit's tree.
 *
 * READ FROM THE TREE, NOT FROM THE WORKING DIRECTORY. The record's whole claim
 * is that it is *tracked* — a file the reviewer can see in the diff and the
 * history retains. Reading it out of the commit makes that structural: an
 * untracked file cannot be mistaken for evidence, whatever a build step left
 * lying in the workspace.
 *
 * A PARSE FAILURE IS A FINDING, NEVER A SKIP. A file that matches this config's
 * record naming template and cannot be read is a defect in the tracked tree, and
 * a verifier that ignored it would be reporting on evidence it never inspected.
 * The cost is real and accepted: a corrupt record committed long ago fails later
 * pull requests until it is repaired or removed. That is the fail-closed
 * direction, and the repair is a one-line commit.
 */
async function readTrackedRecords(git: GitPort, headSha: string, config: HarnessConfig): Promise<DiscoveredRecords> {
  const shape = recordNameShape(config);
  const listing = await git(["ls-tree", "-r", "--name-only", "-z", headSha]);
  if (listing.exitCode !== 0) {
    return {
      files: [],
      trackedCount: 0,
      blockers: [
        actionBlocker({
          code: "tracked_tree_unreadable",
          summary: "The pull request head's tree could not be listed.",
          details: listing.stderr.trim() || listing.stdout.trim() || `git ls-tree ${headSha} failed`,
          remediations: [
            {
              id: "check-out-the-head-commit",
              kind: "manual_action",
              summary: "Check out the pull request head commit with enough history for git to read its tree.",
            },
          ],
        }),
      ],
    };
  }

  const paths = listing.stdout.split(NUL).filter((entry) => entry.length > 0 && isRecordPath(entry, shape));
  const files: DeliveryRecordFile[] = [];
  const blockers: Blocker[] = [];
  for (const recordPath of paths.sort()) {
    const blob = await git(["cat-file", "blob", `${headSha}:${recordPath}`]);
    if (blob.exitCode !== 0) {
      blockers.push(
        actionBlocker({
          code: "delivery_record_unreadable",
          summary: "A tracked delivery record could not be read out of the head commit.",
          details: `${recordPath}: ${blob.stderr.trim() || `git cat-file failed`}`,
          remediations: [RE_RUN_THE_LOOP],
        }),
      );
      continue;
    }
    const parsed = parseDeliveryRecord(blob.stdout);
    if (!parsed.ok) {
      blockers.push(...parsed.blockers);
      continue;
    }
    files.push({ path: recordPath, record: parsed.record });
  }
  return { files, blockers, trackedCount: paths.length };
}

// ── The summary ──────────────────────────────────────────────────────────────

interface SummaryInput {
  readonly ok: boolean;
  readonly mode: ActionMode;
  readonly policyId: string | null;
  readonly headSha: string | null;
  readonly headRef: string | null;
  readonly mergeRefSha: string | null;
  readonly deliverableDigest: string | null;
  readonly identityToken: string | null;
  readonly recordPath: string | null;
  readonly check: DeliveryRecordCheck | null;
  readonly baseMovement: string | null;
  readonly blockers: readonly Blocker[];
}

/**
 * A code fence long enough to contain whatever the renderer produced.
 *
 * Neutralization removes control characters, not backticks — and a record is
 * author-controlled text. Without this, a record carrying a fence could close
 * the Action's block and write markdown that reads as harness-authored, which on
 * a check summary is the difference between a report and a forgery.
 */
function fenceFor(body: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (const character of body) {
    currentRun = character === "`" ? currentRun + 1 : 0;
    if (currentRun > longestRun) longestRun = currentRun;
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}

function claimRow(claim: DeliveryRecordClaim, config: HarnessConfig): string {
  const obligationId = printable(claim.obligationId, ID_GRAMMAR);
  const outcome = (RESOLUTION_OUTCOMES as readonly string[]).includes(claim.outcome) ? claim.outcome : UNPRINTABLE;
  const provider =
    claim.providerId === undefined
      ? "—"
      : config.providers.some((registration) => registration.id === claim.providerId)
        ? printable(claim.providerId, ID_GRAMMAR)
        : "[unregistered]";
  const evidence = claim.recordId === undefined ? "—" : printable(claim.recordId, TOKEN_GRAMMAR, 80);
  return `| \`${obligationId}\` | \`${outcome}\` | ${provider === "—" ? provider : `\`${provider}\``} | ${evidence === "—" ? evidence : `\`${evidence}\``} |`;
}

function renderSummary(input: SummaryInput, config: HarnessConfig | null): string {
  const lines: string[] = [];
  lines.push("## Delivery record verification");
  lines.push("");
  lines.push(input.ok ? "**Result: verified.**" : "**Result: blocked.** The pull request head does not carry a delivery record this gate accepts.");
  lines.push("");
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push(`| Mode | \`${input.mode}\`${input.policyId === null ? "" : ` (policy \`${printable(input.policyId, ID_GRAMMAR)}\`)`} |`);
  lines.push(`| Verified commit | \`${input.headSha === null ? UNPRINTABLE : printable(input.headSha, SHA_GRAMMAR)}\` (pull request head${input.headRef === null ? "" : `, \`${printable(input.headRef, TOKEN_GRAMMAR)}\``}) |`);
  lines.push(
    `| Not verified | \`${input.mergeRefSha === null ? "—" : printable(input.mergeRefSha, SHA_GRAMMAR)}\` (\`GITHUB_SHA\`, the synthetic merge commit) |`,
  );
  if (input.deliverableDigest !== null) {
    lines.push(`| Deliverable identity | \`${printable(input.deliverableDigest, DIGEST_GRAMMAR)}\` (\`${printable(input.identityToken, TOKEN_GRAMMAR)}\`) |`);
  }
  if (input.recordPath !== null) lines.push(`| Delivery record | \`${input.recordPath}\` |`);
  if (input.baseMovement !== null) {
    const relaxed = input.check?.baseMovementRelaxed === true;
    const relaxation = relaxed
      ? ` — **relaxed** base movement: ${input.check?.relaxedDriftClasses.map((driftClass) => `\`${driftClass}\``).join(", ")}`
      : "";
    lines.push(`| Base-movement policy | \`${printable(input.baseMovement, TOKEN_GRAMMAR)}\`${relaxation} |`);
  }
  lines.push(`| Attestation | ${ATTESTATION_LABEL} |`);
  lines.push("");

  if (input.check !== null && config !== null && input.check.claims.length > 0) {
    lines.push("### Claims");
    lines.push("");
    lines.push("| Obligation | Outcome | Provider | Evidence record |");
    lines.push("| --- | --- | --- | --- |");
    for (const claim of input.check.claims) lines.push(claimRow(claim, config));
    lines.push("");
  }

  if (input.blockers.length > 0) {
    const body = renderBlockers(input.blockers);
    const fence = fenceFor(body);
    lines.push("### Blockers");
    lines.push("");
    lines.push(`${fence}text`);
    lines.push(body);
    lines.push(fence);
    lines.push("");
  }

  lines.push(
    `_Attestation level is L0: ${ATTESTATION_LABEL}. This check proves that a gate ran against this exact deliverable and that the record has not gone stale — it does not prove who ran it._`,
  );
  return `${lines.join("\n")}\n`;
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * Verifies the tracked delivery record for one pull request event.
 *
 * Total: it never throws. Every failure — expected or not — becomes typed
 * blockers, a rendered summary, and a non-zero exit code.
 */
export async function runAction(runtime: ActionRuntime): Promise<ActionResult> {
  const mergeRefSha = typeof runtime.env["GITHUB_SHA"] === "string" ? (runtime.env["GITHUB_SHA"] as string) : null;
  let mode: ActionMode = "verify";
  let headSha: string | null = null;
  let headRef: string | null = null;
  let policyId: string | null = null;
  let deliverableDigest: string | null = null;
  let identityToken: string | null = null;
  let recordPath: string | null = null;
  let baseMovement: string | null = null;
  let check: DeliveryRecordCheck | null = null;
  let config: HarnessConfig | null = null;
  const blockers: Blocker[] = [];

  const settle = async (): Promise<ActionResult> => {
    const ok = blockers.length === 0;
    const summary = renderSummary(
      { ok, mode, policyId, headSha, headRef, mergeRefSha, deliverableDigest, identityToken, recordPath, check, baseMovement, blockers },
      config,
    );
    try {
      await runtime.writeSummary(summary);
    } catch (error) {
      // The summary is the product. A failure to publish it is reported on the
      // log rather than swallowed, and never turns a blocked check into a pass.
      runtime.log(`the check summary could not be published: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (runtime.writeOutputs !== undefined) {
      try {
        await runtime.writeOutputs({
          verified: String(ok),
          mode,
          "head-sha": headSha ?? "",
          "record-path": recordPath ?? "",
          "deliverable-digest": deliverableDigest ?? "",
        });
      } catch (error) {
        runtime.log(`step outputs could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    runtime.log(ok ? "delivery record verified against the pull request head" : "delivery record verification blocked");
    return {
      ok,
      exitCode: ok ? ACTION_EXIT_OK : ACTION_EXIT_POLICY,
      mode,
      summary,
      blockers,
      headSha,
      mergeRefSha,
      recordPath,
      deliverableDigest,
    };
  };

  try {
    const event = await resolvePullRequestEvent(runtime);
    if (!event.ok) {
      blockers.push(...event.blockers);
      return await settle();
    }
    headSha = event.event.headSha;
    headRef = event.event.headRef;

    try {
      config = await runtime.loadConfig(runtime.workspace);
    } catch (error) {
      if (error instanceof BlockedError) {
        blockers.push(...error.blockers);
        return await settle();
      }
      throw error;
    }
    baseMovement = config.deliveryRecordVerification.baseMovement;
    identityToken = config.computingIdentityVersion;

    const resolvedMode = resolveMode(runtime, config);
    mode = resolvedMode.mode;
    policyId = resolvedMode.policyId;
    if (resolvedMode.blockers.length > 0) {
      // A run that claimed authority it does not have stops here. Verifying
      // anyway and reporting the result would let the claim's failure read as an
      // aside on a check that otherwise passed.
      blockers.push(...resolvedMode.blockers);
      return await settle();
    }

    const git = gitPortFor(runtime);

    // The head's tree, resolved from the head sha in the payload. Never
    // `GITHUB_SHA`, never `HEAD`, never the working directory.
    const headTree = await git(["rev-parse", "--verify", `${headSha}^{tree}`]);
    if (headTree.exitCode !== 0) {
      blockers.push(
        actionBlocker({
          code: "head_commit_unavailable",
          summary: "The pull request head commit is not present in this checkout.",
          details: `${headSha}: ${headTree.stderr.trim() || "git rev-parse failed"}`,
          remediations: [
            {
              id: "check-out-the-pull-request-head",
              kind: "code_change",
              summary: "Check out `github.event.pull_request.head.sha` (not the default merge ref) with `fetch-depth: 0`.",
            },
          ],
        }),
      );
      return await settle();
    }
    const treeSha = headTree.stdout.trim();

    try {
      deliverableDigest = await computeDeliverableIdentity({ rootDir: runtime.workspace, treeSha, config }, { run: runtime.git });
    } catch (error) {
      if (error instanceof BlockedError) {
        blockers.push(...error.blockers);
        return await settle();
      }
      throw error;
    }

    const baseTip = await git(["rev-parse", "--verify", `${config.baseRef}^{commit}`]);
    if (baseTip.exitCode !== 0) {
      blockers.push(
        actionBlocker({
          code: "base_ref_unresolved",
          summary: `The configured base ref ${JSON.stringify(printable(config.baseRef, TOKEN_GRAMMAR))} does not resolve in this checkout.`,
          details: baseTip.stderr.trim() || "git rev-parse failed",
          remediations: [
            {
              id: "fetch-the-base-ref",
              kind: "code_change",
              summary: "Fetch the base ref in the workflow (`fetch-depth: 0`), or declare a base ref the checkout resolves.",
            },
          ],
        }),
      );
      return await settle();
    }
    const mergeBase = await git(["merge-base", config.baseRef, headSha]);
    if (mergeBase.exitCode !== 0) {
      blockers.push(
        actionBlocker({
          code: "merge_base_unavailable",
          summary: "The merge base between the pull request head and the configured base ref could not be computed.",
          details: mergeBase.stderr.trim() || "git merge-base failed",
          remediations: [
            {
              id: "deepen-the-checkout",
              kind: "code_change",
              summary: "Deepen the checkout (`fetch-depth: 0`) so the merge base with the configured base ref is present.",
            },
          ],
        }),
      );
      return await settle();
    }
    const base = { ref: config.baseRef, tipSha: baseTip.stdout.trim(), mergeBaseSha: mergeBase.stdout.trim() };

    const discovered = await readTrackedRecords(git, headSha, config);
    blockers.push(...discovered.blockers);

    const identity = { deliverableDigest, identityToken: config.computingIdentityVersion };
    const selected = selectDeliveryRecordForIdentity(discovered.files, identity);
    const expectedPath = deliveryRecordPathFor(config, deliverableDigest);

    if (selected === undefined) {
      if (discovered.blockers.length > 0) {
        // The unreadable records already explain why nothing was selected;
        // adding "missing" on top would name a second cause that is not one.
        return await settle();
      }
      if (discovered.trackedCount === 0) {
        const exists = await workspaceHas(runtime, expectedPath);
        blockers.push(
          exists
            ? actionBlocker({
                code: "delivery_record_untracked",
                summary: "A delivery record for this deliverable exists in the workspace but is not tracked in the pull request head.",
                details: `${expectedPath} is present but absent from the head commit's tree; an untracked file is not evidence a reviewer can see.`,
                remediations: [
                  {
                    id: "track-the-delivery-record",
                    kind: "command",
                    command: ["git", "add", expectedPath],
                    summary: "Track the delivery record and push it with the change it describes (`git add`, then commit).",
                  },
                ],
              })
            : actionBlocker({
                code: "delivery_record_missing",
                summary: "The pull request head carries no delivery record.",
                details: `expected ${expectedPath}`,
                remediations: [RECORD_AND_COMMIT],
              }),
        );
        return await settle();
      }
      blockers.push(
        actionBlocker({
          code: IDENTITY_DRIFT_CLASS,
          summary: "No tracked delivery record describes the deliverable identity recomputed from the pull request head.",
          details: [
            `head identity ${deliverableDigest} (${config.computingIdentityVersion})`,
            `expected record ${expectedPath}`,
            `${discovered.trackedCount} tracked record(s) bind to: ${discovered.files
              .map((entry) => printable(entry.record.candidateBinding.deliverableDigest, DIGEST_GRAMMAR))
              .join(", ")}`,
          ].join("\n"),
          remediations: [RE_RUN_THE_LOOP, RECORD_AND_COMMIT],
        }),
      );
      return await settle();
    }

    recordPath = selected.path;
    check = verifyDeliveryRecord(config, selected.record, identity, base);
    blockers.push(...check.blockers);
    return await settle();
  } catch (error) {
    blockers.push(
      createInternalErrorBlocker({
        source: ACTION_SOURCE,
        error,
        reproduce: ["delivery-harness", "verify"],
      }),
    );
    return await settle();
  }
}

async function workspaceHas(runtime: ActionRuntime, relativePath: string): Promise<boolean> {
  const absolute = path.join(runtime.workspace, relativePath);
  if (runtime.pathExists !== undefined) return runtime.pathExists(absolute);
  try {
    await access(absolute);
    return true;
  } catch {
    return false;
  }
}

// ── The default runtime ──────────────────────────────────────────────────────

/**
 * Loads the consumer's `harness.config.ts` and validates it through the kernel.
 *
 * The Action carries its own loader rather than importing the CLI's: the Action
 * is a wrapper over the *kernel*, and a dependency on the operator CLI would put
 * seven commands and an interactive prompt behind a read-only check. The
 * validation itself is the kernel's single implementation; only the import and
 * the blocker's source id are local, so the two loaders cannot disagree about
 * what a valid config is.
 */
export async function importHarnessConfig(rootDir: string): Promise<HarnessConfig> {
  const configPath = path.join(rootDir, "harness.config.ts");
  let loaded: unknown;
  try {
    const module = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
    loaded = module.default;
  } catch (error) {
    throw new BlockedError([
      actionBlocker({
        code: "config_unloadable",
        summary: "The harness configuration could not be loaded.",
        details: `${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        remediations: [
          { id: "provide-a-harness-config", kind: "manual_action", summary: "Provide a valid harness.config.ts at the repository root." },
        ],
      }),
    ]);
  }
  const validation = validateHarnessConfig(loaded);
  if (!validation.ok) throw new BlockedError(validation.blockers);
  return validation.config;
}

export function defaultRuntime(): ActionRuntime {
  const workspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  const outputPath = process.env["GITHUB_OUTPUT"];
  return {
    env: process.env,
    workspace,
    git: runGitCommand,
    readFile: (absolutePath) => readFile(absolutePath, "utf8"),
    loadConfig: importHarnessConfig,
    writeSummary: async (markdown) => {
      if (summaryPath === undefined || summaryPath === "") {
        process.stdout.write(markdown);
        return;
      }
      await appendFile(summaryPath, markdown, "utf8");
    },
    writeOutputs: async (outputs) => {
      if (outputPath === undefined || outputPath === "") return;
      // The heredoc form: an output value is arbitrary text, and `key=value`
      // breaks the moment one contains a newline.
      const body = Object.entries(outputs)
        .map(([key, value]) => `${key}<<__DELIVERY_HARNESS_EOF__\n${value}\n__DELIVERY_HARNESS_EOF__\n`)
        .join("");
      await appendFile(outputPath, body, "utf8");
    },
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

/** Resolves an argv entry to the href form `import.meta.url` carries. */
export function entryHref(argvEntry: string): string {
  return pathToFileURL(argvEntry).href;
}

/**
 * Whether this module is the entry the process was started with. Built with
 * `pathToFileURL` rather than by interpolating into a `file://` string: a `#` or
 * `?` in any directory name would terminate the interpolated form early, the
 * href would stop matching, and the Action would exit 0 having verified nothing.
 */
export function invokedDirectly(argvEntry: string | undefined, moduleHref: string): boolean {
  return argvEntry !== undefined && entryHref(argvEntry) === moduleHref;
}

export async function main(): Promise<number> {
  const result = await runAction(defaultRuntime());
  return result.exitCode;
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  // FAIL CLOSED BEFORE ANYTHING RUNS. Node's default exit code is 0, so any way
  // of leaving without a verdict — a promise that never settles, an event loop
  // that drains early — would report a passing check from a job that decided
  // nothing. Starting at a failure inverts that default.
  process.exitCode = ACTION_EXIT_POLICY;
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = ACTION_EXIT_POLICY;
    });
}
