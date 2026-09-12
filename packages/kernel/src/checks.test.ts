import { describe, expect, it } from "vitest";
import { captureScopedCheckInputs, type ScopedInputCapturePorts } from "./checks.ts";
import { digestCanonical } from "./digest.ts";
import { selectScopedCheckAttempt } from "./evaluator.ts";
import type { ScopedCheckAttempt } from "./records.types.ts";
import { isScopedCheckDefinition } from "./config.ts";

const definition = { version: "scoped-check/1" as const, files: ["src/app.ts", "optional.json"], memberships: ["tests/"], tests: ["tests/app.test.ts"], cwd: ".", profile: "local", environment: [{ name: "FEATURE", kind: "flag" as const }, { name: "TOKEN", kind: "credential" as const }] };
function capture(files: Record<string, string>, environment = { FEATURE: "on", TOKEN: "sentinel-secret" }, credentialIdentity: string | null = "account-revision-1", overrides: Partial<ScopedInputCapturePorts> = {}) {
  return captureScopedCheckInputs(definition, {
    command: ["test", "app"], timeoutMs: 1000, runtimeDigest: digestCanonical("node22"), dependencyDigest: digestCanonical("lock"), policyDigest: digestCanonical("policy"), releaseDigest: digestCanonical("release"),
    listFiles: async () => Object.keys(files), readFile: async p => files[p] === undefined ? null : Buffer.from(files[p]), environment,
    credentialIdentity: () => credentialIdentity, ...overrides,
  });
}
describe("scoped input capture", () => {
  const files = { "src/app.ts": "app", "tests/app.test.ts": "test", "docs/report.html": "report" };
  it("ignores unrelated reports but binds bytes, absence and membership", async () => {
    const original = await capture(files);
    expect(await capture({ ...files, "docs/report.html": "changed" })).toEqual(original);
    for (const changed of [{ ...files, "src/app.ts": "changed" }, { ...files, "optional.json": "present" }, { ...files, "tests/new.test.ts": "new" }]) {
      expect((await capture(changed)).inputDigest).not.toBe(original.inputDigest);
    }
    const removed = { ...files }; delete (removed as Record<string, string>)["tests/app.test.ts"];
    await expect(capture(removed)).rejects.toThrow(/test/);
  });
  it("captures flags and credential presence without retaining credential values or hashes", async () => {
    const original = await capture(files);
    expect(JSON.stringify(original)).not.toContain("sentinel-secret");
    expect((await capture(files, { FEATURE: "off", TOKEN: "sentinel-secret" })).inputDigest).not.toBe(original.inputDigest);
    expect((await capture(files, { FEATURE: "on", TOKEN: "" })).inputDigest).not.toBe(original.inputDigest);
    expect((await capture(files, undefined, null)).reusable).toBe(false);
    await expect(capture(files, undefined, "sentinel-secret")).rejects.toThrow(/nonsecret/);
  });
  it("refuses unsupported scope versions and malformed declarations", () => {
    expect(isScopedCheckDefinition(definition)).toBe(true);
    for (const patch of [{ version: "scoped-check/2" }, { files: ["../outside"] }, { memberships: ["tests"] }, { tests: ["/absolute"] }, { cwd: ".." }, { environment: [{ name: "TOKEN", kind: "secret-value" }] }, { unknown: true }]) expect(isScopedCheckDefinition({ ...definition, ...patch })).toBe(false);
  });
  it.each(["runtimeDigest", "dependencyDigest", "policyDigest", "releaseDigest", "command", "timeoutMs"] as const)("binds %s independently", async key => {
    const changed = key === "command" ? ["another-test"] : key === "timeoutMs" ? 2000 : digestCanonical("changed");
    expect((await capture(files, undefined, undefined, { [key]: changed })).inputDigest).not.toBe((await capture(files)).inputDigest);
  });
});

describe("scoped attempt fencing", () => {
  const attempt = (generation: number, status: ScopedCheckAttempt["status"]): ScopedCheckAttempt => ({ version: "scoped-attempt/1", providerId: "app", attemptId: `attempt-${generation}`, generation, status, inputDigest: "a".repeat(64), profileDigest: "b".repeat(64), origin: { runId: "run-1", candidate: { treeSha: "a".repeat(40), deliverableDigest: "a".repeat(64), identityToken: "v1", baseRef: "main", baseTipSha: "b".repeat(40), mergeBaseSha: "b".repeat(40), workspaceId: "workspace" } } });
  const select = (attempts: ScopedCheckAttempt[]) => selectScopedCheckAttempt("app", "a".repeat(64), "b".repeat(64), attempts);
  it("retains newer failure over an older pass regardless of completion order", () => {
    expect(select([attempt(2, "failed"), attempt(1, "passed")])?.status).toBe("failed");
    expect(select([attempt(2, "failed"), attempt(3, "passed"), attempt(1, "passed")])?.generation).toBe(3);
    expect(select([attempt(1, "passed"), { ...attempt(2, "failed"), providerId: "docs" }])?.status).toBe("passed");
    expect(select([attempt(1, "passed"), attempt(2, "running")])?.status).toBe("running");
  });
  it("refuses conflicting generations", () => {
    expect(() => select([attempt(1, "passed"), { ...attempt(1, "failed"), attemptId: "another" }])).toThrow(/generation/);
  });
});
