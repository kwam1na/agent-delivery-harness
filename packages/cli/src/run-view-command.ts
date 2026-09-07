import { withRetainedRecord } from "./run-view-record.ts";
import { projectRunView } from "./run-view.ts";
import {
  resolveRunSurface,
  oneLine,
  runSurfaceBlocker,
} from "./run-surface.ts";
import type { ConfigFreeCommandContext, CommandResult } from "./boundary.ts";
export async function runViewCommand(
  context: ConfigFreeCommandContext,
  args: readonly string[],
): Promise<CommandResult> {
  const runId = args[0];
  let json = false;
  let recordPath: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--json" && !json) json = true;
    else if (args[i] === "--record" && recordPath === undefined && args[i + 1])
      recordPath = args[++i];
    else
      return {
        kind: "usage",
        message:
          "Usage: runs view <run-id> [--json] [--record <repository-relative-path>]",
      };
  }
  if (!runId)
    return {
      kind: "usage",
      message:
        "Usage: runs view <run-id> [--json] [--record <repository-relative-path>]",
    };
  const resolved = await resolveRunSurface(context.rootDir);
  const read = resolved.ok
    ? await resolved.surface.store.read(args[0]!)
    : undefined;
  if (!read?.ok)
    return {
      kind: "blocked",
      blockers: [
        runSurfaceBlocker({
          code: "run_view_unavailable",
          summary: "Run observations are unavailable.",
          details: resolved.ok
            ? "The selected run could not be read."
            : oneLine(resolved.reason),
          remediation: {
            id: "inspect-run",
            summary: "Check the selected repository and run identifier.",
          },
        }),
      ],
    };
  const view = await withRetainedRecord(
    projectRunView(read.events, { now: new Date().toISOString() }),
    context.rootDir,
    recordPath,
  );
  if (json) context.write(JSON.stringify(view));
  else {
    context.write(view.authority);
    for (const section of view.sections) {
      context.write(section.title);
      if (!section.items.length) context.write(`  ${section.empty}`);
      for (const item of section.items) {
        context.write(`  ${oneLine(item.label)}`);
        for (const field of item.fields)
          context.write(`    ${oneLine(field.label)}: ${oneLine(field.value, 8192)}`);
        if (item.artifactId)
          context.write(
            `    Report: runs artifact ${oneLine(args[0]!)} ${oneLine(item.artifactId)} --json`,
          );
      }
    }
  }
  return { kind: "ok" };
}
