import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  createArtifactsPort,
  defineHarnessConfig,
  publishPreparationReceipt,
  submitManifest,
  type CapturedCandidate,
  type HarnessConfig,
  type SubmissionOutcome,
} from "@agent-delivery-harness/kernel";
import {
  invokeProviderRail,
  openProviderRailProcess,
  type ProviderRailSession,
} from "../packages/cli/src/provider-rails.ts";

export const HARNESS_BASELINE = "b7d62db716e335b25e13f1029ee9c3896244e315" as const;
export const AGENT_SKILLS_BASELINE = "9ad6a934e97222cd819b8e48b7e258effa89a09e" as const;
export const PROTOCOL_VERSION = "delivery-provider-rails/1" as const;

const ARCHIVE_SHA256 = "0e5a2e536ce104f0c8c7956f373990064ecae709fe287c4504d30f2a4314094f";
const METADATA_SHA256 = "9c6f96a9994c0faf6dc84a3d907be60ebd82bb7e5579256c853855010d324d99";
const INSTALLED_PROVIDER_SHA256 = "3f68ac3d677384c6229a3a8215c969bd211c477afbdea1712e564d634e82504f";
const PROVIDER_RAIL_SHA256 = "7cb6245980961ba6103e15783d8a9636987e223b7b03d5350cbf3643d64b4954";
const RECORDER_SHA256 = "1a246e103afa378a6dcc0c5822242282c9ebdf039d1c85a8eaad1bc2f674a53a";
const CONTRACT_SHA256 = "ffeb3f5fe5baa4f288601e7550b06e1bff36f5160fc0ab48059ea403ed5b1c1e";
const CONTRACT_SCHEMA_SHA256 = "7242d88fadc5087b1d63e0065565cd6e272225b2a2240c14de2fe4db305ea0e6";
const CONTRACT_VECTORS_SHA256 = "1ceb7d7e2043d71f7dea0d95ba2dcb97d2977c56d0045a7001c44eb777dbb2bf";
const INSTALLED_WORKFLOWS_SHA256 = "3fbe993bfb10ea6663c62a0a0d3243153fe6f0136807f191d7fe020e482c8353";
const CORE_QUALIFICATION_SHA256 = "c88f1b9b8974400e49cf8229f211647226705ae0bd0bac0f63ddc9aec5548063";
const PROVIDER_QUALIFICATION_SHA256 = "092691d27d2dfe312ac17d18634f4292e52abc2c3efbdaf9568cd7ad8f43768e";
const LINEAR_QUALIFICATION_SHA256 = "fd450a03db73312f449c0aeef2907aa0712ad372071fbccd1b367428532649a3";
const LINEAR_ATTESTATION_SHA256 = "9e59c80307c6cd365abbe646d52effa512610e707b32074fe8a8632cf329cbb3";
const HARNESS_TREE_SHA = "41e4333f18aa63e013b323cba9f6c52b030f1c12";
const AGENT_SKILLS_TREE_SHA = "26034f0e5eea07d066e855100cfd4cabf1195eee";

const PROVIDER_ID = "agent-skills.review";
const OPERATIONS = ["create", "read", "update", "search", "relations", "reconciliation"] as const;
const RELEASE = {
  archiveSha256: ARCHIVE_SHA256,
  metadataSha256: METADATA_SHA256,
  profile: "core",
  releaseId: "core-v1",
} as const;

const CANDIDATE: CapturedCandidate = {
  vcs: "git",
  treeSha: "0d54118bd32b4b84db10f584b3b593e79f6c59d9",
  headSha: "478e8477c64fb64f673cbc9c9523f01d300f74b6",
  deliverable: {
    digest: "a848d8a52e0432790403be7f89cfc55a88ee6727d8f399f8a78c4f4f92e1388f",
    identity: "delivery-harness-tree/v1",
  },
  base: {
    ref: "baseline",
    tipSha: "00c87542800ff9e5ab323b058f7d61e5d9f0dcb8",
    mergeBaseSha: "00c87542800ff9e5ab323b058f7d61e5d9f0dcb8",
  },
  workspaceId: "provider-interoperability",
  mode: "clean",
  statusEntries: [],
  untrackedFiles: [],
};

interface QualificationScenario {
  readonly id: string;
  readonly result: "passed";
  readonly assertionCount: number;
  readonly evidence: readonly string[];
}

interface QualificationCandidateBinding {
  readonly treeSha: string;
  readonly deliverableDigest: string;
  readonly identityToken: string;
  readonly baseRef: string;
  readonly baseTipSha: string;
  readonly mergeBaseSha: string;
  readonly workspaceId: string;
}

export interface AgentSkillsProviderQualification {
  readonly schemaVersion: "provider-harness-interoperability/1";
  readonly baselines: {
    readonly harness: {
      readonly commitSha: typeof HARNESS_BASELINE;
      readonly treeSha: string;
      readonly providerRailSha256: string;
      readonly recorderSha256: string;
    };
    readonly agentSkills: {
      readonly commitSha: typeof AGENT_SKILLS_BASELINE;
      readonly treeSha: string;
      readonly archiveSha256: string;
      readonly metadataSha256: string;
      readonly installedProviderSha256: string;
      readonly installedWorkflowsSha256: string;
      readonly coreQualificationSha256: string;
      readonly providerQualificationSha256: string;
      readonly linearQualificationSha256: string;
      readonly linearAttestationSha256: string;
      readonly profile: "core";
      readonly releaseId: "core-v1";
    };
  };
  readonly protocol: { readonly version: typeof PROTOCOL_VERSION; readonly contractSha256: string; readonly schemaSha256: string; readonly vectorsSha256: string };
  readonly capabilities: { readonly required: readonly string[]; readonly observed: readonly string[] };
  readonly evidence: {
    readonly manifestDigest: string;
    readonly candidateBinding: QualificationCandidateBinding;
    readonly resolution: {
      readonly kind: "evidence";
      readonly providerId: string;
      readonly runId: string;
      readonly finalPassId: string;
    };
    readonly publication: { readonly first: "published"; readonly reconciled: "idempotent"; readonly recordCount: 1 };
  };
  readonly scenarios: readonly QualificationScenario[];
  readonly proofBoundary: { readonly offline: string; readonly external: string };
  readonly summary: { readonly passed: 6; readonly failed: 0; readonly result: "passed" };
}

export interface QualificationInput {
  readonly root: string;
  readonly archive: string;
  readonly metadata: string;
}

interface QualificationPreflight {
  readonly archiveSha256: string;
  readonly metadataSha256: string;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(file: string): Promise<string> {
  return sha256(await readFile(file));
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`qualification failed: ${message}`);
}

/** Immutable byte checks run before Python discovery, installation, or provider startup. */
export async function verifyQualificationInputs(input: QualificationInput): Promise<QualificationPreflight> {
  const expected = [
    [input.archive, ARCHIVE_SHA256],
    [input.metadata, METADATA_SHA256],
    [path.join(input.root, "packages/cli/src/provider-rails.ts"), PROVIDER_RAIL_SHA256],
    [path.join(input.root, "packages/kernel/src/recorder.ts"), RECORDER_SHA256],
    [path.join(input.root, "docs/contracts/delivery-provider-rails-v1.md"), CONTRACT_SHA256],
    [path.join(input.root, "docs/contracts/delivery-provider-rails.schema.json"), CONTRACT_SCHEMA_SHA256],
    [path.join(input.root, "packages/cli/fixtures/delivery-provider-rails-v1.json"), CONTRACT_VECTORS_SHA256],
    [path.join(input.root, "qualifications/fixtures/agent-skills-core-qualification.json"), CORE_QUALIFICATION_SHA256],
    [path.join(input.root, "qualifications/fixtures/agent-skills-provider-qualification.json"), PROVIDER_QUALIFICATION_SHA256],
    [path.join(input.root, "qualifications/fixtures/agent-skills-linear-qualification.json"), LINEAR_QUALIFICATION_SHA256],
    [path.join(input.root, "qualifications/fixtures/agent-skills-linear-attestation.json"), LINEAR_ATTESTATION_SHA256],
  ] as const;
  for (const [file, digest] of expected) {
    invariant(await sha256File(file) === digest, `immutable input ${path.basename(file)} differs`);
  }
  return { archiveSha256: ARCHIVE_SHA256, metadataSha256: METADATA_SHA256 };
}

async function run(executable: string, args: readonly string[], options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(executable)} exited ${String(code)}: ${(stderr.trim() || stdout.trim())}`));
    });
  });
}

async function pythonExecutable(cwd: string): Promise<string> {
  const configured = process.env["PYTHON"];
  const candidates = configured === undefined ? (process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) : [configured];
  for (const candidate of candidates) {
    try {
      await run(candidate, ["--version"], { cwd });
      return candidate;
    } catch {
      // Try the next conventional executable name.
    }
  }
  throw new Error("qualification failed: Python 3 is unavailable");
}

function harnessConfig(): HarnessConfig {
  return defineHarnessConfig({
    gateId: "provider.interoperability",
    baseRef: "baseline",
    storageNamespace: "provider-interoperability/",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: ["delivery-harness-tree/v1"],
    computingIdentityVersion: "delivery-harness-tree/v1",
    reviewNeutral: [{ prefix: "delivery/records/" }],
    recordNeutral: [{ prefix: "delivery/records/" }],
    pathClassification: { generated: [], test: [], lockfile: [] },
    sensitivePaths: [],
    activationThreshold: 1,
    agentEnvSignals: [],
    ciPolicies: [],
    ciPolicyEnvKey: "PROVIDER_INTEROPERABILITY_POLICY",
    preparationWiringPaths: ["qualification.config.json"],
    providers: [{ id: PROVIDER_ID, findingCodes: [] }],
    obligations: [
      {
        id: "review.green",
        activation: { kind: "relevant_change" },
        freshness: "exact_candidate",
        providers: [PROVIDER_ID],
        acceptedPayloadSpecs: ["review.green/1"],
        allowedResolutionKinds: ["satisfied_evidence"],
        humanWaiverAllowed: false,
        minimumAttestationLevel: "self",
        ciDelegationPolicyIds: [],
        remediation: { default: [{ id: "rerun-provider", kind: "retry", summary: "Run the exact provider qualification again." }] },
        waivableCodes: [],
        nonWaivableCodes: [
          "review_evidence_missing",
          "stale_evidence",
          "evidence_not_green",
          "unresolved_actionable_findings",
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
    deliveryRecordPath: "delivery/records/record.json",
    deliveryRecordVerification: { baseMovement: "stale" },
  });
}

function candidateBinding(): QualificationCandidateBinding {
  return {
    treeSha: CANDIDATE.treeSha,
    deliverableDigest: CANDIDATE.deliverable.digest,
    identityToken: CANDIDATE.deliverable.identity,
    baseRef: CANDIDATE.base.ref,
    baseTipSha: CANDIDATE.base.tipSha,
    mergeBaseSha: CANDIDATE.base.mergeBaseSha,
    workspaceId: CANDIDATE.workspaceId,
  };
}

function providerPayload(runId: string, runRoot: string, options: { readonly release?: typeof RELEASE | Record<string, string>; readonly defer?: boolean } = {}): Record<string, unknown> {
  return {
    candidate: {
      vcs: CANDIDATE.vcs,
      treeSha: CANDIDATE.treeSha,
      headSha: CANDIDATE.headSha,
      deliverable: CANDIDATE.deliverable,
      base: CANDIDATE.base,
      workspaceId: CANDIDATE.workspaceId,
    },
    gateId: "provider.interoperability",
    obligationIds: ["review.green"],
    providerId: PROVIDER_ID,
    runId,
    runRoot,
    agentSkills: {
      defer: options.defer === true,
      hostEvents: OPERATIONS.map((operation, index) => ({ kind: "evidence", operation, reference: `host-ref-${index + 1}` })),
      recordedAt: "2026-08-28T12:00:00Z",
      release: options.release ?? RELEASE,
      review: {
        findings: [],
        maxRounds: 1,
        requiredLenses: ["correctness", "testing"],
        rounds: [
          {
            preparedTreeSha: CANDIDATE.treeSha,
            results: [
              { evidence: ["source inspection"], findings: [], lens: "correctness", outcome: "aligned" },
              { evidence: ["focused sensor"], findings: [], lens: "testing", outcome: "aligned" },
            ],
          },
        ],
      },
      workflowId: "review-work",
    },
  };
}

async function installProvider(input: QualificationInput, work: string): Promise<{ readonly python: string; readonly repository: string; readonly generation: string }> {
  const python = await pythonExecutable(work);
  const repository = path.join(work, "repository");
  const bootstrap = path.join(work, "bootstrap");
  await Promise.all([mkdir(repository, { recursive: true }), mkdir(bootstrap, { recursive: true })]);
  await run("git", ["init", "--quiet"], { cwd: repository });
  await run(
    python,
    ["-B", "-c", "import pathlib,sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(pathlib.Path(sys.argv[2]))", input.archive, bootstrap],
    { cwd: work },
  );
  const environment: NodeJS.ProcessEnv = { ...process.env, AGENT_SKILLS_EXECUTION_CONTEXT: "", GITHUB_EVENT_NAME: "" };
  delete environment["PYTHONPATH"];
  await run(
    python,
    ["-B", "-m", "agent_skills.cli", "--root", repository, "install", "--archive", input.archive, "--metadata", input.metadata, "--maintenance"],
    { cwd: bootstrap, env: environment },
  );
  const generation = path.join(repository, ".agent-skills", "generations", ARCHIVE_SHA256);
  invariant(await sha256File(path.join(generation, "agent_skills", "provider.py")) === INSTALLED_PROVIDER_SHA256, "installed provider identity differs");
  invariant(await sha256File(path.join(generation, "agent_skills", "workflows.py")) === INSTALLED_WORKFLOWS_SHA256, "installed workflow identity differs");
  return { python, repository, generation };
}

function openInstalled(python: string, repository: string, generation: string): Promise<ProviderRailSession> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment["PYTHONPATH"];
  return openProviderRailProcess({
    command: [python, "-B", "-m", "agent_skills.provider", "--root", repository],
    cwd: generation,
    env: environment,
  });
}

interface CancellationObservation {
  requestSent: boolean;
  progressObserved: boolean;
  sessionClosed: boolean;
}

function abortAfterDeferredProgress(
  session: ProviderRailSession,
  requestId: string,
  controller: AbortController,
  observation: CancellationObservation,
): ProviderRailSession {
  return {
    async send(message) {
      if (message.kind === "request" && message.requestId === requestId) observation.requestSent = true;
      await session.send(message);
    },
    async receive() {
      const message = await session.receive();
      if (
        !observation.progressObserved &&
        typeof message === "object" &&
        message !== null &&
        (message as { kind?: unknown }).kind === "progress" &&
        (message as { requestId?: unknown }).requestId === requestId
      ) {
        observation.progressObserved = true;
        setImmediate(() => controller.abort());
      }
      return message;
    },
    async close(options) {
      await session.close(options);
      observation.sessionClosed = true;
    },
  };
}

async function allocate(artifacts: ReturnType<typeof createArtifactsPort>, runId: string): Promise<string> {
  const allocation = await artifacts.allocateRunRoot({ providerId: PROVIDER_ID, runId });
  invariant(allocation.ok, `run root ${runId} was not allocated`);
  return allocation.runRoot.path;
}

async function countRecords(storageRoot: string): Promise<number> {
  try {
    return (await readdir(path.join(storageRoot, "records"))).filter((entry) => entry.endsWith(".json")).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function scenario(id: string, evidence: readonly string[]): QualificationScenario {
  invariant(evidence.length > 0, `${id} evidence is empty`);
  return { id, result: "passed", assertionCount: evidence.length, evidence };
}

export async function qualifyAgentSkillsProvider(input: QualificationInput): Promise<AgentSkillsProviderQualification> {
  await verifyQualificationInputs(input);
  const work = await mkdtemp(path.join(os.tmpdir(), "provider-interoperability-"));
  try {
  const changedMetadata = path.join(work, "changed.release.json");
  const changedMetadataBytes = Buffer.from(await readFile(input.metadata));
  changedMetadataBytes[0] = (changedMetadataBytes[0] ?? 0) ^ 1;
  await writeFile(changedMetadata, changedMetadataBytes);
  let immutableMismatchRejected = false;
  try {
    await verifyQualificationInputs({ ...input, metadata: changedMetadata });
  } catch {
    immutableMismatchRejected = true;
  }
  invariant(immutableMismatchRejected, "changed immutable metadata passed preflight");

  const config = harnessConfig();
  const { python, repository, generation } = await installProvider(input, work);
  await writeFile(path.join(repository, "qualification.config.json"), `${canonicalize({ gateId: config.gateId, protocol: PROTOCOL_VERSION })}\n`, "utf8");
  const storageRoot = path.join(work, "storage");
  const runRootBase = path.join(work, "runs");
  await Promise.all([mkdir(storageRoot, { recursive: true }), mkdir(runRootBase, { recursive: true })]);
  const artifacts = createArtifactsPort({ runRootBase });
  await publishPreparationReceipt(repository, { config, candidate: CANDIDATE }, { storageRoot });
  const captureCandidate = async () => ({ ok: true as const, candidate: CANDIDATE });
  const publish = (runId: string, runRootPath: string, manifestPath: string): Promise<SubmissionOutcome> =>
    submitManifest(
      { rootDir: repository, config, manifestPath },
      {
        artifacts,
        captureCandidate,
        storageRoot,
        expectedProviderAttempt: { providerId: PROVIDER_ID, runId, runRootPath },
      },
    );

  let happyManifest = "";
  let firstPublication: SubmissionOutcome | undefined;
  const happyRoot = await allocate(artifacts, "happy-run");
  const happy = await invokeProviderRail(
    {
      providerId: PROVIDER_ID,
      requestId: "happy-run",
      idempotencyKey: "attempt-happy-run",
      payload: providerPayload("happy-run", happyRoot),
      requiresEvidence: true,
    },
    {
      open: () => openInstalled(python, repository, generation),
      publishManifest: async (manifestPath) => {
        happyManifest = manifestPath;
        firstPublication = await publish("happy-run", happyRoot, manifestPath);
        return firstPublication;
      },
    },
  );
  invariant(happy.kind === "success", "pinned provider did not complete successfully");
  const observed = happy.events
    .map((event) => event.details?.["operation"])
    .filter((operation): operation is string => typeof operation === "string");
  invariant(canonicalize(observed) === canonicalize(OPERATIONS), "native operation names changed across the subprocess boundary");
  invariant(happy.events.some((event) => event.kind === "evidence"), "happy path emitted no rail evidence");
  invariant(firstPublication?.status === "accepted", "happy manifest was not accepted by the recorder");
  invariant(firstPublication.records[0]?.status === "published", "first evidence claim was not newly published");
  const firstManifestSha256 = await sha256File(happyManifest);

  const unsupported = await openInstalled(python, repository, generation);
  await unsupported.send({ kind: "negotiate", supportedVersions: ["incompatible/1"] });
  const unsupportedNegotiation = await unsupported.receive();
  invariant(
    (unsupportedNegotiation as { outcome?: unknown; selectedVersion?: unknown } | null)?.outcome === "unsupported" &&
      (unsupportedNegotiation as { selectedVersion?: unknown }).selectedVersion === null,
    "incompatible protocol did not fail before execution",
  );
  await unsupported.close();

  const mismatchRoot = await allocate(artifacts, "release-mismatch");
  const recordsBeforeMismatch = await countRecords(storageRoot);
  let mismatchPublicationCalled = false;
  const mismatch = await invokeProviderRail(
    {
      providerId: PROVIDER_ID,
      requestId: "release-mismatch",
      idempotencyKey: "attempt-release-mismatch",
      payload: providerPayload("release-mismatch", mismatchRoot, { release: { ...RELEASE, archiveSha256: "0".repeat(64) } }),
      requiresEvidence: true,
    },
    {
      open: () => openInstalled(python, repository, generation),
      publishManifest: async (manifestPath) => {
        mismatchPublicationCalled = true;
        return publish("release-mismatch", mismatchRoot, manifestPath);
      },
    },
  );
  invariant(mismatch.kind === "blocked" && mismatch.status === "blocked", "release mismatch did not fail closed");
  invariant(mismatch.blockers.some((blocker) => blocker.details?.includes("release-mismatch") === true), "release mismatch blocker was not retained");
  invariant(!mismatchPublicationCalled, "release mismatch reached publication");
  invariant((await readdir(mismatchRoot)).length === 0, "release mismatch created attempt evidence");
  invariant(await countRecords(storageRoot) === recordsBeforeMismatch, "release mismatch changed the record store");

  const crashScript = [
    "const readline=require('node:readline');",
    "const lines=readline.createInterface({input:process.stdin});",
    "lines.on('line',(line)=>{const message=JSON.parse(line);",
    `if(message.kind==='negotiate')process.stdout.write(JSON.stringify({kind:'negotiation',outcome:'supported',selectedVersion:'${PROTOCOL_VERSION}',supportedVersions:['${PROTOCOL_VERSION}']})+'\\n');`,
    "else process.exit(23);});",
  ].join("");
  const crashed = await invokeProviderRail(
    { providerId: PROVIDER_ID, requestId: "crash-run", idempotencyKey: "attempt-crash-run", payload: {}, requiresEvidence: false },
    { open: () => openProviderRailProcess({ command: [process.execPath, "-e", crashScript], cwd: work, env: process.env }) },
  );
  invariant(crashed.kind === "blocked" && crashed.status === "indeterminate", "provider crash did not fail closed");

  const cancellationRoot = await allocate(artifacts, "cancel-run");
  const controller = new AbortController();
  const cancellationObservation: CancellationObservation = { requestSent: false, progressObserved: false, sessionClosed: false };
  const cancellation = await invokeProviderRail(
    {
      providerId: PROVIDER_ID,
      requestId: "cancel-run",
      idempotencyKey: "attempt-cancel-run",
      payload: providerPayload("cancel-run", cancellationRoot, { defer: true }),
      requiresEvidence: false,
    },
    {
      open: async () =>
        abortAfterDeferredProgress(
          await openInstalled(python, repository, generation),
          "cancel-run",
          controller,
          cancellationObservation,
        ),
      signal: controller.signal,
      cancellationId: "cancel-once",
      deadlineMs: 2_000,
    },
  );
  invariant(cancellationObservation.requestSent, "cancellation request never crossed the subprocess boundary");
  invariant(cancellationObservation.progressObserved, "deferred progress was not observed before cancellation");
  invariant(cancellation.kind === "interrupted" && cancellation.status === "indeterminate", "harness cancellation was not conservatively interrupted");
  invariant(cancellationObservation.sessionClosed, "cancelled subprocess closure was not awaited");

  const afterCancellationRoot = await allocate(artifacts, "after-cancel-run");
  const afterCancellation = await invokeProviderRail(
    {
      providerId: PROVIDER_ID,
      requestId: "after-cancel-run",
      idempotencyKey: "attempt-after-cancel-run",
      payload: providerPayload("after-cancel-run", afterCancellationRoot),
      requiresEvidence: false,
    },
    { open: () => openInstalled(python, repository, generation) },
  );
  invariant(afterCancellation.kind === "success", "fresh provider did not start after cancellation cleanup");

  const missingRoot = await allocate(artifacts, "missing-evidence");
  const missingEvidence = await invokeProviderRail(
    {
      providerId: PROVIDER_ID,
      requestId: "missing-evidence",
      idempotencyKey: "attempt-missing-evidence",
      payload: providerPayload("missing-evidence", missingRoot),
      requiresEvidence: true,
    },
    {
      open: () => openInstalled(python, repository, generation),
      publishManifest: async (manifestPath) => {
        await unlink(manifestPath);
        return publish("missing-evidence", missingRoot, manifestPath);
      },
    },
  );
  invariant(missingEvidence.kind === "blocked" && missingEvidence.status === "failed", "missing evidence exposed green");
  invariant(
    missingEvidence.blockers.some((blocker) => blocker.code === "artifact_file_unreadable"),
    `recorder did not own the missing-evidence refusal (${missingEvidence.blockers.map((blocker) => blocker.code).join(",")})`,
  );

  invariant(happyManifest !== "", "happy run did not retain its manifest location for reconciliation");
  let secondPublication: SubmissionOutcome | undefined;
  const rerun = await invokeProviderRail(
    {
      providerId: PROVIDER_ID,
      requestId: "happy-run",
      idempotencyKey: "attempt-happy-run",
      payload: providerPayload("happy-run", happyRoot),
      requiresEvidence: true,
    },
    {
      open: () => openInstalled(python, repository, generation),
      publishManifest: async (manifestPath) => {
        invariant(manifestPath === happyManifest, "fresh provider rerun changed its manifest location");
        invariant(await sha256File(manifestPath) === firstManifestSha256, "fresh provider rerun changed manifest bytes");
        secondPublication = await publish("happy-run", happyRoot, manifestPath);
        return secondPublication;
      },
    },
  );
  invariant(rerun.kind === "success", "fresh provider rerun did not complete");
  invariant(secondPublication?.status === "accepted" && secondPublication.records[0]?.status === "idempotent", "fresh provider rerun duplicated the green claim");
  invariant(firstPublication.records[0]?.recordId === secondPublication.records[0]?.recordId, "fresh provider rerun changed record identity");
  invariant(await countRecords(storageRoot) === 1, "reconciliation changed the green claim count");

  const published = firstPublication;
  invariant(published !== undefined && published.status === "accepted", "published evidence was unavailable");
  const evidenceRecord = published.records[0]?.record;
  invariant(evidenceRecord !== undefined && evidenceRecord.resolution.kind === "evidence", "accepted evidence record was unavailable");
  const binding = candidateBinding();
  invariant(canonicalize(evidenceRecord.candidateBinding) === canonicalize(binding), "recorder candidate binding differs from the qualified candidate");

  const scenarios = [
    scenario("happy-pinned-run", ["exact installed provider completed", "six native operation names crossed stdio", "non-empty evidence reached the recorder"]),
    scenario("incompatible-protocol-and-release", ["changed immutable input rejected before provider startup", "unsupported protocol rejected before request", "wrong release blocked before host events", "release mismatch created no manifest, publication, or record"]),
    scenario("provider-crash", ["real subprocess close before terminal remained indeterminate"]),
    scenario("cancellation", ["request crossed the harness subprocess boundary", "deferred progress was observed before abort", "aborted attempt remained interrupted and indeterminate", "cancelled subprocess closure was awaited", "fresh installed provider started and completed immediately after cleanup"]),
    scenario("missing-evidence", ["removed manifest reached the real recorder", "recorder refused publication", "missing evidence remained non-green"]),
    scenario("stable-rerun", ["fresh installed provider reused the same attempt identity and run root", "manifest bytes remained identical", "candidate and record identities remained stable", "second publication reconciled idempotently", "one green claim remained"]),
  ] as const;

  return {
    schemaVersion: "provider-harness-interoperability/1",
    baselines: {
      harness: { commitSha: HARNESS_BASELINE, treeSha: HARNESS_TREE_SHA, providerRailSha256: PROVIDER_RAIL_SHA256, recorderSha256: RECORDER_SHA256 },
      agentSkills: {
        commitSha: AGENT_SKILLS_BASELINE,
        treeSha: AGENT_SKILLS_TREE_SHA,
        archiveSha256: ARCHIVE_SHA256,
        metadataSha256: METADATA_SHA256,
        installedProviderSha256: INSTALLED_PROVIDER_SHA256,
        installedWorkflowsSha256: INSTALLED_WORKFLOWS_SHA256,
        coreQualificationSha256: CORE_QUALIFICATION_SHA256,
        providerQualificationSha256: PROVIDER_QUALIFICATION_SHA256,
        linearQualificationSha256: LINEAR_QUALIFICATION_SHA256,
        linearAttestationSha256: LINEAR_ATTESTATION_SHA256,
        profile: "core",
        releaseId: "core-v1",
      },
    },
    protocol: { version: PROTOCOL_VERSION, contractSha256: CONTRACT_SHA256, schemaSha256: CONTRACT_SCHEMA_SHA256, vectorsSha256: CONTRACT_VECTORS_SHA256 },
    capabilities: { required: OPERATIONS, observed },
    evidence: {
      manifestDigest: published.manifestDigest,
      candidateBinding: binding,
      resolution: {
        kind: "evidence",
        providerId: evidenceRecord.resolution.providerId,
        runId: evidenceRecord.resolution.runId,
        finalPassId: evidenceRecord.resolution.finalPassId,
      },
      publication: { first: "published", reconciled: "idempotent", recordCount: 1 },
    },
    scenarios,
    proofBoundary: {
      offline: "Binds the exact retained release bytes to installed provider execution, the harness subprocess rail, and recorder publication using controlled representative host events.",
      external: "The retained Linear qualification and attestation identities preserve the six-operation contract, but this replay does not prove a fresh Linear connector call; external host provenance remains owned by the protected host run.",
    },
    summary: { passed: 6, failed: 0, result: "passed" },
  };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function canonicalQualification(record: AgentSkillsProviderQualification): string {
  return `${JSON.stringify(JSON.parse(canonicalize(record)), null, 2)}\n`;
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, "..");
  const archive = path.join(root, "qualifications/fixtures/agent-skills-core-v1.zip");
  const metadata = path.join(root, "qualifications/fixtures/agent-skills-core-v1.release.json");
  const output = process.argv[2] === undefined ? path.join(root, "qualifications/agent-skills-provider-interoperability.json") : path.resolve(process.argv[2]);
  const record = await qualifyAgentSkillsProvider({ root, archive, metadata });
  const encoded = canonicalQualification(record);
  await writeFile(output, encoded, "utf8");
  process.stdout.write(`${sha256(encoded)}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
