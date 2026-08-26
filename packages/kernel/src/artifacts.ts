/**
 * The kernel's filesystem port. Not yet implemented: the conformance kit's
 * integration mode is the failing suite this unit is written against, and it
 * fails here first.
 */
import type { ArtifactsPort } from "./artifacts.types.ts";

export type {
  ArtifactObservation,
  ArtifactObservationStatus,
  ArtifactsPort,
  RunRoot,
  RunRootRefusalReason,
  RunRootRequest,
  RunRootResolution,
  WriteFileOptions,
} from "./artifacts.types.ts";
export { ARTIFACT_OBSERVATION_STATUSES, RUN_ROOT_REFUSAL_REASONS } from "./artifacts.types.ts";

export const RUN_ROOT_NAMESPACE = "delivery-harness";
export const RUN_ROOT_LEAF = "runs";

export interface ArtifactsPortOptions {
  readonly runRootBase?: string;
}

const unimplemented = (): never => {
  throw new Error("artifacts port is not implemented");
};

export function defaultRunRootBase(): Promise<string> {
  return unimplemented();
}

export function isInsideResolved(_parent: string, _child: string): boolean {
  return unimplemented();
}

export function isSafeRelativePath(_value: string): boolean {
  return unimplemented();
}

export function createArtifactsPort(_options: ArtifactsPortOptions = {}): ArtifactsPort {
  return {
    allocateRunRoot: unimplemented,
    resolveRunRoot: unimplemented,
    isInsideRunRoot: unimplemented,
    observeArtifact: unimplemented,
    readTextFile: unimplemented,
    writeTextFile: unimplemented,
  };
}
