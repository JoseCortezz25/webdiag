# Full CLI E2E — thefactsnow-com

Issue [#17](https://github.com/JoseCortezz25/webdiag/issues/17). Run date **2026-09-06**,
`webdiag@0.1.0`, catalog `1.0.0`. Target: https://www.thefactsnow.com/
(WordPress, behind Cloudflare).

This is one of three parallel end-to-end runs against real, unmodified production
sites using the **built binary** (`./dist/cli.js`, not `bun run ./src/cli.ts`), in
black-box mode. Findings are read per axis, independently — there is no aggregate
score.

## How the run was produced

```
bun run build
bun run install:testssl   # vendors testssl.sh 3.2.1 for the SEC axis
./dist/cli.js scan https://www.thefactsnow.com/ --mode quick --out <dir>
./dist/cli.js scan https://www.thefactsnow.com/ --mode deep  --out <dir>
```

Both runs were launched in parallel with the same command against
`hipintocol.co` and `alfonso-portafolio.vercel.app` (see the sibling documents
in this directory). Artifacts (`raw/*.json`, `findings.json`, `summary.json`,
`meta.json`, `report.html`) were written under `/tmp` and are not committed:
they carry full response bodies and selectors from a third-party site.

## Result

| | quick | deep |
|---|---|---|
| Exit code | 0 | 0 |
| Wall clock | 81.1s | 81.4s |
| Axes with `status: ok` | PERF, A11Y, SEO, DEPS, SEC, AGENT (6/6) | 6/6 |
| Axes failed | none | none |

No probe crashed and no axis was skipped in either mode, despite this target
sitting behind Cloudflare (see Limitations for what that did and did not
affect).

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
| `PERF-LCP-POOR` | high | high | LCP 11 662ms vs 2 500ms threshold |
| `PERF-IMG-UNOPTIMIZED` | medium | high | 6 images flagged, 4 with byte savings, 2 missing dimensions, 112 KB wasted |
| `PERF-RENDER-BLOCKING` | medium | high | 10 blocking resources (theme JS + plugin JS), ~2 400ms estimated FCP savings |
| `PERF-TBT-HIGH` | medium | medium | TBT 3 955ms vs 200ms threshold |
| `PERF-FIELD-UNAVAILABLE` | info | high | No CrUX API key configured; scores are lab-only |

### A11Y

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `A11Y-MANUAL-REVIEW-PENDING` | info | high | axe-core covers ~57% of WCAG 2.2 AA automatically; 40 rules passed, **0 violated**, 2 incomplete |

Zero axe-core violations — the cleanest A11Y result of the three sites.

### SEO

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `SEO-JSONLD-INVALID` | medium | high | 1 JSON-LD block, 1 node missing `@type` |

No `SEO-CANONICAL-MISSING` or `SEO-SITEMAP-MISSING` on this run — this is the
only one of the three sites shipping both.

### DEPS

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `DEPS-LIB-OUTDATED` | medium | medium | jQuery 3.7.1→4.0.0, jQuery-migrate 3.4.1→4.0.2 |
| `DEPS-SOURCEMAP-EXPOSED` | medium | high | `main.js.map` publicly readable, 72 sources, original `sourcesContent` present |
| `DEPS-VERSION-UNDETERMINED` | info | high | 2 libraries (gsap, swiper) with version undetermined in black-box mode |

### SEC

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `SEC-TLS-WEAK` | high | high | testssl.sh flagged obsolete cipher suites offered by the server |

No `SEC-CSP-MISSING` or `SEC-XFO-MISSING` — this is the only site of the three
shipping both headers.

**This finding only surfaced after a bug fix made during this validation** — see
below. The first pass silently reported `SEC-TLS-WEAK` as not evaluated because
testssl.sh was not being found from the built binary.

### AGENT

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `AGENT-LLMSTXT-MISSING` | low | high | `/llms.txt` returns 404 |
| `AGENT-WELLKNOWN-MISSING` | low | high | `/.well-known/{security.txt,ai-plugin.json,ai.txt}` all 404 |

No `AGENT-SEMANTICS-POOR` or `AGENT-STRUCTURED-DATA-MISSING`: all controls have
accessible names, and structured data is present (consistent with the JSON-LD
block SEO flagged as present-but-invalid). This axis's own probe notes: "El
impacto de este eje no esta probado" — its findings are informational, not
validated against real-world impact.

## `--mode deep` — differences from quick

Deep mode crawled 8 of 18 candidate pages (the sampling cap, see Limitations)
and surfaced findings quick mode cannot see by definition:

- `SEO-H1-MISSING` (medium, 2 of 8 pages) — quick mode's single page has an H1;
  2 of the other 7 sampled pages do not.
- `SEO-META-DESC-DUPLICATE` (low, 8 pages) — all 8 sampled pages share one meta
  description.
- `SEO-LINKS-BROKEN` (medium) — of 1 147 links checked site-wide, 1 unique
  "broken" link, and it is a Cloudflare email-obfuscation URL
  (`/cdn-cgi/l/email-protection#...`) returning 404 to the crawler, not an
  actual dead link on the page a browser renders (see Limitations).
- `SEO-JSONLD-INVALID` scaled from 1 to 8 affected pages (every sampled page
  repeats the same invalid block from the shared theme).

No axis status changed and no new axis-level failure appeared. PERF score is
identical between modes (70/70) on this run.

## Limitations encountered

- **Deep crawl sampled 8 of 18 candidate pages.** This is within `--pages`'
  contract (`8` is both the default and what was requested), not a shortfall —
  unlike the other two sites, this one had enough pages to hit the requested
  sample size exactly.
- **Cloudflare rewrote a mailto link into a `/cdn-cgi/l/email-protection` URL**
  that the link checker cannot resolve (it needs client-side JS decoding
  Cloudflare injects into the page, which a plain HTTP fetch does not run).
  `lychee` correctly reports it as unreachable by HTTP; a human would not see
  it as broken in a real browser. This is a known class of false positive for
  any static link checker against Cloudflare-protected mail links, not specific
  to this CLI.
- **No CrUX field data.** `WEBDIAG_CRUX_API_KEY` was not set for this run, so
  PERF is lab-only (Lighthouse), not corroborated by field data.
- **No GNU `timeout` on this machine** (macOS ships none by default), so
  testssl.sh ran without its own per-connection timeout flags. The scan was
  still bounded by the CLI's overall per-axis wall-clock ceiling, and it
  completed inside it.
- **No other bot/CDN blocking observed.** Despite sitting behind Cloudflare,
  this site did not challenge or rate-limit the scanner's Lighthouse,
  axe-core, or lychee requests during either run.

## Bug found and fixed during this validation

The first pass of this validation (all three sites, run in parallel through
`./dist/cli.js`) showed `testssl.sh not installed` in every SEC axis result
despite `bun run install:testssl` having vendored it correctly. Root cause:
`locateTestssl()` in `src/scan/sec/testssl.ts` resolved the vendored path as a
fixed `../../../` relative to `import.meta.dir` — correct from `src/scan/sec/`
under `bun run ./src/cli.ts`, but wrong once the bundler flattens the module
into `dist/cli.js`, which sits one directory level from the repository root
instead of three. Every run of the *shipped* CLI binary was silently losing the
`SEC-TLS-WEAK` / `SEC-TLS-EXPIRING` / `SEC-TLS-EXPIRED` checks whenever
testssl.sh was vendor-installed rather than found on `PATH` — with no error, no
failed status, just a quieter SEC axis.

This site is the clearest evidence the bug mattered: with the bug present, its
SEC axis scored 100/100 with no note that anything was skipped beyond a line in
`notes`. After the fix (`locateTestssl()` now walks up from `import.meta.dir` to
the nearest `package.json` and resolves `vendor/testssl.sh/testssl.sh` from
that root), the same binary correctly found testssl.sh 3.2.1 and surfaced the
real `SEC-TLS-WEAK` finding, dropping the score to 85/100. Regression-tested in
`src/scan/sec/testssl.test.ts` (`findProjectRoot`, both `src/scan/sec/`-shaped
and `dist/`-shaped directory trees). All findings and scores in this document
are from the post-fix, rebuilt binary.
