/** Self-attested terminal check evidence; contextual equality is never optional. */
import { digestCanonical, sha256Hex } from "../digest.ts";
import type { DeclaredArtifact, ManifestValidationContext } from "./envelope.ts";
import { GEN_1_UNKNOWN, GEN_4_MISSING, canonicallyEqual, checkMembers, isRecord, type Collector } from "./grammar.ts";

export function validateChecksPassed(payload: Record<string, unknown>, at: string, provider: { readonly id: unknown; readonly runId: unknown; readonly finalPassId: unknown }, artifacts: readonly DeclaredArtifact[], context: Omit<ManifestValidationContext, "config"> & { readonly config: Pick<ManifestValidationContext["config"], "providers"> }, collector: Collector): void {
  checkMembers(payload, at, { required: ["verdict", "exitCode", "binding"], optional: [] }, { unknown: GEN_1_UNKNOWN, missing: GEN_4_MISSING }, collector);
  const providerId = typeof provider.id === "string" ? provider.id : undefined;
  const expected = providerId === undefined ? undefined : context.checkBindings?.[providerId];
  let outputsMatch = false;
  try {
    const check = context.config.providers.find(entry => entry.id === providerId)?.check;
    if (check !== undefined) {
      const outputs = (check.outputs ?? []).map((output, index) => {
        if (!artifacts.some(artifact => artifact.path === `check-output-${index}.json` && artifact.role === "check-output")) throw new Error("missing declared output artifact");
        return { path: output, sha256: sha256Hex(retainedCheckOutput(context.artifactContents, output, index)) };
      });
      const terminal = JSON.parse(context.artifactContents.get("check-result.json") ?? "null") as unknown;
      outputsMatch = expected?.outputsDigest === digestCanonical(outputs) && artifacts.some(artifact => artifact.path === "check-result.json" && artifact.role === "check-result") && canonicallyEqual(terminal, { providerId: provider.id, runId: provider.runId, finalPassId: provider.finalPassId, ...payload });
    }
  } catch { outputsMatch = false; }
  if (!outputsMatch || payload["verdict"] !== "green" || payload["exitCode"] !== 0 || !isRecord(payload["binding"]) || expected === undefined || !canonicallyEqual(payload["binding"], expected)) {
    collector.emit("malformed_field", "GEN-4", at, "a passing declared check requires exit zero and the complete current check binding");
  }
}

/** Decode only the deterministic artifact slot for this configured output. */
export function retainedCheckOutput(artifactContents: ReadonlyMap<string, string>, outputPath: string, index: number): Uint8Array {
  const text = artifactContents.get(`check-output-${index}.json`);
  if (text === undefined || text.length > 1500000) throw new Error("Missing or oversized retained check output");
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed retained check output");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).sort().join(",") !== "base64,path" || entry["path"] !== outputPath || typeof entry["base64"] !== "string") throw new Error("Mismatched retained check output");
  const bytes = Buffer.from(entry["base64"], "base64");
  if (bytes.length > 1024 * 1024 || bytes.toString("base64") !== entry["base64"]) throw new Error("Malformed retained check output bytes");
  return bytes;
}
