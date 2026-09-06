# Results per site and per axis

Every number below comes from the `summary.json` of the run described in
`README.md`. There is no aggregate score by design (spec §5.1): each axis is read
on its own, and so is judged on its own here.

## Score matrix

| Axis | `hipintocol` (Webflow) | `alfonso` (Next.js) | `thefactsnow` (WordPress) |
|---|---|---|---|
| PERF | **70** | 75 | 75 |
| A11Y | **0** (zeroed) | 95 | 100 |
| SEO | **84** | 85 | 95 |
| DEPS | 90 | 95 | 90 |
| SEC | 80 | 80 | 85 |
| AGENT | 92 | 97 | 98 |
| findings (scored / low-confidence) | 24 / 0 | 16 / 0 | 12 / 0 |

All six probes returned `status: ok` on all three sites. No probe crashed, no axis
was skipped, and the pipeline exited `0` on every run (50s, 44s, 52s wall clock).

## Findings per site

### `hipintocol` — https://www.hipintocol.co/

| Axis | Score | Findings (severity / confidence) |
|---|---|---|
| PERF | 70 | `PERF-LCP-POOR` (high/high) · `PERF-IMG-UNOPTIMIZED` (medium/high) · `PERF-NO-CACHE-POLICY` (medium/high) · `PERF-RENDER-BLOCKING` (medium/high) · `PERF-FIELD-UNAVAILABLE` (info/high) |
| A11Y | 0 | `A11Y-BUTTON-NAME-MISSING` (**critical/high**, blocking → zeroes the axis) · `A11Y-ARIA-INVALID` (high/high) · `A11Y-CONTRAST-INSUFFICIENT` (high/high) · `A11Y-HEADING-ORDER` (medium/high) · `A11Y-LANDMARKS-MISSING` (medium/high) · `A11Y-MANUAL-REVIEW-PENDING` (info/high) |
| SEO | 84 | `SEO-CANONICAL-MISSING` · `SEO-H1-MISSING` · `SEO-SITEMAP-MISSING` (medium) · `SEO-META-DESC-MISSING` (low) |
| DEPS | 90 | `DEPS-LIB-OUTDATED` (medium/medium) · `DEPS-SOURCEMAP-EXPOSED` (medium/high) · `DEPS-VERSION-UNDETERMINED` (info) |
| SEC | 80 | `SEC-CSP-MISSING` (high/high) · `SEC-XFO-MISSING` (medium/high) |
| AGENT | 92 | `AGENT-SEMANTICS-POOR` (medium/medium) · `AGENT-LLMSTXT-MISSING` · `AGENT-STRUCTURED-DATA-MISSING` · `AGENT-WELLKNOWN-MISSING` (low) |

Notable evidence: LCP 20.6s, 23 images with byte savings totalling 6 863 KB, 17 of
them unsized; 8 nodes failing `color-contrast`; 4 nodes failing `link-name`; no
`content-security-policy` and no `x-frame-options` header; `/sitemap.xml` returns 404
(verified independently by `curl`); two `<h1>` elements on the page (also verified).

### `alfonso` — https://alfonso-portafolio.vercel.app/

| Axis | Score | Findings |
|---|---|---|
| PERF | 75 | `PERF-LCP-POOR` (high) · `PERF-IMG-UNOPTIMIZED` · `PERF-RENDER-BLOCKING` (medium) · `PERF-FIELD-UNAVAILABLE` (info) |
| A11Y | 95 | `A11Y-HEADING-ORDER` (medium) · `A11Y-MANUAL-REVIEW-PENDING` (info) |
| SEO | 85 | `SEO-CANONICAL-MISSING` · `SEO-LINKS-BROKEN` · `SEO-SITEMAP-MISSING` (medium) |
| DEPS | 95 | `DEPS-LIB-OUTDATED` (medium/medium) · `DEPS-VERSION-UNDETERMINED` (info) |
| SEC | 80 | `SEC-CSP-MISSING` (high) · `SEC-XFO-MISSING` (medium) |
| AGENT | 97 | `AGENT-LLMSTXT-MISSING` · `AGENT-STRUCTURED-DATA-MISSING` · `AGENT-WELLKNOWN-MISSING` (low) |

Notable evidence: LCP 5.1s, CLS 0, TBT 47ms; only one image with savings (14 KB);
74 links checked, 2 "broken" — both the same LinkedIn profile URL (see
`doubtful-findings.md` §1).

### `thefactsnow` — https://www.thefactsnow.com/

| Axis | Score | Findings |
|---|---|---|
| PERF | 75 | `PERF-LCP-POOR` (high) · `PERF-IMG-UNOPTIMIZED` · `PERF-RENDER-BLOCKING` (medium) · `PERF-FIELD-UNAVAILABLE` (info) |
| A11Y | 100 | `A11Y-MANUAL-REVIEW-PENDING` (info) only |
| SEO | 95 | `SEO-JSONLD-INVALID` (medium) |
| DEPS | 90 | `DEPS-LIB-OUTDATED` (medium/medium) · `DEPS-SOURCEMAP-EXPOSED` (medium/high) · `DEPS-VERSION-UNDETERMINED` (info) |
| SEC | 85 | `SEC-TLS-WEAK` (high/high) |
| AGENT | 98 | `AGENT-LLMSTXT-MISSING` · `AGENT-WELLKNOWN-MISSING` (low) |

Notable evidence: LCP 9.7s, CLS 0, TBT 32ms; zero axe violations; the site ships
`content-security-policy`, `x-frame-options: SAMEORIGIN`, `strict-transport-security`,
`x-content-type-options: nosniff` and `referrer-policy`; its own theme sourcemap
(`main.js.map`, 72 sources with `sourcesContent`) is publicly readable.

## Axis-by-axis contrast against expected severity

The acceptance criterion is that the healthy site must not look bad and the bad site
must not look good — **per axis**, not on average.

| Axis | Ordering produced | Matches reality? | Reading |
|---|---|---|---|
| A11Y | hipintocol 0 « alfonso 95 < thefactsnow 100 | **yes** | The one site with contrast, ARIA and unnamed-control failures is the one that collapses. The two clean sites separate correctly on a single heading-order violation. |
| SEO | hipintocol 84 ≈ alfonso 85 « thefactsnow 95 | **yes** | The WordPress site is the only one with a canonical and a sitemap; the two that lack both land together, 10 points lower. |
| AGENT | hipintocol 92 < alfonso 97 < thefactsnow 98 | **yes**, with the caveat the axis carries | Ordering is right; the spread is intentionally narrow because the axis's impact is documented as unproven. |
| DEPS | hipintocol 90 = thefactsnow 90 < alfonso 95 | **partly** | Ordering is defensible, but the two 90s are reached for very different reasons: thefactsnow really does leak its own source, hipintocol only "leaks" a public jsDelivr sourcemap. See §3 of `doubtful-findings.md`. |
| PERF | hipintocol 70 < alfonso 75 = thefactsnow 75 | **no — magnitude is lost** | A 5-point spread separates a 20.6s LCP from a 5.1s LCP, and a 9.7s LCP ties with a 5.1s one. The ordering is technically right; the *distance* is not. See `thresholds.md`. |
| SEC | hipintocol 80 = alfonso 80 < thefactsnow 85 | **no — inverted in substance** | thefactsnow has by far the strongest posture (CSP + XFO + HSTS + nosniff + TLS 1.2/1.3 only) yet leads by only 5 points, because a testssl.sh finding rated `LOW` by testssl itself is reported as `high`. Corrected, it would read 100 vs 80/80. See §2 of `doubtful-findings.md`. |

**Verdict.** Four of six axes reproduce the expected severity ordering with usable
distance. PERF preserves the ordering but compresses it to noise. SEC produces a
misleading picture on this sample, for one traceable reason that is a severity
mapping, not a threshold. Neither failure is a pipeline failure — every probe ran and
every finding is reproducible.
