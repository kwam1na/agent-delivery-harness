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
