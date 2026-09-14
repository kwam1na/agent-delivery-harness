/**
 * The graded host-liveness rule, and the observation lifetime it ages against.
 *
 * WHY THIS IS ITS OWN MODULE. Host liveness is derived in more than one place
 * — the per-delivery status model derives it, and any installation-scoped
 * listing over several deliveries must derive the SAME grade or the two
 * surfaces disagree about whether a delivery is alive. A rule copied into a
 * second reader is a rule that drifts, and the drift is invisible: both
 * readers keep returning a value from the same small vocabulary. So the rule
 * is one exported pure function here, and every reader calls it.
 *
 * WHAT THE GRADE MEANS. Three grades, and the distinction between them is the
 * whole point:
 *
 * - `paused` is a TRUSTED clean end. The session-end hook appended it to the
 *   journal itself, so the host said it was leaving.
 * - `unknown` is a DISAPPEARANCE. Either no lifecycle event stands for the
 *   current fence, or the freshness heartbeat has aged past the workspace's
 *   declared lifetime. The host did not say anything; it simply stopped being
 *   observed.
 * - `active` is a heartbeat inside its lifetime, at the current fence.
 *
 * A timeout NEVER proves termination, so aging turns `active` into `unknown`
 * and never into `paused` or `ended`. That asymmetry is load-bearing: `paused`
 * is evidence the host produced, and no elapsed clock can manufacture it.
 *
 * THE HEARTBEAT, AND WHY THE LIFETIME IS NOT A GUESS. The binding rewrites
 * `binding/observation.json` on every ALLOWED PreToolUse invocation
 * (`../host/hook-main.ts`), stamped BEFORE the tool runs. So the heartbeat's
 * density is exactly the host's tool-call rate, and a single long tool call
 * emits nothing for its whole duration: the gap is the call itself, and no
 * emission the binding can make lands inside it. The lifetime therefore has to
 * exceed the longest single tool invocation a delivery actually performs, and
 * that is a measurement rather than a preference. The measurement, the
 * derivation, and why the number is what it is are recorded in
 * `docs/managed-delivery.md`; the constant below is that recorded derivation's
 * result and moves only with it.
 */

/** The separately tracked host-activity vocabulary. It never changes delivery state. */
export type HostActivity = "active" | "paused" | "unknown" | "cancellation_pending";

/**
 * The default observation lifetime, in seconds, for a workspace whose binding
 * declares none.
 *
 * DERIVED, NOT CHOSEN. `docs/managed-delivery.md` carries the measurement this
 * number comes from and the rule that turns it into this value. Changing the
 * constant without changing that derivation leaves the guide stating a number
 * the product does not use; changing the derivation without re-measuring is
 * the guess this default exists to replace. The per-fence
 * `observationLifetimeSeconds` declaration still overrides it, which is what a
 * repository with a heavier single operation than the measured one uses.
 */
export const DEFAULT_OBSERVATION_LIFETIME_SECONDS = 3600;

/**
 * The lifetime a bind runs under: the caller's declaration when it made one,
 * the derived default otherwise.
 *
 * A ONE-LINE RULE WITH ITS OWN FUNCTION, deliberately. The declaration is the
 * only escape hatch a repository whose heaviest single operation is heavier —
 * or lighter — than the measured one has, and the interesting failure is
 * silent: a resolution that floors the declaration at the default, or ignores
 * it outright, keeps returning a plausible number and every reader that takes
 * the default stays green. Below the default is the direction that cannot be
 * exercised through `bindWorkspace` in a long scenario (the value governs the
 * whole fence and would expire the binding mid-run), so it is asserted here
 * instead, against the rule itself.
 *
 * The declaration is honoured EXACTLY, in both directions. It is not clamped.
 */
export const resolveObservationLifetimeSeconds = (declaredSeconds: number | undefined): number =>
  declaredSeconds ?? DEFAULT_OBSERVATION_LIFETIME_SECONDS;

/** The freshness heartbeat the binding rewrites on every allowed PreToolUse. */
export interface HostObservationStamp {
  readonly fence: number;
  readonly observedAt: string;
}

/** The last `activity.observed` journal entry, reduced to what the grade reads. */
export interface ObservedActivityEntry {
  readonly activity: HostActivity;
  readonly fence: number;
}

export interface GradeHostActivityInput {
  /** The delivery's current invocation fence, from the reduced journal. */
  readonly currentFence: number;
  /**
   * The last `activity.observed` entry, or `undefined` when the journal holds
   * none. An entry naming a superseded fence is not this fence's evidence and
   * grades `unknown`, exactly as an absent one does.
   */
  readonly lastObservedActivity: ObservedActivityEntry | undefined;
  /**
   * The bound workspace's declared lifetime, or `undefined` when no workspace
   * is bound. With no workspace there is no heartbeat to age and no lifetime
   * to age it against, so the journal's own last word stands unaged.
   */
  readonly observationLifetimeSeconds: number | undefined;
  /** The heartbeat read from the binding directory, when it is readable. */
  readonly observation: HostObservationStamp | undefined;
  /** The instant the read happens at. Aging is lazy: nothing runs on a timer. */
  readonly observedAt: string;
}

/**
 * Seconds since the epoch for the spine's fixed-width UTC instant.
 *
 * A malformed instant yields `NaN` rather than throwing, and the grade below
 * treats `NaN` as expired — an unreadable clock is a disappearance, not a
 * licence to keep reporting `active`.
 */
function instantSeconds(instant: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(instant);
  if (match === null) return Number.NaN;
  return (
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ) / 1000
  );
}

/**
 * The one graded host-liveness rule. Pure: no clock, no I/O, no ambient state.
 *
 * Only `active` is aged. `paused` is trusted lifecycle evidence and stands
 * however old it is; `cancellation_pending` is a pending control decision and
 * is not a liveness claim at all; `unknown` cannot degrade further.
 */
export const gradeHostActivity = (input: GradeHostActivityInput): HostActivity => {
  const last = input.lastObservedActivity;
  const claimed: HostActivity = last !== undefined && last.fence === input.currentFence ? last.activity : "unknown";
  if (claimed !== "active" || input.observationLifetimeSeconds === undefined) return claimed;

  const observation = input.observation;
  // An unreadable heartbeat, or one stamped under a superseded fence, is no
  // evidence for this fence.
  if (observation === undefined || observation.fence !== input.currentFence) return "unknown";
  const ageSeconds = instantSeconds(input.observedAt) - instantSeconds(observation.observedAt);
  if (Number.isNaN(ageSeconds) || ageSeconds > input.observationLifetimeSeconds) return "unknown";
  return "active";
};
