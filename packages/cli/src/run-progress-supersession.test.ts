import { expect, it } from "vitest";
import type { RunEvent } from "@agent-delivery-harness/kernel";
import { projectRunProgress } from "./run-projection.ts";

it("keeps delayed superseded reports and findings in history but out of current findings", () => {
  const tree = "a".repeat(40);
  const binding = { activityId: "review", attemptId: "old", candidateTreeSha: tree };
  function event(seq: number, kind: RunEvent["kind"], payload: Record<string, unknown>): RunEvent {
    return { version: "run-event/2", eventId: `event-${seq}`, candidateTreeSha: tree, seq, runId: "run-example",
      at: "2026-09-07T12:00:00Z", repo: { commonDir: "/repo" }, actor: { role: "executor" }, attestation: "self", kind, payload };
  }
  const progress = projectRunProgress([
    event(1, "activity.observed", { ...binding, owner: "codex", phase: "review", state: "running" }),
    event(2, "activity.observed", { ...binding, attemptId: "new", supersedesAttemptId: "old", owner: "codex", phase: "review", state: "running" }),
    event(3, "report.referenced", { ...binding, reportId: "old-report", role: "review", availability: "unavailable", reason: "interrupted" }),
    event(4, "finding.observed", { ...binding, findingId: "old-finding", reportId: "old-report", state: "unresolved", severity: "P1" }),
    event(5, "finding.observed", { ...binding, attemptId: "new", findingId: "new-finding", reportId: "new-report", state: "unresolved", severity: "P2" }),
  ], "2026-09-07T12:01:00Z");
  expect(progress.activities[0]?.currentAttemptId).toBe("new");
  expect(progress.reports).toHaveLength(1);
  expect.soft(progress.reports[0]).toMatchObject({ current: false, payload: { reportId: "old-report" } });
  expect(progress.findings).toHaveLength(2);
  expect.soft(progress.findings.map((finding) => finding.current)).toEqual([false, true]);
  expect(progress.currentFindings.map((finding) => finding.payload["findingId"])).toEqual(["new-finding"]);
});
