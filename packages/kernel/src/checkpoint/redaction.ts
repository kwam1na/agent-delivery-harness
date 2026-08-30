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

import { MAX_FREE_TEXT } from "../spine/grammar.ts";

export interface SecretPattern {
  readonly id: string;
  /** Source without flags; matching always constructs a fresh global RegExp. */
  readonly source: string;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  { id: "private-key-block", source: String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)` },
  { id: "aws-access-key-id", source: String.raw`\bAKIA[0-9A-Z]{16}\b` },
  { id: "github-token", source: String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}\b` },
  { id: "github-fine-grained-token", source: String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}\b` },
  { id: "slack-token", source: String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}\b` },
  { id: "openai-key", source: String.raw`\bsk-[A-Za-z0-9_-]{20,}\b` },
  { id: "google-api-key", source: String.raw`\bAIza[0-9A-Za-z_-]{30,}\b` },
  { id: "jwt", source: String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b` },
  { id: "bearer-credential", source: String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{20,}` },
] as const);

/** The spine's bounded free-text member names — the only redactable landing spots. */
export const FREE_TEXT_MEMBERS: ReadonlySet<string> = new Set(["summary", "reason"]);

export interface RedactedText {
  readonly text: string;
  /** The pattern ids that matched, in corpus order, deduplicated. */
  readonly redacted: readonly string[];
}

export function redactSecretText(text: string): RedactedText {
  let result = text;
  const redacted: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const matcher = new RegExp(pattern.source, "g");
    if (!matcher.test(result)) continue;
    redacted.push(pattern.id);
    result = result.replace(new RegExp(pattern.source, "g"), `[redacted:${pattern.id}]`);
  }
  return { text: result, redacted };
}

function firstSecretIn(text: string): string | undefined {
  for (const pattern of SECRET_PATTERNS) {
    if (new RegExp(pattern.source, "g").test(text)) return pattern.id;
  }
  return undefined;
}

export type SecretDisciplineResult =
  | { readonly ok: true; readonly entry: unknown; readonly redactions: readonly string[] }
  | { readonly ok: false; readonly matches: readonly { readonly pointer: string; readonly id: string }[] };

/**
 * Walks every string value of a journal entry: free-text members are redacted
 * in place, any other matching string rejects with its pointer. The input is
 * never mutated; the returned entry is a disciplined copy.
 */
export function applySecretDiscipline(entry: unknown): SecretDisciplineResult {
  const matches: { pointer: string; id: string }[] = [];
  const redactions: string[] = [];

  const walk = (value: unknown, pointer: string, member: string | undefined): unknown => {
    if (typeof value === "string") {
      if (member !== undefined && FREE_TEXT_MEMBERS.has(member)) {
        const outcome = redactSecretText(value);
        for (const id of outcome.redacted) if (!redactions.includes(id)) redactions.push(id);
        // Redaction tokens are longer than some credentials, and a bounded
        // free-text member must stay bounded: redaction may never turn a
        // valid value invalid (which would wedge the append fail-closed on
        // candidate-crafted sensor output). Only a redacted value is capped.
        return outcome.redacted.length > 0 && outcome.text.length > MAX_FREE_TEXT
          ? outcome.text.slice(0, MAX_FREE_TEXT)
          : outcome.text;
      }
      const id = firstSecretIn(value);
      if (id !== undefined) matches.push({ pointer, id });
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${pointer}/${index}`, undefined));
    }
    if (typeof value === "object" && value !== null) {
      const copy: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(value)) {
        copy[name] = walk(item, `${pointer}/${name}`, name);
      }
      return copy;
    }
    return value;
  };

  const disciplined = walk(entry, "", undefined);
  if (matches.length > 0) return { ok: false, matches };
  return { ok: true, entry: disciplined, redactions };
}
