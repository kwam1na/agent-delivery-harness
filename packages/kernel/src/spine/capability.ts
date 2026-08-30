/**
 * The minimal repository capability descriptor and sensor-result contract the
 * walking skeleton's one trusted sensor consumes. The capability taxonomy is
 * deliberately a single frozen kind here — broadening it is the adapter
 * SDK's business and does not change this frozen RESULT shape.
 *
 * The result is candidate-bound and closed: it reports an outcome about the
 * candidate and nothing else. There is no member through which a result
 * could carry, request, or grant authority — an agent result cannot grant
 * authority, and the closed grammar is where that starts being mechanical.
 */
import {
  boundedText,
  checkClosed,
  createSpineCollector,
  gitOid,
  literal,
  oneOf,
  specLiteral,
  spineId,
  text,
  type MemberRule,
  type SpineVerdict,
} from "./grammar.ts";

export const CAPABILITY_DESCRIPTOR_SPEC = "capability-descriptor/1";
export const SENSOR_RESULT_SPEC = "sensor-result/1";

/** The skeleton's frozen capability taxonomy: exactly one kind. */
export const CAPABILITY_KINDS = Object.freeze(["sensor"] as const);

export const SENSOR_OUTCOMES = Object.freeze(["passed", "failed"] as const);

const DESCRIPTOR_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(CAPABILITY_DESCRIPTOR_SPEC) },
  { name: "capabilityId", check: spineId },
  { name: "kind", check: oneOf(CAPABILITY_KINDS) },
  { name: "version", check: text },
  { name: "resultSpec", check: literal(SENSOR_RESULT_SPEC) },
];

export function validateCapabilityDescriptor(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  checkClosed(value, "", DESCRIPTOR_RULES, collector);
  return collector.verdict();
}

const RESULT_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(SENSOR_RESULT_SPEC) },
  { name: "capabilityId", check: spineId },
  { name: "outcome", check: oneOf(SENSOR_OUTCOMES) },
  { name: "summary", check: boundedText },
  { name: "candidateTreeSha", check: gitOid },
];

export function validateSensorResult(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  checkClosed(value, "", RESULT_RULES, collector);
  return collector.verdict();
}
