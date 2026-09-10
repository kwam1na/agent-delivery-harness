/** The command registry is the source for documented flags and runs subcommands. */
export interface CommandUsage {
  readonly name: string;
  readonly usage: string;
}

/** Preserve invalid spelling for the caller to reject; only syntax delimits a token. */
export function flagsIn(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s`"'([{},;|&])(--[^\s`"'=<>()[\]{},;|&]+)/g)].map(match => match[1]!);
}

export function commandFlags(commands: readonly CommandUsage[]): ReadonlySet<string> {
  return new Set(["--help", ...commands.flatMap(command => flagsIn(command.usage))]);
}

export function runSubcommands(commands: readonly CommandUsage[]): ReadonlySet<string> {
  const usage = commands.find(command => command.name === "runs")?.usage ?? "";
  return new Set([...usage.matchAll(/\bruns ([^\s`"'<>()[\]{},;|&]+)/g)].map(match => match[1]!));
}

/** Split unquoted shell operators, preserving quoted and escaped argument text. */
function shellStatements(line: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1]!))) {
      statements.push(line.slice(start, index));
      return statements;
    }
    if (character === ";" || character === "|" || character === "&") {
      statements.push(line.slice(start, index));
      start = index + 1;
    }
  }
  statements.push(line.slice(start));
  return statements;
}

/** Read explicit CLI invocations; shell continuations belong to the same command. */
export function harnessInvocations(markdown: string): readonly {
  command: string;
  flags: readonly string[];
  subcommand?: string;
}[] {
  const joined = markdown.replace(/\\\r?\n\s*/g, " ");
  return joined.split("\n").flatMap(shellStatements).flatMap(statement => [...statement.matchAll(/(?:\bharness -- |\bdelivery-harness |\bpython(?:3)?[ \t]+[^\n`]*?[ \t]harness[ \t]+)([^\s`"'<>()[\]{},;|&]+)([^\n`]*)/g)].map(match => {
    const args = match[2]!;
    const firstArg = /^\s+([^\s`"'<>()[\]{},;|&]+)/.exec(args)?.[1];
    const subcommand = firstArg?.startsWith("-") ? undefined : firstArg;
    return { command: match[1]!, flags: flagsIn(args),
      ...(subcommand === undefined ? {} : { subcommand }) };
  }));
}
