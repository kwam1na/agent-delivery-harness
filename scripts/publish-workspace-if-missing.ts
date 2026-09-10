import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

const runCommand: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error === undefined ? "" : `${result.error.message}\n`}`,
  };
};

function commandOutput(result: CommandResult): string {
  return `${result.stdout}${result.stderr}`.trim();
}

function jsonErrorCode(text: string): string | undefined {
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const candidates = [trimmed];
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { readonly code?: unknown; readonly error?: { readonly code?: unknown } };
      const code = parsed.error?.code ?? parsed.code;
      if (typeof code === "string") return code;
    } catch {
      // npm's normal human-readable error format is checked below.
    }
  }
  return undefined;
}

function explicitNotFound(result: CommandResult): boolean {
  const codes: string[] = [];
  for (const output of [result.stdout, result.stderr]) {
    const structuredCode = jsonErrorCode(output);
    if (structuredCode !== undefined) codes.push(structuredCode);
    for (const line of output.split(/\r?\n/u)) {
      const match = line.match(/^npm (?:error|ERR!) code ([A-Z0-9_]+)\s*$/iu);
      if (match?.[1] !== undefined) codes.push(match[1].toUpperCase());
    }
  }
  return codes.length > 0 && codes.every((code) => code === "E404");
}

export type PublishOutcome = "published" | "skipped";

/**
 * Publish one workspace package unless npm confirms that its exact version is
 * already public. Only an explicit E404 means absence; auth, transport, server,
 * and malformed-success responses stop the release before it can guess.
 */
export function publishWorkspaceIfMissing(
  packageName: string,
  version: string,
  run: CommandRunner = runCommand,
): PublishOutcome {
  if (packageName.length === 0 || version.length === 0) {
    throw new Error("publish-if-missing requires a package name and version");
  }

  const exactSpec = `${packageName}@${version}`;
  const view = run("npm", ["view", exactSpec, "version", "--json"]);
  if (view.status === 0) {
    let publishedVersion: unknown;
    try {
      publishedVersion = JSON.parse(view.stdout);
    } catch {
      throw new Error(`npm view ${exactSpec} returned invalid JSON; refusing to infer that the version is absent`);
    }
    if (publishedVersion !== version) {
      throw new Error(
        `npm view ${exactSpec} returned version ${String(publishedVersion)}; expected ${version}; refusing to publish`,
      );
    }
    return "skipped";
  }

  if (!explicitNotFound(view)) {
    throw new Error(
      `could not determine whether ${exactSpec} is published; refusing to publish: ${commandOutput(view) || `npm exited ${view.status}`}`,
    );
  }

  const publish = run("npm", ["publish", "--provenance", "--access", "public", "--workspace", packageName]);
  if (publish.status !== 0) {
    throw new Error(`npm publish failed for ${exactSpec}: ${commandOutput(publish) || `npm exited ${publish.status}`}`);
  }
  return "published";
}

function main(): void {
  const [packageName, version] = process.argv.slice(2);
  if (packageName === undefined || version === undefined) {
    console.error("usage: publish-workspace-if-missing <package-name> <version>");
    process.exitCode = 1;
    return;
  }

  try {
    const outcome = publishWorkspaceIfMissing(packageName, version);
    console.log(`${packageName}@${version}: ${outcome}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === path.resolve(invokedPath)) main();
