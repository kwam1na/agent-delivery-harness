/** Current observations for deterministic checks; admission still owns the decision. */
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CandidateBinding } from "./candidate.types.ts";
import type { HarnessConfig } from "./config.ts";
import { digestCanonical, sha256Hex } from "./digest.ts";
import { computeDeliverableIdentity } from "./identity.ts";
import { computePreparationFingerprint, type PreparationOptions } from "./preparation.ts";
import { BlockedError, createBlocker } from "./blockers.ts";
import { readWorkflowRelease, type ReviewInputReader } from "./review-inputs.ts";
import type { CheckBinding } from "./records.types.ts";

export async function captureCheckOutputSnapshots(rootDir: string, outputs: readonly string[], readOutput?: (repoPath: string) => Promise<Uint8Array>): Promise<readonly { path: string; sha256: string; base64: string }[] | undefined> {
  const root = await realpath(rootDir);
  const result: { path: string; sha256: string; base64: string }[] = [];
  for (const output of outputs) {
    try {
      if (readOutput !== undefined) {
        const bytes = await readOutput(output);
        if (bytes.length > 1024 * 1024) return undefined;
        result.push({ path: output, sha256: sha256Hex(bytes), base64: Buffer.from(bytes).toString("base64") });
        continue;
      }
      const target = await realpath(path.resolve(root, output));
      const relative = path.relative(root, target);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return undefined;
      const handle = await open(target, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 1024 * 1024) return undefined;
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > 1024 * 1024) return undefined;
        const bytes = buffer.subarray(0, offset);
        result.push({ path: output, sha256: sha256Hex(bytes), base64: bytes.toString("base64") });
      } finally { await handle.close(); }
    } catch { return undefined; }
  }
  return result;
}

export async function captureCheckOutputs(rootDir: string, outputs: readonly string[], readOutput?: (repoPath: string) => Promise<Uint8Array>): Promise<readonly { path: string; sha256: string }[] | undefined> {
  return (await captureCheckOutputSnapshots(rootDir, outputs, readOutput))?.map(({ path, sha256 }) => ({ path, sha256 }));
}

export interface CheckBindingOptions extends PreparationOptions {
  readonly readOutput?: (repoPath: string, providerId: string) => Promise<Uint8Array>;
  readonly readReleaseInputs?: ReviewInputReader;
}

export async function computeCheckWiringFingerprint(rootDir: string, config: HarnessConfig, options: CheckBindingOptions = {}): Promise<string> {
  const read = options.readReleaseInputs ?? (async (repoPath: string) => {
    try { return await readFile(path.join(rootDir, repoPath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  });
  let release: Readonly<Record<string, unknown>> | null;
  try { release = await readWorkflowRelease(read); }
  catch (error) {
    throw new BlockedError([createBlocker({ code: "check_release_unreadable", source: { kind: "preparation", id: config.gateId },
      summary: "The installed workflow release identity cannot be read for validation.", details: error instanceof Error ? error.message : String(error),
      remediations: [{ id: "repair-check-release", kind: "manual_action", summary: "Restore a valid installed release and prepare again." }] })]);
  }
  return digestCanonical({ preparation: await computePreparationFingerprint(rootDir, config, options), release });
}

export async function captureCheckBindings(rootDir: string, config: HarnessConfig, candidate: CandidateBinding, options: CheckBindingOptions = {}): Promise<Readonly<Record<string, CheckBinding>>> {
  const providers = config.providers.filter(provider => provider.check !== undefined);
  if (providers.length === 0) return {};
  const validationDigest = await computeDeliverableIdentity({ rootDir, treeSha: candidate.treeSha,
    config: { ...config, computingIdentityVersion: "validation-tree/v1", reviewNeutral: config.recordNeutral } });
  const policyDigest = digestCanonical(config);
  const wiringFingerprint = await computeCheckWiringFingerprint(rootDir, config, options);
  const bindings: Record<string, CheckBinding> = {};
  for (const provider of providers) {
    const outputs = await captureCheckOutputs(rootDir, provider.check!.outputs ?? [], options.readOutput === undefined ? undefined : repoPath => options.readOutput!(repoPath, provider.id));
    if (outputs !== undefined) bindings[provider.id] = { definitionDigest: digestCanonical(provider.check), validationDigest, policyDigest, wiringFingerprint, outputsDigest: digestCanonical(outputs) };
  }
  return bindings;
}

