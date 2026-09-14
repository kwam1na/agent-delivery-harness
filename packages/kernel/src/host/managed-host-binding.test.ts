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
  it("forwards the underlying composition's REFUSAL, rather than flattening or fabricating a session", async () => {
    // THE OTHER ARM OF THE SEAM'S RESULT. Every other row here composes a
    // session that succeeds, so the adapter's `if (!composed.ok) return
    // composed;` was reached by nothing: replacing it with a fabricated
    // success — an empty admission path, an empty digest — left this file, the
    // Claude suite, and the facade scenario all green, while the facade would
    // have admitted a workspace whose settings file was never written and
    // bound an empty discovery-configuration digest.
    const refusing = await composeInput("refusing");
    await rm(path.join(refusing.bindingDir, WORKTREE_EXCLUDES_FILE), { force: true });

    const direct = await composeClaudeCodeSession(refusing);
    expect(direct.ok).toBe(false);
    const throughSeam = await claudeCodeBinding.composeSession(refusing);
    expect(throughSeam.ok).toBe(false);
    if (direct.ok || throughSeam.ok) return;
    // The blocker set is the SAME set, not merely non-empty: an adapter that
    // answered a generic refusal would leave the facade unable to say which
    // half of the admission was not composable.
    expect(throughSeam.blockers.map((blocker) => blocker.code)).toEqual(
      direct.blockers.map((blocker) => blocker.code),
    );
    expect(throughSeam.blockers.map((blocker) => blocker.code)).toContain("discovery_configuration_unreadable");
  });

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
    // THE DIGEST IS PART OF "NO DRIFT". It is what the attestation binds and
    // what every recheck compares against, so a seam that composed the same
    // bytes and reported a different digest would void the session at the
    // first recheck while every byte comparison above stayed green. The two
    // compositions above stand in different disposable bases, and the digest
    // covers absolute paths, so the comparison is made over ONE input: the
    // seam recomposes exactly what the direct call composed.
    const reachedThroughSeam = await claudeCodeBinding.composeSession(direct);
    expect(reachedThroughSeam.ok).toBe(true);
    if (!reachedThroughSeam.ok) return;
    expect(reachedThroughSeam.discoveryConfigurationDigest).toBe(expected.discoveryConfigurationDigest);
    expect(reachedThroughSeam.admissionConfigurationPath).toBe(expected.settingsPath);

    // Both sides are composed by the same code, so comparing them to each
    // other cannot see a change that moves BOTH. These rows say what the bytes
    // must CONTAIN, independently of the other side.
    const settings = JSON.parse(actualBytes) as Record<string, any>;
    expect(settings["permissions"].allow).toEqual([...throughSeam.grant.allowedCapabilities]);
    expect(settings["sandbox"]).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
    expect(settings["sandbox"].filesystem.allowWrite).toEqual(
      expect.arrayContaining([path.join(throughSeam.workspaceRoot, "src")]),
    );
    expect(settings["sandbox"].filesystem.denyWrite).toEqual(
      expect.arrayContaining([throughSeam.commonGitDir, throughSeam.authorityDir]),
    );
    expect(settings["sandbox"].filesystem.denyRead).toEqual(
      expect.arrayContaining([throughSeam.commonGitDir, throughSeam.authorityDir]),
    );
    expect(Object.keys(settings["hooks"])).toContain("PreToolUse");
    // This session's own fence, baked into the hook command.
    expect(JSON.stringify(settings["hooks"])).toContain(String(throughSeam.fence));
    expect(JSON.stringify(settings["hooks"])).toContain(throughSeam.statePath);
  });

  it("is reachable as one binding through the published surface, not only through the module path", async () => {
    // A consumer outside this package holds the barrel. A binding exported
    // from the module but missing from `index.ts` is a seam with one
    // implementation in practice, whatever this file proves about two.
    const barrel = await import("../index.ts");
    expect(barrel.claudeCodeBinding).toBe(claudeCodeBinding);
    expect(barrel.codexAppServerBinding).toBe(codexAppServerBinding);
    expect(barrel.claudeCodeBinding.hostId).toBe("claude-code");
    expect(barrel.codexAppServerBinding.hostId).toBe("codex-cli");
    for (const binding of [barrel.claudeCodeBinding, barrel.codexAppServerBinding]) {
      expect(typeof binding.composeSession).toBe("function");
      expect(typeof binding.recomputeDiscoveryConfigurationDigest).toBe("function");
      expect(typeof binding.admissionConfigurationPath).toBe("function");
    }
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
