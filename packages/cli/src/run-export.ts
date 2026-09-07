/** Retained observability, projected and checked by the same product code. */
import { canonicalize, evaluateRunJournal, RUN_STORE_ID, validateRunEvent, type RunEvent } from "@agent-delivery-harness/kernel";
import { READOUT_LABELS, projectCosts, readoutOf, summarize } from "./run-projection.ts";

export function buildRunExport(input: {
  readonly runId: string;
  readonly events: readonly RunEvent[];
  readonly rootDir?: string;
  readonly refusedAppends?: readonly unknown[];
}) {
  return {
    spec: "delivery-run-export/1" as const,
    labels: READOUT_LABELS,
    runId: input.runId,
    events: input.events,
    summary: summarize(input.events),
    costs: projectCosts(input.events),
    readout: readoutOf(input.events, evaluateRunJournal(input.events), input.rootDir),
    refusedAppends: input.refusedAppends ?? [],
  };
}

export type DeliveryRunExport = ReturnType<typeof buildRunExport>;
export type RunExportParseResult = { readonly ok: true; readonly value: DeliveryRunExport } |
  { readonly ok: false; readonly code: "run_export_invalid" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate observations and recompute totals; this never establishes admission. */
export function parseRunExport(text: string): RunExportParseResult {
  const invalid = { ok: false, code: "run_export_invalid" } as const;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value["spec"] !== "delivery-run-export/1" || value["labels"] !== READOUT_LABELS ||
        typeof value["runId"] !== "string" || value["runId"].length > 128 || !RUN_STORE_ID.test(value["runId"]) ||
        !Array.isArray(value["events"]) || !Array.isArray(value["refusedAppends"]) || !isRecord(value["readout"])) return invalid;
    if (Object.keys(value).sort().join(",") !== "costs,events,labels,readout,refusedAppends,runId,spec,summary") return invalid;
    for (const event of value["events"]) {
      if (!validateRunEvent(event).ok || !isRecord(event) || event["runId"] !== value["runId"]) return invalid;
    }
    const expected = buildRunExport({ runId: value["runId"], events: value["events"] as RunEvent[] });
    if (canonicalize(value["summary"]) !== canonicalize(expected.summary) ||
        canonicalize(value["costs"]) !== canonicalize(expected.costs)) return invalid;
    // The optional note describes config presence in the exporting workspace;
    // it cannot be recomputed in a different checkout and grants no authority.
    const { note, ...readout } = value["readout"];
    if ((note !== undefined && typeof note !== "string") || canonicalize(readout) !== canonicalize(expected.readout)) return invalid;
    return { ok: true, value: { ...expected, refusedAppends: value["refusedAppends"],
      readout: { ...expected.readout, ...(note === undefined ? {} : { note }) } } };
  } catch { return invalid; }
}
