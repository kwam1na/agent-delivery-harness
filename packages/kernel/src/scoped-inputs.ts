/** Recomputable source identity shared by the executor and portable verifier. */
import { captureScopedCheckInputs } from "./checks.ts";
import { digestCanonical, sha256Hex } from "./digest.ts";
import type { HarnessConfig, ProviderRegistration } from "./config.ts";
import { readWorkflowRelease, type ReviewInputReader } from "./review-inputs.ts";
export interface ScopedRuntimeObservation {
  readonly version: "scoped-runtime/1";
  readonly runtimeDigest: string;
  readonly flags: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, { readonly present: boolean; readonly identity: string | null }>>;
}
export async function scopedCheckIdentity(config: HarnessConfig, provider: ProviderRegistration, inventory: readonly string[], read: ReviewInputReader, observation: ScopedRuntimeObservation) {
  const scope = provider.check?.scope;
  const profile = config.scopedExecution?.profiles.find(p => p.id === scope?.profile);
  if (!scope || !profile || observation.version !== "scoped-runtime/1" || !/^[a-f0-9]{64}$/.test(observation.runtimeDigest)) throw new Error("Unsupported scoped execution identity");
  const flags = scope.environment.filter(e => e.kind === "flag").map(e => e.name);
  const credentials = scope.environment.filter(e => e.kind === "credential").map(e => e.name);
  if (Object.keys(observation.flags).some(k => !flags.includes(k) || typeof observation.flags[k] !== "string") || Object.keys(observation.credentials).sort().join("\0") !== credentials.sort().join("\0")) throw new Error("Invalid scoped environment observation");
  const environment: Record<string, string> = { ...observation.flags };
  for (const name of credentials) {
    const entry = observation.credentials[name]!;
    if (typeof entry.present !== "boolean" || entry.identity !== (entry.present ? profile.credentialIdentities[name] ?? null : null)) throw new Error("Invalid credential identity");
    if (entry.present) environment[name] = "<credential-present>";
  }
  const dependencyInputs = [];
  for (const file of [...profile.dependencyInputs].sort()) {
    const bytes = await read(file);
    if (bytes === null) throw new Error("Required dependency input is missing");
    dependencyInputs.push({ file, sha256: sha256Hex(bytes) });
  }
  const dependencyDigest = digestCanonical({ inputs: dependencyInputs, setup: profile.dependencies ?? null });
  const releaseDigest = digestCanonical(await readWorkflowRelease(read));
  const policyDigest = digestCanonical(config.obligations.filter(o => o.providers.includes(provider.id)).map(o => ({ ...o, providers: [provider.id] })));
  const relevantProfile = { ...profile,
    mutableOutputs: profile.mutableOutputs.filter(m => provider.check!.outputs?.some(o => m.endsWith("/") ? o.startsWith(m) : o === m)),
    credentialIdentities: Object.fromEntries(credentials.filter(name => profile.credentialIdentities[name] !== undefined).map(name => [name, profile.credentialIdentities[name]])) };
  const profileDigest = digestCanonical({ profile: relevantProfile, runtimeDigest: observation.runtimeDigest, dependencyDigest, releaseDigest, policyDigest });
  const capture = await captureScopedCheckInputs(scope, { listFiles: async () => inventory, readFile: read, command: provider.check!.command, timeoutMs: provider.check!.timeoutMs,
    runtimeDigest: observation.runtimeDigest, dependencyDigest, releaseDigest, policyDigest, environment, credentialIdentity: name => observation.credentials[name]?.identity ?? null });
  return { ...capture, profileDigest };
}
