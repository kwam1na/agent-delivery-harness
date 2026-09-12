import { scopedCheckIdentity, type ScopedRuntimeObservation } from "./scoped-inputs.ts";
import { digestCanonical } from "./digest.ts";
import type { ScopedCheckPlan, ScopedCheckAttempt } from "./records.types.ts";
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
import { readCompiledRepositoryPolicy, type ReviewInputReader } from "./review-inputs.ts";
import { isSafeRelativePath } from "./validator/envelope.ts";

export interface CandidateTreeInputMetadata {
  readonly mode: string | null;
  readonly links: readonly { readonly path: string; readonly target: string }[];
}
export type CandidateTreeInputReader = ReviewInputReader & { metadata(repoPath: string): Promise<CandidateTreeInputMetadata> };
export async function candidateTreeEvidenceReader(rootDir: string, treeSha: string, run: CandidateCommandRunner = runGitCommand): Promise<CandidateTreeInputReader> {
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
  const resolve = async (requested: string) => {
    if (!isSafeRelativePath(requested)) refusal("An evidence input is not a safe repository-relative path.");
    let current = requested;
    const links: { path: string; target: string }[] = [];
    for (let depth = 0; depth < 32; depth += 1) {
      const segments = current.split("/");
      let redirected = false;
      for (let index = 0; index < segments.length; index += 1) {
        const prefix = segments.slice(0, index + 1).join("/");
        const entry = entries.get(prefix);
        if (entry?.mode !== "120000") continue;
        const target = (await readBlob(entry.objectSha)).toString("utf8");
        links.push({ path: prefix, target });
        if (path.posix.isAbsolute(target) || target.includes("\\") || target.includes("\0")) refusal("An evidence input symlink escapes the repository.");
        current = path.posix.normalize(path.posix.join(path.posix.dirname(prefix), target, ...segments.slice(index + 1)));
        if (!isSafeRelativePath(current)) refusal("An evidence input symlink escapes the repository.");
        redirected = true;
        break;
      }
      if (redirected) continue;
      const entry = entries.get(current);
      if (entry === undefined) return { entry, links };
      if (!/^100(?:644|755)$/.test(entry.mode)) refusal("An evidence input is not a regular committed file.");
      return { entry, links };
    }
    return refusal("An evidence input symlink chain is cyclic or too deep.");
  };
  return Object.assign(async (requested: string) => {
    const { entry } = await resolve(requested);
    return entry ? readBlob(entry.objectSha) : null;
  }, { metadata: async (requested: string): Promise<CandidateTreeInputMetadata> => {
    const { entry, links } = await resolve(requested);
    return { mode: entry?.mode ?? null, links };
  } });
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
  const compiledPolicy = await readCompiledRepositoryPolicy(read);
  let scopedPlan: ScopedCheckPlan | undefined;
  let bindingCandidate = candidate;
  if (config.providers.some(p => p.check?.scope)) {
    const validationConfig = { ...config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: config.recordNeutral };
    const [recorded, current] = await Promise.all([record.candidateBinding.treeSha, candidate.treeSha].map(treeSha => computeDeliverableIdentity({ rootDir, treeSha, config: validationConfig }, { run })));
    // Non-reusable executions may be verified after their record transport is
    // staged. This proves strict byte equivalence; it never grants gate reuse.
    if (recorded === current && record.candidateBinding.baseRef === candidate.base.ref && record.candidateBinding.baseTipSha === candidate.base.tipSha && record.candidateBinding.mergeBaseSha === candidate.base.mergeBaseSha) bindingCandidate = { ...candidate, treeSha: record.candidateBinding.treeSha, workspaceId: record.candidateBinding.workspaceId };
  }
  const scopedProviders = config.providers.filter(p => p.check?.scope);
  if (scopedProviders.length) {
    const listing = await run(["git", "ls-tree", "-r", "--name-only", "-z", candidate.treeSha], { cwd: rootDir });
    if (listing.exitCode !== 0) throw new BlockedError([portableBlocker("portable_tree_unreadable", "Cannot enumerate scoped source inputs.")]);
    const checks: Record<string, ScopedCheckPlan["checks"][string]> = {};
    for (const provider of scopedProviders) {
      const evidence = record.claims.flatMap(c => [...(c.evidence ? [c.evidence] : []), ...(c.supportingEvidence ?? [])]).find(e => e.resolution.kind === "evidence" && e.resolution.providerId === provider.id);
      const portable = evidence?.resolution.kind === "evidence" ? evidence.resolution.portable : undefined;
      const contents = portableArtifactContents(portable?.artifacts);
      const raw = contents.artifacts.get("scoped-inputs.json");
      if (!raw) throw new BlockedError([portableBlocker("portable_scoped_inputs_missing", "Scoped execution requires retained input observations and its originating attempt.")]);
      try {
        const retained = JSON.parse(raw) as { observation: ScopedRuntimeObservation; attempt: ScopedCheckAttempt };
        const identity = await scopedCheckIdentity(config, provider, listing.stdout.split("\0").filter(Boolean), read, retained.observation, candidate.base);
        if (retained.attempt.providerId !== provider.id || retained.attempt.status !== "passed" || retained.attempt.inputDigest !== identity.inputDigest || retained.attempt.profileDigest !== identity.profileDigest) throw new Error("Mismatched scoped execution identity");
        checks[provider.id] = { inputDigest: identity.inputDigest, profileDigest: identity.profileDigest, reusable: identity.reusable, attempts: [retained.attempt] };
      } catch { throw new BlockedError([portableBlocker("portable_scoped_inputs_invalid", "Retained scoped inputs do not match the selected source, profile or policy.")]); }
    }
    scopedPlan = { version: "scoped-plan/1", candidate: { treeSha: bindingCandidate.treeSha, deliverableDigest: candidate.deliverable.digest, identityToken: candidate.deliverable.identity, baseRef: candidate.base.ref, baseTipSha: candidate.base.tipSha, mergeBaseSha: candidate.base.mergeBaseSha, workspaceId: bindingCandidate.workspaceId },
      selectionDigest: digestCanonical(scopedProviders.map(p => ({ id: p.id, check: p.check })).sort((a, b) => a.id.localeCompare(b.id))), checks };
  }
  const checkBindings = await captureCheckBindings(rootDir, config, bindingCandidate, { readWiring, readReleaseInputs: read, ...(scopedPlan ? { scopedPlan } : {}),
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
  return { evidenceContext, checkBindings, projection, ...(compiledPolicy === null ? {} : { compiledPolicy }),
    ...(waiverCandidateMatches === undefined ? {} : { waiverCandidateMatches }) };
}
