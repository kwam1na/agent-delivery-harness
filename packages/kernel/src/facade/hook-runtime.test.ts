/**
 * What the emitted hook command is allowed to assume about its runtime.
 *
 * Both directions on every rule: a probe that refuses everything satisfies a
 * deny-only battery exactly as well as a working one, so each refusal here is
 * paired with the acceptance it is supposed to leave alone.
 */
import { describe, expect, it } from "vitest";
import { liveHookRuntimeProbes, resolveHookRuntimeArgs, STRIP_TYPES_FLAG, type HookRuntimeProbes } from "./hook-runtime.ts";

const nodeProbes = (overrides: Partial<HookRuntimeProbes> = {}): HookRuntimeProbes => ({
  execPath: "/usr/bin/node",
  versions: { node: "22.6.0", v8: "12.4" },
  acceptsFlag: () => true,
  ...overrides,
});

describe("resolveHookRuntimeArgs", () => {
  it("emits the type-stripping flag on a Node that accepts it, and probes for exactly that", () => {
    const asked: string[] = [];
    const resolution = resolveHookRuntimeArgs(
      nodeProbes({
        acceptsFlag: (flag) => {
          asked.push(flag);
          return true;
        },
      }),
    );
    expect(resolution.ok, JSON.stringify(resolution)).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.args).toEqual([STRIP_TYPES_FLAG]);
    // The resolution carries the executable it PROBED, so the caller can
    // compose the command around that one rather than re-reading the process.
    expect(resolution.execPath).toBe("/usr/bin/node");
    // The executable is asked about the flag the command would carry, and
    // about nothing else.
    expect(asked).toEqual([STRIP_TYPES_FLAG]);
  });

  it("REFUSES a Node that rejects the flag rather than emitting a command it will reject", () => {
    // This is the forward-looking case the probe exists for: a future runtime
    // that drops or renames the flag would otherwise be handed a command it
    // rejects, the interceptor would never start, and a deny-until-attested
    // boundary that does not start fails OPEN.
    const resolution = resolveHookRuntimeArgs(nodeProbes({ acceptsFlag: () => false }));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain(STRIP_TYPES_FLAG);
    expect(resolution.reason).toContain("/usr/bin/node");
  });

  it("REFUSES a runtime that is not Node, however loudly its compatibility shim claims to be", () => {
    // Bun and Deno both report `versions.node`, and Bun tolerates the flag, so
    // a flag probe alone would hand each of them a Node-shaped command built
    // around a `process.execPath` that is not node.
    for (const [runtime, version] of [
      ["bun", "1.1.30"],
      ["deno", "2.0.0"],
    ] as const) {
      const resolution = resolveHookRuntimeArgs(
        nodeProbes({ execPath: `/usr/local/bin/${runtime}`, versions: { node: "22.6.0", [runtime]: version } }),
      );
      expect(resolution.ok, runtime).toBe(false);
      if (resolution.ok) return;
      expect(resolution.reason).toContain(runtime);
      expect(resolution.reason).toContain(version);
    }
  });

  it("REFUSES a runtime that reports no Node version at all", () => {
    const resolution = resolveHookRuntimeArgs(nodeProbes({ versions: { v8: "12.4" } }));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain("no Node version");
  });

  it("refuses only the compatibility runtimes it NAMES, and that boundary is stated", () => {
    // The impostor rule is a denylist. An unlisted runtime that reports
    // `versions.node` is admitted and handed the Node-shaped command — there
    // is no positive Node identification available to this module. Recorded
    // here so the residual is a row rather than a surprise.
    expect(resolveHookRuntimeArgs(nodeProbes({ versions: { node: "22.6.0", graaljs: "24.0.0" } })).ok).toBe(true);
    expect(resolveHookRuntimeArgs(nodeProbes({ versions: { node: "22.6.0", bun: "1.1.30" } })).ok).toBe(false);
  });

  it("does not read the flag probe as an answer about which runtime this is", () => {
    // The two rules are independent: a non-Node runtime is refused whether or
    // not it accepts the flag, and a Node is accepted on the flag probe alone.
    expect(resolveHookRuntimeArgs(nodeProbes({ versions: { node: "22.6.0", bun: "1.1.30" }, acceptsFlag: () => true })).ok).toBe(false);
    expect(resolveHookRuntimeArgs(nodeProbes({ versions: { node: "23.11.0" }, acceptsFlag: () => true })).ok).toBe(true);
  });
});

describe("liveHookRuntimeProbes", () => {
  it("observes THIS process, and its accept probe answers both ways on the real executable", () => {
    const probes = liveHookRuntimeProbes();
    expect(probes.execPath).toBe(process.execPath);
    expect(probes.versions["node"]).toBe(process.versions.node);
    // The WHOLE version report is carried through, not a rebuilt `{ node }`
    // subset: the impostor rule reads members this row does not name, and a
    // default that reconstructs only `node` silently disables it — on Bun,
    // which is the runtime the ticket names.
    expect(probes.versions).toBe(process.versions);
    // Both directions against the real binary: the flag this repository's
    // runtime floor is built around is accepted, and an invented flag is not —
    // so the probe reports what the executable lists rather than a constant.
    expect(probes.acceptsFlag(STRIP_TYPES_FLAG)).toBe(true);
    // The negative witness is chosen INSIDE the shape a guess would accept: a
    // probe that answered `flag.startsWith("--experimental-")` — reading
    // nothing from the runtime at all — rejects `--no-such-flag-anywhere` for
    // the same reason the real enumeration does, and would pass a row written
    // that way.
    expect(probes.acceptsFlag("--experimental-no-such-flag-anywhere")).toBe(false);
  });

  it("answers the NODE_OPTIONS-allowlist question, which is NARROWER than the command line's", () => {
    // Node has always accepted `--eval` on the command line; it is simply not
    // permitted in NODE_OPTIONS, and this enumeration is the NODE_OPTIONS
    // allowlist. So a `true` implies CLI acceptance and only a `false` can be
    // over-strict. Any flag the emitted command carries must be one this
    // enumeration lists — a CLI-only flag would refuse a runtime that runs the
    // command fine, and nothing else in the suite would say so.
    expect(liveHookRuntimeProbes().acceptsFlag("--eval")).toBe(false);
    expect(liveHookRuntimeProbes().acceptsFlag(STRIP_TYPES_FLAG)).toBe(true);
  });

  it("reports UNSUPPORTED when the runtime's own flag enumeration cannot be read", () => {
    // The fail-closed branch: an undetectable runtime is a refusal, never a
    // silently Node-shaped command. It is the one refusal in this module that
    // does not run through `resolveHookRuntimeArgs`'s own rules.
    const original = Object.getOwnPropertyDescriptor(process, "allowedNodeEnvironmentFlags");
    expect(original).toBeDefined();
    Object.defineProperty(process, "allowedNodeEnvironmentFlags", {
      configurable: true,
      get() {
        throw new TypeError("unobservable");
      },
    });
    try {
      expect(liveHookRuntimeProbes().acceptsFlag(STRIP_TYPES_FLAG)).toBe(false);
      expect(resolveHookRuntimeArgs(liveHookRuntimeProbes()).ok).toBe(false);
    } finally {
      Object.defineProperty(process, "allowedNodeEnvironmentFlags", original!);
    }
    // ...and the restore really restored: the next reader sees the runtime.
    expect(liveHookRuntimeProbes().acceptsFlag(STRIP_TYPES_FLAG)).toBe(true);
  });

  it("carries the runtime's own identity into the impostor rule, not just its Node version", () => {
    // The second of the two assumptions V26-1510 names is that `execPath` is
    // Node at all, and the only thing that decides it is `versions`. Rebuild
    // that report as `{ node }` — the natural "cleanup" of the cast — and this
    // process passes for Node under any compatibility banner. Driven by
    // shadowing `process.versions` so the LIVE probe, not a constructed one,
    // is what answers.
    const original = Object.getOwnPropertyDescriptor(process, "versions");
    expect(original).toBeDefined();
    Object.defineProperty(process, "versions", {
      configurable: true,
      get() {
        return { ...(original!.value as NodeJS.ProcessVersions), bun: "1.1.30" };
      },
    });
    try {
      const resolution = resolveHookRuntimeArgs(liveHookRuntimeProbes());
      expect(resolution.ok, JSON.stringify(resolution)).toBe(false);
      if (resolution.ok) return;
      expect(resolution.reason).toContain("bun");
    } finally {
      Object.defineProperty(process, "versions", original!);
    }
    // ...and the restore took: the real process is Node again.
    expect(resolveHookRuntimeArgs(liveHookRuntimeProbes()).ok).toBe(true);
  });

  it("resolves the running runtime, which is the one the emitted command would name", () => {
    const resolution = resolveHookRuntimeArgs(liveHookRuntimeProbes());
    expect(resolution.ok, JSON.stringify(resolution)).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.args).toEqual([STRIP_TYPES_FLAG]);
    expect(resolution.execPath).toBe(process.execPath);
  });
});
