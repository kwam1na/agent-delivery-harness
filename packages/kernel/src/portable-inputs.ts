/** Capture verifier inputs from the selected tree, never a synthetic CI checkout. */
import path from "node:path";
import { createHash } from "node:crypto";
import { BlockedError } from "./blockers.ts";
import { runGitCommand, evaluateCandidateActivation, type CandidateCommandRunner } from "./candidate.ts";
import type { CapturedCandidate } from "./candidate.types.ts";
import type { HarnessConfig } from "./config.ts";
import { computePreparationFingerprint } from "./preparation.ts";
import { parseCandidateTreeListing, type DeliveryRecord } from "./delivery-record.ts";
import { capturePortableEvidenceContext, portableArtifactContents, portableBlocker, MAX_PORTABLE_ARTIFACT_BYTES } from "./portable-evidence.ts";
import { computeDeliverableIdentity } from "./identity.ts";
import { captureCheckBindings } from "./checks.ts";
import { retainedCheckOutput } from "./validator/checks-passed.ts";
import type { ReviewInputReader } from "./review-inputs.ts";
import { isSafeRelativePath } from "./validator/envelope.ts";

export async function candidateTreeEvidenceReader(rootDir: string, treeSha: string, run: CandidateCommandRunner = runGitCommand): Promise<ReviewInputReader> {
  const refusal = (message: string): never => { throw new BlockedError([portableBlocker("portable_tree_unreadable", message)]); };
  const listing = await run(["git", "ls-tree", "-r", "-z", "--full-tree", treeSha], { cwd: rootDir });
  if (listing.exitCode !== 0) refusal("The target candidate tree cannot be enumerated.");
  const entries = new Map(parseCandidateTreeListing(listing.stdout).map(entry => [entry.path, entry]));
  const readBlob = async (sha: string): Promise<Buffer> => {
    const size = await run(["git", "cat-file", "-s", sha], { cwd: rootDir });
    if (size.exitCode !== 0 || !/^\d+\s*$/.test(size.stdout) || Number(size.stdout) > MAX_PORTABLE_ARTIFACT_BYTES) refusal("A target-tree evidence input is missing or oversized.");
    const result = await run(["git", "cat-file", "blob", sha], { cwd: rootDir, captureBytes: true });
    if (result.exitCode !== 0) refusal("A target-tree evidence input cannot be read.");
    const bytes = result.stdoutBase64 === undefined ? Buffer.from(result.stdout, "utf8") : Buffer.from(result.stdoutBase64, "base64");
    const actual = createHash(sha.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== sha) refusal("The target-tree reader did not preserve the exact blob bytes.");
    return bytes;
  };
  return async (requested) => {
    if (!isSafeRelativePath(requested)) refusal("An evidence input is not a safe repository-relative path.");
    let current = requested;
    for (let depth = 0; depth < 32; depth += 1) {
      const segments = current.split("/");
      let redirected = false;
      for (let index = 0; index < segments.length; index += 1) {
        const prefix = segments.slice(0, index + 1).join("/");
        const entry = entries.get(prefix);
        if (entry?.mode !== "120000") continue;
        const target = (await readBlob(entry.objectSha)).toString("utf8");
        if (path.posix.isAbsolute(target) || target.includes("\\") || target.includes("\0")) refusal("An evidence input symlink escapes the repository.");
        current = path.posix.normalize(path.posix.join(path.posix.dirname(prefix), target, ...segments.slice(index + 1)));
        if (!isSafeRelativePath(current)) refusal("An evidence input symlink escapes the repository.");
        redirected = true;
        break;
      }
      if (redirected) continue;
      const entry = entries.get(current);
      if (entry === undefined) return null;
      if (!/^100(?:644|755)$/.test(entry.mode)) refusal("An evidence input is not a regular committed file.");
      return readBlob(entry.objectSha);
    }
    return refusal("An evidence input symlink chain is cyclic or too deep.");
  };
}

export async function capturePortableVerificationInputs(rootDir: string, config: HarnessConfig, candidate: CapturedCandidate, record: DeliveryRecord, run: CandidateCommandRunner = runGitCommand) {
  const read = await candidateTreeEvidenceReader(rootDir, candidate.treeSha, run);
  const readWiring = async (repoPath: string): Promise<Uint8Array> => {
    const bytes = await read(repoPath);
    if (bytes === null) throw new BlockedError([portableBlocker("portable_wiring_missing", "A target-tree preparation input is missing.")]);
    return bytes;
  };
  const preparationFingerprint = await computePreparationFingerprint(rootDir, config, { readWiring });
  const evidenceContext = await capturePortableEvidenceContext(config, read, preparationFingerprint);
  const checkBindings = await captureCheckBindings(rootDir, config, candidate, { readWiring, readReleaseInputs: read,
    readOutput: async (repoPath, providerId) => {
      const evidence = record.claims.flatMap(claim => [
        ...(claim.evidence === undefined ? [] : [claim.evidence]),
        ...(claim.supportingEvidence ?? []),
      ]).find(entry => entry.resolution.kind === "evidence" && entry.resolution.providerId === providerId);
      const portable = evidence?.resolution.kind === "evidence" ? evidence.resolution.portable : undefined;
      const contents = portableArtifactContents(portable?.artifacts);
      const index = config.providers.find(provider => provider.id === providerId)?.check?.outputs?.indexOf(repoPath) ?? -1;
      return retainedCheckOutput(contents.artifacts, repoPath, index);
    },
  });
  const projection = await evaluateCandidateActivation({ rootDir, config, candidate, run });
  // Human approval binds the stricter candidate, allowing only its record transport.
  // Read Git trees directly; portable verification needs no old provider folders.
  let waiverCandidateMatches: boolean | undefined;
  if (record.claims.some(claim => claim.outcome === "waived")) {
    const validationConfig = { ...config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: config.recordNeutral };
    const [approved, target] = await Promise.all([record.candidateBinding.treeSha, candidate.treeSha].map(treeSha =>
      computeDeliverableIdentity({ rootDir, treeSha, config: validationConfig }, { run })));
    waiverCandidateMatches = approved === target;
  }
  return { evidenceContext, checkBindings, projection, ...(waiverCandidateMatches === undefined ? {} : { waiverCandidateMatches }) };
}
