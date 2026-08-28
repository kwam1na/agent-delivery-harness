/**
 * The one boundary every CLI command runs behind.
 *
 * WHY ONE BOUNDARY. Seven commands, one place that loads config, wires the repo,
 * classifies exit codes, and renders failures. A command never touches
 * `process`, never prints a stack, never chooses an exit code of its own: it
 * returns a typed result and the boundary maps it. That is what keeps the three
 * exit semantics — policy block, usage error, interruption — identical across
 * commands, and what keeps every operator-facing byte flowing through the one
 * neutralizing renderer.
 *
 * EXIT CODES.
 *   0    the command completed and its check passed
 *   1    a policy block (a typed blocker, a gate that did not admit, a failed
 *        verification) OR an unexpected internal error (rendered as a redacted
 *        `internal_error` blocker — never reported as a policy decision, but
 *        still a non-zero failure)
 *   2    a usage error (unknown command, missing or malformed arguments)
 *   130  interruption (SIGINT) — the shell convention 128 + SIGINT(2)
 *
 * REPO COHERENCE. Capture and the evidence store must address the same
 * repository — the recorder's coherence requirement. Both are wired here, from one
 * `rootDir`, with the store's own `workspaceId` handed to the capture — so a
 * captured candidate can never disagree with the store about which workspace it
 * belongs to. Admission still guards `workspace_incoherent`; this makes the
 * disagreement unconstructible in the first place.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  BlockedError,
  classifyExecutionContext,
  createArtifactsPort,
  createBlocker,
  createCandidateCapture,
  createInternalErrorBlocker,
  evaluateCandidateActivation,
  renderBlockers,
  resolveRecordStorage,
  submitManifest,
  validateHarnessConfig,
  withDeliverableIdentity,
  type ArtifactsPort,
  type Blocker,
  type CaptureCandidate,
  type CapturedCandidate,
  type EnvSnapshot,
  type ExecutionContext,
  type HarnessConfig,
  type LiveProviderResult,
  type NonEmptyTuple,
  type ReviewActivationProjection,
  type WaiverPrompt,
} from "@agent-delivery-harness/kernel";
import {
  invokeProviderRail,
  openProviderRailProcess,
  type ProviderRailInvocationResult,
  type ProviderRailSession,
} from "./provider-rails.ts";

// ── Exit codes ───────────────────────────────────────────────────────────────

export const EXIT_OK = 0;
export const EXIT_POLICY = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

/**
 * Thrown when the operator interrupts the process (SIGINT), typically at an
 * interactive prompt. The boundary maps it to exit 130 — distinct from a policy
 * block, because an interrupted run reached no verdict.
 */
export class CliInterruption extends Error {
  constructor(message = "Interrupted.") {
    super(message);
    this.name = "CliInterruption";
  }
}

// ── Command contract ─────────────────────────────────────────────────────────

/**
 * What a command returns. `ok` is a pass; `blocked` is a policy failure carrying
 * the typed blockers to render; `usage` is an argument or invocation error.
 */
export type CommandResult =
  | { readonly kind: "ok"; readonly summary?: string }
  | { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "usage"; readonly message: string };

/** The repository wiring shared by every command in one invocation. */
export interface RepoWiring {
  readonly rootDir: string;
  readonly workspaceId: string;
  readonly captureCandidate: CaptureCandidate;
  readonly projectActivation: (candidate: CapturedCandidate) => Promise<ReviewActivationProjection>;
  /** Storage options threaded to every kernel call so all share one namespace. */
  readonly storageOptions: { readonly storageNamespace: string };
}

/** Everything a command may reach, none of it the ambient process. */
export interface CommandContext {
  readonly rootDir: string;
  readonly config: HarnessConfig;
  readonly env: EnvSnapshot;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  /** Positional and flag arguments after the command name. */
  readonly args: readonly string[];
  /**
   * Wires capture and the store from this repo, memoized. Lazy so `--help`
   * wires nothing and so a command owns how it renders a store that will not
   * resolve. Rejects with a `BlockedError` the boundary maps to exit 1.
   */
  wire(): Promise<RepoWiring>;
  readonly artifacts: ArtifactsPort;
  /** Present only when the run can ask a human; the boundary gates it on a TTY. */
  readonly promptForWaiver?: WaiverPrompt;
  readonly liveResults?: readonly LiveProviderResult[];
  /** Runs one configured provider through the neutral stdio rail, if it has a command. */
  readonly invokeProvider?: (input: {
    readonly providerId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly requiresEvidence: boolean;
  }) => Promise<ProviderRailInvocationResult | undefined>;
  /** Emits one line of operator-facing output to stdout. */
  readonly write: (text: string) => void;
  /** Classifies the execution context from this invocation's env + TTY. */
  classifyContext(): ExecutionContext;
}

export interface CommandDescriptor {
  readonly name: string;
  /** The blocker `source.id` this command stamps on failures it raises itself. */
  readonly sourceId: string;
  readonly summary: string;
  run(context: CommandContext): Promise<CommandResult>;
}

// ── Runtime the boundary is driven with ──────────────────────────────────────

export interface CliRuntime {
  readonly cwd: string;
  readonly env: EnvSnapshot;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Loads the consumer config. Defaults to importing `harness.config.ts`. */
  readonly loadConfig?: (rootDir: string) => Promise<HarnessConfig>;
  /** The interactive waiver prompt. Only ever offered under a TTY. */
  readonly promptForWaiver?: WaiverPrompt;
  /** The filesystem port. Defaults to one rooted in the system temp directory. */
  readonly artifacts?: ArtifactsPort;
  readonly liveResults?: readonly LiveProviderResult[];
  readonly signal?: AbortSignal;
  /** Test/embedding seam. The ordinary runtime opens the provider's configured command. */
  readonly openProviderRail?: (input: {
    readonly providerId: string;
    readonly command: readonly [string, ...string[]];
    readonly cwd: string;
    readonly env: EnvSnapshot;
  }) => Promise<ProviderRailSession>;
}

// ── Blocker helpers ──────────────────────────────────────────────────────────

const COMMAND_SOURCE = { kind: "command", id: "delivery-harness.cli" } as const;

export function commandBlocker(input: {
  readonly code: string;
  readonly sourceId: string;
  readonly summary: string;
  readonly details?: string;
  readonly remediations: NonEmptyTuple<Parameters<typeof createBlocker>[0]["remediations"][number]>;
}): Blocker {
  return createBlocker({
    code: input.code,
    source: { kind: "command", id: input.sourceId },
    summary: input.summary,
    ...(input.details === undefined ? {} : { details: input.details }),
    remediations: input.remediations,
  });
}

// ── Config loading ───────────────────────────────────────────────────────────

/**
 * The default config loader: import `harness.config.ts` from the repo root and
 * take its default export, which `defineHarnessConfig` has already validated. A
 * config that fails to load — absent, unparseable, or invalid — becomes one
 * typed blocker rather than an unhandled throw.
 */
export async function importHarnessConfig(rootDir: string): Promise<HarnessConfig> {
  const configPath = path.join(rootDir, "harness.config.ts");
  let loaded: unknown;
  try {
    const module = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
    loaded = module.default;
  } catch (error) {
    throw new BlockedError([
      commandBlocker({
        code: "config_unloadable",
        sourceId: "delivery-harness.cli.config",
        summary: "The harness configuration could not be loaded.",
        details: `${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        remediations: [
          {
            id: "create-harness-config",
            kind: "manual_action",
            summary: "Provide a valid harness.config.ts at the repository root.",
          },
        ],
      }),
    ]);
  }
  const validation = validateHarnessConfig(loaded);
  if (!validation.ok) {
    throw new BlockedError(validation.blockers);
  }
  return validation.config;
}

// ── Repo wiring (coherence lives here) ───────────────────────────────────────

/**
 * Wires capture and the evidence store from one `rootDir`. The store's
 * `workspaceId` is what the capture stamps onto the candidate, so the two can
 * never disagree — the coherence the admission adapter guards is guaranteed at
 * the source here.
 */
export async function wireRepo(rootDir: string, config: HarnessConfig): Promise<RepoWiring> {
  const storageOptions = { storageNamespace: config.storageNamespace };
  const storage = await resolveRecordStorage(rootDir, storageOptions);
  const captureCandidate = createCandidateCapture({
    rootDir,
    config,
    workspaceId: storage.workspaceId,
    computeIdentity: withDeliverableIdentity(),
  });
  const projectActivation = (candidate: CapturedCandidate): Promise<ReviewActivationProjection> =>
    evaluateCandidateActivation({ rootDir, candidate, config });
  return { rootDir, workspaceId: storage.workspaceId, captureCandidate, projectActivation, storageOptions };
}

// ── The boundary ─────────────────────────────────────────────────────────────

const USAGE = (commands: readonly CommandDescriptor[]): string =>
  [
    "Usage: delivery-harness <command> [options]",
    "",
    "Commands:",
    ...commands.map((command) => `  ${command.name.padEnd(16)}${command.summary}`),
  ].join("\n");

/**
 * Runs one CLI invocation to an exit code. Total: it maps every command result
 * and every throw to one of the four codes, and renders every failure through
 * the neutralizing blocker renderer. Never throws.
 */
export async function runCliBoundary(
  argv: readonly string[],
  commands: readonly CommandDescriptor[],
  runtime: CliRuntime,
): Promise<number> {
  const [commandName, ...args] = argv;

  if (commandName === undefined || commandName === "--help" || commandName === "-h" || commandName === "help") {
    runtime.stdout(`${USAGE(commands)}\n`);
    return commandName === undefined ? EXIT_USAGE : EXIT_OK;
  }

  const descriptor = commands.find((command) => command.name === commandName);
  if (descriptor === undefined) {
    runtime.stderr(`Unknown command: ${commandName}\n\n${USAGE(commands)}\n`);
    return EXIT_USAGE;
  }

  const loadConfig = runtime.loadConfig ?? importHarnessConfig;
  const artifacts = runtime.artifacts ?? createArtifactsPort();

  try {
    const config = await loadConfig(runtime.cwd);

    let wiringPromise: Promise<RepoWiring> | undefined;
    const wire = (): Promise<RepoWiring> => {
      wiringPromise ??= wireRepo(runtime.cwd, config);
      return wiringPromise;
    };

    const context: CommandContext = {
      rootDir: runtime.cwd,
      config,
      env: runtime.env,
      stdinIsTTY: runtime.stdinIsTTY,
      stdoutIsTTY: runtime.stdoutIsTTY,
      args,
      wire,
      artifacts,
      // The waiver prompt is offered only under a real TTY. A non-interactive
      // invocation never prompts — it blocks — no matter what the run wired.
      ...(runtime.stdinIsTTY && runtime.stdoutIsTTY && runtime.promptForWaiver !== undefined
        ? { promptForWaiver: runtime.promptForWaiver }
        : {}),
      ...(runtime.liveResults === undefined ? {} : { liveResults: runtime.liveResults }),
      invokeProvider: async ({ providerId, payload, requiresEvidence }) => {
        const provider = config.providers.find((registration) => registration.id === providerId);
        if (provider?.command === undefined) return undefined;
        const command = provider.command;
        const requestId = randomUUID();
        const allocation = await artifacts.allocateRunRoot({ providerId, runId: requestId });
        if (!allocation.ok) {
          throw new BlockedError([
            commandBlocker({
              code: "provider_rail_run_root_refused",
              sourceId: "delivery-harness.cli.provider-rails",
              summary: "The provider run root could not be allocated.",
              details: `${providerId}/${requestId}: ${allocation.reason}`,
              remediations: [
                {
                  id: "check-provider-identity",
                  kind: "code_change",
                  summary: "Correct the provider id or restore the harness run-root location, then retry.",
                },
              ],
            }),
          ]);
        }
        const wiring = await wire();
        const interruptController = runtime.signal === undefined ? new AbortController() : undefined;
        const onInterrupt = (): void => interruptController?.abort();
        if (interruptController !== undefined) process.once("SIGINT", onInterrupt);
        try {
          return await invokeProviderRail(
            {
              providerId,
              requestId,
              idempotencyKey: randomUUID(),
              payload: { ...payload, runId: requestId, runRoot: allocation.runRoot.path },
              requiresEvidence,
            },
            {
              open: () =>
                runtime.openProviderRail === undefined
                  ? openProviderRailProcess({ command, cwd: runtime.cwd, env: { ...runtime.env } })
                  : runtime.openProviderRail({ providerId, command, cwd: runtime.cwd, env: runtime.env }),
              publishManifest: (manifestPath) =>
                submitManifest(
                  { rootDir: runtime.cwd, config, manifestPath },
                  {
                    captureCandidate: wiring.captureCandidate,
                    artifacts,
                    expectedProviderAttempt: { providerId, runId: requestId, runRootPath: allocation.runRoot.path },
                    ...wiring.storageOptions,
                  },
                ),
              signal: runtime.signal ?? interruptController?.signal,
              cancellationId: randomUUID(),
            },
          );
        } finally {
          if (interruptController !== undefined) process.off("SIGINT", onInterrupt);
        }
      },
      write: (text) => runtime.stdout(`${text}\n`),
      classifyContext: () =>
        classifyExecutionContext({
          config,
          env: runtime.env,
          stdinIsTTY: runtime.stdinIsTTY,
          stdoutIsTTY: runtime.stdoutIsTTY,
        }),
    };

    const result = await descriptor.run(context);
    if (result.kind === "ok") {
      if (result.summary !== undefined && result.summary !== "") runtime.stdout(`${result.summary}\n`);
      return EXIT_OK;
    }
    if (result.kind === "usage") {
      runtime.stderr(`${result.message}\n`);
      return EXIT_USAGE;
    }
    runtime.stderr(`${renderBlockers(result.blockers)}\n`);
    return EXIT_POLICY;
  } catch (error) {
    if (error instanceof CliInterruption) {
      runtime.stderr(`${error.message}\n`);
      return EXIT_INTERRUPTED;
    }
    if (error instanceof BlockedError) {
      runtime.stderr(`${renderBlockers(error.blockers)}\n`);
      return EXIT_POLICY;
    }
    const blocker = createInternalErrorBlocker({
      source: { kind: "command", id: descriptor.sourceId },
      error,
      reproduce: ["delivery-harness", descriptor.name],
    });
    runtime.stderr(`${renderBlockers([blocker])}\n`);
    return EXIT_POLICY;
  }
}

export { COMMAND_SOURCE };
