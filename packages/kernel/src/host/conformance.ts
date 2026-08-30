/**
 * THE HOST-INTEGRATION CONFORMANCE CONTRACT.
 *
 * Host-specific delegation is deliberately non-normative: how a host applies a
 * grant, scopes discovery, sequences tools, or delegates to its own subagents
 * is its own business and this contract says nothing about it. What IS
 * normative is the set of normalized outcomes below. A future host qualifies
 * by producing them, not by resembling any host that already does.
 *
 * The contract is stated as scenario discriminators rather than mechanisms.
 * The runner hands a port a host-neutral scenario ("a stale-fence
 * attestation"); the port maps it onto whatever its own admission surface
 * calls that, and returns a normalized outcome. Nothing in this module knows
 * about settings files, hooks, sandboxes, worktrees, or approval protocols.
 *
 * Two properties are load-bearing and easy to lose:
 *
 *   - DENIAL IS THE DEFAULT. Every negative case asserts a denial, so a host
 *     that fails open on any of them is caught here rather than in production.
 *   - THE RESUME POSITION IS DERIVED, NOT DECLARED. A host reports its graded
 *     descendant-teardown status; claiming a resume position richer than that
 *     status supports is a conformance failure, which is what keeps an
 *     unverified host out of same-workspace resume.
 */

export const HOST_ADMISSION_SCENARIOS = Object.freeze([
  /** The attestation bound to the port's current expectation. */
  "current",
  /** No attestation has been applied yet. */
  "before-attestation",
  /** An attestation minted under a superseded invocation fence. */
  "stale-fence",
  /** An attestation minted for a different delivery. */
  "sibling-delivery",
] as const);
export type HostAdmissionScenario = (typeof HOST_ADMISSION_SCENARIOS)[number];

export const HOST_INTERCEPTION_SCENARIOS = Object.freeze([
  /** A capability the attested grant lists, writing inside its writable paths. */
  "granted-capability",
  /** A capability outside the attested grant. */
  "ungranted-capability",
  /** A write to a protected authority path. */
  "protected-path-write",
  /** An operator-confirmation operation attempted from inside the grant. */
  "operator-confirmation",
] as const);
export type HostInterceptionScenario = (typeof HOST_INTERCEPTION_SCENARIOS)[number];

export interface NormalizedAdmission {
  readonly outcome: "admitted" | "denied";
  /** Denial codes, for diagnosis only — the contract asserts the outcome. */
  readonly codes?: readonly string[];
}

export interface NormalizedInterception {
  readonly outcome: "allowed" | "denied";
  readonly codes?: readonly string[];
}

export interface NormalizedTermination {
  readonly provenance: "graceful";
  readonly descendantTeardown: "verified" | "unverified";
  readonly resumeEligibility: "same-workspace" | "fresh-worktree-only";
}

export interface NormalizedTeardown {
  readonly outcome: "torn-down" | "failed";
  /** Paths the binding wrote that still exist after teardown; must be empty. */
  readonly residue: readonly string[];
}

/**
 * The operations a host integration must expose to qualify. Every one is
 * model-external by construction: a port implementation is the trusted
 * binding's surface, never a tool the session can call.
 */
export interface HostIntegrationPort {
  readonly hostId: string;
  readonly hostVersion: string;
  admit(scenario: HostAdmissionScenario): Promise<NormalizedAdmission>;
  intercept(scenario: HostInterceptionScenario): Promise<NormalizedInterception>;
  terminate(): Promise<NormalizedTermination>;
  tearDown(): Promise<NormalizedTeardown>;
}

export interface HostConformanceCase {
  readonly caseId: string;
  readonly statement: string;
}

/** The frozen case list; adding or dropping one is a contract change. */
export const HOST_CONFORMANCE_CASES: readonly HostConformanceCase[] = Object.freeze([
  Object.freeze({
    caseId: "admits-the-currently-attested-grant",
    statement: "an attestation bound to the current expectation admits the invocation",
  }),
  Object.freeze({
    caseId: "denies-every-tool-before-attestation",
    statement: "no tool executes before the grant is applied and attested",
  }),
  Object.freeze({
    caseId: "denies-a-stale-fence-attestation",
    statement: "an attestation from a superseded fence opens nothing",
  }),
  Object.freeze({
    caseId: "denies-a-sibling-delivery-attestation",
    statement: "an attestation bound to another delivery opens nothing",
  }),
  Object.freeze({
    caseId: "allows-a-granted-capability",
    statement:
      "a capability the attested grant lists, writing inside its writable paths, is allowed — without this the contract would be satisfied by a host that denies everything",
  }),
  Object.freeze({
    caseId: "denies-a-capability-outside-the-grant",
    statement: "a capability the attested grant does not list is denied",
  }),
  Object.freeze({
    caseId: "denies-a-write-to-a-protected-authority-path",
    statement: "a write under a protected authority path is denied",
  }),
  Object.freeze({
    caseId: "denies-an-operator-confirmation-inside-the-grant",
    statement: "operator confirmations are excluded from every grant and served only by the binding's own channel",
  }),
  Object.freeze({
    caseId: "records-only-the-graded-resume-position",
    statement: "the reported resume position never exceeds what the graded descendant teardown supports",
  }),
  Object.freeze({
    caseId: "tears-the-binding-written-set-down",
    statement: "teardown leaves no binding-written projection or discovery-configuration residue",
  }),
]);

export interface HostConformanceResult {
  readonly caseId: string;
  readonly satisfied: boolean;
  readonly detail: string;
}

const result = (caseId: string, satisfied: boolean, detail: string): HostConformanceResult => ({
  caseId,
  satisfied,
  detail,
});

/**
 * Runs the frozen contract against one port and returns a normalized result
 * per case. It never throws on a non-conforming host: a thrown error is itself
 * a conformance failure, reported as one.
 */
export async function runHostIntegrationConformance(
  port: HostIntegrationPort,
): Promise<readonly HostConformanceResult[]> {
  const results: HostConformanceResult[] = [];

  const admission = async (
    caseId: string,
    scenario: HostAdmissionScenario,
    expected: NormalizedAdmission["outcome"],
  ): Promise<void> => {
    try {
      const observed = await port.admit(scenario);
      results.push(
        result(
          caseId,
          observed.outcome === expected,
          `${scenario}: expected ${expected}, observed ${observed.outcome}${
            observed.codes === undefined ? "" : ` (${observed.codes.join(", ")})`
          }`,
        ),
      );
    } catch (error) {
      results.push(result(caseId, false, `admit(${scenario}) threw: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  const interception = async (
    caseId: string,
    scenario: HostInterceptionScenario,
    expected: NormalizedInterception["outcome"],
  ): Promise<void> => {
    try {
      const observed = await port.intercept(scenario);
      results.push(
        result(
          caseId,
          observed.outcome === expected,
          `${scenario}: expected ${expected}, observed ${observed.outcome}${
            observed.codes === undefined ? "" : ` (${observed.codes.join(", ")})`
          }`,
        ),
      );
    } catch (error) {
      results.push(
        result(caseId, false, `intercept(${scenario}) threw: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  };

  await admission("admits-the-currently-attested-grant", "current", "admitted");
  await admission("denies-every-tool-before-attestation", "before-attestation", "denied");
  await admission("denies-a-stale-fence-attestation", "stale-fence", "denied");
  await admission("denies-a-sibling-delivery-attestation", "sibling-delivery", "denied");
  await interception("allows-a-granted-capability", "granted-capability", "allowed");
  await interception("denies-a-capability-outside-the-grant", "ungranted-capability", "denied");
  await interception("denies-a-write-to-a-protected-authority-path", "protected-path-write", "denied");
  await interception("denies-an-operator-confirmation-inside-the-grant", "operator-confirmation", "denied");

  try {
    const termination = await port.terminate();
    // The derivation, restated as a contract assertion: only verified
    // descendant teardown supports same-workspace resume, and crash provenance
    // is not expressible at all.
    const honest =
      termination.provenance === "graceful" &&
      (termination.descendantTeardown === "verified" || termination.resumeEligibility === "fresh-worktree-only");
    results.push(
      result(
        "records-only-the-graded-resume-position",
        honest,
        `teardown ${termination.descendantTeardown} reported ${termination.resumeEligibility}`,
      ),
    );
  } catch (error) {
    results.push(
      result(
        "records-only-the-graded-resume-position",
        false,
        `terminate() threw: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  try {
    const torn = await port.tearDown();
    results.push(
      result(
        "tears-the-binding-written-set-down",
        torn.outcome === "torn-down" && torn.residue.length === 0,
        torn.residue.length === 0 ? torn.outcome : `residue: ${torn.residue.join(", ")}`,
      ),
    );
  } catch (error) {
    results.push(
      result(
        "tears-the-binding-written-set-down",
        false,
        `tearDown() threw: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  return results;
}
