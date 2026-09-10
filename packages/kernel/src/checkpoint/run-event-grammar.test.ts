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
          const invalid = validateRunEvent(event(kind, version, { [member.name]: "__not_in_vocabulary__" }));
          const malformed = (invalid.ok ? [] : invalid.rejections)
            .find(rejection => rejection.code === "malformed_member" && rejection.pointer === `/payload/${member.name}`);
          const prefix = `${member.name} accepts only: `;
          const expected = malformed?.message.startsWith(prefix)
            ? malformed.message.slice(prefix.length).split(", ") : undefined;
          // Ask the validator first: missing descriptor metadata must not skip
          // the very assertion that would observe its absence.
          expect(member.values, `${version} ${kind}.${member.name}`).toEqual(expected);
          for (const accepted of expected ?? []) {
            const verdict = validateRunEvent(event(kind, version, { [member.name]: accepted }));
            const rejectedMember = verdict.ok ? [] : verdict.rejections.filter(rejection =>
              rejection.code === "malformed_member" && rejection.pointer === `/payload/${member.name}`);
            expect(rejectedMember, `${kind}.${member.name} accepts ${accepted}`).toEqual([]);
          }
        }
      }
    });
  }

  it("does not project unknown kinds or v2-only kinds into version 1", () => {
    expect(describeRunEventPayload("unknown.kind", RUN_EVENT_SPEC_V2)).toBeUndefined();
    expect(describeRunEventPayload("activity.observed", RUN_EVENT_SPEC)).toBeUndefined();
  });

  const nestedTables = [
    { kind: "command.completed", member: "preparation", value: { checks: "executed", reason: "ordinary" }, members: ["checks", "reason"], required: "checks" },
    { kind: "run.started", member: "workflow", value: { releaseId: "test", profile: "core" }, members: ["releaseId", "profile"], required: "releaseId" },
    { kind: "run.ended", member: "cost", value: { unit: "usd", total: 1, reportedBy: "host" }, members: ["unit", "total", "reportedBy", "coverage"], required: "reportedBy" },
    { kind: "run.ended", member: "cost", value: { coverage: "unreported", reportedBy: "host" }, members: ["coverage", "reportedBy"], required: "reportedBy" },
    { kind: "review.round.closed", member: "findings", value: { P0: 0, P1: 0, P2: 0, P3: 0 }, members: ["P0", "P1", "P2", "P3"], required: "P0" },
    { kind: "context.saved", member: "contract", value: { objective: "deliver", finishLine: "merged", acceptanceCriteria: ["checks pass"] }, members: ["objective", "finishLine", "acceptanceCriteria"], required: "objective" },
    { kind: "context.saved", member: "candidateBinding", value: { deliverableDigest: "a".repeat(64), identity: "tree/1", baseRef: "main", baseTipSha: "b".repeat(40), mergeBaseSha: "c".repeat(40), workspaceId: "repo" }, members: ["deliverableDigest", "identity", "baseRef", "baseTipSha", "mergeBaseSha", "workspaceId"], required: "identity" },
    { kind: "context.saved", member: "release", value: { runtimeVersion: "1", releaseId: "test", profile: "core", archiveSha256: "a".repeat(64) }, members: ["runtimeVersion", "releaseId", "profile", "archiveSha256"], required: "releaseId" },
    { kind: "ticket.read", member: "repo", envelope: true, value: { commonDir: "/tmp/repo/.git" }, members: ["commonDir", "remote"], required: "commonDir" },
    { kind: "ticket.read", member: "actor", envelope: true, value: { role: "executor" }, members: ["role", "id"], required: "role" },
  ] as const;

  it.each(nestedTables)("identifies the active $kind.$member table on missing and unknown members ($required)", fixture => {
    const pointer = `${"envelope" in fixture ? "" : "/payload"}/${fixture.member}`;
    const make = (value: Record<string, unknown>): unknown => {
      const base = event(fixture.kind, RUN_EVENT_SPEC_V2, "envelope" in fixture ? {} : { [fixture.member]: value });
      return "envelope" in fixture ? { ...base as Record<string, unknown>, [fixture.member]: value } : base;
    };
    // The valid nested value survives independently of unrelated missing
    // payload members in these minimal event probes.
    const valid = validateRunEvent(make(fixture.value));
    expect(valid.ok ? [] : valid.rejections.filter(item => item.pointer.startsWith(`${pointer}/`))).toEqual([]);
    const missing: Record<string, unknown> = { ...fixture.value };
    delete missing[fixture.required];
    for (const [value, code, member] of [
      [missing, "missing_member", fixture.required],
      [{ ...fixture.value, invented: true }, "unknown_member", "invented"],
    ] as const) {
      const rejection = rejections(make(value)).find(item => item.code === code && item.pointer === `${pointer}/${member}`);
      expect(rejection?.message).toContain(`accepted members: ${fixture.members.join(", ")}`);
      expect(rejection?.message.match(/accepted members:/g)).toHaveLength(1);
    }
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
