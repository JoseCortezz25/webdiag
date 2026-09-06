# Phase 2 calibration — false positive rate by axis

Issue [#12](https://github.com/JoseCortezz25/webdiag/issues/12). Run date **2026-09-06**,
catalog `1.0.0`, `webdiag@0.1.0`, `--mode deep --axes DEPS,SEO,AGENT` against the same
three sites used for [phase 1](../fase1/README.md).

This directory picks up where `docs/test/fase1/doubtful-findings.md` left off: phase 1
read the output of six probes on one page per site (`--mode quick`) and wrote down what
looked wrong without changing any code. Phase 2 closes three of those findings — the
ones scoped to DEPS and SEO — plus one new one found while reproducing them in `deep`
mode, and re-runs the scan to confirm each fix holds against the live sites instead of
only against a unit test.

## Targets and method

| Slug | URL | Stack |
|---|---|---|
| `hipintocol` | https://www.hipintocol.co/ | Webflow marketing site |
| `alfonso` | https://alfonso-portafolio.vercel.app/ | Next.js on Vercel |
| `thefactsnow` | https://www.thefactsnow.com/ | WordPress behind Cloudflare |

```
bun run build
./dist/cli.js scan <url> --mode deep --axes DEPS,SEO,AGENT --out /tmp/out-12-<slug>
```

`--axes` is restricted to the three axes this issue is scoped to (PERF/A11Y/SEC false
positives are tracked separately and are out of scope here — see the phase-1 doc for
`SEC-TLS-WEAK` and `A11Y-BUTTON-NAME-MISSING`, neither touched by this pass).
Artifacts were written to `/tmp/out-12-{hipintocol,alfonso,thefactsnow}` and are not
committed, for the same reason as phase 1: full response bodies from third-party sites.

## False positive rate by axis

"False positive" here means: the probe fired, and manual verification against the live
site showed the condition it claims does not hold (a broken link that works, a version
gap the owner cannot close, source exposure that is not the client's source). It
excludes findings that are correct-but-misnamed or correct-but-debatable-severity —
those are phase-1 items #1, #4 and #6, and stay open against different axes.

| Axis | Findings fired (this run, 3 sites) | False positives (this run) | False positive rate | False positives fixed this phase |
|---|---|---|---|---|
| DEPS | 6 | 0 | 0% | 3 |
| SEO deep | 9 | 0 | 0% | 1 (2 defects) |
| AGENT | 7 | 0 | 0% | 0 (none found, no code touched) |

"Findings fired" counts each `(site, finding ID)` pair once, from the `findings.json`
of this run. Every one of the 22 was read against its `evidence` block and, where the
underlying condition is externally checkable (a link, a TLS-adjacent header, a
sourcemap URL), against the live site directly.

## What changed, and the live evidence that it holds

### DEPS

**1. Third-party sourcemaps no longer count as exposure (`src/scan/deps/adapter.ts`,
`src/scan/deps/sourcemaps.ts`).** Phase 1 found `DEPS-SOURCEMAP-EXPOSED` firing on
`hipintocol` for `gsap` and `swiper` maps served from `cdn.jsdelivr.net` — public
package source, not the client's. The finding now filters `analysis.sourcemaps` to
`!thirdParty` before scoring. This run: `hipintocol` and `alfonso` report no
`DEPS-SOURCEMAP-EXPOSED` at all (their exposed maps, if any, are third-party);
`thefactsnow` still reports it, correctly, for
`/wp-content/themes/base-theme/assets/js/main.js.map` — same-origin, the site's own
WordPress theme bundle, `sources: 72`, `sources_content: true`. The true positive
survived the fix; the false one did not.

**2. A framework-vendored canary/nightly build is excluded from `DEPS-LIB-OUTDATED`
(`src/scan/deps/mapping.ts`: `isVendoredRuntimeVersion`).** Phase 1 found
`react-dom@18.3.0-canary-178c267a4e-20241218` flagged against npm's `19.2.8` latest on
`alfonso` — a real major-version gap on paper, but that exact canary is the React build
Next.js vendors into its own runtime; the site owner cannot bump it without bumping
Next.js. `beta`/`rc`/`alpha` stay in scope since those are channels an author picks.
Covered by a unit test with the literal detected string
(`adapter.test.ts`: *"stays quiet on a framework-vendored canary build"*); this live
run of `alfonso` no longer serves that exact canary build, so it does not reproduce the
finding either way — the regression test is what pins the behavior going forward.

**3. The jQuery signature no longer matches on a license-comment string alone
(`src/scan/deps/signatures.ts`).** Found while reproducing phase-1 results in `deep`
mode, not in the phase-1 doc itself: Google's `gtag.js`/`gtm.js` carry a stray jQuery
license comment ("jQuery (c) 2005, 2012 jQuery Foundation, Inc. jquery.org/license.")
above unrelated internal code, no jQuery present. Matching on
`jQuery\.fn\.jquery|jquery\.(?:com|org)\/license` reported `jquery` on two of the three
calibration sites purely from that comment. The pattern is now `jQuery\.fn\.jquery`
alone — the version-banner property every real jQuery build sets on itself. Live
confirmation this run: `hipintocol` and `thefactsnow` both genuinely ship jQuery
(`jquery-3.5.1.min.js` and `/wp-includes/js/jquery/jquery.min.js?ver=3.7.1` +
`jquery-migrate`, respectively) and both still correctly report `DEPS-LIB-OUTDATED` for
it against npm's `4.0.0`; neither site's `gtag.js`/`gtm.js` (not present in either
site's scanned bundle this run) is the source of that finding.

**`DEPS-VERSION-UNDETERMINED` acceptance check.** All three sites load at least one
CDN-hosted library with no version in the URL or bundle (`gsap`, `swiper`, `core-js` on
`hipintocol`; equivalents on the other two once undetermined). Every one of them
produced `DEPS-VERSION-UNDETERMINED` at `severity: info` with `evidence.mode:
"black-box"` and the specific asset list — none were silently dropped, none were
promoted to a scored finding. This matches the acceptance criterion in #12 directly.

### SEO deep

**4. `999` joins the accepted-status list, and broken links are deduplicated by target
URL (`src/scan/seo/links.ts`).** Phase 1 found `alfonso`'s own working LinkedIn profile
reported as `SEO-LINKS-BROKEN` on HTTP `999` — not a registered status, LinkedIn's
anti-scraping response to every unauthenticated client, browser or bot — and counted
twice (once live, once from lychee's cache) for the same URL. `999` is now in
`--accept` alongside `401/403/429`, and `parseLycheeOutput` deduplicates by URL,
keeping the first (live) occurrence. Live confirmation: `alfonso`'s deep crawl (218
links checked across the crawled pages) reports `SEO-LINKS-BROKEN` with `count: 1` for
a single genuine `404` — an expired-token GitHub raw asset URL
(`raw.githubusercontent.com/.../screenshot.png?token=...`) — not LinkedIn, and not
duplicated.

### AGENT

No heuristic changes were made to the AGENT probe this phase, and none of the findings
across the three sites (`AGENT-SEMANTICS-POOR` on `hipintocol`, `AGENT-LLMSTXT-MISSING`
/ `AGENT-STRUCTURED-DATA-MISSING` / `AGENT-WELLKNOWN-MISSING` across all three) looked
wrong on manual review: each is a presence/absence check (a file that either exists or
does not, a control that either has an accessible name or does not) with the specific
evidence attached, not a pattern match with room for a false match. `hipintocol`'s
`AGENT-SEMANTICS-POOR` reports exactly `controls_without_name: 3` of `controls_total:
22`, matching a manual count of unlabelled interactive elements on the page.

## Known false positives explicitly left open (different axes)

Phase 1's `doubtful-findings.md` also documents `SEC-TLS-WEAK` (over-severe on
`thefactsnow`) and `A11Y-BUTTON-NAME-MISSING` (real defect, misleading ID). Neither is
DEPS, SEO or AGENT, so neither is touched here; #12 is scoped to the three axes the
issue names.

## Summary

| Fix | File | Axis | Site that surfaced it | Live-confirmed this run |
|---|---|---|---|---|
| Third-party sourcemaps excluded | `deps/adapter.ts`, `deps/sourcemaps.ts` | DEPS | hipintocol | yes — thefactsnow true positive survives, hipintocol/alfonso stay quiet |
| Vendored canary/nightly excluded | `deps/mapping.ts` | DEPS | alfonso | unit-tested; not reproduced live (site no longer serves that build) |
| jQuery signature tightened | `deps/signatures.ts` | DEPS | (found during this phase) | yes — both real jQuery sites still detected correctly |
| `999` accepted + dedupe by URL | `seo/links.ts` | SEO deep | alfonso | yes — remaining finding is one genuine 404 |
