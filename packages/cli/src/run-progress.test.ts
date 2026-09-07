import { describe, expect, it } from "vitest";
import type { RunEvent } from "@agent-delivery-harness/kernel";
import { buildRunEvent } from "./run-surface.ts";
import { buildRunExport, parseRunExport } from "./run-export.ts";
import { projectCosts, projectRunProgress } from "./run-projection.ts";

const tree = "a".repeat(40);
const at = "2026-09-07T10:00:00Z";
function event(seq: number, kind: string, payload: Record<string, unknown>): RunEvent {
  return { ...buildRunEvent({ runId: "run-example", commonDir: "/repo/.git", kind, role: "executor", payload,
    version: "run-event/2", eventId: `event-${seq}` }), seq, at };
}
const start = event(1, "run.started", { host: "codex", workflow: { releaseId: "test", profile: "core" } });
const binding = { activityId: "review-correctness", attemptId: "attempt-1", candidateTreeSha: tree };

describe("shared progress and retained export", () => {
  it("keeps current finding dispositions separate from their historical reports", () => {
    const events = [start,
      event(2, "activity.observed", { ...binding, state: "running", owner: "codex", phase: "review" }),
      event(3, "finding.observed", { ...binding, findingId: "finding-1", reportId: "report-1", state: "unresolved", severity: "P1" }),
      event(4, "finding.observed", { ...binding, findingId: "finding-1", reportId: "report-2", state: "resolved", severity: "P1" })];
    const progress = projectRunProgress(events, "2026-09-07T10:10:00Z");
    expect(progress.findings).toHaveLength(2);
    expect(progress.currentFindings).toHaveLength(1);
    expect(progress.currentFindings[0]?.payload["state"]).toBe("resolved");
    expect(progress.activities[0]?.attempts[0]?.freshness).toBe("stale");
    expect(progress.activities[0]?.attempts[0]?.lifecycleIncomplete).toBe(true);
  });

  it("exports v2 observations historically and rejects forged derived state", () => {
    const events = [start, event(2, "activity.observed", { ...binding, state: "completed", owner: "codex", phase: "review" })];
    const exported = buildRunExport({ runId: "run-example", events });
    expect(exported.spec).toBe("delivery-run-export/2");
    expect(exported.progress?.asOf).toBe(at);
    expect(parseRunExport(JSON.stringify(exported)).ok).toBe(true);
    const tampered = JSON.parse(JSON.stringify(exported));
    tampered.progress.activities[0].attempts[0].state = "running";
    expect(parseRunExport(JSON.stringify(tampered)).ok).toBe(false);
    tampered.events[1].version = "run-event/1";
    expect(parseRunExport(JSON.stringify(tampered)).ok).toBe(false);
  });

  it("does not sum repeated cumulative measurements of one v2 round", () => {
    const payload = { round: 1, roundId: "round-1", candidateTreeSha: tree, outcome: "aligned",
      findings: { P0: 0, P1: 0, P2: 0, P3: 0 }, cost: { unit: "tokens", total: 12, reportedBy: "codex", coverage: "complete" } };
    const events = [start, event(2, "review.round.opened", { round: 1, roundId: "round-1", candidateTreeSha: tree, lenses: ["correctness"] }),
      event(3, "review.round.closed", payload), event(4, "review.round.closed", payload)];
    const costs = projectCosts(events);
    expect(costs.review.totals[0]?.total).toBe(12);
    expect(costs.review.coverage).toBe("partial");
  });
});
