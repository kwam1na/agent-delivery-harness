import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mintGrantAttestation } from "../packages/kernel/src/host/claude-code.ts";
import { projectionConsumptionObservationFile } from "../packages/kernel/src/projection-consumption-observation.ts";
import { composeQualificationSession } from "./qualify-claude-code-session.ts";

interface HookSettings {
  readonly hooks?: {
    readonly PostToolUse?: readonly {
      readonly matcher?: string;
      readonly hooks?: readonly { readonly command?: string }[];
    }[];
  };
}

const dispatchPostToolUse = (settings: HookSettings, input: Record<string, unknown>): void => {
  for (const group of settings.hooks?.PostToolUse ?? []) {
    if (group.matcher !== input["tool_name"]) continue;
    for (const hook of group.hooks ?? []) {
      if (hook.command === undefined) continue;
      execFileSync("/bin/sh", ["-c", hook.command], {
        input: JSON.stringify(input),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  }
};

describe("authenticated qualifier hook composition", () => {
  it("uses the strict binding admission vector and records one completed exact Read through its composed hook", async () => {
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), "qualifier-post-tool-use-"));
    try {
      const bindingDir = path.join(root, "binding");
      const workflowPath = path.join(root, ".managed-projection", "workflows", "delivery-v1.json");
      const statePath = path.join(bindingDir, "state.json");
      const receiptPath = path.join(bindingDir, "projection-receipt.json");
      const observationPath = path.join(bindingDir, projectionConsumptionObservationFile(1));
      mkdirSync(path.dirname(workflowPath), { recursive: true });
      mkdirSync(bindingDir, { recursive: true });
      writeFileSync(workflowPath, "{}\n");

      const grant = {
        spec: "execution-grant/1",
        profile: "checkpoint",
        allowedCapabilities: ["Read"],
        writablePaths: [],
        protectedPaths: [".managed-projection"],
        forbiddenOperations: [],
      };
      const expectation = {
        profile: "checkpoint" as const,
        hostVersion: "qualifier-test/1",
        productTrustRevocationEpoch: 0,
        observedAt: "2026-09-01T00:00:00Z",
        deliveryId: "dlv-qualifier-post-tool-use",
        invocationFence: 1,
        workspaceId: "ws-qualifier-post-tool-use",
        projectionDigest: "a".repeat(64),
        discoveryConfigurationDigest: "b".repeat(64),
        registeringInstallationId: "install-qualifier-test",
        activeProfile: "confirmation-fixture",
      };
      writeFileSync(
        receiptPath,
        `${JSON.stringify({
          deliveryId: expectation.deliveryId,
          projectionDigest: expectation.projectionDigest,
          entries: [{ path: "workflows/delivery-v1.json" }],
        })}\n`,
      );
      const session = await composeQualificationSession({
        bindingDir,
        statePath,
        workspaceRoot: root,
        commonGitDir: path.join(root, ".git"),
        grant,
      });
      const boundExpectation = {
        ...expectation,
        discoveryConfigurationDigest: session.discoveryConfigurationDigest,
      };
      writeFileSync(
        statePath,
        `${JSON.stringify({
          expectation: boundExpectation,
          grant,
          attestation: mintGrantAttestation({ grant, expectation: boundExpectation, expiry: "2099-01-01T00:00:00Z" }),
          workspaceRoot: root,
          observationPath: path.join(bindingDir, "activity.json"),
          projectionConsumptionPath: observationPath,
          projectionReceiptPath: receiptPath,
          deliveryId: expectation.deliveryId,
        })}\n`,
      );
      const settings = JSON.parse(readFileSync(session.settingsPath, "utf8")) as HookSettings & {
        readonly sandbox: {
          readonly enabled: boolean;
          readonly failIfUnavailable: boolean;
          readonly excludedCommands: readonly string[];
          readonly allowUnsandboxedCommands: boolean;
          readonly filesystem: {
            readonly allowWrite: readonly string[];
            readonly denyWrite: readonly string[];
            readonly denyRead: readonly string[];
          };
        };
      };
      expect(session.cliArgs).toEqual([
        "--restricted",
        "--settings",
        session.settingsPath,
        "--setting-sources",
        "",
        "--tools",
        "Read",
        "--permission-mode",
        "dontAsk",
      ]);
      expect(settings.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        excludedCommands: [],
        allowUnsandboxedCommands: false,
      });
      expect(settings.sandbox.filesystem.allowWrite).toEqual([]);
      expect(settings.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([root, bindingDir]));
      expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([bindingDir]));
      const input = {
        tool_name: "Read",
        tool_use_id: "toolu_qualifier_exact_read",
        tool_input: { file_path: workflowPath },
      };

      dispatchPostToolUse({ hooks: {} }, input);
      expect(existsSync(observationPath), "a pre-only settings shape cannot observe a completed read").toBe(false);

      dispatchPostToolUse(settings, input);
      expect(JSON.parse(readFileSync(observationPath, "utf8"))).toMatchObject({
        spec: "projection-consumption-observation/1",
        deliveryId: expectation.deliveryId,
        entry: "workflows/delivery-v1.json",
        hostInvocationId: "toolu_qualifier_exact_read",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
