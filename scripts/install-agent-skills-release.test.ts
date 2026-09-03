/**
 * The release installer's readable half: the arguments it accepts, the
 * checkout it is pointed at, and the status document it refuses to accept.
 *
 * WHAT THIS SUITE OWNS, AND WHAT IT DOES NOT. The install itself — building
 * the archive, driving the lifecycle, re-recording the policy snapshot — is a
 * sequence of subprocesses against a real checkout and a real repository, and
 * it is proven by running it: an install that did not happen leaves
 * `.agent-skills/active.json` naming the previous release, which is the
 * candidate's own diff. What is worth testing separately is the half that
 * decides: how a release is named, where the checkout comes from, and, above
 * all, what the script accepts as proof that the install landed. A status
 * check that passes on a status document reporting blockers is worse than no
 * check, because it converts a failed install into a green one.
 */
import { describe, expect, it } from "vitest";

import {
  CHECKOUT_ENV,
  InstallError,
  checkInstalledStatus,
  parseInstallArgs,
  resolveCheckout,
} from "./install-agent-skills-release.ts";

const status = (overrides: Record<string, unknown> = {}): unknown => ({
  active: {
    archiveSha256: "a".repeat(64),
    generation: "a".repeat(64),
    profile: "linear",
    releaseId: "linear-v2",
  },
  blockers: [],
  lifecycle: "current",
  schemaVersion: "agent-skills-status/1",
  ...overrides,
});

const expected = { releaseId: "linear-v2", profile: "linear", archiveSha256: "a".repeat(64) } as const;

describe("the arguments", () => {
  it("takes the release id and defaults the profile to the one this repository runs", () => {
    expect(parseInstallArgs(["--release-id", "linear-v2"])).toEqual({ releaseId: "linear-v2", profile: "linear" });
    expect(parseInstallArgs(["--release-id", "core-v1", "--profile", "core"])).toEqual({
      releaseId: "core-v1",
      profile: "core",
    });
  });

  it("refuses an invocation it would otherwise have to guess at", () => {
    // No release id: the id is what the archive is built under and what the
    // status check later compares against, so there is no defaulting it.
    expect(() => parseInstallArgs([])).toThrow(InstallError);
    expect(() => parseInstallArgs(["--release-id"])).toThrow(InstallError);
    expect(() => parseInstallArgs(["--release-id", "a", "--release-id", "b"])).toThrow(InstallError);
    // Both flags are once-only, and for the same reason: a last-wins parser
    // would install one profile while the operator read another off the
    // command line they typed.
    expect(() => parseInstallArgs(["--release-id", "a", "--profile", "core", "--profile", "linear"])).toThrow(
      InstallError,
    );
    expect(() => parseInstallArgs(["--profile"])).toThrow(InstallError);
    expect(() => parseInstallArgs(["--unknown"])).toThrow(InstallError);
    expect(() => parseInstallArgs(["linear-v2"])).toThrow(InstallError);
    // Both values reach a command line and a comparison, so both are bounded
    // to the shape a release id and a profile name actually have.
    expect(() => parseInstallArgs(["--release-id", "../etc/passwd"])).toThrow(InstallError);
    expect(() => parseInstallArgs(["--release-id", "linear-v2", "--profile", "Linear Profile"])).toThrow(InstallError);
    expect(() => parseInstallArgs(["--release-id", ""])).toThrow(InstallError);
  });
});

describe("the checkout", () => {
  it("comes from the documented environment variable", () => {
    expect(resolveCheckout({ [CHECKOUT_ENV]: "/somewhere/agent-skills" })).toBe("/somewhere/agent-skills");
  });

  it("is a refusal naming the variable rather than a guess at a sibling directory", () => {
    // The corpus checkout is the maintainer's, not something this repository
    // may locate by convention: a wrong guess would install release bytes
    // built from whatever tree happened to be there.
    expect(() => resolveCheckout({})).toThrow(new RegExp(CHECKOUT_ENV));
    expect(() => resolveCheckout({ [CHECKOUT_ENV]: "   " })).toThrow(InstallError);
    expect(() => resolveCheckout({ [CHECKOUT_ENV]: "relative/path" })).toThrow(InstallError);
  });
});

describe("the status the install must reach", () => {
  it("accepts a current lifecycle with no blockers and the new generation active", () => {
    expect(() => checkInstalledStatus(status(), expected)).not.toThrow();
  });

  it("refuses every status that is not that one", () => {
    // Each row is a way an install fails while the command still exits zero.
    expect(() => checkInstalledStatus(status({ lifecycle: "stale" }), expected)).toThrow(InstallError);
    expect(() => checkInstalledStatus(status({ blockers: ["journal_incomplete"] }), expected)).toThrow(InstallError);
    expect(() => checkInstalledStatus(status({ blockers: "none" }), expected)).toThrow(InstallError);
    // The generation that is active is the one just built, by digest. Without
    // this the script would report success over an unchanged installation.
    expect(() =>
      checkInstalledStatus(status({ active: { ...(status() as { active: object }).active, archiveSha256: "b".repeat(64) } }), expected),
    ).toThrow(InstallError);
    expect(() =>
      checkInstalledStatus(status({ active: { ...(status() as { active: object }).active, releaseId: "linear-v1" } }), expected),
    ).toThrow(InstallError);
    expect(() =>
      checkInstalledStatus(status({ active: { ...(status() as { active: object }).active, profile: "core" } }), expected),
    ).toThrow(InstallError);
    // A shape the lifecycle never emits is a refusal, not a pass: an absent
    // member must never read as an absent blocker.
    expect(() => checkInstalledStatus(status({ active: undefined }), expected)).toThrow(InstallError);
    expect(() => checkInstalledStatus(status({ blockers: undefined }), expected)).toThrow(InstallError);
    expect(() => checkInstalledStatus("current", expected)).toThrow(InstallError);
  });
});
