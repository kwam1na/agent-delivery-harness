import { realpath } from "node:fs/promises";
import path from "node:path";
import { readArchiveFile } from "./run-archive-commands.ts";
/** Explicit retained-record reads only: no executable configuration or verification. */
import {
  isSafeRelativePath,
  isInsideResolved,
  parseDeliveryRecord,
  digestCanonical,
} from "@agent-delivery-harness/kernel";
import type { RunView, RunViewItem } from "./run-view.ts";
export async function withRetainedRecord(
  view: RunView,
  root: string,
  relativePath?: string,
): Promise<RunView> {
  if (relativePath === undefined || view.historical) return view;
  const fields: { label: string; value: string }[] = [];
  const add = (label: string, value: string) => fields.push({ label, value });
  add("Source", relativePath);
  add(
    "Applicability",
    "Unknown — no current identity comparison or fresh verification is performed",
  );
  add(
    "Original verification time",
    "Unavailable — delivery records do not store a verification timestamp",
  );
  try {
    let status = "path_refused";
    let contents: string | null = null;
    if (isSafeRelativePath(relativePath)) {
      const resolvedRoot = await realpath(root);
      const resolvedFile = await realpath(
        path.join(resolvedRoot, relativePath),
      );
      if (!isInsideResolved(resolvedRoot, resolvedFile))
        status = "outside_run_root";
      else {
        contents = await readArchiveFile(resolvedFile);
        status = "readable";
      }
    }
    const read = { status, contents };
    if (read.status !== "readable" || read.contents === null) {
      add("Status", `Unavailable — ${read.status}`);
    } else {
      const parsed = parseDeliveryRecord(read.contents);
      if (!parsed.ok)
        add("Status", "Corrupt — retained record grammar is invalid");
      else {
        const { integrityDigest, ...unsigned } = parsed.record;
        if (parsed.record.version !== "delivery-record/2")
          add(
            "Status",
            "Legacy record — integrity unavailable; no accepted evidence inferred",
          );
        else if (integrityDigest !== digestCanonical(unsigned))
          add("Status", "Corrupt — retained record digest does not match");
        else {
          add(
            "Status",
            "Recorded for the candidate below — retained self-attested record, not current approval",
          );
          add("Candidate", parsed.record.candidateBinding.treeSha);
          add(
            "Deliverable digest",
            parsed.record.candidateBinding.deliverableDigest,
          );
          for (const claim of parsed.record.claims) {
            add(`Recorded claim · ${claim.obligationId}`, claim.outcome);
            for (const evidence of [
              claim.evidence,
              ...(claim.supportingEvidence ?? []),
            ]) {
              if (evidence?.resolution.kind !== "evidence") continue;
              const manifest = evidence.resolution.portable?.manifest;
              if (typeof manifest !== "object" || manifest === null) continue;
              if (
                digestCanonical(manifest) !== evidence.resolution.manifestDigest
              ) {
                add(
                  "Retained manifest",
                  "Corrupt — digest does not match; timestamp unavailable",
                );
                continue;
              }
              const at = (manifest as Record<string, unknown>)["recordedAt"];
              add(
                `Provider-reported recording time · ${evidence.resolution.providerId}`,
                typeof at === "string" ? at : "Unavailable",
              );
            }
          }
        }
      }
    }
  } catch (error) {
    add(
      "Status",
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Unavailable — missing"
        : "Unavailable — bounded retained record read refused",
    );
  }
  const retained: RunViewItem = {
    id: "retained-record",
    label: "Retained delivery record",
    fields,
  };
  return {
    ...view,
    sections: view.sections.map((section) =>
      section.id === "evidence"
        ? { ...section, items: [retained, ...section.items] }
        : section,
    ),
  };
}
