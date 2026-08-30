/**
 * The installation-scoped maintenance journal — the update journal, protected
 * with the same owner-only discipline as the trust store and install receipt.
 * Append-only durable JSONL under `<installation>/journal/maintenance.jsonl`;
 * every entry is a frozen `journal-entry/1` envelope in the `maintenance`
 * journal carrying a `maintenance.action.recorded` payload, validated by the
 * spine before it becomes durable.
 *
 * Beyond the frozen shape, appends enforce the journal's local discipline:
 * one subject (the installation identity), sequential expected revisions,
 * unique idempotency keys, and — because every consumed maintenance-lane
 * assertion is embedded verbatim — the journal doubles as the single-use
 * nonce ledger the consumption sites check replays against.
 */
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateJournalEntry } from "../spine/journal.ts";

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

export function maintenanceJournalPathFor(installationPath: string): string {
  return path.join(installationPath, "journal", "maintenance.jsonl");
}

export interface MaintenanceEntryView {
  readonly subjectId: string;
  readonly expectedRevision: number;
  readonly payload: Record<string, unknown>;
}

export type MaintenanceJournalRead =
  | { readonly ok: true; readonly entries: readonly MaintenanceEntryView[] }
  | { readonly ok: false; readonly message: string };

export async function readMaintenanceJournal(installationPath: string): Promise<MaintenanceJournalRead> {
  let text: string;
  try {
    text = await readFile(maintenanceJournalPathFor(installationPath), "utf8");
  } catch {
    return { ok: true, entries: [] };
  }
  const entries: MaintenanceEntryView[] = [];
  for (const [index, line] of text.split("\n").filter((candidate) => candidate.length > 0).entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, message: `maintenance journal line ${index} is not JSON; corrupt durable bytes fail closed` };
    }
    const verdict = validateJournalEntry(parsed);
    if (!verdict.ok) {
      return {
        ok: false,
        message: `maintenance journal line ${index} is outside the frozen grammar: ${verdict.rejections
          .map((rejection) => rejection.message)
          .join("; ")}`,
      };
    }
    const record = parsed as Record<string, unknown>;
    if (record["journal"] !== "maintenance") {
      return { ok: false, message: `maintenance journal line ${index} belongs to the ${String(record["journal"])} journal` };
    }
    entries.push({
      subjectId: record["subjectId"] as string,
      expectedRevision: record["expectedRevision"] as number,
      payload: record["payload"] as Record<string, unknown>,
    });
  }
  return { ok: true, entries };
}

export type MaintenanceAppendResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export async function appendMaintenanceAction(
  installationPath: string,
  installationId: string,
  payload: Record<string, unknown>,
): Promise<MaintenanceAppendResult> {
  const read = await readMaintenanceJournal(installationPath);
  if (!read.ok) return read;
  const expectedRevision = read.entries.length;
  const first = read.entries[0];
  if (first !== undefined && first.subjectId !== installationId) {
    return { ok: false, message: `this maintenance journal belongs to ${first.subjectId}, not ${installationId}` };
  }
  const entry = {
    spec: "journal-entry/1",
    journal: "maintenance",
    subjectId: installationId,
    expectedRevision,
    idempotencyKey: `m${expectedRevision}-${payload["action"]}-${payload["phase"]}`,
    kind: "maintenance.action.recorded",
    payload,
  };
  const verdict = validateJournalEntry(entry);
  if (!verdict.ok) {
    return {
      ok: false,
      message: `the frozen grammar refused the maintenance append: ${verdict.rejections
        .map((rejection) => rejection.message)
        .join("; ")}`,
    };
  }
  const journalPath = maintenanceJournalPathFor(installationPath);
  await mkdir(path.dirname(journalPath), { recursive: true, mode: OWNER_DIR });
  await appendFile(journalPath, `${JSON.stringify(entry)}\n`, { mode: OWNER_FILE });
  await chmod(journalPath, OWNER_FILE);
  return { ok: true };
}

/** Every assertion nonce the journal has consumed — the replay ledger. */
export function consumedNoncesOf(entries: readonly MaintenanceEntryView[]): Set<string> {
  const nonces = new Set<string>();
  for (const entry of entries) {
    const assertion = entry.payload["assertion"];
    if (typeof assertion === "object" && assertion !== null) {
      const nonce = (assertion as Record<string, unknown>)["nonce"];
      if (typeof nonce === "string") nonces.add(nonce);
    }
  }
  return nonces;
}

export interface InterruptedMaintenance {
  readonly action: string;
  readonly generationDigest: string;
}

/**
 * The last phased action left `started` without a later terminal phase. Only
 * a terminal entry of the SAME action closes the marker: an interposed
 * record of a different action — an installer repair is the one appender
 * that legitimately runs while an interruption stands — must not erase an
 * unrecovered interruption.
 */
export function interruptedMaintenanceOf(entries: readonly MaintenanceEntryView[]): InterruptedMaintenance | undefined {
  let open: InterruptedMaintenance | undefined;
  for (const entry of entries) {
    const phase = entry.payload["phase"];
    if (phase === "started") {
      open = {
        action: entry.payload["action"] as string,
        generationDigest: entry.payload["generationDigest"] as string,
      };
    } else if ((phase === "completed" || phase === "recovered") && entry.payload["action"] === open?.action) {
      open = undefined;
    }
  }
  return open;
}

/** The generation last activated by a terminal install/update/rollback record. */
export function lastActivatedGenerationOf(entries: readonly MaintenanceEntryView[]): string | undefined {
  let activated: string | undefined;
  for (const entry of entries) {
    const action = entry.payload["action"];
    const phase = entry.payload["phase"];
    const digest = entry.payload["generationDigest"];
    if (
      phase === "completed" &&
      typeof digest === "string" &&
      (action === "first-install" || action === "update" || action === "rollback")
    ) {
      activated = digest;
    }
  }
  return activated;
}
