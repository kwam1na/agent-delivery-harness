import { describe, expect, it } from "vitest";
import { digestCanonical, sha256Hex } from "../digest.ts";
import { createCollector } from "./grammar.ts";
import { retainedCheckOutput, validateChecksPassed } from "./checks-passed.ts";

function fixture() {
  const provider = { id: "check.tests", runId: "run-1", finalPassId: "pass-1" };
  const outputs = [{ path: "result.txt", sha256: sha256Hex("passed") }];
  const binding = { definitionDigest: "a".repeat(64), validationDigest: "b".repeat(64), policyDigest: "c".repeat(64), wiringFingerprint: "d".repeat(64), outputsDigest: digestCanonical(outputs) };
  const payload = { verdict: "green", exitCode: 0, binding };
  const artifactContents = new Map([
    ["check-output-0.json", JSON.stringify({ path: "result.txt", base64: Buffer.from("passed").toString("base64") })],
    ["check-result.json", JSON.stringify({ providerId: provider.id, runId: provider.runId, finalPassId: provider.finalPassId, ...payload })],
  ]);
  const artifacts = [...artifactContents].map(([path, contents], index) => ({ path, sha256: sha256Hex(contents), role: path === "check-result.json" ? "check-result" : "check-output", index }));
  const context = { config: { providers: [{ ...provider, findingCodes: [], check: { command: ["check"] as [string], timeoutMs: 1000, outputs: ["result.txt"] } }] }, prepared: true, currentCandidate: {}, checkBindings: { "check.tests": binding }, artifactContents };
  return { provider, payload, artifacts, context };
}

describe("checks.passed/1", () => {
  it("accepts only the matching terminal outcome and retained output bytes", () => {
    const f = fixture(), collector = createCollector();
    validateChecksPassed(f.payload, "/payload", f.provider, f.artifacts, f.context, collector);
    expect(collector.list()).toEqual([]);
  });
  it.each(["missing-binding", "stale-binding", "missing-output", "altered-output", "wrong-run", "parent-skip", "exit-failure"])("rejects %s", mode => {
    const f = fixture(), collector = createCollector();
    let payload: Record<string, unknown> = f.payload;
    if (mode === "missing-binding") f.context.checkBindings = {} as typeof f.context.checkBindings;
    if (mode === "stale-binding") payload = { ...f.payload, binding: { ...f.payload.binding, policyDigest: "e".repeat(64) } };
    if (mode === "missing-output") f.context.artifactContents.delete("check-output-0.json");
    if (mode === "altered-output") f.context.artifactContents.set("check-output-0.json", JSON.stringify({ path: "result.txt", base64: Buffer.from("changed").toString("base64") }));
    if (mode === "wrong-run") f.provider.runId = "another-run";
    if (mode === "parent-skip") payload = { ...f.payload, parentPassed: true };
    if (mode === "exit-failure") payload = { ...f.payload, exitCode: 1 };
    validateChecksPassed(payload, "/payload", f.provider, f.artifacts, f.context, collector);
    expect(collector.list().length).toBeGreaterThan(0);
  });
  it("rejects malformed retained encodings and mismatched output paths", () => {
    expect(() => retainedCheckOutput(new Map([["check-output-0.json", '{"path":"other","base64":"cGFzc2Vk"}']]), "result.txt", 0)).toThrow();
    expect(() => retainedCheckOutput(new Map([["check-output-0.json", '{"path":"result.txt","base64":"not!base64"}']]), "result.txt", 0)).toThrow();
  });
});
