/**
 * The post-round residual classifier.
 *
 * WHAT THESE ROWS ARE FALSIFYING. The claim under test is not "neutral changes
 * are admitted" — that is satisfied by admitting everything. It is the pair:
 * each named class admits exactly what the owner's policy names, and everything
 * else refuses *and says which hunk*. So every admitting row has a refusing
 * twin that differs by one line, and the refusals assert on the named hunk
 * rather than merely on `admitted === false`.
 *
 * The `comment-only` class is asserted through its erasure, which is where it
 * can be wrong in the dangerous direction: a comment-shaped line that is not a
 * comment. Those rows are the ones that would pass a diff-text implementation
 * and must fail this one.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POST_ROUND_NEUTRAL,
  type NeutralMatcher,
  type PostRoundNeutralPolicy,
} from "./config.ts";
import {
  canonicalProgram,
  classifyPostRoundResidual,
  nonNeutralHunks,
  projectionSummaryRows,
  stripComments,
  RESIDUAL_CLASSES,
  REVIEW_NEUTRAL_PROJECTION_SPEC,
  type ResidualPathInput,
} from "./review-neutral-projection.ts";

const REVIEWED_TREE = "a".repeat(40);
const RECORD_TREE = "b".repeat(40);
const BASE_ONE = "1".repeat(40);
const BASE_TWO = "2".repeat(40);

const POLICY: PostRoundNeutralPolicy = {
  paths: [{ prefix: "docs/solutions/" }, { prefix: "docs/delivery-runbook.md" }],
  commentOnlyHunks: true,
  rebase: true,
};

/** One residual path, with every coordinate defaulted to "the candidate owns it". */
function residual(path: string, over: Partial<ResidualPathInput> = {}): ResidualPathInput {
  return {
    path,
    reviewedContent: "before\n",
    reviewedBaseContent: null,
    recordContent: "after\n",
    recordBaseContent: null,
    ...over,
  };
}

function classify(paths: readonly ResidualPathInput[], bases: readonly [string, string] = [BASE_ONE, BASE_ONE], policy = POLICY,
    deliverableNeutral: readonly NeutralMatcher[] = []) {
  return classifyPostRoundResidual(policy, {
    reviewedTreeSha: REVIEWED_TREE,
    recordTreeSha: RECORD_TREE,
    reviewedMergeBaseSha: bases[0],
    recordMergeBaseSha: bases[1],
    paths,
    deliverableNeutral,
  });
}

describe("the projection document", () => {
  it("names its spec, both trees, and whether the base moved", () => {
    const projection = classify([], [BASE_ONE, BASE_TWO]);
    expect(projection.spec).toBe(REVIEW_NEUTRAL_PROJECTION_SPEC);
    expect(projection.reviewedTreeSha).toBe(REVIEWED_TREE);
    expect(projection.recordTreeSha).toBe(RECORD_TREE);
    expect(projection.baseMoved).toBe(true);
    expect(projection.admitted).toBe(true);
  });

  it("calls the base unmoved when both candidates share a merge base", () => {
    expect(classify([]).baseMoved).toBe(false);
  });

  it("classifies every entry into exactly one product-defined class", () => {
    const projection = classify([
      residual("docs/solutions/note.md"),
      residual("packages/kernel/src/thing.ts", { reviewedContent: "const a = 1;\n", recordContent: "// why\nconst a = 1;\n" }),
      residual("packages/kernel/src/other.ts"),
    ]);
    for (const entry of projection.entries) expect(RESIDUAL_CLASSES).toContain(entry.residualClass);
  });
});

describe("scenario 1: a neutral docs commit after the round", () => {
  it("admits a path the policy names", () => {
    const projection = classify([residual("docs/solutions/a-thing-2026-09-15.md")]);
    expect(projection.entries[0]?.residualClass).toBe("neutral-path");
    expect(projection.admitted).toBe(true);
  });

  it("admits the repository's own runbook, which the deliverable digest still binds", () => {
    expect(classify([residual("docs/delivery-runbook.md")]).entries[0]?.residualClass).toBe("neutral-path");
  });

  it("refuses a docs path the policy does not name", () => {
    const projection = classify([residual("docs/agent-guide.md")]);
    expect(projection.entries[0]?.residualClass).toBe("non-neutral");
    expect(projection.admitted).toBe(false);
  });
});

describe("scenario 2: a comment-only hunk in source", () => {
  const before = "export const a = 1;\nexport const b = 2;\n";

  it("admits an added comment header", () => {
    const after = "/** Why this constant exists. */\nexport const a = 1;\n// and b\nexport const b = 2;\n";
    const projection = classify([residual("packages/cli/src/x.ts", { reviewedContent: before, recordContent: after })]);
    expect(projection.entries[0]).toEqual({ path: "packages/cli/src/x.ts", residualClass: "comment-only" });
    expect(projection.admitted).toBe(true);
  });

  it("admits a rewritten comment and a removed one together", () => {
    const reviewed = "// old wording\nexport const a = 1; // trailing\nexport const b = 2;\n";
    const record = "/* new wording, longer,\n   over several lines */\nexport const a = 1;\nexport const b = 2;\n";
    expect(classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })]).entries[0]?.residualClass).toBe("comment-only");
  });

  it("names the class in the summary rows so the hunk is visibly accounted for", () => {
    const after = "// why\nexport const a = 1;\nexport const b = 2;\n";
    const rows = projectionSummaryRows(classify([residual("packages/cli/src/x.ts", { reviewedContent: before, recordContent: after })]));
    expect(rows[0]).toContain("comment-only 1");
    expect(rows).toContain("  neutral comment-only: packages/cli/src/x.ts");
  });

  it("refuses a file whose comments the scanner does not know", () => {
    const projection = classify([residual("scripts/thing.sh", { reviewedContent: "# a\ntrue\n", recordContent: "# b\ntrue\n" })]);
    expect(projection.entries[0]?.residualClass).toBe("non-neutral");
  });

  it("refuses a comment-shaped line inside a template literal", () => {
    const reviewed = "export const t = `\n// kept\n`;\n";
    const record = "export const t = `\n// changed\n`;\n";
    expect(classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })]).entries[0]?.residualClass).toBe("non-neutral");
  });

  it("refuses a comment-shaped line inside a string literal", () => {
    const reviewed = 'export const t = "// kept";\n';
    const record = 'export const t = "// changed";\n';
    expect(classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })]).entries[0]?.residualClass).toBe("non-neutral");
  });

  it("refuses a reindentation, which is not on the neutral list", () => {
    expect(classify([residual("x.ts", { reviewedContent: "if (a) {\n  b();\n}\n", recordContent: "if (a) {\n    b();\n}\n" })])
      .entries[0]?.residualClass).toBe("non-neutral");
  });

  it("refuses a file the scanner cannot scan to a terminal state", () => {
    // A regular expression holding `/*` leaves this scanner inside a block
    // comment forever. Both sides refuse, and two refusals are not an equality.
    const reviewed = "export const r = /[/*]/;\nexport const a = 1;\n";
    const record = "export const r = /[/*]/;\nexport const a = 2;\n";
    expect(canonicalProgram(reviewed)).toBeNull();
    expect(classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })]).entries[0]?.residualClass).toBe("non-neutral");
  });

  it("does not admit comment-only when the owner switched it off", () => {
    const after = "// why\nexport const a = 1;\nexport const b = 2;\n";
    const off = { ...POLICY, commentOnlyHunks: false };
    expect(classify([residual("x.ts", { reviewedContent: before, recordContent: after })], [BASE_ONE, BASE_ONE], off)
      .entries[0]?.residualClass).toBe("non-neutral");
  });
});

describe("scenario 3: a one-line logic change after the round", () => {
  it("refuses and names the hunk", () => {
    const reviewed = "export function f(n: number) {\n  return n + 1;\n}\n";
    const record = "export function f(n: number) {\n  return n + 2;\n}\n";
    const projection = classify([residual("packages/kernel/src/f.ts", { reviewedContent: reviewed, recordContent: record })]);
    expect(projection.admitted).toBe(false);
    expect(nonNeutralHunks(projection)).toEqual(["packages/kernel/src/f.ts:2 return n + 2;"]);
  });

  it("refuses a logic change smuggled in beside a comment change", () => {
    const reviewed = "// old\nexport const limit = 5;\n";
    const record = "// new\nexport const limit = 6;\n";
    expect(nonNeutralHunks(classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })])))
      .toEqual(["x.ts:2 export const limit = 6;"]);
  });

  it("names an added and a removed path rather than a line that does not exist", () => {
    const added = classify([residual("x.ts", { reviewedContent: null, recordContent: "export const a = 1;\n" })]);
    const removed = classify([residual("y.ts", { reviewedContent: "export const a = 1;\n", recordContent: null })]);
    expect(nonNeutralHunks(added)).toEqual(["x.ts:1 added by the residual"]);
    expect(nonNeutralHunks(removed)).toEqual(["y.ts:1 removed by the residual"]);
  });

  it("truncates a very long hunk line rather than echoing it whole", () => {
    const long = `export const a = "${"x".repeat(400)}";`;
    const hunk = nonNeutralHunks(classify([residual("x.ts", { reviewedContent: "export const a = 1;\n", recordContent: `${long}\n` })]))[0]!;
    expect(hunk.length).toBeLessThan(200);
    expect(hunk.endsWith("…")).toBe(true);
  });

  it("refuses the whole projection when one of several paths is not neutral", () => {
    const projection = classify([
      residual("docs/solutions/note.md"),
      residual("packages/kernel/src/f.ts", { reviewedContent: "return 1;\n", recordContent: "return 2;\n" }),
    ]);
    expect(projection.admitted).toBe(false);
    expect(projection.entries.map((entry) => entry.residualClass)).toEqual(["neutral-path", "non-neutral"]);
  });

  it("gives an admitted entry no hunk to name", () => {
    for (const entry of classify([residual("docs/solutions/note.md")]).entries) expect(entry.hunk).toBeUndefined();
  });
});

describe("scenario 4: a rebase the candidate does not deliver over", () => {
  const untouched = { reviewedContent: "base v1\n", reviewedBaseContent: "base v1\n", recordContent: "base v2\n", recordBaseContent: "base v2\n" };

  it("admits a path the candidate delivers nothing on when the base moved", () => {
    const projection = classify([residual("packages/other/src/z.ts", untouched)], [BASE_ONE, BASE_TWO]);
    expect(projection.entries[0]?.residualClass).toBe("rebase");
    expect(projection.admitted).toBe(true);
  });

  it("refuses the same shape when the base did not move, because then the candidate did it", () => {
    expect(classify([residual("packages/other/src/z.ts", untouched)], [BASE_ONE, BASE_ONE]).entries[0]?.residualClass)
      .toBe("non-neutral");
  });

  it("refuses a path the candidate does deliver over, even across a rebase", () => {
    const delivered = {
      reviewedContent: "base v1\ncandidate line\n",
      reviewedBaseContent: "base v1\n",
      recordContent: "base v2\ncandidate line CHANGED\n",
      recordBaseContent: "base v2\n",
    };
    const projection = classify([residual("packages/other/src/z.ts", delivered)], [BASE_ONE, BASE_TWO]);
    expect(projection.entries[0]?.residualClass).toBe("non-neutral");
    expect(nonNeutralHunks(projection)[0]).toContain("packages/other/src/z.ts:1");
  });

  it("refuses when only the reviewed side sat at its base, so the record side delivered", () => {
    // The conjunct's left half alone. Under `reviewedContent === reviewedBase`
    // replaced by `true`, the row above still passes because its fixture
    // differs from base on both sides; this one does not.
    const recordDelivers = {
      reviewedContent: "base v1\n",
      reviewedBaseContent: "base v1\n",
      recordContent: "base v2\ndelivered after the round\n",
      recordBaseContent: "base v2\n",
    };
    const projection = classify([residual("z.ts", recordDelivers)], [BASE_ONE, BASE_TWO]);
    expect(projection.entries[0]?.residualClass).toBe("non-neutral");
    expect(nonNeutralHunks(projection)[0]).toContain("z.ts:1");
  });

  it("refuses when only the record side sits at its base, so the reviewed side was reverted", () => {
    // The conjunct's right half alone: reviewed work that the record drops
    // back to base content is a post-round change, not a rebase.
    const reviewedDelivered = {
      reviewedContent: "base v1\nreviewed work\n",
      reviewedBaseContent: "base v1\n",
      recordContent: "base v2\n",
      recordBaseContent: "base v2\n",
    };
    expect(classify([residual("z.ts", reviewedDelivered)], [BASE_ONE, BASE_TWO]).entries[0]?.residualClass)
      .toBe("non-neutral");
  });

  it("does not admit a rebase when the owner switched it off", () => {
    const off = { ...POLICY, rebase: false };
    expect(classify([residual("z.ts", untouched)], [BASE_ONE, BASE_TWO], off).entries[0]?.residualClass).toBe("non-neutral");
  });

  it("says the base moved in the summary row", () => {
    expect(projectionSummaryRows(classify([residual("z.ts", untouched)], [BASE_ONE, BASE_TWO]))[0]).toContain("(base moved)");
  });
});

describe("a path the deliverable digest never covered", () => {
  /**
   * `reviewNeutral` is the identity function's own narration set: a path in it
   * is excluded from the digest, so it was not part of the tree any round was
   * bound to and cannot be the reason the round stops governing. The case that
   * forces this is the record itself — a record transported into the tree under
   * `recordNeutral` moves the tree after the round every single time.
   */
  const identity: readonly NeutralMatcher[] = [{ prefix: "delivery/records/" }];

  it("admits it as identity-neutral, without the policy naming it", () => {
    const projection = classify([residual("delivery/records/record.json")], [BASE_ONE, BASE_ONE], POLICY, identity);
    expect(projection.entries[0]?.residualClass).toBe("identity-neutral");
    expect(projection.admitted).toBe(true);
  });

  it("admits it even under an explicit opt-out, which governs the later predicate only", () => {
    const optOut: PostRoundNeutralPolicy = { paths: [], commentOnlyHunks: false, rebase: false };
    expect(classify([residual("delivery/records/record.json")], [BASE_ONE, BASE_ONE], optOut, identity).admitted).toBe(true);
  });

  it("refuses a path outside that set, so the grant is the identity's and not a blanket one", () => {
    expect(classify([residual("packages/kernel/src/f.ts")], [BASE_ONE, BASE_ONE], POLICY, identity).admitted).toBe(false);
  });

  it("admits nothing extra when the caller supplies no identity set", () => {
    expect(classify([residual("delivery/records/record.json")]).entries[0]?.residualClass).toBe("non-neutral");
  });
});

describe("which hunk a refusal names", () => {
  /**
   * The refusal exists to be read. Naming the first RAW difference names the
   * comment a delivery rewrote on line 1 and leaves the reader looking at the
   * one hunk that is not the problem, so the comparison runs over the erasure
   * and the line number is the real one in the file.
   */
  it("skips the changed comment above and names the changed statement", () => {
    const reviewed = "// stale note\nexport const a = 1;\nexport const b = 2;\n";
    const record = "// rewritten note, longer now\nexport const a = 1;\nexport const b = 3;\n";
    expect(nonNeutralHunks(classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })])))
      .toEqual(["x.ts:3 export const b = 3;"]);
  });

  it("counts the lines a multi-line comment occupies, not the lines that survive it", () => {
    const reviewed = "/**\n * Why.\n * Still why.\n */\nexport const a = 1;\n";
    const record = "/**\n * Why.\n * Still why.\n */\nexport const a = 2;\n";
    expect(nonNeutralHunks(classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })])))
      .toEqual(["x.ts:5 export const a = 2;"]);
  });

  it("names a line the erasure cannot reach by falling back to the raw text", () => {
    // An unterminated literal refuses the erasure; the refusal must still name
    // something rather than reporting no difference at all.
    const reviewed = 'export const a = "one;\n';
    const record = 'export const a = "two;\n';
    expect(nonNeutralHunks(classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })])))
      .toEqual(['x.ts:1 export const a = "two;']);
  });

  it("names the raw line for a file type whose comments it does not erase", () => {
    expect(nonNeutralHunks(classify([residual("docs/agent-guide.md",
      { reviewedContent: "# one\n", recordContent: "# two\n" })])))
      .toEqual(["docs/agent-guide.md:1 # two"]);
  });
});

describe("the default policy an adopter who declares nothing is judged under", () => {
  /**
   * Amendment A. The knob was never the deliverable — the answer an adopter who
   * has written no policy gets is. That absence resolves to
   * `DEFAULT_POST_ROUND_NEUTRAL` rather than to the empty policy is asserted
   * against a full config in `config.test.ts` ("defaults the four members that
   * carry defaults"); what these rows falsify is what that default then admits,
   * and — the row that keeps it honest — what it refuses.
   */
  const underDefault = (paths: readonly ResidualPathInput[], bases: readonly [string, string] = [BASE_ONE, BASE_ONE]) =>
    classify(paths, bases, DEFAULT_POST_ROUND_NEUTRAL);

  it("gives that adopter the solution note, the comment restamp and the rebase", () => {
    const projection = underDefault([
      residual("docs/solutions/what-we-learned-2026-09-15.md"),
      residual("src/thing.ts", { reviewedContent: "const a = 1;\n", recordContent: "// why\nconst a = 1;\n" }),
      residual("vendor/z.ts", { reviewedContent: "v1\n", reviewedBaseContent: "v1\n", recordContent: "v2\n", recordBaseContent: "v2\n" }),
    ], [BASE_ONE, BASE_TWO]);
    expect(projection.entries.map((entry) => entry.residualClass)).toEqual(["neutral-path", "comment-only", "rebase"]);
    expect(projection.admitted).toBe(true);
  });

  it("does not give that adopter this repository's own file names", () => {
    // The default may only carry what is true of any repository. A runbook path
    // is one repository's choice and has to be declared to be admitted.
    expect(underDefault([residual("docs/delivery-runbook.md")]).entries[0]?.residualClass).toBe("non-neutral");
  });

  it("still refuses a logic change, naming the hunk, with no policy written anywhere", () => {
    const projection = underDefault([residual("src/f.ts", { reviewedContent: "return 1;\n", recordContent: "return 2;\n" })]);
    expect(projection.admitted).toBe(false);
    expect(nonNeutralHunks(projection)).toEqual(["src/f.ts:1 return 2;"]);
  });

  it("carries exactly the three grants, so a later widening is a deliberate edit", () => {
    expect(DEFAULT_POST_ROUND_NEUTRAL).toEqual({
      paths: [{ prefix: "docs/solutions/" }],
      commentOnlyHunks: true,
      rebase: true,
    });
  });

  it("admits nothing under an explicit opt-out, which is how an adopter refuses the default", () => {
    const optOut: PostRoundNeutralPolicy = { paths: [], commentOnlyHunks: false, rebase: false };
    const projection = classify([
      residual("docs/solutions/note.md"),
      residual("vendor/z.ts", { reviewedContent: "v1\n", reviewedBaseContent: "v1\n", recordContent: "v2\n", recordBaseContent: "v2\n" }),
    ], [BASE_ONE, BASE_TWO], optOut);
    expect(projection.entries.map((entry) => entry.residualClass)).toEqual(["non-neutral", "non-neutral"]);
    expect(projection.admitted).toBe(false);
  });
});

describe("the one character the erasure will not guess at", () => {
  /**
   * `/` is division or the start of a regular expression, and the difference
   * needs the grammar. Guessing division turns `/^https?:\/\//` — the ordinary
   * URL test — into a `//` that erases the rest of the source line from BOTH
   * programs, so a post-round logic change to the right of it compares equal
   * and ships as `comment-only` under a round that never saw it. Guessing regex
   * swallows a division's right-hand side instead. Both are fail-open, so the
   * erasure refuses, and a refusal cannot be an equality.
   */
  it("refuses a source holding a regex, rather than reading its slashes as a comment", () => {
    expect(stripComments('if (/^https?:\\/\\//.test(ref)) return "remote";\n')).toBeNull();
    expect(canonicalProgram('const re = /ab+c/;\n')).toBeNull();
  });

  it("does not admit a logic change hiding to the right of a regex", () => {
    // The mutation this row exists for: with the slashes read as a line
    // comment, both sides erase to `if (` and the change below compares equal.
    const reviewed = 'if (/^https?:\\/\\//.test(ref)) return "remote";\n';
    const record = 'if (/^https?:\\/\\//.test(ref)) return "LOCAL-ALWAYS";\n';
    const projection = classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })]);
    expect(projection.entries[0]?.residualClass).toBe("non-neutral");
    expect(projection.admitted).toBe(false);
  });

  it("refuses both sides alike, so a refusal never reads as sameness", () => {
    const same = 'const re = /a\\/b/;\n';
    expect(canonicalProgram(same)).toBeNull();
    expect(classify([residual("x.ts", { reviewedContent: same, recordContent: `${same}const a = 1;\n` })])
      .entries[0]?.residualClass).toBe("non-neutral");
  });

  /**
   * ROUND 2, F1'. The first fix refused only where a regex *may* begin, judged
   * from the previous non-whitespace character — a punctuator set. Keywords are
   * value-shaped words that are not values, so a regex introduced by one was
   * called division, the scan continued inside the literal's body, and its own
   * `\//` opened a line comment: the original defect, through the more
   * idiomatic spelling of the same line. These rows are that spelling.
   */
  it.each(["return", "typeof", "case", "await", "throw", "yield", "new", "in", "of"])(
    "refuses a regex introduced by the keyword %s, not only by a punctuator",
    (keyword) => {
      expect(stripComments(`${keyword} /^https?:\\/\\//.test(ref);\n`)).toBeNull();
    },
  );

  it("does not admit a logic change hiding behind a keyword-introduced regex", () => {
    const reviewed = 'function kind(ref) {\n  return /^https?:\\/\\//.test(ref) ? "remote" : "local";\n}\n';
    const record = 'function kind(ref) {\n  return /^https?:\\/\\//.test(ref) ? "LOCAL-ALWAYS" : "local";\n}\n';
    const projection = classify([residual("kind.ts", { reviewedContent: reviewed, recordContent: record })]);
    expect(projection.entries[0]?.residualClass).toBe("non-neutral");
    expect(projection.admitted).toBe(false);
  });

  /**
   * The breadth is deliberate and is the finding's own remedy: a rule about
   * where a regex may begin is a rule about the grammar, and every gap in it is
   * a fail-open. Refusing division too costs a round on files that divide, in
   * the safe direction.
   */
  it("refuses a division as well, rather than keeping a rule it cannot make total", () => {
    expect(stripComments("const half = total / 2; // half\n")).toBeNull();
    expect(stripComments("const r = (a + b) / c;\n")).toBeNull();
    expect(canonicalProgram("const r = items[0] / c;\n")).toBeNull();
  });

  it("refuses both sides of a dividing file alike, so the refusal is not an equality", () => {
    const reviewed = "const r = a / b;\n";
    const record = "const r = a / c;\n";
    expect(classify([residual("x.ts", { reviewedContent: reviewed, recordContent: record })])
      .entries[0]?.residualClass).toBe("non-neutral");
  });

  it("leaves a slash inside a string or a comment alone", () => {
    expect(stripComments('const s = "a/b";\n')).toBe('const s = "a/b";\n');
    expect(canonicalProgram("// see http://example.invalid/a\nconst a = 1;\n")).toBe("const a = 1;");
  });
});

describe("the comment erasure", () => {
  it("keeps the newline a line comment sat on, so two statements do not join", () => {
    expect(stripComments("a();// c\nb();\n")).toBe("a();\nb();\n");
  });

  it("erases a block comment without joining what surrounded it", () => {
    expect(canonicalProgram("a();\n/* c\n   more */\nb();\n")).toBe("a();\nb();");
  });

  it("leaves string and template contents alone", () => {
    expect(stripComments('const s = "a // b";\n')).toBe('const s = "a // b";\n');
    expect(stripComments("const s = `a /* b */ c`;\n")).toBe("const s = `a /* b */ c`;\n");
  });

  it("honours an escaped quote rather than ending the literal on it", () => {
    expect(stripComments('const s = "a\\"// b";\nc();\n')).toBe('const s = "a\\"// b";\nc();\n');
  });

  it("refuses an unterminated block comment", () => {
    expect(stripComments("a();\n/* never closed\n")).toBeNull();
  });

  it("refuses an unterminated string literal", () => {
    expect(stripComments('const s = "open\n')).toBeNull();
  });

  it("drops blank lines and trailing whitespace from the comparison form", () => {
    expect(canonicalProgram("a();   \n\n\nb();\n")).toBe("a();\nb();");
  });

  it("keeps a template substitution's own code in the comparison form", () => {
    const before = canonicalProgram("const s = `x${a + 1}y`;\n");
    const after = canonicalProgram("const s = `x${a + 2}y`;\n");
    expect(before).not.toBe(after);
  });
});

describe("the summary rows", () => {
  it("print nothing when the recorded candidate is the reviewed one", () => {
    expect(projectionSummaryRows({
      spec: REVIEW_NEUTRAL_PROJECTION_SPEC, reviewedTreeSha: REVIEWED_TREE, recordTreeSha: REVIEWED_TREE,
      baseMoved: false, entries: [], admitted: true,
    })).toEqual([]);
  });

  it("say so when the trees differ with no residual path at all", () => {
    expect(projectionSummaryRows(classify([]))[0]).toContain("no residual paths");
  });

  it("do not list a refused path as neutral", () => {
    const rows = projectionSummaryRows(classify([residual("packages/kernel/src/f.ts")]));
    expect(rows.some((row) => row.startsWith("  neutral "))).toBe(false);
    expect(rows[0]).toContain("non-neutral 1");
  });
});
