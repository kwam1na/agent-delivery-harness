/**
 * The two figures behind `DEFAULT_OBSERVATION_LIFETIME_SECONDS`, as test
 * fixtures.
 *
 * They live here rather than in either suite that reads them because two suites
 * do read them — the rule's own unit suite and the walking-skeleton scenario
 * that drives the real facade — and a measurement copied into both is a
 * measurement that drifts. They are fixtures rather than product exports
 * because nothing in the product reads them: the product carries the derived
 * lifetime, and these are the observations the derivation started from.
 *
 * `docs/managed-delivery.md` carries both in full — what was run, under what
 * conditions, what could not be run, and the rule that turns them into the
 * default.
 */

/**
 * The MEASURED wall time, in seconds, of the heaviest single tool invocation
 * that could be run to completion on this machine:
 * `bun run --filter '@athena/webapp' test:coverage`, run on its own as one Bash
 * call, exit 0.
 *
 * This is the dominant leg of the cutover target's `test:coverage`, not the
 * whole of it — the storefront leg's checkout could not resolve its coverage
 * toolchain, so the composite call is strictly longer than this and its exact
 * cost was not established here. Read this as a measured FLOOR on that call.
 */
export const MEASURED_HEAVIEST_INVOCATION_SECONDS = 807;

/**
 * The heaviest OBSERVED wall time, in seconds, of the single gate check that
 * encloses that suite on the cutover target — "Athena and Storefront Webapp
 * Validation" — across three consecutive merged pull requests: 1731s, 1697s,
 * 1493s.
 *
 * An observation of the enclosing job rather than of the call alone, so it
 * bounds the single invocation from ABOVE. It is the larger of the two figures
 * and therefore the one the default is derived from: a lifetime that clears the
 * bound clears everything inside it.
 */
export const OBSERVED_HEAVIEST_VALIDATION_SECONDS = 1731;
