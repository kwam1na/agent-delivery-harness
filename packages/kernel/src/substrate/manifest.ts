/**
 * The minimum composition manifest — the one deterministic document that
 * binds every byte of a packed local composition.
 *
 * The manifest NESTS the frozen composition pin (`product-composition-pin/1`)
 * verbatim rather than extending it: the pin's grammar is closed and frozen,
 * so the substrate's members (profile, sequence, inventory) live in this
 * document's own closed grammar around it. The pin carries the product-trust
 * declaration verbatim — `local-digest / operator-pinned` — and the exact
 * `agent-skills` release identities; this module consumes both frozen values
 * and never re-authors them.
 *
 * DETERMINISM AND CLOSURE. The manifest is serialized as RFC 8785 canonical
 * JSON, so the same inputs always produce byte-identical manifests, and the
 * generation digest is the SHA-256 of those bytes. The inventory lists every
 * packed file with its digest, strictly ordered; the pin's
 * `distributionDigest` is the canonical digest of that inventory, so a file
 * added, removed, or reordered changes the manifest, and a file whose bytes
 * drift stops matching its listed digest. Together that is the full digest
 * closure the trust predicate rechecks.
 *
 * PROFILES. Exactly two: `production` and `confirmation-fixture`. The
 * confirmation-fixture profile is valid only in disposable-repository
 * qualification runs and is production-rejected — the installer refuses any
 * manifest whose declared profile differs from the installation's
 * receipt-recorded profile, in either direction, so a fixture-profile
 * composition can never activate on a production installation.
 */
import { canonicalize, compareUtf16CodeUnits } from "../canonical.ts";
import { digestCanonical, sha256Hex } from "../digest.ts";
import {
  PINNED_AGENT_SKILLS,
  PRODUCT_COMPOSITION_PIN_SPEC,
  PRODUCT_TRUST_LABEL,
  validateCompositionPin,
} from "../spine/composition.ts";
import {
  checkClosed,
  createSpineCollector,
  isSpineRecord,
  nonNegativeInt,
  oneOf,
  sha256,
  specLiteral,
  text,
  type MemberRule,
  type SpineRejectionCode,
} from "../spine/grammar.ts";

export const COMPOSITION_MANIFEST_SPEC = "composition-manifest/1";

/** Exactly two profiles; the fixture profile is production-rejected. */
export const COMPOSITION_PROFILES = Object.freeze(["production", "confirmation-fixture"] as const);
export type CompositionProfile = (typeof COMPOSITION_PROFILES)[number];

/** Valid only in disposable-repository qualification runs. */
export const CONFIRMATION_FIXTURE_PROFILE: CompositionProfile = "confirmation-fixture";

/**
 * The supported contract-version families the pin binds, at the versions the
 * frozen spine ships today. `controlPlane` is deliberately `reserved/0`: the
 * control-plane port has no defined contract yet, and claiming one would
 * claim more than was verified.
 */
export const SUPPORTED_CONTRACT_VERSIONS = Object.freeze({
  policy: "policy-snapshot/1",
  scopedWork: "scoped-delivery-contract/1",
  run: "journal-entry/1",
  workflowResult: "stage-result-ref/1",
  event: "journal-entry/1",
  controlPlane: "reserved/0",
} as const);

export interface CompositionInventoryEntry {
  /** Normalized, '/'-separated path relative to the generation root. */
  readonly path: string;
  readonly sha256: string;
}

export interface BuildCompositionManifestInput {
  readonly compositionProfile: CompositionProfile;
  readonly compositionSequence: number;
  readonly productVersion: string;
  readonly harnessModuleVersions: Readonly<Record<string, string>>;
  readonly inventory: readonly CompositionInventoryEntry[];
}

/** The substrate's rejection vocabulary widens the spine's, never edits it. */
export type SubstrateRejectionCode = SpineRejectionCode | "closure_digest_mismatch";

export interface SubstrateRejection {
  readonly code: SubstrateRejectionCode;
  readonly pointer: string;
  readonly message: string;
}

export type SubstrateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejections: readonly SubstrateRejection[] };

const sortedInventory = (
  inventory: readonly CompositionInventoryEntry[],
): readonly CompositionInventoryEntry[] =>
  [...inventory]
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((a, b) => compareUtf16CodeUnits(a.path, b.path));

export function buildCompositionManifest(input: BuildCompositionManifestInput): Record<string, unknown> {
  const inventory = sortedInventory(input.inventory);
  return {
    spec: COMPOSITION_MANIFEST_SPEC,
    compositionProfile: input.compositionProfile,
    compositionSequence: input.compositionSequence,
    pin: {
      spec: PRODUCT_COMPOSITION_PIN_SPEC,
      productVersion: input.productVersion,
      distributionDigest: digestCanonical(inventory),
      harnessModuleVersions: { ...input.harnessModuleVersions },
      skillsArchive: { ...PINNED_AGENT_SKILLS },
      contractVersions: { ...SUPPORTED_CONTRACT_VERSIONS },
      productTrustLabel: PRODUCT_TRUST_LABEL,
    },
    inventory,
  };
}

/** The manifest's bytes are its canonical JSON — same inputs, same bytes. */
export function compositionManifestBytes(manifest: Record<string, unknown>): string {
  return canonicalize(manifest);
}

/** The generation digest: the SHA-256 of the manifest's canonical bytes. */
export function generationDigestOf(manifestBytes: string): string {
  return sha256Hex(manifestBytes);
}

/**
 * Fail-closed normalized-relative check, same posture as the binding's write
 * paths: '/'-separated, no absolute forms, no '..'/'.'/empty segments, no
 * backslashes, NULs, or drive-letter prefixes.
 */
const isNormalizedRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !/^[A-Za-z]:/.test(value) &&
  !value.split("/").some((segment) => segment === ".." || segment === "." || segment === "");

const inventoryMember: MemberRule["check"] = (value, at, collector) => {
  if (!Array.isArray(value)) {
    collector.emit("malformed_member", at, "expected an array of inventory entries");
    return;
  }
  if (value.length === 0) {
    collector.emit("malformed_member", at, "a composition binds at least one file");
    return;
  }
  let previousPath: string | undefined;
  value.forEach((entry, index) => {
    const entryAt = `${at}/${index}`;
    checkClosed(
      entry,
      entryAt,
      [
        { name: "path", check: text },
        { name: "sha256", check: sha256 },
      ],
      collector,
    );
    if (!isSpineRecord(entry) || typeof entry["path"] !== "string") return;
    const entryPath = entry["path"];
    if (!isNormalizedRelativePath(entryPath)) {
      collector.emit("malformed_member", `${entryAt}/path`, "expected a normalized '/'-separated relative path");
      return;
    }
    if (previousPath !== undefined && compareUtf16CodeUnits(previousPath, entryPath) >= 0) {
      collector.emit(
        "malformed_member",
        `${entryAt}/path`,
        "inventory paths must be strictly ascending — unordered or duplicated entries break determinism",
      );
    }
    previousPath = entryPath;
  });
};

const MANIFEST_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(COMPOSITION_MANIFEST_SPEC) },
  { name: "compositionProfile", check: oneOf(COMPOSITION_PROFILES) },
  { name: "compositionSequence", check: nonNegativeInt },
  {
    name: "pin",
    check: (value, at, collector) => {
      const verdict = validateCompositionPin(value);
      if (verdict.ok) return;
      for (const rejection of verdict.rejections) {
        collector.emit(rejection.code, `${at}${rejection.pointer}`, rejection.message);
      }
    },
  },
  { name: "inventory", check: inventoryMember },
];

export function validateCompositionManifest(value: unknown): SubstrateVerdict {
  const collector = createSpineCollector();
  checkClosed(value, "", MANIFEST_RULES, collector);
  const verdict = collector.verdict();
  const rejections: SubstrateRejection[] = verdict.ok ? [] : [...verdict.rejections];

  // The closure cross-rule: the pin's distribution digest must be the digest
  // of the inventory as written. Only checked once both members are shaped —
  // a malformed half already rejected above.
  if (isSpineRecord(value) && Array.isArray(value["inventory"]) && isSpineRecord(value["pin"])) {
    const declared = value["pin"]["distributionDigest"];
    if (typeof declared === "string" && rejections.length === 0) {
      let computed: string | undefined;
      try {
        computed = digestCanonical(value["inventory"]);
      } catch {
        computed = undefined;
      }
      if (computed !== declared) {
        rejections.push({
          code: "closure_digest_mismatch",
          pointer: "/pin/distributionDigest",
          message: "the pin's distribution digest does not bind the inventory as written",
        });
      }
    }
  }

  return rejections.length === 0 ? { ok: true } : { ok: false, rejections };
}
