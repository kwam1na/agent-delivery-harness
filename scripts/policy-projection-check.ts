/**
 * Read-only comparison between this repository's layered policy projection
 * under `.agents/policy/` and the delivery authority it actually runs.
 *
 * The projection is a mapping, not a cutover. `npm run check`, the
 * `delivery-harness` gate loop, and the hosted checks in `.github/workflows`
 * stay the authority; this sensor only proves that the declarative document,
 * the typed leaf adapters, the recorded compiled snapshot, and the frozen
 * pre-cutover oracle still describe the routing the repository performs. Every
 * defect is a typed finding; nothing here mutates state.
 *
 * THE DIRECTION OF AUTHORITY, because this repository implements the compiler
 * its own policy is compiled by. A delivery is judged by the trusted pre-run
 * copy of the compiled policy (`checkBoundPolicy`) produced by the compiler
 * bytes of the pinned composition generation the product was installed from —
 * never by the candidate worktree. A candidate edit to `.agents/policy/`, to
 * `delivery/personas/`, or to `packages/kernel/src/policy/` is a proposal for a
 * future owner-approved policy generation.
 *
 * This SENSOR deliberately compiles through the candidate tree's compiler,
 * which is the opposite choice and the correct one for a sensor: recompiling
 * in-tree is exactly what turns a compiler change that alters this
 * repository's compiled policy into a visible two-place edit instead of silent
 * drift. A sensor reports; it does not admit.
 *
 * The oracle is immutable by digest: `PRE_CUTOVER_ORACLE_DIGEST` pins its exact
 * bytes, so recharacterizing the pre-cutover truth is a deliberate two-place
 * edit.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import {
  DELIVERY_RECORD_DRIFT_CLASSES,
  PREPARATION_FAILURE_CLASSES,
  compileRepositoryPolicy,
} from "@agent-delivery-harness/kernel";
import { COMMANDS } from "@agent-delivery-harness/cli";

import harnessConfig from "../harness.config.ts";

export const POLICY_PROJECTION_DIR = ".agents/policy";

export const PRE_CUTOVER_ORACLE_DIGEST =
  "c754b5debe0689e35ff0e7a24000c379ab81ed4341331d8ba635381139e81289";

const DOCUMENT_FILE = "repository-policy.json";
const ADAPTERS_FILE = "adapters.json";
const ORACLE_FILE = "pre-cutover-oracle.json";
const SNAPSHOT_FILE = "compiled-snapshot.json";
const REPORT_FILE = "comparison-report.json";

/**
 * Where this repository's reviewer charters live. The compiler resolves a
 * repository-owned charter only against the digest the document pins, and the
 * facade reads those bytes from the trusted pre-run base — this sensor reads
 * them from the tree it is scanning, which is what lets it report a drift the
 * base would refuse.
 */
export const PERSONA_DIR = "delivery/personas";
export const PERSONA_FILES: Readonly<Record<string, string>> = Object.freeze({
  "persona.outcome-correctness": "outcome-correctness.md",
  "persona.testing-policy": "testing-policy.md",
});

const ADJUDICATION_DISPOSITIONS = new Set([
  "accepted-projection",
  "deferred",
  "recorded",
  "corrected",
]);

/** The authority trees no model-driven stage may write. */
const PROTECTED_AUTHORITY_TREES = [
  ".agents",
  "delivery",
  "qualifications",
  "packages/conformance/vectors",
];

export type PolicyProjectionFinding = {
  code:
    | "artifact_unreadable"
    | "oracle_digest_mismatch"
    | "snapshot_input_stale"
    | "report_input_stale"
    | "compile_rejected"
    | "compile_drift"
    | "phase_drift"
    | "obligation_drift"
    | "blocker_vocabulary_drift"
    | "authority_drift"
    | "leaf_mapping_defect"
    | "aggregate_registered_as_leaf"
    | "activation_drift"
    | "generated_ownership_drift"
    | "adjudication_incomplete";
  message: string;
};

export type PolicyProjectionCheckResult = {
  status: "pass" | "fail";
  findings: PolicyProjectionFinding[];
};

type PolicyProjectionOptions = {
  policyDir?: string;
  personaDir?: string;
};

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalStringArrays(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sorted(values: readonly string[]) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Canonical JSON for structural equality. The compiled policy carries no
 * cycles and no non-JSON values, so sorting object keys and re-serializing is
 * enough to compare a fresh compile against the recorded one.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * GitHub Actions path-filter matching, restricted to the two wildcard forms
 * `.github/workflows/release.yml` actually uses: `*` inside one segment and a
 * trailing `**` covering the rest of the path.
 */
export function pathFilterMatches(filter: string, candidatePath: string): boolean {
  const filterSegments = filter.split("/");
  const pathSegments = candidatePath.split("/");
  for (let index = 0; index < filterSegments.length; index += 1) {
    const segment = filterSegments[index]!;
    if (segment === "**") return pathSegments.length >= index;
    const against = pathSegments[index];
    if (against === undefined) return false;
    if (segment === "*") continue;
    if (segment !== against) return false;
  }
  return filterSegments.length === pathSegments.length;
}

/**
 * The release surfaces, read live out of the workflow rather than duplicated:
 * the `paths:` list of the pull-request trigger in
 * `.github/workflows/release.yml`. Editing that list moves the live selection
 * and the frozen oracle vectors apart, which is the whole point.
 */
export function parseReleaseSurfaceFilters(workflowSource: string): string[] {
  const lines = workflowSource.split("\n");
  const start = lines.findIndex((line) => /^\s{4}paths:\s*$/.test(line));
  if (start === -1) return [];
  const filters: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const entry = line.match(/^\s{6}-\s+"?([^"#]+?)"?\s*$/);
    if (entry) {
      filters.push(entry[1]!);
      continue;
    }
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    break;
  }
  return filters;
}

export type SensorActivationClasses = {
  alwaysActive: readonly string[];
  releaseSurfaceActivated: readonly string[];
  operatorInvoked: readonly string[];
};

/** The sensor leaves a candidate touching `changedPaths` selects, live. */
export function selectActivatedSensors(input: {
  changedPaths: readonly string[];
  releaseFilters: readonly string[];
  classes: SensorActivationClasses;
}): string[] {
  const releaseTouched = input.changedPaths.some((candidatePath) =>
    input.releaseFilters.some((filter) => pathFilterMatches(filter, candidatePath)),
  );
  return sorted([
    ...input.classes.alwaysActive,
    ...(releaseTouched ? input.classes.releaseSurfaceActivated : []),
  ]);
}

export async function runPolicyProjectionCheck(
  rootDir: string,
  options: PolicyProjectionOptions = {},
): Promise<PolicyProjectionCheckResult> {
  const findings: PolicyProjectionFinding[] = [];
  const emit = (code: PolicyProjectionFinding["code"], message: string) => {
    findings.push({ code, message });
  };
  const policyDir = options.policyDir ?? path.join(rootDir, POLICY_PROJECTION_DIR);
  const personaDir = options.personaDir ?? path.join(rootDir, PERSONA_DIR);

  const bytes = new Map<string, Buffer>();
  const parsed = new Map<string, unknown>();
  for (const file of [DOCUMENT_FILE, ADAPTERS_FILE, ORACLE_FILE, SNAPSHOT_FILE, REPORT_FILE]) {
    try {
      const content = await readFile(path.join(policyDir, file));
      bytes.set(file, content);
      parsed.set(file, JSON.parse(content.toString("utf8")));
    } catch (error) {
      emit(
        "artifact_unreadable",
        `${POLICY_PROJECTION_DIR}/${file} is missing or not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (findings.length > 0) return { status: "fail", findings };

  const document = parsed.get(DOCUMENT_FILE) as {
    grantedFinishLines: string[];
    grantedAuthority: string[];
    forbiddenAuthority: string[];
    reviewLenses: { lensId: string; category: string; personaId: string; personaDigest?: string }[];
    obligations: { obligationId: string }[];
    requiredCapabilities: { capabilityId: string; kind: string; version: string }[];
    checkpoints?: { stageId: string; additionalProtectedPaths: string[] }[];
  };
  const adapters = parsed.get(ADAPTERS_FILE) as {
    capabilityId: string;
    kind: string;
    version: string;
  }[];
  const oracle = parsed.get(ORACLE_FILE) as {
    phaseVector: {
      aggregateEntrypoints: string[];
      orderedPhases: { phase: string; command: string }[];
      standaloneCommands: string[];
      checkSuiteConstituents: string[];
    };
    activationVector: {
      gateId: string;
      obligations: Record<string, Record<string, unknown>>;
      sensorActivationClasses: SensorActivationClasses;
      releaseSurfacePathFilterSource: string;
      activationProbes: Record<string, string[]>;
      activationSelection: Record<string, string[]>;
    };
    blockerVector: {
      preparationFailureClasses: string[];
      deliveryRecordDriftClasses: string[];
    };
    leafMappings: { leaf: string; capabilityId: string; kind: string }[];
    aggregateExclusions: { entrypoint: string }[];
    generatedArtifactOwnership: {
      repairStage: string;
      groups: { id: string; paths?: string[] }[];
      protectedAuthorityTrees: string[];
    };
  };
  const snapshot = parsed.get(SNAPSHOT_FILE) as {
    inputDigests: Record<string, string>;
    compiled: {
      compiledDigest: string;
      snapshot: {
        grantedFinishLines: string[];
        grantedAuthority: string[];
        obligations: { obligationId: string }[];
      };
      capabilities: { capabilityId: string }[];
      checkpointGrants: { stageId: string; grant: { protectedPaths: string[] } }[];
    };
  };
  const report = parsed.get(REPORT_FILE) as {
    inputs: Record<string, string>;
    adjudications: { id?: string; disposition?: string; blocking?: boolean }[];
  };

  // Valid JSON with the wrong shape is a typed finding, not an unhandled throw
  // that discards the findings already collected.
  try {
    // ── Oracle immutability ───────────────────────────────────────────────────
    const oracleDigest = sha256(bytes.get(ORACLE_FILE)!);
    if (oracleDigest !== PRE_CUTOVER_ORACLE_DIGEST) {
      emit(
        "oracle_digest_mismatch",
        `${ORACLE_FILE} digest ${oracleDigest} does not match the pinned pre-cutover digest; the oracle is immutable and recharacterization is a deliberate two-place edit`,
      );
    }

    // ── Recorded artifacts must describe the current inputs ───────────────────
    const documentDigest = sha256(bytes.get(DOCUMENT_FILE)!);
    const adaptersDigest = sha256(bytes.get(ADAPTERS_FILE)!);
    if (
      snapshot.inputDigests[DOCUMENT_FILE] !== documentDigest ||
      snapshot.inputDigests[ADAPTERS_FILE] !== adaptersDigest
    ) {
      emit(
        "snapshot_input_stale",
        "the recorded compiled snapshot was not compiled from the current document and adapter bytes; recompile and re-record",
      );
    }
    const snapshotFileDigest = sha256(bytes.get(SNAPSHOT_FILE)!);
    if (
      report.inputs[DOCUMENT_FILE] !== documentDigest ||
      report.inputs[ADAPTERS_FILE] !== adaptersDigest ||
      report.inputs[ORACLE_FILE] !== oracleDigest ||
      report.inputs[SNAPSHOT_FILE] !== snapshotFileDigest ||
      report.inputs["compiledDigest"] !== snapshot.compiled.compiledDigest
    ) {
      emit(
        "report_input_stale",
        "the comparison report does not describe the current policy artifacts; re-run the comparison and re-record it",
      );
    }

    // ── The compile, performed live against the recorded snapshot ─────────────
    const personas: { personaId: string; digest: string; origin: "adopter" }[] = [];
    for (const [personaId, fileName] of Object.entries(PERSONA_FILES)) {
      try {
        personas.push({
          personaId,
          digest: sha256(await readFile(path.join(personaDir, fileName))),
          origin: "adopter",
        });
      } catch (error) {
        emit(
          "artifact_unreadable",
          `${PERSONA_DIR}/${fileName} is missing, so reviewer charter ${personaId} cannot be resolved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const compiled = compileRepositoryPolicy({
      document: parsed.get(DOCUMENT_FILE),
      adapters,
      personas,
      productTrustRevocationEpoch: 0,
      repositoryAuthorityRevocationEpoch: 0,
    });
    if (!compiled.ok) {
      for (const rejection of compiled.rejections) {
        emit(
          "compile_rejected",
          `the policy compiler rejected the projection at ${rejection.pointer}: [${rejection.code}] ${rejection.message}`,
        );
      }
    } else if (canonicalJson(compiled.compiled) !== canonicalJson(snapshot.compiled)) {
      emit(
        "compile_drift",
        `compiling the current document and adapters produces ${compiled.compiled.compiledDigest}, which is not the recorded snapshot ${snapshot.compiled.compiledDigest}; recompile and re-record`,
      );
    }

    // ── Phase parity against the live command registry ────────────────────────
    const registered = COMMANDS.map((command) => command.name);
    for (const entry of oracle.phaseVector.orderedPhases) {
      const commandName = entry.command.replace(/^delivery-harness /, "");
      if (!registered.includes(commandName)) {
        emit(
          "phase_drift",
          `oracle phase ${entry.phase} names the command ${commandName}, which the CLI registry no longer registers`,
        );
      }
    }
    const oraclePhaseCommands = oracle.phaseVector.orderedPhases.map((entry) =>
      entry.command.replace(/^delivery-harness /, ""),
    );
    if (
      !equalStringArrays(
        sorted([...oraclePhaseCommands, ...oracle.phaseVector.standaloneCommands]),
        sorted(registered),
      )
    ) {
      emit(
        "phase_drift",
        `the live CLI registry (${sorted(registered).join(", ")}) is not the oracle's phase commands plus its standalone commands`,
      );
    }
    const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = manifest.scripts ?? {};
    const checkScript = scripts["check"];
    if (checkScript === undefined) {
      emit("phase_drift", "package.json no longer defines the check aggregate the oracle names");
    } else {
      const constituents = [...checkScript.matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1]!);
      if (!equalStringArrays(constituents, oracle.phaseVector.checkSuiteConstituents)) {
        emit(
          "phase_drift",
          `npm run check now chains [${constituents.join(", ")}] but the oracle froze [${oracle.phaseVector.checkSuiteConstituents.join(", ")}]`,
        );
      }
      for (const constituent of constituents) {
        if (scripts[constituent] === undefined) {
          emit("phase_drift", `npm run check chains ${constituent}, which package.json does not define`);
        }
      }
    }

    // ── Obligation parity against the live gate configuration ────────────────
    if (harnessConfig.gateId !== oracle.activationVector.gateId) {
      emit(
        "obligation_drift",
        `the live gate id is ${harnessConfig.gateId} but the oracle froze ${oracle.activationVector.gateId}`,
      );
    }
    const documentObligationIds = new Set(document.obligations.map((entry) => entry.obligationId));
    for (const live of harnessConfig.obligations) {
      if (!documentObligationIds.has(live.id)) {
        emit(
          "obligation_drift",
          `live gate obligation ${live.id} is not activated by the declarative policy document`,
        );
      }
      const frozen = oracle.activationVector.obligations[live.id];
      if (frozen === undefined) {
        emit("obligation_drift", `obligation ${live.id} is missing from the oracle activation vector`);
        continue;
      }
      if (frozen["activation"] !== live.activation.kind) {
        emit(
          "obligation_drift",
          `obligation ${live.id} activation is ${live.activation.kind} live but ${String(frozen["activation"])} in the oracle`,
        );
      }
      if (
        frozen["freshness"] !== live.freshness ||
        // Absence of `providerPolicy` in the config means "all"; the oracle
        // records the effective value, not the spelling.
        frozen["providerPolicy"] !== (live.providerPolicy ?? "all") ||
        frozen["minimumAttestationLevel"] !== live.minimumAttestationLevel ||
        frozen["humanWaiverAllowed"] !== live.humanWaiverAllowed
      ) {
        emit(
          "obligation_drift",
          `obligation ${live.id} freshness, provider policy, attestation floor, or waiver posture drifted from the oracle`,
        );
      }
      for (const [member, liveValue] of [
        ["providers", live.providers],
        ["acceptedPayloadSpecs", live.acceptedPayloadSpecs],
        ["ciDelegation", live.ciDelegationPolicyIds],
        ["waivableCodes", live.waivableCodes],
        ["nonWaivableCodes", live.nonWaivableCodes],
      ] as const) {
        const frozenValue = frozen[member];
        if (
          !Array.isArray(frozenValue) ||
          !equalStringArrays(sorted(frozenValue as string[]), sorted([...liveValue]))
        ) {
          emit("obligation_drift", `obligation ${live.id} ${member} drifted from the oracle`);
        }
      }
    }
    if (harnessConfig.activationThreshold !== oracle.activationVector.obligations["review.green"]?.["activationThreshold"]) {
      emit(
        "obligation_drift",
        `the live activation threshold (${harnessConfig.activationThreshold}) no longer matches the oracle's`,
      );
    }

    // ── Blocker vocabulary parity ────────────────────────────────────────────
    if (
      !equalStringArrays(oracle.blockerVector.preparationFailureClasses, [...PREPARATION_FAILURE_CLASSES])
    ) {
      emit(
        "blocker_vocabulary_drift",
        `the live preparation failure classes (${PREPARATION_FAILURE_CLASSES.join(", ")}) no longer match the oracle`,
      );
    }
    if (
      !equalStringArrays(oracle.blockerVector.deliveryRecordDriftClasses, [
        ...DELIVERY_RECORD_DRIFT_CLASSES,
      ])
    ) {
      emit(
        "blocker_vocabulary_drift",
        `the live delivery-record drift classes (${DELIVERY_RECORD_DRIFT_CLASSES.join(", ")}) no longer match the oracle`,
      );
    }

    // ── Authority: merge-ready default, merge and deploy ungranted ───────────
    if (
      !equalStringArrays(document.grantedFinishLines, ["merge-ready"]) ||
      !equalStringArrays(document.grantedAuthority, ["pr-creation"]) ||
      !equalStringArrays(sorted(document.forbiddenAuthority), ["deploy", "merge"])
    ) {
      emit(
        "authority_drift",
        "the declarative document must grant exactly the merge-ready finish line and pr-creation authority, with merge and deploy forbidden",
      );
    }
    if (
      !equalStringArrays(snapshot.compiled.snapshot.grantedFinishLines, ["merge-ready"]) ||
      !equalStringArrays(snapshot.compiled.snapshot.grantedAuthority, ["pr-creation"])
    ) {
      emit(
        "authority_drift",
        "the recorded compiled snapshot grants a finish line or authority the projection must not grant",
      );
    }
    if (
      !equalStringArrays(
        snapshot.compiled.snapshot.obligations.map((entry) => entry.obligationId),
        document.obligations.map((entry) => entry.obligationId),
      )
    ) {
      emit(
        "authority_drift",
        "the recorded compiled snapshot obligations do not match the declarative document obligations",
      );
    }

    // ── Leaf mapping: each proposed leaf maps exactly once ───────────────────
    const mappedCapabilityIds = oracle.leafMappings.map((mapping) => mapping.capabilityId);
    const adapterById = new Map(adapters.map((adapter) => [adapter.capabilityId, adapter]));
    if (new Set(mappedCapabilityIds).size !== mappedCapabilityIds.length) {
      emit("leaf_mapping_defect", "a capability is mapped by more than one oracle leaf");
    }
    const leafNames = oracle.leafMappings.map((mapping) => mapping.leaf);
    if (new Set(leafNames).size !== leafNames.length) {
      emit("leaf_mapping_defect", "a proposed leaf appears more than once in the oracle mapping");
    }
    for (const mapping of oracle.leafMappings) {
      const adapter = adapterById.get(mapping.capabilityId);
      if (!adapter) {
        emit(
          "leaf_mapping_defect",
          `oracle leaf ${mapping.leaf} maps to ${mapping.capabilityId}, which no adapter declares`,
        );
      } else if (adapter.kind !== mapping.kind) {
        emit(
          "leaf_mapping_defect",
          `oracle leaf ${mapping.leaf} expects kind ${mapping.kind} but the adapter binds ${adapter.kind}`,
        );
      }
    }
    for (const adapter of adapters) {
      if (!mappedCapabilityIds.includes(adapter.capabilityId)) {
        emit(
          "leaf_mapping_defect",
          `adapter ${adapter.capabilityId} is declared but mapped by no oracle leaf`,
        );
      }
    }
    for (const required of document.requiredCapabilities) {
      const adapter = adapterById.get(required.capabilityId);
      if (!adapter || adapter.kind !== required.kind || adapter.version !== required.version) {
        emit(
          "leaf_mapping_defect",
          `required capability ${required.capabilityId} has no matching adapter declaration`,
        );
      }
      if (required.kind === "merge" || required.kind === "deploy") {
        emit(
          "leaf_mapping_defect",
          `required capability ${required.capabilityId} would make an ungranted ${required.kind} action a delivery requirement`,
        );
      }
    }

    // ── The aggregates stay aggregates ───────────────────────────────────────
    for (const entrypoint of ["check", "release-checks-workflow"]) {
      if (!oracle.aggregateExclusions.some((exclusion) => exclusion.entrypoint === entrypoint)) {
        emit(
          "aggregate_registered_as_leaf",
          `the oracle no longer records the ${entrypoint} aggregate exclusion`,
        );
      }
    }
    // Positive form: every script the check aggregate chains must map to its
    // own leaf, and the aggregate itself to none. Asserting only that "check"
    // is absent would pass on an oracle that mapped no leaves at all.
    const leafAuthority = new Map(
      oracle.leafMappings.map((mapping) => [
        mapping.capabilityId,
        (mapping as { authority?: string[] }).authority ?? [],
      ]),
    );
    for (const constituent of oracle.phaseVector.checkSuiteConstituents) {
      // Whole-script-name match: `npm run sensor` is a prefix of
      // `npm run sensor:cli`, and a substring test would hand one script's
      // authority to three different leaves.
      const names = new RegExp(`npm run ${constituent}(?![\\w:-])`);
      const owners = [...leafAuthority.entries()].filter(([, authority]) =>
        authority.some((line) => names.test(line)),
      );
      if (owners.length !== 1) {
        emit(
          "aggregate_registered_as_leaf",
          `npm run ${constituent} is claimed by ${owners.length} leaves; each constituent of the check aggregate is exactly one leaf`,
        );
      }
    }
    for (const [capabilityId, authority] of leafAuthority) {
      if (authority.some((line) => /\bnpm run check\b/.test(line))) {
        emit(
          "aggregate_registered_as_leaf",
          `${capabilityId} binds the npm run check aggregate as its authority; the aggregate re-enters every constituent sensor and is the comparison authority, never a leaf`,
        );
      }
    }

    // ── Activation scenarios against the live workflow path filters ──────────
    const releaseFilters = parseReleaseSurfaceFilters(
      await readFile(path.join(rootDir, oracle.activationVector.releaseSurfacePathFilterSource), "utf8"),
    );
    if (releaseFilters.length === 0) {
      emit(
        "activation_drift",
        `no pull-request path filters could be read from ${oracle.activationVector.releaseSurfacePathFilterSource}; an empty filter set would make every activation probe pass vacuously`,
      );
    }
    const classes = oracle.activationVector.sensorActivationClasses;
    // The classes must partition the sensor leaves exactly: an unclassified
    // sensor, or one classified twice, is an activation the projection cannot
    // answer for.
    const classified = [
      ...classes.alwaysActive,
      ...classes.releaseSurfaceActivated,
      ...classes.operatorInvoked,
    ];
    const sensorLeaves = oracle.leafMappings
      .filter((mapping) => mapping.kind === "sensor")
      .map((mapping) => mapping.capabilityId);
    if (new Set(classified).size !== classified.length) {
      emit("activation_drift", "a sensor leaf appears in more than one activation class");
    }
    if (!equalStringArrays(sorted(classified), sorted(sensorLeaves))) {
      emit(
        "activation_drift",
        `the activation classes cover [${sorted(classified).join(", ")}] but the sensor leaves are [${sorted(sensorLeaves).join(", ")}]`,
      );
    }
    for (const [scenario, frozenSelection] of Object.entries(
      oracle.activationVector.activationSelection,
    )) {
      const probe = oracle.activationVector.activationProbes[scenario];
      if (!probe) {
        emit("activation_drift", `oracle scenario ${scenario} has no probe changed-file set`);
        continue;
      }
      const live = selectActivatedSensors({ changedPaths: probe, releaseFilters, classes });
      if (!equalStringArrays(live, sorted(frozenSelection))) {
        emit(
          "activation_drift",
          `scenario ${scenario} now selects [${live.join(", ")}] but the oracle froze [${sorted(frozenSelection).join(", ")}]`,
        );
      }
    }
    for (const scenario of Object.keys(oracle.activationVector.activationProbes)) {
      if (oracle.activationVector.activationSelection[scenario] === undefined) {
        emit("activation_drift", `oracle probe ${scenario} has no frozen selection vector`);
      }
    }

    // ── Generated artifacts and the protected authority trees ────────────────
    const ownership = oracle.generatedArtifactOwnership;
    if (ownership.repairStage !== "stage.conformance-kit-regeneration") {
      emit(
        "generated_ownership_drift",
        "the oracle no longer assigns the generated conformance vectors to their regeneration stage",
      );
    }
    const generatedPaths = harnessConfig.pathClassification.generated
      .filter((matcher) => matcher.kind === "prefix")
      .map((matcher) => matcher.value.replace(/\/$/, ""));
    const oracleGeneratedPaths = ownership.groups.flatMap((group) => group.paths ?? []);
    if (!equalStringArrays(sorted(oracleGeneratedPaths), sorted(generatedPaths))) {
      emit(
        "generated_ownership_drift",
        `the live gate classifies [${sorted(generatedPaths).join(", ")}] as generated but the oracle owns [${sorted(oracleGeneratedPaths).join(", ")}]`,
      );
    }
    if (!equalStringArrays(sorted(ownership.protectedAuthorityTrees), sorted(PROTECTED_AUTHORITY_TREES))) {
      emit(
        "generated_ownership_drift",
        "the oracle's protected authority trees no longer match the set this sensor holds",
      );
    }
    for (const override of document.checkpoints ?? []) {
      for (const tree of PROTECTED_AUTHORITY_TREES) {
        if (!override.additionalProtectedPaths.includes(tree)) {
          emit(
            "generated_ownership_drift",
            `checkpoint ${override.stageId} does not protect the authority tree ${tree}`,
          );
        }
      }
    }
    for (const grant of snapshot.compiled.checkpointGrants) {
      for (const tree of PROTECTED_AUTHORITY_TREES) {
        if (!grant.grant.protectedPaths.includes(tree)) {
          emit(
            "generated_ownership_drift",
            `compiled grant for ${grant.stageId} does not protect the authority tree ${tree}`,
          );
        }
      }
    }

    // ── Every observed-only mismatch carries a disposition ───────────────────
    if (!Array.isArray(report.adjudications) || report.adjudications.length === 0) {
      emit(
        "adjudication_incomplete",
        "the comparison report records no adjudications; the observed-only mismatch record cannot be emptied without a deliberate recharacterization",
      );
    }
    const adjudicationIds = new Set<string>();
    for (const adjudication of report.adjudications ?? []) {
      if (
        !adjudication.id ||
        adjudicationIds.has(adjudication.id) ||
        !ADJUDICATION_DISPOSITIONS.has(adjudication.disposition ?? "") ||
        adjudication.blocking !== false
      ) {
        emit(
          "adjudication_incomplete",
          `comparison-report adjudication ${adjudication.id ?? "<unnamed>"} must carry a unique id, a recorded disposition, and an explicit non-blocking marker`,
        );
      }
      if (adjudication.id) adjudicationIds.add(adjudication.id);
    }
  } catch (error) {
    emit(
      "artifact_unreadable",
      `a policy artifact does not have the expected shape, so the comparisons after this point were not evaluated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { status: findings.length === 0 ? "pass" : "fail", findings };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function main(): Promise<void> {
  const result = await runPolicyProjectionCheck(repoRootFromHere());
  if (result.status === "pass") {
    process.stdout.write(
      "policy-projection-check: clean (the layered policy projection matches the live delivery authority and the frozen pre-cutover oracle)\n",
    );
    return;
  }
  process.stderr.write(`policy-projection-check: ${result.findings.length} finding(s)\n`);
  for (const finding of result.findings) {
    process.stderr.write(`  ${finding.code}\n      ${finding.message}\n`);
  }
  process.exitCode = 1;
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
