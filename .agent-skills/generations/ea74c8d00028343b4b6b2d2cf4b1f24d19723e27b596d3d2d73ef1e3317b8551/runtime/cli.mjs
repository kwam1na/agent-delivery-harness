// packages/cli/src/main.ts
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// packages/cli/src/commands/check.ts
import path from "node:path";
import { resolveRecordStorage, BlockedError } from "./kernel.mjs";
var PROBE_FILE = ".delivery-harness-write-probe";
var checkCommand = {
  name: "check",
  sourceId: "delivery-harness.cli.check",
  summary: "Confirm the config loads and the evidence store is usable.",
  async run(context) {
    try {
      const storage = await resolveRecordStorage(context.rootDir, { storageNamespace: context.config.storageNamespace });
      const probe = path.join(storage.storageDir, PROBE_FILE);
      await context.artifacts.writeTextFile(probe, "probe\n", { mode: 384 });
      await context.artifacts.removeFile(probe);
      return {
        kind: "ok",
        summary: [
          `ok: gate ${context.config.gateId}`,
          `  ${context.config.obligations.length} obligation(s), ${context.config.providers.length} provider(s)`,
          `  store ${storage.storageDir} (writable)`,
          `  delivery record path ${context.config.deliveryRecordPath} (base movement: ${context.config.deliveryRecordVerification.baseMovement})`
        ].join("\n")
      };
    } catch (error) {
      if (error instanceof BlockedError) {
        return { kind: "blocked", blockers: [...error.blockers] };
      }
      throw error;
    }
  }
};

// packages/cli/src/commands/emit.ts
import {
  RUN_STORE_ID,
  reduceToProviderId
} from "./kernel.mjs";

// packages/cli/src/run-surface.ts
import { lstatSync } from "node:fs";
import path2 from "node:path";
import {
  createBlocker,
  createRunStore,
  sha256Hex,
  evaluateRunJournal,
  gitNamespaceClearedEnvironment,
  neutralizeForDisplay,
  resolveRunStoreLocation,
  runGitDirect
} from "./kernel.mjs";
var RUN_SURFACE_SOURCE = "delivery-harness.cli.run-surface";
var RUN_STORE_OVERRIDE = "DELIVERY_HARNESS_RUN_STORE";
function storeRootFor(commonDir, override) {
  const named = override?.trim() ?? "";
  if (named.length === 0) return { ok: true, root: commonDir };
  if (!path2.isAbsolute(named)) {
    return { ok: false, reason: `${RUN_STORE_OVERRIDE} must name an absolute directory` };
  }
  return { ok: true, root: path2.join(named, sha256Hex(commonDir)) };
}
async function resolveRunSurface(cwd) {
  const location = await resolveRunStoreLocation({
    cwd,
    run: runGitDirect,
    env: gitNamespaceClearedEnvironment()
  });
  if (!location.ok) return { ok: false, reason: location.reason };
  const rooted = storeRootFor(location.commonDir, process.env[RUN_STORE_OVERRIDE]);
  if (!rooted.ok) return { ok: false, reason: rooted.reason };
  const store = createRunStore(rooted.root);
  return {
    ok: true,
    surface: {
      store,
      commonDir: location.commonDir,
      runsDir: store.runsDir,
      worktreeKey: location.worktreeKey
    }
  };
}
async function resolveWorktreeRoot(cwd) {
  const outcome2 = await runGitDirect({
    cwd,
    args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    env: gitNamespaceClearedEnvironment()
  });
  const root = outcome2.stdout.trim();
  if (outcome2.code !== 0 || root.length === 0) return { ok: false, reason: `not a git worktree: ${cwd}` };
  return { ok: true, root };
}
function runInstant() {
  return `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19)}Z`;
}
var MIRRORED = ["ticket", "candidateTreeSha"];
function buildRunEvent(input) {
  const payload = typeof input.payload === "object" && input.payload !== null ? input.payload : void 0;
  const mirrored = {};
  if (payload !== void 0) {
    for (const member of MIRRORED) {
      if (Object.prototype.hasOwnProperty.call(payload, member) && payload[member] !== void 0) {
        mirrored[member] = payload[member];
      }
    }
  }
  return {
    version: input.version ?? "run-event/1",
    ...input.eventId === void 0 ? {} : { eventId: input.eventId },
    runId: input.runId,
    at: runInstant(),
    repo: { commonDir: input.commonDir },
    kind: input.kind,
    actor: { role: input.role },
    ...mirrored,
    attestation: "self",
    payload: input.payload ?? null
  };
}
function oneLine(value2, maximum = 240) {
  const collapsed = neutralizeForDisplay(value2).replace(/\s+/g, " ").trim();
  return collapsed.length <= maximum ? collapsed : `${collapsed.slice(0, Math.max(maximum - 1, 0))}\u2026`;
}
function oneLineOf(value2, maximum = 240) {
  if (typeof value2 === "string") return oneLine(value2, maximum);
  if (value2 === void 0) return "";
  return oneLine(JSON.stringify(value2) ?? String(value2), maximum);
}
var RUN_JOURNAL_ROW_LABELS = "self-attested; observability, not evidence; bound to the record";
var ABSENT = { status: "absent", missing: [], attestation: "self" };
async function resolveRunJournalRow(input) {
  const resolved = await resolveRunSurface(input.cwd);
  if (!resolved.ok) return ABSENT;
  const match = await resolved.surface.store.findByCandidateTreeSha(input.treeSha);
  if (match === void 0) return ABSENT;
  const read = await resolved.surface.store.read(match.runId);
  if (!read.ok) return ABSENT;
  const evaluation = evaluateRunJournal(read.events, input.treeSha, input.mandatedLensIds);
  return {
    runId: match.runId,
    ...match.alsoMatching.length === 0 ? {} : { alsoMatching: match.alsoMatching },
    status: evaluation.status,
    missing: evaluation.missing,
    ...evaluation.violations.length === 0 ? {} : { violations: evaluation.violations },
    attestation: "self"
  };
}
function runJournalRows(row) {
  const rows = [`  run journal: ${oneLine(row.status, 64)}  (${RUN_JOURNAL_ROW_LABELS})`];
  if (row.runId !== void 0) rows.push(`    run: ${oneLine(row.runId, 128)}`);
  if (row.alsoMatching !== void 0 && row.alsoMatching.length > 0) {
    rows.push(`    also matching: ${row.alsoMatching.map((id) => oneLine(id, 128)).join(", ")}`);
  }
  rows.push(`    missing: ${row.missing.length === 0 ? "(none)" : row.missing.map((entry) => oneLine(entry, 64)).join(", ")}`);
  if (row.violations !== void 0 && row.violations.length > 0) {
    rows.push(`    violations: ${row.violations.map((entry) => oneLine(entry, 64)).join(", ")}`);
  }
  return rows;
}
function runSurfaceBlocker(input) {
  return createBlocker({
    code: input.code,
    source: { kind: "command", id: RUN_SURFACE_SOURCE },
    summary: input.summary,
    ...input.details === void 0 ? {} : { details: input.details },
    remediations: [{ id: input.remediation.id, kind: "manual_action", summary: input.remediation.summary }]
  });
}
function harnessConfigPresentAt(rootDir) {
  try {
    return lstatSync(path2.join(rootDir, "harness.config.ts")).isFile();
  } catch {
    return false;
  }
}

// packages/cli/src/commands/emit.ts
var USAGE = "Usage: delivery-harness emit <kind> [--run <id>] [--json <payload>] [--force] [--version 1|2] [--event-id <id>]";
function parseArgs(args) {
  let kind;
  let run;
  let json;
  let force = false;
  let version;
  let eventId;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--force") {
      force = true;
      continue;
    }
    if (token === "--run" || token === "--json" || token === "--version" || token === "--event-id") {
      const value2 = args[index + 1];
      if (value2 === void 0) return { ok: false, message: `${token} needs a value.
${USAGE}` };
      if (token === "--run") run = value2;
      else if (token === "--json") json = value2;
      else if (token === "--event-id") eventId = value2;
      else {
        if (value2 !== "1" && value2 !== "2") return { ok: false, message: `--version must be 1 or 2.
${USAGE}` };
        version = value2 === "1" ? "run-event/1" : "run-event/2";
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, message: `Unknown flag ${oneLine(token, 64)}.
${USAGE}` };
    if (kind !== void 0) return { ok: false, message: `emit takes one kind.
${USAGE}` };
    kind = token;
  }
  if (kind === void 0) return { ok: false, message: `emit needs a kind.
${USAGE}` };
  return { ok: true, args: {
    kind,
    force,
    ...run === void 0 ? {} : { run },
    ...json === void 0 ? {} : { json },
    ...version === void 0 ? {} : { version },
    ...eventId === void 0 ? {} : { eventId }
  } };
}
function parsePayload(text2) {
  const trimmed = text2.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
var noRun = (details) => runSurfaceBlocker({
  code: "run_unresolvable",
  summary: "There is no current run to emit against.",
  details,
  remediation: {
    id: "start-a-run",
    summary: "Run `delivery-harness emit run.started` in this worktree, or name an existing run with --run."
  }
});
async function resolveRun(store, surface, named) {
  if (named !== void 0) {
    if (named.length > 128 || !RUN_STORE_ID.test(named)) return void 0;
    const read = await store.read(named);
    return read.ok ? named : void 0;
  }
  const current = await store.current(surface.worktreeKey);
  return current.ok ? current.runId : void 0;
}
var emitCommand = {
  name: "emit",
  sourceId: "delivery-harness.cli.emit",
  summary: "Append one run event to the current delivery run's journal.",
  configFree: true,
  async run(context) {
    const parsed = parseArgs(context.args);
    if (!parsed.ok) return { kind: "usage", message: parsed.message };
    const { kind, run: named, force } = parsed.args;
    const resolved = await resolveRunSurface(context.rootDir);
    if (!resolved.ok) {
      return {
        kind: "blocked",
        blockers: [
          runSurfaceBlocker({
            code: "run_store_unresolvable",
            summary: "The run store could not be resolved.",
            details: oneLine(resolved.reason, 200),
            remediation: {
              id: "run-inside-a-repository",
              summary: "Run this command inside a git repository; the run store lives under its common directory."
            }
          })
        ]
      };
    }
    const surface = resolved.surface;
    const store = surface.store;
    if (kind === "run.started") {
      const version2 = parsed.args.version ?? "run-event/1";
      if (version2 === "run-event/2" !== (parsed.args.eventId !== void 0)) {
        return { kind: "usage", message: `Version 2 requires --event-id; version 1 does not accept it.
${USAGE}` };
      }
      return startRun(surface, force, parsePayload(parsed.args.json ?? await context.readStdin()), version2, parsed.args.eventId);
    }
    const runId = await resolveRun(store, surface, named);
    if (runId === void 0) {
      return {
        kind: "blocked",
        blockers: [
          noRun(
            named === void 0 ? "no current run is pointed at from this worktree, and no --run was given" : `--run ${oneLine(named, 128)} names no readable journal in this store`
          )
        ]
      };
    }
    const history = await store.read(runId);
    if (!history.ok) return { kind: "blocked", blockers: [noRun("the selected run is unreadable")] };
    const version = history.events[0]?.version ?? "run-event/1";
    if (parsed.args.version !== void 0 && parsed.args.version !== version) {
      return { kind: "usage", message: "A run's writer version cannot change. End it and start an explicitly linked successor run." };
    }
    if (version === "run-event/2" !== (parsed.args.eventId !== void 0)) {
      return { kind: "usage", message: `Version 2 requires --event-id; version 1 does not accept it.
${USAGE}` };
    }
    const payload = parsePayload(parsed.args.json ?? await context.readStdin());
    const event = buildRunEvent({
      runId,
      commonDir: surface.commonDir,
      kind,
      role: "executor",
      payload,
      version,
      ...parsed.args.eventId === void 0 ? {} : { eventId: parsed.args.eventId }
    });
    if (kind === "command.completed") {
      await store.noteRefusal(runId, event, {
        code: "unsupported_combination",
        pointer: "/kind",
        message: "command.completed is written by the CLI; emit may not write it"
      });
      return {
        kind: "blocked",
        blockers: [
          runSurfaceBlocker({
            code: "run_event_refused",
            summary: "command.completed is written by the CLI, never by emit.",
            details: `run ${runId}: the product's own commands append their completions; an executor reports a non-product gate with gate.reported`,
            remediation: {
              id: "use-gate-reported",
              summary: "Emit gate.reported when the repository's gate is not a product command."
            }
          })
        ]
      };
    }
    const appended = await store.append(runId, event, { reuseExistingTimestamp: true });
    if (!appended.ok) {
      const first = appended.rejections[0];
      return {
        kind: "blocked",
        blockers: [
          runSurfaceBlocker({
            code: "run_event_refused",
            // The rejected kind is echoed reduced to the bound the note records
            // it at, so the diagnostic and the durable line say the same thing
            // and neither can carry an escape sequence to the terminal.
            summary: `The run event was refused: ${reduceToProviderId(kind)}`,
            details: `run ${runId}: ${first === void 0 ? "the store refused the append" : `${first.code} at ${oneLine(first.pointer, 64) || "/"}: ${oneLine(first.message, 200)}`}`,
            remediation: {
              id: "correct-the-event",
              summary: "Correct the kind or the payload against the run-event/1 contract and emit again."
            }
          })
        ]
      };
    }
    if (kind === "run.ended") await store.clearCurrent(surface.worktreeKey, runId);
    return { kind: "ok", summary: `emitted ${appended.event.kind} seq ${appended.event.seq} to run ${runId}` };
  }
};
async function startRun(surface, force, supplied, version, eventId) {
  const store = surface.store;
  const existing = await store.current(surface.worktreeKey);
  const displaced = existing.ok ? existing.runId : void 0;
  if (displaced !== void 0 && !force) {
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_already_current",
          summary: "A run is already current for this worktree.",
          details: `run ${displaced} is current; --force displaces it and records it as displacedRunId`,
          remediation: {
            id: "end-or-force",
            summary: "End the current run with `emit run.ended`, or start this one with --force."
          }
        })
      ]
    };
  }
  const allocated = await store.allocate();
  if (!allocated.ok) {
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_not_allocated",
          summary: "A run journal could not be allocated.",
          details: oneLine(allocated.rejections[0]?.message ?? "the store refused to allocate", 200),
          remediation: { id: "check-the-store", summary: "Check that the repository's git common directory is writable." }
        })
      ]
    };
  }
  const runId = allocated.runId;
  const payload = typeof supplied === "object" && supplied !== null && displaced !== void 0 ? { ...supplied, displacedRunId: displaced } : supplied;
  const appended = await store.append(
    runId,
    buildRunEvent({
      runId,
      commonDir: surface.commonDir,
      kind: "run.started",
      role: "executor",
      payload,
      version,
      ...eventId === void 0 ? {} : { eventId }
    })
  );
  if (!appended.ok) {
    const first = appended.rejections[0];
    await store.discard(runId);
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_event_refused",
          summary: "The run event was refused: run.started",
          details: `run ${runId}: ${first === void 0 ? "the store refused the append" : `${first.code} at ${oneLine(first.pointer, 64) || "/"}: ${oneLine(first.message, 200)}`}`,
          remediation: {
            id: "correct-the-event",
            summary: "Correct the payload against the run-event/1 contract and emit again."
          }
        })
      ]
    };
  }
  let pointed = await store.setCurrent(surface.worktreeKey, runId, { force });
  let displacedStale = false;
  if (!pointed.ok && !force) {
    const recheck = await store.current(surface.worktreeKey);
    if (recheck.ok && recheck.runId === void 0) {
      pointed = await store.setCurrent(surface.worktreeKey, runId, { force: true });
      displacedStale = pointed.ok;
    }
  }
  if (!pointed.ok) {
    await store.discard(runId);
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_pointer_refused",
          summary: "The worktree pointer could not be written.",
          details: `run ${runId}: ${oneLine(pointed.rejections[0]?.message ?? "the pointer was refused", 200)}`,
          // `--run` cannot help here: `run.started` allocates rather than
          // resolves, so it never reads that flag. `--force` is the one thing
          // that displaces a pointer this command refused to overwrite.
          remediation: { id: "force-the-start", summary: "Start the run with --force to displace the pointer that is already current." }
        })
      ]
    };
  }
  return {
    kind: "ok",
    summary: `started run ${runId}${displaced === void 0 ? displacedStale ? " (displaced a stale pointer naming no readable run; the run store may need attention)" : "" : ` (displaced ${displaced})`}`
  };
}

// packages/cli/src/declared-checks.ts
import { randomUUID } from "node:crypto";
import path3 from "node:path";
import { captureCheckBindings, captureCheckOutputSnapshots, digestCanonical, classifyCandidateDrift, computeCheckWiringFingerprint, createBlocker as createBlocker2, createExecPort, sha256Hex as sha256Hex2, submitManifest } from "./kernel.mjs";
async function runDeclaredCheck(context, provider, obligationIds, before) {
  const check = provider.check;
  const wiring = await context.wire();
  const fail = (code, summary, details) => [createBlocker2({
    code,
    source: { kind: "command", id: "delivery-harness.cli.gate" },
    summary,
    ...details === void 0 ? {} : { details },
    remediations: [{ id: "repair-declared-check", kind: "manual_action", summary: "Fix the declared check or its inputs, prepare the stable candidate and run gate again." }]
  })];
  const start = await wiring.captureCandidate();
  if (!start.ok) return start.blockers;
  if (classifyCandidateDrift(before, start.candidate).length) return fail("check_candidate_changed", "The candidate changed after review admission and before the check started.");
  const fingerprint = await computeCheckWiringFingerprint(context.rootDir, context.config, wiring.storageOptions);
  context.write(`checking ${provider.id}`);
  const result = await createExecPort().run({
    command: check.command[0],
    args: check.command.slice(1),
    cwd: context.rootDir,
    env: Object.fromEntries(Object.entries(context.env).filter((entry) => entry[1] !== void 0)),
    timeoutMs: check.timeoutMs,
    maxBuffer: 1024 * 1024,
    ...context.signal === void 0 ? {} : { signal: context.signal }
  });
  if (result.code !== 0 || context.signal?.aborted) return fail("check_command_failed", `Declared check ${provider.id} did not complete successfully.`, `exit ${result.code}${result.errorCode === void 0 ? "" : ` (${result.errorCode})`}
${`${result.stdout}
${result.stderr}`.slice(-4e3)}`);
  const captured = await wiring.captureCandidate();
  if (!captured.ok) return captured.blockers;
  if (classifyCandidateDrift(before, captured.candidate).length || start.candidate.headSha !== captured.candidate.headSha || fingerprint !== await computeCheckWiringFingerprint(context.rootDir, context.config, wiring.storageOptions)) return fail("check_candidate_changed", "The candidate, base or wiring changed while the check ran.");
  const binding = (await captureCheckBindings(context.rootDir, context.config, captured.candidate, wiring.storageOptions))[provider.id];
  if (binding === void 0) return fail("check_output_missing", `Declared check ${provider.id} has a missing, unreadable, oversized or escaped output.`);
  const runId = randomUUID(), finalPassId = "pass-1";
  const allocation = await context.artifacts.allocateRunRoot({ providerId: provider.id, runId });
  if (!allocation.ok) return fail("check_artifact_unavailable", "Cannot allocate the declared check evidence root.");
  const snapshots = await captureCheckOutputSnapshots(context.rootDir, check.outputs ?? []);
  if (snapshots === void 0 || digestCanonical(snapshots.map(({ path: path15, sha256 }) => ({ path: path15, sha256 }))) !== binding.outputsDigest) return fail("check_output_missing", "Declared outputs changed before evidence retention.");
  const outputArtifacts = [];
  for (const [index, output] of snapshots.entries()) {
    const contents = JSON.stringify({ path: output.path, base64: output.base64 });
    const artifactPath = `check-output-${index}.json`;
    await context.artifacts.writeTextFile(path3.join(allocation.runRoot.path, artifactPath), contents);
    outputArtifacts.push({ path: artifactPath, sha256: sha256Hex2(contents), role: "check-output" });
  }
  const payload = { verdict: "green", exitCode: 0, binding };
  const terminal = JSON.stringify({ providerId: provider.id, runId, finalPassId, ...payload });
  await context.artifacts.writeTextFile(path3.join(allocation.runRoot.path, "check-result.json"), terminal);
  const candidate = captured.candidate;
  const manifest = {
    spec: "delivery-evidence/1",
    provider: { id: provider.id, runId, finalPassId },
    candidate: { vcs: "git", treeSha: candidate.treeSha, headSha: candidate.headSha, deliverable: candidate.deliverable, base: candidate.base, workspaceId: candidate.workspaceId },
    runHistory: [{ preparedTreeSha: candidate.treeSha, evaluatedInPassId: finalPassId }],
    artifacts: [{ path: "check-result.json", sha256: sha256Hex2(terminal), role: "check-result" }, ...outputArtifacts],
    attestation: { level: "self", signatures: [] },
    recordedAt: (/* @__PURE__ */ new Date()).toISOString(),
    claims: obligationIds.map((obligation) => ({ obligation, payloadSpec: "checks.passed/1", payload }))
  };
  const manifestPath = path3.join(allocation.runRoot.path, "manifest.json");
  await context.artifacts.writeTextFile(manifestPath, JSON.stringify(manifest));
  const outcome2 = await submitManifest({ rootDir: context.rootDir, config: context.config, manifestPath }, { captureCandidate: wiring.captureCandidate, artifacts: context.artifacts, ...wiring.storageOptions });
  return outcome2.status === "accepted" ? [] : outcome2.blockers;
}

// packages/cli/src/commands/gate.ts
import { computeDeliverableIdentity, runAdmission } from "./kernel.mjs";

// packages/cli/src/boundary.ts
import path4 from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  BlockedError as BlockedError2,
  classifyExecutionContext,
  createArtifactsPort,
  createBlocker as createBlocker3,
  createCandidateCapture,
  createInternalErrorBlocker,
  evaluateCandidateActivation,
  renderBlockers,
  resolveRecordStorage as resolveRecordStorage2,
  submitManifest as submitManifest2,
  validateHarnessConfig,
  withDeliverableIdentity
} from "./kernel.mjs";

// packages/cli/src/provider-rails.ts
import {
  DELIVERY_PROVIDER_RAILS_VERSION,
  consumeProviderRailMessages,
  openProviderRailProcess,
  invokeProviderRail
} from "./kernel.mjs";

// packages/cli/src/command-activity.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var absent = { needsCandidate: false, start: async () => {
}, prompt: (prompt) => prompt, finish: async () => {
} };
function outcome(code) {
  return code === 0 ? "ok" : code === 2 ? "usage" : code === 130 ? "interrupted" : "policy";
}
async function beginCommandObservation(cwd, command) {
  try {
    const resolved = await resolveRunSurface(cwd);
    if (!resolved.ok) return absent;
    const { store, commonDir, worktreeKey } = resolved.surface;
    const current = await store.current(worktreeKey);
    if (!current.ok || current.runId === void 0) return absent;
    const runId = current.runId;
    const history = await store.read(runId);
    if (!history.ok) return absent;
    const version = history.events[0]?.version ?? "run-event/1";
    const attemptId = `command-${randomUUID2()}`;
    const activityId = attemptId;
    let candidateTreeSha;
    async function emit(kind, payload) {
      try {
        await store.append(runId, buildRunEvent({
          runId,
          commonDir,
          kind,
          role: "cli",
          version,
          ...version === "run-event/2" ? { eventId: randomUUID2() } : {},
          payload
        }));
      } catch {
      }
    }
    const binding = () => ({ activityId, attemptId, candidateTreeSha });
    async function activity(state, nextStep) {
      if (version !== "run-event/2" || candidateTreeSha === void 0) return;
      await emit("activity.observed", { ...binding(), state, owner: "delivery-harness.cli", phase: command, nextStep });
    }
    return {
      needsCandidate: version === "run-event/2",
      async start(tree) {
        candidateTreeSha = tree;
        await activity("running", "Await command outcome; intermediate progress is unavailable unless explicitly observed.");
      },
      prompt(prompt) {
        return async (decision, obligations) => {
          if (version !== "run-event/2" || candidateTreeSha === void 0) return prompt(decision, obligations);
          const waitId = `wait-${randomUUID2()}`;
          const scope = "This command invocation and the waiver decision's candidate and obligations only; this observation grants no authority.";
          await activity("waiting", "Respond to the native waiver prompt.");
          await emit("wait.started", { ...binding(), waitId, owner: "operator", waitingOn: "human", reason: "The executing command opened its native waiver prompt.", nextAction: "Answer the native prompt.", scope });
          try {
            const answer = await prompt(decision, obligations);
            await emit("wait.resolved", { ...binding(), waitId, resolution: answer === false ? "Native prompt declined." : "Native prompt answered; approval remains subject to the gate.", scope });
            return answer;
          } catch (error) {
            await emit("wait.resolved", { ...binding(), waitId, resolution: "Native prompt ended without a decision.", scope });
            throw error;
          } finally {
            await activity("running", "Await command outcome.");
          }
        };
      },
      async finish(code, durationMs, digest) {
        await activity(code === 0 ? "completed" : code === 130 ? "interrupted" : "failed", `Command returned ${outcome(code)} (exit ${code}); continue the declared delivery workflow.`);
        await emit("command.completed", {
          command,
          outcome: outcome(code),
          durationMs,
          ...code === 0 && digest !== void 0 ? { digest } : {}
        });
      }
    };
  } catch {
    return absent;
  }
}

// packages/cli/src/boundary.ts
var EXIT_OK = 0;
var EXIT_POLICY = 1;
var EXIT_USAGE = 2;
var EXIT_INTERRUPTED = 130;
var CliInterruption = class extends Error {
  constructor(message = "Interrupted.") {
    super(message);
    this.name = "CliInterruption";
  }
};
function isConfigFreeCommand(descriptor) {
  return descriptor.configFree === true;
}
function commandBlocker(input) {
  return createBlocker3({
    code: input.code,
    source: { kind: "command", id: input.sourceId },
    summary: input.summary,
    ...input.details === void 0 ? {} : { details: input.details },
    remediations: input.remediations
  });
}
async function importHarnessConfig(rootDir) {
  const configPath = path4.join(rootDir, "harness.config.ts");
  let loaded;
  try {
    const module = await import(pathToFileURL(configPath).href);
    loaded = module.default;
  } catch (error) {
    throw new BlockedError2([
      commandBlocker({
        code: "config_unloadable",
        sourceId: "delivery-harness.cli.config",
        summary: "The harness configuration could not be loaded.",
        details: `${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        remediations: [
          {
            id: "create-harness-config",
            kind: "manual_action",
            summary: "Provide a valid harness.config.ts at the repository root."
          }
        ]
      })
    ]);
  }
  const validation = validateHarnessConfig(loaded);
  if (!validation.ok) {
    throw new BlockedError2(validation.blockers);
  }
  return validation.config;
}
async function wireRepo(rootDir, config) {
  const storageOptions = { storageNamespace: config.storageNamespace };
  const storage = await resolveRecordStorage2(rootDir, storageOptions);
  const captureCandidate = createCandidateCapture({
    rootDir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity()
  });
  const projectActivation = (candidate) => evaluateCandidateActivation({ rootDir, candidate, config });
  return { rootDir, workspaceId: storage.workspaceId, captureCandidate, projectActivation, storageOptions };
}
var USAGE2 = (commands) => [
  "Usage: delivery-harness <command> [options]",
  "",
  "Commands:",
  ...commands.map((command) => `  ${command.name.padEnd(16)}${command.summary}`)
].join("\n");
var COMPLETION_WRAPPED_COMMANDS = [
  "check",
  "prepare",
  "review-context",
  "emit-review-evidence",
  "submit-evidence",
  "gate",
  "record",
  "verify"
];
async function runCliBoundary(argv, commands, runtime) {
  const [commandName, ...args] = argv;
  if (commandName === void 0 || commandName === "--help" || commandName === "-h" || commandName === "help") {
    runtime.stdout(`${USAGE2(commands)}
`);
    return commandName === void 0 ? EXIT_USAGE : EXIT_OK;
  }
  const descriptor = commands.find((command) => command.name === commandName);
  if (descriptor === void 0) {
    runtime.stderr(`Unknown command: ${commandName}

${USAGE2(commands)}
`);
    return EXIT_USAGE;
  }
  if (isConfigFreeCommand(descriptor)) {
    return runConfigFreeCommand(descriptor, args, runtime);
  }
  const prepareHelp = descriptor.name === "prepare" && args.length === 1 && ["--help", "-h"].includes(args[0]);
  const startedAt = Date.now();
  const observation = !prepareHelp && COMPLETION_WRAPPED_COMMANDS.includes(descriptor.name) ? await beginCommandObservation(runtime.cwd, descriptor.name) : void 0;
  let digest;
  const code = await runConfiguredCommand(descriptor, args, runtime, (value2) => {
    digest = value2;
  }, observation);
  await observation?.finish(code, Date.now() - startedAt, digest);
  return code;
}
async function runConfigFreeCommand(descriptor, args, runtime) {
  try {
    const result = await descriptor.run({
      rootDir: runtime.cwd,
      env: runtime.env,
      args,
      readStdin: runtime.readStdin ?? (async () => ""),
      write: (text2) => runtime.stdout(`${text2}
`),
      ...runtime.signal === void 0 ? {} : { signal: runtime.signal }
    });
    if (result.kind === "ok") {
      if (result.summary !== void 0 && result.summary !== "") runtime.stdout(`${result.summary}
`);
      return EXIT_OK;
    }
    if (result.kind === "usage") {
      runtime.stderr(`${result.message}
`);
      return EXIT_USAGE;
    }
    runtime.stderr(`${renderBlockers(result.blockers)}
`);
    return EXIT_POLICY;
  } catch (error) {
    if (error instanceof CliInterruption) {
      runtime.stderr(`${error.message}
`);
      return EXIT_INTERRUPTED;
    }
    if (error instanceof BlockedError2) {
      runtime.stderr(`${renderBlockers(error.blockers)}
`);
      return EXIT_POLICY;
    }
    const blocker = createInternalErrorBlocker({
      source: { kind: "command", id: descriptor.sourceId },
      error,
      reproduce: ["delivery-harness", descriptor.name]
    });
    runtime.stderr(`${renderBlockers([blocker])}
`);
    return EXIT_POLICY;
  }
}
async function runConfiguredCommand(descriptor, args, runtime, observeDigest, observation) {
  const loadConfig = runtime.loadConfig ?? importHarnessConfig;
  const artifacts = runtime.artifacts ?? createArtifactsPort();
  try {
    const config = await loadConfig(runtime.cwd);
    let wiringPromise;
    const wire = () => {
      wiringPromise ??= wireRepo(runtime.cwd, config);
      return wiringPromise;
    };
    if (observation?.needsCandidate) {
      try {
        const capture = await (await wire()).captureCandidate();
        if (capture.ok) await observation.start(capture.candidate.treeSha);
      } catch {
      }
    }
    const context = {
      rootDir: runtime.cwd,
      config,
      ...runtime.policyBinding === void 0 ? {} : { policyBinding: runtime.policyBinding },
      env: runtime.env,
      stdinIsTTY: runtime.stdinIsTTY,
      stdoutIsTTY: runtime.stdoutIsTTY,
      args,
      wire,
      readStdin: runtime.readStdin ?? (async () => ""),
      artifacts,
      ...runtime.signal === void 0 ? {} : { signal: runtime.signal },
      // The waiver prompt is offered only under a real TTY. A non-interactive
      // invocation never prompts — it blocks — no matter what the run wired.
      ...runtime.stdinIsTTY && runtime.stdoutIsTTY && runtime.promptForWaiver !== void 0 ? { promptForWaiver: observation?.prompt(runtime.promptForWaiver) ?? runtime.promptForWaiver } : {},
      ...runtime.liveResults === void 0 ? {} : { liveResults: runtime.liveResults },
      invokeProvider: async ({ providerId, payload, requiresEvidence }) => {
        const provider = config.providers.find((registration) => registration.id === providerId);
        if (provider?.command === void 0) return void 0;
        const command = provider.command;
        const requestId = randomUUID3();
        const allocation = await artifacts.allocateRunRoot({ providerId, runId: requestId });
        if (!allocation.ok) {
          throw new BlockedError2([
            commandBlocker({
              code: "provider_rail_run_root_refused",
              sourceId: "delivery-harness.cli.provider-rails",
              summary: "The provider run root could not be allocated.",
              details: `${providerId}/${requestId}: ${allocation.reason}`,
              remediations: [
                {
                  id: "check-provider-identity",
                  kind: "code_change",
                  summary: "Correct the provider id or restore the harness run-root location, then retry."
                }
              ]
            })
          ]);
        }
        const wiring = await wire();
        const interruptController = runtime.signal === void 0 ? new AbortController() : void 0;
        const onInterrupt = () => interruptController?.abort();
        if (interruptController !== void 0) process.once("SIGINT", onInterrupt);
        try {
          return await invokeProviderRail(
            {
              providerId,
              requestId,
              idempotencyKey: randomUUID3(),
              payload: { ...payload, runId: requestId, runRoot: allocation.runRoot.path },
              requiresEvidence
            },
            {
              open: () => runtime.openProviderRail === void 0 ? openProviderRailProcess({ command, cwd: runtime.cwd, env: { ...runtime.env } }) : runtime.openProviderRail({ providerId, command, cwd: runtime.cwd, env: runtime.env }),
              publishManifest: (manifestPath) => submitManifest2(
                { rootDir: runtime.cwd, config, manifestPath },
                {
                  captureCandidate: wiring.captureCandidate,
                  artifacts,
                  expectedProviderAttempt: { providerId, runId: requestId, runRootPath: allocation.runRoot.path },
                  ...wiring.storageOptions
                }
              ),
              signal: runtime.signal ?? interruptController?.signal,
              cancellationId: randomUUID3()
            }
          );
        } finally {
          if (interruptController !== void 0) process.off("SIGINT", onInterrupt);
        }
      },
      write: (text2) => runtime.stdout(`${text2}
`),
      classifyContext: () => classifyExecutionContext({
        config,
        env: runtime.env,
        stdinIsTTY: runtime.stdinIsTTY,
        stdoutIsTTY: runtime.stdoutIsTTY
      })
    };
    const result = await descriptor.run(context);
    if (runtime.signal?.aborted) throw new CliInterruption();
    if (result.kind === "ok") {
      observeDigest(result.digest);
      if (result.summary !== void 0 && result.summary !== "") runtime.stdout(`${result.summary}
`);
      return EXIT_OK;
    }
    if (result.kind === "usage") {
      runtime.stderr(`${result.message}
`);
      return EXIT_USAGE;
    }
    runtime.stderr(`${renderBlockers(result.blockers)}
`);
    return EXIT_POLICY;
  } catch (error) {
    if (error instanceof CliInterruption) {
      runtime.stderr(`${error.message}
`);
      return EXIT_INTERRUPTED;
    }
    if (error instanceof BlockedError2) {
      runtime.stderr(`${renderBlockers(error.blockers)}
`);
      return EXIT_POLICY;
    }
    const blocker = createInternalErrorBlocker({
      source: { kind: "command", id: descriptor.sourceId },
      error,
      reproduce: ["delivery-harness", descriptor.name]
    });
    runtime.stderr(`${renderBlockers([blocker])}
`);
    return EXIT_POLICY;
  }
}

// packages/cli/src/commands/gate.ts
async function runProviderBackedAdmission(context, options) {
  const wiring = await context.wire();
  const admissionOptions = {
    captureCandidate: wiring.captureCandidate,
    projectActivation: wiring.projectActivation,
    ...wiring.storageOptions
  };
  const input = {
    rootDir: context.rootDir,
    config: context.config,
    context: context.classifyContext(),
    ...options.includeInjectedLiveResults && context.liveResults !== void 0 ? { liveResults: context.liveResults } : {}
  };
  const finalAdmissionOptions = {
    ...admissionOptions,
    ...options.allowPrompt && context.promptForWaiver !== void 0 ? { promptForWaiver: context.promptForWaiver } : {}
  };
  if (!context.config.providers.some((provider) => provider.command !== void 0 || provider.check !== void 0)) {
    return runAdmission(input, finalAdmissionOptions);
  }
  const liveResults = options.includeInjectedLiveResults ? [...context.liveResults ?? []] : [];
  const attempted = /* @__PURE__ */ new Set();
  const attemptBlockers = [];
  let admission = await runAdmission(input, admissionOptions);
  while (!admission.admitted && admission.decision !== void 0 && admission.candidate !== void 0) {
    const requested = /* @__PURE__ */ new Map();
    for (const resolution of admission.decision.resolutions) {
      if (resolution.kind !== "blocked") continue;
      const obligation = context.config.obligations.find((entry) => entry.id === resolution.obligationId);
      if (obligation === void 0) continue;
      const missingCode = obligation.freshness === "live" ? "live_provider_missing" : "review_evidence_missing";
      for (const finding of resolution.providerFindings ?? []) {
        if (finding.code !== missingCode || finding.providerId === void 0 || attempted.has(finding.providerId)) continue;
        const registration2 = context.config.providers.find((provider) => provider.id === finding.providerId);
        if (registration2 === void 0 || registration2.command === void 0 && registration2.check === void 0 || !obligation.providers.includes(registration2.id)) continue;
        if (registration2.check !== void 0 && (obligation.freshness !== "exact_candidate" || !obligation.acceptedPayloadSpecs.includes("checks.passed/1") || admission.decision.resolutions.some((resolution2) => resolution2.kind !== "satisfied_evidence" && resolution2.kind !== "not_applicable" && resolution2.kind !== "waived" && context.config.obligations.find((entry2) => entry2.id === resolution2.obligationId)?.acceptedPayloadSpecs.includes("review.green/1")))) continue;
        const entry = requested.get(registration2.id) ?? { obligationIds: [], requiresEvidence: false, needsLiveResult: false };
        entry.obligationIds.push(obligation.id);
        entry.requiresEvidence ||= obligation.freshness === "exact_candidate";
        entry.needsLiveResult ||= obligation.freshness === "live";
        requested.set(registration2.id, entry);
      }
    }
    const next = requested.entries().next().value;
    if (next === void 0) break;
    const [providerId, request] = next;
    attempted.add(providerId);
    const registration = context.config.providers.find((provider) => provider.id === providerId);
    if (registration.check !== void 0) {
      attemptBlockers.push(...await runDeclaredCheck(context, registration, request.obligationIds, admission.candidate));
      admission = await runAdmission({ ...input, ...liveResults.length === 0 ? {} : { liveResults } }, admissionOptions);
      continue;
    }
    const result = await context.invokeProvider?.({
      providerId,
      requiresEvidence: request.requiresEvidence,
      payload: {
        gateId: context.config.gateId,
        providerId,
        obligationIds: [...new Set(request.obligationIds)].sort(),
        candidate: admission.candidate
      }
    });
    if (result === void 0) continue;
    if (result.kind === "interrupted") throw new CliInterruption("Provider invocation interrupted before a trustworthy terminal outcome.");
    if (result.kind === "blocked") {
      attemptBlockers.push(...result.blockers);
      if (request.needsLiveResult) {
        liveResults.push({ providerId, runId: result.runId, status: "failed", findings: [] });
      }
    } else if (request.needsLiveResult) {
      liveResults.push(result.liveResult);
    }
    admission = await runAdmission(
      { ...input, ...liveResults.length === 0 ? {} : { liveResults } },
      admissionOptions
    );
  }
  if (admission.admitted) return { ...admission, observedLiveResults: liveResults };
  const final = await runAdmission(
    { ...input, ...liveResults.length === 0 ? {} : { liveResults } },
    finalAdmissionOptions
  );
  return attemptBlockers.length === 0 || final.admitted ? { ...final, observedLiveResults: liveResults } : { ...final, observedLiveResults: liveResults, blockers: [...attemptBlockers, ...final.blockers] };
}
var gateCommand = {
  name: "gate",
  sourceId: "delivery-harness.cli.gate",
  summary: "Evaluate the delivery gate for the current candidate.",
  async run(context) {
    const result = await runProviderBackedAdmission(context, { allowPrompt: true, includeInjectedLiveResults: true });
    if (result.admitted) {
      const waiverNote = result.waiver === "accepted" ? ` (waived: ${result.waivedObligationIds.join(", ")})` : "";
      const kinds = (result.decision?.resolutions ?? []).map((resolution) => `${resolution.obligationId}=${resolution.kind}`);
      let digest;
      if (result.candidate !== void 0) {
        try {
          digest = await computeDeliverableIdentity({
            rootDir: context.rootDir,
            treeSha: result.candidate.treeSha,
            config: { ...context.config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: context.config.recordNeutral }
          });
        } catch {
        }
      }
      return { kind: "ok", summary: `admitted${waiverNote}: ${kinds.join(", ")}`, ...digest === void 0 ? {} : { digest } };
    }
    return { kind: "blocked", blockers: [...result.blockers] };
  }
};

// packages/cli/src/commands/maintain.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path5 from "node:path";
import { compiledAdopterPolicyBindingDigest, createManagedDeliveryFacade } from "./kernel.mjs";
var SOURCE_ID = "delivery-harness.cli.maintain";
var MAINTAIN_OPERATIONS = Object.freeze([
  "update",
  "rollback",
  "pin",
  "revoke",
  "unrevoke",
  "advance-high-water-mark"
]);
var blocked = (code, summary, remediation) => ({
  kind: "blocked",
  blockers: [
    commandBlocker({
      code,
      sourceId: SOURCE_ID,
      summary,
      remediations: [{ id: `${code.replaceAll("_", "-")}-remediation`, kind: "manual_action", summary: remediation }]
    })
  ]
});
var gitCommonDir = (cwd) => new Promise((resolve) => {
  execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }, (error, stdout) => {
    resolve(error === null ? stdout.trim() : void 0);
  });
});
var flag = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? void 0 : args[index + 1];
};
function nowInstant() {
  return `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19)}Z`;
}
async function resolveFacade(context) {
  const common = await gitCommonDir(context.rootDir);
  if (common === void 0) {
    return blocked("not_a_repository", "The working directory is not a git repository.", "Run from the repository the product is installed for.");
  }
  let pointer;
  try {
    pointer = JSON.parse(await readFile(path5.join(common, "managed-delivery", "facade.json"), "utf8"));
  } catch {
    return blocked(
      "no_managed_installation",
      "No managed installation is registered for this repository.",
      "Install the composition and register a delivery first."
    );
  }
  let policyBinding = context.policyBinding;
  if (policyBinding === void 0) {
    try {
      policyBinding = JSON.parse(await readFile(path5.join(common, "managed-delivery", "policy-binding.json"), "utf8"));
    } catch {
      return blocked(
        "policy_binding_missing",
        "No compiled adopter policy binding is retained for this installation.",
        "Register a delivery through an adopter binding, or pass one through the embedding runtime."
      );
    }
  }
  if (pointer.policyBindingDigest !== compiledAdopterPolicyBindingDigest(policyBinding)) {
    return blocked(
      "policy_binding_mismatch",
      "The retained compiled adopter policy binding does not match the product namespace pointer.",
      "Restore the exact binding captured at registration; drift requires a new owner-approved delivery."
    );
  }
  return createManagedDeliveryFacade({
    repoDir: context.rootDir,
    policyBinding,
    installation: { installationPath: pointer.installationPath, receiptDir: pointer.receiptDir },
    hostVersion: pointer.hostVersion
  });
}
var isCommandResult = (value2) => "kind" in value2;
var maintainCommand = {
  name: "maintain",
  sourceId: SOURCE_ID,
  summary: "Maintain the product installation (update, rollback, trust-state pin/revoke/unrevoke/high-water-mark).",
  async run(context) {
    const [operation, ...rest] = context.args;
    if (operation === void 0) {
      return { kind: "usage", message: `maintain requires an operation: ${MAINTAIN_OPERATIONS.join(" | ")}` };
    }
    if (!MAINTAIN_OPERATIONS.includes(operation)) {
      return { kind: "usage", message: `Unknown maintain operation: ${operation}.` };
    }
    const resolved = await resolveFacade(context);
    if (isCommandResult(resolved)) return resolved;
    const facade = resolved;
    const now = nowInstant();
    const emit = (value2) => context.write(`${JSON.stringify(value2, null, 2)}
`);
    switch (operation) {
      case "update": {
        const packedDir = flag(rest, "--packed");
        if (packedDir === void 0) {
          return { kind: "usage", message: "update requires --packed <dir> naming the verified packed generation to install." };
        }
        const outcome2 = await facade.updateComposition({ packedDir: path5.resolve(context.rootDir, packedDir), now });
        if (!outcome2.ok) return { kind: "blocked", blockers: [...outcome2.blockers] };
        emit(outcome2);
        return {
          kind: "ok",
          summary: outcome2.noOp ? `already at ${outcome2.generationDigest}` : `updated ${outcome2.priorGenerationDigest} -> ${outcome2.generationDigest}`
        };
      }
      case "rollback": {
        const target = flag(rest, "--generation");
        if (target === void 0) {
          return { kind: "usage", message: "rollback requires --generation <digest> naming a previously accepted generation." };
        }
        const outcome2 = await facade.rollbackComposition({ targetGenerationDigest: target, now });
        if (!outcome2.ok) return { kind: "blocked", blockers: [...outcome2.blockers] };
        return { kind: "ok", summary: `rolled back to ${outcome2.generationDigest}` };
      }
      case "pin":
      case "revoke":
      case "unrevoke": {
        const generationDigest = flag(rest, "--generation");
        if (generationDigest === void 0) {
          return { kind: "usage", message: `${operation} requires --generation <digest>.` };
        }
        const outcome2 = await facade.maintainTrustState({ operation, generationDigest, now });
        if (!outcome2.ok) return { kind: "blocked", blockers: [...outcome2.blockers] };
        emit(outcome2.state);
        return { kind: "ok", summary: `${operation} recorded at revocation epoch ${outcome2.state.revocationEpoch}` };
      }
      case "advance-high-water-mark": {
        const raw = flag(rest, "--to");
        const highWaterMark = raw === void 0 ? Number.NaN : Number.parseInt(raw, 10);
        if (!Number.isInteger(highWaterMark)) {
          return { kind: "usage", message: "advance-high-water-mark requires --to <integer>." };
        }
        const outcome2 = await facade.maintainTrustState({ operation: "advance-high-water-mark", highWaterMark, now });
        if (!outcome2.ok) return { kind: "blocked", blockers: [...outcome2.blockers] };
        emit(outcome2.state);
        return { kind: "ok", summary: `high-water mark is ${outcome2.state.highWaterMark}` };
      }
      default:
        return { kind: "usage", message: `Unknown maintain operation: ${operation}.` };
    }
  }
};

// packages/cli/src/commands/managed.ts
import { execFile as execFile2 } from "node:child_process";
import { readFile as readFile2, readdir, realpath } from "node:fs/promises";
import path6 from "node:path";
import {
  FACADE_OPERATIONS,
  compiledAdopterPolicyBindingDigest as compiledAdopterPolicyBindingDigest2,
  createManagedDeliveryFacade as createManagedDeliveryFacade2
} from "./kernel.mjs";
var SOURCE_ID2 = "delivery-harness.cli.managed";
var MANAGED_OPERATIONS = Object.freeze([
  "status",
  "next",
  "operations",
  "blockers",
  "explain-blocker",
  "submit-plan",
  "checkpoint",
  "run-sensor",
  "reduce-review",
  "compound",
  "admit",
  "prepare-record",
  "confirm-record",
  "finish",
  "propose-approval",
  "request-cancellation",
  "finalize-cancellation",
  "recover",
  "export",
  "delete"
]);
var blocked2 = (code, summary, remediation) => ({
  kind: "blocked",
  blockers: [
    commandBlocker({
      code,
      sourceId: SOURCE_ID2,
      summary,
      remediations: [{ id: `${code.replaceAll("_", "-")}-remediation`, kind: "manual_action", summary: remediation }]
    })
  ]
});
var gitCommonDir2 = (cwd) => new Promise((resolve) => {
  execFile2("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }, (error, stdout) => {
    resolve(error === null ? stdout.trim() : void 0);
  });
});
function nowInstant2() {
  return `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19)}Z`;
}
var flag2 = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? void 0 : args[index + 1];
};
async function resolveManaged(context, requested) {
  const common = await gitCommonDir2(context.rootDir);
  if (common === void 0) {
    return blocked2("not_a_repository", "The working directory is not a git repository.", "Run from the delivery worktree.");
  }
  const namespace = path6.join(common, "managed-delivery");
  let pointer;
  try {
    pointer = JSON.parse(await readFile2(path6.join(namespace, "facade.json"), "utf8"));
  } catch {
    return blocked2(
      "no_managed_delivery",
      "No managed delivery is registered for this repository.",
      "Register a delivery through the facade's contract handoff first."
    );
  }
  let deliveries;
  try {
    deliveries = (await readdir(path6.join(namespace, "deliveries"))).sort();
  } catch {
    deliveries = [];
  }
  const active = [];
  for (const candidate of deliveries) {
    try {
      const journal = await readFile2(path6.join(namespace, "deliveries", candidate, "journal.jsonl"), "utf8");
      const terminal = journal.split("\n").filter((line) => line.length > 0).some((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.kind === "transition.committed" && ["completed", "cancelled", "failed"].includes(entry.payload?.to ?? "");
        } catch {
          return false;
        }
      });
      if (!terminal) active.push(candidate);
    } catch {
      active.push(candidate);
    }
  }
  let deliveryId;
  if (requested !== void 0) {
    if (!deliveries.includes(requested)) {
      return blocked2(
        "delivery_unresolved",
        `No delivery ${requested} is registered for this repository.`,
        "Name a delivery this repository registered; `managed status` reports the current one."
      );
    }
    deliveryId = requested;
  } else {
    deliveryId = active[0] ?? deliveries[deliveries.length - 1];
    if (deliveryId === void 0 || active.length > 1) {
      return blocked2(
        "delivery_unresolved",
        active.length > 1 ? "Several deliveries are in flight; the skeleton drives one." : "No registered delivery exists.",
        "Register exactly one delivery for this repository, or name one with --delivery for export and delete."
      );
    }
  }
  let policyBinding = context.policyBinding;
  if (policyBinding === void 0) {
    try {
      policyBinding = JSON.parse(await readFile2(path6.join(namespace, "policy-binding.json"), "utf8"));
    } catch {
      return blocked2(
        "policy_binding_missing",
        "No compiled adopter policy binding is retained for this delivery.",
        "Register the delivery through an adopter binding, or pass one through the embedding runtime."
      );
    }
  }
  if (pointer.policyBindingDigest !== compiledAdopterPolicyBindingDigest2(policyBinding)) {
    return blocked2(
      "policy_binding_mismatch",
      "The retained compiled adopter policy binding does not match the product namespace pointer.",
      "Restore the exact binding captured at registration; drift requires a new owner-approved delivery."
    );
  }
  const facade = createManagedDeliveryFacade2({
    repoDir: context.rootDir,
    policyBinding,
    installation: { installationPath: pointer.installationPath, receiptDir: pointer.receiptDir },
    hostVersion: pointer.hostVersion
  });
  let fence;
  try {
    const workspace = JSON.parse(
      await readFile2(path6.join(namespace, "deliveries", deliveryId, "workspace.json"), "utf8")
    );
    if (typeof workspace.worktreeDir === "string" && typeof workspace.fence === "number") {
      const [boundReal, hereReal] = await Promise.all([realpath(workspace.worktreeDir), realpath(context.rootDir)]);
      if (boundReal === hereReal) fence = workspace.fence;
    }
  } catch {
    fence = void 0;
  }
  return { facade, deliveryId, fence };
}
var isCommandResult2 = (value2) => "kind" in value2;
var managedCommand = {
  name: "managed",
  sourceId: SOURCE_ID2,
  summary: "Drive the managed delivery's next checkpoint (status, stages, sensor, review, admission, record, finish).",
  async run(context) {
    const [operation, ...rest] = context.args;
    if (operation === void 0) {
      return {
        kind: "usage",
        message: `managed requires an operation: ${MANAGED_OPERATIONS.join(" | ")}`
      };
    }
    if (!MANAGED_OPERATIONS.includes(operation)) {
      return { kind: "usage", message: `Unknown managed operation: ${operation}.` };
    }
    if (operation === "operations") {
      context.write(`${JSON.stringify(FACADE_OPERATIONS, null, 2)}
`);
      return { kind: "ok", summary: `${FACADE_OPERATIONS.length} facade operations` };
    }
    const RETENTION_OPERATIONS = ["export", "delete"];
    if (rest.some((argument) => argument.startsWith("--delivery="))) {
      return { kind: "usage", message: "--delivery takes its value as a separate argument: --delivery <id>." };
    }
    const namesDelivery = rest.includes("--delivery");
    if (namesDelivery && !RETENTION_OPERATIONS.includes(operation)) {
      return { kind: "usage", message: `--delivery is accepted only by: ${RETENTION_OPERATIONS.join(", ")}.` };
    }
    const requestedDelivery = RETENTION_OPERATIONS.includes(operation) ? flag2(rest, "--delivery") : void 0;
    if (namesDelivery && requestedDelivery === void 0) {
      return { kind: "usage", message: "--delivery requires a delivery id." };
    }
    const resolved = await resolveManaged(context, requestedDelivery);
    if (isCommandResult2(resolved)) return resolved;
    const { facade, deliveryId, fence } = resolved;
    const requireFence = () => fence ?? blocked2(
      "workspace_superseded",
      "This worktree is not the delivery's currently bound workspace, so it carries no invocation fence.",
      "Drive checkpoints from the bound worktree; a superseded task's outputs are permanently rejected."
    );
    const emit = (value2) => context.write(`${JSON.stringify(value2, null, 2)}
`);
    const resultFileArg = async (operation2) => {
      const file = flag2(rest, "--result-file");
      if (file === void 0) {
        return {
          kind: "usage",
          message: `${operation2} requires --result-file <path> containing a typed workflow-stage-result/1 document; prose cannot advance a checkpoint.`
        };
      }
      try {
        return await readFile2(path6.resolve(context.rootDir, file), "utf8");
      } catch (error) {
        return { kind: "usage", message: `${operation2} could not read ${file}: ${error instanceof Error ? error.message : String(error)}` };
      }
    };
    switch (operation) {
      case "status": {
        const status = await facade.status({ deliveryId, observedAt: nowInstant2() });
        if (!status.ok) return { kind: "blocked", blockers: [...status.blockers] };
        emit(status.status);
        return {
          kind: "ok",
          summary: `state ${status.status.delivery.state}; host ${status.status.hostActivity}; next ${status.status.nextCheckpoint.kind}`
        };
      }
      case "blockers": {
        const inventory = await facade.blockerInventory({ deliveryId });
        if (!inventory.ok) return { kind: "blocked", blockers: [...inventory.blockers] };
        emit(inventory.entries);
        return { kind: "ok", summary: `${inventory.entries.length} blocker(s) journaled` };
      }
      case "propose-approval": {
        const requestKind = flag2(rest, "--kind");
        const criterionId = flag2(rest, "--criterion");
        const actorId = flag2(rest, "--actor");
        const reason = flag2(rest, "--reason");
        if (requestKind !== "waiver" && requestKind !== "amendment" || criterionId === void 0 || actorId === void 0 || reason === void 0) {
          return {
            kind: "usage",
            message: "propose-approval requires --kind <waiver|amendment> --criterion <id> --actor <id> --reason <text>."
          };
        }
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const proposed = await facade.recordApprovalRequest({
          deliveryId,
          requestKind,
          criterionId,
          actorId,
          reason,
          fence: invokingFence
        });
        if (!proposed.ok) return { kind: "blocked", blockers: [...proposed.blockers] };
        return { kind: "ok", summary: `${requestKind} proposed for ${criterionId}; delivery is ${proposed.state}` };
      }
      case "request-cancellation": {
        const requested = await facade.requestCancellation({ deliveryId });
        if (!requested.ok) return { kind: "blocked", blockers: [...requested.blockers] };
        return { kind: "ok", summary: `cancellation requested; delivery is ${requested.state}` };
      }
      case "finalize-cancellation": {
        const finalized = await facade.finalizeCancellation({ deliveryId });
        if (!finalized.ok) return { kind: "blocked", blockers: [...finalized.blockers] };
        return { kind: "ok", summary: `prior workspace quarantined; delivery is ${finalized.state}` };
      }
      case "export": {
        const exported = await facade.exportDelivery({ deliveryId });
        if (!exported.ok) return { kind: "blocked", blockers: [...exported.blockers] };
        emit({ exportPath: exported.exportPath, artifactDigest: exported.artifactDigest });
        return { kind: "ok", summary: `exported to ${exported.exportPath}` };
      }
      case "delete": {
        const deleted = await facade.deleteDelivery({ deliveryId });
        if (!deleted.ok) return { kind: "blocked", blockers: [...deleted.blockers] };
        emit({ preservedAuditRecords: deleted.preservedAuditRecords });
        return { kind: "ok", summary: `deleted; ${deleted.preservedAuditRecords.length} audit record(s) preserved` };
      }
      case "recover": {
        const target = flag2(rest, "--generation");
        const recovered = await facade.recoverSecurityBlocked({
          deliveryId,
          now: nowInstant2(),
          ...target === void 0 ? {} : { targetGenerationDigest: target }
        });
        if (!recovered.ok) return { kind: "blocked", blockers: [...recovered.blockers] };
        return { kind: "ok", summary: `${recovered.mode}; delivery is ${recovered.state}` };
      }
      case "next": {
        const next = await facade.nextCheckpoint({ deliveryId });
        if (!next.ok) return { kind: "blocked", blockers: [...next.blockers] };
        emit(next.checkpoint);
        return { kind: "ok", summary: `next checkpoint: ${next.checkpoint.kind}` };
      }
      case "submit-plan": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const resultBytes = await resultFileArg("submit-plan");
        if (typeof resultBytes !== "string") return resultBytes;
        const submitted = await facade.submitStageResult({ deliveryId, stageId: "plan", resultBytes, fence: invokingFence });
        if (!submitted.ok) return { kind: "blocked", blockers: [...submitted.blockers] };
        return { kind: "ok", summary: `plan accepted; delivery is ${submitted.state}` };
      }
      case "checkpoint": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const resultBytes = await resultFileArg("checkpoint");
        if (typeof resultBytes !== "string") return resultBytes;
        const checkpointed = await facade.checkpointCandidate({ deliveryId, resultBytes, fence: invokingFence });
        if (!checkpointed.ok) return { kind: "blocked", blockers: [...checkpointed.blockers] };
        return { kind: "ok", summary: `candidate ${checkpointed.treeSha} checkpointed; delivery is ${checkpointed.state}` };
      }
      case "run-sensor": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const sensed = await facade.runSensor({ deliveryId, fence: invokingFence });
        if (!sensed.ok) return { kind: "blocked", blockers: [...sensed.blockers] };
        return { kind: "ok", summary: `sensor ${sensed.outcome}; delivery is ${sensed.state}` };
      }
      case "reduce-review": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const reduced = await facade.reduceReview({ deliveryId, fence: invokingFence });
        if (!reduced.ok) return { kind: "blocked", blockers: [...reduced.blockers] };
        return { kind: "ok", summary: `review reduced; delivery is ${reduced.state}` };
      }
      case "compound": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const resultBytes = await resultFileArg("compound");
        if (typeof resultBytes !== "string") return resultBytes;
        const compounded = await facade.submitStageResult({ deliveryId, stageId: "compound", resultBytes, fence: invokingFence });
        if (!compounded.ok) return { kind: "blocked", blockers: [...compounded.blockers] };
        return { kind: "ok", summary: `compound recorded; delivery is ${compounded.state}` };
      }
      case "admit": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const admitted = await facade.admit({ deliveryId, recordedAtInstant: nowInstant2(), env: context.env, fence: invokingFence });
        if (!admitted.ok) return { kind: "blocked", blockers: [...admitted.blockers] };
        return { kind: "ok", summary: `admitted; delivery is ${admitted.state}` };
      }
      case "prepare-record": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const prepared = await facade.prepareTrackedRecord({ deliveryId, env: context.env, fence: invokingFence });
        if (!prepared.ok) return { kind: "blocked", blockers: [...prepared.blockers] };
        return { kind: "ok", summary: `tracked record written at ${prepared.relativePath}; commit it through native git tooling` };
      }
      case "confirm-record": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const confirmed = await facade.confirmTrackedRecord({ deliveryId, fence: invokingFence });
        if (!confirmed.ok) return { kind: "blocked", blockers: [...confirmed.blockers] };
        return { kind: "ok", summary: `tracked record verified; delivery is ${confirmed.state}` };
      }
      case "finish": {
        const invokingFence = requireFence();
        if (typeof invokingFence !== "number") return invokingFence;
        const finished = await facade.completeFinishLine({ deliveryId, fence: invokingFence });
        if (!finished.ok) return { kind: "blocked", blockers: [...finished.blockers] };
        return { kind: "ok", summary: `merge-ready; delivery is ${finished.state} (result ${finished.resultDigest})` };
      }
      case "explain-blocker": {
        const explained = await facade.explainBlocker({ deliveryId });
        if (!explained.ok) return { kind: "blocked", blockers: [...explained.blockers] };
        emit(explained.blocker ?? { blocker: null });
        return { kind: "ok", summary: explained.blocker === void 0 ? "no blocker recorded" : `blocker ${explained.blocker.code}` };
      }
      default:
        return { kind: "usage", message: `Unknown managed operation: ${operation}.` };
    }
  }
};

// packages/cli/src/commands/prepare.ts
import {
  classifyCandidateDrift as classifyCandidateDrift2,
  computePreparationFingerprint,
  computeDeliverableIdentity as computeDeliverableIdentity2,
  evaluatePreparationReceipt,
  createBlocker as createBlocker4,
  createExecPort as createExecPort2,
  invalidatePreparationReceipt,
  revokePreparationAttempt,
  publishPreparationReceipt
} from "./kernel.mjs";
var prepareCommand = {
  name: "prepare",
  sourceId: "delivery-harness.cli.prepare",
  summary: "Run preparation checks; --refresh-record-neutral permits proven artifact-only receipt refresh.",
  async run(context) {
    const usage = "Usage: delivery-harness prepare [--refresh-record-neutral]";
    if (context.args.length === 1 && ["--help", "-h"].includes(context.args[0])) {
      return { kind: "ok", summary: `${usage}
Ordinary prepare always runs mechanical checks. The refresh flag reuses prior success only when strict validation, policy, wiring and base are unchanged; otherwise it runs the checks.` };
    }
    if (context.args.length > 1 || context.args.length === 1 && context.args[0] !== "--refresh-record-neutral") {
      return { kind: "usage", message: usage };
    }
    const refreshRecordNeutral = context.args[0] === "--refresh-record-neutral";
    const wiring = await context.wire();
    let retainedAttemptId;
    let ownedAttemptId;
    let refreshed = false;
    try {
      let capture;
      let reusableFingerprint;
      let attemptId;
      try {
        capture = await wiring.captureCandidate();
        if (capture.ok && refreshRecordNeutral) {
          const previous = await evaluatePreparationReceipt(
            context.rootDir,
            { config: context.config, candidate: capture.candidate },
            { ...wiring.storageOptions, allowValidationEquivalent: true }
          );
          if (previous.prepared && previous.receipt.attemptId !== void 0) {
            reusableFingerprint = previous.receipt.preparationFingerprint;
            retainedAttemptId = previous.receipt.attemptId;
          }
        }
      } finally {
        attemptId = retainedAttemptId ?? await invalidatePreparationReceipt(context.rootDir, context.config, wiring.storageOptions);
        ownedAttemptId = attemptId;
      }
      if (!capture.ok) {
        return { kind: "blocked", blockers: [...capture.blockers] };
      }
      const fingerprint = await computePreparationFingerprint(context.rootDir, context.config, wiring.storageOptions);
      const reusable = reusableFingerprint === fingerprint;
      if (!reusable && retainedAttemptId !== void 0) {
        attemptId = await invalidatePreparationReceipt(context.rootDir, context.config, wiring.storageOptions);
        ownedAttemptId = attemptId;
        retainedAttemptId = void 0;
      }
      const validationDigest = await computeDeliverableIdentity2({
        rootDir: context.rootDir,
        treeSha: capture.candidate.treeSha,
        config: { ...context.config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: context.config.recordNeutral }
      });
      if (reusable) context.write("reusing preparation checks: strict validation projection, base, policy and wiring unchanged");
      const exec = createExecPort2();
      const env = Object.fromEntries(Object.entries(context.env).filter((entry) => entry[1] !== void 0));
      for (const check of reusable ? [] : context.config.preparationCommands ?? []) {
        context.write(`preparing ${check.id}`);
        const result = await exec.run({
          command: check.command[0],
          args: check.command.slice(1),
          cwd: context.rootDir,
          env,
          timeoutMs: check.timeoutMs,
          maxBuffer: 1024 * 1024,
          ...context.signal === void 0 ? {} : { signal: context.signal }
        });
        if (result.code !== 0 || context.signal?.aborted) {
          return {
            kind: "blocked",
            blockers: [createBlocker4({
              code: "preparation_command_failed",
              source: { kind: "command", id: "delivery-harness.cli.prepare" },
              summary: `Preparation check ${check.id} failed; no receipt was published.`,
              details: `exit ${result.code}${result.errorCode === void 0 ? "" : ` (${result.errorCode})`}
${`${result.stdout}
${result.stderr}`.slice(-4e3)}`,
              remediations: [{ id: "repair-preparation-check", kind: "manual_action", summary: `Fix ${check.id}, then run prepare again.` }]
            })]
          };
        }
      }
      if (context.signal?.aborted) throw new CliInterruption();
      const finalCapture = await wiring.captureCandidate();
      if (!finalCapture.ok) return { kind: "blocked", blockers: [...finalCapture.blockers] };
      const after = finalCapture.candidate;
      if (classifyCandidateDrift2(capture.candidate, after).length > 0 || capture.candidate.headSha !== after.headSha || capture.candidate.mode !== after.mode || fingerprint !== await computePreparationFingerprint(context.rootDir, context.config, wiring.storageOptions)) {
        return {
          kind: "blocked",
          blockers: [createBlocker4({
            code: "preparation_candidate_changed",
            source: { kind: "command", id: "delivery-harness.cli.prepare" },
            summary: "The candidate, base, or preparation wiring changed while checks ran; no receipt was published.",
            remediations: [{ id: "prepare-stable-candidate", kind: "manual_action", summary: "Commit any intended changes and prepare the stable candidate again." }]
          })]
        };
      }
      const published = await publishPreparationReceipt(
        context.rootDir,
        { config: context.config, candidate: capture.candidate, attemptId, validationDigest },
        wiring.storageOptions
      );
      if (context.signal?.aborted) throw new CliInterruption();
      refreshed = true;
      return {
        kind: "ok",
        summary: [
          `prepared ${context.config.gateId}: tree ${capture.candidate.treeSha} (${capture.candidate.mode}); receipt ${published.path}`,
          `  treeSha ${capture.candidate.treeSha}`
        ].join("\n")
      };
    } finally {
      if (ownedAttemptId !== void 0 && !refreshed) {
        await revokePreparationAttempt(context.rootDir, context.config, ownedAttemptId, wiring.storageOptions);
      }
    }
  }
};

// packages/cli/src/commands/record.ts
import {
  buildDeliveryRecord,
  computePreparationFingerprint as computePreparationFingerprint2,
  capturePortableEvidenceContext,
  repositoryEvidenceReader,
  capturePortableVerificationInputs,
  verifyDeliveryRecord,
  deliveryRecordBytes,
  deliveryRecordPathFor,
  discoverRecords
} from "./kernel.mjs";
import path7 from "node:path";
var recordCommand = {
  name: "record",
  sourceId: "delivery-harness.cli.record",
  summary: "Write the tracked delivery record for an admitted gate.",
  async run(context) {
    const wiring = await context.wire();
    const admission = await runProviderBackedAdmission(context, { allowPrompt: false, includeInjectedLiveResults: false });
    if (!admission.admitted || admission.decision === void 0) {
      return { kind: "blocked", blockers: [...admission.blockers] };
    }
    const decision = admission.decision;
    const recheck = await wiring.captureCandidate();
    if (!recheck.ok) {
      return { kind: "blocked", blockers: [...recheck.blockers] };
    }
    if (recheck.candidate.deliverable.digest !== decision.candidate.deliverable.digest) {
      return {
        kind: "blocked",
        blockers: [
          commandBlocker({
            code: "record_identity_changed",
            sourceId: "delivery-harness.cli.record",
            summary: "The deliverable identity changed after the gate; nothing was recorded.",
            details: `gate ${decision.candidate.deliverable.digest} but current ${recheck.candidate.deliverable.digest}`,
            remediations: [
              {
                id: "reprepare-and-record",
                kind: "command",
                command: ["delivery-harness", "prepare"],
                summary: "Re-prepare the candidate and re-run the gate before recording."
              }
            ]
          })
        ]
      };
    }
    const evidenceRecords = [];
    for (const obligation of context.config.obligations) {
      const discovery = await discoverRecords(context.rootDir, {
        gateId: context.config.gateId,
        obligationId: obligation.id,
        ...wiring.storageOptions
      });
      evidenceRecords.push(...discovery.records);
    }
    const evidenceContext = await capturePortableEvidenceContext(
      context.config,
      repositoryEvidenceReader(context.rootDir, context.artifacts),
      await computePreparationFingerprint2(context.rootDir, context.config)
    );
    const built = buildDeliveryRecord({ config: context.config, decision, evidenceRecords, context: evidenceContext });
    if (!built.ok) {
      return { kind: "blocked", blockers: [...built.blockers] };
    }
    const verificationInputs = await capturePortableVerificationInputs(context.rootDir, context.config, recheck.candidate, built.record);
    const checked = verifyDeliveryRecord(
      context.config,
      built.record,
      { deliverableDigest: recheck.candidate.deliverable.digest, identityToken: recheck.candidate.deliverable.identity },
      recheck.candidate.base,
      { ...verificationInputs, liveResults: admission.observedLiveResults ?? [], executionContext: context.classifyContext() }
    );
    if (!checked.ok) return { kind: "blocked", blockers: [...checked.blockers] };
    const relativePath = deliveryRecordPathFor(context.config, decision.candidate.deliverable.digest);
    const absolutePath = path7.join(context.rootDir, relativePath);
    await context.artifacts.writeTextFile(absolutePath, deliveryRecordBytes(built.record));
    return { kind: "ok", summary: `recorded ${relativePath}` };
  }
};

// packages/cli/src/commands/review-context.ts
import { evaluatePreparationReceipt as evaluatePreparationReceipt3 } from "./kernel.mjs";

// packages/cli/src/review-evidence.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path8 from "node:path";
import {
  resolveReviewCharters,
  validateReviewedContext,
  parseReviewOutcome,
  deriveTelemetry,
  reviewerLists,
  capturePortableEvidenceContext as capturePortableEvidenceContext2,
  repositoryEvidenceReader as repositoryEvidenceReader2,
  createArtifactsPort as createArtifactsPort2,
  ReviewInputError as OutcomeError,
  BlockedError as BlockedError3,
  digestCanonical as digestCanonical2,
  evaluatePreparationReceipt as evaluatePreparationReceipt2,
  sha256Hex as sha256Hex3
} from "./kernel.mjs";
import { validateReviewedContext as validateReviewedContext2, parseReviewOutcome as parseReviewOutcome2, deriveTelemetry as deriveTelemetry2, reviewerLists as reviewerLists2, REVIEWER_RESULTS } from "./kernel.mjs";
var REVIEW_PAYLOAD_SPEC = "review.green/1";
var ENVELOPE_SPEC = "delivery-evidence/1";
var EMITTER_VERSION = "1.0.0";
var REVIEW_CONTEXT_SPEC = "review-context/1";
function manifestCandidate(captured) {
  return {
    vcs: captured.vcs,
    treeSha: captured.treeSha,
    headSha: captured.headSha,
    deliverable: { digest: captured.deliverable.digest, identity: captured.deliverable.identity },
    base: { ref: captured.base.ref, tipSha: captured.base.tipSha, mergeBaseSha: captured.base.mergeBaseSha },
    workspaceId: captured.workspaceId
  };
}
async function buildReviewContext(rootDir, config, candidate, receipt) {
  const inputs = await capturePortableEvidenceContext2(config, repositoryEvidenceReader2(rootDir, createArtifactsPort2()), receipt.preparationFingerprint);
  const charters = inputs.reviewerCharters;
  if (charters.length === 0 || inputs.release === null) throw new OutcomeError("the compiled policy activates no review lens or installed release");
  const binding = {
    gate: resolveGateBinding(config),
    candidate: manifestCandidate(candidate),
    preparationFingerprint: inputs.preparationFingerprint,
    configurationDigest: inputs.configurationDigest,
    policyDigest: inputs.policyDigest,
    release: inputs.release,
    workflowGraphSha256: inputs.workflowGraphSha256,
    charters
  };
  return { spec: REVIEW_CONTEXT_SPEC, digest: digestCanonical2(binding), binding };
}
function resolveGateBinding(config) {
  const obligations = config.obligations.filter(
    (obligation2) => obligation2.acceptedPayloadSpecs.includes(REVIEW_PAYLOAD_SPEC)
  );
  if (obligations.length !== 1) {
    throw new OutcomeError(
      `the gate declares ${obligations.length} obligations accepting ${REVIEW_PAYLOAD_SPEC}; this provider serves exactly one`
    );
  }
  const obligation = obligations[0];
  if (obligation.providers.length !== 1) {
    throw new OutcomeError(
      `obligation ${obligation.id} names ${obligation.providers.length} providers; this provider serves exactly one`
    );
  }
  return { obligationId: obligation.id, providerId: obligation.providers[0] };
}
async function emitReviewEvidence(context, original, document) {
  const { rootDir, config } = context;
  const wiring = await context.wire();
  const capture = await wiring.captureCandidate();
  if (!capture.ok) throw new OutcomeError(`the candidate could not be captured: ${capture.code}`);
  const captured = capture.candidate;
  const preparation = await evaluatePreparationReceipt2(rootDir, { config, candidate: captured }, wiring.storageOptions);
  if (!preparation.prepared) throw new BlockedError3([...preparation.blockers]);
  const current = await buildReviewContext(rootDir, config, captured, preparation.receipt);
  validateReviewedContext(original, current, document);
  const charters = current.binding.charters.map((charter) => charter.reviewerId).sort();
  const outcome2 = parseReviewOutcome(document, charters);
  const binding = current.binding.gate;
  const candidate = manifestCandidate(captured);
  const provider = {
    id: binding.providerId,
    version: EMITTER_VERSION,
    // One emitter run is one evaluated pass over this candidate.
    runId: `r-${randomUUID4()}`,
    finalPassId: outcome2.finalPassId ?? "pass-1"
  };
  const reviewed = original;
  const originalRunHistory = outcome2.runHistory ?? [{
    preparedTreeSha: reviewed.binding.candidate.treeSha,
    evaluatedInPassId: provider.finalPassId
  }];
  const finalEntry = originalRunHistory.at(-1);
  if (finalEntry["preparedTreeSha"] !== reviewed.binding.candidate.treeSha || finalEntry["evaluatedInPassId"] !== provider.finalPassId) {
    throw new OutcomeError("the supplied final review pass does not name the original reviewed candidate");
  }
  const runHistory = originalRunHistory.map((entry, index) => index === originalRunHistory.length - 1 ? { ...entry, preparedTreeSha: captured.treeSha } : entry);
  const allocation = await context.artifacts.allocateRunRoot({ providerId: provider.id, runId: provider.runId });
  if (!allocation.ok) throw new OutcomeError(`the run root was refused: ${allocation.reason}`);
  const runRoot = allocation.runRoot.path;
  const lists = reviewerLists(charters, outcome2);
  await mkdir(path8.join(runRoot, "reviewers"), { recursive: true });
  const artifacts = [];
  for (const [name, value2] of [["review-context", original], ["review-outcome", document]]) {
    const bytes = `${JSON.stringify(value2, null, 2)}
`;
    await writeFile(path8.join(runRoot, `${name}.json`), bytes, "utf8");
    artifacts.push({ path: `${name}.json`, sha256: sha256Hex3(bytes), role: name });
  }
  if (digestCanonical2(reviewed.binding.candidate) !== digestCanonical2(candidate)) {
    const bytes = `${JSON.stringify({
      spec: "review-context-projection/1",
      basis: "unchanged-deliverable-and-review-inputs",
      originalContextDigest: reviewed.digest,
      reviewedCandidate: reviewed.binding.candidate,
      preparedCandidate: candidate,
      originalRunHistory,
      reviewRoundAdded: false
    }, null, 2)}
`;
    await writeFile(path8.join(runRoot, "review-context-projection.json"), bytes, "utf8");
    artifacts.push({ path: "review-context-projection.json", sha256: sha256Hex3(bytes), role: "review-context-projection" });
  }
  for (const reviewerId of lists.approved) {
    const stamp = `${JSON.stringify(
      {
        schemaVersion: 1,
        reviewerId,
        result: "approved",
        provider: { id: provider.id, runId: provider.runId, finalPassId: provider.finalPassId },
        workspaceId: candidate.workspaceId,
        candidate
      },
      null,
      2
    )}
`;
    const relativePath = `reviewers/${reviewerId}.json`;
    await writeFile(path8.join(runRoot, relativePath), stamp, "utf8");
    artifacts.push({ path: relativePath, sha256: sha256Hex3(stamp), role: "reviewer-approval" });
  }
  const manifest = {
    spec: ENVELOPE_SPEC,
    provider,
    candidate,
    repository: null,
    runHistory,
    artifacts,
    attestation: { level: "self", signatures: [] },
    recordedAt: (/* @__PURE__ */ new Date()).toISOString(),
    claims: [
      {
        obligation: binding.obligationId,
        payloadSpec: REVIEW_PAYLOAD_SPEC,
        payload: {
          verdict: outcome2.verdict,
          finalized: true,
          editedAfterFinalPass: false,
          reviewers: {
            selected: lists.selected,
            completed: lists.completed,
            failed: lists.failed,
            timedOut: lists.timedOut
          },
          findings: outcome2.findings,
          telemetry: { ...deriveTelemetry(outcome2.findings, runHistory.length), ...outcome2.cost === void 0 ? {} : { cost: outcome2.cost } }
        }
      }
    ]
  };
  const manifestPath = path8.join(runRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
  return { manifestPath, runRoot };
}

// packages/cli/src/commands/review-context.ts
var reviewContextCommand = {
  name: "review-context",
  sourceId: "delivery-harness.cli.review-context",
  summary: "Show the reviewable-change context for the prepared candidate.",
  async run(context) {
    if (context.args.length > 0 && !(context.args.length === 1 && context.args[0] === "--json")) {
      return { kind: "usage", message: "review-context accepts only --json." };
    }
    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    if (!capture.ok) {
      return { kind: "blocked", blockers: [...capture.blockers] };
    }
    const evaluation = await evaluatePreparationReceipt3(
      context.rootDir,
      { config: context.config, candidate: capture.candidate },
      wiring.storageOptions
    );
    if (!evaluation.prepared) {
      const blockers = [...evaluation.blockers];
      if (evaluation.failure === "missing") {
        blockers.push(
          commandBlocker({
            code: "review_context_requires_receipt",
            sourceId: "delivery-harness.cli.review-context",
            summary: "Review context is unavailable until the candidate is prepared.",
            remediations: [
              {
                id: "run-prepare",
                kind: "command",
                command: ["delivery-harness", "prepare"],
                summary: "Publish a preparation receipt for the current candidate."
              }
            ]
          })
        );
      }
      return { kind: "blocked", blockers };
    }
    if (context.args[0] === "--json") {
      try {
        const document = await buildReviewContext(context.rootDir, context.config, capture.candidate, evaluation.receipt);
        return { kind: "ok", summary: JSON.stringify(document, null, 2) };
      } catch (error) {
        if (!(error instanceof OutcomeError)) throw error;
        return { kind: "blocked", blockers: [commandBlocker({
          code: "review_context_unavailable",
          sourceId: "delivery-harness.cli.review-context",
          summary: error.message,
          remediations: [{ id: "restore-review-inputs", kind: "manual_action", summary: "Restore the installed workflow release and compiled policy charters before acquiring review." }]
        })] };
      }
    }
    const projection = await wiring.projectActivation(capture.candidate);
    const active = projection.relevantLineCount >= context.config.activationThreshold || projection.hasRelevantBinaryChange;
    return {
      kind: "ok",
      summary: [
        `review context for ${context.config.gateId}:`,
        `  candidate tree ${capture.candidate.treeSha} (${capture.candidate.mode})`,
        `  relevant lines ${projection.relevantLineCount} across ${projection.changedEntryCount} changed entr${projection.changedEntryCount === 1 ? "y" : "ies"}`,
        `  activation ${active ? "active" : "inactive"} (threshold ${context.config.activationThreshold})`,
        ...projection.sensitivePathIds.length > 0 ? [`  sensitive: ${projection.sensitivePathIds.join(", ")}`] : [],
        `  submit evidence with: delivery-harness submit-evidence --manifest <path>`
      ].join("\n")
    };
  }
};

// packages/cli/src/commands/emit-review-evidence.ts
import { readFile as readFile4 } from "node:fs/promises";
import path9 from "node:path";
var emitReviewEvidenceCommand = {
  name: "emit-review-evidence",
  sourceId: "delivery-harness.cli.emit-review-evidence",
  summary: "Bind concluded review outcomes to their original prepared context.",
  async run(context) {
    if (context.args.length !== 2 || context.args[0] !== "--context" || !context.args[1] || context.args[1].startsWith("-")) {
      return { kind: "usage", message: "emit-review-evidence requires --context <review-context.json> and a review-outcome/1 document on stdin." };
    }
    let original;
    let document;
    try {
      original = JSON.parse(await readFile4(path9.resolve(context.rootDir, context.args[1]), "utf8"));
      const raw = await context.readStdin?.() ?? "";
      if (!raw.trim()) return { kind: "usage", message: "The review-outcome/1 document is required on stdin." };
      document = JSON.parse(raw);
    } catch {
      return { kind: "usage", message: "The original context and review outcome must be readable JSON documents." };
    }
    try {
      const result = await emitReviewEvidence(context, original, document);
      return { kind: "ok", summary: result.manifestPath };
    } catch (error) {
      if (!(error instanceof OutcomeError)) throw error;
      return { kind: "blocked", blockers: [commandBlocker({
        code: "review_outcome_invalid",
        sourceId: "delivery-harness.cli.emit-review-evidence",
        summary: error.message,
        remediations: [{ id: "supply-reviewed-context", kind: "manual_action", summary: "Use the original review-context --json output and concluded outcomes naming its digest; acquire a new review if the deliverable or review inputs changed." }]
      })] };
    }
  }
};

// packages/cli/src/run-view-record.ts
import { realpath as realpath3 } from "node:fs/promises";
import path11 from "node:path";

// packages/cli/src/run-archive-commands.ts
import { constants } from "node:fs";
import { open, realpath as realpath2 } from "node:fs/promises";
import path10 from "node:path";
import {
  createArtifactsPort as createArtifactsPort3,
  readRunArtifact,
  MAX_PORTABLE_RECORD_BYTES as MAX_PORTABLE_RECORD_BYTES3
} from "./kernel.mjs";

// packages/cli/src/run-archive.ts
import {
  applySecretDiscipline as applySecretDiscipline3,
  canonicalize as canonicalize3,
  MAX_PORTABLE_RECORD_BYTES as MAX_PORTABLE_RECORD_BYTES2,
  MAX_PORTABLE_ARTIFACTS as MAX_PORTABLE_ARTIFACTS2,
  MAX_PORTABLE_EVIDENCE_BYTES as MAX_PORTABLE_EVIDENCE_BYTES2
} from "./kernel.mjs";

// packages/cli/src/run-attachments.ts
import {
  canonicalize,
  sha256Hex as sha256Hex4,
  portableArtifactContents,
  applySecretDiscipline,
  MAX_PORTABLE_ARTIFACTS,
  MAX_PORTABLE_EVIDENCE_BYTES
} from "./kernel.mjs";
var record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function referencedAttachments(events) {
  const entries = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.kind !== "artifact.referenced") continue;
    const metadata = event.payload;
    const prior = entries.get(metadata.artifactId);
    if (prior && canonicalize(prior) !== canonicalize(metadata))
      return void 0;
    entries.set(metadata.artifactId, metadata);
  }
  return entries;
}
function validateRunAttachments(value2, events) {
  if (!record(value2) || Object.keys(value2).sort().join(",") !== "blobs,entries" || !Array.isArray(value2["entries"]) || !record(value2["blobs"]) || Buffer.byteLength(JSON.stringify(value2), "utf8") > MAX_PORTABLE_EVIDENCE_BYTES)
    return false;
  const refs = referencedAttachments(events);
  if (!refs || refs.size > MAX_PORTABLE_ARTIFACTS || value2["entries"].length !== refs.size)
    return false;
  const seen = /* @__PURE__ */ new Set();
  const needed = /* @__PURE__ */ new Set();
  const read = portableArtifactContents(value2["blobs"]);
  if (read.blockers.length) return false;
  for (const entry of value2["entries"]) {
    if (!record(entry) || !record(entry["metadata"])) return false;
    const metadata = entry["metadata"];
    if (seen.has(metadata.artifactId) || !refs.has(metadata.artifactId) || canonicalize(metadata) !== canonicalize(refs.get(metadata.artifactId)))
      return false;
    seen.add(metadata.artifactId);
    if (entry["availability"] === "unavailable") {
      if (Object.keys(entry).sort().join(",") !== "availability,code,metadata,reason" || !["missing", "access_refused"].includes(String(entry["code"])) || typeof entry["reason"] !== "string" || !entry["reason"].length || entry["reason"].length > 512)
        return false;
    } else if (entry["availability"] === "retained") {
      if (Object.keys(entry).sort().join(",") !== "availability,metadata")
        return false;
      const observed = read.observations.get(metadata.digest);
      if (!observed || observed.base64 === void 0) return false;
      const bytes = Buffer.from(observed.base64, "base64");
      if (bytes.length !== metadata.sizeBytes || sha256Hex4(bytes) !== metadata.digest)
        return false;
      let structured = null;
      try {
        structured = JSON.parse(bytes.toString("utf8"));
      } catch {
      }
      if (!applySecretDiscipline(
        { text: bytes.toString("utf8"), structured },
        /* @__PURE__ */ new Set()
      ).ok)
        return false;
      needed.add(metadata.digest);
    } else return false;
  }
  return Object.keys(value2["blobs"]).length === needed.size && Object.keys(value2["blobs"]).every((key) => needed.has(key)) && applySecretDiscipline(value2["entries"], /* @__PURE__ */ new Set()).ok;
}

// packages/cli/src/run-export.ts
import {
  canonicalize as canonicalize2,
  MAX_PORTABLE_RECORD_BYTES,
  applySecretDiscipline as applySecretDiscipline2,
  evaluateRunJournal as evaluateRunJournal2,
  RUN_STORE_ID as RUN_STORE_ID2,
  validateRunEvent
} from "./kernel.mjs";

// packages/cli/src/run-projection.ts
import {
  RUN_JOURNAL_REQUIRED_ENTRIES,
  runJournalCarries,
  runPrimaryTicket,
  projectRunActivities
} from "./kernel.mjs";
var READOUT_LABELS = "self-attested; observability, not evidence; unbound to a record";
function projectRunProgress(events, now, freshnessWindowMs) {
  const projection = projectRunActivities(events, { now, ...freshnessWindowMs === void 0 ? {} : { freshnessWindowMs } });
  const latestFindings = /* @__PURE__ */ new Map();
  for (const finding of projection.findings) {
    if (finding.current) latestFindings.set(String(finding.payload["findingId"]), finding);
  }
  return {
    asOf: now,
    ...projection,
    currentFindings: [...latestFindings.values()],
    findingsCoverage: events.some((e) => e.kind === "finding.observed") ? "reported" : "unreported"
  };
}
function costLabel(value2) {
  const cost = typeof value2 === "object" && value2 !== null ? value2 : {};
  if (cost["coverage"] === "unreported" || cost["total"] === void 0) return "unreported";
  const measured = `${oneLineOf(cost["total"])} ${oneLineOf(cost["unit"])}`.trim();
  return cost["coverage"] === "partial" ? `${measured} (partial coverage)` : measured;
}
function projectCosts(events) {
  const allClosed = events.filter((event) => event.kind === "review.round.closed");
  const snapshots = /* @__PURE__ */ new Map();
  for (const event of allClosed) {
    const payload = payloadOf(event);
    const cost = payload["cost"];
    const key = event.version === "run-event/2" ? JSON.stringify([payload["roundId"], cost["reportedBy"], cost["unit"] ?? "unreported"]) : `legacy-${event.seq}`;
    snapshots.set(key, event);
  }
  const closed = [...snapshots.values()];
  const totals = /* @__PURE__ */ new Map();
  let unreportedEntries = 0;
  let partial = allClosed.length !== closed.length || events.filter((event) => event.kind === "review.round.opened").length !== closed.length;
  for (const event of closed) {
    const cost = payloadOf(event)["cost"];
    if (cost["coverage"] === "unreported") {
      unreportedEntries += 1;
      continue;
    }
    if (cost["coverage"] === "partial") partial = true;
    const unit = cost["unit"];
    const reportedBy = cost["reportedBy"];
    const key = JSON.stringify([reportedBy, unit]);
    const prior = totals.get(key);
    const sum = prior?.total === null ? Infinity : (prior?.total ?? 0) + cost["total"];
    if (!Number.isFinite(sum)) partial = true;
    totals.set(key, { unit, total: Number.isFinite(sum) ? sum : null, reportedBy });
  }
  const ended = events.find((event) => event.kind === "run.ended");
  return {
    review: {
      coverage: totals.size === 0 ? "unreported" : partial || unreportedEntries > 0 ? "partial" : "complete",
      unreportedEntries,
      totals: [...totals.values()]
    },
    run: ended === void 0 ? { coverage: "unreported" } : payloadOf(ended)["cost"]
  };
}
var payloadOf = (event) => typeof event.payload === "object" && event.payload !== null ? event.payload : {};
var boundTicket = (event) => event.ticket === void 0 ? "" : ` for ${oneLineOf(event.ticket, 128)}`;
function detailOf(event) {
  const payload = payloadOf(event);
  switch (event.kind) {
    case "run.started":
      return oneLineOf(payload["host"]) + (payload["displacedRunId"] === void 0 ? "" : ` displaced ${oneLineOf(payload["displacedRunId"])}`);
    case "run.ended":
      return `${oneLineOf(payload["result"])} cost ${costLabel(payload["cost"])}`;
    case "ticket.read":
      return `${oneLineOf(payload["ticket"])} via ${oneLineOf(payload["tracker"])}`;
    case "posture.declared":
      return oneLineOf(payload["posture"]) + boundTicket(event);
    case "lens.selected":
      return `mandated ${oneLineOf(payload["mandated"])} selected ${oneLineOf(payload["selected"])} \u2014 ${oneLineOf(payload["rationale"])}`;
    case "review.round.opened":
      return `round ${oneLineOf(payload["round"])} on ${oneLineOf(event.candidateTreeSha)} lenses ${oneLineOf(payload["lenses"])}`;
    case "review.round.closed":
      return `round ${oneLineOf(payload["round"])} ${oneLineOf(payload["outcome"])} findings ${oneLineOf(payload["findings"])}`;
    case "command.completed":
      return `${oneLineOf(payload["command"])} ${oneLineOf(payload["outcome"])} in ${oneLineOf(payload["durationMs"])}ms`;
    case "gate.reported":
      return `${oneLineOf(payload["command"])} ${oneLineOf(payload["outcome"])} in ${oneLineOf(payload["durationMs"])}ms${boundTicket(event)}`;
    case "pr.opened":
      return `${oneLineOf(payload["url"], 400)} on ${oneLineOf(event.candidateTreeSha)}${boundTicket(event)}`;
    case "blocker.recorded":
      return `${oneLineOf(payload["code"])} \u2014 ${oneLineOf(payload["summary"])}`;
    case "decision.recorded":
      return `${oneLineOf(payload["fork"])} \u2014 ${oneLineOf(payload["choice"])}${payload["cited"] === void 0 ? "" : ` (cited ${oneLineOf(payload["cited"])})`}`;
    case "compounding.recorded":
      return `${oneLineOf(payload["outcome"])}${payload["reference"] === void 0 ? "" : ` \u2014 ${oneLineOf(payload["reference"])}`}`;
    case "context.saved":
      return `stage ${oneLineOf(payload["stage"])} (observation only)`;
    case "action.intent":
    case "action.observed":
      return `${oneLineOf(payload["actionId"])} ${oneLineOf(payload["outcome"] ?? "unknown")} reference ${oneLineOf(payload["reference"])}`;
    default:
      return "";
  }
}
function roundEntries(events) {
  const rounds = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.kind !== "review.round.opened" && event.kind !== "review.round.closed") continue;
    const key = oneLineOf(payloadOf(event)["round"], 32);
    const entry = rounds.get(key) ?? {};
    if (event.kind === "review.round.opened") entry.opened = event;
    else entry.closed = event;
    rounds.set(key, entry);
  }
  return [...rounds.entries()].map(([round, entry]) => {
    const anchor = entry.opened ?? entry.closed;
    return {
      round,
      candidateTreeSha: oneLineOf(anchor?.candidateTreeSha),
      ...entry.opened === void 0 ? {} : { opened: entry.opened },
      ...entry.closed === void 0 ? {} : { closed: entry.closed }
    };
  });
}
function roundLenses(entry) {
  return entry.opened === void 0 ? "never opened" : oneLineOf(payloadOf(entry.opened)["lenses"]);
}
function roundRows(events) {
  return roundEntries(events).map((entry) => {
    const closed = entry.closed === void 0 ? void 0 : payloadOf(entry.closed);
    return [
      `  round ${entry.round}`,
      `candidate ${entry.candidateTreeSha || "(none)"}`,
      entry.opened === void 0 ? roundLenses(entry) : `lenses ${roundLenses(entry)}`,
      closed === void 0 ? "open" : `${oneLineOf(closed["outcome"])} findings ${oneLineOf(closed["findings"])} cost ${costLabel(closed["cost"])}`
    ].join("  ");
  });
}
function readoutOf(events, evaluation, rootDir) {
  const present = RUN_JOURNAL_REQUIRED_ENTRIES.filter((entry) => runJournalCarries(events, entry));
  const note = evaluation.status === "complete-executor-only" && rootDir !== void 0 && harnessConfigPresentAt(rootDir) ? `no CLI gate completion in this journal; harness.config.ts present at ${oneLine(rootDir, 400)}` : void 0;
  return {
    status: evaluation.status,
    present,
    missing: evaluation.missing,
    violations: evaluation.violations,
    ...note === void 0 ? {} : { note }
  };
}
function readoutRows(events, evaluation, rootDir) {
  const readout = readoutOf(events, evaluation, rootDir);
  const rows = [
    `  completeness: ${readout.status}  (${READOUT_LABELS})`,
    `    present: ${readout.present.length === 0 ? "(none)" : readout.present.join(", ")}`,
    `    missing: ${readout.missing.length === 0 ? "(none)" : [...readout.missing].join(", ")}`
  ];
  if (readout.violations.length > 0) rows.push(`    violations: ${[...readout.violations].join(", ")}`);
  if (readout.note !== void 0) rows.push(`    note: ${readout.note}`);
  return rows;
}
var cliCompletionFor = (events, command) => events.findLast(
  (event) => event.kind === "command.completed" && event.actor.role === "cli" && payloadOf(event)["command"] === command
);
var severityOf = (value2, key) => {
  const findings = typeof value2 === "object" && value2 !== null ? value2 : {};
  const count = findings[key];
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
};
function spanSeconds(from, to) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 1e3);
}
function summarize(events) {
  const first = events[0];
  const last = events[events.length - 1];
  const startedAt = first?.at ?? "";
  const lastAt = last?.at ?? "";
  const ended = events.find((event) => event.kind === "run.ended");
  const gateCompletion = cliCompletionFor(events, "gate");
  const gateReported = events.find((event) => event.kind === "gate.reported");
  const recordCompletion = cliCompletionFor(events, "record");
  const closed = events.filter((event) => event.kind === "review.round.closed");
  const gate = gateCompletion !== void 0 ? { outcome: oneLineOf(payloadOf(gateCompletion)["outcome"], 64), writer: "cli" } : gateReported !== void 0 ? { outcome: oneLineOf(payloadOf(gateReported)["outcome"], 64), writer: "executor" } : void 0;
  return {
    ticket: oneLineOf(runPrimaryTicket(events), 128),
    open: ended === void 0,
    startedAt,
    lastAt,
    durationSeconds: spanSeconds(startedAt, lastAt),
    roundsOpened: events.filter((event) => event.kind === "review.round.opened").length,
    roundsClosed: closed.length,
    findings: {
      P0: closed.reduce((total, event) => total + severityOf(payloadOf(event)["findings"], "P0"), 0),
      P1: closed.reduce((total, event) => total + severityOf(payloadOf(event)["findings"], "P1"), 0),
      P2: closed.reduce((total, event) => total + severityOf(payloadOf(event)["findings"], "P2"), 0),
      P3: closed.reduce((total, event) => total + severityOf(payloadOf(event)["findings"], "P3"), 0)
    },
    ...gate === void 0 ? {} : { gate },
    ...recordCompletion === void 0 ? {} : { record: { outcome: oneLineOf(payloadOf(recordCompletion)["outcome"], 64), writer: "cli" } },
    ...ended === void 0 ? {} : { result: oneLineOf(payloadOf(ended)["result"], 64) }
  };
}

// packages/cli/src/run-export.ts
function buildRunExport(input) {
  const v2 = input.events[0]?.version === "run-event/2";
  return {
    spec: v2 ? "delivery-run-export/2" : "delivery-run-export/1",
    labels: READOUT_LABELS,
    runId: input.runId,
    events: input.events,
    summary: summarize(input.events),
    costs: projectCosts(input.events),
    readout: readoutOf(
      input.events,
      evaluateRunJournal2(input.events),
      input.rootDir
    ),
    refusedAppends: input.refusedAppends ?? [],
    // Exported progress is a historical projection at the last observation,
    // never a claim about whether the producer is executing now.
    ...v2 ? {
      progress: projectRunProgress(
        input.events,
        input.events.at(-1)?.at ?? ""
      )
    } : {}
  };
}
var isRecord = (value2) => value2 !== null && typeof value2 === "object" && !Array.isArray(value2);
function parseRunExport(text2) {
  const invalid = { ok: false, code: "run_export_invalid" };
  try {
    if (Buffer.byteLength(text2, "utf8") > MAX_PORTABLE_RECORD_BYTES)
      return invalid;
    const value2 = JSON.parse(text2);
    if (!isRecord(value2) || !["delivery-run-export/1", "delivery-run-export/2"].includes(
      String(value2["spec"])
    ) || value2["labels"] !== READOUT_LABELS || typeof value2["runId"] !== "string" || value2["runId"].length > 128 || !RUN_STORE_ID2.test(value2["runId"]) || !Array.isArray(value2["events"]) || !Array.isArray(value2["refusedAppends"]) || !isRecord(value2["readout"]))
      return invalid;
    const v2 = value2["spec"] === "delivery-run-export/2";
    const hasAttachments = Object.prototype.hasOwnProperty.call(
      value2,
      "attachments"
    );
    if (hasAttachments && (!v2 || !applySecretDiscipline2(value2, /* @__PURE__ */ new Set()).ok))
      return invalid;
    if (Object.keys(value2).filter((key) => key !== "attachments").sort().join(",") !== (v2 ? "costs,events,labels,progress,readout,refusedAppends,runId,spec,summary" : "costs,events,labels,readout,refusedAppends,runId,spec,summary"))
      return invalid;
    for (const [index, event] of value2["events"].entries()) {
      if (!validateRunEvent(event).ok || !isRecord(event) || event["runId"] !== value2["runId"] || event["seq"] !== index + 1 || event["version"] !== (v2 ? "run-event/2" : "run-event/1"))
        return invalid;
    }
    if (hasAttachments && !validateRunAttachments(
      value2["attachments"],
      value2["events"]
    ))
      return invalid;
    const expected = buildRunExport({
      runId: value2["runId"],
      events: value2["events"]
    });
    if (expected.spec !== value2["spec"] || canonicalize2(value2["progress"] ?? null) !== canonicalize2(expected.progress ?? null))
      return invalid;
    if (canonicalize2(value2["summary"]) !== canonicalize2(expected.summary) || canonicalize2(value2["costs"]) !== canonicalize2(expected.costs))
      return invalid;
    const { note, ...readout } = value2["readout"];
    if (note !== void 0 && typeof note !== "string" || canonicalize2(readout) !== canonicalize2(expected.readout))
      return invalid;
    return {
      ok: true,
      value: {
        ...expected,
        ...hasAttachments ? { attachments: value2["attachments"] } : {},
        refusedAppends: value2["refusedAppends"],
        readout: {
          ...expected.readout,
          ...note === void 0 ? {} : { note }
        }
      }
    };
  } catch {
    return invalid;
  }
}

// packages/cli/src/run-archive.ts
async function buildRunArchive(input) {
  const base = buildRunExport(input);
  if (Buffer.byteLength(JSON.stringify(base), "utf8") > MAX_PORTABLE_RECORD_BYTES2)
    return { ok: false, reason: "archive exceeds 16 MiB serialized limit" };
  if (!parseRunExport(JSON.stringify(base)).ok)
    return { ok: false, reason: "invalid run export" };
  if (!applySecretDiscipline3(base, /* @__PURE__ */ new Set()).ok)
    return { ok: false, reason: "archive contains a secret-like value" };
  const refs = referencedAttachments(input.events);
  if (refs && refs.size > MAX_PORTABLE_ARTIFACTS2)
    return { ok: false, reason: "archive exceeds 128 attachments" };
  if (!refs)
    return { ok: false, reason: "conflicting attachment reference bindings" };
  const entries = [];
  const blobs = /* @__PURE__ */ Object.create(null);
  if (base.spec === "delivery-run-export/2")
    for (const metadata of refs.values()) {
      const artifact = await input.readArtifact(metadata.artifactId);
      if (!artifact.ok) {
        if (artifact.code !== "missing" && artifact.code !== "access_refused")
          return {
            ok: false,
            reason: `retained attachment ${artifact.code}; export refused`
          };
        entries.push({
          metadata,
          availability: "unavailable",
          code: artifact.code,
          reason: artifact.reason.slice(0, 512)
        });
        continue;
      }
      if (canonicalize3(artifact.metadata) !== canonicalize3(metadata))
        return { ok: false, reason: "attachment binding differs from journal" };
      if (blobs[metadata.digest] !== void 0 && blobs[metadata.digest] !== artifact.base64)
        return { ok: false, reason: "conflicting attachment bytes" };
      blobs[metadata.digest] = artifact.base64;
      entries.push({ metadata, availability: "retained" });
      if (Buffer.byteLength(JSON.stringify({ entries, blobs }), "utf8") > MAX_PORTABLE_EVIDENCE_BYTES2)
        return {
          ok: false,
          reason: "archive exceeds 8 MiB serialized attachment limit"
        };
    }
  const attachments = { entries, blobs };
  if (base.spec === "delivery-run-export/2" && !validateRunAttachments(attachments, input.events))
    return {
      ok: false,
      reason: "attachment bytes, bindings or serialized limits are invalid"
    };
  const text2 = JSON.stringify({
    ...base,
    ...base.spec === "delivery-run-export/2" ? { attachments } : {}
  });
  if (Buffer.byteLength(text2, "utf8") > MAX_PORTABLE_RECORD_BYTES2)
    return { ok: false, reason: "archive exceeds 16 MiB serialized limit" };
  return { ok: true, text: text2 };
}
function readArchiveArtifact(text2, artifactId) {
  if (Buffer.byteLength(text2, "utf8") > MAX_PORTABLE_RECORD_BYTES2)
    return {
      ok: false,
      code: "invalid",
      reason: "archive exceeds 16 MiB serialized limit"
    };
  const parsed = parseRunExport(text2);
  if (!parsed.ok)
    return { ok: false, code: "invalid", reason: "archive invalid" };
  const entry = parsed.value.attachments?.entries.find(
    (e) => e.metadata.artifactId === artifactId
  );
  if (!entry)
    return {
      ok: false,
      code: "invalid",
      reason: "attachment not retained in this archive"
    };
  if (entry.availability === "unavailable")
    return { ok: false, code: entry.code, reason: entry.reason };
  return {
    ok: true,
    metadata: entry.metadata,
    base64: parsed.value.attachments.blobs[entry.metadata.digest]
  };
}

// packages/cli/src/run-archive-commands.ts
var blocked3 = (reason) => ({
  kind: "blocked",
  blockers: [
    runSurfaceBlocker({
      code: "run_archive_unavailable",
      summary: "The run archive is unavailable.",
      details: oneLine(reason),
      remediation: {
        id: "inspect-run-archive",
        summary: "Check the selected archive or retained run attachments and retry."
      }
    })
  ]
});
async function readArchiveFile(file) {
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat2 = await h.stat();
    if (!stat2.isFile() || stat2.size > MAX_PORTABLE_RECORD_BYTES3)
      throw Error("archive must be a regular file no larger than 16 MiB");
    const buffer = Buffer.alloc(
      Math.min(stat2.size + 1, MAX_PORTABLE_RECORD_BYTES3 + 1)
    );
    let offset = 0;
    while (offset < buffer.length) {
      const read = await h.read(buffer, offset, buffer.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat2.size || offset > MAX_PORTABLE_RECORD_BYTES3)
      throw Error("archive changed size while reading");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await h.close();
  }
}
async function resolvedDestination(file) {
  let parent = path10.dirname(file);
  const suffix = [path10.basename(file)];
  for (; ; ) {
    try {
      return path10.join(await realpath2(parent), ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      suffix.unshift(path10.basename(parent));
      const next = path10.dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}
var within = (parent, child) => {
  const relative = path10.relative(parent, child);
  return relative === "" || !relative.startsWith("..") && !path10.isAbsolute(relative);
};
async function runArchiveCommand(context, command, args) {
  if (command === "export" && (args.length !== 3 || args[1] !== "--output"))
    return {
      kind: "usage",
      message: "Usage: runs export <run-id> --output <file>"
    };
  if (command === "archive" && !(args.length === 1 || args.length === 3 && args[1] === "--artifact"))
    return {
      kind: "usage",
      message: "Usage: runs archive <file> [--artifact <id>]"
    };
  try {
    if (command === "archive") {
      const text2 = await readArchiveFile(
        path10.resolve(context.rootDir, args[0])
      );
      const parsed = parseRunExport(text2);
      if (!parsed.ok) return blocked3("archive invalid or unsupported");
      if (args[1] === "--artifact") {
        const artifact = readArchiveArtifact(text2, args[2]);
        if (!artifact.ok) return blocked3(artifact.reason);
        context.write(
          JSON.stringify({
            spec: "run-artifact/1",
            historical: true,
            authority: "observation",
            runId: parsed.value.runId,
            ...artifact
          })
        );
      } else
        context.write(
          JSON.stringify({
            historical: true,
            authority: "observation",
            archive: parsed.value
          })
        );
      return { kind: "ok" };
    }
    const resolved = await resolveRunSurface(context.rootDir);
    if (!resolved.ok) return blocked3(resolved.reason);
    const store = resolved.surface.store;
    const runId = args[0];
    const journal = await store.read(runId);
    if (!journal.ok) return blocked3("run unavailable");
    const archive = await buildRunArchive({
      runId,
      events: journal.events,
      refusedAppends: await store.readNotes(runId),
      readArtifact: (id) => readRunArtifact(store, runId, id)
    });
    if (!archive.ok) return blocked3(archive.reason);
    const destination = await resolvedDestination(
      path10.resolve(context.rootDir, args[2])
    );
    if (within(await realpath2(resolved.surface.commonDir), destination) || within(await realpath2(resolved.surface.runsDir), destination))
      return blocked3(
        "archive output cannot replace repository metadata or the live run store"
      );
    await createArtifactsPort3().writeTextFile(destination, archive.text, {
      mode: 384
    });
    context.write(
      JSON.stringify({
        spec: "run-archive-export/1",
        runId,
        path: path10.resolve(context.rootDir, args[2]),
        sizeBytes: Buffer.byteLength(archive.text),
        authority: "observation"
      })
    );
    return { kind: "ok" };
  } catch {
    return blocked3("archive file unreadable, oversized, unsafe, or unwritable");
  }
}

// packages/cli/src/run-view-record.ts
import {
  isSafeRelativePath,
  isInsideResolved,
  parseDeliveryRecord,
  digestCanonical as digestCanonical3
} from "./kernel.mjs";
async function withRetainedRecord(view, root, relativePath) {
  if (relativePath === void 0 || view.historical) return view;
  const fields = [];
  const add = (label, value2) => fields.push({ label, value: value2 });
  add("Source", relativePath);
  add(
    "Applicability",
    "Unknown \u2014 no current identity comparison or fresh verification is performed"
  );
  add(
    "Original verification time",
    "Unavailable \u2014 delivery records do not store a verification timestamp"
  );
  try {
    let status = "path_refused";
    let contents = null;
    if (isSafeRelativePath(relativePath)) {
      const resolvedRoot = await realpath3(root);
      const resolvedFile = await realpath3(
        path11.join(resolvedRoot, relativePath)
      );
      if (!isInsideResolved(resolvedRoot, resolvedFile))
        status = "outside_run_root";
      else {
        contents = await readArchiveFile(resolvedFile);
        status = "readable";
      }
    }
    const read = { status, contents };
    if (read.status !== "readable" || read.contents === null) {
      add("Status", `Unavailable \u2014 ${read.status}`);
    } else {
      const parsed = parseDeliveryRecord(read.contents);
      if (!parsed.ok)
        add("Status", "Corrupt \u2014 retained record grammar is invalid");
      else {
        const { integrityDigest, ...unsigned } = parsed.record;
        if (parsed.record.version !== "delivery-record/2")
          add(
            "Status",
            "Legacy record \u2014 integrity unavailable; no accepted evidence inferred"
          );
        else if (integrityDigest !== digestCanonical3(unsigned))
          add("Status", "Corrupt \u2014 retained record digest does not match");
        else {
          add(
            "Status",
            "Recorded for the candidate below \u2014 retained self-attested record, not current approval"
          );
          add("Candidate", parsed.record.candidateBinding.treeSha);
          add(
            "Deliverable digest",
            parsed.record.candidateBinding.deliverableDigest
          );
          for (const claim of parsed.record.claims) {
            add(`Recorded claim \xB7 ${claim.obligationId}`, claim.outcome);
            for (const evidence of [
              claim.evidence,
              ...claim.supportingEvidence ?? []
            ]) {
              if (evidence?.resolution.kind !== "evidence") continue;
              const manifest = evidence.resolution.portable?.manifest;
              if (typeof manifest !== "object" || manifest === null) continue;
              if (digestCanonical3(manifest) !== evidence.resolution.manifestDigest) {
                add(
                  "Retained manifest",
                  "Corrupt \u2014 digest does not match; timestamp unavailable"
                );
                continue;
              }
              const at = manifest["recordedAt"];
              add(
                `Provider-reported recording time \xB7 ${evidence.resolution.providerId}`,
                typeof at === "string" ? at : "Unavailable"
              );
            }
          }
        }
      }
    }
  } catch (error) {
    add(
      "Status",
      error.code === "ENOENT" ? "Unavailable \u2014 missing" : "Unavailable \u2014 bounded retained record read refused"
    );
  }
  const retained = {
    id: "retained-record",
    label: "Retained delivery record",
    fields
  };
  return {
    ...view,
    sections: view.sections.map(
      (section) => section.id === "evidence" ? { ...section, items: [retained, ...section.items] } : section
    )
  };
}

// packages/cli/src/run-view.ts
var value = (v) => v === void 0 ? "Unreported" : typeof v === "string" ? v : JSON.stringify(v);
var item = (id, label, fields, artifactId) => ({
  id,
  label,
  fields: Object.entries(fields).map(([label2, v]) => ({
    label: label2,
    value: value(v)
  })),
  ...artifactId === void 0 ? {} : { artifactId }
});
function projectRunView(events, options) {
  const p = projectRunProgress(events, options.now, options.freshnessWindowMs);
  const historical = options.historical === true;
  const costs = projectCosts(events);
  const runCost = costs.run;
  const attempts = p.activities.flatMap((a) => a.attempts);
  const current = attempts.filter((a) => !a.superseded);
  const sections = [
    {
      id: "waiting",
      title: "Waiting and required action",
      empty: "No current waiting observation. Unreported waits remain unknown.",
      items: p.waits.filter((w) => w.current && !w.resolvedAt).map(
        (w) => item(w.waitId, w.reason, {
          Owner: w.owner,
          "Human action required": w.waitingOn === "human" ? "Yes \u2014 human" : w.waitingOn === "unknown" ? "Unknown" : `No \u2014 ${w.waitingOn}`,
          "Next action": w.nextAction,
          Scope: w.scope,
          Attempt: w.attemptId,
          Observed: w.startedAt,
          Freshness: historical ? "Historical observation" : !Number.isFinite(Date.parse(w.startedAt)) ? "unknown" : Date.parse(options.now) - Date.parse(w.startedAt) > (options.freshnessWindowMs ?? 3e5) ? "stale" : "recent",
          Candidate: w.candidateTreeSha
        })
      )
    },
    {
      id: "work",
      title: "Current work",
      empty: attempts.length === 0 ? "No activity observations; execution status unknown." : "No active work in the latest observations. Retained attempts appear in history.",
      items: current.filter(
        (a) => !["completed", "failed", "interrupted"].includes(a.state)
      ).map(
        (a) => item(a.attemptId, a.activityId, {
          Owner: a.owner,
          Phase: a.phase,
          State: `${a.state} (reported)`,
          Freshness: historical ? "Historical observation" : a.freshness,
          "Last observed": a.lastObservedAt,
          "Elapsed since start": a.startedAt ? `${Math.max(0, Math.floor((Date.parse(options.now) - Date.parse(a.startedAt)) / 1e3))}s` : "Unknown \u2014 start not observed",
          "Next step": a.nextStep,
          Candidate: a.candidateTreeSha,
          "Lifecycle history": a.lifecycleIncomplete ? "Incomplete" : "Observed"
        })
      )
    },
    {
      id: "reviews",
      title: "Reviewer attempts and history",
      empty: "No reviewer attempt observations.",
      items: attempts.filter((a) => a.lensId !== void 0 || a.phase === "review").map(
        (a) => item(a.attemptId, a.lensId ?? a.activityId, {
          Attempt: a.attemptId,
          Round: a.round,
          "Round ID": a.roundId,
          Owner: a.owner,
          State: a.state,
          History: a.superseded ? "Superseded attempt" : "Latest observed attempt",
          Verdict: a.verdict,
          Cost: costLabel(a.cost),
          Candidate: a.candidateTreeSha
        })
      )
    },
    {
      id: "findings",
      title: "Current unresolved findings",
      empty: p.findingsCoverage === "unreported" ? "Unknown \u2014 detailed finding observations were not recorded." : "No unresolved findings in latest reported observations; this is not approval.",
      items: p.currentFindings.filter((f) => f.payload["state"] === "unresolved").map(
        (f) => item(String(f.payload["findingId"]), String(f.payload["findingId"]), {
          Severity: f.payload["severity"],
          State: "Unresolved (reported)",
          Report: f.payload["reportId"],
          Attempt: f.payload["attemptId"],
          Candidate: f.payload["candidateTreeSha"]
        })
      )
    },
    {
      id: "evidence",
      title: "Evidence and candidate",
      empty: "No evidence observations. Applicability unknown.",
      items: events.filter(
        (e) => [
          "gate.reported",
          "command.completed",
          "review.round.closed"
        ].includes(e.kind)
      ).map(
        (e) => item(String(e.seq), e.kind, {
          "Reported at": e.at,
          Candidate: e.candidateTreeSha ?? e.payload["candidateTreeSha"],
          Observation: e.payload,
          Authority: "Reported only \u2014 Applicability unknown; no verification is run by this view"
        })
      )
    },
    {
      id: "reports",
      title: "Retained reports",
      empty: "No report references recorded.",
      items: p.reports.map(
        (r) => item(
          String(r.payload["reportId"]),
          String(r.payload["role"]),
          {
            Report: r.payload["reportId"],
            Availability: r.payload["availability"],
            Reason: r.payload["reason"],
            "Originating report": r.payload["originatingReportId"],
            Lens: r.payload["lensId"],
            Attempt: r.payload["attemptId"],
            Candidate: r.payload["candidateTreeSha"],
            History: r.current ? "Latest observed attempt" : "Historical or incomplete binding"
          },
          typeof r.payload["artifactId"] === "string" ? r.payload["artifactId"] : void 0
        )
      )
    },
    {
      id: "finish",
      title: "Declared finish line",
      empty: "Finish steps unreported; delivery completion unknown.",
      items: []
    },
    {
      id: "cost",
      title: "Reported cost",
      empty: "Cost unreported.",
      items: [
        {
          id: "review-cost",
          label: "Review totals",
          fields: [
            ...item("review-cost", "Review totals", {
              Coverage: costs.review.coverage,
              "Unreported round entries": costs.review.unreportedEntries,
              ...costs.review.totals.length === 0 ? { Measurement: "Unreported" } : {}
            }).fields,
            ...costs.review.totals.map((total) => ({
              label: `${total.reportedBy} \xB7 ${total.unit}`,
              value: total.total === null ? "Unavailable \u2014 reported sum exceeds numeric range" : `${total.total} ${total.unit}`
            }))
          ]
        },
        item("run-cost", "Run total", {
          Coverage: runCost["coverage"],
          Measurement: costLabel(runCost),
          "Reported by": runCost["reportedBy"],
          Accounting: "Run totals can include review and attempt costs. These totals are shown separately and are not added together."
        }),
        ...attempts.filter((a) => a.cost !== void 0).map((a) => {
          const cost = a.cost;
          return item(`attempt-cost-${a.attemptId}`, `Attempt cost \xB7 ${a.activityId}`, {
            Attempt: a.attemptId,
            Owner: a.owner,
            Phase: a.phase,
            State: `${a.state} (reported)`,
            History: a.superseded ? "Superseded attempt" : "Latest observed attempt",
            Candidate: a.candidateTreeSha,
            Coverage: cost["coverage"],
            Measurement: costLabel(a.cost),
            "Reported by": cost["reportedBy"],
            Accounting: "Reported attempt measurement; not added to run or review totals, which may overlap."
          });
        })
      ]
    },
    {
      id: "activity-history",
      title: "Activity history",
      empty: "No completed, failed, interrupted or superseded activity observations.",
      items: attempts.filter((a) => a.superseded || ["completed", "failed", "interrupted"].includes(a.state)).map((a) => item(a.attemptId, a.activityId, {
        Attempt: a.attemptId,
        Owner: a.owner,
        Phase: a.phase,
        State: `${a.state} (reported)`,
        History: a.superseded ? "Superseded attempt" : "Latest observed attempt",
        Freshness: historical ? "Historical observation" : a.freshness,
        "Last observed": a.lastObservedAt,
        Candidate: a.candidateTreeSha,
        "Lifecycle history": a.lifecycleIncomplete ? "Incomplete" : "Observed",
        Cost: costLabel(a.cost)
      }))
    },
    {
      id: "finding-history",
      title: "Finding history",
      empty: "No detailed finding history.",
      items: p.findings.map(
        (f) => item(String(f.seq), String(f.payload["findingId"]), {
          State: f.payload["state"],
          Severity: f.payload["severity"],
          Attempt: f.payload["attemptId"],
          Candidate: f.payload["candidateTreeSha"],
          "Deferred issue": f.payload["deferredIssueId"],
          Observed: f.at
        })
      )
    }
  ];
  const reviewSection = sections.find((s) => s.id === "reviews");
  sections[2] = {
    ...reviewSection,
    items: [
      ...events.filter((e) => e.kind === "review.round.opened").map(
        (e) => item(`round-${e.seq}`, "Declared review round", {
          Round: e.payload["round"],
          "Round ID": e.payload["roundId"],
          Bound: e.payload["bound"],
          Grace: e.payload["grace"],
          Reopens: e.payload["reopensRoundId"],
          Candidate: e.payload["candidateTreeSha"]
        })
      ),
      ...reviewSection.items
    ]
  };
  const finish = /* @__PURE__ */ new Map();
  for (const step of p.finishSteps)
    finish.set(String(step.payload["stepId"]), step);
  sections[6] = {
    id: "finish",
    title: "Declared finish line",
    empty: "Finish steps unreported; delivery completion unknown.",
    items: [...finish.values()].map(
      (s) => item(String(s.payload["stepId"]), String(s.payload["name"]), {
        State: s.payload["state"],
        Owner: s.payload["owner"],
        Reason: s.payload["reason"],
        Candidate: s.payload["candidateTreeSha"]
      })
    )
  };
  return {
    spec: "run-view/1",
    historical,
    asOf: options.now,
    authority: "Self-attested observations. Applicability unknown; no permission or candidate approval is granted.",
    sections
  };
}

// packages/cli/src/run-view-command.ts
async function runViewCommand(context, args) {
  const runId = args[0];
  let json = false;
  let recordPath;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--json" && !json) json = true;
    else if (args[i] === "--record" && recordPath === void 0 && args[i + 1])
      recordPath = args[++i];
    else
      return {
        kind: "usage",
        message: "Usage: runs view <run-id> [--json] [--record <repository-relative-path>]"
      };
  }
  if (!runId)
    return {
      kind: "usage",
      message: "Usage: runs view <run-id> [--json] [--record <repository-relative-path>]"
    };
  const resolved = await resolveRunSurface(context.rootDir);
  const read = resolved.ok ? await resolved.surface.store.read(args[0]) : void 0;
  if (!read?.ok)
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_view_unavailable",
          summary: "Run observations are unavailable.",
          details: resolved.ok ? "The selected run could not be read." : oneLine(resolved.reason),
          remediation: {
            id: "inspect-run",
            summary: "Check the selected repository and run identifier."
          }
        })
      ]
    };
  const view = await withRetainedRecord(
    projectRunView(read.events, { now: (/* @__PURE__ */ new Date()).toISOString() }),
    context.rootDir,
    recordPath
  );
  if (json) context.write(JSON.stringify(view));
  else {
    context.write(view.authority);
    for (const section of view.sections) {
      context.write(section.title);
      if (!section.items.length) context.write(`  ${section.empty}`);
      for (const item2 of section.items) {
        context.write(`  ${oneLine(item2.label)}`);
        for (const field of item2.fields)
          context.write(`    ${oneLine(field.label)}: ${oneLine(field.value, 8192)}`);
        if (item2.artifactId)
          context.write(
            `    Report: runs artifact ${oneLine(args[0])} ${oneLine(item2.artifactId)} --json`
          );
      }
    }
  }
  return { kind: "ok" };
}

// packages/cli/src/run-artifact-commands.ts
import {
  captureRunArtifact,
  readRunArtifact as readRunArtifact2,
  validateRunEventInput
} from "./kernel.mjs";
var blocked4 = (reason) => ({
  kind: "blocked",
  blockers: [
    runSurfaceBlocker({
      code: "run_artifact_unavailable",
      summary: "The run attachment is unavailable.",
      details: oneLine(reason),
      remediation: {
        id: "inspect-selected-report",
        summary: "Check the explicit report binding and selected source file, then retry capture."
      }
    })
  ]
});
var record2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
async function runArtifactCommand(context, command, args) {
  if (command === "artifact" && (args.length < 2 || args.length > 3 || args[2] !== void 0 && args[2] !== "--json"))
    return {
      kind: "usage",
      message: "Usage: runs artifact <run-id> <artifact-id> [--json]"
    };
  if (command === "capture" && (args.length !== 3 || args[1] !== "--json"))
    return {
      kind: "usage",
      message: "Usage: runs capture <run-id> --json <request>"
    };
  const resolved = await resolveRunSurface(context.rootDir);
  if (!resolved.ok) return blocked4(resolved.reason);
  const { store, commonDir } = resolved.surface;
  const runId = args[0];
  if (command === "artifact") {
    const result2 = await readRunArtifact2(store, runId, args[1]);
    if (!result2.ok) return blocked4(result2.reason);
    context.write(
      args[2] === "--json" ? `${JSON.stringify({ spec: "run-artifact/1", labels: "self-attested observation; not admission evidence", runId, ...result2 })}
` : `${oneLine(Buffer.from(result2.base64, "base64").toString("utf8"), 2 * 1024 * 1024)}
`
    );
    return { kind: "ok" };
  }
  let request;
  try {
    if (Buffer.byteLength(args[2], "utf8") > 16384)
      return blocked4("capture request exceeds 16 KiB");
    request = JSON.parse(args[2]);
  } catch {
    return { kind: "usage", message: "Capture request must be JSON." };
  }
  if (!record2(request) || Object.keys(request).sort().join(",") !== "artifact,eventId,report,sourcePath,sourceRoot" || typeof request["sourceRoot"] !== "string" || typeof request["sourcePath"] !== "string" || typeof request["eventId"] !== "string" || !record2(request["artifact"]) || !record2(request["report"]))
    return {
      kind: "usage",
      message: "Capture requires artifact, report, eventId, sourceRoot and sourcePath."
    };
  const artifact = request["artifact"];
  const report = request["report"];
  const binding = {
    activityId: artifact["activityId"],
    attemptId: artifact["attemptId"],
    candidateTreeSha: artifact["candidateTreeSha"],
    ...artifact["roundId"] === void 0 ? {} : { roundId: artifact["roundId"] },
    ...artifact["round"] === void 0 ? {} : { round: artifact["round"] },
    ...artifact["lensId"] === void 0 ? {} : { lensId: artifact["lensId"] }
  };
  const journal = await store.read(runId);
  if (!journal.ok || journal.events[0]?.version !== "run-event/2")
    return blocked4(
      "capture requires an existing run-event/2 run; start an explicit successor for a legacy run"
    );
  const make = (suffix, kind, payload) => {
    const event = buildRunEvent({
      runId,
      commonDir,
      kind,
      role: "executor",
      payload,
      version: "run-event/2",
      eventId: `${request["eventId"]}-${suffix}`
    });
    return event;
  };
  const artifactEvent = make("artifact", "artifact.referenced", artifact);
  const reportEvent = make("report", "report.referenced", {
    ...report,
    ...binding,
    availability: "referenced",
    artifactId: artifact["artifactId"]
  });
  if (Object.keys(report).some(
    (k) => !["reportId", "role", "originatingReportId", "findingId"].includes(k)
  ) || !validateRunEventInput(artifactEvent).ok || !validateRunEventInput(reportEvent).ok)
    return blocked4("invalid report or artifact event binding");
  const result = await captureRunArtifact({
    store,
    runId,
    metadata: artifact,
    sourceRoot: request["sourceRoot"],
    sourcePath: request["sourcePath"]
  });
  if (!result.ok) {
    const unavailable = make("unavailable", "report.referenced", {
      ...report,
      ...binding,
      availability: "unavailable",
      reason: result.reason
    });
    await store.append(runId, unavailable, { reuseExistingTimestamp: true });
    return blocked4(result.reason);
  }
  for (const event of [artifactEvent, reportEvent]) {
    const appended = await store.append(runId, event, { reuseExistingTimestamp: true });
    if (!appended.ok)
      return blocked4(
        `bytes retained but reference append refused: ${appended.rejections.map((r) => r.message).join("; ")}`
      );
  }
  context.write(
    `${JSON.stringify({ spec: "run-artifact-capture/1", runId, artifactId: result.metadata.artifactId, digest: result.metadata.digest, availability: "referenced", authority: "observation" })}
`
  );
  return { kind: "ok" };
}

// packages/cli/src/commands/runs.ts
import { stat } from "node:fs/promises";
import path12 from "node:path";
import { evaluateRunJournal as evaluateRunJournal4 } from "./kernel.mjs";

// packages/cli/src/run-view-html.ts
var escapeViewHtml = (value2) => value2.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
var text = (value2) => escapeViewHtml(oneLine(value2, 8192));
var OPERATIONAL_STYLE = `
:root{color-scheme:light dark;--paper:#f5f5f7;--surface:#fff;--ink:#1d1d1f;--muted:#626267;--line:#d8d8de;--link:#0067c0;--wash:#eaf2fa}
*{box-sizing:border-box}body{font:400 1rem/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-optical-sizing:auto;letter-spacing:-.01em;color:var(--ink);background:var(--paper);max-width:76rem;margin:0 auto;padding:2.5rem 2rem 5rem;overflow-wrap:anywhere}
h1{font-size:2.25rem;line-height:1.12;letter-spacing:-.04em;margin:0 0 1.25rem;font-weight:700}h2{font-size:1.35rem;line-height:1.3;letter-spacing:-.025em;margin:2rem 0 .5rem}h3{font-size:1.3rem;line-height:1.3;letter-spacing:-.025em;color:var(--ink);margin:0 0 1rem}h4{font-size:1.05rem;line-height:1.35;margin:0 0 1rem;letter-spacing:-.015em}
p{margin:.6rem 0 1rem}.meta,.ended{color:var(--muted);font-size:.875rem}.labels{font-size:.875rem;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:.75rem;padding:1rem 1.25rem;margin:1rem 0}.live{color:var(--ink)}.open{color:var(--muted)}
a{color:var(--link);text-underline-offset:.2em;border-radius:.3rem}a:hover{text-decoration-thickness:2px}a:active,summary:active{background:var(--wash);color:var(--ink)}a:focus-visible,summary:focus-visible{outline:3px solid var(--link);outline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:.4rem;margin:1.5rem 0 2.5rem}nav a{display:inline-flex;align-items:center;min-height:2.75rem;padding:.5rem .85rem;border:1px solid var(--line);border-radius:2rem;background:var(--surface);font-size:.875rem;text-decoration:none}nav a:hover{border-color:var(--link)}
section{scroll-margin-top:1.5rem;margin:2.5rem 0}section>p{color:var(--muted);font-size:.9375rem}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,23rem),1fr));gap:1rem}.card{background:var(--surface);border:1px solid var(--line);border-radius:1rem;padding:1.5rem;min-width:0}.card>a{display:inline-flex;align-items:center;min-height:2.75rem;margin-top:.5rem}dl{margin:.5rem 0}dt{font-size:.8125rem;color:var(--muted);font-weight:500;margin-top:.75rem}dd{margin:.15rem 0 .75rem;overflow-wrap:anywhere}details{margin:1rem 0;border-top:1px solid var(--line);padding-top:.5rem}summary{cursor:pointer;min-height:2.75rem;padding:.5rem 0;font-size:.875rem;color:var(--muted);border-radius:.3rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface);border:1px solid var(--line);border-radius:1rem;padding:1.5rem;font: .875rem/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.table-scroll{max-width:100%;overflow-x:auto;margin:1rem 0 2rem;border:1px solid var(--line);border-radius:.75rem}table{border-collapse:collapse;display:table;min-width:48rem;width:100%;font-size:.8125rem;margin:0}th,td{border:0;border-bottom:1px solid var(--line);padding:.75rem;text-align:left;vertical-align:top}th{background:var(--surface);font-weight:600}tr:last-child td{border-bottom:0}
.back{margin:.5rem 0}.run-identifiers,.view-provenance{margin:.25rem 0;border:0;padding:0}.section-navigation{margin:.25rem 0 1rem;border:0;padding:0}.section-navigation nav{margin:.5rem 0}body>details:first-of-type{margin:.5rem 0;border:0;padding:0}body>h1{margin-bottom:.5rem}section:first-of-type{margin-top:1.25rem}
@media(max-width:600px){body{padding:1.5rem 1rem 3rem;margin:0}h1{font-size:1.875rem}.cards{grid-template-columns:1fr}.card{padding:1.125rem}nav{gap:.375rem}section{margin:2rem 0}}
@media(prefers-color-scheme:dark){:root{--paper:#161618;--surface:#212124;--ink:#f5f5f7;--muted:#b1b1b8;--line:#45454b;--link:#8ac7ff;--wash:#263b50}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
@media(prefers-reduced-transparency:reduce){.card,nav a,.labels{background:var(--surface);backdrop-filter:none}}
@media(prefers-contrast:more){:root{--muted:var(--ink);--line:var(--ink)}a{text-decoration:underline}nav a{border-width:2px}}
`;
var secondaryLabels = /* @__PURE__ */ new Set([
  "Candidate",
  "Attempt",
  "Scope",
  "Lifecycle",
  "Origin"
]);
function fieldsHtml(fields) {
  return fields.map((f) => `<dt>${text(f.label)}</dt><dd>${text(f.value)}</dd>`).join("");
}
function cardFields(fields) {
  const primary = fields.filter((f) => !secondaryLabels.has(f.label));
  const provenance = fields.filter((f) => secondaryLabels.has(f.label));
  return `<dl>${fieldsHtml(primary)}</dl>${provenance.length ? `<details><summary>Provenance and identifiers</summary><dl>${fieldsHtml(provenance)}</dl></details>` : ""}`;
}
function renderOperationalView(view, baseHref) {
  return `${view.historical ? '<p class="meta">Historical archive \u2014 observations retained at export.</p>' : ""}<details class="section-navigation"><summary>Browse reports, evidence and history</summary><nav aria-label="Run sections">${view.sections.map((s) => `<a href="#${text(s.id)}">${text(s.title)}</a>`).join("")}</nav></details>` + view.sections.map(
    (s) => `<section id="${text(s.id)}"><h3>${text(s.title)}</h3>${s.items.length ? `<div class="cards">${s.items.map((i) => `<article class="card"><h4>${text(i.label)}</h4>${cardFields(i.fields)}${i.artifactId === void 0 ? "" : `<a href="${text(baseHref)}/artifacts/${encodeURIComponent(i.artifactId)}">Open retained report</a>`}</article>`).join("")}</div>` : `<p>${text(s.empty)}</p>`}</section>`
  ).join("");
}
function renderArtifactDetail(input) {
  const { result } = input;
  const m = result.ok ? result.metadata : input.metadata;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Retained report</title><style>body{font:16px/1.5 system-ui;margin:1.5rem}${OPERATIONAL_STYLE}</style></head><body><a href="${text(input.backHref)}#reports">Return to run</a><h1>Retained report</h1><p>Run ${text(input.runId)} \xB7 Artifact ${text(input.artifactId)}</p><p>Self-attested ${input.historical ? "historical archive" : "retained"} output; not admission evidence.</p>${m ? `<dl><dt>Lens</dt><dd>${text(m.lensId ?? "Unreported")}</dd><dt>Attempt</dt><dd>${text(m.attemptId)}</dd><dt>Candidate</dt><dd>${text(m.candidateTreeSha)}</dd><dt>Digest</dt><dd>${text(m.digest)}</dd><dt>Size</dt><dd>${m.sizeBytes} bytes</dd></dl>` : ""}${result.ok ? `<a href="${text(input.backHref)}/artifacts/${encodeURIComponent(input.artifactId)}/download">Download exact report bytes</a><pre>${escapeViewHtml(Buffer.from(result.base64, "base64").toString("utf8"))}</pre>` : `<p role="status">${text(result.code)}: ${text(result.reason)}</p>`}</body></html>`;
}

// packages/cli/src/run-server.ts
import {
  createServer
} from "node:http";
import {
  evaluateRunJournal as evaluateRunJournal3,
  sha256Hex as sha256Hex5,
  readRunArtifact as readRunArtifact3,
  RUN_STORE_ID as RUN_STORE_ID3
} from "./kernel.mjs";
var RUN_SERVER_HOST = "127.0.0.1";
var DEFAULT_POLL_SECONDS = 2;
var RUN_SERVER_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'"
].join("; ");
async function resolveRepo(repoPath) {
  const surface = await resolveRunSurface(repoPath);
  if (!surface.ok) return { reason: `${repoPath}: ${surface.reason}` };
  const root = await resolveWorktreeRoot(repoPath);
  if (!root.ok) return { reason: `${repoPath}: ${root.reason}` };
  return {
    root: root.root,
    commonDir: surface.surface.commonDir,
    runsDir: surface.surface.runsDir,
    worktreeKey: surface.surface.worktreeKey,
    store: surface.surface.store
  };
}
function groupByStore(resolved) {
  const groups = /* @__PURE__ */ new Map();
  for (const repo of resolved) {
    const existing = groups.get(repo.commonDir);
    if (existing === void 0) {
      groups.set(repo.commonDir, {
        root: repo.root,
        commonDir: repo.commonDir,
        runsDir: repo.runsDir,
        worktreeKeys: [repo.worktreeKey],
        store: repo.store
      });
      continue;
    }
    if (!existing.worktreeKeys.includes(repo.worktreeKey))
      existing.worktreeKeys.push(repo.worktreeKey);
  }
  return [...groups.values()];
}
function servedRun(input) {
  const { summary } = input;
  return {
    runId: input.runId,
    ...input.view === void 0 ? {} : { view: input.view },
    ...input.href === void 0 ? {} : { href: input.href },
    repository: input.repository,
    readable: input.readable,
    live: input.live,
    open: summary.open,
    ticket: summary.ticket,
    startedAt: summary.startedAt,
    lastAt: summary.lastAt,
    durationSeconds: summary.durationSeconds,
    rounds: { opened: summary.roundsOpened, closed: summary.roundsClosed },
    findings: summary.findings,
    ...summary.gate === void 0 ? {} : { gate: summary.gate },
    ...summary.record === void 0 ? {} : { record: summary.record },
    ...summary.result === void 0 ? {} : { result: summary.result },
    readout: input.readout,
    timeline: input.timeline,
    roundDetail: input.roundDetail,
    notes: input.notes
  };
}
var EMPTY_SUMMARY = {
  ticket: "",
  open: true,
  startedAt: "",
  lastAt: "",
  durationSeconds: 0,
  roundsOpened: 0,
  roundsClosed: 0,
  findings: { P0: 0, P1: 0, P2: 0, P3: 0 }
};
function timelineOf(events) {
  return events.map((event) => ({
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    writer: event.actor.role,
    detail: detailOf(event)
  }));
}
function roundsOf(events) {
  return roundEntries(events).map((entry) => {
    const closed = entry.closed === void 0 ? void 0 : payloadOf(entry.closed);
    return {
      round: entry.round,
      candidateTreeSha: entry.candidateTreeSha,
      opened: entry.opened !== void 0,
      lenses: roundLenses(entry),
      outcome: closed === void 0 ? "open" : oneLineOf(closed["outcome"], 64),
      findings: closed === void 0 ? "" : oneLineOf(closed["findings"]),
      cost: closed === void 0 ? "" : costLabel(closed["cost"])
    };
  });
}
function notesOf(entries) {
  return entries.map((entry) => {
    const note = typeof entry === "object" && entry !== null ? entry : {};
    return {
      at: oneLineOf(note["at"], 32),
      kind: oneLineOf(note["kind"], 128),
      code: oneLineOf(note["code"], 64),
      pattern: oneLineOf(note["pattern"], 64)
    };
  });
}
async function readState(groups, pollSeconds, now, freshnessWindowMs, recordPath) {
  const runs = [];
  for (const group of groups) {
    const live = /* @__PURE__ */ new Set();
    for (const worktreeKey of group.worktreeKeys) {
      const current = await group.store.current(worktreeKey);
      if (current.ok && current.runId !== void 0) live.add(current.runId);
    }
    for (const runId of await group.store.list()) {
      const read = await group.store.read(runId);
      const notes = notesOf(await group.store.readNotes(runId));
      if (!read.ok) {
        runs.push(
          servedRun({
            runId,
            repository: group.root,
            readable: false,
            href: `/runs/${sha256Hex5(group.commonDir)}/${runId}`,
            live: false,
            summary: EMPTY_SUMMARY,
            readout: {
              status: "absent",
              present: [],
              missing: [],
              violations: []
            },
            timeline: [],
            roundDetail: [],
            notes
          })
        );
        continue;
      }
      const events = read.events;
      const summary = summarize(events);
      runs.push(
        servedRun({
          runId,
          repository: group.root,
          view: await withRetainedRecord(
            projectRunView(events, {
              now,
              ...freshnessWindowMs === void 0 ? {} : { freshnessWindowMs }
            }),
            group.root,
            recordPath
          ),
          href: `/runs/${sha256Hex5(group.commonDir)}/${runId}`,
          readable: true,
          // Liveness is the pointer AND the absence of an end, never one alone:
          // a pointer left behind by a run that ended without clearing it must
          // not read as a run still in flight.
          live: summary.open && live.has(runId),
          summary,
          // No record tree sha and no mandated pair: the viewer has neither, and
          // pretending otherwise would turn an observation into a claim.
          readout: readoutOf(events, evaluateRunJournal3(events), group.root),
          timeline: timelineOf(events),
          roundDetail: roundsOf(events),
          notes
        })
      );
    }
  }
  return {
    labels: READOUT_LABELS,
    pollSeconds,
    repositories: groups.map((group) => ({
      root: group.root,
      commonDir: group.commonDir,
      runsDir: group.runsDir,
      worktreeKeys: group.worktreeKeys
    })),
    runs
  };
}
function escapeHtml(value2) {
  return value2.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var cell = (value2, maximum = 240) => escapeHtml(oneLine(value2, maximum));
var RUNS_HEADER = [
  "run",
  "ticket",
  "repository",
  "duration",
  "rounds",
  "historical findings",
  "gate",
  "record",
  "result",
  "state"
];
function stateCell(run) {
  if (!run.readable) return `<td class="open">unreadable</td>`;
  if (run.live) return `<td class="live">selected / open</td>`;
  return run.open ? `<td class="open">open</td>` : `<td class="ended">ended</td>`;
}
var written = (outcome2) => outcome2 === void 0 ? "\u2014" : `${cell(outcome2.outcome, 64)} <span class="meta">(${cell(outcome2.writer, 16)}-written)</span>`;
function runsTable(state) {
  const rows = state.runs.map(
    (run) => [
      "<tr>",
      `<td><a href="${escapeHtml(run.href ?? "#")}">${cell(run.runId, 128)}</a></td>`,
      `<td>${cell(run.ticket, 128) || "\u2014"}</td>`,
      `<td>${cell(run.repository, 400)}</td>`,
      `<td>${run.durationSeconds}s</td>`,
      `<td>${run.rounds.closed}/${run.rounds.opened}</td>`,
      `<td>P0 ${run.findings.P0} \xB7 P1 ${run.findings.P1} \xB7 P2 ${run.findings.P2} \xB7 P3 ${run.findings.P3}</td>`,
      `<td>${written(run.gate)}</td>`,
      `<td>${written(run.record)}</td>`,
      `<td>${run.result === void 0 ? "\u2014" : cell(run.result, 64)}</td>`,
      stateCell(run),
      "</tr>"
    ].join("")
  );
  return [
    "<table>",
    `<tr>${RUNS_HEADER.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`,
    rows.length === 0 ? `<tr><td colspan="${RUNS_HEADER.length}">no runs in this store</td></tr>` : rows.join(""),
    "</table>"
  ].join("");
}
function timelineTable(run) {
  const rows = run.timeline.map(
    (entry) => [
      "<tr>",
      `<td>${entry.seq}</td>`,
      `<td>${cell(entry.at, 32)}</td>`,
      `<td>${cell(entry.kind, 64)}</td>`,
      `<td>${cell(entry.writer, 16)}-written</td>`,
      `<td>${cell(entry.detail, 400)}</td>`,
      "</tr>"
    ].join("")
  );
  return [
    "<h3>timeline</h3><table><tr><th>seq</th><th>at</th><th>kind</th><th>writer</th><th>detail</th></tr>",
    rows.length === 0 ? '<tr><td colspan="5">no readable events</td></tr>' : rows.join(""),
    "</table>"
  ].join("");
}
function roundsTable(run) {
  if (run.roundDetail.length === 0) return "";
  const rows = run.roundDetail.map(
    (round) => [
      "<tr>",
      `<td>${cell(round.round, 32)}</td>`,
      `<td>${cell(round.candidateTreeSha, 128) || "(none)"}</td>`,
      `<td>${cell(round.lenses)}</td>`,
      `<td>${cell(round.outcome, 64)}</td>`,
      `<td>${cell(round.findings)}</td>`,
      `<td>${cell(round.cost, 64)}</td>`,
      "</tr>"
    ].join("")
  );
  return [
    "<h3>rounds</h3><table><tr><th>round</th><th>candidate</th><th>lenses</th><th>outcome</th><th>findings</th><th>cost</th></tr>",
    rows.join(""),
    "</table>"
  ].join("");
}
function notesTable(run) {
  if (run.notes.length === 0) return "";
  const rows = run.notes.map(
    (note) => `<tr><td>${cell(note.at, 32)}</td><td>${cell(note.kind, 128)}</td><td>${cell(note.code, 64)}</td><td>${cell(note.pattern, 64)}</td></tr>`
  );
  return [
    "<h3>refused appends</h3><table><tr><th>at</th><th>kind</th><th>code</th><th>pattern</th></tr>",
    rows.join(""),
    "</table>"
  ].join("");
}
function readoutBlock(run) {
  const list = (entries) => entries.length === 0 ? "(none)" : cell(entries.join(", "), 800);
  return [
    "<h3>completeness</h3>",
    `<p class="labels">${cell(run.readout.status, 64)} \u2014 ${escapeHtml(READOUT_LABELS)}</p>`,
    `<p class="meta">present: ${list(run.readout.present)}</p>`,
    `<p class="meta">missing: ${list(run.readout.missing)}</p>`,
    run.readout.violations.length === 0 ? "" : `<p class="meta">violations: ${list(run.readout.violations)}</p>`,
    run.readout.note === void 0 ? "" : `<p class="meta">note: ${cell(run.readout.note, 500)}</p>`
  ].join("");
}
function renderPage(state) {
  const anyLive = state.runs.some((run) => run.live);
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    anyLive ? `<meta http-equiv="refresh" content="${state.pollSeconds}">` : "",
    "<title>delivery runs</title>",
    `<style>${OPERATIONAL_STYLE}</style></head><body>`,
    state.selected ? `<h1>${cell(state.runs[0]?.ticket || "Delivery run", 128)}</h1>` : "<h1>Delivery runs</h1>",
    '<p class="meta">Reported observations only; not approval evidence.</p>',
    "<details><summary>Run details and provenance</summary>",
    `<p class="labels">${escapeHtml(READOUT_LABELS)}. Nothing here is read by admission, the gate, or the recorder.</p>`,
    ...state.repositories.map(
      (repository) => `<p class="meta">${cell(repository.root, 400)} \u2014 ${cell(repository.runsDir, 400)}</p>`
    ),
    anyLive ? `<p class="meta">refreshing every ${state.pollSeconds}s while a run is selected and open; execution is not inferred</p>` : '<p class="meta">no selected open run; this page does not refresh itself</p>',
    "</details>",
    state.selected ? '<p class="back"><a href="/">All runs</a></p>' : runsTable(state),
    ...state.runs.map(
      (run) => state.selected && !run.readable ? `<section aria-label="Run read error"><h2>Run journal unreadable</h2><p>The journal for ${cell(run.runId, 128)} could not be read. Activity, evidence and completeness are unavailable.</p></section>` : [
        state.selected ? "" : `<h2>${cell(run.runId, 128)}</h2><p class="meta">${cell(run.repository, 400)}</p>`,
        run.view === void 0 || !state.selected ? "" : renderOperationalView(run.view, run.href ?? ""),
        roundsTable(run),
        timelineTable(run),
        notesTable(run),
        readoutBlock(run)
      ].join("")
    ),
    "</body></html>"
  ].join("").replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>");
}
var SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": RUN_SERVER_CSP,
  "Referrer-Policy": "no-referrer",
  // A viewer of a live store must never be shown a cached run, and no proxy
  // between loopback and loopback has any business holding one.
  "Cache-Control": "no-store"
};
function send(response, status, contentType, body) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType
  });
  response.end(body);
}
function hostIsBound(header, host, port) {
  return header === `${host}:${port}`;
}
async function startRunServer(input) {
  if (input.repos.length === 0 && (input.archives?.length ?? 0) === 0)
    return { ok: false, reason: "no repository path to serve" };
  const pollSeconds = input.pollSeconds ?? DEFAULT_POLL_SECONDS;
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0 || !Number.isFinite(input.freshnessWindowMs ?? 0) || (input.freshnessWindowMs ?? 0) < 0)
    return {
      ok: false,
      reason: "invalid observation refresh or freshness window"
    };
  const resolved = [];
  for (const repoPath of input.repos) {
    const outcome2 = await resolveRepo(repoPath);
    if ("reason" in outcome2) return { ok: false, reason: outcome2.reason };
    resolved.push(outcome2);
  }
  const groups = groupByStore(resolved);
  const archives = /* @__PURE__ */ new Map();
  for (const supplied of input.archives ?? []) {
    const parsed = parseRunExport(supplied.text);
    if (!parsed.ok)
      return { ok: false, reason: "archive invalid or unsupported" };
    archives.set(sha256Hex5(supplied.text), {
      ...supplied,
      archive: parsed.value
    });
  }
  const now = input.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const archiveRun = (id, entry) => servedRun({
    runId: entry.archive.runId,
    repository: `Archive: ${entry.label}`,
    readable: true,
    live: false,
    summary: summarize(entry.archive.events),
    readout: entry.archive.readout,
    timeline: timelineOf(entry.archive.events),
    roundDetail: roundsOf(entry.archive.events),
    notes: [],
    href: `/archives/${id}`,
    view: projectRunView(entry.archive.events, {
      now: entry.archive.events.at(-1)?.at ?? "",
      historical: true
    })
  });
  const state = async () => {
    const live = await readState(
      groups,
      pollSeconds,
      now(),
      input.freshnessWindowMs,
      input.recordPath
    );
    return {
      ...live,
      runs: [
        ...live.runs,
        ...[...archives.entries()].map(([id, entry]) => archiveRun(id, entry))
      ]
    };
  };
  let bound;
  const server = createServer(
    (request, response) => {
      void (async () => {
        try {
          if (bound === void 0 || !hostIsBound(request.headers.host, bound.host, bound.port)) {
            send(
              response,
              403,
              "text/plain; charset=utf-8",
              "forbidden host\n"
            );
            return;
          }
          if (request.method !== "GET" && request.method !== "HEAD") {
            send(
              response,
              405,
              "text/plain; charset=utf-8",
              "method not allowed\n"
            );
            return;
          }
          const route = (request.url ?? "/").split("?")[0];
          if (route === "/") {
            send(
              response,
              200,
              "text/html; charset=utf-8",
              renderPage(await state())
            );
            return;
          }
          if (route === "/api/runs") {
            send(
              response,
              200,
              "application/json; charset=utf-8",
              `${JSON.stringify(await state(), null, 2)}
`
            );
            return;
          }
          const match = route?.match(
            /^\/(runs\/([a-f0-9]{64})\/([A-Za-z0-9_-]+)|archives\/([a-f0-9]{64}))(?:\/artifacts\/([A-Za-z0-9_-]+)(\/download)?)?$/
          );
          if (match) {
            const base = `/${match[1]}`;
            const archive = match[4] ? archives.get(match[4]) : void 0;
            const group = match[2] ? groups.find((g) => sha256Hex5(g.commonDir) === match[2]) : void 0;
            if (!archive && !group) {
              send(response, 404, "text/plain; charset=utf-8", "not found\n");
              return;
            }
            const runId = archive?.archive.runId ?? match[3];
            const artifactId = match[5];
            if (artifactId !== void 0) {
              if (!RUN_STORE_ID3.test(artifactId) || artifactId.length > 128) {
                send(response, 404, "text/plain; charset=utf-8", "not found\n");
                return;
              }
              const result = archive ? readArchiveArtifact(archive.text, artifactId) : await readRunArtifact3(group.store, runId, artifactId);
              if (match[6] && result.ok) {
                response.writeHead(200, {
                  ...SECURITY_HEADERS,
                  "Content-Type": "application/octet-stream",
                  "Content-Disposition": `attachment; filename="${artifactId}.bin"`
                });
                response.end(Buffer.from(result.base64, "base64"));
                return;
              }
              const liveRead = group === void 0 ? void 0 : await group.store.read(runId);
              const referenceList = archive?.archive.events ?? (liveRead?.ok ? liveRead.events : []);
              const reference = referenceList.find(
                (e) => e.kind === "artifact.referenced" && e.payload["artifactId"] === artifactId
              )?.payload;
              send(
                response,
                result.ok ? 200 : 404,
                "text/html; charset=utf-8",
                renderArtifactDetail({
                  runId,
                  artifactId,
                  backHref: base,
                  ...reference === void 0 ? {} : { metadata: reference },
                  result,
                  historical: archive !== void 0
                })
              );
              return;
            }
            const full = await state();
            const selected = full.runs.filter((r) => r.href === base);
            if (!selected.length) {
              send(response, 404, "text/plain; charset=utf-8", "not found\n");
              return;
            }
            send(
              response,
              200,
              "text/html; charset=utf-8",
              renderPage({ ...full, runs: selected, selected: true })
            );
            return;
          }
          send(response, 404, "text/plain; charset=utf-8", "not found\n");
        } catch {
          if (!response.headersSent)
            send(
              response,
              500,
              "text/plain; charset=utf-8",
              "the run store could not be read\n"
            );
          response.end();
        }
      })();
    }
  );
  const listening = await new Promise((resolve) => {
    server.once("error", (error) => resolve(error.message));
    server.listen(input.port ?? 0, RUN_SERVER_HOST, () => resolve(void 0));
  });
  if (listening !== void 0)
    return { ok: false, reason: oneLine(listening, 200) };
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolve) => server.close(() => resolve()));
    return { ok: false, reason: "the server bound no inspectable address" };
  }
  bound = { host: address.address, port: address.port };
  return {
    ok: true,
    server: {
      host: bound.host,
      port: bound.port,
      url: `http://${bound.host}:${bound.port}`,
      close: () => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
    }
  };
}

// packages/cli/src/commands/runs.ts
var USAGE3 = [
  "Usage: delivery-harness runs capabilities --json",
  "Usage: delivery-harness runs list",
  "       delivery-harness runs show <run-id> [--json]",
  "       delivery-harness runs view <run-id> [--json] [--record <repository-relative-path>]",
  "       delivery-harness runs export <run-id> --output <file>",
  "       delivery-harness runs archive <file> [--artifact <id>]",
  "       delivery-harness runs capture <run-id> --json <request>",
  "       delivery-harness runs artifact <run-id> <artifact-id> [--json]",
  "       delivery-harness runs serve [--repo <path>]... [--archive <file>]... [--port <n>] [--freshness-seconds <n>] [--record <repository-relative-path>]"
].join("\n");
var unresolvable = (reason) => ({
  kind: "blocked",
  blockers: [
    runSurfaceBlocker({
      code: "run_store_unresolvable",
      summary: "The run store could not be resolved.",
      details: oneLine(reason, 200),
      remediation: {
        id: "run-inside-a-repository",
        summary: "Run this command inside a git repository; the run store lives under its common directory."
      }
    })
  ]
});
var runsCommand = {
  name: "runs",
  sourceId: "delivery-harness.cli.runs",
  summary: "List, show, and serve the delivery runs this repository has recorded.",
  configFree: true,
  async run(context) {
    const [subcommand, ...rest] = context.args;
    if (subcommand === "capabilities") {
      if (rest.length !== 1 || rest[0] !== "--json") return { kind: "usage", message: "Usage: runs capabilities --json" };
      context.write(`${JSON.stringify({ spec: "run-capabilities/1", writerVersions: ["run-event/1", "run-event/2"], artifactCapture: true })}
`);
      return { kind: "ok" };
    }
    if (subcommand === "view") return runViewCommand(context, rest);
    if (subcommand === "export" || subcommand === "archive") return runArchiveCommand(context, subcommand, rest);
    if (subcommand === "capture" || subcommand === "artifact") return runArtifactCommand(context, subcommand, rest);
    if (subcommand === void 0) return { kind: "usage", message: `runs needs a subcommand.
${USAGE3}` };
    if (subcommand !== "list" && subcommand !== "show" && subcommand !== "serve") {
      return { kind: "usage", message: `Unknown runs subcommand ${oneLine(subcommand, 64)}.
${USAGE3}` };
    }
    if (subcommand === "show" && rest[0] === void 0) {
      return { kind: "usage", message: `runs show needs a run id.
${USAGE3}` };
    }
    if (subcommand === "show" && (rest.length > 2 || rest[1] !== void 0 && rest[1] !== "--json")) {
      return { kind: "usage", message: `runs show accepts only a run id and optional --json.
${USAGE3}` };
    }
    if (subcommand === "serve") return serveRuns(context, rest);
    const resolved = await resolveRunSurface(context.rootDir);
    if (!resolved.ok) return unresolvable(resolved.reason);
    return subcommand === "list" ? listRuns(resolved.surface, context) : showRun(resolved.surface, context, rest[0], rest[1] === "--json");
  }
};
async function sizeOf(runsDir, runId) {
  try {
    return (await stat(path12.join(runsDir, `${runId}.jsonl`))).size;
  } catch {
    return 0;
  }
}
async function listRuns(surface, context) {
  const runIds = await surface.store.list();
  const current = await surface.store.current(surface.worktreeKey);
  const currentRunId = current.ok ? current.runId : void 0;
  const lines = [`runs in ${oneLine(surface.runsDir, 400)}`, `  (${READOUT_LABELS})`];
  let total = 0;
  for (const runId of runIds) {
    const size = await sizeOf(surface.runsDir, runId);
    total += size;
    const read = await surface.store.read(runId);
    if (!read.ok) {
      lines.push(`  ${runId}  unreadable  ${size} bytes`);
      continue;
    }
    const evaluation = evaluateRunJournal4(read.events);
    const open2 = !read.events.some((event) => event.kind === "run.ended");
    lines.push(
      `  ${runId}  ${evaluation.status}  ${open2 ? "open" : "ended"}${runId === currentRunId ? " current" : ""}  ${size} bytes`
    );
  }
  lines.push(`total ${total} bytes across ${runIds.length} run(s)`);
  for (const line of lines) context.write(line);
  return { kind: "ok" };
}
async function showRun(surface, context, runId, json) {
  const read = await surface.store.read(runId);
  if (!read.ok) {
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_unresolvable",
          summary: "That run has no readable journal in this store.",
          details: `run ${oneLine(runId, 128)}: ${oneLine(read.rejections[0]?.message ?? "unreadable", 200)}`,
          remediation: { id: "list-the-runs", summary: "Run `delivery-harness runs list` to see the runs this repository holds." }
        })
      ]
    };
  }
  const events = read.events;
  if (json) {
    const worktreeRoot2 = await resolveWorktreeRoot(context.rootDir);
    const rootDir2 = worktreeRoot2.ok ? worktreeRoot2.root : context.rootDir;
    context.write(JSON.stringify(buildRunExport({
      runId,
      events,
      rootDir: rootDir2,
      refusedAppends: await surface.store.readNotes(runId)
    }), null, 2));
    return { kind: "ok" };
  }
  const open2 = !events.some((event) => event.kind === "run.ended");
  const current = await surface.store.current(surface.worktreeKey);
  const isCurrent = current.ok && current.runId === runId;
  context.write(`run ${runId}  ${open2 ? "open" : "ended"}${isCurrent ? "  current in this worktree" : ""}`);
  context.write("  events:");
  for (const event of events) {
    context.write(`    ${event.seq}  ${event.at}  ${event.kind.padEnd(20)}  ${event.actor.role.padEnd(8)}  ${detailOf(event)}`);
  }
  const rounds = roundRows(events);
  if (rounds.length > 0) {
    context.write("  rounds:");
    for (const row of rounds) context.write(`  ${row}`);
  }
  const decisions = events.filter((event) => event.kind === "decision.recorded");
  if (decisions.length > 0) {
    context.write("  decisions:");
    for (const decision of decisions) context.write(`    ${detailOf(decision)}`);
  }
  const notes = await surface.store.readNotes(runId);
  if (notes.length > 0) {
    context.write("  refused appends:");
    for (const entry of notes) {
      const note = typeof entry === "object" && entry !== null ? entry : {};
      context.write(
        `    ${oneLineOf(note["at"], 32)}  ${oneLineOf(note["kind"], 128)}  ${oneLineOf(note["code"], 64)}${note["pattern"] === void 0 ? "" : `  ${oneLineOf(note["pattern"], 64)}`}`
      );
    }
  }
  const worktreeRoot = await resolveWorktreeRoot(context.rootDir);
  const rootDir = worktreeRoot.ok ? worktreeRoot.root : context.rootDir;
  for (const row of readoutRows(events, evaluateRunJournal4(events), rootDir)) context.write(row);
  return { kind: "ok" };
}
var BROWSER_ELIDED_PORTS = [80, 443];
function parseServeArgs(args, rootDir) {
  const repos = [];
  const archives = [];
  let recordPath;
  let freshnessWindowMs;
  let port;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--repo" || token === "--port" || token === "--archive" || token === "--freshness-seconds" || token === "--record") {
      const value2 = args[index + 1];
      if (value2 === void 0) return { ok: false, message: `${token} needs a value.
${USAGE3}` };
      index += 1;
      if (token === "--record") {
        if (recordPath !== void 0) return { ok: false, message: "Use one explicit record path" };
        recordPath = value2;
        continue;
      }
      if (token === "--archive") {
        archives.push(path12.resolve(rootDir, value2));
        continue;
      }
      if (token === "--freshness-seconds") {
        if (!/^\d+$/.test(value2) || !Number.isSafeInteger(Number(value2)) || Number(value2) > 86400) return { ok: false, message: "freshness seconds must be between 0 and 86400" };
        freshnessWindowMs = Number(value2) * 1e3;
        continue;
      }
      if (token === "--repo") {
        repos.push(path12.resolve(rootDir, value2));
        continue;
      }
      if (!/^\d{1,5}$/.test(value2)) return { ok: false, message: `--port needs a port number.
${USAGE3}` };
      const parsed = Number(value2);
      if (parsed > 65535) return { ok: false, message: `--port needs a port number.
${USAGE3}` };
      if (BROWSER_ELIDED_PORTS.includes(parsed)) {
        return {
          ok: false,
          message: `--port ${parsed} cannot be served: a browser omits a scheme's default port from the Host header, and this page answers only to the exact host:port it bound.
${USAGE3}`
        };
      }
      port = parsed;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, message: `Unknown flag ${oneLine(token, 64)}.
${USAGE3}` };
    return { ok: false, message: `runs serve takes no positional arguments.
${USAGE3}` };
  }
  return { ok: true, args: { repos: repos.length === 0 && archives.length === 0 ? [rootDir] : repos, archives, ...recordPath === void 0 ? {} : { recordPath }, ...freshnessWindowMs === void 0 ? {} : { freshnessWindowMs }, ...port === void 0 ? {} : { port } } };
}
async function serveRuns(context, args) {
  const parsed = parseServeArgs(args, context.rootDir);
  if (!parsed.ok) return { kind: "usage", message: parsed.message };
  let archives;
  try {
    archives = await Promise.all(parsed.args.archives.map(async (file) => ({ label: path12.basename(file), text: await readArchiveFile(file) })));
  } catch {
    return unresolvable("An explicitly selected archive could not be read within its size limit.");
  }
  const started = await startRunServer({ repos: parsed.args.repos, archives, ...parsed.args.recordPath === void 0 ? {} : { recordPath: parsed.args.recordPath }, ...parsed.args.freshnessWindowMs === void 0 ? {} : { freshnessWindowMs: parsed.args.freshnessWindowMs }, ...parsed.args.port === void 0 ? {} : { port: parsed.args.port } });
  if (!started.ok) return unresolvable(started.reason);
  const server = started.server;
  context.write(`serving ${parsed.args.repos.length} repository path(s) at ${server.url}`);
  context.write(`  (${READOUT_LABELS})`);
  try {
    await untilSignalled(context.signal);
  } finally {
    await server.close();
  }
  return { kind: "ok" };
}
function untilSignalled(signal) {
  if (signal === void 0) return new Promise(() => {
  });
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

// packages/cli/src/commands/submit-evidence.ts
import { submitManifest as submitManifest3 } from "./kernel.mjs";
function manifestPathFrom(args) {
  const flagIndex = args.indexOf("--manifest");
  if (flagIndex !== -1) return args[flagIndex + 1];
  const positional = args.find((argument) => !argument.startsWith("-"));
  return positional;
}
var submitEvidenceCommand = {
  name: "submit-evidence",
  sourceId: "delivery-harness.cli.submit-evidence",
  summary: "Validate a provider manifest and publish its evidence records.",
  async run(context) {
    const manifestPath = manifestPathFrom(context.args);
    if (manifestPath === void 0 || manifestPath === "") {
      return { kind: "usage", message: "submit-evidence requires --manifest <path>." };
    }
    const wiring = await context.wire();
    const outcome2 = await submitManifest3(
      { rootDir: context.rootDir, manifestPath, config: context.config },
      { captureCandidate: wiring.captureCandidate, artifacts: context.artifacts, ...wiring.storageOptions }
    );
    if (outcome2.status === "accepted") {
      const lines = outcome2.records.map(
        (record3) => `  ${record3.obligationId}: ${record3.status} ${record3.recordId}`
      );
      return {
        kind: "ok",
        summary: [`accepted (manifestDigest ${outcome2.manifestDigest}):`, ...lines].join("\n")
      };
    }
    return { kind: "blocked", blockers: [...outcome2.blockers] };
  }
};

// packages/cli/src/commands/verify.ts
import { readFile as readFile5 } from "node:fs/promises";
import path13 from "node:path";
import {
  MAX_RUN_PROVIDER_ID,
  RUN_PROVIDER_ID,
  deliveryRecordPathFor as deliveryRecordPathFor2,
  needsCommittedSymlinkTarget,
  parseCandidateTreeListing,
  parseDeliveryRecord as parseDeliveryRecord2,
  runGitCommand,
  verifyDeliveryRecord as verifyDeliveryRecord2,
  capturePortableVerificationInputs as capturePortableVerificationInputs2,
  collectLiveProviderResults
} from "./kernel.mjs";
var USAGE4 = "Usage: delivery-harness verify [--require-run-journal] [--mandated-lens <id>]...";
function parseArgs2(args) {
  let requireRunJournal = false;
  const mandatedLensIds = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--require-run-journal") {
      requireRunJournal = true;
      continue;
    }
    if (token === "--mandated-lens") {
      const value2 = args[index + 1];
      if (value2 === void 0) return { ok: false, message: `${token} needs a value.
${USAGE4}` };
      if (value2.length > MAX_RUN_PROVIDER_ID || !RUN_PROVIDER_ID.test(value2)) {
        return { ok: false, message: `${token} takes a bounded lens id, not ${oneLine(value2, 64)}.
${USAGE4}` };
      }
      mandatedLensIds.push(value2);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { ok: false, message: `Unknown flag ${oneLine(token, 64)}.
${USAGE4}` };
    return { ok: false, message: `verify takes no positional arguments, and ${oneLine(token, 64)} is one.
${USAGE4}` };
  }
  return { ok: true, args: { requireRunJournal, mandatedLensIds } };
}
function runJournalBlocker(row) {
  const missing = row.missing.length === 0 ? "(none)" : row.missing.join(", ");
  const violations = row.violations === void 0 || row.violations.length === 0 ? "(none)" : row.violations.join(", ");
  return commandBlocker({
    code: "run_journal_incomplete",
    sourceId: "delivery-harness.cli.verify",
    summary: "The run journal for this candidate is not complete, and --require-run-journal was given.",
    details: `status ${row.status}${row.runId === void 0 ? "" : ` (run ${oneLine(row.runId, 128)})`}; missing: ${missing}; violations: ${violations}`,
    remediations: [
      {
        id: "emit-the-missing-run-events",
        kind: "manual_action",
        summary: "Emit the run events this delivery did not journal, or drop --require-run-journal: the row is observability, not evidence."
      }
    ]
  });
}
var verifyCommand = {
  name: "verify",
  sourceId: "delivery-harness.cli.verify",
  summary: "Verify the tracked delivery record against the current candidate.",
  async run(context) {
    const parsedArgs = parseArgs2(context.args);
    if (!parsedArgs.ok) return { kind: "usage", message: parsedArgs.message };
    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    if (!capture.ok) {
      return { kind: "blocked", blockers: [...capture.blockers] };
    }
    const identity = {
      deliverableDigest: capture.candidate.deliverable.digest,
      identityToken: capture.candidate.deliverable.identity
    };
    const base = {
      ref: capture.candidate.base.ref,
      tipSha: capture.candidate.base.tipSha,
      mergeBaseSha: capture.candidate.base.mergeBaseSha
    };
    const relativePath = deliveryRecordPathFor2(context.config, identity.deliverableDigest);
    const absolutePath = path13.join(context.rootDir, relativePath);
    let text2;
    try {
      text2 = await readFile5(absolutePath, "utf8");
    } catch {
      return {
        kind: "blocked",
        blockers: [
          commandBlocker({
            code: "delivery_record_missing",
            sourceId: "delivery-harness.cli.verify",
            summary: "No delivery record describes the current candidate.",
            details: `expected ${relativePath}`,
            remediations: [
              {
                id: "run-record",
                kind: "command",
                command: ["delivery-harness", "record"],
                summary: "Record the admitted gate for this candidate."
              }
            ]
          })
        ]
      };
    }
    const parsed = parseDeliveryRecord2(text2);
    if (!parsed.ok) {
      return { kind: "blocked", blockers: [...parsed.blockers] };
    }
    const listing = await runGitCommand(["git", "ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
      cwd: context.rootDir
    });
    const candidateTreePaths = [];
    if (listing.exitCode === 0) {
      for (const entry of parseCandidateTreeListing(listing.stdout)) {
        if (!needsCommittedSymlinkTarget(entry)) {
          candidateTreePaths.push(entry);
          continue;
        }
        const blob = await runGitCommand(["git", "cat-file", "blob", entry.objectSha], { cwd: context.rootDir });
        candidateTreePaths.push(blob.exitCode === 0 ? { ...entry, symlinkTarget: blob.stdout } : entry);
      }
    }
    const runJournal = await resolveRunJournalRow({
      cwd: context.rootDir,
      treeSha: parsed.record.candidateBinding.treeSha,
      ...parsedArgs.args.mandatedLensIds.length === 0 ? {} : { mandatedLensIds: parsedArgs.args.mandatedLensIds }
    });
    const inputs = await capturePortableVerificationInputs2(context.rootDir, context.config, capture.candidate, parsed.record);
    const live = await collectLiveProviderResults({
      rootDir: context.rootDir,
      config: context.config,
      candidate: capture.candidate,
      projection: inputs.projection,
      evidenceContext: inputs.evidenceContext,
      env: context.env,
      ...context.signal === void 0 ? {} : { signal: context.signal }
    });
    const check = verifyDeliveryRecord2(context.config, parsed.record, identity, base, { candidateTreePaths, runJournal, ...inputs, liveResults: live.liveResults, executionContext: context.classifyContext() });
    if (!check.ok) {
      return { kind: "blocked", blockers: [...live.blockers, ...check.blockers] };
    }
    if (parsedArgs.args.requireRunJournal && runJournal.status !== "complete") {
      return { kind: "blocked", blockers: [runJournalBlocker(runJournal)] };
    }
    const relaxation = check.baseMovementRelaxed ? ` (base movement relaxed by policy: ${check.relaxedDriftClasses.join(", ")})` : "";
    return {
      kind: "ok",
      summary: [
        `verified ${relativePath}${relaxation}; attestation: ${check.attestationLabel}`,
        ...runJournalRows(runJournal)
      ].join("\n")
    };
  }
};

// packages/cli/src/ordinary-context.ts
import { readFile as readFile6 } from "node:fs/promises";
import path14 from "node:path";
import { HARNESS_VERSION, digestCanonical as digestCanonical4 } from "./kernel.mjs";
function recoveryBlocker(code, summary) {
  return commandBlocker({
    code,
    sourceId: "delivery-harness.cli.resume",
    summary,
    remediations: [{ id: "reconcile-delivery-context", kind: "manual_action", summary: "Inspect the saved context and actual workspace/external state with host tools; rerun preparation and gates where evidence is not current. Never replay an uncertain action automatically." }]
  });
}
async function recoveryRun(rootDir, named) {
  const resolved = await resolveRunSurface(rootDir);
  if (!resolved.ok) return { ok: false, blocker: recoveryBlocker("resume_context_invalid", "The repository run store cannot be read.") };
  const current = await resolved.surface.store.current(resolved.surface.worktreeKey);
  const runId = named ?? (current.ok ? current.runId : void 0);
  if (!runId) return { ok: false, blocker: recoveryBlocker("resume_context_missing", "No current delivery run was found; start a run or name its existing id with --run.") };
  const read = await resolved.surface.store.read(runId);
  if (!read.ok) return { ok: false, blocker: recoveryBlocker("resume_context_invalid", "The delivery journal is missing, corrupt, or inaccessible.") };
  return { ok: true, surface: resolved.surface, runId, events: read.events };
}
async function installedRelease(rootDir) {
  const document = JSON.parse(await readFile6(path14.join(rootDir, ".agent-skills/active.json"), "utf8"));
  const release = document?.release;
  if (!release || typeof release.releaseId !== "string" || typeof release.profile !== "string" || typeof release.archiveSha256 !== "string" || !/^[0-9a-f]{64}$/.test(release.archiveSha256)) {
    throw new Error("Installed workflow release identity is missing or malformed.");
  }
  return { runtimeVersion: HARNESS_VERSION, releaseId: release.releaseId, profile: release.profile, archiveSha256: release.archiveSha256 };
}
var policyDigest = (context) => digestCanonical4({ config: context.config, policyBinding: context.policyBinding ?? null });
function reconciliationActions(events) {
  const actions = /* @__PURE__ */ new Map();
  for (const event of events) {
    const p = event.payload;
    if (event.kind === "action.intent") {
      const actionId = p["actionId"];
      const prior = actions.get(actionId);
      actions.set(actionId, { actionId, operation: p["operation"], reference: p["reference"], outcome: "unknown", ...prior ? { inconsistent: true } : {} });
    } else if (event.kind === "action.observed") {
      const actionId = p["actionId"];
      const prior = actions.get(actionId);
      actions.set(actionId, {
        ...prior,
        actionId,
        reference: p["reference"],
        outcome: p["outcome"],
        ...!prior || prior.inconsistent || prior.outcome !== "unknown" && prior.outcome !== p["outcome"] ? { inconsistent: true } : {}
      });
    }
  }
  return [...actions.values()];
}

// packages/cli/src/commands/save-context.ts
var saveContextCommand = {
  name: "save-context",
  sourceId: "delivery-harness.cli.save-context",
  summary: "Save a bounded delivery contract and stage observation in the current run.",
  async run(context) {
    if (context.args.length !== 2 || context.args[0] !== "--json") return { kind: "usage", message: `Usage: delivery-harness save-context --json '{"contract":{"objective":"...","acceptanceCriteria":["..."],"finishLine":"merge-ready"},"stage":"work"}'` };
    let input;
    try {
      const value2 = JSON.parse(context.args[1]);
      if (!value2 || typeof value2 !== "object" || Array.isArray(value2) || Object.keys(value2).some((key) => key !== "contract" && key !== "stage")) throw new Error();
      input = value2;
    } catch {
      return { kind: "usage", message: "Context must be a JSON object with only contract and stage." };
    }
    const run = await recoveryRun(context.rootDir);
    if (!run.ok) return { kind: "blocked", blockers: [run.blocker] };
    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    if (!capture.ok) return { kind: "blocked", blockers: capture.blockers };
    let release;
    try {
      release = await installedRelease(context.rootDir);
    } catch {
      return { kind: "blocked", blockers: [recoveryBlocker("resume_release_unreadable", "The installed workflow release identity cannot be read; restore a valid installation before saving context.")] };
    }
    const candidate = capture.candidate;
    const payload = {
      spec: "ordinary-run-context/1",
      contract: input.contract,
      stage: input.stage,
      candidateTreeSha: candidate.treeSha,
      candidateBinding: {
        deliverableDigest: candidate.deliverable.digest,
        identity: candidate.deliverable.identity,
        baseRef: candidate.base.ref,
        baseTipSha: candidate.base.tipSha,
        mergeBaseSha: candidate.base.mergeBaseSha,
        workspaceId: candidate.workspaceId
      },
      policyDigest: policyDigest(context),
      release
    };
    const appended = await run.surface.store.append(run.runId, buildRunEvent({ runId: run.runId, commonDir: run.surface.commonDir, kind: "context.saved", role: "executor", payload }));
    if (!appended.ok) return { kind: "blocked", blockers: [recoveryBlocker("resume_context_invalid", "Context was refused by the bounded run-event contract; inspect contract, stage, and secret-free inputs.")] };
    return { kind: "ok", summary: `saved ordinary context for ${run.runId}; stage is an observation, not evidence` };
  }
};

// packages/cli/src/commands/resume.ts
import { classifyCandidateDrift as classifyCandidateDrift3, digestCanonical as digestCanonical5, evaluatePreparationReceipt as evaluatePreparationReceipt4, runAdmission as runAdmission2 } from "./kernel.mjs";
var resumeCommand = {
  name: "resume",
  sourceId: "delivery-harness.cli.resume",
  summary: "Read saved ordinary context and recheck evidence without executing or replaying work.",
  async run(context) {
    if (context.args.length !== 0 && (context.args.length !== 2 || context.args[0] !== "--run")) return { kind: "usage", message: "Usage: delivery-harness resume [--run <run-id>]" };
    const run = await recoveryRun(context.rootDir, context.args[1]);
    if (!run.ok) return { kind: "blocked", blockers: [run.blocker] };
    const saved = [...run.events].reverse().find((event) => event.kind === "context.saved");
    if (!saved) return { kind: "blocked", blockers: [recoveryBlocker("resume_context_missing", "This run has no saved ordinary context. Recover the contract from its work item and save it explicitly.")] };
    const p = saved.payload;
    const actions = reconciliationActions(run.events);
    const blockers = actions.some((action) => action.outcome === "unknown" || action.inconsistent) ? [recoveryBlocker("resume_action_unreconciled", "An external action has no consistent observed outcome. Reconcile its reference with host tools before any repeat.")] : [];
    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    const drift = [];
    if (p["policyDigest"] !== policyDigest(context)) drift.push("policy_changed");
    try {
      if (digestCanonical5(p["release"]) !== digestCanonical5(await installedRelease(context.rootDir))) drift.push("release_changed");
    } catch {
      drift.push("release_unreadable");
    }
    if (capture.ok) {
      const binding = p["candidateBinding"];
      const expected = {
        treeSha: saved.candidateTreeSha,
        deliverable: { digest: binding["deliverableDigest"], identity: binding["identity"] },
        base: { ref: binding["baseRef"], tipSha: binding["baseTipSha"], mergeBaseSha: binding["mergeBaseSha"] },
        workspaceId: binding["workspaceId"]
      };
      drift.push(...classifyCandidateDrift3(expected, capture.candidate));
      if (expected.deliverable.identity !== capture.candidate.deliverable.identity) drift.push("identity_changed");
      if (expected.base.ref !== capture.candidate.base.ref) drift.push("base_ref_changed");
    } else blockers.push(...capture.blockers);
    const preparation = capture.ok ? await evaluatePreparationReceipt4(context.rootDir, { config: context.config, candidate: capture.candidate }, wiring.storageOptions) : void 0;
    const admission = capture.ok ? await runAdmission2(
      { rootDir: context.rootDir, config: context.config, context: context.classifyContext() },
      { captureCandidate: wiring.captureCandidate, projectActivation: wiring.projectActivation, ...wiring.storageOptions }
    ) : void 0;
    if (capture.ok && admission?.candidate && classifyCandidateDrift3(capture.candidate, admission.candidate).length > 0) drift.push("candidate_observation_changed");
    try {
      if (digestCanonical5(p["release"]) !== digestCanonical5(await installedRelease(context.rootDir)) && !drift.includes("release_changed")) drift.push("release_changed");
    } catch {
      if (!drift.includes("release_unreadable")) drift.push("release_unreadable");
    }
    if (admission) blockers.push(...admission.blockers);
    if (drift.some((item2) => item2 !== "raw_tree_changed")) blockers.push(recoveryBlocker("resume_context_stale", "Saved candidate, policy, or release bindings changed; revalidate the contract and affected work before saving fresh context."));
    const reuseAllowed = blockers.length === 0 && admission?.admitted === true;
    context.write(JSON.stringify({
      spec: "ordinary-resume/1",
      runId: run.runId,
      observationOnly: true,
      automaticReplay: false,
      savedContext: p,
      actions,
      drift,
      preparation: preparation ?? { prepared: false },
      admission: admission ?? { admitted: false },
      reuseAllowed
    }));
    return blockers.length > 0 ? { kind: "blocked", blockers } : { kind: "ok" };
  }
};

// packages/cli/src/index.ts
var COMMANDS = [
  prepareCommand,
  reviewContextCommand,
  emitReviewEvidenceCommand,
  submitEvidenceCommand,
  gateCommand,
  recordCommand,
  verifyCommand,
  checkCommand,
  managedCommand,
  maintainCommand,
  emitCommand,
  runsCommand,
  saveContextCommand,
  resumeCommand
];
function runCli(argv, runtime) {
  return runCliBoundary(argv, COMMANDS, runtime);
}

// packages/cli/src/main.ts
function createWaiverPrompt(input, output) {
  return (decision, obligationIds) => new Promise((resolve, reject) => {
    const rl = createInterface({ input, output });
    let settled = false;
    const settle = (action) => {
      if (settled) return;
      settled = true;
      action();
    };
    rl.on("SIGINT", () => {
      settle(() => {
        rl.close();
        reject(new CliInterruption("Waiver prompt interrupted."));
      });
    });
    rl.on("close", () => {
      settle(() => resolve(false));
    });
    output.write(`Waiving covers ${obligationIds.length} obligation(s): ${obligationIds.join(", ")}.
`);
    output.write(`Candidate: ${decision.candidate.treeSha}. Approval covers only these findings under the current policy; live obligations require new approval each invocation.
`);
    for (const resolution of decision.resolutions) {
      if (resolution.kind === "blocked" && obligationIds.includes(resolution.obligationId)) {
        for (const blocker of resolution.blockers) output.write(`${resolution.obligationId}: [${blocker.code}] ${blocker.summary}
`);
      }
    }
    const finish = (value2) => settle(() => {
      rl.close();
      resolve(value2);
    });
    rl.question("Waive all of them? [y/N] ", (answer) => {
      if (!/^\s*y(es)?\s*$/i.test(answer)) return finish(false);
      rl.question("Author: ", (author) => {
        if (!author.trim() || author.length > 256) return finish(false);
        rl.question("Reason: ", (reason) => {
          if (!reason.trim() || reason.length > 4096) return finish(false);
          finish({ author: author.trim(), reason: reason.trim() });
        });
      });
    });
  });
}
var readlineWaiverPrompt = (decision, obligationIds) => createWaiverPrompt(process.stdin, process.stderr)(decision, obligationIds);
function canonicalEntryPath(entryPath) {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}
function invokedDirectly(argvEntry, moduleHref) {
  if (argvEntry === void 0) return false;
  let modulePath;
  try {
    modulePath = fileURLToPath(moduleHref);
  } catch {
    return false;
  }
  return canonicalEntryPath(argvEntry) === canonicalEntryPath(modulePath);
}
function readStdinText(input) {
  if (input.isTTY === true) return Promise.resolve("");
  return new Promise((resolve) => {
    let text2 = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      text2 += chunk;
    });
    input.once("error", () => resolve(text2));
    input.once("end", () => resolve(text2));
  });
}
function defaultRuntime() {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdout: (text2) => process.stdout.write(text2),
    stderr: (text2) => process.stderr.write(text2),
    promptForWaiver: readlineWaiverPrompt,
    readStdin: () => readStdinText(process.stdin)
  };
}
async function main(argv) {
  return runCli(argv, defaultRuntime());
}
if (invokedDirectly(process.argv[1], import.meta.url)) {
  process.exitCode = EXIT_POLICY;
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}
`);
    process.exitCode = EXIT_POLICY;
  });
}
export {
  createWaiverPrompt,
  defaultRuntime,
  invokedDirectly,
  main,
  readStdinText,
  readlineWaiverPrompt
};
