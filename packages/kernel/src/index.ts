/**
 * Delivery harness kernel.
 *
 * The kernel's modules — canonical.ts, digest.ts, config.ts, blockers.ts,
 * candidate.ts, identity.ts, records.ts, validator/, evaluator.ts, context.ts,
 * recorder.ts, admission.ts, delivery-record.ts — land incrementally. The purity
 * sensor already registers the not-yet-created paths as pending, so the change
 * that creates one has to promote it to an enforced protected class.
 */

export const PACKAGE_NAME = "@delivery-harness/kernel";
