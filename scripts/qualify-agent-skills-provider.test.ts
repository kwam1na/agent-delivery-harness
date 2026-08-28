import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_SKILLS_BASELINE,
  HARNESS_BASELINE,
  PROTOCOL_VERSION,
  canonicalQualification,
  qualifyAgentSkillsProvider,
  verifyQualificationInputs,
} from "./qualify-agent-skills-provider.ts";

const root = path.resolve(import.meta.dirname, "..");
const archive = path.join(root, "qualifications/fixtures/agent-skills-core-v1.zip");
const metadata = path.join(root, "qualifications/fixtures/agent-skills-core-v1.release.json");
const checkedRecord = path.join(root, "qualifications/agent-skills-provider-interoperability.json");

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

describe("exact installed provider interoperability", () => {
  it("pins immutable harness, provider, release, and protocol identities", async () => {
    expect(HARNESS_BASELINE).toBe("b7d62db716e335b25e13f1029ee9c3896244e315");
    expect(AGENT_SKILLS_BASELINE).toBe("9ad6a934e97222cd819b8e48b7e258effa89a09e");
    expect(PROTOCOL_VERSION).toBe("delivery-provider-rails/1");
    expect(await sha256(archive)).toBe("0e5a2e536ce104f0c8c7956f373990064ecae709fe287c4504d30f2a4314094f");
    expect(await sha256(metadata)).toBe("9c6f96a9994c0faf6dc84a3d907be60ebd82bb7e5579256c853855010d324d99");
  });

  it("rejects changed immutable inputs in the read-only preflight", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "provider-preflight-"));
    try {
      const changedArchive = path.join(temporary, "changed.zip");
      const bytes = Buffer.from(await readFile(archive));
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      await writeFile(changedArchive, bytes);
      await expect(verifyQualificationInputs({ root, archive: changedArchive, metadata })).rejects.toThrow("immutable input changed.zip differs");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("drives the installed provider and real recorder through every required scenario", { timeout: 30_000 }, async () => {
    const record = await qualifyAgentSkillsProvider({ root, archive, metadata });
    expect(record.summary).toEqual({ passed: 6, failed: 0, result: "passed" });
    expect(record.capabilities).toEqual({
      required: ["create", "read", "update", "search", "relations", "reconciliation"],
      observed: ["create", "read", "update", "search", "relations", "reconciliation"],
    });
    expect(record.scenarios.map((scenario) => [scenario.id, scenario.result])).toEqual([
      ["happy-pinned-run", "passed"],
      ["incompatible-protocol-and-release", "passed"],
      ["provider-crash", "passed"],
      ["cancellation", "passed"],
      ["missing-evidence", "passed"],
      ["stable-rerun", "passed"],
    ]);
    expect(record.evidence.publication).toEqual({ first: "published", reconciled: "idempotent", recordCount: 1 });
    expect(record.evidence.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.evidence.candidateBinding).toEqual(record.candidate.binding);
  });

  it("replays to the checked canonical record without retaining paths or raw host references", { timeout: 30_000 }, async () => {
    const record = await qualifyAgentSkillsProvider({ root, archive, metadata });
    const encoded = canonicalQualification(record);
    expect(encoded).toBe(await readFile(checkedRecord, "utf8"));
    expect(encoded).not.toMatch(/\/Users\/|[A-Za-z]:\\/u);
    expect(encoded).not.toContain("host-ref-");
  });
});
