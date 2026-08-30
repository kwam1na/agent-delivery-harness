/**
 * The local pack/install/activate path and the M0-era canonical trust check
 * sites. This is deliberately a LOCAL composition substrate, not a product
 * distribution system: it packs the current checkout plus the exact pinned
 * `agent-skills` release into one deterministic staged composition, installs
 * it into a read-only digest-addressed generation root inside one
 * installation namespace, and activates it for new intake. Cross-platform
 * packaging, update journaling, garbage collection, and source-independent
 * rollback belong to the release-lifecycle unit that hardens this path.
 *
 * OPERATOR ACTS. Initial install and trust pinning are operator-performed
 * interactive installer acts, outside any model-driven session; the plan's
 * approval-hardening unit binds them to the non-model-mintable assertion —
 * this substrate owns the mechanics, not the assertion.
 *
 * THE TRUST STORE IS INSTALLATION-SCOPED, FULL STOP. Every trust read here
 * resolves to `<installationPath>/trust/product-trust.json` and nowhere else:
 * no current-working-directory probing, no repository-local fallback, so a
 * planted repository-local trust file is ignored by construction and a fresh
 * clone or new worktree can never reset the high-water mark or revocation
 * epoch. The store and the install receipt are created with D16 owner-only
 * permissions (0700 directories, 0600 files) from the first install.
 *
 * THE CHECK SITES all consume the spine's `ProductTrustPort` — the single
 * seam where the detached-signature predicate later replaces the digest
 * predicate with no change to any caller:
 *
 *   - digest closure (`verifyGenerationClosure`, run at install and on every
 *     pinned-root load);
 *   - the no-downgrade high-water mark (activation during install);
 *   - revocation evaluation against the initialized list/epoch
 *     (`checkMutationLane`, and every pinned-root load), failing closed on
 *     absent or corrupt trust state.
 *
 * Later units invoke `checkMutationLane` at the sites they introduce rather
 * than reimplementing the predicate.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareUtf16CodeUnits } from "../canonical.ts";
import { sha256Hex } from "../digest.ts";
import {
  PINNED_AGENT_SKILLS,
  localDigestTrustPredicate,
  type ProductTrustPort,
  type ProductTrustState,
} from "../spine/composition.ts";
import {
  COMPOSITION_PROFILES,
  buildCompositionManifest,
  compositionManifestBytes,
  generationDigestOf,
  validateCompositionManifest,
  type CompositionInventoryEntry,
  type CompositionProfile,
} from "./manifest.ts";
import {
  checkNoDowngrade,
  discriminateInstall,
  parseTrustState,
  type ArtifactPresence,
  type InstallationPresence,
  type OtherInstallationArtifact,
} from "./trust-store.ts";

// ── Vocabulary and layout ──────────────────────────────────────────────────

export const SUBSTRATE_BLOCKER_CODES = Object.freeze([
  "skills_archive_digest_mismatch",
  "skills_metadata_digest_mismatch",
  "manifest_malformed",
  "closure_digest_mismatch",
  "generation_digest_mismatch",
  "missing_generation",
  "not_an_installed_generation",
  "trust_state_absent",
  "trust_state_corrupt",
  "prior_installation_artifacts",
  "downgrade_rejected",
  "generation_revoked",
  "generation_not_pinned",
  "composition_profile_mismatch",
  "install_receipt_absent",
  "install_receipt_corrupt",
  "active_pointer_missing",
  "active_pointer_corrupt",
] as const);
export type SubstrateBlockerCode = (typeof SUBSTRATE_BLOCKER_CODES)[number];

export interface SubstrateBlocker {
  readonly code: SubstrateBlockerCode;
  readonly message: string;
}

export type SubstrateFailure = { readonly ok: false; readonly blockers: readonly SubstrateBlocker[] };

const fail = (code: SubstrateBlockerCode, message: string): SubstrateFailure => ({
  ok: false,
  blockers: [{ code, message }],
});

export const COMPOSITION_MANIFEST_FILE = "composition-manifest.json";
export const INSTALL_RECEIPT_SPEC = "install-receipt/1";
export const ACTIVE_POINTER_SPEC = "active-pointer/1";

const GENERATIONS_LEAF = "generations";
const POINTERS_LEAF = "pointers";
const TRUST_LEAF = "trust";
const JOURNAL_LEAF = "journal";
const RECEIPTS_LEAF = "receipts";

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;
const READONLY_DIR = 0o555;
const READONLY_FILE = 0o444;

/** The one place trust state lives. Never resolved from a repository. */
export function trustStorePathFor(installationPath: string): string {
  return path.join(installationPath, TRUST_LEAF, "product-trust.json");
}

/** The receipt lives OUTSIDE the store, keyed to the installation path. */
export function receiptPathFor(receiptDir: string, installationPath: string): string {
  return path.join(receiptDir, RECEIPTS_LEAF, `${sha256Hex(installationPath)}.json`);
}

const generationRootFor = (installationPath: string, generationDigest: string): string =>
  path.join(installationPath, GENERATIONS_LEAF, generationDigest);

const activePointerPathFor = (installationPath: string): string =>
  path.join(installationPath, POINTERS_LEAF, "active.json");

// ── Small filesystem helpers ───────────────────────────────────────────────

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Deterministic recursive walk: sorted, files only, '/'-separated paths.
 * The source walk skips development artifacts (hidden entries, node_modules,
 * dist) because a checkout legitimately carries them; the raw walk skips
 * NOTHING — closure verification and root materialization must see every
 * byte, or an unlisted hidden file could ride along unverified.
 */
async function walkFiles(
  root: string,
  mode: "skip-dev-artifacts" | "raw",
  relative = "",
): Promise<string[]> {
  const absolute = relative === "" ? root : path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((a, b) => compareUtf16CodeUnits(a.name, b.name));
  const out: string[] = [];
  for (const entry of entries) {
    if (
      mode === "skip-dev-artifacts" &&
      (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist")
    ) {
      continue;
    }
    const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(root, mode, childRelative)));
    } else if (entry.isFile()) {
      out.push(childRelative);
    }
  }
  return out;
}

async function writeOwnerFile(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: OWNER_DIR });
  await writeFile(target, contents, { mode: OWNER_FILE });
  await chmod(target, OWNER_FILE);
}

// ── Packing ────────────────────────────────────────────────────────────────

/** The harness modules the minimum composition packs from the checkout. */
export const PACKED_HARNESS_PACKAGES = Object.freeze(["kernel", "cli", "conformance", "mcp", "action"] as const);

const PACKED_ROOT_FILES = Object.freeze(["LICENSE", "NOTICE", "qualifications/host-admission-capabilities.json"] as const);

const SKILLS_ARCHIVE_ENTRY = "skills/agent-skills-core-v1.zip";
const SKILLS_METADATA_ENTRY = "skills/agent-skills-core-v1.metadata.json";

export interface PackCompositionInput {
  /** The checkout supplying the managed facade and harness modules. Read-only input. */
  readonly sourceRoot: string;
  /** The exact `agent-skills` release archive; must hash to the frozen pin. */
  readonly skillsArchivePath: string;
  readonly skillsMetadataPath: string;
  readonly compositionProfile: CompositionProfile;
  readonly compositionSequence: number;
  readonly outDir: string;
}

export type PackCompositionResult =
  | {
      readonly ok: true;
      readonly generationDigest: string;
      readonly manifestPath: string;
      readonly packedDir: string;
    }
  | SubstrateFailure;

export async function packComposition(input: PackCompositionInput): Promise<PackCompositionResult> {
  const archiveBytes = await readFile(input.skillsArchivePath);
  const archiveDigest = sha256Hex(archiveBytes);
  if (archiveDigest !== PINNED_AGENT_SKILLS.archiveSha256) {
    return fail(
      "skills_archive_digest_mismatch",
      `the skills archive hashes to ${archiveDigest}, not the pinned ${PINNED_AGENT_SKILLS.archiveSha256}; only the exact authenticated release is packable`,
    );
  }
  const metadataBytes = await readFile(input.skillsMetadataPath);
  const metadataDigest = sha256Hex(metadataBytes);
  if (metadataDigest !== PINNED_AGENT_SKILLS.metadataSha256) {
    return fail(
      "skills_metadata_digest_mismatch",
      `the skills release metadata hashes to ${metadataDigest}, not the pinned ${PINNED_AGENT_SKILLS.metadataSha256}`,
    );
  }

  const packedDir = path.join(input.outDir, "composition");
  const inventory: CompositionInventoryEntry[] = [];
  const stage = async (entryPath: string, bytes: Uint8Array): Promise<void> => {
    const target = path.join(packedDir, ...entryPath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    inventory.push({ path: entryPath, sha256: sha256Hex(bytes) });
  };

  const harnessModuleVersions: Record<string, string> = {};
  for (const packageLeaf of PACKED_HARNESS_PACKAGES) {
    const packageRoot = path.join(input.sourceRoot, "packages", packageLeaf);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    harnessModuleVersions[manifest.name] = manifest.version;
    for (const relative of await walkFiles(packageRoot, "skip-dev-artifacts")) {
      await stage(`harness/packages/${packageLeaf}/${relative}`, await readFile(path.join(packageRoot, ...relative.split("/"))));
    }
  }
  for (const rootFile of PACKED_ROOT_FILES) {
    await stage(`harness/${rootFile}`, await readFile(path.join(input.sourceRoot, ...rootFile.split("/"))));
  }
  await stage(SKILLS_ARCHIVE_ENTRY, archiveBytes);
  await stage(SKILLS_METADATA_ENTRY, metadataBytes);

  const rootManifest = JSON.parse(await readFile(path.join(input.sourceRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const manifest = buildCompositionManifest({
    compositionProfile: input.compositionProfile,
    compositionSequence: input.compositionSequence,
    productVersion: rootManifest.version,
    harnessModuleVersions,
    inventory,
  });
  const manifestBytes = compositionManifestBytes(manifest);
  const manifestPath = path.join(packedDir, COMPOSITION_MANIFEST_FILE);
  await writeFile(manifestPath, manifestBytes);

  return { ok: true, generationDigest: generationDigestOf(manifestBytes), manifestPath, packedDir };
}

// ── Closure verification ───────────────────────────────────────────────────

interface VerifiedClosure {
  readonly ok: true;
  readonly generationDigest: string;
  readonly manifest: Record<string, unknown>;
}

/**
 * Full digest closure over one composition root: the manifest is present and
 * well-formed, its bytes hash to the addressed digest when one is expected,
 * every listed file is present with exactly its listed bytes, and no
 * unlisted file exists.
 */
async function verifyGenerationClosure(
  root: string,
  expectedDigest?: string,
): Promise<VerifiedClosure | SubstrateFailure> {
  if (!(await exists(root))) {
    return fail("missing_generation", `generation root ${root} does not exist`);
  }
  const present = await walkFiles(root, "raw");
  if (present.length === 0) {
    return fail("missing_generation", `generation root ${root} is empty`);
  }
  if (!present.includes(COMPOSITION_MANIFEST_FILE)) {
    return fail(
      "not_an_installed_generation",
      `${root} carries no ${COMPOSITION_MANIFEST_FILE}; a source checkout or arbitrary directory is not an installed generation`,
    );
  }

  const manifestBytes = await readFile(path.join(root, COMPOSITION_MANIFEST_FILE), "utf8");
  const generationDigest = generationDigestOf(manifestBytes);
  if (expectedDigest !== undefined && generationDigest !== expectedDigest) {
    return fail(
      "generation_digest_mismatch",
      `the root's manifest hashes to ${generationDigest}, not the addressed ${expectedDigest}`,
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch {
    return fail("manifest_malformed", "the composition manifest is not JSON");
  }
  const verdict = validateCompositionManifest(manifest);
  if (!verdict.ok) {
    const detail = verdict.rejections.map((rejection) => `${rejection.pointer || "/"}: ${rejection.message}`).join("; ");
    return fail("manifest_malformed", `the composition manifest is outside its grammar (${detail})`);
  }

  const inventory = (manifest as Record<string, unknown>)["inventory"] as readonly CompositionInventoryEntry[];
  const listed = new Set(inventory.map((entry) => entry.path));
  for (const filePath of present) {
    if (filePath === COMPOSITION_MANIFEST_FILE) continue;
    if (!listed.has(filePath)) {
      return fail("closure_digest_mismatch", `file ${filePath} exists in the root but is not bound by the manifest`);
    }
  }
  for (const entry of inventory) {
    const target = path.join(root, ...entry.path.split("/"));
    let bytes: Uint8Array;
    try {
      bytes = await readFile(target);
    } catch {
      return fail("closure_digest_mismatch", `manifest-bound file ${entry.path} is missing from the root`);
    }
    const digest = sha256Hex(bytes);
    if (digest !== entry.sha256) {
      return fail(
        "closure_digest_mismatch",
        `file ${entry.path} hashes to ${digest}, not the manifest-bound ${entry.sha256}`,
      );
    }
  }

  return { ok: true, generationDigest, manifest: manifest as Record<string, unknown> };
}

// ── Trust state and receipt reads ──────────────────────────────────────────

type TrustStateLoad =
  | { readonly ok: true; readonly state: ProductTrustState }
  | SubstrateFailure;

async function loadTrustState(installationPath: string): Promise<TrustStateLoad> {
  const storePath = trustStorePathFor(installationPath);
  let bytes: string;
  try {
    bytes = await readFile(storePath, "utf8");
  } catch {
    return fail(
      "trust_state_absent",
      `no trust store at ${storePath}; absent trust state fails closed, it never defaults open`,
    );
  }
  const parsed = parseTrustState(bytes);
  if (!parsed.ok) return fail("trust_state_corrupt", parsed.message);
  return { ok: true, state: parsed.state };
}

export interface InstallReceipt {
  readonly spec: typeof INSTALL_RECEIPT_SPEC;
  readonly installationPath: string;
  readonly installationId: string;
  readonly installationProfile: CompositionProfile;
}

type ReceiptRead =
  | { readonly presence: "valid"; readonly receipt: InstallReceipt }
  | { readonly presence: "absent" }
  | { readonly presence: "corrupt"; readonly message: string };

async function readReceipt(receiptDir: string, installationPath: string): Promise<ReceiptRead> {
  const receiptPath = receiptPathFor(receiptDir, installationPath);
  let bytes: string;
  try {
    bytes = await readFile(receiptPath, "utf8");
  } catch {
    return { presence: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return { presence: "corrupt", message: "the install receipt is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { presence: "corrupt", message: "the install receipt is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  const profile = record["installationProfile"];
  if (
    record["spec"] !== INSTALL_RECEIPT_SPEC ||
    record["installationPath"] !== installationPath ||
    typeof record["installationId"] !== "string" ||
    record["installationId"].length === 0 ||
    typeof profile !== "string" ||
    !COMPOSITION_PROFILES.includes(profile as CompositionProfile)
  ) {
    return {
      presence: "corrupt",
      message: "the install receipt is outside its grammar or keyed to a different installation path",
    };
  }
  return { presence: "valid", receipt: record as unknown as InstallReceipt };
}

// ── Install and activate ───────────────────────────────────────────────────

export interface InstallCompositionInput {
  readonly packedDir: string;
  readonly installationPath: string;
  /** The platform user-configuration location holding install receipts. */
  readonly receiptDir: string;
  readonly trust?: ProductTrustPort;
}

export type InstallCompositionResult =
  | {
      readonly ok: true;
      readonly installationId: string;
      readonly generationDigest: string;
      readonly firstInstall: boolean;
      readonly root: string;
    }
  | SubstrateFailure;

async function observePresence(input: InstallCompositionInput): Promise<{
  readonly presence: InstallationPresence;
  readonly state?: ProductTrustState;
  readonly receipt?: InstallReceipt;
}> {
  let trustStore: ArtifactPresence = "absent";
  let state: ProductTrustState | undefined;
  if (await exists(trustStorePathFor(input.installationPath))) {
    const loaded = await loadTrustState(input.installationPath);
    if (loaded.ok) {
      trustStore = "valid";
      state = loaded.state;
    } else {
      trustStore = "corrupt";
    }
  }

  const receiptRead = await readReceipt(input.receiptDir, input.installationPath);
  const receipt = receiptRead.presence === "valid" ? receiptRead.receipt : undefined;

  const otherArtifacts: OtherInstallationArtifact[] = [];
  const generationsDir = path.join(input.installationPath, GENERATIONS_LEAF);
  if ((await exists(generationsDir)) && (await readdir(generationsDir)).length > 0) {
    otherArtifacts.push("generation-root");
  }
  if (await exists(path.join(input.installationPath, JOURNAL_LEAF))) {
    otherArtifacts.push("update-journal");
  }
  if (await exists(activePointerPathFor(input.installationPath))) {
    otherArtifacts.push("active-pointer");
  }
  if (await exists(path.join(input.installationPath, POINTERS_LEAF, "rollback.json"))) {
    otherArtifacts.push("rollback-pointer");
  }

  return {
    presence: { trustStore, receipt: receiptRead.presence, otherArtifacts },
    ...(state === undefined ? {} : { state }),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

/** Copies the verified packed composition into a read-only addressable root. */
async function materializeRoot(packedDir: string, root: string): Promise<void> {
  const parent = path.dirname(root);
  await mkdir(parent, { recursive: true, mode: OWNER_DIR });
  const staging = `${root}.staging-${randomBytes(6).toString("hex")}`;
  const files = await walkFiles(packedDir, "raw");
  const directories = new Set<string>([staging]);
  for (const relative of files.includes(COMPOSITION_MANIFEST_FILE) ? files : [...files, COMPOSITION_MANIFEST_FILE]) {
    const source = path.join(packedDir, ...relative.split("/"));
    const target = path.join(staging, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    let cursor = path.dirname(target);
    while (cursor.length >= staging.length && !directories.has(cursor)) {
      directories.add(cursor);
      cursor = path.dirname(cursor);
    }
    await writeFile(target, await readFile(source));
    await chmod(target, READONLY_FILE);
  }
  // Deepest first, so the chmod itself still has a writable parent chain.
  const ordered = [...directories].sort((a, b) => b.length - a.length);
  for (const directory of ordered) {
    if (directory === staging) continue;
    await chmod(directory, READONLY_DIR);
  }
  await rename(staging, root);
  await chmod(root, READONLY_DIR);
}

export async function installComposition(input: InstallCompositionInput): Promise<InstallCompositionResult> {
  const trust = input.trust ?? localDigestTrustPredicate;

  const closure = await verifyGenerationClosure(input.packedDir);
  if (!closure.ok) return closure;
  const generationDigest = closure.generationDigest;
  const manifestProfile = closure.manifest["compositionProfile"] as CompositionProfile;
  const compositionSequence = closure.manifest["compositionSequence"] as number;

  const observed = await observePresence(input);
  const discrimination = discriminateInstall(observed.presence);
  if (discrimination.kind === "fail_closed") {
    return fail(discrimination.code, discrimination.message);
  }

  let installationId: string;
  let state: ProductTrustState;
  const firstInstall = discrimination.kind === "first_install";
  if (firstInstall) {
    // The genuinely-first install: mint the registering-installation
    // identity and initialize the store — the ONLY path that may create
    // epoch zero.
    installationId = `install-${randomBytes(16).toString("hex")}`;
    state = {
      spec: "product-trust-state/1",
      installationId,
      pinnedManifestDigest: generationDigest,
      revokedGenerationDigests: [],
      revocationEpoch: 0,
      highWaterMark: compositionSequence,
    };
  } else {
    const adopted = observed.state as ProductTrustState;
    const receipt = observed.receipt as InstallReceipt;
    installationId = adopted.installationId;

    if (receipt.installationProfile !== manifestProfile) {
      return fail(
        "composition_profile_mismatch",
        `the manifest declares the ${manifestProfile} profile but this installation's receipt records ${receipt.installationProfile}; the confirmation-fixture profile is valid only in disposable-repository qualification runs and is production-rejected`,
      );
    }
    const downgrade = checkNoDowngrade(compositionSequence, adopted.highWaterMark);
    if (!downgrade.ok) return fail(downgrade.code, downgrade.message);

    // The activation-site trust check: the pin is being set to this
    // generation, so the predicate evaluates against the prospective pin —
    // revocation still wins, and a revoked generation can never activate.
    const decision = trust.evaluate(generationDigest, { ...adopted, pinnedManifestDigest: generationDigest });
    if (!decision.eligible) {
      return fail(
        "generation_revoked",
        `generation ${generationDigest} is not execution-eligible under current local trust state (${decision.reason})`,
      );
    }

    state = {
      ...adopted,
      pinnedManifestDigest: generationDigest,
      highWaterMark: Math.max(adopted.highWaterMark, compositionSequence),
    };
  }

  const root = generationRootFor(input.installationPath, generationDigest);
  if (!(await exists(root))) {
    await materializeRoot(input.packedDir, root);
  }

  await writeOwnerFile(trustStorePathFor(input.installationPath), JSON.stringify(state));
  await writeOwnerFile(
    activePointerPathFor(input.installationPath),
    JSON.stringify({ spec: ACTIVE_POINTER_SPEC, generationDigest }),
  );
  if (firstInstall) {
    const receipt: InstallReceipt = {
      spec: INSTALL_RECEIPT_SPEC,
      installationPath: input.installationPath,
      installationId,
      installationProfile: manifestProfile,
    };
    await writeOwnerFile(receiptPathFor(input.receiptDir, input.installationPath), JSON.stringify(receipt));
  }

  return { ok: true, installationId, generationDigest, firstInstall, root };
}

// ── The M0-era check sites ─────────────────────────────────────────────────

export interface TrustCheckInput {
  readonly installationPath: string;
  readonly generationDigest: string;
  readonly trust?: ProductTrustPort;
}

export type MutationLaneResult = { readonly ok: true } | SubstrateFailure;

/**
 * The mutation-lane trust predicate: current local trust state, resolved
 * only from the installation store, evaluated through the ProductTrustPort.
 * Absent or corrupt trust state blocks; a revoked or unpinned generation
 * blocks. Later units call THIS at the check sites they introduce.
 */
export async function checkMutationLane(input: TrustCheckInput): Promise<MutationLaneResult> {
  const loaded = await loadTrustState(input.installationPath);
  if (!loaded.ok) return loaded;
  const trust = input.trust ?? localDigestTrustPredicate;
  const decision = trust.evaluate(input.generationDigest, loaded.state);
  if (!decision.eligible) {
    return decision.reason === "revoked"
      ? fail(
          "generation_revoked",
          `generation ${input.generationDigest} is revoked; revoked bytes remain retained for audit but are never execution-eligible`,
        )
      : fail(
          "generation_not_pinned",
          `generation ${input.generationDigest} is not the operator-pinned manifest digest`,
        );
  }
  return { ok: true };
}

export type LoadPinnedGenerationResult =
  | { readonly ok: true; readonly root: string; readonly manifest: Record<string, unknown> }
  | SubstrateFailure;

/**
 * The pinned-root load the walking skeleton uses to pin and reload one exact
 * generation. Never consults the repository-global active pointer: the root
 * is addressed by digest, so pointer changes cannot alter what a pinned
 * delivery loads. Missing, empty, tampered, or trust-ineligible roots block.
 */
export async function loadPinnedGeneration(input: TrustCheckInput): Promise<LoadPinnedGenerationResult> {
  const loaded = await loadTrustState(input.installationPath);
  if (!loaded.ok) return loaded;

  const root = generationRootFor(input.installationPath, input.generationDigest);
  const closure = await verifyGenerationClosure(root, input.generationDigest);
  if (!closure.ok) return closure;

  const lane = await checkMutationLane(input);
  if (!lane.ok) return lane;

  return { ok: true, root, manifest: closure.manifest };
}

export type ResolveActiveGenerationResult =
  | { readonly ok: true; readonly generationDigest: string }
  | SubstrateFailure;

/** The default generation for NEW intake only; pinned deliveries never read it. */
export async function resolveActiveGeneration(installationPath: string): Promise<ResolveActiveGenerationResult> {
  const pointerPath = activePointerPathFor(installationPath);
  let bytes: string;
  try {
    bytes = await readFile(pointerPath, "utf8");
  } catch {
    return fail("active_pointer_missing", `no active pointer at ${pointerPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return fail("active_pointer_corrupt", "the active pointer is not JSON");
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  const digest = record?.["generationDigest"];
  if (record?.["spec"] !== ACTIVE_POINTER_SPEC || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    return fail("active_pointer_corrupt", "the active pointer is outside its grammar");
  }
  return { ok: true, generationDigest: digest };
}

export interface RegistrationBindingInput {
  readonly installationPath: string;
  readonly receiptDir: string;
}

export type RegistrationBindingResult =
  | {
      readonly ok: true;
      readonly registeringInstallationId: string;
      readonly activeCompositionProfile: CompositionProfile;
    }
  | SubstrateFailure;

/**
 * The registration members `delivery.registered` populates: the identity
 * minted at genuinely-first install and the receipt-recorded profile. An
 * absent or corrupt receipt resolves no identity and no profile — it fails
 * closed instead of defaulting to production.
 */
export async function registrationBinding(input: RegistrationBindingInput): Promise<RegistrationBindingResult> {
  const receiptRead = await readReceipt(input.receiptDir, input.installationPath);
  if (receiptRead.presence === "absent") {
    return fail(
      "install_receipt_absent",
      "no install receipt for this installation path; registration resolves no identity or profile",
    );
  }
  if (receiptRead.presence === "corrupt") {
    return fail("install_receipt_corrupt", receiptRead.message);
  }
  return {
    ok: true,
    registeringInstallationId: receiptRead.receipt.installationId,
    activeCompositionProfile: receiptRead.receipt.installationProfile,
  };
}
