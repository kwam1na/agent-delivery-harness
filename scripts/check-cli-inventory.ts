/**
 * CLI command-inventory sensor.
 *
 * The CLI's command registry (`COMMANDS` in `packages/cli/src/index.ts`) is the
 * single source of truth for which commands exist. This sensor holds that
 * registry honest against the filesystem, the same way the blocker-inventory
 * sensor Athena ships holds its generated-doc registry honest:
 *
 *   - Every command module under `commands/` must be registered. A command file
 *     that no registry entry references is a finding — filename discovery is the
 *     alarm, registration is the mechanism. A command nobody registered is a
 *     command nobody can run, and worse, a command no test drove.
 *   - Every registry entry must resolve to a command file that exists. A dangling
 *     registration — a rename that updated the import but not the file — is a
 *     finding.
 *   - The registry must be non-empty. A CLI whose registry is empty passes every
 *     "is each command registered" check vacuously; the sensor exists precisely
 *     to reject that, so an empty registry fails outright (anti-vacuity).
 *   - The scan root and the commands directory must exist and yield source. A
 *     sensor with nothing to scan is a sensor that cannot fail.
 *
 * Parsed with the TypeScript compiler API, never regex over source text: the
 * registry is read as an array-literal AST and its elements are resolved through
 * the file's own import bindings, so a comment or a string that merely mentions a
 * command name changes nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// ── Registry ─────────────────────────────────────────────────────────────────

export type CliInventoryRule =
  | "unregistered-command"
  | "dangling-registration"
  | "empty-registry"
  | "registry-unreadable"
  | "anti-vacuity";

export interface CliInventoryFinding {
  readonly rule: CliInventoryRule;
  /** Repo-relative POSIX path, or the registry id for structural findings. */
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface CliInventoryInput {
  /** Absolute path to the tree to scan. Fixtures pass a temp dir. */
  readonly root: string;
  /** The CLI source root scanned for anti-vacuity. */
  readonly cliSrc?: string;
  /** The directory whose `*.ts` files are the commands. */
  readonly commandsDir?: string;
  /** The module that declares the registry constant. */
  readonly registryFile?: string;
  /** The name of the registry constant to read. */
  readonly registryConst?: string;
}

export interface CliInventoryResult {
  readonly findings: readonly CliInventoryFinding[];
  readonly commandFiles: readonly string[];
  readonly registeredFiles: readonly string[];
}

export const CLI_SRC = "packages/cli/src";
export const CLI_COMMANDS_DIR = "packages/cli/src/commands";
export const CLI_REGISTRY_FILE = "packages/cli/src/index.ts";
export const CLI_REGISTRY_CONST = "COMMANDS";

// ── Public API ───────────────────────────────────────────────────────────────

export function runCliInventorySensor(input: CliInventoryInput): CliInventoryResult {
  const root = input.root;
  const cliSrc = input.cliSrc ?? CLI_SRC;
  const commandsDir = input.commandsDir ?? CLI_COMMANDS_DIR;
  const registryFile = input.registryFile ?? CLI_REGISTRY_FILE;
  const registryConst = input.registryConst ?? CLI_REGISTRY_CONST;

  const findings: CliInventoryFinding[] = [];

  // Anti-vacuity: the CLI source root exists and yields source.
  const cliSrcAbs = path.join(root, cliSrc);
  if (!existsSync(cliSrcAbs) || !statSync(cliSrcAbs).isDirectory()) {
    findings.push({
      rule: "anti-vacuity",
      file: cliSrc,
      line: 0,
      message: "the CLI source root does not exist; the sensor would vacuously pass",
    });
    return { findings, commandFiles: [], registeredFiles: [] };
  }
  if (collectSourceFiles(cliSrcAbs).length === 0) {
    findings.push({
      rule: "anti-vacuity",
      file: cliSrc,
      line: 0,
      message: "the CLI source root holds no TypeScript source; the sensor would vacuously pass",
    });
  }

  // Anti-vacuity: the commands directory exists and yields command files.
  const commandsAbs = path.join(root, commandsDir);
  const commandFiles: string[] =
    existsSync(commandsAbs) && statSync(commandsAbs).isDirectory()
      ? collectSourceFiles(commandsAbs)
          .filter((file) => !file.endsWith(".test.ts"))
          .map((file) => toPosix(path.relative(root, file)))
          .sort()
      : [];
  if (commandFiles.length === 0) {
    findings.push({
      rule: "anti-vacuity",
      file: commandsDir,
      line: 0,
      message: "no command modules found; a CLI with no commands is not a CLI",
    });
  }

  // Read the registry from the registry file's AST.
  const registryAbs = path.join(root, registryFile);
  if (!existsSync(registryAbs)) {
    findings.push({
      rule: "registry-unreadable",
      file: registryFile,
      line: 0,
      message: `the registry file does not exist; ${registryConst} cannot be read`,
    });
    return { findings, commandFiles, registeredFiles: [] };
  }

  const registered = readRegistry(root, registryFile, registryConst, findings);

  // Every registered entry must resolve to a command file that exists.
  const registeredFiles = new Set<string>();
  for (const entry of registered) {
    if (entry.resolved === undefined) {
      findings.push({
        rule: "dangling-registration",
        file: registryFile,
        line: entry.line,
        message: `${registryConst} registers "${entry.name}", whose import does not resolve to a command source file`,
      });
      continue;
    }
    registeredFiles.add(entry.resolved);
    if (!existsSync(path.join(root, entry.resolved))) {
      findings.push({
        rule: "dangling-registration",
        file: registryFile,
        line: entry.line,
        message: `${registryConst} registers "${entry.name}" from ${entry.resolved}, which does not exist`,
      });
    }
  }

  // Every command file must be registered.
  for (const file of commandFiles) {
    if (!registeredFiles.has(file)) {
      findings.push({
        rule: "unregistered-command",
        file,
        line: 0,
        message: `command module ${file} is not registered in ${registryConst}; add it or the sensor cannot see it`,
      });
    }
  }

  return { findings, commandFiles, registeredFiles: [...registeredFiles].sort() };
}

// ── Registry reading ─────────────────────────────────────────────────────────

interface RegisteredEntry {
  readonly name: string;
  /** Repo-relative POSIX path the entry's import resolves to, if any. */
  readonly resolved: string | undefined;
  readonly line: number;
}

function readRegistry(
  root: string,
  registryFile: string,
  registryConst: string,
  findings: CliInventoryFinding[],
): readonly RegisteredEntry[] {
  const abs = path.join(root, registryFile);
  const text = readFileSync(abs, "utf8");
  const source = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // Map every locally bound name to the module specifier it was imported from.
  const importSpecifierOf = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) importSpecifierOf.set(clause.name.text, specifier);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) importSpecifierOf.set(element.name.text, specifier);
    }
  }

  const registryInitializer = findRegistryInitializer(source, registryConst);
  if (registryInitializer === undefined) {
    findings.push({
      rule: "registry-unreadable",
      file: registryFile,
      line: 0,
      message: `no \`${registryConst}\` array-literal declaration found; the registry must be a directly readable array`,
    });
    return [];
  }

  if (registryInitializer.elements.length === 0) {
    findings.push({
      rule: "empty-registry",
      file: registryFile,
      line: lineOf(source, registryInitializer),
      message: `${registryConst} is empty; a CLI whose registry registers nothing passes every check vacuously`,
    });
    return [];
  }

  const entries: RegisteredEntry[] = [];
  const registryDir = path.posix.dirname(toPosix(registryFile));
  for (const element of registryInitializer.elements) {
    if (!ts.isIdentifier(element)) {
      findings.push({
        rule: "registry-unreadable",
        file: registryFile,
        line: lineOf(source, element),
        message: `${registryConst} holds an entry that is not a bare command identifier; the registry must list imported command descriptors`,
      });
      continue;
    }
    const specifier = importSpecifierOf.get(element.text);
    const resolved =
      specifier !== undefined && specifier.startsWith(".")
        ? resolveTsImport(root, registryDir, specifier)
        : undefined;
    entries.push({ name: element.text, resolved, line: lineOf(source, element) });
  }
  return entries;
}

function findRegistryInitializer(source: ts.SourceFile, registryConst: string): ts.ArrayLiteralExpression | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== registryConst) continue;
      let initializer = declaration.initializer;
      if (initializer === undefined) continue;
      // Unwrap `[...] as const` / `[...] satisfies T`.
      while (initializer !== undefined && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))) {
        initializer = initializer.expression;
      }
      if (initializer !== undefined && ts.isArrayLiteralExpression(initializer)) return initializer;
    }
  }
  return undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveTsImport(root: string, fromDir: string, specifier: string): string | undefined {
  const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [joined.replace(/\.js$/, ".ts"), `${joined}.ts`, joined, path.posix.join(joined, "index.ts")];
  for (const candidate of candidates) {
    if (!candidate.endsWith(".ts")) continue;
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

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function formatCliInventoryFindings(findings: readonly CliInventoryFinding[]): string {
  return findings.map((f) => `  ${f.rule}  ${f.file}:${f.line}\n      ${f.message}`).join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function main(): void {
  const root = repoRootFromHere();
  const result = runCliInventorySensor({ root });
  if (result.findings.length === 0) {
    process.stdout.write(
      `check-cli-inventory: clean (${result.commandFiles.length} command(s) registered)\n`,
    );
    return;
  }
  process.stderr.write(`check-cli-inventory: ${result.findings.length} finding(s)\n`);
  process.stderr.write(`${formatCliInventoryFindings(result.findings)}\n`);
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main();
