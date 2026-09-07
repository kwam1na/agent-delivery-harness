import {
  validateRunAttachments,
  type RunAttachments,
} from "./run-attachments.ts";
/** Retained observability, projected and checked by the same product code. */
import {
  canonicalize,
  MAX_PORTABLE_RECORD_BYTES,
  applySecretDiscipline,
  evaluateRunJournal,
  RUN_STORE_ID,
  validateRunEvent,
  type RunEvent,
} from "@agent-delivery-harness/kernel";
import {
  READOUT_LABELS,
  projectCosts,
  projectRunProgress,
  readoutOf,
  summarize,
} from "./run-projection.ts";

export function buildRunExport(input: {
  readonly runId: string;
  readonly events: readonly RunEvent[];
  readonly rootDir?: string;
  readonly refusedAppends?: readonly unknown[];
}) {
  const v2 = input.events[0]?.version === "run-event/2";
  return {
    spec: v2
      ? ("delivery-run-export/2" as const)
      : ("delivery-run-export/1" as const),
    labels: READOUT_LABELS,
    runId: input.runId,
    events: input.events,
    summary: summarize(input.events),
    costs: projectCosts(input.events),
    readout: readoutOf(
      input.events,
      evaluateRunJournal(input.events),
      input.rootDir,
    ),
    refusedAppends: input.refusedAppends ?? [],
    // Exported progress is a historical projection at the last observation,
    // never a claim about whether the producer is executing now.
    ...(v2
      ? {
          progress: projectRunProgress(
            input.events,
            input.events.at(-1)?.at ?? "",
          ),
        }
      : {}),
  };
}

export type DeliveryRunExport = ReturnType<typeof buildRunExport> & {
  readonly attachments?: RunAttachments;
};
export type RunExportParseResult =
  | { readonly ok: true; readonly value: DeliveryRunExport }
  | { readonly ok: false; readonly code: "run_export_invalid" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate observations and recompute totals; this never establishes admission. */
export function parseRunExport(text: string): RunExportParseResult {
  const invalid = { ok: false, code: "run_export_invalid" } as const;
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_PORTABLE_RECORD_BYTES)
      return invalid;
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      !["delivery-run-export/1", "delivery-run-export/2"].includes(
        String(value["spec"]),
      ) ||
      value["labels"] !== READOUT_LABELS ||
      typeof value["runId"] !== "string" ||
      value["runId"].length > 128 ||
      !RUN_STORE_ID.test(value["runId"]) ||
      !Array.isArray(value["events"]) ||
      !Array.isArray(value["refusedAppends"]) ||
      !isRecord(value["readout"])
    )
      return invalid;
    const v2 = value["spec"] === "delivery-run-export/2";
    const hasAttachments = Object.prototype.hasOwnProperty.call(
      value,
      "attachments",
    );
    if (hasAttachments && (!v2 || !applySecretDiscipline(value, new Set()).ok))
      return invalid;
    if (
      Object.keys(value)
        .filter((key) => key !== "attachments")
        .sort()
        .join(",") !==
      (v2
        ? "costs,events,labels,progress,readout,refusedAppends,runId,spec,summary"
        : "costs,events,labels,readout,refusedAppends,runId,spec,summary")
    )
      return invalid;
    for (const [index, event] of value["events"].entries()) {
      if (
        !validateRunEvent(event).ok ||
        !isRecord(event) ||
        event["runId"] !== value["runId"] ||
        event["seq"] !== index + 1 ||
        event["version"] !== (v2 ? "run-event/2" : "run-event/1")
      )
        return invalid;
    }
    if (
      hasAttachments &&
      !validateRunAttachments(
        value["attachments"],
        value["events"] as RunEvent[],
      )
    )
      return invalid;
    const expected = buildRunExport({
      runId: value["runId"],
      events: value["events"] as RunEvent[],
    });
    if (
      expected.spec !== value["spec"] ||
      canonicalize(value["progress"] ?? null) !==
        canonicalize(expected.progress ?? null)
    )
      return invalid;
    if (
      canonicalize(value["summary"]) !== canonicalize(expected.summary) ||
      canonicalize(value["costs"]) !== canonicalize(expected.costs)
    )
      return invalid;
    // The optional note describes config presence in the exporting workspace;
    // it cannot be recomputed in a different checkout and grants no authority.
    const { note, ...readout } = value["readout"];
    if (
      (note !== undefined && typeof note !== "string") ||
      canonicalize(readout) !== canonicalize(expected.readout)
    )
      return invalid;
    return {
      ok: true,
      value: {
        ...expected,
        ...(hasAttachments
          ? { attachments: value["attachments"] as RunAttachments }
          : {}),
        refusedAppends: value["refusedAppends"],
        readout: {
          ...expected.readout,
          ...(note === undefined ? {} : { note }),
        },
      },
    };
  } catch {
    return invalid;
  }
}
