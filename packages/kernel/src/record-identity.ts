import { digestCanonical } from "./digest.ts";
import type { PublishRecordInput, RecordIdentity } from "./records.types.ts";
export function recordIdentity(workspaceId: string, input: PublishRecordInput): RecordIdentity {
  const common = {
    workspaceId,
    gateId: input.gateId,
    obligationId: input.obligationId,
    candidateBinding: input.candidateBinding,
  };
  return input.resolution.kind === "waiver"
    ? { ...common, kind: "waiver", approval: input.resolution }
    : {
        ...common,
        providerId: input.resolution.providerId,
        runId: input.resolution.runId,
        finalPassId: input.resolution.finalPassId,
      };
}

/** `recordId` = lowercase-hex sha256 over the canonical identity tuple. */
export function computeRecordId(workspaceId: string, input: PublishRecordInput): string {
  return digestCanonical(recordIdentity(workspaceId, input));
}
