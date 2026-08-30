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
} from "./compile.ts";
import {
  mergeAdapterFixture,
  mergeAuthorityDocumentFixture,
  policyDocumentFixture,
  repositoryAdapterSetFixture,
  sensorAdapterFixture,
  trackerAdapterFixture,
} from "./fixtures.ts";

const compile = (document: unknown, adapters: readonly Record<string, unknown>[] = repositoryAdapterSetFixture()) =>
  compileRepositoryPolicy({
    document,
    adapters,
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
const REFERENCE_COMPILED_DIGEST = "708cd87e3b26e1cf48b1c27e614d65b67046247fdd88dbd4640ed5d026c5dc4e";

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
              { lensId: "lens.outcome-correctness", category: "outcome-correctness" },
              { lensId: "lens.outcome-correctness", category: "testing-policy" },
            ],
          }),
        ),
    },
    {
      name: "mandatory review lens category missing — the review floor is not lowered",
      code: "mandatory_lens_missing",
      run: () => compile(policyDocumentFixture({ reviewLenses: [{ lensId: "lens.outcome-correctness", category: "outcome-correctness" }] })),
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
