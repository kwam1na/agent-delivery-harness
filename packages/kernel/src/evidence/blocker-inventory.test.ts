/**
 * The blocker/remediation inventory — the audit surface for review loops.
 *
 * A review loop that blocks and unblocks repeatedly leaves nothing readable in
 * a state field; the inventory is where the loop becomes observable. Every
 * code the delivery journal can carry names a remediation, and each entry says
 * whether the delivery later left the suspended state it caused.
 *
 * Written RED before `blocker-inventory.ts` existed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DELIVERY_BLOCKER_REMEDIATIONS, composeBlockerInventory, remediationFor } from "./blocker-inventory.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const view = (kind: string, payload: Record<string, unknown>): { kind: string; payload: Record<string, unknown> } => ({
  kind,
  payload,
});

describe("composeBlockerInventory", () => {
  it("is empty for a journal that never blocked", () => {
    expect(composeBlockerInventory([view("transition.committed", { from: "accepted", to: "preparing" })])).toEqual([]);
  });

  it("names each blocker's remediation and reports whether the delivery left the suspended state", () => {
    const entries = composeBlockerInventory([
      view("transition.committed", { from: "accepted", to: "preparing" }),
      view("blocker.recorded", { code: "review.floor-unmet", summary: "the mandatory review floor is not met" }),
      view("transition.committed", { from: "preparing", to: "blocked" }),
      view("transition.committed", { from: "blocked", to: "preparing" }),
      view("blocker.recorded", { code: "admission.refused", summary: "the gate refused admission" }),
      view("transition.committed", { from: "preparing", to: "blocked" }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ code: "review.floor-unmet", resolved: true });
    expect(entries[0]?.remediation.length).toBeGreaterThan(0);
    expect(entries[1]).toMatchObject({ code: "admission.refused", resolved: false });
  });

  it("marks a typed escape that never suspended the delivery as resolved", () => {
    const entries = composeBlockerInventory([
      view("transition.committed", { from: "validating", to: "remediating" }),
      view("blocker.recorded", { code: "approval.proposal-voided", summary: "the proposal went stale" }),
    ]);
    expect(entries[0]).toMatchObject({ code: "approval.proposal-voided", resolved: true });
  });

  it("gives an unregistered code an honest fallback rather than an empty remediation", () => {
    expect(remediationFor("some.unregistered-code").length).toBeGreaterThan(0);
  });
});

describe("the inventory sensor", () => {
  it("covers every blocker code the managed-delivery facade can journal", () => {
    const source = readFileSync(path.join(HERE, "..", "facade", "managed-delivery.ts"), "utf8");
    // Every journaled blocker code reaches the journal through one of two call
    // shapes; both are matched here so a new code cannot land unremediated.
    const journaled = new Set<string>();
    for (const match of source.matchAll(/recordBlockerAndTransition\((?:[^;]*?)"([a-z][a-z.-]+)",/gs)) {
      journaled.add(match[1] as string);
    }
    for (const match of source.matchAll(/"blocker\.recorded",\s*\{\s*\n?\s*code:\s*"([a-z][a-z.-]+)"/g)) {
      journaled.add(match[1] as string);
    }
    // A code assembled from a stage status is invisible to a literal scan, so
    // the closed status vocabulary is expanded here rather than trusted.
    for (const match of source.matchAll(/code:\s*`([a-z][a-z.-]*)\$\{[^}]*result\.status[^}]*\}`/g)) {
      for (const status of ["blocked", "failed", "indeterminate"]) journaled.add(`${match[1] as string}${status}`);
    }
    expect(journaled.size).toBeGreaterThan(5);
    const uncovered = [...journaled].filter((code) => DELIVERY_BLOCKER_REMEDIATIONS[code] === undefined).sort();
    expect(uncovered, "these journaled blocker codes carry no declared remediation").toEqual([]);
  });

  it("registers no remediation for a code nothing can journal", () => {
    const source = readFileSync(path.join(HERE, "..", "facade", "managed-delivery.ts"), "utf8");
    const orphans = Object.keys(DELIVERY_BLOCKER_REMEDIATIONS)
      .filter((code) => !source.includes(`"${code}"`) && !code.startsWith("workflow.stage-"))
      .sort();
    expect(orphans, "these declared remediations name codes nothing journals").toEqual([]);
  });
});
