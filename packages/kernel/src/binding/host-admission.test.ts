/**
 * Unit edges of the model-external admission decisions. The scenario battery
 * lives in the frozen qualification fixtures and runs from
 * `scripts/check-host-admission-capabilities.test.ts`; this suite pins the
 * local decision edges those fixtures do not enumerate: fail-closed caller
 * input, expiry boundary semantics, denial totality, and path scoping edges.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import {
  evaluateConfirmationEcho,
  evaluateHostAdmission,
  evaluateToolInvocation,
  type CheckpointAdmissionExpectation,
} from "./host-admission.ts";

const grant = {
  spec: "execution-grant/1",
  profile: "checkpoint",
  allowedCapabilities: ["fs.write"],
  writablePaths: ["src"],
  protectedPaths: [".git"],
  forbiddenOperations: [],
};

const sha = (label: string): string => digestCanonical({ label });

const expectation: CheckpointAdmissionExpectation = {
  profile: "checkpoint",
  hostVersion: "unit-host/1",
  productTrustRevocationEpoch: 1,
  observedAt: "2026-08-30T12:00:00Z",
  deliveryId: "dlv-unit",
  invocationFence: 2,
  workspaceId: "ws-unit",
  projectionDigest: sha("projection"),
  discoveryConfigurationDigest: sha("discovery"),
  registeringInstallationId: "install-unit",
  activeProfile: "default",
};

const attestation = {
  spec: "grant-attestation/1",
  profile: "checkpoint",
  hostVersion: "unit-host/1",
  grantDigest: digestCanonical(grant),
  productTrustRevocationEpoch: 1,
  expiry: "2026-08-30T12:01:00Z",
  intakeDraftId: "absent-by-state",
  deliveryId: "dlv-unit",
  invocationFence: 2,
  workspaceId: "ws-unit",
  projectionDigest: sha("projection"),
  discoveryConfigurationDigest: sha("discovery"),
  registeringInstallationId: "install-unit",
  activeProfile: "default",
};

describe("evaluateHostAdmission edges", () => {
  it("admits the aligned pair", () => {
    expect(evaluateHostAdmission(expectation, grant, attestation).admitted).toBe(true);
  });

  it("fails closed on a malformed caller expectation", () => {
    const bad = { ...expectation, observedAt: "yesterday-ish" };
    const decision = evaluateHostAdmission(bad, grant, attestation);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) expect(decision.denials[0]?.code).toBe("malformed_expectation");
  });

  it("treats expiry equal to the observation instant as expired", () => {
    const decision = evaluateHostAdmission(expectation, grant, { ...attestation, expiry: expectation.observedAt });
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) expect(decision.denials.map((d) => d.code)).toContain("attestation_expired");
  });

  it("reports every mismatch, not the first one", () => {
    const drifted = { ...attestation, invocationFence: 1, workspaceId: "ws-other", projectionDigest: sha("tampered") };
    const decision = evaluateHostAdmission(expectation, grant, drifted);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      const codes = decision.denials.map((d) => d.code);
      expect(codes).toContain("fence_mismatch");
      expect(codes).toContain("workspace_mismatch");
      expect(codes).toContain("projection_digest_mismatch");
    }
  });
});

describe("evaluateToolInvocation path scoping", () => {
  const decide = (writes: readonly string[]) =>
    evaluateToolInvocation(expectation, grant, attestation, { capability: "fs.write", writes });

  it("a prefix sibling is outside the grant", () => {
    const decision = decide(["srcx/file.ts"]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.denials[0]?.code).toBe("write_outside_grant");
  });

  it("the writable root itself is inside the grant", () => {
    expect(decide(["src"]).allowed).toBe(true);
  });

  it("absolute, dot-segment, empty-segment, backslash, NUL, and drive-letter paths fail closed as unnormalized", () => {
    for (const write of ["/etc/passwd", "src/./x.ts", "src//x.ts", "", "src/..\\..\\.git/config", "src\\x.ts", "C:/anything", "src/a\0b"]) {
      const decision = decide([write]);
      expect(decision.allowed, JSON.stringify(write)).toBe(false);
      if (!decision.allowed) expect(decision.denials[0]?.code).toBe("unnormalized_path");
    }
  });

  it("a case alias of a protected path is denied, while the writable side stays byte-exact", () => {
    const aliased = decide([".GIT/hooks/pre-commit"]);
    expect(aliased.allowed).toBe(false);
    if (!aliased.allowed) expect(aliased.denials[0]?.code).toBe("protected_path");
    // Case variance never widens the allow side: 'SRC' is not 'src'.
    const caseWritable = decide(["SRC/x.ts"]);
    expect(caseWritable.allowed).toBe(false);
    if (!caseWritable.allowed) expect(caseWritable.denials[0]?.code).toBe("write_outside_grant");
  });

  it("enforces a protected path declared in one Unicode normalization form against a write naming the other", () => {
    // HFS+ stores a decomposed form and APFS preserves whatever it is given,
    // so one file has two spellings whose BYTES differ. Case folding does not
    // merge them: "caf\u00e9" !== "cafe\u0301" even lowercased. The protected path
    // here sits INSIDE the writable root, which is what makes the miss a
    // permit rather than a different refusal: the other spelling passes the
    // protected check, lands inside `src`, and is ALLOWED — while the OS
    // opens the very file the policy set out to protect.
    const composed = "src/caf\u00e9-secrets";
    const decomposed = "src/cafe\u0301-secrets";
    expect(composed).not.toBe(decomposed);
    expect(composed.toLowerCase()).not.toBe(decomposed.toLowerCase());

    // One step past that pair, where case and normalization differ TOGETHER.
    // `U+01F0` has no precomposed uppercase form, so the uppercase spelling of
    // this one file is necessarily decomposed, and a fold that lowercases
    // without normalizing FIRST lets the two spellings diverge again — the
    // same permit, one case-mapping away. Note what this pair does NOT pin:
    // it merges under every single-step mutant of the fold as written, so it
    // speaks only against the pre-delivery `toLowerCase`-only baseline. The
    // `U+0345` pair below pins the fold's INNER normalize and the `U+00CC`
    // pair its trailing one.
    const lowerPrecomposed = "src/\u01f0-secrets";
    const upperDecomposed = "src/J\u030c-secrets";
    expect(lowerPrecomposed.normalize("NFC").toLowerCase()).not.toBe(upperDecomposed.normalize("NFC").toLowerCase());

    // And one step past NORMALIZATION altogether: `U+017F` is already
    // lowercase and has no decomposition, so neither the normalize nor the
    // lowercase touches it — while a case-insensitive volume folds it to "s"
    // and opens the same file.
    const longS = "src/\u017fecrets";
    const plainS = "src/secrets";
    expect(longS.normalize("NFC").toLowerCase()).not.toBe(plainS.normalize("NFC").toLowerCase());

    // A pair where case mapping DENORMALIZES ITS OWN INPUT, which is the
    // reason the fold normalizes after case-mapping at all: lowercasing
    // `U+03AA` (capital iota with dialytika) and recomposing yields the
    // precomposed `U+0390`, while lowercasing `U+0390` itself leaves a
    // DECOMPOSED sequence behind. What this pair pins is the ALIAS, not one
    // step of the fold — the leading lowercase merges it too. The `U+00CC`
    // pair below is the one that kills the trailing normalize.
    const composedTonos = "src/\u0390-secrets";
    const decomposedTonos = "src/\u03aa\u0301-secrets";
    expect(composedTonos.normalize("NFC").toLowerCase()).not.toBe(decomposedTonos.normalize("NFC").toLowerCase());

    // The INNER normalize, which neither of the others can stand in for.
    // Case mapping does not canonically REORDER, and `U+0345` (combining
    // ypogegrammeni, class 240) sorts after the class-230 marks — so two
    // spellings that NFC makes identical are case-mapped to DIFFERENT code
    // points before the trailing normalize ever runs, and it has nothing left
    // to recompose them from.
    const reordered = "src/a\u0345\u0300-secrets";
    const canonical = "src/\u00e0\u0345-secrets";
    expect(reordered.normalize("NFC")).toBe(canonical.normalize("NFC"));
    expect(reordered).not.toBe(canonical);
    // ...and the pin itself: everything the fold does EXCEPT the inner
    // normalize still leaves these two apart.
    const withoutInner = (value: string): string =>
      value.toLowerCase().toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
    expect(withoutInner(reordered)).not.toBe(withoutInner(canonical));

    // And the TRAILING normalize. Once the fold lowercases first, no
    // canonically-equivalent pair survives to the end denormalized — what the
    // last normalize still buys is that the folded value is CANONICAL, so the
    // comparison key for one path is one string. `U+0131` (dotless i) maps to
    // `i` through the round-trip, and `U+0131 U+0300` therefore folds to a
    // DECOMPOSED `i` + grave that the trailing normalize composes into
    // `U+00EC` — the same key the protected path `U+00CC` folds to. Drop it
    // and these two spellings compare apart, re-opening the permit; the fold
    // also stops being idempotent.
    const dotless = "src/\u0131\u0300-secrets";
    const precomposedGrave = "src/\u00cc-secrets";
    const withoutTrailing = (value: string): string =>
      value.toLowerCase().normalize("NFC").toLowerCase().toUpperCase().toLowerCase();
    expect(withoutTrailing(dotless)).not.toBe(withoutTrailing(precomposedGrave));

    for (const [declared, written] of [
      [composed, `${decomposed}/key.pem`],
      [decomposed, `${composed}/key.pem`],
      [lowerPrecomposed, `${upperDecomposed}/key.pem`],
      [upperDecomposed, `${lowerPrecomposed}/key.pem`],
      [longS, `${plainS}/key.pem`],
      [plainS, `${longS}/key.pem`],
      // The fold routes through toUpperCase and BACK, and these two rows are
      // what keeps the round-trip from being silently shortened: an
      // uppercase-only fold passes every row above while splitting
      // "\u00df" from "\u1e9e", re-opening the same permit one letter over.
      ["src/\u00df-secrets", "src/\u1e9e-secrets/key.pem"],
      // ...and the false DENY the round-trip buys, which the comment claims
      // and nothing pinned: "\u00df" and "ss" compare as one path.
      ["src/\u00df-secrets", "src/ss-secrets/key.pem"],
      // The case-mapping-denormalizes-its-own-input alias, both directions.
      [composedTonos, `${decomposedTonos}/key.pem`],
      [decomposedTonos, `${composedTonos}/key.pem`],
      // ...and the rest of the class the fold's header names: `toLowerCase`
      // alone leaves these apart too, and only the round-trip merges them, so
      // a fold that special-cased the two members pinned above would pass
      // every row while re-opening the permit for 26 more pairs.
      ["src/\u00b5-secrets", "src/\u03bc-secrets/key.pem"],
      ["src/\u03c2-secrets", "src/\u03c3-secrets/key.pem"],
      // A denial the PRE-DELIVERY `toLowerCase` ALREADY made, and the class
      // the fold must not lose: NFC composition is CASE-SENSITIVE, so
      // `U+1FB3 U+0342` composes while the uppercase spelling of the same
      // file, `U+1FBC U+0342`, has no precomposed form and stays decomposed.
      // A fold that normalized before lowercasing splits these two and turns
      // a denial the old code made into a PERMIT — the one direction this
      // delivery must never move. Three classes behave this way.
      ["src/\u1fbc\u0342-secrets", "src/\u1fb3\u0342-secrets/key.pem"],
      ["src/\u1fb3\u0342-secrets", "src/\u1fbc\u0342-secrets/key.pem"],
      // The inner normalize, both directions.
      [reordered, `${canonical}/key.pem`],
      [canonical, `${reordered}/key.pem`],
      // The trailing normalize, both directions.
      [precomposedGrave, `${dotless}/key.pem`],
      [dotless, `${precomposedGrave}/key.pem`],
    ] as const) {
      const scopedGrant = { ...grant, protectedPaths: [declared] };
      const scoped = { ...attestation, grantDigest: digestCanonical(scopedGrant) };
      const decision = evaluateToolInvocation(expectation, scopedGrant, scoped, {
        capability: "fs.write",
        writes: [written],
      });
      expect(decision.allowed, `${JSON.stringify(declared)} vs ${JSON.stringify(written)}`).toBe(false);
      if (!decision.allowed) {
        expect(decision.denials[0]?.code).toBe("protected_path");
        // Comparison-only: the refusal quotes the path AS WRITTEN. Nothing
        // downstream of this check sees a normalized spelling, so no stored,
        // recorded, or digested path changes representation.
        expect(decision.denials[0]?.message).toContain(written);
      }
    }

    // THE CLASS THE FOLD CLAIMS, ENUMERATED RATHER THAN SAMPLED. Every code
    // point whose `toLowerCase` is not fixed by its own upper round-trip is
    // two spellings of one file on a case-insensitive volume. Rows naming
    // individual members are satisfied by a fold that special-cases exactly
    // those members — that mutation survived a two-member table and a
    // four-member one — so the whole class is driven through the real
    // decision here.
    let classMembers = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      const lowered = ch.toLowerCase();
      const rounded = lowered.toUpperCase().toLowerCase();
      if (rounded === lowered) continue;
      classMembers += 1;
      const declared = `src/${ch}-secrets`;
      const memberGrant = { ...grant, protectedPaths: [declared] };
      const memberAttestation = { ...attestation, grantDigest: digestCanonical(memberGrant) };
      const decision = evaluateToolInvocation(expectation, memberGrant, memberAttestation, {
        capability: "fs.write",
        writes: [`src/${rounded}-secrets/key.pem`],
      });
      expect(decision.allowed, `U+${cp.toString(16).toUpperCase()}`).toBe(false);
      if (!decision.allowed) expect(decision.denials[0]?.code).toBe("protected_path");
    }
    // ...and the loop is not vacuously satisfied by a `continue` that always
    // fires. A lower bound rather than an exact count: the class size is an
    // ICU property, and pinning it exactly would make this row break on a
    // Node upgrade instead of on a defect.
    expect(classMembers).toBeGreaterThan(100);

    // The deny side did not widen into a match-everything: a sibling inside
    // the same writable root, protected under neither spelling, is allowed.
    const scopedGrant = { ...grant, protectedPaths: [composed] };
    const scoped = { ...attestation, grantDigest: digestCanonical(scopedGrant) };
    expect(
      evaluateToolInvocation(expectation, scopedGrant, scoped, {
        capability: "fs.write",
        writes: ["src/cafe\u0301-elsewhere/x.ts"],
      }).allowed,
    ).toBe(true);
  });

  it("one bad path denies the whole invocation", () => {
    const decision = decide(["src/ok.ts", ".git/config"]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.denials.map((d) => d.code)).toContain("protected_path");
  });

  it("the confirmation exclusion covers the bare family name and case variants", () => {
    for (const capability of ["operator-confirmation", "Operator-Confirmation.takeover-authorization", "OPERATOR-CONFIRMATION.CONTRACT-CONFIRMATION"]) {
      const decision = evaluateToolInvocation(expectation, grant, attestation, { capability });
      expect(decision.allowed, capability).toBe(false);
      if (!decision.allowed) {
        expect(decision.denials.map((d) => d.code)).toContain("confirmation_operation_excluded");
      }
    }
  });
});

describe("evaluateConfirmationEcho totality", () => {
  it("a malformed rendered expiry fails closed as expired", () => {
    const decision = evaluateConfirmationEcho(
      { channelId: "ch-1", channelOpen: true, interactive: true, challenge: "c-1", consumed: false, expiry: "TBD" },
      { presentedChallenge: "c-1", presentedOnChannelId: "ch-1", observedAt: "2026-08-30T12:00:00Z", viaModelVisibleSurface: false, interactive: true },
    );
    expect(decision.completed).toBe(false);
    if (!decision.completed) expect(decision.denials.map((d) => d.code)).toEqual(["challenge_expired"]);
  });

  it("accumulates every failing condition", () => {
    const decision = evaluateConfirmationEcho(
      { channelId: "ch-1", channelOpen: false, interactive: true, challenge: "c-1", consumed: true, expiry: "2026-08-30T12:00:00Z" },
      { presentedChallenge: "c-2", presentedOnChannelId: "ch-2", observedAt: "2026-08-30T12:00:00Z", viaModelVisibleSurface: true, interactive: false },
    );
    expect(decision.completed).toBe(false);
    if (!decision.completed) {
      const codes = decision.denials.map((d) => d.code).sort();
      expect(codes).toEqual([
        "challenge_consumed",
        "challenge_expired",
        "challenge_mismatch",
        "channel_closed",
        "model_visible_surface_refused",
        "non_interactive_refused",
        "wrong_channel",
      ]);
    }
  });
});
