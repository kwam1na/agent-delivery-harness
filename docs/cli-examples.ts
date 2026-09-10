/** The command registry is the source for documented flags and runs subcommands. */
export interface CommandUsage {
  readonly name: string;
  readonly usage: string;
}

export function commandFlags(commands: readonly CommandUsage[]): ReadonlySet<string> {
  return new Set(["--help", ...commands.flatMap(command => [...command.usage.matchAll(/--[a-z][a-z-]*/g)].map(match => match[0]))]);
}

export function runSubcommands(commands: readonly CommandUsage[]): ReadonlySet<string> {
  const usage = commands.find(command => command.name === "runs")?.usage ?? "";
  return new Set([...usage.matchAll(/(?:delivery-harness )?runs ([a-z-]+)/g)].map(match => match[1]!));
}

/** Read explicit CLI invocations; shell continuations belong to the same command. */
export function harnessInvocations(markdown: string): readonly {
  command: string;
  flags: readonly string[];
  subcommand?: string;
}[] {
  const joined = markdown.replace(/\\\r?\n\s*/g, " ");
  return [...joined.matchAll(/(?:\bharness -- |\bdelivery-harness )([a-z][a-z-]*)([^\n`]*)/g)].map(match => {
    const args = match[2]!;
    const subcommand = /^\s+([a-z][a-z-]*)\b/.exec(args)?.[1];
    return { command: match[1]!, flags: [...args.matchAll(/--[a-z][a-z-]*/g)].map(flag => flag[0]),
      ...(subcommand === undefined ? {} : { subcommand }) };
  });
}
