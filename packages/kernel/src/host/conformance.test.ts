/**
 * THE HOST-INTEGRATION CONFORMANCE CONTRACT — the standing contract for any
 * future host, exercised here by two very different implementations:
 *
 *   - a FAKE HOST, which owns no worktree, no settings file, and no hook, and
 *     satisfies the contract entirely in memory; and
 *   - the real CLAUDE CODE BINDING, driving a disposable repository, a linked
 *     worktree, a materialized projection, and the composed session settings.
 *
 * Their mechanisms have nothing in common, and that is the point: host-specific
 * delegation is non-normative, and the NORMALIZED outcomes are the
 * compatibility target. Every case below is stated once and asserted
 * identically against both, so a future host qualifies by producing the same
 * normalized outcomes rather than by resembling either of these.
 *
 * The suite also proves what the contract must never let a host do: mint an
 * admission before attestation, honor a stale or sibling attestation, open a
 * capability outside the grant, write a protected authority path, serve an
 * operator confirmation from inside a grant, or record a resume position its
 * graded teardown behavior does not support.
 *
 * Written RED before `conformance.ts` and the Claude Code adapter existed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HOST_CONFORMANCE_CASES,
  runHostIntegrationConformance,
  type HostIntegrationPort,
} from "./conformance.ts";
import { createClaudeCodeConformancePort } from "./claude-code-conformance.ts";
import { createFakeHostConformancePort } from "./fake-host.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "fixtures");
const SKILLS_ARCHIVE = path.join(FIXTURES, "agent-skills-core-v1-composition.zip");

let scratch: string;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "host-conformance-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

/** A disposable repo + linked worktree + a stand-in pinned generation root. */
async function claudeCodePort(
  descendantTeardown: "verified" | "unverified",
  // A `verified` port must NOT claim the graded host version: 2.1.97 is
  // graded below Tier 3, so pairing the two would be a contradiction the
  // record and the fixture state differently.
  hostVersion = descendantTeardown === "verified" ? "hypothetical-tier-3/1.0.0" : "claude-code/2.1.97",
): Promise<HostIntegrationPort> {
  const base = await mkdtemp(path.join(scratch, "cc-"));
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

  return createClaudeCodeConformancePort({
    worktreeDir,
    generationRoot,
    bindingDir: path.join(base, "binding"),
    deliveryId: "dlv-conformance-1",
    fence: 5,
    hostVersion,
    descendantTeardown,
  });
}

describe("the host-integration conformance contract", () => {
  it("enumerates its frozen cases — adding or dropping one is a contract change", () => {
    expect(HOST_CONFORMANCE_CASES.map((entry) => entry.caseId)).toEqual([
      "admits-the-currently-attested-grant",
      "denies-every-tool-before-attestation",
      "denies-a-stale-fence-attestation",
      "denies-a-sibling-delivery-attestation",
      "allows-a-granted-capability",
      "denies-a-capability-outside-the-grant",
      "denies-a-write-to-a-protected-authority-path",
      "denies-an-operator-confirmation-inside-the-grant",
      "records-only-the-graded-resume-position",
      "tears-the-binding-written-set-down",
    ]);
  });
});

describe.each([
  ["the fake host", async () => createFakeHostConformancePort({ descendantTeardown: "unverified" })],
  ["the Claude Code binding", async () => claudeCodePort("unverified")],
] as const)("%s", (_label, make) => {
  it("satisfies every normalized case of the contract", async () => {
    const port = await make();
    const results = await runHostIntegrationConformance(port);
    const failures = results.filter((result) => !result.satisfied);
    expect(failures.map((failure) => `${failure.caseId}: ${failure.detail}`)).toEqual([]);
    expect(results.length).toBe(HOST_CONFORMANCE_CASES.length);
  });

  it("reports fresh-worktree-only resume while descendant teardown is unverified", async () => {
    const port = await make();
    const termination = await port.terminate();
    expect(termination.provenance).toBe("graceful");
    expect(termination.descendantTeardown).toBe("unverified");
    expect(termination.resumeEligibility).toBe("fresh-worktree-only");
  });
});

describe("a host graded with verified descendant teardown", () => {
  it("reaches same-workspace resume through the same normalized contract", async () => {
    for (const port of [
      createFakeHostConformancePort({ descendantTeardown: "verified" }),
      await claudeCodePort("verified"),
    ]) {
      const termination = await port.terminate();
      expect(termination.resumeEligibility).toBe("same-workspace");
      const results = await runHostIntegrationConformance(port);
      expect(results.filter((result) => !result.satisfied)).toEqual([]);
    }
  });
});

describe("a non-conforming host", () => {
  it("is caught by the contract rather than silently normalized away", async () => {
    const honest = createFakeHostConformancePort({ descendantTeardown: "unverified" });
    // A host that honors a stale attestation — exactly the failure the
    // contract exists to catch.
    const lax: HostIntegrationPort = {
      ...honest,
      admit: async (scenario) =>
        scenario === "stale-fence" ? { outcome: "admitted" } : honest.admit(scenario),
    };
    const results = await runHostIntegrationConformance(lax);
    const stale = results.find((result) => result.caseId === "denies-a-stale-fence-attestation");
    expect(stale?.satisfied).toBe(false);
  });

  it("catches a host that simply denies everything", async () => {
    const honest = createFakeHostConformancePort({ descendantTeardown: "unverified" });
    const denyEverything: HostIntegrationPort = {
      ...honest,
      admit: async () => ({ outcome: "denied", codes: ["denies_everything"] }),
      intercept: async () => ({ outcome: "denied", codes: ["denies_everything"] }),
    };
    const results = await runHostIntegrationConformance(denyEverything);
    expect(results.find((result) => result.caseId === "admits-the-currently-attested-grant")?.satisfied).toBe(false);
    expect(results.find((result) => result.caseId === "allows-a-granted-capability")?.satisfied).toBe(false);
  });

  it("catches a host that claims same-workspace resume without verified teardown", async () => {
    const honest = createFakeHostConformancePort({ descendantTeardown: "unverified" });
    const overclaiming: HostIntegrationPort = {
      ...honest,
      terminate: async () => ({
        provenance: "graceful",
        descendantTeardown: "unverified",
        resumeEligibility: "same-workspace",
      }),
    };
    const results = await runHostIntegrationConformance(overclaiming);
    const graded = results.find((result) => result.caseId === "records-only-the-graded-resume-position");
    expect(graded?.satisfied).toBe(false);
  });
});
