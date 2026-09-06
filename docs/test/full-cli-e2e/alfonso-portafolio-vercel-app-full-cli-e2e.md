# Full CLI E2E — alfonso-portafolio-vercel-app

Issue [#17](https://github.com/JoseCortezz25/webdiag/issues/17). Run date **2026-09-06**,
`webdiag@0.1.0`, catalog `1.0.0`. Target: https://alfonso-portafolio.vercel.app/
(Next.js on Vercel).

This is one of three parallel end-to-end runs against real, unmodified production
sites using the **built binary** (`./dist/cli.js`, not `bun run ./src/cli.ts`), in
black-box mode. Findings are read per axis, independently — there is no aggregate
score.

## How the run was produced

```
bun run build
bun run install:testssl   # vendors testssl.sh 3.2.1 for the SEC axis
./dist/cli.js scan https://alfonso-portafolio.vercel.app/ --mode quick --out <dir>
./dist/cli.js scan https://alfonso-portafolio.vercel.app/ --mode deep  --out <dir>
```

Both runs were launched in parallel with the same command against
`hipintocol.co` and `thefactsnow.com` (see the sibling documents in this
directory). Artifacts (`raw/*.json`, `findings.json`, `summary.json`,
`meta.json`, `report.html`) were written under `/tmp` and are not committed:
they carry full response bodies and selectors from a third-party site.

## Result

| | quick | deep |
|---|---|---|
| Exit code | 0 | 0 |
| Wall clock | 70.3s | 69.1s |
| Axes with `status: ok` | PERF, A11Y, SEO, DEPS, SEC, AGENT (6/6) | 6/6 |
| Axes failed | none | none |

No probe crashed and no axis was skipped in either mode. This is the healthiest
of the three targets: no A11Y-blocking finding, and the fewest findings overall.

## Tool versions (`meta.json`)

| Axis | Tool | Version |
|---|---|---|
| PERF | lighthouse | 13.4.1 (chrome-headless-shell 148.0.7778.97) |
| A11Y | axe-core | 4.13.0 (chrome 152.0.7977.75) |
| SEO | webdiag-seo | 0.1.0 (lychee 0.24.2, libxml 20913) |
| DEPS | retire.js | 5.7.0 (chrome 152.0.7977.75) |
| SEC | webdiag-sec | 0.1.0 (curl 8.7.1, testssl.sh 3.2.1) |
| AGENT | webdiag-agent | 1.0.0 |

## Findings per axis (`--mode quick`)

### PERF

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `PERF-IMG-UNOPTIMIZED` | medium | high | 1 image with byte savings, 14 KB wasted |
| `PERF-RENDER-BLOCKING` | medium | high | 3 blocking resources (Google Fonts CSS + 2 Next.js CSS bundles), ~650ms estimated FCP savings |
| `PERF-TBT-HIGH` | medium | medium | TBT 3 696ms vs 200ms threshold |
| `PERF-FIELD-UNAVAILABLE` | info | high | No CrUX API key configured; scores are lab-only |

No `PERF-LCP-POOR` on this run: LCP came in under the 2 500ms threshold.

### A11Y

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `A11Y-HEADING-ORDER` | medium | high | 1 node (`.Presentation_presentation__subtitle__BIl5v`) skips a heading level |
| `A11Y-MANUAL-REVIEW-PENDING` | info | high | axe-core covers ~57% of WCAG 2.2 AA automatically; 35 rules passed, 2 violated |

No blocking or critical A11Y finding — this is the only one of the three sites
whose A11Y axis is not zeroed.

### SEO

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `SEO-CANONICAL-MISSING` | medium | high | No `<link rel="canonical">` on `/` |
| `SEO-SITEMAP-MISSING` | medium | high | `/sitemap.xml` not found |

### DEPS

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `DEPS-VERSION-UNDETERMINED` | info | high | 2 assets detected as React with version undetermined in black-box mode (`--next.js` chunk names give no semver) |

No outdated-library finding on this site.

### SEC

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `SEC-CSP-MISSING` | high | high | No `content-security-policy` header (report-only also absent) |
| `SEC-XFO-MISSING` | medium | high | No `x-frame-options` header and no `frame-ancestors` in CSP |

No `SEC-TLS-*` finding: testssl.sh reported no weak protocols/ciphers and a
healthy certificate for this host (Vercel's default TLS termination).

### AGENT

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `AGENT-LLMSTXT-MISSING` | low | high | `/llms.txt` returns 404 |
| `AGENT-STRUCTURED-DATA-MISSING` | low | high | 0 JSON-LD blocks, 0 microdata items |
| `AGENT-WELLKNOWN-MISSING` | low | high | `/.well-known/{security.txt,ai-plugin.json,ai.txt}` all 404 |

No `AGENT-SEMANTICS-POOR`: all controls on this page have an accessible name.
This axis's own probe notes: "El impacto de este eje no esta probado" — its
findings are informational, not validated against real-world impact.

## `--mode deep` — differences from quick

Deep mode crawled 2 pages (`/` and `/projects` — the only 2 candidates the
crawler found beyond the homepage out of 3, see Limitations) and surfaced two
finding IDs that quick mode cannot see by definition, since they require
comparing more than one page:

- `SEO-TITLE-DUPLICATE` (medium, 2 pages) — both pages share a `<title>`.
- `SEO-META-DESC-DUPLICATE` (low, 2 pages) — both pages share a meta description.
- `SEO-LINKS-BROKEN` (medium) — of 218 links checked site-wide, 1 unique broken
  link (a 404'd GitHub raw-content screenshot referenced from `/projects`; 401/403/429
  responses are excluded by design, they are servers rejecting the crawler, not
  broken links).

`SEO-CANONICAL-MISSING` scaled from 1 to 2 affected pages, consistent with the
crawl. No axis status changed and no new axis-level failure appeared. PERF score
differs between modes (70 vs 85) from ordinary Lighthouse run-to-run variance.

## Limitations encountered

- **Deep crawl came up short of `--pages 8`.** This is a small portfolio site
  with only 2 reachable pages beyond the homepage (3 candidates total); the
  crawler analyzed all of them and reported the shortfall explicitly
  (`"El sitio ofrecía 2 página(s) ... se pidieron 8"`). Expected behavior for a
  small site, not a defect.
- **No CrUX field data.** `WEBDIAG_CRUX_API_KEY` was not set for this run, so
  PERF is lab-only (Lighthouse), not corroborated by field data.
- **No GNU `timeout` on this machine** (macOS ships none by default), so
  testssl.sh ran without its own per-connection timeout flags. The scan was
  still bounded by the CLI's overall per-axis wall-clock ceiling, and it
  completed inside it.
- **No bot/CDN blocking observed** against this target.

## Bug found and fixed during this validation

The first pass of this validation (all three sites, run in parallel) showed
`testssl.sh not installed` in the SEC axis of every run despite `bun run
install:testssl` having vendored it correctly, because the scan was run through
the **built binary** (`./dist/cli.js`), not `bun run ./src/cli.ts`. Root cause:
`locateTestssl()` in `src/scan/sec/testssl.ts` computed the vendored path as a
fixed `../../../` relative to `import.meta.dir` — correct from
`src/scan/sec/` in dev mode, but wrong once bundling flattens the module into
`dist/cli.js`, one directory level from the repository root instead of three.
This silently degraded the SEC axis on every shipped-binary run, dropping the
`SEC-TLS-WEAK` / `SEC-TLS-EXPIRING` / `SEC-TLS-EXPIRED` checks without any error.

Fixed by having `locateTestssl()` walk up from `import.meta.dir` to the nearest
`package.json` and resolve `vendor/testssl.sh/testssl.sh` from that root,
regardless of call-site depth. Regression-tested in
`src/scan/sec/testssl.test.ts` with both a `src/scan/sec/`-shaped and a
`dist/`-shaped directory tree. This site's own SEC result (`testssl.sh 3.2.1`
correctly picked up, no `SEC-TLS-*` finding) is from the post-fix, rebuilt
binary.
