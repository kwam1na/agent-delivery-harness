import { expect, it } from "vitest";
import { projectRunActivities } from "./run-activity.ts";
import { validateRunEvent, type RunEvent } from "./run-event.ts";

const tree = "a".repeat(40);
function step(seq: number, state: string, candidateTreeSha = tree): RunEvent {
  return { version: "run-event/2", eventId: `step-${seq}`, runId: "run-example", seq,
    at: "2026-09-07T12:00:00Z", repo: { commonDir: "/repo/.git" }, actor: { role: "executor" }, attestation: "self",
    kind: "finish.step.observed", candidateTreeSha,
    payload: { stepId: "merge", candidateTreeSha, name: "Merge", state, owner: "executor" } };
}

it("projects the latest finish-step state for its candidate without an activity attempt", () => {
  const events = [step(1, "pending"), step(2, "completed"), step(3, "pending", "b".repeat(40))];
  expect(events.map(event => validateRunEvent(event).ok)).toEqual([true, true, true]);
  const projected = projectRunActivities(events, { now: events[0]!.at, currentCandidateTreeSha: tree });
  expect(projected.finishSteps.map(item => item.current)).toEqual([false, true, false]);
  expect(projected.finishSteps[1]?.payload["state"]).toBe("completed");
  expect(projected.activities).toEqual([]);
});
