import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "packages/kernel/dist"), { recursive: true });
const bundle = await rollup({
  input: path.join(root, "packages/kernel/src/index.ts"),
  external: [/^node:/],
  plugins: [dts({ tsconfig: path.join(root, "tsconfig.base.json") })],
});
try { await bundle.write({ file: path.join(root, "packages/kernel/dist/index.d.ts"), format: "es" }); }
finally { await bundle.close(); }
