/** Self-attested recovery history; never action execution or admission authority. */
import { digestCanonical } from "../digest.ts";
import type { RunEvent, RunEventInput } from "../checkpoint/run-event.ts";

export interface ReconciliationAction {
  readonly actionId: string;
  readonly operation?: unknown;
  readonly reference: unknown;
  readonly outcome: string;
  readonly inconsistent?: boolean;
  readonly historyDigest: string;
  readonly reconciliation?: { readonly eventId: string; readonly evidenceReference: string; readonly reason: string };
}

function reconciliationError(action: ReconciliationAction | undefined, payload: Readonly<Record<string, unknown>>): string | undefined {
  if (!action || !action.inconsistent) return "reconciliation requires an existing inconsistent action";
  if (payload["historyDigest"] !== action.historyDigest) return "action history changed; inspect the current history before reconciling";
  if (payload["observedReference"] !== action.reference) return "observed reference does not match the action being reconciled";
  return undefined;
}

/** Digest binds every action entry, including its run, sequence, actor and prior reconciliations. */
export function reconciliationActions(events: readonly RunEvent[]): ReconciliationAction[] {
  const actions = new Map<string, ReconciliationAction>();
  const histories = new Map<string, RunEvent[]>();
  for (const event of events) {
    if (!["action.intent", "action.observed", "action.reconciled"].includes(event.kind)) continue;
    const p = event.payload;
    const actionId = p["actionId"] as string;
    const prior = actions.get(actionId);
    const history = histories.get(actionId) ?? [];
    history.push(event);
    histories.set(actionId, history);
    const historyDigest = digestCanonical(history);
    if (event.kind === "action.intent") {
      actions.set(actionId, { actionId, operation: p["operation"], reference: p["reference"], outcome: "unknown", historyDigest,
        ...(prior ? { inconsistent: true } : {}) });
    } else if (event.kind === "action.observed") {
      actions.set(actionId, { ...prior, actionId, reference: p["reference"], outcome: p["outcome"] as string, historyDigest,
        ...(!prior || prior.inconsistent || (prior.outcome !== "unknown" && prior.outcome !== p["outcome"]) ||
          (prior.reconciliation && prior.reference !== p["reference"]) ? { inconsistent: true } : {}) });
    } else {
      // Invalid imported/hand-edited observations cannot clear a recovery blocker.
      const invalid = reconciliationError(prior, p);
      actions.set(actionId, { ...prior, actionId, reference: prior?.reference, historyDigest,
        outcome: invalid ? prior?.outcome ?? "unknown" : p["outcome"] as string, inconsistent: !!invalid,
        ...(!invalid ? { reconciliation: { eventId: event.eventId!, evidenceReference: p["evidenceReference"] as string, reason: p["reason"] as string } } : {}) });
    }
  }
  return [...actions.values()];
}

/** Called inside the append lock against the exact durable prefix. */
export function runActionReconciliationError(events: readonly RunEvent[], event: RunEventInput): string | undefined {
  if (event.kind !== "action.reconciled") return undefined;
  return reconciliationError(reconciliationActions(events).find(action => action.actionId === event.payload["actionId"]), event.payload);
}
