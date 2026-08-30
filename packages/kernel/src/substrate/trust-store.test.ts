/**
 * The pure half of the installation-scoped trust store: parsing that fails
 * closed on corrupt bytes, the first-install discriminator over the full
 * installation-artifact set, and the no-downgrade decision against the
 * persisted high-water mark.
 *
 * These tests were written RED, before `trust-store.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { PRODUCT_TRUST_STATE_SPEC } from "../spine/composition.ts";
import {
  checkNoDowngrade,
  discriminateInstall,
  parseTrustState,
  type InstallationPresence,
} from "./trust-store.ts";

const DIGEST = "a".repeat(64);

const validStateText = (): string =>
  JSON.stringify({
    spec: PRODUCT_TRUST_STATE_SPEC,
    installationId: "install-1",
    pinnedManifestDigest: DIGEST,
    acceptedGenerationDigests: [DIGEST],
    revokedGenerationDigests: [],
    revocationEpoch: 0,
    highWaterMark: 1,
  });

describe("trust-state parsing", () => {
  it("accepts a valid document", () => {
    const parsed = parseTrustState(validStateText());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.state.installationId).toBe("install-1");
  });

  it("fails closed on non-JSON bytes", () => {
    const parsed = parseTrustState("not json {");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe("trust_state_corrupt");
  });

  it("fails closed on a document outside the frozen grammar", () => {
    const missingEpoch = JSON.parse(validStateText()) as Record<string, unknown>;
    delete missingEpoch["revocationEpoch"];
    const parsed = parseTrustState(JSON.stringify(missingEpoch));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe("trust_state_corrupt");
  });
});

describe("the first-install discriminator", () => {
  const presence = (overrides: Partial<InstallationPresence>): InstallationPresence => ({
    trustStore: "absent",
    receipt: "absent",
    otherArtifacts: [],
    ...overrides,
  });

  it("initializes epoch zero only on a genuinely first installation", () => {
    expect(discriminateInstall(presence({}))).toEqual({ kind: "first_install" });
  });

  it("adopts an existing installation when store and receipt are both valid", () => {
    expect(discriminateInstall(presence({ trustStore: "valid", receipt: "valid" }))).toEqual({ kind: "adopt" });
  });

  it("fails closed when the store is missing but any other artifact survives", () => {
    for (const artifact of ["generation-root", "update-journal", "active-pointer", "rollback-pointer"] as const) {
      const decision = discriminateInstall(presence({ otherArtifacts: [artifact] }));
      expect(decision.kind).toBe("fail_closed");
      if (decision.kind === "fail_closed") expect(decision.code).toBe("prior_installation_artifacts");
    }
  });

  it("fails closed when the store is missing but the receipt survives", () => {
    const decision = discriminateInstall(presence({ receipt: "valid" }));
    expect(decision.kind).toBe("fail_closed");
  });

  it("fails closed when the receipt is missing but the store survives", () => {
    const decision = discriminateInstall(presence({ trustStore: "valid" }));
    expect(decision.kind).toBe("fail_closed");
  });

  it("fails closed on an unreadable store or receipt, never re-initializing", () => {
    expect(discriminateInstall(presence({ trustStore: "corrupt", receipt: "valid" })).kind).toBe("fail_closed");
    expect(discriminateInstall(presence({ trustStore: "valid", receipt: "corrupt" })).kind).toBe("fail_closed");
    expect(discriminateInstall(presence({ trustStore: "corrupt" })).kind).toBe("fail_closed");
    expect(discriminateInstall(presence({ receipt: "corrupt" })).kind).toBe("fail_closed");
  });
});

describe("the no-downgrade high-water mark", () => {
  it("rejects a composition sequence below the persisted mark", () => {
    const decision = checkNoDowngrade(1, 2);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("downgrade_rejected");
  });

  it("accepts an equal or advancing sequence", () => {
    expect(checkNoDowngrade(2, 2)).toEqual({ ok: true });
    expect(checkNoDowngrade(3, 2)).toEqual({ ok: true });
  });
});
