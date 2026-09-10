/**
 * Executable entry-point identity at the host boundary.
 *
 * This module belongs to `host/` because deciding whether two filesystem
 * spellings name the same executable requires `realpathSync`. It is therefore
 * classified only under the kernel's `e` decision-time rule: it cannot join the
 * d1 pure set, and it is not one of the d2 modules whose filesystem work must go
 * through the artifact port.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The `file:` href for a filesystem spelling, with URL-significant characters
 * escaped. `invokedDirectly` compares resolved paths directly; it does not add
 * a URL round trip to the identity decision.
 */
export function entryHref(entryPath: string): string {
  return pathToFileURL(entryPath).href;
}

/** The spelling the filesystem can vouch for, or the supplied spelling when it cannot. */
function canonicalEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    // Entry guards are a best-effort identity check around importable modules.
    // Unlike artifact resolution, failure here carries no path-access verdict
    // to report. Preserving the spelling retains the pre-resolution behavior
    // for missing paths without turning a harmless library import into a throw.
    return entryPath;
  }
}

/**
 * Whether `argvEntry` and `moduleHref` identify the same executable module.
 *
 * Node normally builds `import.meta.url` from a module's realpath, but under
 * `--preserve-symlinks-main` it keeps the caller's symlink spelling. Resolve
 * each side independently before comparing so both regimes agree. Keeping the
 * fallback per side also preserves the resolvable side under an unexpected
 * permission failure. That distinction cannot be made portable in the suite:
 * root and non-root runners disagree about an EACCES fixture. A side the
 * filesystem cannot resolve keeps its spelling; a non-`file:` module href and
 * a missing argv entry never match.
 */
export function invokedDirectly(argvEntry: string | undefined, moduleHref: string): boolean {
  if (argvEntry === undefined) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleHref);
  } catch {
    return false;
  }
  return canonicalEntryPath(argvEntry) === canonicalEntryPath(modulePath);
}
