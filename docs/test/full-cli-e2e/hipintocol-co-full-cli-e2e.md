# Full CLI E2E — hipintocol-co

Issue [#17](https://github.com/JoseCortezz25/webdiag/issues/17). Run date **2026-09-06**,
`webdiag@0.1.0`, catalog `1.0.0`. Target: https://www.hipintocol.co/ (Webflow marketing site).

This is one of three parallel end-to-end runs against real, unmodified production
sites using the **built binary** (`./dist/cli.js`, not `bun run ./src/cli.ts`), in
black-box mode. Findings are read per axis, independently — there is no aggregate
score.

## How the run was produced

```
bun run build
bun run install:testssl   # vendors testssl.sh 3.2.1 for the SEC axis
./dist/cli.js scan https://www.hipintocol.co/ --mode quick --out <dir>
./dist/cli.js scan https://www.hipintocol.co/ --mode deep  --out <dir>
```

Both runs were launched in parallel with the same command against
`alfonso-portafolio.vercel.app` and `thefactsnow.com` (see the sibling documents
in this directory). Artifacts (`raw/*.json`, `findings.json`, `summary.json`,
`meta.json`, `report.html`) were written under `/tmp` and are not committed: they
carry full response bodies and selectors from a third-party site.

## Result

| | quick | deep |
|---|---|---|
| Exit code | 0 | 0 |
| Wall clock | 80.2s | 80.3s |
| Axes with `status: ok` | PERF, A11Y, SEO, DEPS, SEC, AGENT (6/6) | 6/6 |
| Axes failed | none | none |

No probe crashed and no axis was skipped in either mode. `--mode deep` on this
site samples pages under `--pages 8` but the site only offers 5 candidate URLs;
the crawler correctly analyzed all 4 it could reach (see Limitations).

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
| `PERF-LCP-POOR` | high | high | LCP 21 082ms vs 2 500ms threshold |
| `PERF-IMG-UNOPTIMIZED` | medium | high | 34 images flagged, 17 with byte savings, 17 missing dimensions, 6 280 KB wasted |
| `PERF-NO-CACHE-POLICY` | medium | high | 3 resources with short/no cache TTL (`gsap.min.js` at 0ms) |
| `PERF-RENDER-BLOCKING` | medium | high | 1 blocking CSS resource, ~1 100ms estimated FCP savings |
| `PERF-TBT-HIGH` | medium | medium | TBT 6 436ms vs 200ms threshold |
| `PERF-FIELD-UNAVAILABLE` | info | high | No CrUX API key configured; scores are lab-only |

### A11Y (zeroed — blocking finding present)

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `A11Y-BUTTON-NAME-MISSING` | **critical** | high | `link-name`: 4 nodes without discernible text (WCAG 2.4.4/4.1.2) |
| `A11Y-ARIA-INVALID` | high | high | `aria-valid-attr-value`: 4 nodes (e.g. `.swiper-button-prev`) |
| `A11Y-CONTRAST-INSUFFICIENT` | high | high | `color-contrast`: 8 nodes below the minimum ratio (WCAG 1.4.3) |
| `A11Y-HEADING-ORDER` | medium | high | 1 node skips a heading level |
| `A11Y-LANDMARKS-MISSING` | medium | high | No `main` landmark; 8 nodes affected |
| `A11Y-MANUAL-REVIEW-PENDING` | info | high | axe-core covers ~57% of WCAG 2.2 AA automatically; 41 rules passed, 6 violated, 2 incomplete |

The critical `link-name` finding is a blocking ID in the catalog, which is why the
A11Y axis reports 0 rather than a partial score — this is intended catalog
behavior, not a bug.

### SEO

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `SEO-CANONICAL-MISSING` | medium | high | No `<link rel="canonical">` on `/` |
| `SEO-H1-MISSING` | medium | high | 2 `<h1>` elements found, expected exactly 1 |
| `SEO-SITEMAP-MISSING` | medium | high | `/sitemap.xml` not found |
| `SEO-META-DESC-MISSING` | low | high | No meta description |

### DEPS

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `DEPS-LIB-OUTDATED` | medium | medium | jQuery 3.5.1 detected, latest is 4.0.0 |
| `DEPS-VERSION-UNDETERMINED` | info | high | 4 libraries detected (core-js, gsap, swiper) with version undetermined in black-box mode |

### SEC

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `SEC-CSP-MISSING` | high | high | No `content-security-policy` header (report-only also absent) |
| `SEC-XFO-MISSING` | medium | high | No `x-frame-options` header and no `frame-ancestors` in CSP |

No `SEC-TLS-*` finding: testssl.sh reported no weak protocols/ciphers and a
healthy certificate for this host.

### AGENT

| Finding | Severity | Confidence | Evidence |
|---|---|---|---|
| `AGENT-SEMANTICS-POOR` | medium | medium | 3 of 22 controls have no accessible name |
| `AGENT-LLMSTXT-MISSING` | low | high | `/llms.txt` returns 404 |
| `AGENT-STRUCTURED-DATA-MISSING` | low | high | 0 JSON-LD blocks, 0 microdata items |
| `AGENT-WELLKNOWN-MISSING` | low | high | `/.well-known/{security.txt,ai-plugin.json,ai.txt}` all 404 |

This axis's own probe notes it: "El impacto de este eje no esta probado" — its
findings are informational, not validated against real-world impact.

## `--mode deep` — differences from quick

Deep mode re-ran all six axes and additionally crawled the site for
cross-page SEO checks. Per-page finding counts scaled with the number of pages
sampled (e.g. `SEO-CANONICAL-MISSING` and `SEO-H1-MISSING` went from 1 to 4
affected pages), but **no new finding ID appeared and no axis status changed**.
PERF score differs slightly between modes (65 vs 70) due to normal Lighthouse
run-to-run variance, not a mode-dependent code path.

## Limitations encountered

- **Deep crawl came up short of `--pages 8`.** The site only exposes 4 distinct
  page URLs beyond the homepage (5 candidates total); the crawler analyzed all
  of them and said so explicitly (`"El sitio ofrecía 4 página(s) ... se pidieron
  8: el crawl profundo cubre menos de lo previsto"`). This is the crawler
  behaving correctly under a real constraint, not a failure.
- **No CrUX field data.** `WEBDIAG_CRUX_API_KEY` was not set for this run, so
  PERF is lab-only (Lighthouse), not corroborated by field data.
- **No GNU `timeout` on this machine** (macOS ships none by default), so
  testssl.sh ran without its own per-connection timeout flags. The scan was
  still bounded by the CLI's overall per-axis wall-clock ceiling, and it
  completed inside it.
- **No bot/CDN blocking observed** against this target.

## Bug found and fixed during this validation

The first pass of this validation ran against the built binary
(`./dist/cli.js`) with `testssl.sh` installed via `bun run install:testssl`,
and the SEC axis silently reported `testssl.sh not installed` on all three
sites even though it was present at `vendor/testssl.sh/testssl.sh`. Root cause:
`locateTestssl()` (`src/scan/sec/testssl.ts`) resolved the vendored path with a
fixed `../../../` relative to `import.meta.dir`, which is correct from
`src/scan/sec/` (dev mode) but wrong from the bundled `dist/` output — the
bundler flattens the module tree, so the same relative offset walks three
levels above the repository instead of into `vendor/`. Every run of the
*shipped* CLI binary was silently losing the `SEC-TLS-WEAK` /
`SEC-TLS-EXPIRING` / `SEC-TLS-EXPIRED` checks whenever testssl.sh was
vendor-installed rather than on `PATH`.

Fix: `locateTestssl()` now walks up from `import.meta.dir` looking for the
nearest `package.json` to establish the project root, then joins
`vendor/testssl.sh/testssl.sh` from there — independent of how many directory
levels deep the calling module happens to live in either dev or bundled form.
Covered by three new unit tests in `src/scan/sec/testssl.test.ts`
(`findProjectRoot`) that simulate both the `src/scan/sec/`-shaped and
`dist/`-shaped call depths. After the fix, all three sites' SEC axis correctly
picked up `testssl.sh 3.2.1` in `meta.json`, and `thefactsnow`'s real
`SEC-TLS-WEAK` finding (obsolete cipher suites) surfaced instead of being
silently skipped (see `thefactsnow-com-full-cli-e2e.md`).
