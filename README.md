# timbrado

`timbrado` runs your own gates against the heads, nightlies, nexts and
canaries of what you depend on, watches for the upstream fixes you are
waiting on, and tells you what a pin adopts before you move it. It proposes
nothing: no pin is written, no PR is opened, and it holds no credential
beyond a GitHub token for reading.

Dependabot and Renovate move you between releases. The interesting weeks are
the ones before the release, when a regression in a runtime or a bundler is
one `main` commit and can still be fixed, and when the fix you filed is one
`main` commit and has not reached a version you can install. This is the same
gates, a few weeks earlier, against builds that can still change.

The first honest thing it tells you is which dependencies have a head at all.
Measured on one repository's 12 direct dependencies
(`timbrado survey package.json`, 2026-09-15):

| package | live dist-tags | pkg.pr.new | rolling tag |
|---|---|---|---|
| playwright-core | `next 1.64.0-alpha-2026-09-15` (2 stale) | no | - |
| typescript | `next 7.1.0-dev.20260915.1` (5 stale) | no | - |
| wrangler | - (2 stale) | **yes** | - |
| the other nine | - | no | - |

**3 of 12.** A registry keeps every tag forever, so `dev 3.9.4` on typescript
and `rc 1.18.0` on playwright are archaeology and the survey counts only tags
that point past `latest`. The nine with no channel are the rows to read: their
next release is the first you will hear of them.

## The verbs

```bash
timbrado survey [package.json]                          # which dependencies have a head
timbrado resolve <target> [--registry timbrado.json]    # the exact candidate a target names today
timbrado fetch <target> --into <dir>                    # a runtime's binary, sha512 checked against the registry
timbrado try <target> --gate "<cmd>"                    # install it into an isolated checkout of HEAD, run YOUR gate
timbrado digest --repo o/r --from <sha> --to <sha>      # what the range adopts: changesets, then commit subjects
timbrado watch --pinned <exe> --candidate <exe>         # the fixes you wait on, read under both runtimes
timbrado report --target <name> --json report.json     # at most one open issue per target, kept quiet
```

Exit codes everywhere: 0 green or nothing to do, 1 a finding, 2 the instrument
could not run. A leg that cannot measure files nothing and reds its own job,
because "the runner had no unzip" is not a finding about the upstream.

### `resolve`: every channel lands on one shape

There is no one prerelease channel, which is the whole reason this is a
tool. Four kinds are implemented, each measured against the upstream it was
written for (`registry/known.json`):

| kind | example | pinnable | how |
|---|---|---|---|
| `npm-dist-tag` | typescript `next`, playwright-core `next` | yes | exact version from `dist-tags` |
| `npm-dated-canary` | bun `canary` | yes | dated immutable version; the build sha rides as `+sha` on the platform package; binary + sha512 from the registry |
| `pkg-pr-new` | wrangler, miniflare (`@main`, `@<sha>`, `@<PR>`) | yes, by sha | `x-commit-key` on a HEAD names the commit; the install spec always carries the sha |
| `github-rolling-tag` | bun's `canary` release | **no** | the asset's `updated_at` is the honest timestamp; instrument only |

```
$ timbrado resolve --registry registry/known.json
bun              1.4.2-canary.20260915.1+7e56b40          pinnable  5h old
wrangler         f2b3a6d                                  pinnable  2h old
                 pkg.pr.new wrangler@main -> f2b3a6d (the ref floats; the install spec names the sha)
bun-rolling      canary@2026-09-15T16:23:46Z              FLOATING  3h old
```

Age is printed because a candidate that resolves perfectly can still be
refused by your install policy: bun's `minimumReleaseAge`, pnpm's, Renovate's.
`try` reads bunfig and says so when a resolve failure looks like that, which
is what it looked like the day wrangler main moved to a workerd published nine
hours earlier.

### `try`: the tool owns the isolation, you own the verdict

A detached worktree in the temp directory, outside your repository so nothing
resolves from the parent's `node_modules`; a frozen install of what is
committed; the candidate added with the package manager your lockfile names;
your gate command. Removed in a `finally`.

```
$ timbrado try wrangler --gate "node tools/check-routes-harness.ts"
  ok   frozen bun install of HEAD — ok
  ok   add https://pkg.pr.new/cloudflare/workers-sdk/wrangler@f2b3a6d — installed
  ok   gate: node tools/check-routes-harness.ts — exit 0
```

A floating spec (`@main`, a dist-tag, a bare name) is refused unless you pass
`--allow-floating`, and there is no `pin` verb on purpose: a floating ref
records a sha512 in your lockfile that the next frozen install refuses the
morning the ref moves.

### `watch`: the fixes you are waiting on

A gate diffs a moving target against a pin. A watch is that inside out: a
probe that reads **false on your pinned toolchain today**, one per upstream
thread you opened, and the interesting night is the first true. Every entry
names the thread, what `landed` means, and the reading on the day it was
written, because a probe that reads true on its first run is watching nothing.

```ts
// timbrado.watches.ts
export const watches = [{
  name: "fetch-honours-dispatcher",
  issue: "https://github.com/oven-sh/bun/issues/39247",
  landed: "fetch(url, { dispatcher }) calls dispatch() under bun",
  measured: "2026-09-15, bun 1.4.2: dispatch() never called",
  runtime: "bun",
  script: `... console.log(JSON.stringify({ landed, detail }))`,
}];
```

Each watch is read under the pin and under the candidate. A row that differs
is the finding, with the direction in the signature (`watch:<name>:f>t`); a
row landed in both is the cue to retire it; a probe that crashes reads `did
not run` and moves nothing.

### `digest`: what a pin adopts

For a repository that commits changesets, the files added between two shas
are exactly the unreleased changelog, and the compare API returns them in one
request. Anything declaring a `major` bump is called out first. Without
changesets you get the commit subjects and how many are a bot's, which on
bun's main is most of them.

```
**What `982b806` carries that `b149147` did not** (5 commits)

4 changesets, which is the unreleased changelog:

- **wrangler** patch: Replace `execa` with `tinyexec` for running subprocesses...
- **miniflare** minor: Add production-compatible KV bulk write and delete routes to Local Explorer
```

### `report`: one issue per target, kept quiet

```
red or changed, no open issue      create it, with the tables and a signature
red or changed, issue already open comment ONLY if the signature is new
green, issue open                  comment "green again" and close it
green, nothing open                nothing
instrument                         no issue; the caller reds its own job
```

The signature is what failed or moved, never which build did it, so a fresh
head carrying yesterday's broken gate adds nothing.

## What it does not do

It does not decide what "breaking" means. Your test suite is the only honest
oracle for your project, and a changeset's bump level is the only cheap
pre-signal; `try` runs the first and `digest` shows the second. It does not
reach cargo or PyPI yet: cargo has git dependencies by rev and no prerelease
convention, PyPI has dev versions and nightly wheels with no uniform
discovery. npm is where the channels are, and the registry format is data so
the next kind is a resolver rather than a rewrite.

## Where it came from

The four scripts this was extracted from ran nightly on
[aadhar.sh](https://github.com/oddharsh/site) from 2026-09-14, against bun's
canary, wrangler's main and prerelease browsers, and they found things before
the tool existed: `margin-trim` live in Chrome Canary 155, JPEG XL decoding by
default in the same Canary, and a same-day workerd release that the site's
24-hour install window refused. `docs/measurements.md` has the numbers. The
name is the Spanish song canary, bred for its timbre.

## Conformance

`bun test` runs the offline suite; `TIMBRADO_LIVE=1 bun test` adds four
resolves against the real upstreams, so a recipe that rots fails by name.

MIT.
