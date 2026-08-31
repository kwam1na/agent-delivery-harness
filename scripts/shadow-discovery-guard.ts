/**
 * The pre-cutover exactly-one-discovery guard for this repository's read-only
 * shadow window.
 *
 * The composed delivery product is installed in shadow mode and materializes
 * its run-pinned projection into managed delivery worktrees, while `npm run
 * check` and the `delivery-harness` gate loop stay the repository's only
 * delivery authority. This guard holds five positions and holds nothing else:
 *
 *   - POSTURE. The activation metadata must still say shadow, and must not
 *     claim delivery authority.
 *   - THE PINNED PRODUCT COMMIT. The activation's self-application argument
 *     rests on one field naming the trusted generation the installed compiler
 *     was packed from, so that id must resolve to a commit in this repository
 *     rather than merely look like one. A fabricated tail on a real abbreviated
 *     prefix reads as correct at a glance; this position is what makes it a
 *     finding. It is meaningful because the product repository IS this
 *     repository, and an adopter whose product is a different repository would
 *     not carry it.
 *   - AMBIENT-DISCOVERY NEUTRALITY. This repository carries no vendored agent
 *     discovery layout at all, and that is a position rather than an accident:
 *     the tracked contents of the ambient discovery roots are hashed and pinned
 *     by digest over the index, and checked again against the working tree. The
 *     pinned value today is the digest of an empty layout, so introducing an
 *     ambient discovery root before the cutover's removal gate is drift, not a
 *     silent second source of agent instructions.
 *   - SCOPE. The projection root may exist only inside a managed delivery
 *     worktree. The repository root and every non-managed worktree carry none.
 *     What is checked is the root of the tree the guard is invoked in, not
 *     every directory beneath it.
 *   - CONSUMPTION. A delivery counts toward the milestone's comparison set only
 *     on a record that declares the binding as its source and carries the
 *     binding's marker fields for this delivery and fence. The guard checks
 *     that declaration and shape; what keeps a session from writing the record
 *     is that `.agents` is a protected path in every checkpoint grant, plus the
 *     binding-side writer the product supplies. An agent-supplied claim is a
 *     finding, and an absent or non-affirmative record excludes the delivery.
 *
 * Exclusivity is deliberately NOT asserted as blocking. Both graded hosts are
 * exclusivity-ungraded — they can add the run-pinned discovery root but cannot
 * scope discovery to it — so an ambient generation, if one ever appeared, would
 * coexist with the projection inside a managed worktree. That cannot corrupt
 * authority while the shadow window holds none, so coexistence is recorded as a
 * non-blocking observation. It becomes a finding only once the proving host
 * carries the affirmative capable grade.
 *
 * Both consumers of the grading therefore key on that affirmative value rather
 * than on the absence of the ungraded one. Keying on the absence would read a
 * grading the guard does not recognise as capable, and invent exactly the
 * blocking exclusivity claim this window is not allowed to make.
 *
 * Everything here is read-only: the guard opens files, asks git for tracked
 * object names, and returns typed findings.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { POLICY_PROJECTION_DIR } from "./policy-projection-check.ts";

export const SHADOW_ACTIVATION_FILE = "shadow-activation.json";
export const SHADOW_GATE_RECORD_FILE = "shadow-milestone-gate-record.json";

/**
 * The roots an ambient (non-run-pinned) agent discovery layout would occupy.
 * `.agents/skills` rather than `.agents`, deliberately: the policy projection
 * lives under `.agents/policy` and changes on its own schedule, and a guard
 * that fires on ordinary policy churn is one the operator learns to ignore.
 */
export const AMBIENT_DISCOVERY_ROOTS = Object.freeze([
  ".agent-skills",
  ".agents/skills",
  ".agents/agents",
  ".claude",
  ".codex",
]);

/**
 * The pinned bytes of the ambient discovery layout. Today this repository has
 * none, so the pin is the digest of the empty layout — and that is the claim:
 * no ambient agent-instruction source exists beside the run-pinned projection,
 * and none may appear before the cutover's removal gate. Changing the layout is
 * a deliberate two-place edit — the tracked bytes and this digest.
 */
export const AMBIENT_DISCOVERY_LAYOUT_DIGEST =
  "01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b";

export type ShadowGuardFindingCode =
  | "artifact_unreadable"
  | "activation_not_shadow"
  | "delivery_authority_claimed"
  | "exclusivity_position_unsupported"
  | "product_commit_unresolvable"
  | "ambient_discovery_drift"
  | "projection_outside_managed_worktree"
  | "discovery_exclusivity_violation"
  | "consumption_record_missing"
  | "consumption_record_shape"
  | "agent_supplied_consumption_claim"
  | "comparison_set_admission_defect"
  | "comparison_set_mix_defect";

export type ShadowGuardObservationCode = "exclusivity_non_blocking" | "comparison_set_incomplete";

export type ShadowGuardFinding = { code: ShadowGuardFindingCode; message: string };
export type ShadowGuardObservation = { code: ShadowGuardObservationCode; message: string };

export type ShadowGuardResult = {
  status: "pass" | "fail";
  findings: ShadowGuardFinding[];
  observations: ShadowGuardObservation[];
  countedDeliveryIds: string[];
};

/** What the guard was able to see about the tree it is judging. */
export type ObservedWorktree = {
  dir: string;
  projectionPresent: boolean;
  ambientDiscoveryVisible?: boolean;
};

export type ShadowGuardOptions = {
  policyDir?: string;
  /** Overrides the git-derived layout digest; used to plant drift. */
  observedLayoutDigest?: string;
  /** Overrides the git-derived working-tree state of the layout. */
  observedLayoutWorkingTree?: string;
  /** Overrides the observation of the tree the guard runs in. */
  worktree?: ObservedWorktree;
  /**
   * Resolves a commit id to its git object type, or undefined when this
   * repository cannot answer. Overridden by tests so the rule can be driven on
   * both branches without depending on the checkout's clone depth.
   */
  resolveCommitType?: (commit: string) => string | undefined;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(rootDir: string, args: readonly string[]) {
  const result = spawnSync("git", [...args], { cwd: rootDir, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

/**
 * The layout's canonical form: `git ls-files -s` lines — mode, object name,
 * stage, path — for every ambient discovery root, sorted by code unit so the
 * digest does not depend on locale collation.
 */
export function computeAmbientDiscoveryLayoutDigest(rootDir: string) {
  const lines = runGit(rootDir, ["ls-files", "-s", "--", ...AMBIENT_DISCOVERY_ROOTS])
    .split("\n")
    .filter((line) => line.length > 0)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return sha256(`${lines.join("\n")}\n`);
}

/**
 * The working-tree half of neutrality. The digest above reads the index, and
 * the guard's real execution context is an operator's working tree during a
 * live shadow install — where an unstaged addition under a discovery root is
 * exactly the change the position exists to catch and is invisible to the
 * index.
 */
export function observeAmbientDiscoveryWorkingTree(rootDir: string) {
  return runGit(rootDir, ["status", "--porcelain", "--", ...AMBIENT_DISCOVERY_ROOTS]).trim();
}

/**
 * The git object type of a commit id, or undefined when this repository cannot
 * answer — a fabricated id and an id this checkout simply does not carry are
 * indistinguishable to git, so both land here.
 */
export function resolveCommitTypeFromGit(rootDir: string, commit: string): string | undefined {
  const result = spawnSync("git", ["cat-file", "-t", commit], { cwd: rootDir, encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  return (result.stdout ?? "").trim();
}

/** Whether a path lies inside the declared managed delivery worktree root. */
function isManagedDeliveryWorktree(dir: string, managedRoot: string) {
  const wanted = managedRoot.split("/").filter((segment) => segment.length > 0);
  // An empty declared root would make every segment match vacuously, turning
  // the whole scope position off; a degenerate value narrows nothing.
  if (wanted.length === 0) return false;
  const segments = path.resolve(dir).split(path.sep);
  return segments.some((_, index) =>
    wanted.every((segment, offset) => segments[index + offset] === segment),
  );
}

function isHex64(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export async function runShadowDiscoveryGuard(
  rootDir: string,
  options: ShadowGuardOptions = {},
): Promise<ShadowGuardResult> {
  const findings: ShadowGuardFinding[] = [];
  const observations: ShadowGuardObservation[] = [];
  const countedDeliveryIds: string[] = [];
  const emit = (code: ShadowGuardFindingCode, message: string) => {
    findings.push({ code, message });
  };
  const observe = (code: ShadowGuardObservationCode, message: string) => {
    observations.push({ code, message });
  };

  const policyDir = options.policyDir ?? path.join(rootDir, POLICY_PROJECTION_DIR);

  const documents = new Map<string, Record<string, unknown>>();
  for (const file of [SHADOW_ACTIVATION_FILE, SHADOW_GATE_RECORD_FILE]) {
    try {
      documents.set(file, JSON.parse(await readFile(path.join(policyDir, file), "utf8")));
    } catch (error) {
      emit(
        "artifact_unreadable",
        `${POLICY_PROJECTION_DIR}/${file} is missing or not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const activation = documents.get(SHADOW_ACTIVATION_FILE);
  const gateRecord = documents.get(SHADOW_GATE_RECORD_FILE);
  if (activation === undefined || gateRecord === undefined) {
    return { status: "fail", findings, observations, countedDeliveryIds };
  }

  try {
    await evaluateShadowArtifacts({
      rootDir,
      options,
      activation,
      gateRecord,
      countedDeliveryIds,
      emit,
      observe,
    });
  } catch (error) {
    // Valid JSON of the wrong shape is an unreadable artifact, not a crash —
    // the same policy the companion projection sensor applies.
    emit(
      "artifact_unreadable",
      `a shadow policy artifact does not have the expected shape, so the guard positions after this point were not evaluated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    status: findings.length === 0 ? "pass" : "fail",
    findings,
    observations,
    countedDeliveryIds,
  };
}

async function evaluateShadowArtifacts(input: {
  rootDir: string;
  options: ShadowGuardOptions;
  activation: any;
  gateRecord: any;
  countedDeliveryIds: string[];
  emit: (code: ShadowGuardFindingCode, message: string) => void;
  observe: (code: ShadowGuardObservationCode, message: string) => void;
}) {
  const { rootDir, options, activation, gateRecord, countedDeliveryIds, emit, observe } = input;

  // ── Posture ────────────────────────────────────────────────────────────────
  if (activation.installationMode !== "shadow") {
    emit(
      "activation_not_shadow",
      `the activation declares installation mode ${JSON.stringify(
        activation.installationMode,
      )}; the guard only governs the read-only shadow window`,
    );
  }
  if (activation.deliveryAuthority !== "none") {
    emit(
      "delivery_authority_claimed",
      `the activation claims delivery authority ${JSON.stringify(
        activation.deliveryAuthority,
      )}; during the shadow window ${activation.comparisonAuthority} remains the only authority`,
    );
  }

  const provingHost = Array.isArray(activation.hosts)
    ? activation.hosts.find((host: any) => host?.hostId === activation.provingHost)
    : undefined;
  const provingHostExclusivityGraded = provingHost?.exclusivityGrading === "exclusivity-graded";
  const declaredPosition = activation.exclusivityPosition?.duringShadowWindow;
  // Only the affirmative capable grade admits a blocking claim. An ungraded
  // host, an unrecognised grading, and a proving host no entry grades all
  // refuse it: this is the one position that would otherwise widen on a value
  // it does not understand, and a claim the host cannot deliver is worse than
  // no claim.
  if (declaredPosition === "blocking" && !provingHostExclusivityGraded) {
    emit(
      "exclusivity_position_unsupported",
      `the activation claims a blocking exclusivity position while the proving host ${JSON.stringify(
        activation.provingHost,
      )} carries the grading ${JSON.stringify(
        provingHost?.exclusivityGrading,
      )}; only an exclusivity-graded host can deliver one`,
    );
  }

  // ── The pinned product commit must name bytes that exist ───────────────────
  // The activation's self-application argument rests on this one field: it is
  // what names the trusted generation the installed compiler was packed from.
  // A fabricated id that shares a real abbreviated prefix reads as correct at a
  // glance and makes the pin unverifiable, so the id is resolved rather than
  // eyeballed.
  //
  // This check is meaningful HERE because the product repository is this
  // repository. An adopter whose product is a different repository cannot
  // resolve the id locally and would not carry this position.
  const productCommit = activation.product?.commit;
  if (typeof productCommit !== "string" || !/^[0-9a-f]{40}$/.test(productCommit)) {
    emit(
      "product_commit_unresolvable",
      `the activation pins the product commit as ${JSON.stringify(
        productCommit,
      )}, which is not a full 40-character object id; an abbreviated id cannot be expanded by reading it`,
    );
  } else {
    const resolve = options.resolveCommitType ?? ((commit: string) => resolveCommitTypeFromGit(rootDir, commit));
    const objectType = resolve(productCommit);
    if (objectType !== "commit") {
      emit(
        "product_commit_unresolvable",
        `the activation pins the product commit ${productCommit}, which this repository does not resolve to a commit (git reports ${JSON.stringify(
          objectType,
        )}); the field naming which bytes are trusted must name bytes that exist, and a full id is derived with git rev-parse rather than extended from an abbreviation`,
      );
    }
  }

  // ── Neutrality of the ambient discovery layout ─────────────────────────────
  let observedLayoutDigest = options.observedLayoutDigest;
  if (observedLayoutDigest === undefined) {
    try {
      observedLayoutDigest = computeAmbientDiscoveryLayoutDigest(rootDir);
    } catch (error) {
      emit(
        "artifact_unreadable",
        `the ambient discovery layout could not be read from git: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (observedLayoutDigest !== undefined && observedLayoutDigest !== AMBIENT_DISCOVERY_LAYOUT_DIGEST) {
    emit(
      "ambient_discovery_drift",
      `the ambient discovery layout hashes to ${observedLayoutDigest}, not the pinned ${AMBIENT_DISCOVERY_LAYOUT_DIGEST}; no tracked byte of it may change before the cutover's removal gate, and a deliberate change is re-pinned by updating AMBIENT_DISCOVERY_LAYOUT_DIGEST in scripts/shadow-discovery-guard.ts`,
    );
  }
  let workingTree = options.observedLayoutWorkingTree;
  if (workingTree === undefined) {
    try {
      workingTree = observeAmbientDiscoveryWorkingTree(rootDir);
    } catch (error) {
      emit(
        "artifact_unreadable",
        `the ambient discovery layout's working-tree state could not be read from git: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (workingTree !== undefined && workingTree.length > 0) {
    emit(
      "ambient_discovery_drift",
      `the ambient discovery layout is modified in the working tree, which the index digest cannot see (a deliberate change is committed and then re-pinned by updating AMBIENT_DISCOVERY_LAYOUT_DIGEST in scripts/shadow-discovery-guard.ts):\n${workingTree}`,
    );
  }

  // ── Projection scope and discovery coexistence ─────────────────────────────
  const projectionRoot = activation.projection?.root ?? ".managed-projection";
  const managedRoot = activation.projection?.managedDeliveryWorktreeRoot ?? ".worktrees/managed";
  const worktree: ObservedWorktree = options.worktree ?? {
    dir: rootDir,
    projectionPresent: existsSync(path.join(rootDir, projectionRoot)),
    ambientDiscoveryVisible: AMBIENT_DISCOVERY_ROOTS.some((root) =>
      existsSync(path.join(rootDir, root)),
    ),
  };
  const managed = isManagedDeliveryWorktree(worktree.dir, managedRoot);
  if (worktree.projectionPresent && !managed) {
    emit(
      "projection_outside_managed_worktree",
      `${worktree.dir} carries ${projectionRoot} but is not a managed delivery worktree under ${managedRoot}; the repository root and non-managed worktrees carry no projection`,
    );
  }
  if (worktree.projectionPresent && worktree.ambientDiscoveryVisible) {
    // Both consumers of the grading key on the same affirmative value. Keying
    // this one on the absence of the ungraded token would read an unrecognised
    // grading as capable and emit the blocking exclusivity claim the shadow
    // window is specifically not allowed to invent.
    if (provingHostExclusivityGraded) {
      emit(
        "discovery_exclusivity_violation",
        `${worktree.dir} exposes both the run-pinned projection and an ambient discovery root while the proving host ${JSON.stringify(
          activation.provingHost,
        )} is graded exclusivity-graded; discovery must resolve to the run-pinned projection alone`,
      );
    } else {
      observe(
        "exclusivity_non_blocking",
        `${worktree.dir} exposes both the run-pinned projection and an ambient discovery root; the proving host ${JSON.stringify(
          activation.provingHost,
        )} carries the grading ${JSON.stringify(
          provingHost?.exclusivityGrading,
        )}, which is not the capable grade, so coexistence is non-blocking during the read-only shadow window and hard exclusivity arrives at ${activation.exclusivityPosition?.becomesBlockingAt}`,
      );
    }
  }

  // ── Binding-sourced projection-consumption records ─────────────────────────
  const requirement = gateRecord.comparisonSetRequirement ?? {};
  const requiredMix: Record<string, number> = requirement.mix ?? {};
  const deliveries: any[] = Array.isArray(gateRecord.deliveries) ? gateRecord.deliveries : [];
  const countedByCategory = new Map<string, number>();

  for (const delivery of deliveries) {
    const id = String(delivery?.id ?? "<unnamed>");
    const record = delivery?.projectionConsumption;
    let admissible = false;

    if (record === undefined || record === null) {
      emit(
        "consumption_record_missing",
        `delivery ${id} carries no projection-consumption record, so it cannot count toward the comparison set`,
      );
    } else if (record.source !== "binding") {
      emit(
        "agent_supplied_consumption_claim",
        `delivery ${id} carries a projection-consumption record sourced from ${JSON.stringify(
          record.source,
        )}; only the binding's own per-run marker is accepted, so the claim is rejected and the delivery is excluded`,
      );
    } else if (record.affirmative === false) {
      // An honest negative: the run did not consume the run-pinned projection.
      // Excluded from the comparison set, and not a defect.
    } else if (record.affirmative !== true) {
      emit(
        "consumption_record_shape",
        `delivery ${id} has a projection-consumption record whose affirmative flag is ${JSON.stringify(
          record.affirmative,
        )}; it must be an explicit boolean`,
      );
    } else if (!isHex64(record.projectionDigest)) {
      emit(
        "consumption_record_shape",
        `delivery ${id} affirms consumption without the projection digest the binding receipted at materialization`,
      );
    } else if (typeof delivery?.id !== "string" || delivery.id.length === 0) {
      emit(
        "consumption_record_shape",
        "a gate-record entry with no delivery id cannot be tied to any run, so its marker proves nothing",
      );
    } else if (record.marker?.deliveryId !== delivery.id) {
      emit(
        "consumption_record_shape",
        `delivery ${id} carries a marker naming ${JSON.stringify(
          record.marker?.deliveryId,
        )}; a marker from another run proves nothing about this one`,
      );
    } else if (typeof record.marker?.fence !== "number") {
      emit(
        "consumption_record_shape",
        `delivery ${id} carries a marker without the numeric invocation fence that binds it to this run`,
      );
    } else if (typeof record.marker?.consumed !== "string" || record.marker.consumed.length === 0) {
      emit(
        "consumption_record_shape",
        `delivery ${id} carries a marker that names no consumed workflow source`,
      );
    } else {
      admissible = true;
    }

    if (delivery?.countedInComparisonSet === true) {
      if (!admissible) {
        emit(
          "comparison_set_admission_defect",
          `delivery ${id} is counted in the comparison set without an affirmative binding-sourced consumption record`,
        );
      } else if (countedDeliveryIds.includes(id)) {
        // One run counted twice fills the comparison set without measuring a
        // second delivery; the marker binds a delivery, so the id is the run.
        emit(
          "comparison_set_admission_defect",
          `delivery ${id} is counted more than once; each counted delivery must be a distinct run`,
        );
      } else {
        countedDeliveryIds.push(id);
        const category = String(delivery?.category ?? "<uncategorised>");
        countedByCategory.set(category, (countedByCategory.get(category) ?? 0) + 1);
      }
    }
  }

  for (const [category, count] of countedByCategory) {
    // Own properties only: a category named after an Object.prototype member
    // would otherwise resolve through the prototype chain and skip the cap.
    const allowed = Object.hasOwn(requiredMix, category) ? requiredMix[category] : undefined;
    if (allowed === undefined) {
      emit(
        "comparison_set_mix_defect",
        `the comparison set counts a ${category} delivery, which the baseline mix does not include`,
      );
    } else if (count > allowed) {
      emit(
        "comparison_set_mix_defect",
        `the comparison set counts ${count} ${category} deliveries against the baseline's ${allowed}; the set must match the baseline's mix and count`,
      );
    }
  }
  // An absent requirement is unparseable, not zero: defaulting to 0 would make
  // a gate record carrying no requirement at all read as an already-complete
  // empty set, which is exactly the state the observation exists to report.
  const requiredTotal = Number(requirement.total ?? NaN);
  // Written as a negated `>=` so an unparseable total falls to the incomplete
  // side: NaN makes every comparison false, and silently dropping the
  // observation would let a malformed requirement read as a scorable set.
  if (!(countedDeliveryIds.length >= requiredTotal)) {
    observe(
      "comparison_set_incomplete",
      `the comparison set holds ${countedDeliveryIds.length} of the ${requiredTotal} deliveries the baseline mix requires; the shadow-delivery gate cannot be scored until it is complete`,
    );
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function main(): Promise<void> {
  const result = await runShadowDiscoveryGuard(repoRootFromHere());
  if (result.status === "pass") {
    process.stdout.write(
      "shadow-discovery-guard: clean (shadow-mode activation, no ambient discovery layout, projection scoped to managed delivery worktrees, binding-sourced consumption records only)\n",
    );
  } else {
    process.stderr.write(`shadow-discovery-guard: ${result.findings.length} finding(s)\n`);
    for (const finding of result.findings) {
      process.stderr.write(`  ${finding.code}\n      ${finding.message}\n`);
    }
  }
  for (const observation of result.observations) {
    process.stdout.write(`  · ${observation.code}\n      ${observation.message}\n`);
  }
  process.exitCode = result.status === "pass" ? 0 : 1;
}

function canonicalEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  canonicalEntryPath(path.resolve(process.argv[1])) === canonicalEntryPath(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
