/**
 * Host-neutral projection verification primitives.
 *
 * A host adapter may materialize and observe projection use, but the shared
 * decision layer owns the byte/receipt and marker readback checks. Keeping
 * these primitives outside any provider adapter prevents the durable writer
 * from depending on a particular host.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { compareUtf16CodeUnits } from "../canonical.ts";
import { digestCanonical, sha256Hex } from "../digest.ts";

export const PROJECTION_DIR = ".managed-projection";
export const PROJECTION_RECEIPT_FILE = "projection-receipt.json";
export const CONSUMPTION_MARKER_FILE = "consumption.json";

export interface ProjectionReceipt {
  readonly deliveryId: string;
  readonly projectionDigest: string;
  readonly entries: readonly { readonly path: string; readonly sha256: string }[];
}

export const projectionDigestOf = (entries: readonly { path: string; sha256: string }[]): string =>
  digestCanonical([...entries].sort((a, b) => compareUtf16CodeUnits(a.path, b.path)));

export type ProjectionVerificationBlockerCode =
  | "projection_receipt_missing"
  | "projection_receipt_corrupt"
  | "projection_digest_mismatch"
  | "consumption_marker_missing"
  | "consumption_marker_corrupt";

export interface ProjectionVerificationBlocker {
  readonly code: ProjectionVerificationBlockerCode;
  readonly message: string;
}

type ProjectionVerificationFailure = {
  readonly ok: false;
  readonly blockers: readonly ProjectionVerificationBlocker[];
};

const fail = (code: ProjectionVerificationBlockerCode, message: string): ProjectionVerificationFailure => ({
  ok: false,
  blockers: [{ code, message }],
});

export type VerifyProjectionResult =
  | {
      readonly ok: true;
      readonly projectionDigest: string;
      /** The receipted entry paths, in the receipt's own order. */
      readonly entries: readonly string[];
    }
  | ProjectionVerificationFailure;

/** Recompute every receipted byte and require the receipt to bind itself. */
export async function verifyProjection(input: {
  readonly worktreeDir: string;
  readonly bindingDir: string;
}): Promise<VerifyProjectionResult> {
  let receiptText: string;
  try {
    receiptText = await readFile(path.join(input.bindingDir, PROJECTION_RECEIPT_FILE), "utf8");
  } catch {
    return fail("projection_receipt_missing", "no projection receipt; nothing can be verified against it");
  }
  let receipt: ProjectionReceipt;
  try {
    receipt = JSON.parse(receiptText) as ProjectionReceipt;
  } catch {
    return fail("projection_receipt_corrupt", "the projection receipt is not JSON");
  }
  if (!Array.isArray(receipt.entries) || typeof receipt.projectionDigest !== "string") {
    return fail("projection_receipt_corrupt", "the projection receipt is outside its shape");
  }
  if (projectionDigestOf(receipt.entries) !== receipt.projectionDigest) {
    return fail("projection_receipt_corrupt", "the projection receipt does not bind its own entries");
  }

  for (const entry of receipt.entries) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path.join(input.worktreeDir, PROJECTION_DIR, ...entry.path.split("/")));
    } catch {
      return fail("projection_digest_mismatch", `receipted projection file ${entry.path} is missing from the worktree`);
    }
    const digest = sha256Hex(bytes);
    if (digest !== entry.sha256) {
      return fail(
        "projection_digest_mismatch",
        `projection file ${entry.path} hashes to ${digest}, not the receipted ${entry.sha256}; mid-run tampering fails closed`,
      );
    }
  }
  return {
    ok: true,
    projectionDigest: receipt.projectionDigest,
    entries: receipt.entries.map((entry) => entry.path),
  };
}

export interface ConsumptionMarker {
  readonly deliveryId: string;
  readonly fence: number;
  readonly consumed: string;
}

export type ReadConsumptionMarkerResult =
  | ({ readonly ok: true } & ConsumptionMarker)
  | ProjectionVerificationFailure;

/** Read the fence-bound marker back from the projection being adjudicated. */
export async function readConsumptionMarker(input: {
  readonly worktreeDir: string;
}): Promise<ReadConsumptionMarkerResult> {
  let text: string;
  try {
    text = await readFile(path.join(input.worktreeDir, PROJECTION_DIR, CONSUMPTION_MARKER_FILE), "utf8");
  } catch {
    return fail("consumption_marker_missing", "the worktree carries no per-run consumption marker; nothing was materialized here");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("consumption_marker_corrupt", "the consumption marker is not JSON");
  }
  const marker = parsed as Partial<ConsumptionMarker>;
  if (
    typeof marker !== "object" ||
    marker === null ||
    typeof marker.deliveryId !== "string" ||
    typeof marker.fence !== "number" ||
    typeof marker.consumed !== "string"
  ) {
    return fail("consumption_marker_corrupt", "the consumption marker is outside its shape");
  }
  return { ok: true, deliveryId: marker.deliveryId, fence: marker.fence, consumed: marker.consumed };
}
