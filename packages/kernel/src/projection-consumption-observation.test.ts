import { describe, expect, it } from "vitest";

import {
  PROJECTION_CONSUMPTION_OBSERVATION_SPEC,
  parseProjectionConsumptionObservation,
} from "./projection-consumption-observation.ts";

const observation = {
  spec: PROJECTION_CONSUMPTION_OBSERVATION_SPEC,
  deliveryId: "delivery-1",
  fence: 7,
  entry: "workflows/delivery-v1.json",
  canonicalProjectionPath: "/review/.agent-delivery/workflow/graph.yaml",
  projectionDigest: "a".repeat(64),
  hostInvocationId: "toolu_01",
  observedAt: "2026-09-01T12:00:00Z",
} as const;

describe("projection-consumption-observation/1", () => {
  it("admits the host-neutral exact completed-read envelope", () => {
    expect(parseProjectionConsumptionObservation(observation)).toEqual(observation);
  });

  it("refuses the retired Claude-only shape and provider-specific overlays", () => {
    const { spec: _spec, ...bindings } = observation;
    expect(
      parseProjectionConsumptionObservation({
        source: "claude-code-post-tool-use-read/1",
        ...bindings,
      }),
    ).toBeUndefined();
    expect(parseProjectionConsumptionObservation({ ...observation, provider: "claude-code" })).toBeUndefined();
  });

  it.each([
    ["spec", "projection-consumption-observation/2"],
    ["deliveryId", ""],
    ["fence", 0],
    ["fence", 1.5],
    ["entry", "workflow/graph.yaml"],
    ["canonicalProjectionPath", ""],
    ["canonicalProjectionPath", ".managed-projection/workflows/delivery-v1.json"],
    ["projectionDigest", "A".repeat(64)],
    ["projectionDigest", "a".repeat(63)],
    ["hostInvocationId", ""],
    ["observedAt", ""],
    ["observedAt", "2026-09-01T12:00:00.000Z"],
  ])("refuses a malformed %s binding", (key, value) => {
    expect(parseProjectionConsumptionObservation({ ...observation, [key]: value })).toBeUndefined();
  });

  it("refuses a partial observation", () => {
    const { hostInvocationId: _hostInvocationId, ...partial } = observation;
    expect(parseProjectionConsumptionObservation(partial)).toBeUndefined();
  });
});
