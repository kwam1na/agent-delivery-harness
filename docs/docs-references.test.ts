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
 * These are checked by interpolating the computed value into the phrase the
 * document must contain, never by comparing the tree against a literal written
 * here. The difference is the whole point. A literal pin catches the tree
 * moving, but its failure message points at this file, so the repair that
 * suggests itself is to bump the literal — leaving the documented sentence
 * stale and now unguarded, with the suite green. Pinning the *sentence* means
 * the prose is what has to be re-stamped, which is the drift actually worth
 * catching in a documentation sensor.
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
 * Asserts that a documented sentence carries the value the tree computes.
 *
 * The direction matters, and it is the reason this helper exists rather than a
 * bare numeric literal. A pin written as `expect(computed).toBe(37)` moves the
 * staleness into this file: advancing the tree turns it red, the failure points
 * at the literal, and the natural repair is to bump the literal and leave the
 * prose saying thirty-seven forever. Interpolating the computed value into the
 * phrase the document must contain closes that loop — the sentence itself is
 * what has to be re-stamped, so prose that drifts from the tree is the failure
 * rather than the survivor.
 */
const documentStates = (document: string, phrase: string): void => {
  expect(textOf(document), `${document} no longer states: ${phrase}`).toContain(phrase);
};

describe("the computable counts the documentation states", () => {
  it("states the managed-delivery facade's operation inventory", () => {
    expect(FACADE_CAPABILITY_CLASSES.length).toBe(6);
    expect(FACADE_SURFACES.length).toBe(5);
    documentStates("docs/managed-delivery.md", `Each of the **${FACADE_OPERATIONS.length}** operations`);
    documentStates("README.md", `${FACADE_OPERATIONS.length}-operation inventory`);
  });

  it("states the delivery state vocabulary", () => {
    documentStates("docs/managed-delivery.md", `**${DELIVERY_STATES.length}** delivery states`);
    documentStates("README.md", `${DELIVERY_STATES.length} delivery states`);
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
    expect(commands.length).toBe(9);
    // Spelled as a word in the prose, which is why the phrase is pinned rather
    // than the digits: the sentence a reader actually meets is the claim.
    documentStates("README.md", "nine-command operator surface");
    documentStates("docs/agent-guide.md", "the nine-command operator surface");
  });

  it("states the conformance kit's vector count", () => {
    const kit = JSON.parse(readFileSync(path.join(REPO_ROOT, "packages/conformance/vectors/kit.json"), "utf8")) as {
      vectors: readonly unknown[];
    };
    for (const document of ["README.md", "docs/agent-guide.md"]) {
      documentStates(document, `${kit.vectors.length}-vector`);
    }
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
    documentStates("docs/managed-delivery.md", `ships **${projected.personas.length}** reviewer charters`);
  });
});
