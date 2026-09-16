# Experiments and opportunities

Timbrado 0.2 introduces a Rust measurement engine and an explicit baseline /
candidate comparison. This is the first migration slice. Rust owns process
supervision, probe parsing, comparisons, and declarative opportunities. The
existing TypeScript code owns upstream discovery, resolution, digest parsing,
Git worktree preparation, and GitHub issue reporting.

There is one execution path. The JavaScript `runWatch` and `tryCandidate`
functions call the same Rust engine as the native CLI. They do not contain a
second runner or silently fall back when the binary is unavailable.

## Command contract

`timbrado measure` reads one JSON request from stdin:

```json
{
  "schemaVersion": 1,
  "protocol": "probe",
  "command": {
    "argv": ["node", "/absolute/path/to/probe.mjs"],
    "timeoutMs": 60000
  }
}
```

`argv` invokes an executable directly. To use shell syntax, explicitly name
`/bin/sh` and `-c`. `cwd` is optional and defaults to a fresh temporary
directory, removed after the command. `env` is an optional map of environment
overrides. Environment overrides are not copied into result JSON.

Commands inherit the caller's environment and permissions. Scratch directories
and Git worktrees isolate ordinary file state, not access to the filesystem,
network, credentials, or external services. Run untrusted upstream code in a
separately provisioned sandbox or CI job. Timbrado does not provide that boundary.

The `probe` protocol requires exit 0 and exactly one JSON object on stdout:

```json
{
  "landed": true,
  "detail": "The observed behavior that passed",
  "evidence": { "browserVersion": "the version actually tested" }
}
```

`landed` must be a boolean. `detail` must be a nonempty string. `evidence` is
optional JSON supplied by the probe; it is a measurement record, not an
attestation. Logs belong on stderr. Extra stdout, invalid JSON, signals,
timeouts, and nonzero probe exits produce a null value, even if valid JSON
was printed before the failure.

The `exit-code` protocol treats exit 0 as true and ordinary nonzero exit as
false. Exit 126/127, signals, spawn failures, and timeouts are unmeasured.
This protocol measures test gates; it does not parse their output.

Each result records argv, exit status, elapsed time, detail, bounded stdout
and stderr, and probe evidence. Each stream retains at most 64 KiB while
continuing to drain the pipe. Truncated probe stdout is inconclusive.
The supervisor terminates the process group on timeout and cleans up remaining
group members when the leader exits. It does not contain children that
deliberately detach into another session.

The response is `{ "schemaVersion": 1, "measurement": ... }`. Invalid request
schemas exit 2. A successfully executed `measure` protocol request exits 0
even for a null measurement; consumers must read the structured result.

## Experiment contract

`timbrado experiment` accepts:

```json
{
  "schemaVersion": 1,
  "name": "project-gate",
  "protocol": "exit-code",
  "baseline": {
    "id": "the baseline revision",
    "command": { "argv": ["/bin/sh", "-c", "npm test"], "cwd": "/baseline/checkout" }
  },
  "candidate": {
    "id": "the candidate revision",
    "command": { "argv": ["/bin/sh", "-c", "npm test"], "cwd": "/candidate/checkout" }
  }
}
```

Each subject can include `setup`, an array of command objects interpreted
using the exit-code protocol. A failed setup leaves that side unmeasured
and skips its gate. Setup commands needing shared files must explicitly use
the same `cwd`. The caller provisions independent directories; `try` does
this with two detached Git worktrees and a frozen install on each side.

The result contains both subjects, setup measurements, gate measurements,
observation time in Unix milliseconds, and one outcome:

| Baseline | Candidate | Outcome |
|---|---|---|
| true | true | unchanged |
| false | true | improvement |
| true | false | regression |
| false | false | blocked |
| null on either side | | instrument |

Subject IDs are caller-supplied labels. Use immutable candidate IDs from
`resolve` where available. Runtime probes should record the actual runtime
version in `evidence`, as the browser example does.

For project gates, blocked maps to an instrument report: the candidate did
not establish a change or a recovery. For capability opportunities, blocked
means pending and produces no finding. Any null measurement makes either
report an instrument failure, preserving existing issues until evidence is
complete. Signatures name the behavior and direction, excluding build IDs.

## Opportunity manifests

See [`examples/browser/opportunities.json`](../examples/browser/opportunities.json)
for a complete manifest. All entries are validated before any command runs.
Unknown fields, unsupported schema versions, duplicate names, empty adoption
conditions, and invalid commands are rejected.

An opportunity names its intention, affected repository-relative paths,
source URLs, what the probe verifies, and a human-owned adoption condition.
These are declarations; this slice does not infer affected code or evaluate
the support policy. It never edits the affected files.

In command arguments, `{manifest}` expands to the manifest's absolute parent
directory, so a probe file can be located while its working directory remains
disposable. Explicit relative `cwd` values are relative to that directory.

`observe` outputs a versioned report with existing `target`, `verdict`,
`signature`, and `subject` fields plus `opportunities`. Each finding retains
the experiment and gives a next step. Newly available behavior prompts
evaluation; behavior present in both subjects prompts review of whether the
watch is still needed. Neither state approves adoption.

`observe` exits 0 for no change, 1 for an observed change, and 2 for incomplete
measurement or invalid configuration. `--json path` also saves the report.
The existing `report` command understands these records, but observation never
posts them by itself.

## Migration and next boundaries

JavaScript exports and `.ts` watch modules remain supported. Execution now
requires a built Rust engine at `target/release/timbrado` inside the package,
or an absolute `TIMBRADO_BIN` path. Pure reporter and resolver imports need
no native executable. Git installs include source, so consumers must build
the engine explicitly; this version does not ship release binaries.

The example uses a project-owned Playwright probe to measure layout. Browser
discovery, browser installation, audience analytics, automatic workaround
discovery, competitor monitoring, and additional package ecosystems remain
future work. Each should feed this evidence contract before adding its own
decision logic.
