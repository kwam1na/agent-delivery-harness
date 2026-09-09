/**
 * RFC 8785 (JSON Canonicalization Scheme) — the repository's only
 * canonicalizer.
 *
 * `manifestDigest`, `recordId`, and `workspaceId` are all digests over the
 * output of this module. A second canonicalizer would be a second definition
 * of identity, so there is exactly one, it lives in the kernel, and it has no
 * dependencies: the `canonicalize` npm package was rejected for supply-chain
 * surface on the most security-critical path in the system.
 *
 * This module is on the d1 kernel-import allowlist — pure modules import it —
 * so it imports nothing at all.
 *
 * Deliberate departures from `JSON.stringify`, all in the fail-closed
 * direction: `JSON.stringify` silently drops `undefined` members, symbol keys,
 * array holes, and functions, silently turns `NaN`/`Infinity` into `null`,
 * silently renders a `Date` (or any object with `toJSON`) as something other
 * than its members, and silently escapes unpaired surrogates that RFC 8785
 * §3.2.2.2 requires be rejected. Every one of those is a canonical form that
 * does not represent the caller's value, which on this path means a digest
 * over data nobody wrote. All of them throw `CanonicalizationError` here.
 */
type CanonicalErrorCode = 
/** `NaN`, `Infinity`, `-Infinity` — not representable in JSON (RFC 8785 §3.2.2.3). */
"non_finite_number"
/** `undefined`, a function, a symbol, a bigint, or a non-plain object. */
 | "unsupported_value"
/** An own symbol-keyed member, which has no JSON spelling. */
 | "symbol_key"
/** An unpaired surrogate in a string value or member name (RFC 8785 §3.2.2.2). */
 | "lone_surrogate"
/** A value that contains itself. */
 | "circular_reference";
/**
 * Thrown for input that has no canonical JSON form. `path` is a JSON Pointer
 * (RFC 6901) to the offending value, so a caller can name the member rather
 * than the whole document.
 */
declare class CanonicalizationError extends Error {
    readonly code: CanonicalErrorCode;
    readonly path: string;
    constructor(code: CanonicalErrorCode, path: string, message: string);
}
/**
 * RFC 8785 §3.2.3 member ordering: compare UTF-16 code units, not code points
 * and not collation.
 *
 * The distinction is load-bearing for astral keys. U+1F600 is the surrogate
 * pair D83D DE00; its leading code unit 0xD83D sorts *below* a BMP key such as
 * U+FB33 or U+FF21, while its code point 0x1F600 sorts far above them.
 * A code-point sort or a `localeCompare` sort therefore produces different
 * bytes — and `localeCompare` is additionally locale- and ICU-build-dependent,
 * which is why Athena's `stableJson` was not ported.
 *
 * This is exactly the ECMAScript relational operator on strings; it is spelled
 * out rather than left to `Array.prototype.sort`'s default so the ordering the
 * spec depends on is stated in the code that depends on it.
 */
declare function compareUtf16CodeUnits(a: string, b: string): number;
/**
 * Canonicalizes a JSON-representable value to its RFC 8785 form: members
 * sorted by UTF-16 code unit at every depth, no insignificant whitespace,
 * ECMAScript number and string serialization. Throws
 * {@link CanonicalizationError} for anything JSON cannot represent. Never
 * mutates its input.
 */
declare function canonicalize(value: unknown): string;
/**
 * The canonical form as UTF-8 bytes — RFC 8785 §3.3's serialization, and what
 * every digest in this system is computed over. No BOM.
 */
declare function canonicalBytes(value: unknown): Uint8Array;

type DigestErrorCode = "not_sha256_hex";
/** Thrown when a value that must be a lowercase-hex SHA-256 digest is not one. */
declare class DigestError extends Error {
    readonly code: DigestErrorCode;
    constructor(code: DigestErrorCode, message: string);
}
/** SHA-256 of a byte string, or of a string's UTF-8 bytes, as lowercase hex. */
declare function sha256Hex(input: string | Uint8Array): string;
/** SHA-256 of a value's RFC 8785 canonical bytes, as lowercase hex. */
declare function digestCanonical(value: unknown): string;
/** True when `value` is a lowercase-hex SHA-256 digest. */
declare function isSha256Hex(value: unknown): boolean;
/** Returns `value` when it is a lowercase-hex SHA-256 digest; throws otherwise. */
declare function assertSha256Hex(value: unknown): string;
/**
 * Compares two digests, rejecting anything that is not already a
 * lowercase-hex SHA-256 digest. Deliberately not case-insensitive: an
 * uppercase digest reaching a comparison means something upstream emitted a
 * spelling this system does not produce, and quietly folding it would hide
 * that.
 */
declare function digestsEqual(a: string, b: string): boolean;
/**
 * The delivery-evidence/1 manifest digest (spec §6):
 *
 *     manifestDigest = lowerhex(sha256(JCS(manifest with attestation.signatures := [])))
 *
 * Emptying the signature array before digesting is what lets a future
 * signature sign the digest without signing itself, and what gives a level-
 * `self` manifest and its later-countersigned form one content identity. The
 * digest is therefore invariant under any change to `attestation.signatures`
 * — including its absence — and variant under every other member.
 */
declare function manifestDigest(manifest: unknown): string;

/**
 * The failure vocabulary every other unit speaks.
 *
 * Three things live here and nowhere else:
 *
 *   1. `createBlocker` — the single constructor. Codes and source ids are
 *      pattern-validated at the type level and again at runtime, summaries
 *      collapse to one line, details are redacted and bounded, and a blocker
 *      without remediation guidance is unconstructible. A call site cannot opt
 *      out of any of it, which is the whole reason there is one constructor.
 *   2. `GATE_STRUCTURAL_FINDING_CODES` — the evaluator's own blocked-finding
 *      codes, disjoint from the provider code surfaces configs declare. The
 *      config loader partitions each obligation's `waivableCodes ⊎
 *      nonWaivableCodes` against this constant plus config data; the gate
 *      evaluator emits them.
 *   3. `renderBlockers` / `serializeBlockers` — the two faces of the one
 *      renderer. Both neutralize per spec §11.2 and both are **total**: they
 *      never throw, whatever the blocker carries. This matters because they run
 *      inside failure handlers, where a throw destroys the very output the
 *      contract exists to produce.
 *
 * WHERE EACH CHAIN LIVES, AND WHY IT IS SPLIT.
 *
 *   Redaction runs in the **constructor** (spec §11.3). Stored, serialized, and
 *   logged forms all descend from the constructed value, so redacting later
 *   would leave the secret in every retained copy.
 *
 *   Neutralization runs in the **renderer** (spec §11.2). The renderer is the
 *   last thing before a display surface, and not everything it renders passed
 *   through the constructor — an MCP payload deserialized from another process
 *   is exactly the case a constructor-side guard would miss.
 *
 * PURITY. This module is on the d1 kernel-import allowlist: pure modules import
 * it, so it must acquire no dependencies. It imports nothing at all — no fs, no
 * process, no clock, no runtime API. The import-boundary sensor enforces this.
 */
declare const BLOCKER_CONTRACT_VERSION: 1;
/**
 * Bound applied when a blocker is constructed, so the serialized envelope and
 * any retained log inherit it. The renderer bounds further for the screen; this
 * cap is what stops a runaway provider report from being *kept* in full.
 */
declare const MAX_BLOCKER_DETAIL_LENGTH = 8000;
/** The code every surface uses for an unexpected throw (never a policy block). */
declare const INTERNAL_ERROR_CODE = "internal_error";
/**
 * Who is blocking. The kind is closed; the id is config-owned data, so it is
 * pattern-validated rather than membership-checked (this module never imports
 * `config.ts` — `config.ts` imports *it*).
 *
 * Each kind names the emitter it exists for, so a kind nothing emits is a
 * defect rather than a decoration:
 *   gate            — gate-level blocks, from the evaluator and its adapter
 *   obligation      — a blocked obligation resolution, from the evaluator
 *   provider        — a provider finding, or a provider-shaped failure
 *   candidate       — candidate capture and drift
 *   preparation     — preparation-receipt failure classes
 *   store           — the git-private evidence store
 *   delivery-record — producing or verifying the tracked delivery record
 *   config          — load-time config findings
 *   command         — the invocation surfaces themselves (CLI, MCP, Action)
 *
 * Every one of these emitters other than this module is still to be written.
 */
declare const BLOCKER_SOURCE_KINDS: readonly ["gate", "obligation", "provider", "candidate", "preparation", "store", "delivery-record", "config", "command"];
type BlockerSourceKind = (typeof BLOCKER_SOURCE_KINDS)[number];
interface BlockerSource {
    readonly kind: BlockerSourceKind;
    readonly id: string;
}
/**
 * The evaluator's structural blocked-finding codes — the failures that come
 * from the shape of the evidence rather than from a provider's opinion of the
 * work. Deliberately disjoint from provider `findingCodes`, which are config
 * data: the config loader requires each obligation's waivable/non-waivable
 * lists to partition this set ∪ its registered providers' sets exactly, and a
 * code that could be in both universes would make that partition meaningless.
 */
declare const GATE_STRUCTURAL_FINDING_CODES: readonly ["review_evidence_missing", "stale_evidence", "evidence_not_green", "unresolved_actionable_findings", "ambiguous_records", "malformed_record", "unknown_provider", "live_provider_missing", "ambiguous_live_provider", "live_provider_failed", "resolution_not_allowed"];
type GateStructuralFindingCode = (typeof GATE_STRUCTURAL_FINDING_CODES)[number];
type NonEmptyTuple<T> = readonly [T, ...T[]];
/** Remediation commands are argv arrays: no shell, and no empty invocation. */
type CommandArguments = NonEmptyTuple<string>;
interface RemediationBase {
    /** Stable kebab-case identity, used to deduplicate repeated guidance. */
    readonly id: string;
    readonly summary: string;
    readonly details?: string;
}
type Remediation = (RemediationBase & {
    readonly kind: "command";
    readonly command: CommandArguments;
}) | (RemediationBase & {
    readonly kind: "manual_action";
}) | (RemediationBase & {
    readonly kind: "code_change";
}) | (RemediationBase & {
    readonly kind: "retry";
    readonly command?: CommandArguments;
});
interface Blocker {
    readonly code: string;
    readonly source: BlockerSource;
    readonly summary: string;
    readonly details?: string;
    readonly remediations: NonEmptyTuple<Remediation>;
}
interface BlockerInput {
    readonly code: string;
    readonly source: BlockerSource;
    readonly summary: string;
    readonly details?: string;
    readonly remediations: NonEmptyTuple<Remediation>;
}
/**
 * The code grammar, expressed in the type system so a bad literal fails to
 * compile rather than only at runtime. `[a-z0-9]+([_-][a-z0-9]+)*`: snake_case
 * for the evaluator's structural codes, kebab-case for the provider codes
 * configs declare, and nothing else — no dots (that is the source-id grammar),
 * no capitals, no separator runs.
 */
type CodeCharacter = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z" | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "_" | "-";
type OnlyCodeCharacters<S extends string> = S extends `${infer Head}${infer Rest}` ? Head extends CodeCharacter ? OnlyCodeCharacters<Rest> : false : true;
type ValidBlockerCode<S extends string> = string extends S ? S : S extends "" ? never : S extends `_${string}` | `-${string}` | `${string}_` | `${string}-` ? never : S extends `${string}__${string}` | `${string}--${string}` | `${string}_-${string}` | `${string}-_${string}` ? never : OnlyCodeCharacters<S> extends true ? S : never;
interface RenderOptions {
    /** Per-blocker detail budget on screen. Storage is bounded separately. */
    readonly maxDetailLength?: number;
    /** Whole-output budget. Remediation claims its share first. */
    readonly maxOutputLength?: number;
}
interface SerializedRemediation {
    readonly id: string;
    readonly kind: string;
    readonly summary: string;
    readonly details: string | null;
    readonly command: readonly string[] | null;
}
interface SerializedBlocker {
    readonly code: string;
    readonly source: {
        readonly kind: string;
        readonly id: string;
    };
    readonly summary: string;
    readonly details: string | null;
    readonly remediations: readonly SerializedRemediation[];
}
interface SerializedBlockers {
    readonly contractVersion: typeof BLOCKER_CONTRACT_VERSION;
    readonly blockers: readonly SerializedBlocker[];
}
/** A typed policy failure. Surfaces render `blockers`; nothing prints the stack. */
declare class BlockedError extends Error {
    readonly blockers: readonly Blocker[];
    constructor(blockers: readonly Blocker[], message?: string);
}
/**
 * Exported for the run-surface CLI viewer, which renders executor-written free
 * text — rationales, decisions, blocker summaries — to an operator's terminal
 * and owes it exactly this treatment. Same function, same rules, one copy: a
 * second neutralizer is a second place for a sequence to survive.
 */
declare function neutralizeForDisplay(value: string): string;
/**
 * Details keep their newlines — a stack or a provider report is unreadable as
 * one line — but are redacted and bounded here rather than at the renderer, so
 * no stored or serialized form can retain more than the operator was shown.
 *
 * Exported because blockers are not the only operator-facing text built from
 * untrusted bytes: the evidence store's quarantine diagnostics quote the file
 * they refuse, and a credential planted in such a file must not survive the
 * quote. Redaction happens at construction there for the same reason it does
 * here — every retained copy descends from the constructed value. Callers get
 * *this* chain rather than a second one; two redaction implementations would
 * drift, and the weaker one would be the one that mattered.
 */
declare function sanitizedDetail(value: unknown, label: string): string;
/**
 * The single constructor every blocker passes through, so redaction is a
 * property of the contract rather than something each call site remembers.
 *
 * It returns a normalized copy on purpose: validating the cleaned text and then
 * discarding it would leave the guarantee documented but unenforced everywhere
 * downstream.
 */
declare function createBlocker<const TInput extends BlockerInput>(input: TInput & {
    readonly code: ValidBlockerCode<TInput["code"]>;
}): Blocker;
/**
 * An unexpected throw is not a policy decision, and must never be reported as
 * one. Whatever was thrown — an Error, a string, a symbol, an object whose
 * `toString` itself throws — becomes a typed blocker with a reproduce command.
 */
declare function createInternalErrorBlocker(input: {
    readonly source: BlockerSource;
    readonly error: unknown;
    readonly reproduce: CommandArguments;
    readonly retainedLogPath?: string;
}): Blocker;
/**
 * The text surface: CLI stderr, Action logs, MCP text content. Total — it
 * returns a string for every input, including inputs that are not blockers.
 */
declare function renderBlockers(blockers: readonly Blocker[], options?: RenderOptions): string;
/**
 * The structured surface: MCP rejections and Action outputs. An agent context
 * window is a rendering surface too, so this neutralizes exactly as the text
 * renderer does, and is equally total — the result is always JSON-serializable.
 */
declare function serializeBlockers(blockers: readonly Blocker[]): SerializedBlockers;

/**
 * The harness configuration: one object, injected everywhere, validated once.
 *
 * Nothing in the kernel reaches for ambient policy. Every dimension a module
 * needs — which gate this is, which specs it accepts, which paths are narration,
 * which finding codes a human may waive — arrives as a parameter, and the
 * import-boundary sensor enforces that no kernel module imports a config module
 * by name. `defineHarnessConfig` is the one door into that object.
 *
 * WHY THE INVARIANTS LIVE HERE. A config is policy, and inconsistent policy is
 * not a runtime surprise to be discovered at the gate — it is a defect the
 * author should learn about while editing the file. So the rules that relate one
 * member to another (a waiver flag that contradicts the resolution kinds it
 * governs, a delivery-record path the identity rules would exclude from one set
 * but not the other, a finding code no obligation classifies) are checked at
 * load time, all of them, and reported together. Reporting the first failure
 * only would turn one editing session into five.
 *
 * WHY THE CODE UNIVERSE IS INJECTED. The partition invariant needs to know every
 * finding code an obligation can emit. That universe is the structural registry
 * from the blocker contract plus the finding codes the config's own providers
 * declare — both available here. It is deliberately *not* obtained by importing
 * the validator or the evaluator: the loader must not depend on the modules
 * whose vocabulary it is checking, or the check becomes circular and the
 * validator becomes unable to change without the loader agreeing.
 *
 * PURITY. This module is on the kernel-import allowlist that pure modules draw
 * from, so it must stay pure itself: it imports the blocker contract and nothing
 * else — no filesystem, no process, no clock. Reading a config file from disk is
 * the job of the command surfaces; what happens here is validation of a value
 * that has already been handed over.
 *
 * WHO READS WHAT. Every member below names the module that reads it, because a
 * member nothing reads is dead policy that will drift out of truth unnoticed:
 *
 *   gateId                      evidence record store (record identity + filenames)
 *   baseRef                     candidate capture
 *   storageNamespace            evidence record store, preparation receipts
 *   acceptedEnvelopeSpecs       manifest validator (envelope spec rule)
 *   identityVersions            manifest validator (identity-version rule)
 *   computingIdentityVersion    deliverable identity
 *   reviewNeutral               deliverable identity — the only set that
 *                               excludes entries from the deliverable digest
 *   recordNeutral               deliverable identity — a separate predicate that
 *                               never affects the digest
 *   pathClassification          activation projection
 *   sensitivePaths              activation projection
 *   activationThreshold         activation projection
 *   providers[].findingCodes    this loader's partition invariant, admission adapter
 *   agentEnvSignals             execution-context classification
 *   ciPolicies                  execution-context classification
 *   ciPolicyEnvKey              execution-context classification
 *   preparationWiringPaths      preparation receipts (fingerprint input)
 *   obligations[].activation    activation projection, gate evaluator
 *   obligations[].freshness     gate evaluator
 *   obligations[].providers     gate evaluator, admission adapter
 *   obligations[].providerPolicy
 *                               gate evaluator — the quantifier over the
 *                               obligation's providers; capture and projection
 *                               never read it
 *   obligations[].acceptedPayloadSpecs
 *                               manifest validator (claim payload rule)
 *   obligations[].allowedResolutionKinds
 *                               gate evaluator
 *   obligations[].humanWaiverAllowed
 *                               gate evaluator, admission adapter
 *   obligations[].minimumAttestationLevel
 *                               this loader's scope invariant; the manifest
 *                               validator becomes the behavioral reader when
 *                               levels above `self` are specified
 *   obligations[].ciDelegationPolicyIds
 *                               gate evaluator
 *   obligations[].remediation   gate evaluator (blocker remediation catalog)
 *   obligations[].waivableCodes / nonWaivableCodes
 *                               gate evaluator, admission adapter
 *   deliveryRecordPath          the record command, the CI verification action
 *   deliveryRecordVerification  the delivery-record verify core only — never the
 *                               gate evaluator, so the local gate can never be
 *                               more permissive than CI
 */

/** The identity token this version of the deliverable digest is defined for. */
declare const DELIVERABLE_TREE_V1 = "deliverable-tree/v1";
/**
 * The narration set `deliverable-tree/v1` is defined over.
 *
 * The identity token binds this set, in both directions. A digest computed
 * while excluding some *other* set of paths is a different function, and naming
 * it `deliverable-tree/v1` would make two incompatible digests share one token —
 * exactly the confusion a version string exists to prevent. The converse holds
 * too: excluding precisely this set and calling it something else forks the
 * namespace for a function that already has a name.
 */
declare const DELIVERABLE_TREE_V1_NARRATION_SET: readonly NeutralMatcher[];
/** The three levels the evidence spec defines. Only `self` is specified in v1. */
declare const ATTESTATION_LEVELS: readonly ["self", "provider-signed", "independently-verified"];
type AttestationLevel = (typeof ATTESTATION_LEVELS)[number];
/** The only level this version can enforce; higher levels await a signing profile. */
declare const V1_ATTESTATION_LEVEL: AttestationLevel;
/**
 * The resolutions a config may permit. `blocked` is absent on purpose: it is
 * what happens when nothing else applies, never something policy grants.
 */
declare const RESOLUTION_KINDS: readonly ["satisfied_live_fact", "satisfied_evidence", "waived", "delegated", "not_applicable"];
type ResolutionKind = (typeof RESOLUTION_KINDS)[number];
/** Integrity failures are never discharged by policy exceptions. */
declare const NON_WAIVABLE_INTEGRITY_CODES: readonly string[];
/** When an obligation applies to a candidate. */
declare const ACTIVATION_KINDS: readonly ["always", "relevant_change"];
type ActivationKind = (typeof ACTIVATION_KINDS)[number];
/**
 * The evaluator's quantifier over an obligation's providers. `"all"` demands
 * every approved provider be accounted for; `"existential"` is satisfied by any
 * one of them. Absent means `"all"` — the fail-closed reading, and the only
 * quantifier the evaluator implemented before this member existed.
 */
declare const PROVIDER_POLICIES: readonly ["all", "existential"];
type ProviderPolicy = (typeof PROVIDER_POLICIES)[number];
/**
 * What evidence must be bound to. `exact_candidate` obligations are satisfied by
 * evidence recorded against this candidate's identity; `live` obligations are
 * facts the gate observes now and never inherits from a prior invocation.
 */
declare const FRESHNESS_KINDS: readonly ["live", "exact_candidate"];
type FreshnessKind = (typeof FRESHNESS_KINDS)[number];
/** Whether a moved base invalidates a tracked delivery record. */
declare const BASE_MOVEMENT_POLICIES: readonly ["stale", "allow"];
type BaseMovementPolicy = (typeof BASE_MOVEMENT_POLICIES)[number];
/** Path matchers outside the neutral sets carry their kind explicitly. */
declare const PATH_MATCHER_KINDS: readonly ["prefix", "glob"];
type PathMatcherKind = (typeof PATH_MATCHER_KINDS)[number];
/** Evidence lives under the git directory, not the worktree. */
declare const DEFAULT_STORAGE_NAMESPACE = "delivery-harness/";
declare const DEFAULT_BASE_REF = "origin/main";
/** A moved base stales a delivery record unless the config says otherwise. */
declare const DEFAULT_BASE_MOVEMENT_POLICY: BaseMovementPolicy;
/**
 * Neutral-set matchers are prefix-anchored, with an optional suffix. They are
 * deliberately weaker than the classification matchers below: these decide what
 * leaves a content digest, and a glob there would make identity depend on the
 * subtleties of a pattern engine.
 */
interface NeutralMatcher {
    readonly prefix: string;
    readonly suffix?: string;
}
interface PathMatcher {
    readonly kind: PathMatcherKind;
    readonly value: string;
}
interface SensitivePathGroup {
    readonly id: string;
    readonly patterns: readonly PathMatcher[];
}
interface PathClassification {
    readonly generated: readonly PathMatcher[];
    readonly test: readonly PathMatcher[];
    readonly lockfile: readonly PathMatcher[];
}
interface ProviderRegistration {
    readonly id: string;
    /** Every finding code this provider can report. Half of the code universe. */
    readonly findingCodes: readonly string[];
    /** Optional stdio provider-rail executable, expressed as argv and never a shell string. */
    readonly command?: NonEmptyTuple<string>;
    /** Deterministic bounded check executed by the product, not a provider protocol. */
    readonly check?: {
        readonly command: NonEmptyTuple<string>;
        readonly timeoutMs: number;
        readonly outputs?: readonly string[];
    };
}
interface PreparationCommand {
    readonly id: string;
    /** Executed directly from the repository root, in declaration order. */
    readonly command: NonEmptyTuple<string>;
    readonly timeoutMs: number;
}
interface EnvironmentRequirement {
    readonly variable: string;
    readonly equals: string;
}
/**
 * A CI policy is selected by name (the value of `ciPolicyEnvKey`) and then
 * corroborated by `requiredEnv`. A selection whose corroboration fails is an
 * unauthorized automation, never a downgrade to an anonymous context.
 */
interface CiPolicy {
    readonly id: string;
    readonly requiredEnv: readonly EnvironmentRequirement[];
}
interface RemediationCatalog {
    readonly default: readonly Remediation[];
    readonly byCode?: Readonly<Record<string, readonly Remediation[]>>;
}
/**
 * When an obligation applies, and how the `relevant_change` signals may be
 * narrowed. The three optional members are read by the activation projection's
 * `isObligationActive` and nothing else, and every one of them defaults to the
 * widened, fail-closed reading:
 *
 *   `sensitiveGroupIds`  absent: every declared sensitive-path group activates
 *                        this obligation. Present: only the named groups do —
 *                        and an empty list opts the obligation out of the
 *                        sensitive signal entirely. Each id must name a group
 *                        in `sensitivePaths`; the loader rejects a dangling
 *                        reference the same way it rejects a dangling provider.
 *   `relevantBinaryChangeActivates`
 *                        absent or true: a reviewable binary change activates.
 *   `relevantZeroLineChangeActivates`
 *                        absent or true: a reviewable change that counts no
 *                        lines (a mode flip, a pure rename) activates.
 *
 * The two flags are deliberately separate members: they name independent
 * signals. A security-review obligation may not care about a `chmod` yet care
 * intensely about a replaced binary; a licence obligation is the reverse.
 * None of the three narrows an `always` obligation, which ignores the
 * projection entirely.
 */
interface ObligationActivation {
    readonly kind: ActivationKind;
    readonly sensitiveGroupIds?: readonly string[];
    readonly relevantBinaryChangeActivates?: boolean;
    readonly relevantZeroLineChangeActivates?: boolean;
}
interface ObligationPolicy {
    readonly id: string;
    readonly activation: ObligationActivation;
    readonly freshness: FreshnessKind;
    readonly providers: readonly string[];
    /**
     * The evaluator's quantifier over `providers`. Absent means `"all"`, which is
     * byte-for-byte the behavior the evaluator had before this member existed —
     * the member is additive, and only `"existential"` changes anything.
     */
    readonly providerPolicy?: ProviderPolicy;
    readonly acceptedPayloadSpecs: readonly string[];
    readonly allowedResolutionKinds: readonly ResolutionKind[];
    readonly humanWaiverAllowed: boolean;
    readonly minimumAttestationLevel: AttestationLevel;
    readonly ciDelegationPolicyIds: readonly string[];
    readonly remediation: RemediationCatalog;
    readonly waivableCodes: readonly string[];
    readonly nonWaivableCodes: readonly string[];
}
interface DeliveryRecordVerification {
    readonly baseMovement: BaseMovementPolicy;
}
/** Repository-selected review policy, added to the installed default charters. */
interface AdditionalReviewLens {
    readonly lensId: string;
    readonly reviewerId: string;
    readonly charterPath: string;
}
interface HarnessConfig {
    readonly gateId: string;
    readonly baseRef: string;
    readonly storageNamespace: string;
    readonly acceptedEnvelopeSpecs: readonly string[];
    readonly identityVersions: readonly string[];
    readonly computingIdentityVersion: string;
    readonly reviewNeutral: readonly NeutralMatcher[];
    readonly recordNeutral: readonly NeutralMatcher[];
    readonly pathClassification: PathClassification;
    readonly sensitivePaths: readonly SensitivePathGroup[];
    readonly activationThreshold: number;
    readonly providers: readonly ProviderRegistration[];
    readonly agentEnvSignals: readonly string[];
    readonly ciPolicies: readonly CiPolicy[];
    readonly ciPolicyEnvKey: string;
    readonly preparationWiringPaths: readonly string[];
    readonly preparationCommands?: readonly PreparationCommand[];
    readonly additionalReviewLenses?: readonly AdditionalReviewLens[];
    readonly obligations: readonly ObligationPolicy[];
    readonly deliveryRecordPath: string;
    readonly deliveryRecordVerification: DeliveryRecordVerification;
}
/** The three members that carry defaults are optional at the authoring site. */
type HarnessConfigInput = Omit<HarnessConfig, "baseRef" | "storageNamespace" | "deliveryRecordVerification"> & Partial<Pick<HarnessConfig, "baseRef" | "storageNamespace" | "deliveryRecordVerification">>;
type HarnessConfigValidation = {
    readonly ok: true;
    readonly config: HarnessConfig;
} | {
    readonly ok: false;
    readonly blockers: NonEmptyTuple<Blocker>;
};
/**
 * What a config can be wrong about. Each code is produced by exactly one rule,
 * so a falsification row can name the rule it is falsifying rather than
 * asserting on prose.
 */
declare const CONFIG_FINDING_CODES: readonly ["config_unknown_member", "config_missing_member", "config_invalid_member", "config_duplicate_id", "config_dangling_provider", "config_dangling_ci_policy", "config_dangling_sensitive_group", "config_no_payload_spec", "config_waiver_policy_mismatch", "config_empty_remediation", "config_unclassified_finding_code", "config_double_classified_finding_code", "config_stale_finding_code", "config_record_neutral_not_subset", "config_delivery_record_not_neutral", "config_identity_version_not_accepted", "config_identity_token_requires_v1_neutral_set", "config_v1_neutral_set_requires_v1_token", "config_no_obligations", "config_unsupported_attestation_level"];
type ConfigFindingCode = (typeof CONFIG_FINDING_CODES)[number];
/**
 * The one place a neutral matcher is interpreted. The identity computation reads
 * this rather than reimplementing it, so the predicate the loader checks the
 * delivery-record path against is the predicate that decides what leaves the
 * digest — a second implementation is a second answer waiting to happen.
 */
declare function matchesNeutralSet(matchers: readonly NeutralMatcher[], path: string): boolean;
/**
 * The candidate-keyed delivery-record path: `deliveryRecordPath` with the
 * deliverable digest spliced in before its extension.
 *
 * WHY THIS LIVES IN CONFIG AND NOT BESIDE THE RECORD. The derived path is what
 * actually gets written, so it — not the configured path — is what has to be
 * neutral to both predicates. The loader must therefore be able to check it, and
 * the loader cannot import the delivery-record module (it is d2; this file is
 * d1). The derivation is pure string work over a member this file already owns,
 * so it belongs here and the record module consumes it from here. One
 * derivation, one place, checked at load time.
 *
 * THE DOT AT POSITION ZERO IS NOT AN EXTENSION. `.deliveryrecord` is a dotfile
 * whose whole basename is its name; reading the leading dot as an extension
 * separator would leave an empty stem and splice the digest into a file named
 * `--<digest>.deliveryrecord` — a different basename in a different directory
 * than the operator configured. Only a dot *after* the first character of the
 * basename separates an extension.
 */
declare function deriveDeliveryRecordPath(deliveryRecordPath: string, deliverableDigest: string): string;
/** {@link deriveDeliveryRecordPath} over a loaded config's own record path. */
declare function deliveryRecordPathFor(config: HarnessConfig, deliverableDigest: string): string;
/**
 * Every finding code the named obligation can be blocked by: the gate's own
 * structural codes plus the codes declared by the providers *this obligation*
 * registers. An obligation that drops a provider drops that provider's codes,
 * which is what makes a leftover classification a stale entry rather than a
 * harmless extra.
 */
declare function emittableFindingCodes(config: HarnessConfig, obligationId: string): readonly string[];
/**
 * Validates a candidate config and returns either the loaded config or every
 * finding at once.
 *
 * Shape and coherence are two passes, and the second runs only when the first is
 * clean. This is not laziness: a cross-member rule reading a half-parsed value
 * reports noise — a partition against a code list that failed to parse, a
 * neutrality check against a path that is not a string — and noise in a list of
 * config errors is worse than a shorter list, because the author cannot tell
 * which entries are real.
 */
declare function validateHarnessConfig(input: unknown): HarnessConfigValidation;
/**
 * The authoring entry point. Returns the loaded config, or throws a
 * `BlockedError` carrying every finding — config files are loaded at a command
 * boundary that renders blockers, so throwing keeps the happy path free of
 * result-unwrapping while losing none of the diagnostics.
 */
declare function defineHarnessConfig(input: HarnessConfigInput): HarnessConfig;

/**
 * The evidence record's shapes, with no filesystem in sight.
 *
 * `records.ts` opens files, runs git, and links directory entries. Pure modules
 * — the gate evaluator above all — need the *shapes* those operations move
 * around and must never acquire an edge to the operations themselves. That is
 * why the shapes live here: the purity sensor lets a pure module import a
 * `*.types.ts` file by name and nothing else from the fs-bearing side of the
 * kernel, so this seam is what keeps the evaluator honest.
 *
 * Nothing in this file may import anything. A type-only import would be safe
 * for the sensor and still wrong here: the point of the seam is that it has no
 * dependencies to reason about.
 */
/**
 * The record schema version. Deliberately *not* a member of the identity tuple
 * below — identity is the spec's SUB-4 tuple, closed and enumerated — so a
 * future version bump must either keep the tuple meaning what it means today or
 * change the filename grammar. Every stored record carries the version so a
 * reader can reject one it does not understand instead of guessing.
 */
declare const RECORD_SCHEMA_VERSION = 1;
/** A waiver is either good for this invocation only, or bound to the candidate. */
declare const WAIVER_SCOPES: readonly ["invocation", "durable"];
type WaiverScope = (typeof WAIVER_SCOPES)[number];
/**
 * What the record is bound to — the enumerated field set, no spreads.
 *
 * `workspaceId` appears here *and* on the record itself, and the redundancy is
 * intentional. The record's member says which workspace's store the file
 * belongs in; this one is part of the candidate the evidence was produced
 * against, and it travels into the gate's freshness comparison. They are
 * normally equal and the store does not require it: making them one field would
 * quietly turn a candidate that moved workspaces into a candidate that did not.
 */
interface RecordCandidateBinding {
    /** The raw prepared tree. Recorded strictly (SUB-1); ignored at gate time. */
    readonly treeSha: string;
    /** Digest of the deliverable under the configured neutral sets. */
    readonly deliverableDigest: string;
    /** The identity version that produced `deliverableDigest`. */
    readonly identityToken: string;
    readonly baseRef: string;
    readonly baseTipSha: string;
    readonly mergeBaseSha: string;
    readonly workspaceId: string;
}
/**
 * Accepted evidence. The provider triple (`providerId`, `runId`,
 * `finalPassId`) is part of the identity; `manifestDigest` is not — it is what
 * the record *says*, and two records that disagree about it on one identity are
 * the conflict SUB-4 exists to reject.
 */
interface CheckBinding {
    readonly definitionDigest: string;
    readonly validationDigest: string;
    readonly policyDigest: string;
    readonly wiringFingerprint: string;
    readonly outputsDigest: string;
}
interface EvidenceResolution {
    readonly kind: "evidence";
    readonly providerId: string;
    readonly runId: string;
    readonly finalPassId: string;
    /** Stamped from the accepted manifest (SUB-4). */
    readonly manifestDigest: string;
    readonly checkBinding?: CheckBinding;
    /** Accepted original evidence retained before its temporary run root disappears. */
    readonly portable?: PortableEvidence;
}
interface PortableEvidenceContext {
    readonly configurationDigest: string;
    readonly preparationFingerprint: string;
    readonly policyDigest: string | null;
    readonly release: Readonly<Record<string, unknown>> | null;
    readonly workflowGraphSha256: string | null;
    readonly reviewerCharters: readonly {
        readonly origin: "composition" | "repository";
        readonly sourcePath: string;
        readonly lensId: string;
        readonly reviewerId: string;
        readonly personaId: string;
        readonly entryPath: string;
        readonly digest: string;
    }[];
}
interface PortableEvidence {
    readonly version: "portable-evidence/1";
    readonly manifest: unknown;
    /** Safe manifest-relative path to canonical base64 of the original file bytes. */
    readonly artifacts: Readonly<Record<string, string>>;
    readonly context: PortableEvidenceContext;
}
/**
 * A waiver has no provider run: a human accepted a scoped exception. Its full
 * attribution participates in identity, so another approval can coexist while
 * a byte-identical approval remains idempotent. Nothing overwrites prior approval.
 */
interface WaiverResolution {
    readonly kind: "waiver";
    readonly scope: WaiverScope;
    readonly author: string;
    readonly reason: string;
    readonly findingCodes: readonly string[];
    readonly policyDigest: string;
}
type RecordResolution = EvidenceResolution | WaiverResolution;
interface EvidenceRecord {
    readonly schemaVersion: typeof RECORD_SCHEMA_VERSION;
    /** Digest of the identity tuple; also the last segment of the filename. */
    readonly recordId: string;
    /** The workspace whose private store owns this record. */
    readonly workspaceId: string;
    readonly gateId: string;
    readonly obligationId: string;
    readonly candidateBinding: RecordCandidateBinding;
    readonly resolution: RecordResolution;
}
/**
 * What a caller supplies. The three members it cannot choose — the schema
 * version, the workspace, and the content-addressed id — are derived by the
 * store, which is the only party that knows where the file is going.
 *
 * There is no timestamp. A record is content-addressed and republishable; a
 * clock reading would make a byte-identical resubmission differ from the stored
 * copy and turn idempotency into a conflict. When the record was written is a
 * property of the file, not of the evidence.
 */
type PublishRecordInput = Omit<EvidenceRecord, "schemaVersion" | "recordId" | "workspaceId">;
/** The tuple a `recordId` is the digest of, in its evidence spelling. */
interface EvidenceRecordIdentity {
    readonly workspaceId: string;
    readonly gateId: string;
    readonly obligationId: string;
    readonly candidateBinding: RecordCandidateBinding;
    readonly providerId: string;
    readonly runId: string;
    readonly finalPassId: string;
}
/** The waiver spelling binds the attributed approval instead of a provider run. */
interface WaiverRecordIdentity {
    readonly workspaceId: string;
    readonly gateId: string;
    readonly obligationId: string;
    readonly candidateBinding: RecordCandidateBinding;
    readonly kind: "waiver";
    readonly approval: WaiverResolution;
}
type RecordIdentity = EvidenceRecordIdentity | WaiverRecordIdentity;
/**
 * Why a file in the store is not being served as a record. The classes are kept
 * distinct because they mean different things to an operator: a truncated write
 * is a crashed writer or a full disk, while an identity mismatch is a file
 * whose contents no longer agree with the id they are filed under — which is
 * either tampering or a store written by a different version of this code.
 */
declare const RECORD_QUARANTINE_REASONS: readonly ["unreadable", "corrupt_json", "malformed_shape", "identity_mismatch"];
type RecordQuarantineReason = (typeof RECORD_QUARANTINE_REASONS)[number];
interface QuarantinedRecord {
    readonly path: string;
    readonly reason: RecordQuarantineReason;
    /** Operator-facing detail. Never parsed; only displayed. */
    readonly detail: string;
}
/**
 * A neighbour the store passed over. `in_progress` is a publisher's temporary
 * file — possibly one orphaned by a crash — and `foreign` is anything else
 * sharing the directory. Neither is a record and neither is a defect, but
 * reporting them keeps "the store ignored it" from being indistinguishable
 * from "the store never looked".
 */
interface IgnoredStoreEntry {
    readonly path: string;
    readonly reason: "in_progress" | "foreign";
}
interface RecordDiscovery {
    readonly storageDir: string;
    readonly workspaceId: string;
    readonly records: readonly EvidenceRecord[];
    readonly quarantined: readonly QuarantinedRecord[];
    readonly ignored: readonly IgnoredStoreEntry[];
}
/** Where a workspace's harness storage lives, and what that workspace is called. */
interface WorkspaceStorage {
    /** The namespace root — one per workspace, shared by every leaf. */
    readonly storageRoot: string;
    /** The leaf directory this resolution asked for. */
    readonly storageDir: string;
    readonly workspaceId: string;
}
type PublishStatus = "published" | "idempotent";
interface PublishedRecord {
    readonly status: PublishStatus;
    readonly path: string;
    readonly record: EvidenceRecord;
    readonly workspaceId: string;
}

declare function recordIdentity(workspaceId: string, input: PublishRecordInput): RecordIdentity;
/** `recordId` = lowercase-hex sha256 over the canonical identity tuple. */
declare function computeRecordId(workspaceId: string, input: PublishRecordInput): string;

/** The leaf this module owns. Preparation receipts reuse the resolver with their own. */
declare const RECORDS_LEAF = "records";
type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;
interface RecordStorageOptions {
    /** Repo-relative namespace under the git directory. Defaults to the config default. */
    readonly storageNamespace?: string;
    /** Leaf inside the namespace. Defaults to `records`. */
    readonly leaf?: string;
    /**
     * An already-resolved namespace root. When present git is never consulted,
     * which is what lets a caller (and this module's tests) address a store that
     * is not inside a repository.
     */
    readonly storageRoot?: string;
    readonly runGit?: GitRunner;
}
interface PublishOptions extends RecordStorageOptions {
    /**
     * Runs after the temporary is fsynced and before it is linked into place.
     * The crash-window test kills the process here; production callers do not
     * pass it. It exists because the window it names is the one interval in
     * which a failure could plausibly corrupt the store, and a window nothing
     * can enter is a window nothing can test.
     */
    readonly beforeLink?: () => void | Promise<void>;
}
interface RecordSelector extends RecordStorageOptions {
    readonly gateId: string;
    readonly obligationId: string;
}
/**
 * The one resolver. `workspaceId` is the digest of the **namespace root**, not
 * of the leaf, so records and preparation receipts — different directories —
 * agree on which workspace they belong to. Deriving it per leaf would give one
 * worktree two workspace identities and quietly break every cross-leaf
 * comparison built on it.
 */
declare function resolveRecordStorage(rootDir: string, options?: RecordStorageOptions): Promise<WorkspaceStorage>;

declare function recordFileName(gateId: string, obligationId: string, recordId: string): string;
/**
 * Publishes one record, atomically, and reports whether it created the entry or
 * found its own content already there.
 *
 * The two success statuses are not interchangeable to a caller that cares: a
 * recorder writing one record per claim expects `published`, and an idempotent
 * re-run of a completed submission expects `idempotent`. Both mean the store
 * now holds exactly this record; neither means anything was overwritten,
 * because nothing here ever overwrites.
 */
declare function publishRecord(rootDir: string, input: PublishRecordInput, options?: PublishOptions): Promise<PublishedRecord>;
/**
 * Reads every record filed under one gate and obligation in this workspace.
 *
 * Discovery never throws on a bad file. A store with one unreadable record in
 * it still has to answer the question "what evidence exists for this
 * obligation", and the evaluator has to be able to tell "no evidence" from
 * "evidence I refuse to trust" — so unusable files come back as quarantine
 * entries carrying their class, and the caller decides what that means.
 */
declare function discoverRecords(rootDir: string, selector: RecordSelector): Promise<RecordDiscovery>;

/**
 * The manifest rejection-code registry — the vocabulary a submitted
 * `delivery-evidence/1` manifest can be rejected in.
 *
 * This is the spec's Appendix D registry restated as an exhaustive `Record`
 * witness: every code names the rules that produce it, so a code with no rule
 * and a rule with no code are both compile-time or test-time errors rather than
 * discoveries. Appendix D is the source; the tests beside this file check the
 * transcription in both directions.
 *
 * DISJOINT FROM THE GATE'S VOCABULARY. `blockers.ts` owns
 * `GATE_STRUCTURAL_FINDING_CODES` — what the *evaluator* concludes about
 * evidence it already has. These codes are what the *validator* concludes about
 * a submission it is being offered. The two vocabularies never mix, and nothing
 * here is a blocker code.
 *
 * WHERE THE LINE IS. Four codes are not this validator's to emit. The reason is
 * a scope boundary, not an inability: what they judge is the recorder's
 * surface — the run root it allocates (SUB-3), the record store it publishes
 * into (SUB-4), and the artifact bytes it reads through its fs port (ENV-10's
 * realpath clause, ENV-11). Byte-level artifact verification is the clearest
 * case: it is a filesystem operation over files at declared paths, and a digest
 * taken over whatever string map a caller assembled is a different operation
 * with a different meaning — running it here would report a verification that
 * never happened. The codes are registered anyway, because the registry is the
 * whole registry, and carry `emitter: "recorder"` so the split is a stated fact
 * with a test behind it. The conformance kit's five recorder-dependent vectors
 * are exactly the vectors whose expectations sit on that side of the line;
 * their coverage arrives with integration mode.
 */

/**
 * The envelope spec this validator implements. Version strings are exact-match
 * domain-separation tokens (§10), single-sourced here so the docs, the kit
 * runner and the validator cannot drift apart.
 */
declare const DELIVERY_EVIDENCE_1 = "delivery-evidence/1";
/** The original payload spec. Its expansion-only deferral rule is immutable. */
declare const REVIEW_GREEN_1 = "review.green/1";
/** The payload spec that also admits tracked in-contract P2/P3 deferrals. */
declare const REVIEW_GREEN_2 = "review.green/2";
/** Envelope specs the validator implements, whatever a config accepts (GEN-2). */
declare const SUPPORTED_ENVELOPE_SPECS: readonly string[];
/** Payload specs the validator implements, whatever a config accepts (ENV-14). */
declare const SUPPORTED_PAYLOAD_SPECS: readonly string[];
/**
 * The one attestation level `delivery-evidence/1` fully specifies (§7). The
 * other two levels are defined but unimplementable until a signing profile
 * exists, so a validator that accepted them would be laundering level-`self`
 * evidence as something stronger (§11.4).
 */
declare const CONFORMING_ATTESTATION_LEVEL = "self";
/** Every rule id in spec §8 and §9.3, in spec order. */
declare const MANIFEST_RULE_IDS: readonly ["GEN-1", "GEN-2", "GEN-3", "GEN-4", "GEN-5", "ENV-1", "ENV-2", "ENV-3", "ENV-4", "ENV-5", "ENV-6", "ENV-7", "ENV-8", "ENV-9", "ENV-10", "ENV-11", "ENV-12", "ENV-13", "ENV-14", "SUB-1", "SUB-2", "SUB-3", "SUB-4", "SUB-5", "RG-1", "RG-2", "RG-3", "RG-4", "RG-5", "RG-6", "RG-7", "RG-8", "RG-9", "RG-10"];
type ManifestRuleId = (typeof MANIFEST_RULE_IDS)[number];
/**
 * The rules that produce no code because they constrain the validator rather
 * than the manifest: atomicity (GEN-3), the time ban (GEN-5), and
 * all-violations reporting (SUB-5). They are observable in this
 * implementation — GEN-3 through the single all-or-nothing result, GEN-5
 * through the sensor's time ban and the digest test, SUB-5 through every
 * multi-code vector — but no manifest can violate them.
 */
declare const META_RULE_IDS: readonly ManifestRuleId[];
/** Appendix D, in registry order. */
declare const MANIFEST_REJECTION_CODES: readonly ["unknown_member", "unsupported_envelope_spec", "malformed_field", "invalid_provider_id", "unregistered_provider", "invalid_run_id", "invalid_pass_id", "unsupported_vcs", "invalid_object_id", "unsupported_identity_version", "repository_required", "run_history_final_mismatch", "artifact_path_invalid", "artifact_path_duplicate", "artifact_outside_run_root", "artifact_digest_mismatch", "unsupported_attestation", "no_claims", "duplicate_claim", "obligation_not_configured", "unsupported_payload_spec", "candidate_mismatch", "candidate_unprepared", "manifest_outside_run_root", "record_conflict", "verdict_not_green", "not_finalized", "edited_after_final_pass", "reviewer_set_invalid", "reviewer_set_incomplete", "approval_missing", "approval_mismatch", "finding_invalid", "blocking_finding_present", "actionable_unresolved", "illegal_deferral", "telemetry_mismatch", "iteration_count_mismatch", "invalid_cost"];
type ManifestRejectionCode = (typeof MANIFEST_REJECTION_CODES)[number];
/**
 * `validator` — decidable from the manifest, the repository configuration, and
 * the candidate observation the caller supplies.
 *
 * `recorder` — owned by the recorder's surface: the run root it allocates, the
 * records it publishes, and the artifact bytes it reads and hashes through its
 * fs port. A pure validator can be handed values that resemble those things,
 * which is exactly why it must not answer in their name: a caller would then
 * hold a verification nobody performed.
 */
type RejectionEmitter = "validator" | "recorder";
interface ManifestRejectionCodeEntry {
    readonly rules: NonEmptyTuple<ManifestRuleId>;
    readonly emitter: RejectionEmitter;
}
/**
 * Exhaustive by construction: the key type is the code union, so a code added
 * to the list above without an entry here fails to compile.
 */
declare const MANIFEST_REJECTION_REGISTRY: Readonly<Record<ManifestRejectionCode, ManifestRejectionCodeEntry>>;
/** Codes this unit's validator can produce. */
declare const VALIDATOR_EMITTED_CODES: readonly ManifestRejectionCode[];
/** Codes only the recorder can reach, because only it observes the state they judge. */
declare const RECORDER_EMITTED_CODES: readonly ManifestRejectionCode[];
declare function isManifestRejectionCode(value: unknown): value is ManifestRejectionCode;
/**
 * One violated rule. `pointer` is an RFC 6901 JSON pointer into the submitted
 * manifest, so a caller can show the offending member without the validator
 * formatting anything for a screen — that is the renderer's job, and the
 * messages here are constant strings that never interpolate provider-authored
 * text. A pointer can still carry a submitted member name (an unknown member is
 * named by the pointer to it), which is why display goes through the shared
 * renderer's neutralization (§11.2) like any other evidence text.
 */
interface ManifestRejection {
    readonly code: ManifestRejectionCode;
    readonly rule: ManifestRuleId;
    readonly pointer: string;
    readonly message: string;
}
/**
 * Validation is atomic (GEN-3): one verdict for the whole submission, carrying
 * every violated rule (SUB-5). There is no partial acceptance and no
 * first-failure short circuit.
 */
type ManifestValidation<T> = {
    readonly ok: true;
    readonly manifest: T;
} | {
    readonly ok: false;
    readonly rejections: NonEmptyTuple<ManifestRejection>;
};

interface ManifestDeliverable {
    readonly digest: string;
    readonly identity: string;
}
interface ManifestBase {
    readonly ref: string;
    readonly tipSha: string;
    readonly mergeBaseSha: string;
}
interface ManifestCandidate {
    readonly vcs: "git";
    readonly treeSha: string;
    readonly headSha?: string;
    readonly deliverable: ManifestDeliverable;
    readonly base: ManifestBase;
    readonly workspaceId: string;
}
interface ManifestProvider {
    readonly id: string;
    readonly version?: string;
    readonly runId: string;
    readonly finalPassId: string;
}
interface RunHistoryEntry {
    readonly preparedTreeSha: string;
    readonly evaluatedInPassId: string;
}
interface ManifestArtifact {
    readonly path: string;
    readonly sha256: string;
    readonly role: string;
}
/**
 * An artifact entry that survived the shape rules, carrying the index it was
 * declared at so a payload rule can point back at the entry rather than at the
 * pool.
 */
interface DeclaredArtifact extends ManifestArtifact {
    readonly index: number;
}
interface ManifestAttestation {
    readonly level: string;
    readonly signatures: readonly unknown[];
}
interface ManifestClaim {
    readonly obligation: string;
    readonly payloadSpec: string;
    readonly payload: Record<string, unknown>;
}
/** A manifest that passed §8 and §9.3 in full. */
interface DeliveryEvidenceManifest {
    readonly spec: string;
    readonly provider: ManifestProvider;
    readonly candidate: ManifestCandidate;
    readonly repository?: string | null;
    readonly runHistory: readonly RunHistoryEntry[];
    readonly artifacts: readonly ManifestArtifact[];
    readonly attestation: ManifestAttestation;
    readonly recordedAt: string;
    readonly claims: readonly ManifestClaim[];
}
interface ManifestValidationContext {
    readonly checkBindings?: Readonly<Record<string, CheckBinding>>;
    /** Repository gate configuration: accepted specs, identity versions, obligations, providers. */
    readonly config: HarnessConfig;
    /**
     * What candidate capture reports at submission time (SUB-1). A value, not a
     * repository: whoever captured it owns the git work, and this module compares.
     */
    readonly currentCandidate: unknown;
    /** Whether the workspace is in a prepared state at submission time (SUB-2). */
    readonly prepared: boolean;
    /**
     * Artifact file contents, keyed by the path the manifest declares. RG-4 reads
     * approval stamps from here. An entry absent from this map is an artifact the
     * caller could not produce bytes for, which no rule may treat as satisfied.
     */
    readonly artifactContents: ReadonlyMap<string, string>;
}
declare function validateManifest(submitted: unknown, context: ManifestValidationContext): ManifestValidation<DeliveryEvidenceManifest>;

interface Collector {
    /** Reports one violated rule. Never throws, never short-circuits. */
    emit(code: ManifestRejectionCode, rule: ManifestRuleId, pointer: string, message: string): void;
    /** Everything reported so far, in emission order. */
    list(): readonly ManifestRejection[];
}

/**
 * The normative `review.green/1` payload validator (spec §9) and its version-2
 * deferral extension.
 *
 * The payload is a claim that an independent, complete code review of the final
 * candidate concluded green. The rules here never ask *how* the review was
 * conducted — reviewer selection, models and prompts belong to the provider
 * (§3, principle 5). They ask whether what is claimed is internally coherent and
 * bound to the candidate:
 *
 *   SELF-CONSISTENCY IS CHECKED, NOT TRUSTED (§3, principle 6). Every telemetry
 *   number the payload states is derivable from its own findings, so it is
 *   re-derived and compared rather than read. A count that contradicts the
 *   findings it counts is a rejection, not a display quirk.
 *
 *   APPROVALS RE-STATE THE BINDING (§9.2). Each selected reviewer is covered by
 *   exactly one approval stamp that repeats the provider triple, the workspace,
 *   and the whole candidate — so each stamp is independently interpretable in an
 *   audit, and a stamp from another run or another tree cannot be reused here.
 *
 *   GREEN IS AN ABSENCE OF OPEN WORK. A blocking finding, an actionable finding
 *   left unresolved or ignored, a deferral that skips the tracker or defers what
 *   may never be deferred — each contradicts the verdict, and RG-6 and RG-7 make
 *   the contradiction mechanical rather than editorial.
 *
 * PURITY. Approval stamps arrive as bytes the caller already read; this module
 * parses strings and touches no filesystem.
 */

declare const FINDING_SEVERITIES: readonly string[];
declare const FINDING_SCOPES: readonly string[];
declare const FINDING_DISPOSITIONS: readonly string[];
/** The artifact role §9.2 defines. */
declare const REVIEWER_APPROVAL_ROLE = "reviewer-approval";
interface ReviewGreenClaimInput {
    readonly payload: Record<string, unknown>;
    /** Pointer to the payload inside the manifest. */
    readonly at: string;
    /** The envelope's provider triple, as submitted. Approval stamps must repeat it. */
    readonly provider: {
        readonly id: unknown;
        readonly runId: unknown;
        readonly finalPassId: unknown;
    };
    /** The envelope's candidate, as submitted. Approval stamps must repeat it. */
    readonly candidate: unknown;
    readonly artifacts: readonly DeclaredArtifact[];
    readonly artifactContents: ReadonlyMap<string, string>;
    readonly runHistoryLength: number;
}
declare function validateReviewGreenClaim(input: ReviewGreenClaimInput, collector: Collector): void;

/**
 * What a candidate *is*, and every decision that can be made about one without
 * touching a repository.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `candidate.ts`. Capturing a candidate
 * means running git, and git means `node:child_process`. The gate evaluator and
 * the execution-context classifier are forbidden from importing that family at
 * all — not indirectly either — yet both need to know what a candidate looks
 * like and whether a projection activates an obligation. So the split is not
 * cosmetic: the shapes *and the decisions over them* live here, where a pure
 * consumer can reach them, and only the git work lives next door.
 *
 * That is why this file carries functions and not merely `interface`
 * declarations. Classification, projection, activation, and drift are all total
 * functions of values that have already been observed. Putting any of them in
 * `candidate.ts` would force a pure module to import a process-spawning module
 * to answer a question that involves no process at all — or, worse, to grow its
 * own second copy of the rule.
 *
 * WHAT IS DELIBERATELY NOT NORMALIZED. Repository paths arrive from git exactly
 * as git recorded them, and a backslash in one is a literal character in a file
 * name, not a separator to be rewritten. Rewriting it here would make
 * `docs\reports\x.html` classify as though it were `docs/reports/x.html`, which
 * is a different path — the config loader rejects backslashes in matchers for
 * the same reason rather than quietly translating them.
 */

/** Only git is supported; the manifest envelope pins the same constant. */
declare const CANDIDATE_VCS: "git";
type CandidateVcs = typeof CANDIDATE_VCS;
/**
 * `clean` — the worktree matches HEAD and the reviewable tree is HEAD's tree.
 * `staged-index` — the author staged the change; the reviewable tree is the
 * tree the index defines. There is no third mode: an unstaged edit is not a
 * candidate, it is an unprepared workspace.
 */
declare const CANDIDATE_MODES: readonly ["clean", "staged-index"];
type CandidateMode = (typeof CANDIDATE_MODES)[number];
interface CandidateDeliverable {
    /** The deliverable-tree digest, from the injected identity computer. */
    readonly digest: string;
    /** The token naming the function that produced `digest`. */
    readonly identity: string;
}
interface CandidateBase {
    readonly ref: string;
    readonly tipSha: string;
    readonly mergeBaseSha: string;
}
/**
 * The fields evidence binds to. Kept as its own shape because the recorder
 * compares a re-captured candidate against a manifest's binding, and that
 * comparison must be over an enumerated field set rather than over whatever a
 * capture happens to carry.
 */
interface CandidateBinding {
    readonly treeSha: string;
    readonly deliverable: CandidateDeliverable;
    readonly base: CandidateBase;
    readonly workspaceId: string;
}
/** One `git status` entry: the two-character code, and the path it concerns. */
interface CandidateStatusEntry {
    readonly code: string;
    readonly path: string;
}
interface CapturedCandidate extends CandidateBinding {
    readonly vcs: CandidateVcs;
    readonly headSha: string;
    readonly mode: CandidateMode;
    /**
     * The observed status, retained for diagnostics. In `clean` mode it is empty
     * by construction; in `staged-index` mode it describes what was staged.
     */
    readonly statusEntries: readonly CandidateStatusEntry[];
    /**
     * Always empty on a successful capture — an untracked file is an unprepared
     * workspace. The member exists so the value can say so rather than leaving a
     * reader to infer it from an absence.
     */
    readonly untrackedFiles: readonly string[];
}
/**
 * Why a capture produced no candidate. Each code names one situation, because
 * the operator's next action differs for every one of them: stage the work,
 * finish the merge, fetch the base, re-run, or look at the repository itself.
 *
 * The three `candidate_base_*` codes are the fail-closed set. A base that
 * cannot be resolved must never degrade into "nothing changed" — an empty
 * changed set is a legitimate answer (a candidate whose tip equals its base)
 * and reporting an unresolvable base as one would admit an unreviewed change
 * through the activation threshold. They are three rather than one because
 * their remedies are unrelated: fetch the ref, deepen the clone, or reconcile
 * two histories that genuinely have nothing in common.
 */
declare const CANDIDATE_CAPTURE_CODES: readonly ["candidate_unprepared", "candidate_merge_in_progress", "candidate_ambiguous", "candidate_base_missing", "candidate_base_shallow", "candidate_base_unrelated", "candidate_repository_unreadable"];
type CandidateCaptureCode = (typeof CANDIDATE_CAPTURE_CODES)[number];
/**
 * Not a capture code: it is emitted after a candidate has been captured, when
 * the diff that the projection reads cannot be produced. It shares the
 * fail-closed reasoning — an unreadable diff must never present itself as a
 * diff containing nothing.
 */
declare const CANDIDATE_DIFF_UNREADABLE: "candidate_diff_unreadable";
type CandidateCapture = {
    readonly ok: true;
    readonly candidate: CapturedCandidate;
} | {
    readonly ok: false;
    readonly code: CandidateCaptureCode;
    readonly blockers: NonEmptyTuple<Blocker>;
};
interface DeliverableIdentityRequest {
    readonly rootDir: string;
    /** The tree the candidate is defined by — HEAD's tree, or the index's. */
    readonly treeSha: string;
    readonly config: HarnessConfig;
}
/**
 * The identity port: the deliverable digest for a tree.
 *
 * It returns the digest alone. The token that *names* the function is a config
 * member, and capture stamps it from the config it was handed, so a port and a
 * config cannot disagree about what a digest is called — there is only one
 * reader of the token.
 */
type ComputeIdentity = (request: DeliverableIdentityRequest) => Promise<string>;
/**
 * The whole-candidate port. The recorder re-captures through this rather than
 * calling into git itself, which is what lets a conformance run drive the
 * submission path from declared candidate values with no repository at all.
 */
type CaptureCandidate = () => Promise<CandidateCapture>;
/**
 * How a candidate can have moved between two observations.
 *
 * The five classes are disjoint statements about *what* moved, not a severity
 * ordering, and a single comparison can report several at once — a rebase moves
 * the raw tree, the merge base, and the deliverable identity together, and
 * collapsing that into one class would lose the part that explains it.
 *
 * Deliberately not a class: a differing base *ref*, identity *token*, or `vcs`.
 * Those are configuration disagreements rather than movement in the repository,
 * and naming them as drift would tell an operator to re-prepare when the actual
 * fix is to reconcile a config with the evidence recorded under a different one.
 */
declare const CANDIDATE_DRIFT_CLASSES: readonly ["deliverable_identity_changed", "raw_tree_changed", "base_tip_moved", "merge_base_moved", "workspace_changed"];
type CandidateDriftClass = (typeof CANDIDATE_DRIFT_CLASSES)[number];
/**
 * Every class in which `observed` differs from `expected`, in taxonomy order.
 * An empty result means the two bindings describe the same candidate.
 */
declare function classifyCandidateDrift(expected: CandidateBinding, observed: CandidateBinding): readonly CandidateDriftClass[];
/**
 * `relevant` is the residue: a path is reviewable unless the config says what
 * else it is. That direction matters. The opposite arrangement — an explicit
 * list of reviewable paths — would make every unclassified new directory
 * invisible to the activation threshold, so forgetting to update a config would
 * quietly widen what can merge unreviewed.
 */
declare const CANDIDATE_PATH_CLASSES: readonly ["relevant", "test", "generated", "lockfile"];
type CandidatePathClass = (typeof CANDIDATE_PATH_CLASSES)[number];
/**
 * A prefix matcher covers the path it names and everything beneath it, and a
 * trailing slash is optional in the config — `packages/kernel` and
 * `packages/kernel/` name the same subtree. What it must not do is match on a
 * bare string prefix: `packages/kernel` would then cover
 * `packages/kernel-tools/`, which is a different package.
 */
declare function matchesPathMatcher(matcher: PathMatcher, repoPath: string): boolean;
/**
 * Order is policy, not convenience. A lock file inside a generated directory is
 * still a lock file, and a generated file whose name ends in `.test.ts` is
 * still generated — the more specific classification wins so that a config
 * cannot be made to contradict itself by adding a matcher elsewhere.
 */
declare function classifyCandidatePath(classification: PathClassification, repoPath: string): CandidatePathClass;
/** The ids of every sensitive group this path falls inside, in config order. */
declare function sensitiveGroupsFor(groups: readonly SensitivePathGroup[], repoPath: string): readonly string[];
/**
 * One entry of the diff between the candidate's base and its tree. `additions`
 * and `deletions` are `null` exactly when git could not count lines, which is
 * what `binary` records.
 */
interface CandidateDiffEntry {
    readonly path: string;
    /** Present when the entry is a rename or a copy. */
    readonly oldPath?: string;
    readonly additions: number | null;
    readonly deletions: number | null;
    readonly binary: boolean;
}
interface ReviewActivationProjection {
    /** Changed lines on reviewable paths. Test, generated and lock files do not count. */
    readonly relevantLineCount: number;
    readonly relevantPaths: readonly string[];
    readonly excludedPaths: readonly string[];
    readonly binaryPaths: readonly string[];
    readonly sensitivePathIds: readonly string[];
    readonly hasRelevantBinaryChange: boolean;
    /**
     * Whether a reviewable path changed in a way that adds and removes no lines
     * at all: a permission bit flipped to executable, a file moved with its
     * contents intact. Recorded for the same reason as a binary change — the
     * count is zero because lines are the wrong unit for this change, not because
     * nothing happened, and `chmod +x` on a script is not a change a line
     * threshold should be allowed to wave through.
     */
    readonly hasRelevantZeroLineChange: boolean;
    /**
     * How many entries the diff carried at all. Zero is the legitimate
     * empty-diff case — a candidate whose tree already matches its base — and is
     * distinguishable here from a base that could not be resolved, which never
     * produces a projection because capture blocks first.
     */
    readonly changedEntryCount: number;
}
/**
 * SENSITIVE GROUPS ARE COLLECTED BEFORE THE RELEVANCE CHECK, deliberately. A
 * path can be both sensitive and excluded — a generated client for an
 * authentication API, a test fixture holding a signing key — and in that case
 * the sensitive group still names it and the obligation still activates. The
 * exclusion says "these lines are not worth counting", which is a statement
 * about volume; a sensitive group says "changes here are reviewed regardless",
 * which is a statement about risk. Letting the first silence the second would
 * make a config's own classification into a way around its own policy.
 */
declare function projectReviewActivation(entries: readonly CandidateDiffEntry[], config: HarnessConfig): ReviewActivationProjection;
/**
 * Whether an obligation applies to the candidate this projection describes.
 *
 * An `always` obligation ignores the projection entirely. A `relevant_change`
 * obligation activates on any of four independent signals: enough reviewable
 * lines, a reviewable binary change, a reviewable change that counts no lines,
 * or a touched sensitive path. They are independent on purpose — a one-line
 * change to an authentication path is exactly the change a line threshold would
 * wave through.
 *
 * THREE OF THE SIGNALS CAN BE NARROWED PER OBLIGATION, and absence of each
 * narrowing member is the widened, fail-closed reading:
 *
 *   - `sensitiveGroupIds` binds the sensitive signal to named groups. Absent,
 *     every declared group activates every `relevant_change` obligation; an
 *     empty binding opts the obligation out of the signal entirely. The loader
 *     has already rejected an id no `sensitivePaths` group declares, so a
 *     binding here never references a group that does not exist.
 *   - `relevantBinaryChangeActivates: false` opts out of the binary signal.
 *   - `relevantZeroLineChangeActivates: false` opts out of the zero-line one.
 *     The two flags are separate because the signals are independent: a
 *     security review is indifferent to a `chmod` and alert to a replaced
 *     binary, a licence obligation the reverse.
 *
 * The line threshold has no per-obligation narrowing, and none of the members
 * narrows an `always` obligation, which ignores the projection entirely.
 */
declare function isObligationActive(activation: ObligationActivation, projection: ReviewActivationProjection, activationThreshold: number): boolean;

/**
 * How many times a bracket may be retried before the repository is declared
 * ambiguous. Three is a bound, not a budget: it distinguishes a workspace that
 * settles — a save, a formatter, an editor writing a swap file — from one that
 * is being written to continuously, and no number of retries makes the second
 * case safe to capture.
 */
declare const DEFAULT_CAPTURE_ATTEMPTS = 3;
interface CandidateCommandResult {
    /** `-1` when the command could not be started at all. */
    readonly exitCode: number;
    readonly stdout: string;
    readonly stdoutBase64?: string;
    readonly stderr: string;
}
type CandidateCommandRunner = (command: readonly string[], options: {
    readonly cwd: string;
    readonly captureBytes?: boolean;
}) => Promise<CandidateCommandResult>;
declare const runGitCommand: CandidateCommandRunner;
declare function parseCandidateNumstat(output: string): CandidateDiffEntry[];
interface CandidateCaptureOptions {
    readonly rootDir: string;
    readonly config: HarnessConfig;
    /**
     * The identity of the workspace this capture belongs to, supplied by the
     * evidence store that owns it. It is carried rather than derived here so a
     * candidate can be compared for workspace drift without this module needing
     * to know how a workspace is named.
     */
    readonly workspaceId: string;
    readonly computeIdentity: ComputeIdentity;
    readonly run?: CandidateCommandRunner;
    readonly maxAttempts?: number;
}
/**
 * Observes the repository twice, and again if the two readings disagree.
 *
 * The identity computation runs *after* the bracket closes rather than inside
 * it. It is a pure function of a tree that is now known to be stable, so
 * including it would only widen the window in which something can move.
 */
declare function captureGitCandidate(options: CandidateCaptureOptions): Promise<CandidateCapture>;
/**
 * Binds a capture to its inputs. The recorder holds one of these rather than
 * the repository details, which is what lets a conformance run substitute
 * declared candidate values for a repository that does not exist.
 */
declare function createCandidateCapture(options: CandidateCaptureOptions): CaptureCandidate;
interface CandidateActivationOptions {
    readonly rootDir: string;
    readonly candidate: CapturedCandidate;
    readonly config: HarnessConfig;
    readonly run?: CandidateCommandRunner;
}
/**
 * The diff between the candidate's merge base and the tree it is defined by.
 *
 * A failure here throws rather than returning an empty projection, for the same
 * reason an unresolvable base blocks the capture: an unreadable diff and a diff
 * with nothing in it lead to opposite decisions about whether the change needs
 * review.
 */
declare function evaluateCandidateActivation(options: CandidateActivationOptions): Promise<ReviewActivationProjection>;

/**
 * The domain separator the digest opens with. It is a constant of the function
 * rather than of any one token: `identity\0<token>\0` says both what kind of
 * thing this hash is and which version of it, so a digest can never be confused
 * with some other sha256 over the same entries.
 */
declare const IDENTITY_DOMAIN = "identity";
/**
 * This module's own failure vocabulary. Neither code is a gate finding — the
 * gate's structural codes describe evidence, and these describe a repository
 * that could not be read at all — so neither belongs in the config's
 * waivable/non-waivable partition, exactly as the record store's codes do not.
 */
declare const IDENTITY_FINDING_CODES: readonly ["deliverable_tree_unreadable", "deliverable_tree_unparsable"];
type IdentityFindingCode = (typeof IDENTITY_FINDING_CODES)[number];
/**
 * One record of a recursive tree listing, reduced to the three fields the
 * digest reads.
 *
 * The type column git prints between the mode and the object is deliberately
 * absent: it is derivable from the mode and carries no information the identity
 * needs, and hashing both would make a listing format change into an identity
 * change.
 */
interface DeliverableTreeEntry {
    readonly mode: string;
    readonly objectSha: string;
    readonly path: string;
}
/**
 * The pair the digest is a function of.
 *
 * These travel together rather than as a config because that is the honest
 * signature: change either one and the digest changes. A `HarnessConfig`
 * parameter would suggest the other twenty members mattered, and would make the
 * token/neutral-set relationship impossible to state — or to test — on its own.
 * The config's biconditional invariant is what stops one token from ever naming
 * two different pairs; this signature is what makes that invariant meaningful.
 */
interface DeliverableIdentityDefinition {
    readonly identityToken: string;
    readonly reviewNeutral: readonly NeutralMatcher[];
}
interface DeliverableIdentityOptions {
    /** Injected only by tests that need a git invocation to fail on demand. */
    readonly run?: CandidateCommandRunner;
}
/** The two members of a config that decide what a digest is. */
declare function identityDefinitionOf(config: HarnessConfig): DeliverableIdentityDefinition;
/**
 * Whether a path is outside the reviewed deliverable — narration written after
 * the work, which a reviewer was never asked about.
 *
 * This is the only predicate that removes an entry from the digest below.
 */
declare function isReviewNeutralPath(config: HarnessConfig, repoPath: string): boolean;
/**
 * Whether a path may be written *after* a merge-grade gate without invalidating
 * the proof that gate produced.
 *
 * Deliberately narrower than review neutrality, and deliberately separate from
 * it. A report still needs its own validation even though a reviewer never
 * approved it; the delivery record describes the gate that has just finished
 * and is checked by the verification it belongs to. Collapsing the two would
 * either let a report through a gate it should face, or make the record's own
 * write invalidate the record. Nothing in this file's digest reads it.
 */
declare function isRecordNeutralPath(config: HarnessConfig, repoPath: string): boolean;
/**
 * A malformed record blocks rather than being skipped.
 *
 * Dropping one would produce a digest that is confidently wrong: a shorter
 * deliverable that hashes cleanly and matches nothing, with no signal that
 * anything was lost. A tree listing this module cannot read is a repository
 * question, and the honest answer is to say so.
 */
declare function parseTreeEntries(output: string, config: HarnessConfig): DeliverableTreeEntry[];
/**
 * The deliverable digest for a set of tree entries.
 *
 * Every field is NUL-separated and every record is NUL-terminated, so no
 * concatenation of a mode, an object and a path can be re-read as a different
 * triple — a path ending where another begins cannot forge a record.
 */
declare function digestDeliverableEntries(entries: readonly DeliverableTreeEntry[], definition: DeliverableIdentityDefinition): string;
/**
 * `--full-tree` so the answer does not depend on the directory the command was
 * run from, and `-r` so it is a flat list of blobs and gitlinks rather than a
 * walk this module would have to repeat.
 *
 * The listing is decoded as UTF-8, which is what Athena's implementation did.
 * A path whose bytes are not valid UTF-8 therefore digests the same lossy way
 * in both — a fidelity property, not a correctness one, and the reason it is
 * written down here rather than quietly improved.
 */
declare function computeDeliverableIdentity(request: DeliverableIdentityRequest, options?: DeliverableIdentityOptions): Promise<string>;
/**
 * The identity port candidate capture injects.
 *
 * It returns the digest alone. The token that names it is a config member, and
 * capture stamps it from the config it was handed, so a port and a config
 * cannot disagree about what a digest is called.
 */
declare function withDeliverableIdentity(options?: DeliverableIdentityOptions): ComputeIdentity;

/**
 * Stored on every receipt so a reader can refuse a shape it does not
 * understand rather than guess at one. An unrecognised version is `invalid`,
 * not `stale`: the receipt is not a receipt this harness can read at all, and
 * saying "your candidate moved" about it would send an operator to look at
 * their branch.
 */
declare const PREPARATION_RECEIPT_SCHEMA_VERSION = 1;
/** The leaf this module owns, beside the record store's under one root. */
declare const PREPARATION_RECEIPT_LEAF = "preparation";
/**
 * The harness's own version, as a fingerprint input.
 *
 * Declared here rather than read from a package manifest at run time. An
 * installed package's manifest is not reliably reachable from the module that
 * would want it, and reading one at import time is exactly the ambient-file
 * dependency the import boundary exists to keep out. The cost is that this
 * constant can drift from the manifest, so a test asserts the two agree — the
 * drift is caught mechanically instead of being trusted.
 *
 * THE RELEASE WORKFLOW MUST BUMP THIS IN LOCKSTEP WITH
 * `packages/kernel/package.json`. Publishing a version whose fingerprint input
 * still names the previous one would let a receipt survive the upgrade it is
 * supposed to be invalidated by; the manifest-equality test is what makes the
 * omission a red run rather than a silent one.
 */
declare const HARNESS_VERSION = "0.2.0";
/**
 * The five ways a receipt can fail to authorise the candidate in front of it,
 * in the order they are decided. The order is the contract, not an
 * implementation detail:
 *
 *   `missing`         — nothing to read. Every later question is unanswerable.
 *   `invalid`         — something is there and it is not a receipt this
 *                       harness wrote. Comparing its fields would be comparing
 *                       against arbitrary content.
 *   `wiring_mismatch` — the gate itself changed. The receipt was published by a
 *                       different harness or against different wiring, so what
 *                       it attests to is not what would be attested now.
 *   `base_changed`    — the base moved under the candidate. Reported ahead of
 *                       `stale` because the operator's action differs: the work
 *                       did not move, the ground under it did.
 *   `stale`           — the candidate moved.
 *
 * Each class is decided only once every earlier class has been ruled out, which
 * is what makes the ordering observable: a tree in two of these states reports
 * the earlier one, and the tests pin that pair by pair.
 */
declare const PREPARATION_FAILURE_CLASSES: readonly ["missing", "invalid", "wiring_mismatch", "base_changed", "stale"];
type PreparationFailureClass = (typeof PREPARATION_FAILURE_CLASSES)[number];
/**
 * What preparation needs to know about a candidate: the binding evidence will
 * carry, plus the two fields that are not part of it.
 *
 * `headSha` is compared because a head move with an identical tree is still a
 * different candidate to have prepared — the same decision the recorder makes
 * at submission. `mode` is compared because a receipt published for a staged
 * index does not authorise the same tree reached from a clean worktree; the
 * trees are equal and the claims about them are not.
 *
 * A `CapturedCandidate` satisfies this structurally, so capture's own output
 * can be handed straight in.
 */
type PreparationCandidate = CandidateBinding & {
    readonly headSha: string;
    readonly mode: CandidateMode;
};
/**
 * The stored receipt. Flat, mirroring the record store's binding spelling
 * rather than the capture's nested one, so the two stored forms under one root
 * read the same way.
 *
 * `workspaceId` is the store the receipt belongs to; `candidateWorkspaceId` is
 * the workspace the candidate was captured in. They are normally equal, and the
 * redundancy is the same one the record store keeps for the same reason: making
 * them one field would turn a candidate that moved workspaces into a candidate
 * that did not.
 */
interface PreparationReceipt {
    readonly schemaVersion: number;
    readonly gateId: string;
    readonly workspaceId: string;
    readonly treeSha: string;
    readonly headSha: string;
    readonly mode: CandidateMode;
    readonly deliverableDigest: string;
    readonly identityToken: string;
    readonly baseRef: string;
    readonly baseTipSha: string;
    readonly mergeBaseSha: string;
    readonly candidateWorkspaceId: string;
    readonly preparationFingerprint: string;
    /** Present on command-driven receipts; identifies the latest preparation attempt. */
    readonly attemptId?: string;
    /** CLI mechanical success binding; absent on legacy receipts. */
    readonly validationDigest?: string;
    readonly policyDigest?: string;
}
interface PreparationOptions extends RecordStorageOptions {
    /** Only prepare may refresh a receipt after strict validation-equivalent movement. */
    readonly allowValidationEquivalent?: boolean;
    /** Portable verification reads declared wiring from the verified candidate tree. */
    readonly readWiring?: (repoPath: string) => Promise<Uint8Array>;
    /** Overrides the declared harness version. Tests use it; callers do not. */
    readonly harnessVersion?: string;
}
interface PreparationInput {
    /** Supplied by CLI prepare after successful mechanics or proven receipt reuse. */
    readonly validationDigest?: string;
    readonly config: HarnessConfig;
    readonly candidate: PreparationCandidate;
    readonly attemptId?: string;
}
interface PublishedPreparationReceipt {
    readonly path: string;
    readonly receipt: PreparationReceipt;
    readonly workspaceId: string;
}
type PreparationEvaluation = {
    readonly prepared: true;
    readonly receipt: PreparationReceipt;
    readonly receiptPath: string;
    readonly workspaceId: string;
} | {
    readonly prepared: false;
    readonly failure: PreparationFailureClass;
    readonly reason: string;
    readonly receiptPath: string;
    readonly workspaceId: string;
    readonly blockers: NonEmptyTuple<Blocker>;
};
/**
 * One receipt per gate, named after it. The gate id is already part of the
 * record store's filename grammar and is validated at config load, so no
 * additional escaping is introduced here; a gate whose id would not make a
 * filename is a config the loader rejects.
 */
declare function receiptFileName(gateId: string): string;
/**
 * The record store's resolver, with this module's leaf.
 *
 * Everything that makes the store worktree-private — the `--git-path`
 * resolution, the containment check that refuses a namespace git would root in
 * the common directory, the physical-path normalisation the workspace id
 * depends on — is inherited rather than restated. There is deliberately no
 * second copy of that reasoning: a receipt that resolved its own directory
 * could disagree with the store about which worktree it is in, and the
 * disagreement would surface as evidence that looked fresh.
 */
declare function resolveReceiptStorage(rootDir: string, options?: PreparationOptions): Promise<WorkspaceStorage>;
/**
 * The digest of the harness version and the declared wiring bytes.
 *
 * SORTED AND DEDUPLICATED. The fingerprint is a statement about a *set* of
 * files, so two configs that declare the same paths in a different order — or
 * that name one twice — describe the same wiring and must agree. Order
 * sensitivity would make a cosmetic config edit read as a wiring change, which
 * is a real answer given for a non-reason.
 *
 * HASHED THROUGH THE CANONICALIZER, not through ad-hoc framing. Each path
 * contributes its own name and its own content digest, and the pairs are
 * digested as a canonical-JSON object. Framing raw file bytes with a NUL
 * separator instead is not injective: `path1\0abc\0path2\0def` reads two ways
 * the moment a wiring file contains a NUL of its own, so two different wirings
 * could produce one fingerprint. Pairing each digest with its declared path
 * also keeps two identical files distinguishable — moving a gate's wiring
 * between declared paths is a wiring change.
 *
 * NO VERSION MEMBER RIDES IN THE INPUT. A receipt this harness cannot read is
 * rejected at the `invalid` step, which is decided before any fingerprint is
 * compared, so a schema version inside the digest would be a second copy of a
 * check that has already run — with bump semantics nothing would define.
 *
 * A path that cannot be read as a file throws. See the module note — a hashed
 * absence would make deletion a stable input.
 */
declare function computePreparationFingerprint(rootDir: string, config: HarnessConfig, options?: PreparationOptions): Promise<string>;
/**
 * Replace the current attempt token before removing the previous receipt.
 * Publication and evaluation both check this token: an older command still
 * running cannot restore authority after a newer attempt starts or fails.
 */
declare function invalidatePreparationReceipt(rootDir: string, config: HarnessConfig, options?: PreparationOptions): Promise<string>;
/**
 * Revoke unsuccessful preparation without replacing a newer attempt. Open the existing
 * token before checking its value, then mutate that same inode: if ordinary
 * preparation replaces the pathname meanwhile, its new token is untouched.
 * The receipt remains on disk but cannot authorize against a revoked token.
 */
declare function revokePreparationAttempt(rootDir: string, config: HarnessConfig, attemptId: string, options?: PreparationOptions): Promise<void>;
/**
 * Publishes the current receipt, replacing whatever was there.
 *
 * The caller invalidates the previous receipt before starting checks. This
 * publication computes the fingerprint before writing, so unreadable wiring
 * cannot produce a new receipt.
 *
 * Write-temp-then-rename, not write-in-place: a reader that opened the receipt
 * while a second preparation was mid-write would otherwise see a truncated file
 * and call it `invalid`, which is a real class being reported for a race.
 */
declare function publishPreparationReceipt(rootDir: string, input: PreparationInput, options?: PreparationOptions): Promise<PublishedPreparationReceipt>;
/**
 * Decides the five classes, in the declared order, stopping at the first that
 * holds.
 *
 * The order is not a series of early returns that happen to be arranged this
 * way — each step is unanswerable until the one before it has passed. There is
 * nothing to parse until there is a file; nothing to compare until the parse
 * succeeded; and comparing candidate coordinates against a receipt published
 * under different wiring answers a question nobody asked, because the wiring
 * that produced those coordinates is not the wiring in front of us.
 *
 * Two comparisons deliberately do not use the drift classifier: `baseRef` and
 * `identityToken` are configuration disagreements rather than movement — the
 * classifier says so itself — but a receipt published against a different base
 * ref or a different identity function does not authorise this candidate
 * either. The ref lands in `base_changed` and the token in `stale`, next to the
 * digest it names the meaning of.
 */
declare function evaluatePreparationReceipt(rootDir: string, input: PreparationInput, options?: PreparationOptions): Promise<PreparationEvaluation>;

/**
 * Who is running the gate, and what that entitles them to.
 *
 * THE LADDER IS ASYMMETRIC ON PURPOSE. Four rungs, in strictly descending
 * order of what they may do:
 *
 *   ci     — repository-authorized automation. May carry a delegated
 *            obligation, because a declared policy says which job answers for
 *            it and the environment corroborates that the job is the one
 *            running. It may not waive: nobody is present to accept anything.
 *   agent  — a recognized coding agent. May satisfy an obligation with
 *            evidence, and may never waive one. An agent that could waive
 *            could waive its own review.
 *   human  — an interactive person, both streams on a terminal. The only rung
 *            the waiver door opens for, and only for the codes the config
 *            classifies as waivable.
 *   unknown— everything else. Satisfies nothing on its own.
 *
 * THE ENVIRONMENT IS A PARAMETER. This module never touches `process`. The
 * caller hands over a snapshot, which is what lets the whole gate be exercised
 * as a decision table and keeps the module inside the purity sensor's d1 class.
 *
 * A PARTIAL CI MATCH IS AN UNAUTHORIZED AUTOMATION, NEVER A DOWNGRADE. This is
 * the rule with the most ways to get subtly wrong, so it is stated once and
 * applied in every direction: if anything in the environment claims to be a
 * declared automation — the policy env key naming a policy, or any declared
 * policy's corroborating variable already standing at its declared value — then
 * the run must match one declared policy *completely* or it is
 * `unauthorized_automation`. It does not fall back to "an ordinary shell", and
 * a terminal does not rescue it. The failure mode being closed off is the one
 * where an automation with a half-configured environment quietly acquires the
 * rights of whichever rung it happens to land on next.
 *
 * A PTY NEVER PROMOTES AN AGENT. Agents attach terminals; the interactive check
 * runs strictly after the agent check, so no arrangement of streams turns a
 * recognized agent into a person.
 *
 * CI POLICY IS CONFIGURED. Athena's classifier hardcoded one workflow, one
 * job, one event name and one policy id. Every one of those is config data
 * here, and the returned CI context carries the matched policy's own values, so
 * a caller reads what authorized this run rather than what this module was
 * written believing. Supported coding-host signals form a non-configurable
 * denial floor for interactive human classification.
 */

/** The four rungs. Ordered as the ladder is ordered. */
declare const EXECUTION_CONTEXT_KINDS: readonly ["ci", "agent", "human", "unknown"];
type ExecutionContextKind = (typeof EXECUTION_CONTEXT_KINDS)[number];
/**
 * Why a run is anonymous. The two are kept apart because they mean opposite
 * things to an operator: one is an automation that failed to prove itself and
 * should be repaired, the other is an ordinary non-interactive shell and is
 * nobody's defect.
 */
declare const UNKNOWN_CONTEXT_REASONS: readonly ["unauthorized_automation", "noninteractive_unrecognized"];
type UnknownContextReason = (typeof UNKNOWN_CONTEXT_REASONS)[number];
interface CiExecutionContext {
    readonly kind: "ci";
    /** The id of the policy that matched — the config's value, not a literal. */
    readonly policyId: string;
    /** The corroboration that matched, carried so a caller can show its work. */
    readonly requiredEnv: readonly EnvironmentRequirement[];
}
interface AgentExecutionContext {
    readonly kind: "agent";
    /** The declared signal that identified the agent, as the config named it. */
    readonly signal: string;
}
interface HumanExecutionContext {
    readonly kind: "human";
    /** Always true: a non-interactive human is indistinguishable from a script. */
    readonly interactive: true;
}
interface UnknownExecutionContext {
    readonly kind: "unknown";
    readonly reason: UnknownContextReason;
}
type ExecutionContext = CiExecutionContext | AgentExecutionContext | HumanExecutionContext | UnknownExecutionContext;
/** A read-only view of the environment, handed in rather than reached for. */
type EnvSnapshot = Readonly<Record<string, string | undefined>>;
interface ClassifyExecutionContextInput {
    readonly config: HarnessConfig;
    readonly env: EnvSnapshot;
    readonly stdinIsTTY: boolean;
    readonly stdoutIsTTY: boolean;
}
/**
 * Whether a declared signal variable is *asserting* something.
 *
 * The four denied spellings are the ones a shell produces when something is
 * switched off rather than absent — an unset variable, an empty one, and the
 * two falsey words CI systems write. Treating `AGENT=false` as "an agent is
 * present" would let a switched-off signal confer a rung.
 *
 * The type check is not redundant with the type. A snapshot is an ordinary
 * object, so a lookup of `__proto__`, `constructor` or `toString` answers with
 * something inherited rather than with `undefined` — and every one of those is
 * a legal environment-variable name a config may declare as a signal. Without
 * the check, an environment that sets nothing at all would confer the agent
 * rung, which is the rung that can never be waived out of.
 */
declare function isEnvSignalPresent(value: string | undefined): boolean;
declare function classifyExecutionContext({ config, env, stdinIsTTY, stdoutIsTTY }: ClassifyExecutionContextInput): ExecutionContext;

/**
 * The five kinds a config may permit, plus the one it cannot. Kept in this
 * order so the coherence check against `RESOLUTION_KINDS` reads as an equality
 * rather than as a set comparison.
 */
declare const RESOLUTION_OUTCOMES: readonly ["satisfied_live_fact", "satisfied_evidence", "waived", "delegated", "not_applicable", "blocked"];
type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];
/**
 * A provider's own account of what it found.
 *
 * Both fields are provider-authored, and the `code` is the one that lands
 * somewhere structural: it becomes a blocker code, which has a grammar, and it
 * is what an obligation's waivable / non-waivable partition is applied to. So
 * it is checked rather than trusted — only a code the *registered* provider
 * declares in its `findingCodes` is carried through as a code. Anything else,
 * including a well-formed code the config never declared and a summary with no
 * text in it, becomes a structural `live_provider_failed` blocker with the
 * reported text kept as detail. See `providerFinding` below for why.
 */
interface LiveProviderFinding {
    readonly code: string;
    readonly summary: string;
    readonly details?: string;
}
/**
 * A result the caller observed and is handing to the pure evaluator. Process
 * invocation belongs to a command boundary, so this remains the evaluator's
 * only road to `satisfied_live_fact`.
 */
interface LiveProviderResult {
    readonly providerId: string;
    readonly runId: string;
    readonly status: "green" | "failed";
    readonly findings: readonly LiveProviderFinding[];
}
/**
 * A file the store refused to serve, attributed to an obligation by the caller.
 *
 * Attribution is the caller's job because it comes from the filename, and a
 * pure evaluator that parsed store filenames would be reimplementing the store.
 * What is *not* the caller's job is deciding whether it matters: an unreadable
 * file inside the evidence store is the store saying it cannot account for its
 * own contents, and that is a gate decision.
 */
interface UnreadableRecordInput {
    readonly gateId: string;
    readonly obligationId: string;
    /** False when the file could not be tied to the candidate under evaluation. */
    readonly appliesToCandidate: boolean;
    readonly quarantined: QuarantinedRecord;
}
/**
 * One thing found wrong, with the typed blocker that says it. The code and the
 * blocker are both carried because callers partition on the code (waivable or
 * not) and render the blocker — and neither is derivable from the other.
 */
interface ObligationFinding {
    readonly code: string;
    readonly obligationId: string;
    readonly providerId?: string;
    readonly recordId?: string;
    readonly blocker: Blocker;
}
interface ResolutionBase {
    readonly gateId: string;
    readonly obligationId: string;
}
interface SatisfiedLiveFactResolution extends ResolutionBase {
    readonly kind: "satisfied_live_fact";
    readonly providerId: string;
    readonly runId: string;
}
interface SatisfiedEvidenceResolution extends ResolutionBase {
    readonly kind: "satisfied_evidence";
    readonly providerId: string;
    readonly recordId: string;
    /** Every provider record supporting an all-provider obligation. */
    readonly supportingRecordIds?: readonly string[];
    readonly runId: string;
    readonly finalPassId: string;
    readonly candidateBinding: RecordCandidateBinding;
}
interface WaivedResolution extends ResolutionBase {
    readonly kind: "waived";
    readonly waiverRecordId: string;
    readonly scope: WaiverScope;
    readonly waiver: WaiverResolution;
    readonly candidateBinding: RecordCandidateBinding;
}
interface DelegatedResolution extends ResolutionBase {
    readonly kind: "delegated";
    readonly ciPolicyId: string;
}
interface NotApplicableResolution extends ResolutionBase {
    readonly kind: "not_applicable";
    /** The projection that failed to activate it, echoed so the answer is auditable. */
    readonly activation: ReviewActivationProjection;
}
/**
 * A blocked resolution carries at least one blocker by construction. A block
 * with nothing to show for it is the failure mode where an operator is stopped
 * and told nothing, so the type makes it unconstructible.
 */
interface BlockedResolution extends ResolutionBase {
    readonly kind: "blocked";
    /** Structured unresolved findings only for providers with opt-in CLI commands. */
    readonly providerFindings?: NonEmptyTuple<ObligationFinding>;
    readonly blockers: NonEmptyTuple<Blocker>;
}
type ObligationResolution = SatisfiedLiveFactResolution | SatisfiedEvidenceResolution | WaivedResolution | DelegatedResolution | NotApplicableResolution | BlockedResolution;
interface EvaluateGateInput {
    readonly checkBindings?: Readonly<Record<string, CheckBinding>>;
    readonly config: HarnessConfig;
    readonly candidate: CandidateBinding;
    readonly projection: ReviewActivationProjection;
    /**
     * Supplied by the admission adapter, which obtains it from `context.ts` —
     * this is a classification the harness computed, never a value that crossed a
     * process boundary. A caller who could forge a `human` context here could
     * already have called `classifyExecutionContext` with a snapshot of their
     * choosing, so this member widens nothing: it is the same trust boundary,
     * named in one place instead of two.
     */
    readonly context: ExecutionContext;
    /** Well-formed records the store served, of both resolution kinds. */
    readonly records: readonly EvidenceRecord[];
    /** Files the store quarantined, attributed to an obligation by the caller. */
    readonly unreadable?: readonly UnreadableRecordInput[];
    readonly liveResults?: readonly LiveProviderResult[];
    /**
     * The ids of the invocation-scoped waivers *this* invocation granted.
     *
     * Records are content-addressed and durable, so an invocation-scoped waiver
     * written during an earlier run is still on disk during this one. Athena
     * distinguished the two with an `invocation:` id prefix, which a
     * content-addressed id cannot carry, so the invocation's own grants are named
     * explicitly instead. Absent means "this invocation granted none", which is
     * the fail-closed reading: an unlisted invocation waiver is inert.
     *
     * SUPPLIER AND TRUST BOUNDARY. The admission adapter's second pass, and only
     * it: these are the ids it minted a moment earlier when it published the
     * waivers a human accepted. Nothing external reaches this member, and a
     * forged entry buys very little — an id here does not create a waiver, it
     * only stops one that is *already stored* from being treated as a leftover.
     * That stored record still has to name this gate and this obligation, still
     * has to pass the same freshness comparison as every other record, and still
     * cannot cover a finding the config classifies non-waivable. The one thing an
     * attacker gains is the ability to re-use a waiver they already held for this
     * exact candidate — which is precisely what a `durable` waiver grants openly.
     */
    readonly invocationWaiverRecordIds?: readonly string[];
}
interface GateDecision {
    readonly gateId: string;
    readonly candidate: CandidateBinding;
    readonly admitted: boolean;
    readonly resolutions: readonly ObligationResolution[];
    /** Findings that did not block. Kept so a passed gate is still auditable. */
    readonly diagnostics: readonly ObligationFinding[];
    readonly blockers: readonly Blocker[];
}
/**
 * Whether a record's candidate binding names the candidate now under
 * evaluation, under the gate-time reading of "the same candidate".
 *
 * `treeSha` is absent from the comparison and that absence is the whole point;
 * see the header. Both sides must name an identity token this config accepts
 * and the same one, and the digest must be non-empty — a record written before
 * the identity existed carries an empty digest, and comparing two empty strings
 * would make every such record match every candidate.
 */
declare function isRecordFreshForCandidate(config: HarnessConfig, recorded: RecordCandidateBinding, candidate: CandidateBinding): boolean;
/**
 * The last gate on the gate: a resolution an obligation's config does not
 * permit becomes a block, whatever produced it.
 *
 * This exists because every path above answers a different question — is there
 * evidence, did a provider pass, does a policy cover this — and none of them
 * has any reason to consult `allowedResolutionKinds`. Without this step, an
 * obligation that declares itself undelegatable is undelegatable only for as
 * long as nobody writes a delegation path that forgets to ask.
 */
declare function enforceAllowedResolution(obligation: ObligationPolicy, resolution: ObligationResolution): ObligationResolution;
declare function evaluateGate(input: EvaluateGateInput): GateDecision;

/**
 * The filesystem port's shapes, with no filesystem in them.
 *
 * WHY A PORT AT ALL. Three kernel modules — the recorder here, the admission
 * adapter, and the delivery record — are forbidden from importing `node:fs`
 * directly (sensor rule d2). That is not a style preference. Every filesystem
 * question those modules ask is a question the spec has an opinion about: what
 * a run root *is*, whether a resolved path is inside one, what "the digest of
 * the file's bytes at submission" means when the path names a directory. Left
 * to each caller, those answers drift; behind one port they are written once
 * and tested once.
 *
 * WHY THE SHAPES LIVE HERE. Same seam as `candidate.types.ts` and
 * `records.types.ts`: a module may import these shapes without acquiring an
 * edge to the implementation that produces them. Nothing in this file imports
 * anything, and nothing in it performs an operation.
 *
 * WHAT AN OBSERVATION IS. `observeArtifact` returns a *classification*, never a
 * verdict. It says what it found — the path was refused before it was touched,
 * the file is not there, it resolved outside the root, it is not a file, it
 * could not be read, or here are its bytes and their digest. Which rejection
 * code each of those maps to is the recorder's decision, because it is the
 * recorder that owns ENV-10 and ENV-11. A port that returned codes would be
 * making spec decisions from inside the filesystem layer, and the two mappings
 * that matter — a missing file is a digest failure, a file resolving outside
 * the root is not — would then be invisible to the module that has to justify
 * them.
 */
/** The provider coordinates a run root is derived from. */
interface RunRootRequest {
    /** `provider.id` from the manifest. Must be a single safe path component. */
    readonly providerId: string;
    /** `provider.runId` from the manifest. Must be a single safe path component. */
    readonly runId: string;
}
/**
 * An allocated run root: the directory a provider writes its evidence into and
 * the only place a submission's files may live.
 *
 * `path` is always the *resolved* location. On macOS `os.tmpdir()` is a
 * symlinked `/var/...` alias of a real `/private/var/...` directory, so a run
 * root compared before resolution and a file compared after it would disagree
 * about containment for every artifact in the run — the alias, not an attack,
 * is what would fail the check.
 */
interface RunRoot {
    readonly providerId: string;
    readonly runId: string;
    /** Absolute, symlink-resolved. */
    readonly path: string;
}
/**
 * Why a run root could not be derived.
 *
 * The first two are about the *shape* of a provider-supplied identifier, which
 * the port refuses to interpret as a path before any filesystem call happens:
 * `runId: "../run-a"` names another provider's directory, and `runId: "."`
 * names the pool itself. Both are also rejections the manifest validator makes
 * under ENV-1 and ENV-2, which matters to the caller: a refusal the validator
 * independently names can be skipped without losing a check.
 *
 * The last two are not. `provider_id_too_long` is a grammar-legal id — ENV-1
 * bounds the character set and not the length — that cannot be a path
 * component, and `run_root_outside_base` is the pool's own directory resolving
 * somewhere the harness did not put it. Nothing else in the system names
 * either, so a caller that treats them as "skip the run-root rules" accepts a
 * submission whose containment was never established.
 */
declare const RUN_ROOT_REFUSAL_REASONS: readonly ["unsafe_provider_id", "unsafe_run_id", "provider_id_too_long", "run_root_outside_base"];
type RunRootRefusalReason = (typeof RUN_ROOT_REFUSAL_REASONS)[number];
type RunRootResolution = {
    readonly ok: true;
    readonly runRoot: RunRoot;
} | {
    readonly ok: false;
    readonly reason: RunRootRefusalReason;
};
/**
 * What the port found at a declared artifact path.
 *
 *   `path_refused`      — the declared path was not a safe relative path; the
 *                         port never touched the filesystem with it.
 *   `missing`           — nothing resolves there.
 *   `outside_run_root`  — it resolves, and the resolution is not inside the
 *                         run root. A symlink that resolves *inside* is not
 *                         this: containment is judged after resolution, so a
 *                         link within the run is an ordinary file.
 *   `not_a_file`        — a directory, or another non-regular entry. It has no
 *                         "bytes at submission" to digest.
 *   `unreadable`        — it is a file and reading it failed.
 *   `readable`          — bytes were read; `sha256` and `contents` are present.
 */
declare const ARTIFACT_OBSERVATION_STATUSES: readonly ["path_refused", "missing", "outside_run_root", "not_a_file", "unreadable", "readable"];
type ArtifactObservationStatus = (typeof ARTIFACT_OBSERVATION_STATUSES)[number];
interface ArtifactObservation {
    /** Exactly the path the manifest declared, unmodified. */
    readonly declaredPath: string;
    readonly status: ArtifactObservationStatus;
    /** The symlink-resolved location, when there was one to resolve. */
    readonly resolvedPath: string | null;
    /** Lowercase-hex sha256 of the file's bytes. Present only when `readable`. */
    readonly sha256: string | null;
    /**
     * The bytes decoded as UTF-8. Present only when `readable`. Payload rules
     * read approval stamps from here; it is untrusted provider-authored text and
     * is never interpolated into a rejection message.
     */
    readonly contents: string | null;
    /** Exact bytes for portable retention, including non-UTF-8 artifacts. */
    readonly base64?: string;
    /** Operator-facing diagnostic for the failure statuses. Never parsed. */
    readonly detail: string | null;
}
/** Options for the port's one write path. */
interface WriteFileOptions {
    /**
     * Permission bits for the written file. The default suits a tracked,
     * working-tree file — the delivery record — rather than the git-private
     * store, which owns its own stricter modes.
     */
    readonly mode?: number;
}
/**
 * The filesystem operations the recorder, the admission adapter and the
 * delivery record are allowed to perform, and the complete list of them.
 *
 * Deliberately narrow. There is no `exists`, no `mkdir`, no `readdir`: every
 * member here exists because a spec rule or a product artifact needs it, and a
 * general-purpose filesystem facade behind a d2 rule would be the rule with
 * extra steps.
 */
interface ArtifactsPort {
    /**
     * Derives the run root for a provider run and creates it. Allocation is the
     * recorder's, never the provider's: a provider that could name its own root
     * could name a directory whose contents it did not produce (SUB-3).
     */
    allocateRunRoot(request: RunRootRequest): Promise<RunRootResolution>;
    /** The same derivation without creating anything. */
    resolveRunRoot(request: RunRootRequest): Promise<RunRootResolution>;
    /** Whether `target` resolves to a location strictly inside `runRootPath`. */
    isInsideRunRoot(runRootPath: string, target: string): Promise<boolean>;
    /** Classifies one declared artifact path against a run root. */
    observeArtifact(runRootPath: string, declaredPath: string): Promise<ArtifactObservation>;
    /** Reads a UTF-8 text file — the submitted manifest. */
    readTextFile(target: string): Promise<string>;
    /** Writes a UTF-8 text file atomically, creating parent directories. */
    writeTextFile(target: string, contents: string, options?: WriteFileOptions): Promise<void>;
    /**
     * Removes a file, treating an absent one as success.
     *
     * Its caller is a rejection undoing records it published before discovering a
     * conflict on a later claim, so it must not fail the operation it is cleaning
     * up after: it reports whether the file is gone rather than throwing.
     */
    removeFile(target: string): Promise<boolean>;
}

/**
 * The namespace run roots live under, inside the system temporary directory.
 * A constant rather than a config member — see the module note.
 */
declare const RUN_ROOT_NAMESPACE = "delivery-harness";
/** The leaf under the namespace, so a future sibling need not move this one. */
declare const RUN_ROOT_LEAF = "runs";
/**
 * Strict containment over already-resolved paths: `child` is inside `parent`
 * and is not `parent` itself. A string-prefix test would put `/tmp/run-a2`
 * inside `/tmp/run-a`, which is a different run's directory.
 */
declare function isInsideResolved(parent: string, child: string): boolean;
/**
 * Whether a manifest-declared artifact path may be joined to a run root at all:
 * relative, no traversal, no empty segment, no drive-absolute or UNC form.
 *
 * Character-for-character the validator's shape rule, and it has to stay that
 * way rather than merely being "at least as strict". A path this predicate
 * refused but the validator accepted would be an artifact the recorder never
 * digests and no rule ever rejects — a hole, not extra safety. The duplication
 * is deliberate all the same: the validator produces a verdict, this decides
 * whether a provider-supplied string reaches `path.join`, and that decision
 * must hold for a caller who never ran the validator. A test pins the two in
 * step over a shared table.
 *
 * A NUL is refused for a mechanical reason rather than a spec one: no supported
 * filesystem admits one in a path segment, and `realpath` rejects it with
 * `ERR_INVALID_ARG_VALUE` — which is neither of the two absences the resolver
 * reads as "nowhere", so it escapes a classifying function as a raw
 * `TypeError`. Both copies refuse it, so it is a rejection rather than a crash.
 */
declare function isSafeRelativePath(value: string): boolean;
interface ArtifactsPortOptions {
    /**
     * The directory run roots are created under. Defaults to the harness
     * namespace inside the system temporary directory. Callers pass one to keep
     * concurrent runs from sharing a provider's run id; it is not repository
     * configuration.
     */
    readonly runRootBase?: string;
}
/** The default base: `<tmpdir>/delivery-harness/runs`, resolved. */
declare function defaultRunRootBase(): Promise<string>;
declare function createArtifactsPort(options?: ArtifactsPortOptions): ArtifactsPort;

/**
 * The submission flow: spec §8.3, from a manifest on disk to published records.
 *
 * WHAT THIS MODULE IS FOR. The validator answers "is this manifest internally
 * coherent, and does it agree with the candidate observation I was handed".
 * That is a judgement about a value. Submission is a judgement about the
 * *world*: the candidate as it is right now, the run root this harness
 * allocated, the bytes actually sitting in it, and a store that may already
 * hold a record under this identity. Those five SUB rules exist because the
 * transport is part of the trust model — a provider that could choose its own
 * run root, or submit against a candidate it prepared an hour ago, would make
 * every downstream guarantee decorative.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER.
 *
 *   1. Read the manifest through the fs port.
 *   2. When a provider caller supplies its allocated attempt, bind that one
 *      snapshot to the expected provider, run, and run root.
 *   3. Re-capture the candidate through the injected port (SUB-1, SUB-2).
 *   4. Require a current preparation receipt for that candidate — the
 *      preparation receipt's ordering mechanism.
 *   5. Derive the run root from the provider coordinates, and observe every
 *      declared artifact inside it (ENV-10's realpath clause, ENV-11).
 *   6. Validate the manifest, handing it the re-captured candidate and the
 *      artifact bytes read in step 5.
 *   7. Aggregate: the validator's rejections and this module's, in one
 *      response (SUB-5), with no record written if there is a single one
 *      (GEN-3).
 *   8. Publish one record per claim, stamped with the manifest digest (SUB-4).
 *
 * Capture precedes the receipt check because the receipt is evaluated *against*
 * a candidate: there is nothing to compare a receipt to until something has
 * been observed. The receipt check precedes everything else because a stale
 * receipt means the wiring or the tree that produced this candidate is not the
 * one in front of us, and validating a manifest against it would answer a
 * question nobody asked.
 *
 * NO RECEIPT IS A BLOCKER, NEVER A BYPASS. A missing, invalid, wiring-mismatched
 * or stale receipt ends the submission with the receipt's own typed blockers.
 * There is deliberately no option to skip the check and no code path that
 * substitutes the captured candidate for a receipt: the ordering is a mechanism
 * precisely because there is nothing else to consult.
 *
 * WHAT IS NOT DECIDED HERE. Whether an obligation is *satisfied* — that is the
 * gate's question, asked later against the records this writes. This module
 * accepts or rejects a submission; it never resolves an obligation, and it
 * never reads a clock. Freshness in this system is content identity (GEN-5),
 * and `recordedAt` is data whose grammar the validator checks and whose value
 * nothing consults.
 */

interface SubmissionInput {
    /** The repository the evidence store and the receipt store belong to. */
    readonly rootDir: string;
    /** Where the submitted manifest file is. SUB-3 is about this path. */
    readonly manifestPath: string;
    readonly config: HarnessConfig;
}
interface ExpectedProviderAttempt {
    /** Provider selected by the harness for this invocation. */
    readonly providerId: string;
    /** Request/run identity allocated by the harness for this invocation. */
    readonly runId: string;
    /** Run root allocated by the harness before the provider was started. */
    readonly runRootPath: string;
}
interface SubmissionOptions extends RecordStorageOptions {
    /**
     * How the current candidate is observed (SUB-1). Injected rather than
     * defaulted to the git capture: the recorder must not own a repository
     * dependency, and a conformance run drives this whole path from declared
     * values with no repository at all.
     */
    readonly captureCandidate: CaptureCandidate;
    /** The filesystem port. Defaults to one rooted in the system temp directory. */
    readonly artifacts?: ArtifactsPort;
    /**
     * Optional caller authority for provider-driven submissions. When present,
     * the recorder binds the one manifest snapshot it reads to this invocation
     * before any validation or publication. Ordinary submission paths omit it.
     */
    readonly expectedProviderAttempt?: ExpectedProviderAttempt;
    /** Passed through to the receipt evaluation. Tests use it; callers do not. */
    readonly harnessVersion?: string;
}
interface SubmissionRecord {
    readonly obligationId: string;
    readonly recordId: string;
    readonly path: string;
    /** `published` on first write, `idempotent` when this exact record was already stored. */
    readonly status: PublishedRecord["status"];
    readonly record: EvidenceRecord;
}
/**
 * Three outcomes, not two.
 *
 * `rejected` means the submission was judged and failed: every violated rule is
 * named, and the codes are the spec's. `blocked` means it could not be judged —
 * no receipt, an unreadable manifest, a store that will not answer — and there
 * is no spec code for that, because the spec's codes describe manifests. A
 * caller that collapsed the two would have to invent a rejection code for "the
 * harness could not look", which is exactly the fabrication a fail-closed
 * design is trying to avoid.
 *
 * Both failing shapes carry blockers, and blockers are what a surface renders.
 * No caller formats a rejection or a preparation reason itself.
 */
type SubmissionOutcome = {
    readonly status: "accepted";
    readonly manifestDigest: string;
    readonly records: NonEmptyTuple<SubmissionRecord>;
} | {
    readonly status: "rejected";
    readonly rejections: NonEmptyTuple<ManifestRejection>;
    readonly blockers: NonEmptyTuple<Blocker>;
} | {
    readonly status: "blocked";
    readonly blockers: NonEmptyTuple<Blocker>;
};
/**
 * The fields SUB-1 compares, named rather than derived from whatever a capture
 * happens to carry.
 *
 * `headSha` is in the set and is compared strictly when the manifest declares
 * one: §5.3 calls it informational because evidence binds to *trees*, and that
 * note governs gate-time freshness, where a rebase preserving the tree
 * preserves the evidence. SUB-1 is the other end of the system — it says
 * "every field" and the recorded id is an audit anchor — so a head that moved
 * under an identical tree is rejected here and re-preparation is the remedy.
 *
 * `vcs` is constant under ENV-4 and compared anyway, because "every field"
 * means the enumeration, not the fields that could plausibly differ.
 */
declare const SUBMISSION_CANDIDATE_FIELDS: readonly string[];
interface CandidateComparison {
    readonly matches: boolean;
    /** Enumerated field paths that differ, in declaration order. */
    readonly mismatchedFields: readonly string[];
    /**
     * The drift classes the difference falls into, for the fields that describe
     * movement in the repository. A mismatch on `base.ref`, `deliverable.identity`
     * or `vcs` produces no class by design — those are configuration
     * disagreements, and telling an operator to re-prepare would be wrong advice.
     */
    readonly driftClasses: readonly CandidateDriftClass[];
}
/**
 * Compares a submitted candidate binding against the one just captured, on the
 * enumerated field set.
 *
 * The submitted side is read defensively — it is a manifest member, so it may
 * be any value at all — and a member that is absent or of the wrong type is a
 * mismatch rather than a skipped comparison. The single exception is `headSha`,
 * which the envelope makes optional: a manifest that declares none is compared
 * on the other eight.
 */
declare function compareSubmissionCandidate(submitted: unknown, captured: CapturedCandidate): CandidateComparison;
/**
 * Submits one manifest: §8.3 end to end.
 *
 * Every rule runs before anything is written. That is GEN-3 — validation is
 * atomic across claims, and a manifest with one good claim and one bad one
 * writes nothing at all — and it is also why SUB-5 aggregation is possible:
 * the recorder's own filesystem findings join the validator's list rather than
 * short-circuiting it.
 */
declare function submitManifest(input: SubmissionInput, options: SubmissionOptions): Promise<SubmissionOutcome>;

/**
 * The admission adapter: the effectful seam between the store, the classified
 * execution context, the caller-supplied live results, and the *pure* gate
 * evaluator.
 *
 * WHAT LIVES HERE, AND WHY IT IS NOT IN THE EVALUATOR. `evaluateGate` is a total
 * function of values — it opens no file, runs no git, and reads no clock. That
 * is what lets it be exercised as a decision table. But something has to turn a
 * repository into those values: capture the candidate, resolve the git-private
 * store, read the records filed under each obligation, map the store's
 * quarantine into the evaluator's diagnostic union, and translate the classified
 * context. That is this module, and the purity sensor's d2 rule holds it to the
 * bargain — every filesystem effect it performs is routed through `records.ts`
 * or `preparation.ts` (each of which owns its own fs), never a direct `node:fs`.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER.
 *
 *   1. Capture the candidate through the injected port. Everything downstream is
 *      about *this* candidate, so there is nothing to do until one is observed.
 *   2. Prove capture and store name the same workspace. The adapter both
 *      assembles the candidate binding and synthesizes waiver records filed
 *      under the store's workspace id; if those two workspaces disagreed, a
 *      waiver would be filed where the candidate does not live and still pass
 *      the freshness comparison, which is exactly the silent hazard the recorder
 *      flagged for "the CLI". This is the place that can see both, so this is the
 *      place that asserts it.
 *   3. Require a current preparation receipt. No receipt is a blocker, never a
 *      bypass — and it is decided before the gate runs, so a missing receipt can
 *      never reach a waiver prompt.
 *   4. Project activation, read the store, evaluate.
 *   5. Two-pass waiver, only if the first pass blocked on nothing but waivable
 *      findings and the run is an interactive human with a prompt wired.
 *
 * appliesToCandidate IS DECIDED HERE. The evaluator judges freshness, but it is
 * the adapter that decides which discovered records are even *about* this
 * candidate. A well-formed record whose binding is not fresh for the candidate
 * under evaluation is excluded — it resolves as absent, not as stale evidence,
 * because a record for another candidate is not this candidate's stale evidence,
 * it is simply not its evidence. A quarantined file is the opposite case: its
 * binding cannot be parsed, so it cannot be shown to belong to another
 * candidate, and the fail-closed reading is that it applies (a store that cannot
 * account for its own contents is a gate decision).
 *
 * THE TWO-PASS WAIVER EVALUATION. A blocked first pass whose every finding an
 * interactive human may waive earns exactly one prompt, naming every obligation
 * that one "yes" covers. On acceptance the candidate is re-captured — a change
 * while the prompt was open voids the offer — and then candidate-bound waiver
 * records are written to disk and the gate is evaluated a second time, with
 * those record ids handed in as this invocation's grants. The write happens only
 * after an accepted prompt and a clean re-capture, so a decline or a drift
 * leaves the store exactly as it found it: zero waiver records.
 *
 * WHAT THE PORT FROM ATHENA DROPPED. Athena's admission wrote gate-decision
 * telemetry events, spawned private validation providers inside admission, and
 * mapped two Athena-only providers (documentation and delivery-run telemetry).
 * None of those is in this adapter's scope: admission itself never spawns, there
 * is no decision-event stream, and the neutral CLI rail invokes only opt-in
 * provider commands before handing their ordinary evidence/live results back
 * here. And Athena's
 * `toEvaluatorContext` remapped the classifier's kinds onto the evaluator's;
 * here `context.ts` already emits the evaluator's `ExecutionContext` union, so
 * the translation is the identity and the classified context is consumed
 * directly. Athena's `invocation:`-prefixed waiver ids are likewise gone: a
 * content-addressed id cannot carry a prefix, so this invocation's grants are
 * named explicitly through `invocationWaiverRecordIds` instead.
 */

/** Live obligations must obtain approval during each invocation. */
declare const INVOCATION_WAIVER_SCOPE: "invocation";
/**
 * The interactive waiver prompt, injected. The adapter never detects a TTY and
 * never renders — the command surface wires an implementation over its own I/O,
 * and a run with none supplied simply cannot be offered a waiver.
 */
type WaiverApproval = {
    readonly author: string;
    readonly reason: string;
};
type WaiverPrompt = (decision: GateDecision, obligationIds: readonly string[]) => Promise<false | WaiverApproval>;
/** How the interactive waiver offer resolved, for a caller that reports it. */
type WaiverPromptOutcome = "not_offered" | "accepted" | "declined" | "candidate_changed" | "scope_changed";
interface AdmissionInput {
    readonly rootDir: string;
    readonly config: HarnessConfig;
    /**
     * The already-classified context. `context.ts` emits exactly the union the
     * evaluator consumes, so there is nothing to translate — the same trust
     * boundary the classifier established, named in one place.
     */
    readonly context: ExecutionContext;
    /** Caller-supplied live-provider results — the v1 source of `satisfied_live_fact`. */
    readonly liveResults?: readonly LiveProviderResult[];
}
interface AdmissionOptions extends RecordStorageOptions {
    /** How the candidate is observed. Injected: the adapter owns no repository dependency. */
    readonly captureCandidate: CaptureCandidate;
    /** The reviewable-change projection for the captured candidate. Injected for the same reason. */
    readonly projectActivation: (candidate: CapturedCandidate) => Promise<ReviewActivationProjection>;
    /** Absent means "this run cannot ask a human", so no waiver is ever offered. */
    readonly promptForWaiver?: WaiverPrompt;
    readonly evaluatePreparation?: (rootDir: string, config: HarnessConfig, candidate: CapturedCandidate) => Promise<PreparationEvaluation>;
    readonly discoverRecords?: (rootDir: string, gateId: string, obligationId: string) => Promise<RecordDiscovery>;
    readonly publishWaiver?: (rootDir: string, binding: RecordCandidateBinding, obligationId: string, resolution: WaiverResolution) => Promise<PublishedRecord>;
    /** Passed through to receipt evaluation. Tests use it; callers do not. */
    readonly harnessVersion?: string;
}
interface AdmissionResult {
    readonly admitted: boolean;
    readonly blockers: readonly Blocker[];
    /** The final pure evaluation. Absent only when capture, coherence, or the receipt stopped the run before the gate ran. */
    readonly decision?: GateDecision;
    readonly context?: ExecutionContext;
    readonly candidate?: CandidateBinding;
    readonly waiver: WaiverPromptOutcome;
    /** The obligations one "yes" would cover (or did cover). Empty unless a waiver was offerable. */
    readonly waivedObligationIds: readonly string[];
    /** The waiver records written this run. Non-empty only on an accepted waiver. */
    readonly waiverRecordIds: readonly string[];
}
declare function runAdmission(input: AdmissionInput, options: AdmissionOptions): Promise<AdmissionResult>;

/**
 * The closed-grammar machinery the managed-delivery contract spine is written
 * in. Same discipline as the evidence validator's grammar — member tables,
 * a collector, no early return — but deliberately a separate module: the
 * evidence kernel and the spine stay independent by the dependency-direction
 * sensor, so neither may import the other's machinery. This module imports
 * nothing at all.
 *
 * Closedness is also the spine's first redaction rule: every grammar here is
 * a closed member table, so a free-form environment dump, transcript, or
 * secret-bearing stranger member has no place to land (D16's field
 * classification and retention arrive with their owning units). The one
 * free-text member family (summaries and reasons) is length-bounded.
 */
type SpineRejectionCode = "not_an_object" | "unsupported_spec" | "unknown_member" | "missing_member" | "malformed_member" | "unsupported_combination" | "reserved_kind" | "unknown_kind" | "zero_review_attempts" | "duplicate_review_attempt" | "criterion_unverified" | "authority_not_granted" | "vacuous_policy" | "digest_mismatch" | "revision_mismatch" | "duplicate_idempotency_key" | "non_monotonic_fence" | "fence_mismatch" | "invalid_transition" | "journal_terminal" | "subject_mismatch" | "registration_missing" | "secret_rejected";
interface SpineRejection {
    readonly code: SpineRejectionCode;
    /** RFC 6901 pointer to the offending value. */
    readonly pointer: string;
    readonly message: string;
}
type SpineVerdict = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly rejections: readonly SpineRejection[];
};
/** Stable spine identities: bounded, filename- and journal-safe. */
declare const SPINE_ID: RegExp;
/** Lowercase-hex SHA-256, the only digest spelling this system emits. */
declare const SPINE_SHA256: RegExp;
/** Git object ids are 40-hex lowercase; SHA-256 object format is out of scope. */
declare const SPINE_GIT_OID: RegExp;
/** A UTC instant. Shape only — no spine decision may consult a clock. */
declare const SPINE_INSTANT: RegExp;
/** The explicit marker for an identity that does not exist yet in this state. */
declare const ABSENT_BY_STATE = "absent-by-state";

/**
 * `run-event/1` — the RUN family's closed contract.
 *
 * A SEPARATE FAMILY, NOT SPINE KINDS. The frozen `(journal, kind)` vocabulary
 * is a contract-freeze surface: adding a kind there is a spine revision. Run
 * events are observability — they must never be able to advance or block a
 * delivery — so they get their own version, their own validator, and their own
 * store. What they DO reuse is the spine's closed-grammar machinery
 * (`spine/grammar.ts`), because a second hand-rolled member walker would be a
 * second place for a stranger member to land.
 *
 * ENVELOPE/PAYLOAD AGREEMENT. `ticket` and `candidateTreeSha` appear in the
 * envelope so every reader reads ONE place, and in the payload of the kinds
 * that own them. The two must agree exactly: absent where the payload carries
 * the member, present where the payload does not (on ANY kind, including one
 * whose payload never names it), or differing is a rejection. The check lives
 * here rather than in the emitting command so that every appender — today's
 * `emit`, tomorrow's — is held to it at the store boundary.
 *
 * A RUN MAY CARRY MORE THAN ONE TICKET. A dogfood delivery is the ordinary
 * case: one run, one ticket for the thing being dogfooded and one for the
 * ordinary item it delivered, each with its own posture. So `posture.declared`,
 * `gate.reported`, and `pr.opened` each take an OPTIONAL `ticket`, of the same
 * shape `ticket.read` uses, naming which of the run's tickets the entry belongs
 * to. The member is optional rather than required because binding by adjacency
 * is what every single-ticket journal already does and those journals stay
 * readable: an entry that omits it binds to the run's PRIMARY ticket, which
 * `runPrimaryTicket` below defines. Nothing requires the member — the
 * completeness evaluator does not name it — so adding it opens no journal that
 * was closed and closes none that was open.
 *
 * SELF-ATTESTED. Every event carries `attestation: "self"`. Nothing
 * authoritative reads this family; see the run store's header.
 */

/** The family's spec string; `version` is the envelope member that carries it. */
declare const RUN_EVENT_SPEC = "run-event/1";
declare const RUN_EVENT_SPEC_V2 = "run-event/2";
type RunEventVersion = typeof RUN_EVENT_SPEC | typeof RUN_EVENT_SPEC_V2;
/**
 * Run ids name FILES in the store, so their charset is deliberately narrower
 * than the kernel's `RUN_ID`: no `.`, which keeps `.`, `..`, and a `.jsonl`
 * suffix unconstructible and keeps the notes subdirectory unreachable by id.
 */
declare const RUN_STORE_ID: RegExp;
/** The kernel's existing `RUN_ID` charset and length, reused for `ticket`. */
declare const RUN_TICKET: RegExp;
/** A git object id in either object format, lowercase hex only. */
declare const RUN_CANDIDATE_TREE_SHA: RegExp;
/** The `PROVIDER_ID` precedent from `artifacts.ts`: bounded charset and length. */
declare const RUN_PROVIDER_ID: RegExp;
declare const MAX_RUN_PROVIDER_ID = 128;
/** A bounded structural label: adopter command names, postures, trackers, hosts. */
declare const MAX_RUN_LABEL = 128;
/** Paths and URLs are bounded too — nothing in this family is a dumping ground. */
declare const MAX_RUN_PATH = 4096;
declare const MAX_RUN_URL = 2048;
/** Lens id lists are bounded: a selection, never a transcript. */
declare const MAX_RUN_LENSES = 32;
/**
 * The run family's free-text members: redacted on a secret rather than
 * rejected, exactly as the spine's `summary` and `reason` are. Every OTHER
 * member of this family is structural and rejects on a secret.
 */
declare const RUN_FREE_TEXT_MEMBERS: ReadonlySet<string>;
/** Who wrote the event. The store, not `emit`, decides which role is legal per kind. */
declare const RUN_ACTOR_ROLES: readonly ["cli", "executor"];
type RunActorRole = (typeof RUN_ACTOR_ROLES)[number];
/**
 * `command.completed`'s outcome is a closed enum of the CLI boundary's OWN
 * result categories — the four classes it maps to exit codes (0, 1, 2, 130).
 * It deliberately carries no argv, stdout, stderr, or blocker text.
 */
declare const RUN_COMMAND_OUTCOMES: readonly ["ok", "policy", "usage", "interrupted"];
type RunCommandOutcome = (typeof RUN_COMMAND_OUTCOMES)[number];
/** An adopter whose gate is not a product command reports one of these instead. */
declare const RUN_GATE_REPORTED_OUTCOMES: readonly ["pass", "fail", "blocked", "interrupted"];
/** How a run ended. */
declare const RUN_ENDED_RESULTS: readonly ["complete", "partial", "blocked"];
/** The v1 kind vocabulary, in the order the plan's payload table states it. */
declare const RUN_EVENT_KINDS_V1: readonly ["run.started", "run.ended", "ticket.read", "posture.declared", "lens.selected", "review.round.opened", "review.round.closed", "command.completed", "gate.reported", "pr.opened", "blocker.recorded", "decision.recorded", "compounding.recorded", "context.saved", "action.intent", "action.observed"];
declare const RUN_EVENT_KINDS: readonly ["run.started", "run.ended", "ticket.read", "posture.declared", "lens.selected", "review.round.opened", "review.round.closed", "command.completed", "gate.reported", "pr.opened", "blocker.recorded", "decision.recorded", "compounding.recorded", "context.saved", "action.intent", "action.observed", "activity.observed", "wait.started", "wait.resolved", "finding.observed", "report.referenced", "artifact.referenced", "finish.step.observed"];
type RunEventKind = (typeof RUN_EVENT_KINDS)[number];
declare function isRunEventKind(value: unknown): value is RunEventKind;
declare function isRunInstant(value: unknown): value is string;
/** v2 is opt-in; no new member is admitted under a v1 envelope. */
declare const RUN_ACTIVITY_STATES: readonly ["queued", "running", "waiting", "completed", "failed", "interrupted"];
type RunActivityState = (typeof RUN_ACTIVITY_STATES)[number];
interface RunEventRepo {
    readonly commonDir: string;
    readonly remote?: string;
}
interface RunEventActor {
    readonly role: RunActorRole;
    readonly id?: string;
}
/** The envelope as it reaches the store: `seq` is the store's to assign. */
interface RunEventInput {
    readonly version: RunEventVersion;
    readonly eventId?: string;
    readonly runId: string;
    readonly at: string;
    readonly repo: RunEventRepo;
    readonly kind: RunEventKind;
    readonly actor: RunEventActor;
    readonly ticket?: string;
    readonly candidateTreeSha?: string;
    readonly attestation: "self";
    readonly payload: Readonly<Record<string, unknown>>;
}
/** A durable event: the input plus the store-assigned sequence number. */
interface RunEvent extends RunEventInput {
    readonly seq: number;
}
/**
 * Validates one run event. `seq` is required unless the caller says the store
 * has not assigned it yet.
 *
 * ORDER IS LOAD-BEARING: an unknown kind is reported AS an unknown kind and
 * its payload is not walked, so a hostile payload can never dilute the one
 * diagnostic that names what was actually wrong.
 */
declare function validateRunEvent(value: unknown, options?: {
    readonly seqAssigned?: boolean;
}): SpineVerdict;
/**
 * The run's primary ticket: the first ticket the journal names, in `seq` order.
 *
 * WHY THE FIRST, AND WHY FROM THE ENVELOPE. A run that carries more than one
 * `ticket.read` needs one of them to be the ticket the run is ABOUT — the one
 * a runs table names in its row and the one an entry that omits `ticket` binds
 * to. Order is the only thing that distinguishes them without asking the
 * executor to declare a primary it could get wrong, so the first wins. The
 * envelope is what is read rather than each kind's payload, for the same
 * reason every other reader reads it: the validator holds the two to exact
 * agreement, so the envelope is the ONE place a ticket lives whatever kind
 * carries it — `run.started`'s when a run named its ticket at the start, the
 * first `ticket.read`'s otherwise.
 *
 * `undefined` for a journal that names no ticket at all, which is an ordinary
 * run rather than a defect: nothing in the family requires one.
 */
declare function runPrimaryTicket(events: readonly RunEvent[]): string | undefined;
/** The store's own entry point: an event whose `seq` it has not assigned yet. */
declare function validateRunEventInput(value: unknown): SpineVerdict;
/**
 * Reduces an arbitrary string to what a note may carry for a rejected kind:
 * the `PROVIDER_ID` charset and length, so an unbounded or hostile kind string
 * never becomes durable and never reaches the viewer.
 */
declare function reduceToProviderId(value: string): string;

/**
 * Run-journal completeness: does this journal describe a whole delivery run,
 * and in the order a whole run happens?
 *
 * OBSERVABILITY, NEVER EVIDENCE. Nothing authoritative reads this. Anything
 * the owner executes can append to the store, so a hostile executor can
 * batch-emit a plausible journal; the ordering rule makes that a deliberate
 * act rather than an afterthought, and no gate, admission, or record decision
 * depends on the answer.
 *
 * TWO CLOSED SETS, ONE PLACE EACH. `missing` carries required entries by name
 * and `violations` carries violated constraints by identifier. Both
 * vocabularies are enumerated exactly once — in `REQUIRED` and `VIOLATION`
 * below — and the evaluator emits only members of them, so a renamed or
 * dropped entry is a visible edit here and a red assertion in the suite rather
 * than a name that quietly stops appearing.
 *
 * ANCHORED CONSTRAINTS SKIP, THEY DO NOT FAIL. A constraint phrased over the
 * `gate` completion, the `record` completion, or (in an executor-only journal)
 * `gate.reported` is evaluated only when every anchor it names is present.
 * When one is absent the constraint is skipped and the absent anchor is
 * reported MISSING — an unfinished run is incomplete, not ill-ordered.
 */

/**
 * One identifier per ordering constraint the completeness rule states, in the
 * order it states them. `run-started-not-first` and `run-ended-not-last` are
 * the evaluator's own detections of conditions the STORE also refuses at
 * append time; the store's refusal is a separate enforcement with no
 * identifier of its own.
 */
declare const RUN_JOURNAL_VIOLATIONS: readonly ["run-started-not-first", "prerequisites-after-first-round", "round-closed-before-opened", "gate-before-closed-round", "record-before-gate", "pr-before-gate", "run-ended-not-last", "gate-reported-before-closed-round", "pr-before-gate-reported", "mandated-pair-mismatch", "round-not-bound-to-record"];
type RunJournalViolation = (typeof RUN_JOURNAL_VIOLATIONS)[number];
/**
 * The names `missing` can carry. The two CLI completions are named by kind AND
 * command, so each is its own entry.
 */
declare const RUN_JOURNAL_REQUIRED_ENTRIES: readonly ["run.started", "ticket.read", "posture.declared", "lens.selected", "review.round.opened", "review.round.closed", "command.completed:gate", "command.completed:record", "pr.opened", "run.ended", "gate.reported"];
type RunJournalRequiredEntry = (typeof RUN_JOURNAL_REQUIRED_ENTRIES)[number];
/** Every reader compares these by exact equality. */
declare const RUN_JOURNAL_STATUSES: readonly ["complete", "complete-executor-only", "incomplete", "absent"];
type RunJournalStatus = (typeof RUN_JOURNAL_STATUSES)[number];
interface RunJournalEvaluation {
    readonly status: RunJournalStatus;
    readonly missing: readonly RunJournalRequiredEntry[];
    readonly violations: readonly RunJournalViolation[];
    /**
     * Whether a record's tree sha bound the round constraints. False means the
     * readout is unbound to a record and every rule phrased over the record's
     * tree sha was evaluated over any paired round.
     */
    readonly boundToRecord: boolean;
}
/**
 * One journal's completeness as a REPORTED ROW, rather than as the evaluator's
 * own return: the shape a reader — today only `verify` — attaches to something
 * it prints or returns.
 *
 * It carries the resolution as well as the verdict, because the question an
 * operator is really asking is "was THIS candidate journaled", and answering it
 * means saying which run was read and which other runs bound the same
 * candidate. `attestation` is the constant `"self"` for the same reason every
 * readout carries the label in prose: a row derived from a store anyone who can
 * execute in this repository may append to is never anything else.
 *
 * `absent` is the honest answer to "no journal bound this candidate", and it
 * carries no run id and no missing entries — nothing was evaluated.
 */
interface RunJournalRow {
    /** The run whose journal was evaluated; absent when the status is `absent`. */
    readonly runId?: string;
    /** The other runs whose journals bind the same candidate, most recent first. */
    readonly alsoMatching?: readonly string[];
    readonly status: RunJournalStatus;
    readonly missing: readonly RunJournalRequiredEntry[];
    readonly violations?: readonly RunJournalViolation[];
    /** Record tree used to resolve this row when a verified projection exists. */
    readonly recordTreeSha?: string;
    /** Raw trees the verified record says were actually reviewed. */
    readonly reviewedCandidateTreeShas?: readonly string[];
    readonly attestation: "self";
}
/**
 * Whether the journal carries one required entry, by that entry's own name.
 *
 * ONE PREDICATE, TWO READERS. `missing` below is this function's complement
 * over the required list, and every other reader — the `runs show` readout's
 * `present` row among them — answers from here too. Two entries are not plain
 * kind lookups: a completion counts only where the CLI wrote it, so an
 * executor's claim to have run a command is never read as the product's, and a
 * closed round counts only where it pairs with an open of the same number that
 * precedes it. Answering either of those twice is how a readout comes to name
 * one entry as both present and missing.
 */
declare function runJournalCarries(events: readonly RunEvent[], entry: RunJournalRequiredEntry): boolean;
/**
 * Evaluates one journal's completeness.
 *
 * @param events the journal in `seq` order.
 * @param treeSha the record's candidate tree sha, when a record supplies one.
 *   Only `verify` has one; the viewer supplies none and the readout is then
 *   labeled unbound to a record.
 * @param mandatedLensIds the two mandated lens ids, when the operator supplies
 *   them. Without them the mandate check is arity-and-non-emptiness only.
 * @param reviewedTreeShas additional raw trees accepted only after the caller
 *   has verified the record's retained review-neutral projection.
 */
declare function evaluateRunJournal(events: readonly RunEvent[], treeSha?: string, mandatedLensIds?: readonly string[], reviewedTreeShas?: readonly string[]): RunJournalEvaluation;

/**
 * The tracked delivery record — `delivery-record/2` — and the pure verification
 * core the CLI `verify` command and the GitHub Action both call.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. The delivery record is a product-layer
 * projection that lives *outside* the delivery-evidence/1 spec. The git-private
 * evidence store (records.ts) is the gate's evidence; this is the one sanctioned
 * artifact that crosses out of the workspace into the tracked tree, so that a
 * reviewer — and a CI job in a different workspace — can see that a gate was
 * satisfied without re-running it. At L0 it proves process discipline and
 * freshness, not provenance.
 *
 * PRODUCE-ONLY (sensor rule d2). This module BUILDS the record object and its
 * canonical bytes; it never writes them. The CLI `record` command performs the
 * one write, through the artifacts fs port, so the only place in the kernel that
 * opens a file for the submission/record path stays the artifacts port.
 *
 * NO CLOCK (sensor rule e). Nothing here reads a clock or a `recordedAt`: the
 * record's identity is the candidate it attests, never the moment it was
 * written, and its freshness is judged against a recomputed deliverable
 * identity, never against elapsed time.
 *
 * WHY THE RECORD IS NEUTRAL TO ITS OWN PATH. `config.deliveryRecordPath` is
 * required by the config loader to satisfy *both* neutral predicates. Because it
 * is review-neutral, writing it does not change the deliverable identity the
 * record attests — the record cannot invalidate itself. Because it is
 * record-neutral, it is not part of any candidate binding — a candidate is never
 * bound to the presence of its own record. The self-neutrality proof in the test
 * suite is exactly this property, exercised end to end.
 */

/** The product-layer version token. Not a delivery-evidence/1 spec value. */
declare const DELIVERY_RECORD_VERSION = "delivery-record/2";
/**
 * The honest attestation label. L0 is workspace-scoped process discipline and
 * freshness — never provenance. Surfaced verbatim by every verification summary.
 */
declare const ATTESTATION_LABEL = "self / workspace-scoped \u2014 process discipline and freshness, not provenance";
/**
 * The drift classes a verification can name. `deliverable_identity_changed` is
 * the identity mismatch; the three base classes are the base-movement drift the
 * policy either stales on or names as relaxed.
 */
declare const DELIVERY_RECORD_DRIFT_CLASSES: readonly ["deliverable_identity_changed", "base_ref_changed", "base_tip_moved", "merge_base_moved"];
type DeliveryRecordDriftClass = (typeof DELIVERY_RECORD_DRIFT_CLASSES)[number];
/**
 * The two closed, delivery-owned path sets that may never appear in a
 * candidate tree: the receipted run-pinned projection subtree, and the
 * binding-written host discovery configuration. Inside a run the compiled
 * execution grant protects them; here — in the compiled external verifier a
 * reviewer or a CI job runs, with no product state to consult — a committed
 * path inside either set is a protected-authority-path violation on its own
 * evidence. The two lists are held identical by a sensor in the test suite.
 *
 * Membership is by path SEGMENT, never by string prefix: `src/managed-
 * projection-notes.md` names one of these and is nothing to do with it. It is
 * also CASE-FOLDED, and the prefix itself counts — the same two rules the
 * in-run deny side applies, because on a case-insensitive checkout a case
 * alias still lands inside the protected path, and the prefix committed as a
 * single entry is a symlink pointing wherever its author chose.
 */
declare const DELIVERY_OWNED_TREE_PREFIXES: readonly string[];
/**
 * The one exception to the frozen `.claude` prefix, and its two anchors.
 *
 * The `agent-skills` generation install exposes its skills to Claude Code as
 * relative symlinks under `.claude/skills/` pointing into the tracked, receipted
 * generation at `.agent-skills/current/skills/`. That exposure carries no skill
 * text of its own: every byte a host would read lives in the generation the
 * candidate already tracks, under a prefix this rule does not own. Committing it
 * is therefore not the thing the rule forbids — planting authority text under
 * the host's directory — and an adopter that installs the generation should not
 * have to track the exposure differently from the way the product does.
 *
 * The exception is deliberately the narrowest shape that admits that install and
 * nothing else, and it is decidable from the committed tree alone: the entry's
 * git mode must be a symlink, and its target — resolved against the entry's own
 * directory and normalized — must name something strictly inside the receipted
 * skills root. No filesystem is read, no configuration is consulted, and no
 * other delivery-owned prefix is affected. Everything else under `.claude`,
 * including a regular file under `skills/` and a case alias of either anchor,
 * stays a protected-authority-path violation.
 */
declare const CLAUDE_SKILL_EXPOSURE_PREFIX = ".claude/skills/";
/** The receipted generation's skills root a Claude skill exposure may name. */
declare const RECEIPTED_SKILLS_ROOT = ".agent-skills/current/skills/";
/**
 * One obligation's outcome as promoted into the tracked record. Never `blocked`
 * — a blocked obligation means the gate did not admit and no record is written.
 */
interface DeliveryRecordClaim {
    readonly obligationId: string;
    readonly outcome: ResolutionOutcome;
    readonly providerId?: string;
    readonly recordId?: string;
    readonly runId?: string;
    readonly finalPassId?: string;
    readonly manifestDigest?: string;
    readonly scope?: string;
    readonly waiver?: WaiverResolution & {
        readonly candidateBinding: RecordCandidateBinding;
    };
    readonly ciPolicyId?: string;
    readonly evidence?: EvidenceRecord;
    readonly supportingEvidence?: readonly EvidenceRecord[];
}
interface DeliveryRecordAttestation {
    readonly level: AttestationLevel;
}
/**
 * The tracked `delivery-record/2` artifact. `workspaceId` is recorded for audit
 * but is deliberately *excluded* from verification: CI verifies from a different
 * workspace by construction, so binding on it would fail every real PR.
 */
interface DeliveryRecord {
    readonly version: typeof DELIVERY_RECORD_VERSION | "delivery-record/1";
    readonly gateId: string;
    readonly identityToken: string;
    readonly candidateBinding: RecordCandidateBinding;
    readonly claims: readonly DeliveryRecordClaim[];
    readonly manifestDigest: string | null;
    readonly workspaceId: string;
    readonly attestation: DeliveryRecordAttestation;
    readonly context?: PortableEvidenceContext;
    readonly integrityDigest?: string;
}
interface BuildDeliveryRecordInput {
    readonly config: HarnessConfig;
    readonly decision: GateDecision;
    /** The evidence records backing the decision, used to stamp manifest digests. */
    readonly evidenceRecords: readonly EvidenceRecord[];
    readonly context?: PortableEvidenceContext;
}
type BuildDeliveryRecordResult = {
    readonly ok: true;
    readonly record: DeliveryRecord;
} | {
    readonly ok: false;
    readonly blockers: NonEmptyTuple<Blocker>;
};
/** Maps the evaluator's candidate shape onto the record's flat binding. */
declare function bindingOf(candidate: CandidateBinding): RecordCandidateBinding;
/**
 * Builds the tracked record from an *admitted* gate decision. Refuses (returns
 * blockers) when the decision did not admit or carries a blocked obligation —
 * a record is a statement that the gate passed, and there is nothing truthful
 * to write otherwise.
 */
declare function buildDeliveryRecord(input: BuildDeliveryRecordInput): BuildDeliveryRecordResult;
/**
 * The canonical bytes of a record: RFC 8785 JCS plus a trailing newline. Two
 * `record` runs over one candidate produce byte-identical files, which is what
 * makes a re-record a no-op rather than a spurious diff.
 */
declare function deliveryRecordBytes(record: DeliveryRecord): string;

type ParseDeliveryRecordResult = {
    readonly ok: true;
    readonly record: DeliveryRecord;
} | {
    readonly ok: false;
    readonly blockers: NonEmptyTuple<Blocker>;
};
declare function parseDeliveryRecord(text: string): ParseDeliveryRecordResult;
interface DeliveryRecordFile {
    readonly path: string;
    readonly record: DeliveryRecord;
}
interface RecomputedIdentity {
    readonly deliverableDigest: string;
    readonly identityToken: string;
}
/**
 * Selects the record bound to a recomputed identity from a set of discovered
 * records. A record bound to any other candidate — a foreign record — can never
 * win; two records with only one matching head resolves to that one.
 */
declare function selectDeliveryRecordForIdentity(records: readonly DeliveryRecordFile[], identity: RecomputedIdentity): DeliveryRecordFile | undefined;
/** The base state the record's base coordinates are compared against. */
interface VerificationBase {
    readonly ref: string;
    readonly tipSha: string;
    readonly mergeBaseSha: string;
}
interface DeliveryRecordCheck {
    readonly ok: boolean;
    readonly blockers: readonly Blocker[];
    readonly baseMovement: BaseMovementPolicy;
    /** True when base drift occurred but the `allow` policy let it pass. */
    readonly baseMovementRelaxed: boolean;
    /** Base drift classes the `allow` policy relaxed — named in the summary. */
    readonly relaxedDriftClasses: readonly DeliveryRecordDriftClass[];
    readonly attestationLabel: string;
    readonly claims: readonly DeliveryRecordClaim[];
    /**
     * Raw trees whose review rounds the verified record actually carries. The
     * record tree is always present. An earlier tree appears only after the
     * retained review-neutral projection has passed portable verification.
     */
    readonly reviewedCandidateTreeShas: readonly string[];
    /**
     * The caller's self-attested run-journal row, echoed verbatim and absent when
     * the caller supplied none — which is every caller but the local `verify`.
     *
     * ECHOED, NEVER JUDGED. Nothing in this core reads the row: it does not raise
     * a blocker, it does not touch `ok`, and no member of it appears in any
     * decision above. A run journal is observability, and the moment a verifier
     * consulted one, a store that anyone who can execute in the repository may
     * append to would be deciding admission. The Action never supplies it, so the
     * check it computes is byte-for-byte the check it computed before.
     */
    readonly runJournal?: RunJournalRow;
}
/**
 * The pure verification core shared by the CLI `verify` command and the Action.
 *
 * Reads `config.deliveryRecordVerification.baseMovement` — the ONLY reader of
 * that policy in the whole kernel, so the local gate is never more permissive
 * than CI. `recomputedIdentity` is the deliverable identity the caller recomputed
 * from the PR head (never the synthetic merge commit); `base` is the current base
 * state. `workspaceId` is never consulted.
 */
interface VerifyDeliveryRecordOptions {
    /** Fresh equality of approved and target trees under only recordNeutral exclusions. */
    readonly waiverCandidateMatches?: boolean;
    readonly evidenceContext?: PortableEvidenceContext;
    readonly projection?: EvaluateGateInput["projection"];
    readonly executionContext?: EvaluateGateInput["context"];
    readonly checkBindings?: Readonly<Record<string, CheckBinding>>;
    /** Fresh caller-observed results; never reconstructed from a recorded live claim. */
    readonly liveResults?: EvaluateGateInput["liveResults"];
    /**
     * The candidate tree's entries, when the caller can enumerate them. Supplied,
     * the verifier independently rejects any tree carrying a projection or
     * discovery-configuration path; omitted, that check simply does not run —
     * this core never reads a repository itself.
     *
     * A caller that reads the mode and, for a symlink, the committed target may
     * pass `CandidateTreeEntry` instead of a bare path; only that richer form can
     * witness the admitted Claude skill exposure. A bare path is judged on its
     * path alone and stays blocked.
     */
    readonly candidateTreePaths?: readonly (string | CandidateTreeEntry)[];
    /**
     * A self-attested run-journal completeness row the caller resolved for this
     * record's candidate. Echoed onto the check and never read — see
     * {@link DeliveryRecordCheck.runJournal}. Only a caller that can reach the
     * repository's run store has one, and only the local `verify` does; whether
     * an incomplete row should fail is that caller's decision, taken behind its
     * own opt-in, never this core's.
     */
    readonly runJournal?: RunJournalRow;
}
/**
 * One committed tree entry, as `git ls-tree -r` reports it. A caller that can
 * read the mode and — for a symlink — the target out of the committed blob
 * passes this form; a caller that can only enumerate names passes the bare path
 * string, which can never reach the Claude skill-exposure exception because it
 * witnesses neither of the two facts that exception turns on.
 */
interface CandidateTreeEntry {
    readonly path: string;
    /** The git tree mode, e.g. `100644` for a file or `120000` for a symlink. */
    readonly mode?: string;
    /** The link target read from the committed blob, when the entry is a symlink. */
    readonly symlinkTarget?: string;
}
/** True when the path IS one of the delivery-owned sets, or lies inside one. */
declare function isDeliveryOwnedTreePath(repoPath: string): boolean;
/**
 * True when the committed entry lands in a delivery-owned set AND is not the
 * one admitted Claude skill exposure. This is the whole tree-side rule.
 */
declare function isDeliveryOwnedTreeEntry(entry: string | CandidateTreeEntry): boolean;
/** One line of a `git ls-tree -r -z --full-tree` listing, already split out. */
interface ListedTreeEntry extends CandidateTreeEntry {
    readonly mode: string;
    readonly objectSha: string;
}
/**
 * Parses a NUL-separated `git ls-tree -r -z --full-tree <ref>` listing into its
 * entries. Pure string work, so the one reading of git's tree format is stated
 * once and every verifier shares it.
 *
 * A record git could not format as `<mode> <type> <object>\t<path>` is skipped
 * rather than guessed at, and skipping is a real cost, not a free one: a
 * skipped record is judged by nothing — neither the protected-path rule nor
 * the Action's record discovery, both of which read this list — so it would be
 * missed rather than blocked. It is accepted because `-z` output cannot
 * produce one: git never quotes under NUL separation, the mode, type and
 * object fields never contain a tab or a space, and the split takes the FIRST
 * tab, so a path containing tabs still parses whole.
 *
 * NUL separation, never newline splitting: git quotes a path containing a
 * newline, and the quoted form no longer starts with the prefix it is inside.
 */
declare function parseCandidateTreeListing(nulSeparated: string): readonly ListedTreeEntry[];
/**
 * True when this entry's committed link target must be read for the
 * delivery-owned rule to be decidable — a symlink inside a delivery-owned
 * prefix, the only entry the exception could ever admit. Stating it here keeps
 * every verifier reading the same, minimal set of blobs.
 */
declare function needsCommittedSymlinkTarget(entry: ListedTreeEntry): boolean;
declare function verifyDeliveryRecord(config: HarnessConfig, record: DeliveryRecord, recomputedIdentity: RecomputedIdentity, base: VerificationBase, options?: VerifyDeliveryRecordOptions): DeliveryRecordCheck;

/**
 * THE FROZEN VOCABULARY, verbatim from the plan's State and Authority Model
 * (docs/plans/2026-08-29-001-feat-managed-agent-delivery-system-plan.md in
 * the Athena repository, the contract-freeze authority).
 *
 * Three frozen surfaces live here and nowhere else:
 *
 *   1. The intake and delivery state discriminator lists, plus the
 *      host-activity marker list. `failed` is frozen as a terminal delivery
 *      discriminator even though no enumerated transition ever enters it —
 *      an unreachable discriminator is fail-safe, and inventing an entry
 *      condition would be a spine revision requiring contract-freeze owner
 *      approval, so none is invented.
 *   2. The closed durable event-kind vocabulary, keyed by (journal, kind)
 *      PAIRS — never by a kind→journal map, because
 *      `operator.confirmation.recorded` legitimately homes in two journals
 *      (intake for contract confirmations, delivery for takeover
 *      authorizations) and a single-home map would wrongly reject one of
 *      them. Active kinds have their payloads frozen in `journal.ts`;
 *      reserved kinds reject unconditionally — with or without a payload —
 *      until their owning unit defines them; a pair outside the enumeration
 *      rejects as unknown.
 *   3. The three-kind observation-only exemption: `activity.observed`,
 *      `trust.epoch.observed`, and `control.plane.mirror.recorded` never
 *      advance the expected journal revision that fences, assertions, and
 *      confirmations bind. The mirror kind is simultaneously reserved: the
 *      exemption records where it will sit once its owning unit defines it,
 *      and until then the reserved rejection wins.
 *
 * Adding any kind, state, or journal — active or reserved — is a spine
 * contract revision requiring contract-freeze owner approval. The vocabulary
 * tests assert these lists element by element to make a silent edit
 * impossible.
 */
declare const JOURNALS: readonly ["intake", "delivery", "maintenance"];
type Journal = (typeof JOURNALS)[number];
declare const INTAKE_STATES: readonly ["draft_scope", "awaiting_clarification", "awaiting_confirmation", "validating_acceptance", "accepted_contract", "blocked", "abandoned"];
type IntakeState = (typeof INTAKE_STATES)[number];
declare const DELIVERY_STATES: readonly ["accepted", "preparing", "planning", "implementing", "validating", "remediating", "reviewing", "compounding", "admitting", "recording", "ready", "awaiting_approval", "acting", "completed", "blocked", "security_blocked", "cancellation_requested", "action_succeeded_verification_failed", "cancelled", "failed"];
type DeliveryState = (typeof DELIVERY_STATES)[number];
/** The suspended-or-terminal variants, reachable only through typed transitions. */
declare const SUSPENDED_DELIVERY_STATES: readonly ["blocked", "security_blocked", "cancellation_requested", "awaiting_approval", "action_succeeded_verification_failed"];
declare const TERMINAL_DELIVERY_STATES: readonly ["completed", "cancelled", "failed"];
/** Host activity is tracked separately and never changes the delivery state. */
declare const HOST_ACTIVITY_STATES: readonly ["active", "paused", "unknown", "cancellation_pending"];
type HostActivityState = (typeof HOST_ACTIVITY_STATES)[number];
interface EventKindEntry {
    readonly journal: Journal;
    readonly kind: string;
    readonly status: "active" | "reserved";
    /** Never advances the expected journal revision. Delivery journal only. */
    readonly observationOnly: boolean;
    /** For reserved kinds: the plan unit that owns the payload definition. */
    readonly owner?: string;
}
declare const EVENT_VOCABULARY: readonly EventKindEntry[];
/** The three-kind observation-only exemption, verbatim. */
declare const OBSERVATION_ONLY_KINDS: readonly ["activity.observed", "trust.epoch.observed", "control.plane.mirror.recorded"];
type EventClassification = {
    readonly status: "active";
    readonly observationOnly: boolean;
} | {
    readonly status: "reserved";
} | {
    readonly status: "unknown";
    readonly knownIn: readonly Journal[];
};
/**
 * Classifies one (journal, kind) pair against the frozen vocabulary. A pair
 * outside the enumeration is unknown even when the kind exists in another
 * journal — `knownIn` names the kind's real homes so the rejection message
 * can say so without ever accepting the pair.
 */
declare function classifyEventKind(journal: string, kind: string): EventClassification;

/**
 * Product composition pin and local product-trust state — the two contracts
 * that make "which bytes are we running, and are they still trusted" a
 * validated value instead of prose.
 *
 * The `agent-skills` workflow-graph/result and provider-rail schemas are
 * PINNED here by digest, exactly as the composition baseline recorded them —
 * never re-authored. A change to any pinned identity is a new composition,
 * not an edit to this file.
 *
 * The trust predicate is deliberately isolated behind ONE validation port
 * (`ProductTrustPort`): every trust check site consumes the port, so the
 * later detached-signature predicate replaces `localDigestTrustPredicate`
 * without touching reducers or check sites. V1 trust is local by design and
 * says so verbatim: the label is `local-digest / operator-pinned`, claiming
 * exactly what was verified and nothing more — mirroring the L0 attestation
 * discipline.
 */

declare const PRODUCT_COMPOSITION_PIN_SPEC = "product-composition-pin/1";
declare const PRODUCT_TRUST_STATE_SPEC = "product-trust-state/1";
/** Frozen wording. The manifest and every delivery record declare it verbatim. */
declare const PRODUCT_TRUST_LABEL = "local-digest / operator-pinned";
/**
 * The exact qualified `agent-skills` release the composition exposes.
 * Pinned, not re-authored: these identities are read off a built release,
 * never edited by hand. Advancing them is a new composition — which is
 * exactly what advancing the shipped reviewer charter set produces, since the
 * charters are archive content and the `workflowGraphSha256` below is
 * unchanged across that advance.
 */
declare const PINNED_AGENT_SKILLS: Readonly<{
    readonly releaseId: "core-v1";
    readonly profile: "core";
    readonly archiveSha256: "9ce12f12c4096e346154ef377fc89187c9168944d6e59b9d6596feb98e57d2ed";
    readonly metadataSha256: "b2b008cb5a87f2bd83696cb43e908badb305b750a0b013a8c89d118bf16f9007";
    readonly workflowGraphSha256: "49630e23374f0375cb7d019ea024bcd5ea0c284feb8dc124b393b60f6e8d9aa7";
    readonly provenanceLockSha256: "0872fab0e891c7304f5c6ab9c19298902b386935d69f9296e28106c730192bfa";
    readonly protocolVersion: "delivery-provider-rails/1";
}>;
declare function validateCompositionPin(value: unknown): SpineVerdict;
declare function validateProductTrustState(value: unknown): SpineVerdict;
interface ProductTrustState {
    readonly spec: typeof PRODUCT_TRUST_STATE_SPEC;
    readonly installationId: string;
    readonly pinnedManifestDigest: string;
    /**
     * Every generation this installation ever accepted under its local trust
     * policy — the only pool operator rollback and re-pinning may select from,
     * and what keeps a delivery pinned to an older accepted generation
     * execution-eligible after the active pin moves on. Membership never makes
     * revoked bytes eligible: revocation always wins.
     */
    readonly acceptedGenerationDigests: readonly string[];
    readonly revokedGenerationDigests: readonly string[];
    readonly revocationEpoch: number;
    readonly highWaterMark: number;
}
type TrustDecision = {
    readonly eligible: true;
} | {
    readonly eligible: false;
    readonly reason: "revoked" | "not_pinned";
};
/**
 * The single validation port every trust check site consumes. A conforming
 * fixture — or the eventual detached-signature predicate — replaces the
 * implementation without touching any consumer.
 */
interface ProductTrustPort {
    evaluate(generationDigest: string, state: ProductTrustState): TrustDecision;
}
/**
 * V1's digest predicate: a generation is execution-eligible exactly when it
 * is not revoked and is either the operator-pinned manifest digest or a
 * generation this installation previously accepted (which is what keeps a
 * delivery pinned to an older accepted generation running after the active
 * pin advances). Revocation wins over both — revoked bytes remain retained
 * for audit but are never eligible, whatever else claims otherwise.
 */
declare const localDigestTrustPredicate: ProductTrustPort;

/**
 * The accepted scoped-delivery contract and the outcome-verification claim.
 *
 * The contract's shape is identical whether produced by direct operator
 * handoff or by later iterative intake — there are no intake-only members —
 * and an ACCEPTED contract carries no unresolved decisions: material
 * ambiguity remains in intake and cannot begin mutation.
 *
 * Outcome verification maps each acceptance criterion to exact candidate-
 * bound evidence and one disposition. Zero review attempts reject, duplicate
 * attempt identities reject, and every attempt binds a context digest so
 * reviewer independence stays falsifiable (rejecting same-context
 * re-invocation is the admission sensors' job, on top of this shape).
 */

declare const SCOPED_DELIVERY_CONTRACT_SPEC = "scoped-delivery-contract/1";
declare const OUTCOME_VERIFICATION_SPEC = "outcome-verification/1";
declare const FINISH_LINES: readonly ["merge-ready", "merge", "deploy"];
declare const CRITERION_DISPOSITIONS: readonly ["passed", "amended-waived", "blocked"];
declare const EVIDENCE_KINDS: readonly ["sensor", "artifact", "review", "operation"];
declare const REVIEW_VERDICTS: readonly ["approved", "findings"];
interface AcceptedContract {
    readonly spec: typeof SCOPED_DELIVERY_CONTRACT_SPEC;
    readonly contractId: string;
    readonly task: string;
    readonly intendedOutcome: string;
    readonly acceptanceCriteria: readonly {
        readonly criterionId: string;
        readonly statement: string;
    }[];
    readonly nonGoals: readonly string[];
    readonly repository: {
        readonly repositoryId: string;
        readonly baseRef: string;
    };
    readonly requestedFinishLine: (typeof FINISH_LINES)[number];
    readonly requestedAuthority: readonly string[];
    readonly unresolvedDecisions: readonly string[];
}
declare function validateAcceptedContract(value: unknown): SpineVerdict;
interface OutcomeCriterion {
    readonly criterionId: string;
    readonly disposition: (typeof CRITERION_DISPOSITIONS)[number];
    readonly evidence: {
        readonly kind: (typeof EVIDENCE_KINDS)[number];
        readonly reference: string;
    };
}
interface OutcomeVerification {
    readonly spec: typeof OUTCOME_VERIFICATION_SPEC;
    readonly contractId: string;
    readonly candidate: {
        readonly treeSha: string;
        readonly deliverableDigest: string;
    };
    readonly criteria: readonly OutcomeCriterion[];
    readonly reviewAttempts: readonly {
        readonly attemptId: string;
        readonly lensId: string;
        readonly contextDigest: string;
        readonly personaDigest: string;
        readonly verdict: (typeof REVIEW_VERDICTS)[number];
    }[];
}
declare function validateOutcomeVerification(value: unknown): SpineVerdict;
/**
 * Every acceptance criterion of the contract must carry exactly one
 * disposition in the verification — an unmapped criterion is unverified and
 * blocks, and a verified criterion that the contract never named is a
 * mapping to nothing.
 */
declare function checkOutcomeCoversContract(outcome: OutcomeVerification, contract: AcceptedContract): SpineVerdict;
interface PolicyGrantView {
    readonly grantedFinishLines: readonly string[];
    readonly grantedAuthority: readonly string[];
}
/**
 * The contract can request only a subset of what the compiled policy grants.
 * Policy always wins, and ABSENCE OF A GRANT IS DENIAL — nothing a model or
 * agent writes into a contract or result can widen this.
 */
declare function checkContractWithinPolicy(contract: AcceptedContract, policy: PolicyGrantView): SpineVerdict;

declare const POLICY_SNAPSHOT_SPEC = "policy-snapshot/1";
declare const REVIEW_LENS_CATEGORIES: readonly ["outcome-correctness", "testing-policy", "additional"];
interface PolicySnapshot {
    readonly spec: typeof POLICY_SNAPSHOT_SPEC;
    readonly policyDigest: string;
    readonly repositoryId: string;
    readonly productTrustRevocationEpoch: number;
    readonly repositoryAuthorityRevocationEpoch: number;
    readonly grantedFinishLines: readonly (typeof FINISH_LINES)[number][];
    readonly grantedAuthority: readonly string[];
    readonly reviewLenses: readonly {
        readonly lensId: string;
        readonly category: (typeof REVIEW_LENS_CATEGORIES)[number];
        /** The reviewer charter this lens hands its reviewer, and the exact bytes it resolved to. */
        readonly personaId: string;
        readonly personaDigest: string;
    }[];
    readonly obligations: readonly {
        readonly obligationId: string;
    }[];
}
declare function validatePolicySnapshot(value: unknown): SpineVerdict;

/**
 * The fenced host invocation and the reviewer attempt.
 *
 * A fence is an atomic, monotonically increasing acquisition bound to the
 * delivery, the expected journal revision, the host task, the worktree, the
 * candidate (branch ref VALUE as well as tree — a stale host writing the old
 * branch ref must produce a detectable mismatch, never silent adoption), the
 * policy snapshot, and the authority epoch. It also declares its observation
 * lifetime: an invocation-fence observation older than this many seconds
 * marks host activity `unknown` lazily — the shape carries the declaration;
 * no spine decision ever consults a clock.
 *
 * A reviewer attempt binds a context digest so independence is falsifiable:
 * distinct attempt identities with identical contexts are exactly what the
 * admission sensors exist to reject.
 */

declare const INVOCATION_FENCE_SPEC = "invocation-fence/1";
declare const REVIEWER_ATTEMPT_SPEC = "reviewer-attempt/1";
declare function validateInvocationFence(value: unknown): SpineVerdict;
declare function validateReviewerAttempt(value: unknown): SpineVerdict;

declare const EXECUTION_GRANT_SPEC = "execution-grant/1";
declare const GRANT_ATTESTATION_SPEC = "grant-attestation/1";
declare const GRANT_PROFILES: readonly ["checkpoint", "intake"];
type GrantProfile = (typeof GRANT_PROFILES)[number];
declare function validateExecutionGrant(value: unknown): SpineVerdict;
/** The digest an attestation binds: SHA-256 over the grant's RFC 8785 bytes. */
declare function grantDigest(grant: unknown): string;
declare function validateGrantAttestation(value: unknown): SpineVerdict;

/**
 * The operator-confirmation contract, both frozen classes:
 *
 *   - `contract-confirmation` (intake handoff): binds origin, the intake
 *     draft, action, expiry, a single-use nonce, the product-trust revocation
 *     epoch, and the EXACT normalized-contract digest presented to the
 *     operator. It is minted at presentation — before `validating_acceptance`
 *     — so the repository authority epoch does not exist yet and is recorded
 *     absent-by-state, as are every delivery-scoped identity.
 *   - `takeover-authorization`: binds origin, the delivery, action, expiry, a
 *     single-use nonce, BOTH revocation epochs, the superseded invocation
 *     fence, the expected journal revision, and the target base commit —
 *     rejecting consumption on any mismatch is the reducer's job; carrying
 *     the exact bindings is this contract's.
 *
 * Neither class ever binds a new invocation fence or a candidate: both are
 * minted before those exist, so `boundInvocationFence` and
 * `boundCandidateTreeSha` are recorded explicitly absent-by-state in both
 * classes. Uniqueness of the nonce is a consumption rule, not a shape rule.
 */

declare const OPERATOR_CONFIRMATION_SPEC = "operator-confirmation/1";
declare const CONFIRMATION_CLASSES: readonly ["contract-confirmation", "takeover-authorization"];
type ConfirmationClass = (typeof CONFIRMATION_CLASSES)[number];
declare function validateOperatorConfirmation(value: unknown): SpineVerdict;
/** The class the given confirmation value declares, when it declares one. */
declare function confirmationClassOf(value: unknown): ConfirmationClass | undefined;

/**
 * The minimal repository capability descriptor and sensor-result contract the
 * walking skeleton's one trusted sensor consumes. The capability taxonomy is
 * deliberately a single frozen kind here — broadening it is the adapter
 * SDK's business and does not change this frozen RESULT shape.
 *
 * The result is candidate-bound and closed: it reports an outcome about the
 * candidate and nothing else. There is no member through which a result
 * could carry, request, or grant authority — an agent result cannot grant
 * authority, and the closed grammar is where that starts being mechanical.
 */

declare const CAPABILITY_DESCRIPTOR_SPEC = "capability-descriptor/1";
declare const SENSOR_RESULT_SPEC = "sensor-result/1";
/** The skeleton's frozen capability taxonomy: exactly one kind. */
declare const CAPABILITY_KINDS: readonly ["sensor"];
declare const SENSOR_OUTCOMES: readonly ["passed", "failed"];
declare function validateCapabilityDescriptor(value: unknown): SpineVerdict;
declare function validateSensorResult(value: unknown): SpineVerdict;

/**
 * The trusted host-control binding's admission decisions, model-external by
 * construction: pure functions a binding evaluates outside the model-visible
 * tool and shell surface. Nothing here performs I/O, consults a clock, or
 * launches a process — the import-boundary sensor enforces the first two and
 * the process-instrumentation test in the sibling suite proves the third.
 *
 * The enforced property is that no tool ever executes outside the currently
 * attested grant. The mechanism is deliberately re-evaluation, not caching:
 * the per-invocation interceptor decision re-runs the whole admission check
 * against the binding's CURRENT expectation, so a fence supersession, a trust
 * revocation, or a projection re-digest changes the expectation and every
 * attestation minted before the change stops matching — stale or sibling
 * attestations open no tools, and revocation re-denies on the next invocation
 * without any callback plumbing.
 *
 * The grant and attestation shapes are the frozen contract spine's; this
 * module consumes them and never re-authors them. Expiry is compared
 * lexicographically over the spine's fixed-width UTC instant grammar against
 * a caller-supplied observation instant — no decision here reads a clock.
 *
 * Operator confirmations are excluded from every grant by construction: a
 * confirmation-class operation is denied inside any grant, even a grant whose
 * bytes claim to allow it, because the confirmation channel is served only by
 * a binding-owned facade outside the model-visible surface. The echo-challenge
 * evaluation models that channel: completing a confirmation requires echoing a
 * single-use challenge on the same open, interactive, binding-owned channel it
 * was rendered on — which is exactly what a detached descendant of an ended
 * invocation, a piped stdin, or a model-driven tool call cannot do.
 */

declare const ADMISSION_DENIAL_CODES: readonly ["missing_grant", "missing_attestation", "malformed_grant", "malformed_attestation", "malformed_expectation", "empty_grant", "profile_mismatch", "host_version_mismatch", "grant_digest_mismatch", "trust_epoch_mismatch", "attestation_expired", "fence_mismatch", "delivery_mismatch", "workspace_mismatch", "projection_digest_mismatch", "discovery_configuration_mismatch", "installation_mismatch", "active_profile_mismatch", "intake_draft_mismatch"];
type AdmissionDenialCode = (typeof ADMISSION_DENIAL_CODES)[number];
declare const TOOL_DENIAL_CODES: readonly ["not_admitted", "confirmation_operation_excluded", "capability_not_granted", "operation_forbidden", "unnormalized_path", "protected_path", "write_outside_grant"];
type ToolDenialCode = (typeof TOOL_DENIAL_CODES)[number];
declare const CONFIRMATION_DENIAL_CODES: readonly ["channel_closed", "wrong_channel", "non_interactive_refused", "model_visible_surface_refused", "challenge_mismatch", "challenge_consumed", "challenge_expired"];
type ConfirmationDenialCode = (typeof CONFIRMATION_DENIAL_CODES)[number];
interface AdmissionDenial {
    readonly code: AdmissionDenialCode;
    readonly message: string;
}
/**
 * The binding-owned current state an attestation must match. The caller mints
 * this from its own durable state, never from host- or candidate-writable
 * bytes; `observedAt` is the caller's observation instant in the spine's
 * fixed-width UTC grammar.
 */
interface CheckpointAdmissionExpectation {
    readonly profile: "checkpoint";
    readonly hostVersion: string;
    readonly productTrustRevocationEpoch: number;
    readonly observedAt: string;
    readonly deliveryId: string;
    readonly invocationFence: number;
    readonly workspaceId: string;
    readonly projectionDigest: string;
    readonly discoveryConfigurationDigest: string;
    readonly registeringInstallationId: string;
    readonly activeProfile: string;
}
interface IntakeAdmissionExpectation {
    readonly profile: "intake";
    readonly hostVersion: string;
    readonly productTrustRevocationEpoch: number;
    readonly observedAt: string;
    readonly intakeDraftId: string;
}
type AdmissionExpectation = CheckpointAdmissionExpectation | IntakeAdmissionExpectation;
interface AdmittedInvocation {
    readonly admitted: true;
    readonly profile: GrantProfile;
    readonly grantDigest: string;
    readonly allowedCapabilities: readonly string[];
    readonly writablePaths: readonly string[];
    readonly protectedPaths: readonly string[];
    readonly forbiddenOperations: readonly string[];
    /** Only a checkpoint-profile grant with at least one capability mutates. */
    readonly mutationCapable: boolean;
}
interface DeniedInvocation {
    readonly admitted: false;
    readonly denials: readonly AdmissionDenial[];
}
type AdmissionDecision = AdmittedInvocation | DeniedInvocation;
/**
 * The deny-until-attested admission check. Missing, empty, malformed, or
 * mismatched inputs all fail closed; only an attestation bound to the exact
 * current expectation — fence, delivery, workspace, grant digest, projection
 * digest, discovery-configuration digest, installation, profile, epoch — and
 * to the exact bytes of the presented grant admits anything.
 */
declare function evaluateHostAdmission(expectation: AdmissionExpectation, grant: unknown, attestation: unknown): AdmissionDecision;
/** The prefix every operator-confirmation operation lives under (D15). */
declare const CONFIRMATION_OPERATION_PREFIX = "operator-confirmation.";
interface ToolInvocationRequest {
    /** The host tool / MCP capability name being invoked. */
    readonly capability: string;
    /** Optional operation label, matched against the grant's forbidden set. */
    readonly operation?: string;
    /** Workspace-relative paths the invocation intends to write, caller-normalized. */
    readonly writes?: readonly string[];
}
interface ToolDenial {
    readonly code: ToolDenialCode;
    readonly message: string;
    /** For `not_admitted`: why the underlying admission failed. */
    readonly admissionDenials?: readonly AdmissionDenial[];
}
type ToolInvocationDecision = {
    readonly allowed: true;
} | {
    readonly allowed: false;
    readonly denials: readonly ToolDenial[];
};
/**
 * The interceptor decision for one tool invocation: re-evaluates admission
 * against the binding's CURRENT expectation, then scopes the invocation to
 * the attested grant's contents. Denial is total — a single failing write
 * path denies the whole invocation, and a confirmation-class operation is
 * denied inside any grant regardless of what the grant's bytes claim.
 */
declare function evaluateToolInvocation(expectation: AdmissionExpectation, grant: unknown, attestation: unknown, request: ToolInvocationRequest): ToolInvocationDecision;
/**
 * The binding-owned channel state for one rendered confirmation challenge.
 * The channel closes when its owning invocation ends, the challenge is
 * single-use, and the rendering happens only on the binding's own interactive
 * channel — all three are what a detached descendant cannot satisfy.
 */
interface RenderedConfirmationChallenge {
    readonly channelId: string;
    readonly channelOpen: boolean;
    readonly interactive: boolean;
    readonly challenge: string;
    readonly consumed: boolean;
    readonly expiry: string;
}
interface ConfirmationEchoAttempt {
    readonly presentedChallenge: string;
    readonly presentedOnChannelId: string;
    readonly observedAt: string;
    /** True when the echo arrived through any model-visible surface (CLI arg, tty write, MCP tool, subprocess). */
    readonly viaModelVisibleSurface: boolean;
    /** False for piped, non-interactive, or inherited-descriptor input. */
    readonly interactive: boolean;
}
interface ConfirmationDenial {
    readonly code: ConfirmationDenialCode;
    readonly message: string;
}
type ConfirmationEchoDecision = {
    readonly completed: true;
} | {
    readonly completed: false;
    readonly denials: readonly ConfirmationDenial[];
};
declare function evaluateConfirmationEcho(rendered: RenderedConfirmationChallenge, attempt: ConfirmationEchoAttempt): ConfirmationEchoDecision;
interface AssertionSourceAvailability {
    readonly hostNative: boolean;
    readonly osNative: boolean;
}
interface LaneAvailability {
    /** Waiver confirmation, update, rollback, trust-state maintenance, merge/deploy approvals. */
    readonly sensitiveApprovals: "available" | "fail_closed_no_assertion_source";
    /** Contract confirmation and takeover fail closed until a producer is qualified. */
    readonly operatorConfirmations: "available" | "fail_closed_no_qualified_producer";
    readonly mergeReadyLane: "available";
}
/**
 * Sensitive approval and operator-confirmation availability are independent:
 * a native assertion source does not manufacture a qualified confirmation
 * producer, while losing either lane leaves merge-ready adjudication intact.
 */
declare function assertionLaneAvailability(sources: AssertionSourceAvailability): LaneAvailability;

/**
 * THE HOST-INTEGRATION CONFORMANCE CONTRACT.
 *
 * Host-specific delegation is deliberately non-normative: how a host applies a
 * grant, scopes discovery, sequences tools, or delegates to its own subagents
 * is its own business and this contract says nothing about it. What IS
 * normative is the set of normalized outcomes below. A future host qualifies
 * by producing them, not by resembling any host that already does.
 *
 * The contract is stated as scenario discriminators rather than mechanisms.
 * The runner hands a port a host-neutral scenario ("a stale-fence
 * attestation"); the port maps it onto whatever its own admission surface
 * calls that, and returns a normalized outcome. Nothing in this module knows
 * about settings files, hooks, sandboxes, worktrees, or approval protocols.
 *
 * Two properties are load-bearing and easy to lose:
 *
 *   - DENIAL IS THE DEFAULT. Every negative case asserts a denial, so a host
 *     that fails open on any of them is caught here rather than in production.
 *   - THE RESUME POSITION IS DERIVED, NOT DECLARED. A host reports its graded
 *     descendant-teardown status; claiming a resume position richer than that
 *     status supports is a conformance failure, which is what keeps an
 *     unverified host out of same-workspace resume.
 */
declare const HOST_ADMISSION_SCENARIOS: readonly ["current", "before-attestation", "stale-fence", "sibling-delivery"];
type HostAdmissionScenario = (typeof HOST_ADMISSION_SCENARIOS)[number];
declare const HOST_INTERCEPTION_SCENARIOS: readonly ["granted-capability", "ungranted-capability", "protected-path-write", "operator-confirmation"];
type HostInterceptionScenario = (typeof HOST_INTERCEPTION_SCENARIOS)[number];
interface NormalizedAdmission {
    readonly outcome: "admitted" | "denied";
    /** Denial codes, for diagnosis only — the contract asserts the outcome. */
    readonly codes?: readonly string[];
}
interface NormalizedInterception {
    readonly outcome: "allowed" | "denied";
    readonly codes?: readonly string[];
}
interface NormalizedTermination {
    readonly provenance: "graceful";
    readonly descendantTeardown: "verified" | "unverified";
    readonly resumeEligibility: "same-workspace" | "fresh-worktree-only";
}
interface NormalizedTeardown {
    readonly outcome: "torn-down" | "failed";
    /** Paths the binding wrote that still exist after teardown; must be empty. */
    readonly residue: readonly string[];
}
/**
 * The operations a host integration must expose to qualify. Every one is
 * model-external by construction: a port implementation is the trusted
 * binding's surface, never a tool the session can call.
 */
interface HostIntegrationPort {
    readonly hostId: string;
    readonly hostVersion: string;
    admit(scenario: HostAdmissionScenario): Promise<NormalizedAdmission>;
    intercept(scenario: HostInterceptionScenario): Promise<NormalizedInterception>;
    terminate(): Promise<NormalizedTermination>;
    tearDown(): Promise<NormalizedTeardown>;
}
interface HostConformanceCase {
    readonly caseId: string;
    readonly statement: string;
}
/** The frozen case list; adding or dropping one is a contract change. */
declare const HOST_CONFORMANCE_CASES: readonly HostConformanceCase[];
interface HostConformanceResult {
    readonly caseId: string;
    readonly satisfied: boolean;
    readonly detail: string;
}
/**
 * Runs the frozen contract against one port and returns a normalized result
 * per case. It never throws on a non-conforming host: a thrown error is itself
 * a conformance failure, reported as one.
 */
declare function runHostIntegrationConformance(port: HostIntegrationPort): Promise<readonly HostConformanceResult[]>;

declare function createFakeHostConformancePort(input: {
    readonly descendantTeardown: "verified" | "unverified";
}): HostIntegrationPort;

declare const PROVIDER_REVIEW_HANDOFF_SPEC: "provider-review-handoff/1";
declare const PROVIDER_REVIEW_RESULT_SPEC: "provider-review-result/1";
type ProviderReviewVerdict = "approved" | "changes_requested";
type ProviderReviewTerminalState = "completed" | "failed" | "timed_out" | "interrupted";
/** Supplied by the host and kept outside model-visible prompts, files, and tools. */
interface ProviderReviewCapability {
    readonly id: string;
    readonly secret: string;
}
interface ProviderReviewFinding {
    readonly id: string;
    readonly severity: "P0" | "P1" | "P2" | "P3";
    readonly scope: "in_contract" | "adjacent" | "expansion";
    readonly actionable: boolean;
    readonly blocking: boolean;
    readonly disposition: "resolved" | "advisory" | "pre_existing" | "deferred" | "unresolved" | "ignored";
    readonly deferredIssueId?: string;
}
interface ProviderReviewCandidate {
    readonly vcs: "git";
    readonly treeSha: string;
    readonly headSha: string;
    readonly deliverable: {
        readonly digest: string;
        readonly identity: string;
    };
    readonly base: {
        readonly ref: string;
        readonly tipSha: string;
        readonly mergeBaseSha: string;
    };
    readonly workspaceId: string;
}
interface ProviderReviewHandoffReviewer {
    readonly attemptId: string;
    readonly lensId: string;
    readonly personaId: string;
    readonly personaDigest: string;
    readonly personaBytes: string;
    readonly contextDigest: string;
}
interface ProviderReviewHandoff {
    readonly spec: typeof PROVIDER_REVIEW_HANDOFF_SPEC;
    readonly handoffId: string;
    readonly deliveryId: string;
    readonly provider: {
        readonly id: string;
        readonly version: string;
        readonly runId: string;
        readonly finalPassId: string;
    };
    readonly nativeSessionId: string;
    readonly workspaceId: string;
    readonly fence: number;
    readonly productTrustRevocationEpoch: number;
    readonly candidate: ProviderReviewCandidate;
    readonly promptContextBytes: string;
    readonly promptContextDigest: string;
    readonly reviewer: ProviderReviewHandoffReviewer;
}
interface ProviderReviewResult extends Omit<ProviderReviewHandoff, "spec"> {
    readonly spec: typeof PROVIDER_REVIEW_RESULT_SPEC;
    readonly nativeEnvelopeBytes: string;
    readonly nativeEnvelopeDigest: string;
    readonly terminalState: ProviderReviewTerminalState;
    readonly verdict: ProviderReviewVerdict;
    readonly findings: readonly ProviderReviewFinding[];
}
interface NativeReviewConclusion {
    readonly verdict: ProviderReviewVerdict;
    readonly findings: readonly ProviderReviewFinding[];
}
type ParseFailure = {
    readonly ok: false;
    readonly code: "provider_result_invalid";
    readonly message: string;
};
type ProviderReviewParseResult = {
    readonly ok: true;
    readonly result: ProviderReviewResult;
} | ParseFailure;
type ClaudeCodeReviewAdaptation = {
    readonly ok: true;
    readonly result: ProviderReviewResult;
} | {
    readonly ok: false;
    readonly code: "provider_envelope_invalid" | "provider_session_mismatch" | "provider_prompt_mismatch" | "provider_conclusion_invalid";
    readonly message: string;
};
declare function parseProviderReviewResult(bytes: string): ProviderReviewParseResult;
declare function createProviderReviewHandoff(input: Omit<ProviderReviewHandoff, "spec" | "reviewer" | "promptContextBytes" | "promptContextDigest"> & {
    readonly reviewer: Omit<ProviderReviewHandoffReviewer, "contextDigest">;
    readonly contractBytes: string;
    readonly sensorEvidenceBytes: string;
    readonly reviewInstructionsBytes: string;
}): ProviderReviewHandoff;
declare function adaptClaudeCodeReviewResult(input: {
    readonly handoff: ProviderReviewHandoff;
    readonly submittedPromptContextBytes: string;
    readonly nativeEnvelopeBytes: string;
}): ClaudeCodeReviewAdaptation;

/**
 * The merge-ready finish-line result — the ONLY finish-line result the spine
 * freezes. `merge` and `deploy` results are post-action payloads owned by the
 * finish-line/actions units; a result claiming them here rejects.
 *
 * WHAT THE RESULT BINDS. A merge-ready result is the delivery's terminal
 * success, so it carries every value that success was decided from and nothing
 * that could be re-derived favourably later: the run, the reviewed candidate
 * the outcome verification names, the POST-RECORD candidate and the base it
 * stands on, the compiled policy's digest, the obligations that actually
 * completed, the tracked record's digest, the external verifier's result, and
 * the product-trust level the substrate declares. Two of those are frozen to a
 * single spelling on purpose — a result exists only when the external verifier
 * PASSED, and only under the substrate's own declared trust label — so a
 * caller cannot write a weaker claim into the journal and have it accepted.
 *
 * `checkMergeReadyAgainstOutcome` enforces the two rules that keep a blanket
 * waiver from producing delivery success: every criterion must be resolved
 * (`passed` or `amended-waived`, never `blocked`), and at least one positive
 * criterion must have PASSED.
 */

declare const FINISH_LINE_RESULT_SPEC = "finish-line-result/1";
/**
 * The external actions a finish line beyond merge-ready would invoke. Frozen
 * here because the journal's post-action payloads name them and the spine may
 * not reach into the policy module; the policy module's grant model consumes
 * this same list rather than re-authoring one.
 */
declare const EXTERNAL_ACTIONS: readonly ["pr-creation", "merge", "deploy"];
type ExternalAction = (typeof EXTERNAL_ACTIONS)[number];
interface FinishLineResult {
    readonly spec: typeof FINISH_LINE_RESULT_SPEC;
    readonly finishLine: "merge-ready";
    readonly deliveryId: string;
    /** The reviewed candidate — the one the outcome verification names. */
    readonly candidate: {
        readonly treeSha: string;
        readonly deliverableDigest: string;
    };
    /** The candidate after the tracked record was committed, and its base tip. */
    readonly recordedCandidate: {
        readonly treeSha: string;
        readonly baseTipSha: string;
    };
    readonly policyDigest: string;
    readonly completedObligations: readonly string[];
    readonly trackedRecordDigest: string;
    readonly externalVerification: "passed";
    readonly productTrustLabel: typeof PRODUCT_TRUST_LABEL;
    readonly outcomeVerificationDigest: string;
    readonly mergeReadyObligationsSatisfied: true;
}
declare function validateFinishLineResult(value: unknown): SpineVerdict;
/**
 * A merge-ready result is only as good as the outcome verification it binds:
 * the digest must recompute, the candidates must agree, no criterion may
 * remain blocked, and at least one positive criterion must have passed.
 */
declare function checkMergeReadyAgainstOutcome(result: FinishLineResult, outcome: OutcomeVerification): SpineVerdict;

declare const JOURNAL_ENTRY_SPEC = "journal-entry/1";
declare const WORKSPACE_DISPOSITIONS: readonly ["quarantined", "takeover", "reconciled", "prior_host_termination_unverified"];
declare const APPROVAL_REQUEST_KINDS: readonly ["waiver", "amendment"];
/**
 * Termination provenance has two distinct forms, and only ONE of them is
 * expressible. Graceful provenance is a trusted host-runtime lifecycle event
 * at clean end. Crash provenance is structurally unavailable in V1 — no
 * supported host supplies it and no daemon exists to observe it — so the
 * vocabulary carries no discriminator for it and no record can claim one.
 */
declare const TERMINATION_PROVENANCE_KINDS: readonly ["graceful"];
/** Whether the host's descendant teardown was verified for this host version. */
declare const DESCENDANT_TEARDOWN_STATUSES: readonly ["verified", "unverified"];
/** The two resume positions the capability ladder defines. */
declare const RESUME_ELIGIBILITIES: readonly ["same-workspace", "fresh-worktree-only"];
/** Whether the policy required an approval for the action the intent names. */
declare const ACTION_APPROVALS: readonly ["required", "not-required"];
/**
 * What the host observed of the external action. `indeterminate` is a first-
 * class outcome, not an error: a lost response leaves an action that may well
 * have happened, and recording that honestly is what keeps it from being
 * repeated.
 */
declare const EXTERNAL_ACTION_OUTCOMES: readonly ["succeeded", "failed", "indeterminate"];
/**
 * How the required post-action verification resolved. `not-attempted` means a
 * required check DID NOT RUN — it is never the spelling for "there was nothing
 * to verify", which records `passed`. The reducer reads it that way at both
 * the terminal edge and the next-action edge: an action whose required
 * verification did not run is not reconciled, and the delivery leaves through
 * `blocked` rather than through success or another action.
 */
declare const ACTION_VERIFICATIONS: readonly ["passed", "failed", "not-attempted"];
declare function validateJournalEntry(value: unknown): SpineVerdict;

/**
 * Pure reducers over the frozen state tables — no I/O, no clock, no ambient
 * anything. A journal is an ordered value; the reducer either accepts every
 * entry under the frozen discipline or reports typed rejections.
 *
 * THE DELIVERY MATRIX. `DELIVERY_TRANSITION_TABLE` is the plan's conditional
 * transition table row for row, with each row's condition text carried
 * verbatim as documentation of WHY the edge exists. On top of the table sit
 * exactly the typed entries the State and Authority Model names in prose:
 * product-trust revocation enters `security_blocked` from any non-terminal
 * state; a typed blocker enters `blocked`; cancellation enters
 * `cancellation_requested` and completes to `cancelled`; leaving
 * `security_blocked` requires full re-preparation (`preparing`); and a
 * blocked delivery resumes only at its last trustworthy checkpoint — a
 * journal-dependent rule the reducer enforces, not a static edge. Everything
 * else rejects, `failed` has NO entry whatsoever (the discriminator is
 * frozen verbatim; inventing an entry condition would be a spine revision),
 * and terminal states have no exits.
 *
 * REVISIONS, FENCES, KEYS. Every entry names the journal revision it expects;
 * the three observation-only kinds never advance it. Fences are monotonic
 * per delivery — an older or equal fence rejects permanently. Idempotency
 * keys are unique per journal — a replayed append is detected, never
 * double-applied. Authority bindings move ONLY on `policy.snapshot.bound`
 * and `generation.pinned`: no stage result, operation result, or any other
 * agent-produced append can touch them, which is the reducer half of "an
 * agent result cannot grant authority".
 */

interface DeliveryTransitionRow {
    readonly from: DeliveryState;
    readonly to: DeliveryState;
    /** The plan's condition text, verbatim, as documentation of the edge. */
    readonly condition: string;
}
declare const DELIVERY_TRANSITION_TABLE: readonly DeliveryTransitionRow[];
/**
 * The static half of the frozen matrix. The one journal-dependent rule —
 * `blocked` resuming at the delivery's last trustworthy checkpoint — lives in
 * the reducer, so here every `blocked -> *` edge except its enumerated rows
 * is false.
 */
declare function isDeliveryTransitionValid(from: DeliveryState, to: DeliveryState): boolean;
declare function isIntakeTransitionValid(from: IntakeState, to: IntakeState): boolean;
interface DeliveryJournalState {
    readonly deliveryId: string;
    readonly state: DeliveryState;
    readonly expectedRevision: number;
    readonly lastFence: number;
    readonly policyDigest?: string;
    readonly policyBindingDigest?: string;
    readonly authorityEpoch?: number;
    readonly generationDigest?: string;
    /** The contract identity in force, once a confirmed amendment created one. */
    readonly contractId?: string;
    /** The last non-suspended state — where a blocked delivery may resume. */
    readonly lastActiveState: DeliveryState;
}
type ReduceDeliveryResult = {
    readonly ok: true;
    readonly state: DeliveryJournalState;
} | {
    readonly ok: false;
    readonly rejections: readonly SpineRejection[];
};
declare function reduceDeliveryJournal(entries: readonly unknown[]): ReduceDeliveryResult;
/**
 * The installation-scoped maintenance journal: an append log under the same
 * envelope grammar and revision/idempotency discipline, with no state
 * machine — maintenance records are facts about the installation, and the
 * retention family's records deliberately outlive the deliveries they name.
 * No maintenance kind is observation-only, so every entry advances the
 * revision.
 */
interface MaintenanceJournalState {
    readonly subjectId: string;
    readonly expectedRevision: number;
}
interface IntakeJournalState {
    readonly intakeId: string;
    readonly state: IntakeState;
    readonly expectedRevision: number;
    readonly contractConfirmed: boolean;
    /** How many clarification exchanges the scope workflow has retained. */
    readonly clarificationCount: number;
    /** The digest of the most recently retained draft, when one is retained. */
    readonly lastDraftDigest?: string;
}
type ReduceIntakeResult = {
    readonly ok: true;
    readonly state: IntakeJournalState;
} | {
    readonly ok: false;
    readonly rejections: readonly SpineRejection[];
};
declare function reduceIntakeJournal(entries: readonly unknown[]): ReduceIntakeResult;

declare const COMPOSITION_MANIFEST_SPEC = "composition-manifest/1";
/** Exactly two profiles; the fixture profile is production-rejected. */
declare const COMPOSITION_PROFILES: readonly ["production", "confirmation-fixture"];
type CompositionProfile = (typeof COMPOSITION_PROFILES)[number];
/** Valid only in disposable-repository qualification runs. */
declare const CONFIRMATION_FIXTURE_PROFILE: CompositionProfile;
/**
 * The supported contract-version families the pin binds, at the versions the
 * frozen spine ships today. `controlPlane` is deliberately `reserved/0`: the
 * control-plane port has no defined contract yet, and claiming one would
 * claim more than was verified.
 */
declare const SUPPORTED_CONTRACT_VERSIONS: Readonly<{
    readonly policy: "policy-snapshot/1";
    readonly scopedWork: "scoped-delivery-contract/1";
    readonly run: "journal-entry/1";
    readonly workflowResult: "stage-result-ref/1";
    readonly event: "journal-entry/1";
    readonly controlPlane: "reserved/0";
}>;
interface CompositionInventoryEntry {
    /** Normalized, '/'-separated path relative to the generation root. */
    readonly path: string;
    readonly sha256: string;
}
interface BuildCompositionManifestInput {
    readonly compositionProfile: CompositionProfile;
    readonly compositionSequence: number;
    readonly productVersion: string;
    readonly harnessModuleVersions: Readonly<Record<string, string>>;
    readonly inventory: readonly CompositionInventoryEntry[];
}
/** The substrate's rejection vocabulary widens the spine's, never edits it. */
type SubstrateRejectionCode = SpineRejectionCode | "closure_digest_mismatch";
interface SubstrateRejection {
    readonly code: SubstrateRejectionCode;
    readonly pointer: string;
    readonly message: string;
}
type SubstrateVerdict = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly rejections: readonly SubstrateRejection[];
};
declare function buildCompositionManifest(input: BuildCompositionManifestInput): Record<string, unknown>;
/** The manifest's bytes are its canonical JSON — same inputs, same bytes. */
declare function compositionManifestBytes(manifest: Record<string, unknown>): string;
/** The generation digest: the SHA-256 of the manifest's canonical bytes. */
declare function generationDigestOf(manifestBytes: string): string;
declare function validateCompositionManifest(value: unknown): SubstrateVerdict;

/**
 * The pure half of the installation-scoped product trust store.
 *
 * The store itself is one file inside the installation namespace, owned by
 * the product installation and covered by owner-only protections; the
 * installer half (`installer.ts`) does the reading and writing. This module
 * makes the three decisions that must be exhaustively testable without a
 * filesystem:
 *
 *   - PARSING that fails closed: bytes that are not JSON, or a document
 *     outside the frozen `product-trust-state/1` grammar, are `corrupt` —
 *     never partially adopted, never re-initialized.
 *   - THE FIRST-INSTALL DISCRIMINATOR. Epoch zero exists only on a genuinely
 *     first installation: no trust store, no install receipt, and none of the
 *     other installation artifacts (generation roots, update journal,
 *     active/rollback pointers). A missing, deleted, or unreadable store or
 *     receipt alongside ANY of those fails closed rather than initializing —
 *     deleting trust state must never manufacture a fresh epoch.
 *   - NO-DOWNGRADE against the persisted high-water mark: an older
 *     composition sequence can never silently replace the active generation.
 */

/** Presence of one artifact class, as observed by the installer. */
type ArtifactPresence = "absent" | "corrupt" | "valid";
/** The other artifacts whose survival implies a prior trust store. */
declare const OTHER_INSTALLATION_ARTIFACTS: readonly ["generation-root", "update-journal", "active-pointer", "rollback-pointer"];
type OtherInstallationArtifact = (typeof OTHER_INSTALLATION_ARTIFACTS)[number];
interface InstallationPresence {
    readonly trustStore: ArtifactPresence;
    readonly receipt: ArtifactPresence;
    readonly otherArtifacts: readonly OtherInstallationArtifact[];
}
type ParseTrustStateResult = {
    readonly ok: true;
    readonly state: ProductTrustState;
} | {
    readonly ok: false;
    readonly code: "trust_state_corrupt";
    readonly message: string;
};
declare function parseTrustState(textContent: string): ParseTrustStateResult;
type InstallDiscrimination = {
    readonly kind: "first_install";
} | {
    readonly kind: "adopt";
} | {
    readonly kind: "fail_closed";
    readonly code: "prior_installation_artifacts";
    readonly message: string;
};
/**
 * The discriminator. Adoption requires BOTH the store
 * and the receipt, valid; a genuinely first install requires ABSOLUTELY
 * nothing; everything in between fails closed.
 */
declare function discriminateInstall(presence: InstallationPresence): InstallDiscrimination;
type NoDowngradeDecision = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly code: "downgrade_rejected";
    readonly message: string;
};
declare function checkNoDowngrade(compositionSequence: number, highWaterMark: number): NoDowngradeDecision;

/**
 * The sensitive-approval assertion contract — the second, stronger class of
 * user-originated authorization beside the operator confirmation, frozen here
 * by the composition-lifecycle unit whose maintenance lane is its first
 * consumer.
 *
 * NON-MODEL-MINTABLE. An assertion exists only because an assertion source —
 * host-native where the host provides one, OS-native interactive
 * authentication where it does not, or the qualification fixture source valid
 * only under the confirmation-fixture composition profile — performed one
 * fresh interactive evaluation for one single-use nonce, with credential
 * caching disabled or treated as invalid. The evaluating provider and the
 * consuming lane are model-external; this module freezes only the record the
 * evaluation binds, and the consumption sites enforce nonce single-use,
 * expiry, epoch freshness, and binding equality.
 *
 * THREE CLASSES, three binding profiles:
 *
 *   - `delivery-bound` (waiver validity/confirmation and the policy-required
 *     merge/deploy approvals): binds origin, delivery, candidate, policy,
 *     BOTH revocation epochs, the invocation fence, action, expiry, and a
 *     single-use nonce.
 *   - `maintenance-lane` (update, rollback, and trust-state maintenance):
 *     binds the target installation and generation identities in place of
 *     delivery/candidate/fence; the high-water-mark advance binds the target
 *     mark instead of a generation. Only the product-trust revocation epoch
 *     exists in this lane — there is no delivery, so the repository authority
 *     epoch is recorded explicitly absent-by-state.
 *   - `security-blocked-migration`: binds the target installation and
 *     generation identities (the target generation being non-revoked is a
 *     consumption rule) plus the target delivery identity and its expected
 *     journal revision, in place of candidate/fence. The consuming site
 *     rejects on any mismatch; the mandatory full re-preparation recaptures
 *     candidate, fence, and policy, so none of those is bound here.
 *
 * The evaluating prompt disclosed the exact target and action being approved;
 * the members here are that disclosure's machine half.
 */

declare const SENSITIVE_APPROVAL_ASSERTION_SPEC = "sensitive-approval-assertion/1";
declare const ASSERTION_CLASSES: readonly ["delivery-bound", "maintenance-lane", "security-blocked-migration"];
type AssertionClass = (typeof ASSERTION_CLASSES)[number];
/** Where the interactive evaluation ran. The fixture source is profile-gated. */
declare const ASSERTION_SOURCES: readonly ["host-native", "os-native", "qualification-fixture"];
type AssertionSource = (typeof ASSERTION_SOURCES)[number];
/** The maintenance-lane actions in the sensitive set, frozen. */
declare const SENSITIVE_MAINTENANCE_ACTIONS: readonly ["update", "rollback", "pin", "revoke", "unrevoke", "advance-high-water-mark"];
type SensitiveMaintenanceAction = (typeof SENSITIVE_MAINTENANCE_ACTIONS)[number];
declare const SECURITY_BLOCKED_MIGRATION_ACTION = "migrate-security-blocked";
declare function validateSensitiveApprovalAssertion(value: unknown): SpineVerdict;
/** The class the given assertion value declares, when it declares one. */
declare function assertionClassOf(value: unknown): AssertionClass | undefined;

interface AssertionEvaluationRequest {
    /** The exact action being approved, disclosed in the prompt. */
    readonly action: string;
    /** The rendered disclosure of the exact target and action. */
    readonly disclosure: string;
}
type AssertionEvaluation = {
    readonly ok: true;
    readonly nonce: string;
    readonly expiry: string;
    readonly sourceKind: AssertionSource;
} | {
    readonly ok: false;
    readonly reason: string;
};
type AssertionAvailabilityProbe = {
    readonly available: true;
    readonly sourceKind: AssertionSource;
    readonly detail: string;
} | {
    readonly available: false;
    readonly detail: string;
};
interface AssertionSourcePort {
    probe(): Promise<AssertionAvailabilityProbe>;
    evaluate(request: AssertionEvaluationRequest): Promise<AssertionEvaluation>;
}
declare const ASSERTION_PROVIDER_SPEC = "assertion-provider/1";
interface AssertionProviderConfig {
    readonly spec: typeof ASSERTION_PROVIDER_SPEC;
    readonly sourceKind: AssertionSource;
}
/** Beside the trust store, under the same owner-only protections. */
declare function assertionProviderConfigPathFor(installationPath: string): string;
declare function writeAssertionProviderConfig(installationPath: string, sourceKind: AssertionSource): Promise<void>;
type AssertionProviderLoad = {
    readonly ok: true;
    readonly config: AssertionProviderConfig;
} | {
    readonly ok: false;
    readonly reason: "absent" | "corrupt";
};
declare function loadAssertionProviderConfig(installationPath: string): Promise<AssertionProviderLoad>;
interface OsNativeSourceOptions {
    readonly platform?: string;
    readonly now?: () => string;
}
/**
 * The per-platform OS-native assertion source, supplied where the host offers
 * no native one. Probing checks the platform's authentication surfaces;
 * evaluation drives one fresh interactive prompt whose text disclosed the
 * exact target and action.
 */
declare function createOsNativeAssertionSource(options?: OsNativeSourceOptions): AssertionSourcePort;
interface QualificationFixtureSourceOptions {
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
declare function createQualificationFixtureAssertionSource(options?: QualificationFixtureSourceOptions): AssertionSourcePort & {
    readonly evaluations: AssertionEvaluationRequest[];
};

declare const SUPPORTED_PLATFORMS: readonly ["darwin", "linux", "win32"];
/**
 * MAJOR AND MINOR, because the minor is load-bearing. The managed facade emits
 * a hook command carrying `--experimental-strip-types`, which Node rejects
 * outright before 22.6: the interceptor would not start, and a
 * deny-until-attested boundary that does not start fails OPEN. `engines` is
 * advisory — npm only warns — so this preflight is where the floor is actually
 * enforced, and it has to be the floor the emitted command needs.
 */
declare const MINIMUM_NODE: readonly [22, 6];
declare const MINIMUM_PYTHON: readonly [3, 11];
interface PreflightProbes {
    readonly nodeVersion: string;
    /** `undefined` means no Python runtime was found. */
    readonly pythonVersion: string | undefined;
    readonly platform: string;
}
declare function livePreflightProbes(): Promise<PreflightProbes>;

declare const SUBSTRATE_BLOCKER_CODES: readonly ["skills_archive_digest_mismatch", "skills_metadata_digest_mismatch", "manifest_malformed", "closure_digest_mismatch", "generation_digest_mismatch", "missing_generation", "not_an_installed_generation", "trust_state_absent", "trust_state_corrupt", "prior_installation_artifacts", "downgrade_rejected", "generation_revoked", "generation_not_pinned", "composition_profile_mismatch", "install_receipt_absent", "install_receipt_corrupt", "active_pointer_missing", "active_pointer_corrupt", "unsupported_archive_entry", "update_lane_required", "qualification_flag_required", "qualification_flag_refused", "preflight_failed", "assertion_source_unavailable", "assertion_source_mismatch", "assertion_refused", "assertion_stale", "assertion_replayed", "maintenance_in_progress", "maintenance_journal_corrupt", "rollback_target_not_accepted", "epoch_rollback_rejected", "repair_not_needed", "non_interactive_refused", "disposable_repository_required"];
type SubstrateBlockerCode = (typeof SUBSTRATE_BLOCKER_CODES)[number];
interface SubstrateBlocker {
    readonly code: SubstrateBlockerCode;
    readonly message: string;
}
type SubstrateFailure = {
    readonly ok: false;
    readonly blockers: readonly SubstrateBlocker[];
};
declare const COMPOSITION_MANIFEST_FILE = "composition-manifest.json";
declare const INSTALL_RECEIPT_SPEC = "install-receipt/1";
declare const ACTIVE_POINTER_SPEC = "active-pointer/1";
/** The one place trust state lives. Never resolved from a repository. */
declare function trustStorePathFor(installationPath: string): string;
/** The receipt lives OUTSIDE the store, keyed to the installation path. */
declare function receiptPathFor(receiptDir: string, installationPath: string): string;
/** The harness modules the minimum composition packs from the checkout. */
declare const PACKED_HARNESS_PACKAGES: readonly ["kernel", "cli", "conformance", "mcp", "action"];
interface PackCompositionInput {
    /** The checkout supplying the managed facade and harness modules. Read-only input. */
    readonly sourceRoot: string;
    /** The exact `agent-skills` release archive; must hash to the frozen pin. */
    readonly skillsArchivePath: string;
    readonly skillsMetadataPath: string;
    readonly compositionProfile: CompositionProfile;
    readonly compositionSequence: number;
    readonly outDir: string;
}
type PackCompositionResult = {
    readonly ok: true;
    readonly generationDigest: string;
    readonly manifestPath: string;
    readonly packedDir: string;
} | SubstrateFailure;
declare function packComposition(input: PackCompositionInput): Promise<PackCompositionResult>;
interface VerifiedClosure {
    readonly ok: true;
    readonly generationDigest: string;
    readonly manifest: Record<string, unknown>;
}
/**
 * Full digest closure over one composition root: the manifest is present and
 * well-formed, its bytes hash to the addressed digest when one is expected,
 * every listed file is present with exactly its listed bytes, and no
 * unlisted file exists.
 */
declare function verifyGenerationClosure(root: string, expectedDigest?: string): Promise<VerifiedClosure | SubstrateFailure>;
interface InstallReceipt {
    readonly spec: typeof INSTALL_RECEIPT_SPEC;
    readonly installationPath: string;
    readonly installationId: string;
    readonly installationProfile: CompositionProfile;
    /**
     * The qualification flag's use-time half: present exactly when the profile
     * is `confirmation-fixture`, listing the operator-supplied disposable
     * repository identities this installation may serve. Recorded in the
     * receipt — outside every execution grant's writable paths — so a
     * candidate- or model-written marker can never make a repository eligible.
     */
    readonly disposableRepositoryIds?: readonly string[];
}
interface InstallCompositionInput {
    readonly packedDir: string;
    readonly installationPath: string;
    /** The platform user-configuration location holding install receipts. */
    readonly receiptDir: string;
    readonly trust?: ProductTrustPort;
    /**
     * The explicit operator-supplied qualification flag with its disposable
     * repository identities. Required for any fixture-profile install or
     * reinstall; refused for a production one. Recorded in the install receipt.
     */
    readonly qualification?: {
        readonly disposableRepositoryIds: readonly string[];
    };
    /** Which assertion source the installation records; default OS-native. */
    readonly assertionProvider?: {
        readonly sourceKind: AssertionSource;
    };
    /** Override the probed source (tests and host integrations). */
    readonly assertionSource?: AssertionSourcePort;
    /** Override individual preflight probes; unset members probe live. */
    readonly preflight?: Partial<PreflightProbes>;
}
type InstallCompositionResult = {
    readonly ok: true;
    readonly installationId: string;
    readonly generationDigest: string;
    readonly firstInstall: boolean;
    readonly root: string;
} | SubstrateFailure;
declare function installComposition(input: InstallCompositionInput): Promise<InstallCompositionResult>;
interface TrustCheckInput {
    readonly installationPath: string;
    readonly generationDigest: string;
    readonly trust?: ProductTrustPort;
}
type MutationLaneResult = {
    readonly ok: true;
} | SubstrateFailure;
/**
 * The mutation-lane trust predicate: current local trust state, resolved
 * only from the installation store, evaluated through the ProductTrustPort.
 * Absent or corrupt trust state blocks; a revoked or unpinned generation
 * blocks. Later units call THIS at the check sites they introduce.
 */
declare function checkMutationLane(input: TrustCheckInput): Promise<MutationLaneResult>;
type LoadPinnedGenerationResult = {
    readonly ok: true;
    readonly root: string;
    readonly manifest: Record<string, unknown>;
} | SubstrateFailure;
/**
 * The pinned-root load the walking skeleton uses to pin and reload one exact
 * generation. Never consults the repository-global active pointer: the root
 * is addressed by digest, so pointer changes cannot alter what a pinned
 * delivery loads. Missing, empty, tampered, or trust-ineligible roots block.
 */
declare function loadPinnedGeneration(input: TrustCheckInput): Promise<LoadPinnedGenerationResult>;
type ResolveActiveGenerationResult = {
    readonly ok: true;
    readonly generationDigest: string;
} | SubstrateFailure;
/** The default generation for NEW intake only; pinned deliveries never read it. */
declare function resolveActiveGeneration(installationPath: string): Promise<ResolveActiveGenerationResult>;
interface RegistrationBindingInput {
    readonly installationPath: string;
    readonly receiptDir: string;
}
type RegistrationBindingResult = {
    readonly ok: true;
    readonly registeringInstallationId: string;
    readonly activeCompositionProfile: CompositionProfile;
    /** Present exactly when the profile is `confirmation-fixture`. */
    readonly disposableRepositoryIds?: readonly string[];
} | SubstrateFailure;
/**
 * The registration members `delivery.registered` populates: the identity
 * minted at genuinely-first install and the receipt-recorded profile. An
 * absent or corrupt receipt resolves no identity and no profile — it fails
 * closed instead of defaulting to production.
 */
declare function registrationBinding(input: RegistrationBindingInput): Promise<RegistrationBindingResult>;

interface SensitiveLaneInput {
    readonly installationPath: string;
    readonly receiptDir: string;
    /** Override the configured source's port (tests, host integrations). */
    readonly assertionSource?: AssertionSourcePort;
    /** The consumption instant, caller-observed; the lane consults no clock. */
    readonly now: string;
}
interface UpdateCompositionInput extends SensitiveLaneInput {
    readonly packedDir: string;
    readonly qualification?: {
        readonly disposableRepositoryIds: readonly string[];
    };
    readonly preflight?: Partial<PreflightProbes>;
    readonly trust?: ProductTrustPort;
    /** Fault-injection seam for the update fault sensors; production passes none. */
    readonly hooks?: {
        readonly onPhase?: (phase: string) => void | Promise<void>;
    };
}
type UpdateCompositionResult = {
    readonly ok: true;
    readonly generationDigest: string;
    readonly priorGenerationDigest: string;
    readonly root: string;
    readonly noOp: boolean;
} | SubstrateFailure;
declare function updateComposition(input: UpdateCompositionInput): Promise<UpdateCompositionResult>;
interface RollbackCompositionInput extends SensitiveLaneInput {
    readonly targetGenerationDigest: string;
    readonly trust?: ProductTrustPort;
}
declare function rollbackComposition(input: RollbackCompositionInput): Promise<{
    readonly ok: true;
    readonly generationDigest: string;
} | SubstrateFailure>;
type MaintainTrustStateInput = SensitiveLaneInput & ({
    readonly operation: "pin" | "revoke" | "unrevoke";
    readonly generationDigest: string;
} | {
    readonly operation: "advance-high-water-mark";
    readonly highWaterMark: number;
});
declare function maintainTrustState(input: MaintainTrustStateInput): Promise<{
    readonly ok: true;
    readonly state: ProductTrustState;
} | SubstrateFailure>;
interface GarbageCollectInput {
    readonly installationPath: string;
    /** Generation pins of every nonterminal delivery, supplied by the caller. */
    readonly referencedGenerationDigests: readonly string[];
}
declare function garbageCollectGenerations(input: GarbageCollectInput): Promise<{
    readonly ok: true;
    readonly removed: readonly string[];
} | SubstrateFailure>;
declare function recoverInterruptedMaintenance(input: {
    readonly installationPath: string;
}): Promise<{
    readonly ok: true;
    readonly recovered: boolean;
} | SubstrateFailure>;
interface RepairInstallationInput {
    readonly installationPath: string;
    readonly receiptDir: string;
    /** The repair is the operator's own interactive installer act. */
    readonly interactive: boolean;
    readonly source: {
        readonly sourceKind: AssertionSource;
        readonly port?: AssertionSourcePort;
    };
}
/**
 * The operator-performed installer repair: re-establishes the assertion
 * provider after source loss. It adopts and never edits the existing trust
 * store and receipt (it asserts no profile and preserves the receipt's flag
 * state, disposable set, and registering-installation identity), and it is
 * refused while a working assertion source exists.
 */
declare function repairInstallation(input: RepairInstallationInput): Promise<{
    readonly ok: true;
} | SubstrateFailure>;
interface InspectedGeneration {
    readonly digest: string;
    readonly accepted: boolean;
    readonly revoked: boolean;
}
interface InspectInstallationInput {
    readonly installationPath: string;
    readonly receiptDir: string;
}
/**
 * Read-only installation inventory: internal identities are exposed without
 * becoming selectable — nothing here mutates, and nothing here is an input
 * any activation path trusts.
 */
declare function inspectInstallation(input: InspectInstallationInput): Promise<{
    readonly ok: true;
    readonly installationId: string;
    readonly profile: CompositionProfile;
    readonly pinnedGenerationDigest: string;
    readonly activeGenerationDigest: string | undefined;
    readonly rollbackGenerationDigest: string | undefined;
    readonly highWaterMark: number;
    readonly revocationEpoch: number;
    readonly assertionSourceKind: AssertionSource | undefined;
    readonly generations: readonly InspectedGeneration[];
} | SubstrateFailure>;

/** Policy-module rejections reuse the spine's record shape with a wider code set. */
interface PolicyRejection {
    readonly code: string;
    /** RFC 6901 pointer to the offending value. */
    readonly pointer: string;
    readonly message: string;
}
type PolicyVerdict = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly rejections: readonly PolicyRejection[];
};
declare const ADAPTER_CAPABILITY_SPEC = "adapter-capability/1";
declare const OPERATION_RESULT_SPEC = "operation-result/1";
/** The eight repository capability classes the compiler can bind. */
declare const POLICY_CAPABILITY_KINDS: readonly ["sensor", "mutation-stage", "pr-creation", "merge", "deploy", "approval-request", "tracker", "status-reconciliation"];
type PolicyCapabilityKind = (typeof POLICY_CAPABILITY_KINDS)[number];
/** Kinds whose execution reads and never mutates. */
declare const READ_ONLY_CAPABILITY_KINDS: readonly ["sensor", "status-reconciliation"];
/**
 * Kinds whose credentials are excluded from every model-driven execution
 * grant; they run only through bound adapters after authorization.
 */
declare const PRIVILEGED_CAPABILITY_KINDS: readonly ["pr-creation", "merge", "deploy", "approval-request"];
/**
 * The external actions a declarative document can grant as authority. The list
 * itself is frozen in the spine's finish-line contract — the journal's
 * post-action payloads name it and the spine cannot reach into this module —
 * so the grant model consumes that one definition instead of keeping a second.
 */
declare const PRIVILEGED_ACTIONS: readonly ["pr-creation", "merge", "deploy"];
interface AdapterCapability {
    readonly spec: typeof ADAPTER_CAPABILITY_SPEC;
    readonly capabilityId: string;
    readonly kind: PolicyCapabilityKind;
    readonly version: string;
    readonly resultSpec: string;
    readonly credentialId?: string;
}
declare function validateAdapterCapability(value: unknown): PolicyVerdict;
/** Validates a whole adapter set; duplicate capability ids reject. */
declare function validateAdapterSet(values: readonly unknown[]): PolicyVerdict;
declare const OPERATION_CLAIM_SPEC = "operation-claim/1";
/** The slice of a compiled policy a claim is judged against. */
interface ClaimAuthorityView {
    readonly capabilities: readonly {
        readonly capabilityId: string;
        readonly kind: PolicyCapabilityKind;
    }[];
    readonly snapshot: {
        readonly grantedAuthority: readonly string[];
    };
}
/**
 * Judges one adapter output claim against the bound compiled policy. The
 * claim must name a bound capability, the action must be that capability's
 * contracted kind, and a privileged action must be granted by the snapshot.
 */
declare function checkClaimAuthorized(claim: unknown, compiled: ClaimAuthorityView): PolicyVerdict;

/**
 * The declarative repository policy document — layer one of the compiled
 * policy. A repository declares WHAT it activates, grants, and protects;
 * executable adapters (layer two) declare what it can DO; the compiler joins
 * both with the portable defaults.
 *
 * The grammar is closed: unknown fields reject the delivery before mutation.
 * Checkpoint overrides deliberately carry only `additional*` members for
 * protections and forbidden operations — weakening a portable protection is
 * unspellable in this grammar, not merely rejected.
 *
 * Authority is typed, never prose: `grantedAuthority` admits only the frozen
 * privileged-action vocabulary, so a free-text sentence about merging has no
 * member to land in.
 */

declare const REPOSITORY_POLICY_DOCUMENT_SPEC = "repository-policy-document/1";
/** The model-driven workflow stages the compiler emits grant envelopes for. */
declare const PORTABLE_MODEL_DRIVEN_STAGES: readonly ["plan", "implement", "compound"];
declare const TRACKER_ABSENCE_FALLBACKS: readonly ["proceed-without-tracker", "block"];
declare const APPROVAL_REQUIREMENTS: readonly ["operator-required", "none"];
interface CheckpointOverride {
    readonly stageId: (typeof PORTABLE_MODEL_DRIVEN_STAGES)[number];
    readonly allowedCapabilities: readonly string[];
    readonly writablePaths: readonly string[];
    readonly credentials: readonly string[];
    readonly additionalProtectedPaths: readonly string[];
    readonly additionalForbiddenOperations: readonly string[];
}
interface RepositoryPolicyDocument {
    readonly spec: typeof REPOSITORY_POLICY_DOCUMENT_SPEC;
    readonly repositoryId: string;
    readonly policyGeneration: number;
    readonly grantedFinishLines: readonly (typeof FINISH_LINES)[number][];
    readonly grantedAuthority: readonly string[];
    readonly forbiddenAuthority: readonly string[];
    readonly reviewLenses: readonly {
        readonly lensId: string;
        readonly category: (typeof REVIEW_LENS_CATEGORIES)[number];
        /** The reviewer charter this lens hands its reviewer, referenced by identity. */
        readonly personaId: string;
        /**
         * Present only for a repository-owned charter: those bytes belong to the
         * repository, so the document pins them. A charter shipped in the
         * authenticated composition is referenced by identity alone, so advancing
         * the shipped set never edits this document.
         */
        readonly personaDigest?: string;
    }[];
    readonly obligations: readonly {
        readonly obligationId: string;
    }[];
    readonly requiredCapabilities: readonly {
        readonly capabilityId: string;
        readonly kind: string;
        readonly version: string;
    }[];
    readonly approvals: readonly {
        readonly action: string;
        readonly approval: (typeof APPROVAL_REQUIREMENTS)[number];
    }[];
    readonly trackerAbsenceFallback: (typeof TRACKER_ABSENCE_FALLBACKS)[number];
    readonly checkpoints?: readonly CheckpointOverride[];
    /** The admission gate, validated by the characterized `HarnessConfig` loader at compile time. */
    readonly admission?: unknown;
}
declare function validateRepositoryPolicyDocument(value: unknown): PolicyVerdict;

/**
 * The policy compiler: portable defaults + the declarative repository policy
 * document + the repository's executable adapter descriptors, normalized into
 * ONE immutable digest-bound compiled snapshot before a run is accepted.
 *
 * Everything a checkpoint later consults is inside the compiled value: the
 * frozen spine snapshot (finish lines, authority, lenses with the digest of
 * each lens's resolved reviewer charter, obligations, both
 * revocation epochs), one execution-grant envelope per model-driven stage,
 * the bound capability set, approval boundaries, the tracker posture, and —
 * when the repository declares one — the harness admission configuration,
 * validated by the characterized `HarnessConfig` loader. `HarnessConfig` is
 * thereby the admission PROJECTION of this policy, not the policy model.
 *
 * Every defect is a typed rejection BEFORE mutation. The digest recorded at
 * bind time governs the delivery: candidate edits to the document, adapters,
 * sensors, or compiled bytes produce a digest mismatch (`checkBoundPolicy`)
 * and are thereby proposals for a future owner-approved policy generation,
 * never inputs to the current judgement.
 */

declare const COMPILED_POLICY_SPEC = "compiled-repository-policy/1";
/** Every semantic rejection the compiler can produce, each by exactly one rule. */
declare const POLICY_COMPILE_CODES: readonly ["contradictory_authority", "contradictory_finish_line", "duplicate_obligation", "duplicate_review_lens", "duplicate_checkpoint", "mandatory_lens_missing", "persona_unresolvable", "capability_unavailable", "capability_version_mismatch", "capability_contract_mismatch", "prose_only_authority", "privileged_credential_in_model_grant", "tracker_unavailable", "admission_obligation_unactivated", "policy_tamper"];
/** The credentials no model-driven execution grant may carry. */
declare const PORTABLE_PRIVILEGED_CREDENTIALS: readonly ["credential.merge", "credential.deploy", "credential.pr-creation", "credential.approval-request"];
/** The review floor: one activated lens per category, in every compiled policy. */
declare const MANDATORY_LENS_CATEGORIES: readonly ["outcome-correctness", "testing-policy"];
/**
 * The portable per-stage envelope. A checkpoint override REPLACES the tool
 * and writable-path lists — those are the owner-approved document's to shape
 * — while protections and forbidden operations are union-only (`additional*`
 * members), so weakening either of those is unspellable, not just rejected.
 *
 * `Bash` is in this list by DECISION, not by default. The grant still needs an
 * OS-level host sandbox: a shell invocation carries no structured write-path
 * member for the interceptor to inspect. Each admitted host must therefore
 * project these writable/protected paths into its own filesystem boundary and
 * fail closed when that boundary is unavailable. Removing `Bash` was rejected
 * because every gate loop runs build, test, and version-control commands
 * through it; silently accepting a host with no sandbox is rejected too.
 */
declare const PORTABLE_STAGE_GRANT: Readonly<{
    readonly spec: "execution-grant/1";
    readonly profile: "checkpoint";
    readonly allowedCapabilities: readonly string[];
    readonly writablePaths: readonly string[];
    readonly protectedPaths: readonly string[];
    readonly forbiddenOperations: readonly string[];
}>;
/**
 * The read-only grant product-owned intake turns run under — the spine's
 * `intake` profile, whose grammar already refuses any writable path. The
 * scope workflow reads the repository to draft a contract; it mutates
 * nothing, and its admission decision is never mutation-capable.
 */
declare const PORTABLE_INTAKE_GRANT: Readonly<{
    readonly spec: "execution-grant/1";
    readonly profile: "intake";
    readonly allowedCapabilities: readonly string[];
    readonly writablePaths: readonly never[];
    readonly protectedPaths: readonly string[];
    readonly forbiddenOperations: readonly string[];
}>;
interface CompiledCheckpointGrant {
    readonly stageId: string;
    readonly grant: {
        readonly spec: typeof EXECUTION_GRANT_SPEC;
        readonly profile: "checkpoint";
        readonly allowedCapabilities: readonly string[];
        readonly writablePaths: readonly string[];
        readonly protectedPaths: readonly string[];
        readonly forbiddenOperations: readonly string[];
    };
    /** Credential availability for the stage; never a privileged credential. */
    readonly credentials: readonly string[];
}
interface CompiledPolicy {
    readonly spec: typeof COMPILED_POLICY_SPEC;
    readonly compiledDigest: string;
    readonly policyGeneration: number;
    readonly snapshot: PolicySnapshot;
    readonly capabilities: readonly AdapterCapability[];
    readonly checkpointGrants: readonly CompiledCheckpointGrant[];
    readonly approvals: readonly {
        readonly action: string;
        readonly approval: string;
    }[];
    readonly tracker: "available" | "absent";
    readonly trackerAbsenceFallback: string;
    readonly admission?: HarnessConfig;
}
/**
 * One reviewer charter the compiler can resolve a lens declaration against,
 * already materialized from its trusted pre-run source: the pinned
 * composition for a shipped charter, the digest-bound read-only policy copy
 * for a repository-owned one. The compiler never reads charter prose — it
 * binds the digest and nothing else.
 */
interface AvailablePersona {
    readonly personaId: string;
    readonly digest: string;
    readonly origin: "composition" | "adopter";
}
interface CompileRepositoryPolicyInput {
    readonly document: unknown;
    readonly adapters: readonly unknown[];
    /** Charters available to this compilation; a lens resolving to none rejects. */
    readonly personas?: readonly AvailablePersona[];
    readonly productTrustRevocationEpoch: number;
    readonly repositoryAuthorityRevocationEpoch: number;
}
type CompileRepositoryPolicyResult = {
    readonly ok: true;
    readonly compiled: CompiledPolicy;
} | {
    readonly ok: false;
    readonly rejections: readonly {
        readonly code: string;
        readonly pointer: string;
        readonly message: string;
    }[];
};
declare function compileRepositoryPolicy(input: CompileRepositoryPolicyInput): CompileRepositoryPolicyResult;
/**
 * Structural self-check of a compiled policy: the outer digest must recompute
 * from the compiled body and the inner spine snapshot must still validate.
 * This catches corruption; TAMPER is caught by `checkBoundPolicy`, because a
 * digest anyone can recompute is an identity, not a signature.
 */
declare function verifyCompiledPolicy(value: unknown): PolicyVerdict;
/**
 * The trusted pre-run copy governs: only the exact bytes whose digest was
 * bound at policy-bind time judge this delivery. Any other compiled policy —
 * however internally consistent — is a proposal for a future delivery.
 */
declare function checkBoundPolicy(boundCompiledDigest: string, presented: unknown): PolicyVerdict;

/**
 * The fixed policy's declared outcome authorities: the identities allowed to
 * confirm that an intended OUTCOME changed, as opposed to merely waiving a
 * criterion. A repository declaring none cannot amend an outcome mid-delivery
 * at all — absence of a grant is denial — so the disposable policy declares
 * exactly one, and no agent identity is ever in the list.
 *
 * Like the lens and sensor constants beside it, this is fixed-policy data the
 * skeleton reads directly; the layered policy document generalizes it along
 * with them.
 */
declare const DISPOSABLE_OUTCOME_AUTHORITIES: readonly string[];
/**
 * The two lenses the fixed policy activates, one per mandatory category, each
 * naming the reviewer charter its reviewer is handed. The disposable
 * repository owns its charters, so the compiled declaration pins their digests
 * and the bytes are read from the trusted pre-run base — a candidate rewriting
 * a tracked charter changes a future owner-approved run, never this one.
 */
declare const DISPOSABLE_REVIEW_LENSES: readonly [{
    readonly lensId: "lens.outcome-correctness";
    readonly category: "outcome-correctness";
    readonly personaId: "persona.outcome-correctness";
}, {
    readonly lensId: "lens.testing-policy";
    readonly category: "testing-policy";
    readonly personaId: "persona.testing-policy";
}];
/**
 * The one trusted sensor: the disposable repository's acceptance sensor. Its
 * executable bytes are copied from the TRUSTED PRE-RUN BASE at policy-bind
 * time and executed only from that copy — a candidate rewriting the tracked
 * file changes a future owner-approved run, never the current judgement.
 */
declare const DISPOSABLE_SENSOR_CAPABILITY: Readonly<{
    readonly descriptor: Readonly<{
        spec: "capability-descriptor/1";
        capabilityId: "sensor.acceptance";
        kind: "sensor";
        version: "1";
        resultSpec: "sensor-result/1";
    }>;
    /** Where the sensor lives in the repository tree, resolved from the base commit. */
    readonly trustedBasePath: "tools/sensor.mjs";
}>;
interface CompileDisposablePolicyInput {
    readonly repositoryId: string;
    readonly productTrustRevocationEpoch: number;
    readonly repositoryAuthorityRevocationEpoch: number;
    /** The reviewer-charter bytes read from the trusted pre-run base, per identity. */
    readonly personaBytes: Readonly<Record<string, string>>;
    /** Optional admission projection, supplied by disposable fixture callers. */
    readonly admission?: HarnessConfigInput;
}
/** Compiles the fixed policy for one disposable repository. Digest self-binds. */
declare function compileDisposableCompiledPolicy(input: CompileDisposablePolicyInput): CompiledPolicy;
/** The historical disposable call-site projection, retained for characterization tests. */
declare function compileDisposablePolicy(input: CompileDisposablePolicyInput): PolicySnapshot;
/**
 * The ONE fixed stage grant every model-driven checkpoint of the skeleton
 * runs under — the compiler's portable default envelope, unchanged: host
 * tool families, writable paths scoped to the disposable repository's source
 * layout, and the delivery authority paths protected.
 */
declare const DISPOSABLE_STAGE_GRANT: Readonly<{
    readonly spec: "execution-grant/1";
    readonly profile: "checkpoint";
    readonly allowedCapabilities: readonly string[];
    readonly writablePaths: readonly string[];
    readonly protectedPaths: readonly string[];
    readonly forbiddenOperations: readonly string[];
}>;

/** The declared-data manifest the archive carries, and the schema it must announce. */
declare const PERSONA_MANIFEST_ENTRY = "personas/manifest.json";
declare const PERSONA_MANIFEST_SPEC = "reviewer-persona-manifest/1";
/** The archive's own per-file digest listing, which the charter bytes are checked against. */
declare const ARCHIVE_RELEASE_MANIFEST_ENTRY = "release-manifest.json";
type ShippedPersonaRejectionCode = "persona_manifest_absent" | "persona_manifest_malformed" | "persona_charter_absent" | "persona_charter_digest_mismatch";
interface ShippedPersonaRejection {
    readonly code: ShippedPersonaRejectionCode;
    readonly pointer: string;
    readonly message: string;
}
type ProjectShippedPersonasResult = {
    readonly ok: true;
    readonly personas: readonly AvailablePersona[];
} | {
    readonly ok: false;
    readonly rejections: readonly ShippedPersonaRejection[];
};
/** Reads one entry of the pinned archive, or reports it absent. Supplied by the caller. */
type ArchiveEntryReader = (entryPath: string) => Uint8Array | undefined;
/**
 * Projects the pinned archive's charter set into compiler-consumable receipts,
 * in the order the archive declares them. Fail-closed and exhaustive: every
 * defect is reported rather than the first, because a caller that learns only
 * about the first missing charter cannot tell a single drift from a set that
 * did not ship at all.
 */
declare function projectShippedPersonas(read: ArchiveEntryReader): ProjectShippedPersonasResult;

declare const AUTHORITY_REVOCATION_SPEC = "authority-revocation/1";
interface AuthorityRevocation {
    readonly spec: typeof AUTHORITY_REVOCATION_SPEC;
    readonly epoch: number;
    readonly revokedAuthority: readonly string[];
    readonly revokedFinishLines: readonly string[];
}
declare function validateAuthorityRevocation(value: unknown): PolicyVerdict;
type ObserveAuthorityEpochResult = {
    readonly ok: true;
    readonly highestObservedEpoch: number;
} | {
    readonly ok: false;
    readonly rejections: readonly {
        readonly code: string;
        readonly pointer: string;
        readonly message: string;
    }[];
};
/**
 * Consumes one observation of the authority store against the highest epoch
 * ever observed. A lower epoch rejects; an equal or higher epoch advances
 * (or holds) the floor.
 */
declare function observeAuthorityEpoch(highestObservedEpoch: number, presented: unknown): ObserveAuthorityEpochResult;
/** The grants a snapshot-like layer contributes to the intersection. */
interface AuthorityGrantView {
    readonly grantedFinishLines: readonly string[];
    readonly grantedAuthority: readonly string[];
}
interface EffectiveDeliveryAuthorityInput {
    /** The snapshot this delivery bound — its ceiling, forever. */
    readonly bound: AuthorityGrantView;
    readonly revocation: AuthorityRevocation;
    /** The currently active policy generation, when one should also constrain. */
    readonly currentGeneration?: AuthorityGrantView;
}
/**
 * The delivery's effective authority right now: the bound snapshot minus
 * every revocation, intersected with the current generation when supplied.
 * Layers only remove — a wider current generation contributes nothing.
 */
declare function effectiveDeliveryAuthority(input: EffectiveDeliveryAuthorityInput): AuthorityGrantView;
interface CheckActionAuthorizationInput {
    readonly action: string;
    readonly bound: PolicySnapshot | AuthorityGrantView;
    readonly revocation: unknown;
    readonly highestObservedEpoch: number;
}
/**
 * The canonical recheck: is this external action authorized right now? Run at
 * every recheck site — a revocation observed here blocks immediately, even
 * when the delivery is already `ready` and the final candidate commit stands.
 */
declare function checkActionAuthorization(input: CheckActionAuthorizationInput): PolicyVerdict;

type JournalAppendResult = {
    readonly ok: true;
    readonly expectedRevision: number;
} | {
    readonly ok: false;
    readonly rejections: readonly SpineRejection[];
};
type JournalReadResult = {
    readonly ok: true;
    readonly entries: readonly unknown[];
    readonly interruptedTail?: true;
} | {
    readonly ok: false;
    readonly rejections: readonly SpineRejection[];
};
interface Store<State> {
    readonly journalPath: string;
    read(): Promise<JournalReadResult>;
    state(): Promise<{
        ok: true;
        state: State;
    } | {
        ok: false;
        rejections: readonly SpineRejection[];
    }>;
    append(entry: unknown): Promise<JournalAppendResult>;
}
interface JournalStore extends Store<DeliveryJournalState> {
}
declare function createJournalStore(journalPath: string): JournalStore;
/**
 * The intake journal shares the store mechanics but reduces through the
 * frozen INTAKE reducer, so the delivery journal's registration entry has a
 * real confirmation chain to reference.
 */
interface IntakeJournalStore extends Store<IntakeJournalState> {
}
declare function createIntakeJournalStore(journalPath: string): IntakeJournalStore;
/**
 * The installation-scoped maintenance journal: retention/export/deletion
 * records live here precisely so they survive their target delivery's
 * removal.
 */
interface MaintenanceJournalStore extends Store<MaintenanceJournalState> {
}
declare function createMaintenanceJournalStore(journalPath: string): MaintenanceJournalStore;

/**
 * THE CANONICAL RECHECK, one implementation point.
 *
 * The State and Authority Model freezes the rechecked-value list — product
 * trust, the repository authority-revocation epoch, the invocation fence, the
 * registering installation identity and active profile, and the projection
 * and discovery-configuration digests — and the consumption substitutions
 * that replace parts of it:
 *
 *   - takeover consumption rechecks the superseded fence, expected journal
 *     revision, and target base commit IN PLACE OF the current fence and the
 *     prior worktree's projection and discovery-configuration digests;
 *   - rebinding-migration consumption rechecks the current installation's
 *     identity and active profile against the assertion's bound target
 *     installation and the delivery's recorded profile, IN PLACE OF the
 *     recorded registering-installation identity (which that consumption
 *     replaces);
 *   - generation-migration consumption evaluates product trust against the
 *     assertion's bound target generation IN PLACE OF the delivery's recorded
 *     generation pin, with fence and the prior worktree's digests
 *     absent-by-state.
 *
 * The helper is pure: callers gather observations, the helper decides. It
 * fails closed twice over — a missing value is `recheck_incomplete`, and a
 * REAL value supplied where a substitution replaced it is a
 * `substitution_violation`, so no consumption site can quietly recheck the
 * wrong axis. Values recorded absent-by-state are not rechecked, exactly as
 * the model says.
 */
declare const RECHECKED_VALUES: readonly ["product-trust", "repository-authority-epoch", "invocation-fence", "registering-installation-id", "active-profile", "projection-digest", "discovery-configuration-digest"];
type RecheckedValue = (typeof RECHECKED_VALUES)[number];
/** A comparison between a durable binding and the currently observed value. */
interface CompareCheck {
    readonly kind: "compare";
    readonly expected: string | number;
    readonly observed: string | number;
}
/** An eligibility verdict the caller already evaluated (product trust). */
interface EligibleCheck {
    readonly kind: "eligible";
    readonly ok: boolean;
    readonly detail?: string;
}
type ValueCheck = "absent-by-state" | CompareCheck | EligibleCheck;
type RecheckValues = Readonly<Record<RecheckedValue, ValueCheck>>;
type RecheckConsumption = {
    readonly kind: "standard";
} | {
    readonly kind: "takeover";
    readonly supersededFence: CompareCheck;
    readonly expectedJournalRevision: CompareCheck;
    readonly targetBaseCommit: CompareCheck;
} | {
    readonly kind: "rebinding-migration";
    readonly targetInstallationId: CompareCheck;
    readonly recordedProfile: CompareCheck;
} | {
    readonly kind: "generation-migration";
    readonly targetGenerationTrust: EligibleCheck;
};
type RecheckFailureCode = "recheck_incomplete" | "substitution_violation" | "value_mismatch" | "trust_ineligible";
interface RecheckFailure {
    readonly value: string;
    readonly code: RecheckFailureCode;
    readonly message: string;
}
type RecheckResult = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly failures: readonly RecheckFailure[];
};
declare function evaluateCanonicalRecheck(input: {
    readonly consumption: RecheckConsumption;
    readonly values: RecheckValues;
}): RecheckResult;

/**
 * Secret discipline for durable journal bytes: schemas already classify the
 * spine's only free-text members (`summary`, `reason`); everything else is a
 * closed shape. Before any append becomes durable, secret-like values are
 * REDACTED inside those free-text members — an audit record survives with the
 * credential named but not carried — and REJECTED anywhere else, because a
 * secret in a structural member is never legitimate content.
 *
 * The corpus is deliberately high-precision: each pattern names one concrete
 * credential shape. Entropy guessing is excluded — a false positive here
 * erases a legitimate audit record, and the closed grammar already leaves no
 * free-form member for a dump to land in.
 */
interface SecretPattern {
    readonly id: string;
    /** Source without flags; matching always constructs a fresh global RegExp. */
    readonly source: string;
}
declare const SECRET_PATTERNS: readonly SecretPattern[];
interface RedactedText {
    readonly text: string;
    /** The pattern ids that matched, in corpus order, deduplicated. */
    readonly redacted: readonly string[];
}
declare function redactSecretText(text: string): RedactedText;
type SecretDisciplineResult = {
    readonly ok: true;
    readonly entry: unknown;
    readonly redactions: readonly string[];
} | {
    readonly ok: false;
    readonly matches: readonly {
        readonly pointer: string;
        readonly id: string;
    }[];
};
/**
 * Walks every string value of a journal entry: free-text members are redacted
 * in place, any other matching string rejects with its pointer. The input is
 * never mutated; the returned entry is a disciplined copy.
 *
 * The free-text set is the CALLER's, defaulting to the spine's own. The run
 * family owns a different set of bounded free-text members and reuses these
 * detection and redaction rules over it; the spine's set is untouched by that,
 * because a family that could widen another family's redactable members would
 * be a way to make a secret survive.
 */
declare function applySecretDiscipline(entry: unknown, freeTextMembers?: ReadonlySet<string>): SecretDisciplineResult;

/** The facade's namespace, shared by the run store. */
declare const MANAGED_DELIVERY_NAMESPACE = "managed-delivery";
/** One directory under the namespace holds every run of this repository. */
declare const RUN_STORE_DIRECTORY = "runs";
interface NamespaceGitLaunch {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly env?: Record<string, string>;
}
type NamespaceGitRunner = (launch: NamespaceGitLaunch) => Promise<{
    code: number;
    stdout: string;
}>;
interface NamespaceResolutionInput {
    readonly cwd: string;
    readonly run: NamespaceGitRunner;
    readonly env?: Record<string, string>;
}
type NamespaceResolution = {
    readonly ok: true;
    readonly commonDir: string;
    readonly namespaceDir: string;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * Resolves the shared namespace directory. This is the query the facade has
 * always made — same args, same cwd, one launch — so nothing about its
 * recorded process inventory changes by routing it through here.
 */
declare function resolveCommonDirectoryNamespace(input: NamespaceResolutionInput): Promise<NamespaceResolution>;
type RunStoreLocation = {
    readonly ok: true;
    /** The INVOKING worktree's own git directory — the pointer's identity. */
    readonly gitDir: string;
    readonly commonDir: string;
    readonly namespaceDir: string;
    readonly runsDir: string;
    /**
     * The per-worktree pointer key: a digest of the absolute git directory.
     * Config-independent, different in every worktree, and deliberately not
     * the record store's `workspaceId`, which depends on a configured
     * namespace this store does not have.
     */
    readonly worktreeKey: string;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * Resolves the run store and the invoking worktree's pointer key together. One
 * `rev-parse` names both paths; like the common-directory query it reads no
 * index and runs no hook, alias, or pager.
 */
declare function resolveRunStoreLocation(input: NamespaceResolutionInput): Promise<RunStoreLocation>;
/**
 * The `GIT_` namespace is dropped wholesale rather than by curated list,
 * because the failure mode of missing one is a store that looks perfectly
 * healthy and belongs to the wrong repository. `GIT_TERMINAL_PROMPT` because
 * nothing here may wait for someone to type; `GIT_OPTIONAL_LOCKS` because
 * these queries only observe.
 */
declare function gitNamespaceClearedEnvironment(): Record<string, string>;
/**
 * A direct `git` runner for the callers that have no injected port: the CLI's
 * run-surface commands. It never throws — a resolution failure is a reported
 * outcome, never an exception that could change a wrapped command's exit code.
 */
declare const runGitDirect: NamespaceGitRunner;

/**
 * The run family's own rejection vocabulary: the spine's codes, plus the two
 * this store owns. The spine's frozen code list is NOT widened — a family that
 * could add to it would be a contract revision.
 */
type RunStoreRejectionCode = SpineRejectionCode | "access_refused" | "unresolvable_run";
interface RunStoreRejection {
    readonly code: RunStoreRejectionCode;
    readonly pointer: string;
    readonly message: string;
}
type RunAppendResult = {
    readonly ok: true;
    readonly event: RunEvent;
} | {
    readonly ok: false;
    readonly rejections: readonly RunStoreRejection[];
};
type RunReadResult = {
    readonly ok: true;
    readonly events: readonly RunEvent[];
} | {
    readonly ok: false;
    readonly rejections: readonly RunStoreRejection[];
};
type RunAllocateResult = {
    readonly ok: true;
    readonly runId: string;
} | {
    readonly ok: false;
    readonly rejections: readonly RunStoreRejection[];
};
type RunDiscardResult = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly rejections: readonly RunStoreRejection[];
};
type RunCurrentResult = {
    readonly ok: true;
    readonly runId: string | undefined;
} | {
    readonly ok: false;
    readonly rejections: readonly RunStoreRejection[];
};
type RunSetCurrentResult = {
    readonly ok: true;
    readonly displaced?: string;
} | {
    readonly ok: false;
    readonly rejections: readonly RunStoreRejection[];
};
interface RunMatch {
    readonly runId: string;
    /** The other runs whose journals bind the same candidate, most recent first. */
    readonly alsoMatching: readonly string[];
}
interface RunStore {
    /** `<common-dir>/managed-delivery/runs`. */
    readonly runsDir: string;
    allocate(): Promise<RunAllocateResult>;
    /**
     * Takes back a journal `allocate` created for a run that never began.
     *
     * THE ALLOCATOR'S INVERSE, AND ONLY THAT. `allocate` creates the journal
     * before the two things that can still refuse a start — the `run.started`
     * append and the exclusive pointer write — so a refusal after allocation
     * leaves a journal nothing points at and nothing will ever append to, which
     * `list` then shows beside genuine runs and a retry produces one more of.
     *
     * A journal carrying anything but its own `run.started` is a run with
     * history, and history in an append-only store is not the allocator's to
     * delete: both a second event and a lone event that is not a start are
     * refused. That is the whole guard. A pointer check beside it would make
     * neither clause provable on its own.
     */
    discard(runId: string): Promise<RunDiscardResult>;
    append(runId: string, event: RunEventInput, options?: {
        /** CLI-generated observation times retain the original instant on an otherwise identical retry. */
        readonly reuseExistingTimestamp?: boolean;
    }): Promise<RunAppendResult>;
    /**
     * Records one bounded line for an append a CALLER refused before it reached
     * `append` — today, exactly `emit`'s refusal of `command.completed`, which is
     * writer-policy rather than a contract violation the validator could catch.
     * The line is written by the same bounded writer a refused `append` uses, so
     * there is one note format and one place that decides what a note may carry.
     */
    noteRefusal(runId: string, event: RunEventInput, rejection: RunStoreRejection): Promise<void>;
    read(runId: string): Promise<RunReadResult>;
    readNotes(runId: string): Promise<readonly unknown[]>;
    list(): Promise<readonly string[]>;
    current(worktreeKey: string): Promise<RunCurrentResult>;
    setCurrent(worktreeKey: string, runId: string, options?: {
        readonly force?: boolean;
    }): Promise<RunSetCurrentResult>;
    clearCurrent(worktreeKey: string, runId: string): Promise<boolean>;
    findByCandidateTreeSha(treeSha: string): Promise<RunMatch | undefined>;
}
declare function createRunStore(commonDir: string): RunStore;

interface RetentionContext {
    /** The common-Git product namespace directory. */
    readonly namespaceDir: string;
    /** The registering installation identity — the maintenance journal's subject. */
    readonly installationId: string;
    /** The installation-scoped maintenance journal path. */
    readonly maintenanceJournalPath: string;
}
interface RetentionFailure {
    readonly ok: false;
    readonly code: string;
    readonly summary: string;
    readonly remediation: string;
}
type ExportDeliveryResult = {
    readonly ok: true;
    readonly exportPath: string;
    readonly artifactDigest: string;
} | RetentionFailure;
declare function exportDelivery(context: RetentionContext, deliveryId: string): Promise<ExportDeliveryResult>;
type DeleteDeliveryResult = {
    readonly ok: true;
    readonly auditPath: string;
    readonly preservedAuditRecords: readonly string[];
    readonly artifactDigest: string;
} | RetentionFailure;
declare function deleteDelivery(context: RetentionContext, deliveryId: string): Promise<DeleteDeliveryResult>;

/** The archive's entry paths, in central-directory order. */
declare function listArchiveEntries(bytes: Uint8Array): readonly string[];
/** The exact uncompressed bytes of one entry; any structural surprise throws. */
declare function readArchiveEntry(bytes: Uint8Array, entryPath: string): Uint8Array;

/** Where the bundled graph lives inside the pinned release archive. */
declare const WORKFLOW_GRAPH_ENTRY = "workflows/delivery-v1.json";
interface WorkflowPrerequisite {
    readonly stageId: string;
    readonly when: string;
    readonly outputs: readonly string[];
    readonly allowOmitted: boolean;
}
interface WorkflowEdge {
    readonly to: string;
    readonly when: string;
}
interface WorkflowEvidenceAdapter {
    readonly requirement: string;
    readonly ref?: string;
}
interface WorkflowStage {
    readonly id: string;
    readonly semanticKind: string;
    readonly prerequisites: readonly WorkflowPrerequisite[];
    readonly mutationClass: string;
    readonly requiredness: string;
    readonly candidateBinding: string;
    readonly requiredInputs: readonly string[];
    readonly optionalInputs: readonly string[];
    readonly successOutputs: readonly string[];
    readonly statuses: readonly string[];
    readonly evidenceAdapter: WorkflowEvidenceAdapter;
    readonly edges: readonly WorkflowEdge[];
}
interface WorkflowGraph {
    readonly schemaVersion: string;
    readonly graphId: string;
    readonly stages: readonly WorkflowStage[];
}
interface WorkflowBlocker {
    readonly code: "workflow_graph_digest_mismatch" | "workflow_graph_malformed";
    readonly message: string;
}
type LoadWorkflowGraphResult = {
    readonly ok: true;
    readonly graph: WorkflowGraph;
    readonly graphSha256: string;
    readonly bytes: Uint8Array;
} | {
    readonly ok: false;
    readonly blockers: readonly WorkflowBlocker[];
};
/**
 * Loads the bundled graph from the pinned release archive's bytes. The
 * `readEntry` seam exists so a test can prove the digest check bites; the
 * default is the real archive reader.
 */
declare function loadBundledWorkflowGraph(archiveBytes: Uint8Array, options?: {
    readonly readEntry?: (archive: Uint8Array, entry: string) => Uint8Array;
}): LoadWorkflowGraphResult;
interface WorkflowCheckpointBinding {
    /** The delivery state whose next model-driven checkpoint this is. */
    readonly deliveryState: DeliveryState;
    /** A stage id the bundled graph declares. */
    readonly stageId: string;
    /**
     * Graph-declared `always` prerequisites of this stage that the frozen
     * delivery matrix realizes through LATER product-owned checkpoints rather
     * than through an earlier stage result. Prerequisite evaluation skips
     * exactly these; the graph sensor pins each name to a prerequisite the
     * graph actually declares, so a released graph change surfaces here.
     */
    readonly productRealizedPrerequisites: readonly string[];
}
/**
 * The model-driven checkpoints of the walking skeleton, bound to the bundled
 * graph's own stage names. `remediating` deliberately re-enters `implement` —
 * the graph's produce-or-revise-candidate stage — and `reviewing` binds the
 * lens-evidence acquisition stage.
 *
 * `compound` declares `finish.verify` as a prerequisite, but the frozen
 * delivery matrix orders compounding BEFORE admission/recording/finish-line
 * (`compounding -> admitting -> recording -> ready -> completed`), and the
 * finish-line evidence is enforced by those product-owned checkpoints — a
 * delivery cannot complete without it. The binding records that realization
 * explicitly instead of inventing a stage result the runtime never saw.
 */
declare const WORKFLOW_CHECKPOINT_BINDINGS: readonly WorkflowCheckpointBinding[];
declare function workflowStageBindingFor(state: DeliveryState): WorkflowCheckpointBinding | undefined;

interface ExecInvocation {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    /** Absent inherits the ambient environment; present replaces it entirely. */
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly maxBuffer?: number;
    readonly signal?: AbortSignal;
}
interface ExecOutcome {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly errorCode?: string;
}
interface ExecPort {
    run(invocation: ExecInvocation): Promise<ExecOutcome>;
}
/** The real port: a foreground, awaited `execFile` — never detached. */
declare function createExecPort(): ExecPort;

declare const PROJECTION_DIR = ".managed-projection";
declare const PROJECTION_RECEIPT_FILE = "projection-receipt.json";
type ProjectionVerificationBlockerCode = "projection_receipt_missing" | "projection_receipt_corrupt" | "projection_digest_mismatch" | "consumption_marker_missing" | "consumption_marker_corrupt";
interface ProjectionVerificationBlocker {
    readonly code: ProjectionVerificationBlockerCode;
    readonly message: string;
}
type ProjectionVerificationFailure = {
    readonly ok: false;
    readonly blockers: readonly ProjectionVerificationBlocker[];
};
type VerifyProjectionResult = {
    readonly ok: true;
    readonly projectionDigest: string;
    /** The receipted entry paths, in the receipt's own order. */
    readonly entries: readonly string[];
} | ProjectionVerificationFailure;
/** Recompute every receipted byte and require the receipt to bind itself. */
declare function verifyProjection(input: {
    readonly worktreeDir: string;
    readonly bindingDir: string;
}): Promise<VerifyProjectionResult>;
interface ConsumptionMarker {
    readonly deliveryId: string;
    readonly fence: number;
    readonly consumed: string;
}
type ReadConsumptionMarkerResult = ({
    readonly ok: true;
} & ConsumptionMarker) | ProjectionVerificationFailure;
/** Read the fence-bound marker back from the projection being adjudicated. */
declare function readConsumptionMarker(input: {
    readonly worktreeDir: string;
}): Promise<ReadConsumptionMarkerResult>;

declare const HOST_BINDING_BLOCKER_CODES: readonly ["generation_archive_unreadable", "projection_write_failed", "preexisting_worktree_excludes", "worktree_config_failed", "projection_receipt_missing", "projection_receipt_corrupt", "projection_digest_mismatch", "discovery_configuration_unreadable", "consumption_marker_missing", "consumption_marker_corrupt", "teardown_failed"];
type HostBindingBlockerCode = (typeof HOST_BINDING_BLOCKER_CODES)[number];
interface HostBindingBlocker {
    readonly code: HostBindingBlockerCode;
    readonly message: string;
}
type HostBindingFailure = {
    readonly ok: false;
    readonly blockers: readonly HostBindingBlocker[];
};
interface MaterializeProjectionInput {
    readonly worktreeDir: string;
    /** The pinned generation root (digest-addressed, already trust-checked). */
    readonly generationRoot: string;
    readonly deliveryId: string;
    /**
     * The invocation fence this materialization serves. The consumption marker
     * binds it, so the marker read back from a fence-bound submission proves the
     * bytes in the worktree are THIS run's projection and not a prior run's
     * leftovers — and the projection digest moves with every new fence.
     */
    readonly fence: number;
    /** The binding-owned directory in the product namespace for receipts and configuration. */
    readonly bindingDir: string;
    readonly exec: ExecPort;
}
type MaterializeProjectionResult = {
    readonly ok: true;
    readonly projectionDigest: string;
    readonly excludesPath: string;
} | HostBindingFailure;
/**
 * Materializes the run-pinned projection into the worktree and configures the
 * worktree-scoped exclusion. Fails closed on a pre-existing worktree excludes
 * value — preserving the operator's configuration is the rule; merging it is
 * the host-integration unit's hardening.
 */
declare function materializeProjection(input: MaterializeProjectionInput): Promise<MaterializeProjectionResult>;
interface ComposeClaudeCodeSessionInput {
    readonly bindingDir: string;
    /** The binding state file the model-external hook consults per invocation. */
    readonly statePath: string;
    /** The command vector that runs the hook entry (the caller supplies the runtime). */
    readonly hookCommand: readonly string[];
    /**
     * The fence THIS session is admitted under, baked into the hook command it
     * carries. The binding state file is per-delivery and a later invocation
     * overwrites it, so a superseded-but-still-running session would otherwise
     * read the successor's consistent grant and attestation. The baked fence is
     * the session's own identity: when it stops matching the state file, this
     * session has been superseded and its tools close.
     */
    readonly fence: number;
    /** Exact host-created workspace this admission applies to. */
    readonly workspaceRoot: string;
    /** Shared Git authority, which neither Bash nor file tools may read or mutate. */
    readonly commonGitDir: string;
    /** Installation-owned capability state, outside the model's admitted filesystem. */
    readonly authorityDir: string;
    /** The stage grant projected into both tool permissions and the OS sandbox. */
    readonly grant: {
        readonly allowedCapabilities: readonly string[];
        readonly writablePaths: readonly string[];
        readonly protectedPaths: readonly string[];
    };
}
type ComposeClaudeCodeSessionResult = {
    readonly ok: true;
    readonly settingsPath: string;
    /** Admission arguments for the host CLI. The product never launches it. */
    readonly cliArgs: readonly string[];
    readonly discoveryConfigurationDigest: string;
} | HostBindingFailure;
/**
 * Composes the session-scoped admission configuration: hooks wired to the
 * model-external interceptor and lifecycle entries, and setting sources
 * restricted to the user scope so candidate-writable scopes never load.
 */
declare function composeClaudeCodeSession(input: ComposeClaudeCodeSessionInput): Promise<ComposeClaudeCodeSessionResult>;
interface MintGrantAttestationInput {
    readonly grant: unknown;
    readonly expectation: AdmissionExpectation;
    readonly expiry: string;
}
/**
 * The binding's attestation mint: binds the exact expectation and grant
 * bytes. A checkpoint attestation binds every delivery-scoped identity; an
 * intake attestation binds the intake draft and records every delivery-scoped
 * member EXPLICITLY absent-by-state — pre-delivery there is no fence,
 * workspace, projection, or registration to bind.
 */
declare function mintGrantAttestation(input: MintGrantAttestationInput): Record<string, unknown>;

/**
 * The gate-record artifact spec, matched by SUFFIX.
 *
 * Every consumer owns its own copy of this artifact and names the spec after
 * itself — `athena-shadow-milestone-gate-record/1` in Athena, and
 * `delivery-harness-shadow-milestone-gate-record/1` in this repository's own
 * shadow window — while the record contract inside is identical. Pinning one
 * consumer's full string would make the product able to record consumption for
 * exactly one repository, which is the opposite of what a product-side writer
 * is for; it refused this repository's own artifact until this was widened.
 *
 * The suffix still carries the version, so a `/2` artifact is refused rather
 * than written into with `/1` semantics. This is a shape guard, not an
 * authorization, and it never was one: the public facade derives one canonical
 * target from its protected repository context, and this writer rechecks that
 * target record's repository identity before it creates a lock or replaces a
 * byte. A hostile spec therefore grants nothing.
 *
 * The suffix permits adopters to keep their own record spelling, while the
 * derived expected repository identity prevents one adopter's delivery from
 * entering another adopter's comparison set.
 */
declare const SHADOW_MILESTONE_GATE_RECORD_SPEC_SUFFIX = "shadow-milestone-gate-record/1";
/** Athena's spelling of it — the first consumer, kept for callers that name it. */
declare const SHADOW_MILESTONE_GATE_RECORD_SPEC = "athena-shadow-milestone-gate-record/1";
/**
 * The record the guard admits: source, affirmation, the digest the binding
 * receipted at materialization, and the marker fields that tie it to one run.
 */
interface ProjectionConsumptionRecord {
    readonly source: "binding";
    readonly affirmative: true;
    readonly projectionDigest: string;
    readonly marker: {
        readonly deliveryId: string;
        readonly fence: number;
        readonly consumed: string;
    };
}
declare const CONSUMPTION_GATE_RECORD_BLOCKER_CODES: readonly ["gate_record_unreadable", "gate_record_unrecognized", "gate_record_repository_mismatch", "gate_record_locked", "gate_record_write_failed"];
type ConsumptionGateRecordBlockerCode = (typeof CONSUMPTION_GATE_RECORD_BLOCKER_CODES)[number];
/**
 * Why an observation did not become an entry. Each of these is an honest
 * absence, not a defect: the run did not consume THIS binding's projection, so
 * the delivery stays out of the comparison set.
 */
type ProjectionConsumptionUnobserved = "projection-unverified" | "marker-unreadable" | "marker-names-another-run" | "projection-not-consumed";
type EmitProjectionConsumptionResult = {
    readonly ok: true;
    readonly emitted: true;
    readonly record: ProjectionConsumptionRecord;
} | {
    readonly ok: true;
    readonly emitted: false;
    readonly reason: ProjectionConsumptionUnobserved;
} | {
    readonly ok: false;
    readonly blockers: readonly {
        readonly code: ConsumptionGateRecordBlockerCode;
        readonly message: string;
    }[];
};

declare const PROJECTION_CONSUMPTION_OBSERVATION_SPEC = "projection-consumption-observation/1";
interface ProjectionConsumptionObservation {
    readonly spec: typeof PROJECTION_CONSUMPTION_OBSERVATION_SPEC;
    readonly deliveryId: string;
    readonly fence: number;
    readonly entry: string;
    readonly canonicalProjectionPath: string;
    readonly projectionDigest: string;
    readonly hostInvocationId: string;
    readonly observedAt: string;
}
/** Parse the one shared envelope; partial and provider-specific variants fail closed. */
declare function parseProjectionConsumptionObservation(value: unknown): ProjectionConsumptionObservation | undefined;
declare const projectionConsumptionObservationFile: (fence: number) => string;

/**
 * The evidence module's V-slice: the mandatory review floor over recorded reviewer
 * attempts, and the criterion-by-criterion outcome composition that keeps a
 * green-but-unrelated change from passing.
 *
 * REVIEW QUALITY IS QUALIFIED, NOT ASSERTED. Every attempt also binds the
 * digest of the reviewer charter its lens declares, written by the product
 * from the compiled lens declaration and that charter's trusted pre-run
 * materialization. An attempt bound to any other charter does not satisfy
 * that lens, so two attempts sharing a category label are no longer
 * interchangeable. The digest is never read back from a submission: every
 * charter is readable, so an echoed digest would prove read access rather
 * than that the charter reached the reviewer.
 *
 * WHAT THIS DOES AND DOES NOT PROVE, HONESTLY. It binds WHICH charter governs
 * a lens and makes a substitution detectable. Handing that charter's prose to
 * the reviewing agent is the host's act, and no surface here performs it —
 * so this qualifies the lens, it does not yet witness the reading.
 *
 * INDEPENDENCE IS FALSIFIABLE. Every attempt binds a context digest; two
 * attempts carrying the same digest are the same review invoked twice, and
 * re-invoking the same agent, prompt, and context under a fresh attempt
 * identity does not satisfy the floor. The floor also demands both mandatory
 * lenses, distinct attempt identities, and attempts bound to the CURRENT
 * candidate — an aligned final review after every mutation, never a stale
 * approval carried forward.
 *
 * CRITERION MAPPING. Each acceptance criterion maps to the trusted sensor's
 * latest result FOR THE EXACT CANDIDATE. A missing result, a failed result,
 * or a result naming a different candidate leaves the criterion `blocked` —
 * the disposition the merge-ready finish line refuses — which is precisely
 * how an unrelated green change fails criterion mapping instead of riding
 * through on repository-wide green.
 */

/** The evidence module's rejection vocabulary widens the spine's, never edits it. */
type ReviewRejectionCode = SpineRejectionCode | "duplicate_review_context" | "persona_digest_mismatch";
interface ReviewRejection {
    readonly code: ReviewRejectionCode;
    readonly pointer: string;
    readonly message: string;
}
type ReviewVerdict = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly rejections: readonly ReviewRejection[];
};
interface RecordedReviewAttempt {
    readonly attemptId: string;
    readonly lensId: string;
    readonly contextDigest: string;
    readonly artifactDigest: string;
    readonly verdict: "approved" | "findings";
    /** The candidate the attempt reviewed — independence is per candidate. */
    readonly candidateTreeSha: string;
    /**
     * The reviewer charter this attempt's reviewer was handed. The PRODUCT
     * writes it, resolved from the compiled lens declaration and that charter's
     * trusted pre-run materialization; it is never sourced from a submission.
     */
    readonly personaDigest: string;
}
interface RecordedSensorResult {
    readonly capabilityId: string;
    readonly outcome: "passed" | "failed";
    readonly summary: string;
    readonly candidateTreeSha: string;
}
interface ReviewLensSelection {
    readonly lensId: string;
    readonly category: string;
    /** The charter the compiled policy references for this lens. */
    readonly personaDigest: string;
}
interface QualifiedAttempts {
    /** Attempts that count toward independence, in submission order. */
    readonly qualified: readonly RecordedReviewAttempt[];
    /** Same-context re-invocations: recorded, but they can never count. */
    readonly disqualified: readonly {
        readonly attempt: RecordedReviewAttempt;
        readonly collidesWith: string;
    }[];
}
/**
 * Same-context re-invocation under a fresh attempt identity does not qualify
 * as independence: the FIRST attempt carrying a context digest counts, and
 * every later attempt carrying the same digest is disqualified. Only attempts
 * bound to the current candidate are considered at all.
 */
declare function qualifyReviewAttempts(attempts: readonly RecordedReviewAttempt[], candidateTreeSha: string): QualifiedAttempts;
/**
 * The admission-side review floor. Considers only attempts bound to the
 * current candidate; everything else is a superseded review. A duplicated
 * attempt identity rejects outright; a duplicated context disqualifies the
 * re-invocation, so a mandatory lens covered only by a same-context
 * re-invocation is an uncovered lens.
 */
declare function checkReviewFloor(input: {
    readonly attempts: readonly RecordedReviewAttempt[];
    readonly lenses: readonly ReviewLensSelection[];
    readonly candidateTreeSha: string;
}): ReviewVerdict;
/** One criterion whose waiver was CONSUMED — never merely proposed. */
interface ConsumedWaiver {
    readonly criterionId: string;
    /** The approval this disposition rests on, named in the claim. */
    readonly reference: string;
}
/**
 * Composes the outcome-verification claim: each acceptance criterion mapped
 * to the trusted sensor's exact-candidate evidence and one disposition.
 * Composition never invents a pass — an unproven criterion is `blocked`.
 *
 * `amended-waived` appears ONLY where a waiver was consumed under the
 * sensitive-approval lane, and only where the criterion would otherwise have
 * blocked: a waiver is a way past missing evidence, never a way to relabel
 * evidence that exists.
 *
 * HOW FAR THAT REACHES TODAY, HONESTLY. The disposition is composed here, but
 * whether it can carry a delivery to success depends on the criterion-to-
 * evidence mapping the compiled policy supplies. Under the fixed
 * one-sensor disposable policy every criterion resolves to the SAME sensor
 * result, so criteria pass or block together and a waiver can only turn one
 * refusal into another — it never converts a refused admission into an
 * admitted one. A policy mapping criteria to distinct sensors is what makes
 * the lane productive; the doctrine above is what keeps it honest when it is.
 */
declare function composeOutcomeVerification(input: {
    readonly contract: AcceptedContract;
    readonly candidate: {
        readonly treeSha: string;
        readonly deliverableDigest: string;
    };
    readonly sensorResults: readonly RecordedSensorResult[];
    readonly attempts: readonly RecordedReviewAttempt[];
    readonly waivedCriteria?: readonly ConsumedWaiver[];
}): OutcomeVerification;

/** The two approving actions, and the whole difference between them. */
declare const WAIVER_ACTIONS: readonly ["waive-criterion", "confirm-outcome-amendment"];
type WaiverAction = (typeof WAIVER_ACTIONS)[number];
/** The approving identity the assertion origin carries, and its prefix. */
declare const WAIVER_APPROVAL_ORIGIN_PREFIX = "waiver-approval:";
interface WaiverProposal {
    readonly requestKind: "waiver" | "amendment";
    readonly criterionId: string;
    readonly actorId: string;
    /** The candidate the proposal was made against; a later candidate stales it. */
    readonly candidateTreeSha: string;
}
interface WaiverConsumptionContext {
    readonly deliveryId: string;
    readonly deliveryState: DeliveryState;
    readonly candidateTreeSha: string;
    readonly policyDigest: string;
    readonly productTrustRevocationEpoch: number;
    readonly repositoryAuthorityRevocationEpoch: number;
    readonly invocationFence: number;
    /** The pending proposal this consumption answers, when one is pending. */
    readonly proposal: WaiverProposal | undefined;
    readonly contractCriterionIds: readonly string[];
    /** Identities policy declared able to confirm an outcome amendment; empty is denial. */
    readonly outcomeAuthorities: readonly string[];
    readonly currentProfile: string;
    readonly consumedNonces: ReadonlySet<string>;
    /** The caller-observed instant; this module never reads a clock. */
    readonly now: string;
}
interface WaiverRefusal {
    readonly code: string;
    readonly message: string;
}
type WaiverConsumptionVerdict = {
    readonly ok: true;
    readonly outcomeChanging: boolean;
    readonly criterionId: string;
} | {
    readonly ok: false;
    readonly blockers: readonly WaiverRefusal[];
};
declare function evaluateWaiverConsumption(assertion: Record<string, unknown>, context: WaiverConsumptionContext): WaiverConsumptionVerdict;
type PositiveCriterionVerdict = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly blockers: readonly WaiverRefusal[];
};
/**
 * The admission-side blanket-waiver rule: at least one acceptance criterion
 * must have PASSED. Every criterion waived, or no criterion at all, is not a
 * delivery that succeeded.
 */
declare function checkPositiveCriterion(criteria: readonly OutcomeCriterion[]): PositiveCriterionVerdict;

/** Every blocker code the delivery journal can carry, and its remediation. */
declare const DELIVERY_BLOCKER_REMEDIATIONS: Readonly<Record<string, string>>;
declare function remediationFor(code: string): string;
interface BlockerInventoryEntry {
    readonly code: string;
    readonly summary: string;
    readonly remediation: string;
    /** Whether the delivery later stood in a non-suspended state again. */
    readonly resolved: boolean;
}
interface JournalKindPayload {
    readonly kind: string;
    readonly payload: Record<string, unknown>;
}
/**
 * The inventory, in journal order. A blocker is `resolved` once a later
 * committed transition leaves the delivery in a non-suspended state — which
 * covers both the ordinary blocked-and-resumed loop and the typed escape that
 * records a blocker without suspending anything.
 */
declare function composeBlockerInventory(views: readonly JournalKindPayload[]): readonly BlockerInventoryEntry[];

/** This unit's refusal record: the spine's shape with a wider code set. */
interface FinishLineRefusal {
    readonly code: string;
    /** RFC 6901 pointer to the offending value. */
    readonly pointer: string;
    readonly message: string;
}
/** How the external verifier — the hosted statement of the merge-ready rule — resolved. */
declare const EXTERNAL_VERIFICATIONS: readonly ["passed", "failed", "unavailable"];
type ExternalVerification = (typeof EXTERNAL_VERIFICATIONS)[number];
/** The action each finish line beyond merge-ready would have to invoke. */
declare const FINISH_LINE_ACTIONS: Readonly<Record<string, ExternalAction | undefined>>;
interface FinishLineActionInput {
    readonly action: ExternalAction;
    readonly contract: AcceptedContract;
    readonly policy: PolicySnapshot;
    /** The actions the compiled policy requires an approval for. */
    readonly approvalRequiredActions?: readonly string[];
}
type FinishLineActionAuthorization = {
    readonly ok: true;
    readonly nextState: "awaiting_approval" | "acting";
} | {
    readonly ok: false;
    readonly refusals: readonly FinishLineRefusal[];
};
/**
 * Is this external action authorized right now? Every rule is a conjunction
 * and each is reported on its own, so the matrix reads as a matrix:
 *
 *   1. the contract may not request beyond the compiled policy — which, once
 *      the action is required to be a REQUESTED authority, also makes an
 *      ungranted action unreachable;
 *   2. a merge-ready finish line authorizes no external action at all;
 *   3. the action must be one the contract actually requested.
 */
declare function authorizeFinishLineAction(input: FinishLineActionInput): FinishLineActionAuthorization;
interface ExternalActionIntent {
    readonly intentId: string;
    readonly action: ExternalAction;
    readonly candidate: {
        readonly treeSha: string;
        readonly deliverableDigest: string;
    };
    readonly policyDigest: string;
    readonly approval: "required" | "not-required";
}
type ExternalActionInvocation = {
    readonly ok: true;
    readonly externalReference: string;
} | {
    readonly ok: false;
    readonly refusals: readonly FinishLineRefusal[];
};
/**
 * The seam a repository's executable merge/deploy adapter binds to. The
 * concrete operations remain repository adapters; this unit owns only the
 * port's shape.
 */
interface ExternalActionPort {
    invoke(intent: ExternalActionIntent): Promise<ExternalActionInvocation>;
}
/**
 * The port with no adapter bound — the only port this slice ships. An
 * authorized intent still cannot reach an external action through it, which is
 * what makes "authority is modelled, never exercised" mechanical rather than a
 * convention.
 */
declare const UNBOUND_EXTERNAL_ACTION_PORT: ExternalActionPort;
interface FinishLineInput {
    readonly deliveryId: string;
    readonly contract: AcceptedContract;
    readonly policy: PolicySnapshot;
    readonly outcome: OutcomeVerification;
    /**
     * The recorded delivery: the candidate recaptured at the `recording`
     * transition, the base tip the tracked record itself binds, and the record's
     * digest.
     */
    readonly record: {
        readonly treeSha: string;
        readonly baseTipSha: string;
        readonly digest: string;
    };
    /** The same two values observed now: terminal success is a canonical recheck site. */
    readonly observed: {
        readonly treeSha: string;
        readonly baseTipSha: string;
    };
    readonly admission: {
        readonly admitted: boolean;
        readonly completedObligations: readonly string[];
    };
    readonly externalVerification: ExternalVerification;
    /** The product-trust level, read verbatim from the substrate. */
    readonly declaredProductTrustLabel: string;
    readonly approvalRequiredActions?: readonly string[];
}
type FinishLineDecision = {
    readonly kind: "completed";
    readonly result: FinishLineResult;
} | {
    readonly kind: "awaiting_approval";
    readonly action: ExternalAction;
} | {
    readonly kind: "acting";
    readonly action: ExternalAction;
} | {
    readonly kind: "blocked";
    readonly refusals: readonly FinishLineRefusal[];
};
declare function decideFinishLine(input: FinishLineInput): FinishLineDecision;

/**
 * The managed-delivery operation inventory: every facade operation, the
 * authorization capability it costs, whether it binds the invocation fence,
 * what it does to the expected journal revision, and which surfaces may reach
 * it.
 *
 * WHY THIS IS DATA AND NOT PROSE. The facade's boundary is a set of claims
 * that are easy to state and easy to erode: confirmations are served only by
 * the binding's model-external channel; termination provenance enters only
 * through its trusted integration; the tool surfaces
 * inspect rather than orchestrate. Written as comments those claims decay the first time a
 * command is added. Written here they are checkable, and
 * `checkFacadeSurfaceInvariants` is what checks them — over this inventory in
 * the kernel's own suite, and over the CLI's and MCP's advertised surfaces in
 * the contract-inventory sensor that sits above both packages.
 *
 * THIS INVENTORY GRANTS NOTHING. It describes what an operation costs and
 * where it is reachable. Authority still enters only through the compiled
 * policy snapshot, the invocation fence, and the two non-model-mintable
 * authorization classes; an entry here cannot make an unauthorized call
 * succeed, and removing one cannot make an authorized call fail.
 */
/**
 * The six capability classes an operation can cost.
 *
 * `read` observes and never writes. `control` is delivery progression driven
 * by a bound host task. `maintenance` is the installation-scoped lane: update,
 * rollback, trust-state edits, retention, and the security-blocked migration.
 * `approval` is a sensitive approval, which requires the host- or OS-native
 * assertion. `confirmation` is an operator confirmation, which requires no
 * assertion but is model-external by construction. `action` actions the
 * policy-selected finish line.
 */
declare const FACADE_CAPABILITY_CLASSES: readonly ["read", "control", "maintenance", "approval", "confirmation", "action"];
type FacadeCapabilityClass = (typeof FACADE_CAPABILITY_CLASSES)[number];
/**
 * Where an operation can be reached from.
 *
 * `cli` and `mcp` are the model-visible tool surfaces. `binding-channel` is
 * the isolated interactive channel the qualified host binding owns, outside
 * the model-visible tool and shell surface. `integration-event` is the trusted
 * host-runtime integration for lifecycle and native review events. `facade`
 * means the operation is reachable only as a library call by an embedding
 * product surface.
 */
declare const FACADE_SURFACES: readonly ["cli", "mcp", "binding-channel", "integration-event", "facade"];
type FacadeSurface = (typeof FACADE_SURFACES)[number];
/**
 * Whether the operation binds the invocation fence of the task making it.
 * `absent-by-state` is the frozen spelling for a value that does not exist yet
 * or does not apply, and is never rechecked.
 */
type FacadeFenceRule = "required" | "absent-by-state";
/**
 * What the operation does to the DELIVERY journal's expected revision — the
 * value fences, assertions, and confirmations bind, and the only journal
 * revision any of them names.
 *
 * `observation-only` appends without advancing it. `none` means the operation
 * does not move that value at all, which covers three cases and deliberately
 * does not distinguish them, because none of them is bindable: an operation
 * that writes nothing, a maintenance-lane operation that writes the
 * installation's own maintenance journal, and an intake operation that writes
 * the intake journal. Intake's own revision is real and its reducer enforces
 * it, but no fence, assertion, or confirmation binds it — a contract
 * confirmation binds the normalized-contract digest, not a revision — so
 * reporting it here would tell a reader this value moved when the value this
 * field names did not.
 */
type FacadeJournalRule = "advances" | "observation-only" | "none";
interface FacadeOperation {
    /** The facade method name, verbatim. */
    readonly operation: string;
    readonly capability: FacadeCapabilityClass;
    readonly fence: FacadeFenceRule;
    readonly journalRevision: FacadeJournalRule;
    readonly surfaces: readonly FacadeSurface[];
    readonly summary: string;
}
declare const FACADE_OPERATIONS: readonly FacadeOperation[];
declare function facadeOperation(operation: string): FacadeOperation | undefined;
declare function operationsOnSurface(surface: FacadeSurface): readonly FacadeOperation[];
type FacadeSurfaceRule = "confirmation-off-channel" | "mcp-not-read-only" | "termination-provenance-callable" | "duplicate-operation" | "fence-without-revision";
interface FacadeSurfaceFinding {
    readonly rule: FacadeSurfaceRule;
    readonly operation: string;
    readonly message: string;
}
/** The operation whose provenance may never become model-callable. */
declare const TERMINATION_PROVENANCE_OPERATION = "recordTerminationProvenance";
/**
 * Judges an inventory against the boundary this facade exists to hold. Returns
 * every finding rather than the first, so one run reports the whole erosion.
 */
declare function checkFacadeSurfaceInvariants(operations: readonly FacadeOperation[]): readonly FacadeSurfaceFinding[];

/**
 * The one typed status model, and the projection that composes it.
 *
 * WHY ONE MODEL. Every operator-facing surface — the CLI, the MCP tool, and
 * any later control-plane or UI projection — asks the same question of a
 * managed delivery, and each one answering it from raw journal facts is how
 * two surfaces come to disagree about whether a delivery may be resumed. This
 * module is the single answer: the facade gathers the raw facts, this composes
 * them, and every surface renders the result without re-deciding anything.
 *
 * THE PROJECTION IS PURE. It performs no I/O and consults no clock. Aging an
 * observation, reading the trust store, and probing the assertion source are
 * the facade's work; what arrives here is already decided, so the derivations
 * that matter — authorized next actions, mutation verification, retry safety,
 * and the migration path — are directly testable without a repository.
 *
 * IT IS ALSO AN AUDIT PROJECTION. `authorizedNextActions` names operations the
 * inventory declares, and `operationContracts` carries their capability, fence,
 * and journal-revision rules alongside, so a reader can see not just what may
 * be done next but what it costs. Naming an action here still grants nothing:
 * the operation itself rechecks every binding when it is called.
 */

/** The workspace dispositions a delivery journal can record. */
type WorkspaceDisposition = "quarantined" | "takeover" | "reconciled" | "prior_host_termination_unverified";
/**
 * The next valid checkpoint, as the reducer's state determines it. Defined
 * here because the status model carries it and every surface renders it.
 */
type ManagedCheckpoint = {
    readonly kind: "bind-workspace";
} | {
    readonly kind: "workflow-stage";
    readonly stageId: string;
    readonly remediation: boolean;
    readonly grantDigest: string;
} | {
    readonly kind: "repository-sensor";
    readonly capabilityId: string;
} | {
    readonly kind: "review";
    readonly stageId: string;
    readonly lenses: readonly string[];
} | {
    readonly kind: "admission";
} | {
    readonly kind: "tracked-record";
} | {
    readonly kind: "finish-line";
} | {
    readonly kind: "complete";
} | {
    readonly kind: "blocked";
    readonly code: string;
    readonly summary: string;
};
interface RecordedRegistrationBinding {
    readonly registeringInstallationId: string;
    readonly activeCompositionProfile: string;
}
/**
 * How the delivery's recorded registration binding compares to the
 * installation observed now. `identity` and `profile` are deliberately
 * distinct: only the first has a migration path.
 */
type RegistrationMismatch = "none" | "identity" | "profile" | "unresolved";
interface RegistrationBindingView {
    readonly recorded: RecordedRegistrationBinding | undefined;
    readonly current: RecordedRegistrationBinding | undefined;
    readonly mismatch: RegistrationMismatch;
}
interface ProductTrustView {
    /** The declared product-trust level, read verbatim from the substrate. */
    readonly label: string;
    readonly pinnedGenerationDigest: string;
    readonly revocationEpoch: number;
    /** Whether the delivery's pinned generation may execute right now. */
    readonly generation: "eligible" | "revoked" | "not_pinned" | "unreadable";
}
interface AssertionSourceView {
    readonly availability: "available" | "unavailable" | "unconfigured";
    readonly detail: string;
    readonly lanes: LaneAvailability;
}
interface ManagedStatusInput {
    readonly deliveryId: string;
    readonly intake: {
        readonly state: IntakeState;
        readonly expectedRevision: number;
    } | undefined;
    readonly delivery: {
        readonly state: DeliveryState;
        readonly expectedRevision: number;
        readonly fence: number;
    };
    readonly hostActivity: HostActivityState;
    readonly completedObligations: readonly string[];
    readonly productTrust: ProductTrustView;
    readonly assertionSource: AssertionSourceView;
    readonly quarantinedWorkspaces: readonly string[];
    readonly candidate: {
        readonly treeSha: string;
        readonly branchRefValue: string;
    } | undefined;
    readonly pendingDecision: WaiverProposal | undefined;
    readonly registrationBinding: RegistrationBindingView;
    readonly lastWorkspaceDisposition: WorkspaceDisposition | undefined;
    /** A trusted lifecycle event at the current fence that verified descendant teardown. */
    readonly terminationVerifiedAtCurrentFence: boolean;
    readonly workspaceBound: boolean;
    readonly nextCheckpoint: ManagedCheckpoint;
    readonly resume: "none" | "takeover-required" | "same-workspace";
    readonly blockers: readonly {
        readonly code: string;
        readonly summary: string;
    }[];
    readonly policyRequiredInterruptions: number;
    readonly operatorInterventions: number;
}
/** Whether the prior workspace's mutation has been accounted for. */
type MutationVerification = "not-applicable" | "verified" | "unverified";
/**
 * Whether re-driving the delivery is safe. `never-repeat-external-action` is
 * the one value that is not about doubt: an irreversible action succeeded and
 * its verification did not, so the action must never be repeated.
 */
type RetrySafety = "safe" | "unverified-prior-mutation" | "never-repeat-external-action";
/** The exit available from `security_blocked`, if any. */
type MigrationPath = "none" | "re-preparation" | "generation-change-migration" | "rebinding-migration";
interface ManagedDeliveryStatus {
    readonly deliveryId: string;
    readonly intake: {
        readonly state: IntakeState;
        readonly expectedRevision: number;
    } | undefined;
    readonly delivery: {
        readonly state: DeliveryState;
        readonly expectedRevision: number;
        readonly fence: number;
    };
    readonly hostActivity: HostActivityState;
    readonly completedObligations: readonly string[];
    readonly productTrust: ProductTrustView;
    readonly assertionSource: AssertionSourceView;
    readonly quarantinedWorkspaces: readonly string[];
    readonly candidate: {
        readonly treeSha: string;
        readonly branchRefValue: string;
    } | undefined;
    readonly pendingDecision: WaiverProposal | undefined;
    readonly registrationBinding: RegistrationBindingView;
    readonly mutationVerification: MutationVerification;
    readonly retrySafety: RetrySafety;
    readonly migrationPath: MigrationPath;
    readonly nextCheckpoint: ManagedCheckpoint;
    readonly resume: "none" | "takeover-required" | "same-workspace";
    readonly blockers: readonly {
        readonly code: string;
        readonly summary: string;
    }[];
    readonly authorizedNextActions: readonly string[];
    /** The inventory entries for the actions named above, in the same order. */
    readonly operationContracts: readonly FacadeOperation[];
    readonly policyRequiredInterruptions: number;
    readonly operatorInterventions: number;
}
declare function composeManagedStatus(input: ManagedStatusInput): ManagedDeliveryStatus;

type FacadeFailure = {
    readonly ok: false;
    readonly blockers: readonly Blocker[];
};
interface ManagedInstallation {
    readonly installationPath: string;
    readonly receiptDir: string;
}
interface CreateFacadeInput {
    /** Any checkout of the adopter repository (root or linked worktree). */
    readonly repoDir: string;
    /** The adopter's already-compiled policy and its resolved native bindings. */
    readonly policyBinding: CompiledAdopterPolicyBinding;
    readonly installation: ManagedInstallation;
    readonly hostVersion: string;
    readonly exec?: ExecPort;
}
/**
 * The one adopter-owned seam into the portable facade. The policy compiler
 * owns grants, lenses, capability identities, and the admission projection;
 * the host/adopter supplies only resolved bytes and one trusted sensor path.
 */
interface CompiledAdopterPolicyBinding {
    readonly compiledPolicy: CompiledPolicy;
    readonly personaSources: Readonly<Record<string, ResolvedPersonaSource>>;
    readonly sensor: {
        readonly capabilityId: string;
        readonly trustedBasePath: string;
    };
    readonly outcomeAuthorities: readonly string[];
}
type ResolvedPersonaSource = {
    readonly origin: "composition";
    readonly bytes: string;
    readonly digest: string;
} | {
    readonly origin: "repository";
    readonly bytes: string;
    readonly digest: string;
    readonly trustedBasePath: string;
};
declare const compiledAdopterPolicyBindingDigest: (binding: CompiledAdopterPolicyBinding) => string;
interface ManagedDeliveryFacade {
    readonly namespaceDir: () => Promise<string>;
    /**
     * The host-native intake entrypoint: opens an iterative intake for an
     * outcome-only work request. The scope workflow the host runs against it
     * executes under the READ-ONLY intake grant minted here — the admission is
     * never mutation-capable, and every delivery-scoped identity is recorded
     * explicitly absent-by-state.
     */
    openIntake(input: {
        readonly workRequest: string;
        readonly observedAt: string;
        readonly attestationExpiry: string;
    }): Promise<{
        readonly ok: true;
        readonly intakeId: string;
        readonly grantDigest: string;
        readonly grantPath: string;
    } | FacadeFailure>;
    /** Durably retains one clarification exchange of the scope workflow. */
    recordClarification(input: {
        readonly intakeId: string;
        readonly question: string;
        readonly answer: string;
    }): Promise<{
        readonly ok: true;
    } | FacadeFailure>;
    /**
     * Durably retains the current draft contract. A draft recorded after
     * presentation VOIDS the pending confirmation — the operator confirmed
     * different bytes — and a draft recorded while acceptance is blocked
     * returns intake to the confirmation handoff through the frozen chain.
     */
    recordDraft(input: {
        readonly intakeId: string;
        readonly draft: unknown;
    }): Promise<{
        readonly ok: true;
        readonly draftDigest: string;
    } | FacadeFailure>;
    /** Presents the retained draft for the ONE operator confirmation. */
    presentDraft(input: {
        readonly intakeId: string;
        readonly expiry: string;
    }): Promise<{
        readonly ok: true;
        readonly nonce: string;
        readonly normalizedContractDigest: string;
        readonly channelPath: string;
    } | FacadeFailure>;
    /**
     * Re-runs acceptance validation after a preflight failure, WITHOUT a new
     * operator confirmation: the journal guarantees the draft cannot have
     * changed since the consumed confirmation, so the confirmation stands.
     */
    retryAcceptance(input: {
        readonly intakeId: string;
    }): Promise<{
        readonly ok: true;
        readonly deliveryId: string;
    } | FacadeFailure>;
    /**
     * The already-scoped fallback lane: no product-owned intake turn runs, but
     * the frozen chain is identical from the draft record on — contract
     * validation and the operator confirmation are never bypassed.
     */
    presentContract(input: {
        readonly contract: AcceptedContract;
        readonly expiry: string;
    }): Promise<{
        readonly ok: true;
        readonly intakeId: string;
        readonly nonce: string;
        readonly normalizedContractDigest: string;
        readonly channelPath: string;
    } | FacadeFailure>;
    /**
     * Consumes the operator confirmation at the EXIT of awaiting_confirmation,
     * runs acceptance validation in validating_acceptance, and — only when it
     * passes — completes registration at accepted_contract, on the facade side,
     * outside intake's capability set. A preflight failure blocks the intake
     * with the consumed confirmation intact for `retryAcceptance`.
     */
    confirmContract(input: {
        readonly intakeId: string;
        readonly echo: ConfirmationEchoAttempt;
    }): Promise<{
        readonly ok: true;
        readonly deliveryId: string;
    } | FacadeFailure>;
    bindWorkspace(input: {
        readonly deliveryId: string;
        readonly worktreeDir: string;
        readonly hostTaskId: string;
        readonly observedAt: string;
        readonly attestationExpiry: string;
        readonly observationLifetimeSeconds?: number;
        /** Root proof created and retained by the operator-owned host. */
        readonly providerReviewBindingCapability: ProviderReviewCapability;
    }): Promise<{
        readonly ok: true;
        readonly fence: number;
        readonly workspaceId: string;
        readonly statePath: string;
        readonly settingsPath: string;
        readonly cliArgs: readonly string[];
        readonly projectionDigest: string;
    } | FacadeFailure>;
    /**
     * The one typed status model. Every operator-facing surface renders this
     * result without re-deriving anything from the journal, so the CLI, the MCP
     * tool, and any later projection cannot disagree about whether a delivery may
     * be resumed, migrated, or retried.
     *
     * Host disappearance is reported LAZILY and here: a graceful lifecycle event
     * reports `paused`, while an activity observation aged past the fence's
     * declared lifetime reports `unknown` on this observation. Timeout never
     * proves termination.
     */
    status(input: {
        readonly deliveryId: string;
        readonly observedAt: string;
    }): Promise<{
        readonly ok: true;
        readonly status: ManagedDeliveryStatus;
    } | FacadeFailure>;
    nextCheckpoint(input: {
        readonly deliveryId: string;
    }): Promise<{
        readonly ok: true;
        readonly checkpoint: ManagedCheckpoint;
    } | FacadeFailure>;
    submitStageResult(input: {
        readonly deliveryId: string;
        readonly stageId: "plan" | "compound";
        readonly resultBytes: string;
        /** The fence the invoking task was bound under; an older fence's output is permanently rejected, and omitting it fails closed. */
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly state: DeliveryState;
    } | FacadeFailure>;
    checkpointCandidate(input: {
        readonly deliveryId: string;
        readonly resultBytes: string;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly state: DeliveryState;
        readonly treeSha: string;
    } | FacadeFailure>;
    runSensor(input: {
        readonly deliveryId: string;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly outcome: "passed" | "failed";
        readonly state: DeliveryState;
    } | FacadeFailure>;
    /** Prepares one exact reviewer invocation after proving the standing binding. */
    prepareProviderReviewHandoff(input: {
        readonly deliveryId: string;
        readonly expectedFence: number;
        readonly expectedWorkspaceId: string;
        readonly nativeSessionId: string;
        readonly nativeRunId: string;
        readonly finalPassId: string;
        readonly lensId: string;
        /** Host-created snapshot outside model/reviewer writable roots; the trusted host owns its lifecycle. */
        readonly reviewWorkspaceDir: string;
        /** Instructions joined with trusted persona, contract, and sensor bytes by the binding. */
        readonly reviewInstructionsBytes: string;
        readonly bindingCapability: ProviderReviewCapability;
        readonly invocationCapability: ProviderReviewCapability;
    }): Promise<{
        readonly ok: true;
        readonly handoff: ProviderReviewHandoff;
        readonly handoffPath: string;
    } | FacadeFailure>;
    /** Accepts one native result only with the invocation proof retained by its host. */
    ingestProviderReviewResult(input: {
        readonly deliveryId: string;
        readonly handoffId: string;
        readonly resultBytes: string;
        readonly fence: number;
        readonly invocationCapability: ProviderReviewCapability;
    }): Promise<{
        readonly ok: true;
        readonly replay: "recorded" | "identical";
        readonly disposition: "approved" | "changes_requested";
    } | FacadeFailure>;
    reduceReview(input: {
        readonly deliveryId: string;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly state: DeliveryState;
    } | FacadeFailure>;
    admit(input: {
        readonly deliveryId: string;
        readonly recordedAtInstant: string;
        readonly env: EnvSnapshot;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly state: DeliveryState;
    } | FacadeFailure>;
    prepareTrackedRecord(input: {
        readonly deliveryId: string;
        readonly env: EnvSnapshot;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly relativePath: string;
    } | FacadeFailure>;
    confirmTrackedRecord(input: {
        readonly deliveryId: string;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly state: DeliveryState;
    } | FacadeFailure>;
    completeFinishLine(input: {
        readonly deliveryId: string;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly state: DeliveryState;
        readonly resultDigest: string;
    } | FacadeFailure>;
    sessionEnded(input: {
        readonly deliveryId: string;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
    } | FacadeFailure>;
    /**
     * TERMINATION PROVENANCE, and the only door it enters through. The caller is
     * the trusted host-runtime lifecycle integration — never a model-callable
     * tool — reporting that an invocation ended cleanly.
     *
     * The caller reports only THAT, and nothing else. Whether the clean end also
     * proves the invocation's descendants are gone is not a claim any caller may
     * make: the descendant-teardown status is read from the graded capability
     * record inside the pinned generation — whose digest closure is verified on
     * every guarded call — and the resume position is derived from it here. No
     * argument to this operation, and nothing a session writes into the binding
     * state file, can widen it.
     *
     * What this does NOT defend is the delivery journal itself. On a host with no
     * protected common-Git authority path, a granted shell capability writes the
     * journal directly, and the payload grammar only enforces a record's internal
     * consistency. Closing that belongs to the host's own sandbox, not to this
     * operation. Every graded host states its own position on that path rather
     * than leaving it absent: the record carries
     * `commonGitAuthorityPathProtected` as `supported` for Codex's OS sandbox and
     * as `unsupported` for Claude Code, whose ordinary stage sessions hold the
     * shell capability the shipped mutation-stage grant allows.
     *
     * Crash provenance has no entrypoint at all: no supported host supplies it,
     * no daemon exists to observe it, and the product never infers it.
     */
    recordTerminationProvenance(input: {
        readonly deliveryId: string;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly descendantTeardown: "verified" | "unverified";
        readonly resumeEligibility: "same-workspace" | "fresh-worktree-only";
    } | FacadeFailure>;
    /**
     * Tears the run-pinned projection and the binding-written discovery
     * configuration down with the worktree, so nothing the binding wrote
     * outlives the workspace it was scoped to.
     */
    tearDownWorkspaceProjection(input: {
        readonly deliveryId: string;
    }): Promise<{
        readonly ok: true;
    } | FacadeFailure>;
    /**
     * A waiver or contract-amendment proposal: journaled with a pending marker
     * while the delivery remains in its current state. Consumption belongs to
     * the sensitive-approval lane (its journal kind stays reserved here); a
     * candidate change since proposal voids the stale proposal with a typed
     * blocker record.
     */
    recordApprovalRequest(input: {
        readonly deliveryId: string;
        readonly requestKind: "waiver" | "amendment";
        readonly criterionId: string;
        readonly actorId: string;
        readonly reason: string;
        readonly fence: number;
    }): Promise<{
        readonly ok: true;
        readonly state: DeliveryState;
    } | FacadeFailure>;
    /**
     * The waiver's approval half, and the ONLY way a proposal becomes valid.
     * One fresh model-external interactive evaluation from the installation's
     * configured assertion source is consumed as a delivery-bound sensitive
     * approval against the pending proposal: an approver who is the proposer is
     * refused, a proposal made against a superseded candidate voids, and an
     * expired or replayed evaluation is refused.
     *
     * `outcomeChanging` selects the approving action, and only a
     * policy-declared outcome authority may take it. A confirmed amendment
     * creates a NEW contract identity and forces full re-evaluation — which is
     * why it is not consumable at `admitting`: there is no review left to
     * re-open from there.
     */
    consumeWaiver(input: {
        readonly deliveryId: string;
        /** The approving identity; never the proposing actor. */
        readonly approverId: string;
        readonly outcomeChanging: boolean;
        readonly fence: number;
        /** The consumption instant; the facade never consults a clock itself. */
        readonly now: string;
        readonly assertionSource?: AssertionSourcePort;
    }): Promise<{
        readonly ok: true;
        readonly criterionId: string;
        readonly outcomeChanging: boolean;
        readonly contractId: string;
        readonly state: DeliveryState;
    } | FacadeFailure>;
    /**
     * The blocker/remediation inventory: every blocker this delivery journaled,
     * its declared remediation, and whether the delivery left the suspended
     * state it caused. This is the audit surface for review loops — the current
     * state says only where the delivery is now.
     */
    blockerInventory(input: {
        readonly deliveryId: string;
    }): Promise<{
        readonly ok: true;
        readonly entries: readonly BlockerInventoryEntry[];
    } | FacadeFailure>;
    /**
     * Cancellation, first half: enter `cancellation_requested`, revoke the
     * invocation fence for the model-external interceptor, and request native
     * host cancellation (fence-revocation-only on hosts without a trusted
     * cancellation acknowledgement). The delivery is NOT terminal yet.
     */
    requestCancellation(input: {
        readonly deliveryId: string;
    }): Promise<{
        readonly ok: true;
        readonly state: DeliveryState;
    } | FacadeFailure>;
    /**
     * Cancellation, second half: terminal `cancelled` through permanent
     * quarantine of the prior workspace and preservation of the last trusted
     * candidate. This path never claims that the prior task or its descendants
     * terminated.
     */
    finalizeCancellation(input: {
        readonly deliveryId: string;
    }): Promise<{
        readonly ok: true;
        readonly state: DeliveryState;
    } | FacadeFailure>;
    /** Export the delivery's durable detail to an owned namespace path; journaled to the maintenance journal. */
    exportDelivery(input: {
        readonly deliveryId: string;
    }): Promise<{
        readonly ok: true;
        readonly exportPath: string;
        readonly artifactDigest: string;
    } | FacadeFailure>;
    /**
     * Delete a TERMINAL delivery's durable detail, preserving the minimum
     * candidate/policy/evidence/action audit record first. The maintenance
     * journal record survives the target's removal and reports what was
     * preserved.
     */
    deleteDelivery(input: {
        readonly deliveryId: string;
    }): Promise<{
        readonly ok: true;
        readonly preservedAuditRecords: readonly string[];
    } | FacadeFailure>;
    presentTakeover(input: {
        readonly deliveryId: string;
        readonly expiry: string;
    }): Promise<{
        readonly ok: true;
        readonly nonce: string;
        readonly channelPath: string;
        readonly supersededFence: number;
        readonly expectedJournalRevision: number;
        readonly targetBaseCommit: string;
        readonly takeoverBranchRef: string;
    } | FacadeFailure>;
    confirmTakeover(input: {
        readonly deliveryId: string;
        readonly echo: ConfirmationEchoAttempt;
    }): Promise<{
        readonly ok: true;
        readonly targetBaseCommit: string;
        readonly takeoverBranchRef: string;
    } | FacadeFailure>;
    /**
     * Turns the binding's own observation into a durable entry in the shadow
     * milestone's gate-record artifact.
     *
     * The caller names the delivery and baseline category — never the target or
     * observation. The target is the canonical gate-record path under the
     * facade's protected repository root, and the expected repository identity
     * comes from the accepted delivery contract. The delivery and fence the
     * record binds come from the binding's own workspace record,
     * and the record's contents are re-derived from the materialization receipt,
     * the marker in the worktree, and the model-external interceptor's record of
     * this run's invocations, so no caller can assert what the binding did not
     * observe. When it did not, nothing is written and the delivery stays out of
     * the comparison set.
     *
      * WHAT AN EMITTED ENTRY CERTIFIES: that the qualified host emitted a
      * PostToolUse event for this run's completed exact Read of the receipted
      * canonical workflow source. Reads outside that qualified surface are not
      * observed at all — such a delivery is excluded rather than affirmed.
     */
    recordProjectionConsumption(input: {
        readonly deliveryId: string;
        readonly category: string;
    }): Promise<{
        readonly ok: true;
        readonly emitted: true;
        readonly projectionDigest: string;
    } | {
        readonly ok: true;
        readonly emitted: false;
        readonly reason: ProjectionConsumptionUnobserved;
    } | FacadeFailure>;
    explainBlocker(input: {
        readonly deliveryId: string;
    }): Promise<{
        readonly ok: true;
        readonly blocker: {
            readonly code: string;
            readonly summary: string;
            readonly remediation: string;
        } | undefined;
    } | FacadeFailure>;
    /**
     * The maintenance-lane exit from `security_blocked`. Always: current local
     * trust state, full re-preparation, and invalidation of revoked-era
     * candidate-bound evidence. When the generation changed or the delivery is
     * being rebound to a different registering installation, additionally
     * consumes the security-blocked migration assertion — without re-fencing.
     */
    /**
     * The installation-scoped maintenance lane, reached through the one facade
     * rather than through a second entrypoint. Each of these consumes a
     * maintenance-lane sensitive assertion bound to the target installation and
     * generation identities — not to a delivery, candidate, or fence — and each
     * fails closed when no assertion source can evaluate one. They write the
     * installation's maintenance journal, never a delivery journal, so no
     * delivery's expected revision moves.
     *
     * The generation of every paused delivery is retained across an update: the
     * pin lives in each delivery's own record, and updating the installation
     * neither reads nor rewrites it.
     */
    updateComposition(input: Omit<UpdateCompositionInput, "installationPath" | "receiptDir">): Promise<{
        readonly ok: true;
        readonly generationDigest: string;
        readonly priorGenerationDigest: string;
        readonly noOp: boolean;
    } | FacadeFailure>;
    /** Restores a previously accepted, still-eligible generation. A revoked one can never be restored. */
    rollbackComposition(input: {
        readonly targetGenerationDigest: string;
        readonly assertionSource?: AssertionSourcePort;
        readonly now: string;
    }): Promise<{
        readonly ok: true;
        readonly generationDigest: string;
    } | FacadeFailure>;
    /** Pin, revoke, un-revoke, or advance the trust high-water mark. */
    maintainTrustState(input: {
        readonly assertionSource?: AssertionSourcePort;
        readonly now: string;
    } & ({
        readonly operation: "pin" | "revoke" | "unrevoke";
        readonly generationDigest: string;
    } | {
        readonly operation: "advance-high-water-mark";
        readonly highWaterMark: number;
    })): Promise<{
        readonly ok: true;
        readonly state: ProductTrustState;
    } | FacadeFailure>;
    recoverSecurityBlocked(input: {
        readonly deliveryId: string;
        /** Defaults to the delivery's recorded generation pin. */
        readonly targetGenerationDigest?: string;
        readonly assertionSource?: AssertionSourcePort;
        /** The consumption instant; the facade never consults a clock itself. */
        readonly now: string;
    }): Promise<{
        readonly ok: true;
        readonly mode: "re-preparation" | "generation-change-migration" | "rebinding-migration";
        readonly state: DeliveryState;
    } | FacadeFailure>;
}

declare function createManagedDeliveryFacade(input: CreateFacadeInput): ManagedDeliveryFacade;

interface MigrationConsumptionContext {
    readonly deliveryId: string;
    readonly expectedJournalRevision: number;
    readonly currentInstallationId: string;
    readonly currentProfile: string;
    readonly recordedInstallationId: string;
    readonly recordedProfile: string;
    readonly trustState: ProductTrustState;
    readonly consumedNonces: ReadonlySet<string>;
    readonly now: string;
    readonly trust?: ProductTrustPort;
}
interface MigrationRefusal {
    readonly code: string;
    readonly message: string;
}
type MigrationConsumptionVerdict = {
    readonly ok: true;
    readonly rebinding: boolean;
} | {
    readonly ok: false;
    readonly blockers: readonly MigrationRefusal[];
};
declare function evaluateMigrationConsumption(assertion: Record<string, unknown>, context: MigrationConsumptionContext): MigrationConsumptionVerdict;

declare class ReviewInputError extends Error {
}
type ReviewInputReader = (relativePath: string) => Promise<Uint8Array | null>;
/** One activated lens, resolved to the charter bytes the installation carries. */
interface ResolvedCharter {
    readonly origin: "composition" | "repository";
    readonly sourcePath: string;
    readonly lensId: string;
    /** The reviewer id the evidence carries: the charter path's basename. */
    readonly reviewerId: string;
    readonly personaId: string;
    /** The archive-relative path the charter's bytes were read from. */
    readonly entryPath: string;
    /** The digest of those bytes, equal to the one the compiled policy resolved. */
    readonly digest: string;
}
/**
 * The reviewers a review in `rootDir` must cover: the compiled policy's
 * activated review lenses, each resolved to the charter the installed
 * generation ships for it.
 *
 * Two resolutions rather than a list held here, because a list held here is
 * exactly how an activated lens goes unrepresented in the evidence while
 * everything stays green. The compiled snapshot decides WHICH lenses reviewed —
 * the whole shipped set is seventeen charters and this repository activates two
 * of them, so the archive alone would name fifteen reviewers that never ran.
 * The archive decides WHAT each lens was told, and the snapshot's digest is
 * checked against the bytes actually read, so a charter the installation does
 * not carry, or one whose bytes have drifted from the policy the repository is
 * judged under, refuses the emission instead of quietly reviewing under
 * something else.
 */
declare function resolveReviewCharters(read: ReviewInputReader, config?: {
    readonly additionalReviewLenses?: readonly {
        readonly lensId: string;
        readonly reviewerId: string;
        readonly charterPath: string;
    }[];
}): Promise<ResolvedCharter[]>;
/** One release identity for review, checks and portable verification. Absence is explicit. */
declare function readWorkflowRelease(read: ReviewInputReader): Promise<Readonly<Record<string, unknown>> | null>;

declare function captureCheckOutputSnapshots(rootDir: string, outputs: readonly string[], readOutput?: (repoPath: string) => Promise<Uint8Array>): Promise<readonly {
    path: string;
    sha256: string;
    base64: string;
}[] | undefined>;
declare function captureCheckOutputs(rootDir: string, outputs: readonly string[], readOutput?: (repoPath: string) => Promise<Uint8Array>): Promise<readonly {
    path: string;
    sha256: string;
}[] | undefined>;
interface CheckBindingOptions extends PreparationOptions {
    readonly readOutput?: (repoPath: string, providerId: string) => Promise<Uint8Array>;
    readonly readReleaseInputs?: ReviewInputReader;
}
declare function computeCheckWiringFingerprint(rootDir: string, config: HarnessConfig, options?: CheckBindingOptions): Promise<string>;
declare function captureCheckBindings(rootDir: string, config: HarnessConfig, candidate: CandidateBinding, options?: CheckBindingOptions): Promise<Readonly<Record<string, CheckBinding>>>;

/** Decode only the deterministic artifact slot for this configured output. */
declare function retainedCheckOutput(artifactContents: ReadonlyMap<string, string>, outputPath: string, index: number): Uint8Array;

interface ReviewContextDocument {
    readonly spec: string;
    readonly digest: string;
    readonly binding: {
        readonly gate: {
            readonly obligationId: string;
            readonly providerId: string;
        };
        readonly candidate: CandidateBinding & {
            readonly headSha: string;
        };
        readonly preparationFingerprint: string;
        readonly configurationDigest: string;
        readonly policyDigest: string | null;
        readonly release: Readonly<Record<string, unknown>>;
        readonly workflowGraphSha256: string | null;
        readonly charters: readonly ResolvedCharter[];
    };
}
/** Reuse only the existing deliverable identity, with base, policy and wiring fixed. */
declare function validateReviewedContext(original: unknown, current: ReviewContextDocument, outcome: unknown): void;
/** What one reviewer did. `approved` is the only result that stamps an approval. */
declare const REVIEWER_RESULTS: readonly ["approved", "rejected", "failed", "timed-out"];
type ReviewerResult = (typeof REVIEWER_RESULTS)[number];
interface ReviewerOutcome {
    readonly id: string;
    readonly result: ReviewerResult;
}
interface ReviewOutcome {
    readonly verdict: string;
    readonly reviewers: readonly ReviewerOutcome[];
    /** Findings, as the `review.green/1` payload defines them. Passed through. */
    readonly findings: readonly Record<string, unknown>[];
    readonly runHistory?: readonly Record<string, unknown>[];
    readonly finalPassId?: string;
    readonly cost?: Readonly<Record<string, unknown>>;
}
/**
 * Read the outcome document, and hold it to the charter set. Nothing here
 * re-implements the `review.green/1` rules: findings travel through untouched
 * so the recorder — not this script — remains the judge of what green means.
 */
declare function parseReviewOutcome(document: unknown, charters: readonly string[]): ReviewOutcome;
/**
 * Telemetry, derived from the findings exactly the way RG-8 re-derives it:
 * counts per severity, deferrals, and the sorted unique tracker ids they name.
 */
declare function deriveTelemetry(findings: readonly Record<string, unknown>[], iterationCount: number): Record<string, unknown>;
/** The reviewer lists RG-2/RG-3 read, from what each reviewer actually did. */
declare function reviewerLists(charters: readonly string[], outcome: ReviewOutcome): {
    selected: string[];
    completed: string[];
    failed: string[];
    timedOut: string[];
    approved: string[];
};

/** Bounded transport limits shared by observation and serialization. */
declare const MAX_PORTABLE_ARTIFACT_BYTES: number;
declare const MAX_PORTABLE_EVIDENCE_BYTES: number;
declare const MAX_PORTABLE_RECORD_BYTES: number;
declare const MAX_PORTABLE_ARTIFACTS = 128;

/** Portable transport of accepted bytes; every evidence judgment remains in the existing validators. */

/** Read bounded repository inputs through the existing observation port. */
declare function repositoryEvidenceReader(rootDir: string, artifacts: ArtifactsPort): ReviewInputReader;
declare function capturePortableEvidenceContext(config: HarnessConfig, read: ReviewInputReader, preparationFingerprint: string): Promise<PortableEvidenceContext>;
/** Pure observation of transported bytes; no original path is opened or trusted. */
declare function portableArtifactContents(value: unknown): {
    readonly artifacts: ReadonlyMap<string, string>;
    readonly observations: ReadonlyMap<string, ArtifactObservation>;
    readonly blockers: readonly Blocker[];
};
/** The same manifest validator, with a portable artifact reader supplying ENV-11 and RG-4 bytes. */
declare function verifyPortableEvidence(config: HarnessConfig, portable: PortableEvidence, binding: RecordCandidateBinding, expected: PortableEvidenceContext, checkBindings?: Readonly<Record<string, CheckBinding>>): readonly Blocker[];

declare function candidateTreeEvidenceReader(rootDir: string, treeSha: string, run?: CandidateCommandRunner): Promise<ReviewInputReader>;
declare function capturePortableVerificationInputs(rootDir: string, config: HarnessConfig, candidate: CapturedCandidate, record: DeliveryRecord, run?: CandidateCommandRunner): Promise<{
    waiverCandidateMatches?: boolean | undefined;
    evidenceContext: PortableEvidenceContext;
    checkBindings: Readonly<Record<string, CheckBinding>>;
    projection: ReviewActivationProjection;
}>;

/**
 * Neutral provider-rail execution shared by CLI and Action boundaries.
 *
 * The envelope and state machine are the vendored `delivery-provider-rails/1`
 * contract. Its `payload`, `details`, and `result` objects remain opaque. This
 * adapter assigns one adopter-owned meaning inside `terminal.result`:
 * `manifestPath` names a delivery-evidence manifest that must be accepted by
 * the existing recorder before a successful provider attempt can become green
 * evidence. Live obligations reuse the evaluator's existing LiveProviderResult
 * shape; recorded obligations reuse SubmissionOutcome and its evidence records.
 */

declare const DELIVERY_PROVIDER_RAILS_VERSION: "delivery-provider-rails/1";
type JsonObject = Readonly<Record<string, unknown>>;
type TerminalOutcome = "success" | "blocked" | "failed" | "cancelled" | "indeterminate";
interface ProviderRailNegotiate {
    readonly kind: "negotiate";
    readonly supportedVersions: readonly string[];
}
interface ProviderRailNegotiation {
    readonly kind: "negotiation";
    readonly outcome: "supported" | "unsupported";
    readonly selectedVersion: typeof DELIVERY_PROVIDER_RAILS_VERSION | null;
    readonly supportedVersions: readonly [typeof DELIVERY_PROVIDER_RAILS_VERSION];
}
interface ProviderRailRequest {
    readonly kind: "request";
    readonly version: typeof DELIVERY_PROVIDER_RAILS_VERSION;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly payload: JsonObject;
}
interface ProviderRailEventBase {
    readonly version: typeof DELIVERY_PROVIDER_RAILS_VERSION;
    readonly requestId: string;
    readonly sequence: number;
    readonly summary: string;
}
interface ProviderRailProgress extends ProviderRailEventBase {
    readonly kind: "progress";
    readonly details?: JsonObject;
}
interface ProviderRailEvidence extends ProviderRailEventBase {
    readonly kind: "evidence";
    readonly evidenceId: string;
    readonly details?: JsonObject;
}
interface ProviderRailBlocker extends ProviderRailEventBase {
    readonly kind: "blocker";
    readonly blockerId: string;
    readonly action?: string;
    readonly details?: JsonObject;
}
interface ProviderRailTerminal extends ProviderRailEventBase {
    readonly kind: "terminal";
    readonly outcome: TerminalOutcome;
    readonly action?: string;
    readonly details?: JsonObject;
    readonly result?: JsonObject;
}
interface ProviderRailCancel {
    readonly kind: "cancel";
    readonly version: typeof DELIVERY_PROVIDER_RAILS_VERSION;
    readonly requestId: string;
    readonly cancellationId: string;
    readonly reason?: string;
}
type ProviderRailEvent = ProviderRailProgress | ProviderRailEvidence | ProviderRailBlocker | ProviderRailTerminal;
type ProviderRailMessage = ProviderRailNegotiate | ProviderRailNegotiation | ProviderRailRequest | ProviderRailEvent | ProviderRailCancel;
interface ProviderRailConsumption {
    readonly status: "supported" | "unsupported" | "malformed" | "success" | "blocked" | "failed" | "cancelled" | "indeterminate";
    readonly acceptedCount: number;
    readonly duplicateCount: number;
    readonly rejectedCount: number;
    readonly events: readonly ProviderRailEvent[];
    readonly terminal: ProviderRailTerminal | null;
}
interface ConsumeProviderRailOptions {
    readonly requestId?: string;
    readonly cancellationAccepted?: boolean;
    readonly interrupted?: boolean;
    readonly afterInterruption?: readonly unknown[];
}
/**
 * Contract consumer used by both the process adapter and the shared vectors.
 * Terminal finality is checked before message shape, exactly as the contract
 * requires: late malformed or cross-attempt bytes cannot reopen an outcome.
 */
declare function consumeProviderRailMessages(messages: readonly unknown[], options?: ConsumeProviderRailOptions): ProviderRailConsumption;
interface ProviderRailSession {
    send(message: ProviderRailMessage): Promise<void>;
    /** `null` means the provider process or transport closed. */
    receive(): Promise<unknown | null>;
    close(options?: {
        readonly terminationGraceMs?: number;
    }): Promise<void>;
}
interface OpenProviderRailProcessInput {
    readonly command: readonly [string, ...string[]];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
}
/** Opens the contract over newline-delimited JSON on a provider subprocess's stdio. */
declare function openProviderRailProcess(input: OpenProviderRailProcessInput): Promise<ProviderRailSession>;
interface ProviderRailAttemptInput {
    readonly providerId: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly payload: JsonObject;
    readonly requiresEvidence: boolean;
}
interface ProviderRailAttemptOptions {
    readonly open: () => Promise<ProviderRailSession>;
    readonly publishManifest?: (manifestPath: string) => Promise<SubmissionOutcome>;
    readonly signal?: AbortSignal;
    readonly cancellationId?: string;
    readonly deadlineMs?: number;
    readonly terminationGraceMs?: number;
}
type ProviderRailInvocationResult = {
    readonly kind: "success";
    readonly status: "success";
    readonly liveResult: LiveProviderResult;
    readonly events: readonly ProviderRailEvent[];
    readonly records: readonly SubmissionRecord[];
} | {
    readonly kind: "interrupted";
    readonly status: "cancelled" | "indeterminate" | "malformed";
    readonly runId: string;
    readonly blockers: readonly Blocker[];
} | {
    readonly kind: "blocked";
    readonly status: Exclude<ProviderRailConsumption["status"], "supported" | "success" | "cancelled">;
    readonly runId: string;
    readonly blockers: readonly Blocker[];
};
/**
 * Runs one negotiated provider attempt. A successful terminal is provisional:
 * when recorded evidence is required, the adapter publishes the returned
 * manifest through the existing recorder first and exposes green only after
 * that atomic publication reports acceptance.
 */
declare function invokeProviderRail(input: ProviderRailAttemptInput, options: ProviderRailAttemptOptions): Promise<ProviderRailInvocationResult>;

interface CollectLiveProviderInput {
    readonly rootDir: string;
    readonly config: HarnessConfig;
    readonly candidate: CapturedCandidate;
    readonly projection: ReviewActivationProjection;
    readonly evidenceContext: Pick<PortableEvidenceContext, "preparationFingerprint" | "release">;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
    readonly run?: CandidateCommandRunner;
}
interface LiveProviderCollection {
    readonly liveResults: readonly LiveProviderResult[];
    readonly blockers: readonly Blocker[];
}
/** No stored result or injection port: every green value comes from this bounded invocation. */
declare function collectLiveProviderResults(input: CollectLiveProviderInput): Promise<LiveProviderCollection>;

/** Self-attested run observations. This module never grants authority or repairs missing history. */

declare const DEFAULT_RUN_FRESHNESS_WINDOW_MS: number;
interface RunWaitObservation {
    readonly waitId: string;
    readonly activityId: string;
    readonly attemptId: string;
    readonly candidateTreeSha: string;
    readonly owner: string;
    readonly waitingOn: string;
    readonly reason: string;
    readonly nextAction: string;
    readonly scope: string;
    readonly startedAt: string;
    resolvedAt?: string;
    resolution?: string;
    current: boolean;
}
interface RunAttemptObservation {
    readonly activityId: string;
    readonly attemptId: string;
    readonly candidateTreeSha: string;
    state: RunActivityState;
    owner: string;
    phase: string;
    readonly roundId?: string;
    readonly round?: number;
    readonly lensId?: string;
    readonly supersedesAttemptId?: string;
    nextStep?: string;
    verdict?: string;
    cost?: unknown;
    readonly firstObservedAt: string;
    lastObservedAt: string;
    startedAt?: string;
    lifecycleIncomplete: boolean;
    superseded: boolean;
    freshness: "recent" | "stale" | "unknown";
    readonly waits: RunWaitObservation[];
}
interface RunActivityObservation {
    readonly activityId: string;
    currentAttemptId: string;
    readonly attempts: RunAttemptObservation[];
}
interface RunReferencedObservation {
    readonly seq: number;
    readonly at: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly current: boolean;
}
interface RunActivityProjection {
    readonly activities: RunActivityObservation[];
    readonly waits: RunWaitObservation[];
    readonly findings: RunReferencedObservation[];
    readonly reports: RunReferencedObservation[];
    readonly artifacts: RunReferencedObservation[];
    readonly finishSteps: RunReferencedObservation[];
}
/** A useful terminal observation may be the first captured event for an attempt. */
declare function runActivityTransitionError(events: readonly RunEvent[], event: RunEventInput): string | undefined;
/**
 * Replay order is the append sequence. Timestamps only describe observation
 * freshness; a late old-attempt result cannot replace the current attempt.
 * `current` means reported for the latest attempt, never accepted evidence.
 */
declare function projectRunActivities(events: readonly RunEvent[], options: {
    readonly now: string;
    readonly freshnessWindowMs?: number;
    readonly currentCandidateTreeSha?: string;
}): RunActivityProjection;

interface RunArtifactMetadata {
    readonly artifactId: string;
    readonly activityId: string;
    readonly attemptId: string;
    readonly candidateTreeSha: string;
    readonly digest: string;
    readonly sizeBytes: number;
    readonly mediaType: string;
    readonly producer: string;
    readonly roundId?: string;
    readonly round?: number;
    readonly lensId?: string;
}
type RunArtifactFailureCode = "missing" | "corrupt" | "access_refused" | "unsafe" | "invalid";
type RunArtifactResult = {
    readonly ok: true;
    readonly metadata: RunArtifactMetadata;
    readonly base64: string;
} | {
    readonly ok: false;
    readonly code: RunArtifactFailureCode;
    readonly reason: string;
};
/** Explicit selected-file capture. Does not append a successful artifact event. */
declare function captureRunArtifact(input: {
    readonly store: RunStore;
    readonly runId: string;
    readonly metadata: RunArtifactMetadata;
    readonly sourceRoot: string;
    readonly sourcePath: string;
}): Promise<RunArtifactResult>;
/** No arbitrary path input, and no admission/evidence inference. */
declare function readRunArtifact(store: RunStore, runId: string, artifactId: string): Promise<RunArtifactResult>;

/**
 * Delivery harness kernel.
 *
 * The kernel's modules — canonical.ts, digest.ts, config.ts, blockers.ts,
 * candidate.ts, identity.ts, records.ts, validator/, evaluator.ts, context.ts,
 * recorder.ts, admission.ts, delivery-record.ts — land incrementally. The purity
 * sensor already registers the not-yet-created paths as pending, so the change
 * that creates one has to promote it to an enforced protected class.
 */
declare const PACKAGE_NAME = "@agent-delivery-harness/kernel";

export { ABSENT_BY_STATE, ACTION_APPROVALS, ACTION_VERIFICATIONS, ACTIVATION_KINDS, ACTIVE_POINTER_SPEC, ADAPTER_CAPABILITY_SPEC, ADMISSION_DENIAL_CODES, APPROVAL_REQUEST_KINDS, APPROVAL_REQUIREMENTS, ARCHIVE_RELEASE_MANIFEST_ENTRY, ARTIFACT_OBSERVATION_STATUSES, ASSERTION_CLASSES, ASSERTION_PROVIDER_SPEC, ASSERTION_SOURCES, ATTESTATION_LABEL, ATTESTATION_LEVELS, AUTHORITY_REVOCATION_SPEC, BASE_MOVEMENT_POLICIES, BLOCKER_CONTRACT_VERSION, BLOCKER_SOURCE_KINDS, BlockedError, CANDIDATE_CAPTURE_CODES, CANDIDATE_DIFF_UNREADABLE, CANDIDATE_DRIFT_CLASSES, CANDIDATE_MODES, CANDIDATE_PATH_CLASSES, CANDIDATE_VCS, CAPABILITY_DESCRIPTOR_SPEC, CAPABILITY_KINDS, CLAUDE_SKILL_EXPOSURE_PREFIX, COMPILED_POLICY_SPEC, COMPOSITION_MANIFEST_FILE, COMPOSITION_MANIFEST_SPEC, COMPOSITION_PROFILES, CONFIG_FINDING_CODES, CONFIRMATION_CLASSES, CONFIRMATION_DENIAL_CODES, CONFIRMATION_FIXTURE_PROFILE, CONFIRMATION_OPERATION_PREFIX, CONFORMING_ATTESTATION_LEVEL, CONSUMPTION_GATE_RECORD_BLOCKER_CODES, CRITERION_DISPOSITIONS, CanonicalizationError, DEFAULT_BASE_MOVEMENT_POLICY, DEFAULT_BASE_REF, DEFAULT_CAPTURE_ATTEMPTS, DEFAULT_RUN_FRESHNESS_WINDOW_MS, DEFAULT_STORAGE_NAMESPACE, DELIVERABLE_TREE_V1, DELIVERABLE_TREE_V1_NARRATION_SET, DELIVERY_BLOCKER_REMEDIATIONS, DELIVERY_EVIDENCE_1, DELIVERY_OWNED_TREE_PREFIXES, DELIVERY_PROVIDER_RAILS_VERSION, DELIVERY_RECORD_DRIFT_CLASSES, DELIVERY_RECORD_VERSION, DELIVERY_STATES, DELIVERY_TRANSITION_TABLE, DESCENDANT_TEARDOWN_STATUSES, DISPOSABLE_OUTCOME_AUTHORITIES, DISPOSABLE_REVIEW_LENSES, DISPOSABLE_SENSOR_CAPABILITY, DISPOSABLE_STAGE_GRANT, DigestError, EVENT_VOCABULARY, EVIDENCE_KINDS, EXECUTION_CONTEXT_KINDS, EXECUTION_GRANT_SPEC, EXTERNAL_ACTIONS, EXTERNAL_ACTION_OUTCOMES, EXTERNAL_VERIFICATIONS, FACADE_CAPABILITY_CLASSES, FACADE_OPERATIONS, FACADE_SURFACES, FINDING_DISPOSITIONS, FINDING_SCOPES, FINDING_SEVERITIES, FINISH_LINES, FINISH_LINE_ACTIONS, FINISH_LINE_RESULT_SPEC, FRESHNESS_KINDS, GATE_STRUCTURAL_FINDING_CODES, GRANT_ATTESTATION_SPEC, GRANT_PROFILES, HARNESS_VERSION, HOST_ACTIVITY_STATES, HOST_ADMISSION_SCENARIOS, HOST_BINDING_BLOCKER_CODES, HOST_CONFORMANCE_CASES, HOST_INTERCEPTION_SCENARIOS, IDENTITY_DOMAIN, IDENTITY_FINDING_CODES, INSTALL_RECEIPT_SPEC, INTAKE_STATES, INTERNAL_ERROR_CODE, INVOCATION_FENCE_SPEC, INVOCATION_WAIVER_SCOPE, JOURNALS, JOURNAL_ENTRY_SPEC, MANAGED_DELIVERY_NAMESPACE, MANDATORY_LENS_CATEGORIES, MANIFEST_REJECTION_CODES, MANIFEST_REJECTION_REGISTRY, MANIFEST_RULE_IDS, MAX_BLOCKER_DETAIL_LENGTH, MAX_PORTABLE_ARTIFACTS, MAX_PORTABLE_ARTIFACT_BYTES, MAX_PORTABLE_EVIDENCE_BYTES, MAX_PORTABLE_RECORD_BYTES, MAX_RUN_LABEL, MAX_RUN_LENSES, MAX_RUN_PATH, MAX_RUN_PROVIDER_ID, MAX_RUN_URL, META_RULE_IDS, MINIMUM_NODE, MINIMUM_PYTHON, NON_WAIVABLE_INTEGRITY_CODES, OBSERVATION_ONLY_KINDS, OPERATION_CLAIM_SPEC, OPERATION_RESULT_SPEC, OPERATOR_CONFIRMATION_SPEC, OTHER_INSTALLATION_ARTIFACTS, OUTCOME_VERIFICATION_SPEC, PACKAGE_NAME, PACKED_HARNESS_PACKAGES, PATH_MATCHER_KINDS, PERSONA_MANIFEST_ENTRY, PERSONA_MANIFEST_SPEC, PINNED_AGENT_SKILLS, POLICY_CAPABILITY_KINDS, POLICY_COMPILE_CODES, POLICY_SNAPSHOT_SPEC, PORTABLE_INTAKE_GRANT, PORTABLE_MODEL_DRIVEN_STAGES, PORTABLE_PRIVILEGED_CREDENTIALS, PORTABLE_STAGE_GRANT, PREPARATION_FAILURE_CLASSES, PREPARATION_RECEIPT_LEAF, PREPARATION_RECEIPT_SCHEMA_VERSION, PRIVILEGED_ACTIONS, PRIVILEGED_CAPABILITY_KINDS, PRODUCT_COMPOSITION_PIN_SPEC, PRODUCT_TRUST_LABEL, PRODUCT_TRUST_STATE_SPEC, PROJECTION_CONSUMPTION_OBSERVATION_SPEC, PROJECTION_DIR, PROJECTION_RECEIPT_FILE, PROVIDER_POLICIES, PROVIDER_REVIEW_HANDOFF_SPEC, PROVIDER_REVIEW_RESULT_SPEC, READ_ONLY_CAPABILITY_KINDS, RECEIPTED_SKILLS_ROOT, RECHECKED_VALUES, RECORDER_EMITTED_CODES, RECORDS_LEAF, RECORD_QUARANTINE_REASONS, RECORD_SCHEMA_VERSION, REPOSITORY_POLICY_DOCUMENT_SPEC, RESOLUTION_KINDS, RESOLUTION_OUTCOMES, RESUME_ELIGIBILITIES, REVIEWER_APPROVAL_ROLE, REVIEWER_ATTEMPT_SPEC, REVIEWER_RESULTS, REVIEW_GREEN_1, REVIEW_GREEN_2, REVIEW_LENS_CATEGORIES, REVIEW_VERDICTS, RUN_ACTIVITY_STATES, RUN_ACTOR_ROLES, RUN_CANDIDATE_TREE_SHA, RUN_COMMAND_OUTCOMES, RUN_ENDED_RESULTS, RUN_EVENT_KINDS, RUN_EVENT_KINDS_V1, RUN_EVENT_SPEC, RUN_EVENT_SPEC_V2, RUN_FREE_TEXT_MEMBERS, RUN_GATE_REPORTED_OUTCOMES, RUN_JOURNAL_REQUIRED_ENTRIES, RUN_JOURNAL_STATUSES, RUN_JOURNAL_VIOLATIONS, RUN_PROVIDER_ID, RUN_ROOT_LEAF, RUN_ROOT_NAMESPACE, RUN_ROOT_REFUSAL_REASONS, RUN_STORE_DIRECTORY, RUN_STORE_ID, RUN_TICKET, ReviewInputError, SCOPED_DELIVERY_CONTRACT_SPEC, SECRET_PATTERNS, SECURITY_BLOCKED_MIGRATION_ACTION, SENSITIVE_APPROVAL_ASSERTION_SPEC, SENSITIVE_MAINTENANCE_ACTIONS, SENSOR_OUTCOMES, SENSOR_RESULT_SPEC, SHADOW_MILESTONE_GATE_RECORD_SPEC, SHADOW_MILESTONE_GATE_RECORD_SPEC_SUFFIX, SPINE_GIT_OID, SPINE_ID, SPINE_INSTANT, SPINE_SHA256, SUBMISSION_CANDIDATE_FIELDS, SUBSTRATE_BLOCKER_CODES, SUPPORTED_CONTRACT_VERSIONS, SUPPORTED_ENVELOPE_SPECS, SUPPORTED_PAYLOAD_SPECS, SUPPORTED_PLATFORMS, SUSPENDED_DELIVERY_STATES, TERMINAL_DELIVERY_STATES, TERMINATION_PROVENANCE_KINDS, TERMINATION_PROVENANCE_OPERATION, TOOL_DENIAL_CODES, TRACKER_ABSENCE_FALLBACKS, UNBOUND_EXTERNAL_ACTION_PORT, UNKNOWN_CONTEXT_REASONS, V1_ATTESTATION_LEVEL, VALIDATOR_EMITTED_CODES, WAIVER_ACTIONS, WAIVER_APPROVAL_ORIGIN_PREFIX, WAIVER_SCOPES, WORKFLOW_CHECKPOINT_BINDINGS, WORKFLOW_GRAPH_ENTRY, WORKSPACE_DISPOSITIONS, adaptClaudeCodeReviewResult, applySecretDiscipline, assertSha256Hex, assertionClassOf, assertionLaneAvailability, assertionProviderConfigPathFor, authorizeFinishLineAction, bindingOf, buildCompositionManifest, buildDeliveryRecord, candidateTreeEvidenceReader, canonicalBytes, canonicalize, captureCheckBindings, captureCheckOutputSnapshots, captureCheckOutputs, captureGitCandidate, capturePortableEvidenceContext, capturePortableVerificationInputs, captureRunArtifact, checkActionAuthorization, checkBoundPolicy, checkClaimAuthorized, checkContractWithinPolicy, checkFacadeSurfaceInvariants, checkMergeReadyAgainstOutcome, checkMutationLane, checkNoDowngrade, checkOutcomeCoversContract, checkPositiveCriterion, checkReviewFloor, classifyCandidateDrift, classifyCandidatePath, classifyEventKind, classifyExecutionContext, collectLiveProviderResults, compareSubmissionCandidate, compareUtf16CodeUnits, compileDisposableCompiledPolicy, compileDisposablePolicy, compileRepositoryPolicy, compiledAdopterPolicyBindingDigest, composeBlockerInventory, composeClaudeCodeSession, composeManagedStatus, composeOutcomeVerification, compositionManifestBytes, computeCheckWiringFingerprint, computeDeliverableIdentity, computePreparationFingerprint, computeRecordId, confirmationClassOf, consumeProviderRailMessages, createArtifactsPort, createBlocker, createCandidateCapture, createExecPort, createFakeHostConformancePort, createIntakeJournalStore, createInternalErrorBlocker, createJournalStore, createMaintenanceJournalStore, createManagedDeliveryFacade, createOsNativeAssertionSource, createProviderReviewHandoff, createQualificationFixtureAssertionSource, createRunStore, decideFinishLine, defaultRunRootBase, defineHarnessConfig, deleteDelivery, deliveryRecordBytes, deliveryRecordPathFor, deriveDeliveryRecordPath, deriveTelemetry, digestCanonical, digestDeliverableEntries, digestsEqual, discoverRecords, discriminateInstall, effectiveDeliveryAuthority, emittableFindingCodes, enforceAllowedResolution, evaluateCandidateActivation, evaluateCanonicalRecheck, evaluateConfirmationEcho, evaluateGate, evaluateHostAdmission, evaluateMigrationConsumption, evaluatePreparationReceipt, evaluateRunJournal, evaluateToolInvocation, evaluateWaiverConsumption, exportDelivery, facadeOperation, garbageCollectGenerations, generationDigestOf, gitNamespaceClearedEnvironment, grantDigest, identityDefinitionOf, inspectInstallation, installComposition, invalidatePreparationReceipt, invokeProviderRail, isDeliveryOwnedTreeEntry, isDeliveryOwnedTreePath, isDeliveryTransitionValid, isEnvSignalPresent, isInsideResolved, isIntakeTransitionValid, isManifestRejectionCode, isObligationActive, isRecordFreshForCandidate, isRecordNeutralPath, isReviewNeutralPath, isRunEventKind, isRunInstant, isSafeRelativePath, isSha256Hex, listArchiveEntries, livePreflightProbes, loadAssertionProviderConfig, loadBundledWorkflowGraph, loadPinnedGeneration, localDigestTrustPredicate, maintainTrustState, manifestDigest, matchesNeutralSet, matchesPathMatcher, materializeProjection, mintGrantAttestation, needsCommittedSymlinkTarget, neutralizeForDisplay, observeAuthorityEpoch, openProviderRailProcess, operationsOnSurface, packComposition, parseCandidateNumstat, parseCandidateTreeListing, parseDeliveryRecord, parseProjectionConsumptionObservation, parseProviderReviewResult, parseReviewOutcome, parseTreeEntries, parseTrustState, portableArtifactContents, projectReviewActivation, projectRunActivities, projectShippedPersonas, projectionConsumptionObservationFile, publishPreparationReceipt, publishRecord, qualifyReviewAttempts, readArchiveEntry, readConsumptionMarker, readRunArtifact, readWorkflowRelease, receiptFileName, receiptPathFor, recordFileName, recordIdentity, recoverInterruptedMaintenance, redactSecretText, reduceDeliveryJournal, reduceIntakeJournal, reduceToProviderId, registrationBinding, remediationFor, renderBlockers, repairInstallation, repositoryEvidenceReader, resolveActiveGeneration, resolveCommonDirectoryNamespace, resolveReceiptStorage, resolveRecordStorage, resolveReviewCharters, resolveRunStoreLocation, retainedCheckOutput, reviewerLists, revokePreparationAttempt, rollbackComposition, runActivityTransitionError, runAdmission, runGitCommand, runGitDirect, runHostIntegrationConformance, runJournalCarries, runPrimaryTicket, sanitizedDetail, selectDeliveryRecordForIdentity, sensitiveGroupsFor, serializeBlockers, sha256Hex, submitManifest, trustStorePathFor, updateComposition, validateAcceptedContract, validateAdapterCapability, validateAdapterSet, validateAuthorityRevocation, validateCapabilityDescriptor, validateCompositionManifest, validateCompositionPin, validateExecutionGrant, validateFinishLineResult, validateGrantAttestation, validateHarnessConfig, validateInvocationFence, validateJournalEntry, validateManifest, validateOperatorConfirmation, validateOutcomeVerification, validatePolicySnapshot, validateProductTrustState, validateRepositoryPolicyDocument, validateReviewGreenClaim, validateReviewedContext, validateReviewerAttempt, validateRunEvent, validateRunEventInput, validateSensitiveApprovalAssertion, validateSensorResult, verifyCompiledPolicy, verifyDeliveryRecord, verifyGenerationClosure, verifyPortableEvidence, verifyProjection, withDeliverableIdentity, workflowStageBindingFor, writeAssertionProviderConfig };
export type { AcceptedContract, ActivationKind, AdapterCapability, AdditionalReviewLens, AdmissionDecision, AdmissionDenial, AdmissionDenialCode, AdmissionExpectation, AdmissionInput, AdmissionOptions, AdmissionResult, AdmittedInvocation, AgentExecutionContext, ArtifactObservation, ArtifactObservationStatus, ArtifactPresence, ArtifactsPort, ArtifactsPortOptions, AssertionAvailabilityProbe, AssertionClass, AssertionEvaluation, AssertionEvaluationRequest, AssertionProviderConfig, AssertionSource, AssertionSourceAvailability, AssertionSourcePort, AssertionSourceView, AttestationLevel, AuthorityGrantView, AuthorityRevocation, AvailablePersona, BaseMovementPolicy, BlockedResolution, Blocker, BlockerInput, BlockerInventoryEntry, BlockerSource, BlockerSourceKind, BuildCompositionManifestInput, BuildDeliveryRecordInput, BuildDeliveryRecordResult, CandidateActivationOptions, CandidateBase, CandidateBinding, CandidateCapture, CandidateCaptureCode, CandidateCaptureOptions, CandidateCommandResult, CandidateCommandRunner, CandidateComparison, CandidateDeliverable, CandidateDiffEntry, CandidateDriftClass, CandidateMode, CandidatePathClass, CandidateStatusEntry, CandidateTreeEntry, CandidateVcs, CanonicalErrorCode, CaptureCandidate, CapturedCandidate, CheckActionAuthorizationInput, CheckBinding, CheckBindingOptions, CheckpointAdmissionExpectation, CheckpointOverride, CiExecutionContext, CiPolicy, ClaimAuthorityView, ClassifyExecutionContextInput, ClaudeCodeReviewAdaptation, CollectLiveProviderInput, CommandArguments, CompareCheck, CompileDisposablePolicyInput, CompileRepositoryPolicyInput, CompileRepositoryPolicyResult, CompiledAdopterPolicyBinding, CompiledCheckpointGrant, CompiledPolicy, CompositionInventoryEntry, CompositionProfile, ComputeIdentity, ConfigFindingCode, ConfirmationClass, ConfirmationDenial, ConfirmationDenialCode, ConfirmationEchoAttempt, ConfirmationEchoDecision, ConsumeProviderRailOptions, ConsumedWaiver, ConsumptionGateRecordBlockerCode, ConsumptionMarker, CreateFacadeInput, DeclaredArtifact, DelegatedResolution, DeleteDeliveryResult, DeliverableIdentityDefinition, DeliverableIdentityOptions, DeliverableIdentityRequest, DeliverableTreeEntry, DeliveryEvidenceManifest, DeliveryJournalState, DeliveryRecord, DeliveryRecordAttestation, DeliveryRecordCheck, DeliveryRecordClaim, DeliveryRecordDriftClass, DeliveryRecordFile, DeliveryRecordVerification, DeliveryState, DeliveryTransitionRow, DeniedInvocation, DigestErrorCode, EffectiveDeliveryAuthorityInput, EligibleCheck, EmitProjectionConsumptionResult, EnvSnapshot, EnvironmentRequirement, EvaluateGateInput, EventClassification, EventKindEntry, EvidenceRecord, EvidenceRecordIdentity, EvidenceResolution, ExecInvocation, ExecOutcome, ExecPort, ExecutionContext, ExecutionContextKind, ExportDeliveryResult, ExternalAction, ExternalActionIntent, ExternalActionInvocation, ExternalActionPort, ExternalVerification, FacadeCapabilityClass, FacadeFailure, FacadeFenceRule, FacadeJournalRule, FacadeOperation, FacadeSurface, FacadeSurfaceFinding, FacadeSurfaceRule, FinishLineDecision, FinishLineInput, FinishLineRefusal, FinishLineResult, FreshnessKind, GarbageCollectInput, GateDecision, GateStructuralFindingCode, GitRunner, GrantProfile, HarnessConfig, HarnessConfigInput, HarnessConfigValidation, HostActivityState, HostAdmissionScenario, HostBindingBlocker, HostBindingBlockerCode, HostConformanceCase, HostConformanceResult, HostIntegrationPort, HostInterceptionScenario, HumanExecutionContext, IdentityFindingCode, IgnoredStoreEntry, InspectInstallationInput, InspectedGeneration, InstallCompositionInput, InstallCompositionResult, InstallDiscrimination, InstallReceipt, InstallationPresence, IntakeAdmissionExpectation, IntakeJournalState, IntakeJournalStore, IntakeState, Journal, JournalAppendResult, JournalReadResult, JournalStore, LaneAvailability, ListedTreeEntry, LiveProviderCollection, LiveProviderFinding, LiveProviderResult, LoadPinnedGenerationResult, MaintainTrustStateInput, MaintenanceJournalStore, ManagedCheckpoint, ManagedDeliveryFacade, ManagedDeliveryStatus, ManagedInstallation, ManagedStatusInput, ManifestArtifact, ManifestAttestation, ManifestBase, ManifestCandidate, ManifestClaim, ManifestDeliverable, ManifestProvider, ManifestRejection, ManifestRejectionCode, ManifestRejectionCodeEntry, ManifestRuleId, ManifestValidation, ManifestValidationContext, MigrationConsumptionContext, MigrationConsumptionVerdict, MigrationPath, MigrationRefusal, MutationLaneResult, MutationVerification, NamespaceGitLaunch, NamespaceGitRunner, NamespaceResolution, NamespaceResolutionInput, NativeReviewConclusion, NeutralMatcher, NoDowngradeDecision, NonEmptyTuple, NormalizedAdmission, NormalizedInterception, NormalizedTeardown, NormalizedTermination, NotApplicableResolution, ObligationActivation, ObligationFinding, ObligationPolicy, ObligationResolution, ObserveAuthorityEpochResult, OpenProviderRailProcessInput, OtherInstallationArtifact, OutcomeCriterion, OutcomeVerification, PackCompositionInput, PackCompositionResult, ParseDeliveryRecordResult, ParseTrustStateResult, PathClassification, PathMatcher, PathMatcherKind, PolicyCapabilityKind, PolicyGrantView, PolicyRejection, PolicySnapshot, PolicyVerdict, PortableEvidence, PortableEvidenceContext, PositiveCriterionVerdict, PreflightProbes, PreparationCandidate, PreparationCommand, PreparationEvaluation, PreparationFailureClass, PreparationInput, PreparationOptions, PreparationReceipt, ProductTrustPort, ProductTrustState, ProductTrustView, ProjectShippedPersonasResult, ProjectionConsumptionObservation, ProjectionConsumptionRecord, ProjectionConsumptionUnobserved, ProviderPolicy, ProviderRailAttemptInput, ProviderRailAttemptOptions, ProviderRailBlocker, ProviderRailCancel, ProviderRailConsumption, ProviderRailEvent, ProviderRailEvidence, ProviderRailInvocationResult, ProviderRailMessage, ProviderRailNegotiate, ProviderRailNegotiation, ProviderRailProgress, ProviderRailRequest, ProviderRailSession, ProviderRailTerminal, ProviderRegistration, ProviderReviewCandidate, ProviderReviewCapability, ProviderReviewFinding, ProviderReviewHandoff, ProviderReviewHandoffReviewer, ProviderReviewParseResult, ProviderReviewResult, ProviderReviewTerminalState, ProviderReviewVerdict, PublishOptions, PublishRecordInput, PublishStatus, PublishedPreparationReceipt, PublishedRecord, QualifiedAttempts, QuarantinedRecord, ReadConsumptionMarkerResult, RecheckConsumption, RecheckFailure, RecheckResult, RecheckValues, RecheckedValue, RecomputedIdentity, RecordCandidateBinding, RecordDiscovery, RecordIdentity, RecordQuarantineReason, RecordResolution, RecordSelector, RecordStorageOptions, RecordedRegistrationBinding, RecordedReviewAttempt, RecordedSensorResult, ReduceDeliveryResult, ReduceIntakeResult, RegistrationBindingInput, RegistrationBindingResult, RegistrationBindingView, RegistrationMismatch, RejectionEmitter, Remediation, RemediationCatalog, RenderOptions, RenderedConfirmationChallenge, RepairInstallationInput, RepositoryPolicyDocument, ResolutionKind, ResolutionOutcome, ResolveActiveGenerationResult, ResolvedCharter, ResolvedPersonaSource, RetentionContext, RetentionFailure, RetrySafety, ReviewActivationProjection, ReviewGreenClaimInput, ReviewInputReader, ReviewOutcome, ReviewRejection, ReviewVerdict, ReviewerOutcome, ReviewerResult, RollbackCompositionInput, RunActivityObservation, RunActivityProjection, RunActivityState, RunActorRole, RunAllocateResult, RunAppendResult, RunArtifactMetadata, RunArtifactResult, RunAttemptObservation, RunCommandOutcome, RunCurrentResult, RunDiscardResult, RunEvent, RunEventActor, RunEventInput, RunEventKind, RunEventRepo, RunEventVersion, RunHistoryEntry, RunJournalEvaluation, RunJournalRequiredEntry, RunJournalRow, RunJournalStatus, RunJournalViolation, RunMatch, RunReadResult, RunReferencedObservation, RunRoot, RunRootRefusalReason, RunRootRequest, RunRootResolution, RunSetCurrentResult, RunStore, RunStoreLocation, RunStoreRejection, RunStoreRejectionCode, RunWaitObservation, SatisfiedEvidenceResolution, SatisfiedLiveFactResolution, SecretDisciplineResult, SecretPattern, SensitiveLaneInput, SensitiveMaintenanceAction, SensitivePathGroup, SerializedBlocker, SerializedBlockers, SerializedRemediation, ShippedPersonaRejection, ShippedPersonaRejectionCode, SpineRejection, SpineRejectionCode, SpineVerdict, SubmissionInput, SubmissionOptions, SubmissionOutcome, SubmissionRecord, SubstrateBlocker, SubstrateBlockerCode, SubstrateFailure, SubstrateRejection, SubstrateRejectionCode, SubstrateVerdict, ToolDenial, ToolDenialCode, ToolInvocationDecision, ToolInvocationRequest, TrustCheckInput, TrustDecision, UnknownContextReason, UnknownExecutionContext, UnreadableRecordInput, UpdateCompositionInput, UpdateCompositionResult, ValidBlockerCode, ValueCheck, VerificationBase, VerifiedClosure, VerifyDeliveryRecordOptions, VerifyProjectionResult, WaivedResolution, WaiverAction, WaiverApproval, WaiverConsumptionContext, WaiverConsumptionVerdict, WaiverPrompt, WaiverPromptOutcome, WaiverProposal, WaiverRecordIdentity, WaiverRefusal, WaiverResolution, WaiverScope, WorkflowCheckpointBinding, WorkflowGraph, WorkflowStage, WorkspaceDisposition, WorkspaceStorage, WriteFileOptions };
