/**
 * The deliverable identity is checked against Athena, not against itself.
 *
 * `deliverable-tree/v1` is a name Athena already owns. Review evidence in that
 * repository is bound to digests its implementation produced, so a digest here
 * that differs by one byte under the same token would invalidate those bindings
 * while every test in this file that only compared the port to its own output
 * went on passing. That is why the corpus in
 * `packages/conformance/fixtures/identity-goldens/` carries expectations that
 * were *captured* from Athena's `computeDeliverableTreeIdentity` before this
 * module existed, over real repositories built from the recipes stored beside
 * them — and why each golden pins the tree sha as well, so a digest mismatch
 * can never be blamed on a tree that was built differently.
 *
 * THE CONTROLS ARE THE POINT OF THE ORDERING TESTS. A sort assertion that only
 * says "the digest is what the digest is" proves nothing. Every ordering claim
 * below is therefore paired with a comparator that would have produced a
 * different answer — `localeCompare`, whose result depends on the host's ICU
 * build, and UTF-8 byte order, which disagrees with UTF-16 code-unit order
 * exactly on astral paths. Both are computed here and both must diverge from
 * the golden, so a port that quietly adopted either would be caught.
 *
 * WHERE REAL REPOSITORIES ARE USED, AND WHERE A DOUBLE IS. Every digest comes
 * from a real `git ls-tree` over a real repository, because the NUL stream and
 * its mode column are the subject. The command runner is injected only for the
 * two failures a healthy repository will not produce on demand: a git
 * invocation that fails, and a listing whose records are malformed.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildGoldenTree,
  loadIdentityGoldens,
  type GoldenNeutralMatcher,
  type IdentityGolden,
} from "../../conformance/fixtures/identity-goldens/index.ts";
import { BlockedError, GATE_STRUCTURAL_FINDING_CODES } from "./blockers.ts";
import type { CandidateCommandRunner } from "./candidate.ts";
import type { ComputeIdentity } from "./candidate.types.ts";
import {
  DELIVERABLE_TREE_V1,
  DELIVERABLE_TREE_V1_NARRATION_SET,
  defineHarnessConfig,
  type HarnessConfig,
  type HarnessConfigInput,
  type NeutralMatcher,
} from "./config.ts";
import {
  IDENTITY_DOMAIN,
  computeDeliverableIdentity,
  digestDeliverableEntries,
  identityDefinitionOf,
  isRecordNeutralPath,
  isReviewNeutralPath,
  parseTreeEntries,
  withDeliverableIdentity,
  type DeliverableTreeEntry,
} from "./identity.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

const createdRoots: string[] = [];

afterAll(async () => {
  await Promise.all(createdRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  // The realpath matters on macOS, where the temporary directory is reached
  // through a symlink and git reports the resolved path.
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "harness-identity-"));
  createdRoots.push(root);
  return root;
}

/**
 * A configuration whose neutral set and identity token are whatever the caller
 * needs. The two are supplied together because the config loader refuses to
 * separate them — claiming `deliverable-tree/v1` requires that token's
 * narration set, and declaring that set requires the token.
 */
function testConfig(overrides: Partial<HarnessConfigInput> = {}): HarnessConfig {
  return defineHarnessConfig({
    gateId: "test.gate",
    acceptedEnvelopeSpecs: ["delivery-evidence/1"],
    identityVersions: [DELIVERABLE_TREE_V1],
    computingIdentityVersion: DELIVERABLE_TREE_V1,
    reviewNeutral: [...DELIVERABLE_TREE_V1_NARRATION_SET],
    recordNeutral: [{ prefix: "telemetry/delivery-runs/" }],
    pathClassification: {
      generated: [{ kind: "prefix", value: "generated/" }],
      test: [{ kind: "glob", value: "**/*.test.ts" }],
      lockfile: [{ kind: "glob", value: "**/package-lock.json" }],
    },
    sensitivePaths: [],
    activationThreshold: 50,
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
    deliveryRecordPath: "telemetry/delivery-runs/gate-record.json",
    ...overrides,
  });
}

/** A config under a consumer-owned token, which is the only way to vary the neutral set. */
function consumerConfig(reviewNeutral: readonly NeutralMatcher[], recordNeutral: readonly NeutralMatcher[], deliveryRecordPath: string): HarnessConfig {
  return testConfig({
    identityVersions: ["delivery-harness-tree/v1"],
    computingIdentityVersion: "delivery-harness-tree/v1",
    reviewNeutral: [...reviewNeutral],
    recordNeutral: [...recordNeutral],
    deliveryRecordPath,
  });
}

const goldens = loadIdentityGoldens();

function golden(name: string): IdentityGolden {
  const found = goldens.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no golden named ${name}`);
  return found;
}

function asMatchers(matchers: readonly GoldenNeutralMatcher[]): readonly NeutralMatcher[] {
  return matchers.map((matcher) => (matcher.suffix === undefined ? { prefix: matcher.prefix } : { prefix: matcher.prefix, suffix: matcher.suffix }));
}

/**
 * Builds a golden's tree in a fresh repository and returns both the tree sha
 * git produced and the digest this module computes for it.
 */
async function observeGolden(entry: IdentityGolden, config?: HarnessConfig): Promise<{ readonly treeSha: string; readonly digest: string; readonly rootDir: string }> {
  const rootDir = await makeRoot();
  const treeSha = await buildGoldenTree(entry, rootDir);
  const digest = await computeDeliverableIdentity({
    rootDir,
    treeSha,
    config: config ?? testConfig(),
  });
  return { treeSha, digest, rootDir };
}

// ── The Athena goldens ─────────────────────────────────────────────────────

describe("goldens captured from Athena", () => {
  it("names every tree shape the token has to survive", () => {
    expect(goldens.map((entry) => entry.name)).toEqual([
      "empty-tree",
      "mode-variants",
      "mode-variants-exec-flipped",
      "unicode-and-newline-paths",
      "nested-neutral-prefix",
      "nested-neutral-prefix-stripped",
      "neutral-boundaries",
      "ordering-case-and-punctuation",
    ]);
  });

  it("computes each golden's digest under the neutral set the golden was captured with", async () => {
    for (const entry of goldens) {
      expect(entry.identityToken).toBe(DELIVERABLE_TREE_V1);
      expect(asMatchers(entry.reviewNeutral)).toEqual([...DELIVERABLE_TREE_V1_NARRATION_SET]);

      const observed = await observeGolden(entry);
      // The tree sha first: if the recipe built a different tree, the digest
      // comparison below would be reporting the wrong failure.
      expect(`${entry.name}: ${observed.treeSha}`).toBe(`${entry.name}: ${entry.expected.treeSha}`);
      expect(`${entry.name}: ${observed.digest}`).toBe(`${entry.name}: ${entry.expected.digest}`);
    }
  });

  it("hashes the empty tree as the domain separator alone", async () => {
    const observed = await observeGolden(golden("empty-tree"));
    // Not the digest of nothing: a deliverable with no entries still says which
    // function produced it.
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(`${IDENTITY_DOMAIN}\u0000${DELIVERABLE_TREE_V1}\u0000`).digest("hex");
    expect(observed.digest).toBe(expected);
    expect(observed.digest).toBe(golden("empty-tree").expected.digest);
  });

  it("reads the file mode, so making a script executable changes the deliverable", async () => {
    const plain = await observeGolden(golden("mode-variants"));
    const executable = await observeGolden(golden("mode-variants-exec-flipped"));
    expect(plain.treeSha).not.toBe(executable.treeSha);
    expect(plain.digest).not.toBe(executable.digest);
  });

  it("leaves the digest unchanged when only neutral paths differ, while the tree sha moves", async () => {
    const withNarration = await observeGolden(golden("nested-neutral-prefix"));
    const withoutNarration = await observeGolden(golden("nested-neutral-prefix-stripped"));
    expect(withNarration.treeSha).not.toBe(withoutNarration.treeSha);
    expect(withNarration.digest).toBe(withoutNarration.digest);
  });
});

// ── Ordering, with the comparators that would have been wrong ──────────────

/**
 * The digest stream, recomputed here with a comparator the caller chooses. It
 * exists so an ordering claim can be stated against an alternative rather than
 * against itself: the production module has no comparator seam, deliberately,
 * because the ordering is part of what the token means.
 */
async function digestWithComparator(entries: readonly DeliverableTreeEntry[], token: string, compare: (left: string, right: string) => number): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  hash.update(`${IDENTITY_DOMAIN}\u0000${token}\u0000`);
  for (const entry of [...entries].sort((left, right) => compare(left.path, right.path))) {
    hash.update(`${entry.mode}\u0000${entry.objectSha}\u0000${entry.path}\u0000`);
  }
  return hash.digest("hex");
}

function entriesOf(entry: IdentityGolden): readonly DeliverableTreeEntry[] {
  // Object shas are irrelevant to ordering, so the recipe's own index is used
  // as a stand-in; only the paths and the comparator are under test here.
  return entry.entries.map((tree, index) => ({ mode: tree.mode, objectSha: `${index}`.padStart(40, "0"), path: tree.path }));
}

describe("entry ordering", () => {
  it("sorts by UTF-16 code unit, which localeCompare would not have done", async () => {
    const entry = golden("ordering-case-and-punctuation");
    const entries = entriesOf(entry);
    const codeUnits = await digestWithComparator(entries, entry.identityToken, (left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const collated = await digestWithComparator(entries, entry.identityToken, (left, right) => left.localeCompare(right));

    expect(digestDeliverableEntries(entries, identityDefinitionOf(testConfig()))).toBe(codeUnits);
    // The control: a collator is locale- and ICU-dependent, so if the module
    // used one, this corpus would digest two ways on two machines.
    expect(collated).not.toBe(codeUnits);
  });

  it("sorts astral paths by code unit, which UTF-8 byte order would not have done", async () => {
    const entry = golden("unicode-and-newline-paths");
    const entries = entriesOf(entry);
    const codeUnits = await digestWithComparator(entries, entry.identityToken, (left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const utf8Bytes = await digestWithComparator(entries, entry.identityToken, (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));

    expect(digestDeliverableEntries(entries, identityDefinitionOf(testConfig()))).toBe(codeUnits);
    // U+1F600's leading surrogate 0xD83D sorts below the fullwidth U+FF26,
    // while its UTF-8 bytes sort above them. Athena's answer is the first.
    expect(utf8Bytes).not.toBe(codeUnits);
  });
});

// ── Domain separation ──────────────────────────────────────────────────────

describe("identity token", () => {
  it("separates the domain, so the same tree under a different token is a different digest", () => {
    const entries = entriesOf(golden("mode-variants"));
    const v1 = digestDeliverableEntries(entries, { identityToken: DELIVERABLE_TREE_V1, reviewNeutral: [...DELIVERABLE_TREE_V1_NARRATION_SET] });
    const consumer = digestDeliverableEntries(entries, { identityToken: "delivery-harness-tree/v1", reviewNeutral: [...DELIVERABLE_TREE_V1_NARRATION_SET] });
    expect(consumer).not.toBe(v1);
  });

  it("cannot be varied alone in a loaded config, because the token binds the set", () => {
    // The other half of the biconditional, restated here because it is what
    // makes the token-only test above a statement about configs rather than a
    // curiosity about a function: a consumer token may not claim the v1
    // narration set, and the v1 token may not claim anything else.
    expect(() =>
      consumerConfig([...DELIVERABLE_TREE_V1_NARRATION_SET], [{ prefix: "telemetry/delivery-runs/" }], "telemetry/delivery-runs/gate-record.json"),
    ).toThrow(BlockedError);
    expect(() => testConfig({ reviewNeutral: [{ prefix: "docs/" }], recordNeutral: [{ prefix: "docs/" }], deliveryRecordPath: "docs/record.json" })).toThrow(BlockedError);
  });

  it("takes the token from the config the request carries", async () => {
    // `mode-variants` touches neither neutral set — no `docs/`, no
    // `telemetry/`, nothing under `nothing-here/` — so the two configs filter
    // out exactly the same entries (none) and the token is the only difference
    // left to explain the digests.
    const entry = golden("mode-variants");
    const v1Config = testConfig();
    const consumer = consumerConfig([{ prefix: "nothing-here/" }], [{ prefix: "nothing-here/" }], "nothing-here/record.json");
    for (const tree of entry.entries) {
      expect(isReviewNeutralPath(v1Config, tree.path)).toBe(false);
      expect(isReviewNeutralPath(consumer, tree.path)).toBe(false);
    }

    const underV1 = await observeGolden(entry, v1Config);
    const underConsumer = await observeGolden(entry, consumer);
    expect(underConsumer.treeSha).toBe(underV1.treeSha);
    expect(underV1.digest).toBe(entry.expected.digest);
    expect(underConsumer.digest).not.toBe(underV1.digest);
  });
});

// ── The two neutral predicates ─────────────────────────────────────────────

describe("neutral predicates", () => {
  const NARRATION = "docs/reports/2026/08/landed-change.html";
  const RECORD = "telemetry/delivery-runs/gate-record.json";

  it("classifies a review-neutral path that is not record-neutral independently by each predicate", () => {
    const config = testConfig();
    expect(isReviewNeutralPath(config, NARRATION)).toBe(true);
    expect(isRecordNeutralPath(config, NARRATION)).toBe(false);
    expect(isReviewNeutralPath(config, RECORD)).toBe(true);
    expect(isRecordNeutralPath(config, RECORD)).toBe(true);
    expect(isReviewNeutralPath(config, "src/app.ts")).toBe(false);
    expect(isRecordNeutralPath(config, "src/app.ts")).toBe(false);
  });

  it("never lets recordNeutral reach the digest", async () => {
    const entry = golden("nested-neutral-prefix");
    // Two configs that differ only in `recordNeutral` — one covering a single
    // prefix, the other covering all three. Both are legal (record-neutral is a
    // subset of review-neutral in each) and both must digest identically.
    const narrow = await observeGolden(entry, testConfig({ recordNeutral: [{ prefix: "telemetry/delivery-runs/" }] }));
    const wide = await observeGolden(entry, testConfig({ recordNeutral: [...DELIVERABLE_TREE_V1_NARRATION_SET] }));
    expect(narrow.digest).toBe(wide.digest);
    expect(narrow.digest).toBe(entry.expected.digest);
  });

  it("holds the prefix boundary: docs/ does not exclude docs-internal/", () => {
    const config = consumerConfig([{ prefix: "docs/" }], [{ prefix: "docs/" }], "docs/record.json");
    expect(isReviewNeutralPath(config, "docs/x.md")).toBe(true);
    expect(isReviewNeutralPath(config, "docs-internal/x.md")).toBe(false);
  });

  it("honours a suffix matcher", () => {
    const config = consumerConfig([{ prefix: "telemetry/", suffix: ".json" }], [{ prefix: "telemetry/", suffix: ".json" }], "telemetry/record.json");
    expect(isReviewNeutralPath(config, "telemetry/x.json")).toBe(true);
    expect(isReviewNeutralPath(config, "telemetry/x.md")).toBe(false);
    expect(isReviewNeutralPath(config, "telemetry/nested/deep/x.json")).toBe(true);
  });

  it("rewrites no backslashes, so docs\\reports\\x.html stays in the deliverable", () => {
    const config = testConfig();
    expect(isReviewNeutralPath(config, "docs/reports/x.html")).toBe(true);
    expect(isReviewNeutralPath(config, "docs\\reports\\x.html")).toBe(false);
    expect(isReviewNeutralPath(config, "docs/reportsx.md")).toBe(false);
    expect(isReviewNeutralPath(config, "telemetry/delivery-runsX/x.json")).toBe(false);
  });

  it("changes the digest when the review-neutral set widens", async () => {
    const entry = golden("nested-neutral-prefix");
    const captured = await observeGolden(entry);
    expect(captured.digest).toBe(entry.expected.digest);

    // Widening the matcher to all of `docs/` swallows `docs/keep.md`, which is
    // reviewed content. The digest must move — a neutral set that could be
    // widened without changing the identity would be a set the identity does
    // not actually depend on.
    const widened = await observeGolden(
      entry,
      consumerConfig(
        [{ prefix: "docs/" }, { prefix: "telemetry/delivery-runs/" }],
        [{ prefix: "telemetry/delivery-runs/" }],
        "telemetry/delivery-runs/gate-record.json",
      ),
    );
    expect(widened.digest).not.toBe(captured.digest);

    // And it moves to exactly the digest of the tree with `docs/keep.md`
    // removed, under the same token — the widening is the whole difference.
    const stripped = digestDeliverableEntries(
      [{ mode: "100644", objectSha: await blobShaOf(captured.rootDir, "src/keep.ts"), path: "src/keep.ts" }],
      { identityToken: "delivery-harness-tree/v1", reviewNeutral: [{ prefix: "docs/" }, { prefix: "telemetry/delivery-runs/" }] },
    );
    expect(widened.digest).toBe(stripped);
  });
});

/** The object sha git recorded for one path of an already-built golden tree. */
async function blobShaOf(rootDir: string, repoPath: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("git", ["rev-parse", `:${repoPath}`], { cwd: rootDir, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout.trim());
    });
  });
}

// ── The NUL stream ─────────────────────────────────────────────────────────

describe("ls-tree parsing", () => {
  const config = testConfig();

  it("splits on NUL only, so a newline, a tab and a quote survive in a path", () => {
    const sha = "a".repeat(40);
    const output = `100644 blob ${sha}\tweird/line\nbreak.md\u0000100644 blob ${sha}\tweird/ta\tb.md\u0000100644 blob ${sha}\tweird/quo"te.md\u0000`;
    expect(parseTreeEntries(output, config)).toEqual([
      { mode: "100644", objectSha: sha, path: "weird/line\nbreak.md" },
      { mode: "100644", objectSha: sha, path: "weird/ta\tb.md" },
      { mode: "100644", objectSha: sha, path: 'weird/quo"te.md' },
    ]);
  });

  it("reads an empty listing as no entries rather than one blank entry", () => {
    expect(parseTreeEntries("", config)).toEqual([]);
  });

  it("takes the mode and the object sha, never the type column", () => {
    const output = `160000 commit ${"1".repeat(40)}\tvendor/sub\u0000`;
    expect(parseTreeEntries(output, config)).toEqual([{ mode: "160000", objectSha: "1".repeat(40), path: "vendor/sub" }]);
  });

  it("blocks on a record it cannot parse rather than dropping it", () => {
    expect(() => parseTreeEntries("not a tree record\0", config)).toThrow(BlockedError);
    try {
      parseTreeEntries("not a tree record\0", config);
    } catch (error) {
      expect(error).toBeInstanceOf(BlockedError);
      expect((error as BlockedError).blockers[0]?.code).toBe("deliverable_tree_unparsable");
    }
  });
});

// ── Failure ────────────────────────────────────────────────────────────────

describe("failures", () => {
  it("blocks when git cannot list the tree", async () => {
    const run: CandidateCommandRunner = () => Promise.resolve({ exitCode: 128, stdout: "", stderr: "fatal: not a tree object" });
    await expect(
      computeDeliverableIdentity({ rootDir: "/nonexistent", treeSha: "deadbeef", config: testConfig() }, { run }),
    ).rejects.toBeInstanceOf(BlockedError);
  });

  it("names the failure with a code a renderer can carry", async () => {
    const run: CandidateCommandRunner = () => Promise.resolve({ exitCode: -1, stdout: "", stderr: "spawn ENOENT" });
    try {
      await computeDeliverableIdentity({ rootDir: "/nonexistent", treeSha: "deadbeef", config: testConfig() }, { run });
      expect.unreachable("the identity computation should have blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(BlockedError);
      expect((error as BlockedError).blockers[0]?.code).toBe("deliverable_tree_unreadable");
    }
  });
});

// ── The injected port ──────────────────────────────────────────────────────

describe("withDeliverableIdentity", () => {
  it("satisfies the identity port capture injects", async () => {
    const entry = golden("mode-variants");
    const rootDir = await makeRoot();
    const treeSha = await buildGoldenTree(entry, rootDir);

    const computeIdentity: ComputeIdentity = withDeliverableIdentity();
    expect(await computeIdentity({ rootDir, treeSha, config: testConfig() })).toBe(entry.expected.digest);
  });

  it("lists the tree the request names, not HEAD", async () => {
    const commands: string[][] = [];
    const run: CandidateCommandRunner = (command) => {
      commands.push([...command]);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    await withDeliverableIdentity({ run })({ rootDir: "/repo", treeSha: "cafe1234", config: testConfig() });
    expect(commands).toEqual([["git", "ls-tree", "-r", "-z", "--full-tree", "cafe1234"]]);
  });
});

// ── Integration ────────────────────────────────────────────────────────────

describe("a docs-only commit", () => {
  it("moves the tree sha and leaves the identity alone", async () => {
    const rootDir = await makeRoot();
    const before = await observeGolden(golden("nested-neutral-prefix-stripped"), testConfig());

    // The same deliverable, with narration added afterwards — the case the
    // neutral set exists for. Built by extending the stripped recipe rather
    // than by reusing the nested golden, so this is an addition over a tree
    // that was already digested, not two unrelated trees.
    const extended: IdentityGolden = {
      ...golden("nested-neutral-prefix-stripped"),
      entries: [
        ...golden("nested-neutral-prefix-stripped").entries,
        { mode: "100644", path: "docs/reports/2026/08/landed-change.html", content: "written after the work\n" },
        { mode: "100644", path: "docs/solutions/harness/note.md", content: "written after the work\n" },
        { mode: "100644", path: "telemetry/delivery-runs/2026/run.json", content: "{\"run\":2}\n" },
      ],
    };
    const treeSha = await buildGoldenTree(extended, rootDir);
    const digest = await computeDeliverableIdentity({ rootDir, treeSha, config: testConfig() });

    expect(treeSha).not.toBe(before.treeSha);
    expect(digest).toBe(before.digest);
  });
});
