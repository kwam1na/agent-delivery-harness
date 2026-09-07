/** Explicit acquisition capture; retained reports remain observations. */
import {
  captureRunArtifact,
  readRunArtifact,
  validateRunEventInput,
  type RunArtifactMetadata,
} from "@agent-delivery-harness/kernel";
import {
  buildRunEvent,
  oneLine,
  resolveRunSurface,
  runSurfaceBlocker,
} from "./run-surface.ts";
import type { CommandResult, ConfigFreeCommandContext } from "./boundary.ts";
const blocked = (reason: string): CommandResult => ({
  kind: "blocked",
  blockers: [
    runSurfaceBlocker({
      code: "run_artifact_unavailable",
      summary: "The run attachment is unavailable.",
      details: oneLine(reason),
      remediation: {
        id: "inspect-selected-report",
        summary:
          "Check the explicit report binding and selected source file, then retry capture.",
      },
    }),
  ],
});
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export async function runArtifactCommand(
  context: ConfigFreeCommandContext,
  command: "capture" | "artifact",
  args: readonly string[],
): Promise<CommandResult> {
  if (
    command === "artifact" &&
    (args.length < 2 ||
      args.length > 3 ||
      (args[2] !== undefined && args[2] !== "--json"))
  )
    return {
      kind: "usage",
      message: "Usage: runs artifact <run-id> <artifact-id> [--json]",
    };
  if (command === "capture" && (args.length !== 3 || args[1] !== "--json"))
    return {
      kind: "usage",
      message: "Usage: runs capture <run-id> --json <request>",
    };
  const resolved = await resolveRunSurface(context.rootDir);
  if (!resolved.ok) return blocked(resolved.reason);
  const { store, commonDir } = resolved.surface;
  const runId = args[0]!;
  if (command === "artifact") {
    const result = await readRunArtifact(store, runId, args[1]!);
    if (!result.ok) return blocked(result.reason);
    context.write(
      args[2] === "--json"
        ? `${JSON.stringify({ spec: "run-artifact/1", labels: "self-attested observation; not admission evidence", runId, ...result })}\n`
        : `${oneLine(Buffer.from(result.base64, "base64").toString("utf8"), 2 * 1024 * 1024)}\n`,
    );
    return { kind: "ok" };
  }
  let request: unknown;
  try {
    if (Buffer.byteLength(args[2]!, "utf8") > 16384)
      return blocked("capture request exceeds 16 KiB");
    request = JSON.parse(args[2]!);
  } catch {
    return { kind: "usage", message: "Capture request must be JSON." };
  }
  if (
    !record(request) ||
    Object.keys(request).sort().join(",") !==
      "artifact,eventId,report,sourcePath,sourceRoot" ||
    typeof request["sourceRoot"] !== "string" ||
    typeof request["sourcePath"] !== "string" ||
    typeof request["eventId"] !== "string" ||
    !record(request["artifact"]) ||
    !record(request["report"])
  )
    return {
      kind: "usage",
      message:
        "Capture requires artifact, report, eventId, sourceRoot and sourcePath.",
    };
  const artifact = request["artifact"];
  const report = request["report"];
  const binding = {
    activityId: artifact["activityId"],
    attemptId: artifact["attemptId"],
    candidateTreeSha: artifact["candidateTreeSha"],
    ...(artifact["roundId"] === undefined
      ? {}
      : { roundId: artifact["roundId"] }),
    ...(artifact["round"] === undefined ? {} : { round: artifact["round"] }),
    ...(artifact["lensId"] === undefined ? {} : { lensId: artifact["lensId"] }),
  };
  const journal = await store.read(runId);
  if (!journal.ok || journal.events[0]?.version !== "run-event/2")
    return blocked(
      "capture requires an existing run-event/2 run; start an explicit successor for a legacy run",
    );
  const make = (suffix: string, kind: string, payload: unknown) => {
    const event = buildRunEvent({
      runId,
      commonDir,
      kind,
      role: "executor",
      payload,
      version: "run-event/2",
      eventId: `${request["eventId"]}-${suffix}`,
    });
    return event;
  };
  const artifactEvent = make("artifact", "artifact.referenced", artifact);
  const reportEvent = make("report", "report.referenced", {
    ...report,
    ...binding,
    availability: "referenced",
    artifactId: artifact["artifactId"],
  });
  // Report input cannot override the capture's binding or carry success fields.
  if (
    Object.keys(report).some(
      (k) =>
        !["reportId", "role", "originatingReportId", "findingId"].includes(k),
    ) ||
    !validateRunEventInput(artifactEvent).ok ||
    !validateRunEventInput(reportEvent).ok
  )
    return blocked("invalid report or artifact event binding");
  const result = await captureRunArtifact({
    store,
    runId,
    metadata: artifact as unknown as RunArtifactMetadata,
    sourceRoot: request["sourceRoot"],
    sourcePath: request["sourcePath"],
  });
  if (!result.ok) {
    const unavailable = make("unavailable", "report.referenced", {
      ...report,
      ...binding,
      availability: "unavailable",
      reason: result.reason,
    });
    await store.append(runId, unavailable, { reuseExistingTimestamp: true });
    return blocked(result.reason);
  }
  for (const event of [artifactEvent, reportEvent]) {
    const appended = await store.append(runId, event, { reuseExistingTimestamp: true });
    if (!appended.ok)
      return blocked(
        `bytes retained but reference append refused: ${appended.rejections.map((r) => r.message).join("; ")}`,
      );
  }
  context.write(
    `${JSON.stringify({ spec: "run-artifact-capture/1", runId, artifactId: result.metadata.artifactId, digest: result.metadata.digest, availability: "referenced", authority: "observation" })}\n`,
  );
  return { kind: "ok" };
}
