/**
 * The evidence record store, written before `records.ts` existed.
 *
 * Three properties carry this unit, and each is asserted where it can actually
 * fail rather than where it is convenient:
 *
 *   1. IDENTITY is a closed tuple. The evidence variant is pinned member by
 *      member — every one of the seven members moves `recordId`, and a change
 *      confined to the payload does not. The waiver variant is pinned the same
 *      way from the other side: it carries no provider triple, so two waivers
 *      for one obligation on one candidate collide by construction.
 *   2. PUBLICATION is atomic under REAL concurrency. Two processes inside one
 *      interpreter prove nothing about `link()`; these tests spawn actual node
 *      child processes through `node:child_process`, released against a shared
 *      wall-clock barrier, and assert on what is left on disk afterwards. The
 *      crash window between `fsync` and `link()` is exercised by killing a
 *      child inside it.
 *   3. STORAGE is worktree-private. Proven with real `git worktree add` in real
 *      temporary repositories: a record published from one worktree is not
 *      discoverable from another, and the two workspaces do not share an id.
 *
 * Falsification rows sit beside the properties they guard: corrupting a record
 * after publication must be flagged, and the three quarantine classes must stay
 * distinguishable — a store that reported one class for everything would let a
 * tampered record hide behind a truncated write.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { BlockedError } from "./blockers.ts";
import { canonicalize } from "./canonical.ts";
import { sha256Hex } from "./digest.ts";
import {
  RECORDS_LEAF,
  RECORD_SCHEMA_VERSION,
  computeRecordId,
  discoverRecords,
  publishRecord,
  recordFileName,
  resolveRecordStorage,
} from "./records.ts";
import type { EvidenceResolution, PublishRecordInput, RecordCandidateBinding } from "./records.types.ts";

const run = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RECORDS_MODULE = path.join(REPO_ROOT, "packages/kernel/src/records.ts");
const BLOCKERS_MODULE = path.join(REPO_ROOT, "packages/kernel/src/blockers.ts");

// ── Fixtures ───────────────────────────────────────────────────────────────

const BINDING: RecordCandidateBinding = {
  treeSha: "a".repeat(40),
  deliverableDigest: "b".repeat(64),
  identityToken: "deliverable-tree/v1",
  baseRef: "origin/main",
  baseTipSha: "c".repeat(40),
  mergeBaseSha: "d".repeat(40),
  workspaceId: "e".repeat(64),
};

const RESOLUTION: EvidenceResolution = {
  kind: "evidence",
  providerId: "claude-code.ce-code-review",
  runId: "run-0001",
  finalPassId: "pass-3",
  manifestDigest: "f".repeat(64),
};

const EVIDENCE: PublishRecordInput = {
  gateId: "delivery",
  obligationId: "review.green",
  candidateBinding: BINDING,
  resolution: RESOLUTION,
};

/** The same evidence record with only its payload moved — identity is unchanged. */
const REPAID: PublishRecordInput = {
  ...EVIDENCE,
  resolution: { ...RESOLUTION, manifestDigest: "0".repeat(64) },
};

const WAIVER: PublishRecordInput = {
  gateId: "delivery",
  obligationId: "review.green",
  candidateBinding: BINDING,
  resolution: { kind: "waiver", scope: "invocation" },
};

const WORKSPACE = "9".repeat(64);

// ── Temp repositories ──────────────────────────────────────────────────────

function tempDir(label: string): string {
  // Realpath because macOS hands out `/var` symlinks for `/private/var`, and a
  // workspace id derived from an unresolved path would differ from the one git
  // reports for the same directory.
  return realpathSync(mkdtempSync(path.join(tmpdir(), `dh-${label}-`)));
}

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

/** A real repository with one commit — enough for `git worktree add`. */
async function tempRepo(label = "repo"): Promise<string> {
  const dir = tempDir(label);
  await git(dir, "init", "--quiet", "--initial-branch", "main");
  await git(dir, "config", "user.email", "harness@example.invalid");
  await git(dir, "config", "user.name", "Delivery Harness");
  await git(dir, "commit", "--quiet", "--allow-empty", "-m", "root");
  return dir;
}

/** A storage root that needs no repository — the direct-injection seam. */
function tempStorageRoot(label = "store"): string {
  return path.join(tempDir(label), "delivery-harness");
}

// ── Subprocess harness ─────────────────────────────────────────────────────

interface ChildOutcome {
  readonly status?: string;
  readonly recordId?: string;
  readonly path?: string;
  readonly blocked?: string;
  readonly exitCode: number;
}

/**
 * The racer. Written to a temp file rather than kept as a fixture in the
 * package so that it cannot drift into being imported by production code, and
 * so that the module under test is reached the way an external caller reaches
 * it — by path, in a fresh interpreter.
 */
const CHILD_SOURCE = `
const { publishRecord } = await import(process.env["DH_RECORDS_MODULE"]);
const { BlockedError } = await import(process.env["DH_BLOCKERS_MODULE"]);

const job = JSON.parse(process.argv[2]);
if (typeof job.startAt === "number") {
  const wait = job.startAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

try {
  const result = await publishRecord(job.rootDir, job.input, {
    storageRoot: job.storageRoot,
    ...(job.crash === true ? { beforeLink: () => process.exit(9) } : {}),
  });
  process.stdout.write(JSON.stringify({ status: result.status, recordId: result.record.recordId, path: result.path }));
} catch (error) {
  if (error instanceof BlockedError) {
    process.stdout.write(JSON.stringify({ blocked: error.blockers[0].code }));
  } else {
    process.stdout.write(JSON.stringify({ blocked: "unexpected:" + String(error && error.message) }));
  }
}
`;

let childScript = "";

beforeAll(() => {
  childScript = path.join(tempDir("child"), "publish-child.mts");
  writeFileSync(childScript, CHILD_SOURCE, "utf8");
});

async function spawnPublisher(job: Record<string, unknown>): Promise<ChildOutcome> {
  try {
    const { stdout } = await run(process.execPath, ["--import", "tsx", childScript, JSON.stringify(job)], {
      cwd: REPO_ROOT,
      env: { ...process.env, DH_RECORDS_MODULE: RECORDS_MODULE, DH_BLOCKERS_MODULE: BLOCKERS_MODULE },
    });
    return { ...(JSON.parse(stdout.trim() || "{}") as Record<string, unknown>), exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    const stdout = (failure.stdout ?? "").trim();
    return { ...(stdout === "" ? {} : (JSON.parse(stdout) as Record<string, unknown>)), exitCode: failure.code ?? -1 };
  }
}

function jsonFilesIn(dir: string): readonly string[] {
  return readdirSync(dir).filter((entry) => entry.endsWith(".json"));
}

function blockerCodeOf(thrown: unknown): string {
  expect(thrown).toBeInstanceOf(BlockedError);
  const blockers = (thrown as BlockedError).blockers;
  expect(blockers.length).toBeGreaterThan(0);
  return blockers[0]!.code;
}

async function captureBlocker(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return blockerCodeOf(error);
  }
  throw new Error("expected the store to block, but the call resolved");
}

// ── Storage resolution ─────────────────────────────────────────────────────

describe("storage resolution", () => {
  it("resolves the records directory under the git directory, never the worktree", async () => {
    const repo = await tempRepo();
    const { storageRoot, storageDir, workspaceId } = await resolveRecordStorage(repo);

    expect(storageRoot).toBe(path.join(repo, ".git", "delivery-harness"));
    expect(storageDir).toBe(path.join(storageRoot, RECORDS_LEAF));
    // Git-private: the store is inside `.git`, which no working tree tracks.
    expect(storageDir.startsWith(path.join(repo, ".git") + path.sep)).toBe(true);
    expect(workspaceId).toBe(sha256Hex(canonicalize(storageRoot)));
  });

  it("normalizes a namespace whether or not the config spelled a trailing slash", async () => {
    const repo = await tempRepo();
    const withSlash = await resolveRecordStorage(repo, { storageNamespace: "evidence/" });
    const withoutSlash = await resolveRecordStorage(repo, { storageNamespace: "evidence" });

    expect(withSlash.storageDir).toBe(withoutSlash.storageDir);
    expect(withSlash.workspaceId).toBe(withoutSlash.workspaceId);
    expect(withSlash.storageDir).toBe(path.join(repo, ".git", "evidence", RECORDS_LEAF));
  });

  it("derives the workspace id from the namespace root, so every leaf shares one workspace", async () => {
    const repo = await tempRepo();
    const records = await resolveRecordStorage(repo);
    const receipts = await resolveRecordStorage(repo, { leaf: "receipts" });

    expect(receipts.storageDir).toBe(path.join(records.storageRoot, "receipts"));
    expect(receipts.workspaceId).toBe(records.workspaceId);
  });

  it("blocks with a typed store blocker outside a repository", async () => {
    const notARepo = tempDir("bare");
    const code = await captureBlocker(() => resolveRecordStorage(notARepo));
    expect(code).toBe("record_store_unresolved");
  });

  it("accepts an injected storage root without consulting git at all", async () => {
    const storageRoot = tempStorageRoot();
    const resolved = await resolveRecordStorage(path.join(storageRoot, "..", "nowhere"), { storageRoot });

    expect(resolved.storageRoot).toBe(storageRoot);
    expect(resolved.workspaceId).toBe(sha256Hex(canonicalize(storageRoot)));
  });
});

// ── Identity ───────────────────────────────────────────────────────────────

describe("record identity — evidence variant", () => {
  const baseline = computeRecordId(WORKSPACE, EVIDENCE);

  it("is a lowercase-hex sha256 over the canonical identity tuple", () => {
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline).toBe(
      sha256Hex(
        canonicalize({
          workspaceId: WORKSPACE,
          gateId: EVIDENCE.gateId,
          obligationId: EVIDENCE.obligationId,
          candidateBinding: BINDING,
          providerId: "claude-code.ce-code-review",
          runId: "run-0001",
          finalPassId: "pass-3",
        }),
      ),
    );
  });

  const tupleMutations: readonly (readonly [string, () => string])[] = [
    ["workspaceId", () => computeRecordId("8".repeat(64), EVIDENCE)],
    ["gateId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, gateId: "other-gate" })],
    ["obligationId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, obligationId: "review.other" })],
    ["providerId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, resolution: { ...RESOLUTION, providerId: "other-provider" } })],
    ["runId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, resolution: { ...RESOLUTION, runId: "run-0002" } })],
    ["finalPassId", () => computeRecordId(WORKSPACE, { ...EVIDENCE, resolution: { ...RESOLUTION, finalPassId: "pass-4" } })],
  ];

  for (const [member, mutate] of tupleMutations) {
    it(`moves when the tuple member "${member}" moves`, () => {
      expect(mutate()).not.toBe(baseline);
    });
  }

  const bindingMembers: readonly (readonly [keyof RecordCandidateBinding, string])[] = [
    ["treeSha", "1".repeat(40)],
    ["deliverableDigest", "2".repeat(64)],
    ["identityToken", "deliverable-tree/v2"],
    ["baseRef", "origin/release"],
    ["baseTipSha", "3".repeat(40)],
    ["mergeBaseSha", "4".repeat(40)],
    ["workspaceId", "5".repeat(64)],
  ];

  for (const [member, replacement] of bindingMembers) {
    it(`moves when the candidate binding member "${member}" moves`, () => {
      const moved = computeRecordId(WORKSPACE, {
        ...EVIDENCE,
        candidateBinding: { ...BINDING, [member]: replacement },
      });
      expect(moved).not.toBe(baseline);
    });
  }

  it("every mutation above produces a distinct id — no two collapse onto each other", () => {
    const ids = new Set<string>([baseline]);
    for (const [, mutate] of tupleMutations) ids.add(mutate());
    for (const [member, replacement] of bindingMembers) {
      ids.add(computeRecordId(WORKSPACE, { ...EVIDENCE, candidateBinding: { ...BINDING, [member]: replacement } }));
    }
    expect(ids.size).toBe(1 + tupleMutations.length + bindingMembers.length);
  });

  it("does not move when only the payload moves — that is what makes republish a conflict", () => {
    expect(computeRecordId(WORKSPACE, REPAID)).toBe(baseline);
  });
});

describe("record identity — waiver variant", () => {
  it("carries no provider triple, so it is idempotent per candidate by construction", () => {
    const invocation = computeRecordId(WORKSPACE, WAIVER);
    const durable = computeRecordId(WORKSPACE, {
      ...WAIVER,
      resolution: { kind: "waiver", scope: "durable" },
    });

    expect(invocation).toBe(durable);
    expect(invocation).toBe(
      sha256Hex(
        canonicalize({
          workspaceId: WORKSPACE,
          gateId: WAIVER.gateId,
          obligationId: WAIVER.obligationId,
          candidateBinding: BINDING,
          kind: "waiver",
        }),
      ),
    );
  });

  it("is distinct from the evidence variant for the same coordinates", () => {
    expect(computeRecordId(WORKSPACE, WAIVER)).not.toBe(computeRecordId(WORKSPACE, EVIDENCE));
  });

  it("moves with the candidate binding, so a waiver never survives a new candidate", () => {
    const moved = computeRecordId(WORKSPACE, {
      ...WAIVER,
      candidateBinding: { ...BINDING, deliverableDigest: "7".repeat(64) },
    });
    expect(moved).not.toBe(computeRecordId(WORKSPACE, WAIVER));
  });
});

// ── Publication ────────────────────────────────────────────────────────────

describe("publication", () => {
  it("writes one content-addressed file with 0700/0600 modes", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });

    expect(published.status).toBe("published");
    expect(published.record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(published.record.recordId).toBe(computeRecordId(published.record.workspaceId, EVIDENCE));
    expect(path.basename(published.path)).toBe(
      recordFileName(EVIDENCE.gateId, EVIDENCE.obligationId, published.record.recordId),
    );

    expect(statSync(path.dirname(published.path)).mode & 0o777).toBe(0o700);
    expect(statSync(published.path).mode & 0o777).toBe(0o600);

    const onDisk = JSON.parse(readFileSync(published.path, "utf8")) as Record<string, unknown>;
    expect(onDisk["recordId"]).toBe(published.record.recordId);
    expect(onDisk["workspaceId"]).toBe(published.record.workspaceId);
  });

  it("leaves no temporary file behind", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    expect(readdirSync(path.dirname(published.path))).toEqual([path.basename(published.path)]);
  });

  it("is idempotent for a byte-identical resubmission", async () => {
    const storageRoot = tempStorageRoot();
    const first = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const second = await publishRecord(storageRoot, EVIDENCE, { storageRoot });

    expect(second.status).toBe("idempotent");
    expect(second.record.recordId).toBe(first.record.recordId);
    expect(second.path).toBe(first.path);
    expect(jsonFilesIn(path.dirname(first.path))).toHaveLength(1);
  });

  it("rejects the same identity carrying different content", async () => {
    const storageRoot = tempStorageRoot();
    await publishRecord(storageRoot, EVIDENCE, { storageRoot });

    const code = await captureBlocker(() => publishRecord(storageRoot, REPAID, { storageRoot }));
    expect(code).toBe("record_conflict");
  });

  it("treats a repeated waiver for one candidate as idempotent", async () => {
    const storageRoot = tempStorageRoot();
    const first = await publishRecord(storageRoot, WAIVER, { storageRoot });
    const second = await publishRecord(storageRoot, WAIVER, { storageRoot });

    expect(first.status).toBe("published");
    expect(second.status).toBe("idempotent");
    expect(jsonFilesIn(path.dirname(first.path))).toHaveLength(1);
  });

  it("rejects a second waiver whose scope disagrees with the stored one", async () => {
    const storageRoot = tempStorageRoot();
    await publishRecord(storageRoot, WAIVER, { storageRoot });

    const code = await captureBlocker(() =>
      publishRecord(storageRoot, { ...WAIVER, resolution: { kind: "waiver", scope: "durable" } }, { storageRoot }),
    );
    expect(code).toBe("record_conflict");
  });

  it("rejects an existing file at the slot that cannot be parsed at all", async () => {
    const storageRoot = tempStorageRoot();
    const { storageDir, workspaceId } = await resolveRecordStorage(storageRoot, { storageRoot });
    const recordId = computeRecordId(workspaceId, EVIDENCE);

    // Publish once to create the directory, then squat the slot with garbage.
    await publishRecord(storageRoot, WAIVER, { storageRoot });
    writeFileSync(path.join(storageDir, recordFileName(EVIDENCE.gateId, EVIDENCE.obligationId, recordId)), "{ not json");

    const code = await captureBlocker(() => publishRecord(storageRoot, EVIDENCE, { storageRoot }));
    expect(code).toBe("record_conflict");
  });

  it("blocks with a typed blocker when the storage directory cannot be created", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits this asserts on
    const parent = tempDir("readonly");
    chmodSync(parent, 0o500);
    try {
      const code = await captureBlocker(() =>
        publishRecord(parent, EVIDENCE, { storageRoot: path.join(parent, "delivery-harness") }),
      );
      expect(code).toBe("record_store_unwritable");
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

// ── Discovery ──────────────────────────────────────────────────────────────

describe("discovery", () => {
  const selector = { gateId: EVIDENCE.gateId, obligationId: EVIDENCE.obligationId };

  it("returns nothing, and does not throw, before anything has been published", async () => {
    const storageRoot = tempStorageRoot();
    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });

    expect(found.records).toEqual([]);
    expect(found.quarantined).toEqual([]);
  });

  it("finds records for the selected obligation and ignores the neighbours", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    await publishRecord(storageRoot, { ...EVIDENCE, obligationId: "review.other" }, { storageRoot });
    writeFileSync(path.join(path.dirname(published.path), "notes.txt"), "not a record");

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });

    expect(found.records.map((record) => record.recordId)).toEqual([published.record.recordId]);
    expect(found.quarantined).toEqual([]);
    expect(found.ignored.map((entry) => path.basename(entry.path))).toContain("notes.txt");
  });

  it("distinguishes byte corruption from a tampered identity from a malformed shape", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const dir = path.dirname(published.path);

    // (1) truncated write — the JSON parser is what fails.
    writeFileSync(published.path, readFileSync(published.path, "utf8").slice(0, 40));
    // (2) valid JSON, wrong shape.
    const shapePath = path.join(dir, recordFileName(selector.gateId, selector.obligationId, "1".repeat(64)));
    writeFileSync(shapePath, JSON.stringify({ schemaVersion: RECORD_SCHEMA_VERSION, recordId: "1".repeat(64) }));
    // (3) valid shape, tampered member, original id retained.
    const tampered = { ...published.record, candidateBinding: { ...BINDING, treeSha: "9".repeat(40) } };
    const tamperedPath = path.join(dir, recordFileName(selector.gateId, selector.obligationId, "2".repeat(64)));
    writeFileSync(tamperedPath, JSON.stringify({ ...tampered, recordId: "2".repeat(64) }));

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });

    expect(found.records).toEqual([]);
    const reasons = new Map(found.quarantined.map((entry) => [path.basename(entry.path), entry.reason]));
    expect(reasons.get(path.basename(published.path))).toBe("corrupt_json");
    expect(reasons.get(path.basename(shapePath))).toBe("malformed_shape");
    expect(reasons.get(path.basename(tamperedPath))).toBe("identity_mismatch");
    expect(new Set(found.quarantined.map((entry) => entry.reason)).size).toBe(3);
  });

  it("quarantines a record whose filename does not carry its own id", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const wrongSlot = path.join(
      path.dirname(published.path),
      recordFileName(selector.gateId, selector.obligationId, "3".repeat(64)),
    );
    writeFileSync(wrongSlot, readFileSync(published.path, "utf8"));

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });
    expect(found.quarantined.map((entry) => entry.reason)).toEqual(["identity_mismatch"]);
    expect(found.records).toHaveLength(1);
  });

  it("quarantines a record carrying another workspace's id", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    const foreign = { ...published.record, workspaceId: "c".repeat(64) };
    writeFileSync(published.path, JSON.stringify(foreign));

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });
    expect(found.records).toEqual([]);
    expect(found.quarantined[0]?.reason).toBe("identity_mismatch");
  });

  it("falsification: a record corrupted after publication is flagged, not silently dropped", async () => {
    const storageRoot = tempStorageRoot();
    const published = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    writeFileSync(published.path, "}}}");

    const found = await discoverRecords(storageRoot, { ...selector, storageRoot });
    expect(found.records).toEqual([]);
    expect(found.quarantined).toHaveLength(1);
    expect(found.quarantined[0]?.path).toBe(published.path);
  });
});

// ── Real subprocess concurrency ────────────────────────────────────────────

describe("concurrency, in real child processes", () => {
  const RACERS = 6;

  it("admits exactly one publisher when identical records race", async () => {
    const storageRoot = tempStorageRoot("race");
    const startAt = Date.now() + 700;
    const outcomes = await Promise.all(
      Array.from({ length: RACERS }, () =>
        spawnPublisher({ rootDir: storageRoot, storageRoot, input: EVIDENCE, startAt }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "published")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "idempotent")).toHaveLength(RACERS - 1);

    const found = await discoverRecords(storageRoot, {
      gateId: EVIDENCE.gateId,
      obligationId: EVIDENCE.obligationId,
      storageRoot,
    });
    expect(found.records).toHaveLength(1);
    expect(found.quarantined).toEqual([]);
    expect(readdirSync(path.join(storageRoot, RECORDS_LEAF))).toHaveLength(1);
  }, 60_000);

  it("admits exactly one publisher, and blocks the rest, when contents disagree", async () => {
    const storageRoot = tempStorageRoot("conflict-race");
    const startAt = Date.now() + 700;
    const outcomes = await Promise.all(
      Array.from({ length: RACERS }, (_unused, index) =>
        spawnPublisher({
          rootDir: storageRoot,
          storageRoot,
          input: index % 2 === 0 ? EVIDENCE : REPAID,
          startAt,
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "published")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.blocked === "record_conflict").length).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes) {
      expect(outcome.status ?? outcome.blocked).toMatch(/^(published|idempotent|record_conflict)$/);
    }

    const dir = path.join(storageRoot, RECORDS_LEAF);
    expect(jsonFilesIn(dir)).toHaveLength(1);
    const found = await discoverRecords(storageRoot, {
      gateId: EVIDENCE.gateId,
      obligationId: EVIDENCE.obligationId,
      storageRoot,
    });
    expect(found.records).toHaveLength(1);
  }, 60_000);

  it("survives a crash inside the window between fsync and link", async () => {
    const storageRoot = tempStorageRoot("crash");
    const crashed = await spawnPublisher({ rootDir: storageRoot, storageRoot, input: EVIDENCE, crash: true });
    expect(crashed.exitCode).toBe(9);

    const dir = path.join(storageRoot, RECORDS_LEAF);
    const leftovers = readdirSync(dir);
    expect(leftovers).toHaveLength(1); // the orphaned temporary
    expect(jsonFilesIn(dir)).toEqual([]);

    // The orphan is invisible to readers: not a record, and not a quarantine.
    const selector = { gateId: EVIDENCE.gateId, obligationId: EVIDENCE.obligationId, storageRoot };
    const afterCrash = await discoverRecords(storageRoot, selector);
    expect(afterCrash.records).toEqual([]);
    expect(afterCrash.quarantined).toEqual([]);

    // And it does not block the next publisher.
    const republished = await publishRecord(storageRoot, EVIDENCE, { storageRoot });
    expect(republished.status).toBe("published");
    const afterRepublish = await discoverRecords(storageRoot, selector);
    expect(afterRepublish.records).toHaveLength(1);
    expect(afterRepublish.quarantined).toEqual([]);
  }, 60_000);
});

// ── Worktree privacy ───────────────────────────────────────────────────────

describe("linked worktrees", () => {
  it("cannot see each other's records", async () => {
    const repo = await tempRepo("main-worktree");
    const linked = path.join(tempDir("linked"), "wt");
    await git(repo, "worktree", "add", "--quiet", "-b", "feature", linked);

    const main = await resolveRecordStorage(repo);
    const other = await resolveRecordStorage(linked);

    expect(other.storageDir).not.toBe(main.storageDir);
    expect(other.workspaceId).not.toBe(main.workspaceId);

    await publishRecord(repo, EVIDENCE, {});
    const selector = { gateId: EVIDENCE.gateId, obligationId: EVIDENCE.obligationId };

    expect((await discoverRecords(repo, selector)).records).toHaveLength(1);
    expect((await discoverRecords(linked, selector)).records).toEqual([]);
    expect((await discoverRecords(linked, selector)).quarantined).toEqual([]);
  }, 60_000);

  it("scopes record identity by workspace, so the same input yields different ids", async () => {
    const repo = await tempRepo("scoped");
    const linked = path.join(tempDir("linked-scoped"), "wt");
    await git(repo, "worktree", "add", "--quiet", "-b", "scoped-feature", linked);

    const here = await publishRecord(repo, EVIDENCE, {});
    const there = await publishRecord(linked, EVIDENCE, {});

    expect(there.record.recordId).not.toBe(here.record.recordId);
    expect(there.record.workspaceId).not.toBe(here.record.workspaceId);
  }, 60_000);
});
