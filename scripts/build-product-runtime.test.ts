import { execFile, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildProductRuntime } from "./build-product-runtime.ts";

/**
 * WHY THESE ROWS CARRY EXPLICIT BUDGETS.
 *
 * Every row here drives the bundled runtime as an adopter does: as subprocesses
 * that boot node and load `cli.mjs` from bytes. The scoped row alone makes 45
 * such executions across three disposable repositories, and on untouched
 * `origin/main` it failed by exhausting its own 180 000 ms bound rather than by
 * any assertion (V26-2084). The bound was set when the qualification drove
 * fewer probes and was not restated when V26-2067 added more.
 *
 * What the row spends is process start, not work, and process start here is not
 * a stable quantity. Five consecutive `cli.mjs --help` executions on this host,
 * inside one minute, cost 125, 1516, 8560, 151 and 120 ms: macOS serializes
 * exec on a loaded machine, so the same command is two orders of magnitude
 * apart depending on what else is running. Forty-five executions against that
 * distribution is what these budgets have to survive.
 *
 * That also means no number here is sized from a duration. A run of the whole
 * qualification alongside a delivery wave came to 206.9 s, but
 * `docs/solutions/a-test-timeout-that-is-the-checkout-not-the-diff-2026-09-14.md`
 * is explicit that a duration measured under concurrent load is not a
 * measurement, and it is not used as one. Each budget below is a CEILING set
 * well clear of any cost observed either way: no row asserts how long it took,
 * and a row that exceeds its ceiling is reporting something that stopped rather
 * than a busy machine.
 */

/** One esbuild pass over four entry points plus two rollup declaration passes. */
const RUNTIME_BUILD_TIMEOUT_MS = 120_000;

/** Four bundled executions plus a `tsc --noEmit` over the shipped declarations. */
const CONSUMER_ROW_TIMEOUT_MS = 180_000;

/** Eight bundled executions plus the git plumbing of a disposable consumer. */
const ADMISSION_ROW_TIMEOUT_MS = 240_000;

/**
 * The executions `runScopedRuntimeQualification` made when this budget was
 * measured. The row asserts the actual count against it, so a probe added to
 * the qualification trips a named assertion here instead of a bare timeout —
 * which is exactly how the 180 s bound went stale.
 */
const BUDGETED_BUNDLED_COMMANDS = 45;

/**
 * Forty-five executions, each of which has been observed at 8.5 s, plus the
 * three repositories' git plumbing, with room left for the whole suite running
 * at four workers. Fifteen minutes is far above anything this row has cost and
 * still short enough to fail a genuine hang inside one delivery.
 */
const SCOPED_ROW_TIMEOUT_MS = 900_000;

/** A bare `node -e 0` on a quiet host here is 40-150 ms. */
const NOMINAL_EXEC_MS = 250;

/** One exec this far above nominal did not queue behind work; the host stalled it. */
const DEGRADED_EXEC_FACTOR = 10;

/** How often the sampler times a bare start while the qualification runs. */
const EXEC_SAMPLE_INTERVAL_MS = 10_000;

/**
 * Attribute a scoped-qualification failure to the host or to the candidate.
 *
 * The qualification refuses with the command it expected — `gate expected exit
 * 0`, or `runtime command timed out: gate` — and both read as a product defect
 * whatever actually went wrong. On a host whose exec path has stalled, the same
 * messages mean a check crossed its own `timeoutMs` waiting to *start*.
 *
 * The discriminator is the SLOWEST start sampled WHILE THE ROW RAN, not a
 * sample taken afterwards. The first version of this function sampled on the
 * way out of the catch and reported `candidate` for a failure that a 70-second
 * exec stall had caused, because by then the host had recovered and the median
 * was 67 ms. A stall is transient and it is the outlier that records it, so the
 * sampler runs alongside the qualification and the verdict reads its maximum.
 *
 * An unattributable failure stays with the candidate. A product that genuinely
 * hangs on a healthy host reports `candidate`, which is correct: this names the
 * environment only when the environment was measurably stalled, and never
 * launders a real defect.
 */
export function attributeScopedQualificationFailure(observation: {
  readonly failure: string;
  readonly execSampleMs: readonly number[];
}): { readonly attribution: "environment" | "candidate"; readonly message: string } {
  const slowest = observation.execSampleMs.length === 0 ? undefined : Math.max(...observation.execSampleMs);
  if (slowest !== undefined && slowest > NOMINAL_EXEC_MS * DEGRADED_EXEC_FACTOR) {
    return {
      attribution: "environment",
      message: `environment: while this row's ${BUDGETED_BUNDLED_COMMANDS} executions ran, a bare start on this host took ${slowest} ms against a nominal ${NOMINAL_EXEC_MS} ms; the qualification reported: ${observation.failure}`,
    };
  }
  const observed = slowest === undefined ? "unsampled" : `${slowest} ms`;
  return {
    attribution: "candidate",
    message: `candidate: the slowest start sampled while this row ran was ${observed} against a nominal ${NOMINAL_EXEC_MS} ms, so the host did not stall it; the qualification reported: ${observation.failure}`,
  };
}

/**
 * Times bare node starts until stopped.
 *
 * A start is the cost every bundled execution pays before it runs a line, so
 * this measures the same scarce resource the row spends without competing for
 * it: one start per interval against the row's own forty-five.
 */
function startExecSampler(intervalMs: number): { stop: () => number[] } {
  const samples: number[] = [];
  let sampling = true;
  void (async () => {
    while (sampling) {
      const started = Date.now();
      try { execFileSync(process.execPath, ["-e", "0"], { stdio: ["ignore", "ignore", "ignore"] }); }
      catch { /* a host that refuses to start a process is itself the observation */ }
      samples.push(Date.now() - started);
      await new Promise((resolve) => { setTimeout(resolve, intervalMs).unref(); });
    }
  })();
  return { stop: () => { sampling = false; return samples; } };
}

/**
 * One build for the file.
 *
 * Every row used to rebuild the runtime, which is the same bytes three times
 * over. The build is still exercised for real — this is its only producer — and
 * each row takes a copy, because the scoped row corrupts the bytes it runs to
 * prove the checksum refusal.
 */
let shared: string;
let sharedRuntime: string;

beforeAll(async () => {
  shared = await mkdtemp(path.join(os.tmpdir(), "product-runtime-shared-"));
  const manifest = path.join(shared, "workflow.json");
  await writeFile(manifest, JSON.stringify({ schemaVersion: "agent-skills-release/1", contentSha256: "a".repeat(64) }));
  sharedRuntime = path.join(shared, "runtime");
  await buildProductRuntime(process.cwd(), manifest, sharedRuntime);
}, RUNTIME_BUILD_TIMEOUT_MS);

afterAll(async () => { await rm(shared, { recursive: true, force: true }); });

/** The runtime is position-independent: `runtime.json` pins bytes, and the loader resolves relatively. */
const installRuntime = async (destination: string): Promise<string> => {
  await cp(sharedRuntime, destination, { recursive: true });
  return destination;
};

it("runs bundled CLI and a typed consumer config without installed packages", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-"));
  try {
    const runtime = await installRuntime(path.join(temporary, "runtime"));
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: temporary });
    await writeFile(path.join(temporary, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(temporary, "harness.config.ts"), (await readFile("harness.config.ts", "utf8")).replace("delivery-harness.pr-admission", "artifact-consumer"));
    const args = ["--experimental-strip-types", "--import", path.join(runtime, "bootstrap.mjs"), path.join(runtime, "cli.mjs")];
    const help = await run(process.execPath, [...args, "--help"], { cwd: temporary, env: { ...process.env, NODE_PATH: "" } });
    expect(help.stdout).toContain("submit-evidence");
    const check = await run(process.execPath, [...args, "check"], { cwd: temporary, env: { ...process.env, NODE_PATH: "" } });
    expect(check.stdout).toContain("artifact-consumer");
    expect(check.stdout).toContain("delivery/records/record--<deliverableDigest>.json");
    expect(check.stdout).toContain("base movement stale: verification refuses");
    await writeFile(path.join(temporary, "consumer.ts"), `
      import { parseDeliveryRecord, captureGitCandidate, digestDeliverableEntries } from "./runtime/kernel.mjs";
      import { runCli, buildRunExport, parseRunExport, type DeliveryRunExport, type RunExportParseResult, type CliRuntime } from "./runtime/cli-api.mjs";
      export const inspect = (text: string) => parseDeliveryRecord(text);
      export const check = (runtime: CliRuntime) => runCli(["check"], runtime);
      export const parse = (value: DeliveryRunExport): RunExportParseResult => parseRunExport(JSON.stringify(value));
      void buildRunExport;
      void captureGitCandidate; void digestDeliverableEntries;
      // @ts-expect-error The shipped parser must retain its actual typed input.
      parseDeliveryRecord(42);
    `);
    await run(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "NodeNext", "--types", "node", "--typeRoots", path.resolve("node_modules/@types"), "consumer.ts"], { cwd: temporary });
    const parsed = await run(process.execPath, ["--input-type=module", "-e", 'import { buildRunExport, parseRunExport } from "./runtime/cli-api.mjs"; const value = buildRunExport({ runId: "run-1234567890abcdef", events: [] }); if (!parseRunExport(JSON.stringify(value)).ok || parseRunExport("{}").ok) process.exit(1);'], { cwd: temporary, env: { ...process.env, NODE_PATH: "" } });
    expect(parsed.stderr).toBe("");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, CONSUMER_ROW_TIMEOUT_MS);

it("runs composite admission from bundled runtime bytes in a disposable consumer", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-admit-"));
  try {
    const runtime = await installRuntime(path.join(temporary, "installed-runtime"));

    const consumer = path.join(temporary, "consumer");
    await mkdir(consumer);
    const run = promisify(execFile);
    await run("git", ["init", "-q", "-b", "main"], { cwd: consumer });
    await run("git", ["config", "user.name", "Artifact sensor"], { cwd: consumer });
    await run("git", ["config", "user.email", "artifact-sensor@example.invalid"], { cwd: consumer });
    await writeFile(path.join(consumer, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(consumer, "harness.config.ts"), `
      import { defineHarnessConfig } from "@agent-delivery-harness/kernel";
      export default defineHarnessConfig({
        gateId: "artifact.admit",
        baseRef: "origin/main",
        storageNamespace: "delivery-harness/",
        acceptedEnvelopeSpecs: ["delivery-evidence/1"],
        identityVersions: ["deliverable-tree/v1"],
        computingIdentityVersion: "deliverable-tree/v1",
        reviewNeutral: [{ prefix: "docs/reports/" }, { prefix: "docs/solutions/" }, { prefix: "telemetry/delivery-runs/" }],
        recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
        pathClassification: { generated: [], test: [{ kind: "glob", value: "**/*.test.ts" }], lockfile: [] },
        sensitivePaths: [],
        activationThreshold: 1,
        providers: [{ id: "fixture.review", findingCodes: [] }],
        agentEnvSignals: [],
        ciPolicies: [],
        ciPolicyEnvKey: "DH_CI_POLICY",
        preparationWiringPaths: ["harness.config.ts"],
        obligations: [{
          id: "review.green",
          activation: { kind: "relevant_change" },
          freshness: "exact_candidate",
          providers: ["fixture.review"],
          acceptedPayloadSpecs: ["review.green/1"],
          allowedResolutionKinds: ["satisfied_evidence", "waived", "not_applicable"],
          humanWaiverAllowed: true,
          minimumAttestationLevel: "self",
          ciDelegationPolicyIds: [],
          remediation: { default: [{ id: "review", kind: "manual_action", summary: "Obtain review." }] },
          waivableCodes: ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings"],
          nonWaivableCodes: ["ambiguous_records", "malformed_record", "unknown_provider", "live_provider_missing", "ambiguous_live_provider", "live_provider_failed", "resolution_not_allowed"],
        }],
        deliveryRecordPath: "telemetry/delivery-runs/record.json",
        deliveryRecordVerification: { baseMovement: "stale" },
      });
    `);
    await mkdir(path.join(consumer, ".agent-skills"), { recursive: true });
    await mkdir(path.join(consumer, ".agents"), { recursive: true });
    await cp(await realpath(".agent-skills/current"), path.join(consumer, ".agent-skills/current"), { recursive: true });
    await cp(".agent-skills/active.json", path.join(consumer, ".agent-skills/active.json"));
    await cp(".agents/policy", path.join(consumer, ".agents/policy"), { recursive: true });
    await run("git", ["add", "."], { cwd: consumer });
    await run("git", ["commit", "-qm", "consumer base"], { cwd: consumer });
    await run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: consumer });
    await writeFile(path.join(consumer, "change.txt"), "candidate\n");
    await run("git", ["add", "change.txt"], { cwd: consumer });
    await run("git", ["commit", "-qm", "candidate"], { cwd: consumer });

    // This is an executable qualification fixture for the emitter path. It is
    // not a claim that an independent reviewer inspected this disposable repo.
    const args = ["--experimental-strip-types", "--import", path.join(runtime, "bootstrap.mjs"), path.join(runtime, "cli.mjs")];
    const environment = { ...process.env, NODE_PATH: "" };
    const prepared = await run(process.execPath, [...args, "prepare"], { cwd: consumer, env: environment });
    expect(prepared.stdout).toContain("prepared artifact.admit");
    const context = await run(process.execPath, [...args, "review-context", "--json"], { cwd: consumer, env: environment });
    const reviewed = JSON.parse(context.stdout) as { digest: string; binding: { charters: Array<{ reviewerId: string }> } };
    const outcomePath = path.join(temporary, "outcome.json");
    const outcome = {
      spec: "review-outcome/1",
      contextDigest: reviewed.digest,
      verdict: "green",
      reviewers: reviewed.binding.charters.map((charter) => ({ id: charter.reviewerId, result: "approved" })),
      findings: [],
    };
    await writeFile(outcomePath, `${JSON.stringify(outcome)}\n`);
    const admitted = await run(process.execPath, [...args, "admit", "--outcome", outcomePath], { cwd: consumer, env: environment });
    expect(admitted.stdout).toContain("gate: admitted");
    expect(admitted.stdout).toContain("recorded telemetry/delivery-runs/record--");
    const records = (await readdir(path.join(consumer, "telemetry/delivery-runs"))).filter((name) => name.startsWith("record--"));
    expect(records).toHaveLength(1);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, ADMISSION_ROW_TIMEOUT_MS);

it("names the environment when a start stalled while the scoped qualification ran", () => {
  const failure = "gate expected exit 0";

  // One stalled start among healthy ones is the whole signal: the row that
  // produced this note failed after a single 70-second stall, on a host whose
  // median was 67 ms by the time anything asked.
  const stalled = attributeScopedQualificationFailure({ failure, execSampleMs: [40, 55, 60, 120, 9000] });
  expect(stalled.attribution).toBe("environment");
  expect(stalled.message).toContain("9000 ms");
  expect(stalled.message).toContain(failure);

  // The deny side: a host that never stalled leaves the failure with the
  // candidate, however slow the row itself was.
  const healthy = attributeScopedQualificationFailure({ failure: "runtime command timed out: gate", execSampleMs: [40, 55, 60, 120, 2500] });
  expect(healthy.attribution).toBe("candidate");
  expect(healthy.message).toContain("2500 ms");
  expect(healthy.message).toContain("runtime command timed out: gate");

  // An absent sample cannot attribute a failure away from the candidate.
  const unsampled = attributeScopedQualificationFailure({ failure, execSampleMs: [] });
  expect(unsampled.attribution).toBe("candidate");
  expect(unsampled.message).toContain("unsampled");
  expect(unsampled.message).toContain(failure);
});

it("qualifies scoped execution through the actual bundled runtime", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "product-runtime-scoped-"));
  try {
    const runtime = await installRuntime(path.join(temporary, "runtime"));
    const { runScopedRuntimeQualification, SCOPED_RUNTIME_PROBES } = await import("./qualify-product.ts");
    const sampler = startExecSampler(EXEC_SAMPLE_INTERVAL_MS);
    let result;
    try {
      result = await runScopedRuntimeQualification(runtime);
    } catch (error) {
      // A bare `gate expected exit 0` is what sent this row to three separate
      // deliveries as a suspected product defect. Say which it is.
      throw new Error(attributeScopedQualificationFailure({
        failure: error instanceof Error ? error.message : String(error),
        execSampleMs: sampler.stop(),
      }).message, { cause: error });
    } finally { sampler.stop(); }
    expect(result.probes).toEqual(SCOPED_RUNTIME_PROBES);
    expect(result.runtimeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.repositories).toBe(3);
    // The budget above is 45 executions wide. A probe that adds more has to
    // restate it rather than spend it.
    expect(result.commands.length).toBeLessThanOrEqual(BUDGETED_BUNDLED_COMMANDS);
    await writeFile(path.join(runtime, "cli.mjs"), "throw Error(\"must not execute corrupt runtime\");\n");
    await expect(runScopedRuntimeQualification(runtime)).rejects.toThrow("runtime checksum mismatch: cli.mjs");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, SCOPED_ROW_TIMEOUT_MS);
