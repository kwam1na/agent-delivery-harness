/**
 * The ONE seam through which the managed modules run external commands.
 *
 * Everything the product launches — git plumbing for candidate identity and
 * worktree-scoped configuration, the trusted-base sensor — goes through this
 * port, so a test can wrap it and the walking-skeleton scenario can assert
 * the complete launch inventory: no `codex`, no `claude`, no agent runtime,
 * no daemon. The port never detaches a child: every launch is awaited to
 * exit, which is the mechanical half of "no product-owned background
 * execution".
 */
import { execFile } from "node:child_process";

export interface ExecInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Absent inherits the ambient environment; present replaces it entirely. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecPort {
  run(invocation: ExecInvocation): Promise<ExecOutcome>;
}

/** The real port: a foreground, awaited `execFile` — never detached. */
export function createExecPort(): ExecPort {
  return {
    run(invocation) {
      return new Promise<ExecOutcome>((resolve) => {
        execFile(
          invocation.command,
          [...invocation.args],
          {
            cwd: invocation.cwd,
            ...(invocation.env === undefined ? {} : { env: { ...invocation.env } }),
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            const code =
              error === null
                ? 0
                : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
                  ? ((error as unknown as { code: number }).code)
                  : 1;
            resolve({ code, stdout, stderr });
          },
        );
      });
    },
  };
}
