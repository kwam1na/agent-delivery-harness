/**
 * The rejection-code registry, checked against the specification it transcribes.
 *
 * A registry is only worth having if it is exhaustive, and "exhaustive" is a
 * claim about a document. So the claim is checked against the document: the
 * spec's Appendix D table is parsed out of the vendored spec and compared with
 * the registry in both directions. A code invented here, a code dropped from
 * here, and a rule mapped to the wrong code all fail.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MANIFEST_REJECTION_CODES,
  MANIFEST_REJECTION_REGISTRY,
  MANIFEST_RULE_IDS,
  META_RULE_IDS,
  RECORDER_EMITTED_CODES,
  VALIDATOR_EMITTED_CODES,
  isManifestRejectionCode,
  type ManifestRejectionCode,
  type ManifestRuleId,
} from "./codes.ts";

const SPEC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "docs", "spec", "delivery-evidence-1.md");

/** Appendix D as the spec writes it: rows of `code` (or `a` / `b`) against rule ids. */
function appendixD(): ReadonlyMap<string, readonly string[]> {
  const spec = readFileSync(SPEC_PATH, "utf8");
  const appendix = spec.slice(spec.indexOf("## D Appendix D"));
  const rows = appendix.split("\n").filter((line) => line.startsWith("|") && line.includes("`"));

  const table = new Map<string, readonly string[]>();
  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim());
    const codes = [...(cells[1] ?? "").matchAll(/`([a-z_]+)`/g)].map((match) => match[1] as string);
    const rules = [...(cells[2] ?? "").matchAll(/\b((?:GEN|ENV|SUB|RG)-\d+)\b/g)].map((match) => match[1] as string);
    if (codes.length === 0 || rules.length === 0) continue;
    for (const code of codes) table.set(code, rules);
  }
  return table;
}

describe("the rejection-code registry", () => {
  const table = appendixD();

  it("registers exactly the codes Appendix D defines", () => {
    expect([...table.keys()].sort()).toEqual([...MANIFEST_REJECTION_CODES].sort());
  });

  it("maps every code to rules the spec's own row names", () => {
    // A row may list several codes against several rules without saying which
    // goes with which, so the check is: each code's rules come from its row, and
    // the row's rules are exhausted by the codes on it.
    for (const [code, rowRules] of table) {
      const registered = MANIFEST_REJECTION_REGISTRY[code as ManifestRejectionCode].rules;
      for (const rule of registered) {
        expect(rowRules, code).toContain(rule);
      }
    }
    const covered = new Map<string, Set<string>>();
    for (const [code, rowRules] of table) {
      const key = rowRules.join(",");
      const set = covered.get(key) ?? new Set<string>();
      for (const rule of MANIFEST_REJECTION_REGISTRY[code as ManifestRejectionCode].rules) set.add(rule);
      covered.set(key, set);
    }
    for (const [key, set] of covered) {
      expect([...set].sort(), key).toEqual([...new Set(key.split(","))].sort());
    }
  });

  it("accounts for every rule in §8 and §9.3, and names the three that produce no code", () => {
    const ruled = new Set<ManifestRuleId>();
    for (const code of MANIFEST_REJECTION_CODES) {
      for (const rule of MANIFEST_REJECTION_REGISTRY[code].rules) ruled.add(rule);
    }
    const unruled = MANIFEST_RULE_IDS.filter((rule) => !ruled.has(rule));
    expect([...unruled].sort()).toEqual([...META_RULE_IDS].sort());
  });

  it("partitions the codes into what the validator reaches and what the recorder does", () => {
    expect([...VALIDATOR_EMITTED_CODES, ...RECORDER_EMITTED_CODES].sort()).toEqual([...MANIFEST_REJECTION_CODES].sort());
    for (const code of VALIDATOR_EMITTED_CODES) expect(RECORDER_EMITTED_CODES).not.toContain(code);
    expect([...RECORDER_EMITTED_CODES].sort()).toEqual([
      "artifact_digest_mismatch",
      "artifact_outside_run_root",
      "manifest_outside_run_root",
      "record_conflict",
    ]);
  });

  it("recognizes its own codes and nothing else", () => {
    for (const code of MANIFEST_REJECTION_CODES) expect(isManifestRejectionCode(code)).toBe(true);
    expect(isManifestRejectionCode("illegal_deferral_v2")).toBe(false);
    expect(isManifestRejectionCode("toString")).toBe(false);
    expect(isManifestRejectionCode(undefined)).toBe(false);
  });

  it("keeps its codes distinct from the gate's structural finding codes", () => {
    // Two vocabularies, deliberately disjoint: what a submission can be wrong
    // about, and what the evaluator can conclude about evidence it holds.
    expect(MANIFEST_REJECTION_CODES).not.toContain("stale_evidence");
    expect(MANIFEST_REJECTION_CODES).not.toContain("review_evidence_missing");
  });
});
