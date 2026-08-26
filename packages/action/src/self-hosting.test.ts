/**
 * The gate this repository runs on itself, driven by simulated pull-request
 * events BEFORE the workflow that runs it live exists.
 *
 * `main.test.ts` proves the Action against synthetic configurations; this file
 * proves it against `harness.config.ts` — the configuration `.github/workflows/
 * gate.yml` loads on every real pull request. Both directions are exercised the
 * way the workflow will see them: a fresh record on the head admits, and a
 * record gone stale under this repository's own base-movement policy blocks.
 * The fixture repositories are real temporary git repositories carrying a base
 * ref named the way this config names it, so the config is consumed verbatim —
 * not adapted, not overridden.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  ATTESTATION_LABEL,
  DELIVERY_RECORD_VERSION,
  computeDeliverableIdentity,
  deliveryRecordPathFor,
  runGitCommand,
  type DeliveryRecord,
} from "@delivery-harness/kernel";
import harnessConfig from "../../../harness.config.ts";
import { ACTION_EXIT_OK, runAction, type ActionRuntime } from "./main.ts";

const run = promisify(execFile);
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "events");
const TIMEOUT = { timeout: 60000 } as const;

const cleanups: string[] = [];
afterAll(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Repositories shaped the way this config expects ──────────────────────────

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

async function commit(dir: string, message: string): Promise<string> {
  await git(dir, "add", "--all");
  await git(dir, "commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

async function writeAt(dir: string, relativePath: string, contents: string): Promise<void> {
  const absolute = path.join(dir, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

/**
 * A repository whose base ref resolves under this config's own `baseRef` — a
 * local branch literally named `origin/main`, the same standalone-repository
 * device the CLI suite uses. Work happens on `feature`, one commit ahead.
 */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dh-self-"));
  cleanups.push(dir);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeAt(dir, "harness.config.ts", "export default {};\n");
  await commit(dir, "root");
  await git(dir, "branch", harnessConfig.baseRef);
  await git(dir, "checkout", "--quiet", "-b", "feature");
  await writeAt(dir, "src.txt", "the change under review\n");
  await commit(dir, "work");
  return dir;
}

async function identityOf(dir: string, rev: string): Promise<string> {
  const treeSha = await git(dir, "rev-parse", "--verify", `${rev}^{tree}`);
  return computeDeliverableIdentity({ rootDir: dir, treeSha, config: harnessConfig });
}

/** A record the local loop would have produced for the current head, committed at its derived path. */
async function commitFreshRecord(dir: string): Promise<{ digest: string; relativePath: string }> {
  const digest = await identityOf(dir, "HEAD");
  const treeSha = await git(dir, "rev-parse", "--verify", "HEAD^{tree}");
  const baseTipSha = await git(dir, "rev-parse", "--verify", `${harnessConfig.baseRef}^{commit}`);
  const mergeBaseSha = await git(dir, "merge-base", harnessConfig.baseRef, "HEAD");
  const record: DeliveryRecord = {
    version: DELIVERY_RECORD_VERSION,
    gateId: harnessConfig.gateId,
    identityToken: harnessConfig.computingIdentityVersion,
    candidateBinding: {
      treeSha,
      deliverableDigest: digest,
      identityToken: harnessConfig.computingIdentityVersion,
      baseRef: harnessConfig.baseRef,
      baseTipSha,
      mergeBaseSha,
      workspaceId: "workspace-local",
    },
    claims: harnessConfig.obligations.map((obligation) => ({
      obligationId: obligation.id,
      outcome: "satisfied_evidence",
      providerId: obligation.providers[0]!,
      recordId: "a".repeat(64),
      runId: "run-1",
      finalPassId: "pass-2",
      manifestDigest: "b".repeat(64),
    })),
    manifestDigest: "b".repeat(64),
    workspaceId: "workspace-local",
    attestation: { level: "self" },
  } as DeliveryRecord;
  const relativePath = deliveryRecordPathFor(harnessConfig, digest);
  await writeAt(dir, relativePath, `${JSON.stringify(record)}\n`);
  await commit(dir, "delivery record");
  return { digest, relativePath };
}

// ── The runtime seam, loading this repository's own config ───────────────────

interface Fixture {
  readonly description: string;
  readonly env: Record<string, string>;
  readonly event: unknown;
}

interface Driven {
  readonly runtime: ActionRuntime;
  readonly summaries: string[];
  readonly outputs: Record<string, string>[];
}

async function driveRuntime(dir: string, options: { headSha?: string } = {}): Promise<Driven> {
  const raw = JSON.parse(await readFile(path.join(FIXTURES, "pull-request-synchronize.json"), "utf8")) as Fixture;
  const headSha = options.headSha ?? (await git(dir, "rev-parse", "HEAD"));
  const baseSha = await git(dir, "rev-parse", "--verify", `${harnessConfig.baseRef}^{commit}`);
  const eventDir = await mkdtemp(path.join(os.tmpdir(), "dh-self-event-"));
  cleanups.push(eventDir);
  const eventPath = path.join(eventDir, "event.json");
  const substituted = JSON.parse(
    JSON.stringify(raw)
      .replaceAll("{{WORKSPACE}}", dir)
      .replaceAll("{{EVENT_PATH}}", eventPath)
      .replaceAll("{{HEAD_SHA}}", headSha)
      .replaceAll("{{BASE_SHA}}", baseSha)
      .replaceAll("{{MERGE_SHA}}", "0".repeat(40)),
  ) as Fixture;
  await writeFile(eventPath, `${JSON.stringify(substituted.event, null, 2)}\n`, "utf8");

  const summaries: string[] = [];
  const outputs: Record<string, string>[] = [];
  const runtime: ActionRuntime = {
    env: { ...substituted.env },
    workspace: dir,
    git: runGitCommand,
    readFile: (absolutePath) => readFile(absolutePath, "utf8"),
    loadConfig: async () => harnessConfig,
    writeSummary: async (markdown) => {
      summaries.push(markdown);
    },
    writeOutputs: async (written) => {
      outputs.push({ ...written });
    },
    log: () => {},
  };
  return { runtime, summaries, outputs };
}

// ── Both directions, before the workflow exists ──────────────────────────────

describe("simulated gate events under this repository's own configuration", () => {
  it("admits a fresh record on the pull request head", TIMEOUT, async () => {
    const dir = await initRepo();
    const { relativePath, digest } = await commitFreshRecord(dir);

    const { runtime, summaries, outputs } = await driveRuntime(dir);
    const result = await runAction(runtime);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(ACTION_EXIT_OK);
    // The record sits at the completed config's own derived path — a skeleton
    // path would fail here, which is what binds these events to the real gate.
    expect(relativePath.startsWith("delivery/records/record--")).toBe(true);
    expect(result.recordPath).toBe(relativePath);
    expect(result.deliverableDigest).toBe(digest);
    const summary = summaries.join("");
    expect(summary).toContain(ATTESTATION_LABEL);
    expect(summary).toContain("review.green");
    expect(outputs.at(-1)?.["mode"]).toBe("verify");
  });

  it("blocks a planted stale record once the base moves, under this config's own policy", TIMEOUT, async () => {
    const dir = await initRepo();
    await commitFreshRecord(dir);

    // The base advances after the record was written; this repository's
    // base-movement policy is "stale", so the record must not survive it.
    expect(harnessConfig.deliveryRecordVerification.baseMovement).toBe("stale");
    const headSha = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "--quiet", harnessConfig.baseRef);
    await writeAt(dir, "base.txt", "the base moves on\n");
    await commit(dir, "base work");
    await git(dir, "checkout", "--quiet", "feature");

    const { runtime, summaries } = await driveRuntime(dir, { headSha });
    const result = await runAction(runtime);

    expect(result.ok).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toContain("base_tip_moved");
    expect(summaries.join("")).toContain("base_tip_moved");
  });
});
