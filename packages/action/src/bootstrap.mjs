// Consumer configuration imports the Action's pinned kernel, even when the
// repository has no harness package or source checkout installed.
import { register } from "node:module";
register(new URL("./loader.mjs", import.meta.url));
