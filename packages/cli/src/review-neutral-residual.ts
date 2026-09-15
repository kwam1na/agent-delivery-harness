/**
 * Where the CLI reaches the post-round residual.
 *
 * The module itself is the kernel's (`review-neutral-residual.ts` there): the
 * merge gate has to re-prove a proven-neutral move exactly as `record` and
 * `verify` do, and the Action is a wrapper over the kernel and deliberately not
 * over this package. This file is the seam the three commands kept importing
 * through, so that moving the implementation did not move four call sites.
 */
export { projectPostRoundResidual, residualRows, decideResidual, reproveResidual, type ResidualOutcome, type ResidualRequest, type ResidualDecision } from "@agent-delivery-harness/kernel";
