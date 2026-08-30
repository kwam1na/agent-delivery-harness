/**
 * The assertion-source module: provider configuration custody and the
 * per-platform OS-native source's availability probing.
 *
 * HONEST INVENTORY: the availability probe runs LIVE against this test
 * host's real authentication surfaces (macOS and Linux are the platforms the
 * suite runs on). The interactive evaluation legs cannot run headlessly and
 * are covered through the qualification fixture source everywhere else in
 * the suite; no test here fakes an interactive grant.
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertionProviderConfigPathFor,
  createOsNativeAssertionSource,
  createQualificationFixtureAssertionSource,
  loadAssertionProviderConfig,
  writeAssertionProviderConfig,
} from "./assertion-source.ts";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "assertion-source-"));
});

describe("provider configuration custody", () => {
  it("round-trips with owner-only protections beside the trust store", async () => {
    const installationPath = path.join(scratch, "installation-1");
    await writeAssertionProviderConfig(installationPath, "os-native");
    const configPath = assertionProviderConfigPathFor(installationPath);
    expect(configPath).toContain(path.join("trust", "assertion-provider.json"));
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    const loaded = await loadAssertionProviderConfig(installationPath);
    expect(loaded).toEqual({ ok: true, config: { spec: "assertion-provider/1", sourceKind: "os-native" } });
  });

  it("fails closed on an absent or corrupt configuration — the sensitive set's loss condition", async () => {
    const absent = await loadAssertionProviderConfig(path.join(scratch, "nowhere"));
    expect(absent).toEqual({ ok: false, reason: "absent" });

    const installationPath = path.join(scratch, "installation-2");
    await writeAssertionProviderConfig(installationPath, "os-native");
    await writeFile(assertionProviderConfigPathFor(installationPath), "not json", { mode: 0o600 });
    expect(await loadAssertionProviderConfig(installationPath)).toEqual({ ok: false, reason: "corrupt" });

    await writeFile(
      assertionProviderConfigPathFor(installationPath),
      JSON.stringify({ spec: "assertion-provider/1", sourceKind: "model-minted" }),
      { mode: 0o600 },
    );
    expect(await loadAssertionProviderConfig(installationPath)).toEqual({ ok: false, reason: "corrupt" });
  });
});

describe("the OS-native source", () => {
  it("probes the REAL authentication surfaces of this platform (live leg)", async () => {
    // The suite runs on macOS and Linux — both supported platforms with
    // real surfaces to probe. This is the live half of the qualification;
    // the interactive evaluation half stays fixture-backed.
    const source = createOsNativeAssertionSource();
    const availability = await source.probe();
    expect(availability.available, JSON.stringify(availability)).toBe(true);
    if (availability.available) expect(availability.sourceKind).toBe("os-native");
  });

  it("reports unavailability on a platform with no interactive authentication context", async () => {
    const source = createOsNativeAssertionSource({ platform: "sunos" });
    const availability = await source.probe();
    expect(availability.available).toBe(false);
    const evaluation = await source.evaluate({ action: "update", disclosure: "Approve update" });
    expect(evaluation.ok).toBe(false);
  });
});

describe("the qualification fixture source", () => {
  it("records every disclosure it evaluated — the prompt names the exact target and action", async () => {
    const source = createQualificationFixtureAssertionSource();
    const evaluation = await source.evaluate({
      action: "revoke",
      disclosure: "Approve revoke of generation abc on installation install-1",
    });
    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.sourceKind).toBe("qualification-fixture");
      expect(evaluation.nonce.length).toBeGreaterThan(0);
    }
    expect(source.evaluations).toEqual([
      { action: "revoke", disclosure: "Approve revoke of generation abc on installation install-1" },
    ]);
  });

  it("mints a fresh nonce per evaluation unless a replay is being simulated", async () => {
    const fresh = createQualificationFixtureAssertionSource();
    const first = await fresh.evaluate({ action: "update", disclosure: "d" });
    const second = await fresh.evaluate({ action: "update", disclosure: "d" });
    expect(first.ok && second.ok && first.nonce !== second.nonce).toBe(true);

    const replaying = createQualificationFixtureAssertionSource({ nonce: () => "nonce-fixed" });
    const third = await replaying.evaluate({ action: "update", disclosure: "d" });
    const fourth = await replaying.evaluate({ action: "update", disclosure: "d" });
    expect(third.ok && fourth.ok && third.nonce === "nonce-fixed" && fourth.nonce === "nonce-fixed").toBe(true);
  });
});
