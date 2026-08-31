/**
 * The policy compiler's falsification corpus: portable defaults, repository
 * declarations, and repository adapters normalize into one digest-bound
 * compiled snapshot, or the delivery is rejected BEFORE any mutation with a
 * typed code. One row per invariant; a compiler that rejected everything
 * would fail the happy-path rows, and one that accepted everything would
 * fail the corpus.
 *
 * Also here: the trusted-base/candidate-tamper fixtures. The digest recorded
 * at bind time is what governs — a candidate that edits the policy document,
 * the adapters, or the compiled bytes produces something that no longer
 * matches the bound digest, and the mismatch is detected rather than adopted.
 *
 * Written RED before `compile.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import { validateExecutionGrant } from "../spine/grant.ts";
import { validatePolicySnapshot } from "../spine/policy.ts";
import { DISPOSABLE_STAGE_GRANT } from "./disposable.ts";
import {
  POLICY_COMPILE_CODES,
  PORTABLE_MODEL_DRIVEN_STAGES,
  PORTABLE_PRIVILEGED_CREDENTIALS,
  checkBoundPolicy,
  compileRepositoryPolicy,
  verifyCompiledPolicy,
  type AvailablePersona,
} from "./compile.ts";
import {
  compositionPersonaSetFixture,
  deployAdapterFixture,
  mergeAdapterFixture,
  mergeAuthorityDocumentFixture,
  policyDocumentFixture,
  repositoryAdapterSetFixture,
  sensorAdapterFixture,
  trackerAdapterFixture,
} from "./fixtures.ts";

const compile = (
  document: unknown,
  adapters: readonly Record<string, unknown>[] = repositoryAdapterSetFixture(),
  personas: readonly AvailablePersona[] = compositionPersonaSetFixture(),
) =>
  compileRepositoryPolicy({
    document,
    adapters,
    personas,
    productTrustRevocationEpoch: 0,
    repositoryAuthorityRevocationEpoch: 0,
  });

const codesOf = (result: ReturnType<typeof compile>): readonly string[] =>
  result.ok ? [] : result.rejections.map((rejection) => rejection.code);

const compiledFixture = () => {
  const result = compile(policyDocumentFixture());
  if (!result.ok) throw new Error(`fixture must compile: ${JSON.stringify(result.rejections)}`);
  return result.compiled;
};

describe("the compiled snapshot", () => {
  it("compiles the base document into a digest-bound snapshot the frozen spine validates", () => {
    const compiled = compiledFixture();
    expect(validatePolicySnapshot(compiled.snapshot).ok).toBe(true);
    const { compiledDigest, ...body } = compiled as unknown as Record<string, unknown>;
    expect(digestCanonical(body)).toBe(compiledDigest);
    expect(verifyCompiledPolicy(compiled).ok).toBe(true);
  });

  it("emits one checkpoint execution grant per portable model-driven stage, each spine-valid", () => {
    const compiled = compiledFixture();
    expect(compiled.checkpointGrants.map((entry) => entry.stageId)).toEqual([...PORTABLE_MODEL_DRIVEN_STAGES]);
    for (const entry of compiled.checkpointGrants) {
      expect(validateExecutionGrant(entry.grant).ok, entry.stageId).toBe(true);
      expect(entry.grant.profile).toBe("checkpoint");
    }
  });

  it("keeps the walking skeleton's stage grant as the portable default envelope — the module's port is unchanged", () => {
    const compiled = compiledFixture();
    const implement = compiled.checkpointGrants.find((entry) => entry.stageId === "implement");
    expect(implement?.grant).toEqual({ ...DISPOSABLE_STAGE_GRANT });
  });

  it("forbids the privileged external operations in every model-driven grant, even when a checkpoint override narrows tools — no shell/MCP bypass", () => {
    const result = compile(
      mergeAuthorityDocumentFixture({
        checkpoints: [
          {
            stageId: "implement",
            allowedCapabilities: ["Bash", "Read", "Edit"],
            writablePaths: ["src"],
            credentials: [],
            additionalProtectedPaths: [],
            additionalForbiddenOperations: [],
          },
        ],
      }),
      [sensorAdapterFixture(), mergeAdapterFixture()],
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    for (const entry of result.compiled.checkpointGrants) {
      for (const operation of ["git.push", "merge", "deploy"]) {
        expect(entry.grant.forbiddenOperations, `${entry.stageId} must forbid ${operation}`).toContain(operation);
      }
      expect(entry.grant.protectedPaths).toContain(".git");
      expect(entry.grant.protectedPaths).toContain(".managed-projection");
    }
  });

  it("compiles deterministically — the same layers produce the same digest", () => {
    expect(compiledFixture().compiledDigest).toBe(compiledFixture().compiledDigest);
  });

  it("pins the reference fixture's digest — deterministic across supported runtimes", () => {
    expect(compiledFixture().compiledDigest).toBe(REFERENCE_COMPILED_DIGEST);
  });
});

/** Filled from the first green run; the CI matrix (Node 22/24, Bun) re-derives it. */
const REFERENCE_COMPILED_DIGEST = "f456b46f2b869dfe58e3d16ef8a4e842470467a0efd8a241aa68bf8def977a81";

describe("the rejection corpus — every defect rejects before mutation", () => {
  const rows: readonly { readonly name: string; readonly code: string; readonly run: () => ReturnType<typeof compile> }[] = [
    {
      name: "unknown document member",
      code: "unknown_member",
      run: () => compile(policyDocumentFixture({ emergencyOverride: true })),
    },
    {
      name: "contradictory merge authority: granted and forbidden at once",
      code: "contradictory_authority",
      run: () =>
        compile(mergeAuthorityDocumentFixture({ forbiddenAuthority: ["merge"] }), [sensorAdapterFixture(), mergeAdapterFixture()]),
    },
    {
      name: "contradictory deploy authority: granted and forbidden at once",
      code: "contradictory_authority",
      run: () =>
        compile(
          mergeAuthorityDocumentFixture({ grantedAuthority: ["merge", "deploy"], forbiddenAuthority: ["deploy"] }),
          [sensorAdapterFixture(), mergeAdapterFixture(), deployAdapterFixture()],
        ),
    },
    {
      name: "contradictory finish line: merge finish line without merge authority",
      code: "contradictory_finish_line",
      run: () => compile(policyDocumentFixture({ grantedFinishLines: ["merge-ready", "merge"] })),
    },
    {
      name: "contradictory finish line: deploy finish line without deploy authority",
      code: "contradictory_finish_line",
      run: () => compile(policyDocumentFixture({ grantedFinishLines: ["merge-ready", "deploy"] })),
    },
    {
      name: "duplicate obligation",
      code: "duplicate_obligation",
      run: () => compile(policyDocumentFixture({ obligations: [{ obligationId: "review.green" }, { obligationId: "review.green" }] })),
    },
    {
      name: "duplicate review lens",
      code: "duplicate_review_lens",
      run: () =>
        compile(
          policyDocumentFixture({
            reviewLenses: [
              { lensId: "lens.outcome-correctness", category: "outcome-correctness", personaId: "persona.outcome-correctness" },
              { lensId: "lens.outcome-correctness", category: "testing-policy", personaId: "persona.testing-policy" },
            ],
          }),
        ),
    },
    {
      name: "mandatory review lens category missing — the review floor is not lowered",
      code: "mandatory_lens_missing",
      run: () =>
        compile(
          policyDocumentFixture({
            reviewLenses: [{ lensId: "lens.outcome-correctness", category: "outcome-correctness", personaId: "persona.outcome-correctness" }],
          }),
        ),
    },
    {
      name: "lens naming a reviewer charter nothing resolves — rejected at compilation, not at first review",
      code: "persona_unresolvable",
      run: () =>
        compile(
          policyDocumentFixture({
            reviewLenses: [
              { lensId: "lens.outcome-correctness", category: "outcome-correctness", personaId: "persona.absent" },
              { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
            ],
          }),
        ),
    },
    {
      name: "missing required sensor capability",
      code: "capability_unavailable",
      run: () => compile(policyDocumentFixture(), []),
    },
    {
      name: "required capability version mismatch",
      code: "capability_version_mismatch",
      run: () => compile(policyDocumentFixture({ requiredCapabilities: [{ capabilityId: "sensor.acceptance", kind: "sensor", version: "2" }] })),
    },
    {
      name: "required capability bound to an adapter of another kind",
      code: "capability_contract_mismatch",
      run: () => compile(policyDocumentFixture({ requiredCapabilities: [{ capabilityId: "sensor.acceptance", kind: "tracker", version: "1" }] })),
    },
    {
      name: "prose-only authority: merge granted with no executable merge adapter",
      code: "prose_only_authority",
      run: () => compile(mergeAuthorityDocumentFixture()),
    },
    {
      name: "privileged credential in a model-driven checkpoint grant",
      code: "privileged_credential_in_model_grant",
      run: () =>
        compile(
          policyDocumentFixture({
            checkpoints: [
              {
                stageId: "implement",
                allowedCapabilities: ["Read", "Edit"],
                writablePaths: ["src"],
                credentials: [PORTABLE_PRIVILEGED_CREDENTIALS[0]],
                additionalProtectedPaths: [],
                additionalForbiddenOperations: [],
              },
            ],
          }),
        ),
    },
    {
      name: "adapter-declared privileged credential in a model-driven grant — the exclusion is not a naming convention",
      code: "privileged_credential_in_model_grant",
      run: () =>
        compile(
          mergeAuthorityDocumentFixture({
            checkpoints: [
              {
                stageId: "implement",
                allowedCapabilities: ["Read", "Edit"],
                writablePaths: ["src"],
                credentials: ["gh.merge-token"],
                additionalProtectedPaths: [],
                additionalForbiddenOperations: [],
              },
            ],
          }),
          [sensorAdapterFixture(), { ...mergeAdapterFixture(), credentialId: "gh.merge-token" }],
        ),
    },
    {
      name: "duplicate checkpoint envelope for one stage",
      code: "duplicate_checkpoint",
      run: () => {
        const envelope = {
          stageId: "implement",
          allowedCapabilities: ["Read"],
          writablePaths: ["src"],
          credentials: [],
          additionalProtectedPaths: [],
          additionalForbiddenOperations: [],
        };
        return compile(policyDocumentFixture({ checkpoints: [envelope, { ...envelope, writablePaths: ["docs"] }] }));
      },
    },
    {
      name: "tracker declared blocking and absent",
      code: "tracker_unavailable",
      run: () => compile(policyDocumentFixture({ trackerAbsenceFallback: "block" })),
    },
    {
      name: "malformed adapter descriptor in the set",
      code: "unknown_member",
      run: () => compile(policyDocumentFixture(), [{ ...sensorAdapterFixture(), authorityGranted: ["merge"] }]),
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const result = row.run();
      expect(result.ok).toBe(false);
      expect(codesOf(result), row.name).toContain(row.code);
    });
  }

  it("produces every declared compile code somewhere in this suite's corpus", () => {
    const produced = new Set(rows.map((row) => row.code));
    // Codes exercised outside the table: admission projection incoherence in
    // its own suite, and the authority family in authority.test.ts.
    produced.add("admission_obligation_unactivated");
    for (const code of POLICY_COMPILE_CODES) {
      if (code === "policy_tamper") continue; // proven below, not in the table
      expect(produced.has(code), `${code} is never produced by a corpus row`).toBe(true);
    }
  });
});

describe("the reviewer charter a lens hands its reviewer", () => {
  const adopterPersona = { personaId: "persona.house-style", digest: "c".repeat(64), origin: "adopter" as const };

  const adopterLensDocument = (digest: string) =>
    policyDocumentFixture({
      reviewLenses: [
        {
          lensId: "lens.outcome-correctness",
          category: "outcome-correctness",
          personaId: adopterPersona.personaId,
          personaDigest: digest,
        },
        { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
      ],
    });

  it("binds each lens's charter digest into the compiled snapshot, so the delivery judges against bytes rather than a label", () => {
    const compiled = compiledFixture();
    expect(compiled.snapshot.reviewLenses).toEqual([
      {
        lensId: "lens.outcome-correctness",
        category: "outcome-correctness",
        personaId: "persona.outcome-correctness",
        personaDigest: "a".repeat(64),
      },
      {
        lensId: "lens.testing-policy",
        category: "testing-policy",
        personaId: "persona.testing-policy",
        personaDigest: "b".repeat(64),
      },
    ]);
  });

  it("advances the shipped charter set without any edit to the repository's document", () => {
    const document = policyDocumentFixture();
    const advanced = compile(document, repositoryAdapterSetFixture(), [
      { personaId: "persona.outcome-correctness", digest: "d".repeat(64), origin: "composition" },
      { personaId: "persona.testing-policy", digest: "e".repeat(64), origin: "composition" },
    ]);
    expect(advanced.ok, JSON.stringify(advanced)).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.compiled.snapshot.reviewLenses[0]?.personaDigest).toBe("d".repeat(64));
    expect(advanced.compiled.compiledDigest).not.toBe(compiledFixture().compiledDigest);
  });

  it("resolves a repository-owned charter from the digest the document pins", () => {
    const result = compile(adopterLensDocument(adopterPersona.digest), repositoryAdapterSetFixture(), [
      ...compositionPersonaSetFixture(),
      adopterPersona,
    ]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.snapshot.reviewLenses[0]?.personaDigest).toBe(adopterPersona.digest);
  });

  it("rejects a lens naming a charter absent from the composition and from the repository's protected path", () => {
    const document = policyDocumentFixture({
      reviewLenses: [
        { lensId: "lens.outcome-correctness", category: "outcome-correctness", personaId: "persona.invented" },
        { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
      ],
    });
    expect(codesOf(compile(document))).toContain("persona_unresolvable");
  });

  it("rejects a repository-owned reference whose pinned digest matches no available charter", () => {
    const result = compile(adopterLensDocument("f".repeat(64)), repositoryAdapterSetFixture(), [
      ...compositionPersonaSetFixture(),
      adopterPersona,
    ]);
    expect(codesOf(result)).toContain("persona_unresolvable");
  });

  it("keeps a repository file from intercepting a shipped identity — identity alone resolves only in the composition", () => {
    const shadowed = compile(policyDocumentFixture(), repositoryAdapterSetFixture(), [
      ...compositionPersonaSetFixture(),
      { personaId: "persona.outcome-correctness", digest: "9".repeat(64), origin: "adopter" },
    ]);
    expect(shadowed.ok, JSON.stringify(shadowed)).toBe(true);
    if (!shadowed.ok) return;
    expect(shadowed.compiled.snapshot.reviewLenses[0]?.personaDigest).toBe("a".repeat(64));
  });

  it("selects the repository's same-identity charter only where the owner-approved document names its digest", () => {
    const document = policyDocumentFixture({
      reviewLenses: [
        {
          lensId: "lens.outcome-correctness",
          category: "outcome-correctness",
          personaId: "persona.outcome-correctness",
          personaDigest: "9".repeat(64),
        },
        { lensId: "lens.testing-policy", category: "testing-policy", personaId: "persona.testing-policy" },
      ],
    });
    const result = compile(document, repositoryAdapterSetFixture(), [
      ...compositionPersonaSetFixture(),
      { personaId: "persona.outcome-correctness", digest: "9".repeat(64), origin: "adopter" },
    ]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.snapshot.reviewLenses[0]?.personaDigest).toBe("9".repeat(64));
  });

  it("refuses a compiled policy whose bound charter digest was swapped — the trusted pre-run copy governs", () => {
    const bound = compiledFixture();
    const swapped = compile(policyDocumentFixture(), repositoryAdapterSetFixture(), [
      { personaId: "persona.outcome-correctness", digest: "1".repeat(64), origin: "composition" },
      { personaId: "persona.testing-policy", digest: "b".repeat(64), origin: "composition" },
    ]);
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;
    const verdict = checkBoundPolicy(bound.compiledDigest, swapped.compiled);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejections.map((rejection) => rejection.code)).toContain("policy_tamper");
  });
});

describe("tracker absence with a declared fallback", () => {
  it("compiles with the declared fallback rather than inventing a tracker or blocking", () => {
    const absent = compiledFixture();
    expect(absent.tracker).toBe("absent");
    expect(absent.trackerAbsenceFallback).toBe("proceed-without-tracker");
  });

  it("binds the tracker capability when the adapter set provides it", () => {
    const result = compile(policyDocumentFixture(), [sensorAdapterFixture(), trackerAdapterFixture()]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.compiled.tracker).toBe("available");
  });
});

describe("trusted pre-run copy governs — candidate tamper is detected, never adopted", () => {
  it("accepts the exact bound bytes", () => {
    const bound = compiledFixture();
    expect(checkBoundPolicy(bound.compiledDigest, bound).ok).toBe(true);
  });

  it("refuses a candidate-recompiled policy whose document was edited — the edit is a proposal for a future delivery", () => {
    const bound = compiledFixture();
    const recompiled = compile(mergeAuthorityDocumentFixture(), [sensorAdapterFixture(), mergeAdapterFixture()]);
    expect(recompiled.ok).toBe(true);
    if (!recompiled.ok) return;
    const verdict = checkBoundPolicy(bound.compiledDigest, recompiled.compiled);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejections.map((rejection) => rejection.code)).toContain("policy_tamper");
  });

  it("refuses compiled bytes mutated in place — the digest no longer recomputes", () => {
    const bound = compiledFixture();
    const widened = {
      ...bound,
      snapshot: { ...bound.snapshot, grantedAuthority: ["merge"] },
    };
    const verdict = checkBoundPolicy(bound.compiledDigest, widened);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejections.map((rejection) => rejection.code)).toContain("digest_mismatch");
  });
});
