/**
 * Candidate capture is tested against real repositories.
 *
 * Every fixture below is an actual git repository in a temporary directory,
 * driven by actual git commands. A stubbed git would let this suite agree with
 * itself about states that git does not really produce — a merge left
 * half-finished, an index whose tree matches HEAD, a remote-tracking ref that
 * has gone missing — and those states are the entire subject of the unit.
 *
 * The command runner is injected in exactly three places, all of them cases a
 * repository cannot be *left* in: two observations disagreeing mid-capture, and
 * a status shape no sequence of git commands produces. Those tests still run
 * against a real repository; only the one observation being provoked is
 * synthetic.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BlockedError, GATE_STRUCTURAL_FINDING_CODES } from "./blockers.ts";
import {
  captureGitCandidate,
  createCandidateCapture,
  evaluateCandidateActivation,
  parseCandidateNumstat,
  runGitCommand,
  type CandidateCaptureOptions,
  type CandidateCommandRunner,
} from "./candidate.ts";
import {
  classifyCandidateDrift,
  classifyCandidatePath,
  isObligationActive,
  projectReviewActivation,
  type CandidateBinding,
  type CandidateDiffEntry,
  type ComputeIdentity,
  type DeliverableIdentityRequest,
} from "./candidate.types.ts";
import { defineHarnessConfig, type HarnessConfig, type HarnessConfigInput } from "./config.ts";

// ── Repository fixtures ────────────────────────────────────────────────────

const createdRoots: string[] = [];

afterAll(async () => {
  await Promise.all(createdRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Identity and signing are pinned per invocation rather than written into a
 * repository config, so a developer's global git configuration cannot decide
 * whether these fixtures can commit at all.
 */
const GIT_DRIVER_FLAGS = [
  "-c",
  "user.name=Delivery Harness Test",
  "-c",
  "user.email=test@delivery-harness.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/nonexistent",
];

function drive(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...GIT_DRIVER_FLAGS, ...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || stdout || String(error)}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function makeRoot(): Promise<string> {
  // The realpath matters on macOS, where the temporary directory is reached
  // through a symlink and git reports the resolved path.
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "harness-candidate-"));
  createdRoots.push(root);
  return root;
}

async function write(repo: string, repoPath: string, contents: string): Promise<void> {
  const absolute = path.join(repo, repoPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

function lines(count: number, prefix = "line"): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n")}\n`;
}

interface Fixture {
  readonly root: string;
  readonly work: string;
  readonly remote: string;
}

/**
 * A repository whose `main` is published to an `origin` remote, so the default
 * base ref resolves the way it does in a real checkout.
 */
async function preparedFixture(): Promise<Fixture> {
  const root = await makeRoot();
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  await mkdir(work, { recursive: true });
  await drive(root, ["init", "--bare", "--initial-branch=main", remote]);
  await drive(root, ["init", "--initial-branch=main", work]);

  await write(work, "src/app.ts", lines(10, "app"));
  await write(work, "src/app.test.ts", lines(10, "spec"));
  await write(work, "generated/output.ts", lines(10, "gen"));
  await write(work, "packages/auth/token.ts", lines(10, "auth"));
  await write(work, "package-lock.json", '{\n  "name": "fixture"\n}\n');
  await write(work, ".gitignore", "ignored/\n");
  await drive(work, ["add", "--all"]);
  await drive(work, ["commit", "--no-gpg-sign", "-m", "base"]);
  await drive(work, ["remote", "add", "origin", remote]);
  await drive(work, ["push", "--quiet", "origin", "main"]);

  return { root, work, remote };
}

// ── Config fixtures ────────────────────────────────────────────────────────

const ACTIVATION_THRESHOLD = 50;

function testConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "test.gate",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: ["test-tree/v1"],
    computingIdentityVersion: "test-tree/v1",
    reviewNeutral: [{ prefix: "docs/narration/" }, { prefix: "delivery/records/" }],
    recordNeutral: [{ prefix: "delivery/records/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [{ id: "auth", patterns: [{ kind: "prefix", value: "packages/auth" }] }],
    activationThreshold: ACTIVATION_THRESHOLD,
    providers: [{ id: "test.provider", findingCodes: ["provider-finding"] }],
    agentEnvSignals: ["TEST_AGENT"],
    ciPolicies: [],
    ciPolicyEnvKey: "TEST_CI_POLICY",
    preparationWiringPaths: ["harness.config.ts"],
    obligations: [
      {
        id: "review.green",
        activation: { kind: "relevant_change" },
        freshness: "exact_candidate",
        providers: ["test.provider"],
        acceptedPayloadSpecs: ["review.green/1"],
        allowedResolutionKinds: ["satisfied_evidence"],
        humanWaiverAllowed: false,
        minimumAttestationLevel: "self",
        ciDelegationPolicyIds: [],
        remediation: {
          default: [{ id: "complete-review", kind: "manual_action", summary: "Complete a review for this candidate." }],
        },
        waivableCodes: [],
        nonWaivableCodes: [...GATE_STRUCTURAL_FINDING_CODES, "provider-finding"],
      },
    ],
    deliveryRecordPath: "delivery/records/latest.json",
    ...overrides,
  });
}

const RELEVANT_CHANGE = { kind: "relevant_change" } as const;

// ── The identity port double ───────────────────────────────────────────────

const FIXED_DIGEST = `${"5".repeat(63)}f`;
const WORKSPACE_ID = `${"7".repeat(63)}a`;

function identityDouble(): { readonly computeIdentity: ComputeIdentity; readonly requests: DeliverableIdentityRequest[] } {
  const requests: DeliverableIdentityRequest[] = [];
  return {
    requests,
    computeIdentity: (request) => {
      requests.push(request);
      return Promise.resolve(FIXED_DIGEST);
    },
  };
}

function captureOptions(work: string, overrides: Partial<CandidateCaptureOptions> = {}): CandidateCaptureOptions {
  return {
    rootDir: work,
    config: testConfig(),
    workspaceId: WORKSPACE_ID,
    computeIdentity: identityDouble().computeIdentity,
    ...overrides,
  };
}

// ── Capture: the prepared states ───────────────────────────────────────────

describe("candidate capture", () => {
  it("captures a clean worktree against the tree HEAD names", async () => {
    const { work } = await preparedFixture();
    await write(work, "src/app.ts", lines(30, "app"));
    await drive(work, ["add", "--all"]);
    await drive(work, ["commit", "--no-gpg-sign", "-m", "work"]);

    const identity = identityDouble();
    const result = await captureGitCandidate(captureOptions(work, { computeIdentity: identity.computeIdentity }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const headSha = await drive(work, ["rev-parse", "HEAD"]);
    const headTree = await drive(work, ["rev-parse", "HEAD^{tree}"]);
    const baseTip = await drive(work, ["rev-parse", "origin/main"]);
    expect(result.candidate).toMatchObject({
      vcs: "git",
      mode: "clean",
      headSha,
      treeSha: headTree,
      workspaceId: WORKSPACE_ID,
      deliverable: { digest: FIXED_DIGEST, identity: "test-tree/v1" },
      base: { ref: "origin/main", tipSha: baseTip, mergeBaseSha: baseTip },
      statusEntries: [],
      untrackedFiles: [],
    });
    // The identity port is handed the tree the candidate is defined by, not HEAD.
    expect(identity.requests).toEqual([expect.objectContaining({ rootDir: work, treeSha: headTree })]);
  });

  it("captures a staged index as the prepared tree", async () => {
    const { work } = await preparedFixture();
    await write(work, "src/app.ts", lines(30, "app"));
    await drive(work, ["add", "--all"]);

    const result = await captureGitCandidate(captureOptions(work));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const headTree = await drive(work, ["rev-parse", "HEAD^{tree}"]);
    expect(result.candidate.mode).toBe("staged-index");
    expect(result.candidate.treeSha).not.toBe(headTree);
    expect(result.candidate.statusEntries).toEqual([{ code: "M ", path: "src/app.ts" }]);
  });

  it("captures a candidate whose tree already matches its base, and says the diff is empty", async () => {
    const { work } = await preparedFixture();

    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.base.mergeBaseSha).toBe(result.candidate.headSha);

    const config = testConfig();
    const projection = await evaluateCandidateActivation({ rootDir: work, candidate: result.candidate, config });
    expect(projection.changedEntryCount).toBe(0);
    expect(projection.relevantLineCount).toBe(0);
    expect(isObligationActive(RELEVANT_CHANGE, projection, config.activationThreshold)).toBe(false);
  });

  it("honours a non-default base ref end to end", async () => {
    const { work } = await preparedFixture();
    await drive(work, ["branch", "release/next"]);
    await write(work, "src/app.ts", lines(80, "app"));
    await drive(work, ["add", "--all"]);
    await drive(work, ["commit", "--no-gpg-sign", "-m", "work"]);
    // Move origin/main forward so a capture that ignored the configured ref
    // would resolve a different base and project a different diff.
    await drive(work, ["push", "--quiet", "origin", "HEAD:main"]);
    await drive(work, ["fetch", "--quiet", "origin"]);

    const config = testConfig({ baseRef: "release/next" });
    const result = await captureGitCandidate(captureOptions(work, { config }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const releaseTip = await drive(work, ["rev-parse", "release/next"]);
    expect(result.candidate.base).toEqual({ ref: "release/next", tipSha: releaseTip, mergeBaseSha: releaseTip });

    const projection = await evaluateCandidateActivation({ rootDir: work, candidate: result.candidate, config });
    expect(projection.relevantPaths).toEqual(["src/app.ts"]);
    expect(projection.relevantLineCount).toBeGreaterThan(0);
  });

  it("captures on a detached HEAD", async () => {
    const { work } = await preparedFixture();
    await write(work, "src/app.ts", lines(20, "app"));
    await drive(work, ["add", "--all"]);
    await drive(work, ["commit", "--no-gpg-sign", "-m", "work"]);
    const headSha = await drive(work, ["rev-parse", "HEAD"]);
    await drive(work, ["checkout", "--quiet", "--detach", headSha]);

    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.headSha).toBe(headSha);
    expect(result.candidate.mode).toBe("clean");
  });

  it("tolerates ignored files in the worktree", async () => {
    const { work } = await preparedFixture();
    await write(work, "ignored/scratch.txt", "scratch\n");

    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.mode).toBe("clean");
    expect(result.candidate.untrackedFiles).toEqual([]);
  });

  it("is immune to a foreign git environment in the parent process", async () => {
    const { work } = await preparedFixture();
    const foreign = await preparedFixture();
    await write(foreign.work, "src/app.ts", lines(99, "foreign"));
    await drive(foreign.work, ["add", "--all"]);
    await drive(foreign.work, ["commit", "--no-gpg-sign", "-m", "foreign"]);

    const expected = await drive(work, ["rev-parse", "HEAD"]);
    const previous = {
      GIT_DIR: process.env["GIT_DIR"],
      GIT_WORK_TREE: process.env["GIT_WORK_TREE"],
      GIT_INDEX_FILE: process.env["GIT_INDEX_FILE"],
    };
    process.env["GIT_DIR"] = path.join(foreign.work, ".git");
    process.env["GIT_WORK_TREE"] = foreign.work;
    process.env["GIT_INDEX_FILE"] = path.join(foreign.work, ".git", "index");
    try {
      const result = await captureGitCandidate(captureOptions(work));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.candidate.headSha).toBe(expected);
      expect(result.candidate.mode).toBe("clean");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("exposes the whole-candidate port as a bound thunk", async () => {
    const { work } = await preparedFixture();
    const capture = createCandidateCapture(captureOptions(work));
    const first = await capture();
    const second = await capture();
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
  });
});

// ── Capture: the unprepared states ─────────────────────────────────────────

describe("candidate capture refuses unprepared workspaces", () => {
  it("refuses an unstaged edit to a tracked file, and stages nothing", async () => {
    const { work } = await preparedFixture();
    await write(work, "src/app.ts", lines(40, "app"));

    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_unprepared");
    expect(result.blockers[0].source).toEqual({ kind: "candidate", id: "test.gate" });
    // Refusing must not be a repair: the index is exactly as the author left it.
    expect(await drive(work, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("refuses an untracked file", async () => {
    const { work } = await preparedFixture();
    await write(work, "src/new-module.ts", "export const value = 1;\n");

    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_unprepared");
    expect(result.blockers[0].details).toContain("src/new-module.ts");
  });

  it("refuses a merge left in progress, with its own reason", async () => {
    const { work } = await preparedFixture();
    await drive(work, ["checkout", "--quiet", "-b", "side"]);
    await write(work, "src/side.ts", lines(5, "side"));
    await drive(work, ["add", "--all"]);
    await drive(work, ["commit", "--no-gpg-sign", "-m", "side"]);
    await drive(work, ["checkout", "--quiet", "main"]);
    await write(work, "src/trunk.ts", lines(5, "trunk"));
    await drive(work, ["add", "--all"]);
    await drive(work, ["commit", "--no-gpg-sign", "-m", "trunk"]);
    await drive(work, ["merge", "--no-commit", "--no-ff", "side"]).catch(() => undefined);

    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_merge_in_progress");
  });

  it("refuses a conflicted merge before it reaches the index tree", async () => {
    const { work } = await preparedFixture();
    await drive(work, ["checkout", "--quiet", "-b", "side"]);
    await write(work, "src/app.ts", lines(10, "side"));
    await drive(work, ["add", "--all"]);
    await drive(work, ["commit", "--no-gpg-sign", "-m", "side"]);
    await drive(work, ["checkout", "--quiet", "main"]);
    await write(work, "src/app.ts", lines(10, "trunk"));
    await drive(work, ["add", "--all"]);
    await drive(work, ["commit", "--no-gpg-sign", "-m", "trunk"]);
    // Expected to conflict; git exits non-zero and leaves MERGE_HEAD behind.
    await drive(work, ["merge", "--no-ff", "side"]).catch(() => undefined);

    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_merge_in_progress");
  });

  it("refuses a non-clean status whose index defines no distinct tree", async () => {
    const { work } = await preparedFixture();
    // No sequence of git commands leaves a repository in this state — every
    // real way to make status non-empty either dirties the worktree or moves
    // the index tree. The check is a backstop on the mode decision (a
    // staged-index candidate must have a tree of its own), so the observation
    // it guards is injected while everything else stays real.
    const run: CandidateCommandRunner = async (command, options) => {
      const result = await runGitCommand(command, options);
      if (command.includes("status")) {
        return { ...result, stdout: "M  src/app.ts\0" };
      }
      return result;
    };

    const result = await captureGitCandidate(captureOptions(work, { run }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_unprepared");
    expect(result.blockers[0].summary).toContain("distinct");
  });
});

// ── Capture: base handling, fail-closed ────────────────────────────────────

describe("candidate capture fails closed on the base", () => {
  it("blocks when the base ref does not resolve", async () => {
    const { work } = await preparedFixture();

    const result = await captureGitCandidate(captureOptions(work, { config: testConfig({ baseRef: "origin/absent" }) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_base_missing");
    expect(result.blockers[0].summary).toContain("origin/absent");
  });

  it("blocks when the base shares no history with HEAD", async () => {
    const { work } = await preparedFixture();
    await drive(work, ["checkout", "--quiet", "--orphan", "unrelated"]);
    await drive(work, ["rm", "-rq", "--cached", "."]);
    await write(work, "only.ts", "export const only = 1;\n");
    await drive(work, ["add", "only.ts"]);
    await drive(work, ["commit", "--no-gpg-sign", "-m", "unrelated"]);
    await drive(work, ["clean", "-fdq"]);

    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_base_unrelated");
  });

  it("blocks when the directory is not a repository", async () => {
    const root = await makeRoot();

    const result = await captureGitCandidate(captureOptions(root));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_repository_unreadable");
  });

  it("blocks when HEAD is unborn", async () => {
    const root = await makeRoot();
    const work = path.join(root, "fresh");
    await mkdir(work, { recursive: true });
    await drive(root, ["init", "--initial-branch=main", work]);

    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_repository_unreadable");
  });
});

// ── Capture: the double-observation bracket ────────────────────────────────

describe("the double-observation bracket", () => {
  /**
   * Commits between observations, so the two halves of a bracket genuinely
   * disagree about HEAD. `limit` bounds how many times it interferes, which is
   * what separates a repository that settles from one that does not.
   */
  function mutatingRunner(work: string, limit: number): CandidateCommandRunner {
    let interference = 0;
    return async (command, options) => {
      const result = await runGitCommand(command, options);
      if (command.includes("write-tree") && interference < limit) {
        interference += 1;
        await drive(work, ["commit", "--no-gpg-sign", "--allow-empty", "-m", `churn ${interference}`]);
      }
      return result;
    };
  }

  it("captures on a later attempt once the repository settles", async () => {
    const { work } = await preparedFixture();

    const result = await captureGitCandidate(captureOptions(work, { run: mutatingRunner(work, 1) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.headSha).toBe(await drive(work, ["rev-parse", "HEAD"]));
  });

  it("reports an ambiguous candidate once the retry bound is spent", async () => {
    const { work } = await preparedFixture();

    const result = await captureGitCandidate(captureOptions(work, { run: mutatingRunner(work, Number.MAX_SAFE_INTEGER) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("candidate_ambiguous");
    // The blocker names what moved rather than only that something did.
    expect(result.blockers[0].details).toContain("headSha");
  });

  it("spends exactly the configured number of attempts", async () => {
    const { work } = await preparedFixture();
    let observations = 0;
    const run: CandidateCommandRunner = async (command, options) => {
      const result = await runGitCommand(command, options);
      if (command.includes("write-tree")) {
        observations += 1;
        await drive(work, ["commit", "--no-gpg-sign", "--allow-empty", "-m", `churn ${observations}`]);
      }
      return result;
    };

    const result = await captureGitCandidate(captureOptions(work, { run, maxAttempts: 2 }));
    expect(result.ok).toBe(false);
    expect(observations).toBe(4);
  });
});

// ── numstat parsing ────────────────────────────────────────────────────────

describe("numstat parsing", () => {
  it("reads counted, binary and renamed entries from the NUL stream", () => {
    const output = ["12\t3\tsrc/app.ts\0", "-\t-\tassets/logo.png\0", "4\t5\t\0src/old.ts\0src/new.ts\0"].join("");

    expect(parseCandidateNumstat(output)).toEqual([
      { path: "src/app.ts", additions: 12, deletions: 3, binary: false },
      { path: "assets/logo.png", additions: null, deletions: null, binary: true },
      { path: "src/new.ts", oldPath: "src/old.ts", additions: 4, deletions: 5, binary: false },
    ]);
  });

  it("reads a path containing the rename arrow as one path", () => {
    expect(parseCandidateNumstat("1\t0\tsrc/a => b.ts\0")).toEqual([
      { path: "src/a => b.ts", additions: 1, deletions: 0, binary: false },
    ]);
  });

  it("reads an empty diff as no entries", () => {
    expect(parseCandidateNumstat("")).toEqual([]);
  });
});

// ── Path classification ────────────────────────────────────────────────────

describe("path classification", () => {
  const classification = testConfig().pathClassification;

  it("classifies by the config's matchers, most specific first", () => {
    expect(classifyCandidatePath(classification, "src/app.ts")).toBe("relevant");
    expect(classifyCandidatePath(classification, "src/app.test.ts")).toBe("test");
    expect(classifyCandidatePath(classification, "app.test.ts")).toBe("test");
    expect(classifyCandidatePath(classification, "generated/output.ts")).toBe("generated");
    expect(classifyCandidatePath(classification, "package-lock.json")).toBe("lockfile");
    expect(classifyCandidatePath(classification, "packages/kernel/package-lock.json")).toBe("lockfile");
  });

  it("does not let a prefix matcher spill into a sibling directory", () => {
    expect(classifyCandidatePath(classification, "generated-docs/output.ts")).toBe("relevant");
  });

  it("treats a backslash as a literal character, not a separator", () => {
    expect(classifyCandidatePath(classification, "generated\\output.ts")).toBe("relevant");
  });
});

// ── The activation projection ──────────────────────────────────────────────

describe("the activation projection", () => {
  const config = testConfig();

  function counted(repoPath: string, total: number): CandidateDiffEntry {
    return { path: repoPath, additions: total, deletions: 0, binary: false };
  }

  it("is inactive one line below the threshold", () => {
    const projection = projectReviewActivation([counted("src/app.ts", ACTIVATION_THRESHOLD - 1)], config);
    expect(projection.relevantLineCount).toBe(ACTIVATION_THRESHOLD - 1);
    expect(isObligationActive(RELEVANT_CHANGE, projection, config.activationThreshold)).toBe(false);
  });

  it("is active at the threshold", () => {
    const projection = projectReviewActivation([counted("src/app.ts", ACTIVATION_THRESHOLD)], config);
    expect(isObligationActive(RELEVANT_CHANGE, projection, config.activationThreshold)).toBe(true);
  });

  it("stays inactive when generated, test and lock-file lines make up the difference", () => {
    const projection = projectReviewActivation(
      [
        counted("src/app.ts", ACTIVATION_THRESHOLD - 1),
        counted("generated/output.ts", 500),
        counted("src/app.test.ts", 500),
        counted("package-lock.json", 500),
      ],
      config,
    );
    expect(projection.relevantLineCount).toBe(ACTIVATION_THRESHOLD - 1);
    expect(projection.excludedPaths).toEqual(["generated/output.ts", "package-lock.json", "src/app.test.ts"]);
    expect(isObligationActive(RELEVANT_CHANGE, projection, config.activationThreshold)).toBe(false);
  });

  it("counts those same lines once the generated matcher stops covering them", () => {
    // The falsification of the leg above: point the matcher somewhere else and
    // the generated file's 500 lines become reviewable, which flips the result.
    const misScoped = testConfig({
      pathClassification: { ...config.pathClassification, generated: [{ kind: "prefix", value: "vendor/" }] },
    });
    const projection = projectReviewActivation(
      [counted("src/app.ts", ACTIVATION_THRESHOLD - 1), counted("generated/output.ts", 500)],
      misScoped,
    );
    expect(isObligationActive(RELEVANT_CHANGE, projection, misScoped.activationThreshold)).toBe(true);
  });

  it("activates on a reviewable binary change with no line count at all", () => {
    const projection = projectReviewActivation([{ path: "assets/logo.png", additions: null, deletions: null, binary: true }], config);
    expect(projection.relevantLineCount).toBe(0);
    expect(projection.binaryPaths).toEqual(["assets/logo.png"]);
    expect(projection.hasRelevantBinaryChange).toBe(true);
    expect(isObligationActive(RELEVANT_CHANGE, projection, config.activationThreshold)).toBe(true);
  });

  it("does not activate on a binary change to an excluded path", () => {
    const projection = projectReviewActivation([{ path: "generated/logo.png", additions: null, deletions: null, binary: true }], config);
    expect(projection.hasRelevantBinaryChange).toBe(false);
    expect(isObligationActive(RELEVANT_CHANGE, projection, config.activationThreshold)).toBe(false);
  });

  it("names the sensitive group a touched path falls inside", () => {
    const projection = projectReviewActivation([counted("packages/auth/token.ts", 1)], config);
    expect(projection.sensitivePathIds).toEqual(["auth"]);
    expect(isObligationActive(RELEVANT_CHANGE, projection, config.activationThreshold)).toBe(true);
  });

  it("sees a rename out of a sensitive path from the side it left", () => {
    const projection = projectReviewActivation(
      [{ path: "src/token.ts", oldPath: "packages/auth/token.ts", additions: 0, deletions: 0, binary: false }],
      config,
    );
    expect(projection.sensitivePathIds).toEqual(["auth"]);
    expect(projection.relevantPaths).toEqual(["packages/auth/token.ts", "src/token.ts"]);
  });

  it("keeps a rename reviewable when either side is reviewable", () => {
    const projection = projectReviewActivation(
      [{ path: "generated/moved.ts", oldPath: "src/moved.ts", additions: 3, deletions: 4, binary: false }],
      config,
    );
    expect(projection.relevantLineCount).toBe(7);
  });

  it("activates an always-on obligation whatever the projection says", () => {
    const projection = projectReviewActivation([], config);
    expect(projection.changedEntryCount).toBe(0);
    expect(isObligationActive({ kind: "always" }, projection, config.activationThreshold)).toBe(true);
  });
});

// ── The projection over a real repository ──────────────────────────────────

describe("projecting a captured candidate", () => {
  it("counts only reviewable lines from the real diff", async () => {
    const { work } = await preparedFixture();
    await write(work, "src/app.ts", lines(90, "app"));
    await write(work, "generated/output.ts", lines(400, "gen"));
    await write(work, "src/app.test.ts", lines(400, "spec"));
    await drive(work, ["add", "--all"]);

    const config = testConfig();
    const result = await captureGitCandidate(captureOptions(work, { config }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const projection = await evaluateCandidateActivation({ rootDir: work, candidate: result.candidate, config });
    expect(projection.relevantPaths).toEqual(["src/app.ts"]);
    expect(projection.excludedPaths).toEqual(["generated/output.ts", "src/app.test.ts"]);
    expect(projection.changedEntryCount).toBe(3);
    expect(isObligationActive(RELEVANT_CHANGE, projection, config.activationThreshold)).toBe(true);
  });

  it("blocks rather than reporting an empty diff when the diff cannot be read", async () => {
    const { work } = await preparedFixture();
    const result = await captureGitCandidate(captureOptions(work));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const broken = { ...result.candidate, base: { ...result.candidate.base, mergeBaseSha: `${"0".repeat(39)}1` } };

    await expect(evaluateCandidateActivation({ rootDir: work, candidate: broken, config: testConfig() })).rejects.toBeInstanceOf(
      BlockedError,
    );
  });
});

// ── Drift ──────────────────────────────────────────────────────────────────

describe("drift classification", () => {
  const binding: CandidateBinding = {
    treeSha: "t".repeat(40),
    deliverable: { digest: FIXED_DIGEST, identity: "test-tree/v1" },
    base: { ref: "origin/main", tipSha: "b".repeat(40), mergeBaseSha: "m".repeat(40) },
    workspaceId: WORKSPACE_ID,
  };

  it("reports no class for an unmoved candidate", () => {
    expect(classifyCandidateDrift(binding, { ...binding })).toEqual([]);
  });

  it("names each class on its own", () => {
    expect(classifyCandidateDrift(binding, { ...binding, deliverable: { ...binding.deliverable, digest: "d".repeat(64) } })).toEqual([
      "deliverable_identity_changed",
    ]);
    expect(classifyCandidateDrift(binding, { ...binding, treeSha: "u".repeat(40) })).toEqual(["raw_tree_changed"]);
    expect(classifyCandidateDrift(binding, { ...binding, base: { ...binding.base, tipSha: "c".repeat(40) } })).toEqual(["base_tip_moved"]);
    expect(classifyCandidateDrift(binding, { ...binding, base: { ...binding.base, mergeBaseSha: "n".repeat(40) } })).toEqual([
      "merge_base_moved",
    ]);
    expect(classifyCandidateDrift(binding, { ...binding, workspaceId: "w".repeat(64) })).toEqual(["workspace_changed"]);
  });

  it("reports every class a rebase moves at once, in taxonomy order", () => {
    const rebased: CandidateBinding = {
      ...binding,
      treeSha: "u".repeat(40),
      deliverable: { ...binding.deliverable, digest: "d".repeat(64) },
      base: { ref: "origin/main", tipSha: "c".repeat(40), mergeBaseSha: "n".repeat(40) },
    };
    expect(classifyCandidateDrift(binding, rebased)).toEqual([
      "deliverable_identity_changed",
      "raw_tree_changed",
      "base_tip_moved",
      "merge_base_moved",
    ]);
  });

  it("reports no class for a differing base ref or identity token", () => {
    expect(classifyCandidateDrift(binding, { ...binding, base: { ...binding.base, ref: "origin/release" } })).toEqual([]);
    expect(classifyCandidateDrift(binding, { ...binding, deliverable: { ...binding.deliverable, identity: "other-tree/v1" } })).toEqual([]);
  });
});
