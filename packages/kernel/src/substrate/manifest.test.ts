/**
 * The minimum composition manifest: one deterministic document binding every
 * packed byte through the frozen composition pin, plus the profile
 * declaration the installer enforces.
 *
 * These tests were written RED, before `manifest.ts` existed, per the
 * test-first slice inside the unit's characterization-first posture.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical, sha256Hex } from "../digest.ts";
import { PINNED_AGENT_SKILLS, PRODUCT_TRUST_LABEL, validateCompositionPin } from "../spine/composition.ts";
import {
  COMPOSITION_MANIFEST_SPEC,
  COMPOSITION_PROFILES,
  CONFIRMATION_FIXTURE_PROFILE,
  SUPPORTED_CONTRACT_VERSIONS,
  buildCompositionManifest,
  compositionManifestBytes,
  validateCompositionManifest,
  type CompositionInventoryEntry,
} from "./manifest.ts";

const kernelEntry: CompositionInventoryEntry = {
  path: "harness/packages/kernel/package.json",
  sha256: "a".repeat(64),
};
const inventory: readonly CompositionInventoryEntry[] = [
  kernelEntry,
  { path: "skills/agent-skills-core-v1.zip", sha256: PINNED_AGENT_SKILLS.archiveSha256 },
];

const build = () =>
  buildCompositionManifest({
    compositionProfile: CONFIRMATION_FIXTURE_PROFILE,
    compositionSequence: 1,
    productVersion: "0.1.0",
    harnessModuleVersions: { "@agent-delivery-harness/kernel": "0.1.0" },
    inventory,
  });

const codesOf = (verdict: { ok: true } | { ok: false; rejections: readonly { code: string }[] }): string[] =>
  verdict.ok ? [] : verdict.rejections.map((rejection) => rejection.code);

describe("the minimum composition manifest", () => {
  it("accepts its golden form, embedding a valid frozen composition pin", () => {
    const manifest = build();
    expect(validateCompositionManifest(manifest)).toEqual({ ok: true });
    expect(validateCompositionPin(manifest["pin"])).toEqual({ ok: true });
  });

  it("carries the product-trust declaration verbatim, never re-worded", () => {
    const manifest = build();
    const pin = manifest["pin"] as Record<string, unknown>;
    expect(pin["productTrustLabel"]).toBe("local-digest / operator-pinned");
    expect(pin["productTrustLabel"]).toBe(PRODUCT_TRUST_LABEL);
    expect(pin["skillsArchive"]).toEqual({ ...PINNED_AGENT_SKILLS });
    expect(pin["contractVersions"]).toEqual({ ...SUPPORTED_CONTRACT_VERSIONS });
  });

  it("declares the confirmation-fixture profile as one of exactly two profiles", () => {
    expect([...COMPOSITION_PROFILES]).toEqual(["production", "confirmation-fixture"]);
    expect(build()["compositionProfile"]).toBe("confirmation-fixture");
    expect(codesOf(validateCompositionManifest({ ...build(), compositionProfile: "staging" }))).toContain(
      "malformed_member",
    );
  });

  it("is deterministic: the same inputs produce byte-identical manifests", () => {
    const first = compositionManifestBytes(build());
    const second = compositionManifestBytes(build());
    expect(second).toBe(first);
    expect(sha256Hex(second)).toBe(sha256Hex(first));
  });

  it("binds the inventory closure into the pin's distribution digest", () => {
    const manifest = build();
    const pin = manifest["pin"] as Record<string, unknown>;
    expect(pin["distributionDigest"]).toBe(digestCanonical(inventory));

    const tampered = {
      ...manifest,
      inventory: [...inventory, { path: "skills/extra.bin", sha256: "b".repeat(64) }],
    };
    expect(codesOf(validateCompositionManifest(tampered))).toContain("closure_digest_mismatch");
  });

  it("rejects an unsorted, duplicated, or unsafe inventory", () => {
    const manifest = build();
    const reversed = { ...manifest, inventory: [...inventory].reverse() };
    expect(codesOf(validateCompositionManifest(reversed))).toContain("malformed_member");

    const duplicated = { ...manifest, inventory: [kernelEntry, kernelEntry] };
    expect(codesOf(validateCompositionManifest(duplicated))).toContain("malformed_member");

    const escaping = { ...manifest, inventory: [{ path: "../outside", sha256: "a".repeat(64) }] };
    expect(codesOf(validateCompositionManifest(escaping))).toContain("malformed_member");

    const absolute = { ...manifest, inventory: [{ path: "/etc/passwd", sha256: "a".repeat(64) }] };
    expect(codesOf(validateCompositionManifest(absolute))).toContain("malformed_member");
  });

  it("rejects an empty inventory — a composition binds at least one byte", () => {
    const manifest = buildCompositionManifest({
      compositionProfile: "production",
      compositionSequence: 1,
      productVersion: "0.1.0",
      harnessModuleVersions: { "@agent-delivery-harness/kernel": "0.1.0" },
      inventory: [],
    });
    expect(codesOf(validateCompositionManifest(manifest))).toContain("malformed_member");
  });

  it("is a closed grammar: an unknown member rejects", () => {
    expect(codesOf(validateCompositionManifest({ ...build(), vendorExtension: true }))).toContain("unknown_member");
    expect(COMPOSITION_MANIFEST_SPEC).toBe("composition-manifest/1");
  });
});
