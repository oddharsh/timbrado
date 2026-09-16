# Measurements

Everything the README claims, with the date it was read.

## Rust opportunity runner (2026-09-16 UTC)

`target/release/timbrado observe examples/browser/opportunities.json` ran the
same layout probe in disposable profiles of the two installed browsers:

| subject | observed version | control height | trimmed height | trimmed top / bottom gaps | reading |
|---|---|---|---|---|---|
| Chrome Stable | 153.0.8010.37 | 60 px | 60 px | 20 / 30 px | false |
| Chrome Canary | 156.0.8060.2 | 60 px | 10 px | 0 / 0 px | true |

Both probes exited 0. The result was `improvement`, with report verdict
`changed` and signature `changed:opportunity:native-margin-trim:f>t`.
The report retained each browser version and geometry and left the project's
browser-support policy as a separate adoption condition. No feature-enabling
flags were requested by the probe; Playwright used its default launch options.

The first attempt inside the development filesystem sandbox could not launch
either browser. It returned null measurements, verdict `instrument`, and exit
2. The successful run used the permissions needed to launch the installed
browsers. Neither run changed a user browser profile or project CSS.

The eight Bun watches currently declared by aadhar.sh also ran through the
Rust engine under the installed Bun 1.4.2. All returned real boolean readings
(false), including the frozen oxc / SWC comparison at 5,843 / 5,786 bytes.
The site's dependency pin and source files were unchanged.

## Which dependencies have a head (2026-09-15)

`timbrado survey` on aadhar.sh's `package.json`, 12 direct dependencies:

| package | pinned | live dist-tags | stale tags | pkg.pr.new | rolling tag |
|---|---|---|---|---|---|
| @minify-html/node | 0.18.1 | - | 0 | no | - |
| @oxlint/plugins | 1.83.0 | - | 0 | no | - |
| @types/bun | 1.4.2 | - | 15 | no | - |
| htmlparser2 | 12.0.0 | - | 0 | no | - |
| lightningcss | 1.33.0 | - | 0 | no | - |
| oxc-minify | 0.150.0 | - | 0 | no | - |
| oxlint | 1.83.0 | - | 0 | no | - |
| oxlint-tsgolint | 7.0.2001 | - | 0 | ? (no repository field) | - |
| playwright-core | 1.63.0 | next 1.64.0-alpha-2026-09-15 | 2 | no | - |
| smol-toml | 1.8.0 | - | 0 | ? (no repository field) | - |
| typescript | 7.0.2 | next 7.1.0-dev.20260915.1 | 5 | no | - |
| wrangler | pkg.pr.new @982b806 | - | 2 | yes | - |

3 of 12. The first draft counted 4 by treating every non-`latest` dist-tag as
a head; `dev 3.9.4` on typescript is from 2020. A tag counts only when its
version parses past `latest`'s triple; a prerelease of the current release
(`beta 1.63.0-beta-…` on latest 1.63.0) does not.

bun itself is not in `package.json` on that site (its pin is in
`config/bun-pin.json`), so it is a registry entry rather than a survey row.

## Resolve (2026-09-15, 19:30Z)

| target | kind | id | pinnable | age |
|---|---|---|---|---|
| bun | npm-dated-canary | 1.4.2-canary.20260915.1+7e56b40 | yes | 5h |
| bun-rolling | github-rolling-tag | canary@2026-09-15T16:23:46Z | no | 3h |
| wrangler | pkg-pr-new | f2b3a6d | yes (by sha) | 2h |
| miniflare | pkg-pr-new | f2b3a6d | yes (by sha) | 2h |
| typescript | npm-dist-tag | 7.1.0-dev.20260915.1 | yes | 11h |
| playwright-core | npm-dist-tag | 1.64.0-alpha-2026-09-15 | yes | 14h |

## Try (2026-09-15)

`timbrado try wrangler --gate "node tools/check-routes-harness.ts"` against
aadhar.sh at 7d77bd08: frozen bun install ok, added
`https://pkg.pr.new/cloudflare/workers-sdk/wrangler@f2b3a6d`, route oracle
exit 0. The same install had failed that morning on the site's own leg with
`workerd@1.20260915.1 failed to resolve`: wrangler main names the workerd it
was built against, published 01:18Z, and bunfig's `minimumReleaseAge = 86400`
refused it. `try` now names that policy in its detail when a bun add fails to
resolve. The site exempted workerd by name.

## Watches (2026-09-15)

The three example watches, bun 1.4.2 (pinned) against 1.4.3-canary.1+09bb54630
(candidate): all three `not yet -> not yet`. Every fix they wait on is
`REVIEW_REQUIRED` upstream.

## Things learned on the site before extraction

- Chrome Canary 155.0.8057.0 decodes JPEG XL from a data URI by default;
  Chrome 153 does not. Found by a live probe beside a page's own feature
  checks, on the probe's first run.
- `margin-trim` flipped false to true between Chrome 153 and Canary 155.
- A `waitForResponse` attached after `goto` resolves misses a fetch that
  landed at ~450ms; three of six trials read "never fetched" with the response
  in the trace. Attach before navigating.
- A pipe after the command you are measuring hands `$?` to the pipe.
  `wrangler types --x-new-config` read exit 0 once and is refused; the 0 was
  `tail`'s.
