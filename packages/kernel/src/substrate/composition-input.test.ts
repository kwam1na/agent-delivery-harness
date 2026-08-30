/**
 * CHARACTERIZATION of the exact authenticated workflow input the local
 * composition substrate consumes, captured before the substrate exists.
 *
 * The composition pin (`spine/composition.ts`) froze the `agent-skills`
 * release identities from the composition baseline. This suite binds the
 * vendored fixture BYTES under `qualifications/fixtures/` to those frozen
 * identities: the archive and metadata the pack path will embed hash to
 * exactly the pinned digests, and the metadata document names the same
 * release. A drift in either the fixtures or the pin goes red here, not
 * inside an installer test that would then be probing two things at once.
 *
 * The pre-existing `agent-skills-core-v1.zip` fixture is the retained
 * interoperability release (archive 004bfcf1…, skills commit ddd04495…) and
 * is deliberately NOT the composition input; the baseline records the two
 * identities as distinct, and this suite pins the distinction.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../digest.ts";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "..", "qualifications", "fixtures");

const archivePath = path.join(FIXTURES, "agent-skills-core-v1-composition.zip");
const metadataPath = path.join(FIXTURES, "agent-skills-core-v1-composition.metadata.json");

describe("the vendored composition input", () => {
  it("carries archive bytes hashing to the frozen pin's archiveSha256", () => {
    expect(sha256Hex(readFileSync(archivePath))).toBe(PINNED_AGENT_SKILLS.archiveSha256);
  });

  it("carries metadata bytes hashing to the frozen pin's metadataSha256", () => {
    expect(sha256Hex(readFileSync(metadataPath))).toBe(PINNED_AGENT_SKILLS.metadataSha256);
  });

  it("names the same release the pin names, inside the metadata document", () => {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata["releaseId"]).toBe(PINNED_AGENT_SKILLS.releaseId);
    expect(metadata["profile"]).toBe(PINNED_AGENT_SKILLS.profile);
    expect(metadata["archiveSha256"]).toBe(PINNED_AGENT_SKILLS.archiveSha256);
  });

  it("is a different archive from the retained interoperability fixture", () => {
    const interoperability = sha256Hex(readFileSync(path.join(FIXTURES, "agent-skills-core-v1.zip")));
    expect(interoperability).toBe("004bfcf1c8d245a75d9f696d9f1ac83af4b0e6f2c90a48e3927a916a5b8c5ef8");
    expect(interoperability).not.toBe(PINNED_AGENT_SKILLS.archiveSha256);
  });
});
