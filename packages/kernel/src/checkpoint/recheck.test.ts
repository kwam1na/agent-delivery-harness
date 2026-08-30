/**
 * The canonical-recheck helper: ONE implementation point evaluating the
 * frozen rechecked-value list — product trust, the repository
 * authority-revocation epoch, the invocation fence, the registering
 * installation identity and active profile, and the projection and
 * discovery-configuration digests — with the consumption substitutions the
 * State and Authority Model defines (takeover, rebinding migration,
 * generation-axis migration). Every future consumption site routes through
 * this helper rather than re-deriving the list.
 *
 * Written RED before `recheck.ts` existed.
 */
import { describe, expect, it } from "vitest";
import {
  RECHECKED_VALUES,
  evaluateCanonicalRecheck,
  type RecheckValues,
} from "./recheck.ts";

const compare = (expected: string | number, observed: string | number) =>
  ({ kind: "compare", expected, observed }) as const;

const allCurrent = (): RecheckValues => ({
  "product-trust": { kind: "eligible", ok: true },
  "repository-authority-epoch": compare(4, 4),
  "invocation-fence": compare(2, 2),
  "registering-installation-id": compare("install-1", "install-1"),
  "active-profile": compare("core", "core"),
  "projection-digest": compare("p".repeat(8), "p".repeat(8)),
  "discovery-configuration-digest": compare("d".repeat(8), "d".repeat(8)),
});

const failuresOf = (outcome: ReturnType<typeof evaluateCanonicalRecheck>) =>
  outcome.ok ? [] : outcome.failures.map((failure) => `${failure.value}:${failure.code}`);

describe("the frozen rechecked-value list", () => {
  it("is verbatim", () => {
    expect([...RECHECKED_VALUES]).toEqual([
      "product-trust",
      "repository-authority-epoch",
      "invocation-fence",
      "registering-installation-id",
      "active-profile",
      "projection-digest",
      "discovery-configuration-digest",
    ]);
  });
});

describe("the standard recheck", () => {
  it("passes when every value holds and skips only values recorded absent-by-state", () => {
    expect(evaluateCanonicalRecheck({ consumption: { kind: "standard" }, values: allCurrent() })).toEqual({ ok: true });
    // Pre-workspace sites legitimately record workspace-scoped values absent.
    const preWorkspace: RecheckValues = {
      ...allCurrent(),
      "invocation-fence": "absent-by-state",
      "projection-digest": "absent-by-state",
      "discovery-configuration-digest": "absent-by-state",
    };
    expect(evaluateCanonicalRecheck({ consumption: { kind: "standard" }, values: preWorkspace })).toEqual({ ok: true });
  });

  it("fails a changed value with the value named", () => {
    const outcome = evaluateCanonicalRecheck({
      consumption: { kind: "standard" },
      values: { ...allCurrent(), "invocation-fence": compare(2, 1) },
    });
    expect(failuresOf(outcome)).toEqual(["invocation-fence:value_mismatch"]);
  });

  it("fails ineligible product trust as trust_ineligible", () => {
    const outcome = evaluateCanonicalRecheck({
      consumption: { kind: "standard" },
      values: { ...allCurrent(), "product-trust": { kind: "eligible", ok: false, detail: "generation revoked" } },
    });
    expect(failuresOf(outcome)).toEqual(["product-trust:trust_ineligible"]);
  });

  it("fails closed when a rechecked value is missing entirely — the list is closed and complete", () => {
    const values = allCurrent() as Record<string, unknown>;
    delete values["active-profile"];
    const outcome = evaluateCanonicalRecheck({ consumption: { kind: "standard" }, values: values as RecheckValues });
    expect(failuresOf(outcome)).toEqual(["active-profile:recheck_incomplete"]);
  });
});

describe("the takeover-consumption substitution", () => {
  const takeover = () =>
    ({
      kind: "takeover",
      supersededFence: compare(2, 2),
      expectedJournalRevision: compare(9, 9),
      targetBaseCommit: compare("c".repeat(40), "c".repeat(40)),
    }) as const;

  const substitutedValues = (): RecheckValues => ({
    ...allCurrent(),
    "invocation-fence": "absent-by-state",
    "projection-digest": "absent-by-state",
    "discovery-configuration-digest": "absent-by-state",
  });

  it("rechecks the superseded fence, expected journal revision, and target base commit in place of the current fence and prior projection digests", () => {
    expect(evaluateCanonicalRecheck({ consumption: takeover(), values: substitutedValues() })).toEqual({ ok: true });
  });

  it("rejects consumption on any substituted-value mismatch", () => {
    const stale = { ...takeover(), expectedJournalRevision: compare(9, 11) };
    const outcome = evaluateCanonicalRecheck({ consumption: stale, values: substitutedValues() });
    expect(failuresOf(outcome)).toEqual(["expected-journal-revision:value_mismatch"]);
  });

  it("refuses a real value where the substitution replaced it — the substitution is not optional", () => {
    const outcome = evaluateCanonicalRecheck({
      consumption: takeover(),
      values: { ...substitutedValues(), "invocation-fence": compare(2, 2) },
    });
    expect(failuresOf(outcome)).toEqual(["invocation-fence:substitution_violation"]);
  });

  it("still evaluates the unsubstituted values — a revoked generation fails takeover too", () => {
    const outcome = evaluateCanonicalRecheck({
      consumption: takeover(),
      values: { ...substitutedValues(), "product-trust": { kind: "eligible", ok: false } },
    });
    expect(failuresOf(outcome)).toEqual(["product-trust:trust_ineligible"]);
  });
});

describe("the rebinding-migration substitution", () => {
  const rebinding = () =>
    ({
      kind: "rebinding-migration",
      targetInstallationId: compare("install-2", "install-2"),
      recordedProfile: compare("core", "core"),
    }) as const;

  const substitutedValues = (): RecheckValues => ({
    ...allCurrent(),
    "registering-installation-id": "absent-by-state",
    "active-profile": "absent-by-state",
    "invocation-fence": "absent-by-state",
    "projection-digest": "absent-by-state",
    "discovery-configuration-digest": "absent-by-state",
  });

  it("rechecks the target installation identity and the recorded profile in place of the recorded registering installation", () => {
    expect(evaluateCanonicalRecheck({ consumption: rebinding(), values: substitutedValues() })).toEqual({ ok: true });
  });

  it("refuses a rebinding whose target installation's profile differs from the delivery's recorded profile", () => {
    const outcome = evaluateCanonicalRecheck({
      consumption: { ...rebinding(), recordedProfile: compare("core", "confirmation-fixture") },
      values: substitutedValues(),
    });
    expect(failuresOf(outcome)).toEqual(["recorded-profile:value_mismatch"]);
  });
});

describe("the generation-migration substitution", () => {
  const migration = () =>
    ({
      kind: "generation-migration",
      targetGenerationTrust: { kind: "eligible", ok: true },
    }) as const;

  const substitutedValues = (): RecheckValues => ({
    ...allCurrent(),
    "product-trust": "absent-by-state",
    "invocation-fence": "absent-by-state",
    "projection-digest": "absent-by-state",
    "discovery-configuration-digest": "absent-by-state",
  });

  it("evaluates product trust against the assertion's bound target generation in place of the recorded pin", () => {
    expect(evaluateCanonicalRecheck({ consumption: migration(), values: substitutedValues() })).toEqual({ ok: true });
  });

  it("refuses a migration onto a revoked target generation", () => {
    const outcome = evaluateCanonicalRecheck({
      consumption: { kind: "generation-migration", targetGenerationTrust: { kind: "eligible", ok: false } },
      values: substitutedValues(),
    });
    expect(failuresOf(outcome)).toEqual(["target-generation-trust:trust_ineligible"]);
  });

  it("refuses a recorded-pin trust value where the substitution replaced it", () => {
    const outcome = evaluateCanonicalRecheck({
      consumption: migration(),
      values: { ...substitutedValues(), "product-trust": { kind: "eligible", ok: true } },
    });
    expect(failuresOf(outcome)).toEqual(["product-trust:substitution_violation"]);
  });
});
