/**
 * What the emitted hook command may assume about the runtime it names.
 *
 * The facade emits a model-external hook command that runs on the RUNNING
 * executable and names a TypeScript entry the runtime has to strip types from
 * itself — this repository ships zero runtime dependencies, so there is no
 * loader to reach for. Two assumptions were previously baked into that command
 * as constants:
 *
 *   1. that the runtime accepts `--experimental-strip-types`, and
 *   2. that `process.execPath` is a Node executable at all.
 *
 * Both held by coincidence rather than by construction. The first is
 * forward-looking: a future runtime that drops or renames the flag would be
 * handed a command it rejects, the interceptor would never start, and a
 * deny-until-attested boundary that does not start fails OPEN — the exact
 * failure the 22.6 activation floor exists to close. The second is true of
 * Bun today, where `execPath` is the bun binary while the command is composed
 * Node-shaped.
 *
 * So both are PROBED rather than assumed, and the probe FAILS CLOSED: a
 * runtime whose support cannot be observed is a typed refusal, never a
 * silently Node-shaped command. That is the asymmetry that matters — a wrong
 * refusal is a blocked session a reader can act on, and a wrong emission is an
 * interceptor that never runs.
 *
 * The flag question is asked of the executable itself rather than of a version
 * number — the way `packages/action/action.yml` asks it — but it is asked
 * IN-PROCESS, through `process.allowedNodeEnvironmentFlags`, rather than by
 * spawning `node --experimental-strip-types --version` the way the shell
 * action must. The action has no other way to ask; this module does, and the
 * spawn was falsified here before it shipped: under the machine contention an
 * ordinary parallel test run produces, the spawn exceeded its timeout and the
 * probe reported the flag as REJECTED on a runtime that accepts it — a
 * fail-closed refusal caused by load rather than by the runtime. An answer the
 * runtime already holds cannot flake and costs nothing.
 *
 * IT IS NOT THE SAME QUESTION, AND THE DIFFERENCE IS STATED RATHER THAN
 * GLOSSED. `allowedNodeEnvironmentFlags` enumerates the flags permitted in
 * `NODE_OPTIONS`, which is a STRICT SUBSET of the flags Node accepts on the
 * command line: on v23.5.0 it lists neither `--eval` nor `--print`, `--check`,
 * `--test` nor `--version`, all of which the CLI accepts. So a `true` here
 * implies CLI acceptance, and only a `false` can be over-strict — the error
 * direction is a false refusal, which is the closed one, but a false refusal
 * blocks `bindWorkspace` outright. THEREFORE: any flag added to the emitted
 * command must first be confirmed to be in this allowlist. A CLI-only flag
 * would refuse a runtime that runs the command perfectly well, and the suite
 * would not object. `--experimental-strip-types` is `NODE_OPTIONS`-permitted
 * on every Node from 22.6 up, which is what makes this probe sound for the
 * command as it stands; `hook-runtime.test.ts` pins the subset property so the
 * next flag gets a red row instead of a production refusal.
 *
 * This decides only what the emitted command may contain. The enforced Node
 * floor stays where it is, in the activation preflight (`MINIMUM_NODE`), and
 * is untouched by this module.
 */
export interface HookRuntimeProbes {
  /** The executable the emitted command would name (`process.execPath`). */
  readonly execPath: string;
  /**
   * The runtime's own version report (`process.versions`). Bun and Deno both
   * report a `node` member for compatibility, so the presence of `node` is
   * read as necessary and not sufficient: a runtime that ALSO names itself is
   * that runtime, whatever its compatibility shim claims.
   */
  readonly versions: Readonly<Record<string, string | undefined>>;
  /** True when this executable accepts that flag. Never throws. */
  readonly acceptsFlag: (flag: string) => boolean;
}

export type HookRuntimeResolution =
  /**
   * `execPath` is the executable that was PROBED, carried through so the
   * caller composes the command around the same one it validated rather than
   * re-reading `process.execPath` and hoping the two agree.
   */
  | { readonly ok: true; readonly execPath: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** The flag Node needs to strip types from the staged `.ts` hook entry. */
export const STRIP_TYPES_FLAG = "--experimental-strip-types";

/**
 * Runtimes that are not Node but answer `process.versions.node` anyway. The
 * emitted command is Node-shaped — Node's flag spellings, Node's type
 * stripping, Node's exit-code contract with the host — so a different
 * executable under a compatibility banner is refused rather than handed it.
 */
const IMPOSTER_RUNTIMES = Object.freeze(["bun", "deno"] as const);

export function resolveHookRuntimeArgs(probes: HookRuntimeProbes): HookRuntimeResolution {
  const impostor = IMPOSTER_RUNTIMES.find((runtime) => typeof probes.versions[runtime] === "string");
  if (impostor !== undefined) {
    return {
      ok: false,
      reason: `the emitted hook command is Node-shaped, and this runtime reports ${impostor} ${probes.versions[impostor]} at ${probes.execPath}`,
    };
  }
  if (typeof probes.versions["node"] !== "string") {
    return { ok: false, reason: `the emitted hook command is Node-shaped, and ${probes.execPath} reports no Node version` };
  }
  if (probes.acceptsFlag(STRIP_TYPES_FLAG)) return { ok: true, execPath: probes.execPath, args: [STRIP_TYPES_FLAG] };
  return {
    ok: false,
    reason: `${probes.execPath} rejects ${STRIP_TYPES_FLAG}, so it cannot run the staged TypeScript hook entry this command names`,
  };
}

/**
 * Observes the real process. `allowedNodeEnvironmentFlags` is this
 * executable's own enumeration of the flags it permits in `NODE_OPTIONS`, so
 * the probe reads an answer rather than computing one, and a runtime that
 * dropped or renamed the flag simply does not list it. See the header for the
 * one way that question is narrower than the command line's.
 */
export function liveHookRuntimeProbes(): HookRuntimeProbes {
  return {
    execPath: process.execPath,
    versions: process.versions as unknown as Readonly<Record<string, string | undefined>>,
    acceptsFlag: (flag) => {
      try {
        return process.allowedNodeEnvironmentFlags.has(flag);
      } catch {
        // Unobservable is not the same as supported.
        return false;
      }
    },
  };
}
