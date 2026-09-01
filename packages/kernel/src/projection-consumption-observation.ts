/**
 * The host-neutral proof that one host invocation completed an exact read of
 * a receipted projection entry.
 *
 * Host adapters produce this closed envelope. The shared gate-record writer
 * still re-verifies every delivery, fence, canonical path, receipt, digest,
 * and projection byte before admitting it; this contract is evidence, not an
 * authorization or a claim supplied by the model.
 */
import path from "node:path";

import { SPINE_INSTANT, SPINE_SHA256 } from "./spine/grammar.ts";
import { WORKFLOW_GRAPH_ENTRY } from "./workflow/graph.ts";

export const PROJECTION_CONSUMPTION_OBSERVATION_SPEC = "projection-consumption-observation/1";

export interface ProjectionConsumptionObservation {
  readonly spec: typeof PROJECTION_CONSUMPTION_OBSERVATION_SPEC;
  readonly deliveryId: string;
  readonly fence: number;
  readonly entry: string;
  readonly canonicalProjectionPath: string;
  readonly projectionDigest: string;
  readonly hostInvocationId: string;
  readonly observedAt: string;
}

const OBSERVATION_KEYS = Object.freeze([
  "canonicalProjectionPath",
  "deliveryId",
  "entry",
  "fence",
  "hostInvocationId",
  "observedAt",
  "projectionDigest",
  "spec",
] as const);

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Parse the one shared envelope; partial and provider-specific variants fail closed. */
export function parseProjectionConsumptionObservation(
  value: unknown,
): ProjectionConsumptionObservation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const observation = value as Record<string, unknown>;
  const keys = Object.keys(observation).sort();
  if (keys.length !== OBSERVATION_KEYS.length || keys.some((key, index) => key !== OBSERVATION_KEYS[index])) {
    return undefined;
  }
  if (
    observation["spec"] !== PROJECTION_CONSUMPTION_OBSERVATION_SPEC ||
    !nonempty(observation["deliveryId"]) ||
    !Number.isSafeInteger(observation["fence"]) ||
    (observation["fence"] as number) <= 0 ||
    observation["entry"] !== WORKFLOW_GRAPH_ENTRY ||
    !nonempty(observation["canonicalProjectionPath"]) ||
    !path.isAbsolute(observation["canonicalProjectionPath"]) ||
    typeof observation["projectionDigest"] !== "string" ||
    !SPINE_SHA256.test(observation["projectionDigest"]) ||
    !nonempty(observation["hostInvocationId"]) ||
    typeof observation["observedAt"] !== "string" ||
    !SPINE_INSTANT.test(observation["observedAt"])
  ) {
    return undefined;
  }
  return observation as unknown as ProjectionConsumptionObservation;
}

export const projectionConsumptionObservationFile = (fence: number): string =>
  `projection-consumption-${fence}.json`;
