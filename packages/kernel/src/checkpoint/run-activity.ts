/** Self-attested run observations. This module never grants authority or repairs missing history. */
import type { RunActivityState, RunEvent, RunEventInput } from "./run-event.ts";
export const DEFAULT_RUN_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
const terminal = (state: unknown): boolean => ["completed", "failed", "interrupted"].includes(String(state));
export interface RunWaitObservation {
  readonly waitId: string;
  readonly activityId: string;
  readonly attemptId: string;
  readonly candidateTreeSha: string;
  readonly owner: string;
  readonly waitingOn: string;
  readonly reason: string;
  readonly nextAction: string;
  readonly scope: string;
  readonly startedAt: string;
  resolvedAt?: string;
  resolution?: string;
  current: boolean;
}
export interface RunAttemptObservation {
  readonly activityId: string;
  readonly attemptId: string;
  readonly candidateTreeSha: string;
  state: RunActivityState;
  owner: string;
  phase: string;
  readonly roundId?: string;
  readonly round?: number;
  readonly lensId?: string;
  readonly supersedesAttemptId?: string;
  nextStep?: string;
  verdict?: string;
  cost?: unknown;
  readonly firstObservedAt: string;
  lastObservedAt: string;
  startedAt?: string;
  lifecycleIncomplete: boolean;
  superseded: boolean;
  freshness: "recent" | "stale" | "unknown";
  readonly waits: RunWaitObservation[];
}
export interface RunActivityObservation {
  readonly activityId: string;
  currentAttemptId: string;
  readonly attempts: RunAttemptObservation[];
}
export interface RunReferencedObservation {
  readonly seq: number;
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly current: boolean;
}
export interface RunActivityProjection {
  readonly activities: RunActivityObservation[];
  readonly waits: RunWaitObservation[];
  readonly findings: RunReferencedObservation[];
  readonly reports: RunReferencedObservation[];
  readonly artifacts: RunReferencedObservation[];
  readonly finishSteps: RunReferencedObservation[];
}

/** A useful terminal observation may be the first captured event for an attempt. */
export function runActivityTransitionError(events: readonly RunEvent[], event: RunEventInput): string | undefined {
  if (event.version !== "run-event/2") return undefined;
  const p = event.payload;
  const bound = events.filter(e => e.payload["attemptId"] === p["attemptId"]);
  if (p["attemptId"] !== undefined) {
    const original = bound[0];
    if (original && ["activityId", "candidateTreeSha"].some(key => original.payload[key] !== p[key])) {
      return "an attempt cannot change its activity or candidate binding";
    }
    for (const key of ["roundId", "round", "lensId"]) {
      if (p[key] !== undefined && bound.some(previous => previous.payload[key] !== undefined && previous.payload[key] !== p[key])) {
        return `an attempt cannot change its ${key} binding`;
      }
    }
  }
  if (event.kind === "activity.observed") {
    const prior = bound.filter(e => e.kind === "activity.observed");
    const last = prior.at(-1);
    if (last) {
      for (const key of ["roundId", "round", "lensId", "supersedesAttemptId"]) {
        if (last.payload[key] !== p[key]) return `an attempt cannot change its ${key} binding`;
      }
      if (terminal(last.payload["state"])) return "a terminal attempt cannot restart or receive another state; create a new attempt";
      if (p["state"] === "queued" && last.payload["state"] !== "queued") return "a started attempt cannot return to queued";
    } else {
      const sameActivity = events.filter(e => e.kind === "activity.observed" && e.payload["activityId"] === p["activityId"]);
      if (sameActivity.length > 0 && p["supersedesAttemptId"] === undefined) return "a new attempt for an existing activity must name supersedesAttemptId";
      if (p["supersedesAttemptId"] !== undefined) {
        const previous = sameActivity.find(e => e.payload["attemptId"] === p["supersedesAttemptId"]);
        if (!previous) return "supersedesAttemptId must name an existing attempt of this activity";
        const superseded = sameActivity.some(e => e.payload["supersedesAttemptId"] === p["supersedesAttemptId"]);
        if (superseded) return "an already superseded attempt cannot be reopened again";
      }
    }
  }
  if (event.kind === "wait.started") {
    if (events.some(e => e.kind === "wait.started" && e.payload["waitId"] === p["waitId"])) return "a wait ID cannot be reused";
    const last = bound.filter(e => e.kind === "activity.observed").at(-1);
    if (last && terminal(last.payload["state"])) return "a terminal attempt cannot begin a wait";
  }
  if (event.kind === "wait.resolved") {
    const wait = events.find(e => e.kind === "wait.started" && e.payload["waitId"] === p["waitId"]);
    if (!wait || ["attemptId", "activityId", "candidateTreeSha", "scope"].some(k => wait.payload[k] !== p[k])) return "a resolution must name the original wait, attempt, candidate and scope";
    if (events.some(e => e.kind === "wait.resolved" && e.payload["waitId"] === p["waitId"])) return "the wait is already resolved";
  }
  return undefined;
}

/**
 * Replay order is the append sequence. Timestamps only describe observation
 * freshness; a late old-attempt result cannot replace the current attempt.
 * `current` means reported for the latest attempt, never accepted evidence.
 */
export function projectRunActivities(
  events: readonly RunEvent[],
  options: {
    readonly now: string;
    readonly freshnessWindowMs?: number;
    readonly currentCandidateTreeSha?: string;
  },
): RunActivityProjection {
  const freshnessWindow = options.freshnessWindowMs ?? DEFAULT_RUN_FRESHNESS_WINDOW_MS;
  if (!Number.isFinite(freshnessWindow) || freshnessWindow < 0) {
    throw new Error("freshnessWindowMs must be finite and non-negative");
  }
  const now = Date.parse(options.now);
  const activities = new Map<string, RunActivityObservation>();
  const attempts = new Map<string, RunAttemptObservation>();
  const waits = new Map<string, RunWaitObservation>();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    const payload = event.payload;
    if (event.kind === "activity.observed") {
      const id = String(payload["attemptId"]);
      let attempt = attempts.get(id);
      if (!attempt) {
        attempt = {
          activityId: String(payload["activityId"]),
          attemptId: id,
          candidateTreeSha: String(payload["candidateTreeSha"]),
          state: payload["state"] as RunActivityState,
          owner: String(payload["owner"]),
          phase: String(payload["phase"]),
          ...(typeof payload["roundId"] === "string" ? { roundId: payload["roundId"] } : {}),
          ...(typeof payload["round"] === "number" ? { round: payload["round"] } : {}),
          ...(typeof payload["lensId"] === "string" ? { lensId: payload["lensId"] } : {}),
          ...(typeof payload["supersedesAttemptId"] === "string" ? { supersedesAttemptId: payload["supersedesAttemptId"] } : {}),
          firstObservedAt: event.at,
          lastObservedAt: event.at,
          lifecycleIncomplete: payload["state"] !== "queued",
          superseded: false,
          freshness: "unknown",
          waits: [],
        };
        attempts.set(id, attempt);
        let activity = activities.get(attempt.activityId);
        if (!activity) {
          activity = { activityId: attempt.activityId, currentAttemptId: id, attempts: [] };
          activities.set(attempt.activityId, activity);
        }
        if (attempt.supersedesAttemptId) {
          const old = attempts.get(attempt.supersedesAttemptId);
          if (old) old.superseded = true;
          if (activity.currentAttemptId === attempt.supersedesAttemptId) activity.currentAttemptId = id;
        }
        activity.attempts.push(attempt);
        for (const wait of waits.values()) {
          if (wait.attemptId === id) attempt.waits.push(wait);
        }
      }
      if (terminal(payload["state"]) && attempt.startedAt === undefined) attempt.lifecycleIncomplete = true;
      attempt.state = payload["state"] as RunActivityState;
      attempt.owner = String(payload["owner"]);
      attempt.phase = String(payload["phase"]);
      attempt.lastObservedAt = event.at;
      if (payload["state"] === "running" && !attempt.startedAt) attempt.startedAt = event.at;
      if (typeof payload["nextStep"] === "string") attempt.nextStep = payload["nextStep"];
      if (typeof payload["verdict"] === "string") attempt.verdict = payload["verdict"];
      if (payload["cost"] !== undefined) attempt.cost = payload["cost"];
    } else if (event.kind === "wait.started") {
      const wait = { ...payload, startedAt: event.at, current: false } as unknown as RunWaitObservation;
      waits.set(wait.waitId, wait);
      const attempt = attempts.get(wait.attemptId);
      if (attempt) {
        attempt.waits.push(wait);
        attempt.lastObservedAt = event.at;
      }
    } else if (event.kind === "wait.resolved") {
      const wait = waits.get(String(payload["waitId"]));
      if (wait && wait.attemptId === payload["attemptId"]) {
        wait.resolvedAt = event.at;
        wait.resolution = String(payload["resolution"]);
        const attempt = attempts.get(wait.attemptId);
        if (attempt) attempt.lastObservedAt = event.at;
      }
    }
  }
  for (const attempt of attempts.values()) {
    const age = now - Date.parse(attempt.lastObservedAt);
    attempt.freshness = !Number.isFinite(age) || age < 0 ? "unknown" : age <= freshnessWindow ? "recent" : "stale";
  }
  for (const wait of waits.values()) {
    const attempt = attempts.get(wait.attemptId);
    const activity = activities.get(wait.activityId);
    // A captured wait still matters when its activity start was lost. It is
    // historical if an observed current attempt names a different attempt.
    wait.current = !wait.resolvedAt
      && attempt?.superseded !== true
      && (activity === undefined || activity.currentAttemptId === wait.attemptId)
      && (options.currentCandidateTreeSha === undefined || wait.candidateTreeSha === options.currentCandidateTreeSha);
  }
  const references = (kind: RunEvent["kind"]): RunReferencedObservation[] => ordered
    .filter(event => event.kind === kind)
    .map(event => {
      const attempt = attempts.get(String(event.payload["attemptId"]));
      return {
        seq: event.seq,
        at: event.at,
        payload: event.payload,
        current: (options.currentCandidateTreeSha === undefined || event.candidateTreeSha === options.currentCandidateTreeSha)
          && attempt?.candidateTreeSha === event.candidateTreeSha
          && attempt?.superseded === false,
      };
    });
  const finishEvents = ordered.filter(event => event.kind === "finish.step.observed");
  const latestSteps = new Map<string, RunEvent>();
  const stepKey = (event: RunEvent): string => JSON.stringify([event.candidateTreeSha, event.payload["stepId"]]);
  for (const event of finishEvents) latestSteps.set(stepKey(event), event);
  const finishSteps = finishEvents.map(event => ({
    seq: event.seq,
    at: event.at,
    payload: event.payload,
    current: (options.currentCandidateTreeSha === undefined || event.candidateTreeSha === options.currentCandidateTreeSha)
      && latestSteps.get(stepKey(event)) === event,
  }));
  return {
    activities: [...activities.values()],
    waits: [...waits.values()],
    findings: references("finding.observed"),
    reports: references("report.referenced"),
    artifacts: references("artifact.referenced"),
    finishSteps,
  };
}
