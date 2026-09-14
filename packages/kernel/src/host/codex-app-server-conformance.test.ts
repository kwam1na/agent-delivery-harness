/**
 * THE CODEX PORT AGAINST THE FROZEN CONTRACT.
 *
 * A third implementation of `HostIntegrationPort`, and one whose mechanism has
 * nothing in common with either of the two the contract already carries: no
 * settings file, no CLI arguments, a named permission profile and a
 * synchronous `pre_tool_use` hook instead. It qualifies by producing the same
 * NORMALIZED outcomes, which is the whole claim the contract makes.
 *
 * The suite also pins the ordering this port exists for: the applied
 * configuration is verified BEFORE an attestation is minted, so a host that
 * applied something else — or reported nothing at all — admits nothing and
 * intercepts nothing. That case is not decoration: it is the difference
 * between an attestation that binds an enforced boundary and one that binds a
 * hope.
 *
 * MODEL-FREE: no app-server process is started, no thread is opened, no turn
 * runs, and no credential is read.
 *
 * Written RED before `codex-app-server-conformance.ts` existed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_CONFORMANCE_CASES, runHostIntegrationConformance, type HostIntegrationPort } from "./conformance.ts";
import {
  createCodexAppServerConformancePort,
  faithfullyAppliedCodexConfiguration,
} from "./codex-app-server-conformance.ts";
import { CODEX_APP_SERVER_HOST_ID, CODEX_CHARACTERIZED_HOST_VERSION } from "./codex-app-server.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "fixtures");
const SKILLS_ARCHIVE = path.join(FIXTURES, "agent-skills-core-v1-composition.zip");

let scratch: string;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "codex-conformance-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

/** A disposable repo + linked worktree + a stand-in pinned generation root. */
async function codexPort(
  options: Partial<Parameters<typeof createCodexAppServerConformancePort>[0]> = {},
): Promise<HostIntegrationPort> {
  const base = await mkdtemp(path.join(scratch, "codex-"));
  const repoDir = path.join(base, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "--initial-branch", "main");
  git(repoDir, "config", "user.email", "conformance@example.invalid");
  git(repoDir, "config", "user.name", "Conformance");
  writeFileSync(path.join(repoDir, "README.md"), "disposable\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "base");
  const worktreeDir = path.join(base, "worktree");
  git(repoDir, "worktree", "add", "-b", "delivery", worktreeDir, "main");
  const generationRoot = path.join(base, "generation");
  mkdirSync(path.join(generationRoot, "skills"), { recursive: true });
  writeFileSync(path.join(generationRoot, "skills", "agent-skills-core-v1.zip"), readFileSync(SKILLS_ARCHIVE));

  return createCodexAppServerConformancePort({
    worktreeDir,
    generationRoot,
    bindingDir: path.join(base, "binding"),
    deliveryId: "dlv-codex-conformance",
    fence: 5,
    hostVersion: CODEX_CHARACTERIZED_HOST_VERSION,
    descendantTeardown: "unverified",
    appliedConfiguration: faithfullyAppliedCodexConfiguration,
    ...options,
  });
}

/**
 * Ports are built sparingly and shared within a case: each one materializes a
 * real projection into a real worktree, which is the expensive half of this
 * suite. Three ports cover every property it claims — a faithful application,
 * an application the host never reported, and an application that diverged —
 * and the member-by-member divergence matrix lives in
 * `codex-app-server.test.ts`, where it costs nothing.
 */
describe("the Codex app-server binding", () => {
  it("satisfies every normalized case of the frozen contract, and reports only the resume position its grade supports", async () => {
    const port = await codexPort();
    expect(port.hostId).toBe(CODEX_APP_SERVER_HOST_ID);

    const termination = await port.terminate();
    expect(termination.provenance).toBe("graceful");
    expect(termination.descendantTeardown).toBe("unverified");
    expect(termination.resumeEligibility).toBe("fresh-worktree-only");

    const results = await runHostIntegrationConformance(port);
    expect(results.filter((result) => !result.satisfied).map((failure) => `${failure.caseId}: ${failure.detail}`)).toEqual(
      [],
    );
    expect(results.length).toBe(HOST_CONFORMANCE_CASES.length);
  });
});

describe("before the applied configuration is verified", () => {
  it("admits nothing when the host reported nothing it applied, and the contract catches it", async () => {
    const port = await codexPort({ appliedConfiguration: undefined });
    const admission = await port.admit("current");
    expect(admission.outcome).toBe("denied");
    expect(admission.codes).toEqual(["applied_configuration_unverified"]);
    const interception = await port.intercept("granted-capability");
    expect(interception.outcome).toBe("denied");
    expect(interception.codes).toEqual(["applied_configuration_unverified"]);

    // The contract's positive case must FAIL here: a port that quietly
    // admitted an unverified application is the defect this suite exists for.
    const results = await runHostIntegrationConformance(port);
    expect(results.find((result) => result.caseId === "admits-the-currently-attested-grant")?.satisfied).toBe(false);
  });

  it("admits nothing when the host applied something other than what was composed", async () => {
    // One divergence stands for the set: the ordering is what is under test
    // here, and every mismatch code is exercised member by member in
    // `codex-app-server.test.ts`. An asynchronous hook is the divergence that
    // matters most — it leaves the interceptor advisory.
    const port = await codexPort({
      appliedConfiguration: (composed) => ({ ...faithfullyAppliedCodexConfiguration(composed), hookExecutionMode: "async" }),
    });
    const admission = await port.admit("current");
    expect(admission.outcome).toBe("denied");
    expect(admission.codes).toEqual(["applied_configuration_unverified"]);
    expect((await port.intercept("granted-capability")).outcome).toBe("denied");
  });
});
