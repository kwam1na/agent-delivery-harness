/**
 * `verify` — recompute the deliverable identity and check the tracked record.
 *
 * The command captures the current candidate, derives the candidate-keyed record
 * path from the recomputed deliverable identity (the same exact lookup the
 * Action performs from the PR head), reads and parses the record, and hands it to
 * the pure `verifyDeliveryRecord` core. A missing record names the command that
 * writes it; a failed check surfaces the named drift class. When the base-movement
 * policy is `allow`, a passing check that relaxed base drift names the relaxation.
 *
 * THE RUN-JOURNAL ROW, AND WHY IT IS LOCAL ONLY. `verify` is the one caller
 * that holds both halves of the question "was this candidate journaled": a
 * record binding an exact tree sha, and a repository whose run store it can
 * scan for a journal bound to the same one. So it resolves the row and reports
 * it — and reporting is all it does by default. The row changes no exit code
 * unless the operator asks for that with `--require-run-journal`, a LOCAL
 * opt-in: it is not passed by the GitHub Action, not read by the gate, and not
 * consulted by admission. A run journal is self-attested observability that
 * anything the owner executes can append to, so a delivery that could be
 * admitted or refused on one would be resting its gate on a file its own
 * candidate scripts can write.
 *
 * `--mandated-lens <id>` is the second half of the same opt-in: supplied, the
 * evaluator checks the journal's declared mandated pair against these ids
 * rather than merely checking that it declared two non-empty ones. Repeatable,
 * separate-argument form, and bounded to the run family's own id charset before
 * it reaches the kernel.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_RUN_PROVIDER_ID,
  RUN_PROVIDER_ID,
  deliveryRecordPathFor,
  needsCommittedSymlinkTarget,
  parseCandidateTreeListing,
  parseDeliveryRecord,
  runGitCommand,
  verifyDeliveryRecord,
  type CandidateTreeEntry,
  type RunJournalRow,
} from "@agent-delivery-harness/kernel";
import { commandBlocker } from "../boundary.ts";
import type { CommandContext, CommandDescriptor, CommandResult } from "../boundary.ts";
import { oneLine, resolveRunJournalRow, runJournalRows } from "../run-surface.ts";

const USAGE = "Usage: delivery-harness verify [--require-run-journal] [--mandated-lens <id>]...";

interface ParsedArgs {
  readonly requireRunJournal: boolean;
  readonly mandatedLensIds: readonly string[];
}

type ArgParse = { readonly ok: true; readonly args: ParsedArgs } | { readonly ok: false; readonly message: string };

/**
 * The separate-argument form every other command's flags take: `--flag value`,
 * never `--flag=value`. The joined form is not silently split, because a
 * `--mandated-lens=x` that quietly worked here and nowhere else would be a
 * second grammar for the same CLI. It falls through to the unknown-flag arm,
 * which is a usage error naming the token.
 */
function parseArgs(args: readonly string[]): ArgParse {
  let requireRunJournal = false;
  const mandatedLensIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--require-run-journal") {
      requireRunJournal = true;
      continue;
    }
    if (token === "--mandated-lens") {
      const value = args[index + 1];
      if (value === undefined) return { ok: false, message: `${token} needs a value.\n${USAGE}` };
      // Bounded before the kernel sees it: an id is compared against journal
      // content, and an unbounded one would be echoed into the row it produces.
      if (value.length > MAX_RUN_PROVIDER_ID || !RUN_PROVIDER_ID.test(value)) {
        return { ok: false, message: `${token} takes a bounded lens id, not ${oneLine(value, 64)}.\n${USAGE}` };
      }
      mandatedLensIds.push(value);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { ok: false, message: `Unknown flag ${oneLine(token, 64)}.\n${USAGE}` };
    return { ok: false, message: `verify takes no positional arguments, and ${oneLine(token, 64)} is one.\n${USAGE}` };
  }
  return { ok: true, args: { requireRunJournal, mandatedLensIds } };
}

/**
 * The opt-in's refusal. It names the status, the missing entries, and the
 * violated constraints, all of them product-defined names from the evaluator's
 * two closed sets — never journal-derived text.
 */
function runJournalBlocker(row: RunJournalRow) {
  const missing = row.missing.length === 0 ? "(none)" : row.missing.join(", ");
  const violations = row.violations === undefined || row.violations.length === 0 ? "(none)" : row.violations.join(", ");
  return commandBlocker({
    code: "run_journal_incomplete",
    sourceId: "delivery-harness.cli.verify",
    summary: "The run journal for this candidate is not complete, and --require-run-journal was given.",
    details: `status ${row.status}${row.runId === undefined ? "" : ` (run ${oneLine(row.runId, 128)})`}; missing: ${missing}; violations: ${violations}`,
    remediations: [
      {
        id: "emit-the-missing-run-events",
        kind: "manual_action",
        summary: "Emit the run events this delivery did not journal, or drop --require-run-journal: the row is observability, not evidence.",
      },
    ],
  });
}

export const verifyCommand: CommandDescriptor = {
  name: "verify",
  sourceId: "delivery-harness.cli.verify",
  summary: "Verify the tracked delivery record against the current candidate.",
  async run(context: CommandContext): Promise<CommandResult> {
    // Arguments first: a malformed invocation is a usage error and captures
    // nothing, exactly as `emit` and `submit-evidence` order it.
    const parsedArgs = parseArgs(context.args);
    if (!parsedArgs.ok) return { kind: "usage", message: parsedArgs.message };

    const wiring = await context.wire();
    const capture = await wiring.captureCandidate();
    if (!capture.ok) {
      return { kind: "blocked", blockers: [...capture.blockers] };
    }
    const identity = {
      deliverableDigest: capture.candidate.deliverable.digest,
      identityToken: capture.candidate.deliverable.identity,
    };
    const base = {
      ref: capture.candidate.base.ref,
      tipSha: capture.candidate.base.tipSha,
      mergeBaseSha: capture.candidate.base.mergeBaseSha,
    };

    const relativePath = deliveryRecordPathFor(context.config, identity.deliverableDigest);
    const absolutePath = path.join(context.rootDir, relativePath);

    let text: string;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch {
      return {
        kind: "blocked",
        blockers: [
          commandBlocker({
            code: "delivery_record_missing",
            sourceId: "delivery-harness.cli.verify",
            summary: "No delivery record describes the current candidate.",
            details: `expected ${relativePath}`,
            remediations: [
              {
                id: "run-record",
                kind: "command",
                command: ["delivery-harness", "record"],
                summary: "Record the admitted gate for this candidate.",
              },
            ],
          }),
        ],
      };
    }

    const parsed = parseDeliveryRecord(text);
    if (!parsed.ok) {
      return { kind: "blocked", blockers: [...parsed.blockers] };
    }

    // The tracked tree's own entries, so this command rejects a candidate
    // carrying a projection or discovery-configuration path exactly as the
    // Action does. An unreadable listing supplies no entries rather than a
    // false clean bill: the check simply does not run.
    //
    // Mode and object, not just the name: the one admitted exception under
    // `.claude/skills/` turns on the entry being a symlink and on where its
    // committed target resolves, and both facts live in the tree.
    const listing = await runGitCommand(["git", "ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
      cwd: context.rootDir,
    });
    const candidateTreePaths: CandidateTreeEntry[] = [];
    if (listing.exitCode === 0) {
      for (const entry of parseCandidateTreeListing(listing.stdout)) {
        if (!needsCommittedSymlinkTarget(entry)) {
          candidateTreePaths.push(entry);
          continue;
        }
        // The target read out of the committed blob, never off the filesystem:
        // the working tree's link may differ from the one under review. A blob
        // that will not read leaves the target absent, and an entry with no
        // target cannot reach the exception.
        const blob = await runGitCommand(["git", "cat-file", "blob", entry.objectSha], { cwd: context.rootDir });
        candidateTreePaths.push(blob.exitCode === 0 ? { ...entry, symlinkTarget: blob.stdout } : entry);
      }
    }

    // The row is resolved from the RECORD'S tree sha, not the recomputed
    // identity: the identity digest excludes the review-neutral paths, and what
    // a review round and a `pr.opened` bind is the raw tree the record carries.
    const runJournal = await resolveRunJournalRow({
      cwd: context.rootDir,
      treeSha: parsed.record.candidateBinding.treeSha,
      ...(parsedArgs.args.mandatedLensIds.length === 0 ? {} : { mandatedLensIds: parsedArgs.args.mandatedLensIds }),
    });

    const check = verifyDeliveryRecord(context.config, parsed.record, identity, base, { candidateTreePaths, runJournal });
    if (!check.ok) {
      return { kind: "blocked", blockers: [...check.blockers] };
    }

    // The opt-in is judged AFTER the record's own verification, so a delivery
    // whose record is bad is never told its journal is the problem.
    if (parsedArgs.args.requireRunJournal && runJournal.status !== "complete") {
      return { kind: "blocked", blockers: [runJournalBlocker(runJournal)] };
    }

    const relaxation = check.baseMovementRelaxed
      ? ` (base movement relaxed by policy: ${check.relaxedDriftClasses.join(", ")})`
      : "";
    return {
      kind: "ok",
      summary: [
        `verified ${relativePath}${relaxation}; attestation: ${check.attestationLabel}`,
        ...runJournalRows(runJournal),
      ].join("\n"),
    };
  },
};
