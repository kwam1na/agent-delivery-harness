import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createArtifactsPort,
  readRunArtifact,
  MAX_PORTABLE_RECORD_BYTES,
} from "@agent-delivery-harness/kernel";
import { buildRunArchive, readArchiveArtifact } from "./run-archive.ts";
import { parseRunExport } from "./run-export.ts";
import {
  resolveRunSurface,
  oneLine,
  runSurfaceBlocker,
} from "./run-surface.ts";
import type { ConfigFreeCommandContext, CommandResult } from "./boundary.ts";
const blocked = (reason: string): CommandResult => ({
  kind: "blocked",
  blockers: [
    runSurfaceBlocker({
      code: "run_archive_unavailable",
      summary: "The run archive is unavailable.",
      details: oneLine(reason),
      remediation: {
        id: "inspect-run-archive",
        summary:
          "Check the selected archive or retained run attachments and retry.",
      },
    }),
  ],
});
/** Explicit file input only, bounded on the opened descriptor; never a server path. */
async function readArchiveFile(file: string): Promise<string> {
  // Inspect the descriptor before reading; a FIFO must not wait for a writer.
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await h.stat();
    if (!stat.isFile() || stat.size > MAX_PORTABLE_RECORD_BYTES)
      throw Error("archive must be a regular file no larger than 16 MiB");
    const buffer = Buffer.alloc(
      Math.min(stat.size + 1, MAX_PORTABLE_RECORD_BYTES + 1),
    );
    let offset = 0;
    while (offset < buffer.length) {
      const read = await h.read(buffer, offset, buffer.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size || offset > MAX_PORTABLE_RECORD_BYTES)
      throw Error("archive changed size while reading");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await h.close();
  }
}
async function resolvedDestination(file: string): Promise<string> {
  let parent = path.dirname(file);
  const suffix = [path.basename(file)];
  for (;;) {
    try {
      return path.join(await realpath(parent), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      suffix.unshift(path.basename(parent));
      const next = path.dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}
const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};
export async function runArchiveCommand(
  context: ConfigFreeCommandContext,
  command: "export" | "archive",
  args: readonly string[],
): Promise<CommandResult> {
  if (command === "export" && (args.length !== 3 || args[1] !== "--output"))
    return {
      kind: "usage",
      message: "Usage: runs export <run-id> --output <file>",
    };
  if (
    command === "archive" &&
    !(args.length === 1 || (args.length === 3 && args[1] === "--artifact"))
  )
    return {
      kind: "usage",
      message: "Usage: runs archive <file> [--artifact <id>]",
    };
  try {
    if (command === "archive") {
      const text = await readArchiveFile(
        path.resolve(context.rootDir, args[0]!),
      );
      const parsed = parseRunExport(text);
      if (!parsed.ok) return blocked("archive invalid or unsupported");
      if (args[1] === "--artifact") {
        const artifact = readArchiveArtifact(text, args[2]!);
        if (!artifact.ok) return blocked(artifact.reason);
        context.write(
          JSON.stringify({
            spec: "run-artifact/1",
            historical: true,
            authority: "observation",
            runId: parsed.value.runId,
            ...artifact,
          }),
        );
      } else
        context.write(
          JSON.stringify({
            historical: true,
            authority: "observation",
            archive: parsed.value,
          }),
        );
      return { kind: "ok" };
    }
    const resolved = await resolveRunSurface(context.rootDir);
    if (!resolved.ok) return blocked(resolved.reason);
    const store = resolved.surface.store;
    const runId = args[0]!;
    const journal = await store.read(runId);
    if (!journal.ok) return blocked("run unavailable");
    const archive = await buildRunArchive({
      runId,
      events: journal.events,
      refusedAppends: await store.readNotes(runId),
      readArtifact: (id) => readRunArtifact(store, runId, id),
    });
    if (!archive.ok) return blocked(archive.reason);
    const destination = await resolvedDestination(
      path.resolve(context.rootDir, args[2]!),
    );
    if (
      within(await realpath(resolved.surface.commonDir), destination) ||
      within(await realpath(resolved.surface.runsDir), destination)
    )
      return blocked(
        "archive output cannot replace repository metadata or the live run store",
      );
    await createArtifactsPort().writeTextFile(destination, archive.text, {
      mode: 0o600,
    });
    context.write(
      JSON.stringify({
        spec: "run-archive-export/1",
        runId,
        path: path.resolve(context.rootDir, args[2]!),
        sizeBytes: Buffer.byteLength(archive.text),
        authority: "observation",
      }),
    );
    return { kind: "ok" };
  } catch {
    return blocked("archive file unreadable, oversized, unsafe, or unwritable");
  }
}
