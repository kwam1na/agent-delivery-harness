/** Invocation-scoped execution coordinator; durable truth remains per-check evidence. */
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { captureCheckBindings, captureCheckOutputSnapshots, candidateTreeEvidenceReader, createExecPort, digestCanonical, resolveRecordStorage, runGitCommand, scopedCheckIdentity, selectScopedCheckAttempt, sha256Hex, submitManifest,
  type CandidateBinding, type CapturedCandidate, type ProviderRegistration, type ScopedCheckPlan, type ScopedRuntimeObservation, type RecordCandidateBinding } from "@agent-delivery-harness/kernel";
import type { CommandContext } from "./boundary.ts";
import { AttemptStore, type AttemptPayload, type StoredAttempt } from "./scoped-attempts.ts";
import { CheckSnapshotError, createCheckSnapshot, executionPath, type CheckSnapshot } from "./check-snapshot.ts";
export function scopedCandidate(candidate: CandidateBinding): RecordCandidateBinding {
  return { treeSha: candidate.treeSha, deliverableDigest: candidate.deliverable.digest, identityToken: candidate.deliverable.identity, baseRef: candidate.base.ref, baseTipSha: candidate.base.tipSha, mergeBaseSha: candidate.base.mergeBaseSha, workspaceId: candidate.workspaceId };
}
async function executableIdentity(command: string, root: string, searchPath: string, cwd: string, read: Awaited<ReturnType<typeof candidateTreeEvidenceReader>>) {
  if (command.includes(path.sep) && !path.isAbsolute(command)) {
    const file = path.posix.normalize(path.posix.join(cwd, command));
    if (file === ".." || file.startsWith("../")) throw new CheckSnapshotError("check_runtime_unavailable", "A relative execution tool must stay inside the prepared tree.");
    const bytes = await read(file);
    if (bytes === null) throw new CheckSnapshotError("check_runtime_unavailable", "A relative execution tool is missing from the prepared tree.");
    return { command, sha256: sha256Hex(bytes), metadata: await read.metadata(file) };
  }
  const candidates = command.includes(path.sep) ? [path.resolve(root, command)] : searchPath.split(path.delimiter).map(p => path.join(p, command));
  for (const file of candidates) {
    try { await access(file); } catch { continue; }
    const relative = path.relative(await realpath(root), await realpath(file));
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new CheckSnapshotError("check_runtime_author_path", "Repository execution tools must use a relative command so they run from the private prepared tree.");
    return { command, sha256: sha256Hex(await readFile(file)), mode: (await stat(file)).mode & 0o111 };
  }
  throw new CheckSnapshotError("check_runtime_unavailable", "A declared execution tool cannot be resolved and bound.");
}
export class ScopedChecks {
  private readonly snapshots = new Map<string, CheckSnapshot>();
  private readonly owned = new Map<string, Awaited<ReturnType<AttemptStore["allocate"]>>>();
  private readonly stores = new Map<string, AttemptStore>();
  private readonly identities = new Map<string, Awaited<ReturnType<typeof scopedCheckIdentity>>>();
  private readonly observations = new Map<string, ScopedRuntimeObservation>();
  private readonly runId = randomUUID();
  private readonly submissions: (() => Promise<void>)[] = [];
  readonly context: CommandContext;
  readonly candidate: CapturedCandidate;
  private constructor(context: CommandContext, candidate: CapturedCandidate) { this.context = context; this.candidate = candidate; }
  static async create(context: CommandContext, candidate: CapturedCandidate): Promise<ScopedChecks | undefined> {
    const providers = context.config.providers.filter(p => p.check?.scope);
    if (!providers.length) return undefined;
    if (context.config.scopedExecution?.version !== "scoped-execution/1") throw new CheckSnapshotError("scoped_executor_required", "Scoped checks require supported private execution profiles before preparation.");
    const session = new ScopedChecks(context, candidate);
    const storage = await resolveRecordStorage(context.rootDir, { storageNamespace: context.config.storageNamespace, leaf: "scoped-attempts" });
    const read = await candidateTreeEvidenceReader(context.rootDir, candidate.treeSha);
    const listing = await runGitCommand(["git", "ls-tree", "-r", "--name-only", "-z", candidate.treeSha], { cwd: context.rootDir });
    if (listing.exitCode !== 0) throw new CheckSnapshotError("check_snapshot_unavailable", "Cannot enumerate the prepared source tree.");
    const inventory = listing.stdout.split("\0").filter(Boolean);
    for (const provider of providers) {
      const scope = provider.check!.scope!, profile = context.config.scopedExecution.profiles.find(p => p.id === scope.profile)!;
      if (!profile) throw new CheckSnapshotError("scoped_executor_required", "A selected execution profile is unsupported.");
      if (profile.mutableOutputs.some(o => inventory.some(f => f === o.replace(/\/$/, "") || f.startsWith(`${o.replace(/\/$/, "")}/`)))) throw new CheckSnapshotError("check_output_overlaps_source", "Mutable outputs overlap prepared source.");
      if ((provider.check!.outputs ?? []).some(o => !profile.mutableOutputs.some(m => m.endsWith("/") ? o.startsWith(m) : o === m))) throw new CheckSnapshotError("check_output_undeclared", "Every retained output must be declared mutable in its profile.");
      const searchPath = executionPath(context.rootDir, context.env["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin");
      const tools = await Promise.all([[process.execPath, "."], [provider.check!.command[0], scope.cwd], ...(profile.dependencies ? [[profile.dependencies.command[0], "."]] : [])].map(([c, cwd]) => executableIdentity(c!, context.rootDir, searchPath, cwd!, read)));
      const observation: ScopedRuntimeObservation = { version: "scoped-runtime/1", runtimeDigest: digestCanonical({ platform: process.platform, arch: process.arch, tools, searchPath }),
        flags: Object.fromEntries(scope.environment.filter(e => e.kind === "flag" && context.env[e.name] !== undefined).map(e => [e.name, context.env[e.name]!])),
        credentials: Object.fromEntries(scope.environment.filter(e => e.kind === "credential").map(e => {
          const present = context.env[e.name] !== undefined, identity = present ? profile.credentialIdentities[e.name] ?? null : null;
          if (identity !== null && (identity === context.env[e.name] || identity === sha256Hex(context.env[e.name] ?? ""))) throw new CheckSnapshotError("check_credential_identity_invalid", "Credential identity must be an external nonsecret revision.");
          return [e.name, { present, identity }];
        })) };
      session.observations.set(provider.id, observation);
      session.identities.set(provider.id, await scopedCheckIdentity(context.config, provider, inventory, read, observation, candidate.base));
      session.stores.set(provider.id, new AttemptStore(path.join(storage.storageDir, digestCanonical({ gate: context.config.gateId, provider: provider.id }))));
    }
    return session;
  }
  async plan(): Promise<ScopedCheckPlan> {
    const checks: Record<string, ScopedCheckPlan["checks"][string]> = {};
    for (const [id, identity] of this.identities) checks[id] = { inputDigest: identity.inputDigest, profileDigest: identity.profileDigest, reusable: identity.reusable, attempts: (await this.stores.get(id)!.read()).map(r => r.attempt) };
    return { version: "scoped-plan/1", candidate: scopedCandidate(this.candidate), selectionDigest: digestCanonical(this.context.config.providers.filter(p => p.check?.scope).map(p => ({ id: p.id, check: p.check })).sort((a, b) => a.id.localeCompare(b.id))), checks };
  }
  private async selected(id: string): Promise<StoredAttempt | undefined> {
    const identity = this.identities.get(id)!;
    const rows = await this.stores.get(id)!.read();
    const selected = selectScopedCheckAttempt(id, identity.inputDigest, identity.profileDigest, rows.map(r => r.attempt));
    return rows.find(r => r.attempt.attemptId === selected?.attemptId);
  }
  readonly readOutput = async (repoPath: string, providerId: string): Promise<Uint8Array> => {
    if (!this.identities.has(providerId)) return readFile(path.join(this.context.rootDir, repoPath));
    const selected = await this.selected(providerId);
    const output = selected?.attempt.status === "passed" ? selected.payload?.outputs.find(o => o.path === repoPath) : undefined;
    if (!output || sha256Hex(Buffer.from(output.base64, "base64")) !== output.sha256) throw new CheckSnapshotError("check_output_missing", "Retained scoped output is absent or corrupt.");
    return Buffer.from(output.base64, "base64");
  };
  /** No safe secret identity means a fresh attempt in every executing invocation. */
  async fenceNonReusable(ids: readonly string[]): Promise<void> {
    for (const id of ids) if (!this.identities.get(id)!.reusable && !this.owned.has(id)) await this.allocate(id);
  }
  private async allocate(id: string) {
    const identity = this.identities.get(id)!;
    const attempt = await this.stores.get(id)!.allocate({ version: "scoped-attempt/1", providerId: id, inputDigest: identity.inputDigest, profileDigest: identity.profileDigest, origin: { candidate: scopedCandidate(this.candidate), runId: this.runId } });
    this.owned.set(id, attempt); return attempt;
  }
  async explainReuse(admitted: readonly string[]): Promise<void> {
    for (const id of this.identities.keys()) {
      const selected = await this.selected(id);
      if (admitted.includes(id) && selected?.attempt.status === "passed") this.context.write(`reusing ${id}: matching inputs/profile; attempt ${selected.attempt.attemptId}`);
      for (const row of await this.stores.get(id)!.read()) if (row.attempt.status !== "passed" && row.attempt.inputDigest !== this.identities.get(id)!.inputDigest) this.context.write(`superseded ${id}: ${row.attempt.status} attempt ${row.attempt.attemptId} has different inputs`);
    }
  }
  async satisfyMechanical(): Promise<void> {
    const ids = this.context.config.scopedExecution!.mechanicalProviders;
    await this.fenceNonReusable(ids);
    for (const id of ids) {
      if ((await this.selected(id))?.attempt.status === "passed") { this.context.write(`reusing mechanical ${id}`); continue; }
      const provider = this.context.config.providers.find(p => p.id === id)!;
      await this.execute(provider, this.context.config.obligations.filter(o => o.providers.includes(id)).map(o => o.id), true);
    }
  }
  async submitMechanical(): Promise<void> { for (const submit of this.submissions) await submit(); this.submissions.length = 0; }
  async execute(provider: ProviderRegistration, obligationIds: readonly string[], deferSubmission = false): Promise<void> {
    const started = Date.now(), check = provider.check!, profile = this.context.config.scopedExecution!.profiles.find(p => p.id === check.scope!.profile)!;
    const attempt = this.owned.get(provider.id) ?? await this.allocate(provider.id);
    let payload: AttemptPayload = { outputs: [] }, terminal = false;
    const store = this.stores.get(provider.id)!;
    try {
      const key = profile.id;
      let snapshot = this.snapshots.get(key);
      if (!snapshot) {
        snapshot = await createCheckSnapshot({ rootDir: this.context.rootDir, candidate: this.candidate, outputs: profile.mutableOutputs, environment: { PATH: this.context.env["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin" }, ...(profile.dependencies ? { dependencies: profile.dependencies } : {}), ...(this.context.signal ? { signal: this.context.signal } : {}) });
        this.snapshots.set(key, snapshot);
      }
      await snapshot.verify();
      // A sibling or dependency setup cannot supply this command's result.
      for (const output of check.outputs ?? []) await rm(path.join(snapshot.rootDir, output), { recursive: true, force: true });
      const injected = Object.fromEntries(check.scope!.environment.filter(e => this.context.env[e.name] !== undefined).map(e => [e.name, this.context.env[e.name]!]));
      this.context.write(`checking ${provider.id}: attempt ${attempt.attemptId}`);
      const commandHome = path.join(snapshot.rootDir, ".git/commands", attempt.attemptId, "home"), commandTemp = path.join(snapshot.rootDir, ".git/commands", attempt.attemptId, "tmp");
      await mkdir(commandHome, { recursive: true }); await mkdir(commandTemp, { recursive: true });
      const result = await createExecPort().run({ command: check.command[0], args: check.command.slice(1), cwd: path.join(snapshot.rootDir, check.scope!.cwd), env: { ...snapshot.environment, ...injected, HOME: commandHome, TMPDIR: commandTemp }, timeoutMs: check.timeoutMs, maxBuffer: 1024 * 1024, ...(this.context.signal ? { signal: this.context.signal } : {}) });
      const secrets = check.scope!.environment.filter(e => e.kind === "credential").map(e => this.context.env[e.name]).filter((v): v is string => !!v);
      const redact = (s: string) => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), s);
      payload = { outputs: [], durationMs: Date.now() - started, log: redact(`${result.stdout}\n${result.stderr}`).slice(-4000), dependencyDigest: snapshot.dependencyDigest };
      if (result.code !== 0 || this.context.signal?.aborted) throw new CheckSnapshotError("check_command_failed", `Declared scoped check ${provider.id} did not complete successfully (exit ${result.code}).`);
      await snapshot.verify();
      const outputs = await captureCheckOutputSnapshots(snapshot.rootDir, check.outputs ?? []);
      if (!outputs || outputs.some(o => secrets.some(secret => Buffer.from(o.base64, "base64").includes(Buffer.from(secret))))) throw new CheckSnapshotError("check_output_missing", "A retained output is absent, corrupt, escaped or contains credential bytes.");
      payload = { ...payload, outputs };
      await store.finish(attempt, "passed", payload); terminal = true;
      const scopedPlan = await this.plan();
      const wiring = await this.context.wire();
      const binding = (await captureCheckBindings(this.context.rootDir, this.context.config, this.candidate, { ...wiring.storageOptions, scopedPlan, readOutput: this.readOutput }))[provider.id];
      if (!binding || binding.scopedAttemptDigest !== digestCanonical({ ...attempt, status: "passed" })) throw new CheckSnapshotError("check_attempt_superseded", "A newer attempt superseded this completion before evidence publication.");
      const runId = attempt.attemptId, finalPassId = "pass-1";
      const allocation = await this.context.artifacts.allocateRunRoot({ providerId: provider.id, runId });
      if (!allocation.ok) throw new CheckSnapshotError("check_artifact_unavailable", "Cannot allocate scoped check evidence.");
      const artifacts: { path: string; sha256: string; role: string }[] = [];
      const write = async (name: string, value: unknown, role: string) => { const text = JSON.stringify(value); await this.context.artifacts.writeTextFile(path.join(allocation.runRoot.path, name), text); artifacts.push({ path: name, sha256: sha256Hex(text), role }); };
      for (const [index, output] of outputs.entries()) await write(`check-output-${index}.json`, { path: output.path, base64: output.base64 }, "check-output");
      const claim = { verdict: "green", exitCode: 0, binding };
      await write("check-result.json", { providerId: provider.id, runId, finalPassId, ...claim }, "check-result");
      await write("scoped-inputs.json", { observation: this.observations.get(provider.id), attempt: { ...attempt, status: "passed" }, durationMs: payload.durationMs, dependencyDigest: payload.dependencyDigest }, "scoped-inputs");
      const c = this.candidate;
      const manifest = { spec: "delivery-evidence/1", provider: { id: provider.id, runId, finalPassId }, candidate: { vcs: "git", treeSha: c.treeSha, headSha: c.headSha, deliverable: c.deliverable, base: c.base, workspaceId: c.workspaceId }, runHistory: [{ preparedTreeSha: c.treeSha, evaluatedInPassId: finalPassId }], artifacts, attestation: { level: "self", signatures: [] }, recordedAt: new Date().toISOString(), claims: obligationIds.map(obligation => ({ obligation, payloadSpec: "checks.passed/1", payload: claim })) };
      const manifestPath = path.join(allocation.runRoot.path, "manifest.json"); await this.context.artifacts.writeTextFile(manifestPath, JSON.stringify(manifest));
      const submit = async () => {
      const outcome = await submitManifest({ rootDir: this.context.rootDir, config: this.context.config, manifestPath }, { captureCandidate: wiring.captureCandidate, artifacts: this.context.artifacts, ...wiring.storageOptions, scopedPlan: await this.plan(), readOutput: this.readOutput });
      if (outcome.status !== "accepted") throw new CheckSnapshotError("check_evidence_rejected", outcome.blockers.map(b => b.code).join(", "));
      };
      if (deferSubmission) this.submissions.push(submit); else await submit();
      this.context.write(`passed ${provider.id}: ${Date.now() - started}ms including snapshot setup; retained ${runId}`);
    } catch (error) {
      if (!terminal) await store.finish(attempt, this.context.signal?.aborted ? "interrupted" : "failed", { ...payload, durationMs: Date.now() - started });
      const damaged = this.snapshots.get(profile.id);
      this.snapshots.delete(profile.id);
      await damaged?.cleanup();
      throw error;
    }
  }
  async cleanup(): Promise<void> { for (const snapshot of this.snapshots.values()) await snapshot.cleanup(); this.snapshots.clear(); }
}
