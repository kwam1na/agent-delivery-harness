/**
 * THE HOST-NEUTRAL DELIVERY BINDING SEAM.
 *
 * One interface, introduced because a SECOND host implementation proved it
 * necessary and no earlier. Until the Codex app-server binding existed the
 * facade could name the Claude binding's functions directly and lose nothing;
 * with two bindings the facade would otherwise have to branch on a host
 * identity at every admission site, which is the shape a registry grows out
 * of. The seam is therefore as narrow as the second implementation forced:
 *
 *   - the host identity the graded capability record is keyed on;
 *   - composing one fence-scoped admission configuration and reporting the
 *     digest over the bytes the binding wrote; and
 *   - naming that configuration's path again at teardown.
 *
 * Everything a second host did NOT force stays out. Projection
 * materialization, receipting, attestation minting, the admission validator,
 * the resume grade, and teardown of the projection subtree are host-neutral
 * already — both bindings call the same functions — so they are not restated
 * as members here. Nothing in this module discovers, enumerates, or selects a
 * binding: a caller holds exactly the one it was given. There is no registry,
 * no lookup, and no default resolved from a string.
 *
 * A binding COMPOSES; it never launches. Every result below is data the
 * operator or a test harness hands to the host.
 */

/** The grant surface a session composition projects onto a host's own controls. */
export interface HostSessionGrant {
  readonly allowedCapabilities: readonly string[];
  readonly writablePaths: readonly string[];
  readonly protectedPaths: readonly string[];
}

export interface ComposeHostSessionInput {
  /** The binding-owned directory in the product namespace. */
  readonly bindingDir: string;
  /** The binding state file the model-external hook consults per invocation. */
  readonly statePath: string;
  /** The command vector that runs the hook entry; the caller supplies the runtime. */
  readonly hookCommand: readonly string[];
  /** The fence THIS session is admitted under, baked into the hook command. */
  readonly fence: number;
  /** Exact host-created workspace this admission applies to. */
  readonly workspaceRoot: string;
  /** Shared Git authority, which no host capability may read or mutate. */
  readonly commonGitDir: string;
  /** Installation-owned capability state, outside the model's admitted filesystem. */
  readonly authorityDir: string;
  readonly grant: HostSessionGrant;
}

export interface ComposedHostSession {
  readonly ok: true;
  /** The fence-scoped admission configuration the binding wrote. */
  readonly admissionConfigurationPath: string;
  /**
   * What the operator hands the host to open an admitted session: CLI
   * arguments for a host that takes them, or the app-server request members
   * for a host that takes a request. The product never invokes it.
   */
  readonly hostAdmissionArguments: readonly string[];
  /** The digest over exactly the bytes this binding wrote. */
  readonly discoveryConfigurationDigest: string;
}

export interface HostBindingRefusalDetail {
  readonly code: string;
  readonly message: string;
}

export type ComposeHostSessionResult =
  | ComposedHostSession
  | { readonly ok: false; readonly blockers: readonly HostBindingRefusalDetail[] };

/**
 * One host's delivery binding. The facade holds a single instance and never
 * chooses between instances.
 */
export interface ManagedHostBinding {
  /** The key into the graded capability record; never a display name. */
  readonly hostId: string;
  composeSession(input: ComposeHostSessionInput): Promise<ComposeHostSessionResult>;
  /**
   * Recomputes the digest over the binding-written discovery configuration as
   * it stands on disk NOW, for the periodic recheck that compares it against
   * the digest the attestation bound. `undefined` where the bytes cannot be
   * read, which the caller treats as a mismatch rather than a pass.
   *
   * A seam member because the two implementations genuinely differ: one host's
   * configuration is a settings file beside a worktree-scoped exclusion, the
   * other's is a thread-start request. The digest is one definition per host,
   * used at application and at every recheck, and the recheck cannot be
   * written host-neutrally without it.
   */
  recomputeDiscoveryConfigurationDigest(input: {
    readonly admissionConfigurationPath: string;
    readonly bindingDir: string;
  }): Promise<string | undefined>;
  /**
   * The fence-scoped admission configuration's path, named without composing.
   * Teardown removes exactly the file a compose at that fence would have
   * written, so the two spellings are one definition rather than two.
   */
  admissionConfigurationPath(bindingDir: string, fence: number): string;
}
