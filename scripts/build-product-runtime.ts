/** Producer-only bundling. Consumers run these files without npm or source paths. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function buildProductRuntime(root: string, workflowManifest: string, out: string): Promise<void> {
  const workflow = JSON.parse(await readFile(workflowManifest, "utf8")) as { contentSha256?: string; schemaVersion?: string };
  if (workflow.schemaVersion !== "agent-skills-release/1" || !/^[a-f0-9]{64}$/.test(workflow.contentSha256 ?? "")) {
    throw new Error("product.workflow_manifest: expected a verified workflow release manifest");
  }
  await mkdir(out, { recursive: true });
  for (const [name, source] of Object.entries({ cli: "packages/cli/src/main.ts", kernel: "packages/kernel/src/index.ts", policy: "scripts/recompile-policy-snapshot.ts" })) {
    await build({ absWorkingDir: root, entryPoints: [source], outfile: path.join(out, `${name}.mjs`), bundle: true, platform: "node", format: "esm", target: "node22.6", legalComments: "inline" });
  }
  await writeFile(path.join(out, "bootstrap.mjs"), 'import { register } from "node:module";\nregister(new URL("./loader.mjs", import.meta.url));\n');
  await writeFile(path.join(out, "loader.mjs"), 'export async function resolve(specifier, context, nextResolve) {\n  if (specifier === "@agent-delivery-harness/kernel") return { url: new URL("./kernel.mjs", import.meta.url).href, shortCircuit: true };\n  return nextResolve(specifier, context);\n}\n');
  for (const name of ["LICENSE", "NOTICE"]) await writeFile(path.join(out, name), await readFile(path.join(root, name)));
  const names = ["LICENSE", "NOTICE", "bootstrap.mjs", "cli.mjs", "kernel.mjs", "loader.mjs", "policy.mjs"];
  const files = await Promise.all(names.map(async (name) => ({ path: name, sha256: createHash("sha256").update(await readFile(path.join(out, name))).digest("hex") })));
  const pkg = JSON.parse(await readFile(path.join(root, "packages/kernel/package.json"), "utf8")) as { version: string };
  await writeFile(path.join(out, "runtime.json"), JSON.stringify({ schemaVersion: "delivery-runtime/1", runtimeVersion: pkg.version, nodeMinimum: "22.6.0", workflowContentSha256: workflow.contentSha256, files }, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, out] = process.argv.slice(2);
  if (!manifest || !out || process.argv.length !== 4) throw new Error("usage: build-product-runtime <verified-workflow-manifest> <output-directory>");
  await buildProductRuntime(process.cwd(), manifest, out);
}
