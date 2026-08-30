/**
 * THE CANONICAL RECHECK, one implementation point.
 *
 * The State and Authority Model freezes the rechecked-value list — product
 * trust, the repository authority-revocation epoch, the invocation fence, the
 * registering installation identity and active profile, and the projection
 * and discovery-configuration digests — and the consumption substitutions
 * that replace parts of it:
 *
 *   - takeover consumption rechecks the superseded fence, expected journal
 *     revision, and target base commit IN PLACE OF the current fence and the
 *     prior worktree's projection and discovery-configuration digests;
 *   - rebinding-migration consumption rechecks the current installation's
 *     identity and active profile against the assertion's bound target
 *     installation and the delivery's recorded profile, IN PLACE OF the
 *     recorded registering-installation identity (which that consumption
 *     replaces);
 *   - generation-migration consumption evaluates product trust against the
 *     assertion's bound target generation IN PLACE OF the delivery's recorded
 *     generation pin, with fence and the prior worktree's digests
 *     absent-by-state.
 *
 * The helper is pure: callers gather observations, the helper decides. It
 * fails closed twice over — a missing value is `recheck_incomplete`, and a
 * REAL value supplied where a substitution replaced it is a
 * `substitution_violation`, so no consumption site can quietly recheck the
 * wrong axis. Values recorded absent-by-state are not rechecked, exactly as
 * the model says.
 */

export const RECHECKED_VALUES = Object.freeze([
  "product-trust",
  "repository-authority-epoch",
  "invocation-fence",
  "registering-installation-id",
  "active-profile",
  "projection-digest",
  "discovery-configuration-digest",
] as const);
export type RecheckedValue = (typeof RECHECKED_VALUES)[number];

/** A comparison between a durable binding and the currently observed value. */
export interface CompareCheck {
  readonly kind: "compare";
  readonly expected: string | number;
  readonly observed: string | number;
}

/** An eligibility verdict the caller already evaluated (product trust). */
export interface EligibleCheck {
  readonly kind: "eligible";
  readonly ok: boolean;
  readonly detail?: string;
}

export type ValueCheck = "absent-by-state" | CompareCheck | EligibleCheck;

export type RecheckValues = Readonly<Record<RecheckedValue, ValueCheck>>;

export type RecheckConsumption =
  | { readonly kind: "standard" }
  | {
      readonly kind: "takeover";
      readonly supersededFence: CompareCheck;
      readonly expectedJournalRevision: CompareCheck;
      readonly targetBaseCommit: CompareCheck;
    }
  | {
      readonly kind: "rebinding-migration";
      readonly targetInstallationId: CompareCheck;
      readonly recordedProfile: CompareCheck;
    }
  | {
      readonly kind: "generation-migration";
      readonly targetGenerationTrust: EligibleCheck;
    };

/** The values each substitution replaces; a real value there fails closed. */
const SUBSTITUTED: Readonly<Record<RecheckConsumption["kind"], readonly RecheckedValue[]>> = Object.freeze({
  standard: [],
  takeover: ["invocation-fence", "projection-digest", "discovery-configuration-digest"],
  "rebinding-migration": [
    "registering-installation-id",
    "active-profile",
    "invocation-fence",
    "projection-digest",
    "discovery-configuration-digest",
  ],
  "generation-migration": ["product-trust", "invocation-fence", "projection-digest", "discovery-configuration-digest"],
});

export type RecheckFailureCode = "recheck_incomplete" | "substitution_violation" | "value_mismatch" | "trust_ineligible";

export interface RecheckFailure {
  readonly value: string;
  readonly code: RecheckFailureCode;
  readonly message: string;
}

export type RecheckResult = { readonly ok: true } | { readonly ok: false; readonly failures: readonly RecheckFailure[] };

const evaluateCheck = (value: string, check: CompareCheck | EligibleCheck, failures: RecheckFailure[]): void => {
  if (check.kind === "eligible") {
    if (!check.ok) {
      failures.push({
        value,
        code: "trust_ineligible",
        message: check.detail ?? `${value} is not execution-eligible under current local trust state`,
      });
    }
    return;
  }
  if (check.expected !== check.observed) {
    failures.push({
      value,
      code: "value_mismatch",
      message: `${value} changed: bound ${String(check.expected)}, observed ${String(check.observed)}`,
    });
  }
};

export function evaluateCanonicalRecheck(input: {
  readonly consumption: RecheckConsumption;
  readonly values: RecheckValues;
}): RecheckResult {
  const failures: RecheckFailure[] = [];
  const substituted = SUBSTITUTED[input.consumption.kind];

  for (const value of RECHECKED_VALUES) {
    const check = (input.values as Record<string, ValueCheck | undefined>)[value];
    if (check === undefined) {
      failures.push({
        value,
        code: "recheck_incomplete",
        message: `the canonical recheck evaluates every frozen value; ${value} was not supplied`,
      });
      continue;
    }
    if (substituted.includes(value)) {
      if (check !== "absent-by-state") {
        failures.push({
          value,
          code: "substitution_violation",
          message: `${input.consumption.kind} consumption replaces ${value}; a real value here rechecks the wrong axis`,
        });
      }
      continue;
    }
    if (check === "absent-by-state") continue; // recorded absent-by-state: not rechecked
    evaluateCheck(value, check, failures);
  }

  switch (input.consumption.kind) {
    case "takeover":
      evaluateCheck("superseded-fence", input.consumption.supersededFence, failures);
      evaluateCheck("expected-journal-revision", input.consumption.expectedJournalRevision, failures);
      evaluateCheck("target-base-commit", input.consumption.targetBaseCommit, failures);
      break;
    case "rebinding-migration":
      evaluateCheck("target-installation-id", input.consumption.targetInstallationId, failures);
      evaluateCheck("recorded-profile", input.consumption.recordedProfile, failures);
      break;
    case "generation-migration":
      evaluateCheck("target-generation-trust", input.consumption.targetGenerationTrust, failures);
      break;
    default:
      break;
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
