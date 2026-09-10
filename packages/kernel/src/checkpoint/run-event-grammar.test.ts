import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_KINDS,
  RUN_EVENT_KINDS_V1,
  RUN_EVENT_SPEC,
  RUN_EVENT_SPEC_V2,
  describeRunEventPayload,
  validateRunEvent,
  type RunEventKind,
  type RunEventVersion,
  type SpineRejection,
} from "../index.ts";

function event(kind: RunEventKind, version: RunEventVersion, payload: Record<string, unknown>): unknown {
  return {
    version,
    ...(version === RUN_EVENT_SPEC_V2 ? { eventId: "grammar-probe" } : {}),
    runId: "run-grammar-probe",
    seq: 1,
    at: "2026-09-10T00:00:00Z",
    repo: { commonDir: "/tmp/repo/.git" },
    kind,
    actor: { role: "executor" },
    ...(typeof payload["ticket"] === "string" ? { ticket: payload["ticket"] } : {}),
    ...(typeof payload["candidateTreeSha"] === "string" ? { candidateTreeSha: payload["candidateTreeSha"] } : {}),
    attestation: "self",
    payload,
  };
}

function rejections(value: unknown): readonly SpineRejection[] {
  const verdict = validateRunEvent(value);
  if (verdict.ok) throw new Error("grammar probe unexpectedly passed");
  return verdict.rejections;
}

describe("run-event payload grammar discovery", () => {
  for (const [version, kinds] of [
    [RUN_EVENT_SPEC, RUN_EVENT_KINDS_V1],
    [RUN_EVENT_SPEC_V2, RUN_EVENT_KINDS],
  ] as const) {
    it(`derives every ${version} member and requiredness from the validator's active table`, () => {
      for (const kind of kinds) {
        const grammar = describeRunEventPayload(kind, version);
        expect(grammar, `${version} ${kind}`).toBeDefined();
        const members = grammar!.members.map(member => member.name);
        expect(new Set(members).size, `${version} ${kind} has duplicate grammar members`).toBe(members.length);

        const empty = rejections(event(kind, version, {}));
        const missing = empty
          .filter(rejection => rejection.code === "missing_member" && rejection.pointer.startsWith("/payload/") &&
            !rejection.pointer.slice("/payload/".length).includes("/"))
          .map(rejection => rejection.pointer.slice("/payload/".length));
        expect(missing.sort(), `${version} ${kind} requiredness`).toEqual(
          grammar!.members.filter(member => member.required).map(member => member.name).sort(),
        );

        const unknown = rejections(event(kind, version, { __unknown: true }))
          .find(rejection => rejection.code === "unknown_member" && rejection.pointer === "/payload/__unknown");
        expect(unknown?.message, `${version} ${kind} accepted set`).toContain(`accepted members: ${members.join(", ")}`);

        for (const member of grammar!.members) {
          if (member.values === undefined) continue;
          const malformed = rejections(event(kind, version, { [member.name]: "__not_in_vocabulary__" }))
            .find(rejection => rejection.code === "malformed_member" && rejection.pointer === `/payload/${member.name}`);
          expect(malformed?.message, `${version} ${kind}.${member.name}`).toBe(
            `${member.name} accepts only: ${member.values.join(", ")}`,
          );
        }
      }
    });
  }

  it("does not project unknown kinds or v2-only kinds into version 1", () => {
    expect(describeRunEventPayload("unknown.kind", RUN_EVENT_SPEC_V2)).toBeUndefined();
    expect(describeRunEventPayload("activity.observed", RUN_EVENT_SPEC)).toBeUndefined();
  });

  it("does not expose the validator's closed vocabulary arrays to consumer mutation", () => {
    const expected = ["queued", "running", "waiting", "completed", "failed", "interrupted"];
    const grammar = describeRunEventPayload("activity.observed", RUN_EVENT_SPEC_V2)!;
    const values = grammar.members.find(member => member.name === "state")!.values! as string[];
    const original = values[0]!;
    try {
      values[0] = "consumer-mutated";
      expect(describeRunEventPayload("activity.observed", RUN_EVENT_SPEC_V2)!.members
        .find(member => member.name === "state")!.values).toEqual(expected);
      expect(validateRunEvent(event("activity.observed", RUN_EVENT_SPEC_V2, {
        activityId: "review",
        attemptId: "attempt-1",
        candidateTreeSha: "a".repeat(40),
        state: "queued",
        owner: "codex",
        phase: "review",
      }))).toEqual({ ok: true });
    } finally {
      values[0] = original;
    }
  });
});
