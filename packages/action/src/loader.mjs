import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const kernel = pathToFileURL(realpathSync(fileURLToPath(new URL("../../kernel/src/index.ts", import.meta.url)))).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@agent-delivery-harness/kernel") return { url: kernel, shortCircuit: true };
  return nextResolve(specifier, context);
}
