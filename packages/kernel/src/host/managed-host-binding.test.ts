/**
 * THE SEAM, AND WHAT IT MUST NOT BECOME.
 *
 * Two properties are asserted here and nowhere else:
 *
 *   - NO DRIFT. The Claude binding reached through `ManagedHostBinding`
 *     composes byte-identical settings, the same admission arguments, and the
 *     same digest as the function the facade used to call directly. A seam
 *     that changes the delivered host session is not a seam, it is a rewrite.
 *   - NO REGISTRY. The seam module contributes no runtime value at all — no
 *     table, no lookup, no default resolved from a string — so a caller can
 *     only hold the one binding it was given.
 *
 * Written RED before the facade consumed the seam.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as seam from "./managed-host-binding.ts";
import {
  WORKTREE_EXCLUDES_FILE,
  claudeCodeBinding,
  composeClaudeCodeSession,
  discoveryConfigurationDigestOf,
  sessionSettingsFile,
} from "./claude-code.ts";
import { CODEX_THREAD_CONFIG_FILE, codexAppServerBinding } from "./codex-app-server.ts";
import type { ComposeHostSessionInput } from "./managed-host-binding.ts";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "host-seam-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * A binding directory carrying the worktree-scoped exclusion the projection
 * writes, which is the second half of the Claude binding's digest.
 */
async function composeInput(name: string): Promise<ComposeHostSessionInput> {
  const base = await mkdtemp(path.join(scratch, `${name}-`));
  const bindingDir = path.join(base, "binding");
  await mkdir(bindingDir, { recursive: true });
  await writeFile(path.join(bindingDir, WORKTREE_EXCLUDES_FILE), "/.managed-projection/\n");
  return {
    bindingDir,
    statePath: path.join(bindingDir, "state-7.json"),
    hookCommand: ["node", "--experimental-strip-types", path.join(base, "hook-main.ts")],
    fence: 7,
    workspaceRoot: path.join(base, "worktree"),
    commonGitDir: path.join(base, "repo", ".git"),
    authorityDir: path.join(base, "authority"),
    grant: {
      allowedCapabilities: ["Read", "Write"],
      writablePaths: ["src"],
      protectedPaths: [".git", ".managed-projection"],
    },
  };
}

describe("the host-neutral binding seam", () => {
  it("contributes no runtime value — there is no registry, lookup, or string-resolved default", () => {
    expect(Object.keys(seam)).toEqual([]);
  });

  it("keys each binding on a host id, never a display name", () => {
    expect(claudeCodeBinding.hostId).toBe("claude-code");
    expect(codexAppServerBinding.hostId).toBe("codex-cli");
    expect(claudeCodeBinding.hostId).not.toBe(codexAppServerBinding.hostId);
  });

  it("names each binding's fence-scoped admission configuration without composing it", () => {
    expect(claudeCodeBinding.admissionConfigurationPath("/b", 3)).toBe(path.join("/b", sessionSettingsFile(3)));
    expect(codexAppServerBinding.admissionConfigurationPath("/b", 3)).toBe(
      path.join("/b", CODEX_THREAD_CONFIG_FILE(3)),
    );
  });
});

describe("the Claude binding reached through the seam", () => {
  it("composes byte-identical settings, the same admission arguments, and the same digest", async () => {
    const direct = await composeInput("direct");
    const throughSeam = { ...(await composeInput("seam")) };

    const expected = await composeClaudeCodeSession(direct);
    expect(expected.ok).toBe(true);
    const actual = await claudeCodeBinding.composeSession(throughSeam);
    expect(actual.ok).toBe(true);
    if (!expected.ok || !actual.ok) return;

    // Paths differ only by the disposable base; the BYTES must not.
    const expectedBytes = await readFile(expected.settingsPath, "utf8");
    const actualBytes = await readFile(actual.admissionConfigurationPath, "utf8");
    const normalize = (bytes: string, input: ComposeHostSessionInput): string =>
      bytes.split(path.dirname(input.bindingDir)).join("<base>");
    expect(normalize(actualBytes, throughSeam)).toBe(normalize(expectedBytes, direct));

    expect(actual.hostAdmissionArguments).toEqual(
      expected.cliArgs.map((arg) => (arg === expected.settingsPath ? actual.admissionConfigurationPath : arg)),
    );
    expect(actual.admissionConfigurationPath).toBe(
      claudeCodeBinding.admissionConfigurationPath(throughSeam.bindingDir, throughSeam.fence),
    );
  });

  it("recomputes the digest through the one definition every recheck site uses", async () => {
    const input = await composeInput("recheck");
    const composed = await claudeCodeBinding.composeSession(input);
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    await expect(
      claudeCodeBinding.recomputeDiscoveryConfigurationDigest({
        admissionConfigurationPath: composed.admissionConfigurationPath,
        bindingDir: input.bindingDir,
      }),
    ).resolves.toBe(composed.discoveryConfigurationDigest);
    await expect(
      discoveryConfigurationDigestOf({ settingsPath: composed.admissionConfigurationPath, bindingDir: input.bindingDir }),
    ).resolves.toBe(composed.discoveryConfigurationDigest);
  });

  it("answers undefined — a mismatch, not a pass — when the bound bytes cannot be read", async () => {
    const input = await composeInput("unreadable");
    await expect(
      claudeCodeBinding.recomputeDiscoveryConfigurationDigest({
        admissionConfigurationPath: path.join(input.bindingDir, "absent.json"),
        bindingDir: input.bindingDir,
      }),
    ).resolves.toBeUndefined();
    await expect(
      codexAppServerBinding.recomputeDiscoveryConfigurationDigest({
        admissionConfigurationPath: path.join(input.bindingDir, "absent.json"),
        bindingDir: input.bindingDir,
      }),
    ).resolves.toBeUndefined();
  });

  it("re-digests a Codex thread configuration changed under the binding's feet to a different value", async () => {
    const input = await composeInput("codex-recheck");
    const composed = await codexAppServerBinding.composeSession(input);
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    await expect(
      codexAppServerBinding.recomputeDiscoveryConfigurationDigest({
        admissionConfigurationPath: composed.admissionConfigurationPath,
        bindingDir: input.bindingDir,
      }),
    ).resolves.toBe(composed.discoveryConfigurationDigest);

    const tampered = JSON.parse(await readFile(composed.admissionConfigurationPath, "utf8"));
    tampered.params.config.permissions[tampered.params.config.permission_profile].sandbox_workspace_write.network_access = true;
    await writeFile(composed.admissionConfigurationPath, JSON.stringify(tampered, null, 2));
    await expect(
      codexAppServerBinding.recomputeDiscoveryConfigurationDigest({
        admissionConfigurationPath: composed.admissionConfigurationPath,
        bindingDir: input.bindingDir,
      }),
    ).resolves.not.toBe(composed.discoveryConfigurationDigest);
  });
});
