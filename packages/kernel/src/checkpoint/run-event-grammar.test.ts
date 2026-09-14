import { describe, expect, it } from "vitest";
import {
  RUN_CANDIDATE_TREE_SHA,
  RUN_EVENT_KINDS,
  RUN_EVENT_KINDS_V1,
  RUN_EVENT_SPEC,
  RUN_EVENT_SPEC_V2,
  RUN_PROVIDER_ID,
  RUN_STORE_ID,
  RUN_TICKET,
  describeRunEventPayload,
  validateRunEvent,
  type RunEventKind,
  type RunEventValueGrammar,
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

/**
 * V26-2058 / V26-2039. Member names and requiredness alone left a caller
 * guessing at value types, nested shapes and vocabularies, so every payload
 * below is constructed from what `runs grammar` publishes and nothing else.
 * The examples are validator-checked rather than hand-maintained prose: a
 * described example that stops being emittable fails here.
 */
describe("run-event payload grammar types and examples", () => {
  const VALUE_TYPES = ["string", "number", "boolean", "array", "object"];

  /** The JSON type of a published example, in the vocabulary `type` publishes. */
  function jsonTypeOf(value: unknown): string {
    if (Array.isArray(value)) return "array";
    if (value !== null && typeof value === "object") return "object";
    return typeof value;
  }

  /** The described member of a kind's v2 table, by name. */
  function member(kind: RunEventKind, name: string): () => RunEventValueGrammar {
    return () => describeRunEventPayload(kind, RUN_EVENT_SPEC_V2)!.members.find(item => item.name === name)!;
  }

  /** The described member of one variant of a kind's v2 table. */
  function variantMember(kind: RunEventKind, name: string, variant: number, nested: string): RunEventValueGrammar {
    return member(kind, name)().variants![variant]!.members!.find(item => item.name === nested)!;
  }

  function walk(value: RunEventValueGrammar, visit: (value: RunEventValueGrammar) => void): void {
    visit(value);
    for (const member of value.members ?? []) walk(member, visit);
    if (value.items !== undefined) walk(value.items, visit);
    for (const variant of value.variants ?? []) walk(variant, visit);
  }

  for (const [version, kinds] of [
    [RUN_EVENT_SPEC, RUN_EVENT_KINDS_V1],
    [RUN_EVENT_SPEC_V2, RUN_EVENT_KINDS],
  ] as const) {
    it(`types every ${version} member and publishes an emittable minimal example`, () => {
      for (const kind of kinds) {
        const grammar = describeRunEventPayload(kind, version)!;
        expect(grammar.spec, `${version} ${kind} spec`).toBe("run-event-payload-grammar/2");
        for (const entry of grammar.members) {
          walk(entry, described => {
            expect(VALUE_TYPES, `${version} ${kind}.${entry.name} type`).toContain(described.type);
            expect(described.constraint.length, `${version} ${kind}.${entry.name} constraint`).toBeGreaterThan(0);
            // The published type is checked against the published example rather
            // than against a list of type names: every example below is emitted
            // through the validator, so a type that stops matching the value the
            // validator accepts is a type that stops being true.
            expect(jsonTypeOf(described.example), `${version} ${kind}.${entry.name} type vs its own example`)
              .toBe(described.type);
          });
        }
        // The published minimal example carries every required member, nothing
        // the table does not define, and — for the one kind whose combination
        // rule demands it — the optional member that makes it emittable. It is
        // accepted by the same validator that refuses everything else.
        const published = Object.keys(grammar.example);
        const required = grammar.members.filter(member => member.required).map(member => member.name);
        expect(required.filter(name => !published.includes(name)), `${version} ${kind} minimal example omits a required member`).toEqual([]);
        expect(published.filter(name => !grammar.members.some(member => member.name === name)), `${version} ${kind} minimal example invents a member`).toEqual([]);
        expect(published.filter(name => !required.includes(name)), `${version} ${kind} minimal example beyond its required members`)
          .toEqual(kind === "report.referenced" ? ["artifactId"] : []);
        expect(validateRunEvent(event(kind, version, grammar.example)), `${version} ${kind} minimal example`).toEqual({ ok: true });

        // Every optional member's own example is emittable beside the rest, so
        // a caller reading one member's example is never reading a value the
        // validator would refuse.
        const complete = Object.fromEntries(grammar.members.map(member => [member.name, member.example]));
        expect(validateRunEvent(event(kind, version, complete)), `${version} ${kind} complete example`).toEqual({ ok: true });
      }
    });

    it(`describes run.started's workflow object and its required members under ${version}`, () => {
      const workflow = describeRunEventPayload("run.started", version)!.members.find(member => member.name === "workflow")!;
      expect(workflow.type).toBe("object");
      expect(workflow.members?.map(member => [member.name, member.required, member.type])).toEqual([
        ["releaseId", true, "string"],
        ["profile", true, "string"],
      ]);
      expect(Object.keys(workflow.example as Record<string, unknown>).sort()).toEqual(["profile", "releaseId"]);
    });

    it(`names run.started's workflow members when a non-object is supplied under ${version}`, () => {
      const refused = rejections(event("run.started", version, { host: "claude-code", workflow: "linear" }))
        .find(rejection => rejection.pointer === "/payload/workflow");
      expect(refused?.code).toBe("not_an_object");
      expect(refused?.message).toContain("accepted members: releaseId, profile");
    });

    it(`types decision.recorded's cited as an optional string under ${version}`, () => {
      const cited = describeRunEventPayload("decision.recorded", version)!.members.find(member => member.name === "cited")!;
      expect(cited).toMatchObject({ required: false, type: "string" });
      expect(cited.values).toBeUndefined();
      expect(typeof cited.example).toBe("string");

      const refused = rejections(event("decision.recorded", version, { fork: "f", choice: "c", cited: ["V26-2058"] }))
        .find(rejection => rejection.pointer === "/payload/cited");
      expect(refused?.code).toBe("malformed_member");
      expect(refused?.message).toContain("expected bounded free text");
    });

    it(`types lens.selected's id arrays and their items under ${version}`, () => {
      const grammar = describeRunEventPayload("lens.selected", version)!;
      for (const name of ["mandated", "selected"]) {
        const member = grammar.members.find(item => item.name === name)!;
        expect(member.type, name).toBe("array");
        expect(member.items?.type, name).toBe("string");
        expect(Array.isArray(member.example), name).toBe(true);
        expect((member.example as readonly unknown[]).length, name).toBeGreaterThan(0);
      }
      expect(grammar.members.find(item => item.name === "rationale")).toMatchObject({ type: "string", required: true });
    });
  }

  it("describes activity.observed's nested round binding and its cost variants", () => {
    const grammar = describeRunEventPayload("activity.observed", RUN_EVENT_SPEC_V2)!;
    expect(grammar.members.find(member => member.name === "round")).toMatchObject({ type: "number", required: false });
    expect(grammar.members.find(member => member.name === "state")).toMatchObject({ type: "string", required: true });
    const cost = grammar.members.find(member => member.name === "cost")!;
    expect(cost.type).toBe("object");
    expect(cost.variants?.map(variant => variant.members?.map(member => member.name))).toEqual([
      ["coverage", "reportedBy"],
      ["unit", "total", "reportedBy", "coverage"],
    ]);
    for (const variant of cost.variants!) {
      expect(validateRunEvent(event("run.ended", RUN_EVENT_SPEC_V2, { result: "complete", cost: variant.example }))).toEqual({ ok: true });
    }
  });

  /**
   * `constraint` is published as the constraint in the validator's own words, so
   * it is pinned against the words the validator actually refuses with rather
   * than against a remembered copy: each probe supplies a value the check
   * rejects and asserts the described constraint restates that refusal.
   */
  it("states each constraint in the words the validator refuses with", () => {
    const probes: readonly {
      readonly kind: RunEventKind;
      readonly payload: Record<string, unknown>;
      readonly pointer: string;
      /** What the published constraint adds after the refusal's own words. */
      readonly extra?: string;
      /** A value the check accepts and one it refuses, for a published pattern with no exported source. */
      readonly sample?: { readonly accepted: string; readonly refused: string };
      /** The shape word the constraint claims, checked against the boundary the check enforces. */
      readonly names?: string;
      readonly describe: () => RunEventValueGrammar;
    }[] = [
      { kind: "activity.observed", payload: { activityId: 5 }, pointer: "/payload/activityId", extra: `, matching ${RUN_STORE_ID.source}`,
        describe: member("activity.observed", "activityId") },
      { kind: "activity.observed", payload: { candidateTreeSha: 5 }, pointer: "/payload/candidateTreeSha", extra: `, matching ${RUN_CANDIDATE_TREE_SHA.source}`,
        describe: member("activity.observed", "candidateTreeSha") },
      { kind: "ticket.read", payload: { ticket: 5, source: "linear" }, pointer: "/payload/ticket", extra: `, matching ${RUN_TICKET.source}`,
        describe: member("ticket.read", "ticket") },
      { kind: "activity.observed", payload: { owner: 5 }, pointer: "/payload/owner", describe: member("activity.observed", "owner") },
      { kind: "decision.recorded", payload: { fork: "f", choice: "c", cited: 5 }, pointer: "/payload/cited", describe: member("decision.recorded", "cited") },
      { kind: "gate.reported", payload: { durationMs: -1 }, pointer: "/payload/durationMs", describe: member("gate.reported", "durationMs") },
      { kind: "activity.observed", payload: { round: 0 }, pointer: "/payload/round", describe: member("activity.observed", "round") },
      { kind: "review.round.opened", payload: { grace: "yes" }, pointer: "/payload/grace", describe: member("review.round.opened", "grace") },
      { kind: "run.ended", payload: { result: "complete", cost: { unit: "u", total: "x", reportedBy: "r" } }, pointer: "/payload/cost/total",
        describe: () => variantMember("run.ended", "cost", 1, "total") },
      { kind: "wait.started", payload: { reference: 5 }, pointer: "/payload/reference", extra: " that parses as an absolute http or https locator",
        describe: member("wait.started", "reference") },
      { kind: "lens.selected", payload: { mandated: 5 }, pointer: "/payload/mandated", describe: member("lens.selected", "mandated") },
      { kind: "lens.selected", payload: { mandated: ["Not An Id"] }, pointer: "/payload/mandated/0", extra: `, matching ${RUN_PROVIDER_ID.source}`,
        describe: () => member("lens.selected", "mandated")().items! },
      { kind: "context.saved", payload: { policyDigest: 5 }, pointer: "/payload/policyDigest", extra: ", matching ^[0-9a-f]{64}$",
        sample: { accepted: "f".repeat(64), refused: "f".repeat(63) }, names: "sha256", describe: member("context.saved", "policyDigest") },
      { kind: "command.completed", payload: { command: "prepare", outcome: "ok", durationMs: 0, digest: 5 }, pointer: "/payload/digest",
        extra: ", matching ^[0-9a-f]{64}$", sample: { accepted: "f".repeat(64), refused: "F".repeat(64) }, names: "sha256",
        describe: member("command.completed", "digest") },
      { kind: "context.saved", payload: { contract: { objective: "o", finishLine: "f", acceptanceCriteria: 5 } },
        pointer: "/payload/contract/acceptanceCriteria",
        describe: () => member("context.saved", "contract")().members!.find(item => item.name === "acceptanceCriteria")! },
    ];

    for (const probe of probes) {
      const refused = rejections(event(probe.kind, RUN_EVENT_SPEC_V2, probe.payload))
        .find(rejection => rejection.pointer === probe.pointer);
      expect(refused?.code, `${probe.kind}${probe.pointer}`).toBe("malformed_member");
      // The refusal's own words, minus its verb, open the published constraint:
      // a constraint that drifts from the check it describes stops matching.
      const stated = refused!.message.replace(/^expected /, "");
      const published = probe.describe().constraint;
      // Equality, not a prefix: the clause a member appends after the refusal
      // words is the only place a CLI-only caller learns the charset or the
      // scheme rule, so it is pinned as tightly as the words themselves. The
      // patterned members spell theirs out of the very pattern the check tests.
      expect(published, `${probe.kind}${probe.pointer}: published "${published}" does not restate refusal "${stated}"`)
        .toBe(`${stated}${probe.extra ?? ""}`);
      if (probe.sample === undefined) continue;
      // The words a digest publishes are a claim about its shape, so they are
      // held to the boundary the check enforces rather than left as prose: the
      // member that stops naming sha256 while refusing everything but 64
      // lowercase hex characters has stopped describing itself.
      expect(published, `${probe.kind}${probe.pointer} names its shape`).toContain(probe.names!);
      // Two patterned members have no exported source to spell the tail from,
      // so the pattern they publish is pinned to the check's own behaviour: it
      // must accept what the validator accepts and refuse what it refuses.
      const publishedPattern = new RegExp(published.slice(`${stated}, matching `.length));
      expect(publishedPattern.test(probe.sample.accepted), `${probe.kind}${probe.pointer} published pattern refuses an accepted value`).toBe(true);
      expect(publishedPattern.test(probe.sample.refused), `${probe.kind}${probe.pointer} published pattern accepts a refused value`).toBe(false);
      const name = probe.pointer.slice("/payload/".length);
      const complete = Object.fromEntries(describeRunEventPayload(probe.kind, RUN_EVENT_SPEC_V2)!.members
        .map(item => [item.name, item.example]));
      expect(validateRunEvent(event(probe.kind, RUN_EVENT_SPEC_V2, { ...complete, [name]: probe.sample.accepted })),
        `${probe.kind}${probe.pointer} accepted sample`).toEqual({ ok: true });
      expect(rejections(event(probe.kind, RUN_EVENT_SPEC_V2, { ...complete, [name]: probe.sample.refused }))
        .some(rejection => rejection.pointer === probe.pointer && rejection.code === "malformed_member"),
      `${probe.kind}${probe.pointer} refused sample`).toBe(true);
    }

    // `oneOf` refuses by naming its vocabulary rather than by restating its
    // constraint, so it is pinned the other way round: the fixed phrase every
    // closed vocabulary publishes, beside the vocabulary the refusal itself
    // names. A constraint that stops saying the value is closed, or a published
    // vocabulary that drifts from the accepted one, fails here.
    const state = member("activity.observed", "state")();
    const refusedState = rejections(event("activity.observed", RUN_EVENT_SPEC_V2, { state: 5 }))
      .find(rejection => rejection.pointer === "/payload/state")!;
    expect(state.constraint, "activity.observed.state constraint").toBe("one of a closed vocabulary");
    expect(refusedState.message, "activity.observed.state vocabulary").toBe(`state accepts only: ${state.values!.join(", ")}`);

    // The locator clause the URL constraint publishes is the clause the check
    // enforces: a non-http scheme and a non-absolute reference are both refused.
    for (const locator of ["javascript:alert(1)", "/relative/path"]) {
      expect(rejections(event("wait.started", RUN_EVENT_SPEC_V2, { waitingOn: "human", scope: "s", reference: locator }))
        .some(rejection => rejection.pointer === "/payload/reference" && rejection.code === "malformed_member"), locator).toBe(true);
    }
  });

  /**
   * A closed nested table publishes `a <member> object`, so each is pinned to
   * the member it actually describes rather than to its length: a constraint
   * that stops naming its own table stops matching here.
   */
  it("names its own table in every closed object's constraint", () => {
    for (const [kind, name] of [
      ["run.started", "workflow"],
      ["context.saved", "contract"],
      ["context.saved", "candidateBinding"],
      ["context.saved", "release"],
      ["review.round.closed", "findings"],
    ] as const) {
      const described = member(kind, name)();
      expect(described.type, `${kind}.${name} type`).toBe("object");
      expect(described.constraint, `${kind}.${name} constraint`).toBe(`a ${name} object`);
      expect(described.members?.length ?? 0, `${kind}.${name} members`).toBeGreaterThan(0);
    }
  });

  /**
   * `preparation`'s reason vocabulary follows its `checks` value, so each arm is
   * pinned the way `cost`'s arms are: its own member names and vocabularies, and
   * its own example emitted through the validator.
   */
  it("describes command.completed's preparation arms and emits each one", () => {
    const preparation = describeRunEventPayload("command.completed", RUN_EVENT_SPEC_V2)!
      .members.find(item => item.name === "preparation")!;
    expect(preparation.type).toBe("object");
    expect(preparation.variants?.map(variant => variant.members?.map(item => item.name))).toEqual([
      ["checks", "reason"],
      ["checks", "reason"],
    ]);
    expect(preparation.variants?.map(variant => variant.members?.find(item => item.name === "reason")?.values)).toEqual([
      ["ordinary", "receipt-not-reusable", "preparation-fingerprint-changed"],
      ["validation-equivalent"],
    ]);
    expect(preparation.variants?.map(variant => (variant.example as Record<string, unknown>)["checks"])).toEqual([
      "executed",
      "reused",
    ]);
    for (const variant of preparation.variants!) {
      expect(validateRunEvent(event("command.completed", RUN_EVENT_SPEC_V2, {
        command: "prepare",
        outcome: "ok",
        durationMs: 0,
        preparation: variant.example,
      })), JSON.stringify(variant.example)).toEqual({ ok: true });
    }
  });

  it("names a nested table's members exactly once when a non-object is supplied", () => {
    const refused = rejections(event("run.started", RUN_EVENT_SPEC_V2, { host: "claude-code", workflow: "linear" }))
      .find(rejection => rejection.pointer === "/payload/workflow")!;
    expect(refused.message.match(/accepted members:/g)).toHaveLength(1);
    expect(refused.message).toContain("accepted members: releaseId, profile");
  });

  it("keeps the described shapes out of reach of consumer mutation", () => {
    const first = describeRunEventPayload("run.started", RUN_EVENT_SPEC_V2)!;
    const workflow = first.members.find(member => member.name === "workflow")!;
    (workflow.example as Record<string, unknown>)["releaseId"] = "consumer-mutated";
    (workflow.members as unknown as { name: string }[])[0]!.name = "consumer-mutated";
    const second = describeRunEventPayload("run.started", RUN_EVENT_SPEC_V2)!.members.find(member => member.name === "workflow")!;
    expect(second.members?.map(member => member.name)).toEqual(["releaseId", "profile"]);
    expect((second.example as Record<string, unknown>)["releaseId"]).not.toBe("consumer-mutated");
  });
});
