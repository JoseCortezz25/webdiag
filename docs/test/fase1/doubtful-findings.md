# False and doubtful findings

Each entry names the finding, the site it fired on, what was verified independently,
and why the finding is wrong or over-stated. Ordered by how much it distorts a score.

---

## 1. `SEC-TLS-WEAK` on `thefactsnow` — over-severe (costs 15 points)

**Reported:** `SEC-TLS-WEAK`, severity `high`, confidence `high`, evidence
`{"protocols": [], "cipher_suites": ["cifrados obsoletos"]}`. Sole SEC finding; drops
the axis from 100 to 85.

**Verified** by running the vendored testssl.sh 3.2.1 directly against
`www.thefactsnow.com:443`:

```
OK       SSLv2                    not offered
OK       SSLv3                    not offered
INFO     TLS1                     not offered
INFO     TLS1_1                   not offered
OK       TLS1_2                   offered
OK       TLS1_3                   offered with final
OK       cipherlist_NULL          not offered
OK       cipherlist_aNULL         not offered
OK       cipherlist_EXPORT        not offered
OK       cipherlist_LOW           not offered
INFO     cipherlist_3DES_IDEA     not offered
LOW      cipherlist_OBSOLETED     offered
OK       cipherlist_STRONG_NOFS   offered
OK       cipherlist_STRONG_FS     offered
```

**Why it is wrong.** The TLS configuration is modern: TLS 1.2 and 1.3 only, no
SSLv2/v3, no TLS 1.0/1.1, and none of NULL, aNULL, EXPORT, LOW or 3DES/IDEA. The only
trigger is `cipherlist_OBSOLETED`, which **testssl.sh itself rates `LOW`**. `weakness()`
in `src/scan/sec/testssl.ts:232` treats every entry in `WEAK_CIPHERLISTS` as equally
disqualifying and emits one finding at the catalog base severity `high`, discarding
testssl's own severity column.

The empty `protocols` array in the evidence makes this visible: the finding says
"weak TLS" while reporting that no weak protocol was found. The string
`"cifrados obsoletos"` is a category label, not a cipher list, so the report gives the
client nothing to act on either.

**Effect on the validation.** This single mapping inverts the SEC axis on this sample.
`thefactsnow` — the only site of the three with CSP, `x-frame-options`, HSTS,
`nosniff` and a clean TLS config — reads 85 against 80 for two sites with no security
headers at all. Corrected, it would read 100 vs 80/80.

**Suggested fix:** read testssl's `severity` field; map `cipherlist_OBSOLETED` alone to
`medium` or `low` via the `RawObservation.severity` override, and reserve `high` for
the categories that are genuinely broken (NULL, aNULL, EXPORT, LOW, 3DES) or for a
weak protocol still being offered. Also put the offending cipher names in the evidence.

---

## 2. `SEO-LINKS-BROKEN` on `alfonso` — false positive (costs 5 points)

**Reported:** 74 links checked, 72 successful, 2 broken — both the same URL:

```
999 https://www.linkedin.com/in/alfonsochavarrocortes (Error (cached))
999 https://www.linkedin.com/in/alfonsochavarrocortes (Rejected status code: 999 Unknown status code)
```

**Verified:**

```
$ curl -s -o /dev/null -w "%{http_code}\n" -A "lychee/0.24"  https://www.linkedin.com/in/alfonsochavarrocortes
999
$ curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0 ... Chrome/131.0 ..." https://www.linkedin.com/in/alfonsochavarrocortes
999
```

**Why it is wrong.** HTTP 999 is LinkedIn's non-standard anti-scraping response,
returned to every unauthenticated client regardless of user agent. The link is not
broken; it is unverifiable. Reporting it as broken tells a client to fix a link that
works in every browser.

Two entries also appear for one URL — the same target counted once live and once from
lychee's cache — which inflates `count` on a single defect.

**Suggested fix:** treat 999 (and 403/429 from known bot-hostile hosts) as
"unverifiable", not "broken": either exclude them from the finding or emit them at
`confidence: low`, which by the scoring rule would list them without deducting.
Deduplicate by resolved URL before counting.

---

## 3. `DEPS-SOURCEMAP-EXPOSED` on `hipintocol` — false positive (costs 5 points)

**Reported** on `hipintocol` with the title *"El código fuente original de la
aplicación es descargable"* and this evidence:

```json
{"maps": [
  {"asset": "https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js",
   "map":   "https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js.map",
   "kind": "conventional", "status": 200, "sources": 3, "sources_content": true},
  {"asset": "https://cdn.jsdelivr.net/npm/swiper@11/swiper-element-bundle.min.js",
   "map":   "https://cdn.jsdelivr.net/npm/swiper@11/swiper-element-bundle.min.js.map",
   "kind": "linked", "status": 200, "sources": 1, "sources_content": false}
], "with_original_source": 1}
```

**Why it is wrong.** Both maps belong to public open-source packages served from
jsDelivr. GSAP and Swiper publish their sourcemaps deliberately; their source is on
npm and GitHub already. Nothing of the client's application is exposed, yet the
finding's own title claims the opposite.

**Contrast with the true positive** on `thefactsnow`, where the same ID fires on
`https://www.thefactsnow.com/wp-content/themes/base-theme/assets/js/main.js.map`,
`sources: 72`, `sources_content: true` — that one really is the client's own theme
source, and is exactly what the finding is for.

**Suggested fix:** only count maps whose asset is same-origin with the target (or at
least exclude known public package CDNs), and keep third-party maps as informational
context if they are worth mentioning at all.

---

## 4. `A11Y-BUTTON-NAME-MISSING` on `hipintocol` — real defect, misleading ID, debatable blast radius (costs 100 points)

**Reported:** severity `critical`, `blocking: true`, which under the override rule in
`src/catalog/scoring.ts` zeroes the whole A11Y axis and promotes the finding to the
report cover. Evidence: axe rule `link-name`, 4 nodes, axe impact `serious`, selectors
`.logo-social-med-container.w-inline-block[target="_blank"]:nth-child(1..4)`.

**Why it is doubtful, in two separate ways.**

*The name.* The ID says `BUTTON`, the failing elements are `<a>` social-media icons.
The rendered title, *"Hay controles sin nombre accesible"*, is accurate; the ID a
client sees next to it is not. Anyone reading the report will look for buttons.

*The blast radius.* Four unlabelled footer icons take the axis from whatever it would
have been to exactly 0, on the same page that also has 8 contrast failures and 4
invalid ARIA values. The zero is not wrong — this page is genuinely the worst of the
three on A11Y, so the ordering holds — but a score of 0 cannot distinguish "four
unlabelled social icons" from "unusable with a screen reader", and axe itself rates
the trigger `serious`, not `critical`.

**Suggested action:** none to the scoring rule, which is deliberate design. Worth
confirming that `critical + blocking` is intended for `link-name` specifically, and
worth renaming the ID (or splitting link vs. button) before the catalog is frozen.

---

## 5. `DEPS-LIB-OUTDATED` on `alfonso` — technically true, not actionable

**Reported:** `react-dom` detected `18.3.0-canary-178c267a4e-20241218`, latest
`19.2.8`, severity `medium`, confidence `medium`.

**Why it is doubtful.** That canary is the React build Next.js vendors into its own
bundle. The site owner cannot upgrade it independently of Next.js, and comparing a
vendored canary against the latest stable npm tag produces a version gap that is real
on paper and meaningless in practice. Confidence `medium` is the right instinct; the
finding still deducts 5 points.

**Suggested fix:** recognise framework-vendored runtimes (assets under
`/_next/static/`, canary/nightly version strings) and either drop to
`confidence: low` — which does not deduct — or word the remediation as "upgrade
Next.js", not "upgrade react-dom".

---

## 6. `SEO-H1-MISSING` on `hipintocol` — correct per contract, misleading name

Evidence `{"h1_count": 2, "expected": 1}`; independently verified — the page really
does have two `<h1>` elements. The catalog defines the ID as "Sin H1 o con varios"
(`src/catalog/entries.ts:287`, `docs/inbox/findings-catalog.md:132`), so the behaviour
is exactly as specified. Only the ID name reads wrong for the "several" case. Low
priority, but it is a client-facing string.

---

## 7. Measurement-stability notes (no score impact)

**Security headers vary by request shape.** An initial `curl -sSI` (HEAD, browser UA)
against `thefactsnow` returned no `content-security-policy`; the probe's own request
(GET with headers dumped, `webdiag` UA) returned
`content-security-policy: frame-ancestors 'self'; upgrade-insecure-requests;`. The
probe is right and the HEAD probe was wrong, but a header verdict that depends on the
request method behind a CDN is worth knowing about before a client disputes one.

**A present CSP is not necessarily a useful CSP.** The CSP above carries no
`default-src` or `script-src`, so it is a framing policy with no XSS value, yet
`SEC-CSP-MISSING` counts it as present. Not a false positive — the header is there —
but "has CSP" and "is protected by CSP" are not the same claim.

**Two Chrome builds in one run.** `meta.json` records PERF using
`chrome-headless-shell@148.0.7778.97` while A11Y and DEPS use `chrome@152.0.7977.75`.
Both runs are internally reproducible, but comparing across axes assumes one browser.

**testssl.sh must be installed for the SEC axis to be complete.** A first pass without
it emitted the note *"testssl.sh was not found, so SEC-TLS-WEAK, SEC-TLS-EXPIRING and
SEC-TLS-EXPIRED were not evaluated"* and scored `thefactsnow` SEC at 85 for entirely
different reasons. The note behaved exactly as designed — nothing was hidden — but the
scores are only comparable across sites when the toolchain is identical. All results
in this directory come from runs with testssl.sh 3.2.1 present.

**GNU `timeout` is absent on macOS.** Every run carries the note that testssl.sh ran
without per-connection timeouts. Harmless here; relevant on a slow or hostile host.

---

## Summary

| # | Finding | Site | Class | Score impact |
|---|---|---|---|---|
| 1 | `SEC-TLS-WEAK` | thefactsnow | over-severe | −15, inverts the SEC axis |
| 2 | `SEO-LINKS-BROKEN` | alfonso | false positive | −5 |
| 3 | `DEPS-SOURCEMAP-EXPOSED` | hipintocol | false positive | −5 |
| 4 | `A11Y-BUTTON-NAME-MISSING` | hipintocol | real, misnamed, debatable severity | −100 (axis zeroed) |
| 5 | `DEPS-LIB-OUTDATED` | alfonso | true but not actionable | −5 |
| 6 | `SEO-H1-MISSING` | hipintocol | correct, misleading name | 0 |
| 7 | measurement stability | all | context | 0 |

None of these were fixed in this pass. Fixing them means changing probe severity
mapping and finding logic, which is a separate change with its own tests — this issue
is scoped to running the tool, reading the output and writing down what it got wrong.
