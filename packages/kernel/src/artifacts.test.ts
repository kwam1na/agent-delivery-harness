/**
 * The filesystem port.
 *
 * Three groups of claims, and they are separable on purpose:
 *
 *   PATHS RESOLVE BEFORE THEY ARE COMPARED. The macOS `/var` → `/private/var`
 *   alias is the case that motivated this and it has a test of its own, built
 *   from an explicit symlink so it runs the same way on every platform.
 *   Containment is not a string prefix, and a symlink that resolves inside a
 *   run root is an ordinary file while one that resolves outside is an escape.
 *
 *   PROVIDER-SUPPLIED STRINGS NEVER REACH `path.join` UNCHECKED. A `runId` of
 *   `"../run-a"` is refused before any filesystem call, which is what stops a
 *   manifest from naming another provider's directory on its way to being
 *   rejected for the same reason.
 *
 *   THE WRITE PATH IS ATOMIC. Its first consumer is the delivery-record command
 *   this kernel does not have yet, which is exactly why it is tested here: a
 *   write path whose only test is a caller that does not exist yet is a write
 *   path with no test.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RUN_ROOT_LEAF,
  RUN_ROOT_NAMESPACE,
  createArtifactsPort,
  defaultRunRootBase,
  isInsideResolved,
  isSafeRelativePath,
} from "./artifacts.ts";
import { BlockedError } from "./blockers.ts";
import { sha256Hex } from "./digest.ts";

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(await realpath(tmpdir()), "artifacts-test-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function freshBase(name: string): Promise<string> {
  const base = path.join(workspace, name);
  await mkdir(base, { recursive: true });
  return base;
}

// ── Run roots ──────────────────────────────────────────────────────────────

describe("run-root derivation", () => {
  it("keys a run root by provider and run id under the injected base", async () => {
    const base = await freshBase("derive");
    const port = createArtifactsPort({ runRootBase: base });

    const allocation = await port.allocateRunRoot({ providerId: "claude-code.ce-code-review", runId: "r-1" });
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    expect(allocation.runRoot.path).toBe(path.join(base, "claude-code.ce-code-review", "r-1"));
    expect((await stat(allocation.runRoot.path)).isDirectory()).toBe(true);
  });

  it("creates the run root owner-only", async () => {
    const base = await freshBase("modes");
    const port = createArtifactsPort({ runRootBase: base });
    const allocation = await port.allocateRunRoot({ providerId: "p", runId: "r-1" });
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    // Evidence bytes a digest is about to be taken of are not world-readable.
    expect((await stat(allocation.runRoot.path)).mode & 0o777).toBe(0o700);
  });

  it("resolves without creating", async () => {
    const base = await freshBase("resolve-only");
    const port = createArtifactsPort({ runRootBase: base });
    const allocation = await port.resolveRunRoot({ providerId: "p", runId: "r-2" });
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    await expect(stat(allocation.runRoot.path)).rejects.toThrow();
  });

  it.each([
    ["../run-a", "unsafe_run_id"],
    ["nested/run-a", "unsafe_run_id"],
    ["nested\\run-a", "unsafe_run_id"],
    [".", "unsafe_run_id"],
    ["..", "unsafe_run_id"],
    ["", "unsafe_run_id"],
    ["-leading-dash", "unsafe_run_id"],
    ["a".repeat(129), "unsafe_run_id"],
  ])("refuses the run id %j before touching the filesystem", async (runId, reason) => {
    const base = await freshBase(`refuse-${sha256Hex(runId).slice(0, 12)}`);
    const port = createArtifactsPort({ runRootBase: base });
    const allocation = await port.allocateRunRoot({ providerId: "p", runId });
    expect(allocation.ok).toBe(false);
    if (allocation.ok) return;
    expect(allocation.reason).toBe(reason);
    // The whole point of refusing early: nothing was created, anywhere.
    expect(await readdir(base)).toEqual([]);
  });

  it.each(["../evil", "Upper.Case", "trailing.", "", "with space"])(
    "refuses the provider id %j",
    async (providerId) => {
      const base = await freshBase(`provider-${sha256Hex(providerId).slice(0, 12)}`);
      const port = createArtifactsPort({ runRootBase: base });
      const allocation = await port.allocateRunRoot({ providerId, runId: "r-1" });
      expect(allocation.ok).toBe(false);
      if (allocation.ok) return;
      expect(allocation.reason).toBe("unsafe_provider_id");
      expect(await readdir(base)).toEqual([]);
    },
  );

  it("derives the default base under the system temp directory and this harness's namespace", async () => {
    const base = await defaultRunRootBase();
    expect(base).toBe(path.join(await realpath(tmpdir()), RUN_ROOT_NAMESPACE, RUN_ROOT_LEAF));
    // Resolved, so containment comparisons downstream are physical-to-physical.
    expect(base).toBe(await realpath(base));
  });
});

// ── The alias ──────────────────────────────────────────────────────────────

describe("symlinked bases and the macOS /var alias", () => {
  /**
   * On macOS `os.tmpdir()` reports `/var/folders/...`, a symlink to
   * `/private/var/folders/...`. A run root captured through the alias and an
   * artifact resolved with `realpath` differ in their first segment, so an
   * unresolved comparison would report every artifact in every run as an escape
   * — on one platform, for a reason that has nothing to do with the rule. The
   * alias is reconstructed explicitly here rather than relying on the host's
   * temp directory happening to be one.
   */
  it("resolves an aliased base, so containment holds through the alias", async () => {
    const physical = await freshBase("alias-physical");
    const alias = path.join(workspace, "alias-link");
    await symlink(physical, alias);
    expect(await lstat(alias).then((info) => info.isSymbolicLink())).toBe(true);

    const port = createArtifactsPort({ runRootBase: alias });
    const allocation = await port.allocateRunRoot({ providerId: "p", runId: "r-1" });
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;

    // The run root is reported physically, not through the alias.
    expect(allocation.runRoot.path.startsWith(physical)).toBe(true);
    expect(allocation.runRoot.path.startsWith(alias)).toBe(false);

    // And a file written through the alias is inside it all the same.
    const throughAlias = path.join(alias, "p", "r-1", "reviewers", "a.json");
    await mkdir(path.dirname(throughAlias), { recursive: true });
    await writeFile(throughAlias, "{}", "utf8");
    expect(await port.isInsideRunRoot(allocation.runRoot.path, throughAlias)).toBe(true);

    const observation = await port.observeArtifact(allocation.runRoot.path, "reviewers/a.json");
    expect(observation.status).toBe("readable");
  });

  it("is not a string-prefix test", () => {
    // `/tmp/run-a2` is not inside `/tmp/run-a`; it is a different run.
    expect(isInsideResolved("/tmp/run-a", "/tmp/run-a2/file.json")).toBe(false);
    expect(isInsideResolved("/tmp/run-a", "/tmp/run-a/file.json")).toBe(true);
    // A directory is not inside itself.
    expect(isInsideResolved("/tmp/run-a", "/tmp/run-a")).toBe(false);
    expect(isInsideResolved("/tmp/run-a", "/tmp")).toBe(false);
  });
});

// ── Observation ────────────────────────────────────────────────────────────

describe("artifact observation", () => {
  async function runRootWith(name: string): Promise<{ readonly port: ReturnType<typeof createArtifactsPort>; readonly runRoot: string }> {
    const base = await freshBase(name);
    const port = createArtifactsPort({ runRootBase: base });
    const allocation = await port.allocateRunRoot({ providerId: "p", runId: "r-1" });
    if (!allocation.ok) throw new Error("fixture run root was refused");
    return { port, runRoot: allocation.runRoot.path };
  }

  it("reads the bytes and digests them", async () => {
    const { port, runRoot } = await runRootWith("observe-readable");
    const contents = '{"reviewerId":"correctness"}';
    await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
    await writeFile(path.join(runRoot, "reviewers", "a.json"), contents, "utf8");

    const observation = await port.observeArtifact(runRoot, "reviewers/a.json");
    expect(observation.status).toBe("readable");
    expect(observation.sha256).toBe(sha256Hex(contents));
    expect(observation.contents).toBe(contents);
    expect(observation.detail).toBeNull();
  });

  it("digests the raw bytes, not a decoded string", async () => {
    const { port, runRoot } = await runRootWith("observe-bytes");
    // A lone surrogate half: decoding to UTF-8 and re-encoding would not
    // round-trip, so a digest taken over the decoded string would differ from
    // the digest of what is actually on disk.
    const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    await writeFile(path.join(runRoot, "raw.bin"), bytes);
    const observation = await port.observeArtifact(runRoot, "raw.bin");
    expect(observation.sha256).toBe(sha256Hex(bytes));
    expect(observation.sha256).not.toBe(sha256Hex(bytes.toString("utf8")));
  });

  it("reports a file that is not there as missing", async () => {
    const { port, runRoot } = await runRootWith("observe-missing");
    const observation = await port.observeArtifact(runRoot, "reviewers/missing.json");
    expect(observation.status).toBe("missing");
    expect(observation.sha256).toBeNull();
  });

  it("reports a directory as not a file", async () => {
    const { port, runRoot } = await runRootWith("observe-directory");
    await mkdir(path.join(runRoot, "reviewers"), { recursive: true });
    const observation = await port.observeArtifact(runRoot, "reviewers");
    expect(observation.status).toBe("not_a_file");
    expect(observation.sha256).toBeNull();
  });

  it("accepts a symlink that resolves inside the run root", async () => {
    const { port, runRoot } = await runRootWith("observe-symlink-inside");
    const contents = '{"reviewerId":"security"}';
    await writeFile(path.join(runRoot, "real.json"), contents, "utf8");
    await symlink(path.join(runRoot, "real.json"), path.join(runRoot, "link.json"));

    const observation = await port.observeArtifact(runRoot, "link.json");
    expect(observation.status).toBe("readable");
    expect(observation.sha256).toBe(sha256Hex(contents));
    // Pinned deliberately: containment is judged after resolution, so a link
    // within the run is a file, not an escape.
    expect(observation.resolvedPath).toBe(path.join(runRoot, "real.json"));
  });

  it("reports a symlink that resolves outside the run root as an escape", async () => {
    const { port, runRoot } = await runRootWith("observe-symlink-outside");
    const outside = path.join(workspace, "observe-symlink-outside-target.json");
    await writeFile(outside, "{}", "utf8");
    await symlink(outside, path.join(runRoot, "escape.json"));

    const observation = await port.observeArtifact(runRoot, "escape.json");
    expect(observation.status).toBe("outside_run_root");
    // Nothing is read from an escape: reporting its digest would make the check
    // look like it passed something.
    expect(observation.sha256).toBeNull();
    expect(observation.contents).toBeNull();
  });

  it("refuses an unsafe declared path without touching the filesystem", async () => {
    const { port, runRoot } = await runRootWith("observe-refused");
    for (const declared of ["../outside.json", "/etc/passwd", "a//b.json", "C:\\evil"]) {
      const observation = await port.observeArtifact(runRoot, declared);
      expect(observation.status, declared).toBe("path_refused");
      expect(observation.resolvedPath, declared).toBeNull();
    }
  });

  it("reports a missing run root rather than resolving paths against nothing", async () => {
    const base = await freshBase("observe-no-root");
    const port = createArtifactsPort({ runRootBase: base });
    const observation = await port.observeArtifact(path.join(base, "never-allocated"), "a.json");
    expect(observation.status).toBe("missing");
  });
});

// ── The path predicate ─────────────────────────────────────────────────────

describe("the safe-relative-path predicate", () => {
  it.each(["reviewers/a.json", "a.json", "deep/nested/path/file.json", "./a.json", "dot.name/file"])(
    "accepts %j",
    (value) => {
      expect(isSafeRelativePath(value)).toBe(true);
    },
  );

  it.each(["", "/absolute", "\\unc", "C:/drive", "c:\\drive", "../escape", "a/../b", "a//b", "a/"])(
    "refuses %j",
    (value) => {
      expect(isSafeRelativePath(value)).toBe(false);
    },
  );
});

// ── The write path ─────────────────────────────────────────────────────────

describe("the atomic write path", () => {
  it("writes a file, creating the directories it needs", async () => {
    const base = await freshBase("write-new");
    const port = createArtifactsPort({ runRootBase: base });
    const target = path.join(base, "docs", "reports", "delivery-record.json");

    await port.writeTextFile(target, '{"version":"delivery-record/1"}\n');
    expect(await readFile(target, "utf8")).toBe('{"version":"delivery-record/1"}\n');
    // The delivery record is a tracked working-tree file, not store-private.
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  it("honours an explicit mode", async () => {
    const base = await freshBase("write-mode");
    const port = createArtifactsPort({ runRootBase: base });
    const target = path.join(base, "private.json");
    await port.writeTextFile(target, "{}", { mode: 0o600 });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("replaces an existing file and leaves no temporary behind", async () => {
    const base = await freshBase("write-replace");
    const port = createArtifactsPort({ runRootBase: base });
    const target = path.join(base, "record.json");

    await port.writeTextFile(target, "first");
    await port.writeTextFile(target, "second");
    expect(await readFile(target, "utf8")).toBe("second");
    // A rename replaces; it does not accumulate. An orphaned temporary would be
    // a reader's problem later, and a dot-prefixed one is invisible to a
    // careless listing, so it is asserted rather than eyeballed.
    expect(await readdir(base)).toEqual(["record.json"]);
  });

  it("reports an unwritable destination as a typed blocker", async () => {
    const base = await freshBase("write-unwritable");
    const locked = path.join(base, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      await expect(createArtifactsPort({ runRootBase: base }).writeTextFile(path.join(locked, "x.json"), "{}")).rejects.toBeInstanceOf(
        BlockedError,
      );
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("reports an unreadable file as a typed blocker", async () => {
    const base = await freshBase("read-missing");
    await expect(createArtifactsPort({ runRootBase: base }).readTextFile(path.join(base, "nope.json"))).rejects.toBeInstanceOf(
      BlockedError,
    );
  });
});
