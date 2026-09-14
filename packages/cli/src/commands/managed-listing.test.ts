/**
 * `managed deliveries` — the installation-scoped listing mode of the status
 * surface, at the level a terminal reaches it.
 *
 * THE ONE CLAIM THIS FILE EXISTS FOR. The listing answers ABOVE delivery
 * resolution. Every other `managed` operation resolves exactly one delivery
 * and refuses when a repository has none or several in flight — and those two
 * situations are precisely what a listing is for. So the row that matters here
 * drives a repository with TWO deliveries in flight, where `managed status`
 * refuses, and asserts the listing names both anyway.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOURNAL_ENTRY_SPEC, compiledAdopterPolicyBindingDigest, createJournalStore } from "@agent-delivery-harness/kernel";
// The kernel's own disposable-repository baseline, reached by path: it is a
// test fixture and deliberately not part of the package's public surface, and
// the CLI's other suites reach into the kernel's source the same way.
import { disposablePolicyBinding } from "../../../kernel/src/facade/disposable-repository.fixture.ts";
import { managedCommand } from "./managed.ts";
import type { CommandContext, CommandResult } from "../boundary.ts";

const DIGEST = "a".repeat(64);
const DIGEST2 = "c".repeat(64);
const OID = "b".repeat(40);

let repoDir: string;

const run = async (args: readonly string[], rootDir: string): Promise<{ result: CommandResult; written: string }> => {
  let written = "";
  const context = {
    rootDir,
    config: {} as never,
    env: {} as never,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    args,
    wire: async () => ({}) as never,
    artifacts: {} as never,
    write: (text: string) => {
      written += text;
    },
    classifyContext: () => ({}) as never,
  } as unknown as CommandContext;
  return { result: await managedCommand.run(context), written };
};

const entry = (deliveryId: string, revision: number, kind: string, payload: Record<string, unknown>) => ({
  spec: JOURNAL_ENTRY_SPEC,
  journal: "delivery" as const,
  subjectId: deliveryId,
  expectedRevision: revision,
  idempotencyKey: `key-${revision}-${kind}`,
  kind,
  payload,
});

/** Registered, policy bound, generation pinned, and into `preparing`. */
const opening = (deliveryId: string) => [
  entry(deliveryId, 0, "delivery.registered", {
    contractDigest: DIGEST,
    intakeId: "intake-1",
    confirmationNonce: "nonce-1",
    activeCompositionProfile: "core",
    registeringInstallationId: "install-1",
  }),
  entry(deliveryId, 1, "policy.snapshot.bound", { policyDigest: DIGEST, repositoryAuthorityEpoch: 4 }),
  entry(deliveryId, 2, "generation.pinned", { generationDigest: DIGEST2, releaseId: "core-v1", profile: "core" }),
  entry(deliveryId, 3, "transition.committed", { from: "accepted", to: "preparing" }),
];

const scratchRoots: string[] = [];

/**
 * A repository carrying the product namespace pointer and the retained binding
 * and NOTHING else — no deliveries directory at all. `digestOverride` writes a
 * pointer that disagrees with the binding it sits beside, which is the drift
 * the surface refuses on.
 */
function bareInstallation(digestOverride?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "managed-listing-bare-"));
  scratchRoots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  const namespace = path.join(root, ".git", "managed-delivery");
  mkdirSync(namespace, { recursive: true });
  const binding = disposablePolicyBinding();
  writeFileSync(path.join(namespace, "policy-binding.json"), `${JSON.stringify(binding)}\n`);
  writeFileSync(
    path.join(namespace, "facade.json"),
    `${JSON.stringify({
      installationPath: path.join(root, "installation"),
      receiptDir: path.join(root, "receipts"),
      hostVersion: "managed-listing-test",
      policyBindingDigest: digestOverride ?? compiledAdopterPolicyBindingDigest(binding),
    })}\n`,
  );
  return root;
}

beforeAll(async () => {
  repoDir = mkdtempSync(path.join(tmpdir(), "managed-listing-"));
  execFileSync("git", ["init", "--quiet", repoDir]);
  const namespace = path.join(repoDir, ".git", "managed-delivery");
  mkdirSync(namespace, { recursive: true });

  // The product namespace pointer and the retained binding, exactly as
  // registration leaves them: the CLI refuses on drift between the two, so a
  // pointer written with the binding's own digest is the honest fixture.
  const binding = disposablePolicyBinding();
  writeFileSync(path.join(namespace, "policy-binding.json"), `${JSON.stringify(binding)}\n`);
  writeFileSync(
    path.join(namespace, "facade.json"),
    `${JSON.stringify({
      installationPath: path.join(repoDir, "installation"),
      receiptDir: path.join(repoDir, "receipts"),
      hostVersion: "managed-listing-test",
      policyBindingDigest: compiledAdopterPolicyBindingDigest(binding),
    })}\n`,
  );

  // TWO deliveries, both in flight. This is the shape `managed status`
  // refuses, and the shape the listing exists to report.
  for (const deliveryId of ["delivery-one", "delivery-two"]) {
    const dir = path.join(namespace, "deliveries", deliveryId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "delivery.json"), `${JSON.stringify({ intakeId: "intake-1", policyBindingDigest: DIGEST })}\n`);
    const store = createJournalStore(path.join(dir, "journal.jsonl"));
    for (const candidate of opening(deliveryId)) {
      const appended = await store.append(candidate);
      expect(appended.ok, JSON.stringify(appended)).toBe(true);
    }
  }
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
  // Only the directories this file itself created, by the paths it recorded.
  for (const root of scratchRoots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("managed deliveries", () => {
  it("is advertised among the operations the surface names", async () => {
    const { result } = await run([], repoDir);
    expect(result.kind).toBe("usage");
    expect((result as { kind: "usage"; message: string }).message).toContain("deliveries");
  });

  it("lists every in-flight delivery in the very shape `status` refuses to resolve", async () => {
    // The refusal first, so the listing's success is not mistaken for the
    // repository simply being easy to resolve.
    const status = await run(["status"], repoDir);
    expect(status.result.kind).toBe("blocked");
    expect(status.result.kind === "blocked" ? status.result.blockers.map((blocker) => blocker.code) : []).toContain(
      "delivery_unresolved",
    );

    const { result, written } = await run(["deliveries"], repoDir);
    expect(result.kind, JSON.stringify(result)).toBe("ok");
    const listed = JSON.parse(written) as {
      deliveryId: string;
      state: string;
      lastActivity: { activity: string; observedAt: string | undefined };
      pendingDecision: unknown;
    }[];
    expect(listed.map((candidate) => candidate.deliveryId)).toEqual(["delivery-one", "delivery-two"]);
    for (const candidate of listed) {
      expect(candidate.state).toBe("preparing");
      // No workspace is bound yet, so there is no heartbeat to age and the
      // graded answer is a disappearance rather than a claim of life.
      expect(candidate.lastActivity).toEqual({ activity: "unknown", observedAt: undefined });
      expect(candidate.pendingDecision).toBeUndefined();
    }
    // No member beyond the four the contract defines survives to the terminal.
    // The exact set is pinned on the kernel object in the facade's own suite —
    // a member whose value is `undefined` does not survive JSON at all, so
    // this surface can only prove that nothing STRANGE was rendered, which is
    // the half that matters here.
    for (const candidate of listed) {
      expect(Object.keys(candidate).sort()).toEqual(["deliveryId", "lastActivity", "state"]);
    }
  });

  it("reaches the terminal with an empty listing when the installation has registered nothing", async () => {
    // The empty listing is the answer the facade's own suite pins; this row
    // pins that it SURVIVES the CLI — that the surface answers `ok` and writes
    // `[]` instead of refusing, which is what an installation-wide surface
    // unavailable exactly when the installation is quiet would do.
    const { result, written } = await run(["deliveries"], bareInstallation());
    expect(result.kind, JSON.stringify(result)).toBe("ok");
    expect(JSON.parse(written)).toEqual([]);
    expect((result as { kind: "ok"; summary: string }).summary).toContain("0 delivery(ies)");
  });

  it("refuses on binding drift, exactly like every other operation on this surface", async () => {
    // The listing answers ABOVE delivery resolution, so it is the one
    // operation that could have been moved above the installation checks too.
    // It was not: a pointer that disagrees with the binding beside it is the
    // installation being untrustworthy, and a listing is not an exemption.
    const { result } = await run(["deliveries"], bareInstallation("d".repeat(64)));
    expect(result.kind, JSON.stringify(result)).toBe("blocked");
    expect(result.kind === "blocked" ? result.blockers.map((blocker) => blocker.code) : []).toContain("policy_binding_mismatch");
  });

  it("names no delivery and binds no fence: it is refused outside a repository, like every read here", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "managed-listing-outside-"));
    try {
      const { result } = await run(["deliveries"], outside);
      expect(result.kind).toBe("blocked");
      expect(result.kind === "blocked" ? result.blockers.map((blocker) => blocker.code) : []).toContain("not_a_repository");
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
