import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  publishWorkspaceIfMissing,
  type CommandResult,
  type CommandRunner,
} from "./publish-workspace-if-missing.ts";

const PACKAGE = "@agent-delivery-harness/kernel";
const VERSION = "0.4.0";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(repoRoot, "scripts/publish-workspace-if-missing.ts");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function commandResult(status: number, stdout = "", stderr = ""): CommandResult {
  return { status, stdout, stderr };
}

describe("publishing one workspace package idempotently", () => {
  it("skips an exact version the registry already has", () => {
    const run = vi.fn<CommandRunner>(() => commandResult(0, `${JSON.stringify(VERSION)}\n`));

    expect(publishWorkspaceIfMissing(PACKAGE, VERSION, run)).toBe("skipped");
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("npm", ["view", `${PACKAGE}@${VERSION}`, "version", "--json"]);
  });

  it("publishes after the registry explicitly reports that the exact version is absent", () => {
    const run = vi
      .fn<CommandRunner>()
      .mockReturnValueOnce(commandResult(1, "", 'npm error code E404\nnpm error 404 Not Found\n'))
      .mockReturnValueOnce(commandResult(0, "published\n"));

    expect(publishWorkspaceIfMissing(PACKAGE, VERSION, run)).toBe("published");
    expect(run).toHaveBeenNthCalledWith(1, "npm", ["view", `${PACKAGE}@${VERSION}`, "version", "--json"]);
    expect(run).toHaveBeenNthCalledWith(2, "npm", [
      "publish",
      "--provenance",
      "--access",
      "public",
      "--workspace",
      PACKAGE,
    ]);
  });

  it.each(["E401", "E403", "E503", "ETIMEDOUT"])(
    "fails closed on registry or transport error %s rather than treating it as absence",
    (code) => {
      const run = vi.fn<CommandRunner>(() => commandResult(1, "", `npm error code ${code}\nregistry request failed\n`));

      expect(() => publishWorkspaceIfMissing(PACKAGE, VERSION, run)).toThrow(
        new RegExp(`could not determine whether .* is published.*${code}`, "su"),
      );
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("fails closed when npm view exits successfully with invalid JSON", () => {
    const run = vi.fn<CommandRunner>(() => commandResult(0, "service unavailable\n"));

    expect(() => publishWorkspaceIfMissing(PACKAGE, VERSION, run)).toThrow(/returned invalid JSON/u);
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not treat E404 in unrelated transport-error text as a not-found response", () => {
    const run = vi.fn<CommandRunner>(() =>
      commandResult(1, "", "npm error code E503\nnpm error upstream request E404-route timed out\n"),
    );

    expect(() => publishWorkspaceIfMissing(PACKAGE, VERSION, run)).toThrow(/could not determine whether .* is published.*E503/su);
    expect(run).toHaveBeenCalledOnce();
  });

  it("recognizes npm's structured E404 response as explicit absence", () => {
    const run = vi
      .fn<CommandRunner>()
      .mockReturnValueOnce(commandResult(1, "", `${JSON.stringify({ error: { code: "E404" } }, null, 2)}\n`))
      .mockReturnValueOnce(commandResult(0));

    expect(publishWorkspaceIfMissing(PACKAGE, VERSION, run)).toBe("published");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails closed when npm reports conflicting error codes", () => {
    const run = vi.fn<CommandRunner>(() =>
      commandResult(1, '{"error":{"code":"E404"}}\n', "npm error code E503\n"),
    );

    expect(() => publishWorkspaceIfMissing(PACKAGE, VERSION, run)).toThrow(/could not determine whether .* is published.*E503/su);
    expect(run).toHaveBeenCalledOnce();
  });

  it("fails closed when a successful registry response does not name the exact requested version", () => {
    const run = vi.fn<CommandRunner>(() => commandResult(0, `${JSON.stringify("0.3.0")}\n`));

    expect(() => publishWorkspaceIfMissing(PACKAGE, VERSION, run)).toThrow(/returned version 0\.3\.0.*expected 0\.4\.0/su);
    expect(run).toHaveBeenCalledOnce();
  });

  it("propagates a publish refusal instead of reporting completion", () => {
    const run = vi
      .fn<CommandRunner>()
      .mockReturnValueOnce(commandResult(1, "", "npm error code E404\n"))
      .mockReturnValueOnce(commandResult(1, "", "npm error code E403\ntrusted publisher refused\n"));

    expect(() => publishWorkspaceIfMissing(PACKAGE, VERSION, run)).toThrow(/publish failed.*E403/su);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("a partially published workflow rerun", () => {
  it("executes the wired package commands, skips exact existing versions, and publishes every remainder", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-fake-npm-"));
    try {
      const binDir = path.join(dir, "bin");
      const statePath = path.join(dir, "state.json");
      const fakeNpmPath = path.join(binDir, "npm");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeNpmPath,
        `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_NPM_STATE;
const version = process.env.FAKE_NPM_VERSION;
if (!statePath || !version) process.exit(90);
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { published: [], attempts: {}, failedOnce: false };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const [command, ...args] = process.argv.slice(2);

if (command === "view") {
  const exactSpec = args[0];
  if (state.published.includes(exactSpec)) {
    console.log(JSON.stringify(version));
    process.exit(0);
  }
  console.error("npm error code E404");
  process.exit(1);
}

if (command === "publish") {
  const workspaceAt = args.indexOf("--workspace");
  const packageName = args[workspaceAt + 1];
  state.attempts[packageName] = (state.attempts[packageName] ?? 0) + 1;
  if (packageName === "@agent-delivery-harness/cli" && !state.failedOnce) {
    state.failedOnce = true;
    save();
    console.error("npm error code E503");
    process.exit(1);
  }
  state.published.push(packageName + "@" + version);
  save();
  process.exit(0);
}

process.exit(91);
`,
        "utf8",
      );
      chmodSync(fakeNpmPath, 0o755);

      const workflow = readFileSync(path.join(repoRoot, ".github/workflows/publish.yml"), "utf8");
      const packages = [...workflow.matchAll(/publish-workspace-if-missing\.ts "([^"]+)" "\$\{GITHUB_REF_NAME#v\}"/gu)]
        .map((match) => match[1]!);
      expect(packages).toEqual([
        "@agent-delivery-harness/kernel",
        "@agent-delivery-harness/conformance",
        "@agent-delivery-harness/cli",
        "@agent-delivery-harness/action",
        "@agent-delivery-harness/mcp",
      ]);

      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
        FAKE_NPM_STATE: statePath,
        FAKE_NPM_VERSION: VERSION,
      };
      const invoke = (packageName: string) =>
        spawnSync(process.execPath, ["--import", tsxLoader, helperPath, packageName, VERSION], {
          cwd: repoRoot,
          encoding: "utf8",
          env,
        });

      const firstStatuses: number[] = [];
      for (const packageName of packages) {
        const result = invoke(packageName);
        firstStatuses.push(result.status ?? 1);
        if (result.status !== 0) break;
      }
      expect(firstStatuses).toEqual([0, 0, 1]);
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
        published: [`@agent-delivery-harness/kernel@${VERSION}`, `@agent-delivery-harness/conformance@${VERSION}`],
        failedOnce: true,
      });

      const rerun = packages.map((packageName) => invoke(packageName));
      expect(rerun.map((result) => result.status)).toEqual([0, 0, 0, 0, 0]);
      expect(rerun[0]!.stdout).toContain(`${packages[0]}@${VERSION}: skipped`);
      expect(rerun[1]!.stdout).toContain(`${packages[1]}@${VERSION}: skipped`);
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
        published: packages.map((packageName) => `${packageName}@${VERSION}`),
        attempts: {
          "@agent-delivery-harness/kernel": 1,
          "@agent-delivery-harness/conformance": 1,
          "@agent-delivery-harness/cli": 2,
          "@agent-delivery-harness/action": 1,
          "@agent-delivery-harness/mcp": 1,
        },
        failedOnce: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
