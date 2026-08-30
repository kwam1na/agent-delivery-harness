/**
 * The host module's V-slice: the Claude Code integration, built exactly on
 * the graded capability record's qualified surfaces and nothing beyond them.
 *
 *   - IN-SESSION PROJECTION. The run-pinned workflow root is materialized
 *     into the host-created worktree itself and digest-receipted; no
 *     repository-global active pointer and no host API for root selection is
 *     consulted. The projection subtree is read-only, carries the binding's
 *     per-run consumption marker, and is kept untracked through a genuinely
 *     worktree-scoped exclusion — worktree `core.excludesFile` under
 *     `extensions.worktreeConfig`, never the shared `info/exclude` pattern
 *     space and never a tracked ignore edit. A pre-existing worktree
 *     excludes value fails closed rather than being clobbered.
 *   - ADMISSION COMPOSITION. Session settings wire the model-external
 *     PreToolUse interceptor and the SessionEnd lifecycle hook, and the CLI
 *     arguments exclude candidate-writable setting scopes
 *     (`--setting-sources user`), which the capability record proved
 *     neutralizes a candidate-planted settings file. The PRODUCT never
 *     launches the host: composition returns data; a test harness or the
 *     operator starts the session.
 *   - ATTESTATION. The binding — never a model-callable tool — mints the
 *     grant attestation bound to host version, delivery, fence, trust epoch,
 *     grant digest, workspace, projection digest, and the binding-written
 *     discovery configuration.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareUtf16CodeUnits } from "../canonical.ts";
import { digestCanonical, sha256Hex } from "../digest.ts";
import type { AdmissionExpectation } from "../binding/host-admission.ts";
import { listArchiveEntries, readArchiveEntry } from "../workflow/archive.ts";
import type { ExecPort } from "./exec-port.ts";

/** The projection subtree inside the worktree — a protected authority path. */
export const PROJECTION_DIR = ".managed-projection";

/** Where the pinned generation stores the exact skills release archive. */
export const GENERATION_SKILLS_ARCHIVE = "skills/agent-skills-core-v1.zip";

/** The archive prefixes the projection materializes: workflow text + graph. */
export const PROJECTION_ENTRY_PREFIXES = Object.freeze(["skills/", "workflows/", "schemas/workflow-"]);

export const PROJECTION_RECEIPT_FILE = "projection-receipt.json";
export const WORKTREE_EXCLUDES_FILE = "worktree-excludes";
export const SESSION_SETTINGS_FILE = "settings.json";

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;
const READONLY_FILE = 0o444;

export const HOST_BINDING_BLOCKER_CODES = Object.freeze([
  "generation_archive_unreadable",
  "projection_write_failed",
  "preexisting_worktree_excludes",
  "worktree_config_failed",
  "projection_receipt_missing",
  "projection_receipt_corrupt",
  "projection_digest_mismatch",
  "discovery_configuration_unreadable",
] as const);
export type HostBindingBlockerCode = (typeof HOST_BINDING_BLOCKER_CODES)[number];

export interface HostBindingBlocker {
  readonly code: HostBindingBlockerCode;
  readonly message: string;
}

export type HostBindingFailure = { readonly ok: false; readonly blockers: readonly HostBindingBlocker[] };

const fail = (code: HostBindingBlockerCode, message: string): HostBindingFailure => ({
  ok: false,
  blockers: [{ code, message }],
});

interface ProjectionReceipt {
  readonly deliveryId: string;
  readonly projectionDigest: string;
  readonly entries: readonly { readonly path: string; readonly sha256: string }[];
}

export interface MaterializeProjectionInput {
  readonly worktreeDir: string;
  /** The pinned generation root (digest-addressed, already trust-checked). */
  readonly generationRoot: string;
  readonly deliveryId: string;
  /** The binding-owned directory in the product namespace for receipts and configuration. */
  readonly bindingDir: string;
  readonly exec: ExecPort;
}

export type MaterializeProjectionResult =
  | { readonly ok: true; readonly projectionDigest: string; readonly excludesPath: string }
  | HostBindingFailure;

const projectionDigestOf = (entries: readonly { path: string; sha256: string }[]): string =>
  digestCanonical([...entries].sort((a, b) => compareUtf16CodeUnits(a.path, b.path)));

/**
 * Materializes the run-pinned projection into the worktree and configures the
 * worktree-scoped exclusion. Fails closed on a pre-existing worktree excludes
 * value — preserving the operator's configuration is the rule; merging it is
 * the host-integration unit's hardening.
 */
export async function materializeProjection(input: MaterializeProjectionInput): Promise<MaterializeProjectionResult> {
  let archive: Uint8Array;
  try {
    archive = await readFile(path.join(input.generationRoot, ...GENERATION_SKILLS_ARCHIVE.split("/")));
  } catch {
    return fail(
      "generation_archive_unreadable",
      `the pinned generation carries no readable ${GENERATION_SKILLS_ARCHIVE}; a missing pinned root blocks rather than falling forward`,
    );
  }

  // The worktree-scoped exclusion, before any projection byte lands, so the
  // subtree is never observable as untracked content.
  const excludesPath = path.join(input.bindingDir, WORKTREE_EXCLUDES_FILE);
  const enable = await input.exec.run({
    command: "git",
    args: ["config", "extensions.worktreeConfig", "true"],
    cwd: input.worktreeDir,
  });
  if (enable.code !== 0) {
    return fail("worktree_config_failed", `enabling extensions.worktreeConfig failed: ${enable.stderr.trim()}`);
  }
  const existing = await input.exec.run({
    command: "git",
    args: ["config", "--worktree", "--get", "core.excludesFile"],
    cwd: input.worktreeDir,
  });
  if (existing.code === 0 && existing.stdout.trim().length > 0 && existing.stdout.trim() !== excludesPath) {
    return fail(
      "preexisting_worktree_excludes",
      `this worktree already sets core.excludesFile (${existing.stdout.trim()}); the binding preserves operator configuration and fails closed instead of replacing it`,
    );
  }
  await mkdir(input.bindingDir, { recursive: true, mode: OWNER_DIR });
  await writeFile(excludesPath, `/${PROJECTION_DIR}/\n`, { mode: OWNER_FILE });
  await chmod(excludesPath, OWNER_FILE);
  const setExcludes = await input.exec.run({
    command: "git",
    args: ["config", "--worktree", "core.excludesFile", excludesPath],
    cwd: input.worktreeDir,
  });
  if (setExcludes.code !== 0) {
    return fail("worktree_config_failed", `setting the worktree excludes file failed: ${setExcludes.stderr.trim()}`);
  }

  // The projection bytes: generation content plus the binding's per-run
  // consumption marker, every byte digest-bound at materialization.
  const entries: { path: string; sha256: string }[] = [];
  const projectionRoot = path.join(input.worktreeDir, PROJECTION_DIR);
  try {
    let names: readonly string[];
    try {
      names = listArchiveEntries(archive);
    } catch (error) {
      return fail(
        "generation_archive_unreadable",
        `the pinned skills archive is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const name of names) {
      if (!PROJECTION_ENTRY_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      // Defense in depth under the digest pin: an entry name may never
      // traverse out of the projection subtree.
      if (name.startsWith("/") || name.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
        return fail("projection_write_failed", `archive entry ${JSON.stringify(name)} is not a normalized relative path — refusing`);
      }
      const bytes = readArchiveEntry(archive, name);
      const target = path.join(projectionRoot, ...name.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      await chmod(target, READONLY_FILE);
      entries.push({ path: name, sha256: sha256Hex(bytes) });
    }
    const marker = `${JSON.stringify({ deliveryId: input.deliveryId, consumed: GENERATION_SKILLS_ARCHIVE })}\n`;
    const markerPath = path.join(projectionRoot, "consumption.json");
    await writeFile(markerPath, marker);
    await chmod(markerPath, READONLY_FILE);
    entries.push({ path: "consumption.json", sha256: sha256Hex(marker) });
  } catch (error) {
    return fail(
      "projection_write_failed",
      `materializing the projection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const receipt: ProjectionReceipt = {
    deliveryId: input.deliveryId,
    projectionDigest: projectionDigestOf(entries),
    entries: [...entries].sort((a, b) => compareUtf16CodeUnits(a.path, b.path)),
  };
  const receiptPath = path.join(input.bindingDir, PROJECTION_RECEIPT_FILE);
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: OWNER_FILE });
  await chmod(receiptPath, OWNER_FILE);

  return { ok: true, projectionDigest: receipt.projectionDigest, excludesPath };
}

export type VerifyProjectionResult = { readonly ok: true; readonly projectionDigest: string } | HostBindingFailure;

/**
 * The canonical-recheck half: recompute the projection digest from the
 * worktree bytes and require it to match the materialization receipt. Any
 * byte inside the receipted set not matching its digest fails closed.
 */
export async function verifyProjection(input: {
  readonly worktreeDir: string;
  readonly bindingDir: string;
}): Promise<VerifyProjectionResult> {
  let receiptText: string;
  try {
    receiptText = await readFile(path.join(input.bindingDir, PROJECTION_RECEIPT_FILE), "utf8");
  } catch {
    return fail("projection_receipt_missing", "no projection receipt; nothing can be verified against it");
  }
  let receipt: ProjectionReceipt;
  try {
    receipt = JSON.parse(receiptText) as ProjectionReceipt;
  } catch {
    return fail("projection_receipt_corrupt", "the projection receipt is not JSON");
  }
  if (!Array.isArray(receipt.entries) || typeof receipt.projectionDigest !== "string") {
    return fail("projection_receipt_corrupt", "the projection receipt is outside its shape");
  }
  if (projectionDigestOf(receipt.entries) !== receipt.projectionDigest) {
    return fail("projection_receipt_corrupt", "the projection receipt does not bind its own entries");
  }

  for (const entry of receipt.entries) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path.join(input.worktreeDir, PROJECTION_DIR, ...entry.path.split("/")));
    } catch {
      return fail("projection_digest_mismatch", `receipted projection file ${entry.path} is missing from the worktree`);
    }
    const digest = sha256Hex(bytes);
    if (digest !== entry.sha256) {
      return fail(
        "projection_digest_mismatch",
        `projection file ${entry.path} hashes to ${digest}, not the receipted ${entry.sha256}; mid-run tampering fails closed`,
      );
    }
  }
  return { ok: true, projectionDigest: receipt.projectionDigest };
}

export interface ComposeClaudeCodeSessionInput {
  readonly bindingDir: string;
  /** The binding state file the model-external hook consults per invocation. */
  readonly statePath: string;
  /** The command vector that runs the hook entry (the caller supplies the runtime). */
  readonly hookCommand: readonly string[];
  /** The stage grant whose allowed capabilities become the host's own permission allow rules. */
  readonly grant: { readonly allowedCapabilities: readonly string[] };
}

export type ComposeClaudeCodeSessionResult =
  | {
      readonly ok: true;
      readonly settingsPath: string;
      /** Admission arguments for the host CLI. The product never launches it. */
      readonly cliArgs: readonly string[];
      readonly discoveryConfigurationDigest: string;
    }
  | HostBindingFailure;

/**
 * Composes the session-scoped admission configuration: hooks wired to the
 * model-external interceptor and lifecycle entries, and setting sources
 * restricted to the user scope so candidate-writable scopes never load.
 */
export async function composeClaudeCodeSession(
  input: ComposeClaudeCodeSessionInput,
): Promise<ComposeClaudeCodeSessionResult> {
  const hook = (subcommand: string): string =>
    [...input.hookCommand, subcommand, input.statePath].map((part) => JSON.stringify(part)).join(" ");

  const settings = {
    // The supported host enforces the grant through its OWN permission
    // system; the hook is the deny-until-attested interceptor on top. Only
    // the grant's capabilities are allowed — everything else stays subject to
    // the host's non-interactive default denial.
    permissions: {
      allow: [...input.grant.allowedCapabilities],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: hook("pre-tool-use") }],
        },
      ],
      SessionEnd: [
        {
          hooks: [{ type: "command", command: hook("session-end") }],
        },
      ],
    },
  };

  const settingsBytes = `${JSON.stringify(settings, null, 2)}\n`;
  const settingsPath = path.join(input.bindingDir, SESSION_SETTINGS_FILE);
  await mkdir(input.bindingDir, { recursive: true, mode: OWNER_DIR });
  await writeFile(settingsPath, settingsBytes, { mode: OWNER_FILE });
  await chmod(settingsPath, OWNER_FILE);

  let excludesBytes: string;
  try {
    excludesBytes = await readFile(path.join(input.bindingDir, WORKTREE_EXCLUDES_FILE), "utf8");
  } catch {
    return fail(
      "discovery_configuration_unreadable",
      "the worktree excludes file is missing; compose the session only after materializing the projection",
    );
  }

  // The binding-written host discovery-configuration set, digest-bound at
  // application: the session settings and the worktree-scoped exclusion.
  const discoveryConfigurationDigest = digestCanonical({
    settings: settingsBytes,
    worktreeExcludes: excludesBytes,
  });

  return {
    ok: true,
    settingsPath,
    // Candidate-writable setting scopes (project/local) are excluded — the
    // graded requirement — and so is every other ambient scope: the empty
    // selection makes the binding-composed `--settings` file the session's
    // ONLY settings source, so the discovery configuration is exactly the
    // digest-bound bytes above.
    cliArgs: ["--settings", settingsPath, "--setting-sources", ""],
    discoveryConfigurationDigest,
  };
}

export interface MintGrantAttestationInput {
  readonly grant: unknown;
  readonly expectation: AdmissionExpectation;
  readonly expiry: string;
}

/**
 * The binding's attestation mint: binds the exact expectation and grant
 * bytes. A checkpoint attestation binds every delivery-scoped identity; an
 * intake attestation binds the intake draft and records every delivery-scoped
 * member EXPLICITLY absent-by-state — pre-delivery there is no fence,
 * workspace, projection, or registration to bind.
 */
export function mintGrantAttestation(input: MintGrantAttestationInput): Record<string, unknown> {
  const base = {
    spec: "grant-attestation/1",
    profile: input.expectation.profile,
    hostVersion: input.expectation.hostVersion,
    grantDigest: digestCanonical(input.grant),
    productTrustRevocationEpoch: input.expectation.productTrustRevocationEpoch,
    expiry: input.expiry,
  };
  if (input.expectation.profile === "intake") {
    return {
      ...base,
      intakeDraftId: input.expectation.intakeDraftId,
      deliveryId: "absent-by-state",
      invocationFence: "absent-by-state",
      workspaceId: "absent-by-state",
      projectionDigest: "absent-by-state",
      discoveryConfigurationDigest: "absent-by-state",
      registeringInstallationId: "absent-by-state",
      activeProfile: "absent-by-state",
    };
  }
  return {
    ...base,
    intakeDraftId: "absent-by-state",
    deliveryId: input.expectation.deliveryId,
    invocationFence: input.expectation.invocationFence,
    workspaceId: input.expectation.workspaceId,
    projectionDigest: input.expectation.projectionDigest,
    discoveryConfigurationDigest: input.expectation.discoveryConfigurationDigest,
    registeringInstallationId: input.expectation.registeringInstallationId,
    activeProfile: input.expectation.activeProfile,
  };
}
