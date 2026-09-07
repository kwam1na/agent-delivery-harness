/** One operational readout for terminal, JSON and HTML; no admission decisions. */
import type { RunEvent } from "@agent-delivery-harness/kernel";
import {
  projectRunProgress,
  projectCosts,
  costLabel,
} from "./run-projection.ts";
export interface RunViewItem {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly { label: string; value: string }[];
  readonly artifactId?: string;
}
export interface RunViewSection {
  readonly id: string;
  readonly title: string;
  readonly empty: string;
  readonly items: readonly RunViewItem[];
}
export interface RunView {
  readonly spec: "run-view/1";
  readonly historical: boolean;
  readonly asOf: string;
  readonly authority: string;
  readonly sections: readonly RunViewSection[];
}
const value = (v: unknown): string =>
  v === undefined
    ? "Unreported"
    : typeof v === "string"
      ? v
      : JSON.stringify(v);
const item = (
  id: string,
  label: string,
  fields: Record<string, unknown>,
  artifactId?: string,
): RunViewItem => ({
  id,
  label,
  fields: Object.entries(fields).map(([label, v]) => ({
    label,
    value: value(v),
  })),
  ...(artifactId === undefined ? {} : { artifactId }),
});
export function projectRunView(
  events: readonly RunEvent[],
  options: {
    readonly now: string;
    readonly historical?: boolean;
    readonly freshnessWindowMs?: number;
  },
): RunView {
  const p = projectRunProgress(events, options.now, options.freshnessWindowMs);
  const historical = options.historical === true;
  const costs = projectCosts(events);
  const runCost = costs.run as Record<string, unknown>;
  const attempts = p.activities.flatMap((a) => a.attempts);
  const current = attempts.filter((a) => !a.superseded);
  const sections: RunViewSection[] = [
    {
      id: "waiting",
      title: "Waiting and required action",
      empty: "No current waiting observation. Unreported waits remain unknown.",
      items: p.waits
        .filter((w) => w.current && !w.resolvedAt)
        .map((w) =>
          item(w.waitId, w.reason, {
            Owner: w.owner,
            "Human action required":
              w.waitingOn === "human"
                ? "Yes — human"
                : w.waitingOn === "unknown"
                  ? "Unknown"
                  : `No — ${w.waitingOn}`,
            "Next action": w.nextAction,
            Scope: w.scope,
            Attempt: w.attemptId,
            Observed: w.startedAt,
            Freshness: historical
              ? "Historical observation"
              : !Number.isFinite(Date.parse(w.startedAt))
                ? "unknown"
                : Date.parse(options.now) - Date.parse(w.startedAt) >
                    (options.freshnessWindowMs ?? 300000)
                  ? "stale"
                  : "recent",
            Candidate: w.candidateTreeSha,
          }),
        ),
    },
    {
      id: "work",
      title: "Current work",
      empty: attempts.length === 0
        ? "No activity observations; execution status unknown."
        : "No active work in the latest observations. Retained attempts appear in history.",
      items: current
        .filter(
          (a) => !["completed", "failed", "interrupted"].includes(a.state),
        )
        .map((a) =>
          item(a.attemptId, a.activityId, {
            Owner: a.owner,
            Phase: a.phase,
            State: `${a.state} (reported)`,
            Freshness: historical ? "Historical observation" : a.freshness,
            "Last observed": a.lastObservedAt,
            "Elapsed since start": a.startedAt
              ? `${Math.max(0, Math.floor((Date.parse(options.now) - Date.parse(a.startedAt)) / 1000))}s`
              : "Unknown — start not observed",
            "Next step": a.nextStep,
            Candidate: a.candidateTreeSha,
            "Lifecycle history": a.lifecycleIncomplete
              ? "Incomplete"
              : "Observed",
          }),
        ),
    },
    {
      id: "reviews",
      title: "Reviewer attempts and history",
      empty: "No reviewer attempt observations.",
      items: attempts
        .filter((a) => a.lensId !== undefined || a.phase === "review")
        .map((a) =>
          item(a.attemptId, a.lensId ?? a.activityId, {
            Attempt: a.attemptId,
            Round: a.round,
            "Round ID": a.roundId,
            Owner: a.owner,
            State: a.state,
            History: a.superseded
              ? "Superseded attempt"
              : "Latest observed attempt",
            Verdict: a.verdict,
            Cost: costLabel(a.cost),
            Candidate: a.candidateTreeSha,
          }),
        ),
    },
    {
      id: "findings",
      title: "Current unresolved findings",
      empty:
        p.findingsCoverage === "unreported"
          ? "Unknown — detailed finding observations were not recorded."
          : "No unresolved findings in latest reported observations; this is not approval.",
      items: p.currentFindings
        .filter((f) => f.payload["state"] === "unresolved")
        .map((f) =>
          item(String(f.payload["findingId"]), String(f.payload["findingId"]), {
            Severity: f.payload["severity"],
            State: "Unresolved (reported)",
            Report: f.payload["reportId"],
            Attempt: f.payload["attemptId"],
            Candidate: f.payload["candidateTreeSha"],
          }),
        ),
    },
    {
      id: "evidence",
      title: "Evidence and candidate",
      empty: "No evidence observations. Applicability unknown.",
      items: events
        .filter((e) =>
          [
            "gate.reported",
            "command.completed",
            "review.round.closed",
          ].includes(e.kind),
        )
        .map((e) =>
          item(String(e.seq), e.kind, {
            "Reported at": e.at,
            Candidate: e.candidateTreeSha ?? e.payload["candidateTreeSha"],
            Observation: e.payload,
            Authority:
              "Reported only — Applicability unknown; no verification is run by this view",
          }),
        ),
    },
    {
      id: "reports",
      title: "Retained reports",
      empty: "No report references recorded.",
      items: p.reports.map((r) =>
        item(
          String(r.payload["reportId"]),
          String(r.payload["role"]),
          {
            Report: r.payload["reportId"],
            Availability: r.payload["availability"],
            Reason: r.payload["reason"],
            "Originating report": r.payload["originatingReportId"],
            Lens: r.payload["lensId"],
            Attempt: r.payload["attemptId"],
            Candidate: r.payload["candidateTreeSha"],
            History: r.current
              ? "Latest observed attempt"
              : "Historical or incomplete binding",
          },
          typeof r.payload["artifactId"] === "string"
            ? r.payload["artifactId"]
            : undefined,
        ),
      ),
    },
    {
      id: "finish",
      title: "Declared finish line",
      empty: "Finish steps unreported; delivery completion unknown.",
      items: [],
    },
    {
      id: "cost",
      title: "Reported cost",
      empty: "Cost unreported.",
      items: [
        {
          id: "review-cost",
          label: "Review totals",
          fields: [
            ...item("review-cost", "Review totals", {
              Coverage: costs.review.coverage,
              "Unreported round entries": costs.review.unreportedEntries,
              ...(costs.review.totals.length === 0
                ? { Measurement: "Unreported" }
                : {}),
            }).fields,
            ...costs.review.totals.map((total) => ({
              label: `${total.reportedBy} · ${total.unit}`,
              value:
                total.total === null
                  ? "Unavailable — reported sum exceeds numeric range"
                  : `${total.total} ${total.unit}`,
            })),
          ],
        },
        item("run-cost", "Run total", {
          Coverage: runCost["coverage"],
          Measurement: costLabel(runCost),
          "Reported by": runCost["reportedBy"],
          Accounting:
            "Run totals can include review and attempt costs. These totals are shown separately and are not added together.",
        }),
        ...attempts.filter((a) => a.cost !== undefined).map((a) => {
          const cost = a.cost as Record<string, unknown>;
          return item(`attempt-cost-${a.attemptId}`, `Attempt cost · ${a.activityId}`, {
            Attempt: a.attemptId,
            Owner: a.owner,
            Phase: a.phase,
            State: `${a.state} (reported)`,
            History: a.superseded ? "Superseded attempt" : "Latest observed attempt",
            Candidate: a.candidateTreeSha,
            Coverage: cost["coverage"],
            Measurement: costLabel(a.cost),
            "Reported by": cost["reportedBy"],
            Accounting: "Reported attempt measurement; not added to run or review totals, which may overlap.",
          });
        }),
      ],
    },
    {
      id: "activity-history",
      title: "Activity history",
      empty: "No completed, failed, interrupted or superseded activity observations.",
      items: attempts
        .filter((a) => a.superseded || ["completed", "failed", "interrupted"].includes(a.state))
        .map((a) => item(a.attemptId, a.activityId, {
          Attempt: a.attemptId,
          Owner: a.owner,
          Phase: a.phase,
          State: `${a.state} (reported)`,
          History: a.superseded ? "Superseded attempt" : "Latest observed attempt",
          Freshness: historical ? "Historical observation" : a.freshness,
          "Last observed": a.lastObservedAt,
          Candidate: a.candidateTreeSha,
          "Lifecycle history": a.lifecycleIncomplete ? "Incomplete" : "Observed",
          Cost: costLabel(a.cost),
        })),
    },
    {
      id: "finding-history",
      title: "Finding history",
      empty: "No detailed finding history.",
      items: p.findings.map((f) =>
        item(String(f.seq), String(f.payload["findingId"]), {
          State: f.payload["state"],
          Severity: f.payload["severity"],
          Attempt: f.payload["attemptId"],
          Candidate: f.payload["candidateTreeSha"],
          "Deferred issue": f.payload["deferredIssueId"],
          Observed: f.at,
        }),
      ),
    },
  ];
  const reviewSection = sections.find((s) => s.id === "reviews")!;
  sections[2] = {
    ...reviewSection,
    items: [
      ...events
        .filter((e) => e.kind === "review.round.opened")
        .map((e) =>
          item(`round-${e.seq}`, "Declared review round", {
            Round: e.payload["round"],
            "Round ID": e.payload["roundId"],
            Bound: e.payload["bound"],
            Grace: e.payload["grace"],
            Reopens: e.payload["reopensRoundId"],
            Candidate: e.payload["candidateTreeSha"],
          }),
        ),
      ...reviewSection.items,
    ],
  };
  const finish = new Map<string, (typeof p.finishSteps)[number]>();
  for (const step of p.finishSteps)
    finish.set(String(step.payload["stepId"]), step);
  sections[6] = {
    id: "finish",
    title: "Declared finish line",
    empty: "Finish steps unreported; delivery completion unknown.",
    items: [...finish.values()].map((s) =>
      item(String(s.payload["stepId"]), String(s.payload["name"]), {
        State: s.payload["state"],
        Owner: s.payload["owner"],
        Reason: s.payload["reason"],
        Candidate: s.payload["candidateTreeSha"],
      }),
    ),
  };
  return {
    spec: "run-view/1",
    historical,
    asOf: options.now,
    authority:
      "Self-attested observations. Applicability unknown; no permission or candidate approval is granted.",
    sections,
  };
}
