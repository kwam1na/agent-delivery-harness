/**
 * RFC 8785 (JCS) conformance suite for the repo's only canonicalizer.
 *
 * Written before `canonical.ts` existed (V26-1331, test-first per the U2
 * execution note): the vectors below are transcribed from RFC 8785 itself —
 * its property-sorting example, its escaping example, and its number
 * serialization table — and every expectation is a *literal* expected string.
 * Nothing here round-trips the implementation against itself, because a
 * canonicalizer checked against its own output cannot fail.
 *
 * Transcription note: RFC 8785 §3.2.2.3 delegates number serialization to the
 * ECMAScript `Number::toString` algorithm (shortest round-tripping decimal).
 * Two rows of the transcribed table in the `333333333.33333…` cluster are
 * carried here at the value the normative algorithm produces; the RFC's table
 * is a rendering of that algorithm, so the algorithm is the authority when a
 * transcription and it disagree.
 */
import { describe, expect, it } from "vitest";
import {
  CanonicalizationError,
  canonicalBytes,
  canonicalize,
  compareUtf16CodeUnits,
} from "./canonical.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Reconstructs an IEEE-754 double from the RFC's 16-hex-digit bit pattern. */
const fromBits = (bits: string): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, Number.parseInt(bits.slice(0, 8), 16));
  view.setUint32(4, Number.parseInt(bits.slice(8), 16));
  return view.getFloat64(0);
};

/**
 * A code-*point* comparator — the wrong ordering. Used only to prove the
 * astral vectors are falsifying: swapping the canonicalizer's UTF-16
 * code-unit sort for this one reorders keys and changes the output bytes.
 * (`String.prototype.localeCompare` is wrong for a second reason — it is
 * collation- and ICU-build-dependent — so it is not even deterministic
 * enough to assert against.)
 */
const compareCodePoints = (a: string, b: string): number => {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const l = left[i]?.codePointAt(0) ?? 0;
    const r = right[i]?.codePointAt(0) ?? 0;
    if (l !== r) return l - r;
  }
  return left.length - right.length;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ── RFC 8785: sorting of object properties ─────────────────────────────────

describe("RFC 8785 — sorting of object properties", () => {
  /** The RFC's unicode property-name example, verbatim. */
  const RFC_UNICODE_INPUT = {
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\u000a": "Newline",
    "1": "One",
    "\u0080": "Control\u007f",
    "\ud83d\ude02": "Smiley",
    "\u00f6": "Latin Small Letter O With Diaeresis",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "</script>": "Browser Challenge",
  };

  /**
   * Literal expected bytes. Note what is escaped and what is not: U+000A and
   * U+000D are C0 controls with short escapes; U+0080 and U+007F are emitted
   * raw (only U+0000–U+001F, `"` and `\` are escaped); the astral key is
   * emitted as its literal surrogate pair.
   */
  const RFC_UNICODE_EXPECTED =
    '{"\\n":"Newline",' +
    '"\\r":"Carriage Return",' +
    '"1":"One",' +
    '"</script>":"Browser Challenge",' +
    '"\u0080":"Control\u007f",' +
    '"\u00f6":"Latin Small Letter O With Diaeresis",' +
    '"\u20ac":"Euro Sign",' +
    '"\ud83d\ude02":"Smiley",' +
    '"\ufb33":"Hebrew Letter Dalet With Dagesh"}';

  it("canonicalizes the RFC unicode key example byte-identically", () => {
    expect(canonicalize(RFC_UNICODE_INPUT)).toBe(RFC_UNICODE_EXPECTED);
  });

  it("orders keys by UTF-16 code unit, so the astral key precedes U+FB33", () => {
    // U+1F602 is the surrogate pair D83D DE02; its first code unit (0xD83D)
    // is below U+FB33 (0xFB33), so the smiley sorts first — even though its
    // code point (0x1F602) is far above U+FB33's.
    const smiley = RFC_UNICODE_EXPECTED.indexOf('"\ud83d\ude02"');
    const dalet = RFC_UNICODE_EXPECTED.indexOf('"\ufb33"');
    expect(smiley).toBeGreaterThan(-1);
    expect(dalet).toBeGreaterThan(-1);
    expect(smiley).toBeLessThan(dalet);
    expect(compareUtf16CodeUnits("\ud83d\ude02", "\ufb33")).toBeLessThan(0);
  });

  it("FALSIFICATION: a code-point sort reorders the astral key and breaks the expected bytes", () => {
    const keys = Object.keys(RFC_UNICODE_INPUT);
    const byCodeUnit = [...keys].sort(compareUtf16CodeUnits);
    const byCodePoint = [...keys].sort(compareCodePoints);
    expect(byCodePoint).not.toEqual(byCodeUnit);
    // Specifically: code-point order puts U+FB33 before the smiley, which is
    // the opposite of the order pinned in RFC_UNICODE_EXPECTED above.
    expect(compareCodePoints("\ud83d\ude02", "\ufb33")).toBeGreaterThan(0);
  });

  it("pins the astral-vs-fullwidth case: U+1F600 sorts before U+FF21", () => {
    // Code-unit order: 0xD83D < 0xFF21 → the emoji first.
    // Code-point order: 0x1F600 > 0xFF21 → would put "Ａ" first. The literal
    // expected bytes below are only producible by the code-unit sort.
    expect(canonicalize({ "\uff21": "fullwidth", "\ud83d\ude00": "astral" })).toBe(
      '{"\ud83d\ude00":"astral","\uff21":"fullwidth"}',
    );
    expect(compareUtf16CodeUnits("\ud83d\ude00", "\uff21")).toBeLessThan(0);
    expect(compareCodePoints("\ud83d\ude00", "\uff21")).toBeGreaterThan(0);
  });

  it("sorts by code unit, not by length or insertion order", () => {
    expect(canonicalize({ b: 1, a: 2, "": 3, A: 4, aa: 5 })).toBe(
      '{"":3,"A":4,"a":2,"aa":5,"b":1}',
    );
  });
});

// ── RFC 8785: the worked example ───────────────────────────────────────────

describe("RFC 8785 — worked examples", () => {
  it("canonicalizes the RFC's mixed literals/numbers/string example", () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: "\u20ac$\u000f\u000aA'\u0042\u0022\u005c\\\"\u002f",
      literals: [null, true, false],
    };
    // Literal expected bytes. The string member's source escapes decode to
    // the twelve characters EURO $ U+000F LF A ' B " \ \ " / — re-emitted
    // as a six-character \u000f escape, then \n, then A'B, then the pairs
    // \" \\ \\ \", with the solidus left bare.
    expect(canonicalize(input)).toBe(
      "{\"literals\":[null,true,false]," +
        "\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27]," +
        "\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}",
    );
  });

  it("canonicalizes the RFC's transaction example", () => {
    const input = {
      from_account: "543 232 625-3",
      to_account: "58 555 0100",
      amount: 500,
      currency: "USD",
    };
    expect(canonicalize(input)).toBe(
      '{"amount":500,"currency":"USD","from_account":"543 232 625-3","to_account":"58 555 0100"}',
    );
  });
});

// ── RFC 8785: string escaping ──────────────────────────────────────────────

describe("RFC 8785 — string serialization", () => {
  it("uses the short escapes for the RFC's escape table", () => {
    expect(canonicalize("\u0008\u0009\u000a\u000c\u000d\u0022\u005c")).toBe(
      '"\\b\\t\\n\\f\\r\\"\\\\"',
    );
  });

  it("escapes remaining C0 controls as lowercase \\u00xx and leaves U+007F raw", () => {
    expect(canonicalize("\u0000\u001f\u007f")).toBe('"\\u0000\\u001f\u007f"');
  });

  it("does not escape the solidus", () => {
    expect(canonicalize("a/b")).toBe('"a/b"');
  });

  it("emits non-ASCII as literal UTF-8, not \\u escapes", () => {
    expect(canonicalBytes("\u20ac")).toEqual(utf8('"\u20ac"'));
  });

  it("escapes unpaired surrogates (well-formed output)", () => {
    expect(canonicalize("\ud800")).toBe('"\\ud800"');
    expect(canonicalize("\udfff")).toBe('"\\udfff"');
  });
});

// ── RFC 8785: number serialization ─────────────────────────────────────────

describe("RFC 8785 — number serialization", () => {
  /** The RFC's ES6-internal → JSON-representation table. */
  const NUMBER_TABLE: ReadonlyArray<readonly [string, string]> = [
    ["0000000000000000", "0"],
    ["8000000000000000", "0"], // negative zero
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
  ];

  it.each(NUMBER_TABLE)("serializes %s as %s", (bits, expected) => {
    expect(canonicalize(fromBits(bits))).toBe(expected);
  });

  it("serializes negative zero as 0", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize({ a: -0, b: 0 })).toBe('{"a":0,"b":0}');
  });

  it("serializes MAX_SAFE_INTEGER and its neighbours exactly", () => {
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(canonicalize(Number.MAX_SAFE_INTEGER - 1)).toBe("9007199254740990");
    expect(canonicalize(Number.MAX_SAFE_INTEGER + 1)).toBe("9007199254740992");
    expect(canonicalize(-Number.MAX_SAFE_INTEGER)).toBe("-9007199254740991");
  });

  it("switches to exponent form exactly where ECMAScript does", () => {
    expect(canonicalize(1e20)).toBe("100000000000000000000");
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(1e-6)).toBe("0.000001");
    expect(canonicalize(1e-7)).toBe("1e-7");
  });

  it("normalizes trailing-zero and integral-float spellings", () => {
    expect(canonicalize(4.5)).toBe("4.5");
    expect(canonicalize(10.0)).toBe("10");
    expect(canonicalize(0.002)).toBe("0.002");
  });
});

// ── Structures ─────────────────────────────────────────────────────────────

describe("structures", () => {
  it("emits empty objects and arrays without whitespace", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
    expect(canonicalize({ a: {}, b: [] })).toBe('{"a":{},"b":[]}');
  });

  it("preserves array order and sorts only object members", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([{ b: 1, a: 2 }, [{ z: [] }]])).toBe('[{"a":2,"b":1},[{"z":[]}]]');
  });

  it("sorts nested objects at every depth", () => {
    expect(canonicalize({ z: { y: 1, x: { b: 2, a: 3 } }, a: 4 })).toBe(
      '{"a":4,"z":{"x":{"a":3,"b":2},"y":1}}',
    );
  });

  it("canonicalizes bare literals", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize("")).toBe('""');
  });

  it("emits UTF-8 bytes with no BOM", () => {
    expect(canonicalBytes({ "\u20ac": 1 })).toEqual(
      new Uint8Array([0x7b, 0x22, 0xe2, 0x82, 0xac, 0x22, 0x3a, 0x31, 0x7d]),
    );
  });

  it("is insensitive to member insertion order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("does not mutate its input", () => {
    const input = { b: 1, a: 2 };
    canonicalize(input);
    expect(Object.keys(input)).toEqual(["b", "a"]);
  });

  it("accepts a value shared at two positions (a DAG is not a cycle)", () => {
    const shared = { a: 1 };
    expect(canonicalize({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });
});

// ── Error paths ────────────────────────────────────────────────────────────

describe("non-JSON-representable input", () => {
  const rejects = (value: unknown, code: string, path: string): void => {
    let thrown: unknown;
    try {
      canonicalize(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CanonicalizationError);
    const error = thrown as CanonicalizationError;
    expect(error.code).toBe(code);
    expect(error.path).toBe(path);
  };

  it("rejects non-finite numbers rather than emitting null", () => {
    rejects(Number.NaN, "non_finite_number", "");
    rejects(Number.POSITIVE_INFINITY, "non_finite_number", "");
    rejects(Number.NEGATIVE_INFINITY, "non_finite_number", "");
    rejects({ claims: [{ cost: Number.NaN }] }, "non_finite_number", "/claims/0/cost");
  });

  it("rejects undefined rather than dropping the member", () => {
    rejects(undefined, "unsupported_value", "");
    rejects({ a: undefined }, "unsupported_value", "/a");
    rejects([undefined], "unsupported_value", "/0");
  });

  it("rejects functions, symbols, and bigints", () => {
    rejects(() => 1, "unsupported_value", "");
    rejects(Symbol("s"), "unsupported_value", "");
    rejects(10n, "unsupported_value", "");
    rejects({ a: 10n }, "unsupported_value", "/a");
  });

  it("rejects non-plain objects rather than silently emitting {}", () => {
    rejects(new Date(0), "unsupported_value", "");
    rejects(new Map(), "unsupported_value", "");
    rejects(new Set(), "unsupported_value", "");
    rejects({ a: new Date(0) }, "unsupported_value", "/a");
  });

  it("rejects symbol-keyed members rather than dropping them", () => {
    rejects({ a: 1, [Symbol("s")]: 2 }, "symbol_key", "");
  });

  it("rejects circular references", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    rejects(cyclic, "circular_reference", "/self");

    const arm: Record<string, unknown> = {};
    const list: unknown[] = [arm];
    arm["back"] = list;
    rejects({ root: list }, "circular_reference", "/root/0/back");
  });

  it("escapes the JSON-pointer path segments it reports", () => {
    let thrown: unknown;
    try {
      canonicalize({ "a/b~c": Number.NaN });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as CanonicalizationError).path).toBe("/a~1b~0c");
  });

  it("carries a stable error name so failures are recognisable across realms", () => {
    let thrown: unknown;
    try {
      canonicalize(undefined);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).name).toBe("CanonicalizationError");
    expect(thrown).toBeInstanceOf(Error);
  });
});

// ── The comparator itself ──────────────────────────────────────────────────

describe("compareUtf16CodeUnits", () => {
  it("is a total order consistent with the ECMAScript relational operator", () => {
    const samples = ["", "a", "A", "aa", "b", "\u0080", "\u20ac", "\ud83d\ude00", "\uff21", "\ufb33"];
    for (const left of samples) {
      for (const right of samples) {
        const sign = Math.sign(compareUtf16CodeUnits(left, right));
        const expected = left < right ? -1 : left > right ? 1 : 0;
        expect(sign).toBe(expected);
      }
    }
  });

  it("returns 0 only for identical strings", () => {
    expect(compareUtf16CodeUnits("abc", "abc")).toBe(0);
    expect(compareUtf16CodeUnits("abc", "abd")).not.toBe(0);
  });
});
