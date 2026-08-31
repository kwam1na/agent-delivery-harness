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
 * modules, the vector count the conformance kit declares. Those are pinned here
 * against the thing itself, so that advancing the thing and forgetting the prose
 * is a failing test rather than a stale sentence. Numbers that are *judgements*
 * rather than computations are deliberately not pinned: there is nothing to
 * recompute them against, and a fake pin over a hand-maintained constant only
 * moves the staleness into this file.
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
    expect(references.length).toBeGreaterThanOrEqual(50);
    for (const document of scannedDocuments()) {
      expect(referencesOf(document).length, `${document} contributes no checked reference`).toBeGreaterThan(0);
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

describe("the computable counts the documentation states", () => {
  it("pins the managed-delivery facade's operation inventory", () => {
    expect(FACADE_OPERATIONS.length).toBe(37);
    expect(FACADE_CAPABILITY_CLASSES.length).toBe(6);
    expect(FACADE_SURFACES.length).toBe(5);
  });

  it("pins the delivery state vocabulary", () => {
    expect(DELIVERY_STATES.length).toBe(20);
  });

  it("pins the frozen product-trust label the documentation quotes", () => {
    expect(PRODUCT_TRUST_LABEL).toBe("local-digest / operator-pinned");
  });

  it("pins the nine-command CLI surface", () => {
    const commands = readdirSync(path.join(REPO_ROOT, "packages/cli/src/commands")).filter(
      (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"),
    );
    expect(commands.length).toBe(9);
  });

  it("pins the conformance kit's vector count", () => {
    const kit = JSON.parse(readFileSync(path.join(REPO_ROOT, "packages/conformance/vectors/kit.json"), "utf8")) as {
      vectors: readonly unknown[];
    };
    expect(kit.vectors.length).toBe(89);
  });

  it("pins the reviewer charter set the pinned composition ships", () => {
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
    expect(projected.personas.length).toBe(17);
    expect(projected.personas.every((persona) => persona.origin === "composition")).toBe(true);
  });
});
