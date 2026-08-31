/**
 * The documentation-reference sensor: the paths the docs point at, and the
 * counts they state.
 *
 * WHY THIS EXISTS. `docs-examples.test.ts` executes the getting-started
 * walkthrough, so no command or flag on that page can drift from the CLI. It
 * reads nothing else. Every other documentation claim in this repository —
 * every relative link in `README.md` and the top-level guides, and every
 * computable number they quote — was unguarded: a link could name a file that
 * does not exist, and a count could say eighty-nine while the kit carried
 * ninety, with the whole suite green. This suite closes both.
 *
 * THE ABSENCE-ASSERTION TRAP, AND WHY THE GUARDS BELOW ARE NOT DECORATION.
 * "Every documented path exists" is a claim over a set, and a claim over a set
 * is satisfied for free by an empty set. If the link scanner's regex stopped
 * matching, or the document list resolved to nothing, the existence assertion
 * would pass while checking nothing at all — and it would pass *more quietly
 * than it passes now*, because there would be no failure to read. So the
 * enumeration is pinned from both ends: a floor on how many references the scan
 * must find, the exact set of documents it must have read, and one specific
 * reference that must be among them. Each of those fails on its own if the
 * mechanism silently stops enumerating.
 *
 * WHAT A "COMPUTABLE COUNT" IS. A number the documentation states that the tree
 * can recompute — the size of a frozen inventory, the number of CLI command
 * modules, the vector count the conformance kit declares.
 *
 * These are checked by agreement: the value the tree computes is compared
 * against every sentence stating it, in every document this sensor scans,
 * rather than against a literal written here. The difference is the whole
 * point. A literal pin catches the tree moving, but its failure message points
 * at this file, so the repair that suggests itself is to bump the literal —
 * leaving the documented sentence stale and now unguarded, with the suite
 * green. Checking the *sentences* means the prose is what has to be
 * re-stamped, and checking all of them means re-stamping one mention while
 * another goes stale is a failure too.
 *
 * Numbers that are *judgements* rather than computations are deliberately not
 * pinned: there is nothing to recompute them against, and a pin over a
 * hand-maintained constant only moves the staleness into this file.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FACADE_CAPABILITY_CLASSES,
  FACADE_OPERATIONS,
  FACADE_SURFACES,
  DELIVERY_STATES,
  INTAKE_STATES,
  PRODUCT_TRUST_LABEL,
  projectShippedPersonas,
  readArchiveEntry,
} from "@agent-delivery-harness/kernel";

const DOCS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DOCS_DIR, "..");

/**
 * The documents this sensor owns: the README and the top-level guides. The
 * vendored spec and the vendored plan under `docs/spec/` and `docs/plans/` are
 * deliberately excluded — they are normative inputs reproduced verbatim, and
 * their internal references are the upstream author's, not this repository's to
 * keep resolvable. `docs/solutions/` and `docs/reports/` are narration, which
 * the gate already treats as review-neutral.
 */
const scannedDocuments = (): readonly string[] => [
  "README.md",
  ...readdirSync(path.join(REPO_ROOT, "docs"))
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => path.join("docs", entry)),
];

interface DocumentReference {
  readonly document: string;
  readonly target: string;
  readonly resolved: string;
}

/**
 * Every relative link target in a document, with its anchor stripped and its
 * path resolved against the linking document's own directory — which is how a
 * reader's browser resolves it. Absolute URLs and bare anchors are not this
 * sensor's business: it checks paths in this tree.
 */
const referencesOf = (document: string): readonly DocumentReference[] => {
  const text = readFileSync(path.join(REPO_ROOT, document), "utf8");
  const documentDir = path.dirname(path.join(REPO_ROOT, document));
  const found: DocumentReference[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1]!;
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const withoutAnchor = target.split("#")[0]!;
    if (withoutAnchor === "") continue;
    found.push({ document, target, resolved: path.resolve(documentDir, withoutAnchor) });
  }
  return found;
};

const allReferences = (): readonly DocumentReference[] => scannedDocuments().flatMap(referencesOf);

describe("the documentation's references", () => {
  it("scans exactly the documents this sensor owns", () => {
    // The enumeration itself, pinned. A `docs/*.md` guide added without a
    // decision about whether its links are checked shows up here first.
    expect(scannedDocuments()).toEqual([
      "README.md",
      "docs/agent-guide.md",
      "docs/conformance.md",
      "docs/delivery-record.md",
      "docs/getting-started.md",
      "docs/managed-delivery.md",
      "docs/provider-guide.md",
      "docs/spec-errata.md",
    ]);
  });

  it("finds references to check, in every document it scans", () => {
    // The anti-vacuity guard for the existence assertion below. Both halves
    // matter: the floor catches a regex that stops matching, and the
    // per-document assertion catches a scan that silently drops a file.
    const references = allReferences();
    // The floor sits just under the real count rather than far below it. A
    // floor with room to spare is the one thing a partial drop fits through,
    // and a partial drop is the only failure this guard uniquely catches: a
    // scan that stops matching entirely is already caught by the two
    // assertions below.
    expect(references.length).toBeGreaterThanOrEqual(75);
    // Partitioned from the very array the existence assertion consumes, NOT
    // re-enumerated. Re-enumerating would check a different set from the one
    // being guarded, and would stay green while `allReferences` silently
    // narrowed.
    for (const document of scannedDocuments()) {
      expect(
        references.filter((reference) => reference.document === document).length,
        `${document} contributes no checked reference`,
      ).toBeGreaterThan(0);
    }
    // One specific reference the scan must have found, so that a regex which
    // matches *something* but not real links is still a failure.
    expect(references.some((reference) => reference.document === "README.md" && reference.target === "docs/getting-started.md")).toBe(
      true,
    );
  });

  it("links only to paths that exist in this tree", () => {
    const broken = allReferences().filter((reference) => !existsSync(reference.resolved));
    expect(broken.map((reference) => `${reference.document} -> ${reference.target}`)).toEqual([]);
  });
});

const textOf = (document: string): string => readFileSync(path.join(REPO_ROOT, document), "utf8");

/**
 * Prose spellings for counts a guide writes as a word rather than as digits.
 * Only the CLI command count is spelled that way today; the neighbouring
 * entries exist so that advancing it by one or two produces a comparison
 * instead of the `add it to NUMBER_WORDS` failure below.
 */
const NUMBER_WORDS: Readonly<Record<number, string>> = Object.freeze({
  8: "eight",
  9: "nine",
  10: "ten",
  11: "eleven",
});

/**
 * The prose spelling of a computed count, or a legible failure. Without this
 * the missing case surfaces as `expected 'nine' to be undefined`, which points
 * a reader at the document rather than at the table that needs a new row.
 */
const numberWord = (value: number): string => {
  const word = NUMBER_WORDS[value];
  expect(word, `no prose spelling is registered for ${value}; add it to NUMBER_WORDS`).toBeDefined();
  return word!;
};

/**
 * Asserts that EVERY sentence stating a count, in EVERY document this sensor
 * scans, carries the value the tree computes.
 *
 * Two properties matter here, and a weaker helper misses both.
 *
 * AGREEMENT, NOT PRESENCE. Asserting that some document contains the right
 * phrase leaves every other statement of the same count unguarded: the kit's
 * vector count is stated in five documents, so a check that finds it in two is
 * satisfied while three sentences go stale — including, in that instance, the
 * document that is *about* the kit. So the pattern is matched everywhere and
 * every captured value must agree.
 *
 * EVERY DOCUMENT, NOT A HAND-PICKED LIST. The document set comes from
 * `scannedDocuments()`, so a new guide is covered the moment it exists rather
 * than when someone remembers to add it to a list here. A hardcoded pair is a
 * second thing to maintain, and the whole point of this file is to stop
 * maintaining numbers by hand in two places.
 *
 * The capture is a number token rather than a fixed string, which also closes a
 * substring hole: matching the literal `9-vector` would be satisfied by the text
 * `89-vector`, whereas capturing the digits reads `89` and compares it.
 */
const everyStatementAgrees = (label: string, pattern: RegExp, computed: string): void => {
  const stated = scannedDocuments().flatMap((document) =>
    [...textOf(document).matchAll(pattern)].map((match) => ({ document, value: match[1]! })),
  );
  // Anti-vacuity: a pattern that stopped matching would otherwise satisfy the
  // agreement loop below by having nothing to disagree with.
  expect(stated.length, `no scanned document states ${label}`).toBeGreaterThan(0);
  for (const statement of stated) {
    expect(statement.value, `${statement.document} states ${label} as ${statement.value}, tree computes ${computed}`).toBe(
      computed,
    );
  }
};

/** Asserts a document quotes a frozen string verbatim. */
const documentStates = (document: string, phrase: string): void => {
  expect(textOf(document), `${document} no longer states: ${phrase}`).toContain(phrase);
};

describe("the computable counts the documentation states", () => {
  it("states the managed-delivery facade's operation inventory", () => {
    everyStatementAgrees("the facade operation count", /\*\*(\d+)\*\* operations/g, String(FACADE_OPERATIONS.length));
    everyStatementAgrees("the facade operation count", /(\d+)-operation inventory/g, String(FACADE_OPERATIONS.length));
  });

  it("names every capability class and surface the facade declares", () => {
    // The guide presents these as tables of names rather than as a number, so
    // agreement means the names themselves, and a class added to the frozen
    // inventory without reaching the table is the failure.
    const guide = textOf("docs/managed-delivery.md");
    for (const capabilityClass of FACADE_CAPABILITY_CLASSES) {
      expect(guide, `the guide does not name capability class ${capabilityClass}`).toContain(`\`${capabilityClass}\``);
    }
    for (const surface of FACADE_SURFACES) {
      expect(guide, `the guide does not name surface ${surface}`).toContain(`\`${surface}\``);
    }
  });

  it("states the delivery and intake state vocabularies", () => {
    everyStatementAgrees("the delivery state count", /\*\*(\d+)\*\* delivery states/g, String(DELIVERY_STATES.length));
    everyStatementAgrees("the delivery state count", /(\d+) delivery states,/g, String(DELIVERY_STATES.length));
    everyStatementAgrees("the intake state count", /(\d+) intake states/g, String(INTAKE_STATES.length));
  });

  it("quotes the frozen product-trust label verbatim", () => {
    expect(PRODUCT_TRUST_LABEL).toBe("local-digest / operator-pinned");
    documentStates("README.md", `\`${PRODUCT_TRUST_LABEL}\``);
    documentStates("docs/managed-delivery.md", PRODUCT_TRUST_LABEL);
  });

  it("states the CLI surface's command count", () => {
    const commands = readdirSync(path.join(REPO_ROOT, "packages/cli/src/commands")).filter(
      (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"),
    );
    // Spelled as a word in the prose, so the computed count is mapped to its
    // word and that is what every statement must agree with — the digits are
    // never written down here.
    everyStatementAgrees("the CLI command count", /(\w+)-command operator surface/g, numberWord(commands.length));
  });

  it("states the conformance kit's vector count", () => {
    const kit = JSON.parse(readFileSync(path.join(REPO_ROOT, "packages/conformance/vectors/kit.json"), "utf8")) as {
      vectors: readonly unknown[];
      counts: { total: number; accept: number; reject: number };
    };
    everyStatementAgrees("the conformance vector count", /(\d+)-vector/g, String(kit.vectors.length));
    everyStatementAgrees("the conformance vector count", /\*\*(\d+) golden/g, String(kit.vectors.length));
    everyStatementAgrees("the conformance vector count", /All (\d+) are decided/g, String(kit.vectors.length));
    everyStatementAgrees("the conformance vector count", /total: (\d+)/g, String(kit.vectors.length));

    // The accept/reject split rides in the same sentences as the total, and is
    // just as computable — it drifts the moment the kit is rebalanced, while
    // the total beside it re-stamps loudly.
    everyStatementAgrees("the accept-vector count", /\((\d+) accept/g, String(kit.counts.accept));
    everyStatementAgrees("the accept-vector count", /(\d+) accept,/g, String(kit.counts.accept));
    everyStatementAgrees("the accept-vector count", /accept\/ +\((\d+)\)/g, String(kit.counts.accept));
    everyStatementAgrees("the accept-vector count", /accept: (\d+)/g, String(kit.counts.accept));
    everyStatementAgrees("the reject-vector count", /(\d+) reject\)/g, String(kit.counts.reject));
    everyStatementAgrees("the reject-vector count", /(\d+) reject\*\*/g, String(kit.counts.reject));
    everyStatementAgrees("the reject-vector count", /reject\/ +\((\d+)\)/g, String(kit.counts.reject));
    everyStatementAgrees("the reject-vector count", /reject:\n?(\d+)/g, String(kit.counts.reject));
  });

  it("states the reviewer charter set the pinned composition ships", () => {
    // This resolves the real archive through the real mechanism, which is also
    // the honest scope of the claim: `projectShippedPersonas` is a library
    // boundary with no production caller in this repository, and this is a test
    // caller. The documentation says so; this test is why it can.
    const archive = readFileSync(path.join(REPO_ROOT, "qualifications/fixtures/agent-skills-core-v1-composition.zip"));
    const projected = projectShippedPersonas((entry) => {
      try {
        return readArchiveEntry(archive, entry);
      } catch {
        return undefined;
      }
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    everyStatementAgrees("the shipped charter count", /ships \*\*(\d+)\*\* reviewer charters/g, String(projected.personas.length));
  });
});
