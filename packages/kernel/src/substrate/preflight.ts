/**
 * Activation preflights: run before the active generation switches, on first
 * install and on every update. The product declares Node >=22 and Python
 * >=3.11 as preflighted platform prerequisites rather than pretending to be a
 * hermetic single binary; platform support, an interactive assertion-source
 * context, and license/provenance presence are prerequisites of the same
 * rank. A failed preflight blocks BEFORE any mutation.
 *
 * Probes are injectable values so unsupported environments are testable; the
 * live defaults observe the real process and platform.
 */
import { execFile } from "node:child_process";
import type { AssertionSourcePort } from "./assertion-source.ts";
import { PINNED_AGENT_SKILLS } from "../spine/composition.ts";

export const SUPPORTED_PLATFORMS = Object.freeze(["darwin", "linux", "win32"] as const);
export const MINIMUM_NODE_MAJOR = 22;
export const MINIMUM_PYTHON = [3, 11] as const;

export interface PreflightProbes {
  readonly nodeVersion: string;
  /** `undefined` means no Python runtime was found. */
  readonly pythonVersion: string | undefined;
  readonly platform: string;
}

const runVersionProbe = (command: string, args: readonly string[]): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(command, [...args], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const match = `${stdout}\n${stderr}`.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
      resolve(match?.[0]);
    });
  });

export async function livePreflightProbes(): Promise<PreflightProbes> {
  const python =
    (await runVersionProbe(process.platform === "win32" ? "python" : "python3", ["--version"])) ??
    (await runVersionProbe("python", ["--version"]));
  return { nodeVersion: process.version, pythonVersion: python, platform: process.platform };
}

export interface PreflightFailure {
  readonly requirement: string;
  readonly message: string;
}

const parseVersion = (value: string): number[] =>
  value
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));

export function checkRuntimePreflight(probes: PreflightProbes): PreflightFailure[] {
  const failures: PreflightFailure[] = [];
  const nodeMajor = parseVersion(probes.nodeVersion)[0] ?? 0;
  if (nodeMajor < MINIMUM_NODE_MAJOR) {
    failures.push({
      requirement: "node",
      message: `Node ${probes.nodeVersion} is below the preflighted prerequisite >=${MINIMUM_NODE_MAJOR}`,
    });
  }
  if (probes.pythonVersion === undefined) {
    failures.push({ requirement: "python", message: "no Python runtime was found; Python >=3.11 is a preflighted prerequisite" });
  } else {
    const [major = 0, minor = 0] = parseVersion(probes.pythonVersion);
    if (major < MINIMUM_PYTHON[0] || (major === MINIMUM_PYTHON[0] && minor < MINIMUM_PYTHON[1])) {
      failures.push({
        requirement: "python",
        message: `Python ${probes.pythonVersion} is below the preflighted prerequisite >=${MINIMUM_PYTHON.join(".")}`,
      });
    }
  }
  if (!SUPPORTED_PLATFORMS.includes(probes.platform as never)) {
    failures.push({
      requirement: "platform",
      message: `${probes.platform} is not a supported installation platform (${SUPPORTED_PLATFORMS.join(", ")})`,
    });
  }
  return failures;
}

export async function checkAssertionSourcePreflight(source: AssertionSourcePort): Promise<PreflightFailure[]> {
  const availability = await source.probe();
  if (availability.available) return [];
  return [
    {
      requirement: "assertion-source",
      message: `no interactive assertion source is available: ${availability.detail}; a platform without an interactive authentication context is not a supported installation target`,
    },
  ];
}

/**
 * License/provenance presence over a verified manifest: the archive must
 * carry its license and notice bytes, and the pinned skills identities must
 * be exactly the frozen qualified release — a composition claiming different
 * provenance never activates.
 */
export function checkLicenseProvenancePreflight(manifest: Record<string, unknown>): PreflightFailure[] {
  const failures: PreflightFailure[] = [];
  const inventory = Array.isArray(manifest["inventory"]) ? (manifest["inventory"] as { path?: unknown }[]) : [];
  const paths = new Set(inventory.map((entry) => entry.path).filter((entry): entry is string => typeof entry === "string"));
  for (const required of ["harness/LICENSE", "harness/NOTICE"]) {
    if (!paths.has(required)) {
      failures.push({ requirement: "license", message: `the composition carries no ${required}; license bytes are an activation prerequisite` });
    }
  }
  const pin = manifest["pin"];
  const skills = typeof pin === "object" && pin !== null ? (pin as Record<string, unknown>)["skillsArchive"] : undefined;
  const frozen = PINNED_AGENT_SKILLS as Record<string, unknown>;
  const declared = (skills ?? {}) as Record<string, unknown>;
  const matches = Object.keys(frozen).every((key) => declared[key] === frozen[key]);
  if (!matches) {
    failures.push({
      requirement: "provenance",
      message: "the manifest's skills identities are not the frozen qualified release; provenance must match before activation",
    });
  }
  return failures;
}
