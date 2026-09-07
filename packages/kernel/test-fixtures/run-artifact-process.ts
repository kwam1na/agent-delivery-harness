import { createRunStore } from "../src/checkpoint/run-store.ts";
import {
  captureRunArtifact,
  type RunArtifactMetadata,
} from "../src/checkpoint/run-artifacts.ts";
const input = JSON.parse(process.argv[2]!) as {
  root: string;
  runId: string;
  sourceRoot: string;
  sourcePath: string;
  metadata: RunArtifactMetadata;
};
process.stdout.write(
  JSON.stringify(
    await captureRunArtifact({ ...input, store: createRunStore(input.root) }),
  ),
);
