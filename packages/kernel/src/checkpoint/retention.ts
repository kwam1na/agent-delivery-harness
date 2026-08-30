/**
 * The retention/export/deletion operations over the durable delivery
 * namespace. Both operate ONLY on owned paths — the common-Git product
 * namespace and the installation-scoped maintenance journal — and both
 * journal a `retention.action.recorded` entry to the MAINTENANCE journal, so
 * the record survives its target's removal.
 *
 * Deletion is terminal-only and preservation-first: the minimum
 * candidate/policy/evidence/action audit record is written into the
 * namespace's audit directory BEFORE any byte of the delivery is removed, and
 * the maintenance record reports exactly which audit records were preserved.
 * Export never mutates its target. Neither operation touches a worktree, a
 * candidate, or anything outside the namespace.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../digest.ts";
import { createJournalStore, createMaintenanceJournalStore } from "./journal-store.ts";

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

export interface RetentionContext {
  /** The common-Git product namespace directory. */
  readonly namespaceDir: string;
  /** The registering installation identity — the maintenance journal's subject. */
  readonly installationId: string;
  /** The installation-scoped maintenance journal path. */
  readonly maintenanceJournalPath: string;
}

export interface RetentionFailure {
  readonly ok: false;
  readonly code: string;
  readonly summary: string;
  readonly remediation: string;
}

const refuse = (code: string, summary: string, remediation: string): RetentionFailure => ({ ok: false, code, summary, remediation });

async function writeOwned(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: OWNER_DIR });
  await writeFile(target, contents, { mode: OWNER_FILE });
  await chmod(target, OWNER_FILE);
}

async function appendRetentionRecord(
  context: RetentionContext,
  action: "export" | "delete",
  deliveryId: string,
  artifactDigest: string,
  preservedAuditRecords: readonly string[],
): Promise<{ ok: true } | RetentionFailure> {
  const store = createMaintenanceJournalStore(context.maintenanceJournalPath);
  const read = await store.read();
  if (!read.ok) {
    return refuse("maintenance_journal_unreadable", "The maintenance journal is unreadable.", "Inspect the installation's maintenance journal file.");
  }
  let expectedRevision = 0;
  if (read.entries.length > 0) {
    const reduced = await store.state();
    if (!reduced.ok) {
      return refuse("maintenance_journal_rejected", "The maintenance journal does not reduce.", "Inspect the installation's maintenance journal file.");
    }
    expectedRevision = reduced.state.expectedRevision;
  }
  const appended = await store.append({
    spec: "journal-entry/1",
    journal: "maintenance",
    subjectId: context.installationId,
    expectedRevision,
    idempotencyKey: `m${read.entries.length}-${action}-${deliveryId}`,
    kind: "retention.action.recorded",
    payload: { action, subjectDeliveryId: deliveryId, artifactDigest, preservedAuditRecords: [...preservedAuditRecords] },
  });
  if (!appended.ok) {
    return refuse(
      "maintenance_journal_rejected",
      `The maintenance journal refused the retention record: ${appended.rejections.map((rejection) => rejection.message).join("; ")}`,
      "The retention action is not performed without its durable record.",
    );
  }
  return { ok: true };
}

interface JournalEntryView {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

const lastOf = (views: readonly JournalEntryView[], kind: string): JournalEntryView | undefined =>
  [...views].reverse().find((view) => view.kind === kind);

export type ExportDeliveryResult =
  | { readonly ok: true; readonly exportPath: string; readonly artifactDigest: string }
  | RetentionFailure;

export async function exportDelivery(context: RetentionContext, deliveryId: string): Promise<ExportDeliveryResult> {
  const deliveryDir = path.join(context.namespaceDir, "deliveries", deliveryId);
  const store = createJournalStore(path.join(deliveryDir, "journal.jsonl"));
  const read = await store.read();
  if (!read.ok || read.entries.length === 0) {
    return refuse("unknown_delivery", `No registered delivery ${deliveryId} to export.`, "Name a registered delivery.");
  }
  let meta: unknown;
  try {
    meta = JSON.parse(await readFile(path.join(deliveryDir, "delivery.json"), "utf8"));
  } catch {
    meta = undefined;
  }
  const bundle = `${JSON.stringify({
    spec: "delivery-export/1",
    deliveryId,
    installationId: context.installationId,
    journal: read.entries,
    ...(meta === undefined ? {} : { meta }),
  })}\n`;
  const artifactDigest = sha256Hex(bundle);
  const exportPath = path.join(context.namespaceDir, "exports", `${deliveryId}.json`);
  await writeOwned(exportPath, bundle);
  const recorded = await appendRetentionRecord(context, "export", deliveryId, artifactDigest, []);
  if (!recorded.ok) return recorded;
  return { ok: true, exportPath, artifactDigest };
}

export type DeleteDeliveryResult =
  | {
      readonly ok: true;
      readonly auditPath: string;
      readonly preservedAuditRecords: readonly string[];
      readonly artifactDigest: string;
    }
  | RetentionFailure;

export async function deleteDelivery(context: RetentionContext, deliveryId: string): Promise<DeleteDeliveryResult> {
  const deliveryDir = path.join(context.namespaceDir, "deliveries", deliveryId);
  const store = createJournalStore(path.join(deliveryDir, "journal.jsonl"));
  const read = await store.read();
  if (!read.ok || read.entries.length === 0) {
    return refuse("unknown_delivery", `No registered delivery ${deliveryId} to delete.`, "Name a registered delivery.");
  }
  const reduced = await store.state();
  if (!reduced.ok) {
    return refuse("journal_rejected", "The delivery journal does not reduce; nothing is deleted over a journal that fails closed.", "Inspect the durable journal file.");
  }
  const finalState = reduced.state.state;
  if (finalState !== "completed" && finalState !== "cancelled" && finalState !== "failed") {
    return refuse(
      "delivery_not_terminal",
      `Delivery ${deliveryId} is ${finalState}; only terminal-delivery detail is deletable.`,
      "Finish or cancel the delivery first; retention bounds apply to terminal detail only.",
    );
  }

  // The minimum candidate/policy/evidence/action audit record, preserved
  // BEFORE removal per repository obligations.
  const views = read.entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    return { kind: record["kind"] as string, payload: record["payload"] as Record<string, unknown> };
  });
  const registered = lastOf(views, "delivery.registered");
  const candidate = lastOf(views, "candidate.recaptured") ?? lastOf(views, "invocation.fenced");
  const finishLine = lastOf(views, "finish.line.recorded");
  const audit = `${JSON.stringify({
    spec: "delivery-audit/1",
    deliveryId,
    finalState,
    contractDigest: registered?.payload["contractDigest"],
    ...(reduced.state.policyDigest === undefined ? {} : { policyDigest: reduced.state.policyDigest }),
    ...(reduced.state.generationDigest === undefined ? {} : { generationDigest: reduced.state.generationDigest }),
    ...(candidate === undefined ? {} : { candidate: candidate.payload }),
    evidenceReferences: views.filter((view) => view.kind === "evidence.reference.recorded").map((view) => view.payload),
    actions: views.filter((view) => view.kind === "finish.line.recorded").length,
    ...(finishLine === undefined ? {} : { finishLine: finishLine.payload }),
  })}\n`;
  const auditRelative = path.join("audit", `${deliveryId}.json`);
  const auditPath = path.join(context.namespaceDir, auditRelative);
  await writeOwned(auditPath, audit);

  const preservedAuditRecords = [auditRelative];
  const recorded = await appendRetentionRecord(context, "delete", deliveryId, sha256Hex(audit), preservedAuditRecords);
  if (!recorded.ok) return recorded;

  // Only now, with the audit record durable and the maintenance journal
  // carrying the action, does the terminal delivery detail leave the disk.
  await rm(deliveryDir, { recursive: true, force: true });
  return { ok: true, auditPath, preservedAuditRecords, artifactDigest: sha256Hex(audit) };
}
