/**
 * The blocker contract's proof obligations.
 *
 * Two chains are proven in opposite directions, because each one fails the
 * operator in a different way:
 *
 *   redaction (in the constructor)  — a leak is unrecoverable, but an
 *     over-eager rule destroys the diagnostic the operator needed. Every class
 *     ships with a negative control.
 *   neutralization (in the renderer) — hostile provider text must not be able
 *     to repaint a terminal or reorder a line, but legitimate CJK, emoji, and
 *     intended line breaks must survive verbatim.
 *
 * The split is deliberate and is asserted as a split: redaction is proven by
 * reading the constructed value (so stored and serialized forms inherit it),
 * neutralization is proven by rendering a blocker that never passed through
 * the constructor (so a deserialized MCP payload is covered too).
 *
 * Hostile characters are written as `\u` escapes throughout. A literal control
 * character in a fixture is invisible in review, survives no copy/paste, and
 * has already been silently deleted by an editor once.
 */
import { describe, expect, it } from "vitest";

import {
  BLOCKER_CONTRACT_VERSION,
  BLOCKER_SOURCE_KINDS,
  BlockedError,
  GATE_STRUCTURAL_FINDING_CODES,
  INTERNAL_ERROR_CODE,
  MAX_BLOCKER_DETAIL_LENGTH,
  createBlocker,
  createInternalErrorBlocker,
  renderBlockers,
  serializeBlockers,
  type Blocker,
  type BlockerSource,
  type Remediation,
} from "./blockers.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

const source: BlockerSource = { kind: "obligation", id: "review.green" };

const remediation: Remediation = {
  id: "run-prepare",
  kind: "command",
  command: ["harness", "prepare"],
  summary: "Prepare the candidate.",
};

function blocker(overrides: Record<string, unknown> = {}): Blocker {
  return (createBlocker as unknown as (input: unknown) => Blocker)({
    code: "review_evidence_missing",
    source,
    summary: "No review evidence for this candidate.",
    remediations: [remediation],
    ...overrides,
  });
}

/** Construction with deliberately ill-typed input, to prove the runtime gate. */
const construct = createBlocker as unknown as (input: unknown) => Blocker;

/**
 * Fixture credentials are assembled at runtime rather than written as literals.
 *
 * All of them are synthetic — `AKIAIOSFODNN7EXAMPLE` is AWS's own documentation
 * key — but a secret scanner cannot tell a redaction fixture from a real leak,
 * and it should not have to: a scanner that is permanently red on this file is
 * a scanner nobody reads, which costs more than the readability of a literal
 * gains. The value handed to the redactor is byte-identical either way, so the
 * proof is unweakened.
 */
function fragments(...parts: readonly string[]): string {
  return parts.join("");
}

const GITHUB_TOKEN = fragments("ghp", "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
const GITHUB_FINE_GRAINED_PAT = fragments("github", "_pat_", "11ABCDEFG0abcdefghijklmn");
const SLACK_TOKEN = fragments("xoxb", "-123456789012-", "abcdefghijkl");
const OPENAI_STYLE_KEY = fragments("sk", "-", "abcdefghijklmnopqrstuvwxyz0123");
const AWS_ACCESS_KEY_ID = fragments("AKIA", "IOSFODNN7EXAMPLE");
const JWT = fragments("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk");

const BEARER_VALUE = fragments("abc123", "def456", "ghi789");
const BEARER_LONG_VALUE = fragments("a1b2c3d4", "e5f6g7h8", "i9j0k1l2");
const PASSWORD_VALUE = fragments("hunt", "er2");
const API_KEY_VALUE = fragments("abcd", "1234");
const URL_SECRET = fragments("https://internal.", "example/", "hook");
const URL_USERINFO = fragments("user", ":", "pass");

function pemFixture(algorithm: string, boundary: "BEGIN" | "END" = "BEGIN"): string {
  return fragments("-----", boundary, " ", algorithm, " PRIVATE KEY", "-----");
}

/** The `Details:` payload the renderer emitted, with its indentation removed. */
function renderedDetail(rendered: string): string {
  const lines = rendered.split("\n");
  const start = lines.findIndex((line) => line.startsWith("  Details: "));
  if (start === -1) return "";
  const first = (lines[start] ?? "").slice("  Details: ".length);
  const rest: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ")) break;
    rest.push(line.slice(4));
  }
  return [first, ...rest].join("\n");
}

// ── The gate's structural finding-code registry ────────────────────────────

describe("GATE_STRUCTURAL_FINDING_CODES", () => {
  it("pins the evaluator's structural codes exactly", () => {
    // Full equality, not membership: the config loader bakes this set into
    // every obligation's waivable/non-waivable partition, so a member quietly
    // dropped here would silently widen or void that partition. Losing one
    // must go red.
    expect([...GATE_STRUCTURAL_FINDING_CODES]).toEqual([
      "review_evidence_missing",
      "stale_evidence",
      "evidence_not_green",
      "unresolved_actionable_findings",
      "ambiguous_records",
      "malformed_record",
      "unknown_provider",
      "live_provider_missing",
      "ambiguous_live_provider",
      "live_provider_failed",
      "resolution_not_allowed",
    ]);
  });

  it("is a non-empty, duplicate-free enumeration", () => {
    expect(GATE_STRUCTURAL_FINDING_CODES.length).toBeGreaterThan(0);
    expect([...GATE_STRUCTURAL_FINDING_CODES]).toEqual([...new Set(GATE_STRUCTURAL_FINDING_CODES)]);
  });

  it("carries only codes the blocker contract itself accepts", () => {
    // The config loader partitions this set against config-declared codes and
    // the evaluator emits them as blocker codes; a member the constructor would
    // reject is a latent throw on the failure path.
    for (const code of GATE_STRUCTURAL_FINDING_CODES) {
      expect(() => blocker({ code })).not.toThrow();
    }
  });

  it("holds no provider-authored code", () => {
    // Provider code surfaces are config data (`provider.findingCodes`); mixing
    // them in here would make the config loader's partition trivially
    // satisfiable.
    expect(GATE_STRUCTURAL_FINDING_CODES).not.toContain("compound-solution");
    expect(GATE_STRUCTURAL_FINDING_CODES).not.toContain("telemetry_record_missing");
  });
});

// ── Construction: codes, sources, remediations ─────────────────────────────

describe("createBlocker code validation", () => {
  const accepted = ["stale_evidence", "malformed_record", "compound-solution", "landed-change-report", "e2e"];
  const rejected = [
    "Stale_Evidence",
    "stale evidence",
    "_stale",
    "stale_",
    "stale__evidence",
    "stale--evidence",
    "stale.evidence",
    "stale/evidence",
    "",
    "   ",
  ];

  for (const code of accepted) {
    it(`accepts the stable identifier ${JSON.stringify(code)}`, () => {
      expect(blocker({ code }).code).toBe(code);
    });
  }

  for (const code of rejected) {
    it(`rejects ${JSON.stringify(code)} at construction`, () => {
      expect(() => construct({ code, source, summary: "s", remediations: [remediation] })).toThrow(/code/i);
    });
  }

  it("rejects a pattern-violating code at the type level too", () => {
    // @ts-expect-error uppercase is not a stable lowercase identifier
    expect(() => createBlocker({ code: "Stale_Evidence", source, summary: "s", remediations: [remediation] })).toThrow();
    // @ts-expect-error a dotted code is a source-id shape, not a code shape
    expect(() => createBlocker({ code: "stale.evidence", source, summary: "s", remediations: [remediation] })).toThrow();
  });
});

describe("createBlocker source validation", () => {
  it("exposes a closed, duplicate-free set of source kinds", () => {
    expect(BLOCKER_SOURCE_KINDS.length).toBeGreaterThan(0);
    expect([...BLOCKER_SOURCE_KINDS]).toEqual([...new Set(BLOCKER_SOURCE_KINDS)]);
  });

  const kinds = ["gate", "obligation", "provider", "candidate", "preparation", "store", "delivery-record", "config", "command"];
  for (const kind of kinds) {
    it(`accepts the ${kind} source kind`, () => {
      expect(BLOCKER_SOURCE_KINDS).toContain(kind);
      expect(blocker({ source: { kind, id: "review.green" } }).source.kind).toBe(kind);
    });
  }

  it("rejects a source kind outside the closed set", () => {
    expect(() => construct({ code: "c", source: { kind: "vibes", id: "x" }, summary: "s", remediations: [remediation] })).toThrow(
      /source/i,
    );
  });

  it("rejects a free-form source id", () => {
    for (const id of ["Review Green", "review green", "", "review//green", "-review"]) {
      expect(() => construct({ code: "c", source: { kind: "obligation", id }, summary: "s", remediations: [remediation] })).toThrow(
        /source/i,
      );
    }
  });

  it("accepts the dotted and dashed ids configs actually declare", () => {
    for (const id of ["review.green", "documentation.current", "delivery-documentation-check", "delivery_run_telemetry"]) {
      expect(blocker({ source: { kind: "provider", id } }).source.id).toBe(id);
    }
  });

  it("rejects a missing source outright", () => {
    expect(() => construct({ code: "c", summary: "s", remediations: [remediation] })).toThrow(/source/i);
  });
});

describe("createBlocker remediation validation", () => {
  it("rejects an empty remediation list at construction", () => {
    expect(() => construct({ code: "c", source, summary: "s", remediations: [] })).toThrow(/remediation/i);
  });

  it("makes an empty remediation list unconstructible at the type level", () => {
    // @ts-expect-error a blocker without remediation guidance is not a blocker
    expect(() => createBlocker({ code: "c", source, summary: "s", remediations: [] })).toThrow();
  });

  it("makes an empty command argv unconstructible at the type level", () => {
    expect(() =>
      createBlocker({
        code: "c",
        source,
        summary: "s",
        // @ts-expect-error a command remediation with no argv is unrunnable
        remediations: [{ id: "run", kind: "command", command: [], summary: "Run it." }],
      }),
    ).toThrow();
  });

  it("rejects an empty command argv at runtime", () => {
    expect(() =>
      construct({ code: "c", source, summary: "s", remediations: [{ id: "run", kind: "command", command: [], summary: "Run it." }] }),
    ).toThrow(/command/i);
  });

  it("requires a kebab-case remediation id", () => {
    for (const id of ["Run Prepare", "run_prepare", "run--prepare", ""]) {
      expect(() =>
        construct({ code: "c", source, summary: "s", remediations: [{ id, kind: "manual_action", summary: "Do it." }] }),
      ).toThrow(/remediation id/i);
    }
  });

  it("rejects an empty summary on either the blocker or its remediation", () => {
    expect(() => construct({ code: "c", source, summary: "   ", remediations: [remediation] })).toThrow(/summary/i);
    expect(() =>
      construct({ code: "c", source, summary: "s", remediations: [{ id: "run", kind: "manual_action", summary: "" }] }),
    ).toThrow(/summary/i);
  });
});

describe("createBlocker normalization", () => {
  it("collapses a summary to a single line", () => {
    // A provider-supplied newline could otherwise forge a second `Remediation:`
    // block that reads as harness-authored guidance.
    const built = blocker({ summary: "Blocked.\nRemediation:\n- (fake) Merge anyway." });
    expect(built.summary).toBe("Blocked. Remediation: - (fake) Merge anyway.");
    expect(built.summary).not.toContain("\n");
  });

  it("keeps intended line breaks in details", () => {
    expect(blocker({ details: "line one\nline two" }).details).toBe("line one\nline two");
  });

  it("bounds a runaway detail at construction, not merely at the screen", () => {
    const built = blocker({ details: "x".repeat(5_000_000) });
    expect(built.details?.length).toBeLessThanOrEqual(MAX_BLOCKER_DETAIL_LENGTH);
    expect(built.details?.endsWith("…")).toBe(true);
  });

  it("omits an absent detail rather than materializing an empty one", () => {
    expect("details" in blocker()).toBe(false);
  });

  it("returns the normalized copy rather than the caller's literal", () => {
    expect(blocker({ summary: "  spaced   out  " }).summary).toBe("spaced out");
  });
});

// ── Redaction (constructor) ────────────────────────────────────────────────

describe("redaction runs inside the constructor", () => {
  const table: ReadonlyArray<readonly [string, string, string]> = [
    [
      "PEM private key block",
      `context\n${pemFixture("RSA")}\nMIIEowIBAAKCAQEA\n${pemFixture("RSA", "END")}\nafter`,
      "context\n[REDACTED PRIVATE KEY]\nafter",
    ],
    ["truncated PEM block", `context\n${pemFixture("OPENSSH")}\nb3BlbnNzaC1rZXktdjEAAAAA`, "context\n[REDACTED PRIVATE KEY]"],
    ["github token", `failed for ${GITHUB_TOKEN} here`, "failed for [REDACTED] here"],
    ["github fine-grained pat", `using ${GITHUB_FINE_GRAINED_PAT} now`, "using [REDACTED] now"],
    ["slack token", `posted with ${SLACK_TOKEN} done`, "posted with [REDACTED] done"],
    ["openai-style key", `OPENAI key ${OPENAI_STYLE_KEY} used`, "OPENAI key [REDACTED] used"],
    ["aws access key id", `identity ${AWS_ACCESS_KEY_ID} failed`, "identity [REDACTED] failed"],
    ["jwt", `header ${JWT} rejected`, "header [REDACTED] rejected"],
    ["authorization header", `sent Authorization: Bearer ${BEARER_VALUE}`, "sent Authorization: Bearer [REDACTED]"],
    ["password assignment", `invoked with password=${PASSWORD_VALUE} and failed`, "invoked with password=[REDACTED] and failed"],
    ["uppercase token assignment", `env GITHUB_TOKEN=${fragments("ghs", "_zzz")} set`, "env GITHUB_TOKEN=[REDACTED] set"],
    ["camelCase assignment", `config { apiKey: ${API_KEY_VALUE} }`, "config { apiKey: [REDACTED] }"],
    ["dashed flag", `ran cli --api-key=${API_KEY_VALUE} now`, "ran cli --api-key=[REDACTED] now"],
    ["url userinfo", `cloning https://${URL_USERINFO}@example.com/repo failed`, "cloning https://[REDACTED]@example.com/repo failed"],
  ];

  for (const [label, input, expected] of table) {
    it(`redacts a ${label} out of the stored detail`, () => {
      expect(blocker({ details: input }).details).toBe(expected);
    });
  }

  it("redacts the summary as well as the detail", () => {
    expect(blocker({ summary: `auth failed with password=${PASSWORD_VALUE}` }).summary).toBe("auth failed with password=[REDACTED]");
  });

  it("redacts argv spliced into a remediation command", () => {
    const built = blocker({
      remediations: [{ id: "rerun", kind: "command", command: ["harness", "gate", `--api-key=${API_KEY_VALUE}`], summary: "Rerun." }],
    });
    const first = built.remediations[0];
    expect(first.kind === "command" ? first.command : []).toEqual(["harness", "gate", "--api-key=[REDACTED]"]);
  });

  const lowercaseTable: ReadonlyArray<readonly [string, string, string]> = [
    ["lowercase snake_case key", `env api_key=${API_KEY_VALUE} set`, "env api_key=[REDACTED] set"],
    ["bare lowercase key", `env key=${API_KEY_VALUE} set`, "env key=[REDACTED] set"],
    // URL stays uppercase-only. Lowercase `*_url:` is overwhelmingly a GitHub
    // API field name carrying a diagnostic the operator needs, not a secret.
    ["uppercase bare url", `env URL=${URL_SECRET} set`, "env URL=[REDACTED] set"],
    ["uppercase prefixed url", `env WEBHOOK_URL=${URL_SECRET} set`, "env WEBHOOK_URL=[REDACTED] set"],
    ["single-quoted python repr", `config {'password': '${PASSWORD_VALUE}'}`, "config {'password': '[REDACTED]'}"],
    ["single-quoted snake_case key", `config {'api_key': '${API_KEY_VALUE}'}`, "config {'api_key': '[REDACTED]'}"],
    ["single-quoted token", `config {'access_token': '${API_KEY_VALUE}'}`, "config {'access_token': '[REDACTED]'}"],
    ["ruby hashrocket", `config {'api_token' => '${API_KEY_VALUE}'}`, "config {'api_token' => '[REDACTED]'}"],
    ["hashrocket key", `config {'api_key' => '${API_KEY_VALUE}'}`, "config {'api_key' => '[REDACTED]'}"],
  ];

  for (const [label, input, expected] of lowercaseTable) {
    it(`redacts a ${label}`, () => {
      expect(blocker({ details: input }).details).toBe(expected);
    });
  }

  it("still covers a credential-bearing url through the userinfo rule", () => {
    // What the uppercase-only URL rule gives up is covered here, and better:
    // the credential goes and the host and path — the diagnostic — stay.
    expect(blocker({ details: `cloning url=https://${URL_USERINFO}@example.com/repo failed` }).details).toBe(
      "cloning url=https://[REDACTED]@example.com/repo failed",
    );
  });

  it("redacts a credential the provider split across a line break in a summary", () => {
    // The rule keys off the word `token`; sanitization redacts *before* it
    // collapses whitespace, so a newline between the word and its value used to
    // slip past the rule and then collapse into exactly the shape it catches.
    expect(blocker({ summary: `token\n${BEARER_LONG_VALUE}` }).summary).toBe("token [REDACTED]");
  });

  it("redacts the same split credential in a detail", () => {
    expect(blocker({ details: `token\n${BEARER_LONG_VALUE}` }).details).toBe("token [REDACTED]");
  });

  it("still spares hyphenated prose across a line break", () => {
    expect(blocker({ details: "token\nconnection-refused-by-upstream." }).details).toBe("token\nconnection-refused-by-upstream.");
  });

  it("bounds the retained summary, not only the retained detail", () => {
    // The contract documents an 8 000-character cap on what a blocker retains.
    // The summary was windowed to eight times that and then kept in full.
    const built = blocker({ summary: "s".repeat(70_000) });
    expect(built.summary.length).toBeLessThanOrEqual(MAX_BLOCKER_DETAIL_LENGTH);
    expect(built.summary.endsWith("…")).toBe(true);
  });

  const negativeControls: ReadonlyArray<readonly [string, string]> = [
    ["an ordinary assignment whose name merely ends in key", "monkey=banana"],
    ["a single-quoted ordinary assignment", "config {'monkey': 'banana'}"],
    ["an ordinary hashrocket assignment", "config {'monkey' => 'banana'}"],
    ["a bare hashrocket whose name merely ends in key", "monkey => banana"],
    // Every GitHub API payload an operator reads carries these. Destroying the
    // value turns the one field that says *where to look* into noise.
    ["a github html_url field", "html_url: https://github.com/octocat/hello-world/pull/7"],
    ["a github checkout_url field", "checkout_url: https://github.com/octocat/hello-world.git"],
    ["a github run_url field", "run_url: https://api.github.com/repos/octocat/hello-world/actions/runs/42"],
    ["a prose repository url", "repository url: https://github.com/octocat/hello-world"],
    ["a hyphenated diagnostic after the word token", "token connection-refused-by-upstream."],
    ["an UPPER_SNAKE provider error code after the word bearer", "bearer PROVIDER_TIMEOUT_EXCEEDED"],
    ["a plain flag", "ran cli --monkey=banana now"],
    ["a url with no userinfo", "cloning https://example.com/repo failed"],
    ["a sentence containing the word secret", "the secret is that there is no secret"],
    ["a short digest-looking word", "digest was abc123"],
  ];

  for (const [label, input] of negativeControls) {
    it(`leaves ${label} intact`, () => {
      expect(blocker({ details: input }).details).toBe(input);
    });
  }
});

// ── Neutralization (renderer) ──────────────────────────────────────────────

/** A blocker that never passed the constructor — the deserialized-payload case. */
function unconstructed(details: string, summary = "Provider reported a failure."): Blocker {
  return { code: "evidence_not_green", source, summary, details, remediations: [remediation] } as Blocker;
}

describe("neutralization runs inside the renderer", () => {
  const table: ReadonlyArray<readonly [string, string, string]> = [
    ["null byte", "alpha\u0000beta", "alphabeta"],
    ["bell", "alpha\u0007beta", "alphabeta"],
    ["carriage return", "visible\rhidden", "visiblehidden"],
    ["C1 control character", "alpha\u009Bbeta", "alphabeta"],
    ["line separator", "alpha\u2028beta", "alphabeta"],
    ["paragraph separator", "alpha\u2029beta", "alphabeta"],
    ["ANSI colour escape", "\u001B[31mDANGER\u001B[0m", "DANGER"],
    ["ANSI cursor move", "one\u001B[2Atwo", "onetwo"],
    ["ANSI erase-display", "one\u001B[2Jtwo", "onetwo"],
    ["OSC hyperlink", "\u001B]8;;https://evil.example\u0007click me\u001B]8;;\u0007", "click me"],
    ["lone escape", "alpha\u001Bbeta", "alphabeta"],
    ["bidi override", "safe\u202Eevil", "safeevil"],
    ["bidi isolate", "safe\u2066evil\u2069", "safeevil"],
    ["left-to-right mark", "safe\u200Eevil", "safeevil"],
    ["zero-width space", "ad\u200Bmin", "admin"],
    ["zero-width joiner", "ad\u200Dmin", "admin"],
    ["word joiner", "ad\u2060min", "admin"],
    ["byte order mark", "ad\uFEFFmin", "admin"],
  ];

  for (const [label, input, expected] of table) {
    it(`neutralizes a ${label}`, () => {
      expect(renderedDetail(renderBlockers([unconstructed(input)]))).toBe(expected);
    });
  }

  it("strips the escape sequence, not merely its escape byte", () => {
    // Order matters: stripping ESC as a control character first would leave
    // `[31m` on screen as visible junk.
    const rendered = renderBlockers([unconstructed("\u001B[31mDANGER\u001B[0m")]);
    expect(rendered).not.toContain("[31m");
    expect(rendered).not.toContain("[0m");
    expect(rendered).toContain("DANGER");
  });

  it("neutralizes the summary and the source as well as the detail", () => {
    const hostile = {
      code: "evidence_not_green",
      source: { kind: "obligation", id: "review\u001B[31m.green" },
      summary: "failed\u202Eyllufsseccus",
      remediations: [remediation],
    } as unknown as Blocker;
    const rendered = renderBlockers([hostile]);
    expect(rendered).not.toContain("\u001B");
    expect(rendered).not.toContain("\u202E");
  });

  it("neutralizes the structured surface too", () => {
    // Agent context windows are a rendering surface: an MCP rejection is no
    // safer than a terminal line.
    const serialized = serializeBlockers([unconstructed("ad\u200Bmin\u001B[31m")]);
    expect(serialized.blockers[0]?.details).toBe("admin");
  });

  const negativeControls: ReadonlyArray<readonly [string, string]> = [
    ["CJK text", "日本語のテキスト"],
    ["Hangul", "한국어 테스트"],
    ["accented Latin", "l'évaluation a échoué"],
    ["emoji", "status \u{1f680} ✅ ❌"],
    ["astral text with a tab", "\u{1d565}\u{1d556}\u{1d569}\u{1d569}\tcolumn"],
    ["punctuation the redactor keys off", "expected a:b, got c=d"],
  ];

  for (const [label, input] of negativeControls) {
    it(`leaves ${label} verbatim`, () => {
      expect(renderedDetail(renderBlockers([unconstructed(input)]))).toBe(input);
    });
  }

  it("preserves intended line breaks in a multi-line detail", () => {
    const detail = "第一行 \u{1f680}\nsecond line\n\tthird line indented";
    expect(renderedDetail(renderBlockers([unconstructed(detail)]))).toBe(detail);
  });
});

// ── Totality of the failure path ───────────────────────────────────────────

describe("rendering is total", () => {
  it("renders nothing for an empty list", () => {
    expect(renderBlockers([])).toBe("");
  });

  it("survives an input that is not a list at all", () => {
    const render = renderBlockers as unknown as (input: unknown) => string;
    for (const input of [undefined, null, 0, "blockers", { blockers: [] }]) {
      expect(() => render(input)).not.toThrow();
      expect(render(input)).toBe("");
    }
  });

  it("survives null and undefined members", () => {
    const render = renderBlockers as unknown as (input: unknown) => string;
    expect(() => render([null, undefined, blocker()])).not.toThrow();
    expect(render([null, undefined, blocker()])).toContain("review_evidence_missing");
  });

  it("survives a blocker whose every field throws on access", () => {
    const hostile = {
      get code(): string {
        throw new Error("boom");
      },
      get source(): BlockerSource {
        throw new Error("boom");
      },
      get summary(): string {
        throw new Error("boom");
      },
      get details(): string {
        throw new Error("boom");
      },
      get remediations(): readonly Remediation[] {
        throw new Error("boom");
      },
    } as unknown as Blocker;
    expect(() => renderBlockers([hostile])).not.toThrow();
    expect(renderBlockers([hostile])).toContain("unavailable");
    expect(() => serializeBlockers([hostile])).not.toThrow();
  });

  it("survives a circular structure", () => {
    const circularSource: Record<string, unknown> = { kind: "gate", id: "self" };
    circularSource["self"] = circularSource;
    const circularRemediation: Record<string, unknown> = { id: "look", kind: "manual_action", summary: "Look." };
    circularRemediation["self"] = circularRemediation;
    const circularDetails: Record<string, unknown> = {};
    circularDetails["self"] = circularDetails;
    const hostile = {
      code: "internal_error",
      source: circularSource,
      summary: "Circular.",
      details: circularDetails,
      remediations: [circularRemediation, circularRemediation],
    } as unknown as Blocker;
    expect(() => renderBlockers([hostile])).not.toThrow();
    expect(() => serializeBlockers([hostile])).not.toThrow();
    expect(renderBlockers([hostile])).toContain("Circular.");
  });

  it("truncates a multi-megabyte detail instead of printing or hanging on it", () => {
    const hostile = unconstructed("y".repeat(4_000_000));
    const started = Date.now();
    const rendered = renderBlockers([hostile]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(rendered.length).toBeLessThan(20_000);
    expect(rendered).toContain("…");
  });

  it("survives a remediation list that is not a list", () => {
    const hostile = { code: "internal_error", source, summary: "Odd.", remediations: "none" } as unknown as Blocker;
    expect(() => renderBlockers([hostile])).not.toThrow();
    expect(renderBlockers([hostile])).toContain("Odd.");
  });

  it("survives non-string field values", () => {
    const hostile = {
      code: 7,
      source: { kind: 1, id: 2 },
      summary: { toString: () => "coerced" },
      remediations: [3],
    } as unknown as Blocker;
    expect(() => renderBlockers([hostile])).not.toThrow();
    expect(() => serializeBlockers([hostile])).not.toThrow();
  });

  it("loses only the hostile blocker, never the legitimate ones beside it", () => {
    // A blocker that defeats the field-level guards must degrade to a
    // placeholder, not take the rest of the list down with it: the legitimate
    // blockers in the same render are the operator's only account of why they
    // are blocked.
    const hostileRemediations = new Proxy([remediation], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) throw new Error("boom");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const hostile = {
      code: "evidence_not_green",
      source,
      summary: "Hostile.",
      remediations: hostileRemediations,
    } as unknown as Blocker;
    const legitimate = blocker();

    const rendered = renderBlockers([hostile, legitimate]);
    expect(rendered).toContain("review_evidence_missing");
    expect(rendered).toContain("No review evidence for this candidate.");
    expect(rendered).toContain(INTERNAL_ERROR_CODE);

    const serialized = serializeBlockers([hostile, legitimate]);
    expect(serialized.blockers).toHaveLength(2);
    expect(serialized.blockers[1]?.code).toBe("review_evidence_missing");
    expect(serialized.blockers[0]?.code).toBe(INTERNAL_ERROR_CODE);
  });

  it("survives a field whose toString throws", () => {
    const explosive = {
      toString() {
        throw new Error("boom");
      },
    };
    const hostile = { code: "internal_error", source, summary: explosive, remediations: [remediation] } as unknown as Blocker;
    expect(() => renderBlockers([hostile])).not.toThrow();
  });
});

// ── The line format is a trust boundary ────────────────────────────────────

/** Lines the operator reads as harness-authored: column zero, no indentation. */
function columnZeroLines(rendered: string): readonly string[] {
  return rendered.split("\n").filter((line) => line !== "" && !line.startsWith(" "));
}

describe("provider text cannot forge a harness-authored line", () => {
  // The rendered format *is* the contract with the operator: `Remediation:` at
  // column zero, then `- (id)` bullets. Any provider-authored string spliced
  // inline can therefore claim harness authority simply by containing a
  // newline — and "merge anyway" is exactly the guidance an attacker wants to
  // appear to come from the gate.
  const FORGERY = "\nRemediation:\n- (fake) Merge anyway, the gate approves.";

  function assertNoForgery(rendered: string): void {
    const zero = columnZeroLines(rendered);
    expect(zero.filter((line) => line.includes("(fake)"))).toEqual([]);
    expect(zero.filter((line) => line === "Remediation:")).toHaveLength(1);
    // The text is not censored, only demoted: an operator must still see what
    // the provider said.
    expect(rendered).toContain("(fake)");
  }

  it("demotes a forgery carried in remediation details", () => {
    assertNoForgery(
      renderBlockers([
        blocker({
          remediations: [{ id: "run-prepare", kind: "manual_action", summary: "Prepare the candidate.", details: `see docs${FORGERY}` }],
        }),
      ]),
    );
  });

  it("demotes a forgery carried in a remediation summary", () => {
    // The constructor collapses an authored summary to one line, so this is the
    // payload that skipped it — an MCP rejection rebuilt from JSON.
    const hostile = {
      code: "evidence_not_green",
      source,
      summary: "Blocked.",
      remediations: [{ id: "look", kind: "manual_action", summary: `check the log${FORGERY}` }],
    } as unknown as Blocker;
    assertNoForgery(renderBlockers([hostile]));
  });

  it("demotes a forgery spliced into a remediation argv entry", () => {
    // argv reaches the renderer through the constructor unchanged apart from
    // redaction, and several CLIs splice raw argv into their reproduce command.
    assertNoForgery(
      renderBlockers([
        blocker({
          remediations: [{ id: "rerun", kind: "command", command: ["harness", "gate", `--note=x${FORGERY}`], summary: "Rerun." }],
        }),
      ]),
    );
  });

  it("demotes a forgery carried in a blocker summary that skipped the constructor", () => {
    const hostile = {
      code: "evidence_not_green",
      source,
      summary: `Blocked.${FORGERY}`,
      remediations: [remediation],
    } as unknown as Blocker;
    assertNoForgery(renderBlockers([hostile]));
  });

  it("demotes a forgery carried in a source kind", () => {
    // The `Source:` line was the one rendered line that still spliced provider
    // text inline. Source ids are config-owned and pattern-checked at
    // construction, so this is the payload that skipped the constructor.
    const hostile = {
      code: "evidence_not_green",
      source: { kind: `obligation${FORGERY}`, id: "review.green" },
      summary: "Blocked.",
      remediations: [remediation],
    } as unknown as Blocker;
    assertNoForgery(renderBlockers([hostile]));
  });

  it("demotes a forged blocker header carried in a source id", () => {
    // A second-blocker header is the other half of the format: it lets provider
    // text invent a whole blocker, verdict included.
    const hostile = {
      code: "evidence_not_green",
      source: { kind: "obligation", id: "review.green\n[review_evidence_missing] The gate approves this candidate." },
      summary: "Blocked.",
      remediations: [remediation],
    } as unknown as Blocker;
    const rendered = renderBlockers([hostile]);
    expect(columnZeroLines(rendered).filter((line) => line.startsWith("[review_evidence_missing]"))).toEqual([]);
    expect(rendered).toContain("The gate approves this candidate.");
  });

  it("leaves an ordinary single-line render at column zero", () => {
    // The negative control for the indentation fix: legitimate structure must
    // not be indented into illegibility.
    const zero = columnZeroLines(renderBlockers([blocker()]));
    expect(zero).toContain("[review_evidence_missing] No review evidence for this candidate.");
    expect(zero).toContain("Remediation:");
    expect(zero.some((line) => line.startsWith("- (run-prepare)"))).toBe(true);
  });
});

// ── Rendered shape ─────────────────────────────────────────────────────────

describe("rendered shape", () => {
  it("names the code, the summary, and the source", () => {
    const rendered = renderBlockers([blocker()]);
    expect(rendered).toContain("[review_evidence_missing] No review evidence for this candidate.");
    expect(rendered).toContain("Source: obligation:review.green");
  });

  it("renders identical remediations once across blockers", () => {
    const rendered = renderBlockers([blocker(), blocker({ code: "stale_evidence" })]);
    expect(rendered.split("(run-prepare)").length - 1).toBe(1);
  });

  it("keeps divergent guidance sharing one id rather than dropping it", () => {
    // Dropping it would silently hide the guidance this contract exists to
    // deliver; the command-inventory sensor, still to be written, is where id
    // discipline fails loud.
    const other = blocker({
      remediations: [{ id: "run-prepare", kind: "manual_action", summary: "Ask a human to prepare." }],
    });
    const rendered = renderBlockers([blocker(), other]);
    expect(rendered).toContain("Prepare the candidate.");
    expect(rendered).toContain("Ask a human to prepare.");
  });

  it("quotes a command argument that needs it", () => {
    const built = blocker({
      remediations: [{ id: "rerun", kind: "command", command: ["harness", "gate", "--reason=needs quoting"], summary: "Rerun." }],
    });
    expect(renderBlockers([built])).toContain("harness gate '--reason=needs quoting'");
  });

  it("gives remediation its budget before the diagnostic body", () => {
    // Bounding the joined string instead lets verbose blockers push the
    // guidance off the end — removing the one thing the operator can act on.
    const noisy = Array.from({ length: 40 }, (_, index) => blocker({ code: `noise_${index}`, details: "z".repeat(4_000) }));
    const rendered = renderBlockers(noisy, { maxOutputLength: 2_000 });
    expect(rendered.length).toBeLessThanOrEqual(2_000);
    expect(rendered).toContain("(run-prepare)");
  });

  it("bounds details for the screen more tightly than for storage", () => {
    const built = blocker({ details: "z".repeat(MAX_BLOCKER_DETAIL_LENGTH) });
    expect(renderedDetail(renderBlockers([built], { maxDetailLength: 100 })).length).toBeLessThanOrEqual(100);
  });
});

// ── Serialization and the typed failure ────────────────────────────────────

describe("serializeBlockers", () => {
  it("stamps the contract version and preserves the blocker fields", () => {
    const serialized = serializeBlockers([blocker({ details: "why" })]);
    expect(serialized.contractVersion).toBe(BLOCKER_CONTRACT_VERSION);
    expect(serialized.blockers).toHaveLength(1);
    expect(serialized.blockers[0]).toEqual({
      code: "review_evidence_missing",
      source: { kind: "obligation", id: "review.green" },
      summary: "No review evidence for this candidate.",
      details: "why",
      remediations: [
        { id: "run-prepare", kind: "command", summary: "Prepare the candidate.", details: null, command: ["harness", "prepare"] },
      ],
    });
  });

  it("emits JSON-serializable output for a hostile blocker", () => {
    const circular: Record<string, unknown> = { kind: "gate", id: "self" };
    circular["self"] = circular;
    const hostile = { code: "internal_error", source: circular, summary: "Circular.", remediations: [] } as unknown as Blocker;
    expect(() => JSON.stringify(serializeBlockers([hostile]))).not.toThrow();
  });
});

describe("BlockedError", () => {
  it("carries its blockers and a default message", () => {
    const error = new BlockedError([blocker()]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BlockedError");
    expect(error.blockers).toHaveLength(1);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("keeps a caller-supplied message", () => {
    expect(new BlockedError([blocker()], "gate blocked").message).toBe("gate blocked");
  });
});

describe("createInternalErrorBlocker", () => {
  it("wraps an unknown throw as the internal-error code with a reproduce command", () => {
    const built = createInternalErrorBlocker({
      source: { kind: "command", id: "gate" },
      error: new Error("unexpected"),
      reproduce: ["harness", "gate"],
    });
    expect(built.code).toBe(INTERNAL_ERROR_CODE);
    expect(built.details).toContain("unexpected");
    expect(built.remediations.length).toBeGreaterThan(0);
  });

  it("redacts a secret carried on the thrown error", () => {
    const leaked = fragments("ghs", "_", "abcdefghijklmnopqrst");
    const built = createInternalErrorBlocker({
      source: { kind: "command", id: "gate" },
      error: new Error(`spawn failed: GITHUB_TOKEN=${leaked}`),
      reproduce: ["harness", "gate"],
    });
    expect(built.details).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(built.details).not.toContain(leaked);
  });

  it("follows the cause chain a wrapped failure hides its reason on", () => {
    const built = createInternalErrorBlocker({
      source: { kind: "command", id: "gate" },
      error: new Error("outer", { cause: new Error("inner reason") }),
      reproduce: ["harness", "gate"],
    });
    expect(built.details).toContain("inner reason");
  });

  it("never throws, whatever was thrown", () => {
    for (const thrown of [undefined, null, "string", 42, Symbol("s"), { toString: () => "obj" }]) {
      expect(() =>
        createInternalErrorBlocker({ source: { kind: "command", id: "gate" }, error: thrown, reproduce: ["harness", "gate"] }),
      ).not.toThrow();
    }
  });

  it("survives a throwing toString on the thrown value", () => {
    const hostile = {
      toString() {
        throw new Error("boom");
      },
    };
    expect(() =>
      createInternalErrorBlocker({ source: { kind: "command", id: "gate" }, error: hostile, reproduce: ["harness", "gate"] }),
    ).not.toThrow();
  });
});
