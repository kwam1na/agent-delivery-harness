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

// ── Contract constants ─────────────────────────────────────────────────────

export const BLOCKER_CONTRACT_VERSION = 1 as const;

/**
 * Bound applied when a blocker is constructed, so the serialized envelope and
 * any retained log inherit it. The renderer bounds further for the screen; this
 * cap is what stops a runaway provider report from being *kept* in full.
 */
export const MAX_BLOCKER_DETAIL_LENGTH = 8_000;

/** The code every surface uses for an unexpected throw (never a policy block). */
export const INTERNAL_ERROR_CODE = "internal_error";

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
export const BLOCKER_SOURCE_KINDS = [
  "gate",
  "obligation",
  "provider",
  "candidate",
  "preparation",
  "store",
  "delivery-record",
  "config",
  "command",
] as const;

export type BlockerSourceKind = (typeof BLOCKER_SOURCE_KINDS)[number];

export interface BlockerSource {
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
export const GATE_STRUCTURAL_FINDING_CODES = [
  // Evidence-shaped
  "review_evidence_missing",
  "stale_evidence",
  "evidence_not_green",
  "unresolved_actionable_findings",
  "ambiguous_records",
  "malformed_record",
  "unknown_provider",
  // Live-result-shaped
  "live_provider_missing",
  "ambiguous_live_provider",
  "live_provider_failed",
  // Policy-shaped
  "resolution_not_allowed",
] as const;

export type GateStructuralFindingCode = (typeof GATE_STRUCTURAL_FINDING_CODES)[number];

// ── Types ──────────────────────────────────────────────────────────────────

export type NonEmptyTuple<T> = readonly [T, ...T[]];

/** Remediation commands are argv arrays: no shell, and no empty invocation. */
export type CommandArguments = NonEmptyTuple<string>;

interface RemediationBase {
  /** Stable kebab-case identity, used to deduplicate repeated guidance. */
  readonly id: string;
  readonly summary: string;
  readonly details?: string;
}

export type Remediation =
  | (RemediationBase & { readonly kind: "command"; readonly command: CommandArguments })
  | (RemediationBase & { readonly kind: "manual_action" })
  | (RemediationBase & { readonly kind: "code_change" })
  | (RemediationBase & { readonly kind: "retry"; readonly command?: CommandArguments });

export interface Blocker {
  readonly code: string;
  readonly source: BlockerSource;
  readonly summary: string;
  readonly details?: string;
  readonly remediations: NonEmptyTuple<Remediation>;
}

export interface BlockerInput {
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
type CodeCharacter =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z"
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "_" | "-";

type OnlyCodeCharacters<S extends string> = S extends `${infer Head}${infer Rest}`
  ? Head extends CodeCharacter
    ? OnlyCodeCharacters<Rest>
    : false
  : true;

export type ValidBlockerCode<S extends string> =
  // A non-literal `string` carries no information to check; the runtime gate
  // still applies. Only literals can be decided here.
  string extends S
    ? S
    : S extends ""
      ? never
      : S extends `_${string}` | `-${string}` | `${string}_` | `${string}-`
        ? never
        : S extends `${string}__${string}` | `${string}--${string}` | `${string}_-${string}` | `${string}-_${string}`
          ? never
          : OnlyCodeCharacters<S> extends true
            ? S
            : never;

export interface RenderOptions {
  /** Per-blocker detail budget on screen. Storage is bounded separately. */
  readonly maxDetailLength?: number;
  /** Whole-output budget. Remediation claims its share first. */
  readonly maxOutputLength?: number;
}

export interface SerializedRemediation {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly details: string | null;
  readonly command: readonly string[] | null;
}

export interface SerializedBlocker {
  readonly code: string;
  readonly source: { readonly kind: string; readonly id: string };
  readonly summary: string;
  readonly details: string | null;
  readonly remediations: readonly SerializedRemediation[];
}

export interface SerializedBlockers {
  readonly contractVersion: typeof BLOCKER_CONTRACT_VERSION;
  readonly blockers: readonly SerializedBlocker[];
}

/** A typed policy failure. Surfaces render `blockers`; nothing prints the stack. */
export class BlockedError extends Error {
  readonly blockers: readonly Blocker[];

  constructor(blockers: readonly Blocker[], message = "Blocked by the delivery gate.") {
    super(message);
    this.name = "BlockedError";
    this.blockers = blockers;
  }
}

// ── Patterns ───────────────────────────────────────────────────────────────

const CODE_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/**
 * Source ids are config-owned: obligation ids are dotted (`review.green`),
 * provider ids are dashed, gate ids are either. Dots are therefore legal here
 * and illegal in codes — the two grammars are deliberately distinguishable.
 */
const SOURCE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const REMEDIATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Redaction (constructor side, spec §11.3) ───────────────────────────────

/**
 * Order matters here, and it is the whole reason this is a chain rather than a
 * set. Block-scoped rules run first: a PEM body arriving as
 * `SSH_PRIVATE_KEY=-----BEGIN ...` would otherwise have its header eaten by the
 * assignment rule, destroying the anchor the PEM rule needs and printing the key
 * material in full.
 *
 * The keyword rules are split by how specific the word is. `token`, `secret`
 * and `password` are credential words, so they redact standing alone. `key` and
 * `url` are ordinary English, so an uppercase env-style name or a dashed flag
 * has to vouch for them — otherwise `monkey=banana` loses its value and a real
 * diagnostic is destroyed, which fails an operator the same way a leak fails a
 * secret. Every rule below has a negative control in the test file.
 *
 * Ported from `athena:scripts/harness-blockers.ts`.
 */
function redactSecrets(value: string): string {
  return (
    value
      // Paired PEM blocks, then a truncated one: killed providers emit a BEGIN
      // with no END, and the body is just as sensitive.
      .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
      .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*/gi, "[REDACTED PRIVATE KEY]")
      // Unambiguous provider prefixes: no context needed, no false positives.
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprse]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/g,
        "[REDACTED]",
      )
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/\b(bearer|token)[ \t]+([A-Za-z0-9._~+/-]{16,}=*)/gi, (match, label: string, candidate: string) =>
        // Hyphenated prose ("token connection-refused-by-upstream.") or an
        // UPPER_SNAKE provider error code: both are diagnostics an operator
        // needs, and neither is a credential shape.
        /^[A-Za-z]+(?:-[A-Za-z]+)+[.,;:!?]?$|^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+[.,;:!?]?$/.test(candidate) ? match : `${label} [REDACTED]`,
      )
      // Credential words, standing alone or prefixed, assigned with = or :.
      .replace(
        /((?:^|[\s"'`(\[{,?&;])-{0,2}(?:[A-Za-z0-9]+[_-])*(?:TOKEN|SECRET|PASSWORD)"?\s*[:=]\s*"?)(?!\[REDACTED)[^\s",}\])]+/gi,
        "$1[REDACTED]",
      )
      // camelCase config dumps: `apiKey=`, `accessToken=`. Case-sensitive on the
      // capital, so `monkey=` cannot match on the Key suffix.
      .replace(
        /((?:^|[\s"'`(\[{,?&;])[A-Za-z][A-Za-z0-9]*(?:Token|Secret|Password|Key)"?\s*[:=]\s*"?)(?!\[REDACTED)[^\s",}\])]+/g,
        "$1[REDACTED]",
      )
      // Ordinary words as an UPPERCASE env-style name.
      .replace(
        /((?:^|[\s"'`(\[{,?&;])(?:[A-Z0-9]+[_-])*(?:KEY|URL)"?\s*[:=]\s*"?)(?!\[REDACTED)[^\s",}\])]+/g,
        "$1[REDACTED]",
      )
      // Or as a dashed flag, where a separator has to precede the word so
      // `--api-key=` redacts and `--monkey=` does not.
      .replace(
        /((?:^|[\s"'`(\[{,?&;])-{1,2}[A-Za-z0-9-]*[-_](?:KEY|URL)"?\s*[:=]\s*"?)(?!\[REDACTED)[^\s",}\])]+/gi,
        "$1[REDACTED]",
      )
      // Userinfo with or without a password. The scheme run is bounded: an
      // unbounded one backtracks quadratically over a long alphanumeric line.
      .replace(/([a-z][a-z0-9+.-]{0,32}:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
  );
}

// ── Neutralization (renderer side, spec §11.2) ─────────────────────────────

/**
 * ANSI escape sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL | ST`), and
 * the two-character forms. Removed **before** the generic control-character
 * pass, and the order is load-bearing: stripping the bare ESC first would leave
 * `[31m` behind as visible junk on the operator's screen.
 */
const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g;

/**
 * Bidirectional controls and zero-width characters. Both are invisible by
 * construction, which is exactly why they are the vector: a bidi override
 * reverses what an operator reads, and a zero-width character splits a word a
 * human is scanning for. Casualty accepted knowingly: ZWJ emoji sequences and
 * Indic/Arabic joiners degrade. §11.2 says neutralize them, and evidence text
 * is provider-authored diagnostics, not prose we owe typographic fidelity to.
 */
const BIDI_AND_ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/**
 * Tab and newline survive; every other C0/C1 control, DEL, and the Unicode line
 * and paragraph separators do not. Carriage return is stripped deliberately:
 * the renderer is line-oriented, and a stray CR lets diagnostic text overwrite
 * the `[code]` and `Source:` lines an operator relies on to identify who is
 * blocking them.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;

function neutralizeForDisplay(value: string): string {
  return value.replace(ANSI_SEQUENCE, "").replace(BIDI_AND_ZERO_WIDTH, "").replace(CONTROL_CHARACTERS, "");
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function bounded(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 0) return "";
  // Walk code points rather than slicing units: a plain slice can cut a
  // surrogate pair in half and emit a lone surrogate just before the ellipsis.
  let truncated = "";
  for (const character of value) {
    if (truncated.length + character.length > maximum - 1) break;
    truncated += character;
  }
  return `${truncated}…`;
}

/**
 * Pre-slice before any regex pass so a multi-megabyte provider report cannot
 * make it quadratic. The window is a generous multiple of the cap, so a secret
 * straddling the final cut is still scanned.
 */
function windowed(value: string, maximum: number): string {
  return value.slice(0, Math.max(maximum, 1) * 8);
}

// ── Construction ───────────────────────────────────────────────────────────

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

/**
 * Operator-facing summaries are single lines by construction. Collapsing
 * whitespace stops provider-supplied text from forging a second `Remediation:`
 * block, which would otherwise read as harness-authored guidance.
 */
function sanitizedLine(value: unknown, label: string): string {
  // Redact before collapsing whitespace: the rules key off `=`, `:` and `://`,
  // and a summary is no less likely to carry provider text than a detail.
  const raw = requireString(value, label);
  const sanitized = redactSecrets(windowed(raw, MAX_BLOCKER_DETAIL_LENGTH)).replace(/\s+/g, " ").trim();
  if (sanitized === "") throw new Error(`${label} must be non-empty.`);
  return sanitized;
}

/**
 * Details keep their newlines — a stack or a provider report is unreadable as
 * one line — but are redacted and bounded here rather than at the renderer, so
 * no stored or serialized form can retain more than the operator was shown.
 */
function sanitizedDetail(value: unknown, label: string): string {
  const raw = requireString(value, label);
  const redacted = redactSecrets(windowed(raw, MAX_BLOCKER_DETAIL_LENGTH)).trim();
  return bounded(redacted, MAX_BLOCKER_DETAIL_LENGTH);
}

function sanitizedCommand(command: unknown, label: string): CommandArguments {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error(`${label} command must be a non-empty argv array.`);
  }
  const args = (command as readonly unknown[]).map((argument, index) =>
    // Several CLIs splice raw argv into their reproduce command, so arguments
    // are operator-facing text like everything else here: a `--token=` value
    // would otherwise be echoed and stored verbatim.
    redactSecrets(windowed(requireString(argument, `${label} command argument ${index}`), MAX_BLOCKER_DETAIL_LENGTH)),
  );
  const [first, ...rest] = args;
  return [first as string, ...rest];
}

function sanitizedRemediation(remediation: unknown): Remediation {
  if (remediation === null || typeof remediation !== "object") {
    throw new Error("Blocker remediation must be an object.");
  }
  const input = remediation as Record<string, unknown>;
  const id = requireString(input["id"], "Blocker remediation id");
  if (!REMEDIATION_ID_PATTERN.test(id)) {
    throw new Error("Blocker remediation id must be a stable kebab-case identifier.");
  }
  const kind = input["kind"];
  if (kind !== "command" && kind !== "manual_action" && kind !== "code_change" && kind !== "retry") {
    throw new Error(`Blocker remediation kind ${String(kind)} is not part of the contract.`);
  }
  const base = {
    id,
    summary: sanitizedLine(input["summary"], "Blocker remediation summary"),
    ...(input["details"] === undefined ? {} : { details: sanitizedDetail(input["details"], "Blocker remediation details") }),
  };
  if (kind === "command") {
    return { ...base, kind, command: sanitizedCommand(input["command"], "Blocker remediation") };
  }
  if (kind === "retry" && input["command"] !== undefined) {
    return { ...base, kind, command: sanitizedCommand(input["command"], "Blocker remediation") };
  }
  return { ...base, kind };
}

/**
 * The `kind` is closed and checked; the `id` is config-owned data, so it is
 * checked against a grammar instead. A free-form source id is exactly the drift
 * this contract exists to prevent, so it fails loudly at construction — which
 * is the one place failing loudly is safe.
 */
function validatedSource(source: unknown): BlockerSource {
  if (source === null || typeof source !== "object") {
    throw new Error("Blocker source must be an object naming a kind and an id.");
  }
  const input = source as Record<string, unknown>;
  const kind = input["kind"];
  if (typeof kind !== "string" || !(BLOCKER_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Blocker source kind ${String(kind)} is not part of the contract.`);
  }
  const id = input["id"];
  if (typeof id !== "string" || !SOURCE_ID_PATTERN.test(id)) {
    throw new Error(`Blocker source id ${JSON.stringify(id)} is not a stable lowercase identifier.`);
  }
  return { kind: kind as BlockerSourceKind, id };
}

/**
 * The single constructor every blocker passes through, so redaction is a
 * property of the contract rather than something each call site remembers.
 *
 * It returns a normalized copy on purpose: validating the cleaned text and then
 * discarding it would leave the guarantee documented but unenforced everywhere
 * downstream.
 */
export function createBlocker<const TInput extends BlockerInput>(
  input: TInput & { readonly code: ValidBlockerCode<TInput["code"]> },
): Blocker {
  const raw = input as unknown as Record<string, unknown>;
  const code = sanitizedLine(raw["code"], "Blocker code");
  if (!CODE_PATTERN.test(code)) {
    throw new Error(`Blocker code ${JSON.stringify(code)} must be a stable lowercase identifier.`);
  }
  const source = validatedSource(raw["source"]);
  const remediations = raw["remediations"];
  if (!Array.isArray(remediations) || remediations.length === 0) {
    throw new Error("Blocker remediations must be a non-empty list: a blocker with no way forward is not guidance.");
  }
  const sanitized = (remediations as readonly unknown[]).map(sanitizedRemediation);
  const [firstRemediation, ...restRemediations] = sanitized;
  return {
    code,
    source,
    summary: sanitizedLine(raw["summary"], "Blocker summary"),
    ...(raw["details"] === undefined ? {} : { details: sanitizedDetail(raw["details"], "Blocker details") }),
    remediations: [firstRemediation as Remediation, ...restRemediations],
  };
}

// ── The internal-error path ────────────────────────────────────────────────

function describeThrown(error: unknown, depth = 0): string {
  try {
    if (error instanceof Error) {
      // The stack is the diagnostic on this path: an unexpected TypeError with
      // only its message names no file or line, and wrapped failures keep the
      // real reason on `cause`.
      const base = error.stack ?? `${error.name}: ${error.message}`;
      if (error.cause === undefined || depth >= 3) return base;
      return `${base}\nCaused by: ${describeThrown(error.cause, depth + 1)}`;
    }
    return String(error);
  } catch {
    return "Unknown internal error (the thrown value could not be described).";
  }
}

/** Derived remediation ids satisfy the same kebab-case gate as authored ones. */
function remediationIdFor(prefix: string, source: BlockerSource): string {
  const slug = `${source.kind}-${source.id}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? prefix : `${prefix}-${slug}`;
}

/**
 * An unexpected throw is not a policy decision, and must never be reported as
 * one. Whatever was thrown — an Error, a string, a symbol, an object whose
 * `toString` itself throws — becomes a typed blocker with a reproduce command.
 */
export function createInternalErrorBlocker(input: {
  readonly source: BlockerSource;
  readonly error: unknown;
  readonly reproduce: CommandArguments;
  readonly retainedLogPath?: string;
}): Blocker {
  const described = describeThrown(input.error);
  return createBlocker({
    code: INTERNAL_ERROR_CODE,
    source: input.source,
    summary: "The harness encountered an unexpected internal error.",
    details: described === "" ? "Unknown internal error." : described,
    remediations: [
      {
        id: remediationIdFor("reproduce", input.source),
        kind: "command",
        command: input.reproduce,
        summary: "Reproduce the failure with the authoritative command.",
      },
      {
        id: "inspect-harness-output",
        kind: "manual_action",
        summary:
          input.retainedLogPath === undefined
            ? "Inspect the complete harness output before retrying."
            : `Inspect the retained harness log at ${input.retainedLogPath}.`,
      },
    ],
  });
}

// ── Total rendering ────────────────────────────────────────────────────────

/**
 * Everything below reads its input defensively. Not all of it came from
 * `createBlocker`: an MCP payload crosses a process boundary, and a blocker
 * reconstructed from JSON has whatever shape the sender gave it. A throwing
 * getter, a circular structure, a number where a string belongs, and a
 * multi-megabyte detail are all rendered rather than thrown on.
 */
const UNAVAILABLE = "[unavailable]";

function safeGet(container: unknown, key: string): unknown {
  if (container === null || typeof container !== "object") return undefined;
  try {
    return (container as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  try {
    const text = String(value);
    return text === "" ? fallback : text;
  } catch {
    return fallback;
  }
}

function displayText(value: unknown, fallback: string, maximum: number): string {
  const text = safeText(value, fallback);
  return bounded(neutralizeForDisplay(windowed(text, maximum)), maximum);
}

function displayCommand(value: unknown, maximum: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return (value as readonly unknown[]).map((argument) => displayText(argument, UNAVAILABLE, maximum));
}

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatCommand(command: readonly string[]): string {
  return command.map(quoteCommandArgument).join(" ");
}

interface DisplayRemediation {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly details: string | null;
  readonly command: readonly string[] | null;
}

function displayRemediations(value: unknown, maxDetailLength: number): readonly DisplayRemediation[] {
  if (!Array.isArray(value)) return [];
  const out: DisplayRemediation[] = [];
  for (const entry of value as readonly unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const details = safeGet(entry, "details");
    out.push({
      id: displayText(safeGet(entry, "id"), UNAVAILABLE, 200),
      kind: displayText(safeGet(entry, "kind"), UNAVAILABLE, 200),
      summary: displayText(safeGet(entry, "summary"), UNAVAILABLE, maxDetailLength),
      details: details === undefined || details === null ? null : displayText(details, "", maxDetailLength),
      command: displayCommand(safeGet(entry, "command"), maxDetailLength),
    });
  }
  return out;
}

interface DisplayBlocker {
  readonly code: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly summary: string;
  readonly details: string | null;
  readonly remediations: readonly DisplayRemediation[];
}

function toDisplay(blocker: unknown, maxDetailLength: number): DisplayBlocker | undefined {
  if (blocker === null || typeof blocker !== "object") return undefined;
  const source = safeGet(blocker, "source");
  const details = safeGet(blocker, "details");
  return {
    code: displayText(safeGet(blocker, "code"), UNAVAILABLE, 200),
    sourceKind: displayText(safeGet(source, "kind"), UNAVAILABLE, 200),
    sourceId: displayText(safeGet(source, "id"), UNAVAILABLE, 200),
    summary: displayText(safeGet(blocker, "summary"), UNAVAILABLE, maxDetailLength),
    details: details === undefined || details === null ? null : displayText(details, "", maxDetailLength),
    remediations: displayRemediations(safeGet(blocker, "remediations"), maxDetailLength),
  };
}

function remediationBody(remediation: DisplayRemediation): string {
  try {
    return JSON.stringify({
      kind: remediation.kind,
      summary: remediation.summary,
      details: remediation.details,
      command: remediation.command,
    });
  } catch {
    return "<unserializable>";
  }
}

/**
 * Deduplicates on the whole remediation, not on its id alone.
 *
 * Identical guidance collapses, which is the point of a stable id. Divergent
 * guidance under one id is kept rather than dropped or thrown on: this runs
 * inside failure handlers, so a throw here would discard every blocker and
 * leave the operator nothing at exactly the moment the contract exists to
 * deliver guidance. Id discipline is a static concern, belonging to the
 * command-inventory sensor that is still to be written, where failing loudly is
 * the right outcome.
 */
function uniqueRemediations(blockers: readonly DisplayBlocker[]): readonly DisplayRemediation[] {
  const seen = new Set<string>();
  const out: DisplayRemediation[] = [];
  for (const blocker of blockers) {
    for (const remediation of blocker.remediations) {
      const key = `${remediation.id}\u0000${remediationBody(remediation)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(remediation);
    }
  }
  return out;
}

function remediationInstruction(remediation: DisplayRemediation): string {
  const command = remediation.command === null ? "" : ` Command: ${formatCommand(remediation.command)}`;
  const details = remediation.details === null || remediation.details === "" ? "" : ` ${remediation.details}`;
  return `- (${remediation.id}) ${remediation.summary}${command}${details}`;
}

/**
 * The text surface: CLI stderr, Action logs, MCP text content. Total — it
 * returns a string for every input, including inputs that are not blockers.
 */
export function renderBlockers(blockers: readonly Blocker[], options: RenderOptions = {}): string {
  try {
    if (!Array.isArray(blockers) || blockers.length === 0) return "";
    const maxDetailLength = options.maxDetailLength ?? 600;
    const maxOutputLength = options.maxOutputLength ?? 12_000;
    const display: DisplayBlocker[] = [];
    for (const blocker of blockers as readonly unknown[]) {
      const entry = toDisplay(blocker, maxDetailLength);
      if (entry !== undefined) display.push(entry);
    }
    if (display.length === 0) return "";

    const remediations = uniqueRemediations(display);
    const remediationText =
      remediations.length === 0 ? "" : ["Remediation:", ...remediations.map(remediationInstruction)].join("\n");
    // Remediation claims its budget before the diagnostic body. Bounding the
    // joined string instead lets a few verbose blockers push the guidance off
    // the end — silently removing the one thing this contract exists to deliver.
    if (remediationText.length >= maxOutputLength) return bounded(remediationText, maxOutputLength);
    const bodyBudget = remediationText === "" ? maxOutputLength : maxOutputLength - remediationText.length - 1;

    const body = bounded(
      display
        .flatMap((blocker) => [
          `[${blocker.code}] ${blocker.summary}`,
          `  Source: ${blocker.sourceKind}:${blocker.sourceId}`,
          ...(blocker.details === null || blocker.details === "" ? [] : [`  Details: ${blocker.details.replaceAll("\n", "\n    ")}`]),
        ])
        .join("\n"),
      bodyBudget,
    );
    if (remediationText === "") return body;
    return body === "" ? remediationText : `${body}\n${remediationText}`;
  } catch {
    // Unreachable by construction; kept because "total" has to survive a future
    // edit to any helper above, and returning nothing beats throwing here.
    return "";
  }
}

/**
 * The structured surface: MCP rejections and Action outputs. An agent context
 * window is a rendering surface too, so this neutralizes exactly as the text
 * renderer does, and is equally total — the result is always JSON-serializable.
 */
export function serializeBlockers(blockers: readonly Blocker[]): SerializedBlockers {
  const out: SerializedBlocker[] = [];
  try {
    if (Array.isArray(blockers)) {
      for (const blocker of blockers as readonly unknown[]) {
        const entry = toDisplay(blocker, MAX_BLOCKER_DETAIL_LENGTH);
        if (entry === undefined) continue;
        out.push({
          code: entry.code,
          source: { kind: entry.sourceKind, id: entry.sourceId },
          summary: entry.summary,
          details: entry.details === "" ? null : entry.details,
          remediations: entry.remediations.map((remediation) => ({
            id: remediation.id,
            kind: remediation.kind,
            summary: remediation.summary,
            details: remediation.details === "" ? null : remediation.details,
            command: remediation.command,
          })),
        });
      }
    }
  } catch {
    // Same reasoning as the text renderer: a serialization failure must not
    // become the thing that stops the operator learning why they are blocked.
  }
  return { contractVersion: BLOCKER_CONTRACT_VERSION, blockers: out };
}
