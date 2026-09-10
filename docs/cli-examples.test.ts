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

it("recognizes installed Python launcher commands without a bare-harness prose match", () => {
  expect(harnessInvocations("python3 -B /repo/.agent-skills/current --root /repo harness runs show2 <id> --json"))
    .toEqual([{ command: "runs", subcommand: "show2", flags: ["--json"] }]);
  expect(harnessInvocations("python -B product.zip --root /repo harness prepare --invented2"))
    .toEqual([{ command: "prepare", flags: ["--invented2"] }]);
  expect(harnessInvocations("The harness prepares candidates.")).toEqual([]);
});

it.each([";", "&&", "||", "|", "&"])("enumerates both commands separated by %s", separator => {
  expect(harnessInvocations(`delivery-harness review-context --json ${separator} npm run harness -- runs list`))
    .toEqual([
      { command: "review-context", flags: ["--json"] },
      { command: "runs", subcommand: "list", flags: [] },
    ]);
});

it("retains an invalid later command for registry refusal", () => {
  expect(harnessInvocations("delivery-harness prepare; delivery-harness deploy"))
    .toEqual([{ command: "prepare", flags: [] }, { command: "deploy", flags: [] }]);
});

it.each(["'x; delivery-harness deploy'", '"x; delivery-harness deploy"', "x\\; delivery-harness deploy"])(
  "keeps quoted or escaped separators in argument text: %s", argument => {
    expect(harnessInvocations(`delivery-harness record --retention-scope ${argument}; delivery-harness verify`))
      .toEqual([{ command: "record", flags: ["--retention-scope"] }, { command: "verify", flags: [] }]);
  },
);

it("enumerates a continued Python command after a shell operator", () => {
  expect(harnessInvocations("delivery-harness prepare && \\\n python3 -B /repo/.agent-skills/current --root /repo harness runs list --json"))
    .toEqual([{ command: "prepare", flags: [] }, { command: "runs", subcommand: "list", flags: ["--json"] }]);
});

it("does not turn shell comment text into a later invocation", () => {
  expect(harnessInvocations("delivery-harness prepare # explanation; delivery-harness deploy"))
    .toEqual([{ command: "prepare", flags: [] }]);
});
