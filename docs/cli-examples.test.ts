import { describe, expect, it } from "vitest";
import { commandFlags, harnessInvocations, runSubcommands } from "./cli-examples.js";

describe("documented CLI tokens", () => {
  it.each(["--manifest2", "--manifestExtra", "--Manifest", "--manifest_extra", "--manifest.foo"])(
    "preserves the complete flag %s for registry validation", flag => {
      const known = commandFlags([{ name: "prepare", usage: "prepare [--manifest <path>]" }]);
      const invocation = harnessInvocations(`delivery-harness prepare ${flag}=input.json`)[0]!;
      expect(invocation.flags).toEqual([flag]);
      expect(invocation.flags.filter(value => !known.has(value))).toEqual([flag]);
      expect(commandFlags([{ name: "example", usage: `example [${flag} <value>]` }])).toEqual(new Set(["--help", flag]));
    },
  );

  it("separates usage delimiters and values without treating embedded double hyphens as flags", () => {
    expect(commandFlags([{ name: "prepare", usage: "prepare [--manifest=<path>] [--json] | --help" }]))
      .toEqual(new Set(["--help", "--manifest", "--json"]));
    expect(harnessInvocations("npm run harness -- prepare \\\n  --manifest=input.json --json; echo prefix--fake")[0])
      .toEqual({ command: "prepare", flags: ["--manifest", "--json"] });
  });

  it.each(["record2", "recordExtra", "Record", "record_extra", "record.foo", "record=extra"])(
    "preserves the complete command %s", command => {
      expect(harnessInvocations(`delivery-harness ${command} --help`)[0])
        .toEqual({ command, flags: ["--help"] });
    },
  );

  it.each(["show2", "showExtra", "Show", "show_extra", "show.foo", "show=extra"])(
    "preserves the complete subcommand %s in invocations and registry usage", subcommand => {
      expect(harnessInvocations(`delivery-harness runs ${subcommand} --json`)[0])
        .toEqual({ command: "runs", subcommand, flags: ["--json"] });
      expect(runSubcommands([{ name: "runs", usage: `delivery-harness runs ${subcommand} <id>\nruns list` }]))
        .toEqual(new Set([subcommand, "list"]));
    },
  );
});
