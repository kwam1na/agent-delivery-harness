/**
 * THE AUTHENTICATED CLAUDE CODE SESSION QUALIFICATION LANE.
 *
 * This is the TEST HARNESS driving a real authenticated host session, which is
 * exactly the thing the PRODUCT must never do. It is a standalone script, not
 * part of `npm run check`, and it refuses to run without an explicit operator
 * opt-in, so no ordinary sensor run ever spawns a host.
 *
 * What only a live host can prove, and what this lane therefore proves:
 *
 *   1. DENY BEFORE ATTESTATION — a tool invocation with no attested grant is
 *      denied by the model-external interceptor, and the side effect it would
 *      have had does not appear on disk.
 *   2. ALLOW AFTER ATTESTATION — the identical invocation succeeds once the
 *      binding's expectation is attested, so the denial was the interceptor
 *      and not an unrelated failure.
 *   3. CANDIDATE-PLANTED SETTINGS ARE INERT — a `.claude/settings.json` in the
 *      working directory carrying a permissive allow rule does not widen the
 *      attested grant under the binding's admission flags.
 *   4. LIFECYCLE EVENT ON CLEAN END — the SessionEnd hook fires.
 *   5. DESCENDANT TEARDOWN — whether a detached background child survives the
 *      clean host end. This is the Tier 3 gate, and the honest answer decides
 *      whether same-workspace resume is available at all.
 *
 * Everything the PRODUCT owns — the projection lifecycle, the journal records,
 * the normalized checkpoint outcomes — is proven by the in-process sensors and
 * is deliberately not re-litigated here.
 *
 * The user's own configuration is never touched: the session runs in a
 * disposable directory, writes its state under that directory, and admits with
 * every ambient setting scope excluded.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestCanonical } from "../packages/kernel/src/digest.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const HOOK_MAIN = path.join(REPO_ROOT, "packages", "kernel", "src", "host", "hook-main.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

export const OPT_IN_VARIABLE = "QUALIFY_CLAUDE_CODE_SESSION";

export interface LiveProbeOutcome {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly satisfied: boolean;
}

export interface LiveQualification {
  readonly hostVersion: string;
  readonly probes: readonly LiveProbeOutcome[];
  readonly descendantTeardown: "verified" | "unverified";
}

const hostVersion = (): string =>
  execFileSync("claude", ["--version"], { encoding: "utf8" }).trim().split(/\s+/)[0] ?? "unknown";

/**
 * Runs one non-interactive session in a disposable directory with the
 * binding's own admission flags. Returns the exit code; the probe's verdict
 * comes from what did or did not land on disk, never from model output.
 */
function runSession(input: {
  readonly cwd: string;
  readonly settingsPath: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", input.prompt, "--settings", input.settingsPath, "--setting-sources", ""],
      { cwd: input.cwd, timeout: input.timeoutMs, encoding: "utf8" },
      (error) => resolve(error === null ? 0 : 1),
    );
  });
}

const hookCommand = (subcommand: string, statePath: string): string =>
  [TSX_BIN, HOOK_MAIN, subcommand, statePath].map((part) => JSON.stringify(part)).join(" ");

/** The binding-composed session settings, in the shape the binding writes them. */
function writeSettings(input: {
  readonly bindingDir: string;
  readonly statePath: string;
  readonly allow: readonly string[];
  readonly sessionEndMarker?: string;
}): string {
  const settings: Record<string, unknown> = {
    permissions: { allow: [...input.allow] },
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("pre-tool-use", input.statePath) }] }],
      ...(input.sessionEndMarker === undefined
        ? {}
        : {
            SessionEnd: [
              {
                hooks: [
                  { type: "command", command: `/bin/sh -c ${JSON.stringify(`printf ended > ${input.sessionEndMarker}`)}` },
                ],
              },
            ],
          }),
    },
  };
  const settingsPath = path.join(input.bindingDir, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settingsPath;
}

/**
 * The binding state the interceptor consults. An expectation whose members
 * cannot match any attestation is how "before attestation" is expressed: the
 * hook's own decision path is unchanged.
 */
function writeState(input: {
  readonly statePath: string;
  readonly workspaceRoot: string;
  readonly attested: boolean;
  readonly allow: readonly string[];
}): void {
  const grant = {
    spec: "execution-grant/1",
    profile: "checkpoint",
    allowedCapabilities: [...input.allow],
    writablePaths: ["work"],
    protectedPaths: [".git"],
    forbiddenOperations: [],
  };
  const expectation = {
    profile: "checkpoint",
    hostVersion: "live-probe/1",
    productTrustRevocationEpoch: 0,
    observedAt: "2026-01-01T00:00:00Z",
    deliveryId: "dlv-live-probe",
    invocationFence: 1,
    workspaceId: "ws-live-probe",
    projectionDigest: "a".repeat(64),
    discoveryConfigurationDigest: "b".repeat(64),
    registeringInstallationId: "install-live-probe",
    activeProfile: "confirmation-fixture",
  };
  writeFileSync(
    input.statePath,
    `${JSON.stringify({
      expectation,
      grant,
      // The unattested case presents no attestation at all — deny-until-attested.
      attestation: input.attested ? mintForProbe(grant, expectation) : null,
      workspaceRoot: input.workspaceRoot,
      observationPath: path.join(path.dirname(input.statePath), "observation.json"),
    })}\n`,
    { mode: 0o600 },
  );
}

/** The attestation shape the binding mints, over the probe's own expectation. */
function mintForProbe(grant: unknown, expectation: Record<string, unknown>): Record<string, unknown> {
  return {
    spec: "grant-attestation/1",
    profile: "checkpoint",
    hostVersion: expectation["hostVersion"],
    grantDigest: digestCanonical(grant),
    productTrustRevocationEpoch: expectation["productTrustRevocationEpoch"],
    // Far enough out that the probe's own clock never expires it mid-run.
    expiry: "2099-01-01T00:00:00Z",
    intakeDraftId: "absent-by-state",
    deliveryId: expectation["deliveryId"],
    invocationFence: expectation["invocationFence"],
    workspaceId: expectation["workspaceId"],
    projectionDigest: expectation["projectionDigest"],
    discoveryConfigurationDigest: expectation["discoveryConfigurationDigest"],
    registeringInstallationId: expectation["registeringInstallationId"],
    activeProfile: expectation["activeProfile"],
  };
}

const landed = (file: string): boolean => {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
};

export async function qualifyClaudeCodeSession(): Promise<LiveQualification> {
  const root = mkdtempSync(path.join(tmpdir(), "cc-live-qualification-"));
  const probes: LiveProbeOutcome[] = [];
  try {
    const version = hostVersion();

    // ── 1 & 2: deny before attestation, allow after ──
    for (const attested of [false, true]) {
      const cwd = path.join(root, attested ? "attested" : "unattested");
      const bindingDir = path.join(cwd, "binding");
      mkdirSync(bindingDir, { recursive: true });
      mkdirSync(path.join(cwd, "work"), { recursive: true });
      const statePath = path.join(bindingDir, "state.json");
      writeState({ statePath, workspaceRoot: cwd, attested, allow: ["Write"] });
      const settingsPath = writeSettings({ bindingDir, statePath, allow: ["Write"] });
      const target = path.join(cwd, "work", "side-effect.txt");
      await runSession({
        cwd,
        settingsPath,
        prompt: `Use the Write tool to create the file work/side-effect.txt containing exactly: ok`,
        timeoutMs: 180_000,
      });
      const observed = landed(target);
      probes.push(
        attested
          ? {
              id: "allow-after-attestation",
              question: "does the identical invocation succeed once the grant is attested?",
              answer: observed ? "yes — the side effect landed on disk" : "no — the side effect never landed",
              satisfied: observed,
            }
          : {
              id: "deny-before-attestation",
              question: "is a tool invocation denied while no attestation is applied?",
              answer: observed ? "no — the side effect landed despite no attestation" : "yes — no side effect occurred",
              satisfied: !observed,
            },
      );
    }

    // ── 3: a candidate-planted settings file cannot widen the grant ──
    {
      const cwd = path.join(root, "planted");
      const bindingDir = path.join(cwd, "binding");
      mkdirSync(path.join(cwd, ".claude"), { recursive: true });
      mkdirSync(path.join(cwd, "work"), { recursive: true });
      mkdirSync(bindingDir, { recursive: true });
      writeFileSync(
        path.join(cwd, ".claude", "settings.json"),
        `${JSON.stringify({ permissions: { allow: ["Bash", "Write"] } }, null, 2)}\n`,
      );
      const statePath = path.join(bindingDir, "state.json");
      // The attested grant deliberately excludes Bash; the planted file adds it.
      writeState({ statePath, workspaceRoot: cwd, attested: true, allow: ["Write"] });
      const settingsPath = writeSettings({ bindingDir, statePath, allow: ["Write"] });
      const target = path.join(cwd, "work", "planted-effect.txt");
      await runSession({
        cwd,
        settingsPath,
        prompt: `Use the Bash tool to run: printf widened > work/planted-effect.txt`,
        timeoutMs: 180_000,
      });
      const observed = landed(target);
      probes.push({
        id: "candidate-planted-settings-inert",
        question: "can a candidate-planted .claude/settings.json widen the attested grant?",
        answer: observed
          ? "yes — the planted allow rule took effect"
          : "no — the planted rule was inert under the binding's admission flags",
        satisfied: !observed,
      });
    }

    // ── 4 & 5: lifecycle event on clean end, and descendant teardown ──
    {
      const cwd = path.join(root, "lifecycle");
      const bindingDir = path.join(cwd, "binding");
      mkdirSync(bindingDir, { recursive: true });
      const statePath = path.join(bindingDir, "state.json");
      writeState({ statePath, workspaceRoot: cwd, attested: true, allow: ["Bash"] });
      const endMarker = path.join(cwd, "session-end.marker");
      const settingsPath = writeSettings({ bindingDir, statePath, allow: ["Bash"], sessionEndMarker: endMarker });
      const pidFile = path.join(cwd, "child.pid");
      await runSession({
        cwd,
        settingsPath,
        prompt:
          `Use the Bash tool once to run exactly this and nothing else: ` +
          `nohup sh -c 'sleep 120' > /dev/null 2>&1 & echo $! > child.pid`,
        timeoutMs: 180_000,
      });

      const ended = landed(endMarker);
      probes.push({
        id: "lifecycle-event-on-clean-end",
        question: "does the SessionEnd lifecycle hook fire on a clean non-interactive end?",
        answer: ended ? "yes — the marker is present after the clean exit" : "no — no marker was written",
        satisfied: ended,
      });

      let survived: boolean | undefined;
      try {
        const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        if (Number.isSafeInteger(pid) && pid > 1) {
          try {
            process.kill(pid, 0);
            survived = true;
            process.kill(pid, "SIGKILL"); // reap the probe's own child
          } catch {
            survived = false;
          }
        }
      } catch {
        survived = undefined;
      }
      // `satisfied` means the probe reached a CONCLUSIVE answer. Which answer
      // it reached is the grading input, not a pass or a fail: a surviving
      // child is a perfectly conclusive probe whose consequence is that the
      // host stays below Tier 3.
      probes.push({
        id: "descendant-teardown",
        question: "does a detached background child survive a clean host end?",
        answer:
          survived === undefined
            ? "inconclusive — the session recorded no child pid"
            : survived
              ? "yes — the child was still alive after the clean end, so teardown is UNVERIFIED and the host stays below Tier 3"
              : "no — the child was gone, so descendant teardown is VERIFIED",
        satisfied: survived !== undefined,
      });

      return {
        hostVersion: version,
        probes,
        descendantTeardown: survived === false ? "verified" : "unverified",
      };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

/** The opt-in is read INSIDE the entrypoint, never while the module evaluates. */
async function main(): Promise<number> {
  if (process.env["QUALIFY_CLAUDE_CODE_SESSION"] !== "1") {
    process.stderr.write(
      `qualify-claude-code-session: this lane drives a REAL authenticated Claude Code session.\n` +
        `Set ${OPT_IN_VARIABLE}=1 to opt in. It is never part of \`npm run check\`.\n`,
    );
    return 2;
  }
  const qualification = await qualifyClaudeCodeSession();
  process.stdout.write(`${JSON.stringify(qualification, null, 2)}\n`);
  return qualification.probes.every((probe) => probe.satisfied) ? 0 : 1;
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`qualify-claude-code-session failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
