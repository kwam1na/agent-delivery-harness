import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateRunEventInput } from "@agent-delivery-harness/kernel";

const prose = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\s+/g, " ");

describe("delivery completion guidance", () => {
  it("keeps a run open through the authorized finish line and links terminal continuations", () => {
    const instructions = prose("../AGENTS.md");
    for (const rule of [
      "Keep the run open until the authorized finish line is confirmed.",
      'Under `baseMovement: "stale"`, settle base movement before ending the run:',
      "For an authorized merge, confirm the merge before emitting `run.ended`.",
      "`run.ended` is terminal; no append can reopen it.",
      "start a second version-2 run with `predecessorRunId` naming the ended run",
    ]) expect(instructions).toContain(rule);
    const payload = { host: "codex", workflow: { releaseId: "test", profile: "linear" }, predecessorRunId: "run-previous" };
    const event = {
      version: "run-event/2", eventId: "start", runId: "run-next", at: "2026-09-10T00:00:00Z",
      repo: { commonDir: "/tmp/repo" }, actor: { role: "executor" }, attestation: "self",
      kind: "run.started", payload,
    };
    expect(validateRunEventInput(event).ok).toBe(true);
    expect(validateRunEventInput({ ...event, payload: { ...payload, predecessor: "run-previous" } }).ok).toBe(false);
  });

  it("makes the deliberately narrow record and event surfaces explicit", () => {
    const progress = prose("run-progress.md");
    expect(progress).toContain("`run.ended` deliberately carries only `result` and `cost`");
    expect(progress).toContain("Record the confirmed finish line and merge commit in `decision.recorded` before `run.ended`");
    expect(progress).toContain("`gate.reported` is required by completeness only when the journal has no CLI `command.completed` entries");
    expect(prose("run-view.md")).toContain("Changed-entry and relevant-line figures are narration only in plain `review-context` output");
  });

  it("confirms the merge explicitly and identifies the recorded base field", () => {
    const runbook = prose("delivery-runbook.md");
    expect(runbook).toContain("gh pr view <n> --json state,mergedAt,mergeCommit,url");
    expect(runbook).toContain("candidateBinding.baseTipSha");
    expect(runbook).toContain("An empty successful merge response is not a reason to repeat the merge");
  });
});
