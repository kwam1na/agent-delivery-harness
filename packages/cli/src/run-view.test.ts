import { expect, it } from "vitest";
import type { RunEvent } from "@agent-delivery-harness/kernel";
import { projectRunView } from "./run-view.ts";
const candidate = "a".repeat(40);
const event = (
  kind: RunEvent["kind"],
  payload: Record<string, unknown>,
  seq: number,
): RunEvent => ({
  version: "run-event/2",
  candidateTreeSha: candidate,
  eventId: `e-${seq}`,
  runId: "run-1",
  seq,
  at: "2026-09-07T12:00:00Z",
  repo: { commonDir: "/repo" },
  actor: { role: "executor" },
  attestation: "self",
  kind,
  payload,
});
const binding = {
  activityId: "review",
  attemptId: "attempt-1",
  candidateTreeSha: candidate,
};
it("projects waiting ownership, staleness, next step and incomplete history without approval", () => {
  const events = [
    event(
      "activity.observed",
      {
        ...binding,
        state: "running",
        owner: "Codex",
        phase: "review",
        nextStep: "Inspect report",
      },
      1,
    ),
    event(
      "wait.started",
      {
        ...binding,
        waitId: "billing",
        owner: "service",
        waitingOn: "external",
        reason: "Actions billing unavailable",
        nextAction: "Use authorized local checks",
        scope: "this delivery",
      },
      2,
    ),
  ];
  const view = projectRunView(events, { now: "2026-09-07T13:00:00Z" });
  const text = JSON.stringify(view);
  expect(text).toContain("stale");
  expect(text).toContain("Use authorized local checks");
  expect(text).toContain("Human action required");
  expect(text).toContain("No — external");
  expect(text).toContain("Applicability unknown");
  expect(
    projectRunView(events, { now: "2026-09-07T13:00:00Z", historical: true })
      .historical,
  ).toBe(true);
});
it("keeps parallel attempts and resolved historical findings separate from current work", () => {
  const other = { ...binding, activityId: "tests", attemptId: "tests-1" };
  const events = [
    event(
      "activity.observed",
      { ...binding, state: "running", owner: "Alice", phase: "review" },
      1,
    ),
    event(
      "activity.observed",
      { ...other, state: "running", owner: "Bob", phase: "tests" },
      2,
    ),
    event(
      "finding.observed",
      {
        ...binding,
        findingId: "f1",
        reportId: "r1",
        severity: "P1",
        state: "unresolved",
      },
      3,
    ),
    event(
      "finding.observed",
      {
        ...binding,
        findingId: "f1",
        reportId: "r1",
        severity: "P1",
        state: "resolved",
      },
      4,
    ),
    event(
      "activity.observed",
      {
        ...binding,
        state: "completed",
        owner: "Alice",
        phase: "review",
        verdict: "approved",
      },
      5,
    ),
  ];
  const unresolved = projectRunView(events.slice(0, 3), {
    now: "2026-09-07T12:01:00Z",
  }).sections.find((s) => s.id === "findings")!.items;
  expect(unresolved).toHaveLength(1);
  expect(unresolved[0]!.id).toBe("f1");
  expect(unresolved[0]!.fields).toEqual(expect.arrayContaining([
    { label: "Severity", value: "P1" },
    { label: "State", value: "Unresolved (reported)" },
    { label: "Report", value: "r1" },
    { label: "Attempt", value: "attempt-1" },
    { label: "Candidate", value: candidate },
  ]));
  const view = projectRunView(events, { now: "2026-09-07T12:01:00Z" });
  expect(
    view.sections.find((s) => s.id === "work")!.items.map((i) => i.id),
  ).toEqual(["tests-1"]);
  expect(view.sections.find((s) => s.id === "findings")!.items).toEqual([]);
  expect(
    view.sections.find((s) => s.id === "finding-history")!.items,
  ).toHaveLength(2);
  expect(
    JSON.stringify(view.sections.find((s) => s.id === "reviews")),
  ).toContain("approved");
  expect(view.authority).toContain("no permission or candidate approval");
});

it("renders reported cost by compatible reporter and unit without adding overlapping run totals", () => {
  const closed = (
    roundId: string,
    total: number,
    unit: string,
    reportedBy: string,
    seq: number,
  ) =>
    event(
      "review.round.closed",
      { roundId, cost: { coverage: "complete", total, unit, reportedBy } },
      seq,
    );
  const events = [
    closed("r1", 2, "tokens", "Codex", 1),
    closed("r2", 3, "tokens", "Codex", 2),
    closed("r3", 4, "USD", "Claude", 3),
    event(
      "run.ended",
      {
        cost: {
          coverage: "partial",
          total: 12,
          unit: "tokens",
          reportedBy: "Codex",
        },
      },
      4,
    ),
  ];
  const costs = projectRunView(events, {
    now: "2026-09-07T13:00:00Z",
  }).sections.find((s) => s.id === "cost")!;
  expect(costs.items[0]!.fields).toContainEqual({
    label: "Codex · tokens",
    value: "5 tokens",
  });
  expect(costs.items[0]!.fields).toContainEqual({
    label: "Claude · USD",
    value: "4 USD",
  });
  expect(costs.items[1]!.fields).toContainEqual({
    label: "Measurement",
    value: "12 tokens (partial coverage)",
  });
  expect(
    costs.items.flatMap((i) => i.fields).some((f) => f.label === "Counters"),
  ).toBe(false);
  const missing = projectRunView([], {
    now: "2026-09-07T13:00:00Z",
  }).sections.find((s) => s.id === "cost")!;
  expect(missing.items[0]!.fields).toContainEqual({
    label: "Measurement",
    value: "Unreported",
  });
  expect(missing.items[1]!.fields).toContainEqual({
    label: "Measurement",
    value: "unreported",
  });
  const overflow = projectRunView(
    [
      closed("r1", Number.MAX_VALUE, "tokens", "Codex", 1),
      closed("r2", Number.MAX_VALUE, "tokens", "Codex", 2),
    ],
    { now: "2026-09-07T13:00:00Z" },
  ).sections.find((s) => s.id === "cost")!;
  expect(overflow.items[0]!.fields).toContainEqual({
    label: "Codex · tokens",
    value: "Unavailable — reported sum exceeds numeric range",
  });
});

it("retains failed and interrupted nonreview attempts before any retry", () => {
  for (const state of ["failed", "interrupted"] as const) {
    const binding = { activityId: "qualification", attemptId: `qualification-${state}`, candidateTreeSha: candidate, owner: "codex", phase: "qualification" };
    const view = projectRunView([
      event("activity.observed", { ...binding, state: "running" }, 1),
      event("activity.observed", { ...binding, state }, 2),
    ], { now: "2026-09-07T13:00:00Z" });
    expect(view.sections.find(s => s.id === "work")!.items).toEqual([]);
    const history = view.sections.find(s => s.id === "activity-history")!.items;
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe(binding.attemptId);
    expect(history[0]!.fields).toEqual(expect.arrayContaining([
      { label: "State", value: `${state} (reported)` },
      { label: "History", value: "Latest observed attempt" },
      { label: "Candidate", value: candidate },
      { label: "Owner", value: "codex" },
    ]));
  }
});

it("retains terminal nonreview attempts and partial cost without adding overlapping totals", () => {
  const first = { activityId: "native-claude", attemptId: "native-claude-1", candidateTreeSha: candidate, owner: "claude-code", phase: "qualification" };
  const second = { ...first, attemptId: "native-claude-2", supersedesAttemptId: first.attemptId };
  const cost = { coverage: "partial", total: 0.5786060000000001, unit: "USD", reportedBy: "claude-code" };
  const events = [
    event("activity.observed", { ...first, state: "running" }, 1),
    event("activity.observed", { ...first, state: "interrupted", cost }, 2),
    event("activity.observed", { ...second, state: "running" }, 3),
    event("activity.observed", { ...second, state: "completed" }, 4),
    event("run.ended", { cost: { ...cost, total: 1 } }, 5),
  ];
  const view = projectRunView(events, { now: "2026-09-07T13:00:00Z" });
  const work = view.sections.find(s => s.id === "work")!;
  expect(work.items).toEqual([]);
  expect(work.empty).toBe("No active work in the latest observations. Retained attempts appear in history.");
  const history = view.sections.find(s => s.id === "activity-history")!;
  expect(history.items.map(i => i.id)).toEqual([first.attemptId, second.attemptId]);
  expect(history.items[0]!.fields).toEqual(expect.arrayContaining([
    { label: "Owner", value: "claude-code" },
    { label: "Phase", value: "qualification" },
    { label: "Attempt", value: first.attemptId },
    { label: "Candidate", value: candidate },
    { label: "State", value: "interrupted (reported)" },
    { label: "History", value: "Superseded attempt" },
    { label: "Freshness", value: "stale" },
    { label: "Cost", value: "0.5786060000000001 USD (partial coverage)" },
  ]));
  expect(view.sections.find(s => s.id === "reviews")!.items).toEqual([]);
  const costs = view.sections.find(s => s.id === "cost")!.items;
  expect(costs).toHaveLength(3);
  expect(costs[1]!.fields).toContainEqual({ label: "Measurement", value: "1 USD (partial coverage)" });
  expect(costs[2]!.fields).toEqual(expect.arrayContaining([
    { label: "Attempt", value: first.attemptId },
    { label: "Coverage", value: "partial" },
    { label: "Reported by", value: "claude-code" },
    { label: "Measurement", value: "0.5786060000000001 USD (partial coverage)" },
  ]));
  expect(JSON.stringify(view)).not.toContain("1.578606");
  const archived = projectRunView(events, { now: "2026-09-07T13:00:00Z", historical: true });
  expect(archived.sections.find(s => s.id === "activity-history")!.items[0]!.fields).toContainEqual({ label: "Freshness", value: "Historical observation" });
  expect(projectRunView([], { now: "2026-09-07T13:00:00Z" }).sections.find(s => s.id === "work")!.empty).toBe("No activity observations; execution status unknown.");
});
