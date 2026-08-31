/**
 * The frozen state and event vocabulary, verbatim from the plan's State and
 * Authority Model. These assertions ARE the freeze: any edit to a list, a
 * journal home, an active/reserved status, or the observation-only exemption
 * set is a spine contract revision and must go through contract-freeze owner
 * approval — this suite exists to make such an edit impossible to land
 * silently.
 */
import { describe, expect, it } from "vitest";
import {
  DELIVERY_STATES,
  EVENT_VOCABULARY,
  HOST_ACTIVITY_STATES,
  INTAKE_STATES,
  JOURNALS,
  OBSERVATION_ONLY_KINDS,
  SUSPENDED_DELIVERY_STATES,
  TERMINAL_DELIVERY_STATES,
  classifyEventKind,
} from "./vocabulary.ts";

describe("the frozen journals", () => {
  it("are exactly intake, delivery, maintenance", () => {
    expect([...JOURNALS]).toEqual(["intake", "delivery", "maintenance"]);
  });
});

describe("the frozen intake state list", () => {
  it("is verbatim", () => {
    expect([...INTAKE_STATES]).toEqual([
      "draft_scope",
      "awaiting_clarification",
      "awaiting_confirmation",
      "validating_acceptance",
      "accepted_contract",
      "blocked",
      "abandoned",
    ]);
  });
});

describe("the frozen delivery state list", () => {
  it("is verbatim, including the dead `failed` discriminator", () => {
    expect([...DELIVERY_STATES]).toEqual([
      "accepted",
      "preparing",
      "planning",
      "implementing",
      "validating",
      "remediating",
      "reviewing",
      "compounding",
      "admitting",
      "recording",
      "ready",
      "awaiting_approval",
      "acting",
      "completed",
      "blocked",
      "security_blocked",
      "cancellation_requested",
      "action_succeeded_verification_failed",
      "cancelled",
      "failed",
    ]);
  });

  it("classifies the suspended-or-terminal variants verbatim", () => {
    expect([...SUSPENDED_DELIVERY_STATES]).toEqual([
      "blocked",
      "security_blocked",
      "cancellation_requested",
      "awaiting_approval",
      "action_succeeded_verification_failed",
    ]);
    expect([...TERMINAL_DELIVERY_STATES]).toEqual(["completed", "cancelled", "failed"]);
  });
});

describe("the frozen host-activity marker list", () => {
  it("is verbatim, and is not a delivery state list", () => {
    expect([...HOST_ACTIVITY_STATES]).toEqual(["active", "paused", "unknown", "cancellation_pending"]);
    for (const activity of HOST_ACTIVITY_STATES) {
      if (activity === "cancellation_pending") continue; // marker-only spelling
      expect(DELIVERY_STATES.includes(activity as never)).toBe(false);
    }
  });
});

const activePairs = EVENT_VOCABULARY.filter((entry) => entry.status === "active");
const reservedPairs = EVENT_VOCABULARY.filter((entry) => entry.status === "reserved");
const kindsIn = (journal: string, status: "active" | "reserved"): string[] =>
  EVENT_VOCABULARY.filter((entry) => entry.journal === journal && entry.status === status)
    .map((entry) => entry.kind)
    .sort();

describe("the frozen event-kind vocabulary", () => {
  it("enumerates the intake journal's active kinds verbatim", () => {
    // The iterative-intake unit defined its two reserved kinds out of
    // reservation — the sanctioned per-tranche path.
    expect(kindsIn("intake", "active")).toEqual(
      ["intake.state.changed", "operator.confirmation.recorded", "intake.clarification.recorded", "intake.draft.recorded"].sort(),
    );
  });

  it("enumerates the delivery journal's active kinds verbatim", () => {
    expect(kindsIn("delivery", "active")).toEqual(
      [
        "delivery.registered",
        "workspace.bound",
        "invocation.fenced",
        "activity.observed",
        "operator.confirmation.recorded",
        "approval.request.recorded",
        "operation.result.recorded",
        "workspace.disposition.recorded",
        "transition.committed",
        "stage.result.recorded",
        "attempt.artifact.recorded",
        "evidence.reference.recorded",
        "candidate.recaptured",
        "approval.assertion.consumed",
        "policy.snapshot.bound",
        "generation.pinned",
        "trust.epoch.observed",
        "blocker.recorded",
        "finish.line.recorded",
        // Defined out of reservation by the trusted host lifecycle
        // integration — the sanctioned per-tranche path.
        "termination.provenance.recorded",
        // Defined out of reservation by the amendment/waiver admission unit —
        // the same sanctioned path: the pair was enumerated with that owner
        // from the start, and its payload is now frozen in `journal.ts`.
        "contract.amended",
        // Defined out of reservation by the merge-ready finish-line unit, on
        // the same path: the post-action payloads are now frozen in
        // `journal.ts`, and the external-actions unit extends them.
        "action.intent.recorded",
        "action.result.recorded",
      ].sort(),
    );
  });

  it("enumerates the reserved kinds with their owning journals verbatim", () => {
    expect(kindsIn("intake", "reserved")).toEqual([]);
    expect(kindsIn("delivery", "reserved")).toEqual(["control.plane.mirror.recorded"]);
    expect(kindsIn("maintenance", "reserved")).toEqual([]);
    // Both maintenance families are now defined by their owning units: the
    // maintenance lane and the retention/export/deletion contract family.
    expect(kindsIn("maintenance", "active")).toEqual(["maintenance.action.recorded", "retention.action.recorded"]);
  });

  it("counts 29 active and 1 reserved (journal, kind) pairs", () => {
    expect(activePairs.length).toBe(29);
    expect(reservedPairs.length).toBe(1);
  });

  it("homes operator.confirmation.recorded in exactly two journals — the vocabulary is keyed by (journal, kind) pairs", () => {
    const homes = EVENT_VOCABULARY.filter((entry) => entry.kind === "operator.confirmation.recorded");
    expect(homes.map((entry) => entry.journal).sort()).toEqual(["delivery", "intake"]);
    for (const home of homes) expect(home.status).toBe("active");
  });

  it("freezes the observation-only exemption to exactly three kinds", () => {
    expect([...OBSERVATION_ONLY_KINDS]).toEqual([
      "activity.observed",
      "trust.epoch.observed",
      "control.plane.mirror.recorded",
    ]);
    for (const entry of EVENT_VOCABULARY) {
      expect(entry.observationOnly, `${entry.journal}/${entry.kind}`).toBe(
        OBSERVATION_ONLY_KINDS.includes(entry.kind as never) && entry.journal === "delivery",
      );
    }
  });

  it("is deeply frozen — the vocabulary cannot be extended at runtime", () => {
    expect(Object.isFrozen(EVENT_VOCABULARY)).toBe(true);
    for (const entry of EVENT_VOCABULARY) expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe("classifyEventKind", () => {
  it("classifies an enumerated active pair as active, with its observation-only bit", () => {
    expect(classifyEventKind("delivery", "transition.committed")).toEqual({
      status: "active",
      observationOnly: false,
    });
    expect(classifyEventKind("delivery", "activity.observed")).toEqual({
      status: "active",
      observationOnly: true,
    });
    expect(classifyEventKind("intake", "operator.confirmation.recorded")).toEqual({
      status: "active",
      observationOnly: false,
    });
    expect(classifyEventKind("delivery", "operator.confirmation.recorded")).toEqual({
      status: "active",
      observationOnly: false,
    });
  });

  it("classifies an enumerated reserved pair as reserved — even the observation-only mirror kind", () => {
    expect(classifyEventKind("delivery", "control.plane.mirror.recorded")).toEqual({ status: "reserved" });
  });

  it("classifies the retention kind as active in the maintenance journal only", () => {
    expect(classifyEventKind("maintenance", "retention.action.recorded")).toEqual({
      status: "active",
      observationOnly: false,
    });
    expect(classifyEventKind("delivery", "retention.action.recorded")).toEqual({
      status: "unknown",
      knownIn: ["maintenance"],
    });
  });

  it("classifies a kind outside the enumeration as unknown", () => {
    expect(classifyEventKind("delivery", "delivery.invented")).toEqual({ status: "unknown", knownIn: [] });
  });

  it("classifies a known kind in the wrong journal as unknown — pairs, not a kind→journal map", () => {
    expect(classifyEventKind("maintenance", "delivery.registered")).toEqual({
      status: "unknown",
      knownIn: ["delivery"],
    });
    expect(classifyEventKind("maintenance", "operator.confirmation.recorded")).toEqual({
      status: "unknown",
      knownIn: ["intake", "delivery"],
    });
  });
});
