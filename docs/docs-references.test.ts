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
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS } from "@agent-delivery-harness/cli";
import { runCliBoundary, EXIT_OK, EXIT_USAGE, EXIT_POLICY, EXIT_INTERRUPTED } from "../packages/cli/src/boundary.ts";
import * as ordinaryContext from "../packages/cli/src/ordinary-context.ts";
import { saveContextCommand } from "../packages/cli/src/commands/save-context.ts";
import { qualificationInputs } from "../scripts/qualify-agent-skills-provider.ts";
import { RESOLUTION_OUTCOMES } from "../packages/kernel/src/evaluator.ts";
import { commandFlags, flagsIn, harnessInvocations, runSubcommands } from "./cli-examples.ts";
import harnessConfig from "../harness.config.ts";
import {
  parseReviewOutcome,
  REVIEWER_RESULTS,
  digestCanonical,
  FACADE_CAPABILITY_CLASSES,
  FACADE_OPERATIONS,
  FACADE_SURFACES,
  DELIVERY_STATES,
  INTAKE_STATES,
  MANIFEST_REJECTION_REGISTRY,
  PRODUCT_TRUST_LABEL,
  projectShippedPersonas,
  readArchiveEntry,
  validateRunEventInput,
  RUN_GATE_REPORTED_OUTCOMES,
  RUN_ENDED_RESULTS,
  RUN_EVENT_KINDS,
  RUN_EVENT_KINDS_V1,
} from "@agent-delivery-harness/kernel";

const DOCS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DOCS_DIR, "..");

/**
 * The envelope a payload harvested from the documentation would reach the
 * validator inside, built the way `buildRunEvent` builds it for a live `emit`.
 *
 * `ticket` and `candidateTreeSha` are mirrored members: the grammar refuses an
 * event whose envelope and payload disagree about either, in both directions,
 * and the CLI satisfies that by copying them out of the payload verbatim.
 * Copying them here rather than hard-coding an envelope is what keeps these
 * rows a test of the documented payload instead of a test of this fixture —
 * a page that changes which ticket its examples name stays valid, and a page
 * that prints a malformed one still fails.
 */
const runEventEnvelope = (payload: unknown): Record<string, unknown> => {
  const members = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const mirrored = Object.fromEntries(
    (["ticket", "candidateTreeSha"] as const)
      .filter((member) => members[member] !== undefined)
      .map((member) => [member, members[member]]),
  );
  return {
    version: "run-event/2",
    eventId: "e1",
    runId: "run-1",
    at: "2026-09-07T12:00:00Z",
    repo: { commonDir: "/tmp/repo" },
    actor: { role: "executor" },
    attestation: "self",
    ...mirrored,
  };
};

/**
 * The documents this sensor owns: the root agent instructions, the README, and
 * the top-level guides. The
 * vendored spec and the vendored plan under `docs/spec/` and `docs/plans/` are
 * deliberately excluded — they are normative inputs reproduced verbatim, and
 * their internal references are the upstream author's, not this repository's to
 * keep resolvable. `docs/solutions/` and `docs/reports/` are narration, which
 * the gate already treats as review-neutral.
 */
const scannedDocuments = (): readonly string[] => [
  "AGENTS.md",
  "README.md",
  ...readdirSync(path.join(REPO_ROOT, "docs"))
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => path.join("docs", entry)),
];

interface DocumentReference {
  readonly document: string;
  readonly target: string;
  /**
   * The link target as a repository-relative POSIX path — the spelling
   * `git ls-files` would have to print for the link to resolve. Deliberately
   * not an absolute filesystem path: there is no longer one to hand to
   * `existsSync`, so the resolver this row was written with cannot be put back
   * at the call site without also reintroducing the field it needs.
   */
  readonly inTree: string;
}

/**
 * Every path this repository tracks, spelled exactly as git spells it, plus
 * every directory prefix of one.
 *
 * WHY NOT `existsSync`. `existsSync` asks the checkout; `git ls-files` asks the
 * tree, and only the second question has the same answer on every host. macOS
 * and Windows normalize case, so a link naming `.github/pull_request_template.md`
 * for the tracked `.github/PULL_REQUEST_TEMPLATE.md` resolved locally and did
 * not resolve on the Linux runners: this row passed on six consecutive local
 * gate runs of the delivery that introduced the link, and all three hosted
 * matrix jobs failed on it. Resolving against the index makes the row
 * case-exact everywhere, so the repair happens on the laptop where it is cheap.
 *
 * `-z` rather than newline splitting because git quotes and escapes unusual
 * path names in its default output and does not in the NUL-separated form.
 */
let trackedIndex: { readonly files: ReadonlySet<string>; readonly directories: ReadonlySet<string> } | undefined;
const trackedPaths = (): { readonly files: ReadonlySet<string>; readonly directories: ReadonlySet<string> } => {
  if (trackedIndex === undefined) {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter((entry) => entry !== "");
    const directories = new Set<string>();
    for (const file of files) {
      let directory = path.posix.dirname(file);
      while (directory !== "." && directory !== "/" && directory !== "") {
        directories.add(directory);
        directory = path.posix.dirname(directory);
      }
    }
    trackedIndex = { files: new Set(files), directories };
  }
  return trackedIndex;
};

/**
 * Whether a repository-relative POSIX path names something git tracks — a file,
 * or a directory that holds one. A trailing slash is how the guides write a
 * directory, and it is not part of the name.
 */
const isTracked = (inTree: string): boolean => {
  const normalized = inTree.replace(/\/+$/, "");
  const index = trackedPaths();
  return index.files.has(normalized) || index.directories.has(normalized);
};

/**
 * `existsSync`, made case-exact on a case-insensitive host: every segment must
 * appear, spelled this way, in its parent's own listing.
 *
 * Used where `isTracked` cannot answer — the paths the guides cite inside the
 * installed release live behind `.agent-skills/current`, which is a tracked
 * *symlink*, so the index knows the link and nothing beyond it. The class of
 * defect is the same one `isTracked` closes for links; the mechanism has to
 * differ because the target is not in the index at all.
 */
const existsCaseExactly = (relative: string): boolean => {
  let directory = REPO_ROOT;
  for (const segment of relative.split("/").filter((entry) => entry !== "" && entry !== ".")) {
    let entries: readonly string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return false;
    }
    if (!entries.includes(segment)) return false;
    directory = path.join(directory, segment);
  }
  return true;
};

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
    const inTree = path.relative(REPO_ROOT, path.resolve(documentDir, withoutAnchor)).split(path.sep).join("/");
    found.push({ document, target, inTree });
  }
  return found;
};

const allReferences = (): readonly DocumentReference[] => scannedDocuments().flatMap(referencesOf);

describe("the documentation's references", () => {
  it("scans exactly the documents this sensor owns", () => {
    // The enumeration itself, pinned. A `docs/*.md` guide added without a
    // decision about whether its links are checked shows up here first.
    expect(scannedDocuments()).toEqual([
      "AGENTS.md",
      "README.md",
      "docs/agent-guide.md",
      "docs/conformance.md",
      "docs/declared-checks.md",
      "docs/delivery-record.md",
      "docs/delivery-runbook.md",
      "docs/getting-started.md",
      "docs/managed-delivery.md",
      "docs/ordinary-resume.md",
      "docs/portable-evidence.md",
      "docs/product-artifacts.md",
      "docs/provider-guide.md",
      "docs/run-archives.md",
      "docs/run-artifacts.md",
      "docs/run-progress.md",
      "docs/run-view.md",
      "docs/spec-errata.md",
    ]);
  });

  it("finds references to check, in every document it scans", () => {
    // The anti-vacuity guard for the existence assertion below. Both halves
    // matter: the floor catches a regex that stops matching, and the
    // per-document assertion catches a scan that silently drops a file.
    const references = allReferences();
    // Keep this floor near the harvested count when the guide set grows. A
    // floor with room to spare is the one thing a partial drop fits through,
    // and a partial drop is the only failure this guard uniquely catches: a
    // scan that stops matching entirely is already caught by the two
    // assertions below.
    expect(references.length).toBeGreaterThanOrEqual(142);
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
    // The two references a delivering host arrives by. `AGENTS.md` is the only
    // entry point a fresh agent is given, so these two links are what make the
    // agent guide and the delivery runbook reachable at all; without them both
    // pages are unreferenced prose. Asserted against the same scanned array as
    // the existence check above, so a link that stops resolving fails there and
    // a link that is deleted outright fails here.
    for (const target of ["docs/agent-guide.md", "docs/delivery-runbook.md"]) {
      expect(
        references.some((reference) => reference.document === "AGENTS.md" && reference.target === target),
        `AGENTS.md no longer points a delivering host at ${target}`,
      ).toBe(true);
    }
  });

  /**
   * The corpus, plus two probes carried through the very same predicate.
   *
   * Without them this row is the assertion that shipped a broken link: it read
   * `existsSync`, and `existsSync` on this host says yes to a path whose case
   * differs from the tracked one and yes to a path git does not track at all.
   * The probes make both of those answers a failure of *this row*, on any host,
   * rather than a difference the hosted runners discover later — and they are
   * carried through `isTracked` at the same call site as the real references,
   * so a resolver swapped back at that call site cannot pass them.
   */
  it("links only to paths that exist in this tree", () => {
    // A case-flipped spelling of a path this tree really tracks. Rejected by
    // the index on every host; accepted by `existsSync` on this one.
    const caseProbe: DocumentReference = {
      document: "<probe>",
      target: ".github/pull_request_template.md",
      inTree: ".github/pull_request_template.md",
    };
    // Present in every checkout and tracked in none, so this one separates the
    // index from the filesystem on case-sensitive hosts too.
    const untrackedProbe: DocumentReference = { document: "<probe>", target: ".git", inTree: ".git" };
    expect(isTracked(".github/PULL_REQUEST_TEMPLATE.md"), "the case probe no longer names a tracked path").toBe(true);

    const broken = [...allReferences(), caseProbe, untrackedProbe]
      .filter((reference) => !isTracked(reference.inTree))
      .map((reference) => `${reference.document} -> ${reference.target}`);
    expect(broken).toEqual(["<probe> -> .github/pull_request_template.md", "<probe> -> .git"]);
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
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
  11: "eleven",
  12: "twelve",
  13: "thirteen",
  14: "fourteen",
  15: "fifteen",
  16: "sixteen",
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
    const commands = COMMANDS;
    expect(commands.length, "the CLI registry is empty").toBeGreaterThan(0);
    // Spelled as a word in the prose, so the computed count is mapped to its
    // word and that is what every statement must agree with — the digits are
    // never written down here.
    everyStatementAgrees("the CLI command count", /(\w+)-command operator surface/g, numberWord(commands.length));
  });

  it("states the evaluator resolution count", () => {
    everyStatementAgrees("the resolution count", /(\w+) resolution kinds/g, numberWord(RESOLUTION_OUTCOMES.length));
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
    // This resolves a pinned qualification fixture through the real mechanism.
    // The count claimed in the documentation is a claim about what the pinned
    // composition ships, so it is checked against that frozen archive rather
    // than against the installed generation the projection sensor reads, which
    // advances with each release.
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

  it("references the installed workflow for the rules it carries, rather than restating them", () => {
    // This row replaces an agreement check. `AGENTS.md` used to restate the
    // round bound and the grace round, and the check was that the restatement
    // still agreed with the installed workflow. The corpus's install
    // convention now says an overlay references the installed workflow for
    // every rule the workflow carries and restates none of them, so the
    // overlay carries the reference and this row checks that instead.
    //
    // This supersedes V26-1594's proposed phrase pin. That item assumed the
    // overlay still attributed the count exception to `review-work`; restoring
    // that attribution would now violate the no-restatement contract. The
    // current sensor instead pins the overlay's deferral, the absence of its
    // old restatement, and the rule in the installed skill that owns it.
    //
    // It is pinned from THREE ends, because "the overlay does not restate a
    // rule" is satisfied for free in two separate ways. An overlay that says
    // nothing at all satisfies it; so does a release that stopped carrying the
    // rule, at which point the overlay's "read from the installed skills"
    // sentence points at nothing. So for every rule the overlay defers on:
    // the installed generation must still carry it, the overlay's enumeration
    // must still name it, and no scanned document may restate it. The table
    // below is the enumeration — a rule the overlay defers on and this table
    // omits is unguarded in all three directions, which is why the overlay's
    // sentence is checked against the table rather than as one frozen phrase.
    const DEFERRED_RULES: readonly {
      readonly named: string;
      readonly skill: string;
      readonly carries: RegExp;
      readonly notRestated: readonly RegExp[];
    }[] = [
      {
        named: "the review round bound",
        skill: "review-work",
        carries: /The workflow default is \w+ rounds/,
        notRestated: [/at most \w+ review rounds/, /review rounds in total/],
      },
      {
        named: "the grace round",
        skill: "execute-work",
        carries: /exactly one grace verification round/,
        notRestated: [/grace verification round/, /at most once per delivery/],
      },
      {
        named: "how a deferral is tracked",
        skill: "execute-work",
        carries: /has a tracked follow-up item recorded through the tracker/,
        notRestated: [/tracked follow-up item/, /review\.deferral-untracked/],
      },
      {
        named: "how a finding is resolved",
        skill: "obtain-review",
        carries: /A finding is closed, deferred, or declined only by the lens that filed it/,
        notRestated: [/only by the lens that filed it/, /only P0 and P1/],
      },
    ];

    const installedSkill = (skill: string): string =>
      readFileSync(path.join(REPO_ROOT, ".agent-skills/current/skills", skill, "SKILL.md"), "utf8").replace(/\s+/g, " ");

    // Read with whitespace collapsed, because these are sentence checks over
    // hard-wrapped prose: a rule name or a restatement that happens to fall
    // across a line break must read the same as one that does not, in both the
    // presence and the absence directions.
    const collapsed = (document: string): string => textOf(document).replace(/\s+/g, " ");

    const overlay = collapsed("AGENTS.md");
    expect(overlay, "AGENTS.md no longer defers to the installed workflow").toContain(
      "Rules the installed workflow already carries are not restated here",
    );
    expect(overlay, "AGENTS.md no longer says where those rules are read from").toContain(
      "read from the installed skills",
    );

    const enumeration = /not restated here — (.*?) are read from the installed skills/.exec(overlay);
    expect(enumeration, "the overlay has no deferred-rule enumeration").not.toBeNull();
    expect(enumeration![1]!.split(/, (?:and )?/).sort()).toEqual(DEFERRED_RULES.map(rule => rule.named).sort());

    for (const rule of DEFERRED_RULES) {
      // The release still carries it. Without this the row would let a
      // generation drop a rule while the overlay went on deferring to it.
      expect(
        rule.carries.test(installedSkill(rule.skill)),
        `the installed ${rule.skill} skill no longer carries ${rule.named}`,
      ).toBe(true);
      // The overlay still names it in the sentence that defers. Without this,
      // deleting a rule from that enumeration would silently drop it from the
      // overlay's claim while every other assertion here stayed green.
      expect(overlay, `AGENTS.md no longer names ${rule.named} among the rules it defers on`).toContain(rule.named);
      // And nothing restates it. Each pattern is a shape the overlay carried
      // before the trim, or the shape the installed skill states the rule in —
      // a restatement in any scanned document puts the two texts back in a
      // position to disagree silently.
      for (const document of scannedDocuments()) {
        for (const restatement of rule.notRestated) {
          expect(
            restatement.test(collapsed(document)),
            `${document} restates ${rule.named}, which the installed workflow carries: ${restatement.source}`,
          ).toBe(false);
        }
      }
    }
  });
});

/**
 * Prose that carries a rule, rather than a number.
 *
 * WHY THIS BLOCK EXISTS. Everything above pins a documented *value* against
 * something the tree computes. A sentence that states a rule has no computed
 * counterpart, so nothing above it can disagree with it — and the failure that
 * follows is not drift but deletion: the rule is removed, trimmed to one of its
 * halves, or inverted outright, and every check in this file stays green
 * because the links still resolve and the counts still agree. The guidance
 * below is read by a delivering host and by nothing else in this tree, so a pin
 * here is the only thing standing between it and an ordinary edit.
 *
 * The pins are deliberately of two shapes. A rule's own words are pinned by
 * presence, the way `documentStates` already pins the trust label, because
 * there is nothing else to compare them against. The identifiers the rule
 * quotes are pinned by agreement against the documents that define them, so a
 * sanctioned rename in the policy or the code registry re-stamps the sentence
 * instead of leaving it quietly wrong.
 */
describe("the rules the documentation states in prose", () => {
  const GUIDE = "docs/agent-guide.md";

  /**
   * A sentence check over the guide as a reader receives it, not over its
   * bytes. HTML comments are removed first, because a rule commented out is a
   * rule the document no longer states while every byte of it is still there —
   * presence over raw bytes reads that as unchanged. Whitespace is then
   * collapsed, so a phrase falling across a line break reads the same as one
   * that does not and a rewrap is correctly not a failure; that half is the
   * treatment the deferred-rules row above gives `AGENTS.md`.
   */
  const statesInProse = (phrase: string): void => {
    const stated = textOf(GUIDE)
      .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
      .replace(/\s+/g, " ");
    expect(stated, `${GUIDE} no longer states: ${phrase}`).toContain(phrase);
  };

  it("states where a review lens that plants mutations runs them", () => {
    // The instruction in each of its clauses: which worktree the lens gets,
    // which revision that worktree carries, where it may live, and which
    // worktree it may never use. Any one clause alone is satisfied by a
    // sentence that no longer says the thing — a rule trimmed to a subset of
    // itself is the failure this row exists to catch, so every clause the rule
    // is made of is pinned rather than a representative one.
    statesInProse("gets its own worktree of this repository");
    statesInProse("reset to the revision the round is bound to");
    statesInProse("beside the delivery worktree rather than under it");
    statesInProse("never the delivery worktree");
    // What the delivery worktree must hold while that happens, and who puts it
    // back. Without these the rule says where a lens may plant and nothing
    // about the state the loop needs the delivery worktree left in.
    statesInProse("The delivery worktree stays clean for the whole loop");
    statesInProse("restores its own probe");
    // And both failure modes, because the guidance's own claim is that either
    // one alone reads as an annoyance rather than as a correctness problem.
    statesInProse("A mutated tree read concurrently produces a phantom finding.");
    statesInProse("A tree carrying a plant cannot be captured.");
  });

  it("names the mandated testing lens and its charter as the policy binds them", () => {
    const policy = JSON.parse(readFileSync(path.join(REPO_ROOT, ".agents/policy/repository-policy.json"), "utf8")) as {
      readonly reviewLenses: readonly { readonly lensId: string; readonly category: string; readonly personaId: string }[];
    };
    const testing = policy.reviewLenses.filter((lens) => lens.category === "testing-policy");
    // Anti-vacuity from both ends: a policy that declares no testing lens, or
    // more than one, would otherwise satisfy the loop below with nothing in it.
    expect(testing.length, "the repository policy declares no single testing-policy lens").toBe(1);
    for (const document of [GUIDE, "docs/delivery-runbook.md"]) {
      const prose = textOf(document).replace(/<!--[\s\S]*?(?:-->|$)/g, " ").replace(/\s+/g, " ");
      for (const lens of testing) {
        expect(prose).toContain(`\`${lens.personaId}\``);
        expect(prose).toContain(`\`${lens.lensId}\``);
      }
    }
  });

  it("invokes only harness commands, npm scripts and run-event kinds that exist", () => {
    // The runbook is a page of commands a fresh agent copies verbatim, and
    // nothing else in this tree executes it — `docs-examples.test.ts` reads
    // `getting-started.md` and no other page. So an invented command, a
    // renamed one, or one deleted from the CLI would sit there looking
    // authoritative with the whole suite green. Every `harness -- <command>`
    // the page writes is checked against the command modules that exist.
    const runbook = textOf("docs/delivery-runbook.md");
    const invoked = harnessInvocations(runbook).map(invocation => invocation.command)
      .filter(command => command !== "--help"); // Global help is not a command name.
    // Anti-vacuity from both ends, for the same reason the link scan has it: a
    // regex that stops matching would satisfy the loop below with nothing in
    // it, and a partial harvest would satisfy a bare floor.
    expect(new Set(invoked).size, "the runbook invokes no harness command").toBeGreaterThanOrEqual(8);
    expect(invoked, "the runbook walks through `prepare`").toContain("prepare");
    // Against the registry the CLI actually dispatches on, not against the
    // filenames beside it: a module present but unregistered dispatches
    // nothing, and the filename check would still pass.
    const registered = new Set(COMMANDS.map((command) => command.name));
    expect(registered.size, "the CLI registers no command").toBeGreaterThan(0);
    expect([...new Set(invoked)].filter((command) => !registered.has(command))).toEqual([]);

    // The page reaches the CLI through npm scripts, so an invented script name
    // fails as loudly as an invented command and was equally unchecked.
    const scripts = new Set(
      Object.keys(JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts ?? {}),
    );
    const run = [...runbook.matchAll(/npm run (?:--silent )?([a-z][a-z:-]*)/g)].map((match) => match[1]!);
    expect(new Set(run).size, "the runbook runs no npm script").toBeGreaterThanOrEqual(3);
    expect(run, "the runbook runs the gate").toContain("check");
    expect([...new Set(run)].filter((script) => !scripts.has(script))).toEqual([]);

    // Every run-event kind the page *names*, against the frozen vocabulary — not
    // only the ones it prefixes with `emit`. The row's title is a general claim
    // over the page's kinds, and half the kinds this page carries appear only in
    // the prose paragraph listing the others worth emitting; harvesting on the
    // literal `emit ` prefix left exactly those five unchecked, which is the
    // half most likely to be invented because it was never executed.
    const kinds = new Set<string>([...RUN_EVENT_KINDS, ...RUN_EVENT_KINDS_V1]);
    expect(kinds.size, "the kernel exports no run-event kinds").toBeGreaterThan(0);
    // Every kind in both grammars is dotted lowercase, so requiring the dot
    // matches every real `emit <kind>` while leaving prose like "emit the pair
    // the policy names" alone. A bare word after `emit` is English, not a kind.
    const emitted = [...runbook.matchAll(/emit ([a-z]+(?:\.[a-z]+)+)/g)].map((match) => match[1]!);
    // The prose side. Fenced blocks are removed first: a fence's own ``` would
    // otherwise pair with the next inline backtick and hand this scan spans that
    // are neither prose nor code. Each remaining inline span contributes its
    // leading dotted-lowercase token, and only when the token ends there —
    // `(?![\w-])` is what keeps `lens.outcome-correctness`, an id and not a
    // kind, from arriving here truncated to `lens.outcome`. Filename-shaped
    // tokens (`package.json`, `gate.yml`, `harness.config.ts`) share the kind
    // shape and are dropped by extension; a kind renamed into anything else
    // stays in the set and fails below.
    const named = [...runbook.replace(/```[\s\S]*?```/g, " ").matchAll(/`([^`\n]+)`/g)]
      .map((match) => /^([a-z]+(?:\.[a-z]+)+)(?![\w-])/.exec(match[1]!)?.[1])
      .filter((token): token is string => token !== undefined)
      .filter((token) => !/\.(ts|js|mjs|cjs|json|jsonl|md|yml|yaml|sh|lock)$/.test(token));
    const allKinds = [...new Set([...emitted, ...named])];
    // Anti-vacuity, raised to the harvest this page now yields: a floor of four
    // was satisfied by the eight executable kinds alone, so a prose scan that
    // silently stopped matching would have changed nothing.
    expect(allKinds.length, "the runbook names too few run-event kinds to have been scanned").toBeGreaterThanOrEqual(14);
    expect(emitted, "the runbook opens the run").toContain("run.started");
    expect(allKinds, "the runbook no longer names the kinds it recommends in prose").toContain("gate.reported");
    expect(allKinds.filter((kind) => !kinds.has(kind))).toEqual([]);

    // The member lists the page prints beside those prose-named kinds, run
    // through the validator rather than read. The page writes them as
    // `<kind> {"a","b"[,"c"]}`, so the members are harvested from the page and
    // the payload is built from what it says: a member the page renames —
    // `durationMs` to `duration`, say — becomes an unknown member and the
    // envelope is refused here instead of at an agent's live emit.
    const sample: Record<string, unknown> = {
      command: "npm run check", outcome: "pass", durationMs: 1000, ticket: "V26-0000",
      code: "candidate_unprepared", summary: "s", fork: "f", choice: "c", cited: "round-1",
      reference: "docs/solutions/x.md",
    };
    const listed = [...runbook.matchAll(/`([a-z]+(?:\.[a-z]+)+) \{([^}]*)\}/g)];
    expect(listed.length, "the runbook lists no payload members beside a kind").toBeGreaterThanOrEqual(4);
    for (const [, kind, members] of listed) {
      const names = [...members!.matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]!);
      expect(names.length, `the runbook lists no members for ${kind}`).toBeGreaterThan(0);
      const payload = Object.fromEntries(names.map((name) => [name, sample[name] ?? "x"]));
      expect(
        validateRunEventInput({ ...runEventEnvelope(payload), kind: kind!, payload }).ok,
        `the runbook's stated payload for ${kind} is refused by the frozen grammar`,
      ).toBe(true);
    }
  });

  it("states the base-movement rule the gate configuration actually carries", () => {
    // The runbook's whole tail — the serialized merge, the byte-identity
    // replay — hangs off this one setting. Pinned by agreement rather than by
    // presence, so relaxing the configuration re-stamps the sentence instead
    // of leaving it confidently wrong.
    // Read from the validated config object, not from its source text: a
    // regex over the file cannot tell a deleted setting from a renamed one,
    // and would go quiet — passing nothing — the moment the member moved.
    const declared = harnessConfig.deliveryRecordVerification?.baseMovement;
    expect(declared, "harness.config.ts declares no deliveryRecordVerification.baseMovement").toBeDefined();
    documentStates("docs/delivery-runbook.md", `baseMovement: "${declared!}"`);
  });

  it("splits the round-event members the way the frozen grammar actually does", () => {
    // A wrong member list on this page is the worst kind of documentation
    // defect here: the emit is refused at runtime, in the middle of a round,
    // by a page the agent is copying verbatim. Pinned behaviourally — the
    // validator is asked, not the source text — so the sentence re-derives if
    // the grammar ever moves a member across the two events.
    const runbookStates = (phrase: string): void => {
      const stated = textOf("docs/delivery-runbook.md").replace(/\s+/g, " ");
      expect(stated, `docs/delivery-runbook.md no longer states: ${phrase}`).toContain(phrase);
    };
    const tree = "a".repeat(40);
    const closed = {
      version: "run-event/2", eventId: "e1", runId: "run-1", at: "2026-09-07T12:00:00Z",
      repo: { commonDir: "/tmp/repo" }, actor: { role: "executor" }, attestation: "self",
      kind: "review.round.closed", candidateTreeSha: tree,
      payload: {
        round: 1, roundId: "round-1", candidateTreeSha: tree, outcome: "aligned",
        findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
        cost: { coverage: "unreported", reportedBy: "claude-code" },
      },
    };
    // Anti-vacuity: if the baseline envelope stopped validating, every
    // rejection below would pass for the wrong reason.
    expect(validateRunEventInput(closed).ok, "the six-member closed envelope is refused").toBe(true);
    for (const member of ["bound", "grace", "reopensRoundId"]) {
      const value = member === "grace" ? true : member === "bound" ? 4 : "round-1";
      expect(
        validateRunEventInput({ ...closed, payload: { ...closed.payload, [member]: value } }).ok,
        `review.round.closed accepts \`${member}\` after all`,
      ).toBe(false);
      runbookStates(`\`${member}\``);
    }
    runbookStates("adds the optional `bound`, `grace` and `reopensRoundId` to `review.round.opened` **only**");
    runbookStates("no `lateFindings` member");

    // The enumeration the page gives, checked against the set the validator
    // actually accepts rather than against a list retyped here. Deriving it
    // both ways — a member whose removal is refused is in; a candidate whose
    // addition is refused is out — is what makes truncating the sentence, or
    // padding it with `reopensRoundId`, a failure. A literal `toContain` on
    // the whole sentence would catch neither once the wording drifts.
    const baseline = Object.keys(closed.payload);
    const accepted = baseline.filter((member) => {
      const without = { ...closed.payload } as Record<string, unknown>;
      delete without[member];
      return !validateRunEventInput({ ...closed, payload: without }).ok;
    });
    for (const candidate of ["bound", "grace", "reopensRoundId", "lateFindings"]) {
      if (validateRunEventInput({ ...closed, payload: { ...closed.payload, [candidate]: "x" } }).ok) {
        accepted.push(candidate);
      }
    }
    expect(accepted.slice().sort(), "the derived member set stopped matching the baseline envelope").toEqual(
      baseline.slice().sort(),
    );
    const sentence = /accepted\s+members\s+of\s+`review\.round\.closed`\s+are\s+exactly([^;]+);/.exec(
      textOf("docs/delivery-runbook.md").replace(/\s+/g, " "),
    );
    expect(sentence, "docs/delivery-runbook.md no longer enumerates review.round.closed's members").not.toBeNull();
    const enumerated = [...sentence![1]!.matchAll(/`([a-zA-Z]+)`/g)].map((match) => match[1]!);
    expect(enumerated.slice().sort(), "the runbook's enumeration is not the set the grammar accepts").toEqual(
      accepted.slice().sort(),
    );

    // Section 6's carrier claim — the exact sentence a round-1 finding was
    // filed against. It sits far from the enumeration above, in the section a
    // reader is in when a base has moved, so it needs its own pin.
    runbookStates("the next `review.round.opened` carries `reopensRoundId`");
  });

  // Two payload shapes the runbook writes at points where being wrong is
  // expensive: `run.ended` is terminal, and `decision.recorded` is the only
  // place a version-1 journal can carry a citation. Both were stated wrongly
  // once, from a friction log rather than from the grammar, so pin them
  // behaviourally: the shape the page tells an agent to emit must validate,
  // and the misspelling the page warns about must not.
  it("writes run-event payloads the frozen grammar accepts", () => {
    const raw = textOf("docs/delivery-runbook.md");
    const runbook = raw.replace(/\s+/g, " ");
    const envelope = {
      version: "run-event/2",
      eventId: "e1",
      runId: "run-1",
      at: "2026-09-07T12:00:00Z",
      repo: { commonDir: "/tmp/repo" },
      actor: { role: "executor" },
      attestation: "self",
    } as const;
    const cost = { coverage: "unreported", reportedBy: "claude-code" };

    // THE PAYLOADS THE PAGE ACTUALLY PRINTS, harvested rather than retyped.
    // The prose and the command beneath it are two independent surfaces, and a
    // page whose sentence says `there is no note` above a command that sends
    // one is worse than either alone, because the agent copies the command.
    // So every `emit <kind> … --json <payload>` in every fenced block is pulled
    // out, un-shelled, and put through the same validator a live emit reaches.
    //
    // Un-shelling is two substitutions and no guessing: continuation backslashes
    // are joined, the double-quoted form's `\"` is unescaped, and the shell
    // interpolations the page writes are replaced with grammar-valid literals
    // from a table. Anything else placeholder-shaped left in a payload fails the
    // row rather than being silently accepted — a new `<placeholder>` has to be
    // given a literal here before its command can be claimed valid.
    const literals: Record<string, string> = {
      $TREE: "a".repeat(40),
      $DELIVERY_HOST: "codex",
      "<pr url>": "https://example.test/pull/1",
      "<why>": "the delivery uses the mandated pair only",
    };
    const printed = [...raw.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
      .flatMap((block) => block[1]!.replace(/\\\n\s*/g, " ").split("\n"))
      .map((line) => /\bemit\s+([a-z]+(?:\.[a-z]+)+)\b.*?--json\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => {
        const shell = match[2] ?? match[3]!.replace(/\\"/g, '"');
        const json = Object.entries(literals).reduce(
          (text, [token, literal]) => text.split(token).join(literal),
          shell,
        );
        return { kind: match[1]!, json };
      });
    // Anti-vacuity from both ends, and named rather than counted: a regex that
    // stopped matching, or matched only the easy single-quoted blocks, would
    // otherwise satisfy the loop below with nothing in it. `run.ended` is
    // terminal and `review.round.opened` is the double-quoted interpolated form.
    expect(printed.length, "no `emit … --json` command was harvested from the runbook").toBeGreaterThanOrEqual(8);
    for (const kind of ["run.started", "review.round.opened", "review.round.closed", "pr.opened", "run.ended"]) {
      expect(printed.map((command) => command.kind), `the runbook stopped printing an ${kind} command`).toContain(kind);
    }
    for (const { kind, json } of printed) {
      expect(json, `the runbook's ${kind} payload still carries an unresolved placeholder`).not.toMatch(/[<$]/);
      let payload: unknown;
      expect(() => {
        payload = JSON.parse(json);
      }, `the runbook's ${kind} payload is not valid JSON: ${json}`).not.toThrow();
      const verdict = validateRunEventInput({ ...runEventEnvelope(payload), kind, payload });
      expect(
        verdict.ok,
        `the runbook prints a ${kind} payload the frozen grammar refuses: ${json}`,
      ).toBe(true);
    }

    // `run.ended` takes exactly `result` and `cost`, both required. A `note`
    // member — the thing the merge-ready branch once told an agent to send —
    // is refused, and so is dropping `cost`.
    const ended = { ...envelope, kind: "run.ended", payload: { result: "complete", cost } };
    expect(validateRunEventInput(ended).ok, "the runbook's run.ended payload is refused").toBe(true);
    expect(
      validateRunEventInput({ ...ended, payload: { result: "complete" } }).ok,
      "run.ended no longer requires cost",
    ).toBe(false);
    expect(
      validateRunEventInput({ ...ended, payload: { result: "complete", cost, note: "merge-ready" } }).ok,
      "run.ended accepts a note after all",
    ).toBe(false);
    expect(runbook, "docs/delivery-runbook.md no longer says run.ended has no note member").toContain(
      "there is no `note`",
    );

    // `decision.recorded` does have the optional member — spelled `cited`.
    const decision = {
      ...envelope,
      kind: "decision.recorded",
      payload: { fork: "f", choice: "c", cited: "round-1" },
    };
    expect(validateRunEventInput(decision).ok, "decision.recorded rejects `cited`").toBe(true);
    expect(
      validateRunEventInput({ ...decision, payload: { fork: "f", choice: "c", citation: "round-1" } }).ok,
      "decision.recorded accepts `citation` after all",
    ).toBe(false);
    expect(runbook, "docs/delivery-runbook.md no longer directs the citation into `cited`").toContain(
      "put the round you are continuing in `cited`",
    );

    // Two closed vocabularies the page spells out. Both are frozen exports, so
    // the page can be held to them by agreement instead of by a retyped list:
    // re-freezing either one re-stamps the runbook rather than leaving it
    // confidently wrong about a token an agent copies into a live emit.
    expect(RUN_GATE_REPORTED_OUTCOMES.length, "the gate-outcome vocabulary is empty").toBeGreaterThan(0);
    expect(
      runbook,
      "docs/delivery-runbook.md no longer lists the gate.reported outcome vocabulary the kernel freezes",
    ).toContain(RUN_GATE_REPORTED_OUTCOMES.map((outcome) => `\`${outcome}\``).join(", "));
    expect(RUN_ENDED_RESULTS, "run.ended no longer accepts the result the runbook emits").toContain("complete");
    expect(printed.find((command) => command.kind === "run.ended")?.json).toContain('"result":"complete"');
  });

  it("names only paths that exist in the agent guide's shape section", () => {
    // The section is a map a reader navigates by. Every entry it carried before
    // this delivery was a path, and one of them — `delivery/charters` — had
    // stopped existing with the whole suite green, which is why it was
    // rewritten. Presence of the block is not the claim; resolution of each
    // path is.
    //
    // And the claim is over the section, not over the block's first column.
    // Parsing column one alone left the paths in the description text
    // unchecked — `docs/plans/`, `docs/solutions/`, `docs/contracts/` — and
    // left the trailing paragraph that resolves a lens charter to
    // `.agent-skills/current/personas/` unchecked too, which is the very
    // sentence that replaced the path that had rotted. So: column one, plus
    // every slash-bearing token anywhere in the section.
    const guide = textOf("docs/agent-guide.md");
    const section = /## The shape of the repository\n([\s\S]*?)\n## /.exec(guide);
    expect(section, "docs/agent-guide.md has no shape section").not.toBeNull();
    const block = /```\n([\s\S]*?)```/.exec(section![1]!);
    expect(block, "the shape section has no fenced block").not.toBeNull();
    const columnOne = block![1]!
      .split("\n")
      .map((line) => /^(\S+)\s\s+\S/.exec(line)?.[1])
      .filter((entry): entry is string => entry !== undefined);
    // A path token is one bearing a separator, so it is recognised the same in
    // a table row, in a description continuation line and in a paragraph. The
    // lookbehind keeps a token from being harvested from its own middle; the
    // two extensionless names in column one (`AGENTS.md`, `harness.config.ts`)
    // carry no separator and arrive from the column-one pass instead.
    const referenced = [...section![1]!.matchAll(/(?<![\w./-])((?:\.?[A-Za-z][\w.-]*)(?:\/[\w.-]*)+)/g)].map(
      (match) => match[1]!,
    );
    const paths = [...new Set([...columnOne, ...referenced])];
    // Anti-vacuity from both ends, and raised past the block's own row count so
    // that a regex which stops reaching the prose fails rather than passing on
    // the table alone.
    expect(columnOne.length, "the shape block yields no rows").toBeGreaterThanOrEqual(17);
    expect(paths.length, "the shape section yields no paths outside its table").toBeGreaterThanOrEqual(23);
    expect(paths, "the shape block names the root instruction file").toContain("AGENTS.md");
    expect(paths, "the shape section no longer says where a lens charter resolves from").toContain(
      ".agent-skills/current/personas/",
    );
    expect([...paths, ".github/pull_request_template.md"].filter((entry) => !existsCaseExactly(entry))).toEqual([".github/pull_request_template.md"]);
  });

  it("names only paths that exist in the delivery runbook's prose", () => {
    // Harvest rooted in-tree tokens, including installed symlinks. Illustrations,
    // globs, refs and placeholders are not paths a reader can open.
    const runbook = textOf("docs/delivery-runbook.md").replace(/```[\s\S]*?```/g, " ");
    const cited = [...new Set([...runbook.matchAll(/`([^`\n]+)`/g)]
      .map(match => match[1]!)
      .filter(token => /^(?:\.agent-skills|\.agents|\.claude|\.github|packages|scripts|docs|delivery|telemetry|qualifications)\/[\w./-]+$/.test(token)))];
    expect(cited.length, "the runbook lost a prose path").toBeGreaterThanOrEqual(27);
    expect(textOf("docs/delivery-runbook.md")).toContain("`$DELIVERY_SKILLS/obtain-review/references/round-brief-template.md`");
    for (const exposure of [".agents/skills", ".claude/skills"]) {
      expect(cited).toContain(exposure);
      expect(existsCaseExactly(`${exposure}/obtain-review/references/round-brief-template.md`)).toBe(true);
    }
    // The wrong-case token is an explicitly documented counterexample; neutral
    // prefixes describe configured output locations that may not exist yet.
    const resolvable = cited.filter(entry => entry !== ".github/pull_request_template.md" &&
      !harnessConfig.reviewNeutral.some(rule => rule.prefix === entry));
    expect([...resolvable, ".github/pull_request_template.md"].filter(entry => !existsCaseExactly(entry)))
      .toEqual([".github/pull_request_template.md"]);
  });

  it("pairs the rejection code that blocks a capture with the rule the registry gives it", () => {
    // The key is a literal, and this file is not typechecked — `docs/**` sits
    // outside every `tsconfig` include, so the key type buys nothing here. It
    // is a runtime read instead: a code renamed in `validator/codes.ts` leaves
    // no entry to read and fails this row, rather than leaving the pairing
    // unchecked.
    const rules = MANIFEST_REJECTION_REGISTRY["candidate_unprepared"].rules;
    expect(rules.length, "the registry gives candidate_unprepared no rule").toBeGreaterThan(0);
    for (const rule of rules) statesInProse(`${rule} \`candidate_unprepared\``);
  });
});

/**
 * The runbook's corrections, pinned.
 *
 * These are the sentences that exist because a delivery got them wrong: each
 * one contradicts the obvious guess, each was paid for in a lost round or a
 * damaged sibling delivery. Trimming the historical guidance can leave the
 * page recommending the thing that failed, while an outdated computed claim
 * can survive intact. Presence is the only
 * available pin for historical incidents and operator instructions. The help,
 * save-context, policy, paths and vocabulary rows below instead compare the
 * behavior or defining data. Shell availability, process-group discipline,
 * manual restoration, interrupted-lens relaunch, review-context retention and
 * the order a human performs a rebase have no deterministic repository
 * counterpart: presence is the ceiling for those historical/operator claims,
 * not a proof against arbitrary natural-language negation. The bounded
 * negation probes below additionally cover demonstrated inversions.
 */
describe("the corrections the delivery runbook carries", () => {
  const statesInProse = (phrase: string): void => {
    const stated = textOf("docs/delivery-runbook.md")
      .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
      .replace(/\s+/g, " ");
    expect(stated, `docs/delivery-runbook.md no longer states: ${phrase}`).toContain(phrase);
  };

  it("says a byte-identical replay is still checked before it counts as a reopen", () => {
    statesInProse("Run `npm run check` on the replayed candidate before deciding a round is a reopen.");
    statesInProse("Compare the **delivered lines**, not the raw diff bytes.");
    // The recipe's own two corrections. Without the space the header filter
    // also eats a delivered line beginning `--`/`++`, so a changed markdown
    // rule canonicalizes to the empty digest and a counted round is reopened
    // for free; without `--name-status` the hash omits the path set the
    // sentence above it promises.
    statesInProse("The **space** in `'^(\\+\\+\\+ |--- )'` is what keeps it a header filter");
    statesInProse("the `--name-status` line is what puts the **path set** inside the hash");
    // And the command itself, not only the paragraph explaining it. The
    // explanation is what a reader is persuaded by; the pipeline is what they
    // copy, and the two can drift apart in either direction.
    statesInProse("grep -Ev '^(\\+\\+\\+ |--- )'");
    statesInProse("git diff --name-status <base>..<head> -- . ':!delivery/records'");
  });

  /**
   * The one correction on this page whose truth is conditional on the CLI, so
   * the one that must not be pinned by presence alone. It was hedged once — into
   * "whether `<command> --help` is safe depends on the build" — on the strength
   * of a sibling delivery's fix that had not merged, and the hedge is what an
   * agent skims past on its way to running `record --help` mid-round. Held to
   * the boundary and the command modules by agreement instead, which is how this
   * row earned its keep: the fix landed on this delivery's base mid-review, the
   * row went red on the replay, and the page had to be re-stamped to the
   * predicate the boundary now carries rather than left warning about a hazard
   * that is gone. The day one of these commands starts parsing its arguments,
   * the same thing happens again; the day a fourth stops, the page has to name
   * it.
   */
  it("names the commands whose `--help` executes them, as the CLI behaves today", async () => {
    const boundary = readFileSync(path.join(REPO_ROOT, "packages/cli/src/boundary.ts"), "utf8");
    // The arity is the whole safety property: a help request is answered by the
    // boundary only when `--help` is the entire argument list, so a page that
    // said "`--help` is safe" without saying "alone" would be wrong in the one
    // direction that costs a round.
    const predicate = /args\.length === (\d+) && \(args\[0\] === "--help" \|\| args\[0\] === "-h"\)/.exec(boundary);
    expect(predicate, "the CLI boundary no longer answers help from one arity-checked predicate").not.toBeNull();
    const arity = Number(predicate![1]);
    statesInProse(`**exactly ${numberWord(arity)} argument${arity === 1 ? "" : "s"}**`);

    const commands = readdirSync(path.join(REPO_ROOT, "packages/cli/src/commands"))
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
    // Anti-vacuity: a scan that stopped reading the directory would leave
    // nothing to disagree, and the branch below would pass on an empty set.
    expect(commands.length, "no command modules were read").toBeGreaterThan(5);
    const registered = new Set(COMMANDS.map((command) => command.name));
    // A module that never mentions its arguments cannot be judging a call that
    // carries one: `--help` beside another token reaches it as an ordinary
    // invocation and it runs.
    const executes = commands
      .filter((entry) => !/\bcontext\.args\b/.test(readFileSync(path.join(REPO_ROOT, "packages/cli/src/commands", entry), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ")))
      .map((entry) => entry.replace(/\.ts$/, ""))
      .filter((name) => registered.has(name));

    const prose = textOf("docs/delivery-runbook.md").replace(/\s+/g, " ");
    const clause = /((?:`[a-z-]+\.ts`(?:, | and )?)+) never read their arguments at all/.exec(prose);
    if (executes.length === 0) {
      // Which is where this tree stands: every registered command judges its own
      // argument list, so the page must not still be warning about the hazard,
      // and must say what replaced it.
      expect(clause, "no command module ignores its arguments, but the runbook still names some that do").toBeNull();
      statesInProse("is a usage refusal at exit `2` rather than a delivery record");
    } else {
      expect(clause, "docs/delivery-runbook.md no longer names the commands whose `--help` executes them").not.toBeNull();
      const named = [...clause![1]!.matchAll(/`([a-z-]+)\.ts`/g)].map((match) => match[1]!);
      expect(named.slice().sort(), "the runbook's `--help` warning is not the set of commands that ignore arguments").toEqual(
        executes.slice().sort(),
      );
    }
    statesInProse("**`<command> --help` is answered read-only, and only when it stands alone.**");
    statesInProse("prints that command's usage and writes nothing");
    statesInProse("before it loads config, wires anything, or observes the command");
    statesInProse("Any other token on the line stops it being a help request, and every command then judges the call itself");
    statesInProse("`--help` or `-h`");
    const output: string[] = [];
    const loadConfig = vi.fn(() => { throw new Error("help loaded configuration"); });
    const runtime = { cwd: REPO_ROOT, env: {}, stdinIsTTY: false, stdoutIsTTY: false,
      stdout: (text: string) => output.push(text), stderr: (text: string) => { throw new Error(text); }, loadConfig };
    // Include both dispatch classes: moving help below config-free dispatch must
    // fail too, even though the configured `record` command still answers safely.
    for (const name of ["record", "runs"]) {
      for (const flag of ["--help", "-h"]) {
        output.length = 0;
        const args = Array.from({ length: arity }, () => flag);
        expect(await runCliBoundary([name, ...args], COMMANDS, runtime)).toBe(EXIT_OK);
        expect(output.join("")).toBe(`${COMMANDS.find(command => command.name === name)!.usage}\n`);
      }
    }
    expect(loadConfig).not.toHaveBeenCalled();
    const helpExit = await runCliBoundary(["--help"], COMMANDS, runtime);
    const emptyExit = await runCliBoundary([], COMMANDS, runtime);
    statesInProse(`prints the command listing and exits \`${helpExit}\``);
    statesInProse(`prints the same listing and exits \`${emptyExit}\``);
    // And the consequence, not only the rule: a correction trimmed to its
    // mechanism stops saying why the reader should care, and the hazard is what
    // an older checkout still has.
    statesInProse("a delivery record written and the worktree dirtied mid-round");
  });

  /**
   * The rest of the corrections this page carries because a delivery paid for
   * them, each with no computable counterpart in this tree. Presence again, one
   * assertion per rule, for the reason the block comment above this describe
   * gives: deletion is the failure mode, and a page trimmed to its confident
   * half reads like an edit.
   */
  it("says which shell this loop runs in and what that shell breaks", () => {
    statesInProse("Write `--include='*.ts'`");
    statesInProse("Put the loop in a `#!/bin/bash` file and run the file.");
    statesInProse("**There is no `timeout(1)`**");
  });

  /**
   * The page's other conditional correction, and the second one a sibling
   * delivery has invalidated under it.
   *
   * `save-context` built a `run-event/1` event unconditionally, so a version-2
   * journal refused it as `unsupported_spec` and the page told a delivering
   * agent to skip the command. V26-1960 made it write at the run's own writer
   * version instead. Pinned by presence, the old sentence would have stayed
   * green while sending an agent past a command that now works — the same
   * failure the `--help` row two rows up exists to prevent, and the same one
   * that cost this page's first delivery its grace round. So this claim is held
   * to the command's emitted events and writer output, not a token in its
   * source. The command probe also reaches a partial revert that leaves
   * `run.version` in dead text, which a writer-only unit probe cannot see.
   */
  it("says which event version `save-context` writes at, as the CLI behaves today", async () => {
    const contract = { objective: "Check documented saves", acceptanceCriteria: ["Journal keeps the observation"], finishLine: "merge-ready" };
    const candidate = { treeSha: "a".repeat(40), deliverable: { digest: "b".repeat(64), identity: "test/1" },
      base: { ref: "main", tipSha: "c".repeat(40), mergeBaseSha: "c".repeat(40) }, workspaceId: "docs" };
    const observed: { version: string; eventId?: string; payload: unknown }[] = [];
    const append = vi.fn(async (_id, event) => { observed.push(event); return { ok: true }; });
    const release = vi.spyOn(ordinaryContext, "installedRelease").mockResolvedValue({ runtimeVersion: "test", releaseId: "test", profile: "linear", archiveSha256: "d".repeat(64) });
    const selected = vi.spyOn(ordinaryContext, "recoveryRun");
    try {
      for (const version of ["run-event/2", "run-event/1"] as const) {
        observed.length = 0;
        selected.mockResolvedValue({ ok: true, version, runId: "run-docs", events: [],
          surface: { commonDir: "/tmp/docs", store: { append } } } as never);
        for (const stage of ["work", "work", "review"]) {
          const result = await saveContextCommand.run({ rootDir: REPO_ROOT, config: harnessConfig,
            args: ["--json", JSON.stringify({ contract, stage })], wire: async () => ({ captureCandidate: async () => ({ ok: true, candidate }) }) } as never);
          expect(result.kind).toBe("ok");
        }
        for (const event of observed) {
          const writer = ordinaryContext.ordinaryEventWriter(version, "context.saved", event.payload);
          expect(event.version).toBe(writer.version);
          expect(event.eventId).toBe(writer.eventId);
          if (version === "run-event/2") expect(event.eventId).toBe(`context-saved-${digestCanonical(event.payload)}`);
          else expect(event.eventId).toBeUndefined();
        }
        if (version === "run-event/2") {
          expect(observed[0]!.eventId).toBe(observed[1]!.eventId);
          expect(observed[2]!.eventId).not.toBe(observed[0]!.eventId);
          expect(append.mock.calls.every(call => call[2]?.reuseExistingTimestamp === true)).toBe(true);
        }
      }
    } finally { selected.mockRestore(); release.mockRestore(); }
    statesInProse("**`save-context` writes at the run's own event version.**");
    expect(textOf("docs/delivery-runbook.md").replace(/\s+/g, " ")).not.toContain("**`save-context` is refused on a version-2 run.**");
    statesInProse("it appends on a version-2 run as well as a version-1 one");
    statesInProse("On a version-2 run the event id it derives is the canonical digest of the observation");
    statesInProse("the same save twice appends once");
    statesInProse("is a different id and a second entry");
    statesInProse("a version-1 run carries no event id, so an identical repeat appends again");
    const recovery = textOf("packages/cli/src/ordinary-context.ts").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
    const index = /version: read\.events\[(\d+)\]\?\.version/.exec(recovery);
    expect(index, "recovery no longer derives the writer version from a journal event").not.toBeNull();
    const ordinal = Number(index![1]) === 0 ? "first" : `index ${index![1]}`;
    statesInProse(`version out of the journal's ${ordinal} event`);
  });

  it("says how a round that is already open is resumed rather than reopened", () => {
    statesInProse("Re-realize only the lens that did not report");
    statesInProse("Inspect the interrupted lens's worktree before relaunching.");
  });

  it("says why the round's review context is retained, not merely that it is", () => {
    statesInProse("The retained file is the round's only surviving binding tuple");
    statesInProse("`preparation_base_changed`");
  });

  it("says a rebased worktree is reinstalled before the gate is believed", () => {
    statesInProse("Re-run `npm install` after every rebase, before the gate.");
  });

  it("says a suite is never stopped with a machine-wide pattern", () => {
    statesInProse("there is no worktree scoping in `pkill`");
  });

  // The correction this page's own first delivery died on, and the one whose
  // subject is the local gate itself: on a case-insensitive host no sensor run
  // can observe the hazard, so nothing but the sentence carries it forward.
  it("says a green local gate is not evidence about the case of a documented path", () => {
    statesInProse("**The hosted runners have a case-sensitive filesystem and a developer's machine usually does not.**");
    // The move, not only the hazard: without this half the page names a failure
    // and leaves the reader nothing to do about it.
    statesInProse("push before the last round you can still spend");
  });

  // The merge step is the one place the page can instruct a host to exceed the
  // authority this repository grants it, so it is held to the policy document
  // by agreement rather than by a retyped claim: a grant that moves re-stamps
  // the sentence instead of leaving the page authorizing what policy forbids.
  it("states the merge authority the compiled policy actually grants", () => {
    const policy = JSON.parse(readFileSync(path.join(REPO_ROOT, ".agents/policy/repository-policy.json"), "utf8"));
    const granted: string[] = policy.grantedAuthority ?? [];
    const forbidden: string[] = policy.forbiddenAuthority ?? [];
    const finishLines: string[] = policy.grantedFinishLines ?? [];
    expect(granted.length + forbidden.length + finishLines.length, "the policy grants nothing to state").toBeGreaterThan(0);
    expect(forbidden, "policy no longer forbids merge; the runbook's conditioning is now unmotivated").toContain("merge");
    for (const finishLine of finishLines) statesInProse(`grants the \`${finishLine}\` finish line`);
    for (const authority of granted) statesInProse(`\`${authority}\` authority`);
    statesInProse("lists `merge` under `forbiddenAuthority`");
    // The conditioning itself, not just the recital of the policy. Without
    // this the page may state the grant and then merge unconditionally.
    statesInProse("the merge below runs only under authority the user supplied for that delivery");
  });

  // The three sentences that keep this page from becoming a second copy of the
  // installed workflow's rules. Each names the skill that owns the rule instead
  // of restating it; deleting one silently reinstates the duplication the item
  // exists to remove, and no other assertion in this tree notices.
  it("defers the rules the installed skills own instead of restating them", () => {
    statesInProse("through the invoking agent's own host exposure");
    statesInProse("`.agents/skills` is the default for Codex and other hosts; Claude Code uses `.claude/skills`");
    statesInProse("`execute-work` says when that has to exist, and `obtain-review` says what discharges it.");
    statesInProse("are `linear-tracker-adapter`'s, as is the rule about writing to the properties file.");
  });
});

describe("the runbook's computed operating contract", () => {
  const prose = () => textOf("docs/delivery-runbook.md").replace(/<!--[\s\S]*?(?:-->|$)/g, " ").replace(/\s+/g, " ");
  const policy = () => JSON.parse(textOf(".agents/policy/repository-policy.json"));
  const quoted = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]!);

  it("documents exactly the inputs the qualification verifies before implementation", () => {
    const pins = qualificationInputs({ root: "", archive: "qualifications/fixtures/agent-skills-core-v1.zip", metadata: "qualifications/fixtures/agent-skills-core-v1.release.json" });
    expect(pins.length).toBeGreaterThan(2);
    const section = /## Qualification inputs\n([\s\S]*?)\n## /.exec(textOf("docs/agent-guide.md"));
    expect(section).not.toBeNull();
    const documented = [...section![1]!.matchAll(/^- `([^`]+)`$/gm)].map(match => match[1]!);
    expect(documented.sort()).toEqual(pins.map(([file]) => file).sort());
    expect(section![1]!.replace(/\s+/g, " ")).toContain("Re-running this historical qualification with changed bytes requires a newly earned harness baseline commit and tree.");
  });

  it("states the checkpoint path sets and configured neutral prefixes by agreement", () => {
    const implement = policy().checkpoints.find((checkpoint: { stageId: string }) => checkpoint.stageId === "implement");
    expect(implement).toBeDefined();
    const writable = /Writable in the `implement` checkpoint: (.*?)\. Protected:/.exec(prose());
    const protectedPaths = /Protected: (.*?)\. Some files/.exec(prose());
    expect(writable).not.toBeNull(); expect(protectedPaths).not.toBeNull();
    const compiled = JSON.parse(textOf(".agents/policy/compiled-snapshot.json")).compiled;
    const grant = compiled.checkpointGrants.find((checkpoint: { stageId: string }) => checkpoint.stageId === "implement").grant;
    // Git internals are not candidate-edit paths; all other compiled protections
    // must appear, including the platform's .claude protection.
    const protectedSet = grant.protectedPaths.filter((entry: string) => ![".git", ".managed-projection"].includes(entry));
    expect(quoted(writable![1]!).sort()).toEqual(implement.writablePaths.slice().sort());
    expect(quoted(protectedPaths![1]!).sort()).toEqual(protectedSet.sort());
    const neutral = /Only (`docs\/[^.]*?) are review-neutral\./.exec(prose());
    expect(neutral).not.toBeNull();
    expect(quoted(neutral![1]!).sort()).toEqual(harnessConfig.reviewNeutral.map(rule => rule.prefix).sort());
    const recordPaths = harnessConfig.recordNeutral.map(rule => rule.prefix);
    for (const prefix of recordPaths) {
      expect(harnessConfig.reviewNeutral.map(rule => rule.prefix)).toContain(prefix);
      expect(prose()).toContain(`lists \`${prefix}\` in both \`reviewNeutral\` and \`recordNeutral\``);
    }
    const recorderPin = /\[path\.join\(input.root, "([^"\n]+recorder\.ts)"\), (\w+)\]/.exec(textOf("scripts/qualify-agent-skills-provider.ts"));
    expect(recorderPin).not.toBeNull();
    expect(prose()).toContain(`\`${recorderPin![1]}\` (\`${recorderPin![2]}\` in \`scripts/qualify-agent-skills-provider.ts\`)`);
    expect(prose()).toContain("everything under `docs/contracts/`");
  });

  it("states the CI matrix, tracker statuses and CLI exit codes by agreement", () => {
    const matrix = [...textOf(".github/workflows/ci.yml").split("    steps:")[0]!.matchAll(/^\s+- name: ([\w-]+)$/gm)].map(match => match[1]!);
    expect(matrix.length).toBeGreaterThan(0);
    const stated = /\(matrix (.*?)\)/.exec(prose());
    expect(stated).not.toBeNull();
    expect(quoted(stated![1]!)).toEqual(matrix);
    const tracker = JSON.parse(textOf(".agents/tracker-properties.json"));
    expect(prose()).toContain(`Team \`${tracker.team}\`, project \`${tracker.project}\``);
    const statuses = /statuses from `\.agents\/tracker-properties.json` \((.*?)\)/.exec(prose());
    expect(statuses).not.toBeNull();
    expect(quoted(statuses![1]!)).toEqual([tracker.statuses.inProgress, tracker.statuses.inReview, tracker.statuses.done]);
    expect(prose()).toContain(`**Exit codes**: \`${EXIT_OK}\` pass, \`${EXIT_POLICY}\` policy block, \`${EXIT_USAGE}\` usage, \`${EXIT_INTERRUPTED}\` interrupted.`);
  });

  it("binds the printed lens selection and reviewer ids to policy", () => {
    const lenses = policy().reviewLenses;
    const command = /emit lens.selected[^\n]*\\\n\s+--json '([^']+)'/.exec(textOf("docs/delivery-runbook.md"));
    expect(command).not.toBeNull();
    const payload = JSON.parse(command![1]!);
    expect(payload.mandated.slice().sort()).toEqual(lenses.map((lens: { lensId: string }) => lens.lensId).sort());
    expect(payload.selected.slice().sort()).toEqual(payload.mandated.slice().sort());
    for (const lens of lenses) expect(prose()).toContain(`| \`${lens.lensId}\` | \`${lens.personaId}\` |`);
    const ids = /charter basenames: (.*?)\./.exec(prose());
    expect(ids).not.toBeNull();
    expect(quoted(ids![1]!)).toEqual(lenses.map((lens: { personaId: string }) => lens.personaId.replace(/^persona\./, "")));
  });

  it("validates the printed review outcome and its result and cost contract", () => {
    const heredoc = /<<'JSON'\n([\s\S]*?)\nJSON/.exec(textOf("docs/delivery-runbook.md"));
    expect(heredoc).not.toBeNull();
    const digest = "a".repeat(64);
    const document = JSON.parse(heredoc![1]!.replace("<the retained context's digest, exactly>", digest));
    const ids = policy().reviewLenses.map((lens: { personaId: string }) => lens.personaId.replace(/^persona\./, ""));
    const parsed = parseReviewOutcome(document, ids);
    expect(document.contextDigest).toBe(digest);
    expect(parsed.verdict).toBe("green");
    expect(prose()).toContain(`\`result\` is one of ${REVIEWER_RESULTS.map(result => `\`${result}\``).join(", ")}`);
    expect(prose()).toContain("only `approved` stamps an approval");
    expect(prose()).toContain("An optional `cost` requires `costCoverage`");
    expect(() => parseReviewOutcome({ ...document, cost: 1 }, ids)).toThrow(/costCoverage/);
  });

  it("checks runbook flags, runs subcommands and quoted config member names", () => {
    const runbook = textOf("docs/delivery-runbook.md");
    const shellBlocks = [...runbook.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]!).join("\n");
    for (const invocation of harnessInvocations(shellBlocks)) {
      const descriptor = COMMANDS.find(command => command.name === invocation.command);
      expect(descriptor, `unknown command ${invocation.command}`).toBeDefined();
      const accepted = commandFlags([descriptor!]);
      expect(invocation.flags.filter(flag => !accepted.has(flag)), `${invocation.command} rejects a documented flag`).toEqual([]);
    }
    const knownFlags = commandFlags(COMMANDS);
    const invocations = harnessInvocations(runbook);
    const inline = quoted(runbook.replace(/```[\s\S]*?```/g, " "));
    const inlineInvocations = inline.filter(value => /^(?:verify|emit|runs)(?:\s|$)/.test(value))
      .flatMap(value => harnessInvocations(`delivery-harness ${value}`));
    // These spans illustrate grep, generic flag syntax, or diff markers rather
    // than naming harness options. Keep exceptions on the complete example.
    const otherExamples = new Set(["--include='*.ts'", "--flag value", "--flag=value", "--- a/path", "--- /dev/null", "---", "----"]);
    const standaloneFlags = inline.filter(value => value.startsWith("--") && !otherExamples.has(value)).flatMap(flagsIn);
    expect(invocations.length).toBeGreaterThan(10);
    const flags = new Set([...invocations, ...inlineInvocations].flatMap(invocation => invocation.flags)
      // Git flags and Vitest's separately checked option.
      .concat(standaloneFlags.filter(flag => !["--continue", "--name-status", "--testTimeout"].includes(flag))));
    expect(flags.size).toBeGreaterThanOrEqual(8);
    expect([...flags].filter(flag => !knownFlags.has(flag))).toEqual([]);
    const registered = runSubcommands(COMMANDS);
    const named = [...invocations, ...inlineInvocations]
      .filter(invocation => invocation.command === "runs" && invocation.subcommand !== undefined)
      .map(invocation => invocation.subcommand!);
    expect(new Set(named).size).toBeGreaterThanOrEqual(3);
    expect(named.filter(name => !registered.has(name))).toEqual([]);
    const members = new Set([...Object.keys(harnessConfig), ...Object.keys(policy())]);
    const claimed = [...runbook.matchAll(/`((?:review|record|tracker|deliveryRecord|baseMovement|granted|forbidden)[A-Z][\w]*)`/g)].map(match => match[1]!);
    expect(claimed.length).toBeGreaterThanOrEqual(5);
    for (const name of claimed) expect(members.has(name) || name in (harnessConfig.deliveryRecordVerification ?? {}), `unknown config/policy member ${name}`).toBe(true);
    // Vitest's public declaration is the local source for its differently-cased flag.
    const timeout = standaloneFlags.find(flag => flag === "--testTimeout");
    if (timeout) {
      const chunks = readdirSync(path.join(REPO_ROOT, "node_modules/vitest/dist/chunks")).filter(name => name.startsWith("cac.") && name.endsWith(".js"));
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some(name => textOf(`node_modules/vitest/dist/chunks/${name}`).includes(timeout.slice(2)))).toBe(true);
    }
  });

  it("holds retry-only run-start members to the grammar", () => {
    const runbook = prose();
    const payload = { host: "codex", workflow: { releaseId: "test", profile: "linear" } };
    for (const member of ["predecessorRunId", "displacedRunId"]) {
      expect(runbook).toContain(`\`${member}\``);
      const input = { ...runEventEnvelope(payload), kind: "run.started", payload: { ...payload, [member]: "run-before" } };
      expect(validateRunEventInput(input).ok, member).toBe(true);
      expect(validateRunEventInput({ ...input, payload: { ...payload, [member.replace(/Id$/, "")]: "run-before" } }).ok).toBe(false);
    }
  });
});


describe("visible rules cannot be contradicted by demonstrated negations", () => {
  const inversions = [
    { pattern: /(?:lens|reviewer) (?:may|can|should) (?:plant|mutate)(?: in)? the delivery worktree/i,
      probes: ["In practice a lens may plant in the delivery worktree and restore afterwards; the rule above is a preference, not a requirement.", "A reviewer can mutate the delivery worktree."] },
    { pattern: /(?:rule|worktree isolation)(?: above)? is (?:a preference|optional|not a requirement)/i,
      probes: ["The rule above is a preference, not a requirement.", "Worktree isolation is optional."] },
    { pattern: /(?:do not|never) (?:run `npm run check` on the replayed candidate|re-run `npm install` after every rebase)/i,
      probes: ["Do not Run `npm run check` on the replayed candidate before deciding a round is a reopen.", "Never Re-run `npm install` after every rebase, before the gate."] },
  ];
  it("sweeps every scanned document and proves each forbidden shape still matches", () => {
    expect(inversions.length).toBe(3);
    for (const { pattern, probes } of inversions) {
      expect(probes.length).toBeGreaterThan(0);
      for (const probe of probes) expect(pattern.test(probe), probe).toBe(true);
      for (const document of scannedDocuments()) {
        const visible = textOf(document).replace(/<!--[\s\S]*?(?:-->|$)/g, " ").replace(/\s+/g, " ");
        expect(pattern.test(visible), `${document} contradicts a pinned rule: ${pattern}`).toBe(false);
      }
    }
  });
});
