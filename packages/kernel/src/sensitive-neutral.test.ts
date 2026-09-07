import { it, expect } from "vitest";
import { defineHarnessConfig } from "./config.ts";
import { projectReviewActivation, isObligationActive } from "./candidate.types.ts";
import adopter from "../../../harness.config.ts";

it("retains explicitly sensitive path activation inside review-neutral narration", () => {
  const config = defineHarnessConfig({ ...adopter, sensitivePaths: [{ id: "published-policy", patterns: [{ kind: "prefix", value: "docs/reports/" }] }] });
  const projection = projectReviewActivation([{ path: "docs/reports/access-policy.md", additions: 1, deletions: 0, binary: false }], config);
  expect(projection.sensitivePathIds).toEqual(["published-policy"]);
  expect(projection.relevantLineCount).toBe(0);
  expect(isObligationActive({ kind: "relevant_change", sensitiveGroupIds: ["published-policy"] }, projection, 100)).toBe(true);
});
