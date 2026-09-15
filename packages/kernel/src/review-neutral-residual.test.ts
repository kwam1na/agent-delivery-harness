/**
 * The repository half of the post-round residual, against real git objects.
 *
 * The kernel's own suite owns the classification rules. What is falsifiable
 * only here is the reading: that the four blobs come from the four tree-ishes
 * the comparison names, that a tree this clone does not hold stops the whole
 * comparison instead of reading as a deletion, and that the record's own
 * coordinates decide which reviewed tree is compared against.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POST_ROUND_NEUTRAL, type HarnessConfig, type PostRoundNeutralPolicy, type ReviewNeutralProjection } from "@agent-delivery-harness/kernel";
import { projectPostRoundResidual, residualRows, decideResidual } from "./review-neutral-residual.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function put(root: string, repoPath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, repoPath)), { recursive: true });
  await writeFile(path.join(root, repoPath), contents);
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "residual-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch", "main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Residual Fixture");
  return root;
}

function commit(root: string, message: string): { commit: string; tree: string } {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return { commit: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
}

const POLICY: PostRoundNeutralPolicy = {
  paths: [{ prefix: "docs/solutions/" }, { prefix: "docs/delivery-runbook.md" }],
  commentOnlyHunks: true,
  rebase: true,
};

const config = (postRoundNeutral: PostRoundNeutralPolicy = POLICY) => ({ postRoundNeutral }) as unknown as HarnessConfig;

describe("reading the residual out of a repository", () => {
  it("admits a solution note committed after the round closed", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const base = commit(root, "base");
    await put(root, "src/a.ts", "export const a = 2;\n");
    const reviewed = commit(root, "the candidate the round read");
    await put(root, "docs/solutions/what-we-learned-2026-09-15.md", "# a note\n");
    const recorded = commit(root, "the solution note");

    const outcome = await projectPostRoundResidual({
      rootDir: root,
      config: config(),
      reviewedCandidates: [{ treeSha: reviewed.tree, mergeBaseSha: base.commit }, { treeSha: recorded.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: recorded.tree, mergeBaseSha: base.commit },
    });
    expect(outcome.kind).toBe("projected");
    if (outcome.kind !== "projected") return;
    expect(outcome.projection.admitted).toBe(true);
    expect(outcome.projection.entries).toEqual([
      { path: "docs/solutions/what-we-learned-2026-09-15.md", residualClass: "neutral-path" },
    ]);
    expect(residualRows(outcome, (projection) => [`rows for ${projection.entries.length}`])).toEqual(["rows for 1"]);
  });

  it("admits a comment-only restamp and refuses the logic change beside it", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export function f(n: number) {\n  return n + 1;\n}\n");
    const base = commit(root, "base");
    const reviewed = base;

    await put(root, "src/a.ts", "/** Why f exists. */\nexport function f(n: number) {\n  return n + 1;\n}\n");
    const commented = commit(root, "comment header");
    const neutral = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [{ treeSha: reviewed.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: commented.tree, mergeBaseSha: base.commit },
    });
    expect(neutral.kind === "projected" && neutral.projection.entries[0]?.residualClass).toBe("comment-only");

    await put(root, "src/a.ts", "/** Why f exists. */\nexport function f(n: number) {\n  return n + 2;\n}\n");
    const changed = commit(root, "one-line logic change");
    const refused = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [{ treeSha: reviewed.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: changed.tree, mergeBaseSha: base.commit },
    });
    expect(refused.kind).toBe("projected");
    if (refused.kind !== "projected") return;
    expect(refused.projection.admitted).toBe(false);
    expect(refused.projection.entries[0]?.hunk).toBe("src/a.ts:3 return n + 2;");
  });

  it("admits a rebase that moves only what the candidate does not deliver", async () => {
    const root = await repository();
    await put(root, "vendor/z.ts", "export const z = 1;\n");
    await put(root, "src/a.ts", "export const a = 1;\n");
    const firstBase = commit(root, "first base");

    // The candidate, prepared over the first base.
    git(root, "checkout", "--quiet", "-b", "candidate");
    await put(root, "src/a.ts", "export const a = 2;\n");
    const reviewed = commit(root, "candidate over the first base");

    // main moves under it, touching only a path the candidate does not deliver.
    git(root, "checkout", "--quiet", "main");
    await put(root, "vendor/z.ts", "export const z = 2;\n");
    const secondBase = commit(root, "second base");

    git(root, "checkout", "--quiet", "candidate");
    git(root, "rebase", "--quiet", "main");
    const recorded = { tree: git(root, "rev-parse", "HEAD^{tree}") };

    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [{ treeSha: reviewed.tree, mergeBaseSha: firstBase.commit }],
      recordCandidate: { treeSha: recorded.tree, mergeBaseSha: secondBase.commit },
    });
    expect(outcome.kind).toBe("projected");
    if (outcome.kind !== "projected") return;
    expect(outcome.projection.baseMoved).toBe(true);
    expect(outcome.projection.entries).toEqual([{ path: "vendor/z.ts", residualClass: "rebase" }]);
    expect(outcome.projection.admitted).toBe(true);
  });

  it("refuses a path the candidate does deliver, even across the same rebase", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const firstBase = commit(root, "first base");
    git(root, "checkout", "--quiet", "-b", "candidate");
    await put(root, "src/a.ts", "export const a = 2;\n");
    const reviewed = commit(root, "candidate");
    git(root, "checkout", "--quiet", "main");
    await put(root, "other.txt", "moved\n");
    const secondBase = commit(root, "second base");
    git(root, "checkout", "--quiet", "candidate");
    git(root, "rebase", "--quiet", "main");
    await put(root, "src/a.ts", "export const a = 3;\n");
    const recorded = commit(root, "and a post-round logic change");

    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [{ treeSha: reviewed.tree, mergeBaseSha: firstBase.commit }],
      recordCandidate: { treeSha: recorded.tree, mergeBaseSha: secondBase.commit },
    });
    expect(outcome.kind).toBe("projected");
    if (outcome.kind !== "projected") return;
    expect(outcome.projection.admitted).toBe(false);
    expect(outcome.projection.entries.find((entry) => entry.path === "src/a.ts")?.hunk)
      .toBe("src/a.ts:1 export const a = 3;");
    expect(outcome.projection.entries.find((entry) => entry.path === "other.txt")?.residualClass).toBe("rebase");
  });
});

describe("what the comparison refuses to guess", () => {
  it("says nothing moved when the record names only its own tree", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const only = commit(root, "base");
    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [{ treeSha: only.tree, mergeBaseSha: only.commit }],
      recordCandidate: { treeSha: only.tree, mergeBaseSha: only.commit },
    });
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(residualRows(outcome, () => ["never"])).toEqual([]);
  });

  /**
   * All four roles, not just the reviewed tree. The record tree is the role
   * that matters most: with its check skipped, `git diff` against an
   * unresolvable tree-ish fails, and a failed listing must not arrive as an
   * empty path list — which would classify as admitted with "no residual
   * paths", turning an unreadable record into a clean verification.
   */
  const ABSENT = "0".repeat(40);
  const roles = [
    ["the reviewed candidate tree", "reviewedTree"],
    ["the reviewed candidate's merge base", "reviewedBase"],
    ["the recorded candidate tree", "recordTree"],
    ["the recorded candidate's merge base", "recordBase"],
  ] as const;

  for (const [role, slot] of roles) {
    it(`stops rather than reading an absent tree as a deletion: ${role}`, async () => {
      const root = await repository();
      await put(root, "src/a.ts", "export const a = 1;\n");
      const base = commit(root, "base");
      await put(root, "src/a.ts", "export const a = 2;\n");
      const moved = commit(root, "moved");
      const outcome = await projectPostRoundResidual({
        rootDir: root, config: config(),
        reviewedCandidates: [{
          treeSha: slot === "reviewedTree" ? ABSENT : base.tree,
          mergeBaseSha: slot === "reviewedBase" ? ABSENT : base.commit,
        }],
        recordCandidate: {
          treeSha: slot === "recordTree" ? ABSENT : moved.tree,
          mergeBaseSha: slot === "recordBase" ? ABSENT : base.commit,
        },
      });
      expect(outcome.kind).toBe("unresolvable");
      if (outcome.kind !== "unresolvable") return;
      expect(outcome.detail).toContain(ABSENT);
      expect(outcome.detail).toContain(role);
      expect(residualRows(outcome, () => ["never"])[0]).toContain("not computed");
    });
  }

  it("judges every reviewed tree the record names, not the nearest one", async () => {
    // The near comparison is neutral and the far one is not. Picking either
    // "the last reviewed tree" or "the first" would decide this case by
    // accident; requiring all of them decides it by the claim being made.
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const first = commit(root, "the tree the round read");
    await put(root, "src/a.ts", "export const a = 2;\n");
    const second = commit(root, "a post-round logic change");
    await put(root, "docs/solutions/note-2026-09-15.md", "# note\n");
    const third = commit(root, "and a neutral note on top");

    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [
        { treeSha: first.tree, mergeBaseSha: first.commit },
        { treeSha: second.tree, mergeBaseSha: first.commit },
      ],
      recordCandidate: { treeSha: third.tree, mergeBaseSha: first.commit },
    });
    expect(outcome.kind).toBe("projected");
    if (outcome.kind !== "projected") return;
    // Against `second` alone the residual is just the note, and admitted.
    // Against `first` it also carries the logic change, so the delivery refuses
    // and the reported projection is the refusing one, with the hunk named.
    expect(outcome.projection.reviewedTreeSha).toBe(first.tree);
    expect(outcome.projection.admitted).toBe(false);
    expect(outcome.projection.entries.find((entry) => entry.path === "src/a.ts")?.hunk)
      .toBe("src/a.ts:1 export const a = 2;");
  });

  it("reports the widest projection when every reviewed tree is admitted", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const first = commit(root, "the tree the round read");
    await put(root, "docs/solutions/one-2026-09-15.md", "# one\n");
    const second = commit(root, "one note");
    await put(root, "docs/solutions/two-2026-09-15.md", "# two\n");
    const third = commit(root, "another note");

    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [
        { treeSha: second.tree, mergeBaseSha: first.commit },
        { treeSha: first.tree, mergeBaseSha: first.commit },
      ],
      recordCandidate: { treeSha: third.tree, mergeBaseSha: first.commit },
    });
    expect(outcome.kind).toBe("projected");
    if (outcome.kind !== "projected") return;
    expect(outcome.projection.admitted).toBe(true);
    expect(outcome.projection.reviewedTreeSha).toBe(first.tree);
    expect(outcome.projection.entries.map((entry) => entry.path)).toEqual([
      "docs/solutions/one-2026-09-15.md",
      "docs/solutions/two-2026-09-15.md",
    ]);
  });

  it("stops on an absent tree even when another reviewed tree would have passed", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const base = commit(root, "base");
    await put(root, "docs/solutions/note-2026-09-15.md", "# note\n");
    const recorded = commit(root, "note");
    const absent = "0".repeat(40);
    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [
        { treeSha: base.tree, mergeBaseSha: base.commit },
        { treeSha: absent, mergeBaseSha: base.commit },
      ],
      recordCandidate: { treeSha: recorded.tree, mergeBaseSha: base.commit },
    });
    expect(outcome.kind).toBe("unresolvable");
  });
});

describe("what a failed read is allowed to look like", () => {
  /**
   * No paths and "the paths could not be listed" are the same empty list to a
   * caller that does not distinguish them, and the first of the two admits the
   * residual. The mutation: have `changedPaths` return `[]` on a non-zero exit
   * and two trees known to differ are admitted with "no residual paths".
   */
  it("does not read an unlistable difference as no difference", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const base = commit(root, "base");
    await put(root, "src/a.ts", "export const a = 2;\n");
    const moved = commit(root, "a logic change");

    // A second repository that holds neither tree. Two guards can fire here —
    // the tree-ish resolution and the listing — and what this row pins is that
    // NEITHER of them can end in `projected`: a read that failed must never
    // arrive as an admitted residual over zero paths.
    const other = await repository();
    await put(other, "src/a.ts", "unrelated\n");
    commit(other, "unrelated");
    const outcome = await projectPostRoundResidual({
      rootDir: other, config: config(),
      reviewedCandidates: [{ treeSha: base.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: moved.tree, mergeBaseSha: base.commit },
    });
    expect(outcome.kind).not.toBe("projected");
    expect(residualRows(outcome, () => ["never"])[0]).toContain("not computed");
  });

  /**
   * ROUND 2, N3. The row above is a row for the existence gate: neither tree
   * resolves there, so the listing is never attempted and restoring
   * `changedPaths`'s `return []` leaves it green. This one reaches the listing.
   *
   * It is the case the prose names — a clone whose root objects resolve while
   * recursing them needs a fetch it cannot make. Built by deleting one
   * SUBTREE object: `git rev-parse <root>^{tree}` still answers, so the gate
   * passes, and `git diff --name-only` must walk into the hole and exits
   * non-zero. Read as an empty list, two trees known to differ would be
   * admitted over zero paths.
   */
  it("refuses when the trees resolve but the difference between them cannot be walked", async () => {
    const root = await repository();
    await put(root, "sub/a.ts", "export const a = 1;\n");
    const base = commit(root, "base");
    const subtree = git(root, "rev-parse", `${base.tree}:sub`);
    await put(root, "sub/a.ts", "export const a = 2;\n");
    const moved = commit(root, "a logic change");

    // Loose in a repository this young; removing it leaves the root tree whole.
    await rm(path.join(root, ".git/objects", subtree.slice(0, 2), subtree.slice(2)), { force: true });
    expect(git(root, "rev-parse", "--quiet", "--verify", `${base.tree}^{tree}`)).toBe(base.tree);

    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [{ treeSha: base.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: moved.tree, mergeBaseSha: base.commit },
    });
    expect(outcome.kind).toBe("unresolvable");
    if (outcome.kind !== "unresolvable") throw new Error("unreachable");
    expect(outcome.detail).toContain("could not be listed");
    expect(outcome.detail).toContain(base.tree);
  });
});

/**
 * ACCEPTANCE CRITERION 1, against the bytes rather than a fixture.
 *
 * "Lane A's V26-1510 journal and record replayed through the new `record` and
 * `verify` come out clean with the projection recorded." The record is tracked
 * in this repository, so the replay reads it instead of describing it.
 *
 * What it proves is a negative, and the negative is the point: the residual
 * check is additive and must not newly refuse a record written before it
 * existed. This record's single evidence entry names the same raw tree as the
 * record itself and carries no `review-context-projection` artifact, so there
 * is no earlier coordinate, nothing moved after the round, and the projection
 * is `unchanged`. Every other record in `delivery/records/` is replayed the
 * same way in the same row: 135 real records, none of which the new surface is
 * allowed to turn red.
 */
describe("the records this repository has already written", () => {
  const RECORDS_DIR = path.join(process.cwd(), "delivery/records");
  const V26_1510 = "record--6dc6a8b2fe5be38cde21b5f6e589c386cb588bac79ba2b0f22e420fceeed4a89.json";

  /**
   * THE REPOSITORY'S OWN POLICY, NOT THIS SUITE'S. A replay judged under a
   * fixture policy is a replay of something else: these records were written
   * under `harness.config.ts`, and the identity set is what decides most of
   * them — a record transported into the tree beside a solution note moves two
   * paths, both of which this repository excludes from the deliverable digest.
   * The values are restated here rather than imported, because no module under
   * `packages/` may reach the root config — the kernel least of all, where rule
   * (a) of `check-import-boundaries` forbids it outright — and the row below
   * pins them against the file so the restatement cannot rot.
   */
  const REVIEW_NEUTRAL = ["docs/reports/", "docs/solutions/", "telemetry/delivery-runs/", "delivery/records/"];
  const repositoryConfig = () => ({
    postRoundNeutral: DEFAULT_POST_ROUND_NEUTRAL,
    reviewNeutral: REVIEW_NEUTRAL.map((prefix) => ({ prefix })),
  }) as unknown as HarnessConfig;

  it("restates the repository's identity set as the config still declares it", async () => {
    const declared = await readFile(path.join(process.cwd(), "harness.config.ts"), "utf8");
    const block = declared.slice(declared.indexOf("reviewNeutral:"), declared.indexOf("recordNeutral:"));
    for (const prefix of REVIEW_NEUTRAL) expect(block, prefix).toContain(`"${prefix}"`);
    expect(block.match(/prefix:/g) ?? [], "no prefix beyond the four restated above").toHaveLength(REVIEW_NEUTRAL.length);
  });

  /** The reviewed coordinates a record names, read the way the kernel reads them. */
  async function coordinatesOf(file: string): Promise<{ record: { treeSha: string; mergeBaseSha: string }; earlier: { treeSha: string; mergeBaseSha: string }[] }> {
    const parsed = JSON.parse(await readFile(path.join(RECORDS_DIR, file), "utf8")) as Record<string, any>;
    const binding = parsed["candidateBinding"];
    const earlier: { treeSha: string; mergeBaseSha: string }[] = [];
    for (const claim of parsed["claims"] ?? []) {
      for (const entry of [...(claim["evidence"] === undefined ? [] : [claim["evidence"]]), ...(claim["supportingEvidence"] ?? [])]) {
        const portable = entry?.["resolution"]?.["portable"];
        if (portable === undefined) continue;
        if (entry["candidateBinding"]["treeSha"] !== binding["treeSha"]) {
          earlier.push({ treeSha: entry["candidateBinding"]["treeSha"], mergeBaseSha: entry["candidateBinding"]["mergeBaseSha"] });
        }
        for (const artifact of portable["manifest"]?.["artifacts"] ?? []) {
          if (artifact["role"] !== "review-context-projection") continue;
          const projection = JSON.parse(Buffer.from(portable["artifacts"][artifact["path"]], "base64").toString("utf8"));
          earlier.push({ treeSha: projection["reviewedCandidate"]["treeSha"], mergeBaseSha: entry["candidateBinding"]["mergeBaseSha"] });
        }
      }
    }
    return { record: { treeSha: binding["treeSha"], mergeBaseSha: binding["mergeBaseSha"] }, earlier };
  }

  it("replays V26-1510's record through the new residual surface unchanged", async () => {
    const { record, earlier } = await coordinatesOf(V26_1510);
    expect(earlier).toEqual([]);
    const outcome = await projectPostRoundResidual({
      rootDir: process.cwd(), config: repositoryConfig(),
      reviewedCandidates: [record, ...earlier],
      recordCandidate: record,
    });
    expect(outcome.kind).toBe("unchanged");
  });

  it("refuses none of the records already in the tree", async () => {
    const files = (await readdir(RECORDS_DIR)).filter((name) => name.startsWith("record--") && name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const { record, earlier } = await coordinatesOf(file);
      const outcome = await projectPostRoundResidual({
        rootDir: process.cwd(), config: repositoryConfig(),
        reviewedCandidates: [record, ...earlier],
        recordCandidate: record,
      });
      // A clone that no longer holds an old tree reports `unresolvable`, which
      // `verify` tolerates for these records: none of them claims a moved
      // deliverable identity. What may never happen is a refusal.
      if (outcome.kind === "projected") expect(outcome.projection.admitted, file).toBe(true);
    }
  });
});

describe("the identity set the request carries", () => {
  /**
   * The wiring, not the rule. `deliverableNeutral: request.config.reviewNeutral`
   * is one expression, and replacing it with `[]` leaves every other row here
   * green — they all build their config as a bare `postRoundNeutral` object, so
   * `reviewNeutral` is undefined in all of them. This row reads it from the
   * config the way the commands do, over the case the wiring exists for: the
   * delivery record transported into the tree after the round.
   */
  const withIdentity = (postRoundNeutral: PostRoundNeutralPolicy = POLICY) =>
    ({ postRoundNeutral, reviewNeutral: [{ prefix: "delivery/records/" }] }) as unknown as HarnessConfig;

  it("admits a record-neutral transport as identity-neutral, read from config.reviewNeutral", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const base = commit(root, "base");
    await put(root, "delivery/records/record--abc.json", '{"spec":"delivery-record/1"}\n');
    const recorded = commit(root, "the record, transported into the tree");

    const outcome = await projectPostRoundResidual({
      rootDir: root, config: withIdentity(),
      reviewedCandidates: [{ treeSha: base.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: recorded.tree, mergeBaseSha: base.commit },
    });
    expect(outcome.kind).toBe("projected");
    if (outcome.kind !== "projected") return;
    expect(outcome.projection.entries).toEqual([
      { path: "delivery/records/record--abc.json", residualClass: "identity-neutral" },
    ]);
    expect(outcome.projection.admitted).toBe(true);
  });

  it("admits it even under an opt-out policy, because the identity outranks the later predicate", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const base = commit(root, "base");
    await put(root, "delivery/records/record--abc.json", "{}\n");
    const recorded = commit(root, "the record");
    const outcome = await projectPostRoundResidual({
      rootDir: root, config: withIdentity({ paths: [], commentOnlyHunks: false, rebase: false }),
      reviewedCandidates: [{ treeSha: base.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: recorded.tree, mergeBaseSha: base.commit },
    });
    expect(outcome.kind === "projected" && outcome.projection.admitted).toBe(true);
  });

  it("refuses the same path when the config's identity set does not name it", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const base = commit(root, "base");
    await put(root, "delivery/records/record--abc.json", "{}\n");
    const recorded = commit(root, "the record");
    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(),
      reviewedCandidates: [{ treeSha: base.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: recorded.tree, mergeBaseSha: base.commit },
    });
    expect(outcome.kind === "projected" && outcome.projection.entries[0]?.residualClass).toBe("non-neutral");
  });
});

describe("the default policy, read through a config that declares none", () => {
  it("admits the solution note and the comment restamp for an adopter with no block", async () => {
    const root = await repository();
    await put(root, "src/a.ts", "export const a = 1;\n");
    const base = commit(root, "base");
    await put(root, "src/a.ts", "// why\nexport const a = 1;\n");
    await put(root, "docs/solutions/note-2026-09-15.md", "# note\n");
    const recorded = commit(root, "note and comment");

    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(DEFAULT_POST_ROUND_NEUTRAL),
      reviewedCandidates: [{ treeSha: base.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: recorded.tree, mergeBaseSha: base.commit },
    });
    expect(outcome.kind === "projected" && outcome.projection.admitted).toBe(true);
    expect(outcome.kind === "projected" && outcome.projection.entries.map((entry) => entry.residualClass).sort())
      .toEqual(["comment-only", "neutral-path"]);
  });

  it("does not admit this repository's runbook under the default", async () => {
    const root = await repository();
    await put(root, "docs/delivery-runbook.md", "# one\n");
    const base = commit(root, "base");
    await put(root, "docs/delivery-runbook.md", "# two\n");
    const recorded = commit(root, "runbook edit");
    const outcome = await projectPostRoundResidual({
      rootDir: root, config: config(DEFAULT_POST_ROUND_NEUTRAL),
      reviewedCandidates: [{ treeSha: base.tree, mergeBaseSha: base.commit }],
      recordCandidate: { treeSha: recorded.tree, mergeBaseSha: base.commit },
    });
    expect(outcome.kind === "projected" && outcome.projection.admitted).toBe(false);
  });
});

/**
 * The rule three deciding surfaces share, and the wiring that keeps them on it.
 *
 * `harness verify`, the pull-request Action and the managed-delivery facade all
 * read a record that may claim a closed round survived a move of the
 * deliverable identity. This delivery shipped that claim admitted at one
 * surface and refused at another twice — first the Action, then the facade —
 * each time because the rule had been written where the caller was rather than
 * where the rule is. The rows below falsify the rule itself, and then falsify
 * that each caller is still standing on it: a surface that stops calling
 * `decideResidual` is a surface that has started deciding for itself, and that
 * is the defect, whatever it decides.
 */
/**
 * The seam, not the answer.
 *
 * The managed-delivery facade routes every external command through one exec
 * port so the walking-skeleton scenario can assert the launch inventory it
 * observes is complete. That assertion is negative — it checks that nothing
 * unexpected was launched — so a module spawning git directly does not fail it,
 * it empties it. The only thing that can catch a bypass here is a row that
 * makes the supplied runner the ONLY way to reach the repository, which is what
 * this one does: the rootDir handed to the projection holds no repository at
 * all, and the runner is what knows where the objects live.
 */
describe("the runner the caller supplies", () => {
  it("is the one every git read goes through", async () => {
    const root = await repository();
    await put(root, "docs/solutions/note.md", "# before\n");
    const base = commit(root, "base");
    await put(root, "docs/solutions/note.md", "# after\n");
    const moved = commit(root, "a note after the round");

    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "no-repo-"));
    roots.push(elsewhere);

    const launched: string[][] = [];
    const run = async (command: readonly string[], options: { readonly cwd: string }) => {
      launched.push([...command]);
      expect(options.cwd, "the projection asks for the root it was given").toBe(elsewhere);
      try {
        // The runner, and only the runner, knows where the objects are.
        return { exitCode: 0, stdout: execFileSync(command[0] as string, command.slice(1), { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
      } catch {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
    };

    const outcome = await projectPostRoundResidual({
      rootDir: elsewhere,
      config: config(),
      reviewedCandidates: [{ treeSha: base.tree, mergeBaseSha: base.commit, provenNeutral: true }],
      recordCandidate: { treeSha: moved.tree, mergeBaseSha: base.commit },
      run,
    });

    // Had the projection spawned git itself, `elsewhere` is not a repository
    // and every tree-ish would have failed to resolve.
    expect(outcome.kind).toBe("projected");
    expect(outcome.kind === "projected" ? outcome.projection.admitted : false).toBe(true);
    expect(launched.length).toBeGreaterThan(0);
    expect(launched.every((command) => command[0] === "git")).toBe(true);
  });
});

describe("the residual decision the deciding surfaces share", () => {
  const reviewed = { treeSha: "a".repeat(40), mergeBaseSha: "b".repeat(40) };
  const projection = (admitted: boolean): ReviewNeutralProjection => ({
    spec: "review-neutral-projection/1",
    reviewedTreeSha: reviewed.treeSha,
    recordTreeSha: "c".repeat(40),
    baseMoved: false,
    admitted,
    entries: [{ path: "src/admit.ts", residualClass: admitted ? "comment-only" : "non-neutral",
      ...(admitted ? {} : { hunk: "src/admit.ts:3 return count >= 0;" }) }],
  });

  it("admits an unmoved candidate and an admitted projection", () => {
    expect(decideResidual({ kind: "unchanged" }, [reviewed]).kind).toBe("admitted");
    expect(decideResidual({ kind: "projected", projection: projection(true) }, [reviewed]).kind).toBe("admitted");
  });

  it("refuses a non-neutral residual whether or not anything claimed the move was neutral", () => {
    // UNGATED ON PURPOSE. A residual carrying a change the policy does not
    // admit is a round that did not read what is about to merge, whatever the
    // record says about itself. Gating this on the claim would leave the one
    // coordinate that can differ without any projection — an evidence entry
    // under a provider whose `check.scope` narrows the binding comparison away
    // from the deliverable digest — judged by `verify` and unread by the gate.
    for (const candidates of [[reviewed], [{ ...reviewed, provenNeutral: true }]]) {
      const decision = decideResidual({ kind: "projected", projection: projection(false) }, candidates);
      expect(decision.kind).toBe("not-neutral");
    }
  });

  it("refuses an unprovable residual only when the record claims the move was proven neutral", () => {
    // GATED ON PURPOSE, and this is the asymmetry. A clone may simply have
    // pruned an old tree object; refusing every such record would fail records
    // that are correct, which is the leniency that predates the ticket. It is
    // only the claim "the identity moved and the move was proven neutral" whose
    // unreadable tree means the claim is checked nowhere at all.
    const outcome = { kind: "unresolvable" as const, detail: "tree not in this repository" };
    expect(decideResidual(outcome, [reviewed]).kind).toBe("admitted");
    const refused = decideResidual(outcome, [{ ...reviewed, provenNeutral: true }]);
    expect(refused.kind).toBe("unprovable");
    expect(refused.kind === "unprovable" ? refused.detail : "").toContain("tree not in this repository");
  });

  /**
   * Wiring, asserted by reading the sources.
   *
   * These are the things the rule cannot defend by itself. A caller that stops
   * consulting it does not fail any behavioural row — it simply decides on its
   * own again, which is how this delivery shipped the gap twice.
   *
   * WHY EACH SURFACE PINS ITS CALL SITE AND NOT MERELY THE NAME. A surface may
   * put the shared rule behind a private helper, and the facade does: both of
   * its deciding paths go through `refuseResidual(await residualDecisionFor(`.
   * A row that only looks for `reproveResidual(` therefore reads the *helper's*
   * body and passes with every caller of it deleted — which is precisely the
   * round-4 defect this row was written to prevent recurring, one level in. So
   * the pattern pinned per surface is the spelling at the point of decision,
   * and the facade additionally pins the count, because "one of two call sites
   * guarded" is the exact shape that shipped. The facade's pattern also names
   * the runner it passes: reaching git any other way there is the bypass the
   * module's one exec seam exists to prevent, and no scenario row can report
   * a launch the port never saw.
   */
  it("is what every surface that decides actually calls, at each site that decides", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.join(here, "..", "..", "..");
    const sources = [
      { surface: "the verify command", file: path.join(root, "packages/cli/src/commands/verify.ts"), call: /decideResidual\(residual, verified\.reviewedCandidates\)/g, sites: 1 },
      { surface: "the pull-request Action", file: path.join(root, "packages/action/src/main.ts"), call: /reproveResidual\(\{/g, sites: 1 },
      { surface: "the managed-delivery facade", file: path.join(here, "facade", "managed-delivery.ts"), call: /refuseResidual\(await residualDecisionFor\(rootDir, config, check, parsed\.record\.candidateBinding, candidateRunner\)\)/g, sites: 2 },
    ];
    for (const { surface, file, call, sites } of sources) {
      const text = await readFile(file, "utf8");
      expect(text.match(call)?.length ?? 0, `${surface} decides the residual at every site that decides`).toBe(sites);
    }
  });

  /**
   * The same pinning, one module over: the strictest-wins merge is applied
   * where the record's reviewed coordinates are projected.
   *
   * `mergeReviewedClaim` has its own four-assertion row in
   * `delivery-record.test.ts`, and that row stays green with the call site
   * reverted to the first-wins `if (!trees.has(sha))` it replaced — an
   * extracted helper proves the rule and says nothing about its application.
   * The retained-review fixture that would falsify the application
   * behaviourally costs a full review-context artifact set; this is the cheap
   * half of it, and it closes the revert.
   */
  it("applies the strictest-wins claim where the reviewed coordinates are projected", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const text = await readFile(path.join(here, "delivery-record.ts"), "utf8");
    expect(text).toContain("mergeReviewedClaim(trees.get(");
  });
});
