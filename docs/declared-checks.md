# Declared validation and artifact checks

The existing [provider contract](provider-guide.md) also supports declared checks. A provider can declare a bounded command instead of implementing the stdio provider protocol:

```ts
providers: [{
  id: "repo.validation",
  findingCodes: [],
  check: {
    command: ["npm", "run", "test"],
    timeoutMs: 300000,
    outputs: ["build/check-result.json"],
  },
}],
```

Connect it to an existing `exact_candidate` obligation accepting `checks.passed/1`, with `satisfied_evidence` allowed. Use the existing activation policy for thresholds and sensitive paths. `outputs` is optional; a typecheck can succeed solely by exiting zero. Commands execute directly as argv in the repository root. A provider cannot declare both `command` (stdio protocol) and `check`. Output paths must be unique repository-relative paths; escaping symlinks, non-files, missing files and files above 1 MiB block. There are at most 64 outputs and a timeout of at most one hour. Child stdout/stderr is bounded to 1 MiB and failure diagnostics to 4,000 characters.

`prepare` runs declared mechanical prerequisites. `gate` uses the existing provider-backed admission path: resolve active independent review before expensive checks, execute missing checks, construct their evidence, submit it through the existing manifest validator, and re-evaluate admission. A nonzero exit, spawn failure, timeout, cancellation, output failure or candidate/base/wiring mutation publishes no passing evidence. Parent flags and command output text do not declare success. Check execution is a self-attested observation of the actual child process; it does not claim a stronger signed trust profile.

The `checks.passed/1` payload is closed: `{verdict: "green", exitCode: 0, binding}`. The binding contains SHA-256 digests named `definitionDigest`, `validationDigest`, `policyDigest`, `wiringFingerprint` and `outputsDigest`. It covers the command definition, full resolved policy, runtime/preparation wiring, output bytes and the candidate's validation projection. Candidate/base/workspace fields remain in the existing manifest and evidence record.

Validation uses the existing tree identity algorithm with **record-neutral** exclusions. Review still uses **review-neutral** exclusions. A report or solution note can preserve review approval while requiring validation again. A record-neutral addition does not require repeated validation. Changing argv under the same provider id, policy, base, wiring or an output invalidates reuse. Live facts remain invocation-specific and cannot be satisfied by these records.

Each run retains `check-result.json` and one `check-output-N.json` artifact per output. Output snapshots contain the repository path and canonical base64 bytes, so binary output survives transport. The shared validator rehashes these bytes and checks the terminal outcome and full contextual binding. Portable verification supplies freshly computed `checkBindings`; omitting them blocks. The shared installed release reader binds `.agent-skills/active.json.release`, including explicit absence; a same-package-version release swap invalidates validation. `captureCheckBindings` accepts `readReleaseInputs(path)` and `readWiring(path)` for reading tracked wiring from the verified candidate tree and `readOutput(path, providerId)` for reading retained output bytes with `retainedCheckOutput`. Transported wiring must never replace current candidate wiring. Physical local admission reads current files itself.

Repository policy continues to declare its review lenses, mechanical commands, validation/artifact obligations and merge-admission live facts. This feature adds no scheduler, state engine, report format or repository sensor implementation.

## Scoped execution

A check that declares a `scope` runs in a private snapshot of the prepared tree under one of the `scopedExecution` profiles. Profiles that declare the same dependency setup — the same `dependencies` command, the same `dependencyInputs` and the same `gitContext` — share one snapshot, so that setup installs once and every check in those profiles runs against the same installed bytes. Each check may still write only its own profile's `mutableOutputs`: before a check runs, its declared outputs and every output path of the other sharing profiles are removed, and afterwards the snapshot is verified with only its own profile's outputs excluded, so a write to another profile's output is drift. One snapshot is live at a time; moving to a different setup discards the previous snapshot before the next is created.

`prepare` runs the first declared of the `mechanicalProviders` first, because that is where a selection guard that must precede every other check belongs. It runs the rest cheapest first. A check's cost is the duration of its most recent passed or failed attempt, less the dependency setup that attempt itself ran. Checks never timed run after timed ones, and ties keep declaration order, so a first `prepare` follows declaration order. Checks then run one dependency setup at a time, in the order each setup first appears in that sequence, so each setup installs once. The first failure stops preparation: no later check runs and no receipt is published.

A failed scoped check prints a failure report on standard output before its blocker: the failure code, the attempt id and the path of its retained `terminal.json`, the command that ran with its working directory — the profile's dependency command when setup failed — and its exit code with the last 40 lines of its output, after credential redaction. The same tail is kept in the retained attempt.

A passed attempt is reused, by `prepare` and by `gate`, whenever the check's current input digest and profile digest both equal the attempt's. Reuse is never extended past a changed digest, because the digest is what binds the pass to what the check could observe. Two things move the profile digest even when no declared input changed. Every profile binds the selected base ref, tip and merge base, so a moved base reruns every check. A `gitContext: "full"` profile also binds the original HEAD commit and the whole prepared tree, because such a check can read any file and the history; any new commit, including an unrelated one, reruns it. Declare `gitContext: "none"` for a check that reads only its declared files to keep its pass across unrelated commits. A check run with a present credential that has no declared nonsecret identity is not reused across candidates.
