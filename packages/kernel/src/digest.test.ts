/**
 * Digest helpers: SHA-256 over canonical JSON, and the spec's manifestDigest.
 *
 * Written before `digest.ts` existed (V26-1331, test-first per the U2
 * execution note).
 *
 * The load-bearing property is spec 6:
 *
 *     manifestDigest = lowerhex(sha256(JCS(manifest with attestation.signatures := [])))
 *
 * — invariant under any change to `attestation.signatures`, variant under
 * everything else. A property of that shape is worthless unless it can fail,
 * so the suite carries its own falsification: a digest variant that *includes*
 * the signatures, asserted to differ exactly where the real function agrees.
 */
import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalize } from "./canonical.ts";
import {
  DigestError,
  assertSha256Hex,
  digestCanonical,
  digestsEqual,
  isSha256Hex,
  manifestDigest,
  sha256Hex,
} from "./digest.ts";

const LOWER_HEX_SHA256 = /^[0-9a-f]{64}$/;

// ── Fixture ────────────────────────────────────────────────────────────────

const CLAIM = {
  obligation: "review.green",
  payloadSpec: "review.green/1",
  payload: { outcome: "green" },
};

/** A delivery-evidence/1-shaped manifest, level `self`, no signatures. */
const MANIFEST = {
  spec: "delivery-evidence/1",
  provider: { id: "claude-code.ce-code-review", runId: "run-0001" },
  candidate: {
    vcs: "git",
    treeSha: "a".repeat(40),
    deliverable: { digest: "b".repeat(64), identity: "deliverable-tree/v1" },
    base: { ref: "origin/main", tipSha: "c".repeat(40), mergeBaseSha: "d".repeat(40) },
    workspaceId: "w-0123456789abcdef",
  },
  runHistory: [{ pass: 1, treeSha: "a".repeat(40) }],
  attestation: { level: "self", signatures: [] },
  recordedAt: "2026-08-25T09:00:00Z",
  claims: [CLAIM],
};

/** The same manifest with the optional `runHistory` member removed. */
const { runHistory: _withoutRunHistory, ...withoutRunHistory } = MANIFEST;

/** The same manifest with a countersignature attached. */
const COUNTERSIGNED = {
  ...MANIFEST,
  attestation: {
    level: "self",
    signatures: [{ alg: "ed25519", keyId: "k1", value: "c2lnbmF0dXJl" }],
  },
};

/** The same manifest with no `signatures` member at all. */
const NO_SIGNATURES_MEMBER = { ...MANIFEST, attestation: { level: "self" } };

/**
 * FALSIFICATION CONTROL. The digest the spec deliberately does *not* define:
 * canonical bytes of the manifest exactly as given, signatures included. Every
 * invariance assertion below is paired with an assertion that this variant
 * disagrees — otherwise "invariant under signature changes" could be passing
 * because nothing distinguishes the fixtures at all.
 */
const digestIncludingSignatures = (manifest: unknown): string => sha256Hex(canonicalize(manifest));

// ── sha256Hex ──────────────────────────────────────────────────────────────

describe("sha256Hex", () => {
  it("matches the published SHA-256 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes a string as its UTF-8 bytes", () => {
    expect(sha256Hex("€")).toBe(sha256Hex(new TextEncoder().encode("€")));
  });

  it("emits lowercase hex, always 64 characters", () => {
    for (const sample of ["", "abc", "€", "0", "the quick brown fox"]) {
      const digest = sha256Hex(sample);
      expect(digest).toMatch(LOWER_HEX_SHA256);
      expect(digest).toBe(digest.toLowerCase());
    }
  });
});

// ── digestCanonical ────────────────────────────────────────────────────────

describe("digestCanonical", () => {
  it("digests the canonical bytes, not the caller's spelling", () => {
    expect(digestCanonical({ a: 1, b: 2 })).toBe(digestCanonical({ b: 2, a: 1 }));
    expect(digestCanonical({ a: 1, b: 2 })).toBe(sha256Hex('{"a":1,"b":2}'));
  });

  it("distinguishes values that differ", () => {
    expect(digestCanonical({ a: 1 })).not.toBe(digestCanonical({ a: 2 }));
    expect(digestCanonical({ a: 1 })).not.toBe(digestCanonical({ a: "1" }));
    expect(digestCanonical([])).not.toBe(digestCanonical({}));
  });

  it("propagates the canonicalizer's typed error for non-representable input", () => {
    expect(() => digestCanonical({ a: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => digestCanonical(undefined)).toThrow(CanonicalizationError);
  });
});

// ── manifestDigest ─────────────────────────────────────────────────────────

describe("manifestDigest", () => {
  it("is lowercase hex", () => {
    expect(manifestDigest(MANIFEST)).toMatch(LOWER_HEX_SHA256);
  });

  it("equals sha256 of the canonical form with signatures emptied", () => {
    const digestedForm = {
      ...MANIFEST,
      attestation: { ...MANIFEST.attestation, signatures: [] },
    };
    expect(manifestDigest(COUNTERSIGNED)).toBe(sha256Hex(canonicalize(digestedForm)));
  });

  it("is invariant under attestation.signatures changes", () => {
    const twoSignatures = {
      ...MANIFEST,
      attestation: {
        level: "self",
        signatures: [
          { alg: "ed25519", keyId: "k1", value: "c2lnbmF0dXJl" },
          { alg: "ed25519", keyId: "k2", value: "b3RoZXI=" },
        ],
      },
    };
    const baseline = manifestDigest(MANIFEST);
    expect(manifestDigest(COUNTERSIGNED)).toBe(baseline);
    expect(manifestDigest(twoSignatures)).toBe(baseline);
    expect(manifestDigest(NO_SIGNATURES_MEMBER)).toBe(baseline);
  });

  it("FALSIFICATION: including the signatures in the digested form breaks that invariance", () => {
    // If manifestDigest were implemented as this variant, the assertions in
    // the test above would fail. That is what makes them meaningful.
    expect(digestIncludingSignatures(COUNTERSIGNED)).not.toBe(digestIncludingSignatures(MANIFEST));
    expect(digestIncludingSignatures(NO_SIGNATURES_MEMBER)).not.toBe(
      digestIncludingSignatures(MANIFEST),
    );
    // And the real function ignores exactly what the variant reacts to.
    expect(manifestDigest(COUNTERSIGNED)).toBe(manifestDigest(MANIFEST));
    expect(manifestDigest(NO_SIGNATURES_MEMBER)).toBe(manifestDigest(MANIFEST));
  });

  it("changes under any other member change", () => {
    const baseline = manifestDigest(MANIFEST);
    const variants: ReadonlyArray<readonly [string, unknown]> = [
      ["attestation.level", { ...MANIFEST, attestation: { level: "provider-signed", signatures: [] } }],
      ["spec", { ...MANIFEST, spec: "delivery-evidence/2" }],
      ["provider.runId", { ...MANIFEST, provider: { ...MANIFEST.provider, runId: "run-0002" } }],
      [
        "candidate.treeSha",
        { ...MANIFEST, candidate: { ...MANIFEST.candidate, treeSha: "e".repeat(40) } },
      ],
      ["recordedAt", { ...MANIFEST, recordedAt: "2026-08-25T09:00:01Z" }],
      [
        "claims payload",
        { ...MANIFEST, claims: [{ ...CLAIM, payload: { outcome: "deferred" } }] },
      ],
      ["added member", { ...MANIFEST, extra: 1 }],
      ["removed member", withoutRunHistory],
    ];
    for (const [label, variant] of variants) {
      expect.soft(manifestDigest(variant), `${label} must change the digest`).not.toBe(baseline);
    }
  });

  it("is insensitive to member insertion order", () => {
    const reordered = {
      claims: MANIFEST.claims,
      recordedAt: MANIFEST.recordedAt,
      attestation: MANIFEST.attestation,
      runHistory: MANIFEST.runHistory,
      candidate: MANIFEST.candidate,
      provider: MANIFEST.provider,
      spec: MANIFEST.spec,
    };
    expect(manifestDigest(reordered)).toBe(manifestDigest(MANIFEST));
  });

  it("does not mutate the manifest it is given", () => {
    const signatures = [{ alg: "ed25519", keyId: "k1", value: "c2lnbmF0dXJl" }];
    const manifest = { ...MANIFEST, attestation: { level: "self", signatures } };
    manifestDigest(manifest);
    expect(manifest.attestation.signatures).toBe(signatures);
    expect(manifest.attestation.signatures).toHaveLength(1);
  });

  it("digests a manifest with no attestation member as-is, without inventing one", () => {
    const { attestation: _dropped, ...withoutAttestation } = MANIFEST;
    expect(manifestDigest(withoutAttestation)).toBe(sha256Hex(canonicalize(withoutAttestation)));
  });
});

// ── Lowercase-hex discipline ───────────────────────────────────────────────

describe("hex discipline", () => {
  /** Computed inside the tests so the suite still collects when it is red. */
  const pair = (): { lower: string; upper: string } => {
    const lower = sha256Hex("abc");
    return { lower, upper: lower.toUpperCase() };
  };

  it("recognises a lowercase sha256 digest and nothing else", () => {
    const { lower: LOWER, upper: UPPER } = pair();
    expect(isSha256Hex(LOWER)).toBe(true);
    expect(isSha256Hex(UPPER)).toBe(false);
    expect(isSha256Hex(LOWER.slice(0, 63))).toBe(false);
    expect(isSha256Hex(`${LOWER}0`)).toBe(false);
    expect(isSha256Hex("g".repeat(64))).toBe(false);
    expect(isSha256Hex("")).toBe(false);
    expect(isSha256Hex(undefined)).toBe(false);
    expect(isSha256Hex(123)).toBe(false);
  });

  it("rejects uppercase input rather than normalising it", () => {
    const { upper: UPPER } = pair();
    expect(() => assertSha256Hex(UPPER)).toThrow(DigestError);
    let thrown: unknown;
    try {
      assertSha256Hex(UPPER);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DigestError).code).toBe("not_sha256_hex");
    expect((thrown as Error).name).toBe("DigestError");
  });

  it("returns the digest unchanged when it is already well-formed", () => {
    const { lower: LOWER } = pair();
    expect(assertSha256Hex(LOWER)).toBe(LOWER);
  });

  it("compares digests without case folding", () => {
    const { lower: LOWER, upper: UPPER } = pair();
    expect(digestsEqual(LOWER, LOWER)).toBe(true);
    expect(digestsEqual(LOWER, sha256Hex("abcd"))).toBe(false);
    expect(() => digestsEqual(LOWER, UPPER)).toThrow(DigestError);
    expect(() => digestsEqual("not-a-digest", LOWER)).toThrow(DigestError);
  });
});
