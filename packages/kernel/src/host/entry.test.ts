import { realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { entryHref, invokedDirectly } from "./entry.ts";

describe("host entry identity", () => {
  const cleanups: string[] = [];
  afterAll(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
  });

  it("encodes URL-significant characters in an entry href", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-kernel-entry-url-"));
    cleanups.push(dir);
    const weird = path.join(dir, "a#b", "entry?.ts");
    await mkdir(path.dirname(weird), { recursive: true });
    await writeFile(weird, "export const x = 1;\n", "utf8");

    expect(entryHref(weird)).toBe(pathToFileURL(weird).href);
    expect(invokedDirectly(weird, pathToFileURL(realpathSync(weird)).href)).toBe(true);
  });

  it("matches symlink and realpath spellings under both Node symlink regimes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-kernel-entry-link-"));
    cleanups.push(dir);
    const real = path.join(dir, "real");
    await mkdir(real, { recursive: true });
    const modulePath = path.join(real, "module.ts");
    await writeFile(modulePath, "export const x = 1;\n", "utf8");
    const linkedDir = path.join(dir, "linked");
    await symlink(real, linkedDir, "dir");
    const linkedModulePath = path.join(linkedDir, "module.ts");

    // Default resolution: argv keeps the symlink while import.meta.url carries
    // the realpath. `--preserve-symlinks-main`: import.meta.url keeps the link.
    expect(invokedDirectly(linkedModulePath, pathToFileURL(realpathSync(modulePath)).href)).toBe(true);
    const linkedHref = pathToFileURL(linkedModulePath).href;
    expect(invokedDirectly(linkedModulePath, linkedHref)).toBe(true);
    expect(invokedDirectly(modulePath, linkedHref)).toBe(true);

    const otherPath = path.join(real, "other.ts");
    await writeFile(otherPath, "export const y = 2;\n", "utf8");
    expect(invokedDirectly(linkedModulePath, pathToFileURL(otherPath).href)).toBe(false);
    expect(invokedDirectly(undefined, linkedHref)).toBe(false);
  });

  it("falls back per side when the filesystem cannot resolve a spelling", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dh-kernel-entry-fallback-"));
    cleanups.push(dir);
    const real = path.join(dir, "real");
    await mkdir(real, { recursive: true });
    const linkedDir = path.join(dir, "linked");
    await symlink(real, linkedDir, "dir");

    const ghost = path.join(real, "gh#ost.ts");
    expect(invokedDirectly(ghost, pathToFileURL(ghost).href)).toBe(true);
    expect(invokedDirectly(path.join(linkedDir, "gh#ost.ts"), pathToFileURL(ghost).href)).toBe(false);

    const modulePath = path.join(real, "module.ts");
    await writeFile(modulePath, "export const x = 1;\n", "utf8");
    expect(invokedDirectly(path.join(linkedDir, "module.ts"), pathToFileURL(path.join(real, "missing.ts")).href)).toBe(false);
    expect(invokedDirectly(path.join(linkedDir, "missing.ts"), pathToFileURL(realpathSync(modulePath)).href)).toBe(false);
    expect(invokedDirectly(modulePath, "data:text/javascript,export{}")).toBe(false);
  });
});
