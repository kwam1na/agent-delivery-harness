/**
 * Assertion sources: where a sensitive approval's interactive evaluation
 * runs. The product consumes the host or OS authentication — it never builds
 * a second local authentication service — so a source here only (1) probes
 * whether an interactive authentication context exists and (2) drives ONE
 * fresh interactive evaluation per request, returning a single-use nonce and
 * a short expiry. Credential evaluation is delegated entirely to the
 * operating system; credential caching and reuse windows are disabled or
 * treated as invalid (each evaluation is a fresh process, and Unix `sudo`
 * evaluations are preceded by an explicit cached-credential reset).
 *
 * THE PROVIDER CONFIGURATION is installation-scoped, next to the trust store
 * and under the same owner-only protections: `trust/assertion-provider.json`.
 * It is written by the operator's installer act (first install or installer
 * repair) and read by every sensitive operation. An absent or corrupt
 * configuration means the assertion source is LOST: sensitive operations fail
 * closed until an operator-performed installer repair rewrites it. It lives
 * outside every execution grant's writable paths, so a candidate cannot mint
 * a source by writing a file.
 *
 * THE QUALIFICATION FIXTURE SOURCE is the assertion half of the qualification
 * fixture profile: deterministic, non-interactive, and valid ONLY on an
 * installation whose receipt records the confirmation-fixture profile — the
 * consuming lane refuses a fixture-sourced assertion on a production
 * installation, exactly as the installer refuses the fixture composition
 * profile there.
 *
 * HONEST VERIFICATION INVENTORY. Availability probing is live-verifiable on
 * this development platform (macOS: LocalAuthentication.framework and
 * /usr/bin/security). The interactive evaluation legs cannot run headlessly,
 * so the test suite drives them through the fixture source; the per-platform
 * commands below are the recorded design, not live-qualified interactive
 * evaluations.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssertionSource } from "../spine/assertion.ts";

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

/** How long a fresh interactive evaluation stays consumable. */
const EVALUATION_LIFETIME_SECONDS = 300;

export interface AssertionEvaluationRequest {
  /** The exact action being approved, disclosed in the prompt. */
  readonly action: string;
  /** The rendered disclosure of the exact target and action. */
  readonly disclosure: string;
}

export type AssertionEvaluation =
  | { readonly ok: true; readonly nonce: string; readonly expiry: string; readonly sourceKind: AssertionSource }
  | { readonly ok: false; readonly reason: string };

export type AssertionAvailabilityProbe =
  | { readonly available: true; readonly sourceKind: AssertionSource; readonly detail: string }
  | { readonly available: false; readonly detail: string };

export interface AssertionSourcePort {
  probe(): Promise<AssertionAvailabilityProbe>;
  evaluate(request: AssertionEvaluationRequest): Promise<AssertionEvaluation>;
}

// ── Provider configuration ─────────────────────────────────────────────────

export const ASSERTION_PROVIDER_SPEC = "assertion-provider/1";

export interface AssertionProviderConfig {
  readonly spec: typeof ASSERTION_PROVIDER_SPEC;
  readonly sourceKind: AssertionSource;
}

/** Beside the trust store, under the same owner-only protections. */
export function assertionProviderConfigPathFor(installationPath: string): string {
  return path.join(installationPath, "trust", "assertion-provider.json");
}

export async function writeAssertionProviderConfig(
  installationPath: string,
  sourceKind: AssertionSource,
): Promise<void> {
  const target = assertionProviderConfigPathFor(installationPath);
  await mkdir(path.dirname(target), { recursive: true, mode: OWNER_DIR });
  const config: AssertionProviderConfig = { spec: ASSERTION_PROVIDER_SPEC, sourceKind };
  await writeFile(target, JSON.stringify(config), { mode: OWNER_FILE });
  await chmod(target, OWNER_FILE);
}

export type AssertionProviderLoad =
  | { readonly ok: true; readonly config: AssertionProviderConfig }
  | { readonly ok: false; readonly reason: "absent" | "corrupt" };

export async function loadAssertionProviderConfig(installationPath: string): Promise<AssertionProviderLoad> {
  let bytes: string;
  try {
    bytes = await readFile(assertionProviderConfigPathFor(installationPath), "utf8");
  } catch {
    return { ok: false, reason: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "corrupt" };
  }
  const record = parsed as Record<string, unknown>;
  if (
    record["spec"] !== ASSERTION_PROVIDER_SPEC ||
    !["host-native", "os-native", "qualification-fixture"].includes(record["sourceKind"] as string)
  ) {
    return { ok: false, reason: "corrupt" };
  }
  return { ok: true, config: record as unknown as AssertionProviderConfig };
}

// ── OS-native source ───────────────────────────────────────────────────────

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

interface PlatformAuthentication {
  /**
   * Groups of absolute-path candidates; each group must resolve to one
   * existing file for an interactive authentication context to exist, and
   * `command` receives exactly the resolved paths — an evaluation only ever
   * spawns the absolute executable the probe verified, never a PATH lookup
   * a planted binary could satisfy.
   */
  readonly probePaths: readonly (readonly string[])[];
  /** One command list per evaluation; a fresh process, never a cached grant. */
  readonly command: (disclosure: string, resolved: readonly string[]) => readonly (readonly string[])[];
  readonly detail: string;
}

/**
 * Per-platform interactive authentication. Each evaluation runs in a fresh
 * process so no OS credential-caching window carries over, and the Unix sudo
 * path resets cached credentials (`sudo -k`) before prompting.
 */
const PLATFORM_AUTHENTICATION: Readonly<Record<string, PlatformAuthentication>> = Object.freeze({
  darwin: {
    probePaths: [
      ["/System/Library/Frameworks/LocalAuthentication.framework"],
      ["/usr/bin/security"],
      ["/usr/bin/osascript"],
    ],
    command: (disclosure, resolved) => [
      [
        resolved[2] as string,
        "-e",
        `do shell script "true" with prompt ${JSON.stringify(disclosure)} with administrator privileges`,
      ],
    ],
    detail: "macOS Authorization Services prompt (LocalAuthentication-backed where enrolled)",
  },
  linux: {
    probePaths: [["/usr/bin/sudo", "/bin/sudo"]],
    command: (disclosure, resolved) => [
      [resolved[0] as string, "-k"],
      [resolved[0] as string, "-p", `${disclosure}\npassword for %u: `, "-v"],
    ],
    detail: "sudo re-authentication with the cached-credential window explicitly reset",
  },
  win32: {
    probePaths: [["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]],
    command: (disclosure, resolved) => [
      [
        resolved[0] as string,
        "-NoProfile",
        "-Command",
        `[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null; ` +
          `$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync(${JSON.stringify(disclosure)}); ` +
          `while ($op.Status -eq 'Started') { Start-Sleep -Milliseconds 50 }; ` +
          `if ($op.GetResults() -ne 'Verified') { exit 1 }`,
      ],
    ],
    detail: "Windows Hello / credential UI consent verification",
  },
});

/** First existing candidate per group, or the group that resolved nothing. */
async function resolveProbeGroups(
  authentication: PlatformAuthentication,
): Promise<{ readonly resolved: readonly string[] } | { readonly missing: readonly string[] }> {
  const resolved: string[] = [];
  for (const candidates of authentication.probePaths) {
    let found: string | undefined;
    for (const candidate of candidates) {
      if (found === undefined && (await exists(candidate))) found = candidate;
    }
    if (found === undefined) return { missing: candidates };
    resolved.push(found);
  }
  return { resolved };
}

const runOnce = (command: readonly string[]): Promise<number> =>
  new Promise((resolve) => {
    const [executable, ...args] = command;
    const child = spawn(executable as string, args, { stdio: ["inherit", "ignore", "ignore"] });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });

export interface OsNativeSourceOptions {
  readonly platform?: string;
  readonly now?: () => string;
}

/**
 * The per-platform OS-native assertion source, supplied where the host offers
 * no native one. Probing checks the platform's authentication surfaces;
 * evaluation drives one fresh interactive prompt whose text disclosed the
 * exact target and action.
 */
export function createOsNativeAssertionSource(options: OsNativeSourceOptions = {}): AssertionSourcePort {
  const platform = options.platform ?? process.platform;
  const authentication = PLATFORM_AUTHENTICATION[platform];
  const now = options.now ?? ((): string => `${new Date().toISOString().slice(0, 19)}Z`);
  return {
    async probe() {
      if (authentication === undefined) {
        return { available: false, detail: `no interactive authentication context is defined for platform ${platform}` };
      }
      const groups = await resolveProbeGroups(authentication);
      if ("missing" in groups) {
        return {
          available: false,
          detail: `authentication surface missing on ${platform}: ${groups.missing.join(" or ")}`,
        };
      }
      return { available: true, sourceKind: "os-native", detail: authentication.detail };
    },
    async evaluate(request) {
      if (authentication === undefined) {
        return { ok: false, reason: `no interactive authentication context is defined for platform ${platform}` };
      }
      const groups = await resolveProbeGroups(authentication);
      if ("missing" in groups) {
        return { ok: false, reason: `authentication surface missing on ${platform}: ${groups.missing.join(" or ")}` };
      }
      for (const command of authentication.command(request.disclosure, groups.resolved)) {
        const code = await runOnce(command);
        if (code !== 0) return { ok: false, reason: `interactive authentication was not granted (${command[0]})` };
      }
      const minted = now();
      const expirySeconds = Date.parse(minted) / 1000 + EVALUATION_LIFETIME_SECONDS;
      const expiry = `${new Date(expirySeconds * 1000).toISOString().slice(0, 19)}Z`;
      return { ok: true, nonce: `nonce-${randomBytes(12).toString("hex")}`, expiry, sourceKind: "os-native" };
    },
  };
}

// ── Qualification fixture source ───────────────────────────────────────────

export interface QualificationFixtureSourceOptions {
  readonly decide?: (request: AssertionEvaluationRequest) => "approve" | "refuse";
  /** Override nonce minting — a fixed nonce simulates a replay. */
  readonly nonce?: () => string;
  /** Override the evaluation expiry — a past expiry simulates a stale grant. */
  readonly expiry?: string;
}

/**
 * The deterministic assertion half of the qualification fixture profile.
 * Valid only in disposable-repository qualification runs: consumption
 * refuses a fixture-sourced assertion unless the installation's receipt
 * records the confirmation-fixture profile.
 */
export function createQualificationFixtureAssertionSource(
  options: QualificationFixtureSourceOptions = {},
): AssertionSourcePort & { readonly evaluations: AssertionEvaluationRequest[] } {
  const evaluations: AssertionEvaluationRequest[] = [];
  let counter = 0;
  return {
    evaluations,
    async probe() {
      return { available: true, sourceKind: "qualification-fixture", detail: "deterministic qualification fixture" };
    },
    async evaluate(request) {
      evaluations.push(request);
      if ((options.decide?.(request) ?? "approve") === "refuse") {
        return { ok: false, reason: "the fixture operator refused the evaluation" };
      }
      counter += 1;
      const nonce = options.nonce?.() ?? `nonce-fixture-${counter}-${randomBytes(6).toString("hex")}`;
      return {
        ok: true,
        nonce,
        expiry: options.expiry ?? "2099-01-01T00:00:00Z",
        sourceKind: "qualification-fixture",
      };
    },
  };
}
