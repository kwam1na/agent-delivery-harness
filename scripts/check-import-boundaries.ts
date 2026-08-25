/**
 * Static import-boundary, env, runtime, purity, and time sensor.
 *
 * Six independently falsifiable rules, all parsed with the TypeScript compiler
 * API (never regex over source text):
 *
 *   a  — kernel modules import nothing from `cli`/`mcp`/`action` and never
 *        import `harness.config`.
 *   b  — no module reads `process.env` while it is being evaluated (import
 *        time). In-function reads are legal. Aliased top-level reads
 *        (`const p = process; p.env.X`) are resolved and rejected. Dynamic
 *        constructs the resolver cannot decide are reported as findings —
 *        never silently skipped.
 *   c  — no `Bun.*` API anywhere. Bun is a supported runtime via the CI matrix,
 *        never a required one.
 *   d1 — true purity. The d1 protected classes (`validator/`, `evaluator.ts`,
 *        `context.ts`) import none of the fs/process/os specifier family and,
 *        within the kernel, import only the enumerated allowlist (plus, for
 *        files in a kernel subdirectory, siblings of that subdirectory).
 *   d2 — no ad-hoc fs. `recorder.ts`, `admission.ts`, `delivery-record.ts` may
 *        not import the fs/process/os family directly; their filesystem work
 *        goes through the `artifacts.ts` fs port (not yet created).
 *   e  — GEN-5 time ban. No `Date.now()`, `new Date()`, or `recordedAt` member
 *        read (`x.recordedAt`, `x["recordedAt"]`) in the decision paths the spec
 *        forbids consulting a clock from. A locally-scoped binding merely named
 *        `recordedAt` is legal; only reading the member is a finding.
 *
 * `import type` is always legal — a type has no runtime edge. `*.test.ts` files
 * are outside the d1/d2/e scans (tests read fixtures from disk and stub clocks);
 * rules a, b, and c apply to them.
 *
 * ANTI-VACUITY. Most protected files do not exist yet. Every scan root and every
 * protected class is registered below with an explicit status, and the registry
 * is checked against the filesystem on every run: a `present` entry that has
 * vanished and a `pending` entry that has appeared are both findings. A rename
 * or a newly landed unit therefore cannot silently drop coverage. Scan roots
 * must exist and yield at least one source file.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// ── Registry ───────────────────────────────────────────────────────────────

export type SensorRule =
  | "a-kernel-boundary"
  | "b-import-time-env"
  | "c-bun-api"
  | "d1-kernel-purity"
  | "d2-no-adhoc-fs"
  | "e-time-ban"
  | "anti-vacuity";

export interface Finding {
  readonly rule: SensorRule;
  /** Repo-relative POSIX path, or the registry entry id for anti-vacuity findings. */
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export type ProtectedRule = "d1" | "d2" | "e";

export interface ProtectedClass {
  readonly id: string;
  /** Repo-relative POSIX path. */
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly rules: readonly ProtectedRule[];
  /**
   * `pending` means "this unit has not landed yet". The sensor asserts the
   * status against the filesystem, so the unit that creates the file must
   * promote it to `present` in the same change.
   */
  readonly status: "present" | "pending";
}

/** The informational timestamp (§5.8) no decision path may read. */
const RECORDED_AT = "recordedAt";

/** Directories walked for the always-on rules (a, b, c). */
export const SCAN_ROOTS: readonly string[] = [
  "packages/kernel/src",
  "packages/conformance/src",
  "packages/cli/src",
  "packages/mcp/src",
  "packages/action/src",
  "scripts",
];

export const KERNEL_SRC = "packages/kernel/src";

/** The kernel's workspace specifier — its barrel, reachable without a relative path. */
export const KERNEL_PACKAGE = "@delivery-harness/kernel";

export const PROTECTED_CLASSES: readonly ProtectedClass[] = [
  { id: "kernel-validator", path: "packages/kernel/src/validator", kind: "dir", rules: ["d1", "e"], status: "pending" },
  { id: "kernel-evaluator", path: "packages/kernel/src/evaluator.ts", kind: "file", rules: ["d1", "e"], status: "pending" },
  { id: "kernel-context", path: "packages/kernel/src/context.ts", kind: "file", rules: ["d1"], status: "pending" },
  { id: "kernel-recorder", path: "packages/kernel/src/recorder.ts", kind: "file", rules: ["d2", "e"], status: "pending" },
  { id: "kernel-admission", path: "packages/kernel/src/admission.ts", kind: "file", rules: ["d2", "e"], status: "pending" },
  { id: "kernel-delivery-record", path: "packages/kernel/src/delivery-record.ts", kind: "file", rules: ["d2", "e"], status: "pending" },
  { id: "action-main", path: "packages/action/src/main.ts", kind: "file", rules: ["e"], status: "pending" },
];

/**
 * The fs/process/os specifier family banned by d1 and d2. `node:module` and
 * `module` are members because `createRequire` is an fs escape hatch;
 * `node:process` and `process` are members because a d1-pure module receives the
 * environment as a context snapshot and never imports the ambient process.
 */
export const FS_SPECIFIER_FAMILY: readonly string[] = [
  "node:fs",
  "node:fs/promises",
  "fs",
  "fs/promises",
  "node:child_process",
  "child_process",
  "node:os",
  "os",
  "node:module",
  "module",
  "node:process",
  "process",
];

/**
 * Kernel modules a d1-pure module may import by name. Everything else inside
 * the kernel is reachable only through a `*.types.ts` seam, so a pure module
 * cannot acquire fs transitively.
 */
export const D1_KERNEL_ALLOWLIST: readonly string[] = [
  "canonical.ts",
  "digest.ts",
  "blockers.ts",
  "config.ts",
  "context.ts",
];

/** Packages the kernel must never import from (rule a). */
const FORBIDDEN_KERNEL_PACKAGES: readonly string[] = ["cli", "mcp", "action"];

// ── Public API ─────────────────────────────────────────────────────────────

export interface SensorInput {
  /** Absolute path to the tree to scan. Fixtures pass a temp dir. */
  readonly root: string;
  readonly scanRoots?: readonly string[];
  readonly protectedClasses?: readonly ProtectedClass[];
  readonly kernelSrc?: string;
}

export interface SensorResult {
  readonly findings: readonly Finding[];
  readonly filesScanned: number;
  readonly scanRootFileCounts: Readonly<Record<string, number>>;
}

export function runImportBoundarySensor(input: SensorInput): SensorResult {
  const root = input.root;
  const scanRoots = input.scanRoots ?? SCAN_ROOTS;
  const protectedClasses = input.protectedClasses ?? PROTECTED_CLASSES;
  const kernelSrc = input.kernelSrc ?? KERNEL_SRC;

  const findings: Finding[] = [];
  const scanRootFileCounts: Record<string, number> = {};

  // Anti-vacuity: every scan root exists and is non-empty.
  const files: string[] = [];
  for (const scanRoot of scanRoots) {
    const abs = path.join(root, scanRoot);
    if (!existsSync(abs)) {
      scanRootFileCounts[scanRoot] = 0;
      findings.push({
        rule: "anti-vacuity",
        file: scanRoot,
        line: 0,
        message: `scan root does not exist; the sensor would vacuously pass over it`,
      });
      continue;
    }
    const found = collectSourceFiles(abs).map((f) => toPosix(path.relative(root, f)));
    scanRootFileCounts[scanRoot] = found.length;
    if (found.length === 0) {
      findings.push({
        rule: "anti-vacuity",
        file: scanRoot,
        line: 0,
        message: `scan root contains no TypeScript source files; the sensor would vacuously pass over it`,
      });
    }
    files.push(...found);
  }

  // Anti-vacuity: the protected-class registry matches the filesystem.
  for (const entry of protectedClasses) {
    const exists = existsSync(path.join(root, entry.path));
    if (entry.status === "present" && !exists) {
      findings.push({
        rule: "anti-vacuity",
        file: entry.path,
        line: 0,
        message: `protected class "${entry.id}" is registered as present but does not exist; a rename must update PROTECTED_CLASSES, never drop it`,
      });
    }
    if (entry.status === "pending" && exists) {
      findings.push({
        rule: "anti-vacuity",
        file: entry.path,
        line: 0,
        message: `protected class "${entry.id}" now exists but is still registered as pending; set status to "present" so rules ${entry.rules.join("/")} are enforced against it`,
      });
    }
    if (entry.status === "present" && exists && entry.kind === "dir") {
      // `*.test.ts` files are outside the d1/d2/e scans, so a directory holding
      // only tests carries no enforced file at all.
      const scanned = collectSourceFiles(path.join(root, entry.path)).filter((f) => !f.endsWith(".test.ts"));
      if (scanned.length === 0) {
        findings.push({
          rule: "anti-vacuity",
          file: entry.path,
          line: 0,
          message: `protected class "${entry.id}" contains no non-test TypeScript source files; rules ${entry.rules.join("/")} would vacuously pass over it`,
        });
      }
    }
  }

  const activeClasses = protectedClasses.filter((c) => c.status === "present");

  for (const relFile of files.sort()) {
    const absFile = path.join(root, relFile);
    const text = readFileSync(absFile, "utf8");
    const source = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
    const isTest = relFile.endsWith(".test.ts");

    const imports = collectImports(source);
    const emit = (rule: SensorRule, node: ts.Node, message: string): void => {
      findings.push({ rule, file: relFile, line: lineOf(source, node), message });
    };

    // Rule a — kernel boundary. Applies to every kernel file, tests included.
    if (isUnder(relFile, kernelSrc)) {
      checkKernelBoundary(relFile, kernelSrc, imports, emit);
    }

    // Rule b — no import-time process.env read.
    checkImportTimeEnv(source, emit);

    // Rule c — no Bun.* API.
    checkBunApi(source, emit);

    if (isTest) continue;

    const rules = rulesFor(relFile, activeClasses);

    if (rules.has("d1")) {
      checkD1(relFile, kernelSrc, imports, root, hasSiblingAllowance(relFile, activeClasses), emit);
    }
    if (rules.has("d2")) {
      checkFsFamily(imports, "d2-no-adhoc-fs", "filesystem work must go through the artifacts.ts port, not a direct import", emit);
    }
    if (rules.has("e")) {
      checkTimeBan(source, emit);
    }
  }

  return {
    findings,
    filesScanned: files.length,
    scanRootFileCounts,
  };
}

// ── Rule a ─────────────────────────────────────────────────────────────────

function checkKernelBoundary(
  relFile: string,
  kernelSrc: string,
  imports: readonly ImportEdge[],
  emit: (rule: SensorRule, node: ts.Node, message: string) => void,
): void {
  for (const edge of imports) {
    const spec = edge.specifier;

    for (const pkg of FORBIDDEN_KERNEL_PACKAGES) {
      if (spec === `@delivery-harness/${pkg}` || spec.startsWith(`@delivery-harness/${pkg}/`)) {
        emit("a-kernel-boundary", edge.node, `kernel imports "${spec}"; the kernel must not depend on the ${pkg} package`);
      }
    }

    if (spec.startsWith(".")) {
      const resolvedRel = toPosix(path.normalize(path.join(path.dirname(relFile), spec)));
      for (const pkg of FORBIDDEN_KERNEL_PACKAGES) {
        if (isUnder(resolvedRel, `packages/${pkg}/`) || resolvedRel.startsWith(`packages/${pkg}/`)) {
          emit("a-kernel-boundary", edge.node, `kernel imports "${spec}" which resolves into packages/${pkg}; the kernel must not depend on the ${pkg} package`);
        }
      }
    }

    if (isHarnessConfigSpecifier(spec)) {
      emit(
        "a-kernel-boundary",
        edge.node,
        `kernel imports "${spec}"; config is an explicit parameter (defineHarnessConfig), never an ambient module the kernel reaches for`,
      );
    }
  }
}

function isHarnessConfigSpecifier(spec: string): boolean {
  const base = spec.split("/").pop() ?? spec;
  return /^harness\.config(\.[cm]?[jt]s)?$/.test(base);
}

// ── Rule b ─────────────────────────────────────────────────────────────────

type ProcessBinding = "process" | "env";

function checkImportTimeEnv(source: ts.SourceFile, emit: (rule: SensorRule, node: ts.Node, message: string) => void): void {
  const aliases = new Map<string, ProcessBinding>();

  // `import process from "node:process"` / `import { env } from "node:process"`.
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const spec = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
    if (spec !== "node:process" && spec !== "process") continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name) aliases.set(clause.name.text, "process");
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) aliases.set(bindings.name.text, "process");
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const imported = (element.propertyName ?? element.name).text;
        if (imported === "env") {
          aliases.set(element.name.text, "env");
          emit("b-import-time-env", element, `imports \`env\` from "${spec}", which binds \`process.env\` while this module is evaluated; read the environment inside a function instead`);
        }
        if (imported === "default") aliases.set(element.name.text, "process");
      }
    }
  }

  const resolve = (node: ts.Expression): ProcessBinding | "unresolvable" | undefined => {
    const expr = unwrap(node);
    if (ts.isIdentifier(expr)) {
      if (expr.text === "process") return "process";
      return aliases.get(expr.text);
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const base = resolve(expr.expression);
      if (base === "unresolvable") return "unresolvable";
      if (base === "process" && expr.name.text === "env") return "env";
      if (isGlobalThis(expr.expression) && expr.name.text === "process") return "process";
      return undefined;
    }
    if (ts.isElementAccessExpression(expr)) {
      const arg = unwrap(expr.argumentExpression);
      const literal = ts.isStringLiteralLike(arg) ? arg.text : undefined;
      const base = resolve(expr.expression);
      const baseIsGlobal = isGlobalThis(expr.expression);
      if (literal === undefined) {
        // A computed key on `process`, on an alias of it, or on `globalThis`
        // cannot be decided statically. Report, never skip.
        if (base !== undefined || baseIsGlobal) return "unresolvable";
        return undefined;
      }
      if (base === "unresolvable") return "unresolvable";
      if (base === "process" && literal === "env") return "env";
      if (baseIsGlobal && literal === "process") return "process";
      return undefined;
    }
    return undefined;
  };

  // Top-level aliases, resolved to a fixed point over statement order.
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      const init = decl.initializer;
      if (init === undefined) continue;
      const resolved = resolve(init);
      if (ts.isIdentifier(decl.name)) {
        if (resolved === "process" || resolved === "env") {
          aliases.set(decl.name.text, resolved);
          continue;
        }
      }
      if (ts.isObjectBindingPattern(decl.name) && resolve(init) === "process") {
        for (const element of decl.name.elements) {
          if (element.dotDotDotToken !== undefined) {
            // `const { ...proc } = process` — the rest binding still carries
            // `env`, so it is an alias of `process`, not a skip.
            if (ts.isIdentifier(element.name)) {
              aliases.set(element.name.text, "process");
            } else {
              emit(
                "b-import-time-env",
                element,
                `rest element of a \`process\` destructuring that this sensor cannot resolve; unresolvable constructs are findings, not skips`,
              );
            }
            continue;
          }
          const propertyName = element.propertyName;
          const sourceName = propertyName && ts.isIdentifier(propertyName) ? propertyName.text : ts.isIdentifier(element.name) ? element.name.text : undefined;
          if (sourceName === "env") {
            // A nested pattern (`const { env: { CI } } = process`) binds no
            // alias but has already read `process.env` at import time.
            if (ts.isIdentifier(element.name)) aliases.set(element.name.text, "env");
            emit("b-import-time-env", element, `destructures \`env\` off \`process\` at import time; move the read inside a function`);
          }
        }
        continue;
      }
    }
  }

  const reported = new Set<number>();
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const entersFunction = inFunction || isFunctionLike(node);

    if (!entersFunction && isMemberAccess(node) && !reported.has(node.getStart(source))) {
      const resolved = resolve(node);
      if (resolved === "env") {
        reported.add(node.getStart(source));
        emit("b-import-time-env", node, `\`process.env\` is read while this module is evaluated; config is an explicit parameter — move the read inside a function`);
      } else if (resolved === "unresolvable") {
        reported.add(node.getStart(source));
        emit(
          "b-import-time-env",
          node,
          `dynamic access to \`process\`/\`process.env\` at import time that this sensor cannot resolve; unresolvable constructs are findings, not skips`,
        );
      }
    }

    ts.forEachChild(node, (child) => visit(child, entersFunction));
  };
  ts.forEachChild(source, (child) => visit(child, false));
}

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/**
 * Only member accesses are resolved in the walk. A bare identifier is never a
 * fresh `process.env` read — the read happened where the binding was created,
 * and that site is checked separately — and resolving bare identifiers would
 * misfire on every unrelated `.env` property name in the tree.
 */
function isMemberAccess(node: ts.Node): node is MemberAccess {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

/**
 * Import-time is "not lexically inside a function body". Class property
 * initializers are deliberately treated as import-time: fail closed rather than
 * reason about instantiation order.
 */
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

// ── Rule c ─────────────────────────────────────────────────────────────────

function checkBunApi(source: ts.SourceFile, emit: (rule: SensorRule, node: ts.Node, message: string) => void): void {
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isBunBase(node.expression)) {
      emit("c-bun-api", node, `\`Bun.${node.name.getText(source)}\` is a Bun-only API; Bun is a supported runtime, never a required one — use the node: equivalent`);
    }
    if (ts.isElementAccessExpression(node) && isBunBase(node.expression)) {
      emit("c-bun-api", node, `Bun-only API accessed via computed member; Bun is a supported runtime, never a required one — use the node: equivalent`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function isBunBase(node: ts.Expression): boolean {
  const expr = unwrap(node);
  if (ts.isIdentifier(expr)) return expr.text === "Bun";
  if (ts.isPropertyAccessExpression(expr)) return isGlobalThis(expr.expression) && expr.name.text === "Bun";
  return false;
}

// ── Rules d1 / d2 ──────────────────────────────────────────────────────────

function checkFsFamily(
  imports: readonly ImportEdge[],
  rule: SensorRule,
  why: string,
  emit: (rule: SensorRule, node: ts.Node, message: string) => void,
): void {
  for (const edge of imports) {
    if (edge.typeOnly) continue;
    if (FS_SPECIFIER_FAMILY.includes(edge.specifier)) {
      emit(rule, edge.node, `imports "${edge.specifier}"; ${why}`);
    }
  }
}

function checkD1(
  relFile: string,
  kernelSrc: string,
  imports: readonly ImportEdge[],
  root: string,
  hasSiblingAllowance: boolean,
  emit: (rule: SensorRule, node: ts.Node, message: string) => void,
): void {
  checkFsFamily(imports, "d1-kernel-purity", "this module is pure by contract and performs no I/O", emit);

  const importerDir = path.posix.dirname(relFile);

  for (const edge of imports) {
    if (edge.typeOnly) continue;

    // The workspace barrel re-exports the whole kernel, so it is a kernel-internal
    // import that no allowlist entry names — reaching it would acquire fs
    // transitively.
    if (edge.specifier === KERNEL_PACKAGE || edge.specifier.startsWith(`${KERNEL_PACKAGE}/`)) {
      emit(
        "d1-kernel-purity",
        edge.node,
        `imports "${edge.specifier}"; the kernel barrel is not on the d1 allowlist — a d1-pure module may reach only *.types.ts or ${D1_KERNEL_ALLOWLIST.join(", ")} by relative path`,
      );
      continue;
    }

    if (!edge.specifier.startsWith(".")) continue;

    const resolved = resolveRelativeImport(root, relFile, edge.specifier);
    if (resolved === undefined) {
      emit(
        "d1-kernel-purity",
        edge.node,
        `relative import "${edge.specifier}" does not resolve to a source file; an unresolvable edge cannot be proven pure`,
      );
      continue;
    }
    if (!isUnder(resolved, kernelSrc)) continue;

    const kernelRel = toPosix(path.posix.relative(kernelSrc, resolved));
    const base = path.posix.basename(resolved);
    const allowed =
      base.endsWith(".types.ts") ||
      D1_KERNEL_ALLOWLIST.includes(kernelRel) ||
      (hasSiblingAllowance && path.posix.dirname(resolved) === importerDir);

    if (!allowed) {
      const allowance = hasSiblingAllowance
        ? `, or a sibling inside ${importerDir}`
        : ` (no sibling allowance outside the validator/ class)`;
      emit(
        "d1-kernel-purity",
        edge.node,
        `imports kernel module "${kernelRel}"; a d1-pure module may import only *.types.ts or ${D1_KERNEL_ALLOWLIST.join(", ")}${allowance}`,
      );
    }
  }
}

// ── Rule e ─────────────────────────────────────────────────────────────────

function checkTimeBan(source: ts.SourceFile, emit: (rule: SensorRule, node: ts.Node, message: string) => void): void {
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && node.name.text === "now") {
      emit("e-time-ban", node, `\`Date.now()\` in a decision path; GEN-5 forbids any admissibility or freshness decision from consulting a clock`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
      emit("e-time-ban", node, `\`new Date()\` in a decision path; GEN-5 forbids any admissibility or freshness decision from consulting a clock`);
    }
    // `recordedAt` is informational (§5.8). Only member reads are banned — a
    // locally-scoped binding of that name carries no manifest timestamp.
    if (ts.isPropertyAccessExpression(node) && node.name.text === RECORDED_AT) {
      emit("e-time-ban", node, `reads \`.${RECORDED_AT}\` in a decision path; GEN-5 forbids any admissibility or freshness decision from depending on it`);
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = unwrap(node.argumentExpression);
      if (ts.isStringLiteralLike(arg) && arg.text === RECORDED_AT) {
        emit("e-time-ban", node, `reads \`["${RECORDED_AT}"]\` in a decision path; GEN-5 forbids any admissibility or freshness decision from depending on it`);
      }
    }
    if (ts.isBindingElement(node)) {
      const member = node.propertyName ?? node.name;
      if (ts.isIdentifier(member) && member.text === RECORDED_AT) {
        emit("e-time-ban", node, `destructures \`${RECORDED_AT}\` in a decision path; GEN-5 forbids any admissibility or freshness decision from depending on it`);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

// ── Import extraction ──────────────────────────────────────────────────────

interface ImportEdge {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly node: ts.Node;
}

function collectImports(source: ts.SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyImport(node), node });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, node });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const ref = node.moduleReference.expression;
      if (ts.isStringLiteral(ref)) edges.push({ specifier: ref.text, typeOnly: false, node });
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const first = node.arguments[0];
      if ((isDynamicImport || isRequire) && first !== undefined && ts.isStringLiteralLike(first)) {
        edges.push({ specifier: first.text, typeOnly: false, node });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return edges;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false; // bare side-effect import: a runtime edge
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function rulesFor(relFile: string, activeClasses: readonly ProtectedClass[]): Set<ProtectedRule> {
  const rules = new Set<ProtectedRule>();
  for (const entry of activeClasses) {
    const matches = entry.kind === "file" ? relFile === entry.path : isUnder(relFile, entry.path);
    if (matches) for (const rule of entry.rules) rules.add(rule);
  }
  return rules;
}

/**
 * The d1 sibling allowance belongs to the `validator/` dir class only. Any other
 * kernel subdirectory gets the same allowlist as the kernel root.
 */
function hasSiblingAllowance(relFile: string, activeClasses: readonly ProtectedClass[]): boolean {
  return activeClasses.some(
    (entry) =>
      entry.kind === "dir" &&
      entry.rules.includes("d1") &&
      path.posix.basename(entry.path) === "validator" &&
      isUnder(relFile, entry.path),
  );
}

function resolveRelativeImport(root: string, relFile: string, specifier: string): string | undefined {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(relFile), specifier));
  const candidates = [
    joined.replace(/\.js$/, ".ts"),
    joined.replace(/\.mjs$/, ".mts"),
    `${joined}.ts`,
    joined,
    path.posix.join(joined, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (!candidate.endsWith(".ts") && !candidate.endsWith(".mts")) continue;
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return undefined;
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      out.push(...collectSourceFiles(abs));
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.(ts|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}

function isUnder(relPath: string, dir: string): boolean {
  const normalized = dir.endsWith("/") ? dir : `${dir}/`;
  return relPath.startsWith(normalized);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isGlobalThis(node: ts.Expression): boolean {
  const expr = unwrap(node);
  return ts.isIdentifier(expr) && expr.text === "globalThis";
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `  ${f.rule}  ${f.file}:${f.line}\n      ${f.message}`).join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function main(): void {
  const root = repoRootFromHere();
  const result = runImportBoundarySensor({ root });
  const roots = Object.entries(result.scanRootFileCounts)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");

  if (result.findings.length === 0) {
    process.stdout.write(`check-import-boundaries: clean (${result.filesScanned} files; ${roots})\n`);
    return;
  }
  process.stderr.write(`check-import-boundaries: ${result.findings.length} finding(s) (${result.filesScanned} files; ${roots})\n`);
  process.stderr.write(`${formatFindings(result.findings)}\n`);
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main();
