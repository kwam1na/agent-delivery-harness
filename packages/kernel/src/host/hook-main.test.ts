/**
 * The model-external hook decisions: deny-until-attested from inside the
 * host's PreToolUse surface. The hook consumes the binding's state file and
 * the frozen admission decisions — a missing, unreadable, or stale state
 * denies everything, and no output the model produces can widen that.
 *
 * Written RED before `hook-main.ts` existed.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../digest.ts";
import {
  decideHookInvocation,
  exactWorkflowSourceRead,
  renderHookDecision,
  type HookBindingState,
} from "./hook-main.ts";

const grant = {
  spec: "execution-grant/1",
  profile: "checkpoint",
  allowedCapabilities: ["Bash", "Write", "Read", "Grep"],
  writablePaths: ["src", "tests", "tools"],
  protectedPaths: [".git", ".managed-projection"],
  forbiddenOperations: [],
};

const expectation = {
  profile: "checkpoint",
  hostVersion: "2.1.97",
  productTrustRevocationEpoch: 0,
  observedAt: "2026-08-30T12:00:00Z",
  deliveryId: "dlv-hook",
  invocationFence: 1,
  workspaceId: "ws-hook",
  projectionDigest: "a".repeat(64),
  discoveryConfigurationDigest: "b".repeat(64),
  registeringInstallationId: "install-1",
  activeProfile: "confirmation-fixture",
} as const;

const attestation = {
  spec: "grant-attestation/1",
  profile: "checkpoint",
  hostVersion: "2.1.97",
  grantDigest: digestCanonical(grant),
  productTrustRevocationEpoch: 0,
  expiry: "2026-08-30T13:00:00Z",
  intakeDraftId: "absent-by-state",
  deliveryId: "dlv-hook",
  invocationFence: 1,
  workspaceId: "ws-hook",
  projectionDigest: "a".repeat(64),
  discoveryConfigurationDigest: "b".repeat(64),
  registeringInstallationId: "install-1",
  activeProfile: "confirmation-fixture",
};

/** The fence this fixture session was admitted under — the expectation's own. */
const SESSION_FENCE = expectation.invocationFence;

const state: HookBindingState = {
  expectation,
  grant,
  attestation,
  workspaceRoot: "/work/tree",
  observationPath: "/ns/observation.json",
};

describe("decideHookInvocation", () => {
  it("allows a granted capability writing inside the grant", () => {
    const decision = decideHookInvocation(state, {
      tool_name: "Write",
      tool_input: { file_path: "/work/tree/src/greet.mjs" },
    }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(true);
  });

  it("denies an empty Write file_path with unnormalized_path", () => {
    const decision = decideHookInvocation(
      state,
      { tool_name: "Write", tool_input: { file_path: "" } },
      "2026-08-30T12:01:00Z",
      SESSION_FENCE,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason.split(":", 1)).toEqual(["unnormalized_path"]);
  });

  it("denies a non-string Write file_path with unnormalized_path", () => {
    const decision = decideHookInvocation(
      state,
      { tool_name: "Write", tool_input: { file_path: 7 } },
      "2026-08-30T12:01:00Z",
      SESSION_FENCE,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason.split(":", 1)).toEqual(["unnormalized_path"]);
  });

  it("allows a Write invocation whose file_path member is absent", () => {
    expect(
      decideHookInvocation(state, { tool_name: "Write", tool_input: {} }, "2026-08-30T12:01:00Z", SESSION_FENCE).allowed,
    ).toBe(true);
  });

  it("leaves granted no-write tools unchanged", () => {
    for (const input of [
      { tool_name: "Read", tool_input: { file_path: "" } },
      { tool_name: "Grep", tool_input: { path: "" } },
      { tool_name: "Bash", tool_input: { command: "true" } },
    ]) {
      expect(decideHookInvocation(state, input, "2026-08-30T12:01:00Z", SESSION_FENCE).allowed, input.tool_name).toBe(true);
    }
  });

  it("denies a write under a protected authority path", () => {
    const decision = decideHookInvocation(state, {
      tool_name: "Write",
      tool_input: { file_path: "/work/tree/.managed-projection/consumption.json" },
    }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });

  it("denies a write outside the workspace entirely", () => {
    const decision = decideHookInvocation(state, {
      tool_name: "Write",
      tool_input: { file_path: "/etc/passwd" },
    }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });

  it("denies a capability outside the attested grant", () => {
    const decision = decideHookInvocation(state, { tool_name: "WebFetch", tool_input: {} }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });

  it("denies a confirmation-class operation even though the model can name it", () => {
    const decision = decideHookInvocation(
      state,
      { tool_name: "operator-confirmation.takeover-authorization", tool_input: {} },
      "2026-08-30T12:01:00Z",
      SESSION_FENCE,
    );
    expect(decision.allowed).toBe(false);
  });

  it("denies everything when no binding state exists — deny-until-attested", () => {
    const decision = decideHookInvocation(undefined, { tool_name: "Read", tool_input: {} }, "2026-08-30T12:01:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });

  it("re-denies once the attestation expires at the observation instant", () => {
    const decision = decideHookInvocation(state, { tool_name: "Read", tool_input: {} }, "2026-08-30T13:00:00Z", SESSION_FENCE);
    expect(decision.allowed).toBe(false);
  });
});

describe("write-path canonicalization", () => {
  const decideWrite = (workspaceRoot: string, filePath: string) =>
    decideHookInvocation(
      { ...state, workspaceRoot },
      { tool_name: "Write", tool_input: { file_path: filePath } },
      "2026-08-30T12:01:00Z",
      SESSION_FENCE,
    );

  /**
   * The real shape, not a stand-in: an actual directory plus an actual symlink
   * to it, anchored at the ALREADY-RESOLVED temp root so the symlink created
   * here is the sole indirection. Relying on the platform's own `/var` link
   * would make these assertions pass on macOS and prove nothing on Linux CI.
   *
   * `src/existing.ts` exists and `src/new.ts` does not, because a write's
   * target usually does not exist yet — that is the case a resolve-the-value
   * fix silently fails to cover.
   */
  const withSymlinkedWorkspace = (body: (real: string, link: string) => void): void => {
    const real = mkdtempSync(path.join(realpathSync(tmpdir()), "write-canon-"));
    const link = `${real}-link`;
    mkdirSync(path.join(real, "src"), { recursive: true });
    writeFileSync(path.join(real, "src", "existing.ts"), "//\n");
    symlinkSync(real, link);
    try {
      body(real, link);
    } finally {
      unlinkSync(link);
      rmSync(real, { recursive: true, force: true });
    }
  };

  it("allows a legitimate workspace write in every root and argument path form", () => {
    // THE PROPERTY, ENUMERATED RATHER THAN SAMPLED: for both spellings of the
    // workspace root, and for every path form the host may send the argument
    // in, and whether or not the target file exists yet, a write inside the
    // grant is allowed. The cross-product is built here and every member is
    // asserted, so narrowing the matrix fails this test rather than quietly
    // shrinking what "every form" means. The pairing count is pinned for the
    // same reason.
    withSymlinkedWorkspace((real, link) => {
      const denied: string[] = [];
      const pairings: string[] = [];
      for (const [rootName, root] of [
        ["resolved", real],
        ["symlinked", link],
      ] as const) {
        for (const [argName, argRoot] of [
          ["resolved-absolute", real],
          ["root-form-absolute", link],
          ["relative", ""],
        ] as const) {
          for (const leaf of ["existing.ts", "new.ts"]) {
            const argument = argRoot === "" ? path.join("src", leaf) : path.join(argRoot, "src", leaf);
            const label = `root=${rootName} arg=${argName} leaf=${leaf}`;
            pairings.push(label);
            if (!decideWrite(root, argument).allowed) denied.push(label);
          }
        }
      }
      expect(pairings).toHaveLength(12);
      expect(denied).toEqual([]);
    });
  });

  it("allows a write the host names by its resolved path under a symlinked workspace root", () => {
    // Leaving the ROOT unwalked fails HERE: the argument is already resolved,
    // so walking only the value changes nothing and the as-written root still
    // escapes with '..'. This is the exact shape that made the authenticated
    // lane's `allow-after-attestation` leg flip between runs.
    withSymlinkedWorkspace((real, link) => {
      expect(decideWrite(link, path.join(real, "src", "new.ts")).allowed).toBe(true);
      expect(decideWrite(link, path.join(real, "src", "existing.ts")).allowed).toBe(true);
    });
  });

  it("allows a write named through the symlinked root under a resolved workspace root", () => {
    // Leaving the VALUE unwalked fails HERE, and it is the converse direction
    // on purpose: the root is already resolved, so walking the root alone
    // leaves the unresolved argument escaping with '..'. Together with the
    // test above, neither operand can be left unwalked without a named
    // failure.
    withSymlinkedWorkspace((real, link) => {
      expect(decideWrite(real, path.join(link, "src", "new.ts")).allowed).toBe(true);
      expect(decideWrite(real, path.join(link, "src", "existing.ts")).allowed).toBe(true);
    });
  });

  it("denies a write outside the workspace, including through a symlink pointing out", () => {
    // THE PIN AGAINST THE INVERSE FAILURE. Canonicalization exists to stop
    // legitimate writes being read as traversals; it must not start reading
    // traversals as legitimate. A symlink inside the workspace pointing out is
    // the case a purely lexical check never saw at all — it spells as an
    // ordinary in-grant path — so closing it tightens the boundary. The claim
    // here is bounded to the argument forms actually listed; the traversal
    // that applies '..' AFTER such a symlink is a different mechanism and is
    // pinned separately below rather than assumed to follow from these.
    withSymlinkedWorkspace((real, link) => {
      const outside = mkdtempSync(path.join(realpathSync(tmpdir()), "write-canon-outside-"));
      symlinkSync(outside, path.join(real, "src", "out"));
      try {
        for (const root of [real, link]) {
          expect(decideWrite(root, path.join(outside, "captured.ts")).allowed).toBe(false);
          expect(decideWrite(root, `${root}${path.sep}..${path.sep}captured.ts`).allowed).toBe(false);
          expect(decideWrite(root, path.join(root, "src", "out", "captured.ts")).allowed).toBe(false);
          expect(decideWrite(root, path.join("src", "out", "captured.ts")).allowed).toBe(false);
          expect(decideWrite(root, path.join("..", "captured.ts")).allowed).toBe(false);
        }
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("denies a traversal that leaves the workspace through a symlink before the '..' applies", () => {
    // ORDER OF RESOLUTION, which a lexical normalization gets backwards. The
    // kernel resolves `src/out` FIRST and applies `..` to wherever it landed —
    // outside — while `path.resolve` collapses `src/out/..` to `src` before
    // consulting the filesystem and calls the write in-grant. Both spellings
    // are asserted DENIED, not merely "not allowed by some other rule": the
    // string is built so that every other check would pass it.
    withSymlinkedWorkspace((real, link) => {
      const outside = mkdtempSync(path.join(realpathSync(tmpdir()), "write-canon-order-"));
      mkdirSync(path.join(outside, "deep"), { recursive: true });
      symlinkSync(path.join(outside, "deep"), path.join(real, "src", "out"));
      try {
        for (const root of [real, link]) {
          expect(decideWrite(root, "src/out/../captured.ts").allowed).toBe(false);
          expect(decideWrite(root, `${path.join(root, "src", "out")}/../captured.ts`).allowed).toBe(false);
          expect(decideWrite(root, "src/out/../../captured.ts").allowed).toBe(false);
        }
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("denies a write that reaches a protected path through a symlink on its chain", () => {
    // PROTECTION IS A PROPERTY OF THE PATH WALKED. Resolving is what admits a
    // legitimate write, but a resolver that reports only where a path ENDS
    // cannot see a protected subtree the walk went THROUGH: a link to `.git`
    // or `.managed-projection` lands somewhere writable, and the endpoint is
    // all that is left. Symlinks are tracked content, so a committed one arms
    // this. Every case below resolves to a genuinely writable destination, so
    // only the protected position the walk passed can deny it — and the code
    // is asserted, not merely the absence of an allow.
    //
    // The claim is exactly this: for these link shapes, and for each root and
    // argument SPELLING pairing enumerated, the write is denied as protected.
    // Spellings are paired both ways because relativizing an as-named value
    // against a canonical root is precisely how an earlier attempt at this
    // check silently passed under a symlinked root.
    const shapes = [
      { label: "the protected root is itself a link", link: ".git", target: "src/gitdir", write: ".git/config" },
      { label: "the projection root is itself a link", link: ".managed-projection", target: "src/proj", write: ".managed-projection/consumption.json" },
      { label: "the link is nested under a real protected root", link: ".managed-projection/skills", target: "tools/h", write: ".managed-projection/skills/x.md" },
    ] as const;
    for (const { label, link, target, write } of shapes) {
      const real = mkdtempSync(path.join(realpathSync(tmpdir()), "write-canon-protected-"));
      const alias = `${real}-link`;
      mkdirSync(path.join(real, target), { recursive: true });
      mkdirSync(path.join(real, path.dirname(link)), { recursive: true });
      symlinkSync(path.join(real, target), path.join(real, link));
      symlinkSync(real, alias);
      try {
        for (const [rootName, root] of [["resolved", real], ["symlinked", alias]] as const) {
          for (const [argName, argRoot] of [["resolved", real], ["symlinked", alias], ["relative", ""]] as const) {
            const argument = argRoot === "" ? write : path.join(argRoot, write);
            const decision = decideWrite(root, argument);
            const where = `${label} — root=${rootName} arg=${argName}`;
            expect(decision.allowed, where).toBe(false);
            expect(decision.allowed ? "" : decision.reason, where).toContain("protected_path");
          }
        }
      } finally {
        unlinkSync(alias);
        rmSync(real, { recursive: true, force: true });
      }
    }
  });

  it("denies a write that passes through a protected subtree on its way somewhere writable", () => {
    // THE CASE NO PAIR OF ENDPOINT SPELLINGS CAN SEE, and the reason the
    // resolver follows one link hop at a time rather than calling `realpath`:
    // an indirection BEFORE the protected segment. `src/self -> ..` puts the
    // workspace root back in the middle of the path, and `src/self0 -> ../.git`
    // resolves THROUGH the git directory to its writable target. In both, the
    // destination is writable and the argument's own head is `src/`, so
    // neither the resolved form nor the named form is under a protected
    // prefix; only a position passed mid-walk is.
    const real = mkdtempSync(path.join(realpathSync(tmpdir()), "write-canon-through-"));
    try {
      mkdirSync(path.join(real, "src", "gitdir"), { recursive: true });
      symlinkSync(path.join(real, "src", "gitdir"), path.join(real, ".git"));
      symlinkSync("..", path.join(real, "src", "self"));
      symlinkSync("../.git", path.join(real, "src", "self0"));
      symlinkSync(path.join(real, ".git"), path.join(real, "src", "self0abs"));
      const through = [
        "src/self/.git/config",
        "src/self0/config",
        "src/self0abs/config",
      ];
      for (const argument of through) {
        for (const spelling of [argument, path.join(real, argument)]) {
          const decision = decideWrite(real, spelling);
          expect(decision.allowed, spelling).toBe(false);
          expect(decision.allowed ? "" : decision.reason, spelling).toContain("protected_path");
        }
      }
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("denies a write through a dangling symlink, whose target it still reads", () => {
    // A DANGLING LINK — one whose target does not exist — is where a
    // `realpath`-based resolver goes blind: it throws exactly as it does for
    // an ordinary not-yet-created file, so the link's own innocent name is
    // what gets judged while the host's `open()` follows it. Reading the link
    // target directly is what closes this, and it is asserted for a relative
    // target, an absolute target, a target that is a directory prefix, and a
    // target leaving the workspace entirely.
    const real = mkdtempSync(path.join(realpathSync(tmpdir()), "write-canon-dangling-"));
    try {
      mkdirSync(path.join(real, "src"), { recursive: true });
      symlinkSync("../.git/hooks/pre-push", path.join(real, "src", "evil"));
      symlinkSync(path.join(real, ".git", "hooks", "pre-push"), path.join(real, "src", "evilabs"));
      symlinkSync("../.git/newdir", path.join(real, "src", "danglingdir"));
      symlinkSync("/tmp/outside-v26-1498.ts", path.join(real, "src", "escape"));
      for (const argument of ["src/evil", "src/evilabs", "src/danglingdir/x.ts"]) {
        const decision = decideWrite(real, argument);
        expect(decision.allowed, argument).toBe(false);
        expect(decision.allowed ? "" : decision.reason, argument).toContain("protected_path");
      }
      // Out of the workspace rather than into a protected path: still denied,
      // by containment instead.
      expect(decideWrite(real, "src/escape").allowed).toBe(false);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("denies a write whose resolution loops instead of following it forever", () => {
    // A link cycle must terminate and fail closed, not hang the interceptor.
    const real = mkdtempSync(path.join(realpathSync(tmpdir()), "write-canon-loop-"));
    try {
      mkdirSync(path.join(real, "src"), { recursive: true });
      symlinkSync(path.join(real, "src", "b"), path.join(real, "src", "a"));
      symlinkSync(path.join(real, "src", "a"), path.join(real, "src", "b"));
      expect(decideWrite(real, "src/a/x.ts").allowed).toBe(false);
      expect(decideWrite(real, path.join(real, "src", "a")).allowed).toBe(false);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("refuses to walk a path with more positions than any real one has", () => {
    // `file_path` IS UNBOUNDED MODEL INPUT, and each step of the walk
    // re-processes the accumulated path, so cost grows with the SQUARE of the
    // segment count. Left unbounded, ~16k segments — about 100KB of argument —
    // blocks this hook for eighteen seconds, and more blocks it for minutes; a
    // model that can stall its own permission check hands the host a timeout
    // decision this file never made. Refusing to judge is the closed
    // direction.
    //
    // Asserted as a PAIR, because a ceiling that denies everything would pass
    // the deny half alone: an ordinary deep path is still allowed, and a
    // legitimate link chain is still followed to a normal verdict.
    withSymlinkedWorkspace((real) => {
      const deep = (count: number): string => `src/${Array.from({ length: count }, (_, index) => `s${index}`).join("/")}/x.ts`;
      expect(decideWrite(real, deep(2000)).allowed, "beyond the ceiling").toBe(false);
      expect(decideWrite(real, deep(64)).allowed, "an ordinary deep path").toBe(true);

      const start = performance.now();
      expect(decideWrite(real, deep(16000)).allowed, "far beyond the ceiling").toBe(false);
      // Generous next to the eighteen seconds this took unbounded, while still
      // failing loudly if the quadratic ever returns.
      expect(performance.now() - start).toBeLessThan(2000);
    });
  });

  it("follows a long but legitimate chain of links to an ordinary verdict", () => {
    // The ceiling must not clip real work. A chain of links, each resolved
    // through the next, stays inside both the hop and the step ceilings and
    // reaches its destination — allowed when that destination is writable,
    // and denied when the same chain ends outside the workspace.
    const real = mkdtempSync(path.join(realpathSync(tmpdir()), "write-canon-chain-"));
    const outside = mkdtempSync(path.join(realpathSync(tmpdir()), "write-canon-chain-out-"));
    try {
      mkdirSync(path.join(real, "tools", "end"), { recursive: true });
      mkdirSync(path.join(real, "src"), { recursive: true });
      // hop0 -> hop1 -> ... -> hop29 -> tools/end
      symlinkSync(path.join(real, "tools", "end"), path.join(real, "src", "hop29"));
      for (let index = 28; index >= 0; index -= 1) {
        symlinkSync(path.join(real, "src", `hop${index + 1}`), path.join(real, "src", `hop${index}`));
      }
      expect(decideWrite(real, "src/hop0/out.ts").allowed, "30-link chain into a writable directory").toBe(true);

      symlinkSync(outside, path.join(real, "src", "outhop1"));
      symlinkSync(path.join(real, "src", "outhop1"), path.join(real, "src", "outhop0"));
      expect(decideWrite(real, "src/outhop0/captured.ts").allowed, "chain ending outside").toBe(false);
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("denies every write when the workspace root cannot anchor containment", () => {
    // An empty or relative root would otherwise be resolved against whatever
    // directory the hook process happens to sit in, silently re-anchoring the
    // grant somewhere the operator never named. Containment is unjudgeable, so
    // nothing is admitted.
    for (const root of ["", "tree", "./tree", "../tree"]) {
      expect(decideWrite(root, "src/a.ts").allowed, JSON.stringify(root)).toBe(false);
      expect(decideWrite(root, "/anywhere/src/a.ts").allowed, JSON.stringify(root)).toBe(false);
    }
  });
  it("admits the redundant spellings of an in-grant path", () => {
    // A DELIBERATE, RECORDED BEHAVIOUR CHANGE, asserted so it is a decision
    // rather than a side effect. Before canonicalization these four reached
    // the normalization check verbatim and were denied for carrying a '.' or
    // an empty segment; they now normalize first and are admitted. Every one
    // names a path that is plainly inside the grant, and the same normalization
    // is what lets the traversal test above see through `src/out/..` — so
    // pinning it here keeps the two consequences of one mechanism together.
    withSymlinkedWorkspace((real) => {
      for (const spelling of ["./src/a.ts", "src/./a.ts", "src//a.ts", "src/a.ts/"]) {
        expect(decideWrite(real, spelling).allowed, spelling).toBe(true);
      }
    });
  });

  it("denies a write whose path resolves nowhere, keeping its lexical form", () => {
    // Nothing along the chain resolves, so the lexical form stands and
    // containment rejects it — the same fail-closed direction the check had
    // before canonicalization existed. Asserted with an unresolvable argument
    // under a real root and with an unresolvable root, so neither operand's
    // resolution failure opens the grant.
    withSymlinkedWorkspace((real) => {
      expect(decideWrite(real, "/no-such-root-v26-1498/src/a.ts").allowed).toBe(false);
      expect(decideWrite("/no-such-root-v26-1498", path.join(real, "src", "new.ts")).allowed).toBe(false);
      expect(decideWrite("/no-such-root-v26-1498", "/other-missing-root/src/a.ts").allowed).toBe(false);
    });
  });

  it("does not widen the grant under an ordinary unsymlinked workspace root", () => {
    // The characterization pin: with no symlink anywhere, canonicalization is
    // a no-op on the decisions. In-grant allowed, protected denied, outside
    // denied — the behaviour the check had before this change.
    withSymlinkedWorkspace((real) => {
      expect(decideWrite(real, path.join(real, "src", "new.ts")).allowed).toBe(true);
      expect(decideWrite(real, path.join("src", "new.ts")).allowed).toBe(true);
      expect(decideWrite(real, path.join(real, ".managed-projection", "consumption.json")).allowed).toBe(false);
      expect(decideWrite(real, path.join(real, "docs", "notes.md")).allowed).toBe(false);
      expect(decideWrite(real, "/etc/passwd").allowed).toBe(false);
    });
  });
});

describe("the superseded-session check", () => {
  it("denies every tool when the session's admitted fence is not the state file's", () => {
    const decision = decideHookInvocation(state, { tool_name: "Read", tool_input: {} }, "2026-08-30T12:01:00Z", SESSION_FENCE + 1);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("superseded_session");
  });
});

describe("renderHookDecision", () => {
  it("renders a deny as the host's PreToolUse deny document", () => {
    const rendered = JSON.parse(
      renderHookDecision({ allowed: false, reason: "capability outside the attested grant" }),
    ) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    expect(rendered.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(rendered.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(rendered.hookSpecificOutput.permissionDecisionReason).toContain("grant");
  });

  it("renders an allow as an empty defer — the host's own permission system still applies", () => {
    expect(renderHookDecision({ allowed: true })).toBe("");
  });
});

describe("exactWorkflowSourceRead", () => {
  const observedState: HookBindingState = { ...state, deliveryId: expectation.deliveryId };
  const receipt = {
    deliveryId: expectation.deliveryId,
    projectionDigest: expectation.projectionDigest,
    entries: ["workflows/delivery-v1.json"],
  } as const;
  const read = (input: Record<string, unknown>) => exactWorkflowSourceRead(observedState, input, receipt);

  it("binds only the host's exact completed Read invocation to the canonical workflow source", () => {
    expect(
      read({
        tool_name: "Read",
        tool_use_id: "toolu_read_workflow",
        tool_input: { file_path: "/work/tree/.managed-projection/workflows/delivery-v1.json" },
      }),
    ).toEqual({
      deliveryId: expectation.deliveryId,
      fence: expectation.invocationFence,
      hostInvocationId: "toolu_read_workflow",
      canonicalProjectionPath: "/work/tree/.managed-projection/workflows/delivery-v1.json",
      projectionDigest: expectation.projectionDigest,
    });
  });

  it("rejects a planted path-only claim and every mismatched host/read/receipt binding", () => {
    const pathOnly = { tool_input: { file_path: "/work/tree/.managed-projection/workflows/delivery-v1.json" } };
    expect(read(pathOnly)).toBeUndefined();
    expect(read({ ...pathOnly, tool_name: "Grep", tool_use_id: "toolu_grep" })).toBeUndefined();
    expect(
      read({
        tool_name: "Read",
        tool_use_id: "toolu_other",
        tool_input: { file_path: "/work/tree/.managed-projection/consumption.json" },
      }),
    ).toBeUndefined();
    expect(
      exactWorkflowSourceRead(observedState, { ...pathOnly, tool_name: "Read", tool_use_id: "toolu_wrong" }, {
        ...receipt,
        projectionDigest: "b".repeat(64),
      }),
    ).toBeUndefined();
  });

  it("rejects every partial Read spelling, including a zero offset", () => {
    const fullRead = {
      tool_name: "Read",
      tool_use_id: "toolu_partial",
      tool_input: { file_path: "/work/tree/.managed-projection/workflows/delivery-v1.json" },
    };
    for (const partial of [
      { limit: 1 },
      { offset: 1 },
      { offset: 0 },
      { start_line: 1 },
      { end_line: 1 },
    ]) {
      expect(read({ ...fullRead, tool_input: { ...fullRead.tool_input, ...partial } })).toBeUndefined();
    }
  });

  it("rejects a symlink alias and a workflow entry swapped to a symlink", () => {
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), "exact-workflow-read-"));
    const workflowDir = path.join(root, ".managed-projection", "workflows");
    const direct = path.join(workflowDir, "delivery-v1.json");
    const alias = path.join(workflowDir, "workflow-alias.json");
    const original = path.join(workflowDir, "delivery-v1.original.json");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(direct, "{}\n");
    symlinkSync(direct, alias);
    const physicalState: HookBindingState = { ...observedState, workspaceRoot: root };
    const invocation = (file_path: string) => ({
      tool_name: "Read",
      tool_use_id: "toolu_alias",
      tool_input: { file_path },
    });
    try {
      // An alias resolving to the same bytes is still not the direct path.
      expect(exactWorkflowSourceRead(physicalState, invocation(alias), receipt)).toBeUndefined();
      expect(exactWorkflowSourceRead(physicalState, invocation(direct), receipt)).toMatchObject({ canonicalProjectionPath: direct });

      // A later swap means even the direct spelling no longer names a direct
      // projection file, and the old physical target is rejected as well.
      unlinkSync(direct);
      writeFileSync(original, "{}\n");
      symlinkSync(original, direct);
      expect(exactWorkflowSourceRead(physicalState, invocation(direct), receipt)).toBeUndefined();
      expect(exactWorkflowSourceRead(physicalState, invocation(original), receipt)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
