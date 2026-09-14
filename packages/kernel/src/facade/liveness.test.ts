/**
 * The graded host-liveness rule, and the measured lifetime it ages against.
 *
 * TWO DIRECTIONS, AND WHY BOTH ARE HERE. A lifetime raised high enough keeps
 * every delivery `active` forever and satisfies the long-operation assertion on
 * its own, which is exactly the failure the second direction exists to catch.
 * So this suite pins both: a live host running the measured heaviest single
 * invocation holds `active` for its whole duration, AND a host that has
 * genuinely gone away still reaches `unknown`. Raising the lifetime must not
 * disable aging, and disabling aging must not pass for a raised lifetime.
 *
 * The two named mutations this suite is built to kill:
 *
 * - Reverting `DEFAULT_OBSERVATION_LIFETIME_SECONDS` to its old 900 fails
 *   `holds active across the heaviest observed validation invocation`, because
 *   that invocation is 1731 seconds — 1.9x the value it would be reverted to.
 * - Removing the age comparison from `gradeHostActivity` fails
 *   `ages a vanished host to unknown once the heartbeat outlives the lifetime`,
 *   because nothing else in the rule turns a stale heartbeat into `unknown`.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_OBSERVATION_LIFETIME_SECONDS, gradeHostActivity, type HostActivity } from "./liveness.ts";
import { MEASURED_HEAVIEST_INVOCATION_SECONDS, OBSERVED_HEAVIEST_VALIDATION_SECONDS } from "./liveness.fixture.ts";

const FENCE = 7;
const START = "2026-08-30T12:00:00Z";

/** `START` advanced by `seconds`, in the spine's fixed-width UTC shape. */
const after = (seconds: number): string => `${new Date(Date.parse(START) + seconds * 1000).toISOString().slice(0, 19)}Z`;

const grade = (
  overrides: Partial<Parameters<typeof gradeHostActivity>[0]> = {},
): HostActivity =>
  gradeHostActivity({
    currentFence: FENCE,
    lastObservedActivity: { activity: "active", fence: FENCE },
    observationLifetimeSeconds: DEFAULT_OBSERVATION_LIFETIME_SECONDS,
    observation: { fence: FENCE, observedAt: START },
    observedAt: START,
    ...overrides,
  });

describe("the measured observation lifetime", () => {
  it("is derived from the recorded figures rather than from the old guess", () => {
    // The derivation `docs/managed-delivery.md` records, asserted rather than
    // described. The larger figure is what the default is derived from, because
    // a lifetime clearing the upper bound clears everything inside it — and it
    // is the measured floor that establishes the bound is not idle.
    expect(MEASURED_HEAVIEST_INVOCATION_SECONDS).toBeGreaterThan(0);
    expect(OBSERVED_HEAVIEST_VALIDATION_SECONDS).toBeGreaterThan(MEASURED_HEAVIEST_INVOCATION_SECONDS);
    expect(DEFAULT_OBSERVATION_LIFETIME_SECONDS).not.toBe(900);
    expect(DEFAULT_OBSERVATION_LIFETIME_SECONDS).toBeGreaterThanOrEqual(2 * OBSERVED_HEAVIEST_VALIDATION_SECONDS);
  });

  it("holds active across the heaviest observed validation invocation", () => {
    // THE MUTATION THIS ROW EXISTS FOR: reverting the default to 900 fails
    // here, because the observed invocation is 1.9x that value. The heartbeat
    // is stamped BEFORE the tool runs, so a delivery that starts this call and
    // is read at any point inside it must never report `unknown`. Sampled at
    // the start, the midpoint, and the last second, all against one stamp taken
    // at its start.
    for (const elapsed of [0, Math.floor(OBSERVED_HEAVIEST_VALIDATION_SECONDS / 2), OBSERVED_HEAVIEST_VALIDATION_SECONDS]) {
      expect(grade({ observedAt: after(elapsed) }), `elapsed ${elapsed}s`).toBe("active");
    }
    // And the replaced default would not have. Stated as the comparison rather
    // than as prose, so the claim "900 was too short" is itself checked.
    expect(OBSERVED_HEAVIEST_VALIDATION_SECONDS).toBeGreaterThan(900);
    expect(
      grade({ observationLifetimeSeconds: 900, observedAt: after(OBSERVED_HEAVIEST_VALIDATION_SECONDS) }),
      "the replaced 900s default is what this delivery would have reported unknown under",
    ).toBe("unknown");
  });

  it("holds active for the whole measured Athena coverage leg", () => {
    // The locally measured floor, at every point inside it. Weaker than the row
    // above on its own — 807s also fits inside the old 900 — and it is here
    // because it is the figure that was actually run to completion on this
    // machine rather than read off a CI job.
    for (const elapsed of [0, Math.floor(MEASURED_HEAVIEST_INVOCATION_SECONDS / 2), MEASURED_HEAVIEST_INVOCATION_SECONDS]) {
      expect(grade({ observedAt: after(elapsed) }), `elapsed ${elapsed}s`).toBe("active");
    }
  });
});

describe("the graded host-liveness rule", () => {
  it("ages a vanished host to unknown once the heartbeat outlives the lifetime", () => {
    // The direction a raised lifetime must not buy off. One second past the
    // declared lifetime with no fresher stamp is a disappearance.
    expect(grade({ observedAt: after(DEFAULT_OBSERVATION_LIFETIME_SECONDS + 1) })).toBe("unknown");
    // Far past it, too — so a comparison inverted rather than deleted also dies.
    expect(grade({ observedAt: after(DEFAULT_OBSERVATION_LIFETIME_SECONDS * 10) })).toBe("unknown");
  });

  it("holds active at the lifetime boundary and loses it one second later", () => {
    // The boundary is `>`, not `>=`: a heartbeat exactly as old as the lifetime
    // is still inside it. Pinned from both sides so the comparison cannot be
    // loosened or tightened by one without failing.
    expect(grade({ observedAt: after(DEFAULT_OBSERVATION_LIFETIME_SECONDS) })).toBe("active");
    expect(grade({ observedAt: after(DEFAULT_OBSERVATION_LIFETIME_SECONDS + 1) })).toBe("unknown");
  });

  it("ages against the declared lifetime rather than the default", () => {
    // A fence that declares its own lifetime is what a repository with a
    // heavier single operation uses, so the declaration has to be the value
    // compared against — not the default beside it.
    expect(grade({ observationLifetimeSeconds: 30, observedAt: after(31) })).toBe("unknown");
    expect(grade({ observationLifetimeSeconds: 30, observedAt: after(30) })).toBe("active");
    expect(grade({ observationLifetimeSeconds: 100_000, observedAt: after(99_999) })).toBe("active");
  });

  it("never ages active into anything but unknown", () => {
    // Timeout never proves termination. Every expiry above and below reaches
    // exactly one grade, and it is not `paused` and not a terminal claim.
    const expired = grade({ observedAt: after(DEFAULT_OBSERVATION_LIFETIME_SECONDS + 1) });
    expect(expired).toBe("unknown");
    expect(expired).not.toBe("paused");
  });

  it("reports unknown when the journal names no activity for this fence", () => {
    // Two shapes of the same absence: no entry at all, and an entry belonging
    // to a superseded fence. A superseded `active` is another task's word.
    expect(grade({ lastObservedActivity: undefined })).toBe("unknown");
    expect(grade({ lastObservedActivity: { activity: "active", fence: FENCE - 1 } })).toBe("unknown");
    // Including a superseded `paused`, which must not be read as this fence's
    // clean end.
    expect(grade({ lastObservedActivity: { activity: "paused", fence: FENCE - 1 } })).toBe("unknown");
  });

  it("reports unknown when the heartbeat is unreadable or belongs to another fence", () => {
    expect(grade({ observation: undefined })).toBe("unknown");
    expect(grade({ observation: { fence: FENCE - 1, observedAt: START } })).toBe("unknown");
    expect(grade({ observation: { fence: FENCE + 1, observedAt: START } })).toBe("unknown");
  });

  it("reports unknown when either instant is unreadable", () => {
    // An unparsable instant yields NaN, and NaN must read as expired rather
    // than as "not greater than the lifetime", which is what a bare `>` does.
    expect(grade({ observation: { fence: FENCE, observedAt: "not-an-instant" } })).toBe("unknown");
    expect(grade({ observedAt: "2026-08-30 12:00:00" })).toBe("unknown");
  });

  it("leaves a trusted clean end unaged however old it is", () => {
    // `paused` is evidence the session-end hook produced. No elapsed clock may
    // manufacture it and none may erase it.
    expect(
      grade({
        lastObservedActivity: { activity: "paused", fence: FENCE },
        observedAt: after(DEFAULT_OBSERVATION_LIFETIME_SECONDS * 100),
      }),
    ).toBe("paused");
  });

  it("leaves a pending cancellation and an existing unknown alone", () => {
    expect(
      grade({
        lastObservedActivity: { activity: "cancellation_pending", fence: FENCE },
        observedAt: after(DEFAULT_OBSERVATION_LIFETIME_SECONDS + 1),
      }),
    ).toBe("cancellation_pending");
    expect(
      grade({
        lastObservedActivity: { activity: "unknown", fence: FENCE },
        observedAt: after(DEFAULT_OBSERVATION_LIFETIME_SECONDS + 1),
      }),
    ).toBe("unknown");
  });

  it("does not age at all when no workspace is bound", () => {
    // With no workspace there is no declared lifetime and no heartbeat to age;
    // the journal's own last word stands. This is the pre-binding case the
    // status model reads before the first fence is minted.
    expect(
      grade({
        observationLifetimeSeconds: undefined,
        observation: undefined,
        observedAt: after(DEFAULT_OBSERVATION_LIFETIME_SECONDS * 100),
      }),
    ).toBe("active");
  });
});
