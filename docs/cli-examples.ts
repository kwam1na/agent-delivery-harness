/** The command registry is the source for documented flags and runs subcommands. */
export interface CommandUsage {
  readonly name: string;
  readonly usage: string;
}

/** Preserve invalid spelling for the caller to reject; only syntax delimits a token. */
function flagsIn(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s`"'([{},;|&])(--[^\s`"'=<>()[\]{},;|&]+)/g)].map(match => match[1]!);
}

export function commandFlags(commands: readonly CommandUsage[]): ReadonlySet<string> {
  return new Set(["--help", ...commands.flatMap(command => flagsIn(command.usage))]);
}

export function runSubcommands(commands: readonly CommandUsage[]): ReadonlySet<string> {
  const usage = commands.find(command => command.name === "runs")?.usage ?? "";
  return new Set([...usage.matchAll(/\bruns ([^\s`"'<>()[\]{},;|&]+)/g)].map(match => match[1]!));
}

/** Read explicit CLI invocations; shell continuations belong to the same command. */
export function harnessInvocations(markdown: string): readonly {
  command: string;
  flags: readonly string[];
  subcommand?: string;
}[] {
  const joined = markdown.replace(/\\\r?\n\s*/g, " ");
  return [...joined.matchAll(/(?:\bharness -- |\bdelivery-harness )([^\s`"'<>()[\]{},;|&]+)([^\n`]*)/g)].map(match => {
    const args = match[2]!;
    const firstArg = /^\s+([^\s`"'<>()[\]{},;|&]+)/.exec(args)?.[1];
    const subcommand = firstArg?.startsWith("-") ? undefined : firstArg;
    return { command: match[1]!, flags: flagsIn(args),
      ...(subcommand === undefined ? {} : { subcommand }) };
  });
}
